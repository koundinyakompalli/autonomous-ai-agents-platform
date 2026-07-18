import * as fs from "fs/promises";
import * as path from "path";
import type { CodeRepository } from "../orchestrator/database.js";
import type { EvidenceArtifact, EvidenceManifest } from "./evidence.js";
import type { SpecFactoryQualificationDecision } from "./qualifier.js";
import type {
  SpecFactoryRepoGroundingBranch,
  SpecFactoryRepoWorkspace,
  SpecFactoryRepoWorkspaceManager,
} from "./repo-workspace.js";

const MAX_HINTED_PATHS_PER_REPO = 12;
export const MAX_SNIPPET_CHARS = 4_000;
const DEFAULT_SNIPPET_READ_BYTES = MAX_SNIPPET_CHARS + 1024;

export interface SpecFactoryRepoContextManifest {
  sourceJiraKey: string;
  repos: Array<{
    repoName: string;
    branch: SpecFactoryRepoGroundingBranch;
    headSha: string;
    workspacePath: string;
    repoId?: string;
    cleanup?: () => Promise<void>;
    inspectedPaths: string[];
    evidenceRefs: string[];
    summaries: Array<{ path: string; snippet: string }>;
    warnings: string[];
  }>;
  unresolvedHints: string[];
  warnings: string[];
}

export interface SpecFactoryRepoContextReader {
  realPath(filePath: string): Promise<string>;
  readSnippet(filePath: string, maxChars: number): Promise<string>;
}

interface SpecFactoryRepoContextCollectorOptions {
  lookupRepositories: () => Promise<CodeRepository[]>;
  workspaceManager: Pick<SpecFactoryRepoWorkspaceManager, "prepareMasterWorkspace">;
  reader?: SpecFactoryRepoContextReader;
}

interface HintBucket {
  repoNames: Set<string>;
  pathsByRepo: Map<string, Set<string>>;
  unresolvedPaths: Set<string>;
  unresolvedPathEvidenceRefs: Map<string, Set<string>>;
  evidenceRefsByRepo: Map<string, Set<string>>;
}

