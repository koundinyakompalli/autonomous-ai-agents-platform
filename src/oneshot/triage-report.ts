/**
 * TRIAGE Leadership Summary Report
 *
 * Auto-generated when all runs in a OneShot run group reach terminal state.
 * Mirrors the format of CP_Security_Remediation_Leadership_Summary.md.
 * Attaches a Markdown file to the source EPIC and posts an abridged comment.
 *
 * Triggered fire-and-forget from transitionRunWithNotification() — never
 * blocks or rolls back the state transition that triggered it.
 */

import { createLogger } from "../utils/logger.js";
import type { Database } from "../orchestrator/database.js";
import type { OneShotDatabase } from "./database/index.js";
import { getJiraClient, type JiraClient } from "../orchestrator/JiraClient.js";
import type { OneShotRun, OneShotState } from "./types.js";
import { PFOS_LABEL, SONAR_AUTOFIX_LABEL, SONAR_LABEL } from "./contracts.js";

const logger = createLogger("triage-report");

/**
 * Get a JiraClient suitable for use inside consumer tasks.
 * Consumer ECS tasks never call Orchestrator.start() which normally seeds the
 * singleton. This helper initialises it from env vars on first call so the
 * triage report can post to Jira regardless of which ECS task fires the hook.
 * Returns null (and logs a warning) if credentials are not configured so that
 * report failures are non-fatal and do not flood terminal-state transitions.
 */
function getTriageJiraClient(): JiraClient | null {
  try {
    return getJiraClient(
      process.env.JIRA_BASE_URL
        ? {
            baseUrl: process.env.JIRA_BASE_URL,
            username: process.env.JIRA_EMAIL ?? process.env.JIRA_USERNAME ?? "",
            token: process.env.JIRA_API_TOKEN ?? process.env.JIRA_TOKEN ?? "",
          }
        : undefined,
    );
  } catch {
    logger.warn(
      "JiraClient not configured — TRIAGE report will be skipped. " +
        "Set JIRA_BASE_URL, JIRA_EMAIL/JIRA_USERNAME, JIRA_API_TOKEN/JIRA_TOKEN " +
        "in the consumer task definition to enable automatic report posting.",
    );
    return null;
  }
}

const TERMINAL_STATES = new Set<OneShotState>([
  "pr_open",
  "completed",
  "failed",
  "escalated",
  "blocked",
]);

interface TriageReportSource {
  key: "wiz" | "sonar" | "multi_repo_feature";
  displayName: string;
  scanName: string;
  sourcePrefix: "WIZ" | "SONAR" | "MULTI_REPO";
  childLabel: string;
  filenamePrefix: string;
  reportHeading: string;
  nextStepText: string;
}

const WIZ_REPORT_SOURCE: TriageReportSource = {
  key: "wiz",
  displayName: "Wiz",
  scanName: "Wiz Scan",
  sourcePrefix: "WIZ",
  childLabel: PFOS_LABEL,
  filenamePrefix: "wiz-remediation-summary",
  reportHeading: "CP Platform Security Vulnerability Remediation",
  nextStepText:
    "Trigger redeploy to all environments for findings to clear in next Wiz scan",
};

const SONAR_REPORT_SOURCE: TriageReportSource = {
  key: "sonar",
  displayName: "SonarQube",
  scanName: "SonarQube Scan",
  sourcePrefix: "SONAR",
  childLabel: SONAR_AUTOFIX_LABEL,
  filenamePrefix: "sonarqube-remediation-summary",
  reportHeading: "CP Platform SonarQube Remediation",
  nextStepText:
    "Run the next SonarQube scan and confirm the listed issue keys are cleared",
};

export const MULTI_REPO_FEATURE_REPORT_SOURCE: TriageReportSource = {
  key: "multi_repo_feature",
  displayName: "Multi-Repo Feature",
  scanName: "Multi-Repo Feature Group",
  sourcePrefix: "MULTI_REPO",
  childLabel: PFOS_LABEL,
  filenamePrefix: "multi-repo-feature-summary",
  reportHeading: "CP Platform Multi-Repo Feature Group",
  nextStepText:
    "Merge PRs in the specified merge order and verify end-to-end integration",
};

