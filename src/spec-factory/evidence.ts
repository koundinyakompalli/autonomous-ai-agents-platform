import type { JiraTicketData } from "../orchestrator/JiraClient.js";
import type { QualifierProfiledRepoSummary } from "../oneshot/qualifier-repo-context.js";
import type { SpecFactoryRepoReferenceManifest } from "./repo-reference.js";
import type { ComposeStory } from "./compose-types.js";

export type EvidenceArtifactKind =
  | "loe_estimate"
  | "code_changes"
  | "config_changes"
  | "raw_requirement"
  | "other";

export interface EvidenceArtifact {
  kind: EvidenceArtifactKind;
  filename: string;
  content: string;
  artifactUri?: string;
  relativePath?: string;
  jiraAttachmentId?: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  s3Bucket?: string | null;
  s3Key?: string | null;
  sha256?: string | null;
  isPriority?: boolean;
  extractionStatus?: string;
}

export interface EvidenceManifest {
  snapshotId?: number;
  sourceJiraKey: string;
  sourceSummary: string;
  sourceStatus: string | null;
  sourceLabels: string[];
  descriptionMarkdown: string;
  loeHours: number | null;
  loeSource: string | null;
  comments: JiraTicketData["comments"];
  artifacts: EvidenceArtifact[];
  repoReferences?: SpecFactoryRepoReferenceManifest;
  repoClassifierContext?: {
    profiledRepos: QualifierProfiledRepoSummary[];
  };
  /** Compose-only: the agreed story breakdown that the draft must honor (one child per story). */
  composeStories?: ComposeStory[];
  warnings: string[];
}

export interface ArchivedEvidenceAttachment {
  jiraAttachmentId: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  s3Bucket: string | null;
  s3Key: string | null;
  sha256: string | null;
  extractedText: string | null;
  extractionStatus: "stored" | "extracted" | "unsupported" | "failed" | "skipped";
  errorMessage?: string | null;
}

type EvidenceComment = JiraTicketData["comments"][number];

const LOE_RANGE_PATTERNS = [
  /\b(?:total\s+)?(?:loe|level\s+of\s+effort|estimated\s+effort|estimate|hours)\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i,
  /\|\s*\*{0,2}total\s+hours\*{0,2}\s*\|\s*(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)?\s*\|\s*(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)?\s*\|/i,
  /\|\s*\*{0,2}total\*{0,2}\s*\|\s*(?:\*{0,2})?(\d+(?:\.\d+)?)(?:\*{0,2})?\s*\|\s*(?:\*{0,2})?(\d+(?:\.\d+)?)(?:\*{0,2})?\s*\|/i,
];

const LOE_PATTERNS = [
  /\b(?:total\s+)?(?:loe|level\s+of\s+effort)\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i,
  /\bestimated\s+effort\s*[:=-]?\s*(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i,
  /\|\s*\*{0,2}total\s+hours\*{0,2}\s*\|\s*(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)?\s*\|/i,
];

export function extractLoeHours(text: string): number | null {
  for (const pattern of LOE_RANGE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match?.[1] || !match?.[2]) continue;

    const low = Number(match[1]);
    const high = Number(match[2]);
    if (Number.isFinite(low) && Number.isFinite(high)) {
      return Math.max(low, high);
    }
  }

  for (const pattern of LOE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;

    const hours = Number(match[1]);
    if (Number.isFinite(hours)) return hours;
  }

  return null;
}

export function artifactKind(filename: string): EvidenceArtifactKind {
  const normalized = filename.toLowerCase();

  if (
    normalized.includes("loe") ||
    normalized.includes("estimate")
  ) {
    return "loe_estimate";
  }
  if (
    normalized.includes("development-plan") ||
    normalized.includes("code-change") ||
    normalized.includes("code_changes")
  ) {
    return "code_changes";
  }
  if (
    normalized.includes("configuration-plan") ||
    normalized.includes("config-change") ||
    normalized.includes("config_changes")
  ) {
    return "config_changes";
  }
  if (normalized.includes("requirement") || normalized.includes("prd")) {
    return "raw_requirement";
  }

  return "other";
}

