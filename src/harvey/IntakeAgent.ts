/**
 * Harvey Intake Agent
 *
 * The conversational intelligence behind Harvey. Uses Claude (via Bedrock)
 * to have a multi-turn conversation with the user, determine which Specter
 * agent should handle their request, gather required context, and create
 * a task_management entry.
 *
 * Unlike the other Specter agents that use the Claude Agent SDK with file tools,
 * Harvey uses direct Bedrock API calls because it needs:
 * - Multi-turn conversation state (not a single-shot agentic task)
 * - Custom tools for querying the DB (agents, customers, repos)
 * - Streaming token output back to Teams
 *
 * ## Tool Definitions
 * Harvey has access to these tools to resolve task parameters:
 * - list_agents: Show available agents and their descriptions
 * - list_customers: Show customer -> branch mappings
 * - list_repositories: Show available code repositories
 * - create_task: Submit the resolved task to the pipeline
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock,
  type ToolConfiguration,
} from '@aws-sdk/client-bedrock-runtime';
import { getDatabase, type Database } from '../orchestrator/database.js';
import { RepoAnalyzer } from '../orchestrator/RepoAnalyzer.js';
import { SessionStore } from './SessionStore.js';
import { TaskCreator } from './TaskCreator.js';
import { createLogger } from '../utils/logger.js';
import type { ChatSession, ChatMessage, IntakeResponse, StreamCallbacks } from './types.js';

const logger = createLogger('harvey-intake');

const SYSTEM_PROMPT = `You are Harvey, the intelligent intake assistant for Product Factory. Product Factory is an AI-powered platform that puts specialized agents to work on engineering and operational tasks. You help users engage the right agent through natural conversation.

## Your Role
Users come to you when they need help from one of Product Factory's AI agents. Your job is:
1. Understand what the user needs
2. Determine which agent should handle it
3. Gather the required context (customer, repositories)
4. Confirm with the user, then submit the task

## Conversation Style
- Be concise and direct — don't be overly chatty
- Ask ONE question at a time, not a wall of questions
- If the user names an agent directly (e.g., "I need DARCI to look at..."), skip agent discovery
- If the user mentions a customer name, validate it with list_customers before proceeding
- Always confirm the full plan before calling create_task

## Gathering Information
You need three things before you can create a task:
1. **Which agent** — Use list_agents() to see options. Match based on what the user describes.
2. **Which customer/branch** — Use list_customers() to find the right customer. If the user doesn't specify, ask.
3. **Task description** — Build a clear, detailed description from the conversation. Include everything the user told you about their problem/request.

Repositories are selected automatically based on the agent type, but you can use list_repositories() if the user asks about specific repos or if you need to confirm.

## Agent Selection Quick Reference
Use this to avoid routing to the wrong agent:
- **HERMES**: system variables, config values, feature flags, database settings, environment settings, "what does X config do", "what is the value of Y"
- **SCRIBE**: "how does this code work", explain a class/method/flow, understand business logic
- **DARCI**: bugs, defects, errors, exceptions, root cause analysis
- **PRISM**: implementing a feature, planning code changes, "how should I build X"
- **SENTRY**: SQL execution review, "is this SQL safe to run", DBA review
- **VERITAS**: incident reports, post-mortems, RCA documents
- **NOTARY**: review client notes for a release, "review client notes for 1.10.23", "notary 1.10.23"

When the user asks about a system variable or configuration setting → always use **HERMES**, not SCRIBE.

When the user asks for NOTARY:
- customer_name is NOT required — use "MHK" as the customer
- release_version IS required — ask for it if not provided (e.g., "Which release version? e.g. 1.10.23")
- Pass release_version in the create_task call — it becomes the task's JIRA reference

## When Ready
Once you have all three pieces, summarize the plan and ask the user to confirm. Then call create_task().

## Follow-up After Task Completion
Once a task is delivered, the conversation stays open. You can:
- Answer questions about the result using the context injected into the conversation
- Create a NEW task if the user wants to dig deeper, try a different agent, or add more context
  (e.g. "run DARCI on this instead", "now check the same thing for Aetna", "can SCRIBE explain the fix?")
- The new task will have access to the same conversation history — include any relevant prior context
  in the task description you write

## Important
- NEVER make up customer names or agent names — always validate with tools
- If uncertain about the agent, describe the options and let the user choose
- The task description you write becomes the agent's entire input — make it thorough
`;

/**
 * Tool definitions for the Bedrock Converse API
 */
