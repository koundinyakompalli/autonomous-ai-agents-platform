import fs from "fs/promises";
import path from "path";

export interface InvestigationCodeRepositoryForRouting {
  id: number;
  repo_name: string;
  repo_url: string;
  description: string;
  default_branch?: string | null;
  created_at?: Date;
}

export interface InvestigationRouterTicketInput {
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    labels?: string[];
    comment?: {
      comments?: Array<{
        id?: string;
        created?: string;
        body?: unknown;
      }>;
    };
    attachment?: Array<{
      filename?: string;
    }>;
  };
}

export type InvestigationCrossCuttingRisk = "low" | "medium" | "high";

export interface InvestigationExtractedRepoSignals {
  filePaths: string[];
  identifiers: string[];
  tables: string[];
  endpoints: string[];
  directionalPhrases: string[];
  sentences: string[];
  customerTags: string[];
  businessConcepts: string[];
  crossCuttingRisk: InvestigationCrossCuttingRisk;
  extractorSchemaVersion: string;
  provider: "regex" | "fallback";
}

export interface InvestigationRepoProfileSection {
  aliases: string[];
  domains: string[];
  packages: string[];
  file_path_patterns: string[];
  symbols: string[];
  endpoints: string[];
  tables: string[];
}

export interface InvestigationRepoProfile {
  repoName: string;
  schema_version: string;
  profile_version: string;
  generated_at: string;
  source_repo_commit_sha: string;
  generated: InvestigationRepoProfileSection;
  curated: InvestigationRepoProfileSection;
  merged: InvestigationRepoProfileSection;
  profileText: string;
  summary: string;
}

export interface InvestigationRepoRouterWeights {
  weightsVersion: string;
  scoreMin: number;
  marginAuto: number;
  historicalHalfLifeDays: number;
  historicalDoubleCountCap: number;
  weights: {
    filePath: number;
    packageNamespace: number;
    symbolTableEndpoint: number;
    semanticHistoricalSimilarity: number;
    semanticProfileSimilarity: number;
    directionalPhrase: number;
    actionableSingleRepoAlias: number;
    businessTermProfileHit: number;
    actionableMultiRepoAlias: number;
    contextualAlias: number;
    genericKeywordPenalty: number;
  };
}

export interface InvestigationRepoMetadata {
  repoName: string;
  githubSlug: string;
}

export const INVESTIGATION_REPO_METADATA: InvestigationRepoMetadata[] = [
  { repoName: "core-app", githubSlug: "cp-medhok-monorepo" },
  { repoName: "client-services", githubSlug: "cp-client-services-monorepo" },
  { repoName: "batch-jobs", githubSlug: "cp-batch-monorepo" },
  { repoName: "provider-portal", githubSlug: "cp-provider-portal" },
  { repoName: "React-based-new-ui", githubSlug: "cp-mhk-smart-prominence" },
  { repoName: "React-new-ui", githubSlug: "cp-mhk-smart-prominence" },
  { repoName: "interop", githubSlug: "cp-interoperability-monorepo" },
  { repoName: "data-visor", githubSlug: "cp-datalake-pipeline" },
  { repoName: "cp-medhok-bi-datamart-monorepo", githubSlug: "cp-medhok-bi-datamart-monorepo" },
  { repoName: "Document-ai", githubSlug: "document-ai" },
  { repoName: "Ai-agents", githubSlug: "enterprise-ai-agent-platform" },
  { repoName: "cp-autonomous-ai-agents-platform", githubSlug: "cp-autonomous-ai-agents-platform" },
  { repoName: "mp-web", githubSlug: "mp-web" },
  { repoName: "mp-product-client-configs", githubSlug: "mp-product-client-configs" },
];

const INVESTIGATION_REPO_METADATA_BY_NAME = new Map(
  INVESTIGATION_REPO_METADATA.map((metadata) => [metadata.repoName.toLowerCase(), metadata]),
);

const VERSIONED_BRANCH_PREFIX_BY_REPO: Record<string, string> = {
  "core-app": "medhok-monorepo",
  "client-services": "client-services-monorepo",
  "batch-jobs": "batch-monorepo",
  "provider-portal": "provider-portal",
};

