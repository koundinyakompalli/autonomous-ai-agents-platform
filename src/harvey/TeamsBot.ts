/**
 * Harvey Teams Bot
 *
 * Microsoft Bot Framework handler for Teams integration.
 * Receives messages from Teams, forwards them to the IntakeAgent,
 * and sends replies back to the user.
 *
 * ## Teams Interaction Pattern
 * - User sends a message in 1:1 chat with the bot
 * - Bot shows typing indicator while processing
 * - IntakeAgent processes the message (may call tools internally)
 * - Bot sends the final reply as a message
 * - When a task is created, bot sends an Adaptive Card confirmation
 * - When results are ready, ResultNotifier pushes them proactively
 */

import {
  TeamsActivityHandler,
  TurnContext,
  CardFactory,
  type ChannelAccount,
} from "botbuilder";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { IntakeAgent } from "./IntakeAgent.js";
import { SessionStore } from "./SessionStore.js";
import { FileProcessor } from "./FileProcessor.js";
import { AdminQuery } from "./AdminQuery.js";
import {
  buildWelcomeCard,
  buildTaskCreatedCard,
  buildStatusCard,
  buildSessionsCard,
  buildHelpCard,
  buildHistoryCard,
  buildAdminResultCard,
} from "./cards.js";
import { createLogger } from "../utils/logger.js";
import { handleTriageCommand } from "../orchestrator/triage/index.js";
import { getJiraClient } from "../orchestrator/JiraClient.js";
import { getDatabase } from "../orchestrator/database.js";

const logger = createLogger("harvey-teams");

export class HarveyTeamsBot extends TeamsActivityHandler {
  private intakeAgent: IntakeAgent;
  private sessionStore: SessionStore;
  private fileProcessor: FileProcessor;
  private adminQuery: AdminQuery;
  private s3: S3Client;
  private userLocks: Map<string, Promise<void>> = new Map();

  constructor(intakeAgent: IntakeAgent) {
    super();
    this.intakeAgent = intakeAgent;
    this.sessionStore = new SessionStore();
    this.fileProcessor = new FileProcessor();
    this.adminQuery = new AdminQuery();
    this.s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-2" });
  }

  /**
   * Per-user message serialization to prevent race conditions from rapid-fire messages.
   * Chains promises per userId so messages are processed sequentially.
   */
  private async withUserLock(
    userId: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const existing = this.userLocks.get(userId) ?? Promise.resolve();
    const next = existing.then(fn, fn); // chain regardless of success/failure
    this.userLocks.set(userId, next);
    try {
      await next;
    } finally {
      // Clean up if this is still the latest promise
      if (this.userLocks.get(userId) === next) {
        this.userLocks.delete(userId);
      }
    }
  }