const INTAKE_TOOLS: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: 'list_agents',
        description: 'List all available Specter agents with their names, descriptions, and task types. Use this to help the user pick the right agent.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {},
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'list_customers',
        description: 'List all customers and their associated code branches. Use this to validate customer names and find the correct customer ID.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              search: {
                type: 'string',
                description: 'Optional: filter customers by name (partial match)',
              },
            },
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'list_repositories',
        description: 'List all available code repositories. Use this if the user asks about specific repos.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {},
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'create_task',
        description: 'Create a task for an agent to process. Call this ONLY after confirming the plan with the user. This submits the task to the Specter pipeline.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              agent_name: {
                type: 'string',
                description: 'Name of the agent (e.g., DARCI, SCRIBE, SENTRY)',
              },
              customer_name: {
                type: 'string',
                description: 'Customer name (must match a customer_branches entry)',
              },
              task_description: {
                type: 'string',
                description: 'Comprehensive task description for the agent. Include all context from the conversation.',
              },
              create_jira: {
                type: 'boolean',
                description: 'Whether to create a JIRA ticket for tracking (default: false)',
              },
              release_version: {
                type: 'string',
                description: 'For NOTARY only: the release source version to review (e.g. "1.10.23"). Required when agent_name is NOTARY.',
              },
            },
            required: ['agent_name', 'task_description'],
          },
        },
      },
    },
  ],
};

export class IntakeAgent {
  private bedrock: BedrockRuntimeClient;
  private db: Database;
  private repoAnalyzer: RepoAnalyzer;
  private sessionStore: SessionStore;
  private taskCreator: TaskCreator;
  private modelId: string;

  constructor(region?: string, modelId?: string) {
    this.bedrock = new BedrockRuntimeClient({
      region: region || process.env.AWS_REGION || 'us-east-2',
    });
    this.db = getDatabase();
    this.repoAnalyzer = new RepoAnalyzer({ region: region || process.env.AWS_REGION || 'us-east-2' });
    this.sessionStore = new SessionStore();
    this.taskCreator = new TaskCreator();
    this.modelId = modelId || process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
  }