export function isPriorityLouiseArtifact(
  filename: string,
  sourceJiraKey: string,
): boolean {
  const escapedKey = sourceJiraKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^(Configuration-Plan|Development-Plan|LOE)-${escapedKey}\\.md$`,
    "i",
  ).test(filename.trim());
}

function byNewestCreated(left: EvidenceComment, right: EvidenceComment): number {
  const leftTime = Date.parse(left.created);
  const rightTime = Date.parse(right.created);
  const safeLeftTime = Number.isFinite(leftTime) ? leftTime : 0;
  const safeRightTime = Number.isFinite(rightTime) ? rightTime : 0;

  return safeRightTime - safeLeftTime;
}

function isLouiseComment(comment: EvidenceComment): boolean {
  return comment.author?.toLowerCase().includes("louise") ?? false;
}

function findFirstLoeHours(
  texts: Array<{ text: string; source: string }>,
): { hours: number; source: string } | null {
  for (const { text, source } of texts) {
    const loeHours = extractLoeHours(text);
    if (loeHours !== null) return { hours: loeHours, source };
  }

  return null;
}

function findLoeHours(
  descriptionMarkdown: string,
  comments: EvidenceComment[],
  artifacts: EvidenceArtifact[],
): { hours: number; source: string } | null {
  const loeEstimateArtifacts = artifacts.filter((artifact) => artifact.kind === "loe_estimate");
  const otherArtifacts = artifacts.filter((artifact) => artifact.kind !== "loe_estimate");
  const newestComments = [...comments].sort(byNewestCreated);
  const louiseComments = newestComments.filter(isLouiseComment);
  const otherComments = newestComments.filter((comment) => !isLouiseComment(comment));

  return findFirstLoeHours([
    ...loeEstimateArtifacts.map((artifact) => ({
      text: artifact.content,
      source: `attachment:${artifact.filename}`,
    })),
    ...louiseComments.map((comment) => ({
      text: comment.bodyMarkdown,
      source: `comment:${comment.id}`,
    })),
    ...otherComments.map((comment) => ({
      text: comment.bodyMarkdown,
      source: `comment:${comment.id}`,
    })),
    { text: descriptionMarkdown, source: "description" },
    ...otherArtifacts.map((artifact) => ({
      text: artifact.content,
      source: `attachment:${artifact.filename}`,
    })),
  ]);
}

function missingArtifactWarnings(artifacts: EvidenceArtifact[]): string[] {
  const artifactKinds = new Set(artifacts.map((artifact) => artifact.kind));
  const warnings: string[] = [];

  if (!artifactKinds.has("loe_estimate")) {
    warnings.push("Missing loe-estimate artifact.");
  }
  if (!artifactKinds.has("code_changes")) {
    warnings.push("Missing code-changes artifact.");
  }
  if (!artifactKinds.has("config_changes")) {
    warnings.push("Missing config-changes artifact.");
  }

  return warnings;
}

function artifactsFromArchivedAttachments(
  attachments: ArchivedEvidenceAttachment[],
  sourceJiraKey: string,
): EvidenceArtifact[] {
  return attachments.map((attachment) => {
    const extractedText = attachment.extractedText?.trim();
    const archivedRef =
      attachment.s3Bucket && attachment.s3Key
        ? `Archived attachment: s3://${attachment.s3Bucket}/${attachment.s3Key}`
        : "Attachment archive unavailable.";

    return {
      kind: artifactKind(attachment.filename),
      filename: attachment.filename,
      content: extractedText || archivedRef,
      jiraAttachmentId: attachment.jiraAttachmentId,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      s3Bucket: attachment.s3Bucket,
      s3Key: attachment.s3Key,
      sha256: attachment.sha256,
      isPriority: isPriorityLouiseArtifact(attachment.filename, sourceJiraKey),
      extractionStatus: attachment.extractionStatus,
    };
  });
}

function artifactsFromTicketData(ticketData: JiraTicketData): EvidenceArtifact[] {
  const textAttachments = Array.isArray(ticketData.textAttachments)
    ? ticketData.textAttachments
    : [];

  return textAttachments.map((attachment) => ({
    kind: artifactKind(attachment.filename),
    filename: attachment.filename,
    content: attachment.content,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.size,
    isPriority: isPriorityLouiseArtifact(
      attachment.filename,
      ticketData.issue.key,
    ),
    extractionStatus: "extracted",
  }));
}

export function buildEvidenceManifest(
  ticketData: JiraTicketData,
  options: {
    archivedAttachments?: ArchivedEvidenceAttachment[];
    repoReferences?: SpecFactoryRepoReferenceManifest;
    repoClassifierContext?: EvidenceManifest["repoClassifierContext"];
  } = {},
): EvidenceManifest {
  const descriptionMarkdown =
    typeof ticketData.descriptionMarkdown === "string" ? ticketData.descriptionMarkdown : "";
  const comments = Array.isArray(ticketData.comments) ? ticketData.comments : [];
  const artifacts = options.archivedAttachments
    ? artifactsFromArchivedAttachments(
        options.archivedAttachments,
        ticketData.issue.key,
      )
    : artifactsFromTicketData(ticketData);
  const loe = findLoeHours(descriptionMarkdown, comments, artifacts);
  const warnings = [
    ...missingArtifactWarnings(artifacts),
    ...(options.repoReferences?.warnings ?? []),
  ];

  return {
    sourceJiraKey: ticketData.issue.key,
    sourceSummary: ticketData.issue.fields.summary ?? "",
    sourceStatus: ticketData.issue.fields.status?.name ?? null,
    sourceLabels: ticketData.issue.fields.labels ?? [],
    descriptionMarkdown,
    loeHours: loe?.hours ?? null,
    loeSource: loe?.source ?? null,
    comments,
    artifacts,
    repoReferences: options.repoReferences,
    repoClassifierContext: options.repoClassifierContext,
    warnings,
  };
}

export interface ComposeEvidenceSourceInput {
  sourceId: number;
  filename: string;
  content: string;
}

export function buildComposeEvidenceManifest(input: {
  sourceJiraKey: string;
  sourceSummary: string;
  sources: ComposeEvidenceSourceInput[];
  repoReferences?: SpecFactoryRepoReferenceManifest;
  repoClassifierContext?: EvidenceManifest["repoClassifierContext"];
  composeStories?: ComposeStory[];
}): EvidenceManifest {
  const artifacts: EvidenceArtifact[] = input.sources.map((source) => ({
    kind: artifactKind(source.filename),
    filename: source.filename,
    content: source.content,
    isPriority: false,
    extractionStatus: "extracted",
  }));

  const descriptionMarkdown = input.sources
    .map((source) => `## ${source.filename}\n\n${source.content}`)
    .join("\n\n");

  const loe = extractLoeHours(descriptionMarkdown);

  return {
    sourceJiraKey: input.sourceJiraKey,
    sourceSummary: input.sourceSummary,
    sourceStatus: null,
    sourceLabels: [],
    descriptionMarkdown,
    loeHours: loe,
    loeSource: loe !== null ? "compose-sources" : null,
    comments: [],
    artifacts,
    repoReferences: input.repoReferences,
    repoClassifierContext: input.repoClassifierContext,
    ...(input.composeStories && input.composeStories.length > 0
      ? { composeStories: input.composeStories }
      : {}),
    warnings: [...(input.repoReferences?.warnings ?? [])],
  };
}
