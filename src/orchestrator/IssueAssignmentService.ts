import { createHash } from "node:crypto";
import type {
  Agent,
  CodeRepository,
  CustomerBranch,
  Database,
  TaskManagement,
} from "./database.js";
import type { RepoAnalyzer } from "./RepoAnalyzer.js";
import type { Storage } from "./storage.js";
import type { TaskDescriptionGenerator } from "./TaskDescriptionGenerator.js";
import type { TicketEvidenceV1 } from "../oneshot/ticket-evidence.js";
import {
  canReuseTaskManagementRow,
  type QualifierMode,
} from "../oneshot/contracts.js";
import {
  CLIENT_ELIGIBILITY_JIRA_EXPAND,
  extractClientNameFromJiraIssue,
} from "../oneshot/client-eligibility.js";
import { hasExhaustedTaskProcessingAttempts } from "./agentRetryPolicy.js";
import type { RoutingPlan } from "../oneshot/repo-router/types.js";
import { isOneShotRepoEnabled } from "../oneshot/repo-metadata.js";
import { createLogger } from "../utils/logger.js";
import { buildPlainTextJiraCommentBody } from "./JiraClient.js";

const logger = createLogger("issue-assignment");

export interface AssignmentJiraIssue {
  key: string;
  names?: Record<string, string>;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    priority?: { name?: string };
    labels?: string[];
    assignee?: { displayName?: string; accountId?: string };
    reporter?: { displayName?: string; accountId?: string };
    created?: string;
    updated?: string;
    [key: string]: unknown;
  };
}

export type AssignmentDisposition = "created" | "requeued" | "existing_active";

export function canRequeueExistingTaskManagementRow(
  taskManagement: Pick<TaskManagement, "status" | "retry_count">,
  isQualifier: boolean,
): boolean {
  if (isQualifier) {
    return canReuseTaskManagementRow(taskManagement);
  }

  return (
    taskManagement.status === "failed" &&
    !hasExhaustedTaskProcessingAttempts(taskManagement.retry_count)
  );
}

export interface AssignIssueToAgentOptions {
  existingTaskManagement?: TaskManagement | null;
  qualifierMode?: QualifierMode | null;
  fullIssue?: AssignmentJiraIssue;
}

export interface AssignIssueToAgentResult {
  taskManagementId: number;
  disposition: AssignmentDisposition;
  fullIssue: AssignmentJiraIssue;
}

interface IssueAssignmentServiceConfig {
  jiraBaseUrl: string;
  jiraToken: string;
  jiraUsername: string;
}

function jiraMutationsDisabled(): boolean {
  return (
    process.env.ONESHOT_DISABLE_JIRA_MUTATIONS?.toLowerCase() === "true" ||
    process.env.ONESHOT_DISABLE_JIRA_COMMENTS?.toLowerCase() === "true"
  );
}

export function buildQualifierRepoConfirmationDashboardUrl(
  baseUrl: string | null | undefined,
  taskManagementId: number | null | undefined,
): string | null {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return null;
  }

  const normalizedBase = trimmed.replace(/\/+$/, "");
  const oneshotBase = normalizedBase.endsWith("/oneshot")
    ? normalizedBase
    : `${normalizedBase}/oneshot`;
  const params = new URLSearchParams({ view: "waiting" });
  if (taskManagementId) {
    params.set("run", `qualifier-task-${taskManagementId}`);
  }
  return `${oneshotBase}?${params.toString()}`;
}

export function buildRouterConfirmationCandidates(
  routerPlan: RoutingPlan,
  availableRepos: CodeRepository[],
): Array<{
  repoId: number;
  repoName: string;
  score: number;
  evidence: unknown[];
}> {
  const scoredByRepoId = new Map(
    routerPlan.candidates.map((candidate) => [candidate.repo.id, candidate]),
  );
  return availableRepos
    .filter(isOneShotRepoEnabled)
    .map((repo) => {
      const scored = scoredByRepoId.get(repo.id);
      return {
        repoId: repo.id,
        repoName: repo.repo_name,
        score: scored?.score ?? 0,
        evidence: scored?.evidence ?? [],
      };
    })
    .sort((a, b) => b.score - a.score || a.repoName.localeCompare(b.repoName));
}

