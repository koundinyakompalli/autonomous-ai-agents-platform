/**
 * TRIAGE Jira writer — creates stories and posts comments
 */

import { createLogger } from "../../utils/logger.js";
import type { JiraClient } from "../JiraClient.js";
import type { TriagePathDisposition, TriageStory } from "./types.js";
import { SONAR_AUTOFIX_LABEL, SONAR_LABEL } from "../../oneshot/contracts.js";

const logger = createLogger("triage-jira-writer");

// Jira Cloud rejects any single comment whose body text exceeds 32,767 chars
// with CONTENT_LIMIT_EXCEEDED. Stay comfortably under that so headroom remains
// for ADF wrapping and multi-byte characters.
const JIRA_COMMENT_CHAR_LIMIT = 30_000;
const JIRA_ISSUE_DESCRIPTION_CHAR_LIMIT = 30_000;

export interface CreateStoryResult {
  key: string;
  summary: string;
}

/** Create a Jira child story under the EPIC */
export async function createJiraStory(
  jiraClient: JiraClient,
  epicKey: string,
  story: TriageStory,
): Promise<CreateStoryResult> {
  const labels: string[] =
    story.source === "sonar" ? [SONAR_LABEL, "code-quality"] : ["security"];

  if (story.source === "sonar") {
    if (story.team === "A") labels.push(SONAR_AUTOFIX_LABEL);
    labels.push(`SONAR-${story.severity.toUpperCase()}`);
    for (const issueType of story.issueTypes ?? []) {
      labels.push(`SONAR-${issueType.toUpperCase()}`);
    }
    if ((story.issueTypes ?? []).includes("VULNERABILITY")) {
      labels.push("security");
    }
  } else if (story.source === "wiz-code") {
    // Wiz Code (SAST) stories are pushed into OneShot via PFOS (same as CVE
    // stories). Keep the WIZ-CODE / SAST identity labels alongside PFOS so the
    // source stays visible. Repo is known from resource.name.
    labels.push("WIZ-CODE", "SAST");
    if (story.isPfos) {
      labels.push("PFOS");
    }
    labels.push(story.slaTier);
    if (story.repoConfidence && story.repoConfidence !== "high") {
      labels.push("REPO-MAPPING-NEEDED");
    }
  } else if (story.isPfos) {
    labels.push("PFOS");
    labels.push(story.slaTier);
    if (story.team === "A" && story.repoConfidence !== "high") {
      labels.push("REPO-MAPPING-NEEDED");
    }
  } else if (story.team === "A") {
    labels.push("TEAM-A");
    labels.push(story.slaTier);
    if (story.repoConfidence !== "high") {
      labels.push("REPO-MAPPING-NEEDED");
    }
    if (story.queueForOneShot === false) {
      labels.push("ONESHOT-APPROVAL-REQUIRED");
    }
  } else {
    labels.push(`TEAM-${story.team}`);
    labels.push(story.slaTier);
  }

  const body = buildStoryBody(epicKey, story);
  const boundedBody = buildCreateIssueBody(epicKey, story, body);

  const result = await jiraClient.createIssue({
    projectKey: epicKey.split("-")[0],
    summary: story.title,
    description: boundedBody.description,
    issueType: "Story",
    labels,
    priority: slaTierToPriority(story.slaTier),
    parentKey: epicKey,
    storyPoints: 3,
  });

  if (boundedBody.fullDescription) {
    await attachOverflowStoryDescription(jiraClient, result.key, {
      fullDescription: boundedBody.fullDescription,
      attachmentFilename: boundedBody.attachmentFilename,
    });
  }

  logger.info(
    { key: result.key, team: story.team, isPfos: story.isPfos },
    "Created Jira story",
  );
  return result;
}

/** Post "Where to Update" comment on a Team A story */
export async function postWhereToUpdateComment(
  jiraClient: JiraClient,
  storyKey: string,
  story: TriageStory,
): Promise<void> {
  let comment: string;
  if (story.source === "sonar") {
    comment =
      `[TRIAGE] SonarQube Where to Update — ${story.packageName}\n\n` +
      `Rule(s): ${(story.ruleIds ?? [story.packageName]).join(", ")}\n` +
      `Issue keys: ${(story.findingKeys ?? story.cveIds).join(", ")}\n` +
      formatRepoHeaderLines(story) +
      story.whereToUpdate +
      `\n\nFindings: ${story.findingCount.toLocaleString()}`;
  } else if (story.source === "wiz-code") {
    // SAST findings have no CVE / target version; label by weakness + branch.
    comment =
      `[TRIAGE] Wiz Code Where to Update — ${story.packageName}\n\n` +
      `Weakness (CWE): ${(story.ruleIds ?? [story.packageName]).join(", ")}\n` +
      (story.repoDefaultBranch ? `Branch: ${story.repoDefaultBranch}\n` : "") +
      formatRepoHeaderLines(story) +
      story.whereToUpdate +
      `\n\nFindings: ${story.findingCount.toLocaleString()}`;
  } else {
    comment =
      `[TRIAGE] Where to Update — ${story.packageName}\n\n` +
      `CVEs: ${story.cveIds.join(", ")}\n` +
      `Target version: ${story.targetVersion}\n` +
      formatRepoHeaderLines(story) +
      story.whereToUpdate +
      `\n\nFindings: ${story.findingCount.toLocaleString()} | Assets: ${story.assetCount.toLocaleString()}`;
  }

  await jiraClient.addComment(storyKey, comment);
}