  /**
   * Handle an incoming user message.
   *
   * 1. Load session history
   * 2. Add the new message
   * 3. Call Bedrock Converse with tool definitions
   * 4. Execute any tool calls
   * 5. Loop until Claude produces a final text response
   * 6. Return the reply
   */
  async handleMessage(
    session: ChatSession,
    userMessage: string,
  ): Promise<IntakeResponse> {
    const logContext = {
      sessionId: session.session_id,
      userId: session.user_id,
      messageLength: userMessage.length,
    };

    logger.info(logContext, '[INTAKE_MESSAGE] Processing user message');

    // Add user message to session
    const userMsg: ChatMessage = {
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString(),
    };
    await this.sessionStore.addMessage(session.id, userMsg);
    session.messages_json.push(userMsg);

    // Build Bedrock messages from session history
    const messages = this.buildMessages(session.messages_json);

    // Agentic loop: call LLM -> handle tool calls -> repeat
    let taskCreated = false;
    let taskManagementId: number | undefined;
    let agentName: string | undefined;
    let finalReply = '';

    const MAX_TOOL_ROUNDS = 10;
    const timeoutMs = 30000; // 30 seconds per LLM call

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      logger.debug({ ...logContext, round, messageCount: messages.length }, '[INTAKE_LLM_CALL] Calling Bedrock');

      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), timeoutMs);

      let response;
      try {
        response = await this.bedrock.send(
          new ConverseCommand({
            modelId: this.modelId,
            system: [{ text: SYSTEM_PROMPT }],
            messages,
            toolConfig: INTAKE_TOOLS,
            inferenceConfig: {
              maxTokens: 4096,
              temperature: 0.3,
            },
          }),
          { abortSignal: abortController.signal },
        );
      } finally {
        clearTimeout(timeout);
      }

      const output = response.output;
      if (!output?.message) {
        logger.error(logContext, '[INTAKE_NO_OUTPUT] Bedrock returned no message');
        break;
      }

      const assistantMessage = output.message;
      messages.push(assistantMessage);

      // Check for tool use
      const toolUseBlocks = (assistantMessage.content ?? []).filter(
        (b) => b.toolUse !== undefined,
      );

      if (toolUseBlocks.length === 0) {
        // No tool calls — this is the final text response
        const textBlocks = (assistantMessage.content ?? []).filter(
          (b) => b.text !== undefined,
        );
        finalReply = textBlocks.map(b => b.text!).join('\n');
        break;
      }

      // Execute tool calls and collect results
      const toolResults: ContentBlock[] = [];

      for (const block of toolUseBlocks) {
        const toolUse = block.toolUse!;
        const toolName = toolUse.name!;
        const toolInput = toolUse.input as Record<string, any>;

        logger.info({ ...logContext, toolName, round }, '[INTAKE_TOOL_CALL] Executing tool');

        let toolResult: string;
        try {
          const result = await this.executeTool(toolName, toolInput, session);
          toolResult = JSON.stringify(result.output);

          // Track task creation
          if (result.taskCreated) {
            taskCreated = true;
            taskManagementId = result.taskManagementId;
            agentName = result.agentName;
          }
        } catch (err: any) {
          toolResult = JSON.stringify({ error: err.message });
          logger.error({ ...logContext, toolName, error: err.message }, '[INTAKE_TOOL_ERROR]');
        }

        toolResults.push({
          toolResult: {
            toolUseId: toolUse.toolUseId!,
            content: [{ text: toolResult }],
          },
        });
      }

      // Add tool results as user message (Bedrock Converse format)
      messages.push({ role: 'user', content: toolResults });
    }

    // Persist assistant reply
    if (finalReply) {
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: finalReply,
        timestamp: new Date().toISOString(),
      };
      await this.sessionStore.addMessage(session.id, assistantMsg);
    }

    // Update session status if task was created
    if (taskCreated && taskManagementId) {
      await this.sessionStore.updateResolution(session.id, {
        task_management_id: taskManagementId,
        status: 'task_created',
      });
    }

    logger.info({
      ...logContext,
      replyLength: finalReply.length,
      taskCreated,
      taskManagementId,
      agentName,
    }, '[INTAKE_COMPLETE] Message processed');

    return {
      reply: finalReply,
      taskCreated,
      taskManagementId,
      agentName,
      sessionComplete: taskCreated,
    };
  }

  /**
   * Reset a session for follow-up after result delivery.
   * Keeps the conversation history but sets status back to 'active'.
   */
  async enableFollowUp(session: ChatSession): Promise<void> {
    await this.sessionStore.updateStatus(session.id, 'active');
  }

  // ===========================================================================
  // Tool Execution
  // ===========================================================================

  private async executeTool(
    toolName: string,
    input: Record<string, any>,
    session: ChatSession,
  ): Promise<{
    output: any;
    taskCreated?: boolean;
    taskManagementId?: number;
    agentName?: string;
  }> {
    switch (toolName) {
      case 'list_agents':
        return { output: await this.toolListAgents() };

      case 'list_customers':
        return { output: await this.toolListCustomers(input.search) };

      case 'list_repositories':
        return { output: await this.toolListRepositories() };

      case 'create_task':
        return this.toolCreateTask(input, session);

      default:
        return { output: { error: `Unknown tool: ${toolName}` } };
    }
  }

  private async toolListAgents(): Promise<any> {
    const agents = await this.db.getActiveAgents();
    return agents.map(a => ({
      name: a.name,
      description: a.description,
      task_type: a.task_type,
    }));
  }

  private async toolListCustomers(search?: string): Promise<any> {
    const pool = this.db.getPool();
    let query = 'SELECT id, customer, branch, `default` FROM customer_branches';
    const params: any[] = [];

    if (search) {
      query += ' WHERE customer LIKE ?';
      params.push(`%${search}%`);
    }
    query += ' ORDER BY customer';

    const [rows] = await pool.query(query, params);
    return rows;
  }

  private async toolListRepositories(): Promise<any> {
    const repos = await this.db.getAllRepositories();
    return repos.map(r => ({
      id: r.id,
      name: r.repo_name,
      description: r.description,
      default_branch: this.db.getRepositoryDefaultBranch(r),
      provider: 'github',
    }));
  }

  private async toolCreateTask(
    input: Record<string, any>,
    session: ChatSession,
  ): Promise<{
    output: any;
    taskCreated: boolean;
    taskManagementId?: number;
    agentName?: string;
  }> {
    const { agent_name, customer_name, task_description, create_jira, release_version } = input;

    // NOTARY requires a release_version instead of a customer
    if (agent_name?.toUpperCase() === 'NOTARY' && !release_version) {
      return {
        output: { error: 'NOTARY requires a release_version (e.g. "1.10.23"). Please ask the user which release to review.' },
        taskCreated: false,
      };
    }

    // Duplicate task guard — block if a task is already in-flight for this session.
    // Allow a new task if the previous one is done (completed/delivered/failed),
    // so the user can trigger follow-up runs in the same conversation.
    if (session.task_management_id) {
      const pool = this.db.getPool();
      const [tmRows] = await pool.query<any[]>(
        'SELECT status FROM task_management WHERE id = ? LIMIT 1',
        [session.task_management_id],
      );
      const tmStatus: string = tmRows[0]?.status ?? '';
      const isDone = ['completed', 'posted_to_jira', 'failed'].includes(tmStatus);

      if (!isDone) {
        return {
          output: { error: 'A task is already in progress for this conversation. Please wait for it to complete before submitting another.' },
          taskCreated: false,
        };
      }
      // Previous task is done — fall through and create the new task below.
    }

    // Resolve agent
    const agent = await this.db.getAgentByName(agent_name);
    if (!agent) {
      return {
        output: { error: `Agent not found: ${agent_name}. Use list_agents() to see available agents.` },
        taskCreated: false,
      };
    }

    // Resolve customer — NOTARY always uses the internal MHK customer (no client-specific branch needed)
    const resolvedCustomerName = agent_name?.toUpperCase() === 'NOTARY' ? 'MHK' : customer_name;
    if (!resolvedCustomerName) {
      return {
        output: { error: 'customer_name is required. Use list_customers() to see valid customer names.' },
        taskCreated: false,
      };
    }
    const customer = await this.db.getCustomerBranch(resolvedCustomerName);
    if (!customer) {
      return {
        output: { error: `Customer not found: "${resolvedCustomerName}". Use list_customers() to see valid customer names.` },
        taskCreated: false,
      };
    }

    // Use RepoAnalyzer to select only relevant repos (same as the Orchestrator does for JIRA tickets).
    // This prevents over-provisioning repos (e.g. assigning all 7 repos to a HERMES config lookup
    // that only needs core-app), which causes OOM kills in the agent container.
    const allRepos = await this.db.getAllRepositories();
    const repoAnalysis = await this.repoAnalyzer.analyzeTicketForRepos(
      { key: `HARVEY-intake`, fields: { summary: task_description, description: task_description } },
      allRepos,
    );
    const relatedCode = repoAnalysis.selectedRepoIds.join(',');

    // Update session with resolved data
    await this.sessionStore.updateResolution(session.id, {
      resolved_agent_id: agent.id,
      resolved_customer_id: customer.id,
      resolved_repo_ids: relatedCode,
    });

    // Create the task — for NOTARY, jiraNumber holds the release version (e.g. "1.10.23")
    // which NOTARYWorker reads as the release to process
    const result = await this.taskCreator.createTask({
      chatSessionId: session.id,
      agentId: agent.id,
      customerId: customer.id,
      relatedCode,
      taskType: agent.task_type,
      taskDescription: task_description,
      jiraNumber: release_version || undefined,
    });

    logger.info({
      sessionId: session.session_id,
      agentName: agent.name,
      customerName: customer.customer,
      taskManagementId: result.taskManagementId,
    }, '[INTAKE_TASK_CREATED] Task submitted to pipeline');

    return {
      output: {
        success: true,
        task_management_id: result.taskManagementId,
        agent: agent.name,
        customer: customer.customer,
        branch: customer.branch,
        message: `Task created for ${agent.name}. The agent will begin processing shortly.`,
      },
      taskCreated: true,
      taskManagementId: result.taskManagementId,
      agentName: agent.name,
    };
  }

  // ===========================================================================
  // Result Summarization
  // ===========================================================================

  /**
   * Extract a direct 2-3 sentence answer from a full agent result using Bedrock.
   * Used by ResultNotifier to give the user a plain-language answer before
   * showing the full report.
   */
  async extractKeyAnswer(
    fullResult: string,
    agentName: string,
    taskDescription: string,
  ): Promise<string> {
    try {
      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 15000);

      const response = await this.bedrock.send(
        new ConverseCommand({
          modelId: this.modelId,
          system: [{
            text: 'You are a concise technical assistant. Extract the key answer from an agent analysis report. Be direct and specific — no preamble, no "based on the analysis" fluff. Answer in 2-4 sentences maximum.',
          }],
          messages: [{
            role: 'user',
            content: [{
              text: `Task: "${taskDescription}"\n\nAgent (${agentName}) report:\n${fullResult.substring(0, 6000)}\n\nProvide a direct 2-4 sentence answer to the task. Be specific — name exact variables, files, values.`,
            }],
          }],
          inferenceConfig: { maxTokens: 512, temperature: 0.1 },
        }),
        { abortSignal: abortController.signal },
      ).finally(() => clearTimeout(timeout));

      const text = (response.output?.message?.content ?? [])
        .filter(b => b.text !== undefined)
        .map(b => b.text!)
        .join('');

      return text || 'See the full report below for details.';
    } catch (err: any) {
      logger.warn({ error: err.message }, '[INTAKE_EXTRACT_WARN] Could not extract key answer');
      return 'See the full report below for details.';
    }
  }

  // ===========================================================================
  // Message Formatting
  // ===========================================================================

  /**
   * Convert ChatMessage[] history into Bedrock Converse Message[] format
   */
  private buildMessages(history: ChatMessage[]): Message[] {
    const messages: Message[] = [];

    for (const msg of history) {
      if (msg.role === 'system') {
        // Include system context as user messages so the LLM sees result context
        messages.push({
          role: 'user',
          content: [{ text: `[System Context]\n${msg.content}` }],
        });
        continue;
      }
      messages.push({
        role: msg.role as 'user' | 'assistant',
        content: [{ text: msg.content }],
      });
    }

    // Bedrock requires messages to start with 'user' and alternate roles.
    // Merge consecutive same-role messages.
    return this.mergeConsecutiveMessages(messages);
  }

  /**
   * Bedrock Converse API requires strictly alternating user/assistant messages.
   * Merge consecutive messages with the same role.
   */
  private mergeConsecutiveMessages(messages: Message[]): Message[] {
    if (messages.length === 0) return [];

    const merged: Message[] = [messages[0]];

    for (let i = 1; i < messages.length; i++) {
      const prev = merged[merged.length - 1];
      const curr = messages[i];

      if (prev.role === curr.role) {
        // Merge content arrays
        prev.content = [...(prev.content ?? []), ...(curr.content ?? [])];
      } else {
        merged.push(curr);
      }
    }

    return merged;
  }
}
