import dotenv from "dotenv";
import mammoth from "mammoth";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  adfToMarkdown,
  createJiraClient,
  type JiraAttachment,
  type JiraIssue,
  type JiraTicketData,
} from "../../orchestrator/JiraClient.js";
import { Database } from "../../orchestrator/database.js";
import {
  DOCS_BLOCKED_LABEL,
  DOCS_GENERATED_LABEL,
  DOCS_IN_PROGRESS_LABEL,
  DOCS_REPLAN_LABEL,
  getDocumentationDocumentTypeLabels,
  validateDocumentationIntakeLabels,
} from "../contracts.js";
import {
  LocalDocumentationTemplateProvider,
  type DocumentationTemplateSnapshot,
} from "./templates.js";
import {
  isDocumentationSynthesisEnabled,
  synthesizeDocumentationMarkdown,
  validateSynthesizedDocument,
  type DocsEvidenceBlock,
} from "./synthesis.js";

export interface DocumentationDryRunIssue {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  labels: string[];
  parentKey: string | null;
  descriptionMarkdown: string;
  commentCount: number;
  attachmentCount: number;
  components: string[];
  fixVersions: string[];
  subtasks: string[];
  comments: Array<{
    id: string;
    author?: string;
    created: string;
    bodyMarkdown: string;
  }>;
  attachmentTexts: Array<{
    filename: string;
    content: string;
  }>;
}

export interface DocumentationDryRunContext {
  target: DocumentationDryRunIssue;
  documentationStory: DocumentationDryRunIssue;
  epic: DocumentationDryRunIssue | null;
  epicChildren: DocumentationDryRunIssue[];
  subtaskIssues: DocumentationDryRunIssue[];
  template: DocumentationTemplateSnapshot;
  gaps: string[];
}

interface ConfigurationValueRow {
  location: string;
  setting: string;
  value: string;
  notes: string;
}

interface ParsedConfigurationTable {
  title: string;
  location: string;
  headers: string[];
  rows: string[][];
}

interface DocumentationHumanReviewSummary {
  humanReviewRequired: boolean;
  readiness: "review_required" | "ready_for_publish_review";
  reasons: string[];
  recommendedJiraSummary: string;
  recommendedNextAction: string;
}

interface DocumentationDryRunCliArgs {
  issueKey: string;
  outputDir: string;
  attachToJira: boolean;
  addJiraComment: boolean;
  ignoreTerminalLabels: boolean;
}

interface DocumentationDryRunOutput {
  markdownPath: string;
  summaryPath: string;
  jiraSummaryPath: string;
  reviewSummary: DocumentationHumanReviewSummary;
}

export interface DocumentationJiraAttachmentResult {
  requestedFilenames: string[];
  filenames: string[];
  skippedFilenames: string[];
  commentId: string | null;
  generatedLabelAdded: boolean;
  /**
   * True when the draft required human review and the ticket was transitioned
   * to the DOCS-BLOCKED review-required terminal label (DOCS-IN-PROGRESS
   * removed). This prevents the ticket from becoming permanently stuck: the
   * poller excludes DOCS-IN-PROGRESS, so leaving it in place would make the
   * ticket un-selectable without ever reaching a terminal state.
   */
  reviewRequiredLabelAdded: boolean;
  mutationsDisabled: boolean;
}

export interface DocumentationArtifactRunResult {
  issueKey: string;
  templateTitle: string;
  documentTypeLabel: string;
  documentationStoryKey: string;
  parentEpicKey: string | null;
  epicChildrenReviewed: number;
  subtaskIssuesReviewed: number;
  markdownPath: string;
  summaryPath: string;
  jiraSummaryPath: string;
  attachmentResult: DocumentationJiraAttachmentResult | null;
}

type RawTableFormatter = (cells: string[]) => string | null;

export interface JiraConfig {
  baseUrl: string;
  username: string;
  token: string;
}

const EPIC_CHILD_FETCH_CONCURRENCY = 8;

function loadLocalEnv(): void {
  process.env.DOTENV_CONFIG_QUIET = "true";
  const candidates = [
    path.resolve(process.cwd(), ".env.local"),
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env.local"),
    path.resolve(process.cwd(), "..", ".env"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate, override: false, quiet: true });
    }
  }
}

export function getJiraConfig(): JiraConfig {
  loadLocalEnv();

  const baseUrl = process.env.JIRA_BASE_URL?.trim();
  const username =
    process.env.JIRA_USERNAME?.trim() ??
    process.env.CONFLUENCE_USERNAME?.trim();
  const rawToken =
    process.env.JIRA_TOKEN?.trim() ?? process.env.CONFLUENCE_TOKEN?.trim();
  const token = rawToken?.replace(/^JIRA_TOKEN=/, "");
  if (rawToken?.startsWith("JIRA_TOKEN=")) {
    console.warn(
      "Jira token value included a JIRA_TOKEN= prefix; stripping it for documentation dry run.",
    );
  }

  const missing = [
    ["JIRA_BASE_URL", baseUrl],
    ["JIRA_USERNAME", username],
    ["JIRA_TOKEN", token],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(
      `Missing Jira credentials for documentation dry run: ${missing
        .map(([name]) => name)
        .join(", ")}`,
    );
  }

  return {
    baseUrl: baseUrl!,
    username: username!,
    token: token!,
  };
}