/** Flip the EPIC label from PENDING to IN-PROGRESS */
export async function setEpicInProgress(
  jiraClient: JiraClient,
  epicKey: string,
  sourcePrefix: string,
): Promise<void> {
  await jiraClient.updateIssueLabels(epicKey, {
    remove: [
      `${sourcePrefix}-SCAN-PENDING`,
      `${sourcePrefix}-SCAN-REVIEW-READY`,
      `${sourcePrefix}-SCAN-APPROVED`,
    ],
    add: [`${sourcePrefix}-SCAN-IN-PROGRESS`],
  });
}

/** Flip the EPIC label from PENDING to REVIEW-READY after analysis. */
export async function setEpicReviewReady(
  jiraClient: JiraClient,
  epicKey: string,
  sourcePrefix: string,
): Promise<void> {
  await jiraClient.updateIssueLabels(epicKey, {
    remove: [`${sourcePrefix}-SCAN-PENDING`],
    add: [`${sourcePrefix}-SCAN-REVIEW-READY`],
  });
}

/** Flip the EPIC label to COMPLETE or FAILED */
export async function setEpicComplete(
  jiraClient: JiraClient,
  epicKey: string,
  sourcePrefix: string,
  status: "COMPLETE" | "COMPLETE-WITH-EXCEPTIONS" | "FAILED",
): Promise<void> {
  await jiraClient.updateIssueLabels(epicKey, {
    remove: [`${sourcePrefix}-SCAN-IN-PROGRESS`],
    add: [`${sourcePrefix}-SCAN-${status}`],
  });
}

/** Post summary comment on EPIC when TRIAGE finishes */
export async function postTriageSummaryComment(
  jiraClient: JiraClient,
  epicKey: string,
  summary: {
    source: string;
    totalRows: number;
    uniqueFindings: number;
    teamAStories: string[];
    teamBCDStories: string[];
    backupCleanupStories: string[];
    reviewNeededStories: string[];
    skippedNonMaven: number;
    dryRun: boolean;
  },
): Promise<void> {
  const sourcePrefix = summary.source.toUpperCase();
  const header = [
    `[TRIAGE] ${summary.dryRun ? "DRY RUN — " : ""}Scan classified: ${sourcePrefix}`,
    "",
    `Raw findings: ${summary.totalRows.toLocaleString()}`,
    `Unique scoped findings: ${summary.uniqueFindings.toLocaleString()}`,
    "",
    `Team A (Maven/OneShot pipeline): ${summary.teamAStories.length} stories`,
    `Team B/C/D (human execution): ${summary.teamBCDStories.length} stories`,
    `Backup/archive cleanup (DevOps): ${summary.backupCleanupStories.length} stories`,
    `Held for human review: ${summary.reviewNeededStories.length} candidates`,
    summary.skippedNonMaven > 0
      ? `Skipped (non-Maven, v1 not supported): ${summary.skippedNonMaven} — labeled PFOS-NOT-QUALIFIED`
      : "",
    summary.dryRun
      ? "DRY RUN: No stories were created. Re-run without --dry-run to create."
      : "",
  ].filter((l) => l !== "");

  const keyList = (keys: string[]) =>
    keys.length > 0 ? keys.map((k) => `  • ${k}`) : ["  (none)"];
  const detail = [
    "Team A (Maven/OneShot pipeline):",
    ...keyList(summary.teamAStories),
    "",
    "Team B/C/D (human execution):",
    ...keyList(summary.teamBCDStories),
    "",
    "Backup/archive cleanup (DevOps):",
    ...keyList(summary.backupCleanupStories),
    "",
    "Held for human review:",
    ...keyList(summary.reviewNeededStories),
  ];

  await postCommentOrAttach(jiraClient, epicKey, {
    header,
    detail,
    attachmentFilename: `TRIAGE-summary-${sourcePrefix}-${epicKey}.md`,
  });
}

