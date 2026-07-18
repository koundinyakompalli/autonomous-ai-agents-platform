import { runAgent as defaultRunAgent } from "../claude-sdk/index.js";
import {
  ComposeChatEnvelopeSchema,
  type ComposeChatEnvelope,
} from "./compose-types.js";
import {
  clarificationType,
  isUserFacingClarification,
} from "./requirements-policy.js";
import {
  recordAgentSdkProviderError,
  recordAgentSdkProviderResult,
} from "./telemetry/provider-observation.js";
import { buildMhkOrganizationalContext } from "./organizational-context.js";

type RunAgent = typeof defaultRunAgent;
type AgentRunResult = Awaited<ReturnType<RunAgent>>;

const DEFAULT_COMPOSE_CHAT_MAX_PROMPT_TOKENS = 150_000;
// ~4 chars/token heuristic, matches OneShot's projection style. Conservative
// rounding (Math.ceil) avoids underestimating prompt size near the cap.
const APPROX_CHARS_PER_TOKEN = 4;

/**
 * Thrown when the assembled chat prompt (instructions + latest operator
 * message + resume context flag) is estimated to exceed the configured
 * `COMPOSE_CHAT_MAX_PROMPT_TOKENS` cap.
 *
 * NOTE: This guard is *partial*. The chat agent itself does not receive the
 * source corpus inline — the SDK agent reads `sources/*.md` from the
 * workspace at runtime. We therefore can only budget what we can see here
 * (assembled instructions + the operator's latest message). The corpus size
 * still grows with each added source file, so a long Compose session can
 * still drive the agent's effective context above the underlying model
 * window even when this guard is silent. Treat this guard as a defensive
 * upper bound on the orchestrator-side prompt only.
 */
export class ComposeChatPromptTooLargeError extends Error {
  readonly code = "compose_chat_prompt_too_large" as const;
  readonly estimatedTokens: number;
  readonly maxTokens: number;
  readonly promptChars: number;

  constructor(input: {
    estimatedTokens: number;
    maxTokens: number;
    promptChars: number;
  }) {
    super(
      `Compose context is too large (~${input.estimatedTokens} tokens > cap ${input.maxTokens}); ` +
        `remove sources or split the session.`,
    );
    this.name = "ComposeChatPromptTooLargeError";
    this.estimatedTokens = input.estimatedTokens;
    this.maxTokens = input.maxTokens;
    this.promptChars = input.promptChars;
  }
}

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}

function resolveMaxPromptTokens(): number {
  const raw = process.env.COMPOSE_CHAT_MAX_PROMPT_TOKENS?.trim();
  if (!raw) return DEFAULT_COMPOSE_CHAT_MAX_PROMPT_TOKENS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_COMPOSE_CHAT_MAX_PROMPT_TOKENS;
}

