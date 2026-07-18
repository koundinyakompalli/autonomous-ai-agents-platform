import type { CodeRepository } from "../orchestrator/database.js";
import { findDeterministicDomainRepoMatches } from "../oneshot/repo-domain-rules.js";
import type { EvidenceArtifact, EvidenceManifest } from "./evidence.js";

export interface SpecFactoryRepoReference {
  repoId: number;
  repoName: string;
  repoUrl: string;
  defaultBranch: string | null;
  evidenceRefs: string[];
}

export interface SpecFactoryRepoReferenceManifest {
  matchedRepos: SpecFactoryRepoReference[];
  unresolvedHints: string[];
  warnings: string[];
}

interface HintBucket {
  repos: Set<string>;
  evidenceRefsByRepo: Map<string, Set<string>>;
  unresolvedHints: Set<string>;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function addEvidenceRef(map: Map<string, Set<string>>, key: string, ref: string): void {
  let refs = map.get(key);
  if (!refs) {
    refs = new Set<string>();
    map.set(key, refs);
  }
  refs.add(ref);
}

function extractExplicitRepoNames(text: string): string[] {
  const repos = new Set<string>();
  const pattern = /\b(?:repo|repository)\s*:?\s+([A-Za-z0-9._-]+)\b/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match[1]) repos.add(match[1]);
  }

  return [...repos];
}

function extractPathLikeHints(text: string): string[] {
  const hints = new Set<string>();
  const pattern = /\b[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)+\b/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const value = match[0];
    if (value.includes("://")) continue;
    hints.add(value);
  }

  return [...hints];
}

function addTextHints(
  bucket: HintBucket,
  text: string,
  evidenceRef: string,
  repoByName: Map<string, CodeRepository>,
): void {
  for (const repoName of extractExplicitRepoNames(text)) {
    const normalized = normalize(repoName);
    if (repoByName.has(normalized)) {
      bucket.repos.add(normalized);
      addEvidenceRef(bucket.evidenceRefsByRepo, normalized, evidenceRef);
    } else {
      bucket.unresolvedHints.add(repoName);
    }
  }

  for (const hintedPath of extractPathLikeHints(text)) {
    const firstSegment = hintedPath.split("/")[0];
    if (!firstSegment) continue;
    const normalized = normalize(firstSegment);
    if (repoByName.has(normalized)) {
      bucket.repos.add(normalized);
      addEvidenceRef(bucket.evidenceRefsByRepo, normalized, evidenceRef);
    }
  }
}

function evidenceText(
  evidence: Pick<EvidenceManifest, "descriptionMarkdown" | "comments" | "artifacts">,
): string {
  return [
    evidence.descriptionMarkdown,
    ...evidence.comments.map((comment) => comment.bodyMarkdown),
    ...evidence.artifacts
      .filter(artifactCarriesRepoHints)
      .map((artifact) => [artifact.filename, artifact.content].join("\n")),
  ].join("\n\n");
}

function artifactCarriesRepoHints(artifact: EvidenceArtifact): boolean {
  return (
    artifact.kind === "code_changes" ||
    artifact.kind === "config_changes" ||
    artifact.kind === "raw_requirement" ||
    artifact.kind === "loe_estimate"
  );
}

export function buildRepoReferenceManifest(
  evidence: Pick<EvidenceManifest, "descriptionMarkdown" | "comments" | "artifacts">,
  repositories: CodeRepository[],
): SpecFactoryRepoReferenceManifest {
  const repoByName = new Map(
    repositories.map((repo) => [normalize(repo.repo_name), repo] as const),
  );
  const bucket: HintBucket = {
    repos: new Set<string>(),
    evidenceRefsByRepo: new Map<string, Set<string>>(),
    unresolvedHints: new Set<string>(),
  };

  addTextHints(bucket, evidence.descriptionMarkdown, "description", repoByName);
  evidence.comments.forEach((comment, index) => {
    addTextHints(bucket, comment.bodyMarkdown, `comment:${index}`, repoByName);
  });
  for (const artifact of evidence.artifacts) {
    if (!artifactCarriesRepoHints(artifact)) continue;
    addTextHints(
      bucket,
      artifact.content,
      `attachment:${artifact.filename}`,
      repoByName,
    );
  }

  for (const match of findDeterministicDomainRepoMatches(
    evidenceText(evidence),
    repositories,
  )) {
    const normalized = normalize(match.repo.repo_name);
    bucket.repos.add(normalized);
    for (const evidenceLine of match.evidence) {
      addEvidenceRef(
        bucket.evidenceRefsByRepo,
        normalized,
        `domain-rule:${evidenceLine}`,
      );
    }
  }

  const matchedRepos = [...bucket.repos]
    .sort()
    .map((repoName): SpecFactoryRepoReference | null => {
      const repo = repoByName.get(repoName);
      if (!repo) return null;
      return {
        repoId: repo.id,
        repoName: repo.repo_name,
        repoUrl: repo.repo_url,
        defaultBranch: repo.default_branch ?? null,
        evidenceRefs: [...(bucket.evidenceRefsByRepo.get(repoName) ?? new Set<string>())],
      };
    })
    .filter((repo): repo is SpecFactoryRepoReference => repo !== null);

  const warnings = [...bucket.unresolvedHints].map(
    (hint) => `Repository hint could not be resolved against code_repositories: ${hint}`,
  );
  if (matchedRepos.length === 0) {
    warnings.push("No repository references matched code_repositories.");
  }

  return {
    matchedRepos,
    unresolvedHints: [...bucket.unresolvedHints].sort(),
    warnings,
  };
}