export class IssueAssignmentService {
  constructor(
    private readonly db: Database,
    private readonly storage: Storage,
    private readonly taskDescriptionGenerator: TaskDescriptionGenerator,
    private readonly repoAnalyzer: RepoAnalyzer,
    private readonly config: IssueAssignmentServiceConfig,
  ) {}

  private getToken(agentToken?: string): string {
    return agentToken?.trim() || this.config.jiraToken;
  }

  private getAuthHeader(agentToken?: string): string {
    return `Basic ${Buffer.from(
      `${this.config.jiraUsername}:${this.getToken(agentToken)}`,
    ).toString("base64")}`;
  }

  async fetchJiraIssue(
    issueKey: string,
    jiraToken?: string,
  ): Promise<AssignmentJiraIssue> {
    const params = new URLSearchParams({
      expand: CLIENT_ELIGIBILITY_JIRA_EXPAND,
      fields: "*all",
    });
    const url = `${this.config.jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?${params.toString()}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.getAuthHeader(jiraToken),
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => "Unable to read error response");
      logger.error(
        {
          issueKey,
          status: response.status,
          statusText: response.statusText,
          errorBody: errorText,
        },
        "Failed to fetch JIRA issue",
      );
      throw new Error(
        `Failed to fetch JIRA issue: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    const issue = (await response.json()) as AssignmentJiraIssue;
    const comments = await this.fetchJiraComments(issueKey, jiraToken);
    issue.fields.comment = {
      comments,
      maxResults: comments.length,
      total: comments.length,
      startAt: 0,
    };
    return issue;
  }

