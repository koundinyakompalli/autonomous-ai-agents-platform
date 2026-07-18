/**
 * Orchestrator Service
 *
 * Responsibilities:
 * 1. Poll JIRA for new tickets (using agents' JQL queries)
 * 2. Extract customer information from JIRA tickets
 * 3. Lookup/register customer in customer_branches table
 * 4. Analyze ticket to determine relevant code repositories
 * 5. Assign tickets to appropriate agents in task_management table
 * 6. Monitor completed tasks
 * 7. Read results from S3
 * 8. Post results back to JIRA
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { createJiraClient, getJiraClient } from "./JiraClient.js";
import {
  getDatabase,
  type Database,
  type Agent,
  type CustomerBranch,
} from "./database.js";
import {
  resolveOneShotJiraCredentials,
  type OneShotJiraCredentials,
} from "../oneshot/jira-credentials.js";
import { getStorage, type Storage } from "./storage.js";
import { TaskDescriptionGenerator } from "./TaskDescriptionGenerator.js";
import { RepoAnalyzer } from "./RepoAnalyzer.js";
import {
  canRequeueExistingTaskManagementRow,
  IssueAssignmentService,
} from "./IssueAssignmentService.js";
import { OneShotDashboardRunRequestProcessor } from "./OneShotDashboardRunRequestProcessor.js";
import { RepoRouterConfirmationMaterializer } from "./RepoRouterConfirmationMaterializer.js";
import { createS3Client } from "../utils/awsClients.js";
import { createLogger } from "../utils/logger.js";
import { OneShotService } from "../oneshot/service.js";
import { extractOneShotQualifierComment } from "../oneshot/jira-comments.js";
import { validateRepoRouterSchema } from "../oneshot/repo-router/schema-validation.js";
import {
  DOCS_BLOCKED_LABEL,
  DOCS_FAILED_LABEL,
  DOCS_GENERATED_LABEL,
  DOCS_GENERATE_LABEL,
  DOCS_IN_PROGRESS_LABEL,
  DOCS_NOT_QUALIFIED_LABEL,
  DOCS_REPLAN_LABEL,
  DOCUMENTATION_DOCUMENT_TYPE_LABELS,
  getQualifierMode,
  normalizeJiraLabels,
  PFOS_LABEL,
  PFOS_DONE_LABEL,
  PFOS_FAILED_LABEL,
  PFOS_BLOCKED_LABEL,
  PFOS_OUTCOME_LABELS,
  shouldSkipAgentForPfos,
} from "../oneshot/contracts.js";
import { runDocumentationArtifactForIssue } from "../oneshot/documentation/generate.js";
import { runTriage } from "./triage/index.js";
import { getAgentDoneLabel, getAgentFailedLabel } from "./agentDoneLabels.js";
import type { NotificationType, OneShotRun } from "../oneshot/types.js";

const logger = createLogger("orchestrator");

function jiraMutationsDisabled(): boolean {
  return (
    process.env.ONESHOT_DISABLE_JIRA_MUTATIONS?.toLowerCase() === "true" ||
    process.env.ONESHOT_DISABLE_JIRA_COMMENTS?.toLowerCase() === "true"
  );
}

export interface OrchestratorConfig {
  jiraBaseUrl: string;
  jiraToken: string;
  jiraUsername: string;
  pollingIntervalMs?: number;
  resultCheckIntervalMs?: number;
  dashboardRunRequestIntervalMs?: number;
  jiraPollingEnabled?: boolean;
  awsRegion?: string;
  autoReassignTickets?: boolean; // Whether to reassign tickets to reporter after posting results
}

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: string;
    status: { name: string };
    priority?: { name: string };
    labels?: string[];
    assignee?: { displayName: string; accountId?: string };
    reporter?: { displayName: string; accountId?: string };
    created?: string;
    updated?: string;
    [key: string]: any;
  };
}

interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
  maxResults: number;
  startAt: number;
}

/**
 * Orchestrator - Manages JIRA integration and task distribution
 */
export class Orchestrator {
  private config: OrchestratorConfig;
  private db: Database;
  private storage: Storage;
  private s3Client: S3Client;
  private taskDescriptionGenerator: TaskDescriptionGenerator;
  private repoAnalyzer: RepoAnalyzer;
  private issueAssignmentService: IssueAssignmentService;
  private oneShotService: OneShotService | null = null;
  private dashboardRunRequestProcessor: OneShotDashboardRunRequestProcessor | null =
    null;
  private repoRouterConfirmationMaterializer: RepoRouterConfirmationMaterializer | null =
    null;
  private isRunning: boolean = false;
  private isPolling: boolean = false;
  private isCheckingResults: boolean = false;
  private isCheckingDashboardRunRequests: boolean = false;
  private jiraPollingTimer: NodeJS.Timeout | null = null;
  private triageLabelPollTimer: NodeJS.Timeout | null = null;
  private isRunningTriagePoll: boolean = false;
  private resultCheckTimer: NodeJS.Timeout | null = null;
  private dashboardRunRequestTimer: NodeJS.Timeout | null = null;
  private consecutivePollingErrors: number = 0;
  private consecutiveResultErrors: number = 0;
  private consecutiveDashboardRunRequestErrors: number = 0;
  private oneShotWorkspaceCleanupCounter = 0;
  private readonly MAX_BACKOFF_MS = 300000; // Max 5 minute backoff

  constructor(config: OrchestratorConfig) {
    this.config = {
      pollingIntervalMs: 60000, // 1 minute default
      resultCheckIntervalMs: 30000, // 30 seconds default
      dashboardRunRequestIntervalMs: 10000,
      jiraPollingEnabled: true,
      awsRegion: "us-east-2",
      autoReassignTickets: true, // Default: enabled
      ...config,
    };

    this.db = getDatabase();
    this.storage = getStorage();
    this.s3Client = createS3Client({ region: this.config.awsRegion });

    // Initialize TaskDescriptionGenerator with JIRA config for enhanced task generation
    // This enables fetching full JIRA data: ADF description, comments, attachments
    this.taskDescriptionGenerator = new TaskDescriptionGenerator({
      jiraBaseUrl: this.config.jiraBaseUrl,
      jiraUsername: this.config.jiraUsername,
      jiraToken: this.config.jiraToken,
      awsRegion: this.config.awsRegion,
    });

    this.repoAnalyzer = new RepoAnalyzer({ region: this.config.awsRegion });
    this.issueAssignmentService = new IssueAssignmentService(
      this.db,
      this.storage,
      this.taskDescriptionGenerator,
      this.repoAnalyzer,
      {
        jiraBaseUrl: this.config.jiraBaseUrl,
        jiraToken: this.config.jiraToken,
        jiraUsername: this.config.jiraUsername,
      },
    );
  }

  /**
   * Start the orchestrator service
   */
  async start(): Promise<void> {
    logger.info("Starting Orchestrator");

    // Ensure database is connected
    await this.db.connect();
    await validateRepoRouterSchema(this.db.getPool());
    this.oneShotService = new OneShotService(this.db);
    this.dashboardRunRequestProcessor = new OneShotDashboardRunRequestProcessor(
      this.db,
      this.oneShotService,
      this.issueAssignmentService,
    );
    this.repoRouterConfirmationMaterializer =
      new RepoRouterConfirmationMaterializer(
        this.db,
        this.storage,
        this.taskDescriptionGenerator,
        this.issueAssignmentService,
      );

    this.isRunning = true;

    // Initialize the JiraClient singleton with orchestrator credentials so that
    // TRIAGE, triage-report, and TeamsBot can call getJiraClient() without config.
    getJiraClient({
      baseUrl: this.config.jiraBaseUrl,
      username: this.config.jiraUsername,
      token: this.config.jiraToken,
    });

    if (this.config.jiraPollingEnabled) {
      // Start JIRA polling loop
      this.startJiraPolling();
    } else {
      logger.info(
        "JIRA polling disabled for orchestrator; dashboard run-request polling remains enabled",
      );
    }

    // Start result checking loop
    this.startResultChecking();

    // Start dashboard-submitted OneShot run-request loop
    this.startDashboardRunRequestPolling();

    // Start artifact label poll — checks scan EPICs and documentation tasks every 15 min.
    // Gated behind jiraPollingEnabled so deployments that set that flag to false
    // (e.g. OneShot-only or dashboard-only) do not pick up unexpected Jira work.
    // Can be disabled via TRIAGE_LABEL_POLL_ENABLED=false.
    if (this.config.jiraPollingEnabled) {
      this.startTriageLabelPolling();
    }

    logger.info(
      {
        jiraPollingInterval: this.config.pollingIntervalMs,
        jiraPollingEnabled: this.config.jiraPollingEnabled,
        resultCheckInterval: this.config.resultCheckIntervalMs,
        dashboardRunRequestInterval: this.config.dashboardRunRequestIntervalMs,
      },
      "Orchestrator started",
    );
  }

