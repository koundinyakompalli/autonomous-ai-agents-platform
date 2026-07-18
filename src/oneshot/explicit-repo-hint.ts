import type { CodeRepository } from "../orchestrator/database.js";
import { getRepositorySlug } from "./repo-metadata.js";
import { parseTicketIntent } from "./ticket-intent.js";

export type ExplicitRepoHintSource =
  | "labeled_field"
  | "github_url"
  | "owner_repo"
  | "registered_repo_name";

export interface ExplicitRepoHint {
  value: string;
  source: ExplicitRepoHintSource;
}

const REPO_TOKEN_BOUNDARY = "[^A-Za-z0-9_.-]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeGitHubRepoSlug(value: string): string {
  return value.replace(/[.,;:!?]+$/g, "").replace(/\.git$/i, "");
}

function ownerRepoFromUrl(value: string): string | null {
  const matches = Array.from(
    value.matchAll(
      /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?(?:[/?#][^\s<>)\]]*)?/gi,
    ),
  )
    .map((match) =>
      match[1] && match[2]
        ? `${match[1]}/${normalizeGitHubRepoSlug(match[2])}`
        : null,
    )
    .filter((match): match is string => Boolean(match));

  const unique = Array.from(
    new Set(matches.map((match) => match.toLowerCase())),
  );
  return unique.length === 1 ? matches[0] : null;
}

function ownersFromRepos(repos: CodeRepository[]): Set<string> {
  const owners = new Set<string>();
  for (const repo of repos) {
    const match = repo.repo_url.match(/github\.com[:/]([^/]+)\//i);
    if (match?.[1]) {
      owners.add(match[1].toLowerCase());
    }
  }

  const envOwners = process.env.ONESHOT_GITHUB_REPO_OWNERS?.split(",")
    .map((owner) => owner.trim().toLowerCase())
    .filter(Boolean);
  for (const owner of envOwners ?? []) {
    owners.add(owner);
  }

  owners.add("mhk-repos");
  return owners;
}

function ownerRepoFromText(
  ticketText: string,
  repos: CodeRepository[],
): string | null {
  const allowedOwners = ownersFromRepos(repos);
  const matches = Array.from(
    ticketText.matchAll(
      /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9])(?:\.git)?\b/g,
    ),
  )
    .map((match) => ({
      owner: match[1],
      repo: match[2].replace(/\.git$/i, ""),
    }))
    .filter((match) => allowedOwners.has(match.owner.toLowerCase()));

  const unique = Array.from(
    new Set(matches.map((match) => `${match.owner}/${match.repo}`)),
  );
  return unique.length === 1 ? unique[0] : null;
}

function containsExactToken(text: string, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) {
    return false;
  }
  const rx = new RegExp(
    `(^|${REPO_TOKEN_BOUNDARY})${escapeRegExp(trimmed)}(?=$|${REPO_TOKEN_BOUNDARY})`,
    "i",
  );
  return rx.test(text);
}

function registeredRepoNameFromText(
  ticketText: string,
  repos: CodeRepository[],
): string | null {
  const matches: string[] = [];
  for (const repo of repos) {
    const tokens = [repo.repo_name, getRepositorySlug(repo.repo_url)].filter(
      (token): token is string => Boolean(token?.trim()),
    );
    if (tokens.some((token) => containsExactToken(ticketText, token))) {
      matches.push(repo.repo_name);
    }
  }

  return Array.from(new Set(matches)).length === 1 ? matches[0] : null;
}

export function detectExplicitRepoHint(
  ticketText: string,
  availableRepos: CodeRepository[],
): ExplicitRepoHint | null {
  const repoHint = parseTicketIntent(ticketText).repoHint;
  if (repoHint?.value) {
    return {
      value: repoHint.value,
      source: "labeled_field",
    };
  }

  const githubUrl = ownerRepoFromUrl(ticketText);
  if (githubUrl) {
    return {
      value: githubUrl,
      source: "github_url",
    };
  }

  const ownerRepo = ownerRepoFromText(ticketText, availableRepos);
  if (ownerRepo) {
    return {
      value: ownerRepo,
      source: "owner_repo",
    };
  }

  const registeredRepoName = registeredRepoNameFromText(
    ticketText,
    availableRepos,
  );
  if (registeredRepoName) {
    return {
      value: registeredRepoName,
      source: "registered_repo_name",
    };
  }

  return null;
}
