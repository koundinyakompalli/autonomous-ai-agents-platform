import type { CodeRepository } from "../orchestrator/database.js";
import {
  dedupeOneShotEnabledRepos,
  getRepoMentionTokens,
  getRepositorySlug,
  isOneShotRepoEnabled,
} from "./repo-metadata.js";
import {
  fetchGitHubRepositoryMetadata,
  type GitHubRepositoryMetadata,
  parseGitHubRepoRef,
  parseGitHubRepoUrl,
  searchGitHubRepositoriesByName,
} from "./github.js";

const MAX_GITHUB_REPO_LOOKUPS = 5;
const DEFAULT_GITHUB_LOOKUP_TIMEOUT_MS = 5_000;

export type ExplicitRepoProfileStatus =
  | "profiled"
  | "unprofiled"
  | "github_resolved";

export interface ExplicitRepoResolution {
  repo: CodeRepository | null;
  profileStatus: ExplicitRepoProfileStatus | null;
  selectedReason:
    | "explicit_repo"
    | "explicit_github_repo"
    | "explicit_repo_unresolved";
  explicitRepoHint: string;
  registeredCandidates: string[];
  githubCandidates: string[];
  blockingReasons: string[];
}

export interface ExplicitRepoResolverDatabase {
  upsertCodeRepository(input: {
    repoName: string;
    repoUrl: string;
    description: string;
    defaultBranch: string;
  }): Promise<CodeRepository>;
}

export function normalizeExplicitRepoValue(value: string): string {
  return value
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^<(.+)>$/g, "$1")
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .trim();
}

function normalizeComparable(value: string): string {
  return normalizeExplicitRepoValue(value).toLowerCase();
}

function canonicalRepoUrl(repoUrl: string): string {
  return normalizeComparable(repoUrl);
}

function ownerRepoCandidates(
  value: string,
): Array<{ owner: string; repo: string }> {
  const normalized = normalizeExplicitRepoValue(value);
  try {
    return [parseGitHubRepoRef(normalized)];
  } catch {
    // Fall through.
  }

  if (/^https:\/\/github\.com\//i.test(normalized)) {
    try {
      return [parseGitHubRepoUrl(normalized)];
    } catch {
      return [];
    }
  }

  return [];
}