function defaultDocumentationOutputDir(issueKey: string): string {
  return path.resolve(
    os.tmpdir(),
    "oneshot-docs-dry-run",
    `${issueKey || "unknown"}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
}

function parseArgs(argv: string[]): DocumentationDryRunCliArgs {
  let issueKey = "";
  let outputDirArg = "";
  let attachToJira = false;
  let addJiraComment = true;
  let ignoreTerminalLabels = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]?.trim();
    if (!arg) {
      continue;
    }
    if (arg === "--out") {
      outputDirArg = argv[index + 1]?.trim() ?? "";
      index += 1;
      continue;
    }
    if (arg === "--attach-to-jira") {
      attachToJira = true;
      continue;
    }
    if (arg === "--no-jira-comment") {
      addJiraComment = false;
      continue;
    }
    if (arg === "--ignore-terminal-labels") {
      ignoreTerminalLabels = true;
      continue;
    }
    if (!arg.startsWith("--") && !issueKey) {
      issueKey = arg;
    }
  }

  const outputDir = outputDirArg
    ? path.resolve(outputDirArg)
    : defaultDocumentationOutputDir(issueKey);

  if (!issueKey) {
    throw new Error(
      [
        "Usage:",
        "  npm run oneshot:docs:dry-run -- JIRA-123 [--out /path/to/output]",
        "  npm run oneshot:docs:run -- JIRA-123 [--out /path/to/output] [--no-jira-comment]",
      ].join("\n"),
    );
  }

  return {
    issueKey: issueKey.toUpperCase(),
    outputDir,
    attachToJira,
    addJiraComment,
    ignoreTerminalLabels,
  };
}

function isTruthyEnvValue(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function isDocumentationArtifactRunRecordingEnabled(): boolean {
  if (process.env.ONESHOT_DOCS_RECORD_ARTIFACT_RUNS !== undefined) {
    return isTruthyEnvValue(process.env.ONESHOT_DOCS_RECORD_ARTIFACT_RUNS);
  }

  return process.env.NODE_ENV === "production" || Boolean(process.env.DB_HOST);
}

function jiraMutationsDisabled(): boolean {
  return (
    process.env.ONESHOT_DISABLE_JIRA_MUTATIONS?.toLowerCase() === "true" ||
    process.env.ONESHOT_DISABLE_JIRA_COMMENTS?.toLowerCase() === "true"
  );
}

function issueToDryRunIssue(
  issue: JiraIssue,
  descriptionMarkdown = "",
  commentCount = 0,
  comments: DocumentationDryRunIssue["comments"] = [],
  attachmentTexts: DocumentationDryRunIssue["attachmentTexts"] = [],
): DocumentationDryRunIssue {
  return {
    key: issue.key,
    summary: issue.fields.summary ?? "",
    issueType: issue.fields.issuetype?.name ?? "",
    status: issue.fields.status?.name ?? "",
    labels: issue.fields.labels ?? [],
    parentKey: issue.fields.parent?.key ?? null,
    descriptionMarkdown:
      descriptionMarkdown || adfToMarkdown(issue.fields.description),
    commentCount,
    attachmentCount: issue.fields.attachment?.length ?? 0,
    components: (issue.fields.components ?? [])
      .map((component) => component.name)
      .filter((name): name is string => Boolean(name)),
    fixVersions: (issue.fields.fixVersions ?? [])
      .map((version) => version.name)
      .filter((name): name is string => Boolean(name)),
    subtasks: (issue.fields.subtasks ?? [])
      .map((subtask) => subtask.key)
      .filter((key): key is string => Boolean(key)),
    comments,
    attachmentTexts,
  };
}

async function ticketDataToDryRunIssue(
  data: JiraTicketData,
  config: JiraConfig,
): Promise<DocumentationDryRunIssue> {
  const attachmentTexts = await extractAttachmentTexts(config, data);
  return issueToDryRunIssue(
    data.issue,
    data.descriptionMarkdown,
    data.comments.length,
    data.comments,
    attachmentTexts,
  );
}

function getAuthHeader(config: JiraConfig): string {
  return `Basic ${Buffer.from(`${config.username}:${config.token}`).toString(
    "base64",
  )}`;
}

async function downloadAttachmentBuffer(
  config: JiraConfig,
  attachment: JiraAttachment,
): Promise<Buffer | null> {
  if (!attachment.content) {
    return null;
  }

  const response = await fetch(attachment.content, {
    method: "GET",
    headers: {
      Authorization: getAuthHeader(config),
      Accept: "*/*",
    },
  });

  if (!response.ok) {
    return null;
  }

  return Buffer.from(await response.arrayBuffer());
}

function looksReadable(content: string): boolean {
  if (content.trim().length < 20) {
    return false;
  }
  const sample = content.slice(0, 2000);
  const replacementChars = (sample.match(/\uFFFD/g) ?? []).length;
  const controlChars = (
    sample.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []
  ).length;
  return replacementChars + controlChars < sample.length * 0.05;
}

export function isGeneratedDocumentationArtifactForTest(
  filename: string,
  content: string,
): boolean {
  return isGeneratedDocumentationArtifact(filename, content);
}

function isGeneratedDocumentationArtifact(
  filename: string,
  content: string,
): boolean {
  const normalizedFilename = filename.trim().toLowerCase();
  if (/-summary\.json$/i.test(normalizedFilename)) {
    return true;
  }
  if (/-jira-summary\.md$/i.test(normalizedFilename)) {
    return true;
  }

  const sample = content.slice(0, 4000);
  // Recognize both the current "Generation Summary" title and the legacy
  // "Dry Run Summary" title so artifacts attached before the rename are still
  // detected (dedup / evidence-skip must not regress for in-flight tickets).
  if (
    /# OneShot Documentation Generation Summary/i.test(sample) ||
    /# OneShot Documentation Dry Run Summary/i.test(sample)
  ) {
    return true;
  }

  const hasGeneratedHeader =
    /Document type:\s*DOC-TYPE-/i.test(sample) &&
    // "Source:" is the current marker; "Dry-run source:" is the legacy marker.
    /(?:^|\n)(?:Dry-run s|S)ource:/i.test(sample) &&
    /Generated at:/i.test(sample);
  if (!hasGeneratedHeader) {
    return false;
  }

  return /^cpdev-\d+-(?:release-notes|functionality|integration|configuration|config|api|deployment-runbook|terraform|troubleshooting|support-runbook|client-kb|internal)\.md$/i.test(
    normalizedFilename,
  );
}

async function extractAttachmentTexts(
  config: JiraConfig,
  data: JiraTicketData,
): Promise<DocumentationDryRunIssue["attachmentTexts"]> {
  const extracted: DocumentationDryRunIssue["attachmentTexts"] = [];
  const seen = new Set<string>();

  for (const attachment of data.textAttachments) {
    if (
      !looksReadable(attachment.content) ||
      isGeneratedDocumentationArtifact(attachment.filename, attachment.content)
    ) {
      continue;
    }
    seen.add(attachment.filename);
    extracted.push({
      filename: attachment.filename,
      content: attachment.content,
    });
  }

  for (const attachment of data.attachments) {
    const filename = attachment.filename ?? "";
    if (!filename.toLowerCase().endsWith(".docx") || seen.has(filename)) {
      continue;
    }

    const buffer = await downloadAttachmentBuffer(config, attachment);
    if (!buffer) {
      continue;
    }

    try {
      const result = await mammoth.extractRawText({ buffer });
      const content = result.value.trim();
      if (content && !isGeneratedDocumentationArtifact(filename, content)) {
        extracted.push({ filename, content });
      }
    } catch {
      // Best-effort only. Missing attachment text is represented through gaps
      // and attachment metadata in the dry-run summary.
    }
  }

  return extracted;
}

function uniqueByKey(
  issues: DocumentationDryRunIssue[],
): DocumentationDryRunIssue[] {
  const seen = new Set<string>();
  const result: DocumentationDryRunIssue[] = [];
  for (const issue of issues) {
    if (seen.has(issue.key)) {
      continue;
    }
    seen.add(issue.key);
    result.push(issue);
  }
  return result;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]!, index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(concurrency, 1), items.length) },
      () => worker(),
    ),
  );

  return results;
}

async function fetchIssueDataSafe(
  jiraClient: ReturnType<typeof createJiraClient>,
  jiraConfig: JiraConfig,
  issueKey: string,
  gaps: string[],
): Promise<DocumentationDryRunIssue | null> {
  try {
    return await ticketDataToDryRunIssue(
      await jiraClient.fetchTicketData(issueKey),
      jiraConfig,
    );
  } catch (error) {
    gaps.push(
      `Could not fetch full Jira evidence for ${issueKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

async function fetchEpicChildren(
  jiraClient: ReturnType<typeof createJiraClient>,
  jiraConfig: JiraConfig,
  epicKey: string,
  gaps: string[],
): Promise<DocumentationDryRunIssue[]> {
  const jqlAttempts = [
    `parent = ${epicKey} ORDER BY created ASC`,
    `parentEpic = ${epicKey} ORDER BY created ASC`,
    `"Epic Link" = ${epicKey} ORDER BY created ASC`,
  ];

  let childKeys: string[] = [];
  for (const jql of jqlAttempts) {
    try {
      const result = await jiraClient.searchIssues(jql, "key,summary", 100);
      childKeys = result.issues.map((issue) => issue.key);
      if (childKeys.length > 0) {
        break;
      }
    } catch (error) {
      gaps.push(
        `Child lookup failed for JQL '${jql}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (childKeys.length === 0) {
    gaps.push(`No child issues found under epic ${epicKey}.`);
    return [];
  }

  const fetched = await mapWithConcurrency(
    childKeys,
    EPIC_CHILD_FETCH_CONCURRENCY,
    (key) => fetchIssueDataSafe(jiraClient, jiraConfig, key, gaps),
  );

  return fetched.filter((issue): issue is DocumentationDryRunIssue =>
    Boolean(issue),
  );
}

async function fetchSubtaskIssues(
  jiraClient: ReturnType<typeof createJiraClient>,
  jiraConfig: JiraConfig,
  parentIssues: DocumentationDryRunIssue[],
  gaps: string[],
): Promise<DocumentationDryRunIssue[]> {
  const parentKeys = new Set(parentIssues.map((issue) => issue.key));
  const subtaskKeys = uniqueStrings(
    parentIssues.flatMap((issue) => issue.subtasks),
  ).filter((key) => !parentKeys.has(key));

  if (subtaskKeys.length === 0) {
    return [];
  }

  const fetched = await mapWithConcurrency(
    subtaskKeys,
    EPIC_CHILD_FETCH_CONCURRENCY,
    (key) => fetchIssueDataSafe(jiraClient, jiraConfig, key, gaps),
  );

  return fetched.filter((issue): issue is DocumentationDryRunIssue =>
    Boolean(issue),
  );
}

async function buildDryRunContext(
  issueKey: string,
  jiraConfig: JiraConfig,
  options: { ignoreTerminalLabels?: boolean } = {},
): Promise<DocumentationDryRunContext> {
  const jiraClient = createJiraClient({ ...jiraConfig, downloadImages: false });
  const templateProvider = new LocalDocumentationTemplateProvider();
  const gaps: string[] = [];

  const targetData = await jiraClient.fetchTicketData(issueKey);
  const target = await ticketDataToDryRunIssue(targetData, jiraConfig);
  const labelValidation = validateDocumentationIntakeLabels(target.labels);
  let documentTypeLabel = labelValidation.documentTypeLabel;

  if (!labelValidation.qualified || !labelValidation.documentTypeLabel) {
    if (
      options.ignoreTerminalLabels &&
      labelValidation.reasonCode === "terminal_label_present"
    ) {
      const documentTypes = getDocumentationDocumentTypeLabels(target.labels);
      if (documentTypes.length === 1) {
        documentTypeLabel = documentTypes[0];
      } else {
        throw new Error(
          `Documentation dry run cannot ignore terminal labels for ${issueKey}: expected exactly one document type label, found ${documentTypes.join(", ") || "none"}.`,
        );
      }
    } else {
      throw new Error(
        `Documentation dry run is not qualified for ${issueKey}: ${labelValidation.reason}`,
      );
    }
  }

  const template = await templateProvider.getTemplateByLabel(
    documentTypeLabel!,
  );
  const templateValidation = templateProvider.validateSnapshot(template);
  if (!templateValidation.valid) {
    throw new Error(
      `Template ${template.definition.key} is invalid; missing headings: ${templateValidation.missingRequiredHeadings.join(
        ", ",
      )}`,
    );
  }

  let documentationStory = target;
  if (target.issueType.toLowerCase().includes("sub-task")) {
    if (!target.parentKey) {
      throw new Error(`Sub-task ${target.key} does not have a parent story.`);
    }
    documentationStory = await ticketDataToDryRunIssue(
      await jiraClient.fetchTicketData(target.parentKey),
      jiraConfig,
    );
  }

  let epic: DocumentationDryRunIssue | null = null;
  if (documentationStory.parentKey) {
    epic = await ticketDataToDryRunIssue(
      await jiraClient.fetchTicketData(documentationStory.parentKey),
      jiraConfig,
    );
  } else {
    gaps.push(
      `Documentation story ${documentationStory.key} has no parent epic.`,
    );
  }

  const epicChildren = epic
    ? await fetchEpicChildren(jiraClient, jiraConfig, epic.key, gaps)
    : [];
  const subtaskIssues = await fetchSubtaskIssues(
    jiraClient,
    jiraConfig,
    uniqueByKey([
      target,
      documentationStory,
      ...(epic ? [epic] : []),
      ...epicChildren,
    ]),
    gaps,
  );

  return {
    target,
    documentationStory,
    epic,
    epicChildren: uniqueByKey(epicChildren),
    subtaskIssues: uniqueByKey(subtaskIssues),
    template,
    gaps,
  };
}

function issueLink(config: JiraConfig, issueKey: string): string {
  return `${config.baseUrl.replace(/\/$/, "")}/browse/${issueKey}`;
}

function renderEvidenceSummary(
  context: DocumentationDryRunContext,
  allIssues: DocumentationDryRunIssue[],
): string {
  const extractedAttachments = allIssues.flatMap((issue) =>
    issue.attachmentTexts.map(
      (attachment) => `${issue.key}: ${attachment.filename}`,
    ),
  );
  const commentCount = allIssues.reduce(
    (sum, issue) => sum + issue.commentCount,
    0,
  );
  const attachmentCount = allIssues.reduce(
    (sum, issue) => sum + issue.attachmentCount,
    0,
  );

  return [
    `- Primary documentation story: ${context.documentationStory.key} - ${context.documentationStory.summary}`,
    context.epic
      ? `- Parent epic: ${context.epic.key} - ${context.epic.summary}`
      : "- Parent epic: not found",
    `- Epic child issues reviewed: ${context.epicChildren.length}`,
    `- Subtask/task issues reviewed: ${context.subtaskIssues.length}`,
    `- Comments reviewed: ${commentCount}`,
    `- Attachments reviewed: ${attachmentCount}`,
    extractedAttachments.length > 0
      ? `- Extracted attachment text used: ${extractedAttachments.length} files`
      : "- Extracted attachment text used: none",
    "",
    "Full evidence details are available in the generation summary JSON generated beside this Markdown file.",
  ].join("\n");
}

function joinOrGap(values: string[], gapText: string): string {
  return values.length > 0 ? values.join(", ") : `<${gapText}>`;
}

function joinOrNotFound(values: string[], gapText: string): string {
  return values.length > 0
    ? values.join(", ")
    : `${gapText} not found in reviewed evidence`;
}

function tableCell(value: string): string {
  return normalizeWhitespace(value).replace(/\|/g, "\\|");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildIssueSourceText(issues: DocumentationDryRunIssue[]): string {
  const parts: string[] = [];
  for (const issue of issues) {
    parts.push(issue.descriptionMarkdown);
    parts.push(...issue.comments.map((comment) => comment.bodyMarkdown));
    parts.push(
      ...issue.attachmentTexts.map((attachment) => attachment.content),
    );
  }

  return parts.filter(Boolean).join("\n\n");
}

/**
 * Build structured, delimited evidence blocks with stable IDs for LLM
 * synthesis. Each fact source (issue description, comment, attachment) becomes
 * its own block with an ID the model can cite and that downstream validation
 * can confirm exists — so claims are attributable to a specific ticket,
 * comment, or attachment rather than an anonymous concatenation.
 */
function buildEvidenceBlocks(
  context: DocumentationDryRunContext,
): DocsEvidenceBlock[] {
  const blocks: DocsEvidenceBlock[] = [];
  for (const issue of getAllEvidenceIssues(context)) {
    // Emit an ISSUE block for EVERY reviewed issue, not only those with a
    // description. Summary/type/status/components/fixVersions influence the
    // deterministic draft, so every issue must be citable; otherwise a fact
    // drawn from issue metadata would have no valid evidence id and the model
    // could not attribute it.
    const metadataLines = [
      `Summary: ${issue.summary}`,
      `Type: ${issue.issueType}`,
      `Status: ${issue.status}`,
      ...(issue.components.length > 0
        ? [`Components: ${issue.components.join(", ")}`]
        : []),
      ...(issue.fixVersions.length > 0
        ? [`Fix versions: ${issue.fixVersions.join(", ")}`]
        : []),
    ];
    const description = normalizeWhitespace(issue.descriptionMarkdown);
    const content = description
      ? `${metadataLines.join("\n")}\n\nDescription:\n${issue.descriptionMarkdown}`
      : metadataLines.join("\n");
    blocks.push({
      id: `ISSUE-${issue.key}`,
      label: `${issue.issueType} ${issue.key}: ${issue.summary}`,
      content,
    });
    for (const comment of issue.comments) {
      if (!normalizeWhitespace(comment.bodyMarkdown)) {
        continue;
      }
      blocks.push({
        id: `COMMENT-${issue.key}-${comment.id}`,
        label: `Comment on ${issue.key}${
          comment.author ? ` by ${comment.author}` : ""
        }`,
        content: comment.bodyMarkdown,
      });
    }
    for (const attachment of issue.attachmentTexts) {
      if (!normalizeWhitespace(attachment.content)) {
        continue;
      }
      blocks.push({
        id: `ATTACHMENT-${issue.key}-${attachment.filename}`,
        label: `Attachment ${attachment.filename} on ${issue.key}`,
        content: attachment.content,
      });
    }
  }
  return blocks;
}

function buildSourceText(context: DocumentationDryRunContext): string {
  return buildIssueSourceText(getAllEvidenceIssues(context));
}

function buildTargetFirstSourceText(
  context: DocumentationDryRunContext,
): string {
  const targetSubtasks = context.subtaskIssues.filter(
    (issue) => issue.parentKey === context.target.key,
  );
  const primaryText = buildIssueSourceText([context.target, ...targetSubtasks]);
  if (normalizeWhitespace(primaryText).length >= 80) {
    return primaryText;
  }

  return buildIssueSourceText([
    context.target,
    ...targetSubtasks,
    context.documentationStory,
    ...(context.epic ? [context.epic] : []),
  ]);
}

function extractBulletSection(
  text: string,
  heading: string,
  maxItems = 8,
): string[] {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) =>
    line.toLowerCase().includes(heading.toLowerCase()),
  );
  if (headingIndex < 0) {
    return [];
  }

  const bullets: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    const trimmed = line.trim();
    if (
      isHorizontalRule(trimmed) ||
      trimmed.startsWith("|") ||
      trimmed.startsWith("```")
    ) {
      continue;
    }
    if (!trimmed) {
      if (bullets.length > 0) {
        break;
      }
      continue;
    }
    if (
      bullets.length > 0 &&
      !trimmed.startsWith("-") &&
      !trimmed.match(/^\d+\./) &&
      trimmed.endsWith(":")
    ) {
      break;
    }
    const bullet = cleanExtractedItem(trimmed);
    if (bullet && bullet !== heading && isUsefulExtractedItem(bullet)) {
      bullets.push(bullet);
    }
    if (bullets.length >= maxItems) {
      break;
    }
  }

  return uniqueStrings(bullets.map(normalizeWhitespace));
}

function extractFirstBulletSection(
  text: string,
  headings: string[],
  maxItems = 8,
): string[] {
  for (const heading of headings) {
    const items = extractBulletSection(text, heading, maxItems).filter(
      isUsefulExtractedItem,
    );
    if (items.length > 0) {
      return items;
    }
  }
  return [];
}

function lineMatchesSectionHeading(line: string, heading: string): boolean {
  const normalizedLine = cleanEvidenceCell(line)
    .replace(/^#{1,6}\s+/, "")
    .replace(/:$/, "")
    .toLowerCase();
  const normalizedHeading = cleanEvidenceCell(heading)
    .replace(/:$/, "")
    .toLowerCase();
  return (
    normalizedLine === normalizedHeading ||
    normalizedLine.startsWith(`${normalizedHeading}:`)
  );
}

function isLikelyStandaloneHeading(line: string): boolean {
  const cleaned = cleanEvidenceCell(line);
  if (
    !cleaned ||
    cleaned.length > 90 ||
    cleaned.startsWith("|") ||
    /^[-*]\s+/.test(cleaned) ||
    /^\d+\./.test(cleaned) ||
    /[.!?]$/.test(cleaned)
  ) {
    return false;
  }
  const words = cleaned.split(/\s+/);
  if (words.length > 10) {
    return false;
  }
  return /^[A-Z0-9]/.test(cleaned);
}

function extractSectionItems(
  text: string,
  headings: string[],
  maxItems = 8,
): string[] {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) =>
    headings.some((heading) => lineMatchesSectionHeading(line, heading)),
  );
  if (headingIndex < 0) {
    return [];
  }

  const items: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed || isHorizontalRule(trimmed) || trimmed.startsWith("```")) {
      continue;
    }
    if (trimmed.startsWith("|")) {
      continue;
    }
    if (items.length > 0 && isLikelyStandaloneHeading(trimmed)) {
      break;
    }
    const item = cleanExtractedItem(trimmed);
    if (isUsefulExtractedItem(item)) {
      items.push(item);
    }
    if (items.length >= maxItems) {
      break;
    }
  }

  return uniqueStrings(items);
}

function extractFirstSectionItems(
  text: string,
  headings: string[],
  maxItems = 8,
): string[] {
  for (const heading of headings) {
    const items = extractSectionItems(text, [heading], maxItems);
    if (items.length > 0) {
      return items;
    }
  }
  return [];
}

function extractRawTableCells(
  text: string,
  heading: string,
  headerPatterns: RegExp[],
  stopHeadings: string[],
  maxRows = 8,
): string[][] {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) =>
    lineMatchesSectionHeading(line, heading),
  );
  if (headingIndex < 0) {
    return [];
  }

  const values: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    const cleaned = cleanExtractedItem(line);
    if (!cleaned || isHorizontalRule(cleaned) || cleaned.startsWith("```")) {
      continue;
    }
    if (
      values.length >= headerPatterns.length &&
      stopHeadings.some((stopHeading) =>
        lineMatchesSectionHeading(cleaned, stopHeading),
      )
    ) {
      break;
    }
    values.push(cleaned);
    if (
      values.length >=
      headerPatterns.length + maxRows * headerPatterns.length
    ) {
      break;
    }
  }

  const startsWithHeaders = headerPatterns.every((pattern, index) =>
    pattern.test(values[index] ?? ""),
  );
  const startIndex = startsWithHeaders ? headerPatterns.length : 0;
  const rows: string[][] = [];
  for (
    let index = startIndex;
    index + headerPatterns.length - 1 < values.length;
    index += headerPatterns.length
  ) {
    const cells = values.slice(index, index + headerPatterns.length);
    if (!cells.every(isUsefulExtractedItem)) {
      continue;
    }
    rows.push(cells);
    if (rows.length >= maxRows) {
      break;
    }
  }

  return rows;
}