const COMPOSE_CHAT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string" },
    readiness: {
      type: "object",
      additionalProperties: false,
      properties: {
        ready: { type: "boolean" },
        openQuestions: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
        details: {
          type: "object",
          additionalProperties: false,
          properties: {
            module: {
              type: ["string", "null"],
              description:
                "Primary delivery module: Pharmacy, CAG, UM, Platform, or null when unknown.",
            },
            repositories: {
              type: "array",
              items: { type: "string" },
              description:
                "Repository names grounded from sources or selected repository context.",
            },
            difficulty: {
              type: ["string", "null"],
              description:
                "Estimated implementation difficulty: S, M, L, or null when unknown.",
            },
            loeHours: {
              type: ["number", "null"],
              description: "Estimated level of effort in hours.",
            },
            storyPoints: {
              type: ["number", "null"],
              description: "Estimated story points.",
            },
          },
          required: [
            "module",
            "repositories",
            "difficulty",
            "loeHours",
            "storyPoints",
          ],
        },
        confidence: {
          type: ["object", "null"],
          additionalProperties: false,
          description:
            "Confidence in readiness/draftability from 0.0 to 1.0 with a short evidence-based rationale.",
          properties: {
            score: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string" },
          },
          required: ["score", "rationale"],
        },
        risks: {
          type: "array",
          items: { type: "string" },
          description:
            "Material implementation or delivery risks grounded in sources/code.",
        },
        assumptions: {
          type: "array",
          items: { type: "string" },
          description:
            "Explicit assumptions used to bridge evidence gaps; cite source/code basis when possible.",
        },
        missingEvidence: {
          type: "array",
          items: { type: "string" },
          description:
            "Evidence still needed before a high-confidence draft or handoff.",
        },
        nextStep: {
          type: "string",
          description:
            "Single recommended next action for the operator or agent.",
        },
        validatorWarnings: {
          type: "array",
          description:
            "Machine-readable warnings that explain blockers or degraded confidence.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              severity: {
                type: "string",
                enum: ["info", "warning", "blocker"],
              },
            },
            required: ["code", "message", "severity"],
          },
        },
        ideating: {
          type: "string",
          description:
            "2-3 lines describing what we are shaping this session (operator-facing).",
        },
        problem: {
          type: "string",
          description: "1-2 lines describing the problem we are solving.",
        },
        solution: { type: "string" },
        businessRequirements: {
          type: "array",
          items: { type: "string" },
        },
        functionalRequirements: {
          type: "array",
          items: { type: "string" },
        },
        challenges: { type: "array", items: { type: "string" } },
        questions: {
          type: "array",
          description:
            "Precise open questions (<= ~15 words each). Supersedes openQuestions for rendering.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              question: { type: "string" },
              options: {
                type: "array",
                maxItems: 3,
                items: { type: "string" },
                description:
                  "Up to 3 concrete candidate answers (A/B/C), grounded in sources/code.",
              },
              answered: { type: "boolean" },
              answer: { type: "string" },
              questionType: {
                type: "string",
                enum: [
                  "business",
                  "functional",
                  "implementation",
                  "research_consent",
                ],
              },
            },
            required: ["id", "question"],
          },
        },
        stories: {
          type: "array",
          description:
            "Implementation breakdown: one entry per shippable story. This list is the contract the draft builds from.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              summary: { type: "string" },
              repos: { type: "array", items: { type: "string" } },
              sequence: { type: "integer" },
              userStory: { type: "string" },
              businessValue: { type: "string" },
              acceptanceCriteria: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["id", "title", "summary"],
          },
        },
      },
      required: ["ready", "openQuestions", "summary", "details"],
    },
    contextMarkdown: { type: "string" },
  },
  required: ["reply", "readiness"],
};