/** Post analysis-only report on EPIC before any child story creation. */
export async function postTriageAnalysisComment(
  jiraClient: JiraClient,
  epicKey: string,
  summary: {
    source: string;
    totalRows: number;
    uniqueFindings: number;
    teamAStories: TriageStory[];
    teamBCDStories: TriageStory[];
    backupCleanupStories: TriageStory[];
    reviewNeededStories: TriageStory[];
    suppressedByDisposition: Record<
      TriagePathDisposition | "non-maven",
      number
    >;
    needsReviewFindings: number;
    dryRun: boolean;
  },
): Promise<void> {
  const sourcePrefix = summary.source.toUpperCase();
  const header = buildAnalysisHeader(summary, sourcePrefix);
  const detail = buildAnalysisDetail(summary);

  await postCommentOrAttach(jiraClient, epicKey, {
    header,
    detail,
    attachmentFilename: `TRIAGE-analysis-${sourcePrefix}-${epicKey}.md`,
  });
}

/**
 * Post a report as a Jira comment, falling back to a file attachment when the
 * full text would exceed Jira's comment size limit (CONTENT_LIMIT_EXCEEDED on
 * bodies over ~32,767 chars). The `header` is always small enough to inline;
 * the unbounded `detail` is what gets attached when the combined body is large.
 */
async function postCommentOrAttach(
  jiraClient: JiraClient,
  epicKey: string,
  report: {
    header: string[];
    detail: string[];
    attachmentFilename: string;
  },
): Promise<void> {
  const { header, detail, attachmentFilename } = report;
  const fullReport = [...header, "", ...detail].join("\n");

  if (fullReport.length <= JIRA_COMMENT_CHAR_LIMIT) {
    await jiraClient.addComment(epicKey, fullReport);
    return;
  }

  // Attach the full breakdown and post a pointer comment as independent steps,
  // so the comment accurately reflects whether the attachment actually landed.
  let attached = false;
  let skippedByMutationGuard = false;
  try {
    const attachResult = await jiraClient.attachFileToIssue(
      epicKey,
      attachmentFilename,
      fullReport,
      "text/markdown",
    );
    attached = attachResult?.status === "attached";
    skippedByMutationGuard = attachResult?.status === "skipped";
  } catch (err) {
    logger.error(
      { epicKey, error: err instanceof Error ? err.message : String(err) },
      "Failed to attach full TRIAGE report; posting header-only comment",
    );
  }

  const pointer = attached
    ? `Full breakdown (${detail.length.toLocaleString()} lines) exceeds Jira's comment size limit, so it is attached as ${attachmentFilename}.`
    : skippedByMutationGuard
      ? `Full breakdown (${detail.length.toLocaleString()} lines) exceeds Jira's comment size limit and was not attached because Jira mutations are disabled. Re-run TRIAGE with Jira mutations enabled to attach ${attachmentFilename}.`
      : "Full breakdown could not be attached — re-run TRIAGE or inspect orchestrator logs for details.";

  await jiraClient.addComment(epicKey, [...header, "", pointer].join("\n"));
}

function buildCreateIssueBody(
  epicKey: string,
  story: TriageStory,
  fullDescription: string,
): {
  description: string;
  fullDescription?: string;
  attachmentFilename?: string;
} {
  if (fullDescription.length <= JIRA_ISSUE_DESCRIPTION_CHAR_LIMIT) {
    return { description: fullDescription };
  }

  const attachmentFilename = `TRIAGE-story-detail-${epicKey}-${sanitizeFilenamePart(
    story.packageName || "story",
  )}.md`;
  const description = clampForJiraIssueDescription(
    buildBoundedStoryDescription(epicKey, story, attachmentFilename),
  );

  return {
    description,
    fullDescription,
    attachmentFilename,
  };
}

