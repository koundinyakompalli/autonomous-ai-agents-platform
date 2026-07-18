import { GITHUB_PROJECT_CATALOG } from "./github-project-catalog.generated.js";

export interface GitHubProjectCatalogEntry {
  repo: string;
  repoFullName: string;
  projectName: string;
  projectPath: string;
  projectType: string;
  defaultBranch: string;
}

export interface RepoCatalogResolution {
  repoName: string;
  repoFullName: string;
  projectName: string;
  projectPath: string;
  projectType: string;
  defaultBranch: string;
  confidence: "high" | "medium";
  evidence: string[];
}

interface RuntimeHint {
  value: string;
  label: string;
  exactOnly?: boolean;
}

interface ScoredCatalogEntry {
  entry: GitHubProjectCatalogEntry;
  score: number;
  evidence: string[];
}

const GENERIC_PROJECT_KEYS = new Set([
  "api",
  "app",
  "backend",
  "build",
  "common",
  "config",
  "core",
  "dashboard",
  "docs",
  "frontend",
  "lambda",
  "scripts",
  "server",
  "service",
  "source",
  "test",
  "tests",
  "utils",
]);

const CATALOG = GITHUB_PROJECT_CATALOG as readonly GitHubProjectCatalogEntry[];

export function resolveRepoFromProjectCatalog(
  locationPath: string,
  catalog: readonly GitHubProjectCatalogEntry[] = CATALOG,
): RepoCatalogResolution | undefined {
  const normalizedPath = normalizeLocationPath(locationPath);
  const hints = extractRuntimeHints(normalizedPath);
  if (hints.length === 0) return undefined;

  const scored = catalog
    .map((entry) => scoreCatalogEntry(entry, hints, normalizedPath))
    .filter((candidate): candidate is ScoredCatalogEntry => !!candidate)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.repo.localeCompare(b.entry.repo) ||
        a.entry.projectPath.localeCompare(b.entry.projectPath),
    );

  const best = scored[0];
  if (!best || best.score < 85) return undefined;

  const competing = scored.find(
    (candidate) =>
      candidate !== best &&
      candidate.score === best.score &&
      catalogIdentity(candidate.entry) !== catalogIdentity(best.entry),
  );
  if (competing) return undefined;

  return {
    repoName: best.entry.repo,
    repoFullName: best.entry.repoFullName,
    projectName: best.entry.projectName,
    projectPath: best.entry.projectPath,
    projectType: best.entry.projectType,
    defaultBranch: best.entry.defaultBranch,
    confidence: best.score >= 95 ? "high" : "medium",
    evidence: best.evidence,
  };
}

function scoreCatalogEntry(
  entry: GitHubProjectCatalogEntry,
  hints: RuntimeHint[],
  normalizedPath: string,
): ScoredCatalogEntry | undefined {
  const projectKeys = projectComparableKeys(entry);
  const pathKeys = normalizedPath
    .split("/")
    .map(normalizeComparable)
    .filter(Boolean);

  let score = 0;
  const evidence: string[] = [];

  for (const hint of hints) {
    const hintKey = normalizeComparable(hint.value);
    if (!hintKey) continue;

    if (projectKeys.exact.has(hintKey)) {
      const hintScore = hint.label.startsWith("/opt/repo") ? 100 : 98;
      if (hintScore > score) score = hintScore;
      evidence.push(
        `Catalog project "${entry.projectName}" matched ${hint.label} "${hint.value}"`,
      );
      continue;
    }

    if (hint.exactOnly || GENERIC_PROJECT_KEYS.has(hintKey)) continue;

    for (const projectKey of projectKeys.fuzzy) {
      if (
        projectKey.length >= 6 &&
        (projectKey.includes(hintKey) || hintKey.includes(projectKey))
      ) {
        if (90 > score) score = 90;
        evidence.push(
          `Catalog project "${entry.projectName}" closely matched ${hint.label} "${hint.value}"`,
        );
      }
    }
  }

  if (score === 0) {
    for (const projectKey of projectKeys.exact) {
      if (
        projectKey.length >= 6 &&
        !GENERIC_PROJECT_KEYS.has(projectKey) &&
        pathKeys.includes(projectKey)
      ) {
        score = 88;
        evidence.push(
          `Catalog project "${entry.projectName}" appeared as a path segment`,
        );
        break;
      }
    }
  }

  if (score === 0) return undefined;

  evidence.push(
    `GitHub catalog: ${entry.repoFullName}${entry.projectPath ? `/${entry.projectPath}` : ""} (${entry.projectType})`,
  );

  return { entry, score, evidence: [...new Set(evidence)] };
}

function extractRuntimeHints(locationPath: string): RuntimeHint[] {
  const pathOnly = locationPath.split(" -> ")[0] ?? locationPath;
  const hints: RuntimeHint[] = [];

  const optRepo = pathOnly.match(/^\/opt\/repo\/([^/]+)/i);
  if (optRepo?.[1]) {
    hints.push({
      value: optRepo[1],
      label: "/opt/repo project",
    });
  }

  const optSoftwareMedhok = pathOnly.match(
    /^\/opt\/software\/medhok\/([^/]+)/i,
  );
  if (optSoftwareMedhok?.[1]) {
    hints.push({
      value: optSoftwareMedhok[1],
      label: "/opt/software/medhok runtime project",
    });
  }

  const software = pathOnly.match(/^\/(?:opt\/)?software\/([^/]+)/i);
  if (software?.[1] && software[1].toLowerCase() !== "medhok") {
    hints.push({
      value: software[1],
      label: "/software runtime project",
    });
  }

  const webapp = pathOnly.match(/\/webapps\/([^/]+)/i);
  if (webapp?.[1]) {
    hints.push({
      value: webapp[1],
      label: "webapp context",
      exactOnly: true,
    });
  }

  return dedupeHints(hints);
}

function projectComparableKeys(entry: GitHubProjectCatalogEntry): {
  exact: Set<string>;
  fuzzy: Set<string>;
} {
  const exact = new Set<string>();
  const fuzzy = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value) return;
    const key = normalizeComparable(value);
    if (!key) return;
    exact.add(key);
    if (!GENERIC_PROJECT_KEYS.has(key)) fuzzy.add(key);
  };

  add(entry.projectName);
  add(entry.projectPath);
  add(lastPathSegment(entry.projectPath));
  add(entry.repo);

  return { exact, fuzzy };
}

function dedupeHints(hints: RuntimeHint[]): RuntimeHint[] {
  const seen = new Set<string>();
  const unique: RuntimeHint[] = [];
  for (const hint of hints) {
    const key = `${hint.label}:${normalizeComparable(hint.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hint);
  }
  return unique;
}

function catalogIdentity(entry: GitHubProjectCatalogEntry): string {
  return `${entry.repo}:${entry.projectPath}:${entry.projectName}`;
}

function lastPathSegment(value: string): string | undefined {
  const parts = value.split("/").filter(Boolean);
  return parts[parts.length - 1];
}

function normalizeLocationPath(locationPath: string): string {
  return locationPath.replace(/^\/\[Partition=[^\]]+\]/i, "");
}

function normalizeComparable(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