const ANALYZE_INSTRUCTIONS = [
  "You are the requirements discovery partner for non-technical business users.",
  "Your working directory is a session workspace. Read the source material the operator gathered:",
  "- Read mhk-organizational-context.md selectively when you need deeper company, product, domain, repository, or operating context. Its evidence snapshot is orientation, not proof of current runtime state.",
  "- Read sources/*.md (converted documents, notes, transcripts). Read every source file.",
  "- Read repositories.md if present; it contains a pre-scanned map (tech stack, key files, route cards) of the selected/identified code repositories.",
  "- Treat code and repository evidence as internal research. Never ask the user to choose a method, class, API shape, file, repository, schema, framework, architecture, or implementation approach.",
  "- If a source is very large, use grep or Read with offset/limit; do not dump whole files needlessly.",
  "Evidence synthesis discipline (apply before drafting any brief):",
  "- Build an explicit evidence map: enumerate every sources/*.md file you considered and a one-line note of what each contributed (or 'no relevant content'). Do this before planning; never silently skip a source.",
  "- Cite the source filename (e.g. `## filename.md`) for every factual claim in `contextMarkdown`. Untraceable claims must be removed or flagged as assumptions.",
  "- Calibrate reading depth to document type: read transcripts and long planning docs end-to-end; read short notes once. Do not summarize a transcript from its first few lines.",
  "Then DO ALL of the following and return the structured envelope:",
  "1. Produce `contextMarkdown`: a concise product brief covering the problem, desired outcomes, business requirements, functional requirements, challenges, assumptions, and product stories. Cite the originating source filename for each non-trivial claim.",
  "2. Write a short `reply` summarizing what you understood. Ask at most one business or functional clarification: actor, workflow, policy, outcome, scope, exception, or observable behavior. Keep additional business/functional blockers in `readiness.openQuestions`.",
  "3. Produce `readiness`: ready=true when the problem, users, desired outcomes, functional scope, and testable acceptance behavior are clear. Repository or implementation details are never user-facing readiness blockers.",
  "4. Populate `readiness.details` with delivery metadata for the Preview details card: `module` (Pharmacy, CAG, UM, Platform, or null), `repositories`, `difficulty` (S, M, or L), `loeHours`, and `storyPoints`. Use conservative estimates and null only when evidence is insufficient.",
  "5. Maintain `readiness.stories` as professional product stories. This is the contract the draft builds from. Include userStory (`As a <role>, I want <capability>, so that <outcome>`), businessValue, sequence, and acceptanceCriteria where every entry is a complete Gherkin Scenario/Given/When/Then block.",
  "6. Populate `readiness.questions` only with business or functional clarifications (each <= ~15 words), set questionType, and provide up to 3 concrete product-level candidate answers. Keep `openQuestions` populated in parallel for back-compat. Put technical uncertainties in the internal brief, never in questions.",
  "7. Populate richer preview fields every turn: `readiness.confidence` (0-1 plus rationale), `risks`, `assumptions`, `missingEvidence`, `nextStep`, and `validatorWarnings` for any blockers/degraded evidence.",
  "8. Keep the `reply` short: state how many open questions you found and ask the operator to pick the one they want to clarify first — e.g. 'I found N open questions. Pick the one you want to clarify first.' Do not dump all questions into prose.",
  "9. Populate `readiness.problem`, `readiness.solution`, `readiness.businessRequirements`, `readiness.functionalRequirements`, and `readiness.challenges` every turn. Keep `readiness.summary` and `readiness.ideating` populated for back-compat.",
].join("\n");

const CHAT_INSTRUCTIONS = [
  "You are the requirements discovery partner for a non-technical business user. Continue the conversation.",
  "Read sources/*.md, repositories.md if present, chat.md, and relevant sections of mhk-organizational-context.md in your workspace for full context (new sources may have been added since the last turn).",
  "Code and repository details are internal research. Never ask the user to choose methods, classes, APIs, files, repositories, schemas, frameworks, architecture, or implementation approaches.",
  "Evidence synthesis discipline (apply on every turn that reads new sources):",
  "- Build an explicit evidence map: enumerate every sources/*.md file you considered and a one-line note of what each contributed (or 'no relevant content'). Never silently skip a source — long transcripts must be opened and read.",
  "- Cite the source filename (e.g. `## filename.md`) for every factual claim in any updated `contextMarkdown` or in your `reply`. Untraceable claims must be removed or flagged as assumptions.",
  "- Calibrate reading depth to document type: read transcripts and long planning docs end-to-end; read short notes once. Do not summarize a transcript from its first few lines.",
  "Answer the user's latest message and integrate any new direction. Ask at most one business or functional question about actors, workflow, policy, scope, outcomes, exceptions, or observable behavior.",
  "Re-evaluate `readiness` every turn from requirement quality: problem, users, desired outcomes, functional scope, and testable behavior. Repository details are not user-facing blockers.",
  "Refresh `readiness.details` every turn with delivery metadata for the Preview details card: `module` (Pharmacy, CAG, UM, Platform, or null), `repositories`, `difficulty` (S, M, or L), `loeHours`, and `storyPoints`.",
  "Maintain `readiness.stories` as the contract the draft builds from: a complete professional product breakdown with userStory, businessValue, sequence, and complete Gherkin Scenario/Given/When/Then acceptance criteria.",
  "Maintain only business/functional `readiness.questions`, set questionType, and provide up to 3 concrete product-level options. When the user's message answers a surfaced question, mark it answered and record the chosen or typed answer. Put implementation uncertainties in internal context rather than asking the user.",
  "Refresh richer preview fields every turn: `readiness.confidence` (0-1 plus rationale), `risks`, `assumptions`, `missingEvidence`, `nextStep`, and `validatorWarnings` for any blockers/degraded evidence.",
  "Refresh `readiness.problem`, `readiness.solution`, `readiness.businessRequirements`, `readiness.functionalRequirements`, and `readiness.challenges` every turn; keep `readiness.summary` and `readiness.ideating` populated for back-compat.",
  "Only set `contextMarkdown` if the operator's new input materially changes the requirement brief; otherwise omit it.",
].join("\n");