  /**
   * Handle incoming messages.
   * Override of ActivityHandler.onMessageActivity (the correct virtual method).
   */
  protected async onMessageActivity(context: TurnContext): Promise<void> {
    const userId = context.activity.from.id;
    const userName = context.activity.from.name ?? "Unknown User";
    const text = (context.activity.text ?? "").trim();

    // Download real file attachments and include their content in the message.
    // Teams provides a pre-authenticated downloadUrl for each uploaded file.
    // Skip Teams internal wrappers (text/html, adaptive cards).
    const attachments = context.activity.attachments ?? [];
    // Process all real file attachments (skip Teams internal HTML wrappers)
    const realFiles = attachments.filter(
      (a) =>
        a.contentType !== "application/vnd.microsoft.card.adaptive" &&
        a.contentType !== "text/html",
    );

    const fileParts: string[] = [];
    for (const attachment of realFiles) {
      const result = await this.fileProcessor.process(attachment, text);
      if (result.ok) {
        fileParts.push(`[File: ${result.name}]\n${result.content}`);
        logger.info(
          { userId, fileName: result.name },
          "[TEAMS_FILE] Processed attachment",
        );
      } else {
        const err = result as { ok: false; reason: string; name: string };
        await context.sendActivity(`⚠️ **${err.name}**: ${err.reason}`);
        logger.warn(
          { userId, fileName: err.name, reason: err.reason },
          "[TEAMS_FILE_SKIP]",
        );
      }
    }

    const fullMessage = [text, ...fileParts].filter(Boolean).join("\n\n");

    if (!fullMessage.trim()) {
      await context.sendActivity("Please send a text message to get started.");
      return;
    }

    // Handle new-session command — /new
    if (fullMessage.trim().toLowerCase() === "/new") {
      await this.sessionStore.forceNew(userId);
      await context.sendActivity(
        "Starting a fresh conversation. Your previous session has been cleared.\n\nWhat can I help you with?",
      );
      return;
    }

    // Handle /sessions — show resumable session list
    if (fullMessage.trim().toLowerCase() === "/sessions") {
      await this.handleSessionsList(context, userId);
      return;
    }

    // Handle __resume:SESSION_UUID__ — sent by Adaptive Card Continue button
    if (fullMessage.trim().startsWith("__resume:")) {
      const sessionId = fullMessage.trim().replace("__resume:", "");
      await this.handleResumeSession(context, userId, sessionId);
      return;
    }

    // Handle /status — show current task status
    if (fullMessage.trim().toLowerCase() === "/status") {
      await this.handleStatus(context, userId);
      return;
    }

    // Handle /help — show all available commands
    if (fullMessage.trim().toLowerCase() === "/help") {
      await this.handleHelp(context);
      return;
    }

    // Handle /triage — analyze a Wiz scan EPIC; --apply creates approved tickets
    // Syntax: /triage CPDEV-XXXXX [--apply] [--dry-run] [--force] [--source wiz|snyk|sonar]
    if (fullMessage.trim().toLowerCase().startsWith("/triage")) {
      await context.sendActivity("⏳ Running TRIAGE on the EPIC...");
      // Initialize singleton with env vars if not already initialized by Orchestrator
      const jiraClient = getJiraClient(
        process.env.JIRA_BASE_URL
          ? {
              baseUrl: process.env.JIRA_BASE_URL,
              username:
                process.env.JIRA_EMAIL ?? process.env.JIRA_USERNAME ?? "",
              token: process.env.JIRA_API_TOKEN ?? process.env.JIRA_TOKEN ?? "",
            }
          : undefined,
      );
      const reply = await handleTriageCommand(
        fullMessage.trim(),
        jiraClient,
        getDatabase(),
      );
      await context.sendActivity(reply);
      return;
    }

    // Handle /history — show recent completed tasks
    if (fullMessage.trim().toLowerCase() === "/history") {
      await this.handleHistory(context, userId);
      return;
    }

    // Handle /cancel — cancel the current in-progress task
    if (fullMessage.trim().toLowerCase() === "/cancel") {
      await this.handleCancel(context, userId);
      return;
    }

    // Handle /share — share the last result via pre-signed URL
    if (fullMessage.trim().toLowerCase() === "/share") {
      await this.handleShare(context, userId);
      return;
    }

    // Handle __download:TASK_MGMT_ID — sent by history card Download button
    if (fullMessage.trim().startsWith("__download:")) {
      const tmId = parseInt(fullMessage.trim().replace("__download:", ""), 10);
      if (!isNaN(tmId)) {
        await this.handleDownload(context, tmId);
      }
      return;
    }

    // Handle __feedback:positive:SESSION_UUID and __feedback:negative:SESSION_UUID
    const feedbackMatch = fullMessage
      .trim()
      .match(/^__feedback:(positive|negative):(.+)$/);
    if (feedbackMatch) {
      const sentiment = feedbackMatch[1] as "positive" | "negative";
      const sessionUuid = feedbackMatch[2];
      await this.handleFeedback(context, sessionUuid, sentiment);
      return;
    }

    // /admin — hidden command, not listed in /help
    if (fullMessage.trim().toLowerCase().startsWith("/admin")) {
      await this.handleAdmin(context, fullMessage.trim());
      return;
    }

    await this.withUserLock(userId, async () => {
      const logContext = {
        userId,
        userName,
        messageLength: text.length,
        conversationId: context.activity.conversation?.id,
      };

      logger.info(logContext, "[TEAMS_MESSAGE] Received message from Teams");

      // Capture conversation reference for proactive messaging
      const convRef = TurnContext.getConversationReference(context.activity);

      // Get or create session
      const session = await this.sessionStore.getOrCreate(
        userId,
        userName,
        "teams",
        convRef,
      );

      logger.debug(
        {
          ...logContext,
          sessionId: session.session_id,
          sessionStatus: session.status,
          messageCount: session.messages_json.length,
        },
        "[TEAMS_SESSION] Session loaded",
      );

      // Show typing indicator while we process
      await context.sendActivity({ type: "typing" });

      try {
        // Forward message to intake agent
        const response = await this.intakeAgent.handleMessage(
          session,
          fullMessage,
        );

        // Send the reply
        if (response.reply) {
          await context.sendActivity(response.reply);
        }

        // If a task was created, send a confirmation card
        if (response.taskCreated && response.agentName) {
          const card = buildTaskCreatedCard(
            response.agentName,
            response.taskManagementId!,
          );
          await context.sendActivity({
            attachments: [CardFactory.adaptiveCard(card)],
          });
        }

        logger.info(
          {
            ...logContext,
            sessionId: session.session_id,
            replyLength: response.reply?.length ?? 0,
            taskCreated: response.taskCreated,
            agentName: response.agentName,
          },
          "[TEAMS_REPLY] Reply sent to Teams",
        );
      } catch (error: any) {
        logger.error(
          {
            ...logContext,
            sessionId: session.session_id,
            error: error.message,
            errorStack: error.stack,
          },
          "[TEAMS_ERROR] Error processing message",
        );

        await context.sendActivity(
          "I'm sorry, I encountered an error processing your request. Please try again.",
        );
      }
    });
  }