const defaultReader: SpecFactoryRepoContextReader = {
  async realPath(filePath: string): Promise<string> {
    return fs.realpath(filePath);
  },
  async readSnippet(filePath: string, maxChars: number): Promise<string> {
    const file = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(Math.max(maxChars + 1, DEFAULT_SNIPPET_READ_BYTES));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const raw = buffer.subarray(0, bytesRead).toString("utf8");
      return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n[truncated]` : raw;
    } finally {
      await file.close();
    }
  },
};

function normalizeRepoName(value: string): string {
  return value.trim().toLowerCase();
}

function repoMatchesPath(repoName: string, hintedPath: string): string | null {
  const normalizedRepoName = repoName.toLowerCase();
  const normalizedHintedPath = hintedPath.toLowerCase();
  if (normalizedHintedPath === normalizedRepoName) return "";
  if (normalizedHintedPath.startsWith(`${normalizedRepoName}/`)) {
    return hintedPath.slice(repoName.length + 1);
  }
  return null;
}

function extractExplicitRepoNames(text: string): string[] {
  const repoNames = new Set<string>();
  const pattern = /\b(?:repo|repository)\s*:?\s+([A-Za-z0-9._-]+)\b/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match[1]) repoNames.add(match[1]);
  }

  return [...repoNames];
}

function extractPathHints(text: string): string[] {
  const paths = new Set<string>();
  const pattern = /\b[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)+\b/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const value = match[0];
    if (value.includes("://")) continue;
    if (/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\//.test(value)) continue;
    paths.add(value);
  }

  return [...paths];
}

function ensureMapSet(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  return set;
}

function addTextHints(
  bucket: HintBucket,
  text: string,
  evidenceRef: string,
  repoByNormalizedName: Map<string, CodeRepository>,
): void {
  for (const repoName of extractExplicitRepoNames(text)) {
    const normalized = normalizeRepoName(repoName);
    bucket.repoNames.add(normalized);
    ensureMapSet(bucket.evidenceRefsByRepo, normalized).add(evidenceRef);
  }

  for (const hintedPath of extractPathHints(text)) {
    let resolved = false;
    for (const repo of repoByNormalizedName.values()) {
      const normalizedRepo = normalizeRepoName(repo.repo_name);
      const repoRelativePath = repoMatchesPath(repo.repo_name, hintedPath);
      if (repoRelativePath !== null && repoRelativePath) {
        bucket.repoNames.add(normalizedRepo);
        ensureMapSet(bucket.pathsByRepo, normalizedRepo).add(repoRelativePath);
        ensureMapSet(bucket.evidenceRefsByRepo, normalizedRepo).add(evidenceRef);
        resolved = true;
      }
    }

    if (!resolved) {
      bucket.unresolvedPaths.add(hintedPath);
      ensureMapSet(bucket.unresolvedPathEvidenceRefs, hintedPath).add(evidenceRef);
    }
  }
}

function addRepoReferenceHints(
  bucket: HintBucket,
  evidenceManifest: EvidenceManifest,
): void {
  for (const repoReference of evidenceManifest.repoReferences?.matchedRepos ?? []) {
    const normalized = normalizeRepoName(repoReference.repoName);
    bucket.repoNames.add(normalized);
    for (const evidenceRef of repoReference.evidenceRefs) {
      ensureMapSet(bucket.evidenceRefsByRepo, normalized).add(evidenceRef);
    }
  }
}

function addQualificationHints(
  bucket: HintBucket,
  qualification: Pick<SpecFactoryQualificationDecision, "repoHints"> | undefined,
  repoByNormalizedName: Map<string, CodeRepository>,
): void {
  for (const repoHint of qualification?.repoHints ?? []) {
    const normalized = normalizeRepoName(repoHint.repoName);
    if (!repoByNormalizedName.has(normalized)) {
      bucket.repoNames.add(normalized);
      continue;
    }

    bucket.repoNames.add(normalized);
    for (const evidenceRef of repoHint.evidenceRefs) {
      ensureMapSet(bucket.evidenceRefsByRepo, normalized).add(
        `qualifier:${evidenceRef}`,
      );
    }
  }
}

function artifactCarriesContextHints(artifact: EvidenceArtifact): boolean {
  return (
    artifact.kind === "code_changes" ||
    artifact.kind === "config_changes" ||
    artifact.kind === "raw_requirement" ||
    artifact.kind === "loe_estimate"
  );
}

async function readBoundedSnippet(
  reader: SpecFactoryRepoContextReader,
  workspace: SpecFactoryRepoWorkspace,
  repoRelativePath: string,
): Promise<string> {
  const workspaceRoot = path.resolve(workspace.workspacePath);
  const targetPath = path.resolve(workspaceRoot, repoRelativePath);
  const relativeToWorkspace = path.relative(workspaceRoot, targetPath);
  if (
    relativeToWorkspace === "" ||
    relativeToWorkspace === ".." ||
    relativeToWorkspace.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToWorkspace)
  ) {
    throw new UnsafeHintedPathError(repoRelativePath);
  }

  const realWorkspaceRoot = await reader.realPath(workspaceRoot);
  const realTargetPath = await reader.realPath(targetPath);
  const realRelativeToWorkspace = path.relative(realWorkspaceRoot, realTargetPath);
  if (
    realRelativeToWorkspace === "" ||
    realRelativeToWorkspace === ".." ||
    realRelativeToWorkspace.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelativeToWorkspace)
  ) {
    throw new UnsafeHintedPathError(repoRelativePath);
  }

  return reader.readSnippet(realTargetPath, MAX_SNIPPET_CHARS);
}

class UnsafeHintedPathError extends Error {
  constructor(readonly hintedPath: string) {
    super(`Unsafe hinted path escapes repository workspace: ${hintedPath}`);
  }
}

export class SpecFactoryRepoContextCollector {
  private readonly lookupRepositories: () => Promise<CodeRepository[]>;
  private readonly workspaceManager: Pick<SpecFactoryRepoWorkspaceManager, "prepareMasterWorkspace">;
  private readonly reader: SpecFactoryRepoContextReader;

  constructor(options: SpecFactoryRepoContextCollectorOptions) {
    this.lookupRepositories = options.lookupRepositories;
    this.workspaceManager = options.workspaceManager;
    this.reader = options.reader || defaultReader;
  }

  async collect(input: {
    sourceId: number;
    evidenceManifest: EvidenceManifest;
    qualification?: Pick<SpecFactoryQualificationDecision, "repoHints">;
  }): Promise<SpecFactoryRepoContextManifest> {
    const repositories = await this.lookupRepositories();
    const repoByNormalizedName = new Map(
      repositories.map((repo) => [normalizeRepoName(repo.repo_name), repo] as const),
    );
    const hints: HintBucket = {
      repoNames: new Set<string>(),
      pathsByRepo: new Map<string, Set<string>>(),
      unresolvedPaths: new Set<string>(),
      unresolvedPathEvidenceRefs: new Map<string, Set<string>>(),
      evidenceRefsByRepo: new Map<string, Set<string>>(),
    };

    addRepoReferenceHints(hints, input.evidenceManifest);
    addQualificationHints(
      hints,
      input.qualification,
      repoByNormalizedName,
    );
    addTextHints(
      hints,
      input.evidenceManifest.descriptionMarkdown,
      "description",
      repoByNormalizedName,
    );
    input.evidenceManifest.comments.forEach((comment, index) => {
      addTextHints(hints, comment.bodyMarkdown, `comment:${index}`, repoByNormalizedName);
    });
    for (const artifact of input.evidenceManifest.artifacts) {
      if (!artifactCarriesContextHints(artifact)) continue;
      addTextHints(
        hints,
        artifact.content,
        `attachment:${artifact.filename}`,
        repoByNormalizedName,
      );
    }

    const resolvedRepoNames = [...hints.repoNames].filter((repoName) =>
      repoByNormalizedName.has(repoName),
    );
    for (const hintedPath of hints.unresolvedPaths) {
      for (const repoName of resolvedRepoNames) {
        ensureMapSet(hints.pathsByRepo, repoName).add(hintedPath);
        for (const evidenceRef of hints.unresolvedPathEvidenceRefs.get(hintedPath) || []) {
          ensureMapSet(hints.evidenceRefsByRepo, repoName).add(evidenceRef);
        }
      }
    }

    const unresolvedHints = [...hints.repoNames].filter(
      (repoName) => !repoByNormalizedName.has(repoName),
    );
    for (const repoReferenceHint of input.evidenceManifest.repoReferences?.unresolvedHints ?? []) {
      if (!unresolvedHints.includes(repoReferenceHint)) {
        unresolvedHints.push(repoReferenceHint);
      }
    }
    if (resolvedRepoNames.length === 0) {
      unresolvedHints.push(...hints.unresolvedPaths);
    }
    const warnings = [
      ...unresolvedHints.map((hint) =>
        hint.includes("/")
          ? `Path hint could not be tied to a repository on master or main: ${hint}`
          : `Repository hint could not be resolved: ${hint}`),
      ...(input.evidenceManifest.repoReferences?.warnings ?? []),
    ].filter((warning, index, all) => all.indexOf(warning) === index);
    const repos: SpecFactoryRepoContextManifest["repos"] = [];

    try {
      for (const repoName of [...hints.repoNames].sort()) {
        const repo = repoByNormalizedName.get(repoName);
        if (!repo) continue;

        const workspace = await this.workspaceManager.prepareMasterWorkspace({
          sourceId: input.sourceId,
          repo,
        });
        const hintedPaths = [...(hints.pathsByRepo.get(repoName) || new Set<string>())].slice(
          0,
          MAX_HINTED_PATHS_PER_REPO,
        );
        const summaries: Array<{ path: string; snippet: string }> = [];
        const inspectedPaths: string[] = [];
        const repoWarnings: string[] = [];

        for (const hintedPath of hintedPaths) {
          try {
            const snippet = await readBoundedSnippet(this.reader, workspace, hintedPath);
            inspectedPaths.push(hintedPath);
            summaries.push({ path: hintedPath, snippet });
          } catch (error) {
            if (error instanceof UnsafeHintedPathError) {
              repoWarnings.push(error.message);
              continue;
            }
            repoWarnings.push(`Missing hinted path on ${workspace.branch}: ${hintedPath}`);
          }
        }

        repos.push({
          repoName: workspace.repoName,
          branch: workspace.branch,
          headSha: workspace.headSha,
          workspacePath: workspace.workspacePath,
          repoId: workspace.repoId,
          cleanup: workspace.cleanup,
          inspectedPaths,
          evidenceRefs: [...(hints.evidenceRefsByRepo.get(repoName) || new Set<string>())],
          summaries,
          warnings: repoWarnings,
        });
      }
    } catch (error) {
      const cleanupHandles = repos
        .map((repo) => repo.cleanup)
        .filter((cleanup): cleanup is () => Promise<void> => Boolean(cleanup));
      await Promise.allSettled(
        cleanupHandles.map((cleanup) => cleanup()),
      );
      throw error;
    }

    return {
      sourceJiraKey: input.evidenceManifest.sourceJiraKey,
      repos,
      unresolvedHints,
      warnings,
    };
  }
}