function extractRawTableRows(
  text: string,
  heading: string,
  headerPatterns: RegExp[],
  stopHeadings: string[],
  formatter: RawTableFormatter,
  maxRows = 8,
): string[] {
  return uniqueStrings(
    extractRawTableCells(text, heading, headerPatterns, stopHeadings, maxRows)
      .map(formatter)
      .filter((row): row is string =>
        Boolean(row && isUsefulExtractedItem(row)),
      ),
  );
}

function extractFailureItems(text: string): string[] {
  const eligibilityItems = extractFirstBulletSection(
    text,
    ["A member is not eligible when:", "Not eligible when:"],
    8,
  );
  const failureRows = extractRawTableRows(
    text,
    "Failure Surface Overview",
    [/^failure point$/i, /^current behavior$/i, /owner|check/i],
    [
      "Confirmed Current-Main Migrations and Controls",
      "Action on Failure UI Guidance",
      "Branch-Only or Historical Evidence",
      "Legacy Batch Watcher Overlap",
      "Operational Validation Checklist",
      "Open Confirmations",
      "Evidence Basis",
    ],
    ([point, behavior, owner]) => `${point}: ${behavior} Check/owner: ${owner}`,
    6,
  );

  return uniqueStrings([...eligibilityItems, ...failureRows]).slice(0, 10);
}

function extractTroubleshootingItems(text: string): string[] {
  const troubleshootingRows = extractRawTableRows(
    text,
    "Troubleshooting Guide",
    [/^symptom$/i, /^likely cause$/i, /^what to check$/i],
    ["Open Confirmations", "Evidence Basis", "Related Articles"],
    ([symptom, cause, check]) => `${symptom}: ${cause} Check: ${check}`,
    6,
  );
  if (troubleshootingRows.length > 0) {
    return troubleshootingRows;
  }

  return extractFirstSectionItems(
    text,
    ["Operational Validation Checklist", "Failure Surface Overview"],
    10,
  );
}

function extractParagraphAfterHeading(
  text: string,
  headings: string[],
  maxChars = 650,
): string | null {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) =>
    headings.some((heading) =>
      line.toLowerCase().includes(heading.toLowerCase()),
    ),
  );
  if (headingIndex < 0) {
    return null;
  }

  const paragraph: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    if (
      paragraph.length > 0 &&
      /^(#{1,6}\s+|[A-Z][A-Za-z /&-]+:?$)/.test(trimmed)
    ) {
      break;
    }
    if (
      trimmed.startsWith("|") ||
      trimmed.startsWith("---") ||
      trimmed.startsWith("```")
    ) {
      continue;
    }
    paragraph.push(trimmed.replace(/^[-*]\s+/, ""));
    if (paragraph.join(" ").length >= maxChars) {
      break;
    }
  }

  const result = normalizeWhitespace(paragraph.join(" "));
  return result
    ? `${result.slice(0, maxChars).trim()}${result.length > maxChars ? "..." : ""}`
    : null;
}

function firstSentences(text: string, maxSentences = 2): string | null {
  const normalized = normalizeWhitespace(text.replace(/```[\s\S]*?```/g, " "));
  if (!normalized) {
    return null;
  }
  const sentences = normalized.match(/[^.!?]+[.!?]/g) ?? [normalized];
  const result = sentences.slice(0, maxSentences).join(" ").trim();
  return result ? result.slice(0, 650) : null;
}

function extractAffectedAreas(text: string): string[] {
  const match = /affected areas:\s*([^.]+)/i.exec(text);
  if (!match) {
    return [];
  }
  return uniqueStrings(
    match[1]
      .split(/,|\band\b/i)
      .map((area) => area.trim())
      .filter(Boolean),
  );
}

function extractKeyHighlights(text: string): string[] {
  const match =
    /Key highlights include\s+([\s\S]{1,900}?)(?:\n\n|\.)(?:\s|$)/i.exec(text);
  if (!match?.[1]) {
    return [];
  }

  const actionBoundary =
    /,\s+(?=(?:configure|use|route|fall back|enable|support|allow|capture|update|send|receive|display|validate|create|generate|trigger)\b)/i;
  const normalized = match[1].replace(
    /,\s+and\s+(?=(?:configure|use|route|fall back|enable|support|allow|capture|update|send|receive|display|validate|create|generate|trigger)\b)/gi,
    ", ",
  );

  return uniqueStrings(
    normalized
      .split(actionBoundary)
      .map(cleanExtractedItem)
      .map((item) => item.replace(/^the ability to\s+/i, ""))
      .filter(isUsefulExtractedItem),
  ).slice(0, 8);
}

function extractApiReferences(text: string): string[] {
  const references: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") || trimmed.startsWith("#")) {
      continue;
    }
    const cleaned = cleanEvidenceCell(line);
    if (
      isUsefulExtractedItem(cleaned) &&
      !isSensitiveReference(cleaned) &&
      !isJiraMetaReference(cleaned) &&
      !isGenericApiReference(cleaned) &&
      /(\b(?:GET|POST|PUT|PATCH|DELETE)\s+(?:\/|https?:)|api gateway.*(?:callback|resource|path|endpoint|exposes)|api_gateway_resource_path|\/rest\/|\/DocumentRestServices|\/ExternalTransferServices|\/MHKCallBackServices|\/PersonDetails|\/workflowtransactions|DocumentRestServices|ExternalCallbackServices|MHKCallBackServices|ExternalTransferServices)/i.test(
        cleaned,
      )
    ) {
      references.push(cleaned);
    }
  }

  const pathMatches = text.match(
    /\/(?:DocumentRestServices|ExternalTransferServices|MHKCallBackServices)[A-Za-z0-9_./-]*|\/(?:PersonDetails|workflowtransactions)\b|(?:\/[A-Za-z0-9_.-]+){2,}[A-Za-z0-9_.-]*/g,
  );
  if (pathMatches) {
    references.push(
      ...pathMatches.filter(
        (value) =>
          !/^\/(?:DIVISION|CP|ENDLINK|MHKWS|API)\b/i.test(value) &&
          !isSensitiveReference(value),
      ),
    );
  }

  const cleanedReferences = uniqueStrings(
    references.map(cleanExtractedItem).filter(isUsefulExtractedItem),
  );
  const concreteReferences = cleanedReferences.filter((reference) =>
    /\/(?:DocumentRestServices|ExternalTransferServices|MHKCallBackServices|PersonDetails|workflowtransactions|rest\/)/i.test(
      reference,
    ),
  );
  const gatewayReferences = cleanedReferences.filter(
    (reference) =>
      !concreteReferences.includes(reference) &&
      /api gateway|api_gateway_resource_path|existing_api_id|callback resource/i.test(
        reference,
      ),
  );
  const serviceReferences = cleanedReferences.filter(
    (reference) =>
      !concreteReferences.includes(reference) &&
      !gatewayReferences.includes(reference),
  );

  return uniqueStrings([
    ...concreteReferences,
    ...gatewayReferences,
    ...serviceReferences,
  ]).slice(0, 12);
}

function isSensitiveReference(value: string): boolean {
  return /TOKEN_CLIENT_SECRET|PASSWORD|API_KEY|CLIENT_SECRET|PWD|secret/i.test(
    value,
  );
}

function isJiraMetaReference(value: string): boolean {
  return /i verified|jira-ready comment|connected atlassian actions|add comment|paste into|scope: complete the epic documentation tasks/i.test(
    value,
  );
}

function isGenericApiReference(value: string): boolean {
  return (
    /^(callback\/webhook endpoint|vendor api endpoint|api_gateway_resource_path)$/i.test(
      value,
    ) ||
    /^check\s+/i.test(value) ||
    /vendor api details, endpoint|admin: configures|disable or do not assign|allow view\/update|health plan must contract/i.test(
      value,
    )
  );
}

function extractNavigationPathFromLine(line: string): string | null {
  const match =
    /\b(?:Navigation|Path):\s*`?([^`\n]+?)`?\s*$/i.exec(line.trim()) ??
    /\b(?:Navigate to|Go to):\s*`?([^`\n]+?)`?\s*$/i.exec(line.trim());
  return match?.[1] ? normalizeWhitespace(match[1]) : null;
}

function extractNavigationPaths(text: string): string[] {
  const paths = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const path = extractNavigationPathFromLine(line);
    if (path) {
      paths.add(path);
    }
  }
  return [...paths].slice(0, 8);
}

