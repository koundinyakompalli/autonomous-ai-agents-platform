import fs from "fs/promises";
import path from "path";
import type { CodeRepository } from "../../orchestrator/database.js";
import {
  dedupeOneShotEnabledRepos,
  getOneShotRepoMetadata,
} from "../repo-metadata.js";
import type {
  RepoProfile,
  RepoProfileSection,
  RepoRouterWeights,
} from "./types.js";

const PROFILE_KEYS: Array<keyof RepoProfileSection> = [
  "aliases",
  "domains",
  "packages",
  "file_path_patterns",
  "symbols",
  "endpoints",
  "tables",
];

const EMPTY_SECTION: RepoProfileSection = {
  aliases: [],
  domains: [],
  packages: [],
  file_path_patterns: [],
  symbols: [],
  endpoints: [],
  tables: [],
};

function requireRepoProfiles(): boolean {
  return process.env.NODE_ENV === "production";
}

function requireRepoRouterWeights(): boolean {
  return process.env.NODE_ENV === "production";
}

export async function loadRepoProfiles(
  repos: CodeRepository[],
  options: { profileDir?: string; requireProfiles?: boolean } = {},
): Promise<Map<string, RepoProfile>> {
  const shouldRequireProfiles =
    options.requireProfiles ?? requireRepoProfiles();
  const profileDir =
    options.profileDir ?? path.join(process.cwd(), "config", "repo-profiles");
  const profiles = new Map<string, RepoProfile>();

  repoLoop: for (const repo of dedupeOneShotEnabledRepos(repos)) {
    const profileNames = getProfileCandidateNames(repo);
    const attemptedProfilePaths: string[] = [];

    for (const profileName of profileNames) {
      const profilePath = path.join(profileDir, `${profileName}.yaml`);
      attemptedProfilePaths.push(profilePath);
      try {
        const content = await fs.readFile(profilePath, "utf8");
        profiles.set(
          repo.repo_name.toLowerCase(),
          parseRepoProfile(repo.repo_name, content),
        );
        continue repoLoop;
      } catch (error: any) {
        if (error?.code !== "ENOENT" && shouldRequireProfiles) {
          throw error;
        }
      }
    }

    if (shouldRequireProfiles) {
      throw new Error(
        `Missing RepoRouter profile for enabled repo ${repo.repo_name}: ${attemptedProfilePaths.join(", ")}`,
      );
    }
    profiles.set(repo.repo_name.toLowerCase(), buildFallbackProfile(repo));
  }

  return profiles;
}

function getProfileCandidateNames(repo: CodeRepository): string[] {
  const metadata = getOneShotRepoMetadata(repo);
  return Array.from(
    new Set(
      [repo.repo_name, metadata?.repoName].filter((value): value is string =>
        Boolean(value?.trim()),
      ),
    ),
  );
}

export async function loadRepoRouterWeights(
  weightsPath = path.join(
    process.cwd(),
    "config",
    "repo-router",
    "weights.yaml",
  ),
  options: { requireWeights?: boolean } = {},
): Promise<RepoRouterWeights> {
  const shouldRequireWeights =
    options.requireWeights ?? requireRepoRouterWeights();
  try {
    const content = await fs.readFile(weightsPath, "utf8");
    return parseWeights(content, { strict: shouldRequireWeights });
  } catch (error: any) {
    if (shouldRequireWeights) {
      throw new Error(
        `Missing or invalid RepoRouter weights config: ${weightsPath}: ${error?.message ?? error}`,
      );
    }
    return DEFAULT_WEIGHTS;
  }
}

export function parseRepoProfile(
  repoName: string,
  content: string,
): RepoProfile {
  const parsed = parseSimpleYaml(content);
  const generated = normalizeSection(parsed.generated);
  const curated = normalizeSection(parsed.curated);
  const merged = mergeSections(generated, curated);
  const profile: RepoProfile = {
    repoName,
    schema_version: stringValue(parsed.schema_version, "1"),
    profile_version: stringValue(parsed.profile_version, "1"),
    generated_at: stringValue(parsed.generated_at, ""),
    source_repo_commit_sha: stringValue(parsed.source_repo_commit_sha, ""),
    generated,
    curated,
    merged,
    profileText: "",
    summary: extractProfileSummary(content),
  };
  profile.profileText = buildProfileText(profile);
  return profile;
}

/**
 * Extract the human-authored summary paragraph from the YAML's leading
 * comment block (preceded by `# Summary:` and preserved across regeneration).
 * Returns a single normalized string (newlines and `#` markers stripped);
 * empty string when no summary comment is present.
 */
