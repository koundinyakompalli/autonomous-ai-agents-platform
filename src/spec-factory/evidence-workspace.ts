import * as fs from "fs/promises";
import * as path from "path";
import { registerRepoFromPath as defaultRegisterRepoFromPath } from "../claude-sdk/index.js";
import type { EvidenceArtifact, EvidenceManifest } from "./evidence.js";
import type { SpecFactoryRepoContextManifest } from "./repo-context.js";

export const DEFAULT_SPEC_FACTORY_TASK_WORKSPACE_BASE =
  "/mnt/efs/specter-repo/spec-factory/tasks";
export const DEFAULT_SPEC_FACTORY_EVIDENCE_WORKSPACE_BASE =
  "/mnt/efs/specter-repo/spec-factory/evidence-workspaces";
const INDEX_PREVIEW_CHARS = 500;
const PROFILE_SUMMARY_CHARS = 700;
const PROFILE_LIST_LIMIT = 20;

export interface SpecFactoryTaskWorkspaceRepoLink {
  repoName: string;
  workspacePath: string;
  linkPath: string;
  linked: boolean;
  errorMessage?: string;
}

export interface SpecFactoryTaskWorkspace {
  repoId: string;
  workspacePath: string;
  evidenceDir: string;
  attachmentsDir: string;
  reposDir: string;
  repoLinks: SpecFactoryTaskWorkspaceRepoLink[];
}

export type SpecFactoryEvidenceWorkspace = SpecFactoryTaskWorkspace;

interface PrepareTaskWorkspaceInput {
  sourceId: number;
  evidenceManifest: EvidenceManifest;
  repoContextManifest?: SpecFactoryRepoContextManifest | null;
}

interface AttachmentWorkspaceFile {
  artifact: EvidenceArtifact;
  filename: string;
}

function safePathSegment(value: string, fallback: string): string {
  const basename = path.basename(value.trim()).replace(/[\\/]/g, "-");
  const sanitized = basename.replace(/[\x00-\x1F\x7F]/g, "").trim();
  return sanitized || fallback;
}

function uniqueAttachmentName(
  artifact: EvidenceArtifact,
  index: number,
  used: Set<string>,
): string {
  const parsed = path.parse(
    safePathSegment(artifact.filename, `attachment-${index + 1}.txt`),
  );
  const base = parsed.name || `attachment-${index + 1}`;
  const ext = parsed.ext || ".txt";
  let candidate = `${base}${ext}`;
  let suffix = 2;

  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}${ext}`;
    suffix += 1;
  }

  used.add(candidate.toLowerCase());
  return candidate;
}

function uniqueRepoProfileName(
  repoName: string,
  repoId: number,
  index: number,
  used: Set<string>,
): string {
  const base = safePathSegment(`${repoId}-${repoName}`, `repo-${index + 1}`);
  let candidate = `${base}.md`;
  let suffix = 2;

  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}.md`;
    suffix += 1;
  }

  used.add(candidate.toLowerCase());
  return candidate;
}

function compactText(value: string | null | undefined, maxChars = INDEX_PREVIEW_CHARS): string {
  const compacted = (value ?? "").replace(/\s+/g, " ").trim();
  if (compacted.length <= maxChars) return compacted;
  return `${compacted.slice(0, maxChars)}... [truncated]`;
}

function renderTicketMarkdown(evidenceManifest: EvidenceManifest): string {
  return [
    `# ${evidenceManifest.sourceJiraKey}: ${evidenceManifest.sourceSummary}`,
    "",
    `- Status: ${evidenceManifest.sourceStatus ?? "unknown"}`,
    `- LOE: ${evidenceManifest.loeHours ?? "unknown"}`,
    `- LOE Source: ${evidenceManifest.loeSource ?? "unknown"}`,
    `- Labels: ${evidenceManifest.sourceLabels.join(", ") || "none"}`,
    "",
    "## Description",
    "",
    evidenceManifest.descriptionMarkdown || "_No description supplied._",
    "",
    "## Comments",
    "",
    ...(evidenceManifest.comments.length > 0
      ? evidenceManifest.comments.flatMap((comment, index) => [
          `### Comment ${index + 1}: ${comment.author ?? "unknown"}`,
          "",
          `- Created: ${comment.created ?? "unknown"}`,
          "",
          comment.bodyMarkdown || "_No comment body supplied._",
          "",
        ])
      : ["_No comments supplied._", ""]),
  ].join("\n");
}