function uniqueOwnerRepoCandidates(
  candidates: Array<{ owner: string; repo: string }>,
): Array<{ owner: string; repo: string }> {
  const seen = new Set<string>();
  const unique: Array<{ owner: string; repo: string }> = [];
  for (const candidate of candidates) {
    const key = `${candidate.owner.toLowerCase()}/${candidate.repo.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

export function findRegisteredExplicitRepoMatches(
  value: string,
  repos: CodeRepository[],
): CodeRepository[] {
  const normalized = normalizeComparable(value);
  const ownerRepoRefs = ownerRepoCandidates(value);
  const ownerRepoNames = ownerRepoRefs.map((ref) =>
    `${ref.owner}/${ref.repo}`.toLowerCase(),
  );

  const matches = repos.filter((repo) => {
    const slug = getRepositorySlug(repo.repo_url);
    const repoUrl = canonicalRepoUrl(repo.repo_url);
    const tokens = getRepoMentionTokens(repo).map((token) =>
      normalizeComparable(token),
    );
    const repoOwnerRefs = ownerRepoCandidates(repo.repo_url).map((ref) =>
      `${ref.owner}/${ref.repo}`.toLowerCase(),
    );

    return (
      normalizeComparable(repo.repo_name) === normalized ||
      (slug ? normalizeComparable(slug) === normalized : false) ||
      repoUrl === normalized ||
      tokens.includes(normalized) ||
      ownerRepoNames.some((candidate) => repoOwnerRefs.includes(candidate))
    );
  });

  const enabledMatches = dedupeOneShotEnabledRepos(matches);
  const enabledMatchIds = new Set(enabledMatches.map((repo) => repo.id));
  const unsupportedMatches = matches.filter(
    (repo) => !enabledMatchIds.has(repo.id) && !isOneShotRepoEnabled(repo),
  );

  return [...enabledMatches, ...unsupportedMatches];
}

export function findRegisteredExplicitRepoMatch(
  value: string,
  repos: CodeRepository[],
): CodeRepository | null {
  const matches = findRegisteredExplicitRepoMatches(value, repos);
  return matches.length === 1 ? matches[0] : null;
}

function allowedOwnersForExplicitRepo(repos: CodeRepository[]): string[] {
  const envOwners = process.env.ONESHOT_GITHUB_REPO_OWNERS?.split(",")
    .map((owner) => owner.trim())
    .filter(Boolean);
  if (envOwners && envOwners.length > 0) {
    return Array.from(new Set(envOwners));
  }

  const owners = repos.flatMap((repo) => ownerRepoCandidates(repo.repo_url));
  const distinct = Array.from(new Set(owners.map((ref) => ref.owner)));
  return distinct;
}

async function upsertGitHubResolvedRepo(
  db: ExplicitRepoResolverDatabase,
  input: {
    repoName: string;
    repoUrl: string;
    description: string;
    defaultBranch: string;
  },
): Promise<CodeRepository> {
  return db.upsertCodeRepository(input);
}

function explicitRepoGithubTimeoutMs(): number {
  const parsed = Number(process.env.ONESHOT_EXPLICIT_REPO_GITHUB_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_GITHUB_LOOKUP_TIMEOUT_MS;
}

export async function resolveExplicitRepoHint(
  db: ExplicitRepoResolverDatabase,
  value: string,
  availableRepos: CodeRepository[],
): Promise<ExplicitRepoResolution> {
  const explicitRepoHint = normalizeExplicitRepoValue(value);
  const registeredMatches = findRegisteredExplicitRepoMatches(
    explicitRepoHint,
    availableRepos,
  );

  const registered = registeredMatches[0] ?? null;

  const explicitRefs = ownerRepoCandidates(explicitRepoHint);
  const registeredRefs =
    registeredMatches.length === 1 && registered
      ? ownerRepoCandidates(registered.repo_url)
      : [];
  const allowedOwners = allowedOwnersForExplicitRepo(availableRepos);
  const candidateRefs = uniqueOwnerRepoCandidates(
    [
      ...explicitRefs,
      ...registeredRefs,
      ...(explicitRefs.length === 0 && registeredRefs.length === 0
        ? allowedOwners.slice(0, MAX_GITHUB_REPO_LOOKUPS).map((owner) => ({
            owner,
            repo: explicitRepoHint,
          }))
        : []),
    ].slice(0, MAX_GITHUB_REPO_LOOKUPS),
  );
  if (candidateRefs.length === 0) {
    if (registeredMatches.length > 1) {
      const registeredCandidates = registeredMatches.map(
        (repo) => repo.repo_name,
      );
      return {
        repo: null,
        profileStatus: null,
        selectedReason: "explicit_repo_unresolved",
        explicitRepoHint,
        registeredCandidates,
        githubCandidates: [],
        blockingReasons: [
          `explicit_repo_unresolved: Explicit Repo ${explicitRepoHint} matched multiple registered repositories: ${registeredCandidates.join(", ")}.`,
        ],
      };
    }

    return {
      repo: null,
      profileStatus: null,
      selectedReason: "explicit_repo_unresolved",
      explicitRepoHint,
      registeredCandidates: [],
      githubCandidates: [],
      blockingReasons: [
        `explicit_repo_unresolved: Explicit Repo ${explicitRepoHint} could not be resolved because no GitHub owners were configured or derivable from registered repositories.`,
      ],
    };
  }

  const githubCandidates: string[] = [];
  const resolvedRepos: GitHubRepositoryMetadata[] = [];
  const timeoutMs = explicitRepoGithubTimeoutMs();
  let githubAttemptCount = 0;

  for (const ref of candidateRefs) {
    githubAttemptCount += 1;
    const metadata = await Promise.resolve(
      fetchGitHubRepositoryMetadata(ref.owner, ref.repo, {
        timeoutMs,
      }),
    ).catch(() => null);
    if (!metadata) {
      continue;
    }
    githubCandidates.push(metadata.fullName);
    resolvedRepos.push(metadata);
  }

  if (resolvedRepos.length === 0 && explicitRefs.length === 0) {
    const searched: GitHubRepositoryMetadata[] = [];
    for (const owner of allowedOwners.slice(0, MAX_GITHUB_REPO_LOOKUPS)) {
      if (githubAttemptCount >= MAX_GITHUB_REPO_LOOKUPS) {
        break;
      }
      githubAttemptCount += 1;
      const results = await Promise.resolve(
        searchGitHubRepositoriesByName(owner, explicitRepoHint, { timeoutMs }),
      ).catch(() => []);
      searched.push(
        ...results.filter((candidate) => {
          const name = candidate.repo.toLowerCase();
          const hint = explicitRepoHint.toLowerCase();
          return name === hint || name.includes(hint) || hint.includes(name);
        }),
      );
    }
    const distinctByFullName = new Map(
      searched.map((candidate) => [candidate.fullName, candidate]),
    );
    resolvedRepos.push(...distinctByFullName.values());
    githubCandidates.push(...distinctByFullName.keys());
  }

  if (resolvedRepos.length === 1) {
    const metadata = resolvedRepos[0];
    const repo = await upsertGitHubResolvedRepo(db, {
      repoName: metadata.repo,
      repoUrl: metadata.cloneUrl,
      description:
        metadata.description ||
        `GitHub repository resolved from explicit Repo field: ${metadata.fullName}`,
      defaultBranch: metadata.defaultBranch || "main",
    });
    return {
      repo,
      profileStatus: "github_resolved",
      selectedReason: "explicit_github_repo",
      explicitRepoHint,
      registeredCandidates: registeredMatches.map((repo) => repo.repo_name),
      githubCandidates,
      blockingReasons: [],
    };
  }

  if (resolvedRepos.length > 1) {
    return {
      repo: null,
      profileStatus: null,
      selectedReason: "explicit_repo_unresolved",
      explicitRepoHint,
      registeredCandidates: registeredMatches.map((repo) => repo.repo_name),
      githubCandidates,
      blockingReasons: [
        `explicit_repo_unresolved: Explicit Repo ${explicitRepoHint} matched multiple GitHub repositories: ${githubCandidates.join(", ")}.`,
      ],
    };
  }

  if (registeredMatches.length > 1) {
    const registeredCandidates = registeredMatches.map(
      (repo) => repo.repo_name,
    );
    return {
      repo: null,
      profileStatus: null,
      selectedReason: "explicit_repo_unresolved",
      explicitRepoHint,
      registeredCandidates,
      githubCandidates,
      blockingReasons: [
        `explicit_repo_unresolved: Explicit Repo ${explicitRepoHint} matched multiple registered repositories: ${registeredCandidates.join(", ")}.`,
      ],
    };
  }

  if (registered) {
    return {
      repo: registered,
      profileStatus: isOneShotRepoEnabled(registered)
        ? "profiled"
        : "unprofiled",
      selectedReason: "explicit_repo",
      explicitRepoHint,
      registeredCandidates: [registered.repo_name],
      githubCandidates,
      blockingReasons: [],
    };
  }

  return {
    repo: null,
    profileStatus: null,
    selectedReason: "explicit_repo_unresolved",
    explicitRepoHint,
    registeredCandidates: [],
    githubCandidates,
    blockingReasons: [
      resolvedRepos.length > 1
        ? `explicit_repo_unresolved: Explicit Repo ${explicitRepoHint} matched multiple GitHub repositories: ${githubCandidates.join(", ")}.`
        : `explicit_repo_unresolved: Explicit Repo ${explicitRepoHint} could not be resolved to a registered or accessible GitHub repository.`,
    ],
  };
}