export function extractProfileSummary(yamlContent: string): string {
  const lines = yamlContent.split(/\r?\n/);
  // Find the comment block that precedes `curated:`. Walk up from curated:
  // and collect consecutive `#` lines.
  const curatedIdx = lines.findIndex((line) => /^curated\s*:/.test(line));
  if (curatedIdx === -1) return "";
  let startIdx = curatedIdx;
  for (let i = curatedIdx - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) {
      startIdx = i;
      continue;
    }
    break;
  }
  if (startIdx === curatedIdx) return "";
  // Strip `#` markers, optional leading space, and drop pure-divider lines
  // (e.g. `# -------------`) that many curated blocks use as visual separators.
  const summary = lines
    .slice(startIdx, curatedIdx)
    .map((line) => line.trim().replace(/^#+\s?/, ""))
    .filter((line) => line !== "" && !/^-{3,}$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    // Remove any lingering long dash-runs that came from joining divider-adjacent lines.
    .replace(/\s-{3,}\s*/g, " ")
    .trim();
  return summary;
}

export function parseWeights(
  content: string,
  options: { strict?: boolean } = {},
): RepoRouterWeights {
  const strict = options.strict ?? false;
  const parsed = parseSimpleYaml(content);
  const thresholds = objectValue(parsed.thresholds);
  const weights = objectValue(parsed.weights);
  const decay = objectValue(parsed.decay);
  const caps = objectValue(parsed.caps);
  const requiredString = (value: unknown, key: string, fallback: string) => {
    const parsedValue =
      value === undefined || value === null ? "" : String(value).trim();
    if (parsedValue) return parsedValue;
    if (strict) {
      throw new Error(`RepoRouter weights missing required key ${key}`);
    }
    return fallback;
  };
  const requiredNumber = (value: unknown, key: string, fallback: number) => {
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric)) return numeric;
    if (strict) {
      throw new Error(`RepoRouter weights missing numeric key ${key}`);
    }
    return fallback;
  };

  return {
    weightsVersion: requiredString(
      parsed.weights_version,
      "weights_version",
      "1",
    ),
    scoreMin: requiredNumber(
      thresholds.score_min,
      "thresholds.score_min",
      DEFAULT_WEIGHTS.scoreMin,
    ),
    marginAuto: requiredNumber(
      thresholds.margin_auto,
      "thresholds.margin_auto",
      DEFAULT_WEIGHTS.marginAuto,
    ),
    historicalHalfLifeDays: requiredNumber(
      decay.historical_half_life_days,
      "decay.historical_half_life_days",
      DEFAULT_WEIGHTS.historicalHalfLifeDays,
    ),
    historicalDoubleCountCap: requiredNumber(
      caps.historical_double_count,
      "caps.historical_double_count",
      DEFAULT_WEIGHTS.historicalDoubleCountCap,
    ),
    weights: {
      filePath: requiredNumber(
        weights.file_path,
        "weights.file_path",
        DEFAULT_WEIGHTS.weights.filePath,
      ),
      packageNamespace: requiredNumber(
        weights.package_namespace,
        "weights.package_namespace",
        DEFAULT_WEIGHTS.weights.packageNamespace,
      ),
      symbolTableEndpoint: requiredNumber(
        weights.symbol_table_endpoint,
        "weights.symbol_table_endpoint",
        DEFAULT_WEIGHTS.weights.symbolTableEndpoint,
      ),
      semanticHistoricalSimilarity: requiredNumber(
        weights.semantic_historical_similarity,
        "weights.semantic_historical_similarity",
        DEFAULT_WEIGHTS.weights.semanticHistoricalSimilarity,
      ),
      semanticProfileSimilarity: requiredNumber(
        weights.semantic_profile_similarity,
        "weights.semantic_profile_similarity",
        DEFAULT_WEIGHTS.weights.semanticProfileSimilarity,
      ),
      directionalPhrase: requiredNumber(
        weights.directional_phrase,
        "weights.directional_phrase",
        DEFAULT_WEIGHTS.weights.directionalPhrase,
      ),
      actionableSingleRepoAlias: requiredNumber(
        weights.actionable_single_repo_alias,
        "weights.actionable_single_repo_alias",
        DEFAULT_WEIGHTS.weights.actionableSingleRepoAlias,
      ),
      businessTermProfileHit: requiredNumber(
        weights.business_term_profile_hit,
        "weights.business_term_profile_hit",
        DEFAULT_WEIGHTS.weights.businessTermProfileHit,
      ),
      actionableMultiRepoAlias: requiredNumber(
        weights.actionable_multi_repo_alias,
        "weights.actionable_multi_repo_alias",
        DEFAULT_WEIGHTS.weights.actionableMultiRepoAlias,
      ),
      contextualAlias: requiredNumber(
        weights.contextual_alias,
        "weights.contextual_alias",
        DEFAULT_WEIGHTS.weights.contextualAlias,
      ),
      genericKeywordPenalty: requiredNumber(
        weights.generic_keyword_penalty,
        "weights.generic_keyword_penalty",
        DEFAULT_WEIGHTS.weights.genericKeywordPenalty,
      ),
    },
  };
}