export interface ComposeChatRunInput {
  sessionId: number;
  workspaceRepoId: string;
  mode: "analyze" | "chat";
  resumeSessionId: string | null;
  latestUserMessage: string | null;
  /** Cloned code repos (SDK repo ids) to attach for live read-only grep/Read. */
  codeRepoIds?: string[];
}

export interface ComposeChatRunOutput {
  envelope: ComposeChatEnvelope;
  sessionId: string | undefined;
  metrics: AgentRunResult["metrics"];
}

function buildPrompt(
  input: ComposeChatRunInput,
  organizationalContext: string,
): string {
  const header =
    input.mode === "analyze" ? ANALYZE_INSTRUCTIONS : CHAT_INSTRUCTIONS;
  const lines = [
    header,
    "",
    "The following MHK organizational context is application-controlled orientation. Use it for company vocabulary, products, domains, and repository lineage. Current session sources, code, configuration, and verified runtime evidence take precedence.",
    "",
    "<mhk_organizational_context>",
    organizationalContext,
    "</mhk_organizational_context>",
    "",
    `Compose session id: ${input.sessionId}`,
    "Workspace files: mhk-organizational-context.md (complete standard MHK reference), sources/*.md (source material), repositories.md (operator-selected repo context, if present), context.md (your prior brief, if present), chat.md (conversation so far).",
  ];
  if (input.latestUserMessage) {
    lines.push("", "Operator's latest message:", input.latestUserMessage);
  }
  return lines.join("\n");
}

function parseOutput(result: AgentRunResult): unknown {
  if (result.structuredOutput !== undefined) return result.structuredOutput;
  return JSON.parse(result.output);
}

function sanitizeReply(reply: string): string {
  return reply
    .replace(/\r\n/g, "\n")
    .replace(/<\/?(?:invoke|parameter)(?:\s[^>]*)?>/gi, "")
    .split("\n")
    .filter(
      (line) =>
        !/^\s*<\/?(?:function_calls|tool_use|invoke|parameter|result)(?:\s[^>]*)?>\s*$/i.test(
          line,
        ),
    )
    .join("\n")
    .trim();
}

