import type { SpecFactoryTaskWorkspace } from "./evidence-workspace.js";
import type { EvidenceManifest } from "./evidence.js";
import type { SpecFactoryRepoContextManifest } from "./repo-context.js";

function joinOrNone(values: readonly string[] | undefined): string {
  const filtered = (values ?? []).map((value) => value.trim()).filter(Boolean);
  return filtered.length > 0 ? filtered.join(", ") : "none";
}

function formatSize(sizeBytes: number | null | undefined): string {
  return sizeBytes === null || sizeBytes === undefined
    ? "unknown"
    : String(sizeBytes);
}

export function renderCompactEvidenceSummary(
  evidenceManifest: EvidenceManifest,
): string {
  const matchedRepos = evidenceManifest.repoReferences?.matchedRepos ?? [];
  const unresolvedHints = evidenceManifest.repoReferences?.unresolvedHints ?? [];
  const profiledRepos =
    evidenceManifest.repoClassifierContext?.profiledRepos ?? [];
  const lines = [
    "Evidence package summary (metadata only; read files for source text):",
    `- Source Jira key: ${evidenceManifest.sourceJiraKey}`,
    `- Source summary: ${evidenceManifest.sourceSummary}`,
    `- Source status: ${evidenceManifest.sourceStatus ?? "unknown"}`,
    `- LOE hours: ${evidenceManifest.loeHours ?? "unknown"}`,
    `- LOE source: ${evidenceManifest.loeSource ?? "unknown"}`,
    `- Labels: ${joinOrNone(evidenceManifest.sourceLabels)}`,
    `- Comment count: ${evidenceManifest.comments.length}`,
    "",
    "Attachments (metadata only; read evidence/attachment-index.md first, then individual files under evidence/attachments/ for content):",
  ];

  if (evidenceManifest.artifacts.length === 0) {
    lines.push("- none");
  } else {
    for (const artifact of evidenceManifest.artifacts) {
      lines.push(
        [
          `- ${artifact.filename}`,
          `kind=${artifact.kind}`,
          `priority=${artifact.isPriority === true ? "yes" : "no"}`,
          `status=${artifact.extractionStatus ?? "unknown"}`,
          `sizeBytes=${formatSize(artifact.sizeBytes)}`,
          artifact.s3Bucket && artifact.s3Key
            ? `archive=s3://${artifact.s3Bucket}/${artifact.s3Key}`
            : null,
          artifact.sha256 ? `sha256=${artifact.sha256}` : null,
        ]
          .filter((value): value is string => value !== null)
          .join("; "),
      );
    }
  }

  lines.push("", "Matched repo references:");
  if (matchedRepos.length === 0) {
    lines.push("- none");
  } else {
    for (const repo of matchedRepos) {
      lines.push(
        `- ${repo.repoName} (id=${repo.repoId}; defaultBranch=${repo.defaultBranch ?? "unknown"}; refs=${joinOrNone(repo.evidenceRefs)})`,
      );
    }
  }

  lines.push("", `Unresolved repo hints: ${joinOrNone(unresolvedHints)}`);
  lines.push(
    `Repo classifier profile names: ${
      profiledRepos.length > 0
        ? profiledRepos
            .map((repo) => `${repo.repoName}(id=${repo.repoId})`)
            .join(", ")
        : "none"
    }`,
  );
  lines.push(`Warnings: ${joinOrNone(evidenceManifest.warnings)}`);

  return lines.join("\n");
}

export function renderTaskWorkspacePromptContext(
  taskWorkspace: SpecFactoryTaskWorkspace,
): string {
  const lines = [
    "Task workspace:",
    `- Registered repo id: ${taskWorkspace.repoId}`,
    `- Workspace root: ${taskWorkspace.workspacePath}`,
    `- Evidence directory: ${taskWorkspace.evidenceDir}`,
    `- Attachments directory: ${taskWorkspace.attachmentsDir}`,
    `- Repo links directory: ${taskWorkspace.reposDir}`,
    "- Primary compact files to read, relative to workspace root:",
    "  - evidence/ticket.md",
    "  - evidence/evidence-summary.json",
    "  - evidence/attachment-index.md",
    "  - evidence/repo-references.json",
    "  - evidence/repo-classifier-index.md",
    "  - repo-context-summary.json",
    "- Source evidence files:",
    "  - evidence/attachments/<selected files from attachment-index.md>",
    "- Full audit manifests are retained in the workspace for traceability, but they can exceed SDK read limits. Use compact files, grep, or targeted Read offset/limit instead of opening full audit manifests directly.",
  ];

  if (taskWorkspace.repoLinks.length > 0) {
    lines.push("- Linked repository workspaces:");
    for (const link of taskWorkspace.repoLinks) {
      lines.push(
        `  - ${link.repoName}: ${link.linked ? link.linkPath : "not linked"} -> ${link.workspacePath}`,
      );
    }
  } else {
    lines.push("- Linked repository workspaces: none");
  }

  return lines.join("\n");
}

export function renderCompactRepoContextSummary(
  repoContextManifest: SpecFactoryRepoContextManifest | undefined,
): string {
  if (!repoContextManifest) {
    return "Repository context summary: none registered.";
  }

  const lines = [
    "Repository context summary (metadata only; read repo-context-summary.json and repos/* for details):",
    `- Source Jira key: ${repoContextManifest.sourceJiraKey}`,
    "- Repositories:",
  ];

  if (repoContextManifest.repos.length === 0) {
    lines.push("  - none");
  } else {
    for (const repo of repoContextManifest.repos) {
      lines.push(
        [
          `  - ${repo.repoName}`,
          `branch=${repo.branch}`,
          `headSha=${repo.headSha}`,
          `repoId=${repo.repoId ?? "unregistered"}`,
          `workspace=${repo.workspacePath}`,
          `inspectedPaths=${joinOrNone(repo.inspectedPaths)}`,
          `evidenceRefs=${joinOrNone(repo.evidenceRefs)}`,
          `warnings=${joinOrNone(repo.warnings)}`,
        ].join("; "),
      );
    }
  }

  lines.push(
    `- Unresolved hints: ${joinOrNone(repoContextManifest.unresolvedHints)}`,
  );
  lines.push(`- Warnings: ${joinOrNone(repoContextManifest.warnings)}`);

  return lines.join("\n");
}
