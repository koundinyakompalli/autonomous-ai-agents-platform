import { createLogger } from "../utils/logger.js";
import type { CodeRepository } from "../orchestrator/database.js";
import type { SpecFactoryRepoWorkspaceManager } from "./repo-workspace.js";
import type { ComposeRepoEvidence } from "./compose-types.js";
import {
  scanRepo as defaultScanRepo,
  formatScanForPrompt as defaultFormatScanForPrompt,
  buildRepoRouteCardContext as defaultBuildRouteCardContext,
  getRepoMentionTokens,
  type RepoScanResult,
} from "../repo-intel/index.js";

const logger = createLogger("compose-repo-grounding");

const DEFAULT_MAX_GROUNDED_REPOS = Number(
  process.env.COMPOSE_MAX_GROUNDED_REPOS || 3,
);
const DEFAULT_GROUNDING_TIMEOUT_MS = Number(
  process.env.COMPOSE_REPO_GROUNDING_TIMEOUT_MS || 120_000,
);

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return work;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ComposeRepoGroundingResult {
  /** SDK repo ids to attach to the agent (only successfully cloned repos). */
  codeRepoIds: string[];
  /** Markdown written to repositories.md (pre-scan intelligence or metadata). */
  repositoriesMarkdown: string;
  /** Per-repo evidence surfaced to the operator. */
  manifest: ComposeRepoEvidence[];
  /** Shared read-only workspaces that can be attached to background research. */
  workspaces: Array<{
    repoName: string;
    workspacePath: string;
    headSha: string;
    cleanup?: () => Promise<void>;
  }>;
}

type LookupRepositories = () => Promise<CodeRepository[]>;
type WorkspaceManager = Pick<
  SpecFactoryRepoWorkspaceManager,
  "prepareMasterWorkspace"
>;

interface ComposeRepoGroundingOptions {
  lookupRepositories?: LookupRepositories;
  workspaceManager?: WorkspaceManager;
  scanRepo?: (workspacePath: string) => Promise<RepoScanResult>;
  formatScanForPrompt?: (scan: RepoScanResult) => string;
  buildRouteCardContext?: (repoName: string) => string;
  maxGroundedRepos?: number;
  groundingTimeoutMs?: number;
  enabled?: boolean;
}

