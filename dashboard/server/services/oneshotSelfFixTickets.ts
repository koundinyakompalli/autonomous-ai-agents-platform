import { createOneShotRunRequest } from "./oneshotRunRequests.js";
import { getOneShotStatistics } from "./oneshotStatistics.js";
import {
  getOneShotSelfFixConfig,
  ONESHOT_SELF_FIX_TARGET_BRANCH,
  ONESHOT_SELF_FIX_TARGET_EPIC_KEY,
  ONESHOT_SELF_FIX_TARGET_REPO,
} from "./oneshotSelfFixCandidates.js";
import {
  ensureSelfFixTicketTableExists,
  findActiveSelfFixTicketByCandidateKey,
  insertSelfFixTicket,
  OneShotSelfFixTicketStoreError,
  updateSelfFixTicketRunRequest,
} from "./oneshotSelfFixTicketStore.js";
import type {
  OneShotAnalyticsRange,
  OneShotFailureErrorCategory,
  OneShotSelfFixCandidate,
  OneShotSelfFixCandidateStatus,
} from "../types/oneshot.js";
import type { OperatorIdentity } from "../types/oneshotDeployments.js";

const SELF_FIX_PROJECT_KEY = "CPDEV";
const SELF_FIX_ISSUE_TYPE = "Defect";
const SELF_FIX_LABELS = [
  "PFOS",
  "oneshot-self-fix",
  "oneshot-statistics",
  "auto-fix",
];

const SYSTEM_OPERATOR: OperatorIdentity = {
  id: "oneshot-statistics",
  display: "OneShot Statistics",
};

const ERROR_CATEGORY_LABEL: Record<OneShotFailureErrorCategory, string> = {
  git_operation: "Git operation",
  llm_provider: "LLM provider",
  llm_output: "LLM output",
  s3_storage: "S3 storage",
  db_operation: "Database",
  workspace: "Workspace",
  github_api: "GitHub API",
  ticket_quality: "Ticket quality",
  plan_validation: "Plan validation",
  budget: "Budget",
  agent_logic: "Agent logic",
  test_runner_skipped: "Test runner skipped",
  ci_failure: "CI failure",
  unknown: "Uncategorized",
};

type JiraIssue = {
  key: string;
  fields?: {
    summary?: unknown;
    description?: unknown;
  };
};

type SelfFixTicketStatus = Extract<
  OneShotSelfFixCandidateStatus,
  "ticket_created" | "duplicate" | "run_requested"
>;

export interface OneShotSelfFixTicketResult {
  candidateId: string;
  ticketKey: string;
  jiraUrl: string | null;
  runRequestId?: number;
  status: SelfFixTicketStatus;
}

export class OneShotSelfFixTicketError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
  ) {
    super(message);
    this.name = "OneShotSelfFixTicketError";
  }
}

function jiraMutationsDisabled(): boolean {
  return (
    process.env.ONESHOT_DISABLE_JIRA_MUTATIONS?.toLowerCase() === "true" ||
    process.env.JIRA_MUTATIONS_DISABLED?.toLowerCase() === "true"
  );
}

function requiredJiraEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new OneShotSelfFixTicketError(
      `OneShot self-fix Jira integration is not configured: ${name} is missing`,
      503,
    );
  }
  return value;
}

function jiraBaseUrl(): string {
  return requiredJiraEnv("JIRA_BASE_URL").replace(/\/$/, "");
}