const DEFAULT_BRANCH_BY_REPO: Record<string, string> = {
  "core-app": "master",
  "client-services": "master",
  "batch-jobs": "master",
  "provider-portal": "master",
  "React-based-new-ui": "master",
  "React-new-ui": "master",
  "mp-web": "master",
};

const PROFILE_KEYS: Array<keyof InvestigationRepoProfileSection> = [
  "aliases",
  "domains",
  "packages",
  "file_path_patterns",
  "symbols",
  "endpoints",
  "tables",
];

const EMPTY_SECTION: InvestigationRepoProfileSection = {
  aliases: [],
  domains: [],
  packages: [],
  file_path_patterns: [],
  symbols: [],
  endpoints: [],
  tables: [],
};

export const DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS: InvestigationRepoRouterWeights = {
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

export function buildInvestigationRouterTicketText(
  ticket: InvestigationRouterTicketInput,
): string {
  const fields = ticket.fields ?? {};
  const labels = Array.isArray(fields.labels)
    ? fields.labels.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const attachments = Array.isArray(fields.attachment)
    ? fields.attachment.map((attachment) => attachment.filename?.trim()).filter((filename): filename is string => Boolean(filename))
    : [];
  const comments = fields.comment?.comments ?? [];

  const lines: string[] = [];
  if (ticket.key) lines.push(ticket.key);
  if (fields.summary?.trim()) lines.push(fields.summary.trim());
  const description = stringifyFieldValue(fields.description);
  if (description) lines.push(description);
  if (labels.length > 0) lines.push(`[LABELS] ${labels.join(", ")}`);
  if (attachments.length > 0) {
    lines.push("[ATTACHMENTS]");
    lines.push(...attachments);
  }
  for (const [index, comment] of comments.entries()) {
    const body = stringifyFieldValue(comment.body);
    if (!body) continue;
    lines.push(`[COMMENT ${index + 1} on ${comment.created || "unknown"}]`);
    lines.push(body);
    lines.push(`[/COMMENT ${index + 1}]`);
  }
  return lines.join("\n");
}

export function extractInvestigationRepoRoutingSignals(
  ticketText: string,
): InvestigationExtractedRepoSignals {
  return {
    filePaths: extractFilePaths(ticketText),
    identifiers: extractIdentifiers(ticketText),
    tables: extractTables(ticketText),
    endpoints: extractEndpoints(ticketText),
    directionalPhrases: extractDirectionalPhrases(ticketText),
    sentences: splitIntoSentences(ticketText),
    customerTags: [],
    businessConcepts: [],
    crossCuttingRisk: "medium",
    extractorSchemaVersion: "investigation-repo-routing-regex-v1",
    provider: "regex",
  };
}

export function getInvestigationRepoMetadata(repoName: string): InvestigationRepoMetadata | undefined {
  return INVESTIGATION_REPO_METADATA_BY_NAME.get(repoName.toLowerCase());
}

export function getInvestigationRepositoryDefaultBranchName(input: {
  repoName: string;
  configuredDefaultBranch?: string | null;
}): string {
  const configuredDefaultBranch = input.configuredDefaultBranch?.trim();
  if (configuredDefaultBranch) {
    return configuredDefaultBranch;
  }
  return DEFAULT_BRANCH_BY_REPO[input.repoName] || "main";
}

export function getInvestigationRepoBranchCandidatesForVersion(input: {
  repoName: string;
  repoUrl?: string;
  versionOrBranch?: string;
  defaultBranch?: string | null;
}): string[] {
  const defaultBranch = getInvestigationRepositoryDefaultBranchName({
    repoName: input.repoName,
    configuredDefaultBranch: input.defaultBranch,
  });
  const versionOrBranch = input.versionOrBranch?.trim();

  if (!isInvestigationVersionedRepositoryName(input.repoName)) {
    return [versionOrBranch, defaultBranch].filter((entry): entry is string => Boolean(entry));
  }

  if (!versionOrBranch || versionOrBranch === "master" || versionOrBranch === defaultBranch) {
    return [defaultBranch];
  }

  const candidates = new Set<string>();
  const legacyPrefix = VERSIONED_BRANCH_PREFIX_BY_REPO[input.repoName];
  const repoSlug = getRepositorySlug(input.repoUrl);
  for (const prefix of [legacyPrefix, repoSlug]) {
    if (prefix) {
      candidates.add(`${prefix}-${versionOrBranch}`);
    }
  }
  candidates.add(versionOrBranch);
  candidates.add(defaultBranch);
  return Array.from(candidates);
}

export function getInvestigationRepoBranchFamilyPatternsForVersion(input: {
  repoName: string;
  repoUrl?: string;
  versionOrBranch?: string;
}): string[] {
  const versionOrBranch = input.versionOrBranch?.trim();
  if (!versionOrBranch || !isInvestigationVersionedRepositoryName(input.repoName)) {
    return [];
  }

  const candidates = new Set<string>();
  const legacyPrefix = VERSIONED_BRANCH_PREFIX_BY_REPO[input.repoName];
  const repoSlug = getRepositorySlug(input.repoUrl);
  for (const prefix of [legacyPrefix, repoSlug]) {
    if (prefix) {
      candidates.add(`${prefix}-${versionOrBranch}*`);
    }
  }
  candidates.add(`*${versionOrBranch}*`);
  return Array.from(candidates);
}

export async function loadInvestigationRepoProfiles(
  repos: InvestigationCodeRepositoryForRouting[],
  options: { profileDir?: string; requireProfiles?: boolean } = {},
): Promise<Map<string, InvestigationRepoProfile>> {
  const shouldRequireProfiles = options.requireProfiles ?? process.env.NODE_ENV === "production";
  const profileDir = options.profileDir ?? path.join(process.cwd(), "config", "repo-profiles");
  const profiles = new Map<string, InvestigationRepoProfile>();

  repoLoop: for (const repo of dedupeRepositories(repos)) {
    const attemptedProfilePaths: string[] = [];
    for (const profileName of getProfileCandidateNames(repo)) {
      const profilePath = path.join(profileDir, `${profileName}.yaml`);
      attemptedProfilePaths.push(profilePath);
      try {
        const content = await fs.readFile(profilePath, "utf8");
        profiles.set(
          repo.repo_name.toLowerCase(),
          parseInvestigationRepoProfile(repo.repo_name, content),
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
        `Missing investigation repo profile for ${repo.repo_name}: ${attemptedProfilePaths.join(", ")}`,
      );
    }
    profiles.set(repo.repo_name.toLowerCase(), buildFallbackProfile(repo));
  }

  return profiles;
}

export async function loadInvestigationRepoRouterWeights(
  weightsPath = path.join(process.cwd(), "config", "repo-router", "weights.yaml"),
  options: { requireWeights?: boolean } = {},
): Promise<InvestigationRepoRouterWeights> {
  const shouldRequireWeights = options.requireWeights ?? process.env.NODE_ENV === "production";
  try {
    const content = await fs.readFile(weightsPath, "utf8");
    return parseInvestigationRepoRouterWeights(content, { strict: shouldRequireWeights });
  } catch (error: any) {
    if (shouldRequireWeights) {
      throw new Error(
        `Missing or invalid investigation repo routing weights config: ${weightsPath}: ${error?.message ?? error}`,
      );
    }
    return DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS;
  }
}

export function parseInvestigationRepoProfile(
  repoName: string,
  content: string,
): InvestigationRepoProfile {
  const parsed = parseSimpleYaml(content);
  const generated = normalizeSection(parsed.generated);
  const curated = normalizeSection(parsed.curated);
  const merged = mergeSections(generated, curated);
  const profile: InvestigationRepoProfile = {
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
  profile.profileText = PROFILE_KEYS.flatMap((key) => profile.merged[key]).join("\n");
  return profile;
}

export function parseInvestigationRepoRouterWeights(
  content: string,
  options: { strict?: boolean } = {},
): InvestigationRepoRouterWeights {
  const strict = options.strict ?? false;
  const parsed = parseSimpleYaml(content);
  const thresholds = objectValue(parsed.thresholds);
  const weights = objectValue(parsed.weights);
  const decay = objectValue(parsed.decay);
  const caps = objectValue(parsed.caps);
  const requiredString = (value: unknown, key: string, fallback: string) => {
    const parsedValue = value === undefined || value === null ? "" : String(value).trim();
    if (parsedValue) return parsedValue;
    if (strict) throw new Error(`Investigation repo routing weights missing required key ${key}`);
    return fallback;
  };
  const requiredNumber = (value: unknown, key: string, fallback: number) => {
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric)) return numeric;
    if (strict) throw new Error(`Investigation repo routing weights missing numeric key ${key}`);
    return fallback;
  };

  return {
    weightsVersion: requiredString(parsed.weights_version, "weights_version", "1"),
    scoreMin: requiredNumber(thresholds.score_min, "thresholds.score_min", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.scoreMin),
    marginAuto: requiredNumber(thresholds.margin_auto, "thresholds.margin_auto", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.marginAuto),
    historicalHalfLifeDays: requiredNumber(decay.historical_half_life_days, "decay.historical_half_life_days", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.historicalHalfLifeDays),
    historicalDoubleCountCap: requiredNumber(caps.historical_double_count, "caps.historical_double_count", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.historicalDoubleCountCap),
    weights: {
      filePath: requiredNumber(weights.file_path, "weights.file_path", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.weights.filePath),
      packageNamespace: requiredNumber(weights.package_namespace, "weights.package_namespace", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.weights.packageNamespace),
      symbolTableEndpoint: requiredNumber(weights.symbol_table_endpoint, "weights.symbol_table_endpoint", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.weights.symbolTableEndpoint),
      semanticHistoricalSimilarity: requiredNumber(weights.semantic_historical_similarity, "weights.semantic_historical_similarity", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.weights.semanticHistoricalSimilarity),
      semanticProfileSimilarity: requiredNumber(weights.semantic_profile_similarity, "weights.semantic_profile_similarity", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.weights.semanticProfileSimilarity),
      directionalPhrase: requiredNumber(weights.directional_phrase, "weights.directional_phrase", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.weights.directionalPhrase),
      actionableSingleRepoAlias: requiredNumber(weights.actionable_single_repo_alias, "weights.actionable_single_repo_alias", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.weights.actionableSingleRepoAlias),
      businessTermProfileHit: requiredNumber(weights.business_term_profile_hit, "weights.business_term_profile_hit", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.weights.businessTermProfileHit),
      actionableMultiRepoAlias: requiredNumber(weights.actionable_multi_repo_alias, "weights.actionable_multi_repo_alias", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.weights.actionableMultiRepoAlias),
      contextualAlias: requiredNumber(weights.contextual_alias, "weights.contextual_alias", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.weights.contextualAlias),
      genericKeywordPenalty: requiredNumber(weights.generic_keyword_penalty, "weights.generic_keyword_penalty", DEFAULT_INVESTIGATION_REPO_ROUTER_WEIGHTS.weights.genericKeywordPenalty),
    },
  };
}

function extractFilePaths(text: string): string[] {
  const matches = text.match(/\b[\w.-]+(?:\/[\w.@-]+)+(?:\.[A-Za-z0-9]+)?\b/g) ?? [];
  return Array.from(new Set(matches));
}

function extractEndpoints(text: string): string[] {
  const matches = text.match(/(?:GET|POST|PUT|PATCH|DELETE)?\s*(\/[A-Za-z0-9_./{}:-]+)/g) ?? [];
  return Array.from(
    new Set(matches.map((match) => match.trim().replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/i, ""))),
  );
}

