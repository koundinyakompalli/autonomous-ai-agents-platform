import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_SEARCH_TERMS = 6;
const MAX_SEARCH_QUERIES = 4;
const MAX_REPOSITORIES = 3;
const cache = new Map<string, { expiresAt: number; repositories: DiscoveredGitHubRepository[] }>();

const GENERIC_TICKET_TERMS = new Set([
  "application", "business", "client", "configuration", "environment",
  "failure", "foreign", "identifier", "incident", "integration", "issue",
  "member", "production", "request", "requests", "service", "support",
]);

interface GitHubCodeSearchItem {
  path?: string;
  repository?: {
    name?: string;
    full_name?: string;
    clone_url?: string;
    default_branch?: string;
    description?: string | null;
    archived?: boolean;
    fork?: boolean;
  };
}

interface GitHubCodeSearchResponse {
  items?: GitHubCodeSearchItem[];
}

export interface DiscoveredGitHubRepository {
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  description: string;
  matchedTerms: string[];
  matchedPaths: string[];
}

export function selectRepositoryDiscoveryTerms(values: string[]): string[] {
  return Array.from(new Set(values
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z_][A-Za-z0-9_.-]{5,79}$/.test(value))
    .filter((value) => !/^_/.test(value) && !/[-_]{3,}/.test(value) && !/\d{4,}/.test(value))
    .filter((value) => !GENERIC_TICKET_TERMS.has(value.toLowerCase()))
    .filter((value) => !/^(?:prod|dev|int|uat|stage)[-_]?\d*$/i.test(value))))
    .sort((left, right) => repositoryTermScore(right) - repositoryTermScore(left))
    .slice(0, MAX_SEARCH_TERMS);
}

export async function discoverGitHubRepositoriesForTicket(input: {
  organization: string;
  terms: string[];
}): Promise<DiscoveredGitHubRepository[]> {
  if (process.env.INVESTIGATION_GITHUB_CATALOG_DISCOVERY?.trim().toLowerCase() === "false") {
    return [];
  }
  const organization = input.organization.trim();
  const terms = selectRepositoryDiscoveryTerms(input.terms);
  if (!organization || terms.length === 0) {
    return [];
  }

  const cacheKey = `${organization.toLowerCase()}:${terms.map((term) => term.toLowerCase()).join(",")}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.repositories;
  }

  const candidates = new Map<string, DiscoveredGitHubRepository & { score: number }>();
  const searches = await Promise.all(buildRepositoryDiscoveryQueries(terms).map(async (query) => ({
    query,
    response: await searchOrganizationCode(organization, query).catch(() => ({ items: [] })),
  })));
  for (const { query, response } of searches) {
    const queryTerms = query.split(" ");
    for (const item of response.items || []) {
      const repository = item.repository;
      const fullName = repository?.full_name?.trim() || "";
      const name = repository?.name?.trim() || "";
      if (
        !name
        || !fullName.toLowerCase().startsWith(`${organization.toLowerCase()}/`)
        || repository?.archived
        || repository?.fork
      ) {
        continue;
      }
      const existing = candidates.get(fullName.toLowerCase());
      if (existing) {
        existing.score += queryTerms.reduce((score, term) => score + repositoryTermScore(term), 0);
        for (const term of queryTerms) {
          if (!existing.matchedTerms.includes(term)) existing.matchedTerms.push(term);
        }
        if (item.path && !existing.matchedPaths.includes(item.path)) existing.matchedPaths.push(item.path);
        continue;
      }
      candidates.set(fullName.toLowerCase(), {
        name,
        fullName,
        cloneUrl: repository?.clone_url || `https://github.com/${fullName}.git`,
        defaultBranch: repository?.default_branch || "main",
        description: repository?.description?.trim() || "",
        matchedTerms: queryTerms,
        matchedPaths: item.path ? [item.path] : [],
        score: queryTerms.reduce((score, term) => score + repositoryTermScore(term), 0),
      });
    }
  }

  const repositories = Array.from(candidates.values())
    .sort((left, right) => right.score - left.score || left.fullName.localeCompare(right.fullName))
    .slice(0, MAX_REPOSITORIES)
    .map(({ score: _score, ...repository }) => repository);
  cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, repositories });
  return repositories;
}

export function buildRepositoryDiscoveryQueries(terms: string[]): string[] {
  const selected = selectRepositoryDiscoveryTerms(terms);
  const pairs = selected.slice(1, 3).map((term) => `${selected[0]} ${term}`);
  return [...pairs, ...selected].filter(Boolean).slice(0, MAX_SEARCH_QUERIES);
}

function repositoryTermScore(term: string): number {
  let score = Math.min(term.length, 24);
  if (/[a-z][A-Z]/.test(term)) score += 20;
  if (/[_\-.]/.test(term)) score += 12;
  if (/^[A-Z][A-Za-z0-9]+$/.test(term)) score += 6;
  return score;
}

async function searchOrganizationCode(
  organization: string,
  term: string,
): Promise<GitHubCodeSearchResponse> {
  if (process.env.NODE_ENV === "test"
      && process.env.INVESTIGATION_GITHUB_CATALOG_TEST_LIVE !== "true") {
    return { items: [] };
  }
  const token = process.env.GITHUB_REPO_TOKEN?.trim()
    || process.env.GH_TOKEN?.trim()
    || process.env.GITHUB_TOKEN?.trim();
  const query = `${term} org:${organization}`;
  if (token) {
    const url = new URL("https://api.github.com/search/code");
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", "20");
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`GitHub code search failed with HTTP ${response.status}`);
    }
    return await response.json() as GitHubCodeSearchResponse;
  }

  const { stdout } = await execFileAsync("gh", [
    "api", "-X", "GET", "search/code",
    "-f", `q=${query}`,
    "-f", "per_page=20",
  ], { timeout: 8_000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(stdout) as GitHubCodeSearchResponse;
}