function stripMarkdownMarkup(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "; ")
    .replace(/[`*]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .trim();
}

function cleanEvidenceCell(value: string): string {
  return normalizeWhitespace(stripMarkdownMarkup(value));
}

function isHorizontalRule(value: string): boolean {
  return /^[-_*]{3,}$/.test(value.trim());
}

function cleanExtractedItem(value: string): string {
  return cleanEvidenceCell(
    value
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/^\[[ xX]\]\s+/, ""),
  );
}

function isUsefulExtractedItem(value: string): boolean {
  const cleaned = cleanExtractedItem(value);
  if (!cleaned || cleaned.length < 3) {
    return false;
  }
  if (isHorizontalRule(cleaned) || /^[\W_]+$/.test(cleaned)) {
    return false;
  }
  if (
    /^(ticket|feature|draft date|boundary|scope|status|how to document it|evidence basis|area|evidence used in drafting|symptom|likely cause|what to check|failure point|current behavior|primary owner or check|item|classification|current-main meaning|variable|why it is needed|example from sample|relative name|type|used by|notes|component|purpose|key settings)$/i.test(
      cleaned,
    )
  ) {
    return false;
  }
  if (isJiraMetaReference(cleaned)) {
    return false;
  }
  return true;
}

function splitMarkdownTableLine(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map(cleanEvidenceCell);
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function extractLineHeading(line: string): string | null {
  const trimmed = line.trim();
  const markdownHeading = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
  if (markdownHeading?.[1]) {
    return cleanEvidenceCell(markdownHeading[1].replace(/:$/, ""));
  }
  if (
    trimmed.length > 0 &&
    trimmed.length <= 90 &&
    trimmed.endsWith(":") &&
    !trimmed.startsWith("|") &&
    !trimmed.startsWith("-") &&
    !/^\d+\./.test(trimmed)
  ) {
    return cleanEvidenceCell(trimmed.replace(/:$/, ""));
  }
  return null;
}

function isRelevantConfigurationTable(headers: string[]): boolean {
  const headerText = headers.join(" ").toLowerCase();
  return /system variable|feature package|configuration|setting|variable|relative name|data point|required state|status value|field name|data source|sample value|key settings|configuration value|used by|parameter/.test(
    headerText,
  );
}

function extractMarkdownConfigurationTables(
  text: string,
): ParsedConfigurationTable[] {
  const lines = text.split(/\r?\n/);
  const tables: ParsedConfigurationTable[] = [];
  let currentHeading = "Reviewed evidence";
  let currentNavigation: string | null = null;
  let currentNavigationLine = -1000;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const navigationPath = extractNavigationPathFromLine(trimmed);
    if (navigationPath) {
      currentNavigation = navigationPath;
      currentNavigationLine = index;
    }
    const heading = extractLineHeading(trimmed);
    if (heading) {
      currentHeading = heading;
    }

    if (
      !trimmed.startsWith("|") ||
      !lines[index + 1] ||
      !isMarkdownTableSeparator(lines[index + 1]!)
    ) {
      continue;
    }

    const headers = splitMarkdownTableLine(trimmed);
    if (!isRelevantConfigurationTable(headers)) {
      continue;
    }

    const rows: string[][] = [];
    index += 2;
    while (index < lines.length && lines[index]!.trim().startsWith("|")) {
      const row = splitMarkdownTableLine(lines[index]!);
      if (row.some(Boolean)) {
        rows.push(row);
      }
      index += 1;
    }
    index -= 1;

    tables.push({
      title: currentHeading,
      location:
        currentNavigation && index - currentNavigationLine <= 10
          ? currentNavigation
          : currentHeading,
      headers,
      rows,
    });
  }

  return tables;
}

function findHeaderIndex(headers: string[], patterns: RegExp[]): number {
  return headers.findIndex((header) =>
    patterns.some((pattern) => pattern.test(header.toLowerCase())),
  );
}

function collectCellsByHeader(
  headers: string[],
  row: string[],
  patterns: RegExp[],
): string[] {
  return headers
    .map((header, index) => ({
      header,
      value: row[index] ?? "",
      matched: patterns.some((pattern) => pattern.test(header.toLowerCase())),
    }))
    .filter((entry) => entry.matched && entry.value)
    .map((entry) => `${entry.header}: ${entry.value}`);
}

function tableRowToConfigurationValue(
  table: ParsedConfigurationTable,
  row: string[],
): ConfigurationValueRow | null {
  const headers = table.headers.map(cleanEvidenceCell);
  const settingIndex = findHeaderIndex(headers, [
    /system variable name/,
    /feature package name/,
    /relative name/,
    /^variable$/,
    /variable group/,
    /data point/,
    /item/,
    /setting/,
    /field/,
    /component/,
    /data source/,
    /status value/,
    /watcher setting/,
  ]);
  const resolvedSettingIndex = settingIndex >= 0 ? settingIndex : 0;
  const setting = cleanEvidenceCell(row[resolvedSettingIndex] ?? "");
  if (!setting) {
    return null;
  }

  const valueParts = collectCellsByHeader(headers, row, [
    /^value$/,
    /configuration/,
    /required state/,
    /sample value/,
    /example from sample/,
    /^type$/,
    /method/,
    /classification/,
    /key settings/,
    /used by/,
  ]);
  const noteParts = headers
    .map((header, index) => ({
      header,
      value: cleanEvidenceCell(row[index] ?? ""),
      index,
    }))
    .filter(
      (entry) =>
        entry.value &&
        entry.index !== resolvedSettingIndex &&
        !valueParts.some((part) => part.startsWith(`${entry.header}:`)),
    )
    .map((entry) => `${entry.header}: ${entry.value}`);

  return {
    location: table.location,
    setting,
    value:
      valueParts.length > 0
        ? valueParts.join("; ")
        : "Value not found in reviewed table row",
    notes: noteParts.length > 0 ? noteParts.join("; ") : table.title,
  };
}

function configurationRowsFromTables(
  tables: ParsedConfigurationTable[],
): ConfigurationValueRow[] {
  return tables.flatMap((table) =>
    table.rows
      .map((row) => tableRowToConfigurationValue(table, row))
      .filter((row): row is ConfigurationValueRow => Boolean(row)),
  );
}

function extractRawConfigurationRows(text: string): ConfigurationValueRow[] {
  const rows: ConfigurationValueRow[] = [];

  rows.push(
    ...extractRawTableCells(
      text,
      "Required SSM Parameters",
      [/^relative name$/i, /^type$/i, /^used by$/i, /^notes$/i],
      ["Terraform Values to Review Per Environment", "Outbound Flow Details"],
      20,
    ).map(([setting, type, usedBy, notes]) => ({
      location: "Required SSM Parameters",
      setting,
      value: `${type}; used by ${usedBy}`,
      notes,
    })),
  );

  rows.push(
    ...extractRawTableCells(
      text,
      "Terraform Values to Review Per Environment",
      [/^variable group$/i, /^sample value$/i, /^why it matters$/i],
      ["Outbound Flow Details", "Inbound Callback Flow Details"],
      20,
    ).map(([setting, sample, notes]) => ({
      location: "Terraform Values to Review Per Environment",
      setting,
      value: sample ? `Sample from reviewed evidence: ${sample}` : "",
      notes,
    })),
  );

  return rows;
}

function extractNavigationSetupRows(text: string): ConfigurationValueRow[] {
  const lines = text.split(/\r?\n/);
  const rows: ConfigurationValueRow[] = [];
  let currentHeading = "Configuration setup";

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    const heading = extractLineHeading(trimmed);
    if (heading) {
      currentHeading = heading;
    }

    const navigationPath = extractNavigationPathFromLine(trimmed);
    if (!navigationPath) {
      continue;
    }

    const steps: string[] = [];
    for (const line of lines.slice(index + 1, index + 30)) {
      const raw = line.trim();
      if (!raw) {
        if (steps.length > 0) {
          break;
        }
        continue;
      }
      if (steps.length > 0 && extractLineHeading(raw)) {
        break;
      }
      const step = cleanEvidenceCell(
        raw.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""),
      );
      if (extractNavigationPathFromLine(step)) {
        break;
      }
      if (/^\d+\.|^[-*]\s+/.test(raw)) {
        steps.push(step);
      }
      if (steps.length >= 8) {
        break;
      }
    }

    if (steps.length > 0) {
      rows.push({
        location: navigationPath,
        setting: currentHeading,
        value: steps.join("; "),
        notes: "Setup steps extracted from reviewed evidence.",
      });
    }
  }

  return rows;
}

function uniqueConfigurationRows(
  rows: ConfigurationValueRow[],
): ConfigurationValueRow[] {
  const seen = new Set<string>();
  const result: ConfigurationValueRow[] = [];
  for (const row of rows) {
    const key = [row.location, row.setting, row.value, row.notes]
      .map((value) => value.toLowerCase())
      .join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(row);
  }
  return result;
}

function extractConfigurationValueRows(text: string): ConfigurationValueRow[] {
  return uniqueConfigurationRows([
    ...configurationRowsFromTables(extractMarkdownConfigurationTables(text)),
    ...extractNavigationSetupRows(text),
    ...extractRawConfigurationRows(text),
  ]).slice(0, 60);
}

function renderBullets(items: string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function renderChecklist(items: string[]): string[] {
  return items.map((item) => `- [ ] ${item}`);
}

function renderNumberedSteps(items: string[]): string[] {
  return items.map((item, index) => `${index + 1}. ${item}`);
}

function deriveTroubleshootingGaps(
  context: DocumentationDryRunContext,
): string[] {
  const gaps = [...context.gaps];
  const sourceText = buildSourceText(context);
  const text = sourceText.toLowerCase();
  const causeEvidence = extractFailureItems(sourceText).slice(0, 1);
  const checklist = extractFirstBulletSection(
    sourceText,
    [
      "Resolution",
      "Resolution Steps",
      "Quick Configuration Checklist:",
      "Required configuration items:",
      "Setup steps:",
    ],
    1,
  );
  const validationAreas = extractFirstBulletSection(
    sourceText,
    [
      "Validation Areas:",
      "Validation Checklist",
      "Verification",
      "Operational Validation Checklist",
    ],
    1,
  );
  const knownItems = extractFirstBulletSection(
    sourceText,
    ["Known Items to Confirm:", "Open Confirmations", "Known Issues"],
    1,
  );

  if (!text.match(/\b(error|exception|fail|unable|cannot|symptom|issue)\b/)) {
    gaps.push("Problem symptom evidence is incomplete.");
  }
  if (
    causeEvidence.length === 0 &&
    !text.match(/\b(cause|root cause|because|trigger|not eligible)\b/)
  ) {
    gaps.push("Cause evidence was not found.");
  }
  if (
    checklist.length === 0 &&
    !text.match(/\b(resolve|resolution|fix|workaround|mitigation|checklist)\b/)
  ) {
    gaps.push("Resolution evidence was not found.");
  }
  if (
    validationAreas.length === 0 &&
    !text.match(/\b(verify|verification|test|confirm|validated|validation)\b/)
  ) {
    gaps.push("Verification evidence was not found.");
  }
  if (
    knownItems.length === 0 &&
    !text.match(/\b(escalate|escalation|l2|l3|support|owner)\b/)
  ) {
    gaps.push("Escalation evidence was not found.");
  }
  const directEvidenceIssues = [
    context.target,
    context.documentationStory,
    ...(context.epic ? [context.epic] : []),
  ];
  const directAttachmentCount = directEvidenceIssues.reduce(
    (sum, issue) => sum + issue.attachmentCount,
    0,
  );
  if (directAttachmentCount === 0) {
    gaps.push("No attachments found on target, documentation story, or epic.");
  }

  return [...new Set(gaps)];
}

function isAuthoredTroubleshootingGuide(text: string): boolean {
  const normalized = normalizeWhitespace(text);
  if (normalized.length < 1200) {
    return false;
  }

  const sectionSignals = [
    /^#{1,3}\s+.*troubleshooting.*guide\b/im,
    /\bFeature\b.*\bCode\/DB\/Config\b.*\bMap\b/i,
    /\bKey Log Markers\b/i,
    /\bInspection SQL\b/i,
    /\bCommon Issues\b.*\bTroubleshooting\b/i,
    /\bEnvironment Setup\b|\bDeployment Checklist\b/i,
    /\bKnown Limitations\b|\bOpen Items\b/i,
    /\bEscalation Matrix\b/i,
  ];
  const matchedSignals = sectionSignals.filter((signal) =>
    signal.test(text),
  ).length;
  return matchedSignals >= 4;
}

function splitLeadingMarkdownTitle(text: string): {
  title: string | null;
  body: string;
} {
  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines[0]?.trim() ?? "";
  const titleMatch = /^#\s+(.+?)\s*$/.exec(firstLine);
  if (!titleMatch?.[1]) {
    return { title: null, body: trimmed };
  }

  return {
    title: cleanEvidenceCell(titleMatch[1]),
    body: lines.slice(1).join("\n").trim(),
  };
}

function renderAuthoredTroubleshootingGuide(
  context: DocumentationDryRunContext,
  config: JiraConfig,
  gaps: string[],
): string {
  const allIssues = getAllEvidenceIssues(context);
  const authored = splitLeadingMarkdownTitle(
    context.target.descriptionMarkdown,
  );

  return [
    `# ${authored.title || context.target.summary || "Troubleshooting Guide"}`,
    "",
    `Template: ${context.template.definition.templateTitle} (Confluence page ${context.template.definition.confluencePageId}, version ${context.template.definition.confluenceVersion})`,
    `Document type: ${context.template.definition.documentTypeLabel}`,
    `Source: [${context.target.key}](${issueLink(config, context.target.key)})`,
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Internal Use Only",
    "",
    "This document is for internal use only. Do not share externally.",
    "",
    authored.body,
    "",
    "## Epic Evidence Map",
    "",
    renderEpicEvidenceMap(context, config),
    "",
    "## Evidence Reviewed",
    "",
    renderEvidenceSummary(context, allIssues),
    "",
    "## Gaps / Not Found",
    "",
    gaps.length > 0
      ? gaps.map((gap) => `- ${gap}`).join("\n")
      : "- No deterministic gaps found.",
    "",
  ].join("\n");
}