function jiraAuthHeader(): string {
  const username = requiredJiraEnv("JIRA_USERNAME");
  const token = requiredJiraEnv("JIRA_TOKEN");
  return `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
}

function buildJiraUrl(jiraKey: string): string | null {
  const base = process.env.JIRA_BASE_URL?.trim().replace(/\/$/, "");
  return base ? `${base}/browse/${encodeURIComponent(jiraKey)}` : null;
}

function buildPlainTextJiraDocument(bodyText: string): {
  type: "doc";
  version: 1;
  content: Array<{
    type: "paragraph";
    content: Array<{ type: "text"; text: string }>;
  }>;
} {
  return {
    type: "doc",
    version: 1,
    content: bodyText.split(/\n{2,}/).map((paragraph) => ({
      type: "paragraph",
      content: [{ type: "text", text: paragraph.trim() }],
    })),
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatWilson(candidate: OneShotSelfFixCandidate): string {
  return candidate.wilson95
    ? `${formatPercent(candidate.wilson95.low)} - ${formatPercent(candidate.wilson95.high)}`
    : "not available";
}

function buildSelfFixSummary(candidate: OneShotSelfFixCandidate): string {
  return `OneShot self-fix: ${ERROR_CATEGORY_LABEL[candidate.category]} failures`;
}

function buildSelfFixDescription(input: {
  candidate: OneShotSelfFixCandidate;
  snapshotFingerprint: string;
}): string {
  const { candidate } = input;
  const examples = candidate.examples
    .map((example) => `- ${example.jiraKey} (${example.dashboardId})`)
    .join("\n");
  return [
    "Summary",
    `Fix recurring OneShot-owned ${ERROR_CATEGORY_LABEL[candidate.category].toLowerCase()} failures detected by the Statistics tab.`,
    "",
    "Overview",
    `OneShot Statistics found ${candidate.sampleSize} recurring failures attributed to OneShot in the ${candidate.range} window. The pattern is statistically significant against the current ${formatPercent(candidate.passRateBaseline)} terminal pass-rate baseline, so this defect tracks the platform fix rather than a customer-ticket fix.`,
    "",
    "Acceptance Criteria",
    "- The identified OneShot failure category is fixed or downgraded with deterministic evidence explaining why it is no longer a platform defect.",
    "- The fix includes targeted regression coverage for the affected OneShot path.",
    "- Existing OneShot intake, qualification, implementation, and dashboard behavior outside this failure category remains unchanged.",
    "- The Statistics tab no longer reports this candidate as an eligible self-fix defect after the corrected behavior has enough fresh samples.",
    "",
    "Technical Details",
    `Repo: ${ONESHOT_SELF_FIX_TARGET_REPO}`,
    `Target Branch: ${ONESHOT_SELF_FIX_TARGET_BRANCH}`,
    `Candidate Key: ${candidate.id}`,
    `Range: ${candidate.range}`,
    `Failure Category: ${candidate.category}`,
    `Attribution: ${candidate.attribution}`,
    `Sample Size: ${candidate.sampleSize}`,
    `Wilson 95%: ${formatWilson(candidate)}`,
    `Overall Pass Rate Baseline: ${formatPercent(candidate.passRateBaseline)}`,
    `Snapshot Fingerprint: ${input.snapshotFingerprint}`,
    "Examples:",
    examples || "- No examples captured",
    "",
    "Out of Scope",
    "- Do not change customer product behavior unrelated to OneShot execution.",
    "- Do not loosen ticket-quality or qualifier requirements to hide this failure pattern.",
    "- Do not auto-merge or deploy the fix as part of this ticket.",
    "",
    "Testing Notes",
    "- Add or update focused unit coverage for the fixed OneShot module.",
    "- Run the relevant dashboard/server OneShot statistics tests.",
    "- Run the dashboard build before marking the defect ready.",
  ].join("\n");
}

async function searchOpenDuplicateTicket(
  candidate: OneShotSelfFixCandidate,
): Promise<{ key: string; jiraUrl: string | null } | null> {
  const jql = [
    `project = ${SELF_FIX_PROJECT_KEY}`,
    `issuetype = ${SELF_FIX_ISSUE_TYPE}`,
    `parent = ${ONESHOT_SELF_FIX_TARGET_EPIC_KEY}`,
    `labels = "oneshot-self-fix"`,
    "statusCategory != Done",
  ].join(" AND ");

  const response = await fetch(`${jiraBaseUrl()}/rest/api/3/search/jql`, {
    method: "POST",
    headers: {
      Authorization: jiraAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      jql,
      fields: ["summary", "description"],
      maxResults: 50,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new OneShotSelfFixTicketError(
      `Jira duplicate search failed: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`,
      502,
    );
  }

  const payload = (await response.json()) as { issues?: JiraIssue[] };
  const match = (payload.issues ?? []).find((issue) => {
    const text = JSON.stringify(issue.fields ?? {});
    return text.includes(candidate.id);
  });
  return match ? { key: match.key, jiraUrl: buildJiraUrl(match.key) } : null;
}

async function createJiraDefect(input: {
  candidate: OneShotSelfFixCandidate;
  snapshotFingerprint: string;
}): Promise<{ key: string; jiraUrl: string | null }> {
  if (jiraMutationsDisabled()) {
    throw new OneShotSelfFixTicketError(
      "OneShot self-fix Jira mutations are disabled",
      503,
    );
  }

  const response = await fetch(`${jiraBaseUrl()}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      Authorization: jiraAuthHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      fields: {
        project: { key: SELF_FIX_PROJECT_KEY },
        summary: buildSelfFixSummary(input.candidate),
        description: buildPlainTextJiraDocument(
          buildSelfFixDescription(input),
        ),
        issuetype: { name: SELF_FIX_ISSUE_TYPE },
        parent: { key: ONESHOT_SELF_FIX_TARGET_EPIC_KEY },
        labels: SELF_FIX_LABELS,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new OneShotSelfFixTicketError(
      `Jira defect creation failed: ${response.status} ${response.statusText} - ${errorText.substring(0, 300)}`,
      502,
    );
  }

  const payload = (await response.json()) as { key?: unknown };
  if (typeof payload.key !== "string" || !payload.key.trim()) {
    throw new OneShotSelfFixTicketError(
      "Jira defect creation did not return an issue key",
      502,
    );
  }
  return { key: payload.key.trim(), jiraUrl: buildJiraUrl(payload.key.trim()) };
}