function metadataBlock(repo: CodeRepository): string {
  return [
    `- ${repo.repo_name}`,
    `  - Repository ID: ${repo.id}`,
    `  - Default branch: ${repo.default_branch ?? "unknown"}`,
    `  - URL: ${repo.repo_url || "unknown"}`,
    repo.description ? `  - Description: ${repo.description}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

const EXT_LANGUAGE: Record<string, string> = {
  ".java": "Java",
  ".kt": "Kotlin",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rb": "Ruby",
  ".cs": "C#",
};

/**
 * Derive a language label from the scan's key-file extensions. scanRepo's
 * primaryLanguage relies on root-level build markers (package.json/pom.xml),
 * which are often absent at a multi-module/monorepo worktree root and yield
 * "unknown" even when the key files clearly reveal the language. This recovers
 * the dominant language from the files the scan actually surfaced.
 */
function inferLanguageFromKeyFiles(scan: RepoScanResult): string | null {
  const counts = new Map<string, number>();
  for (const file of scan.keyFiles) {
    const dot = file.path.lastIndexOf(".");
    if (dot < 0) continue;
    const lang = EXT_LANGUAGE[file.path.slice(dot).toLowerCase()];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [lang, n] of counts) {
    if (n > bestN) {
      best = lang;
      bestN = n;
    }
  }
  return best;
}

function techStackSummary(scan: RepoScanResult): string {
  const t = scan.techStack;
  const lang =
    t.primaryLanguage ?? inferLanguageFromKeyFiles(scan) ?? "unknown";
  const fw = t.frameworks.length ? `/${t.frameworks.join(",")}` : "";
  return `${lang}${fw}`;
}

function wrapMarkdown(body: string): string {
  return [
    "# Selected code repositories",
    "",
    "The operator selected (or the sources named) these repositories. They are attached to your workspace as real, read-only checkouts: prefer grepping/reading the actual code over guessing, and confirm whether an API/route/service exists before asking about it.",
    "",
    body,
    "",
  ].join("\n");
}

/**
 * Resolves the repos relevant to a Compose session (operator-selected plus any
 * auto-identified from the source text), clones them through the shared
 * freshness-cached workspace manager, scans each for codebase intelligence, and
 * returns the SDK repo ids to attach to the clarification agent plus a per-repo
 * evidence manifest. Any repo that cannot be cloned/scanned degrades to a
 * metadata-only block (and is dropped from codeRepoIds) so a grounding failure
 * never blocks the clarification turn.
 */
export class ComposeRepoGrounding {
  private readonly lookupRepositories?: LookupRepositories;
  private readonly workspaceManager?: WorkspaceManager;
  private readonly scanRepo: (workspacePath: string) => Promise<RepoScanResult>;
  private readonly formatScanForPrompt: (scan: RepoScanResult) => string;
  private readonly buildRouteCardContext: (repoName: string) => string;
  private readonly maxGroundedRepos: number;
  private readonly groundingTimeoutMs: number;
  private readonly enabled: boolean;

  constructor(options: ComposeRepoGroundingOptions = {}) {
    this.lookupRepositories = options.lookupRepositories;
    this.workspaceManager = options.workspaceManager;
    this.scanRepo = options.scanRepo ?? defaultScanRepo;
    this.formatScanForPrompt =
      options.formatScanForPrompt ?? defaultFormatScanForPrompt;
    this.buildRouteCardContext =
      options.buildRouteCardContext ??
      ((repoName: string) => defaultBuildRouteCardContext(repoName, "") ?? "");
    this.maxGroundedRepos =
      options.maxGroundedRepos ?? DEFAULT_MAX_GROUNDED_REPOS;
    this.groundingTimeoutMs =
      options.groundingTimeoutMs ?? DEFAULT_GROUNDING_TIMEOUT_MS;
    this.enabled =
      options.enabled ??
      (process.env.COMPOSE_REPO_GROUNDING_ENABLED ?? "true").toLowerCase() !==
        "false";
  }

  async groundRepos(input: {
    selectedRepositoryIds: number[];
    sources: Array<{ filename: string; content: string }>;
  }): Promise<ComposeRepoGroundingResult> {
    const empty: ComposeRepoGroundingResult = {
      codeRepoIds: [],
      repositoriesMarkdown: "",
      manifest: [],
      workspaces: [],
    };
    if (!this.lookupRepositories) return empty;

    const all = await this.lookupRepositories();
    const repos = this.resolveRepos(
      all,
      input.selectedRepositoryIds,
      input.sources,
    );
    if (repos.length === 0) return empty;

    // Disabled (or no clone machinery): metadata-only, no clone.
    if (!this.enabled || !this.workspaceManager) {
      return {
        codeRepoIds: [],
        repositoriesMarkdown: wrapMarkdown(repos.map(metadataBlock).join("\n")),
        manifest: repos.map((repo) => ({
          repoName: repo.repo_name,
          inspectedPaths: [],
          keyMatches: [],
          warnings: this.enabled
            ? []
            : ["repo grounding disabled; metadata only"],
        })),
        workspaces: [],
      };
    }

    const codeRepoIds: string[] = [];
    const blocks: string[] = [];
    const manifest: ComposeRepoEvidence[] = [];
    const workspaces: ComposeRepoGroundingResult["workspaces"] = [];

    for (const repo of repos) {
      try {
        const { ws, scan } = await withTimeout(
          (async () => {
            const workspace =
              await this.workspaceManager!.prepareMasterWorkspace({
                sourceId: repo.id,
                repo: { repo_name: repo.repo_name, repo_url: repo.repo_url },
              });
            return {
              ws: workspace,
              scan: await this.scanRepo(workspace.workspacePath),
            };
          })(),
          this.groundingTimeoutMs,
          `Repo grounding (${repo.repo_name})`,
        );
        const routeCards = this.safeRouteCards(repo.repo_name);
        codeRepoIds.push(ws.repoId);
        workspaces.push({
          repoName: repo.repo_name,
          workspacePath: ws.workspacePath,
          headSha: ws.headSha,
          cleanup: ws.cleanup,
        });
        blocks.push(
          [`## ${repo.repo_name}`, this.formatScanForPrompt(scan), routeCards]
            .filter(Boolean)
            .join("\n\n"),
        );
        manifest.push({
          repoName: repo.repo_name,
          headSha: ws.headSha,
          techStack: techStackSummary(scan),
          inspectedPaths: scan.keyFiles.map((f) => f.path),
          keyMatches: [],
          warnings: [],
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn(
          { repoName: repo.repo_name, repoId: repo.id, error: reason },
          "compose repo grounding degraded to metadata-only",
        );
        blocks.push(metadataBlock(repo));
        manifest.push({
          repoName: repo.repo_name,
          inspectedPaths: [],
          keyMatches: [],
          warnings: [`code unavailable, used metadata only (${reason})`],
        });
      }
    }

    return {
      codeRepoIds,
      repositoriesMarkdown: wrapMarkdown(blocks.join("\n\n")),
      manifest,
      workspaces,
    };
  }

  private safeRouteCards(repoName: string): string {
    try {
      return this.buildRouteCardContext(repoName) || "";
    } catch {
      return "";
    }
  }

  /** Selected repos first (they win on cap), then auto-identified, deduped. */
  private resolveRepos(
    all: CodeRepository[],
    selectedIds: number[],
    sources: Array<{ filename: string; content: string }>,
  ): CodeRepository[] {
    const byId = new Map(all.map((r) => [r.id, r]));
    const ordered: CodeRepository[] = [];
    const seen = new Set<number>();

    for (const id of selectedIds) {
      const r = byId.get(id);
      if (r && !seen.has(r.id)) {
        seen.add(r.id);
        ordered.push(r);
      }
    }

    const haystack = sources
      .map((s) => s.content)
      .join("\n")
      .toLowerCase();
    if (haystack.trim()) {
      for (const r of all) {
        if (seen.has(r.id)) continue;
        const tokens = getRepoMentionTokens({
          repo_name: r.repo_name,
          repo_url: r.repo_url,
        });
        const mentioned = tokens.some(
          (t) => t.length >= 3 && haystack.includes(t.toLowerCase()),
        );
        if (mentioned) {
          seen.add(r.id);
          ordered.push(r);
        }
      }
    }

    return ordered.slice(0, Math.max(1, this.maxGroundedRepos));
  }
}