function buildBoundedStoryDescription(
  epicKey: string,
  story: TriageStory,
  attachmentFilename: string,
): string {
  const cves = formatValueList(story.cveIds, 20);
  const pathSamples = extractAffectedPathSamples(story.whereToUpdate);
  const pathLines =
    pathSamples.length > 0
      ? ["Where to Update (sample)", ...pathSamples.map((path) => `- ${path}`)]
      : [];

  if (story.team === "A" && story.source !== "sonar") {
    return [
      "Summary",
      `Update ${story.packageName} security remediation in ${story.applicationRoot || story.repoName || "the mapped runtime scope"}.`,
      "",
      "Overview",
      `Full TRIAGE detail exceeded Jira's description limit. Attachment target: ${attachmentFilename}. This ticket keeps the OneShot routing fields inline and moves the full path/CVE breakdown to the attachment when Jira mutations are enabled.`,
      "",
      "Acceptance Criteria",
      ...buildAcceptanceCriteria(story).map(
        (item) => `- ${stripNumberPrefix(item)}`,
      ),
      "",
      "Technical Details",
      `Epic: ${epicKey}`,
      formatRepoDirectiveLine(story),
      ...buildRepoResolutionBodyLines(story),
      story.queueForOneShot === false
        ? `OneShot queue status: not auto-queued — ${story.queueBlockedReason ?? "explicit approval required"}`
        : "",
      story.repoDefaultBranch ? `Branch: ${story.repoDefaultBranch}` : "",
      story.applicationRoot
        ? `Application/runtime root: ${story.applicationRoot}`
        : "",
      story.pathDisposition ? `Path disposition: ${story.pathDisposition}` : "",
      `Package: ${story.packageName}`,
      `Target version: ${story.targetVersion || "Remove/exclude (EOL - no safe version)"}`,
      `CVEs: ${cves}`,
      `Findings: ${story.findingCount.toLocaleString()} raw | Assets: ${story.assetCount.toLocaleString()}`,
      "",
      ...pathLines,
      "",
      "Out of Scope",
      "- Do not remediate backup/archive, runtime-tooling, or unrelated platform findings in this ticket.",
      "- Do not perform broad dependency cleanup outside the affected project/module.",
      "",
      "Testing Notes",
      "- Run the relevant Maven compile/unit test command for the affected project.",
      "- Verify dependency tree and packaged artifacts no longer include the vulnerable dependency.",
      "- Confirm the next Wiz scan clears the listed findings.",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  return [
    `Epic: ${epicKey}`,
    `Full TRIAGE detail exceeded Jira's description limit. Attachment target: ${attachmentFilename}.`,
    "",
    story.source === "sonar" ? "Source: SonarQube" : "",
    `Package/rule: ${story.packageName}`,
    story.applicationRoot ? `Application/root: ${story.applicationRoot}` : "",
    story.repoName ? `Repo: ${story.repoName}` : "Repo: manual/platform",
    story.pathDisposition ? `Path disposition: ${story.pathDisposition}` : "",
    `Target: ${story.targetVersion || "see remediation"}`,
    story.source === "sonar"
      ? `Issue keys: ${formatValueList(story.findingKeys ?? story.cveIds, 20)}`
      : `CVEs: ${cves}`,
    `Findings: ${story.findingCount.toLocaleString()} raw | Assets: ${story.assetCount.toLocaleString()}`,
    "",
    ...pathLines,
    "",
    "Acceptance Criteria",
    ...buildAcceptanceCriteria(story).map(
      (item) => `- ${stripNumberPrefix(item)}`,
    ),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function attachOverflowStoryDescription(
  jiraClient: JiraClient,
  storyKey: string,
  body: {
    fullDescription: string;
    attachmentFilename?: string;
  },
): Promise<void> {
  const attachmentFilename =
    body.attachmentFilename ?? `TRIAGE-story-detail-${storyKey}.md`;
  let attached = false;
  let skippedByMutationGuard = false;

  try {
    const attachResult = await jiraClient.attachFileToIssue(
      storyKey,
      attachmentFilename,
      body.fullDescription,
      "text/markdown",
    );
    attached = attachResult?.status === "attached";
    skippedByMutationGuard = attachResult?.status === "skipped";
  } catch (err) {
    logger.error(
      { storyKey, error: err instanceof Error ? err.message : String(err) },
      "Failed to attach full TRIAGE story description",
    );
  }

  const pointer = attached
    ? `[TRIAGE] Full story detail exceeded Jira's description limit and is attached as ${attachmentFilename}.`
    : skippedByMutationGuard
      ? `[TRIAGE] Full story detail exceeded Jira's description limit and was not attached because Jira mutations are disabled. Re-run TRIAGE with Jira mutations enabled to attach ${attachmentFilename}.`
      : "[TRIAGE] Full story detail exceeded Jira's description limit, but the attachment upload failed. Inspect orchestrator logs or re-run TRIAGE after fixing attachment upload.";

  try {
    await jiraClient.addComment(storyKey, pointer);
  } catch (err) {
    logger.warn(
      { storyKey, error: err instanceof Error ? err.message : String(err) },
      "Failed to post TRIAGE story overflow pointer comment",
    );
  }
}

function clampForJiraIssueDescription(description: string): string {
  if (description.length <= JIRA_ISSUE_DESCRIPTION_CHAR_LIMIT) {
    return description;
  }

  const suffix =
    "\n\n[TRIAGE] Description truncated to fit Jira. See the attached full TRIAGE story detail.";
  return `${description.slice(
    0,
    JIRA_ISSUE_DESCRIPTION_CHAR_LIMIT - suffix.length,
  )}${suffix}`;
}

function sanitizeFilenamePart(value: string): string {
  const safe = value
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return safe || "story";
}

/** Headline counts block — bounded, safe to inline in a Jira comment. */
function buildAnalysisHeader(
  summary: {
    totalRows: number;
    uniqueFindings: number;
    teamAStories: TriageStory[];
    teamBCDStories: TriageStory[];
    backupCleanupStories: TriageStory[];
    reviewNeededStories: TriageStory[];
    suppressedByDisposition: Record<
      TriagePathDisposition | "non-maven",
      number
    >;
    needsReviewFindings: number;
  },
  sourcePrefix: string,
): string[] {
  const suppressedTotal = Object.values(summary.suppressedByDisposition).reduce(
    (sum, count) => sum + count,
    0,
  );
  return [
    `[TRIAGE] Analysis complete: ${sourcePrefix}`,
    "",
    `No child stories were created. Add ${sourcePrefix}-SCAN-APPROVED when the grouped analysis is approved for ticket creation.`,
    "",
    `Raw findings: ${summary.totalRows.toLocaleString()}`,
    `Unique scoped findings: ${summary.uniqueFindings.toLocaleString()}`,
    "",
    `Ticket candidates: ${(
      summary.teamAStories.length +
      summary.teamBCDStories.length +
      summary.backupCleanupStories.length
    ).toLocaleString()}`,
    `Held for human review (no tickets): ${summary.reviewNeededStories.length.toLocaleString()}`,
    `Team A candidates (OneShot/source remediation): ${summary.teamAStories.length.toLocaleString()}`,
    `Team B/C/D candidates (manual/platform execution): ${summary.teamBCDStories.length.toLocaleString()}`,
    `Backup/archive cleanup candidates (DevOps): ${summary.backupCleanupStories.length.toLocaleString()}`,
    `Suppressed findings: ${suppressedTotal.toLocaleString()}`,
    `Needs review findings: ${summary.needsReviewFindings.toLocaleString()}`,
    "",
    "Suppressed by disposition:",
    ...Object.entries(summary.suppressedByDisposition)
      .filter(([, count]) => count > 0)
      .map(([disposition, count]) => `  - ${disposition}: ${count}`),
  ];
}

/** Full per-candidate breakdown — unbounded; may be attached rather than inlined. */
function buildAnalysisDetail(summary: {
  teamAStories: TriageStory[];
  teamBCDStories: TriageStory[];
  backupCleanupStories: TriageStory[];
  reviewNeededStories: TriageStory[];
}): string[] {
  return [
    "Team A candidates for human review:",
    ...formatStoryCandidates(summary.teamAStories, Infinity, true),
    "",
    "Source candidates held for human review:",
    ...formatStoryCandidates(summary.reviewNeededStories, Infinity, true),
    "",
    "Team B/C/D manual/platform candidates:",
    ...formatStoryCandidates(summary.teamBCDStories, Infinity, false),
    "",
    "Backup/archive directories segregated from remediation:",
    ...formatBackupCleanupCandidates(summary.backupCleanupStories),
  ].filter((l) => l !== "");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slaTierToPriority(tier: string): string {
  if (tier === "P1-CISA-KEV" || tier === "P1-HIGH-EXPLOIT") return "P1";
  if (tier === "P2-30-DAY") return "P2";
  return "P3";
}

function formatStoryCandidates(
  stories: TriageStory[],
  limit: number,
  includePaths: boolean,
): string[] {
  if (stories.length === 0) return ["  (none)"];

  return stories.slice(0, limit).flatMap((story, index) => {
    const lines =
      story.source === "sonar"
        ? [
            `${index + 1}. [${story.slaTier}] ${story.packageName}`,
            `   Repo: ${story.repoName || "manual/platform"}`,
            story.applicationRoot
              ? `   Module/root: ${story.applicationRoot}`
              : "",
            story.pathDisposition
              ? `   Disposition: ${story.pathDisposition}`
              : "",
            `   Issue types: ${(story.issueTypes ?? []).join(", ") || "Unknown"}`,
            `   Issue keys: ${formatValueList(story.findingKeys ?? story.cveIds, 15)}`,
            `   Findings: ${story.findingCount.toLocaleString()}`,
          ]
        : [
            `${index + 1}. [${story.slaTier}] ${story.packageName}`,
            `   Repo: ${formatStoryRepo(story)}`,
            story.applicationRoot
              ? `   Application/root: ${story.applicationRoot}`
              : "",
            story.pathDisposition
              ? `   Disposition: ${story.pathDisposition}`
              : "",
            `   CVEs: ${formatValueList(story.cveIds, 15)}`,
            `   Target: ${story.targetVersion || "see remediation"}`,
            `   Findings: ${story.findingCount.toLocaleString()} raw | Assets: ${story.assetCount.toLocaleString()}`,
          ];

    if (includePaths) {
      const paths = extractAffectedPathSamples(story.whereToUpdate);
      if (paths.length > 0) {
        lines.push("   Sample paths:");
        lines.push(...paths.map((path) => `     - ${path}`));
      }
    }

    return lines.filter((line) => line !== "");
  });
}

function formatStoryRepo(story: TriageStory): string {
  if (story.repoName) return story.repoName;
  if (story.team === "A") return "repo mapping needed";
  return "manual/platform";
}

function extractAffectedPathSamples(whereToUpdate: string): string[] {
  return whereToUpdate
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("•"))
    .map((line) => line.replace(/^•\s*/, ""))
    .slice(0, 3);
}

function formatBackupCleanupCandidates(stories: TriageStory[]): string[] {
  if (stories.length === 0) return ["  (none)"];

  return stories.flatMap((story, index) => {
    const lines = [
      `${index + 1}. [${story.slaTier}] DevOps cleanup candidate`,
      `   Findings: ${story.findingCount.toLocaleString()} raw | Assets: ${story.assetCount.toLocaleString()}`,
      "   Action: validate retention, then remove stale backup/archive folders or move retained archives outside scanned runtime paths.",
      "   Top directories:",
      ...story.whereToUpdate
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("•"))
        .slice(0, 10)
        .map((line) => `     - ${line.replace(/^•\s*/, "")}`),
    ];
    return lines.filter((line) => line !== "");
  });
}

function formatValueList(values: string[], limit: number): string {
  if (values.length <= limit) return values.join(", ");
  return `${values.slice(0, limit).join(", ")}, ... and ${
    values.length - limit
  } more`;
}

function buildStoryBody(epicKey: string, story: TriageStory): string {
  if (story.source === "sonar") {
    return buildSonarStoryBody(epicKey, story);
  }

  // Wiz Code (SAST) stories carry a fully-built OneShot-format description
  // (branch, language, weakness, code-fix guidance) from the engine. Reuse it
  // verbatim — the dependency-CVE body below would mislabel these as Maven
  // version bumps.
  if (story.source === "wiz-code" && story.description) {
    return story.description;
  }

  if (story.team === "A") {
    return buildOneShotStoryBody(epicKey, story);
  }

  const lines = [
    `Epic: ${epicKey}`,
    "",
    `CVEs: ${story.cveIds.join(", ")}`,
    `Package: ${story.packageName}`,
    story.applicationRoot
      ? `Application/runtime root: ${story.applicationRoot}`
      : "",
    story.pathDisposition ? `Path disposition: ${story.pathDisposition}` : "",
    `Target version: ${story.targetVersion || "Remove/exclude (EOL — no safe version)"}`,
    `Repo: ${story.repoName}`,
    ...buildRepoResolutionBodyLines(story),
    `Findings: ${story.findingCount.toLocaleString()} raw | Assets: ${story.assetCount.toLocaleString()}`,
    "",
    "Where to Update:",
    story.whereToUpdate,
    "",
    "Acceptance Criteria:",
    ...buildAcceptanceCriteria(story),
  ].filter((line) => line !== "");

  return lines.join("\n");
}

function buildOneShotStoryBody(epicKey: string, story: TriageStory): string {
  const lines = [
    "Summary",
    `Update ${story.packageName} security remediation in ${story.applicationRoot || story.repoName}.`,
    "",
    "Overview",
    `TRIAGE found ${story.findingCount.toLocaleString()} Wiz finding(s) for ${story.packageName} under ${story.applicationRoot || "the mapped runtime scope"}. This ticket is scoped to the mapped source project below and should remediate the vulnerable dependency without changing adjacent application behavior.`,
    "",
    "Acceptance Criteria",
    ...buildAcceptanceCriteria(story).map(
      (item) => `- ${stripNumberPrefix(item)}`,
    ),
    "",
    "Technical Details",
    `Epic: ${epicKey}`,
    formatRepoDirectiveLine(story),
    ...buildRepoResolutionBodyLines(story),
    story.queueForOneShot === false
      ? `OneShot queue status: not auto-queued — ${story.queueBlockedReason ?? "explicit approval required"}`
      : "",
    story.repoDefaultBranch ? `Branch: ${story.repoDefaultBranch}` : "",
    story.applicationRoot
      ? `Application/runtime root: ${story.applicationRoot}`
      : "",
    story.pathDisposition ? `Path disposition: ${story.pathDisposition}` : "",
    `Package: ${story.packageName}`,
    `Target version: ${story.targetVersion || "Remove/exclude (EOL - no safe version)"}`,
    `CVEs: ${story.cveIds.join(", ")}`,
    `Findings: ${story.findingCount.toLocaleString()} raw | Assets: ${story.assetCount.toLocaleString()}`,
    "",
    "Where to Update",
    story.whereToUpdate,
    "",
    "Out of Scope",
    "- Do not remediate backup/archive, runtime-tooling, or unrelated platform findings in this ticket.",
    "- Do not perform broad dependency cleanup outside the affected project/module.",
    "",
    "Testing Notes",
    "- Run the relevant Maven compile/unit test command for the affected project.",
    "- Verify dependency tree and packaged artifacts no longer include the vulnerable dependency.",
    "- Confirm the next Wiz scan clears the listed findings.",
  ].filter((line) => line !== "");

  return lines.join("\n");
}

function buildSonarStoryBody(epicKey: string, story: TriageStory): string {
  const lines = [
    `Epic: ${epicKey}`,
    "Source: SonarQube",
    "",
    `Rule(s): ${(story.ruleIds ?? [story.packageName]).join(", ")}`,
    `Issue type(s): ${(story.issueTypes ?? []).join(", ") || "Unknown"}`,
    `Issue keys: ${(story.findingKeys ?? story.cveIds).join(", ")}`,
    `Repo: ${story.repoName}`,
    ...buildRepoResolutionBodyLines(story),
    story.applicationRoot ? `Module/root: ${story.applicationRoot}` : "",
    story.pathDisposition ? `Path disposition: ${story.pathDisposition}` : "",
    `Findings: ${story.findingCount.toLocaleString()}`,
    "",
    "Where to Update:",
    story.whereToUpdate,
    "",
    "Acceptance Criteria:",
    ...buildAcceptanceCriteria(story),
  ].filter((line) => line !== "");

  return lines.join("\n");
}

function buildRepoResolutionBodyLines(story: TriageStory): string[] {
  const lines: string[] = [];
  if (story.repoFullName) lines.push(`GitHub Repo: ${story.repoFullName}`);
  if (story.repoProjectPath) {
    lines.push(`Project path: ${story.repoProjectPath}`);
  } else if (story.repoProjectName) {
    lines.push(`Project: ${story.repoProjectName}`);
  }
  if (story.repoConfidence) {
    lines.push(`Repo mapping confidence: ${story.repoConfidence}`);
  }
  if (story.repoEvidence && story.repoEvidence.length > 0) {
    lines.push("Repo mapping evidence:");
    lines.push(...story.repoEvidence.slice(0, 5).map((line) => `- ${line}`));
  }
  return lines;
}

function formatRepoDirectiveLine(story: TriageStory): string {
  return story.repoName
    ? `Repo: ${story.repoName}`
    : "Repo mapping: needs confirmation before implementation";
}

function formatRepoHeaderLines(story: TriageStory): string {
  return [
    formatRepoDirectiveLine(story),
    ...buildRepoResolutionBodyLines(story),
    "",
  ].join("\n");
}

function stripNumberPrefix(value: string): string {
  return value.replace(/^\d+\.\s*/, "");
}

/**
 * True when the story is a code-level (SAST) weakness rather than a vulnerable
 * dependency. Primary signal is source === "wiz-code". The extra guards catch
 * mis-routed stories where a Wiz Code finding fell through to the dependency
 * path: such stories carry a CWE id in the package field (e.g. "CWE-89") and a
 * non-version targetVersion (e.g. "fix code weakness (no dependency change)"),
 * which must never produce dependency-upgrade acceptance criteria.
 */
function isCodeWeaknessStory(story: TriageStory): boolean {
  if (story.source === "wiz-code") {
    return true;
  }
  const pkg = (story.packageName ?? "").trim();
  if (/^cwe-\d+$/i.test(pkg)) {
    return true;
  }
  const target = (story.targetVersion ?? "").toLowerCase();
  if (
    target.includes("no dependency change") ||
    target.includes("code weakness")
  ) {
    return true;
  }
  return false;
}

function buildAcceptanceCriteria(story: TriageStory): string[] {
  if (story.source === "sonar") {
    return [
      "1. All listed SonarQube issue keys are addressed in the reported component files",
      "2. The implementation is limited to the listed rule(s), components, and directly required tests",
      "3. Existing behavior is preserved unless the Sonar rule explicitly identifies a behavior bug",
      "4. Relevant module compile or unit tests pass",
      "5. SonarQube re-scan no longer reports the listed issue keys",
    ];
  }

  // Wiz Code (SAST) / code-level weaknesses: the fix is source code, not a
  // dependency bump. Emitting the dependency-upgrade criteria below for these
  // produces self-contradictory ACs ("upgrade pom.xml" + "no .java changes")
  // that the QUALIFIER rightly blocks.
  if (isCodeWeaknessStory(story)) {
    return [
      "1. Each listed source-code sink is remediated at the code level (e.g. parameterized queries / safe encoding); the specific weakness class is neutralized",
      "2. Runtime values are bound as parameters (never string-concatenated); identifiers that cannot be bound are validated against an allowlist",
      "3. Allowlist validation must match the identifier's real grammar — decompose compound tokens (e.g. `table alias`, `schema.table`, alias-qualified or comma-separated column lists, `col AS alias`) into their component identifiers and validate each part; NEVER validate a whole compound token as one identifier, or existing config-driven values with spaces/dots/aliases will be rejected and silently break the feature",
      "4. Confirm the accepted input shapes: before tightening validation, check the existing config/screendef/DB values that flow into each sink so legitimate production identifiers (aliases, joins, dotted names) still pass; where a value legitimately cannot be a simple identifier and is not attacker-controlled, document it as an accepted concatenation rather than forcing it through the allowlist",
      "5. All sibling sinks of the same weakness class in each touched file are remediated, not only the exact reported line",
      "6. No behavior change for legitimate input; source (.java/other) changes are expected. This is NOT a dependency upgrade — no pom.xml/dependency-tree step applies",
      "7. Tests added proving BOTH that an attack payload is rejected AND that representative real config/production identifiers (including aliased/dotted/multi-token values) still pass and the query returns the expected result",
      "8. Module-scoped build and tests pass (e.g. mvn -pl <module> -am -B test); do not rely on a root -DskipTests build",
      "9. Wiz re-scan confirms the listed findings are cleared",
    ];
  }

  if (story.pathDisposition === "backup-archive") {
    return [
      "1. Backup/archive directories reviewed with owning teams for retention requirements",
      "2. Stale backup/archive directories removed from scanned runtime hosts or moved outside Wiz-scanned runtime paths",
      "3. Any retained archive locations documented with owner and retention reason",
      "4. Wiz re-scan confirms backup/archive findings are cleared or accepted through the approved exception process",
    ];
  }

  if (story.team === "A") {
    if (isLog4j1Story(story)) {
      return [
        "1. Log4j 1.x is removed from the affected project dependency/package output",
        `2. Logging is migrated or bridged to ${story.targetVersion || "a supported Log4j 2.x version"} without leaving log4j:log4j 1.x reachable at runtime`,
        "3. mvn dependency:tree and packaged artifact inspection confirm no log4j-1.x JAR remains",
        "4. Relevant compile/unit tests pass for the affected project",
        "5. Wiz re-scan confirms findings cleared",
      ];
    }

    return [
      `1. All affected pom.xml files upgraded to ${story.targetVersion || "safe replacement"}`,
      "2. mvn dependency:tree -Dincludes=<groupId>:<artifactId> returns empty",
      "3. mvn clean install -DskipTests -Dskip.gwt.compile=true passes",
      "4. No source code (.java) files changed",
      "5. Wiz re-scan confirms findings cleared",
    ];
  }

  if (story.team === "B") {
    return [
      `1. Affected hosts migrated off EOL OS to a supported version`,
      `2. ${story.packageName} no longer present or replaced with supported equivalent`,
      "3. Patch compliance verified via SSM Patch Manager or equivalent tooling",
      "4. Wiz re-scan confirms findings cleared",
    ];
  }

  if (story.team === "C") {
    const pkg = story.packageName;
    const hasFixedVersion =
      story.targetVersion && !story.targetVersion.toLowerCase().includes("eol");
    return [
      `1. ${pkg} patched to ${hasFixedVersion ? story.targetVersion : "latest available secure version"} on all affected hosts`,
      "2. Patching applied via AWS SSM Patch Manager (or equivalent) across all affected assets",
      "3. Patch compliance scan confirms no affected hosts remain",
      "4. Wiz re-scan confirms findings cleared",
    ];
  }

  if (story.team === "D") {
    return [
      `1. ${story.packageName} removed or upgraded to a non-vulnerable version on all affected hosts`,
      "2. Python environment audit confirms no vulnerable package version remains",
      "3. AWS SSM run-command or equivalent used to apply changes at scale",
      "4. Wiz re-scan confirms findings cleared",
    ];
  }

  return ["1. Wiz re-scan confirms findings cleared"];
}

function isLog4j1Story(story: TriageStory): boolean {
  return /^log4j$/i.test(story.packageName);
}