function extractIdentifiers(text: string): string[] {
  const matches = text.match(/\b[A-Z][A-Za-z0-9_]*(?:Service|Controller|Repository|Request|Response|Mapper|Handler|Job|Task|Dao|DAO)?\b/g) ?? [];
  return Array.from(new Set(matches.filter((match) => match.length >= 4)));
}

function extractTables(text: string): string[] {
  const matches = text.match(/\b[a-z][a-z0-9_]{2,}\.[a-z][a-z0-9_]{2,}\b|\b[a-z][a-z0-9_]{3,}_[a-z0-9_]+\b/g) ?? [];
  return Array.from(new Set(matches));
}

function extractDirectionalPhrases(text: string): string[] {
  const matches =
    text.match(/\b(?:in|under|inside|within|add to|change in|update in|fix in)\s+[`"']?([A-Za-z0-9_.@/-]+)[`"']?/gi) ?? [];
  return Array.from(new Set(matches.map((match) => match.trim())));
}

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n;])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function isInvestigationVersionedRepositoryName(repoName: string): boolean {
  return Object.prototype.hasOwnProperty.call(VERSIONED_BRANCH_PREFIX_BY_REPO, repoName);
}

function getRepositorySlug(repoUrl: string | undefined): string | null {
  const normalized = (repoUrl || "").trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const slug = normalized.split("/").pop();
  return slug ? slug.trim() : null;
}