function renderTroubleshootingDraft(
  context: DocumentationDryRunContext,
  config: JiraConfig,
): string {
  const gaps = deriveTroubleshootingGaps(context);
  if (isAuthoredTroubleshootingGuide(context.target.descriptionMarkdown)) {
    return renderAuthoredTroubleshootingGuide(context, config, gaps);
  }

  const allIssues = getAllEvidenceIssues(context);
  const sourceText = buildTargetFirstSourceText(context);
  const affectedAreas = extractAffectedAreas(sourceText);
  const focusedConfigurationRows = extractConfigurationValueRows(sourceText);
  const problemEvidence = uniqueStrings([
    ...extractFirstSectionItems(
      sourceText,
      ["Problem", "Problem Statement", "Known Issues"],
      8,
    ),
    ...extractTroubleshootingItems(sourceText).slice(0, 6),
    ...extractFailureItems(sourceText).slice(0, 6),
  ]).slice(0, 10);
  const causeEvidence = uniqueStrings([
    ...extractFirstSectionItems(
      sourceText,
      ["Cause", "Root Cause", "Failure Surface Overview"],
      8,
    ),
    ...extractFailureItems(sourceText).slice(0, 8),
  ]).slice(0, 10);
  const resolutionItems = extractFirstBulletSection(
    sourceText,
    [
      "Resolution",
      "Resolution Steps",
      "Workaround",
      "Mitigation",
      "Quick Checks",
      "Quick Configuration Checklist:",
      "Required configuration items:",
      "Setup steps:",
    ],
    12,
  );
  const validationAreas = extractFirstBulletSection(
    sourceText,
    [
      "Validation Areas:",
      "Validation Checklist",
      "Verification",
      "Operational Validation Checklist",
    ],
    8,
  );
  const knownItems = extractFirstBulletSection(
    sourceText,
    ["Known Items to Confirm:", "Open Confirmations", "Known Issues"],
    8,
  );

  const problemText =
    problemEvidence.length > 0
      ? [
          "Reviewed evidence identifies these troubleshooting symptoms or support conditions:",
          "",
          ...renderBullets(problemEvidence),
        ].join("\n")
      : (extractParagraphAfterHeading(sourceText, [
          "Problem",
          "Problem Statement",
          "Purpose and Scope",
          "Overview",
          "Executive Summary",
        ]) ??
        (context.target.descriptionMarkdown.trim()
          ? context.target.descriptionMarkdown.trim()
          : context.target.summary));

  const causeText =
    causeEvidence.length > 0
      ? renderBullets(causeEvidence).join("\n")
      : "<cause not found in reviewed evidence>";

  const resolutionText =
    resolutionItems.length > 0
      ? [
          "Use these reviewed resolution or mitigation steps before escalating:",
          "",
          ...resolutionItems
            .slice(0, 12)
            .map((item, index) => `${index + 1}. ${item}`),
        ].join("\n")
      : "<resolution evidence not found in reviewed evidence>";

  const verificationText =
    validationAreas.length > 0
      ? [
          "Validate the result in these reviewed areas:",
          "",
          ...renderBullets(validationAreas),
        ].join("\n")
      : "<verification evidence not found in reviewed evidence>";

  const escalationText = [
    "Escalate with the issue key, affected record or environment, observed result, attempted checks, relevant logs or screenshots, timestamps, and owner handoff.",
    knownItems.length > 0
      ? [
          "Open confirmation items:",
          "",
          ...renderBullets(knownItems.slice(0, 8)),
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    `# ${context.target.summary || "Troubleshooting Guide"}`,
    "",
    `Template: ${context.template.definition.templateTitle} (Confluence page ${context.template.definition.confluencePageId}, version ${context.template.definition.confluenceVersion})`,
    `Document type: ${context.template.definition.documentTypeLabel}`,
    `Source: [${context.target.key}](${issueLink(config, context.target.key)})`,
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Internal Use Only",
    "",
    "This document is for internal use only. Do not share externally.",
    "",
    "## Problem",
    "",
    problemText,
    "",
    "## Environment / Conditions",
    "",
    "| Field | Details |",
    "|---|---|",
    `| Affected Version(s) | ${joinOrGap(
      uniqueStrings(
        uniqueByKey(allIssues).flatMap((issue) => issue.fixVersions),
      ),
      "version not found in reviewed evidence",
    )} |`,
    `| Solution / Module | ${joinOrGap(
      affectedAreas.length > 0
        ? affectedAreas
        : uniqueStrings(
            uniqueByKey(allIssues).flatMap((issue) => issue.components),
          ),
      "solution/module not found in reviewed evidence",
    )} |`,
    `| Configuration State | ${tableCell(
      focusedConfigurationRows.length > 0
        ? focusedConfigurationRows
            .slice(0, 5)
            .map((row) => `${row.setting}: ${row.value}`)
            .join("; ")
        : "configuration state not found in reviewed evidence",
    )} |`,
    `| Additional Conditions | Target status: ${context.target.status}; parent story status: ${context.documentationStory.status} |`,
    "",
    "## Cause",
    "",
    causeText,
    "",
    "## Resolution",
    "",
    resolutionText,
    "",
    "## Verification",
    "",
    verificationText,
    "",
    "## Escalation",
    "",
    escalationText,
    "",
    "## Related Articles",
    "",
    `- Documentation story: [${context.documentationStory.key}](${issueLink(
      config,
      context.documentationStory.key,
    )})`,
    context.epic
      ? `- Parent epic: [${context.epic.key}](${issueLink(config, context.epic.key)})`
      : "- Parent epic: <not found>",
    "",
    "## Epic Evidence Map",
    "",
    renderEpicEvidenceMap(context, config),
    "",
    "## Evidence Reviewed",
    "",
    renderEvidenceSummary(context, allIssues),
    "",
    "## Gaps / Not Found",
    "",
    gaps.length > 0
      ? gaps.map((gap) => `- ${gap}`).join("\n")
      : "- No deterministic gaps found.",
    "",
  ].join("\n");
}

function getAllEvidenceIssues(
  context: DocumentationDryRunContext,
): DocumentationDryRunIssue[] {
  return uniqueByKey([
    context.target,
    context.documentationStory,
    ...(context.epic ? [context.epic] : []),
    ...context.epicChildren,
    ...context.subtaskIssues,
  ]);
}

function getContextFacts(context: DocumentationDryRunContext): {
  allIssues: DocumentationDryRunIssue[];
  sourceText: string;
  title: string;
  affectedAreas: string[];
  fixVersions: string[];
  capabilities: string[];
  keyHighlights: string[];
  configurationChecklist: string[];
  validationAreas: string[];
  knownItems: string[];
  prerequisites: string[];
  architectureItems: string[];
  deploymentItems: string[];
  failureItems: string[];
  troubleshootingItems: string[];
  apiReferences: string[];
  navigationPaths: string[];
  configurationValues: ConfigurationValueRow[];
} {
  const allIssues = getAllEvidenceIssues(context);
  const sourceText = buildSourceText(context);
  const affectedAreas = extractAffectedAreas(sourceText);
  const fixVersions = uniqueStrings(
    allIssues.flatMap((issue) => issue.fixVersions),
  );
  const capabilities = uniqueStrings(
    context.epicChildren
      .filter((issue) => issue.issueType.toLowerCase() !== "sub-task")
      .map((issue) => issue.summary)
      .slice(0, 8),
  );

  return {
    allIssues,
    sourceText,
    title:
      context.epic?.summary ||
      context.documentationStory.summary ||
      context.target.summary,
    affectedAreas,
    fixVersions,
    capabilities,
    keyHighlights: extractKeyHighlights(sourceText),
    configurationChecklist: extractFirstBulletSection(
      sourceText,
      [
        "Quick Configuration Checklist:",
        "Required configuration items:",
        "Setup steps:",
      ],
      12,
    ),
    validationAreas: extractFirstBulletSection(
      sourceText,
      [
        "Validation Areas:",
        "Validation Checklist",
        "Operational Validation Checklist",
      ],
      10,
    ),
    knownItems: extractFirstBulletSection(
      sourceText,
      ["Known Items to Confirm:", "Open Confirmations", "Known Issues"],
      10,
    ),
    prerequisites: extractFirstBulletSection(
      sourceText,
      [
        "Prerequisites:",
        "Required Roles / Permissions:",
        "Required User Roles & Permissions",
      ],
      8,
    ),
    architectureItems: extractFirstSectionItems(
      sourceText,
      [
        "Architecture Summary",
        "Deployment Component Matrix",
        "Expected Processing Flow:",
        "Processing Flow:",
        "How It Works",
      ],
      8,
    ),
    deploymentItems: extractFirstSectionItems(
      sourceText,
      [
        "Deployment Sequence",
        "Setup Steps:",
        "Outbound Flow Details",
        "Inbound Callback Flow Details",
      ],
      8,
    ),
    failureItems: extractFailureItems(sourceText),
    troubleshootingItems: extractTroubleshootingItems(sourceText),
    apiReferences: extractApiReferences(sourceText),
    navigationPaths: extractNavigationPaths(sourceText),
    configurationValues: extractConfigurationValueRows(sourceText),
  };
}

function renderRelatedArticles(
  context: DocumentationDryRunContext,
  config: JiraConfig,
): string {
  return [
    `- Documentation story: [${context.documentationStory.key}](${issueLink(
      config,
      context.documentationStory.key,
    )})`,
    context.epic
      ? `- Parent epic: [${context.epic.key}](${issueLink(config, context.epic.key)})`
      : "- Parent epic: not found",
  ].join("\n");
}

function renderGenericOverview(
  context: DocumentationDryRunContext,
  facts: ReturnType<typeof getContextFacts>,
): string {
  return (
    extractParagraphAfterHeading(facts.sourceText, [
      "Value of the Enhancement",
      "Summary of the Approach",
      "Executive Summary",
      "Overview",
      "Purpose and Scope",
      "Purpose:",
    ]) ??
    firstSentences(context.epic?.descriptionMarkdown ?? facts.sourceText, 2) ??
    `${facts.title} documentation draft.`
  );
}

function renderWhereItAppears(
  facts: ReturnType<typeof getContextFacts>,
): string {
  return [
    "| Field | Details |",
    "|---|---|",
    `| Solution(s) | ${tableCell(joinOrNotFound(facts.affectedAreas, "solution"))} |`,
    `| Module(s) / Section(s) | ${tableCell(joinOrNotFound(facts.affectedAreas, "module or area"))} |`,
    `| Navigation Path | ${tableCell(joinOrNotFound(facts.navigationPaths, "navigation path"))} |`,
  ].join("\n");
}

function summarizeConfigurationKeys(
  facts: ReturnType<typeof getContextFacts>,
): string {
  const settings = uniqueStrings(
    facts.configurationValues.map((row) => row.setting),
  );
  if (settings.length > 0) {
    return settings.slice(0, 12).join(", ");
  }
  if (facts.configurationChecklist.length > 0) {
    return facts.configurationChecklist.slice(0, 6).join("; ");
  }
  return "configuration keys not found in reviewed evidence";
}

function renderConfigurationValuesTable(
  facts: ReturnType<typeof getContextFacts>,
): string[] {
  if (facts.configurationValues.length === 0) {
    return [];
  }

  return [
    "",
    "Configuration values and locations found in reviewed evidence:",
    "",
    "| Location | Setting | Value / Selection | Notes |",
    "|---|---|---|---|",
    ...facts.configurationValues.map(
      (row) =>
        `| ${tableCell(row.location)} | ${tableCell(row.setting)} | ${tableCell(row.value)} | ${tableCell(row.notes)} |`,
    ),
  ];
}

function renderConfigurationTable(
  facts: ReturnType<typeof getContextFacts>,
): string {
  const configurationDetails =
    facts.configurationChecklist.length > 0
      ? facts.configurationChecklist
      : [
          "Configuration checklist evidence was not found.",
          "Use the extracted configuration value table and source evidence before publication.",
        ];
  const configurationValueTable = renderConfigurationValuesTable(facts);
  const openConfirmations =
    facts.knownItems.length > 0
      ? [
          "",
          "Open confirmations from reviewed evidence:",
          "",
          ...renderBullets(facts.knownItems.slice(0, 10)),
        ]
      : [];

  return [
    "| Field | Details |",
    "|---|---|",
    `| Solution(s) | ${tableCell(joinOrNotFound(facts.affectedAreas, "solution"))} |`,
    `| Module(s) / Area(s) | ${tableCell(joinOrNotFound(facts.affectedAreas, "module or area"))} |`,
    `| Affected Navigation Path | ${tableCell(joinOrNotFound(facts.navigationPaths, "navigation path"))} |`,
    `| Configuration Key(s) | ${tableCell(summarizeConfigurationKeys(facts))} |`,
    `| Default Value(s) | ${facts.configurationValues.length > 0 ? "See configuration value table below. Values absent from reviewed evidence are reported as not found." : "default values not found in reviewed evidence"} |`,
    "",
    "Configuration checklist found in reviewed evidence:",
    "",
    ...renderBullets(configurationDetails.slice(0, 12)),
    ...configurationValueTable,
    ...openConfirmations,
  ].join("\n");
}

function issueEvidenceKinds(issue: DocumentationDryRunIssue): string {
  const kinds = [
    issue.descriptionMarkdown.trim() ? "description" : "",
    issue.commentCount > 0 ? `${issue.commentCount} comment(s)` : "",
    issue.attachmentCount > 0 ? `${issue.attachmentCount} attachment(s)` : "",
    issue.attachmentTexts.length > 0
      ? `${issue.attachmentTexts.length} extracted attachment text file(s)`
      : "",
    issue.subtasks.length > 0 ? `${issue.subtasks.length} subtask key(s)` : "",
  ].filter(Boolean);
  return kinds.length > 0 ? kinds.join("; ") : "summary/status only";
}

function renderEpicEvidenceMap(
  context: DocumentationDryRunContext,
  config: JiraConfig,
): string {
  const issues = getAllEvidenceIssues(context);
  return [
    "| Issue | Type | Status | Parent | Summary | Evidence Considered |",
    "|---|---|---|---|---|---|",
    ...issues.map(
      (issue) =>
        `| [${issue.key}](${issueLink(config, issue.key)}) | ${tableCell(issue.issueType || "type not found")} | ${tableCell(issue.status || "status not found")} | ${tableCell(issue.parentKey ?? "")} | ${tableCell(issue.summary || "summary not found")} | ${tableCell(issueEvidenceKinds(issue))} |`,
    ),
  ].join("\n");
}

function rowsMatching(
  rows: ConfigurationValueRow[],
  pattern: RegExp,
): ConfigurationValueRow[] {
  return rows.filter((row) =>
    pattern.test(`${row.location} ${row.setting} ${row.value} ${row.notes}`),
  );
}

function renderConfigurationRowsByLocation(
  rows: ConfigurationValueRow[],
): string {
  if (rows.length === 0) {
    return "Configuration value evidence was not found.";
  }

  const grouped = new Map<string, ConfigurationValueRow[]>();
  for (const row of rows) {
    const location = row.location || "Reviewed evidence";
    grouped.set(location, [...(grouped.get(location) ?? []), row]);
  }

  return [...grouped.entries()]
    .map(([location, locationRows]) =>
      [
        `### ${location}`,
        "",
        "| Setting | Value / Selection | Notes |",
        "|---|---|---|",
        ...locationRows.map(
          (row) =>
            `| ${tableCell(row.setting)} | ${tableCell(row.value)} | ${tableCell(row.notes)} |`,
        ),
      ].join("\n"),
    )
    .join("\n\n");
}

function splitEvidenceSteps(value: string): string[] {
  return uniqueStrings(
    value
      .split(/\s*;\s*/)
      .map(cleanExtractedItem)
      .filter(isUsefulExtractedItem),
  );
}

function renderHowToConfigure(
  facts: ReturnType<typeof getContextFacts>,
): string {
  const setupRows = rowsMatching(
    facts.configurationValues,
    /configuration steps|setup steps|where to configure|navigation|navigate|menu|admin|click|edit|save/i,
  );

  if (setupRows.length === 0 && facts.configurationChecklist.length === 0) {
    return "Configuration steps were not found in reviewed evidence.";
  }

  const sections = setupRows.slice(0, 8).map((row) => {
    const steps = splitEvidenceSteps(row.value);
    return [
      `### ${row.location}`,
      "",
      `Setting: ${row.setting}`,
      "",
      ...(steps.length > 0
        ? renderNumberedSteps(steps)
        : renderBullets([row.value || row.notes])),
    ].join("\n");
  });

  if (sections.length === 0) {
    return renderNumberedSteps(facts.configurationChecklist.slice(0, 12)).join(
      "\n",
    );
  }

  return sections.join("\n\n");
}

function extractExampleItems(text: string, maxItems = 8): string[] {
  const lines = text.split(/\r?\n/);
  const examples: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const heading = extractLineHeading(lines[index] ?? "");
    if (!heading || !/\bexample\b/i.test(heading)) {
      continue;
    }

    const details: string[] = [];
    for (const line of lines.slice(index + 1)) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (details.length > 0) {
          break;
        }
        continue;
      }
      if (details.length > 0 && extractLineHeading(trimmed)) {
        break;
      }
      if (trimmed.startsWith("|") || isHorizontalRule(trimmed)) {
        continue;
      }
      const item = cleanExtractedItem(trimmed);
      if (isUsefulExtractedItem(item)) {
        details.push(item);
      }
      if (details.length >= 4) {
        break;
      }
    }

    examples.push(
      details.length > 0 ? `${heading}: ${details.join("; ")}` : heading,
    );
    if (examples.length >= maxItems) {
      break;
    }
  }

  return uniqueStrings(examples);
}

function renderConfigurationExamples(
  facts: ReturnType<typeof getContextFacts>,
): string {
  const examples = extractExampleItems(facts.sourceText, 8);
  return examples.length > 0
    ? renderBullets(examples).join("\n")
    : "Configuration examples were not found in reviewed evidence.";
}

function renderVerificationEvidence(
  facts: ReturnType<typeof getContextFacts>,
): string {
  const testRows = rowsMatching(
    facts.configurationValues,
    /test|testing|verification|validate|validation|coverage/i,
  ).map((row) => `${row.location} / ${row.setting}: ${row.value}`);
  const items = uniqueStrings([...facts.validationAreas, ...testRows]).slice(
    0,
    18,
  );
  return items.length > 0
    ? renderBullets(items).join("\n")
    : "Verification or test-case evidence was not found in reviewed evidence.";
}