export const DEFAULT_WEIGHTS: RepoRouterWeights = {
  weightsVersion: "1",
  scoreMin: 8,
  marginAuto: 5,
  historicalHalfLifeDays: 30,
  historicalDoubleCountCap: 8,
  weights: {
    filePath: 10,
    packageNamespace: 6,
    symbolTableEndpoint: 6,
    semanticHistoricalSimilarity: 6,
    semanticProfileSimilarity: 4,
    directionalPhrase: 3,
    actionableSingleRepoAlias: 3,
    businessTermProfileHit: 2,
    actionableMultiRepoAlias: 1,
    contextualAlias: 0,
    genericKeywordPenalty: -1,
  },
};

function buildFallbackProfile(repo: CodeRepository): RepoProfile {
  const metadata = getOneShotRepoMetadata(repo);
  const generated: RepoProfileSection = {
    ...EMPTY_SECTION,
    aliases: [repo.repo_name, ...(metadata?.aliases ?? [])],
    domains: metadata?.domains ?? [],
  };
  const curated = { ...EMPTY_SECTION };
  const merged = mergeSections(generated, curated);
  const profile: RepoProfile = {
    repoName: repo.repo_name,
    schema_version: "1",
    profile_version: "fallback",
    generated_at: "",
    source_repo_commit_sha: "",
    generated,
    curated,
    merged,
    profileText: "",
    summary: "",
  };
  profile.profileText = buildProfileText(profile);
  return profile;
}

function mergeSections(
  generated: RepoProfileSection,
  curated: RepoProfileSection,
): RepoProfileSection {
  const merged = { ...EMPTY_SECTION };
  for (const key of PROFILE_KEYS) {
    merged[key] = Array.from(
      new Set(
        [...(generated[key] ?? []), ...(curated[key] ?? [])].filter(Boolean),
      ),
    );
  }
  return merged;
}

function normalizeSection(value: unknown): RepoProfileSection {
  const source = objectValue(value);
  const section = { ...EMPTY_SECTION };
  for (const key of PROFILE_KEYS) {
    section[key] = arrayValue(source[key]);
  }
  return section;
}

function buildProfileText(profile: RepoProfile): string {
  return PROFILE_KEYS.flatMap((key) => profile.merged[key]).join("\n");
}

function parseSimpleYaml(content: string): Record<string, any> {
  const root: Record<string, any> = {};
  const stack: Array<{ indent: number; value: Record<string, any> }> = [
    { indent: -1, value: root },
  ];
  let currentArrayKey: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const line = rawLine.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].value;
    if (line.startsWith("- ")) {
      if (currentArrayKey) {
        parent[currentArrayKey] = parent[currentArrayKey] ?? [];
        parent[currentArrayKey].push(cleanScalar(line.slice(2)));
      }
      continue;
    }

    const [keyPart, ...rest] = line.split(":");
    const key = keyPart.trim();
    const rawValue = rest.join(":").trim();
    currentArrayKey = null;
    if (!rawValue) {
      if (PROFILE_KEYS.includes(key as keyof RepoProfileSection)) {
        parent[key] = [];
        currentArrayKey = key;
      } else {
        parent[key] = {};
        stack.push({ indent, value: parent[key] });
      }
    } else if (rawValue === "[]") {
      parent[key] = [];
      currentArrayKey = key;
    } else {
      parent[key] = cleanScalar(rawValue);
    }
  }

  return root;
}

function cleanScalar(value: string): string | number {
  const cleaned = value.replace(/^["']|["']$/g, "").trim();
  const numeric = Number(cleaned);
  return cleaned !== "" && Number.isFinite(numeric) ? numeric : cleaned;
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function arrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function stringValue(value: unknown, fallback: string): string {
  return value === undefined || value === null ? fallback : String(value);
}
