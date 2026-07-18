/**
 * TRIAGE engine — core orchestration: parse → classify → group → analyze/apply
 *
 * This is the shared core used by both the Harvey /triage command (Phase 1)
 * and the label-poll auto-trigger (Phase 6). All Jira mutations go through
 * jira-writer.ts. The engine is pure logic with no side effects beyond logging.
 */

import { createLogger } from "../../utils/logger.js";
import type { JiraClient } from "../JiraClient.js";
import type { CodeRepository, Database } from "../database.js";
import { getStorage } from "../storage.js";
import { TaskDescriptionGenerator } from "../TaskDescriptionGenerator.js";
import type {
  TriageFinding,
  TriagePathDisposition,
  TriageResult,
  TriageStory,
  TriageOptions,
} from "./types.js";
import {
  isWizCsv,
  parseWizCsvStream,
  parseWizXlsxStream,
} from "./parsers/wiz.js";
import {
  isSonarCsv,
  parseSonarCsv,
  parseSonarCsvStream,
} from "./parsers/sonar.js";
import {
  isWizCodeCsv,
  parseWizCodeCsv,
  parseWizCodeCsvStream,
} from "./parsers/wiz-code.js";
import {
  classifyFinding,
  assignSlaTier,
  type ClassificationResult,
} from "./classifier.js";
import {
  createJiraStory,
  postWhereToUpdateComment,
  setEpicInProgress,
  setEpicReviewReady,
  postTriageAnalysisComment,
  postTriageSummaryComment,
} from "./jira-writer.js";
import { classifyLocationPath } from "./path-disposition.js";
import {
  PFOS_LABEL,
  SONAR_AUTOFIX_LABEL,
  SONAR_LABEL,
} from "../../oneshot/contracts.js";

const logger = createLogger("triage-engine");

const SOURCE_PREFIX: Record<string, string> = {
  wiz: "WIZ",
  // Must equal "wiz-code".toUpperCase() so it matches jira-writer's prefix
  // derivation (source.toUpperCase()) and the poller watches the same label.
  "wiz-code": "WIZ-CODE",
  snyk: "SNYK",
  sonar: "SONAR",
  custom: "CUSTOM",
};

/**
 * Issue-centric sources report one finding per file:line (fix a rule/weakness),
 * as opposed to the Wiz dependency-CVE flow (bump a library version). They share
 * the SonarQube grouping/classification path.
 */
function isIssueCentricSource(source: TriageResult["source"]): boolean {
  return source === "sonar" || source === "wiz-code";
}

const SONAR_AUTOFIX_CODE_SMELL_RULES = new Set([
  "java:S128", // switch fallthrough
  "java:S2178", // bitwise boolean operator
  "java:S3516", // invariant return value
]);

const SONAR_HUMAN_REVIEW_RULES = new Set([
  "java:S2229", // transaction boundary semantics
  "java:S4830", // TLS certificate/trust semantics
]);

const DEFAULT_SONAR_FINDINGS_PER_STORY = 12;

function artifactModeForSource(
  source: TriageResult["source"],
): "wiz" | "sonar" | "wiz_sast" | null {
  // Wiz Code (SAST) reuses the Sonar remediation pipeline internally, but it is
  // surfaced on the dashboard as its own "wiz_sast" mode so SAST scan batches
  // are not mislabeled as SonarQube runs.
  if (source === "wiz-code") {
    return "wiz_sast";
  }
  if (source === "sonar") {
    return "sonar";
  }
  if (source === "wiz" || source === "custom") {
    return "wiz";
  }
  return null;
}

function triageStoryReviewItems(stories: TriageStory[], limit = 12): string[] {
  return stories.slice(0, limit).map((story) => story.title);
}

interface CreatedStoryRef {
  key: string;
  story: TriageStory;
  reused: boolean;
}

function triageTicketRecords(
  refs: CreatedStoryRef[],
  kind: string,
): Array<{ key: string; title: string | null; kind: string; status: string }> {
  return refs.map((ref) => ({
    key: ref.key,
    title: ref.story.title,
    kind,
    status: ref.reused ? "reused" : "created",
  }));
}

function triageTeamATicketRecords(
  refs: CreatedStoryRef[],
): Array<{ key: string; title: string | null; kind: string; status: string }> {
  return refs.map((ref) => ({
    key: ref.key,
    title: ref.story.title,
    kind: ref.story.queueForOneShot === false ? "team-a-review" : "oneshot",
    status: ref.reused ? "reused" : "created",
  }));
}