function extractMarkdownTableAfterHeading(
  text: string,
  headings: string[],
): string | null {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) =>
    headings.some((heading) => lineMatchesSectionHeading(line, heading)),
  );
  if (headingIndex < 0) {
    return null;
  }

  const tableLines: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (tableLines.length > 0) {
        break;
      }
      continue;
    }
    if (tableLines.length > 0 && extractLineHeading(trimmed)) {
      break;
    }
    if (trimmed.startsWith("|")) {
      tableLines.push(trimmed);
      continue;
    }
    if (tableLines.length > 0) {
      break;
    }
  }

  return tableLines.length >= 2 ? tableLines.join("\n") : null;
}

function renderBehaviorMatrix(
  facts: ReturnType<typeof getContextFacts>,
): string {
  const sourceTable = extractMarkdownTableAfterHeading(facts.sourceText, [
    "Behavior Matrix",
    "Combined Behavior Matrix",
  ]);
  if (sourceTable) {
    return sourceTable;
  }

  const rows = rowsMatching(
    facts.configurationValues,
    /behavior matrix|enabled|disabled|toggle|checkbox|revision|state/i,
  );
  return rows.length > 0
    ? renderConfigurationRowsByLocation(rows)
    : "Behavior matrix evidence was not found.";
}

function renderRollbackAndTroubleshooting(
  facts: ReturnType<typeof getContextFacts>,
): string {
  const items = uniqueStrings([
    ...facts.troubleshootingItems,
    ...facts.failureItems,
    ...facts.knownItems,
  ]).slice(0, 12);
  return items.length > 0
    ? renderBullets(items).join("\n")
    : "Rollback or troubleshooting evidence was not found in reviewed evidence.";
}

function renderConfigurationGuideDraft(
  context: DocumentationDryRunContext,
  config: JiraConfig,
): string {
  const facts = getContextFacts(context);
  const allIssues = getAllEvidenceIssues(context);

  return [
    `# ${context.epic?.summary || context.target.summary || "Configuration Guide"}`,
    "",
    `Template: ${context.template.definition.templateTitle} (Confluence page ${context.template.definition.confluencePageId}, version ${context.template.definition.confluenceVersion})`,
    `Document type: ${context.template.definition.documentTypeLabel}`,
    `Source: [${context.target.key}](${issueLink(config, context.target.key)})`,
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Overview",
    "",
    renderGenericOverview(context, facts),
    "",
    "## Feature / Configuration Areas",
    "",
    facts.capabilities.length > 0
      ? renderBullets(facts.capabilities).join("\n")
      : "Feature/story summaries were not found in reviewed evidence.",
    "",
    "## Epic Evidence Map",
    "",
    renderEpicEvidenceMap(context, config),
    "",
    "## What It Affects",
    "",
    renderConfigurationTable(facts),
    "",
    "## Configuration Details",
    "",
    renderConfigurationRowsByLocation(facts.configurationValues),
    "",
    "## Behavior Matrix",
    "",
    renderBehaviorMatrix(facts),
    "",
    "## How to Configure",
    "",
    renderHowToConfigure(facts),
    "",
    "## Configuration Examples",
    "",
    renderConfigurationExamples(facts),
    "",
    "## Verification & Testing",
    "",
    renderVerificationEvidence(facts),
    "",
    "## Rollback & Troubleshooting",
    "",
    renderRollbackAndTroubleshooting(facts),
    "",
    "## Screenshot",
    "",
    "Screenshot evidence was not found in the reviewed evidence. Capture a sanitized screenshot from the target environment before publication.",
    "",
    "## Related Articles",
    "",
    renderRelatedArticles(context, config),
    "",
    "## Evidence Reviewed",
    "",
    renderEvidenceSummary(context, allIssues),
    "",
    "## Gaps / Not Found",
    "",
    renderGenericSection(context, config, facts, "Gaps / Not Found"),
    "",
  ].join("\n");
}

function renderReleaseNoteTable(
  context: DocumentationDryRunContext,
  facts: ReturnType<typeof getContextFacts>,
): string {
  const overview = renderGenericOverview(context, facts);
  const summaryOfChange =
    extractParagraphAfterHeading(facts.sourceText, [
      "Summary of the Approach",
      "Value of the Enhancement",
      "Executive Summary",
      "Overview",
    ]) ??
    (facts.keyHighlights.length > 0
      ? facts.keyHighlights.join("; ")
      : "summary of change not found in reviewed evidence");
  return [
    "| Field | Draft Value |",
    "|---|---|",
    `| Jira Epic | ${tableCell(context.epic?.key ?? "epic not found")} |`,
    `| Title | ${tableCell(facts.title)} |`,
    `| Code Release | ${tableCell(joinOrNotFound(facts.fixVersions, "code release"))} |`,
    "| Type | Enhancement |",
    "| Strategic Theme | strategic theme not found in reviewed evidence |",
    "| Initiative | initiative not found in reviewed evidence |",
    `| Business Problem | ${tableCell(overview)} |`,
    `| Summary of Change | ${tableCell(summaryOfChange)} |`,
    `| User Impact | ${tableCell(facts.affectedAreas.length > 0 ? `Applies to ${facts.affectedAreas.join(", ")}.` : "user impact not found in reviewed evidence")} |`,
    `| Configuration Impact | ${tableCell(facts.configurationChecklist.length > 0 ? facts.configurationChecklist.slice(0, 5).join("; ") : "configuration impact not found in reviewed evidence")} |`,
    `| Known Limitations | ${tableCell(facts.knownItems.length > 0 ? facts.knownItems.slice(0, 5).join("; ") : "N/A")} |`,
    `| Testing Evidence | ${tableCell(facts.validationAreas.length > 0 ? facts.validationAreas.slice(0, 5).join("; ") : "testing evidence not found in reviewed evidence")} |`,
    "| Related Documentation | See Related Articles. |",
  ].join("\n");
}

function renderSystemSummary(
  facts: ReturnType<typeof getContextFacts>,
): string {
  const authRows = facts.configurationValues.filter((row) => {
    const setting = row.setting.toLowerCase();
    const rowText = `${row.setting} ${row.value} ${row.notes}`;
    return (
      /auth|credential|password|secret|client_id|username|api_key/i.test(
        rowText,
      ) && !/token_url|token_scope|api_url|timeout/i.test(setting)
    );
  });
  return [
    "| Field | Details |",
    "|---|---|",
    `| Integration / System | ${tableCell(facts.title || "system not found in reviewed evidence")} |`,
    `| Direction | ${tableCell(facts.architectureItems.length > 0 ? facts.architectureItems.slice(0, 3).join("; ") : "direction not found in reviewed evidence")} |`,
    `| Protocol / Method | ${tableCell(facts.apiReferences.length > 0 ? facts.apiReferences.slice(0, 4).join("; ") : facts.deploymentItems.length > 0 ? facts.deploymentItems.slice(0, 3).join("; ") : "protocol or method not found in reviewed evidence")} |`,
    `| Authentication | ${tableCell(
      authRows.length > 0
        ? authRows
            .slice(0, 4)
            .map((row) => `${row.setting}: ${row.value}`)
            .join("; ")
        : "authentication evidence not found in reviewed evidence",
    )} |`,
    `| Applicable Solutions | ${tableCell(joinOrNotFound(facts.affectedAreas, "applicable solution"))} |`,
    "| Environment(s) | environment-specific values must be confirmed before publication |",
  ].join("\n");
}

function renderHowItWorks(facts: ReturnType<typeof getContextFacts>): string {
  const flow = extractFirstBulletSection(
    facts.sourceText,
    [
      "Expected Processing Flow:",
      "Processing Flow:",
      "Outbound Flow Details",
      "Inbound Callback Flow Details",
      "How It Works",
    ],
    10,
  );
  return renderNumberedSteps(
    flow.length > 0
      ? flow
      : facts.architectureItems.length > 0
        ? facts.architectureItems
        : facts.capabilities.slice(0, 6),
  ).join("\n");
}

function renderScope(facts: ReturnType<typeof getContextFacts>): string {
  const scopeItems =
    facts.apiReferences.length > 0
      ? facts.apiReferences.slice(0, 8)
      : facts.keyHighlights.length > 0
        ? facts.keyHighlights
        : facts.capabilities.slice(0, 6);
  return [
    "### What This Does",
    "",
    ...(scopeItems.length > 0
      ? renderBullets(scopeItems)
      : ["- scope capabilities not found in reviewed evidence"]),
    "",
    "### What This Does Not Do",
    "",
    ...(facts.knownItems.length > 0
      ? renderBullets(facts.knownItems.slice(0, 5))
      : ["- out-of-scope evidence not found in reviewed evidence"]),
  ].join("\n");
}

function renderDeploymentOverview(
  context: DocumentationDryRunContext,
  facts: ReturnType<typeof getContextFacts>,
): string {
  return [
    renderGenericOverview(context, facts),
    "",
    "| Field | Details |",
    "|---|---|",
    `| Service / Component | ${tableCell(facts.title || "service/component not found in reviewed evidence")} |`,
    "| Applicable Environments | environment-specific values must be confirmed before publication |",
    "| Runbook Owner | owner not found in reviewed evidence |",
    "| Last Reviewed | generation timestamp |",
    `| Linked Epic / Release | ${tableCell(context.epic?.key ?? "epic not found")} / ${tableCell(joinOrNotFound(facts.fixVersions, "release"))} |`,
  ].join("\n");
}

function renderTerraformOverview(
  context: DocumentationDryRunContext,
  facts: ReturnType<typeof getContextFacts>,
): string {
  return [
    renderGenericOverview(context, facts),
    "",
    "| Field | Details |",
    "|---|---|",
    `| Infrastructure / Service | ${tableCell(facts.title || "infrastructure/service not found in reviewed evidence")} |`,
    "| Applicable Environments | environment-specific values must be confirmed before publication |",
    "| AWS Region(s) | region not found in reviewed evidence |",
    "| Owner / Team | owner/team not found in reviewed evidence |",
    "| Repository Location | repository path not found in reviewed evidence |",
    "| Last Reviewed | generation timestamp |",
  ].join("\n");
}