  private async fetchJiraComments(
    issueKey: string,
    jiraToken?: string,
  ): Promise<unknown[]> {
    const comments: unknown[] = [];
    const pageSize = 100;
    let startAt = 0;

    while (true) {
      const params = new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(pageSize),
        orderBy: "created",
      });
      const url = `${this.config.jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?${params.toString()}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: this.getAuthHeader(jiraToken),
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        const errorText = await response
          .text()
          .catch(() => "Unable to read error response");
        logger.warn(
          {
            issueKey,
            status: response.status,
            statusText: response.statusText,
            errorBody: errorText.substring(0, 500),
          },
          "Failed to fetch JIRA comments for routing",
        );
        return comments;
      }

      const page = (await response.json()) as {
        comments?: unknown[];
        startAt?: number;
        maxResults?: number;
        total?: number;
      };
      comments.push(...(Array.isArray(page.comments) ? page.comments : []));
      const currentStart = page.startAt ?? startAt;
      const currentMax = page.maxResults ?? pageSize;
      const total = page.total ?? comments.length;
      startAt = currentStart + currentMax;
      if (startAt >= total || currentMax <= 0) {
        break;
      }
    }

    return comments;
  }

  async addLabel(
    issueKey: string,
    label: string,
    jiraToken?: string,
  ): Promise<void> {
    if (jiraMutationsDisabled()) {
      logger.warn(
        {
          issueKey,
          label,
        },
        "Skipping JIRA label mutation because mutation guard is set",
      );
      return;
    }
    const url = `${this.config.jiraBaseUrl}/rest/api/3/issue/${issueKey}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: this.getAuthHeader(jiraToken),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        update: {
          labels: [{ add: label }],
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => "Unable to read error response");
      logger.error(
        {
          issueKey,
          label,
          status: response.status,
          statusText: response.statusText,
          errorBody: errorText,
        },
        "Failed to add JIRA label",
      );
      throw new Error(
        `Failed to add JIRA label: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }
  }

  /**
   * Post a plain-text comment to a Jira issue. Returns the comment id so the
   * caller can persist it (e.g. on router_confirmations.jira_comment_id).
   *
   * Used by the RepoRouter needs_repo_confirmation path (v3.5 P2 #4): the
   * reporter gets a Jira-native notification announcing the confirmation
   * alongside the dashboard queue entry. Non-fatal when posting fails — the
   * router decision + confirmation row are already persisted; a missing
   * comment degrades to "dashboard only" notification.
   */
  async addComment(
    issueKey: string,
    body: string,
    jiraToken?: string,
  ): Promise<{ id: string }> {
    if (jiraMutationsDisabled()) {
      logger.warn(
        {
          issueKey,
        },
        "Skipping JIRA comment mutation because mutation guard is set",
      );
      return { id: "mutation-guard-disabled" };
    }
    const url = `${this.config.jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;
    const adfBody = buildPlainTextJiraCommentBody(body);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.getAuthHeader(jiraToken),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: adfBody }),
    });
    if (!response.ok) {
      const errorText = await response
        .text()
        .catch(() => "Unable to read error response");
      throw new Error(
        `Failed to add JIRA comment: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`,
      );
    }
    const payload = (await response.json()) as { id: string };
    return { id: payload.id };
  }

  extractCustomerFromJira(issue: AssignmentJiraIssue): string | null {
    const customerName = extractClientNameFromJiraIssue(issue);
    if (customerName) {
      return customerName;
    }
    logger.warn({ jira: issue.key }, "No customer field found in JIRA issue");
    return null;
  }

  async assignIssueToAgent(
    issue: Pick<AssignmentJiraIssue, "key" | "fields">,
    agent: Agent,
    options: AssignIssueToAgentOptions = {},
  ): Promise<AssignIssueToAgentResult> {
    const isQualifier = agent.name.trim().toUpperCase() === "QUALIFIER";
    const isMeridian = agent.name.trim().toUpperCase() === "MERIDIAN";
    const qualifierMode = options.qualifierMode ?? null;
    const existing =
      options.existingTaskManagement ??
      (await this.db.getTaskManagementByJiraAndAgent(issue.key, agent.id));

    const assignmentStart = Date.now();
    const fullIssue =
      options.fullIssue ??
      (await this.fetchJiraIssue(issue.key, agent.jira_token));

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
        "Issue already assigned to this agent - linking existing task",
      );

      return {
        taskManagementId: existing.id,
        disposition: "existing_active",
        fullIssue,
      };
    }

    const customerName = this.extractCustomerFromJira(fullIssue);
    logger.info(
      {
        jira: issue.key,
        customer: customerName,
      },
      "Extracted customer from JIRA",
    );

    let customerBranch: CustomerBranch;
    if (customerName) {
      customerBranch = await this.db.getOrCreateCustomerBranch(customerName);
    } else {
      const defaultBranch = await this.db.getDefaultCustomerBranch();
      if (!defaultBranch) {
        throw new Error("No default customer branch configured");
      }
      customerBranch = defaultBranch;
      logger.info(
        {
          jira: issue.key,
          customer: customerBranch.customer,
          branch: customerBranch.branch,
        },
        "Using default customer branch",
      );
    }

    let relatedCodeCSV = "";
    const taskManagementStatus: TaskManagement["status"] = "assigned";
    let repoMs = 0;
    // QUALIFIER-owned repo selection: IssueAssignmentService no longer runs
    // any repo-routing for QUALIFIER intake. The QUALIFIER worker LLM picks
    // the repo from the ticket text + profiled-repo catalog. This service
    // just persists task_management with related_code="" and lets the
    // worker upgrade status (qualified, waiting_repo_confirmation, or
    // PFOS-NOT-QUALIFIED). For non-QUALIFIER agents, RepoAnalyzer remains
    // the routing path.
    if (!isQualifier && !isMeridian) {
      const repoStart = Date.now();
      logger.info(
        {
          jira: issue.key,
        },
        "Analyzing ticket for relevant repositories",
      );
      const availableRepos = await this.db.getAllRepositories();
      const repoAnalysis = await this.repoAnalyzer.analyzeTicketForRepos(
        fullIssue as any,
        availableRepos,
      );
      relatedCodeCSV = repoAnalysis.selectedRepoIds.join(",");
      repoMs = Date.now() - repoStart;
      logger.info(
        {
          jira: issue.key,
          repoMs,
          selectedRepos: repoAnalysis.selectedRepoIds,
          relatedCodeCSV,
          reasoning: (repoAnalysis as any)?.reasoning?.substring?.(0, 200),
        },
        "Repository analysis complete",
      );
    } else {
      logger.info(
        {
          jira: issue.key,
          agent: agent.name,
          mode: qualifierMode,
        },
        isMeridian
          ? "Skipping repository analysis for MERIDIAN task assignment"
          : "Skipping repository analysis for QUALIFIER task assignment",
      );
    }

    if (isMeridian) {
      let taskManagementId: number;
      let disposition: AssignmentDisposition;
      if (existing) {
        await this.db.requeueTaskManagement(existing.id, {
          customer_id: customerBranch.id,
          related_code: "",
          task_type: agent.task_type,
          source: "jira",
          status: taskManagementStatus,
        });
        taskManagementId = existing.id;
        disposition = "requeued";
      } else {
        taskManagementId = await this.db.createTaskManagement({
          jira_number: issue.key,
          customer_id: customerBranch.id,
          agent_id: agent.id,
          related_code: "",
          task_type: agent.task_type,
          status: taskManagementStatus,
        });
        disposition = "created";
      }

      const totalMs = Date.now() - assignmentStart;
      logger.info(
        {
          jira: issue.key,
          agent: agent.name,
          totalMs,
          customerId: customerBranch.id,
          customerName: customerBranch.customer,
          taskType: agent.task_type,
          disposition,
          taskManagementId,
        },
        "MERIDIAN issue assigned without generic LLM task-description generation",
      );

      return {
        taskManagementId,
        disposition,
        fullIssue,
      };
    }

    const taskGenStart = Date.now();
    logger.info(
      { jira: issue.key },
      "Generating comprehensive task description with multimodal LLM",
    );
    const taskPayload =
      isQualifier &&
      typeof this.taskDescriptionGenerator.generateTaskPayloadFromTicketKey ===
        "function"
        ? await this.taskDescriptionGenerator.generateTaskPayloadFromTicketKey(
            issue.key,
            agent.jira_token,
          )
        : {
            taskDescription:
              await this.taskDescriptionGenerator.generateFromTicketKey(
                issue.key,
                agent.jira_token,
              ),
            ticketEvidence: null as TicketEvidenceV1 | null,
          };
    const { taskDescription, ticketEvidence } = taskPayload;
    const taskGenMs = Date.now() - taskGenStart;

    logger.info(
      {
        jira: issue.key,
        taskGenMs,
        taskGenSec: (taskGenMs / 1000).toFixed(1),
        descriptionLength: taskDescription.length,
      },
      "Task description generated",
    );

    const uploadStart = Date.now();
    logger.info({ jira: issue.key }, "Uploading task description to S3");
    const { bucket, key } = await this.storage.uploadTaskDescription(
      issue.key,
      taskDescription,
    );
    if (isQualifier && ticketEvidence) {
      try {
        await this.storage.uploadTicketEvidence(issue.key, key, ticketEvidence);
      } catch (error) {
        logger.warn(
          {
            jira: issue.key,
            taskS3Key: key,
            error: error instanceof Error ? error.message : String(error),
          },
          "Ticket evidence upload failed after task description upload; continuing with legacy task-description handoff",
        );
      }
    }
    const uploadMs = Date.now() - uploadStart;

    let taskManagementId: number;
    let disposition: AssignmentDisposition;
    if (
      existing &&
      canRequeueExistingTaskManagementRow(existing, isQualifier)
    ) {
      await this.db.requeueTaskManagement(existing.id, {
        customer_id: customerBranch.id,
        related_code: relatedCodeCSV,
        task_type: agent.task_type,
        task_s3_bucket: bucket,
        task_s3_key: key,
        source: "jira",
        status: taskManagementStatus,
        retry_count: existing.retry_count ?? 0,
      });
      taskManagementId = existing.id;
      disposition = "requeued";
    } else {
      taskManagementId = await this.db.createTaskManagement({
        jira_number: issue.key,
        customer_id: customerBranch.id,
        agent_id: agent.id,
        related_code: relatedCodeCSV,
        task_type: agent.task_type,
        task_s3_bucket: bucket,
        task_s3_key: key,
        status: taskManagementStatus,
      });
      disposition = "created";
    }

    const totalMs = Date.now() - assignmentStart;
    logger.info(
      {
        jira: issue.key,
        agent: agent.name,
        totalMs,
        totalSec: (totalMs / 1000).toFixed(1),
        taskGenMs,
        repoMs,
        uploadMs,
        customerId: customerBranch.id,
        customerName: customerBranch.customer,
        branch: customerBranch.branch,
        relatedCode: relatedCodeCSV,
        taskType: agent.task_type,
        taskDescriptionLength: taskDescription.length,
        s3Bucket: bucket,
        s3Key: key,
        disposition,
        taskManagementId,
      },
      "Issue assigned with enriched data",
    );

    return {
      taskManagementId,
      disposition,
      fullIssue,
    };
  }
}