  /**
   * Handle members added (welcome message when bot is installed).
   * Override of ActivityHandler.onMembersAddedActivity.
   */
  protected async onMembersAddedActivity(
    membersAdded: ChannelAccount[],
    context: TurnContext,
  ): Promise<void> {
    for (const member of membersAdded) {
      // Don't greet the bot itself
      if (member.id === context.activity.recipient.id) continue;

      await context.sendActivity({
        attachments: [CardFactory.adaptiveCard(buildWelcomeCard())],
      });
    }
  }

  /**
   * Build an Adaptive Card for task creation confirmation
   */
  /**
   * Show the user's recent sessions as an Adaptive Card with Continue buttons.
   */
  private async handleSessionsList(
    context: TurnContext,
    userId: string,
  ): Promise<void> {
    const sessions = await this.sessionStore.getUserSessions(userId);

    if (sessions.length === 0) {
      await context.sendActivity("You have no previous sessions.");
      return;
    }

    const card = buildSessionsCard(sessions, this.timeAgo.bind(this));
    await context.sendActivity({
      attachments: [CardFactory.adaptiveCard(card)],
    });
  }

  /**
   * Resume a previous session — load its history and set it as active.
   */
  private async handleResumeSession(
    context: TurnContext,
    userId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await this.sessionStore.resumeSession(sessionId, userId);

    if (!session) {
      await context.sendActivity(
        "Sorry, that session could not be found or resumed.",
      );
      return;
    }

    // Give the user a quick recap of what was happening in that session
    const messages = session.messages_json ?? [];
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    const recap = lastAssistant
      ? `Continuing your previous conversation. Here's where we left off:\n\n> ${lastAssistant.content.substring(0, 300)}...\n\nWhat would you like to do next?`
      : "Session resumed. What would you like to do?";

    await context.sendActivity(recap);
  }

  private timeAgo(date: Date): string {
    const secs = Math.floor((Date.now() - date.getTime()) / 1000);
    if (secs < 60) return "just now";
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
    return `${Math.floor(secs / 86400)}d ago`;
  }

  /**
   * /status — show current task status
   */
  private async handleStatus(
    context: TurnContext,
    userId: string,
  ): Promise<void> {
    const task = await this.sessionStore.getTaskStatus(userId);

    if (!task) {
      await context.sendActivity(
        "No task in progress. What can I help you with?",
      );
      return;
    }

    // Determine display state
    const tmStatus: string = task.task_status ?? task.status;

    if (
      tmStatus === "completed" ||
      tmStatus === "posted_to_jira" ||
      task.status === "delivered"
    ) {
      await context.sendActivity(
        "Last task completed. Ask follow-up questions or use /new for a new task.",
      );
      return;
    }

    const since = this.timeAgo(new Date(task.updated_at ?? task.created_at));
    const card = buildStatusCard(task, since);
    await context.sendActivity({
      attachments: [CardFactory.adaptiveCard(card)],
    });
  }

  /**
   * /help — show all available commands as an Adaptive Card
   */
  private async handleHelp(context: TurnContext): Promise<void> {
    await context.sendActivity({
      attachments: [CardFactory.adaptiveCard(buildHelpCard())],
    });
  }