function renderGenericSection(
  context: DocumentationDryRunContext,
  config: JiraConfig,
  facts: ReturnType<typeof getContextFacts>,
  heading: string,
): string {
  const label = context.template.definition.documentTypeLabel;
  const configurationItems =
    facts.configurationChecklist.length > 0
      ? facts.configurationChecklist
      : [
          "Confirm feature enablement and required permissions.",
          "Confirm member or environment data required by the selected workflow.",
          "Confirm fallback, retry, and validation behavior where applicable.",
        ];

  if (heading === "Internal Use Only") {
    return "This document is for internal use only. Do not share externally.";
  }
  if (heading === "Overview") {
    if (label === "DOC-TYPE-DEPLOYMENT-RUNBOOK") {
      return renderDeploymentOverview(context, facts);
    }
    if (label === "DOC-TYPE-TERRAFORM") {
      return renderTerraformOverview(context, facts);
    }
    return renderGenericOverview(context, facts);
  }
  if (heading === "Version Number - Feature Title") {
    return renderReleaseNoteTable(context, facts);
  }
  if (heading === "Where It Appears") {
    return renderWhereItAppears(facts);
  }
  if (heading === "What It Affects") {
    return renderConfigurationTable(facts);
  }
  if (heading === "What It Does") {
    const items =
      facts.keyHighlights.length > 0 ? facts.keyHighlights : facts.capabilities;
    return (
      items.length > 0
        ? renderBullets(items.slice(0, 8))
        : ["- capabilities not found in reviewed evidence"]
    ).join("\n");
  }
  if (heading === "Screenshot") {
    return "Screenshot evidence was not found in the reviewed evidence. Capture a sanitized screenshot from the target environment before publication.";
  }
  if (heading === "System Summary") {
    return renderSystemSummary(facts);
  }
  if (heading === "How It Works") {
    return renderHowItWorks(facts);
  }
  if (heading === "Scope") {
    return renderScope(facts);
  }
  if (heading === "Configuration") {
    if (
      label === "DOC-TYPE-API" &&
      facts.apiReferences.length > 0 &&
      facts.configurationValues.length > 0
    ) {
      return [
        ...renderBullets(configurationItems.slice(0, 8)),
        "",
        "Referenced service paths and API surfaces:",
        "",
        ...renderBullets(facts.apiReferences.slice(0, 8)),
      ].join("\n");
    }
    return renderBullets(configurationItems).join("\n");
  }
  if (heading === "Backward Compatibility") {
    return "Backward compatibility impact was not found in reviewed evidence.";
  }
  if (heading === "FAQs") {
    return "- FAQ evidence was not found in reviewed evidence.";
  }
  if (heading === "Error Handling" || heading === "Troubleshooting") {
    const errorItems =
      heading === "Troubleshooting" && facts.troubleshootingItems.length > 0
        ? facts.troubleshootingItems
        : facts.failureItems.length > 0
          ? facts.failureItems
          : facts.knownItems;
    return (
      errorItems.length > 0
        ? renderBullets(errorItems)
        : ["- error-handling evidence not found in reviewed evidence"]
    ).join("\n");
  }
  if (heading === "Prerequisites") {
    return renderChecklist(
      facts.prerequisites.length > 0
        ? facts.prerequisites
        : [
            "Required access and permissions confirmed",
            "Dependencies and upstream configuration confirmed",
            "Release approval or operational readiness confirmed",
          ],
    ).join("\n");
  }
  if (heading === "Pre-Deployment Checklist") {
    const checklist = uniqueStrings([
      ...facts.prerequisites.slice(0, 5),
      ...configurationItems.slice(0, 4),
      "Rollback or restore path identified",
      "Monitoring and validation plan identified",
    ]);
    return renderChecklist(checklist.slice(0, 10)).join("\n");
  }
  if (heading === "Deployment Steps" || heading === "Deployment") {
    const steps =
      facts.deploymentItems.length > 0
        ? facts.deploymentItems
        : configurationItems;
    return renderNumberedSteps(steps.slice(0, 10)).join("\n");
  }
  if (heading === "Verification") {
    return (
      facts.validationAreas.length > 0
        ? renderBullets(facts.validationAreas)
        : ["- verification evidence not found in reviewed evidence"]
    ).join("\n");
  }
  if (heading === "Rollback Procedure") {
    return "Rollback procedure evidence was not found in reviewed evidence.";
  }
  if (heading === "Known Issues") {
    return facts.knownItems.length > 0
      ? renderBullets(facts.knownItems).join("\n")
      : "N/A";
  }
  if (heading === "Contacts") {
    return "Owner, release manager, support handoff, and escalation contacts were not found in reviewed evidence.";
  }
  if (heading === "Architecture") {
    return (
      facts.architectureItems.length > 0
        ? renderBullets(facts.architectureItems)
        : ["- architecture evidence not found in reviewed evidence"]
    ).join("\n");
  }
  if (heading === "Variables") {
    const rows = facts.configurationValues.filter((row) =>
      /variable|parameter|setting|env|config|key|secret|token|url|path/i.test(
        `${row.location} ${row.setting}`,
      ),
    );
    if (rows.length === 0) {
      return "Variable evidence was not found in reviewed evidence.";
    }
    return [
      "| Variable / Setting | Value / Type | Location | Notes |",
      "|---|---|---|---|",
      ...rows
        .slice(0, 25)
        .map(
          (row) =>
            `| ${tableCell(row.setting)} | ${tableCell(row.value)} | ${tableCell(row.location)} | ${tableCell(row.notes)} |`,
        ),
    ].join("\n");
  }
  if (heading === "Resources Managed") {
    return (
      facts.architectureItems.length > 0
        ? renderBullets(facts.architectureItems.slice(0, 8))
        : ["- Terraform resources managed not found in reviewed evidence"]
    ).join("\n");
  }
  if (heading === "Tagging") {
    return "Tagging requirements were not found in reviewed evidence.";
  }
  if (heading === "Trigger") {
    return (
      context.target.summary ||
      "trigger evidence not found in reviewed evidence"
    );
  }
  if (heading === "Quick Checks") {
    const checks = uniqueStrings([
      ...configurationItems.slice(0, 6),
      ...facts.failureItems.slice(0, 4),
    ]);
    return renderChecklist(checks.slice(0, 10)).join("\n");
  }
  if (heading === "Resolution Steps") {
    const steps = uniqueStrings([
      ...configurationItems.slice(0, 6),
      ...facts.troubleshootingItems.slice(0, 4),
      ...facts.validationAreas.slice(0, 4),
    ]);
    return renderNumberedSteps(steps.slice(0, 10)).join("\n");
  }
  if (heading === "Escalation") {
    return [
      "Escalate with the issue key, member/case or environment details, configuration state, attempted checks, observed result, logs or screenshots, timestamps, and owner handoff.",
      facts.knownItems.length > 0
        ? renderBullets(facts.knownItems.slice(0, 6)).join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  if (heading === "Related Articles") {
    return renderRelatedArticles(context, config);
  }
  if (heading === "Evidence Reviewed") {
    return renderEvidenceSummary(context, facts.allIssues);
  }
  if (heading === "Gaps / Not Found") {
    const gaps = [
      ...context.gaps,
      ...(facts.knownItems.length > 0 ? facts.knownItems : []),
    ];
    return gaps.length > 0
      ? renderBullets(uniqueStrings(gaps)).join("\n")
      : "- No deterministic gaps found in dry run.";
  }

  return `${heading} content was not deterministically generated from reviewed evidence.`;
}

function renderGenericDraft(
  context: DocumentationDryRunContext,
  config: JiraConfig,
): string {
  const facts = getContextFacts(context);

  const sectionMarkdown = context.template.sections
    .filter((section) => section.level === 2)
    .map(
      (section) =>
        `## ${section.heading}\n\n${renderGenericSection(
          context,
          config,
          facts,
          section.heading,
        )}`,
    )
    .join("\n\n");

  return [
    `# ${context.target.summary || context.template.definition.templateTitle}`,
    "",
    `Template: ${context.template.definition.templateTitle} (Confluence page ${context.template.definition.confluencePageId}, version ${context.template.definition.confluenceVersion})`,
    `Document type: ${context.template.definition.documentTypeLabel}`,
    `Source: [${context.target.key}](${issueLink(config, context.target.key)})`,
    `Generated at: ${new Date().toISOString()}`,
    "",
    "## Epic Evidence Map",
    "",
    renderEpicEvidenceMap(context, config),
    "",
    sectionMarkdown,
    "",
  ].join("\n");
}

function renderDryRunMarkdown(
  context: DocumentationDryRunContext,
  config: JiraConfig,
): string {
  if (
    context.template.definition.documentTypeLabel === "DOC-TYPE-TROUBLESHOOTING"
  ) {
    return renderTroubleshootingDraft(context, config);
  }
  if (context.template.definition.documentTypeLabel === "DOC-TYPE-CONFIG") {
    return renderConfigurationGuideDraft(context, config);
  }
  return renderGenericDraft(context, config);
}

export function renderDryRunMarkdownForTest(
  context: DocumentationDryRunContext,
  config: JiraConfig,
): string {
  return renderDryRunMarkdown(context, config);
}

function markdownReviewSignals(markdown: string): string[] {
  const signals: string[] = [];

  if (/not found in reviewed evidence/i.test(markdown)) {
    signals.push(
      "One or more template fields could not be filled from reviewed Jira evidence.",
    );
  }
  if (/must be confirmed before publication/i.test(markdown)) {
    signals.push(
      "Environment-specific values or ownership details must be confirmed before publication.",
    );
  }
  if (/Screenshot evidence was not found/i.test(markdown)) {
    signals.push("Screenshot evidence must be added before publication.");
  }
  if (/FAQ evidence was not found/i.test(markdown)) {
    signals.push("FAQ content was not found in reviewed evidence.");
  }
  if (/Backward compatibility impact was not found/i.test(markdown)) {
    signals.push(
      "Backward compatibility impact was not found in reviewed evidence.",
    );
  }
  if (/Rollback procedure evidence was not found/i.test(markdown)) {
    signals.push("Rollback procedure evidence was not found.");
  }
  if (
    /Owner, release manager, support handoff, and escalation contacts were not found/i.test(
      markdown,
    )
  ) {
    signals.push("Owner and escalation contacts were not found.");
  }

  return signals;
}

function buildHumanReviewSummary(
  context: DocumentationDryRunContext,
  markdown: string,
  extraReviewReasons: string[] = [],
): DocumentationHumanReviewSummary {
  const facts = getContextFacts(context);
  const explicitGaps =
    context.template.definition.documentTypeLabel === "DOC-TYPE-TROUBLESHOOTING"
      ? deriveTroubleshootingGaps(context)
      : uniqueStrings([...context.gaps, ...facts.knownItems]);
  const reasons = uniqueStrings([
    ...explicitGaps,
    ...markdownReviewSignals(markdown),
    ...extraReviewReasons,
  ]).slice(0, 12);
  const humanReviewRequired = reasons.length > 0;
  const documentName =
    context.template.definition.sourceMatrixTask ||
    context.template.definition.templateTitle;

  return {
    humanReviewRequired,
    readiness: humanReviewRequired
      ? "review_required"
      : "ready_for_publish_review",
    reasons,
    recommendedJiraSummary: humanReviewRequired
      ? `${context.target.key} ${documentName} draft generated; human review required before publish (${reasons.length} open item${
          reasons.length === 1 ? "" : "s"
        }).`
      : `${context.target.key} ${documentName} draft generated; no deterministic evidence gaps found.`,
    recommendedNextAction: humanReviewRequired
      ? `Review the generated Markdown and resolve or accept the listed evidence gaps in Jira. The ticket has been moved to ${DOCS_BLOCKED_LABEL}; add ${DOCS_REPLAN_LABEL} to regenerate once the gaps are addressed.`
      : "Review formatting and business accuracy, then proceed with the normal documentation publish flow.",
  };
}

function renderJiraSummaryMarkdown(input: {
  context: DocumentationDryRunContext;
  config: JiraConfig;
  allIssues: DocumentationDryRunIssue[];
  reviewSummary: DocumentationHumanReviewSummary;
  markdownPath: string;
  summaryPath: string;
}): string {
  const {
    context,
    config,
    allIssues,
    reviewSummary,
    markdownPath,
    summaryPath,
  } = input;
  const commentCount = allIssues.reduce(
    (sum, issue) => sum + issue.commentCount,
    0,
  );
  const attachmentCount = allIssues.reduce(
    (sum, issue) => sum + issue.attachmentCount,
    0,
  );
  const extractedAttachmentCount = allIssues.reduce(
    (sum, issue) => sum + issue.attachmentTexts.length,
    0,
  );

  return [
    `# OneShot Documentation Generation Summary`,
    "",
    `Target: [${context.target.key}](${issueLink(config, context.target.key)})`,
    `Document type: ${context.template.definition.documentTypeLabel}`,
    `Template: ${context.template.definition.templateTitle}`,
    `Human review required: ${reviewSummary.humanReviewRequired ? "Yes" : "No"}`,
    `Readiness: ${reviewSummary.readiness}`,
    "",
    "## Recommended Jira Summary",
    "",
    reviewSummary.recommendedJiraSummary,
    "",
    "## Next Action",
    "",
    reviewSummary.recommendedNextAction,
    "",
    "## Evidence Counts",
    "",
    `- Issues reviewed: ${allIssues.length}`,
    `- Epic children reviewed: ${context.epicChildren.length}`,
    `- Subtask/task issues reviewed: ${context.subtaskIssues.length}`,
    `- Comments reviewed: ${commentCount}`,
    `- Attachments reviewed: ${attachmentCount}`,
    `- Extracted attachment text files: ${extractedAttachmentCount}`,
    "",
    "## Human Review Reasons",
    "",
    reviewSummary.reasons.length > 0
      ? renderBullets(reviewSummary.reasons).join("\n")
      : "- No deterministic human-review blockers found.",
    "",
    "## Local Artifacts",
    "",
    `- Markdown: ${markdownPath}`,
    `- Summary JSON: ${summaryPath}`,
    "",
  ].join("\n");
}

interface DocumentationMarkdownResult {
  markdown: string;
  /** Whether LLM synthesis was attempted for this document. */
  synthesisAttempted: boolean;
  /**
   * Extra human-review reasons derived independently of prose: unsupported
   * model claims, missing required sections, missing/invalid citations, or a
   * synthesis failure. Nonempty forces DOCS-BLOCKED even if the prose looks
   * complete, closing the gap where invented prose erases deterministic gap
   * phrases.
   */
  synthesisReviewReasons: string[];
}

/**
 * Produce the documentation Markdown. When synthesis is disabled (default),
 * this is exactly the deterministic assembler and no synthesis reasons apply.
 *
 * When synthesis is enabled, generate via the real generation prompts and an
 * LLM, then validate the result independently of its prose. Any of the
 * following forces human review (DOCS-BLOCKED):
 *  - the model reported unsupported claims,
 *  - required template sections/citations are missing or citations are invalid,
 *  - synthesis failed (Bedrock/prompt/schema error).
 *
 * On synthesis failure we still fall back to the deterministic draft so the
 * artifact is usable, but we do NOT let it reach a clean DOCS-GENERATED
 * terminal state — deterministic quality is the reported defect, so a silent
 * fallback to a "successful" result would mask it.
 */
async function buildDocumentationMarkdown(
  context: DocumentationDryRunContext,
  config: JiraConfig,
): Promise<DocumentationMarkdownResult> {
  const deterministicDraft = renderDryRunMarkdown(context, config);
  if (!isDocumentationSynthesisEnabled()) {
    return {
      markdown: deterministicDraft,
      synthesisAttempted: false,
      synthesisReviewReasons: [],
    };
  }

  try {
    const result = await synthesizeDocumentationMarkdown({
      jiraKey: context.target.key,
      epicKey: context.epic?.key ?? null,
      documentTypeLabel: context.template.definition.documentTypeLabel,
      templateKey: context.template.definition.key,
      templateTitle: context.template.definition.templateTitle,
      templateMarkdown: context.template.markdown,
      deterministicDraft,
      evidenceBlocks: buildEvidenceBlocks(context),
    });
    const synthesisReviewReasons = validateSynthesizedDocument({
      markdown: result.markdown,
      requiredHeadings: context.template.definition.requiredHeadings,
      unsupportedClaims: result.unsupportedClaims,
      sectionEvidence: result.sectionEvidence,
      citedEvidenceIds: result.citedEvidenceIds,
      availableEvidenceIds: result.availableEvidenceIds,
    });
    return {
      markdown: result.markdown,
      synthesisAttempted: true,
      synthesisReviewReasons,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `Documentation synthesis failed for ${context.target.key}; ` +
        `falling back to deterministic draft (routing to human review): ${message}`,
    );
    return {
      markdown: deterministicDraft,
      synthesisAttempted: true,
      synthesisReviewReasons: [
        `Documentation synthesis failed (${message}); deterministic draft attached for human review.`,
      ],
    };
  }
}

async function writeDryRunOutput(
  context: DocumentationDryRunContext,
  outputDir: string,
  config: JiraConfig,
): Promise<DocumentationDryRunOutput> {
  const { markdown, synthesisReviewReasons } = await buildDocumentationMarkdown(
    context,
    config,
  );
  await fs.mkdir(outputDir, { recursive: true });

  const markdownPath = path.join(
    outputDir,
    `${context.target.key}-${context.template.definition.key}.md`,
  );
  const summaryPath = path.join(
    outputDir,
    `${context.target.key}-summary.json`,
  );
  const jiraSummaryPath = path.join(
    outputDir,
    `${context.target.key}-jira-summary.md`,
  );

  const allIssues = uniqueByKey([
    context.target,
    context.documentationStory,
    ...(context.epic ? [context.epic] : []),
    ...context.epicChildren,
    ...context.subtaskIssues,
  ]);
  const reviewSummary = buildHumanReviewSummary(
    context,
    markdown,
    synthesisReviewReasons,
  );

  await fs.writeFile(markdownPath, markdown, "utf8");
  await fs.writeFile(
    jiraSummaryPath,
    renderJiraSummaryMarkdown({
      context,
      config,
      allIssues,
      reviewSummary,
      markdownPath,
      summaryPath,
    }),
    "utf8",
  );
  await fs.writeFile(
    summaryPath,
    JSON.stringify(
      {
        target: context.target,
        documentationStory: context.documentationStory,
        epic: context.epic,
        template: {
          key: context.template.definition.key,
          title: context.template.definition.templateTitle,
          documentTypeLabel: context.template.definition.documentTypeLabel,
          confluencePageId: context.template.definition.confluencePageId,
          confluenceVersion: context.template.definition.confluenceVersion,
          contentHash: context.template.contentHash,
        },
        evidenceCounts: {
          issues: allIssues.length,
          epicChildren: context.epicChildren.length,
          subtaskIssues: context.subtaskIssues.length,
          comments: allIssues.reduce(
            (sum, issue) => sum + issue.commentCount,
            0,
          ),
          attachments: allIssues.reduce(
            (sum, issue) => sum + issue.attachmentCount,
            0,
          ),
          extractedTextAttachments: allIssues.reduce(
            (sum, issue) => sum + issue.attachmentTexts.length,
            0,
          ),
        },
        evidenceIndex: allIssues.map((issue) => ({
          key: issue.key,
          summary: issue.summary,
          issueType: issue.issueType,
          status: issue.status,
          parentKey: issue.parentKey,
          commentCount: issue.commentCount,
          attachmentCount: issue.attachmentCount,
          extractedAttachmentTextFiles: issue.attachmentTexts.map(
            (attachment) => attachment.filename,
          ),
        })),
        humanReview: reviewSummary,
        gaps:
          context.template.definition.documentTypeLabel ===
          "DOC-TYPE-TROUBLESHOOTING"
            ? deriveTroubleshootingGaps(context)
            : context.gaps,
        outputs: {
          markdownPath,
          summaryPath,
          jiraSummaryPath,
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  return { markdownPath, summaryPath, jiraSummaryPath, reviewSummary };
}

function contentTypeForDocumentationOutput(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".md" || extension === ".markdown") {
    return "text/markdown";
  }
  if (extension === ".json") {
    return "application/json";
  }
  return "text/plain";
}

function renderJiraAttachmentComment(
  context: DocumentationDryRunContext,
  output: DocumentationDryRunOutput,
  attachmentFiles: {
    attachedFilenames: string[];
    skippedFilenames: string[];
  },
): string {
  const attachedLines =
    attachmentFiles.attachedFilenames.length > 0
      ? attachmentFiles.attachedFilenames.map((filename) => `- ${filename}`)
      : ["- none"];
  const skippedLines =
    attachmentFiles.skippedFilenames.length > 0
      ? [
          "",
          "Skipped files:",
          ...attachmentFiles.skippedFilenames.map(
            (filename) => `- ${filename}`,
          ),
        ]
      : [];
  return [
    "OneShot documentation artifacts generated for this ticket.",
    "",
    `Document type: ${context.template.definition.documentTypeLabel}`,
    `Template: ${context.template.definition.templateTitle}`,
    `Human review: ${
      output.reviewSummary.humanReviewRequired
        ? `${output.reviewSummary.reasons.length} item(s) required`
        : "no deterministic blockers found"
    }`,
    "",
    "Attached files:",
    ...attachedLines,
    ...skippedLines,
    "",
    "Jira summary:",
    output.reviewSummary.recommendedJiraSummary,
    "",
    ...(output.reviewSummary.humanReviewRequired
      ? [
          `This ticket has been moved to ${DOCS_BLOCKED_LABEL} (review required); ${DOCS_IN_PROGRESS_LABEL} was removed.`,
          `After resolving or accepting the open items, add the ${DOCS_REPLAN_LABEL} label to regenerate.`,
          "",
        ]
      : []),
    `Next action: ${output.reviewSummary.recommendedNextAction}`,
  ].join("\n");
}

export function renderJiraAttachmentCommentForTest(
  context: DocumentationDryRunContext,
  output: DocumentationDryRunOutput,
  attachmentFiles: {
    attachedFilenames: string[];
    skippedFilenames: string[];
  },
): string {
  return renderJiraAttachmentComment(context, output, attachmentFiles);
}

/**
 * Decides whether the terminal DOCS-GENERATED label may be applied when
 * attaching artifacts to Jira. A draft flagged for human review must NOT be
 * marked as terminally generated/published — it stays queued for review.
 */
function shouldApplyGeneratedLabel(
  reviewSummary: DocumentationHumanReviewSummary,
): boolean {
  return !reviewSummary.humanReviewRequired;
}

export function shouldApplyGeneratedLabelForTest(
  reviewSummary: DocumentationHumanReviewSummary,
): boolean {
  return shouldApplyGeneratedLabel(reviewSummary);
}

export function buildHumanReviewSummaryForTest(
  context: DocumentationDryRunContext,
  markdown: string,
  extraReviewReasons: string[] = [],
): DocumentationHumanReviewSummary {
  return buildHumanReviewSummary(context, markdown, extraReviewReasons);
}

export function buildEvidenceBlocksForTest(
  context: DocumentationDryRunContext,
): DocsEvidenceBlock[] {
  return buildEvidenceBlocks(context);
}

async function attachDocumentationOutputToJira(
  context: DocumentationDryRunContext,
  output: DocumentationDryRunOutput,
  jiraConfig: JiraConfig,
  addJiraComment: boolean,
): Promise<DocumentationJiraAttachmentResult> {
  const jiraClient = createJiraClient({ ...jiraConfig, downloadImages: false });
  const mutationsDisabled = jiraMutationsDisabled();
  const files = [
    output.markdownPath,
    output.jiraSummaryPath,
    output.summaryPath,
  ];
  const requestedFilenames: string[] = [];
  const filenames: string[] = [];
  const skippedFilenames: string[] = [];

  for (const filePath of files) {
    const filename = path.basename(filePath);
    requestedFilenames.push(filename);
    const content = await fs.readFile(filePath, "utf8");
    const attachResult = await jiraClient.attachFileToIssue(
      context.target.key,
      filename,
      content,
      contentTypeForDocumentationOutput(filePath),
    );
    if (attachResult.status === "attached") {
      filenames.push(filename);
    } else {
      skippedFilenames.push(filename);
    }
  }

  const commentId = addJiraComment
    ? (
        await jiraClient.addComment(
          context.target.key,
          renderJiraAttachmentComment(context, output, {
            attachedFilenames: filenames,
            skippedFilenames,
          }),
        )
      ).id
    : null;

  // Terminal-label transition. Every processed ticket must reach a terminal
  // state and drop DOCS-IN-PROGRESS, because the poller excludes
  // DOCS-IN-PROGRESS from selection. Leaving it in place strands the ticket:
  // it can neither be treated as published nor re-selected on a later poll.
  //
  // - Passed the deterministic evidence check -> DOCS-GENERATED.
  // - Requires human review -> DOCS-BLOCKED (review-required terminal). Draft
  //   artifacts are still attached so a reviewer can inspect them; the reviewer
  //   resolves the gaps and adds DOCS-REPLAN to regenerate (mirrors the
  //   PFOS-REPLAN regeneration path).
  const generatedLabelApplied = shouldApplyGeneratedLabel(output.reviewSummary);
  let reviewRequiredLabelApplied = false;
  if (generatedLabelApplied) {
    await jiraClient.updateIssueLabels(context.target.key, {
      add: [DOCS_GENERATED_LABEL],
      remove: [DOCS_IN_PROGRESS_LABEL],
    });
  } else {
    await jiraClient.updateIssueLabels(context.target.key, {
      add: [DOCS_BLOCKED_LABEL],
      remove: [DOCS_IN_PROGRESS_LABEL],
    });
    reviewRequiredLabelApplied = true;
  }

  return {
    requestedFilenames,
    filenames,
    skippedFilenames,
    commentId: mutationsDisabled ? null : commentId,
    generatedLabelAdded: !mutationsDisabled && generatedLabelApplied,
    reviewRequiredLabelAdded: !mutationsDisabled && reviewRequiredLabelApplied,
    mutationsDisabled,
  };
}

async function recordDocumentationArtifactRun(
  context: DocumentationDryRunContext,
  output: DocumentationDryRunOutput,
  attachmentResult: DocumentationJiraAttachmentResult | null,
): Promise<void> {
  if (!isDocumentationArtifactRunRecordingEnabled()) {
    return;
  }

  const db = new Database();
  try {
    await db.connect();
    await db.upsertOneShotArtifactRun({
      sourceKey: context.target.key,
      sourceParentKey: context.documentationStory.key,
      mode: "documentation",
      status: output.reviewSummary.humanReviewRequired
        ? "review_required"
        : attachmentResult
          ? "generated"
          : "dry_run_complete",
      title:
        context.target.summary || context.template.definition.templateTitle,
      generatedCount: 1,
      generatedTickets: [
        {
          key: context.target.key,
          title: context.target.summary,
          kind: context.template.definition.documentTypeLabel,
          status: context.target.status,
        },
      ],
      humanReviewRequired: output.reviewSummary.humanReviewRequired,
      humanReviewCount: output.reviewSummary.reasons.length,
      reviewItems: output.reviewSummary.reasons,
      evidence: {
        documentTypeLabel: context.template.definition.documentTypeLabel,
        documentationStory: context.documentationStory.key,
        parentEpic: context.epic?.key ?? null,
        epicChildrenReviewed: context.epicChildren.length,
        subtaskIssuesReviewed: context.subtaskIssues.length,
      },
      artifactRefs: {
        markdownPath: output.markdownPath,
        summaryPath: output.summaryPath,
        jiraSummaryPath: output.jiraSummaryPath,
        jiraAttachments: attachmentResult?.mutationsDisabled
          ? []
          : (attachmentResult?.filenames ?? []),
        jiraAttachmentsRequested: attachmentResult?.requestedFilenames ?? [],
        jiraAttachmentsSkipped: attachmentResult?.skippedFilenames ?? [],
        jiraCommentId: attachmentResult?.commentId ?? null,
        jiraGeneratedLabelAdded: attachmentResult?.generatedLabelAdded ?? false,
        jiraMutationsDisabled: attachmentResult?.mutationsDisabled ?? false,
      },
      jiraSummary: output.reviewSummary.recommendedJiraSummary,
      completedAt: new Date(),
    });
  } catch (error) {
    console.warn(
      `Could not record OneShot documentation artifact run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    await db.disconnect().catch(() => undefined);
  }
}

export async function runDocumentationArtifactForIssue(input: {
  issueKey: string;
  outputDir?: string;
  attachToJira?: boolean;
  addJiraComment?: boolean;
  ignoreTerminalLabels?: boolean;
  jiraConfig?: JiraConfig;
}): Promise<DocumentationArtifactRunResult> {
  if (input.attachToJira && input.ignoreTerminalLabels) {
    throw new Error(
      "--ignore-terminal-labels is only allowed for local documentation dry runs; do not attach duplicate generated artifacts to Jira.",
    );
  }

  const issueKey = input.issueKey.toUpperCase();
  const jiraConfig = input.jiraConfig ?? getJiraConfig();
  const outputDir =
    input.outputDir !== undefined
      ? path.resolve(input.outputDir)
      : defaultDocumentationOutputDir(issueKey);
  const context = await buildDryRunContext(issueKey, jiraConfig, {
    ignoreTerminalLabels: input.ignoreTerminalLabels,
  });
  const output = await writeDryRunOutput(context, outputDir, jiraConfig);
  const attachmentResult = input.attachToJira
    ? await attachDocumentationOutputToJira(
        context,
        output,
        jiraConfig,
        input.addJiraComment ?? true,
      )
    : null;

  await recordDocumentationArtifactRun(context, output, attachmentResult);

  return {
    issueKey,
    templateTitle: context.template.definition.templateTitle,
    documentTypeLabel: context.template.definition.documentTypeLabel,
    documentationStoryKey: context.documentationStory.key,
    parentEpicKey: context.epic?.key ?? null,
    epicChildrenReviewed: context.epicChildren.length,
    subtaskIssuesReviewed: context.subtaskIssues.length,
    markdownPath: output.markdownPath,
    summaryPath: output.summaryPath,
    jiraSummaryPath: output.jiraSummaryPath,
    attachmentResult,
  };
}

async function main(): Promise<void> {
  const {
    issueKey,
    outputDir,
    attachToJira,
    addJiraComment,
    ignoreTerminalLabels,
  } = parseArgs(process.argv.slice(2));
  const result = await runDocumentationArtifactForIssue({
    issueKey,
    outputDir,
    attachToJira,
    addJiraComment,
    ignoreTerminalLabels,
  });

  console.log(
    attachToJira
      ? `OneShot documentation run completed for ${issueKey}`
      : `OneShot documentation dry run completed for ${issueKey}`,
  );
  console.log(`Template: ${result.templateTitle}`);
  console.log(`Document type: ${result.documentTypeLabel}`);
  console.log(`Documentation story: ${result.documentationStoryKey}`);
  console.log(`Parent epic: ${result.parentEpicKey ?? "not found"}`);
  console.log(`Epic children reviewed: ${result.epicChildrenReviewed}`);
  console.log(`Subtask/task issues reviewed: ${result.subtaskIssuesReviewed}`);
  console.log(`Markdown: ${result.markdownPath}`);
  console.log(`Summary: ${result.summaryPath}`);
  console.log(`Jira summary: ${result.jiraSummaryPath}`);
  if (result.attachmentResult) {
    if (result.attachmentResult.mutationsDisabled) {
      console.log(
        `Jira mutations skipped by guard; would attach: ${result.attachmentResult.requestedFilenames.join(", ")}`,
      );
    } else {
      console.log(
        `Jira attachments: ${result.attachmentResult.filenames.join(", ")}`,
      );
    }
    console.log(
      `Jira label added: ${
        result.attachmentResult.generatedLabelAdded
          ? DOCS_GENERATED_LABEL
          : "none"
      }`,
    );
    if (result.attachmentResult.commentId) {
      console.log(`Jira comment: ${result.attachmentResult.commentId}`);
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