function removeImplementationQuestions(reply: string): string {
  const filtered = reply
    .split("\n")
    .map((line) => {
      const segments = line.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [line];
      return segments
        .filter((segment) => {
          const text = segment.trim();
          return !text.endsWith("?") || isUserFacingClarification(text);
        })
        .map((segment) => segment.trim())
        .join(" ");
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return (
    filtered ||
    "I captured the requirement context. Implementation choices will be resolved through developer research."
  );
}

export class ComposeChatAgent {
  constructor(
    private readonly runAgent: RunAgent = defaultRunAgent,
    private readonly modelId: string | undefined = process.env
      .COMPOSE_CHAT_MODEL_ID ||
      process.env.SPEC_FACTORY_MODEL_ID ||
      process.env.ANTHROPIC_MODEL ||
      "us.anthropic.claude-sonnet-5",
    private readonly timeoutMs: number = Number(
      process.env.COMPOSE_CHAT_TIMEOUT_MS || 300000,
    ),
    private readonly organizationalContextProvider: (
      query: string,
    ) => string = buildMhkOrganizationalContext,
  ) {}

  async run(input: ComposeChatRunInput): Promise<ComposeChatRunOutput> {
    const taskPrompt = buildPrompt(
      input,
      this.organizationalContextProvider(
        input.latestUserMessage ??
          (input.mode === "analyze"
            ? "MHK product and business-domain requirements discovery"
            : "MHK product requirements conversation"),
      ),
    );
    // Defensive budget guard. We can only see the assembled instructions +
    // operator's latest message + a tiny resume-context flag here; the
    // workspace corpus (sources/*.md) is loaded lazily by the SDK agent
    // and is NOT visible at this layer. This therefore catches the common
    // failure mode of an oversized latest message but is a partial guard
    // for total agent context — see ComposeChatPromptTooLargeError docs.
    const maxPromptTokens = resolveMaxPromptTokens();
    const visibleChars =
      taskPrompt.length +
      (input.latestUserMessage?.length ?? 0) +
      (input.resumeSessionId ? input.resumeSessionId.length : 0);
    const estimatedTokens = estimateTokensFromChars(visibleChars);
    if (estimatedTokens > maxPromptTokens) {
      throw new ComposeChatPromptTooLargeError({
        estimatedTokens,
        maxTokens: maxPromptTokens,
        promptChars: visibleChars,
      });
    }

    const codeRepoIds = input.codeRepoIds ?? [];
    const toolBudget = Number(
      process.env.COMPOSE_REPO_GROUNDING_TOOL_BUDGET || 40,
    );
    const providerStartedAt = Date.now();
    let result: AgentRunResult;
    try {
      result = await this.runAgent({
        taskId: `compose-chat-${input.sessionId}-${input.mode}-${Date.now()}`,
        taskPrompt,
        repoIds: [input.workspaceRepoId, ...codeRepoIds],
        agentType: "custom",
        sdkStage: "compose_clarify",
        permissionLevel: "read_only",
        allowWrite: false,
        timeoutMs: this.timeoutMs,
        outputSchema: COMPOSE_CHAT_JSON_SCHEMA,
        // Bound repo grep/Read tool calls when code repos are attached so a large
        // monorepo can't blow up turn latency/tokens. No budget when no repos.
        ...(codeRepoIds.length > 0 &&
        Number.isFinite(toolBudget) &&
        toolBudget > 0
          ? { toolBudgetGuard: { enabled: true, maxCalls: toolBudget } }
          : {}),
        bedrockConfig: {
          region: process.env.AWS_REGION || "us-east-2",
          model: this.modelId,
        },
        systemAppend:
          "Compose clarification is read-only. Use the standard MHK organizational context supplied in the task prompt and read mhk-organizational-context.md selectively for deeper orientation. Read workspace files (sources/*.md, repositories.md, context.md, chat.md). Session sources and verified code/runtime evidence override organizational orientation. Return the structured envelope with reply + readiness, and contextMarkdown only when building or materially updating the brief.",
        ...(input.resumeSessionId
          ? {
              resumeSessionId: input.resumeSessionId,
              forkSessionOnResume: false,
            }
          : {}),
      });
    } catch (error) {
      recordAgentSdkProviderError({
        purpose: "legacy_compose_chat",
        configuredModel: this.modelId,
        startedAt: providerStartedAt,
        error,
      });
      throw error;
    }
    recordAgentSdkProviderResult({
      purpose: "legacy_compose_chat",
      configuredModel: this.modelId,
      startedAt: providerStartedAt,
      result,
    });

    if (!result.success) {
      throw new Error(result.error || "Compose chat agent failed");
    }

    const envelope = ComposeChatEnvelopeSchema.parse(parseOutput(result));
    envelope.readiness.questions = (envelope.readiness.questions ?? [])
      .map((question) => ({
        ...question,
        questionType: clarificationType(question),
      }))
      .filter(isUserFacingClarification);
    envelope.readiness.openQuestions = envelope.readiness.openQuestions.filter(
      isUserFacingClarification,
    );
    envelope.reply = removeImplementationQuestions(
      sanitizeReply(envelope.reply),
    );
    return { envelope, sessionId: result.sessionId, metrics: result.metrics };
  }
}