function stringifyFieldValue(value: unknown): string {
  return flattenFieldValue(value).join("\n").trim();
}

function flattenFieldValue(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenFieldValue(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["text", "value", "name", "displayName", "key"]) {
      const fieldValue = record[key];
      if (typeof fieldValue === "string" && fieldValue.trim()) {
        parts.push(fieldValue.trim());
      }
    }
    if (Array.isArray(record.content)) {
      parts.push(...record.content.flatMap((item) => flattenFieldValue(item)));
    }
    return parts;
  }
  return [];
}

function dedupeRepositories(
  repos: InvestigationCodeRepositoryForRouting[],
): InvestigationCodeRepositoryForRouting[] {
  const seen = new Set<string>();
  return repos.filter((repo) => {
    const key = repo.repo_name.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getProfileCandidateNames(repo: InvestigationCodeRepositoryForRouting): string[] {
  const slugFromUrl = repo.repo_url.match(/\/([^/]+?)(?:\.git)?$/)?.[1];
  return Array.from(new Set([repo.repo_name, slugFromUrl].filter((value): value is string => Boolean(value?.trim()))));
}

function buildFallbackProfile(repo: InvestigationCodeRepositoryForRouting): InvestigationRepoProfile {
  const generated: InvestigationRepoProfileSection = {
    ...EMPTY_SECTION,
    aliases: [repo.repo_name, repo.repo_url].filter(Boolean),
    domains: [repo.description].filter((entry) => Boolean(entry?.trim())),
  };
  const curated = { ...EMPTY_SECTION };
  const merged = mergeSections(generated, curated);
  const profile: InvestigationRepoProfile = {
    repoName: repo.repo_name,
    schema_version: "1",
    profile_version: "fallback",
    generated_at: "",
    source_repo_commit_sha: "",
    generated,
    curated,
    merged,
    profileText: "",
    summary: repo.description || "",
  };
  profile.profileText = PROFILE_KEYS.flatMap((key) => profile.merged[key]).join("\n");
  return profile;
}

function mergeSections(
  generated: InvestigationRepoProfileSection,
  curated: InvestigationRepoProfileSection,
): InvestigationRepoProfileSection {
  const merged = { ...EMPTY_SECTION };
  for (const key of PROFILE_KEYS) {
    merged[key] = Array.from(new Set([...(generated[key] ?? []), ...(curated[key] ?? [])].filter(Boolean)));
  }
  return merged;
}

function normalizeSection(value: unknown): InvestigationRepoProfileSection {
  const source = objectValue(value);
  const section = { ...EMPTY_SECTION };
  for (const key of PROFILE_KEYS) {
    section[key] = arrayValue(source[key]);
  }
  return section;
}

function extractProfileSummary(yamlContent: string): string {
  const lines = yamlContent.split(/\r?\n/);
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
  return lines
    .slice(startIdx, curatedIdx)
    .map((line) => line.trim().replace(/^#+\s?/, ""))
    .filter((line) => line !== "" && !/^-{3,}$/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s-{3,}\s*/g, " ")
    .trim();
}

function parseSimpleYaml(content: string): Record<string, any> {
  const root: Record<string, any> = {};
  const stack: Array<{ indent: number; value: Record<string, any> }> = [{ indent: -1, value: root }];
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
      if (PROFILE_KEYS.includes(key as keyof InvestigationRepoProfileSection)) {
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