async function maybeCreateRunRequest(input: {
  ticketKey: string;
  autoRunRequested: boolean;
  existingRunRequestId?: number;
}): Promise<number | undefined> {
  if (!input.autoRunRequested) return input.existingRunRequestId;
  if (input.existingRunRequestId) return input.existingRunRequestId;
  const request = await createOneShotRunRequest({
    jiraKey: input.ticketKey,
    operator: SYSTEM_OPERATOR,
  });
  return request.id;
}

function mapExistingResult(input: {
  candidate: OneShotSelfFixCandidate;
  ticketKey: string;
  jiraUrl: string | null;
  runRequestId?: number;
  status: SelfFixTicketStatus;
}): OneShotSelfFixTicketResult {
  return {
    candidateId: input.candidate.id,
    ticketKey: input.ticketKey,
    jiraUrl: input.jiraUrl,
    runRequestId: input.runRequestId,
    status: input.runRequestId ? "run_requested" : input.status,
  };
}

export async function createOneShotSelfFixTicket(input: {
  range: OneShotAnalyticsRange;
  candidateId: string;
  autoRun?: boolean;
  operator?: OperatorIdentity;
}): Promise<OneShotSelfFixTicketResult> {
  await ensureSelfFixTicketTableExists();
  const statistics = await getOneShotStatistics(input.range);
  const candidate = statistics.selfFixCandidates.find(
    (item) => item.id === input.candidateId,
  );
  if (!candidate) {
    throw new OneShotSelfFixTicketError(
      `Self-fix candidate ${input.candidateId} is not eligible in the ${input.range} statistics window`,
      404,
    );
  }

  const config = getOneShotSelfFixConfig();
  const autoRunRequested = input.autoRun === true || config.autoRunEnabled;
  const active = await findActiveSelfFixTicketByCandidateKey(candidate.id);
  if (active) {
    const runRequestId = await maybeCreateRunRequest({
      ticketKey: active.jira_key,
      autoRunRequested,
      existingRunRequestId: active.run_request_id ?? undefined,
    });
    if (runRequestId && runRequestId !== active.run_request_id) {
      await updateSelfFixTicketRunRequest({
        candidateKey: candidate.id,
        runRequestId,
      });
    }
    return mapExistingResult({
      candidate,
      ticketKey: active.jira_key,
      jiraUrl: active.jira_url,
      runRequestId,
      status: active.status as SelfFixTicketStatus,
    });
  }

  const duplicate = await searchOpenDuplicateTicket(candidate);
  if (duplicate) {
    const runRequestId = await maybeCreateRunRequest({
      ticketKey: duplicate.key,
      autoRunRequested,
    });
    await insertSelfFixTicket({
      candidate,
      range: input.range,
      snapshotFingerprint: statistics.modelInfo.dataFingerprint,
      jiraKey: duplicate.key,
      jiraUrl: duplicate.jiraUrl,
      status: runRequestId ? "run_requested" : "duplicate",
      runRequestId,
    });
    return {
      candidateId: candidate.id,
      ticketKey: duplicate.key,
      jiraUrl: duplicate.jiraUrl,
      runRequestId,
      status: runRequestId ? "run_requested" : "duplicate",
    };
  }

  const created = await createJiraDefect({
    candidate,
    snapshotFingerprint: statistics.modelInfo.dataFingerprint,
  });
  const runRequestId = await maybeCreateRunRequest({
    ticketKey: created.key,
    autoRunRequested,
  });
  await insertSelfFixTicket({
    candidate,
    range: input.range,
    snapshotFingerprint: statistics.modelInfo.dataFingerprint,
    jiraKey: created.key,
    jiraUrl: created.jiraUrl,
    status: runRequestId ? "run_requested" : "ticket_created",
    runRequestId,
  });
  return {
    candidateId: candidate.id,
    ticketKey: created.key,
    jiraUrl: created.jiraUrl,
    runRequestId,
    status: runRequestId ? "run_requested" : "ticket_created",
  };
}

export function normalizeSelfFixTicketError(error: unknown): {
  statusCode: number;
  message: string;
} {
  if (
    error instanceof OneShotSelfFixTicketError ||
    error instanceof OneShotSelfFixTicketStoreError
  ) {
    return { statusCode: error.statusCode, message: error.message };
  }
  return {
    statusCode: 500,
    message:
      error instanceof Error
        ? error.message
        : "Failed to create OneShot self-fix ticket",
  };
}