  /**
   * /history — show recent completed tasks as an Adaptive Card
   */
  private async handleHistory(
    context: TurnContext,
    userId: string,
  ): Promise<void> {
    const history = await this.sessionStore.getUserHistory(userId, 8);

    if (history.length === 0) {
      await context.sendActivity(
        "No completed tasks found. Results will appear here once an agent finishes your request.",
      );
      return;
    }

    const card = buildHistoryCard(history, this.timeAgo.bind(this));
    await context.sendActivity({
      attachments: [CardFactory.adaptiveCard(card)],
    });
  }

  /**
   * /cancel — cancel the current in-progress task
   */
  private async handleCancel(
    context: TurnContext,
    userId: string,
  ): Promise<void> {
    const cancelled = await this.sessionStore.cancelCurrentTask(userId);
    if (cancelled) {
      await context.sendActivity(
        "Your task has been cancelled. What can I help you with?",
      );
    } else {
      await context.sendActivity("There's no active task to cancel.");
    }
  }

  /**
   * /share — generate a 24h pre-signed URL for the most recent result
   */
  private async handleShare(
    context: TurnContext,
    userId: string,
  ): Promise<void> {
    const info = await this.sessionStore.getLastResultS3Info(userId);

    if (!info) {
      await context.sendActivity(
        "You don't have any completed results to share yet.",
      );
      return;
    }

    const url = await this.generatePresignedUrl(info.bucket, info.key);
    const filename = `${info.agentName}_${info.customerName}.md`.replace(
      /\s+/g,
      "_",
    );

    await context.sendActivity(
      `Here's a shareable link to your last result (expires in 24 hours):\n\n` +
        `📄 [Download: ${filename}](${url})\n\n` +
        "You can copy and share this link with anyone.",
    );
  }

  /**
   * __download:TASK_MGMT_ID — generate a pre-signed URL for a specific history entry
   */
  private async handleDownload(
    context: TurnContext,
    taskManagementId: number,
  ): Promise<void> {
    const info = await this.sessionStore.getResultS3Info(taskManagementId);

    if (!info) {
      await context.sendActivity(
        "Sorry, the result file could not be found for that task.",
      );
      return;
    }

    const url = await this.generatePresignedUrl(info.bucket, info.key);
    const filename = `${info.agentName}_${info.customerName}.md`.replace(
      /\s+/g,
      "_",
    );

    await context.sendActivity(
      `📄 **[Download: ${filename}](${url})**\n*(link expires in 24 hours)*`,
    );
  }

  /**
   * __feedback:positive|negative:SESSION_UUID — record feedback from result card buttons
   */
  private async handleFeedback(
    context: TurnContext,
    sessionUuid: string,
    sentiment: "positive" | "negative",
  ): Promise<void> {
    await this.sessionStore.recordFeedback(sessionUuid, sentiment);
    if (sentiment === "positive") {
      await context.sendActivity("Thanks for the feedback! 👍");
    } else {
      await context.sendActivity("Thanks — I'll note that. 👎");
    }
  }

  /**
   * Generate a pre-signed S3 URL valid for 24 hours.
   */
  private async generatePresignedUrl(
    bucket: string,
    key: string,
  ): Promise<string> {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(this.s3, command, { expiresIn: 86400 });
  }

  /**
   * /admin <question> — hidden command for querying tasks and task_management.
   * Not listed in /help. Translates natural language to SQL via Bedrock.
   */
  private async handleAdmin(
    context: TurnContext,
    fullMessage: string,
  ): Promise<void> {
    const question = fullMessage.replace(/^\/admin\s*/i, "").trim();

    if (!question) {
      await context.sendActivity(
        "**Admin mode.** Ask a question about system activity:\n\n" +
          "- `/admin show me all failed tasks today`\n" +
          "- `/admin how many tasks has DARCI processed this week`\n" +
          "- `/admin last 10 Harvey tasks with their status`\n" +
          "- `/admin total cost by agent this month`\n" +
          "- `/admin tasks that have been retried more than once`",
      );
      return;
    }

    await context.sendActivity({ type: "typing" });

    const result = await this.adminQuery.run(question);
    await context.sendActivity({
      attachments: [
        CardFactory.adaptiveCard(buildAdminResultCard(question, result)),
      ],
    });
  }
}