  /**
   * Stop the orchestrator service
   */
  async stop(): Promise<void> {
    logger.info("Stopping Orchestrator");

    this.isRunning = false;

    if (this.jiraPollingTimer) {
      clearTimeout(this.jiraPollingTimer);
      this.jiraPollingTimer = null;
    }

    if (this.resultCheckTimer) {
      clearTimeout(this.resultCheckTimer);
      this.resultCheckTimer = null;
    }

    if (this.dashboardRunRequestTimer) {
      clearTimeout(this.dashboardRunRequestTimer);
      this.dashboardRunRequestTimer = null;
    }

    if (this.triageLabelPollTimer) {
      clearTimeout(this.triageLabelPollTimer);
      this.triageLabelPollTimer = null;
    }

    // Wait for any in-progress operations to complete
    const maxWait = 30000; // 30 seconds
    const startWait = Date.now();
    while (
      (this.isPolling ||
        this.isCheckingResults ||
        this.isCheckingDashboardRunRequests) &&
      Date.now() - startWait < maxWait
    ) {
      logger.info(
        {
          isPolling: this.isPolling,
          isCheckingResults: this.isCheckingResults,
          isCheckingDashboardRunRequests: this.isCheckingDashboardRunRequests,
        },
        "Waiting for in-progress operations to complete",
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    await this.db.disconnect();
    this.oneShotService = null;
    this.dashboardRunRequestProcessor = null;

    logger.info("Orchestrator stopped");
  }

  // ============================================================================
  // JIRA POLLING
  // ============================================================================

  /**
   * Start JIRA polling loop
   */
  private startJiraPolling(): void {
    this.scheduleJiraPolling();
  }

  // ============================================================================
  // TRIAGE LABEL POLL
  // ============================================================================

  /**
   * Start the artifact label polling loop.
   * Checks for scan EPICs labeled *-SCAN-PENDING / *-SCAN-APPROVED and
   * documentation tickets labeled DOCS-GENERATE plus one DOC-TYPE-*.
   *
   * Controlled by TRIAGE_LABEL_POLL_ENABLED env var (default: true in prod).
   * Interval configurable via TRIAGE_LABEL_POLL_INTERVAL_MS (default: 15 min).
   */
  private startTriageLabelPolling(): void {
    if (process.env.TRIAGE_LABEL_POLL_ENABLED?.toLowerCase() === "false") {
      logger.info(
        "Artifact label polling disabled via TRIAGE_LABEL_POLL_ENABLED=false",
      );
      return;
    }
    this.scheduleTriageLabelPoll();
  }

  private scheduleTriageLabelPoll(): void {
    if (!this.isRunning) return;

    const intervalMs = parseInt(
      process.env.TRIAGE_LABEL_POLL_INTERVAL_MS ?? "900000", // 15 minutes
      10,
    );

    this.triageLabelPollTimer = setTimeout(async () => {
      if (!this.isRunning || this.isRunningTriagePoll) return;

      this.isRunningTriagePoll = true;
      try {
        await this.pollForTriageLabels();
      } catch (err) {
        logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          "TRIAGE label poll error",
        );
      } finally {
        this.isRunningTriagePoll = false;
        this.scheduleTriageLabelPoll();
      }
    }, intervalMs);
  }

  private async pollForTriageLabels(): Promise<void> {
    const jiraClient = getJiraClient();
    // autoApply sources skip the SCAN-APPROVED human gate: a PENDING epic runs
    // "apply" directly (create stories + PFOS → OneShot). Gated sources (Wiz
    // dependency-CVE, Sonar) run "analyze" on PENDING and only "apply" once a
    // human adds SCAN-APPROVED.
    const sources: Array<{
      prefix: "WIZ" | "WIZ-CODE" | "SONAR";
      source: "wiz" | "wiz-code" | "sonar";
      autoApply: boolean;
    }> = [
      { prefix: "WIZ", source: "wiz", autoApply: false },
      { prefix: "WIZ-CODE", source: "wiz-code", autoApply: true },
      { prefix: "SONAR", source: "sonar", autoApply: false },
    ];

    let matchedTotal = 0;
    for (const { prefix, source, autoApply } of sources) {
      if (autoApply) {
        // No approval gate: PENDING → apply directly. Exclude epics already
        // being processed or finished so we don't re-trigger.
        const pendingJql =
          `project = CPDEV AND issuetype = Epic AND labels = "${prefix}-SCAN-PENDING" ` +
          `AND labels not in ("${prefix}-SCAN-IN-PROGRESS", "${prefix}-SCAN-COMPLETE", "${prefix}-SCAN-COMPLETE-WITH-EXCEPTIONS", "${prefix}-SCAN-FAILED")`;
        const pending = await jiraClient.searchIssues(
          pendingJql,
          "key,summary,labels",
        );
        matchedTotal += pending.total;
        await this.runTriageForIssues(pending.issues, "apply", source);
        continue;
      }

      const approvedJql =
        `project = CPDEV AND issuetype = Epic AND labels = "${prefix}-SCAN-APPROVED" ` +
        `AND labels not in ("${prefix}-SCAN-IN-PROGRESS")`;
      const pendingJql =
        `project = CPDEV AND issuetype = Epic AND labels = "${prefix}-SCAN-PENDING" ` +
        `AND labels not in ("${prefix}-SCAN-REVIEW-READY", "${prefix}-SCAN-APPROVED", "${prefix}-SCAN-IN-PROGRESS")`;

      const approved = await jiraClient.searchIssues(
        approvedJql,
        "key,summary,labels",
      );
      matchedTotal += approved.total;
      await this.runTriageForIssues(approved.issues, "apply", source);

      const pending = await jiraClient.searchIssues(
        pendingJql,
        "key,summary,labels",
      );
      matchedTotal += pending.total;
      await this.runTriageForIssues(pending.issues, "analyze", source);
    }

    matchedTotal += await this.pollForDocumentationLabels();

    if (matchedTotal === 0) {
      logger.debug(
        "Artifact label poll: no eligible scan EPICs or documentation tickets found",
      );
    }
  }

  private async pollForDocumentationLabels(): Promise<number> {
    if (
      process.env.DOCUMENTATION_LABEL_POLL_ENABLED?.toLowerCase() === "false"
    ) {
      logger.debug(
        "Documentation label polling disabled via DOCUMENTATION_LABEL_POLL_ENABLED=false",
      );
      return 0;
    }

    const jiraClient = getJiraClient();
    // Completion-terminal labels exclude a ticket from selection once a run has
    // reached a terminal state. DOCS-REPLAN overrides this so a reviewer can
    // regenerate a DOCS-BLOCKED (review-required) ticket. DOCS-IN-PROGRESS is a
    // separate hard exclusion so an in-flight run is never double-processed,
    // even if it also carries a stale DOCS-REPLAN label.
    const completionTerminalLabels = [
      DOCS_GENERATED_LABEL,
      DOCS_NOT_QUALIFIED_LABEL,
      DOCS_BLOCKED_LABEL,
      DOCS_FAILED_LABEL,
    ];
    const parsedLimit = Number.parseInt(
      process.env.DOCUMENTATION_LABEL_POLL_LIMIT ?? "25",
      10,
    );
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 25;
    const docsJql =
      `project = CPDEV AND labels = "${DOCS_GENERATE_LABEL}" ` +
      `AND labels in (${DOCUMENTATION_DOCUMENT_TYPE_LABELS.map((label) => `"${label}"`).join(", ")}) ` +
      `AND labels not in ("${DOCS_IN_PROGRESS_LABEL}") ` +
      `AND (labels = "${DOCS_REPLAN_LABEL}" ` +
      `OR labels not in (${completionTerminalLabels.map((label) => `"${label}"`).join(", ")})) ` +
      "ORDER BY updated ASC";

    const documentationIssues = await jiraClient.searchIssues(
      docsJql,
      "key,summary,labels",
    );
    const issuesToProcess = documentationIssues.issues.slice(0, limit);

    if (issuesToProcess.length === 0) {
      return 0;
    }

    if (documentationIssues.total > issuesToProcess.length) {
      logger.info(
        {
          total: documentationIssues.total,
          processing: issuesToProcess.length,
          limit,
        },
        "Documentation label poll limited eligible ticket batch",
      );
    }

    await this.runDocumentationForIssues(issuesToProcess);
    return issuesToProcess.length;
  }

  private async runDocumentationForIssues(
    issues: Array<{ key: string }>,
  ): Promise<void> {
    if (issues.length === 0) return;

    logger.info(
      { count: issues.length },
      "Documentation label poll: found matching ticket(s)",
    );

    const jiraClient = getJiraClient();
    for (const issue of issues) {
      try {
        // Mark in-progress and clear any prior completion-terminal state and
        // the DOCS-REPLAN trigger. A regeneration ticket (DOCS-BLOCKED +
        // DOCS-REPLAN) must not carry those labels through the new run, or its
        // terminal transition would be ambiguous and the replan trigger would
        // re-select it indefinitely.
        await jiraClient.updateIssueLabels(issue.key, {
          add: [DOCS_IN_PROGRESS_LABEL],
          remove: [
            DOCS_REPLAN_LABEL,
            DOCS_BLOCKED_LABEL,
            DOCS_FAILED_LABEL,
            DOCS_GENERATED_LABEL,
            DOCS_NOT_QUALIFIED_LABEL,
          ],
        });
        const result = await runDocumentationArtifactForIssue({
          issueKey: issue.key,
          attachToJira: true,
          addJiraComment: true,
          jiraConfig: {
            baseUrl: this.config.jiraBaseUrl,
            username: this.config.jiraUsername,
            token: this.config.jiraToken,
          },
        });
        logger.info(
          {
            issueKey: issue.key,
            documentTypeLabel: result.documentTypeLabel,
            attachments: result.attachmentResult?.filenames.length ?? 0,
          },
          "Documentation artifact run completed from label poll",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(
          {
            issueKey: issue.key,
            error: message,
          },
          "Documentation artifact run failed from label poll",
        );
        await this.recordDocumentationPollFailure(issue.key, message);
      }
    }
  }

  private async recordDocumentationPollFailure(
    issueKey: string,
    message: string,
  ): Promise<void> {
    const jiraClient = getJiraClient();
    await jiraClient.updateIssueLabels(issueKey, {
      add: [DOCS_FAILED_LABEL],
      remove: [DOCS_IN_PROGRESS_LABEL],
    });
    await jiraClient.addComment(
      issueKey,
      [
        "OneShot documentation artifact generation failed.",
        "",
        `Error: ${message}`,
        "",
        `After fixing the issue, remove ${DOCS_FAILED_LABEL} and rerun the documentation artifact flow.`,
      ].join("\n"),
    );
    await this.db
      .upsertOneShotArtifactRun({
        sourceKey: issueKey,
        sourceParentKey: null,
        mode: "documentation",
        status: "failed",
        title: `Documentation artifact run failed for ${issueKey}`,
        generatedCount: 0,
        generatedTickets: [],
        humanReviewRequired: true,
        humanReviewCount: 1,
        reviewItems: [message],
        evidence: { source: "orchestrator_label_poll" },
        artifactRefs: {},
        jiraSummary: `Documentation artifact generation failed: ${message}`,
        completedAt: new Date(),
      })
      .catch((error) => {
        logger.warn(
          {
            issueKey,
            error: error instanceof Error ? error.message : String(error),
          },
          "Could not record failed documentation artifact run",
        );
      });
  }

  private async runTriageForIssues(
    issues: Array<{ key: string }>,
    mode: "analyze" | "apply",
    sourceOverride?: "wiz" | "wiz-code" | "sonar",
  ): Promise<void> {
    if (issues.length === 0) return;
    logger.info(
      { count: issues.length, mode },
      "TRIAGE label poll: found matching EPIC(s)",
    );

    const jiraClient = getJiraClient();
    for (const issue of issues) {
      try {
        logger.info(
          { epicKey: issue.key, mode },
          "Auto-triggering TRIAGE for EPIC",
        );
        await runTriage(jiraClient, this.db, {
          epicKey: issue.key,
          mode,
          dryRun: false,
          force: false,
          sourceOverride,
        });
      } catch (err) {
        logger.error(
          {
            epicKey: issue.key,
            error: err instanceof Error ? err.message : String(err),
          },
          "TRIAGE auto-trigger failed for EPIC",
        );
      }
    }
  }

  /**
   * Schedule next JIRA poll with exponential backoff on errors
   */
  private scheduleJiraPolling(): void {
    if (!this.isRunning) return;

    const backoffDelay =
      this.consecutivePollingErrors > 0
        ? Math.min(
            this.config.pollingIntervalMs! *
              Math.pow(2, this.consecutivePollingErrors),
            this.MAX_BACKOFF_MS,
          )
        : this.config.pollingIntervalMs!;

    if (this.consecutivePollingErrors > 0) {
      logger.warn(
        {
          consecutiveErrors: this.consecutivePollingErrors,
          backoffMs: backoffDelay,
        },
        "JIRA polling with backoff due to errors",
      );
    }

    this.jiraPollingTimer = setTimeout(
      async () => {
        if (!this.isRunning) return;

        // Prevent overlapping poll cycles
        if (this.isPolling) {
          logger.debug("Skipping JIRA poll - previous still running");
          this.scheduleJiraPolling();
          return;
        }

        this.isPolling = true;
        try {
          await this.pollJiraForAllAgents();
          this.consecutivePollingErrors = 0;
        } catch (error) {
          this.consecutivePollingErrors++;
          logger.error(
            {
              error,
              consecutiveErrors: this.consecutivePollingErrors,
            },
            "Error in JIRA polling",
          );
        } finally {
          this.isPolling = false;
          this.scheduleJiraPolling();
        }
      },
      this.jiraPollingTimer ? backoffDelay : 0,
    );
  }

  /**
   * Poll JIRA for all active agents
   */
  private async pollJiraForAllAgents(): Promise<void> {
    logger.info("Polling JIRA for all agents");

    const agents = await this.db.getActiveAgents();

    for (const agent of agents) {
      try {
        await this.pollJiraForAgent(agent);
      } catch (error) {
        logger.error(
          {
            agent: agent.name,
            error,
          },
          "Error polling JIRA for agent",
        );
      }
    }

    logger.info({ agentCount: agents.length }, "JIRA polling complete");
  }

  /**
   * Poll JIRA for a specific agent using its JQL and token
   */
  private async pollJiraForAgent(agent: Agent): Promise<void> {
    logger.info(
      {
        agent: agent.name,
        jql: agent.jql,
        hasAgentToken: !!agent.jira_token,
        agentTokenValue: agent.jira_token ? "SET" : "NULL",
      },
      `Polling JIRA for agent: ${agent.name}`,
    );

    try {
      // Use agent-specific JIRA token
      const issues = await this.searchJira(agent.jql, agent.jira_token);

      const issueKeys = issues.map((i) => i.key);
      logger.info(
        {
          agent: agent.name,
          count: issues.length,
          issueKeys:
            issueKeys.slice(0, 5).join(", ") +
            (issueKeys.length > 5 ? "..." : ""),
        },
        "Found JIRA issues",
      );

      for (const issue of issues) {
        try {
          await this.assignIssueToAgent(issue, agent);
        } catch (error) {
          logger.error(
            {
              issue: issue.key,
              agent: agent.name,
              error: error instanceof Error ? error.message : String(error),
              errorStack: error instanceof Error ? error.stack : undefined,
            },
            "Failed to assign issue to agent",
          );
          // Continue processing other issues
        }
      }
    } catch (error) {
      logger.error(
        {
          agent: agent.name,
          jql: agent.jql,
          error: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          errorName: error instanceof Error ? error.name : undefined,
          hasAgentToken: !!agent.jira_token,
          agentId: agent.id,
        },
        `Failed to poll JIRA for agent: ${agent.name}`,
      );
      // Don't throw - continue polling other agents
    }
  }

  /**
   * Search JIRA using JQL with agent-specific token
   * Updated to use /rest/api/3/search/jql endpoint (new API)
   */
  private async searchJira(
    jql: string,
    jiraToken: string,
  ): Promise<JiraIssue[]> {
    // Use agent token if available, otherwise fall back to global token
    const tokenToUse = jiraToken || this.config.jiraToken;

    logger.info(
      {
        hasAgentToken: !!jiraToken,
        usingFallback: !jiraToken,
        jql: jql.substring(0, 100),
        baseUrl: this.config.jiraBaseUrl,
        username: this.config.jiraUsername,
      },
      "JIRA search request",
    );

    const auth = Buffer.from(
      `${this.config.jiraUsername}:${tokenToUse}`,
    ).toString("base64");

    // Use the new /rest/api/3/search/jql endpoint
    const url = `${this.config.jiraBaseUrl}/rest/api/3/search/jql`;

    // New API uses POST with JSON body instead of GET with query params
    const requestBody = {
      jql,
      maxResults: 50,
      fields: [
        "summary",
        "description",
        "status",
        "priority",
        "labels",
        "assignee",
      ],
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response
          .text()
          .catch(() => "Unable to read error response");
        logger.error({
          msg: "JIRA API request failed",
          status: response.status,
          statusText: response.statusText,
          errorBody: errorText,
          url,
          jql: jql.substring(0, 100),
          hasToken: !!tokenToUse,
          tokenLength: tokenToUse ? tokenToUse.length : 0,
        });
        throw new Error(
          `JIRA API error: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      const data = (await response.json()) as JiraSearchResponse;
      logger.info(
        {
          issueCount: data.issues?.length || 0,
          total: data.total,
        },
        "JIRA search successful",
      );
      return data.issues || [];
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          url,
          jql: jql.substring(0, 100),
        },
        "JIRA search exception",
      );
      throw error;
    }
  }

  /**
   * Assign JIRA issue to agent
   */
  private async assignIssueToAgent(
    issue: JiraIssue,
    agent: Agent,
  ): Promise<void> {
    const issueLabels = issue.fields.labels || [];
    if (shouldSkipAgentForPfos(agent.name, issueLabels)) {
      logger.debug(
        {
          jira: issue.key,
          agent: agent.name,
          labels: issueLabels,
        },
        "Skipping issue due to OneShot intake exclusivity rules",
      );
      return;
    }

    const isQualifier = agent.name.trim().toUpperCase() === "QUALIFIER";
    const latestOneShotRun =
      issueLabels.length > 0 && this.oneShotService
        ? await this.oneShotService.getLatestRunByJiraKey(issue.key)
        : null;
    const qualifierMode = isQualifier
      ? getQualifierMode(issueLabels, latestOneShotRun)
      : null;

    if (isQualifier && !qualifierMode) {
      logger.info(
        {
          jira: issue.key,
          latestRunState: latestOneShotRun?.state,
          labels: issueLabels,
        },
        "Skipping QUALIFIER assignment because OneShot intake state is not actionable",
      );
      return;
    }

    // Check if already assigned TO THIS AGENT
    // Using jira+agent combo allows same ticket to be processed by multiple agents
    const existing = await this.db.getTaskManagementByJiraAndAgent(
      issue.key,
      agent.id,
    );
    if (existing?.status === "completed") {
      const retryCount = existing.retry_count ?? 0;
      if (retryCount >= 3) {
        await this.db.resetTaskManagementJiraPostRetry(existing.id);
        logger.info(
          {
            jira: issue.key,
            agent: agent.name,
            existingStatus: existing.status,
            existingId: existing.id,
            retryCount,
          },
          "Existing completed task exhausted Jira-post retries - reopening Jira-post retry",
        );
      } else {
        logger.info(
          {
            jira: issue.key,
            agent: agent.name,
            existingStatus: existing.status,
            existingId: existing.id,
            retryCount,
          },
          "Existing completed task is already pending Jira posting - skipping reassignment",
        );
      }
      return;
    }

    // Allow re-trigger when agent's FAILED label has been removed from the ticket
    if (
      existing &&
      (existing.status === "failed_retries_exhausted" ||
        (existing.status === "failed" && (existing.retry_count ?? 0) >= 3))
    ) {
      const failedLabel = getAgentFailedLabel(agent.name);
      if (failedLabel && !issueLabels.includes(failedLabel)) {
        await this.db.resetTaskManagementForRetrigger(existing.id);
        logger.info(
          {
            jira: issue.key,
            agent: agent.name,
            existingId: existing.id,
            previousStatus: existing.status,
            removedLabel: failedLabel,
          },
          "Agent failed label removed — resetting task for re-processing",
        );
        existing.status = "failed";
        existing.retry_count = 0;
      }
    }

    if (
      existing &&
      !canRequeueExistingTaskManagementRow(existing, isQualifier)
    ) {
      logger.info(
        {
          jira: issue.key,
          agent: agent.name,
          existingStatus: existing.status,
          existingId: existing.id,
        },
        "Issue already assigned to this agent - skipping",
      );
      return;
    }

    const assignmentStart = Date.now();
    logger.info(
      {
        jira: issue.key,
        agent: agent.name,
        summary: issue.fields.summary?.substring(0, 100),
        existingId: existing?.id,
        existingStatus: existing?.status,
      },
      existing
        ? "Requeueing existing issue for agent"
        : "Assigning new issue to agent",
    );

    try {
      const assignment = await this.issueAssignmentService.assignIssueToAgent(
        issue,
        agent,
        {
          existingTaskManagement: existing,
          qualifierMode,
        },
      );

      logger.info(
        {
          jira: issue.key,
          agent: agent.name,
          assignmentMs: Date.now() - assignmentStart,
          taskManagementId: assignment.taskManagementId,
          disposition: assignment.disposition,
        },
        "Issue assignment completed",
      );
    } catch (error) {
      logger.error(
        {
          jira: issue.key,
          agent: agent.name,
          error,
        },
        "Failed to assign issue to agent",
      );
      throw error;
    }
  }

  /**
   * Start dashboard-submitted OneShot run-request polling loop.
   */
  private startDashboardRunRequestPolling(): void {
    this.scheduleDashboardRunRequestPolling();
  }

  /**
   * Schedule the next dashboard run-request check with exponential backoff.
   */
  private scheduleDashboardRunRequestPolling(): void {
    if (!this.isRunning) return;

    const backoffDelay =
      this.consecutiveDashboardRunRequestErrors > 0
        ? Math.min(
            this.config.dashboardRunRequestIntervalMs! *
              Math.pow(2, this.consecutiveDashboardRunRequestErrors),
            this.MAX_BACKOFF_MS,
          )
        : this.config.dashboardRunRequestIntervalMs!;

    if (this.consecutiveDashboardRunRequestErrors > 0) {
      logger.warn(
        {
          consecutiveErrors: this.consecutiveDashboardRunRequestErrors,
          backoffMs: backoffDelay,
        },
        "Dashboard run-request polling with backoff due to errors",
      );
    }

    this.dashboardRunRequestTimer = setTimeout(
      async () => {
        if (!this.isRunning) return;

        if (this.isCheckingDashboardRunRequests) {
          logger.debug(
            "Skipping dashboard run-request check - previous cycle still running",
          );
          this.scheduleDashboardRunRequestPolling();
          return;
        }

        this.isCheckingDashboardRunRequests = true;
        try {
          await this.checkDashboardRunRequests();
          this.consecutiveDashboardRunRequestErrors = 0;
        } catch (error) {
          this.consecutiveDashboardRunRequestErrors += 1;
          logger.error(
            {
              error,
              consecutiveErrors: this.consecutiveDashboardRunRequestErrors,
            },
            "Error checking dashboard run requests",
          );
        } finally {
          this.isCheckingDashboardRunRequests = false;
          this.scheduleDashboardRunRequestPolling();
        }
      },
      this.dashboardRunRequestTimer ? backoffDelay : 0,
    );
  }

  private async checkDashboardRunRequests(): Promise<void> {
    if (!this.dashboardRunRequestProcessor) {
      return;
    }

    if (this.repoRouterConfirmationMaterializer) {
      const confirmationResult =
        await this.repoRouterConfirmationMaterializer.processPendingSelections();
      if (
        confirmationResult.processed > 0 ||
        confirmationResult.failed > 0 ||
        confirmationResult.stale > 0 ||
        confirmationResult.skippedBackoff > 0
      ) {
        logger.info(
          confirmationResult,
          "Processed RepoRouter confirmation materialization",
        );
      }
    }

    const result =
      await this.dashboardRunRequestProcessor.processQueuedRequests();
    if (result.processed > 0 || result.failed > 0) {
      logger.info(result, "Processed dashboard-submitted OneShot run requests");
    }
  }

  // ============================================================================
  // RESULT CHECKING AND POSTING
  // ============================================================================

  /**
   * Start result checking loop
   */
  private startResultChecking(): void {
    this.scheduleResultChecking();
  }

  /**
   * Schedule next result check with exponential backoff on errors
   */
  private scheduleResultChecking(): void {
    if (!this.isRunning) return;

    const backoffDelay =
      this.consecutiveResultErrors > 0
        ? Math.min(
            this.config.resultCheckIntervalMs! *
              Math.pow(2, this.consecutiveResultErrors),
            this.MAX_BACKOFF_MS,
          )
        : this.config.resultCheckIntervalMs!;

    if (this.consecutiveResultErrors > 0) {
      logger.warn(
        {
          consecutiveErrors: this.consecutiveResultErrors,
          backoffMs: backoffDelay,
        },
        "Result checking with backoff due to errors",
      );
    }

    this.resultCheckTimer = setTimeout(
      async () => {
        if (!this.isRunning) return;

        // Prevent overlapping check cycles
        if (this.isCheckingResults) {
          logger.debug("Skipping result check - previous still running");
          this.scheduleResultChecking();
          return;
        }

        this.isCheckingResults = true;
        try {
          await this.checkAndPostResults();
          this.consecutiveResultErrors = 0;
        } catch (error) {
          this.consecutiveResultErrors++;
          logger.error(
            {
              error,
              consecutiveErrors: this.consecutiveResultErrors,
            },
            "Error in result checking",
          );
        } finally {
          this.isCheckingResults = false;
          this.scheduleResultChecking();
        }
      },
      this.resultCheckTimer ? backoffDelay : 0,
    );
  }

  /**
   * Check for completed tasks and post results to JIRA
   *
   * Uses an atomic claim pattern to prevent duplicate posting:
   * 1. Fetch pending tasks (status = 'completed')
   * 2. For each task, atomically claim it (completed → posting_to_jira)
   * 3. Only post if the claim succeeded (affectedRows = 1)
   * 4. On success: mark as posted_to_jira
   * 5. On failure: release claim back to completed for retry
   */
  private async checkAndPostResults(): Promise<void> {
    logger.debug("Checking for completed tasks");

    const pendingPosts = await this.db.getTasksPendingJiraPost(10);

    if (pendingPosts.length === 0) {
      logger.debug("No pending JIRA posts");
    } else {
      logger.info(
        {
          count: pendingPosts.length,
        },
        "Found completed tasks pending JIRA posting",
      );

      for (const task of pendingPosts) {
        try {
          // Atomically claim this task to prevent duplicate posting.
          // If another orchestrator instance (or a re-entrant cycle) already
          // claimed it, claimTaskForJiraPost returns false and we skip it.
          const claimed = await this.db.claimTaskForJiraPost(task.id);
          if (!claimed) {
            logger.info(
              {
                jira: task.jira_number,
                agent: task.agent_name,
                tmId: task.id,
              },
              "Task already claimed by another process, skipping",
            );
            continue;
          }

          logger.info(
            {
              jira: task.jira_number,
              agent: task.agent_name,
              tmId: task.id,
              retryCount: task.retry_count,
              s3Bucket: task.result_s3_bucket,
              s3Key: task.result_s3_key,
            },
            "[POST_RESULT_CLAIMED] Claimed task for JIRA posting",
          );

          await this.postResultToJira(task);
        } catch (error: any) {
          logger.error(
            {
              jira: task.jira_number,
              agent: task.agent_name,
              tmId: task.id,
              retryCount: task.retry_count,
              errorName: error?.name,
              errorMessage: error?.message,
              errorStack: error?.stack,
            },
            "[POST_RESULT_FAILED] Failed to post result to JIRA — releasing claim for retry",
          );

          // Release the claim back to 'completed' so it can be retried,
          // and increment retry_count to track failures.
          await this.db.releaseTaskClaim(task.id);
        }
      }
    }

    await this.checkAndPostOneShotNotifications();
    await this.checkAndReconcileOneShotRuns();
    await this.checkAndBackfillOneShotTerminationPostmortems();
    await this.checkAndCleanupOneShotWorkspaces();
  }

  private classifyPfosOutcome(
    notificationType: NotificationType,
    run: Pick<OneShotRun, "state" | "current_pr_url"> | null,
  ): string | null {
    if (run?.current_pr_url?.trim()) {
      return PFOS_DONE_LABEL;
    }

    switch (notificationType) {
      case "run_failed":
      case "budget_exceeded":
        return PFOS_FAILED_LABEL;
      default:
        break;
    }

    if (run?.state === "failed") {
      return PFOS_FAILED_LABEL;
    }

    if (
      run &&
      this.isPfosBlockedOutcomeNotification(notificationType) &&
      (run.state === "blocked" ||
        run.state === "escalated" ||
        run.state === "replan_required")
    ) {
      return PFOS_BLOCKED_LABEL;
    }

    return null;
  }

  private isPfosOutcomeCandidateNotification(
    notificationType: NotificationType,
  ): boolean {
    switch (notificationType) {
      case "pr_ready":
      case "pr_draft":
      case "pr_with_risks":
      case "pr_needs_review":
      case "pr_created":
      case "run_failed":
      case "budget_exceeded":
      case "review_blocked":
      case "review_escalated":
      case "code_review_blocked":
      case "code_review_escalated":
      case "progress_update":
      case "branch_drift":
        return true;
      default:
        return false;
    }
  }

  private isPfosBlockedOutcomeNotification(
    notificationType: NotificationType,
  ): boolean {
    switch (notificationType) {
      case "review_blocked":
      case "review_escalated":
      case "code_review_blocked":
      case "code_review_escalated":
      case "progress_update":
      case "branch_drift":
        return true;
      default:
        return false;
    }
  }

  private async checkAndPostOneShotNotifications(): Promise<void> {
    if (!this.oneShotService) {
      return;
    }

    const pendingNotifications =
      await this.oneShotService.database.notifications.getPendingNotifications(
        10,
      );
    if (pendingNotifications.length === 0) {
      logger.debug("No pending OneShot notifications");
      return;
    }

    logger.info(
      {
        count: pendingNotifications.length,
      },
      "Found pending OneShot notifications",
    );

    const jiraCredentials =
      await this.resolveOneShotNotificationJiraCredentials();
    const jiraClient = createJiraClient({
      baseUrl: this.config.jiraBaseUrl,
      username: jiraCredentials.username,
      token: jiraCredentials.token,
    });

    for (const notification of pendingNotifications) {
      try {
        const claimed =
          await this.oneShotService.database.notifications.claimNotificationForPosting(
            notification.id,
          );
        if (!claimed) {
          logger.info(
            {
              notificationId: notification.id,
              jira: notification.jira_key,
              type: notification.notification_type,
            },
            "OneShot notification already claimed by another process, skipping",
          );
          continue;
        }

        if (notification.notification_type === "completed") {
          await this.oneShotService.database.notifications.markNotificationPosted(
            notification.id,
          );

          logger.warn(
            {
              notificationId: notification.id,
              jira: notification.jira_key,
              type: notification.notification_type,
              runId: notification.oneshot_run_id,
            },
            "Drained legacy OneShot completed notification without changing run state",
          );
          continue;
        }

        const needsRun = this.isPfosOutcomeCandidateNotification(
          notification.notification_type,
        );
        const run = needsRun
          ? await this.oneShotService.database.runs.getRunById(
              notification.oneshot_run_id,
            )
          : null;
        const outcomeLabel = this.classifyPfosOutcome(
          notification.notification_type,
          run,
        );

        if (outcomeLabel !== null) {
          const issue = await jiraClient.fetchIssue(notification.jira_key);
          const issueLabels = normalizeJiraLabels(issue.fields.labels);
          if (issueLabels.has(PFOS_LABEL)) {
            await jiraClient.updateIssueLabels(notification.jira_key, {
              add: [outcomeLabel],
              remove: PFOS_OUTCOME_LABELS.filter(
                (l) => l !== outcomeLabel,
              ) as string[],
            });
          }
        }

        await this.addJiraComment(
          notification.jira_key,
          notification.body_markdown,
          jiraCredentials.token,
          jiraCredentials.username,
        );

        await this.oneShotService.database.notifications.markNotificationPosted(
          notification.id,
        );

        logger.info(
          {
            notificationId: notification.id,
            jira: notification.jira_key,
            type: notification.notification_type,
          },
          "OneShot notification posted to JIRA",
        );
      } catch (error: any) {
        logger.error(
          {
            notificationId: notification.id,
            jira: notification.jira_key,
            type: notification.notification_type,
            errorName: error?.name,
            errorMessage: error?.message,
            errorStack: error?.stack,
          },
          "[ONESHOT_NOTIFICATION_FAILED] Failed to post OneShot notification — releasing claim for retry",
        );

        await this.oneShotService.database.notifications.releaseNotificationClaim(
          notification.id,
        );
      }
    }
  }

  private async resolveOneShotNotificationJiraCredentials(): Promise<OneShotJiraCredentials> {
    return (
      (await resolveOneShotJiraCredentials({
        getAgentByName: (name) => this.db.getAgentByName(name),
        fallbackUsername: this.config.jiraUsername,
        fallbackToken: this.config.jiraToken,
        logger,
        warningMessage:
          "Unable to load QUALIFIER Jira credentials for OneShot notifications; falling back to orchestrator config",
      })) ?? {
        username: this.config.jiraUsername,
        token: this.config.jiraToken,
        source: "configured",
      }
    );
  }

  private async checkAndReconcileOneShotRuns(): Promise<void> {
    if (!this.oneShotService) {
      return;
    }

    if (
      !process.env.ONESHOT_PLANNING_QUEUE_URL ||
      !process.env.ONESHOT_REVIEW_QUEUE_URL ||
      !process.env.ONESHOT_IMPLEMENTATION_QUEUE_URL
    ) {
      return;
    }

    const result = await this.oneShotService.reconcileStuckRuns(10);
    if (
      result.republished === 0 &&
      result.terminated === 0 &&
      result.failed === 0
    ) {
      logger.debug("No stale OneShot runs to reconcile");
    } else {
      logger.info(result, "OneShot stuck-run reconciliation finished");
    }

    const ciResult = await this.oneShotService.reconcilePrOpenCiReadiness(10);
    if (
      ciResult.checked === 0 ||
      (ciResult.refreshed === 0 && ciResult.failed === 0)
    ) {
      logger.debug(
        "No OneShot PR-open CI readiness rows needed reconciliation",
      );
      return;
    }

    logger.info(
      ciResult,
      "OneShot PR-open CI readiness reconciliation finished",
    );
  }

  private async checkAndBackfillOneShotTerminationPostmortems(): Promise<void> {
    if (!this.oneShotService) {
      return;
    }

    if (
      !process.env.ONESHOT_PLANNING_QUEUE_URL ||
      !process.env.ONESHOT_REVIEW_QUEUE_URL ||
      !process.env.ONESHOT_IMPLEMENTATION_QUEUE_URL
    ) {
      return;
    }

    const result = await this.oneShotService.backfillTerminationPostmortems(10);
    if (result.generated === 0 && result.failed === 0) {
      logger.debug("No OneShot termination postmortems to backfill");
      return;
    }

    logger.info(result, "OneShot termination postmortem backfill finished");
  }

  private async checkAndCleanupOneShotWorkspaces(): Promise<void> {
    if (!this.oneShotService) {
      return;
    }

    if (
      !process.env.ONESHOT_PLANNING_QUEUE_URL ||
      !process.env.ONESHOT_REVIEW_QUEUE_URL ||
      !process.env.ONESHOT_IMPLEMENTATION_QUEUE_URL
    ) {
      return;
    }

    // Only run cleanup every N reconcile cycles (cleanup is expensive)
    this.oneShotWorkspaceCleanupCounter =
      (this.oneShotWorkspaceCleanupCounter ?? 0) + 1;
    const CLEANUP_EVERY_N_CYCLES = 30; // if reconcile runs every ~30s, cleanup runs every ~15min
    if (this.oneShotWorkspaceCleanupCounter % CLEANUP_EVERY_N_CYCLES !== 0) {
      return;
    }

    try {
      const result = await this.oneShotService.cleanupTerminalWorkspaces(
        24,
        50,
      );
      if (result.cleaned === 0 && result.failed === 0) {
        logger.debug("No terminal OneShot workspaces to clean");
        return;
      }
      logger.info(result, "OneShot workspace cleanup finished");
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "OneShot workspace cleanup failed",
      );
    }
  }

  // JIRA Cloud comment character limit (conservative, actual is ~32767)
  private readonly JIRA_COMMENT_LIMIT = 30000;

  /**
   * Generate the AI-generated content banner with metrics
   */
  private generateAiBanner(task: any): string {
    // Parse tokens if available
    let inputTokens = "N/A";
    let outputTokens = "N/A";
    if (task.tokens_consumed) {
      const match = task.tokens_consumed.match(/input:(\d+),output:(\d+)/);
      if (match) {
        inputTokens = parseInt(match[1]).toLocaleString();
        outputTokens = parseInt(match[2]).toLocaleString();
      }
    }

    // Format duration
    let duration = "N/A";
    if (task.duration_seconds) {
      const minutes = Math.floor(task.duration_seconds / 60);
      const seconds = task.duration_seconds % 60;
      duration = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
    }

    // Format cost
    const cost = task.cost ? `$${parseFloat(task.cost).toFixed(4)}` : "N/A";

    // Format model name for display
    const modelDisplay = task.agent_model
      ? task.agent_model.replace("us.anthropic.", "").replace("-v1:0", "")
      : "Claude Sonnet 4.5";

    // Customer and branch info
    const customerName = task.customer_name || "Unknown";
    const codeBranch = task.code_branch || "master";

    return `
⚠️  ⚠️  ⚠️  AI-GENERATED CONTENT - FOR INTERNAL USE ONLY  ⚠️  ⚠️  ⚠️

🤖 Agent Execution Report :

🏢 Customer Name : ${customerName}
🌿 Code Branch   : ${codeBranch}

🏷️  Generated By : ${task.agent_name}
⏱️  Duration     : ${duration}
🎯 Tokens Used  : ${inputTokens} input / ${outputTokens} output
💰 Cost         : ${cost}
🧠 Model        : ${modelDisplay}

🔒 CONFIDENTIAL  •  🚫 DO NOT DISTRIBUTE  •  🏢 INTERNAL ONLY

---

`;
  }

  /**
   * Post task result to JIRA using agent-specific token
   */
  private async postResultToJira(task: any): Promise<void> {
    logger.info(
      {
        jira: task.jira_number,
        agent: task.agent_name,
        s3Bucket: task.result_s3_bucket,
        s3Key: task.result_s3_key,
        tokensConsumed: task.tokens_consumed,
        cost: task.cost,
        durationSeconds: task.duration_seconds,
      },
      "Posting result to JIRA",
    );

    // Read result from S3
    const fullResult = await this.readResultFromS3(
      task.result_s3_bucket,
      task.result_s3_key,
    );

    logger.info(
      {
        jira: task.jira_number,
        agent: task.agent_name,
        resultLength: fullResult.length,
        resultPreview: fullResult.substring(0, 300),
        containsHtmlTags: /<(details|summary|div|span|p|br|table)\b/i.test(
          fullResult,
        ),
        htmlTagsFound: (fullResult.match(/<\w+/g) || []).slice(0, 10),
      },
      "[POST_RESULT_S3] Result loaded from S3",
    );

    const meridianAttachment = this.extractMeridianSqlAttachment(fullResult);
    if (task.agent_name?.toUpperCase?.() === "MERIDIAN" && meridianAttachment) {
      await this.attachFileToJira(
        task.jira_number,
        meridianAttachment.filename,
        meridianAttachment.sql,
        task.jira_token,
        "text/sql",
      );

      await this.addJiraComment(
        task.jira_number,
        this.generateAiBanner(task) + meridianAttachment.comment,
        task.jira_token,
      );

      await this.finalizeJiraPost(task);

      logger.info(
        {
          jira: task.jira_number,
          agent: task.agent_name,
          filename: meridianAttachment.filename,
        },
        "MERIDIAN result posted to JIRA with SQL attachment",
      );
      return;
    }

    const { isOneShotComment, body: commentBody } =
      extractOneShotQualifierComment(fullResult);

    // Generate the AI content banner with metrics unless this is a OneShot-scoped
    // QUALIFIER comment that requested the custom comment path.
    const banner = isOneShotComment ? "" : this.generateAiBanner(task);

    // Handle large results - attach file and post summary comment
    if (commentBody.length > this.JIRA_COMMENT_LIMIT) {
      logger.info(
        {
          jira: task.jira_number,
          fullLength: commentBody.length,
          limit: this.JIRA_COMMENT_LIMIT,
        },
        "Result exceeds JIRA comment limit, attaching as file",
      );

      // Generate filename from task info
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${task.agent_name}_analysis_${timestamp}.md`;

      // Attach the full result as a file (with banner prepended)
      await this.attachFileToJira(
        task.jira_number,
        filename,
        banner + commentBody,
        task.jira_token,
      );

      // Post a summary comment with link to attachment
      const summaryComment = this.generateSummaryComment(
        commentBody,
        filename,
        task,
      );
      await this.addJiraComment(
        task.jira_number,
        banner + summaryComment,
        task.jira_token,
      );

      logger.info(
        {
          jira: task.jira_number,
          filename,
          originalLength: commentBody.length,
        },
        "Large result attached to JIRA",
      );
    } else {
      // Post full result as comment with banner
      await this.addJiraComment(
        task.jira_number,
        banner + commentBody,
        task.jira_token,
      );
    }

    await this.finalizeJiraPost(task);
  }

  private async finalizeJiraPost(task: any): Promise<void> {
    // Reassign ticket to reporter (so it doesn't show up in next polling)
    if (this.config.autoReassignTickets) {
      try {
        await this.reassignToReporter(task.jira_number, task.jira_token);
      } catch (error) {
        logger.warn(
          {
            jira: task.jira_number,
            error,
          },
          "Failed to reassign ticket to reporter",
        );
        // Don't fail the whole operation if reassignment fails
      }
    } else {
      logger.info(
        {
          jira: task.jira_number,
        },
        "Auto-reassign disabled - ticket remains assigned",
      );
    }

    const doneLabel = getAgentDoneLabel(task.agent_name);
    if (doneLabel && task.jira_number) {
      try {
        await this.issueAssignmentService.addLabel(
          task.jira_number,
          doneLabel,
          task.jira_token,
        );
        logger.info(
          {
            jira: task.jira_number,
            agent: task.agent_name,
            doneLabel,
          },
          "Added agent done label to JIRA issue",
        );
      } catch (error) {
        logger.warn(
          {
            jira: task.jira_number,
            agent: task.agent_name,
            doneLabel,
            error,
          },
          "Failed to add agent done label; continuing Jira finalization",
        );
      }
    }

    // Update task_management status
    await this.db.updateTaskManagementStatus(task.id, "posted_to_jira", {
      jira_posted_at: new Date(),
    });

    logger.info(
      {
        jira: task.jira_number,
        agent: task.agent_name,
      },
      "Result posted to JIRA",
    );
  }

  /**
   * Read result file from S3
   */
  private async readResultFromS3(bucket: string, key: string): Promise<string> {
    logger.debug({ bucket, key }, "Reading result from S3");

    try {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new Error("Empty response body from S3");
      }

      // Convert stream to string
      const bodyContents = await response.Body.transformToString();

      logger.debug(
        {
          bucket,
          key,
          size: bodyContents.length,
        },
        "Result read from S3",
      );

      return bodyContents;
    } catch (error) {
      logger.error({ bucket, key, error }, "Failed to read from S3");
      throw error;
    }
  }

  /**
   * Add comment to JIRA issue using agent-specific token
   */
  private async addJiraComment(
    issueKey: string,
    comment: string,
    jiraToken: string,
    jiraUsername = this.config.jiraUsername,
  ): Promise<void> {
    if (jiraMutationsDisabled()) {
      logger.warn(
        {
          issueKey,
        },
        "Skipping JIRA comment mutation because mutation guard is set",
      );
      return;
    }
    // Use agent token if available, otherwise fall back to global token
    const tokenToUse = jiraToken || this.config.jiraToken;
    const usernameToUse = jiraUsername || this.config.jiraUsername;

    const auth = Buffer.from(`${usernameToUse}:${tokenToUse}`).toString(
      "base64",
    );

    const url = `${this.config.jiraBaseUrl}/rest/api/3/issue/${issueKey}/comment`;

    logger.info(
      {
        issueKey,
        commentLength: comment.length,
        commentPreview: comment.substring(0, 200),
      },
      "[JIRA_COMMENT] Preparing comment for JIRA",
    );

    // Convert markdown to ADF format for proper rendering in Jira
    let adfWithFooter: any;
    try {
      const { convertMarkdownToAdf, addAdfFooter } =
        await import("../utils/index.js");

      const adf = convertMarkdownToAdf(comment);

      // Collect all node types in the ADF tree to catch anything Jira won't accept
      const allNodeTypes = new Set<string>();
      const collectTypes = (nodes: any[]) => {
        for (const n of nodes ?? []) {
          allNodeTypes.add(n.type);
          collectTypes(n.content);
        }
      };
      collectTypes(adf.content);

      const problematicTypes = [...allNodeTypes].filter((t) =>
        ["html_block", "html_inline", "rawHtml", "unknown"].includes(t),
      );

      logger.info(
        {
          issueKey,
          topLevelNodeTypes: adf.content?.map((n: any) => n.type).join(", "),
          allNodeTypes: [...allNodeTypes].join(", "),
          hasProblematicNodes: problematicTypes.length > 0,
          problematicNodeTypes: problematicTypes.join(", ") || "none",
        },
        "[JIRA_COMMENT_ADF] ADF conversion complete",
      );

      if (problematicTypes.length > 0) {
        logger.error(
          { issueKey, problematicNodeTypes: problematicTypes },
          "[JIRA_COMMENT_ADF] ADF contains node types Jira will reject (html_block/html_inline) — comment will fail",
        );
      }

      adfWithFooter = addAdfFooter(adf, "Specter AI Agent");
    } catch (importOrConversionError: any) {
      logger.error(
        {
          issueKey,
          errorName: importOrConversionError.name,
          errorMessage: importOrConversionError.message,
          errorStack: importOrConversionError.stack,
          hint: "marklassian not installed — run: npm install",
        },
        "[JIRA_COMMENT_ADF] CRITICAL: markdown-to-adf import/conversion failed",
      );
      throw importOrConversionError;
    }

    const formattedComment = { body: adfWithFooter };
    const requestBodySize = JSON.stringify(formattedComment).length;

    logger.info(
      { issueKey, url, requestBodySize },
      "[JIRA_COMMENT_POST] Sending comment to JIRA",
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(formattedComment),
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => "Unable to read error response");
      logger.error(
        {
          issueKey,
          httpStatus: response.status,
          httpStatusText: response.statusText,
          jiraErrorBody: errorText,
          requestBodyPreview: JSON.stringify(formattedComment).substring(
            0,
            800,
          ),
        },
        "[JIRA_COMMENT_POST] Failed to add JIRA comment",
      );
      throw new Error(
        `Failed to add JIRA comment: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    logger.info(
      { issueKey },
      "[JIRA_COMMENT_POST] Comment added to JIRA successfully",
    );
  }

  private async updateJiraIssueFields(
    issueKey: string,
    fields: Record<string, unknown>,
    jiraToken: string,
  ): Promise<void> {
    if (jiraMutationsDisabled()) {
      logger.warn(
        {
          issueKey,
          fields: Object.keys(fields),
        },
        "Skipping JIRA field mutation because mutation guard is set",
      );
      return;
    }

    const tokenToUse = jiraToken || this.config.jiraToken;
    const auth = Buffer.from(
      `${this.config.jiraUsername}:${tokenToUse}`,
    ).toString("base64");
    const url = `${this.config.jiraBaseUrl}/rest/api/3/issue/${issueKey}`;
    const body = JSON.stringify({ fields });

    logger.info(
      {
        issueKey,
        fields: Object.keys(fields),
        requestBodySize: body.length,
      },
      "[JIRA_FIELD_UPDATE] Sending field update to JIRA",
    );

    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => "Unable to read error response");
      logger.error(
        {
          issueKey,
          fields: Object.keys(fields),
          httpStatus: response.status,
          httpStatusText: response.statusText,
          jiraErrorBody: errorText,
        },
        "[JIRA_FIELD_UPDATE] Failed to update JIRA fields",
      );
      throw new Error(
        `Failed to update JIRA fields: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    logger.info(
      {
        issueKey,
        fields: Object.keys(fields),
      },
      "[JIRA_FIELD_UPDATE] Fields updated successfully",
    );
  }

  /**
   * Reassign JIRA ticket to reporter
   * This removes the ticket from agent's JQL results (assignee filter)
   */
  private async reassignToReporter(
    issueKey: string,
    jiraToken: string,
  ): Promise<void> {
    if (jiraMutationsDisabled()) {
      logger.warn(
        {
          issueKey,
        },
        "Skipping JIRA reassignment mutation because mutation guard is set",
      );
      return;
    }
    logger.info({ issueKey }, "Reassigning ticket to reporter");

    // Use agent token if available, otherwise fall back to global token
    const tokenToUse = jiraToken || this.config.jiraToken;

    const auth = Buffer.from(
      `${this.config.jiraUsername}:${tokenToUse}`,
    ).toString("base64");

    // Step 1: Get issue details to find reporter
    const issueUrl = `${this.config.jiraBaseUrl}/rest/api/3/issue/${issueKey}`;
    const issueResponse = await fetch(issueUrl, {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });

    if (!issueResponse.ok) {
      throw new Error(`Failed to fetch issue: ${issueResponse.status}`);
    }

    const issue = (await issueResponse.json()) as JiraIssue;
    const reporterAccountId = issue.fields.reporter?.accountId;

    if (!reporterAccountId) {
      logger.warn({ issueKey }, "No reporter found, cannot reassign");
      return;
    }

    // Step 2: Reassign to reporter
    const assignUrl = `${this.config.jiraBaseUrl}/rest/api/3/issue/${issueKey}/assignee`;
    const assignResponse = await fetch(assignUrl, {
      method: "PUT",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountId: reporterAccountId,
      }),
    });

    if (!assignResponse.ok) {
      const errorText = await assignResponse
        .text()
        .catch(() => "Unknown error");
      throw new Error(
        `Failed to reassign: ${assignResponse.status} - ${errorText}`,
      );
    }

    logger.info(
      {
        issueKey,
        reporterAccountId,
      },
      "Ticket reassigned to reporter",
    );
  }

  /**
   * Attach a file to a JIRA issue
   */
  private async attachFileToJira(
    issueKey: string,
    filename: string,
    content: string,
    jiraToken: string,
    contentType = "text/markdown",
  ): Promise<void> {
    if (jiraMutationsDisabled()) {
      logger.warn(
        {
          issueKey,
          filename,
        },
        "Skipping JIRA attachment mutation because mutation guard is set",
      );
      return;
    }
    const tokenToUse = jiraToken || this.config.jiraToken;

    const auth = Buffer.from(
      `${this.config.jiraUsername}:${tokenToUse}`,
    ).toString("base64");

    const url = `${this.config.jiraBaseUrl}/rest/api/3/issue/${issueKey}/attachments`;

    // Create form data with the file content
    const boundary =
      "----FormBoundary" + Math.random().toString(36).substring(2);
    const fileContent = Buffer.from(content, "utf-8");

    const bodyParts = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      `Content-Type: ${contentType}`,
      "",
      content,
      `--${boundary}--`,
    ];
    const body = bodyParts.join("\r\n");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "X-Atlassian-Token": "no-check", // Required for JIRA file uploads
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => "Unable to read error response");
      logger.error(
        {
          issueKey,
          filename,
          status: response.status,
          statusText: response.statusText,
          errorBody: errorText,
        },
        "Failed to attach file to JIRA",
      );
      throw new Error(
        `Failed to attach file to JIRA: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    logger.info(
      { issueKey, filename, size: content.length },
      "File attached to JIRA",
    );
  }

  /**
   * MERIDIAN returns a compact markdown summary plus a SQL attachment block.
   * Packaged MERIDIAN runs should provide a redacted preview block; any raw
   * executable SQL must stay on an approved secure DBA handoff path.
   */
  private extractMeridianSqlAttachment(fullResult: string): {
    filename: string;
    sql: string;
    comment: string;
  } | null {
    const markerPattern =
      /<!-- MERIDIAN_SQL_ATTACHMENT_START filename="([^"]+)" -->([\s\S]*?)<!-- MERIDIAN_SQL_ATTACHMENT_END -->/;
    const match = fullResult.match(markerPattern);
    if (!match) {
      return null;
    }

    const filename =
      match[1].replace(/[^A-Za-z0-9._-]+/g, "_") || "meridian.sql";
    const sql = match[2].trimStart();
    const comment = fullResult.replace(markerPattern, "").trim();
    return { filename, sql, comment };
  }

  /**
   * Generate a summary comment for large results that were attached as files
   */
  private generateSummaryComment(
    fullResult: string,
    filename: string,
    task: any,
  ): string {
    // Extract a preview from the beginning of the result
    const previewLength = 2000;
    const preview = fullResult.substring(0, previewLength);

    // Try to find a natural break point (end of a section/paragraph)
    let truncatedPreview = preview;
    const lastNewlineIndex = preview.lastIndexOf("\n\n");
    if (lastNewlineIndex > previewLength / 2) {
      truncatedPreview = preview.substring(0, lastNewlineIndex);
    }

    // Extract key sections if they exist
    const sections: string[] = [];

    // Look for common section headers
    const sectionPatterns = [
      /## Summary\n([\s\S]*?)(?=\n## |$)/i,
      /## Root Cause\n([\s\S]*?)(?=\n## |$)/i,
      /## Key Findings\n([\s\S]*?)(?=\n## |$)/i,
      /## Recommendations\n([\s\S]*?)(?=\n## |$)/i,
    ];

    for (const pattern of sectionPatterns) {
      const match = fullResult.match(pattern);
      if (match && match[1]?.trim()) {
        const content = match[1].trim().substring(0, 500);
        sections.push(content);
      }
    }

    const summaryParts = [
      `## 🤖 ${task.agent_name} Analysis Complete`,
      "",
      `**Full analysis attached as:** \`${filename}\``,
      `**Analysis size:** ${fullResult.length.toLocaleString()} characters`,
      "",
      "---",
      "",
      "### Preview",
      "",
      truncatedPreview,
      "",
      "...",
      "",
      `*See attached file \`${filename}\` for full analysis*`,
    ];

    return summaryParts.join("\n");
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Get orchestrator status
   */
  getStatus(): {
    isRunning: boolean;
    jiraPollingEnabled: boolean;
    jiraPollingInterval: number;
    resultCheckInterval: number;
    dashboardRunRequestInterval: number;
  } {
    return {
      isRunning: this.isRunning,
      jiraPollingEnabled: Boolean(this.config.jiraPollingEnabled),
      jiraPollingInterval: this.config.pollingIntervalMs!,
      resultCheckInterval: this.config.resultCheckIntervalMs!,
      dashboardRunRequestInterval: this.config.dashboardRunRequestIntervalMs!,
    };
  }
}