function renderAttachmentMarkdown(artifact: EvidenceArtifact): string {
  return [
    `# ${artifact.filename}`,
    "",
    `- Kind: ${artifact.kind}`,
    artifact.jiraAttachmentId ? `- Jira Attachment ID: ${artifact.jiraAttachmentId}` : null,
    artifact.mimeType ? `- MIME Type: ${artifact.mimeType}` : null,
    artifact.sizeBytes !== undefined && artifact.sizeBytes !== null
      ? `- Size Bytes: ${artifact.sizeBytes}`
      : null,
    artifact.s3Bucket && artifact.s3Key
      ? `- Archive: s3://${artifact.s3Bucket}/${artifact.s3Key}`
      : null,
    artifact.sha256 ? `- SHA256: ${artifact.sha256}` : null,
    artifact.extractionStatus ? `- Extraction Status: ${artifact.extractionStatus}` : null,
    "",
    artifact.content || "_No extracted text available._",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function renderAttachmentIndexMarkdown(
  attachmentFiles: AttachmentWorkspaceFile[],
): string {
  const lines = [
    "# Attachment Index",
    "",
    "Use this index to choose evidence files to read. Read individual files under evidence/attachments/ for source text instead of reading full audit manifests.",
    "",
  ];

  if (attachmentFiles.length === 0) {
    lines.push("_No attachments available._");
    return lines.join("\n");
  }

  for (const { artifact, filename } of attachmentFiles) {
    lines.push(
      `## ${artifact.filename}`,
      "",
      `- Workspace file: evidence/attachments/${filename}`,
      `- Kind: ${artifact.kind}`,
      `- Priority Louise artifact: ${artifact.isPriority === true ? "yes" : "no"}`,
      artifact.mimeType ? `- MIME Type: ${artifact.mimeType}` : null,
      artifact.sizeBytes !== undefined && artifact.sizeBytes !== null
        ? `- Size Bytes: ${artifact.sizeBytes}`
        : null,
      artifact.s3Bucket && artifact.s3Key
        ? `- Archive: s3://${artifact.s3Bucket}/${artifact.s3Key}`
        : null,
      artifact.extractionStatus
        ? `- Extraction Status: ${artifact.extractionStatus}`
        : null,
      `- Extracted text chars: ${artifact.content.length}`,
      artifact.content.trim()
        ? `- Preview: ${compactText(artifact.content)}`
        : "- Preview: no extracted text available",
      "",
    );
  }

  return lines.filter((line): line is string => line !== null).join("\n");
}

function renderEvidenceSummaryJson(
  evidenceManifest: EvidenceManifest,
  attachmentFiles: AttachmentWorkspaceFile[],
): string {
  return JSON.stringify(
    {
      sourceJiraKey: evidenceManifest.sourceJiraKey,
      sourceSummary: evidenceManifest.sourceSummary,
      sourceStatus: evidenceManifest.sourceStatus,
      sourceLabels: evidenceManifest.sourceLabels,
      loeHours: evidenceManifest.loeHours,
      loeSource: evidenceManifest.loeSource,
      descriptionChars: evidenceManifest.descriptionMarkdown.length,
      comments: evidenceManifest.comments.map((comment) => ({
        id: comment.id,
        author: comment.author,
        created: comment.created,
        bodyChars: comment.bodyMarkdown.length,
        preview: compactText(comment.bodyMarkdown, 250),
      })),
      attachments: attachmentFiles.map(({ artifact, filename }) => ({
        filename: artifact.filename,
        workspaceFile: `evidence/attachments/${filename}`,
        kind: artifact.kind,
        priority: artifact.isPriority === true,
        mimeType: artifact.mimeType ?? null,
        sizeBytes: artifact.sizeBytes ?? null,
        archive:
          artifact.s3Bucket && artifact.s3Key
            ? `s3://${artifact.s3Bucket}/${artifact.s3Key}`
            : null,
        sha256: artifact.sha256 ?? null,
        extractionStatus: artifact.extractionStatus ?? null,
        contentChars: artifact.content.length,
        preview: compactText(artifact.content, 250),
      })),
      repoReferences: evidenceManifest.repoReferences ?? null,
      repoClassifierProfileCount:
        evidenceManifest.repoClassifierContext?.profiledRepos.length ?? 0,
      warnings: evidenceManifest.warnings,
    },
    null,
    2,
  );
}

function renderRepoClassifierMarkdown(
  evidenceManifest: EvidenceManifest,
): string {
  const profiledRepos =
    evidenceManifest.repoClassifierContext?.profiledRepos ?? [];
  if (profiledRepos.length === 0) {
    return "# Repo Classifier Context\n\n_No profiled repositories available._\n";
  }

  return [
    "# Repo Classifier Context",
    "",
    "These are the OneShot repo-classifier profiles available to Spec Factory qualification.",
    "",
    ...profiledRepos.map((repo) =>
      [
        `## ${repo.repoName} (id=${repo.repoId})`,
        "",
        repo.summary ? repo.summary : "_No curated summary available._",
        "",
        repo.aliases.length > 0 ? `- Aliases: ${repo.aliases.join(", ")}` : null,
        repo.domains.length > 0 ? `- Domains: ${repo.domains.join(", ")}` : null,
        repo.packages.length > 0
          ? `- Packages: ${repo.packages.slice(0, 25).join(", ")}`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    ),
  ].join("\n\n");
}

function renderRepoClassifierProfileMarkdown(repo: {
  repoId: number;
  repoName: string;
  summary: string;
  aliases: string[];
  domains: string[];
  packages: string[];
}): string {
  return [
    `# ${repo.repoName} (id=${repo.repoId})`,
    "",
    repo.summary ? compactText(repo.summary, 6_000) : "_No curated summary available._",
    "",
    repo.aliases.length > 0 ? `- Aliases: ${repo.aliases.join(", ")}` : null,
    repo.domains.length > 0 ? `- Domains: ${repo.domains.join(", ")}` : null,
    repo.packages.length > 0
      ? `- Packages: ${repo.packages.slice(0, 200).join(", ")}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

async function writeRepoClassifierIndex(
  evidenceDir: string,
  evidenceManifest: EvidenceManifest,
): Promise<void> {
  const profilesDir = path.join(evidenceDir, "repo-classifier-profiles");
  await fs.rm(profilesDir, { recursive: true, force: true });
  await fs.mkdir(profilesDir, { recursive: true });

  const profiledRepos =
    evidenceManifest.repoClassifierContext?.profiledRepos ?? [];
  const usedProfileNames = new Set<string>();
  const lines = [
    "# Repo Classifier Index",
    "",
    "Use this compact index to infer likely repositories. Read a specific profile file only after narrowing candidates. Do not read the full combined classifier audit file during normal qualification.",
    "",
  ];

  if (profiledRepos.length === 0) {
    lines.push("_No profiled repositories available._");
  }

  const profileFiles = profiledRepos.map((repo, index) => ({
    repo,
    filename: uniqueRepoProfileName(
      repo.repoName,
      repo.repoId,
      index,
      usedProfileNames,
    ),
  }));

  await Promise.all(
    profileFiles.map(({ repo, filename }) =>
      fs.writeFile(
        path.join(profilesDir, filename),
        renderRepoClassifierProfileMarkdown(repo),
        "utf8",
      ),
    ),
  );

  for (const { repo, filename } of profileFiles) {
    lines.push(
      [
        `- ${repo.repoName}`,
        `id=${repo.repoId}`,
        `profile=evidence/repo-classifier-profiles/${filename}`,
        repo.aliases.length > 0
          ? `aliases=${repo.aliases.slice(0, PROFILE_LIST_LIMIT).join(", ")}`
          : null,
        repo.domains.length > 0
          ? `domains=${repo.domains.slice(0, PROFILE_LIST_LIMIT).join(", ")}`
          : null,
        repo.packages.length > 0
          ? `packages=${repo.packages.slice(0, PROFILE_LIST_LIMIT).join(", ")}`
          : null,
        repo.summary
          ? `summary=${compactText(repo.summary, PROFILE_SUMMARY_CHARS)}`
          : "summary=none",
      ]
        .filter((value): value is string => value !== null)
        .join("; "),
    );
  }

  await fs.writeFile(
    path.join(evidenceDir, "repo-classifier-index.md"),
    lines.join("\n"),
    "utf8",
  );
}

function renderRepoContextSummaryJson(
  repoContextManifest?: SpecFactoryRepoContextManifest | null,
): string {
  if (!repoContextManifest) return "null";

  return JSON.stringify(
    {
      sourceJiraKey: repoContextManifest.sourceJiraKey,
      repos: repoContextManifest.repos.map((repo) => ({
        repoName: repo.repoName,
        branch: repo.branch,
        headSha: repo.headSha,
        workspacePath: repo.workspacePath,
        repoId: repo.repoId,
        inspectedPaths: repo.inspectedPaths,
        evidenceRefs: repo.evidenceRefs,
        summaryPaths: repo.summaries.map((summary) => summary.path),
        summaryCount: repo.summaries.length,
        warnings: repo.warnings,
      })),
      unresolvedHints: repoContextManifest.unresolvedHints,
      warnings: repoContextManifest.warnings,
    },
    null,
    2,
  );
}

export class SpecFactoryTaskWorkspaceManager {
  constructor(
    private readonly workspaceBase =
      process.env.SPEC_FACTORY_TASK_WORKSPACE_BASE ||
      process.env.SPEC_FACTORY_EVIDENCE_WORKSPACE_BASE ||
      DEFAULT_SPEC_FACTORY_TASK_WORKSPACE_BASE,
    private readonly registerRepoFromPath = defaultRegisterRepoFromPath,
  ) {}

  async prepare(input: PrepareTaskWorkspaceInput): Promise<SpecFactoryTaskWorkspace> {
    const workspacePath = path.join(this.workspaceBase, String(input.sourceId));
    const evidenceDir = path.join(workspacePath, "evidence");
    const attachmentsDir = path.join(evidenceDir, "attachments");
    const reposDir = path.join(workspacePath, "repos");

    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.rm(reposDir, { recursive: true, force: true });
    await fs.mkdir(reposDir, { recursive: true });

    const usedAttachmentNames = new Set<string>();
    const attachmentFiles = input.evidenceManifest.artifacts.map(
      (artifact, index) => ({
        artifact,
        filename: uniqueAttachmentName(artifact, index, usedAttachmentNames),
      }),
    );

    await fs.writeFile(
      path.join(evidenceDir, "evidence.json"),
      JSON.stringify(input.evidenceManifest, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(evidenceDir, "evidence-summary.json"),
      renderEvidenceSummaryJson(input.evidenceManifest, attachmentFiles),
      "utf8",
    );
    await fs.writeFile(
      path.join(evidenceDir, "ticket.md"),
      renderTicketMarkdown(input.evidenceManifest),
      "utf8",
    );
    await fs.writeFile(
      path.join(evidenceDir, "attachment-index.md"),
      renderAttachmentIndexMarkdown(attachmentFiles),
      "utf8",
    );
    await fs.writeFile(
      path.join(evidenceDir, "attachments.md"),
      input.evidenceManifest.artifacts
        .map((artifact) => renderAttachmentMarkdown(artifact))
        .join("\n\n---\n\n"),
      "utf8",
    );
    await fs.writeFile(
      path.join(evidenceDir, "repo-references.json"),
      JSON.stringify(input.evidenceManifest.repoReferences ?? null, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(evidenceDir, "repo-classifier.json"),
      JSON.stringify(
        input.evidenceManifest.repoClassifierContext ?? null,
        null,
        2,
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(evidenceDir, "repo-classifier.md"),
      renderRepoClassifierMarkdown(input.evidenceManifest),
      "utf8",
    );
    await writeRepoClassifierIndex(evidenceDir, input.evidenceManifest);
    await fs.writeFile(
      path.join(workspacePath, "repo-context.json"),
      JSON.stringify(input.repoContextManifest ?? null, null, 2),
      "utf8",
    );
    await fs.writeFile(
      path.join(workspacePath, "repo-context-summary.json"),
      renderRepoContextSummaryJson(input.repoContextManifest),
      "utf8",
    );

    await Promise.all(
      attachmentFiles.map(async ({ artifact, filename }) => {
        await fs.writeFile(
          path.join(attachmentsDir, filename),
          renderAttachmentMarkdown(artifact),
          "utf8",
        );
      }),
    );

    const repoLinks: SpecFactoryTaskWorkspaceRepoLink[] = [];
    for (const repo of input.repoContextManifest?.repos ?? []) {
      const repoLinkName = safePathSegment(repo.repoName, "repo");
      const linkPath = path.join(reposDir, repoLinkName);
      const link: SpecFactoryTaskWorkspaceRepoLink = {
        repoName: repo.repoName,
        workspacePath: repo.workspacePath,
        linkPath,
        linked: false,
      };
      try {
        await fs.rm(linkPath, { recursive: true, force: true });
        await fs.symlink(repo.workspacePath, linkPath, "dir");
        link.linked = true;
      } catch (error) {
        link.errorMessage = error instanceof Error ? error.message : String(error);
      }
      repoLinks.push(link);
    }

    const repoId = this.registerRepoFromPath(
      workspacePath,
      `spec-factory-task-${input.sourceId}`,
    );
    const taskWorkspace: SpecFactoryTaskWorkspace = {
      repoId,
      workspacePath,
      evidenceDir,
      attachmentsDir,
      reposDir,
      repoLinks,
    };

    await fs.writeFile(
      path.join(workspacePath, "task-workspace.json"),
      JSON.stringify(taskWorkspace, null, 2),
      "utf8",
    );

    return taskWorkspace;
  }
}

export class SpecFactoryEvidenceWorkspaceManager extends SpecFactoryTaskWorkspaceManager {}