// ---------------------------------------------------------------------------
// Entry point — called from state-transitions.ts (fire-and-forget)
// ---------------------------------------------------------------------------

export async function maybeGenerateTriageReport(
  db: Database,
  _oneShotDb: OneShotDatabase,
  runId: number,
  runGroupId: number | null,
): Promise<void> {
  try {
    let runs: OneShotRun[];
    let epicKey: string | null;
    let reportSource: TriageReportSource | null = null;

    if (runGroupId) {
      // Grouped run path — handles multi-repo feature groups
      const openCount = await countOpenRunsInGroup(db, runGroupId);
      if (openCount > 0) {
        logger.debug(
          { runGroupId, openCount },
          "Run group not yet complete — skipping report",
        );
        return;
      }
      runs = await getRunsInGroup(db, runGroupId);
      if (runs.length === 0) return;
      epicKey = await resolveEpicKey(db, runs[0]);
      reportSource = await resolveReportSourceForGroup(db, runGroupId);
    } else {
      // Individual run path — TRIAGE creates separate task_management rows,
      // each becoming its own run with no run_group_id.
      // Resolve the EPIC from this run, then check all sibling TRIAGE runs.
      const [thisRunRows] = await db
        .getPool()
        .query<any[]>("SELECT * FROM oneshot_runs WHERE id = ?", [runId]);
      const thisRun = (thisRunRows[0] ?? null) as OneShotRun | null;
      if (!thisRun) return;

      epicKey = await resolveEpicKey(db, thisRun);
      if (!epicKey) return;

      reportSource = await resolveReportSource(db, thisRun, epicKey);

      // Get all TRIAGE runs for this source whose source story is a child of
      // this EPIC. A run is a sibling if its jira_key has the same epic parent.
      runs = await getRunsByEpic(db, epicKey, reportSource);
      if (runs.length === 0) return;

      // Only proceed if ALL sibling runs are terminal
      const openCount = runs.filter(
        (r) => !TERMINAL_STATES.has(r.state),
      ).length;
      if (openCount > 0) {
        logger.debug(
          { epicKey, openCount },
          "Not all EPIC runs terminal — skipping report",
        );
        return;
      }
    }

    if (!epicKey) {
      logger.warn({ runId }, "Could not resolve EPIC key — skipping report");
      return;
    }

    logger.info(
      { epicKey, runCount: runs.length },
      "All runs terminal — generating TRIAGE report",
    );
    reportSource ??= await resolveReportSource(db, runs[0], epicKey);
    const report = buildReport(epicKey, runs, reportSource);
    await postReport(epicKey, report, runs, reportSource);
  } catch (err) {
    logger.error(
      {
        runGroupId,
        runId,
        error: err instanceof Error ? err.message : String(err),
      },
      "Failed to generate TRIAGE report",
    );
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

interface RunSummary {
  jiraKey: string;
  state: OneShotState;
  prUrl: string | null;
  planVersion: number | null;
}

function buildReport(
  epicKey: string,
  runs: OneShotRun[],
  reportSource: TriageReportSource,
): string {
  const total = runs.length;
  const completed = runs.filter(
    (r) => r.state === "pr_open" || r.state === "completed",
  ).length;
  const failed = runs.filter((r) => r.state === "failed").length;
  const escalated = runs.filter(
    (r) => r.state === "escalated" || r.state === "blocked",
  ).length;

  const allSuccess = failed === 0 && escalated === 0;

  const prLinks = runs
    .filter((r) => r.current_pr_url)
    .map(
      (r) => `| ${r.jira_key} | ${r.current_pr_url} | ${stateLabel(r.state)} |`,
    )
    .join("\n");

  const now = new Date().toISOString().split("T")[0];
  const nextSteps = [
    "- Merge open PRs (GUARD APPROVED — batch review recommended)",
    `- ${reportSource.nextStepText}`,
    ...(reportSource.key === "wiz"
      ? ["- Team B/C/D infrastructure stories require separate human execution"]
      : reportSource.key === "multi_repo_feature"
        ? ["- Verify cross-repo integration after all PRs are merged"]
        : ["- Review SonarQube review-needed stories separately before adding them to automation"]),
  ];

  return [
    `# ${reportSource.reportHeading}`,
    `## Leadership Summary — ${reportSource.scanName} (Epic: ${epicKey})`,
    `**Generated:** ${now}  `,
    `**Epic:** ${epicKey}`,
    "",
    "---",
    "",
    "## Executive Summary",
    "",
    `OneShot pipeline completed **${completed} of ${total} stories**.` +
      (failed > 0 ? ` ${failed} stories failed.` : "") +
      (escalated > 0 ? ` ${escalated} escalated/blocked.` : ""),
    "",
    "## Pipeline Results",
    "",
    `| Metric | Value |`,
    `|---|---|`,
    `| Stories completed | ${completed} / ${total} |`,
    `| PRs created | ${runs.filter((r) => r.current_pr_url).length} |`,
    `| Failed | ${failed} |`,
    `| Escalated / Blocked | ${escalated} |`,
    `| Overall status | ${allSuccess ? "✅ ALL GUARD APPROVED" : "⚠️ REVIEW REQUIRED"} |`,
    "",
    "## Stories Completed — PRs",
    "",
    "| Ticket | PR | Status |",
    "|---|---|---|",
    prLinks || "| (none) | | |",
    "",
    "## Testing",
    "",
    "| Phase | What it did |",
    "|---|---|",
    "| PRISM (Opus) | Deep codebase analysis, implementation plan posted to Jira |",
    "| TRACE | Structured test cases generated from AC + plan |",
    "| MACH | pom.xml version bumps, mvn dependency:tree verification, build check |",
    "| PUSH | Quality gates, commit, PR creation with WIP label |",
    "| GUARD | Code review against PRISM plan and AC |",
    "| QUEST | Unit tests, coverage validation, QA report posted |",
    "",
    "## Next Steps",
    "",
    ...nextSteps,
    "",
    `---`,
    `*Generated by OneShot TRIAGE Report | Epic: ${epicKey}*`,
  ].join("\n");
}

function stateLabel(state: OneShotState): string {
  switch (state) {
    case "pr_open":
    case "completed":
      return "✅ GUARD APPROVED";
    case "failed":
      return "❌ Failed";
    case "escalated":
      return "⚠️ Escalated";
    case "blocked":
      return "🚫 Blocked";
    default:
      return state;
  }
}

function buildAbridgedComment(
  epicKey: string,
  runs: OneShotRun[],
  reportSource: TriageReportSource,
): string {
  const total = runs.length;
  const completed = runs.filter(
    (r) => r.state === "pr_open" || r.state === "completed",
  ).length;
  const failed = runs.filter((r) => r.state === "failed").length;
  const prCount = runs.filter((r) => r.current_pr_url).length;
  const allSuccess = failed === 0;

  return [
    `## OneShot Pipeline Summary — ${epicKey}`,
    "",
    `**Stories completed:** ${completed} / ${total} ${allSuccess ? "✅" : "⚠️"}`,
    `**PRs created:** ${prCount}${allSuccess ? " (all GUARD APPROVED)" : ""}`,
    failed > 0 ? `**Failed:** ${failed} — see attached report` : "",
    "",
    "Full report status is listed below.",
    "",
    `Next: merge open PRs. ${reportSource.nextStepText}.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// ---------------------------------------------------------------------------
// Jira posting
// ---------------------------------------------------------------------------

async function postReport(
  epicKey: string,
  markdown: string,
  runs: OneShotRun[],
  reportSource: TriageReportSource,
): Promise<void> {
  try {
    const jiraClient = getTriageJiraClient();
    if (!jiraClient) return; // credentials not configured — skip silently

    // Attach full Markdown report to the EPIC
    const now = new Date().toISOString().split("T")[0];
    const filename = `${reportSource.filenamePrefix}-${now}.md`;
    let fullReportReference = `Full report attached: **${filename}**`;
    let jiraMutationsSkipped = false;
    try {
      const attachResult = await jiraClient.attachFileToIssue(
        epicKey,
        filename,
        markdown,
        "text/markdown",
      );
      if (attachResult.status === "attached") {
        logger.info({ epicKey, filename }, "TRIAGE report attached to EPIC");
      } else {
        jiraMutationsSkipped = true;
        fullReportReference = `Full report attachment skipped because Jira mutations are disabled: **${filename}**`;
        logger.warn(
          { epicKey, filename, reason: attachResult.reason },
          "TRIAGE report attachment skipped",
        );
      }
    } catch (attachErr) {
      // Attachment failure is non-fatal — fall through to comment
      logger.warn(
        {
          epicKey,
          error:
            attachErr instanceof Error ? attachErr.message : String(attachErr),
        },
        "Failed to attach report — posting full report as comment instead",
      );
      await jiraClient.addComment(
        epicKey,
        `## ${reportSource.displayName} Remediation Report\n\n${markdown}`,
      );
      fullReportReference =
        "Full report attachment failed; full report was posted in a separate Jira comment.";
    }

    // Post abridged comment referencing the full report outcome.
    const comment = buildAbridgedComment(epicKey, runs, reportSource);
    await jiraClient.addComment(epicKey, comment + `\n\n${fullReportReference}`);

    // Determine completion label
    const failed = runs.filter((r) => r.state === "failed").length;
    const escalated = runs.filter(
      (r) => r.state === "escalated" || r.state === "blocked",
    ).length;
    const suffix =
      failed > 0 || escalated > 0 ? "COMPLETE-WITH-EXCEPTIONS" : "COMPLETE";

    await jiraClient.updateIssueLabels(epicKey, {
      remove: [`${reportSource.sourcePrefix}-SCAN-IN-PROGRESS`],
      add: [`${reportSource.sourcePrefix}-SCAN-${suffix}`],
    });

    if (jiraMutationsSkipped) {
      logger.warn(
        { epicKey, suffix },
        "TRIAGE report generated but Jira mutation guard skipped comment and label updates",
      );
    } else {
      logger.info(
        { epicKey, suffix },
        "TRIAGE report posted and EPIC label updated",
      );
    }
  } catch (err) {
    logger.error(
      { epicKey, error: err instanceof Error ? err.message : String(err) },
      "Failed to post TRIAGE report to Jira",
    );
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function countOpenRunsInGroup(
  db: Database,
  runGroupId: number,
): Promise<number> {
  const [rows] = await db.getPool().query<any[]>(
    `SELECT COUNT(*) AS open_count
     FROM oneshot_runs
     WHERE run_group_id = ?
       AND state NOT IN ('pr_open','completed','failed','escalated','blocked')`,
    [runGroupId],
  );
  return (rows[0]?.open_count as number) ?? 1;
}

async function getRunsInGroup(
  db: Database,
  runGroupId: number,
): Promise<OneShotRun[]> {
  const [rows] = await db
    .getPool()
    .query<
      any[]
    >(`SELECT * FROM oneshot_runs WHERE run_group_id = ?`, [runGroupId]);
  return rows as OneShotRun[];
}

/**
 * Find all oneshot_runs whose source story is a direct child of the given EPIC.
 *
 * Strategy: fetch the EPIC's child issues from Jira to get the exact list of
 * child story keys, then look up only those runs — no prefix guessing.
 * This avoids false positives from unrelated CPDEV-* runs with the same prefix.
 */
async function getRunsByEpic(
  db: Database,
  epicKey: string,
  reportSource: TriageReportSource,
): Promise<OneShotRun[]> {
  try {
    // Get the definitive list of child story keys from Jira
    const jiraClient = getTriageJiraClient();
    if (!jiraClient) return [];
    const childIssues = await jiraClient.searchIssues(
      `parentEpic = ${epicKey} AND labels = "${reportSource.childLabel}" ORDER BY created ASC`,
      "key",
    );

    if (childIssues.total === 0) return [];

    const childKeys = childIssues.issues.map((i) => i.key);
    if (childKeys.length === 0) return [];

    // Fetch runs for exactly these keys
    const placeholders = childKeys.map(() => "?").join(",");
    const [rows] = await db
      .getPool()
      .query<
        any[]
      >(`SELECT * FROM oneshot_runs WHERE jira_key IN (${placeholders})`, childKeys);
    return rows as OneShotRun[];
  } catch (err) {
    logger.warn(
      { epicKey, error: err instanceof Error ? err.message : String(err) },
      "getRunsByEpic Jira lookup failed — skipping report for this run",
    );
    return [];
  }
}

async function resolveReportSourceForGroup(
  db: Database,
  runGroupId: number,
): Promise<TriageReportSource | null> {
  const [rows] = await db.getPool().query<any[]>(
    "SELECT metadata_json FROM oneshot_run_groups WHERE id = ?",
    [runGroupId],
  );
  const metadata = rows[0]?.metadata_json as { mode?: string } | undefined;
  if (metadata?.mode === "multi_repo") {
    return MULTI_REPO_FEATURE_REPORT_SOURCE;
  }
  return null;
}

async function resolveReportSource(
  db: Database,
  run: OneShotRun,
  epicKey: string,
): Promise<TriageReportSource> {
  const jiraClient = getTriageJiraClient();
  if (!jiraClient) return WIZ_REPORT_SOURCE;

  try {
    const taskIssueKey = await getTaskIssueKey(db, run);
    if (taskIssueKey) {
      const taskIssue = await jiraClient.fetchIssue(taskIssueKey);
      const taskSource = sourceFromLabels(taskIssue.fields?.labels);
      if (taskSource) return taskSource;
    }

    const epicIssue = await jiraClient.fetchIssue(epicKey);
    const epicSource = sourceFromLabels(epicIssue.fields?.labels);
    if (epicSource) return epicSource;
  } catch (err) {
    logger.warn(
      { epicKey, error: err instanceof Error ? err.message : String(err) },
      "Could not infer TRIAGE report source from Jira labels; defaulting to WIZ",
    );
  }

  return WIZ_REPORT_SOURCE;
}

async function getTaskIssueKey(
  db: Database,
  run: OneShotRun,
): Promise<string | null> {
  const [rows] = await db
    .getPool()
    .query<
      any[]
    >(`SELECT jira_number FROM task_management WHERE id = ?`, [run.source_task_management_id]);
  return (rows[0]?.jira_number as string | undefined) ?? null;
}

function sourceFromLabels(
  labels: string[] | undefined,
): TriageReportSource | null {
  const normalized = new Set(
    (labels ?? []).map((label) => label.toUpperCase()),
  );

  if (
    normalized.has(SONAR_AUTOFIX_LABEL) ||
    normalized.has(SONAR_LABEL) ||
    [...normalized].some((label) => label.startsWith("SONAR-SCAN-"))
  ) {
    return SONAR_REPORT_SOURCE;
  }

  if (
    normalized.has(PFOS_LABEL) ||
    [...normalized].some((label) => label.startsWith("WIZ-SCAN-"))
  ) {
    return WIZ_REPORT_SOURCE;
  }

  return null;
}

async function resolveEpicKey(
  db: Database,
  run: OneShotRun,
): Promise<string | null> {
  try {
    // Find the task_management row for this run's source_task_management_id
    const [rows] = await db
      .getPool()
      .query<
        any[]
      >(`SELECT jira_number FROM task_management WHERE id = ?`, [run.source_task_management_id]);
    const jiraNumber = rows[0]?.jira_number as string | undefined;
    if (!jiraNumber) return null;

    // Fetch the issue to get its parent EPIC
    const jiraClient = getTriageJiraClient();
    if (!jiraClient) return null;
    const issue = await jiraClient.fetchIssue(jiraNumber);
    const parent = issue.fields?.parent as { key?: string } | undefined;
    return parent?.key ?? null;
  } catch {
    return null;
  }
}