async function recordTriageArtifactRun(
  db: Database,
  input: {
    epicKey: string;
    epicSummary: string;
    source: TriageResult["source"];
    status: string;
    generatedCount: number;
    generatedTickets: unknown[];
    humanReviewRequired: boolean;
    humanReviewCount: number;
    reviewItems: string[];
    evidence: Record<string, unknown>;
    artifactRefs?: Record<string, unknown>;
    jiraSummary: string;
    completedAt?: Date | string | null;
  },
): Promise<void> {
  const mode = artifactModeForSource(input.source);
  if (!mode) {
    return;
  }

  try {
    await db.upsertOneShotArtifactRun({
      sourceKey: input.epicKey,
      mode,
      status: input.status,
      title: input.epicSummary,
      generatedCount: input.generatedCount,
      generatedTickets: input.generatedTickets,
      humanReviewRequired: input.humanReviewRequired,
      humanReviewCount: input.humanReviewCount,
      reviewItems: input.reviewItems,
      evidence: input.evidence,
      artifactRefs: input.artifactRefs,
      jiraSummary: input.jiraSummary,
      completedAt: input.completedAt,
    });
  } catch (error) {
    logger.warn(
      {
        epicKey: input.epicKey,
        source: input.source,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to record OneShot artifact run",
    );
  }
}

interface ExistingTriageChild {
  key: string;
  summary: string;
}

interface EnsureJiraStoryResult {
  key: string;
  summary: string;
  reused: boolean;
}

async function loadExistingTriageChildrenByTitle(
  jiraClient: JiraClient,
  epicKey: string,
): Promise<Map<string, ExistingTriageChild>> {
  const existing = await jiraClient.searchIssues(
    `parentEpic = ${epicKey} AND statusCategory != Done`,
    "key,summary,labels",
    100,
  );
  const childrenByTitle = new Map<string, ExistingTriageChild>();

  for (const issue of existing.issues) {
    const summary = issue.fields?.summary?.trim();
    if (!summary) continue;
    childrenByTitle.set(summary, { key: issue.key, summary });
  }

  logger.info(
    { epicKey, existingChildren: childrenByTitle.size },
    "Loaded existing TRIAGE child issues for apply resume",
  );

  return childrenByTitle;
}

async function ensureJiraStory(
  jiraClient: JiraClient,
  epicKey: string,
  story: TriageStory,
  existingChildrenByTitle: Map<string, ExistingTriageChild>,
): Promise<EnsureJiraStoryResult> {
  const existing = existingChildrenByTitle.get(story.title.trim());
  if (existing) {
    logger.info(
      { key: existing.key, title: story.title },
      "Reusing existing TRIAGE child story",
    );
    return {
      key: existing.key,
      summary: existing.summary,
      reused: true,
    };
  }

  const result = await createJiraStory(jiraClient, epicKey, story);
  existingChildrenByTitle.set(story.title.trim(), {
    key: result.key,
    summary: result.summary,
  });

  return {
    ...result,
    reused: false,
  };
}

function formatFailedStoryItem(story: TriageStory, err: unknown): string {
  const error = err instanceof Error ? err.message : String(err);
  return `${story.title} failed during Jira story creation: ${error}`;
}

export async function resolveRelatedCodeForStory(
  db: Pick<Database, "getAllRepositories" | "upsertCodeRepository">,
  story: TriageStory,
): Promise<string> {
  if (process.env.TRIAGE_DIRECT_REPO_ROUTING_ENABLED === "false") {
    return "";
  }

  if (
    story.team !== "A" ||
    story.repoConfidence !== "high" ||
    story.queueForOneShot === false
  ) {
    return "";
  }

  try {
    const repositories = await db.getAllRepositories();
    const repo = findRepositoryForStory(story, repositories);
    if (repo) return String(repo.id);

    if (story.repoFullName) {
      const created = await db.upsertCodeRepository({
        repoName: story.repoName,
        repoUrl: `https://github.com/${story.repoFullName}.git`,
        description: buildCatalogRepoDescription(story),
        defaultBranch: story.repoDefaultBranch ?? "main",
      });
      return String(created.id);
    }

    return "";
  } catch (error) {
    logger.warn(
      {
        repoName: story.repoName,
        repoFullName: story.repoFullName,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to resolve TRIAGE story repo to related_code",
    );
    return "";
  }
}

export function shouldQueueLog4j1ForOneShot(): boolean {
  return process.env.TRIAGE_LOG4J1_ONESHOT_QUEUE_ENABLED !== "false";
}

function buildCatalogRepoDescription(story: TriageStory): string {
  const projectHint = story.repoProjectPath
    ? ` project ${story.repoProjectPath}`
    : story.repoProjectName
      ? ` project ${story.repoProjectName}`
      : "";
  return `Discovered by TRIAGE GitHub project catalog for${projectHint} security remediation`;
}

function findRepositoryForStory(
  story: TriageStory,
  repositories: CodeRepository[],
): CodeRepository | undefined {
  const hints = [
    story.repoName,
    story.repoFullName,
    story.repoFullName?.split("/").pop(),
  ]
    .filter((value): value is string => !!value)
    .map(normalizeRepoComparable);

  for (const repo of repositories) {
    const repoValues = [
      repo.repo_name,
      repo.repo_url,
      getRepoSlug(repo.repo_url),
      getOwnerRepo(repo.repo_url),
    ]
      .filter((value): value is string => !!value)
      .map(normalizeRepoComparable);

    if (repoValues.some((value) => hints.includes(value))) {
      return repo;
    }
  }

  return undefined;
}

function getRepoSlug(repoUrl: string): string | undefined {
  return repoUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .pop();
}

function getOwnerRepo(repoUrl: string): string | undefined {
  const normalized = repoUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const match = normalized.match(/github\.com[:/]([^/]+\/[^/]+)$/i);
  return match?.[1];
}

function normalizeRepoComparable(value: string): string {
  return value
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

export async function runTriage(
  jiraClient: JiraClient,
  db: Database,
  options: TriageOptions,
): Promise<TriageResult> {
  const { epicKey, dryRun = false, force = false, mode = "analyze" } = options;

  logger.info({ epicKey, dryRun, force, mode }, "TRIAGE starting");

  // ── Step 1: Fetch EPIC and find CSV attachment ──────────────────────────
  const epic = await jiraClient.fetchIssue(epicKey);
  const csvAttachment = findCsvAttachment(epic.fields.attachment ?? []);

  if (!csvAttachment) {
    const msg = `No CSV attachment found on ${epicKey}. Attach the Wiz scan CSV and add label WIZ-SCAN-PENDING to trigger TRIAGE.`;
    await jiraClient.addComment(epicKey, `[TRIAGE] ERROR: ${msg}`);
    throw new Error(msg);
  }

  // ── Step 3: Detect source type from filename/headers ───────────────────
  // We need the source type to choose the right parser, but we also need to
  // avoid reading the full ~1 GB body just for detection. Use the filename
  // first; only sniff headers if the filename is ambiguous.
  const filename = csvAttachment.filename ?? "";
  // detectedSource may be "custom" for ambiguous filenames; effectiveSource is
  // normalised to "wiz" after a successful Wiz parse so that labels, prefix,
  // and the report all use WIZ-SCAN-* consistently. Without this, WIZ-SCAN-PENDING
  // would stay on the EPIC (poller watches that label) and the report would
  // remove CUSTOM-SCAN-IN-PROGRESS instead of WIZ-SCAN-IN-PROGRESS.
  const detectedSource =
    options.sourceOverride ?? detectSourceFromFilename(filename);

  // Defer computing effectiveSource / sourcePrefix until after parsing so that
  // a successful "custom" parse can be promoted to "wiz".
  let effectiveSource = detectedSource;

  logger.info(
    { detectedSource, attachmentId: csvAttachment.id, filename },
    "Starting CSV download and parse",
  );

  // ── Step 4: Parse attachment — CSV (stream) or xlsx (buffer) ─────────────
  const isXlsx =
    filename.toLowerCase().endsWith(".xlsx") ||
    filename.toLowerCase().endsWith(".xls");

  const attachmentStream = await jiraClient.downloadAttachmentStream(
    csvAttachment.id,
  );

  let totalRows = 0;
  let uniqueFindings = 0;
  let skippedRows = 0;
  let findings: TriageFinding[] = [];

  // Sniff the header for CSVs whose filename resolved to "custom" (ambiguous,
  // e.g. "Report_*.csv") OR "wiz" (filename starts with wiz/all_cp_vuln/mhk).
  // The filename-only detector cannot tell a Wiz dependency-CVE export from a
  // Wiz Code (SAST) export when both carry a "wiz"-family name, so a SAST scan
  // named e.g. "wiz_findings.csv" would otherwise be force-parsed as a
  // dependency CVE — producing corrupted stories (CWE id in the package field)
  // and self-contradictory dependency-bump acceptance criteria (CPDEV-26167).
  // peekHeaderLine reads only the first line, so a large dependency export is
  // never fully buffered; a non-SAST header falls through to the streaming Wiz
  // path below.
  if ((detectedSource === "custom" || detectedSource === "wiz") && !isXlsx) {
    const { headerLine, consumed, reader, decoder } =
      await peekHeaderLine(attachmentStream);

    if (isWizCodeCsv(headerLine) || isSonarCsv(headerLine)) {
      // Issue-centric SAST / Sonar exports are small: drain the rest of the
      // already-open stream and parse from text (no second download).
      const text = await drainRemainder(consumed, reader, decoder);
      const isWizCode = isWizCodeCsv(headerLine);
      const parsed = isWizCode ? parseWizCodeCsv(text) : parseSonarCsv(text);
      findings = parsed.findings;
      totalRows = parsed.totalRows;
      uniqueFindings = parsed.findings.length;
      skippedRows = parsed.skippedRows;
      effectiveSource = isWizCode ? "wiz-code" : "sonar";
    } else {
      // Wiz dependency-CVE (or unknown): can be ~1 GB, so discard this peeked
      // stream and re-download to stream through the memory-safe Wiz parser.
      await reader.cancel().catch(() => undefined);
      const freshStream = await jiraClient.downloadAttachmentStream(
        csvAttachment.id,
      );
      const parsed = await parseWizCsvStream(freshStream);
      findings = parsed.findings;
      totalRows = parsed.totalRows;
      uniqueFindings = parsed.findings.length;
      skippedRows = parsed.skippedRows;
      effectiveSource = "wiz";
    }
  } else if (detectedSource === "wiz" || detectedSource === "custom") {
    const parsed = isXlsx
      ? await parseWizXlsxStream(attachmentStream)
      : await parseWizCsvStream(attachmentStream);
    findings = parsed.findings;
    totalRows = parsed.totalRows;
    uniqueFindings = parsed.findings.length;
    skippedRows = parsed.skippedRows;
    // Promote ambiguous filenames that successfully parsed as Wiz to "wiz"
    // so that WIZ-SCAN-* labels and the poller stay consistent.
    if (detectedSource === "custom") effectiveSource = "wiz";
  } else if (detectedSource === "sonar") {
    if (isXlsx) {
      throw new Error("SonarQube TRIAGE currently supports CSV exports only.");
    }
    const parsed = await parseSonarCsvStream(attachmentStream);
    findings = parsed.findings;
    totalRows = parsed.totalRows;
    uniqueFindings = parsed.findings.length;
    skippedRows = parsed.skippedRows;
  } else if (detectedSource === "wiz-code") {
    if (isXlsx) {
      throw new Error("Wiz Code TRIAGE currently supports CSV exports only.");
    }
    const parsed = await parseWizCodeCsvStream(attachmentStream);
    findings = parsed.findings;
    totalRows = parsed.totalRows;
    uniqueFindings = parsed.findings.length;
    skippedRows = parsed.skippedRows;
  } else {
    throw new Error(
      `Source "${detectedSource}" parser not yet implemented in v1. ` +
        `Use "wiz", "all_cp_vuln", or "sonar" filename prefixes for auto-detection.`,
    );
  }

  const sourcePrefix = SOURCE_PREFIX[effectiveSource] ?? "WIZ";

  logger.info(
    { effectiveSource, sourcePrefix, totalRows, uniqueFindings },
    "CSV parsed",
  );

  // ── Step 4: Classify findings ──────────────────────────────────────────
  const teamAFindings: TriageFinding[] = [];
  const teamBFindings: TriageFinding[] = [];
  const teamCFindings: TriageFinding[] = [];
  const teamDFindings: TriageFinding[] = [];
  const unknownFindings: TriageFinding[] = [];
  const backupArchiveFindings: TriageFinding[] = [];
  const reviewNeededFindings: TriageFinding[] = [];
  let skippedNonMaven = 0;
  const suppressedByDisposition = createSuppressionCounters();
  let needsReviewFindings = 0;

  for (const finding of findings) {
    const classification = isIssueCentricSource(effectiveSource)
      ? effectiveSource === "wiz-code"
        ? classifyWizCodeFinding(finding)
        : classifySonarFinding(finding)
      : classifyFinding(finding);
    const { team, pfosNotQualified, shouldCreateTicket, pathDisposition } =
      classification;
    if (pfosNotQualified) {
      skippedNonMaven++;
      suppressedByDisposition["non-maven"]++;
      continue; // pip/Gradle — skip in v1
    }
    if (!shouldCreateTicket) {
      suppressedByDisposition[pathDisposition]++;
      if (pathDisposition === "backup-archive") {
        backupArchiveFindings.push(finding);
      }
      if (pathDisposition === "needs-review") {
        needsReviewFindings++;
        reviewNeededFindings.push(finding);
      }
      continue;
    }
    switch (team) {
      case "A":
        teamAFindings.push(finding);
        break;
      case "B":
        teamBFindings.push(finding);
        break;
      case "C":
        teamCFindings.push(finding);
        break;
      case "D":
        teamDFindings.push(finding);
        break;
      default:
        unknownFindings.push(finding);
        break;
    }
  }

  logger.info(
    {
      A: teamAFindings.length,
      B: teamBFindings.length,
      C: teamCFindings.length,
      D: teamDFindings.length,
      unknown: unknownFindings.length,
      skippedNonMaven,
      suppressedByDisposition,
      needsReviewFindings,
      backupArchive: backupArchiveFindings.length,
      reviewNeeded: reviewNeededFindings.length,
    },
    "TRIAGE classification complete",
  );

  // ── Step 5: Group findings into actionable ticket candidates ───────────
  const teamAStories =
    effectiveSource === "wiz-code"
      ? groupWizCodeStories(teamAFindings, epicKey)
      : effectiveSource === "sonar"
        ? groupSonarStories(teamAFindings, epicKey)
        : groupIntoStories(teamAFindings, epicKey);
  const teamBCDStories: TriageStory[] = isIssueCentricSource(effectiveSource)
    ? []
    : [
        ...groupInfraStories(teamBFindings, epicKey, "B"),
        ...groupInfraStories(teamCFindings, epicKey, "C"),
        ...groupInfraStories(teamDFindings, epicKey, "D"),
      ];
  const backupCleanupStories = groupBackupCleanupStories(
    backupArchiveFindings,
    epicKey,
  );
  const reviewNeededStories = isIssueCentricSource(effectiveSource)
    ? groupSonarReviewNeededStories(reviewNeededFindings, epicKey)
    : groupReviewNeededStories(reviewNeededFindings, epicKey);

  // ── Step 6: Flip EPIC label & create stories ────────────────────────────
  const createdTeamAKeys: string[] = [];
  const queuedTeamAKeys: string[] = [];
  const createdTeamBCDKeys: string[] = [];
  const createdBackupCleanupKeys: string[] = [];
  const createdTeamARefs: CreatedStoryRef[] = [];
  const createdTeamBCDRefs: CreatedStoryRef[] = [];
  const createdBackupCleanupRefs: CreatedStoryRef[] = [];
  const failedStoryItems: string[] = [];
  const storyCandidateCount =
    teamAStories.length + teamBCDStories.length + backupCleanupStories.length;

  if (mode === "analyze" || dryRun) {
    if (!dryRun) {
      // Posting the analysis comment must never block the run: if it fails
      // (e.g. oversized comment), the label still has to advance to
      // REVIEW-READY, otherwise the poller re-triages the same epic forever.
      try {
        await postTriageAnalysisComment(jiraClient, epicKey, {
          source: effectiveSource,
          totalRows,
          uniqueFindings,
          teamAStories,
          teamBCDStories,
          backupCleanupStories,
          reviewNeededStories,
          suppressedByDisposition,
          needsReviewFindings,
          dryRun,
        });
      } catch (err) {
        logger.error(
          {
            epicKey,
            error: err instanceof Error ? err.message : String(err),
          },
          "Failed to post TRIAGE analysis comment; advancing label anyway",
        );
      }
      await setEpicReviewReady(jiraClient, epicKey, sourcePrefix);
    }

    if (!dryRun) {
      await recordTriageArtifactRun(db, {
        epicKey,
        epicSummary: epic.fields.summary ?? epicKey,
        source: effectiveSource,
        status: "review_ready",
        generatedCount: storyCandidateCount,
        generatedTickets: [],
        humanReviewRequired: true,
        humanReviewCount: reviewNeededStories.length,
        reviewItems: [
          `Add ${sourcePrefix}-SCAN-APPROVED after grouped analysis is approved for ticket creation.`,
          ...triageStoryReviewItems(reviewNeededStories),
        ],
        evidence: {
          mode,
          totalRows,
          uniqueFindings,
          skippedRows,
          teamAStoryCandidates: teamAStories.length,
          teamBCDStoryCandidates: teamBCDStories.length,
          backupCleanupStoryCandidates: backupCleanupStories.length,
          reviewNeededStoryCandidates: reviewNeededStories.length,
          suppressedFindings: Object.values(suppressedByDisposition).reduce(
            (sum, count) => sum + count,
            0,
          ),
          needsReviewFindings,
          skippedNonMaven,
        },
        artifactRefs: {
          attachmentFilename: filename,
          sourcePrefix,
        },
        jiraSummary: `${sourcePrefix} analysis complete for ${epicKey}; ${storyCandidateCount} ticket candidate(s), ${reviewNeededStories.length} held for human review.`,
      });
    }

    return {
      epicKey,
      source: effectiveSource,
      mode,
      storiesCreated: 0,
      teamAStories: [],
      teamBCDStories: [],
      backupCleanupStories: [],
      reviewNeededStories: [],
      teamAStoryCandidates: teamAStories.length,
      teamBCDStoryCandidates: teamBCDStories.length,
      backupCleanupStoryCandidates: backupCleanupStories.length,
      reviewNeededStoryCandidates: reviewNeededStories.length,
      suppressedFindings: Object.values(suppressedByDisposition).reduce(
        (sum, count) => sum + count,
        0,
      ),
      needsReviewFindings,
      skippedNonMaven,
      dryRun,
    };
  }

  const maxCreateStories = parseInt(
    process.env.TRIAGE_MAX_CREATE_STORIES ?? "50",
    10,
  );
  if (!force && storyCandidateCount > maxCreateStories) {
    const msg =
      `TRIAGE apply blocked: ${storyCandidateCount} ticket candidates exceeds ` +
      `TRIAGE_MAX_CREATE_STORIES=${maxCreateStories}. Review the EPIC analysis ` +
      `and rerun with --force only if the grouped ticket set is expected.`;
    await jiraClient.addComment(epicKey, `[TRIAGE] BLOCKED: ${msg}`);
    throw new Error(msg);
  }

  if (!dryRun) {
    await setEpicInProgress(jiraClient, epicKey, sourcePrefix);

    // Get QUALIFIER agent_id for task_management insertion
    const qualifierAgent = await db.getAgentByName("QUALIFIER");
    if (!qualifierAgent) {
      throw new Error(
        "QUALIFIER agent not found in agents table. Ensure the DB seed is applied.",
      );
    }

    // Get customer_id from EPIC's project (use default customer for the project)
    const customerId = await resolveCustomerId(db, epicKey);

    // Set up storage and task description generator for S3 upload
    const storage = getStorage();
    const taskDescGenerator = new TaskDescriptionGenerator({
      jiraBaseUrl: process.env.JIRA_BASE_URL ?? "",
      jiraUsername: process.env.JIRA_EMAIL ?? "",
      jiraToken: process.env.JIRA_API_TOKEN ?? "",
      awsRegion: process.env.AWS_REGION ?? "us-east-2",
    });
    const existingChildrenByTitle = await loadExistingTriageChildrenByTitle(
      jiraClient,
      epicKey,
    );

    // Create Team A stories
    for (const story of teamAStories) {
      let result: EnsureJiraStoryResult;
      try {
        result = await ensureJiraStory(
          jiraClient,
          epicKey,
          story,
          existingChildrenByTitle,
        );
      } catch (err) {
        failedStoryItems.push(formatFailedStoryItem(story, err));
        continue;
      }
      createdTeamAKeys.push(result.key);
      createdTeamARefs.push({ key: result.key, story, reused: result.reused });
      if (!result.reused) {
        try {
          await postWhereToUpdateComment(jiraClient, result.key, story);
        } catch (err) {
          logger.warn(
            {
              key: result.key,
              error: err instanceof Error ? err.message : String(err),
            },
            "Failed to post Team A where-to-update comment",
          );
        }
      }

      if (story.queueForOneShot === false) {
        logger.info(
          {
            key: result.key,
            reason: story.queueBlockedReason,
          },
          "Team A story created without OneShot queueing",
        );
        continue;
      }

      // Generate task description and upload to S3 — required by planner consumer
      // (planner throws if task_s3_bucket / task_s3_key are missing)
      let taskS3Bucket: string | undefined;
      let taskS3Key: string | undefined;
      try {
        const freshIssue = await jiraClient.fetchIssue(result.key);
        // Cast to BasicJiraIssue — JiraIssue has all required fields at runtime
        // but the type has some optional where BasicJiraIssue requires them.
        const taskDescription = await taskDescGenerator.generateTaskDescription(
          freshIssue as any,
        );
        const uploaded = await storage.uploadTaskDescription(
          result.key,
          taskDescription,
        );
        taskS3Bucket = uploaded.bucket;
        taskS3Key = uploaded.key;
      } catch (uploadErr) {
        logger.warn(
          {
            key: result.key,
            error:
              uploadErr instanceof Error
                ? uploadErr.message
                : String(uploadErr),
          },
          "Failed to generate/upload task description — falling back to story description",
        );
        try {
          // Fallback: upload the story description so planner has something to work with.
          const fallback = await storage.uploadTaskDescription(
            result.key,
            story.description,
          );
          taskS3Bucket = fallback.bucket;
          taskS3Key = fallback.key;
        } catch (fallbackErr) {
          failedStoryItems.push(
            `${result.key} was created/reused but failed OneShot task description upload: ${
              fallbackErr instanceof Error
                ? fallbackErr.message
                : String(fallbackErr)
            }`,
          );
          continue;
        }
      }

      try {
        const relatedCode = await resolveRelatedCodeForStory(db, story);

        // Insert into task_management so QUALIFIER picks it up. The DB layer
        // returns the existing row id when jira_number + agent_id already
        // exists, so resumed TRIAGE applies do not create duplicate queue rows.
        await db.createTaskManagement({
          jira_number: result.key,
          customer_id: customerId,
          agent_id: qualifierAgent.id,
          related_code: relatedCode,
          task_type: "oneshot_planning",
          task_s3_bucket: taskS3Bucket,
          task_s3_key: taskS3Key,
          source: "jira",
          status: "assigned",
        });
        queuedTeamAKeys.push(result.key);

        logger.info(
          { key: result.key, taskS3Key, relatedCode, reused: result.reused },
          "Team A story ready and queued",
        );
      } catch (err) {
        failedStoryItems.push(
          `${result.key} was created/reused but failed OneShot queueing: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        logger.error(
          {
            key: result.key,
            error: err instanceof Error ? err.message : String(err),
          },
          "Failed to queue Team A story for OneShot",
        );
      }
    }

    // Create Team B/C/D stories (no task_management — human execution)
    for (const story of teamBCDStories) {
      try {
        const result = await ensureJiraStory(
          jiraClient,
          epicKey,
          story,
          existingChildrenByTitle,
        );
        createdTeamBCDKeys.push(result.key);
        createdTeamBCDRefs.push({
          key: result.key,
          story,
          reused: result.reused,
        });
      } catch (err) {
        failedStoryItems.push(formatFailedStoryItem(story, err));
      }
    }

    // Create one consolidated backup/archive cleanup story for DevOps.
    for (const story of backupCleanupStories) {
      try {
        const result = await ensureJiraStory(
          jiraClient,
          epicKey,
          story,
          existingChildrenByTitle,
        );
        createdBackupCleanupKeys.push(result.key);
        createdBackupCleanupRefs.push({
          key: result.key,
          story,
          reused: result.reused,
        });
      } catch (err) {
        failedStoryItems.push(formatFailedStoryItem(story, err));
      }
    }

    // Post summary comment on EPIC. Must not block: stories are already
    // created, so a comment failure cannot be allowed to skip the artifact-run
    // recording and label progression below.
    try {
      await postTriageSummaryComment(jiraClient, epicKey, {
        source: effectiveSource,
        totalRows,
        uniqueFindings,
        teamAStories: createdTeamAKeys,
        teamBCDStories: createdTeamBCDKeys,
        backupCleanupStories: createdBackupCleanupKeys,
        reviewNeededStories: failedStoryItems,
        skippedNonMaven,
        dryRun: false,
      });
    } catch (err) {
      logger.error(
        {
          epicKey,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to post TRIAGE summary comment; continuing with artifact recording",
      );
    }

    const generatedTickets = [
      ...triageTeamATicketRecords(createdTeamARefs),
      ...triageTicketRecords(createdTeamBCDRefs, "manual"),
      ...triageTicketRecords(createdBackupCleanupRefs, "backup-cleanup"),
    ];
    const manualReviewCount =
      createdTeamAKeys.length -
      queuedTeamAKeys.length +
      createdTeamBCDKeys.length +
      createdBackupCleanupKeys.length +
      reviewNeededStories.length +
      failedStoryItems.length;
    await recordTriageArtifactRun(db, {
      epicKey,
      epicSummary: epic.fields.summary ?? epicKey,
      source: effectiveSource,
      status: queuedTeamAKeys.length > 0 ? "in_progress" : "manual_review",
      generatedCount: generatedTickets.length,
      generatedTickets,
      humanReviewRequired: manualReviewCount > 0,
      humanReviewCount: manualReviewCount,
      reviewItems: [
        ...createdTeamAKeys
          .filter((key) => !queuedTeamAKeys.includes(key))
          .map((key) => `${key} requires approval before OneShot queueing.`),
        ...createdTeamBCDKeys.map((key) => `${key} requires manual execution.`),
        ...createdBackupCleanupKeys.map(
          (key) => `${key} requires backup/archive cleanup review.`,
        ),
        ...triageStoryReviewItems(reviewNeededStories),
        ...failedStoryItems,
      ],
      evidence: {
        mode,
        totalRows,
        uniqueFindings,
        skippedRows,
        teamAStoriesCreated: createdTeamAKeys.length,
        teamAStoriesQueuedForOneShot: queuedTeamAKeys.length,
        teamBCDStoriesCreated: createdTeamBCDKeys.length,
        backupCleanupStoriesCreated: createdBackupCleanupKeys.length,
        storyFailures: failedStoryItems.length,
        reviewNeededStoryCandidates: reviewNeededStories.length,
        skippedNonMaven,
      },
      artifactRefs: {
        attachmentFilename: filename,
        sourcePrefix,
      },
      jiraSummary: `${sourcePrefix} apply complete for ${epicKey}; ${generatedTickets.length} ticket(s) created/reused, ${queuedTeamAKeys.length} queued for OneShot, ${failedStoryItems.length} failed.`,
      completedAt: new Date(),
    });
  } else {
    // Dry run — just post what would be created
    await postTriageSummaryComment(jiraClient, epicKey, {
      source: effectiveSource,
      totalRows,
      uniqueFindings,
      teamAStories: teamAStories.map((s) => `[DRY RUN] ${s.title}`),
      teamBCDStories: teamBCDStories.map((s) => `[DRY RUN] ${s.title}`),
      backupCleanupStories: backupCleanupStories.map(
        (s) => `[DRY RUN] ${s.title}`,
      ),
      reviewNeededStories: reviewNeededStories.map(
        (s) => `[DRY RUN] ${s.title}`,
      ),
      skippedNonMaven,
      dryRun: true,
    });
  }

  return {
    epicKey,
    source: effectiveSource,
    mode,
    storiesCreated:
      createdTeamAKeys.length +
      createdTeamBCDKeys.length +
      createdBackupCleanupKeys.length,
    teamAStories: createdTeamAKeys,
    teamBCDStories: createdTeamBCDKeys,
    backupCleanupStories: createdBackupCleanupKeys,
    reviewNeededStories: failedStoryItems,
    teamAStoryCandidates: teamAStories.length,
    teamBCDStoryCandidates: teamBCDStories.length,
    backupCleanupStoryCandidates: backupCleanupStories.length,
    reviewNeededStoryCandidates: reviewNeededStories.length,
    suppressedFindings: Object.values(suppressedByDisposition).reduce(
      (sum, count) => sum + count,
      0,
    ),
    needsReviewFindings,
    skippedNonMaven,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Grouping helpers
// ---------------------------------------------------------------------------

function classifySonarFinding(finding: TriageFinding): ClassificationResult {
  const issueType = (finding.issueType ?? "").toUpperCase();
  const severity = (finding.severity ?? "").toUpperCase();
  const ruleId = finding.ruleId ?? finding.packageName;

  if (SONAR_HUMAN_REVIEW_RULES.has(ruleId)) {
    return {
      team: "UNKNOWN",
      reason: `SonarQube rule requires human review: ${ruleId}`,
      isPfos: false,
      pfosNotQualified: false,
      shouldCreateTicket: false,
      pathDisposition: "needs-review",
    };
  }

  if (issueType === "VULNERABILITY") {
    return {
      team: "A",
      reason: `SonarQube vulnerability: ${ruleId}`,
      isPfos: false,
      pfosNotQualified: false,
      shouldCreateTicket: true,
      pathDisposition: "active-code-managed",
    };
  }

  if (
    issueType === "BUG" &&
    (severity === "BLOCKER" || severity === "CRITICAL")
  ) {
    return {
      team: "A",
      reason: `SonarQube ${severity.toLowerCase()} bug: ${ruleId}`,
      isPfos: false,
      pfosNotQualified: false,
      shouldCreateTicket: true,
      pathDisposition: "active-code-managed",
    };
  }

  if (
    issueType === "CODE_SMELL" &&
    severity === "BLOCKER" &&
    SONAR_AUTOFIX_CODE_SMELL_RULES.has(ruleId)
  ) {
    return {
      team: "A",
      reason: `SonarQube allowlisted blocker code smell: ${ruleId}`,
      isPfos: false,
      pfosNotQualified: false,
      shouldCreateTicket: true,
      pathDisposition: "active-code-managed",
    };
  }

  return {
    team: "UNKNOWN",
    reason: `SonarQube finding held for human review: ${issueType} ${severity} ${ruleId}`,
    isPfos: false,
    pfosNotQualified: false,
    shouldCreateTicket: false,
    pathDisposition: "needs-review",
  };
}

/**
 * Classify a Wiz Code (SAST) finding. Every weakness is a code-logic issue, so
 * all findings become Team A stories that are pushed into OneShot via PFOS
 * (see groupWizCodeStories).
 */
function classifyWizCodeFinding(finding: TriageFinding): ClassificationResult {
  return {
    team: "A",
    reason: `Wiz Code (SAST) weakness: ${finding.ruleId ?? finding.packageName}`,
    isPfos: false,
    pfosNotQualified: false,
    shouldCreateTicket: true,
    pathDisposition: "active-code-managed",
  };
}

/**
 * Group Wiz Code (SAST) findings into stories by repo × module × weakness.
 * Groups like Sonar (repo × module × CWE) and emits a OneShot-format CPDEV
 * description. Stories are marked isPfos/queueForOneShot=true so they are
 * pushed into the OneShot pipeline via PFOS, the same as Wiz-CVE stories.
 */
export function groupWizCodeStories(
  findings: TriageFinding[],
  epicKey: string,
): TriageStory[] {
  const maxFindingsPerStory = Math.max(
    1,
    parseInt(
      process.env.TRIAGE_SONAR_MAX_FINDINGS_PER_STORY ??
        String(DEFAULT_SONAR_FINDINGS_PER_STORY),
      10,
    ),
  );
  const groups = new Map<
    string,
    {
      repoName: string;
      moduleName: string;
      cwe: string;
      branch: string;
      findings: TriageFinding[];
    }
  >();

  for (const finding of findings) {
    const repoName = inferSonarRepoName(finding);
    const moduleName = inferSonarModule(finding);
    const cwe = finding.ruleId ?? finding.packageName;
    // Branch must be part of the grouping key: the same CWE in the same module
    // can appear on different branches (e.g. master vs feature/x), and each
    // remediation targets a specific branch. Grouping without branch would
    // create one PFOS story spanning both, and OneShot could plan/implement
    // against the wrong branch.
    const branch = wizCodeBranch(finding);
    const key = JSON.stringify([repoName, moduleName, cwe, branch]);
    const group = groups.get(key) ?? {
      repoName,
      moduleName,
      cwe,
      branch,
      findings: [],
    };
    group.findings.push(finding);
    groups.set(key, group);
  }

  const stories: TriageStory[] = [];
  for (const {
    repoName,
    moduleName,
    cwe,
    branch,
    findings: group,
  } of groups.values()) {
    const sortedGroup = [...group].sort(compareSonarFindings);
    const chunks = chunkFindings(sortedGroup, maxFindingsPerStory);

    chunks.forEach((chunk, index) => {
      const suffix =
        chunks.length > 1 ? ` — ${index + 1}/${chunks.length}` : "";
      const severity = chooseHighestSeverity(chunk);
      const weaknessLabel = chunk[0]?.remediation || cwe;
      // Only surface the branch in the title when it is not the default, to
      // keep the common case readable while disambiguating feature branches.
      const branchLabel =
        branch && branch !== "master" && branch !== "main"
          ? ` (${branch})`
          : "";

      stories.push({
        source: "wiz-code",
        title: `[Wiz Code] ${cwe} — ${moduleName}${branchLabel}${suffix} — ${repoName} (Epic: ${epicKey})`,
        description: buildWizCodeDescription(
          epicKey,
          chunk,
          repoName,
          moduleName,
          cwe,
          weaknessLabel,
          branch,
        ),
        team: "A",
        severity,
        slaTier: chooseHighestSlaTier(chunk),
        cveIds: chunk.map((finding) => finding.findingKey ?? finding.cveId),
        findingKeys: chunk.map(
          (finding) => finding.findingKey ?? finding.cveId,
        ),
        ruleIds: [cwe],
        issueTypes: ["VULNERABILITY"],
        packageName: cwe,
        targetVersion: "fix code weakness (no dependency change)",
        repoName,
        // Carry the branch so OneShot branch resolution targets the branch the
        // finding was reported on, not just the repo default.
        repoDefaultBranch: branch || undefined,
        applicationRoot: moduleName,
        pathDisposition: "active-code-managed",
        whereToUpdate: buildSonarWhereToUpdate(chunk),
        findingCount: chunk.reduce((sum, finding) => sum + finding.rawCount, 0),
        assetCount: chunk.length,
        // Wiz Code (SAST) stories are pushed into OneShot like CVE stories:
        // isPfos=true stamps the PFOS label and queueForOneShot=true creates the
        // task_management row so QUALIFIER picks them up.
        isPfos: true,
        queueForOneShot: true,
      });
    });
  }

  return stories;
}

/**
 * Build a OneShot-format CPDEV story description for a Wiz Code (SAST) group,
 * matching the CPDEV template: Summary, Overview, Acceptance Criteria,
 * Technical Details (Repo/Branch/paths), Out of Scope, Testing Notes.
 */
function buildWizCodeDescription(
  epicKey: string,
  findings: TriageFinding[],
  repoName: string,
  moduleName: string,
  cwe: string,
  weaknessLabel: string,
  branch: string,
): string {
  const totalFindings = findings.reduce((sum, f) => sum + f.rawCount, 0);
  const branchLabel = branch || "default branch";
  const language =
    (findings[0] as { language?: string })?.language || "the affected language";

  return [
    "Summary",
    `Fix ${cwe} (${weaknessLabel}) in ${moduleName} — ${repoName}.`,
    "",
    "Overview",
    `Wiz Code Analysis (SAST) reported ${totalFindings.toLocaleString()} ${cwe} weakness(es) in ${moduleName}. ` +
      `This is a code-logic security fix (not a dependency version change): remediate each reported ${language} location so the weakness is no longer exploitable, without changing adjacent behavior.`,
    "",
    "Acceptance Criteria",
    `- All listed ${cwe} findings are remediated in the reported files and lines.`,
    "- The fix follows the standard remediation for this weakness (e.g. parameterized queries for CWE-89 SQL injection; secure parser configuration disabling external entities for CWE-611 XXE).",
    "- Existing behavior for the affected code paths remains unchanged aside from the security fix.",
    "- Relevant module compile and unit tests pass; tests are added or updated to cover the fixed behavior.",
    "- A Wiz Code re-scan no longer reports the listed findings.",
    "",
    "Technical Details",
    `Epic: ${epicKey}`,
    `Source: Wiz Code Analysis (SAST)`,
    `Repo: ${repoName}`,
    `Branch: ${branchLabel}`,
    `Module/root: ${moduleName}`,
    `Weakness (CWE): ${cwe}`,
    `Language: ${language}`,
    `Findings: ${totalFindings.toLocaleString()}`,
    "",
    "Where to Update",
    buildSonarWhereToUpdate(findings),
    "",
    "Out of Scope",
    "- Do not remediate unrelated weaknesses, rules, or files not listed in this story.",
    "- Do not perform broad refactors or dependency upgrades; this is a targeted code-logic fix.",
    "",
    "Testing Notes",
    "- Run the relevant module compile and unit test command for the affected project.",
    "- Add or update tests that exercise the fixed code path (e.g. malicious input is safely handled).",
    "- Confirm the next Wiz Code scan clears the listed findings.",
  ].join("\n");
}

function groupSonarStories(
  findings: TriageFinding[],
  epicKey: string,
): TriageStory[] {
  const maxFindingsPerStory = Math.max(
    1,
    parseInt(
      process.env.TRIAGE_SONAR_MAX_FINDINGS_PER_STORY ??
        String(DEFAULT_SONAR_FINDINGS_PER_STORY),
      10,
    ),
  );
  const groups = new Map<
    string,
    {
      repoName: string;
      moduleName: string;
      ruleId: string;
      findings: TriageFinding[];
    }
  >();

  for (const finding of findings) {
    const repoName = inferSonarRepoName(finding);
    const moduleName = inferSonarModule(finding);
    const ruleId = finding.ruleId ?? finding.packageName;
    const key = JSON.stringify([repoName, moduleName, ruleId]);
    const group = groups.get(key) ?? {
      repoName,
      moduleName,
      ruleId,
      findings: [],
    };
    group.findings.push(finding);
    groups.set(key, group);
  }

  const stories: TriageStory[] = [];
  for (const {
    repoName,
    moduleName,
    ruleId,
    findings: group,
  } of groups.values()) {
    const sortedGroup = [...group].sort(compareSonarFindings);
    const chunks = chunkFindings(sortedGroup, maxFindingsPerStory);

    chunks.forEach((chunk, index) => {
      const suffix =
        chunks.length > 1 ? ` — ${index + 1}/${chunks.length}` : "";
      const severity = chooseHighestSeverity(chunk);
      const issueTypes = [
        ...new Set(chunk.map((finding) => finding.issueType ?? "UNKNOWN")),
      ].sort();

      stories.push({
        source: "sonar",
        title: `[SonarQube] ${ruleId} — ${moduleName}${suffix} — ${repoName} (Epic: ${epicKey})`,
        description: buildSonarDescription(
          epicKey,
          chunk,
          repoName,
          moduleName,
        ),
        team: "A",
        severity,
        slaTier: chooseHighestSlaTier(chunk),
        cveIds: chunk.map((finding) => finding.findingKey ?? finding.cveId),
        findingKeys: chunk.map(
          (finding) => finding.findingKey ?? finding.cveId,
        ),
        ruleIds: [ruleId],
        issueTypes,
        packageName: ruleId,
        targetVersion: "fix SonarQube rule violation",
        repoName,
        applicationRoot: moduleName,
        pathDisposition: "active-code-managed",
        whereToUpdate: buildSonarWhereToUpdate(chunk),
        findingCount: chunk.reduce((sum, finding) => sum + finding.rawCount, 0),
        assetCount: chunk.length,
        isPfos: false,
      });
    });
  }

  return stories;
}

function groupSonarReviewNeededStories(
  findings: TriageFinding[],
  epicKey: string,
): TriageStory[] {
  const groups = new Map<
    string,
    {
      moduleName: string;
      issueType: string;
      ruleId: string;
      findings: TriageFinding[];
    }
  >();
  for (const finding of findings) {
    const moduleName = inferSonarModule(finding);
    const ruleId = finding.ruleId ?? finding.packageName;
    const issueType = finding.issueType ?? "UNKNOWN";
    const key = JSON.stringify([moduleName, issueType, ruleId]);
    const group = groups.get(key) ?? {
      moduleName,
      issueType,
      ruleId,
      findings: [],
    };
    group.findings.push(finding);
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort(
      (a, b) =>
        b.findings.length - a.findings.length ||
        a.moduleName.localeCompare(b.moduleName) ||
        a.issueType.localeCompare(b.issueType) ||
        a.ruleId.localeCompare(b.ruleId),
    )
    .map(({ moduleName, issueType, ruleId, findings: group }) => {
      const sample = [...group].sort(compareSonarFindings).slice(0, 10);
      return {
        source: "sonar",
        title: `[SonarQube][Review Needed] ${ruleId} — ${moduleName} (${group.length.toLocaleString()} findings, Epic: ${epicKey})`,
        description:
          `Epic: ${epicKey}\n` +
          "Review needed before ticket creation\n\n" +
          `Rule: ${ruleId}\n` +
          `Type: ${issueType}\n` +
          `Module: ${moduleName}\n` +
          `Findings: ${group.length.toLocaleString()}\n\n` +
          "These findings are intentionally held from OneShot automation because the rule is high-volume, style-oriented, or likely to require product/owner judgment.",
        team: "UNKNOWN",
        severity: chooseHighestSeverity(group),
        slaTier: chooseHighestSlaTier(group),
        cveIds: sample.map((finding) => finding.findingKey ?? finding.cveId),
        findingKeys: sample.map(
          (finding) => finding.findingKey ?? finding.cveId,
        ),
        ruleIds: [ruleId],
        issueTypes: [issueType],
        packageName: ruleId,
        targetVersion: "human review",
        repoName: inferSonarRepoName(group[0]),
        applicationRoot: moduleName,
        pathDisposition: "needs-review",
        whereToUpdate: buildSonarWhereToUpdate(sample),
        findingCount: group.length,
        assetCount: group.length,
        isPfos: false,
      };
    });
}

function groupIntoStories(
  findings: TriageFinding[],
  epicKey: string,
): TriageStory[] {
  // Group by repo × package. A single dependency upgrade
  // often clears multiple CVEs; creating one ticket per CVE produces noisy
  // bulk Jira creation without improving remediation. Keeping repo in the key
  // preserves ownership while allowing one story to list multiple app roots.
  const groups = new Map<string, TriageFinding[]>();

  for (const finding of findings) {
    const repo = inferRepoForFinding(finding);
    const key = repo
      ? `repo:${repo}::${finding.packageName}`
      : `repo-mapping-needed:${inferApplicationRootForFinding(finding)}::${finding.packageName}`;
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  const stories: TriageStory[] = [];
  for (const [groupKey, group] of groups.entries()) {
    const [scope, packageName] = groupKey.split("::");
    const repoName = scope.startsWith("repo:")
      ? scope.slice("repo:".length)
      : "";
    const representative = group[0];
    const repoResolution = summarizeRepoResolutionForFindings(group, repoName);
    const isLog4j1Story = group.some((finding) =>
      isLog4j1MigrationStory(finding),
    );
    const queueForOneShot = !isLog4j1Story || shouldQueueLog4j1ForOneShot();
    const queueBlockedReason = queueForOneShot
      ? undefined
      : "Log4j 1.x migration requires explicit approval before OneShot queueing";
    const applicationRoots = [
      ...new Set(
        group.map((finding) => inferApplicationRootForFinding(finding)),
      ),
    ].sort();
    const applicationRoot = summarizeApplicationRoots(applicationRoots);
    const slaTier = chooseHighestSlaTier(group);
    const fixedVersion = chooseTargetVersion(group);
    const cveIds = [...new Set(group.map((f) => f.cveId))];
    const cveTitle =
      cveIds.length === 1
        ? cveIds[0]
        : `${cveIds[0]} + ${cveIds.length - 1} more`;

    stories.push({
      source: "wiz",
      title: `[Security] ${packageName} — ${cveTitle} — ${applicationRoot} — Wiz remediation${repoName ? "" : " repo confirmation"} (Epic: ${epicKey})`,
      description: buildTeamADescription(
        epicKey,
        group,
        repoName,
        applicationRoot,
        repoResolution,
      ),
      team: "A",
      severity: chooseHighestSeverity(group),
      slaTier,
      cveIds,
      packageName,
      targetVersion: fixedVersion,
      repoName,
      repoFullName: repoResolution.repoFullName,
      repoProjectName: repoResolution.repoProjectName,
      repoProjectPath: repoResolution.repoProjectPath,
      repoDefaultBranch: repoResolution.repoDefaultBranch,
      repoConfidence: repoResolution.repoConfidence,
      repoEvidence: repoResolution.repoEvidence,
      applicationRoot,
      pathDisposition: "active-code-managed",
      whereToUpdate: buildWhereToUpdate(group, repoName),
      findingCount: group.reduce((sum, f) => sum + f.rawCount, 0),
      assetCount: group.reduce((sum, f) => sum + f.assetCount, 0),
      isPfos: queueForOneShot,
      queueForOneShot,
      queueBlockedReason,
    });
  }

  return stories;
}

function groupInfraStories(
  findings: TriageFinding[],
  epicKey: string,
  team: "B" | "C" | "D",
): TriageStory[] {
  if (findings.length === 0) return [];

  // Group by execution scope so manual/platform work is actionable without
  // creating one Jira story per OS advisory package or runtime library.
  const groups = new Map<string, TriageFinding[]>();
  for (const finding of findings) {
    const executionRoot = inferManualExecutionRoot(finding);
    const disposition = classifyLocationPath(finding.locationPath).disposition;
    const key = `${team}::${disposition}::${executionRoot}`;
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  const stories: TriageStory[] = [];
  const teamLabel = {
    B: "EOL OS Migration",
    C: "OS Patching",
    D: "Python OS Packages",
  }[team];

  for (const [groupKey, group] of groups.entries()) {
    const [, disposition, applicationRoot] = groupKey.split("::");
    const representative = group[0];
    const packages = [
      ...new Set(group.map((finding) => finding.packageName)),
    ].sort();
    const packageName = summarizePackageNames(packages, 5);
    const slaTier = chooseHighestSlaTier(group);
    const assetCount = group.reduce((sum, f) => sum + f.assetCount, 0);
    const findingCount = group.reduce((sum, f) => sum + f.rawCount, 0);
    const pathDisposition = disposition as TriagePathDisposition;

    stories.push({
      source: "wiz",
      title: `[Security][Team ${team}] ${applicationRoot} — ${teamLabel} — Wiz remediation (Epic: ${epicKey})`,
      description:
        `Epic: ${epicKey}\n` +
        `Team ${team} — ${teamLabel}\n\n` +
        `Application/runtime root: ${applicationRoot}\n` +
        `Path disposition: ${pathDisposition}\n` +
        `Packages: ${packages.join(", ")}\n` +
        `Findings: ${findingCount.toLocaleString()} | Assets: ${assetCount.toLocaleString()}\n\n` +
        `Remediation: ${summarizeManualRemediation(group)}\n\n` +
        `NOTE: This story requires infrastructure/SSM execution, not code changes. ` +
        `It is NOT routed through the OneShot pipeline.`,
      team,
      severity: chooseHighestSeverity(group),
      slaTier,
      cveIds: [...new Set(group.map((f) => f.cveId))],
      packageName,
      targetVersion: chooseTargetVersion(group),
      repoName: "",
      applicationRoot,
      pathDisposition,
      whereToUpdate: buildManualWhereToUpdate(group, applicationRoot),
      findingCount,
      assetCount,
      isPfos: false,
    });
  }

  return stories;
}

function groupBackupCleanupStories(
  findings: TriageFinding[],
  epicKey: string,
): TriageStory[] {
  if (findings.length === 0) return [];

  const findingCount = findings.reduce((sum, f) => sum + f.rawCount, 0);
  const assetCount = findings.reduce((sum, f) => sum + f.assetCount, 0);
  const cveIds = summarizeValues(
    [...new Set(findings.map((finding) => finding.cveId))],
    25,
  );
  const packageNames = summarizeValues(
    [...new Set(findings.map((finding) => finding.packageName))],
    20,
  );

  return [
    {
      source: "wiz",
      title: `[Security][DevOps] Cleanup backup/archive vulnerability directories — ${findingCount.toLocaleString()} Wiz findings (Epic: ${epicKey})`,
      description:
        `Epic: ${epicKey}\n` +
        "Team DevOps — backup/archive filesystem cleanup\n\n" +
        "These findings were intentionally segregated from Team A/B/C/D remediation because the vulnerable files are under backup/archive directories, release-note folders, or deprecated local copies.\n\n" +
        `Findings: ${findingCount.toLocaleString()} raw | Assets: ${assetCount.toLocaleString()}\n` +
        `Packages: ${packageNames.join(", ")}\n` +
        `CVEs/findings: ${cveIds.join(", ")}\n\n` +
        "Remediation: validate retention requirements, remove stale backup/archive directories from scanned hosts, or move required archives outside Wiz-scanned runtime paths.",
      team: "C",
      severity: chooseHighestSeverity(findings),
      slaTier: assignSlaTier(findings[0]),
      cveIds,
      packageName: "backup/archive vulnerable files",
      targetVersion: "cleanup stale backup/archive directories",
      repoName: "DevOps",
      applicationRoot: "backup/archive filesystem cleanup",
      pathDisposition: "backup-archive",
      whereToUpdate: buildBackupCleanupWhereToUpdate(findings),
      findingCount,
      assetCount,
      isPfos: false,
    },
  ];
}

function groupReviewNeededStories(
  findings: TriageFinding[],
  epicKey: string,
): TriageStory[] {
  if (findings.length === 0) return [];

  const groups = new Map<string, TriageFinding[]>();
  for (const finding of findings) {
    const repo = inferRepoForFinding(finding) ?? "manual-review";
    const applicationRoot = inferApplicationRootForFinding(finding);
    const key = `${repo}::${applicationRoot}::${finding.packageName}`;
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  return [...groups.entries()].map(([groupKey, group]) => {
    const [repoName, applicationRoot, packageName] = groupKey.split("::");
    const findingCount = group.reduce((sum, f) => sum + f.rawCount, 0);
    const assetCount = group.reduce((sum, f) => sum + f.assetCount, 0);
    const cveIds = [...new Set(group.map((finding) => finding.cveId))];

    return {
      source: "wiz",
      title: `[Security][Review Needed] ${packageName} — ${applicationRoot} — Wiz remediation review (Epic: ${epicKey})`,
      description:
        `Epic: ${epicKey}\n` +
        "Review needed before ticket creation\n\n" +
        `Reason: ${inferReviewReason(group)}\n` +
        `Repo candidate: ${repoName}\n` +
        `Application/runtime root: ${applicationRoot}\n` +
        `Package: ${packageName}\n` +
        `Findings: ${findingCount.toLocaleString()} raw | Assets: ${assetCount.toLocaleString()}\n\n` +
        "These findings are intentionally held from OneShot automation until a human confirms the source module and remediation approach.",
      team: "UNKNOWN",
      severity: chooseHighestSeverity(group),
      slaTier: chooseHighestSlaTier(group),
      cveIds,
      packageName,
      targetVersion: chooseTargetVersion(group),
      repoName: repoName === "manual-review" ? "" : repoName,
      applicationRoot,
      pathDisposition: "needs-review",
      whereToUpdate: buildReviewNeededWhereToUpdate(group),
      findingCount,
      assetCount,
      isPfos: false,
    };
  });
}

function buildSonarDescription(
  epicKey: string,
  findings: TriageFinding[],
  repoName: string,
  moduleName: string,
): string {
  const ruleIds = [
    ...new Set(findings.map((finding) => finding.ruleId)),
  ].filter((value): value is string => !!value);
  const issueTypes = [
    ...new Set(findings.map((finding) => finding.issueType ?? "UNKNOWN")),
  ].sort();
  const severity = chooseHighestSeverity(findings);

  const ruleList = ruleIds.length > 0 ? ruleIds.join(", ") : "listed rule(s)";

  return [
    "Summary",
    `Fix SonarQube ${ruleList} in ${moduleName} — ${repoName}.`,
    "",
    "Overview",
    `TRIAGE grouped ${findings.length.toLocaleString()} SonarQube finding(s) for ${ruleList} in ${moduleName}. ` +
      `This ticket is scoped to the listed rule(s), components, and lines below and should resolve them without changing adjacent behavior.`,
    "",
    "Acceptance Criteria",
    "- All listed SonarQube findings are addressed in the reported component files.",
    "- The implementation is limited to the listed rule(s), components, and directly required tests.",
    "- Existing behavior is preserved unless the Sonar rule explicitly identifies a behavior bug.",
    "- Relevant module compile or unit tests pass; tests are added or updated where behavior changes.",
    "- A SonarQube re-scan no longer reports the listed issue keys.",
    "",
    "Technical Details",
    `Epic: ${epicKey}`,
    `Source: SonarQube`,
    `Repo: ${repoName}`,
    `Project: ${findings[0]?.project ?? "unknown"}`,
    `Module/root: ${moduleName}`,
    `Rule(s): ${ruleList}`,
    `Issue type(s): ${issueTypes.join(", ")}`,
    `Severity: ${severity}`,
    `Findings: ${findings.length.toLocaleString()}`,
    "",
    "Where to Update",
    buildSonarWhereToUpdate(findings),
    "",
    "Out of Scope",
    "- Do not remediate neighboring Sonar rules or components not listed in this story.",
    "- Do not perform broad cleanup or refactors outside the affected module.",
    "",
    "Testing Notes",
    "- Run the relevant module compile/unit test command for the affected project.",
    "- Add or update tests that cover any changed behavior.",
    "- Confirm the next SonarQube scan clears the listed issue keys.",
  ].join("\n");
}

function buildSonarWhereToUpdate(findings: TriageFinding[]): string {
  const lines = [...findings].sort(compareSonarFindings).map((finding) => {
    const location = finding.line
      ? `${finding.component}:${finding.line}`
      : (finding.component ?? finding.locationPath);
    return `  • ${location} — ${finding.ruleId ?? finding.packageName} — ${finding.remediation}`;
  });

  return [
    "Reported findings:",
    ...lines,
    "",
    "Fix these specific findings only; do not perform broad cleanup for neighboring rules.",
  ].join("\n");
}

interface RepoResolutionSummary {
  repoFullName?: string;
  repoProjectName?: string;
  repoProjectPath?: string;
  repoDefaultBranch?: string;
  repoConfidence: "high" | "medium" | "none";
  repoEvidence: string[];
}

function summarizeRepoResolutionForFindings(
  findings: TriageFinding[],
  repoName: string,
): RepoResolutionSummary {
  const paths = findings.flatMap((finding) =>
    finding.locationPaths && finding.locationPaths.length > 0
      ? finding.locationPaths
      : [finding.locationPath],
  );
  const profiles = paths
    .map((path) => classifyLocationPath(path))
    .filter((profile) => profile.repoName === repoName);

  const catalogProfile =
    profiles.find((profile) => profile.repoFullName) ?? profiles[0];
  const confidence = profiles.some(
    (profile) => profile.repoConfidence === "high",
  )
    ? "high"
    : profiles.some((profile) => profile.repoConfidence === "medium")
      ? "medium"
      : "none";

  return {
    repoFullName: catalogProfile?.repoFullName,
    repoProjectName: catalogProfile?.repoProjectName,
    repoProjectPath: catalogProfile?.repoProjectPath,
    repoDefaultBranch: catalogProfile?.repoDefaultBranch,
    repoConfidence: confidence,
    repoEvidence: [
      ...new Set(profiles.flatMap((profile) => profile.repoEvidence ?? [])),
    ],
  };
}

function buildTeamADescription(
  epicKey: string,
  findings: TriageFinding[],
  repoName: string,
  applicationRoot: string,
  repoResolution: RepoResolutionSummary,
): string {
  const representative = findings[0];
  const totalFindings = findings.reduce((sum, f) => sum + f.rawCount, 0);
  const totalAssets = findings.reduce((sum, f) => sum + f.assetCount, 0);
  const cveIds = [...new Set(findings.map((f) => f.cveId))].join(", ");
  const fixedVersion = chooseTargetVersion(findings) || "remove/exclude (EOL)";
  const repoEvidence = repoResolution.repoEvidence.slice(0, 5);
  const acceptanceCriteria = isLog4j1MigrationStory(representative)
    ? [
        "1. Log4j 1.x is removed from the affected project dependency/package output",
        `2. Logging is migrated or bridged to ${fixedVersion} without leaving log4j:log4j 1.x reachable at runtime`,
        "3. mvn dependency:tree and packaged artifact inspection confirm no log4j-1.x JAR remains",
        "4. Relevant compile/unit tests pass for the affected project",
        "5. Wiz re-scan confirms findings cleared",
      ]
    : [
        `1. ${representative.packageName} upgraded to ${fixedVersion} in affected pom.xml`,
        "2. mvn dependency:tree confirms no vulnerable version remains",
        "3. mvn clean install -DskipTests -Dskip.gwt.compile=true passes",
        "4. No .java source files changed (version bump only)",
        "5. Wiz re-scan confirms findings cleared",
      ];

  return [
    "Summary",
    `Update ${representative.packageName} security remediation in ${applicationRoot}.`,
    "",
    "Overview",
    `TRIAGE found ${totalFindings.toLocaleString()} Wiz finding(s) for ${representative.packageName} under ${applicationRoot}. This ticket is scoped to the mapped source project below and should remediate the vulnerable dependency without changing adjacent application behavior.`,
    "",
    "Acceptance Criteria",
    ...acceptanceCriteria.map((item) => `- ${stripNumberPrefix(item)}`),
    "",
    "Technical Details",
    `Epic: ${epicKey}`,
    repoName
      ? `Repo: ${repoName}`
      : "Repo mapping: needs confirmation before implementation",
    repoResolution.repoFullName
      ? `GitHub Repo: ${repoResolution.repoFullName}`
      : undefined,
    repoResolution.repoProjectPath
      ? `Project path: ${repoResolution.repoProjectPath}`
      : repoResolution.repoProjectName
        ? `Project: ${repoResolution.repoProjectName}`
        : undefined,
    `Repo mapping confidence: ${repoResolution.repoConfidence}`,
    repoEvidence.length > 0 ? "Repo mapping evidence:" : undefined,
    ...repoEvidence.map((evidence) => `- ${evidence}`),
    `Application/runtime root: ${applicationRoot}`,
    `Path disposition: active-code-managed`,
    `CVEs: ${cveIds}`,
    `Package: ${representative.packageName}`,
    `Current version: ${representative.packageVersion}`,
    `Target version: ${fixedVersion}`,
    `Findings: ${totalFindings.toLocaleString()} raw | Assets: ${totalAssets.toLocaleString()}`,
    "",
    "Where to Update",
    buildWhereToUpdate(findings, repoName),
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
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function stripNumberPrefix(value: string): string {
  return value.replace(/^\d+\.\s*/, "");
}

function buildWhereToUpdate(
  findings: TriageFinding[],
  repoName: string,
): string {
  const paths = new Set(
    findings
      .flatMap((f) =>
        f.locationPaths?.length ? f.locationPaths : [f.locationPath],
      )
      .filter(
        (path) =>
          path &&
          classifyLocationPath(path).disposition === "active-code-managed",
      ),
  );
  const roots = new Set(
    Array.from(paths).map((path) => classifyLocationPath(path).applicationRoot),
  );
  const rootList = Array.from(roots).sort();
  const sample = Array.from(paths).slice(0, 10);
  return (
    "Affected application roots:\n" +
    rootList.map((root) => `  - ${root}`).join("\n") +
    "\n\n" +
    "Affected paths (sample):\n" +
    sample.map((p) => `  • ${p}`).join("\n") +
    (paths.size > 10 ? `\n  ... and ${paths.size - 10} more` : "") +
    `\n\n${repoName ? `${repoName} security remediation` : "repo mapping needed for security remediation"}`
  );
}

function isLog4j1MigrationStory(finding: TriageFinding): boolean {
  return (
    /^log4j$/i.test(finding.packageName) && /^1\./.test(finding.packageVersion)
  );
}

function buildBackupCleanupWhereToUpdate(findings: TriageFinding[]): string {
  const directoryCounts = new Map<string, number>();

  for (const finding of findings) {
    const paths =
      finding.locationPaths && finding.locationPaths.length > 0
        ? finding.locationPaths
        : [finding.locationPath];
    for (const path of paths) {
      const directory = inferBackupCleanupRoot(path);
      directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
    }
  }

  const topDirectories = [...directoryCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 25);

  return [
    "Backup/archive directories to validate and clean up:",
    ...topDirectories.map(
      ([directory, count]) =>
        `  • ${directory} — ${count.toLocaleString()} grouped findings`,
    ),
    directoryCounts.size > topDirectories.length
      ? `  ... and ${directoryCounts.size - topDirectories.length} more backup/archive directories`
      : "",
    "",
    "Do not route these dependency findings to application source remediation unless the directory owner confirms the files are active runtime artifacts.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function buildManualWhereToUpdate(
  findings: TriageFinding[],
  executionRoot: string,
): string {
  const packageGroups = new Map<string, Set<string>>();
  const paths = new Set<string>();

  for (const finding of findings) {
    const cves = packageGroups.get(finding.packageName) ?? new Set<string>();
    cves.add(finding.cveId);
    packageGroups.set(finding.packageName, cves);

    const findingPaths =
      finding.locationPaths && finding.locationPaths.length > 0
        ? finding.locationPaths
        : [finding.locationPath];
    for (const path of findingPaths) {
      paths.add(path);
    }
  }

  const packageLines = [...packageGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 25)
    .map(
      ([packageName, cves]) =>
        `  - ${packageName}: ${summarizeValues([...cves], 8).join(", ")}`,
    );
  const pathSamples = [...paths].sort().slice(0, 25);

  return [
    `Manual execution scope: ${executionRoot}`,
    "",
    "Packages/CVEs:",
    ...packageLines,
    packageGroups.size > packageLines.length
      ? `  ... and ${packageGroups.size - packageLines.length} more packages`
      : "",
    "",
    "Sample paths/advisories:",
    ...pathSamples.map((path) => `  • ${path}`),
    paths.size > pathSamples.length
      ? `  ... and ${paths.size - pathSamples.length} more paths`
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function buildReviewNeededWhereToUpdate(findings: TriageFinding[]): string {
  const paths = new Set(
    findings.flatMap((finding) =>
      finding.locationPaths && finding.locationPaths.length > 0
        ? finding.locationPaths
        : [finding.locationPath],
    ),
  );
  const sample = [...paths].sort().slice(0, 15);

  return [
    "Review these paths before creating remediation tickets:",
    ...sample.map((path) => `  • ${path}`),
    paths.size > sample.length
      ? `  ... and ${paths.size - sample.length} more paths`
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function inferRepoForFinding(finding: TriageFinding): string | undefined {
  const paths =
    finding.locationPaths && finding.locationPaths.length > 0
      ? finding.locationPaths
      : [finding.locationPath];
  for (const path of paths) {
    const profile = classifyLocationPath(path);
    if (
      profile.disposition === "active-code-managed" &&
      profile.repoConfidence === "high" &&
      profile.repoName
    ) {
      return profile.repoName;
    }
  }
  return undefined;
}

function inferSonarRepoName(finding: TriageFinding): string {
  const project = (finding.project ?? "").toLowerCase();
  if (project === "cp-medhok-monorepo") return "core-app";
  return finding.project || "core-app";
}

function inferSonarModule(finding: TriageFinding): string {
  const component = finding.component ?? finding.locationPath;
  const parts = component.split("/").filter(Boolean);
  return parts[0] ?? "root";
}

/**
 * Branch a Wiz Code finding was reported on. The parser stores it as an extra
 * (loosely-typed) `repoBranch` field parsed from resource.name. Empty string
 * when unknown so grouping treats "unknown branch" as its own bucket.
 */
function wizCodeBranch(finding: TriageFinding): string {
  return (finding as { repoBranch?: string }).repoBranch ?? "";
}

function compareSonarFindings(a: TriageFinding, b: TriageFinding): number {
  const componentCompare = (a.component ?? a.locationPath).localeCompare(
    b.component ?? b.locationPath,
  );
  if (componentCompare !== 0) return componentCompare;

  const aLine = parseInt(a.line ?? "0", 10);
  const bLine = parseInt(b.line ?? "0", 10);
  if (aLine !== bLine) return aLine - bLine;

  return (a.findingKey ?? a.cveId).localeCompare(b.findingKey ?? b.cveId);
}

function chunkFindings<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function inferManualExecutionRoot(finding: TriageFinding): string {
  const advisoryAsset = extractAdvisoryAsset(finding.locationPath);
  if (advisoryAsset) return `/advisory/${advisoryAsset}`;
  return classifyLocationPath(finding.locationPath).applicationRoot;
}

function inferApplicationRootForFinding(finding: TriageFinding): string {
  const paths =
    finding.locationPaths && finding.locationPaths.length > 0
      ? finding.locationPaths
      : [finding.locationPath];
  const activePath = paths.find(
    (path) => classifyLocationPath(path).disposition === "active-code-managed",
  );
  return classifyLocationPath(activePath ?? finding.locationPath)
    .applicationRoot;
}

function extractAdvisoryAsset(locationPath: string): string | undefined {
  const normalizedPath = locationPath.replace(/^\/\[Partition=[^\]]+\]/i, "");
  const match = normalizedPath.match(/^\/advisory\/[^@]+@(.+)$/i);
  return match?.[1]?.trim();
}

function inferBackupCleanupRoot(locationPath: string): string {
  const normalizedPath = locationPath
    .replace(/^\/\[Partition=[^\]]+\]/i, "")
    .split(" -> ")[0];
  const parts = normalizedPath.split("/").filter(Boolean);
  const backupIndex = parts.findIndex((part) =>
    /backup|backups|bckp|bkp|bak|archive|archived|dnu|do[_-]?not[_-]?use|deprecated|unused|old|^lib[_.-]?(?:backup|bckp|bkp|bak|old|\d{6,8})$/i.test(
      part,
    ),
  );

  if (backupIndex >= 0) {
    return `/${parts.slice(0, backupIndex + 1).join("/")}`;
  }

  if (parts[0]?.toLowerCase() === "releases" && parts[1]) {
    return `/${parts.slice(0, 2).join("/")}`;
  }

  return normalizedPath.replace(/\/[^/]*$/, "");
}

function chooseTargetVersion(findings: TriageFinding[]): string {
  const versions = [
    ...new Set(
      findings
        .map((finding) => finding.fixedVersion)
        .filter((version) => version && version.trim()),
    ),
  ].sort();
  if (versions.length === 0) return "remove/exclude";
  if (versions.length === 1) return versions[0];
  return `${versions[versions.length - 1]} or later`;
}

function chooseHighestSlaTier(
  findings: TriageFinding[],
): "P1-CISA-KEV" | "P1-HIGH-EXPLOIT" | "P2-30-DAY" | "P3" {
  const tierRank = {
    "P1-CISA-KEV": 4,
    "P1-HIGH-EXPLOIT": 3,
    "P2-30-DAY": 2,
    P3: 1,
  };
  return findings
    .map((finding) => assignSlaTier(finding))
    .sort((a, b) => tierRank[b] - tierRank[a])[0];
}

function chooseHighestSeverity(findings: TriageFinding[]): string {
  const rank: Record<string, number> = {
    blocker: 5,
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  return (
    findings
      .map((finding) => finding.severity)
      .sort(
        (a, b) => (rank[b.toLowerCase()] ?? 0) - (rank[a.toLowerCase()] ?? 0),
      )[0] ?? "Unknown"
  );
}

function summarizeApplicationRoots(roots: string[]): string {
  if (roots.length === 0) return "unknown root";
  if (roots.length === 1) return roots[0];
  if (roots.length <= 3) return roots.join(", ");
  return `${roots.slice(0, 2).join(", ")} + ${roots.length - 2} more roots`;
}

function summarizePackageNames(packages: string[], limit: number): string {
  if (packages.length === 0) return "manual/platform packages";
  if (packages.length <= limit) return packages.join(", ");
  return `${packages.slice(0, limit).join(", ")} + ${packages.length - limit} more packages`;
}

function summarizeManualRemediation(findings: TriageFinding[]): string {
  const remediations = [
    ...new Set(
      findings
        .map((finding) => finding.remediation)
        .filter((value) => value && value.trim()),
    ),
  ];
  if (remediations.length === 0) return "See Wiz findings";
  return summarizeValues(remediations, 5).join("; ");
}

function inferReviewReason(findings: TriageFinding[]): string {
  const packageNames = new Set(findings.map((finding) => finding.packageName));
  if (packageNames.has("log4j")) {
    return "Log4j 1.x migration may require exclusions/bridges/config changes, not a simple Maven version bump";
  }
  if ([...packageNames].some((name) => /^spring(?:-|$)|^spring$/i.test(name))) {
    return "Spring major-version upgrade requires compatibility review";
  }
  if (
    findings.some((finding) =>
      (finding.locationPaths?.length
        ? finding.locationPaths
        : [finding.locationPath]
      ).some((path) => /->\s*META-INF\/maven\//i.test(path)),
    )
  ) {
    return "Wiz path indicates embedded/shaded Maven metadata; source dependency may differ from the vulnerable artifact";
  }
  return "Source module or remediation path needs human confirmation";
}

function summarizeValues(values: string[], limit: number): string[] {
  const cleaned = values.filter((value) => value && value.trim()).sort();
  if (cleaned.length <= limit) return cleaned;
  return [...cleaned.slice(0, limit), `... and ${cleaned.length - limit} more`];
}

function createSuppressionCounters(): Record<
  TriagePathDisposition | "non-maven",
  number
> {
  return {
    "active-code-managed": 0,
    "backup-archive": 0,
    "runtime-tooling": 0,
    "third-party-runtime": 0,
    "infra-os": 0,
    "needs-review": 0,
    "non-maven": 0,
  };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function findCsvAttachment(
  attachments: Array<{ id: string; filename?: string; mimeType?: string }>,
): { id: string; filename?: string } | null {
  // Accept both CSV and xlsx — xlsx is converted to CSV internally
  const csvAttachments = attachments.filter((a) => {
    const name = (a.filename ?? "").toLowerCase();
    const mime = (a.mimeType ?? "").toLowerCase();
    return (
      name.endsWith(".csv") ||
      name.endsWith(".xlsx") ||
      name.endsWith(".xls") ||
      mime === "text/csv" ||
      mime ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mime === "application/vnd.ms-excel" ||
      mime === "application/octet-stream"
    );
  });

  if (csvAttachments.length === 0) return null;
  // Return the last one (most recently attached)
  return csvAttachments[csvAttachments.length - 1];
}

interface PeekedStream {
  headerLine: string;
  /** Text already decoded from the stream (header + any following bytes). */
  consumed: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: InstanceType<typeof TextDecoder>;
}

/**
 * Read only enough of the stream to capture the first (header) line, without
 * buffering the whole attachment. Returns the header plus whatever bytes were
 * already decoded so a follow-on parse doesn't lose them.
 */
async function peekHeaderLine(response: Response): Promise<PeekedStream> {
  const decoder = new TextDecoder("utf-8");
  const reader = response.body?.getReader();
  if (!reader) {
    // No streaming body (test/small env): fall back to full text.
    const text = await response.text();
    const headerLine = text.split("\n")[0] ?? "";
    return {
      headerLine,
      consumed: text,
      // Minimal stub reader that reports completion immediately.
      reader: {
        read: async () => ({ done: true, value: undefined }),
        cancel: async () => undefined,
      } as unknown as ReadableStreamDefaultReader<Uint8Array>,
      decoder,
    };
  }

  let consumed = "";
  let done = false;
  while (!done && !consumed.includes("\n")) {
    const { value, done: d } = await reader.read();
    done = d;
    if (value) consumed += decoder.decode(value, { stream: !done });
  }
  const headerLine = consumed.split("\n")[0] ?? "";
  return { headerLine, consumed, reader, decoder };
}

/** Finish reading a stream that peekHeaderLine() already partially consumed. */
async function drainRemainder(
  consumed: string,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: InstanceType<typeof TextDecoder>,
): Promise<string> {
  let text = consumed;
  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    done = d;
    if (value) text += decoder.decode(value, { stream: !done });
  }
  return text;
}

/** Detect source type from filename alone — no body read required. */
export function detectSourceFromFilename(
  filename: string,
): "wiz" | "wiz-code" | "snyk" | "sonar" | "custom" {
  const fn = filename.toLowerCase();
  // Strip extension for name-based detection
  const base = fn.replace(/\.(csv|xlsx?|json)$/, "");
  // Wiz Code (SAST) naming must be checked BEFORE the broad "wiz" prefix,
  // otherwise wiz-code-report.csv would route to the Wiz dependency parser and
  // fail on the missing Name/LocationPath columns.
  if (
    /(^|[-_ ])wiz[-_ ]?code([-_ ]|$)/.test(base) ||
    /(^|[-_ ])sast([-_ ]|$)/.test(base)
  )
    return "wiz-code";
  if (
    base.startsWith("wiz") ||
    base.startsWith("all_cp_vuln") ||
    base.startsWith("mhk")
  )
    return "wiz";
  if (fn.startsWith("snyk") || fn.includes(".snyk")) return "snyk";
  if (fn.startsWith("sonar")) return "sonar";
  return "custom"; // will attempt wiz parser; let it fail gracefully if wrong
}

/** Legacy full-content detection — kept for tests that pass content directly. */
export function detectSource(
  content: string,
  filename: string,
): "wiz" | "wiz-code" | "snyk" | "sonar" | "custom" {
  const byFilename = detectSourceFromFilename(filename);
  if (byFilename !== "custom") return byFilename;
  // Header sniffing for ambiguous filenames. Wiz Code (SAST) must be checked
  // before the Wiz dependency parser since both share the "wiz" family.
  if (isWizCodeCsv(content)) return "wiz-code";
  if (isSonarCsv(content)) return "sonar";
  if (isWizCsv(content)) return "wiz";
  return "custom";
}

async function resolveCustomerId(
  db: Database,
  epicKey: string,
): Promise<number> {
  // Default to customer_id=1 — in production this would resolve from
  // the EPIC's project/client tag. Safe default for MHK internal projects.
  const branches = await db
    .getPool()
    .query("SELECT id FROM customer_branches WHERE id = 1 LIMIT 1");
  const rows = (branches as any)[0];
  if (Array.isArray(rows) && rows.length > 0) return 1;

  // Fallback: use any available customer
  const any = await db
    .getPool()
    .query("SELECT id FROM customer_branches ORDER BY id ASC LIMIT 1");
  const anyRows = (any as any)[0];
  if (Array.isArray(anyRows) && anyRows.length > 0) return anyRows[0].id;

  throw new Error(
    "No customer_branches rows found — cannot create task_management entries",
  );
}
