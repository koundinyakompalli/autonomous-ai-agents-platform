import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import type { CodeInspectionAdapterContract } from "./types.js";
import type {
  InvestigationAdapterRequest,
  InvestigationAdapterResult,
  InvestigationDataFlowColumnHint,
  InvestigationDataFlowHint,
} from "../types/investigation.js";
import type {
  InvestigationCodeTarget,
  InvestigationCodeTargetRegistry,
} from "../data/CodeTargetRegistry.js";
import {
  NoopCodeSemanticProfileRegistry,
  type InvestigationCodeSemanticProfile,
  type InvestigationCodeSemanticProfileRegistry,
  type InvestigationCodeSemanticRule,
} from "../data/CodeSemanticProfileRegistry.js";
import { extractTicketPayloadEvidence } from "../utils/TicketPayloadEvidence.js";

const execFileAsync = promisify(execFile);

interface CodeEvidenceHit {
  repoName: string;
  branch?: string;
  file: string;
  line: number;
  term: string;
  preview: string;
}

interface RankedCodeEvidenceHit extends CodeEvidenceHit {
  semanticScore: number;
  semanticReasons: string[];
}

interface CodeDiscoveryTrace {
  seedTerms: string[];
  derivedTerms: string[];
  contextFiles: string[];
  dataFlowHints: InvestigationDataFlowHint[];
}

interface CodeSearchBatchResult {
  hits: CodeEvidenceHit[];
  error?: string;
}

interface GitSnapshot {
  repoName: string;
  branch: string;
  head: string;
  defaultBranch?: string;
  configuredBranch?: string;
}

type CodeRefreshStatus =
  | "refreshed"
  | "refresh_disabled"
  | "refresh_failed_fallback"
  | "missing"
  | "not_git";

interface PreparedCodeTarget {
  sourceTarget: InvestigationCodeTarget;
  scanTarget: InvestigationCodeTarget;
  status: CodeRefreshStatus;
  sourcePath: string;
  scanPath: string;
  branch?: string;
  remoteRef?: string;
  head?: string;
  error?: string;
  cleanupPath?: string;
  attemptedBranches?: Array<{
    branch: string;
    status: "resolved" | "failed";
    error?: string;
  }>;
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "batch",
  "before",
  "cannot",
  "case",
  "client",
  "comment",
  "error",
  "fails",
  "failure",
  "issue",
  "job",
  "groupname",
  "member",
  "prod",
  "should",
  "ticket",
  "users",
  "with",
]);

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

async function pathExists(value: string): Promise<boolean> {
  return access(value)
    .then(() => true)
    .catch(() => false);
}

function safePathSegment(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "repo"
  );
}

function stripGitCredentials(value: string): string {
  return value.replace(/https:\/\/[^@/\s]+@/g, "https://");
}

function buildAuthenticatedGitUrl(value: string): string {
  const cleanUrl = stripGitCredentials(value);
  const token = process.env.GITHUB_REPO_TOKEN?.trim();
  if (!token || !/^https:\/\/github\.com\//i.test(cleanUrl)) {
    return cleanUrl;
  }
  return cleanUrl.replace(
    "https://",
    `https://x-access-token:${encodeURIComponent(token)}@`,
  );
}

function sanitizeGitError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return stripGitCredentials(message);
}

function codeWorktreeBase(): string {
  return (
    process.env.INVESTIGATION_CODE_WORKTREE_BASE?.trim() ||
    path.join(tmpdir(), "investigation-code-agent-worktrees")
  );
}

function maxReleaseFamilyBranches(): number {
  const parsed = Number.parseInt(process.env.INVESTIGATION_CODE_MAX_RELEASE_BRANCHES || "", 10);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 12)) : 6;
}

function codeSearchConcurrency(): number {
  const parsed = Number.parseInt(process.env.INVESTIGATION_CODE_SEARCH_CONCURRENCY || "", 10);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 4)) : 2;
}

function codeSearchTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.INVESTIGATION_CODE_SEARCH_TIMEOUT_MS || "", 10);
  return Number.isInteger(parsed) ? Math.max(5_000, Math.min(parsed, 60_000)) : 20_000;
}

async function mapWithConcurrency<T, U>(
  values: T[],
  limit: number,
  worker: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

function extractCodeTerms(request: InvestigationAdapterRequest): string[] {
  const payloadEvidence = extractTicketPayloadEvidence(request.scope.ticketContext);
  const payloadTerms = unique([
    ...payloadEvidence.observedFieldLengths.map(observation => observation.fieldName),
    ...payloadEvidence.fieldTerms,
  ]).filter(term => term.length >= 3 && !STOP_WORDS.has(term.toLowerCase()));
  const accessorTerms = payloadTerms
    .slice(0, 8)
    .filter(term => /^[A-Za-z_][A-Za-z0-9_]*$/.test(term))
    .flatMap(term => {
      const capitalized = `${term.charAt(0).toUpperCase()}${term.slice(1)}`;
      return [`set${capitalized}`, `get${capitalized}`];
    });
  const rawText = [
    request.jiraKey,
    ...(request.scope.keywords ?? []),
    ...(request.scope.planningContext?.searchHints ?? []),
    ...(request.scope.serviceIds ?? []),
    ...(request.scope.repoNames ?? []),
  ].join("\n");

  const quoted = Array.from(rawText.matchAll(/"([^"\n]{4,100})"/g))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const quotedConstants = Array.from(
    rawText.matchAll(/['"]([A-Z][A-Z0-9_]{3,})['"]/g),
  )
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  const identifiers = rawText.match(/[A-Za-z_][A-Za-z0-9_.-]{3,}/g) ?? [];
  const filteredIdentifiers = identifiers.filter((term) => {
    const lower = term.toLowerCase();
    return (
      !STOP_WORDS.has(lower) &&
      !/^CPSUP-\d+$/i.test(term) &&
      (term.length >= 8 ||
        /[A-Z]/.test(term.slice(1)) ||
        term.includes("_") ||
        term.includes(".") ||
        /(Exception|Error|Service|Controller|Manager|Handler|Repository|Processor|Batch|Job)$/i.test(
          term,
        ))
    );
  });

  return unique([
    ...payloadTerms.slice(0, 12),
    ...accessorTerms,
    ...quoted,
    ...quotedConstants,
    ...filteredIdentifiers,
  ]).slice(0, 24);
}

function extractFocusedCodeTerms(request: InvestigationAdapterRequest): string[] {
  const payloadEvidence = extractTicketPayloadEvidence(request.scope.ticketContext)
  const runtimeCodeTerms = (request.scope.diagnosticContext?.codeEvidenceTerms || [])
    .filter(isUsefulDiscoveryTerm)
  const fields = unique([
    ...(request.scope.diagnosticContext?.runtimeFailureColumns || []),
    ...payloadEvidence.observedFieldLengths.map(observation => observation.fieldName),
  ]).filter(term => /^[A-Za-z_][A-Za-z0-9_]*$/.test(term))
  return unique([
    ...runtimeCodeTerms,
    ...fields.flatMap(term => {
    const camel = term.replace(/_([a-z0-9])/g, (_match, value: string) => value.toUpperCase())
    const capitalized = `${camel.charAt(0).toUpperCase()}${camel.slice(1)}`
    return [term, camel, `set${capitalized}`, `get${capitalized}`]
    }),
  ]).slice(0, 16)
}

function semanticSearchTerms(
  baseTerms: string[],
  profile: InvestigationCodeSemanticProfile | null,
): string[] {
  if (!profile) {
    return baseTerms;
  }
  return unique([...profile.preferredTerms, ...baseTerms]).slice(0, 24);
}

function normalizeDiscoveryTerm(value: string): string {
  return value
    .trim()
    .replace(/^['"`]+|['"`),;]+$/g, "")
    .slice(0, 140);
}

function discoveryTermKey(value: string): string {
  return normalizeDiscoveryTerm(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isUsefulDiscoveryTerm(value: string): boolean {
  const normalized = normalizeDiscoveryTerm(value);
  const lower = normalized.toLowerCase();
  if (
    normalized.length < 4 ||
    STOP_WORDS.has(lower) ||
    lower.includes("[redacted]") ||
    /^cpsup-\d+$/i.test(normalized)
  ) {
    return false;
  }

  if (/\.(?:py|java|kt|js|mjs|cjs|ts|tsx|go|rb|cs)$/i.test(normalized)) {
    return true;
  }

  if (normalized.includes(".")) {
    const tablePart = normalized.split(".").pop() || "";
    return tablePart.includes("_");
  }

  return (
    normalized.includes("_") ||
    /[A-Z]/.test(normalized.slice(1)) ||
    /(Controller|Service|Processor|Batch|Job|Scheduler|Task|Command|Handler|Repository|Dao|DAO|Client|Utility|Util)$/i.test(
      normalized,
    )
  );
}

function extractDiscoveryTermsFromText(value: string, limit: number): string[] {
  const patterns = [
    /\bnew\s+([A-Z][A-Za-z0-9]+)\b/g,
    /\b([A-Z][A-Za-z0-9]+)\.class\b/g,
    /\b(?:get|set)([A-Z][A-Za-z0-9]+)\b/g,
    /\b[A-Za-z_$][A-Za-z0-9_$]*(?:Controller|Service|Processor|Batch|Job|Scheduler|Task|Command|Handler|Repository|Dao|DAO|Client|Utility|Util)\b/g,
    /\b[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*_[A-Za-z0-9_]*\b/g,
    /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]{3,}\b/g,
    /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/g,
    /['"]([A-Z][A-Z0-9_]{3,})['"]/g,
  ];
  const candidateGroups = patterns.map(pattern => {
    const candidates: string[] = [];
    for (const match of value.matchAll(pattern)) {
      const term = normalizeDiscoveryTerm(match[1] || match[0]);
      if (
        !isUsefulDiscoveryTerm(term) ||
        candidates.some(existing => existing.toLowerCase() === term.toLowerCase())
      ) {
        continue;
      }
      candidates.push(term);
    }
    return candidates.slice(0, limit);
  });

  return roundRobinUnique(candidateGroups, limit);
}

function roundRobinUnique(candidateGroups: string[][], limit: number): string[] {
  const terms: string[] = [];
  for (let index = 0; terms.length < limit; index += 1) {
    let added = false;
    for (const candidates of candidateGroups) {
      const term = candidates[index];
      if (!term || terms.some(existing => existing.toLowerCase() === term.toLowerCase())) {
        continue;
      }
      terms.push(term);
      added = true;
      if (terms.length >= limit) {
        break;
      }
    }
    if (!added && candidateGroups.every(candidates => candidates.length <= index + 1)) {
      break;
    }
  }
  return terms;
}

function extractDataFlowHintsFromText(input: {
  repoName: string;
  sourcePath: string;
  sourceLine?: number;
  sourceTerm?: string;
  provenance: 'runtime_context' | 'derived_reference';
  context: string;
}): InvestigationDataFlowHint[] {
  const hints = new Map<string, InvestigationDataFlowHint>();
  const mappedColumns = extractHibernateMappedColumns(input.context);
  const mappedModelName = extractHibernateMappedModelName(input.context);
  const pendingColumns = Array.from(input.context.matchAll(/\bcolumn\s+name\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/gi))
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));

  const addTable = (
    rawTableName: string | null | undefined,
    artifactType: InvestigationDataFlowHint["artifactType"],
    modelName?: string,
  ): InvestigationDataFlowHint | undefined => {
    const tableName = normalizeTableName(rawTableName);
    if (!tableName) {
      return undefined;
    }
    const existing = hints.get(tableName);
    if (existing) {
      if (existing.artifactType === "unknown" && artifactType !== "unknown") {
        existing.artifactType = artifactType;
      }
      existing.modelName ||= modelName;
      return existing;
    }
    const hint: InvestigationDataFlowHint = {
      sourceRepo: input.repoName,
      sourcePath: path.posix.normalize(input.sourcePath),
      sourceLine: input.sourceLine,
      sourceTerm: input.sourceTerm,
      modelName: artifactType === "hibernate_mapping" ? mappedModelName : modelName,
      provenance: artifactType === "hibernate_mapping" && input.provenance === "runtime_context"
        ? "direct_field_match"
        : input.provenance,
      artifactType,
      tableName,
      columns: [],
    };
    hints.set(tableName, hint);
    return hint;
  };

  for (const match of input.context.matchAll(/\b(?:from|join|update|into)\s+`?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)`?/gi)) {
    addTable(match[1], "sql_literal");
  }
  for (const match of input.context.matchAll(/\btable\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/gi)) {
    addTable(match[1], "hibernate_mapping");
  }
  for (const match of input.context.matchAll(/\bfrom\s+([A-Z][A-Za-z0-9]+)\s+as\b/g)) {
    addTable(camelToSnake(match[1]), "hql_literal");
  }
  for (const match of input.context.matchAll(/\b([A-Z][A-Za-z0-9]+)\.class\b/g)) {
    const className = match[1];
    if (!className || COMMON_NON_MODEL_CLASSES.has(className)) {
      continue;
    }
    addTable(camelToSnake(className), "unknown");
  }
  for (const match of input.context.matchAll(/\bnew\s+([A-Z][A-Za-z0-9]+)\b/g)) {
    const className = match[1];
    if (!className || COMMON_NON_MODEL_CLASSES.has(className)) {
      continue;
    }
    addTable(camelToSnake(className), "unknown");
  }

  // Retain the Java relationship that plain-text discovery otherwise loses:
  // entity variable -> setter/property -> getter/source field. Structured
  // Hibernate or schema inspection can then independently verify the inferred
  // table and column.
  const variableTypes = new Map<string, string>();
  const valueFieldsByVariable = new Map<string, string[]>()
  for (const match of input.context.matchAll(/\b([A-Z][A-Za-z0-9]+)\s+([a-z_$][A-Za-z0-9_$]*)\s*(?==|;|,)/g)) {
    const className = match[1];
    const variableName = match[2];
    if (!className || !variableName || COMMON_NON_MODEL_CLASSES.has(className)) {
      continue;
    }
    variableTypes.set(variableName, className);
  }
  for (const match of input.context.matchAll(/\b([a-z_$][A-Za-z0-9_$]*)\s*=\s*new\s+([A-Z][A-Za-z0-9]+)\b/g)) {
    const variableName = match[1];
    const className = match[2];
    if (!className || !variableName || COMMON_NON_MODEL_CLASSES.has(className)) {
      continue;
    }
    variableTypes.set(variableName, className);
  }
  for (const match of input.context.matchAll(/\b([a-z_$][A-Za-z0-9_$]*)\s*=\s*([^;\n]{1,800});/g)) {
    const variableName = match[1]
    const getterFields = Array.from((match[2] || '').matchAll(/\.get([A-Z][A-Za-z0-9]*)\s*\(/g))
      .map(getterMatch => getterMatch[1])
      .filter((value): value is string => Boolean(value))
      .map(value => `${value.charAt(0).toLowerCase()}${value.slice(1)}`)
    if (variableName && getterFields.length > 0) {
      valueFieldsByVariable.set(variableName, unique([
        ...getterFields,
        ...(getterFields.length > 1 ? [getterFields.join('.')] : []),
      ]))
    }
  }
  for (const [variableName, className] of variableTypes) {
    for (const setter of extractSetterCalls(input.context, variableName)) {
      const propertySuffix = setter.propertySuffix;
      if (!propertySuffix) {
        continue;
      }
      const columnName = camelToSnake(propertySuffix);
      const hint = addTable(camelToSnake(className), "unknown", className);
      if (!hint || !columnName) {
        continue;
      }
      const propertyName = `${propertySuffix.charAt(0).toLowerCase()}${propertySuffix.slice(1)}`;
      const getterFields = Array.from(setter.argument.matchAll(/\.get([A-Z][A-Za-z0-9]*)\s*\(/g))
        .map(getterMatch => getterMatch[1])
        .filter((value): value is string => Boolean(value))
        .map(value => `${value.charAt(0).toLowerCase()}${value.slice(1)}`);
      const argumentVariable = /^\s*([a-z_$][A-Za-z0-9_$]*)\s*$/.exec(setter.argument)?.[1]
      const columnLinkedFields = unique([
        ...getterFields,
        ...(getterFields.length > 1 ? [getterFields.join('.')] : []),
        ...(argumentVariable ? valueFieldsByVariable.get(argumentVariable) || [] : []),
      ]);
      const existingColumn = hint.columns?.find(column => column.name.toLowerCase() === columnName.toLowerCase());
      if (existingColumn) {
        existingColumn.propertyName ||= propertyName;
        existingColumn.linkedFields = unique([...(existingColumn.linkedFields || []), ...columnLinkedFields]);
      } else {
        hint.columns = [...(hint.columns || []), {
          name: columnName,
          propertyName,
          linkedFields: columnLinkedFields,
        }].slice(0, 100);
      }
      hint.linkedFields = unique([
        ...(hint.linkedFields || []),
        ...columnLinkedFields,
      ]);
    }
  }

  if (hints.size === 1 && pendingColumns.length > 0) {
    const hint = Array.from(hints.values())[0];
    const mappedColumnNames = new Set(mappedColumns.map(column => column.name.toLowerCase()));
    hint.columns = [
      ...mappedColumns,
      ...unique(pendingColumns)
        .filter(name => !mappedColumnNames.has(name.toLowerCase()))
        .map((name) => ({ name })),
    ].slice(0, 100);
  }

  return Array.from(hints.values()).slice(0, 20);
}

function extractSetterCalls(
  context: string,
  variableName: string,
): Array<{ propertySuffix: string; argument: string }> {
  const calls: Array<{ propertySuffix: string; argument: string }> = []
  const pattern = new RegExp(`\\b${escapeRegex(variableName)}\\.set([A-Z][A-Za-z0-9]*)\\s*\\(`, 'g')
  for (const match of context.matchAll(pattern)) {
    const propertySuffix = match[1]
    const openIndex = (match.index || 0) + match[0].length - 1
    let depth = 0
    let closeIndex = -1
    for (let index = openIndex; index < context.length && index - openIndex <= 1_000; index += 1) {
      const char = context[index]
      if (char === '(') depth += 1
      if (char === ')') {
        depth -= 1
        if (depth === 0) {
          closeIndex = index
          break
        }
      }
    }
    if (propertySuffix && closeIndex > openIndex) {
      calls.push({ propertySuffix, argument: context.slice(openIndex + 1, closeIndex) })
    }
  }
  return calls
}

function extractHibernateMappedModelName(context: string): string | undefined {
  const qualifiedName = /<class\b[^>]*\bname\s*=\s*["']([^"']+)["']/i.exec(context)?.[1];
  return qualifiedName?.split('.').pop()?.trim() || undefined;
}

function mergeDataFlowHints(
  hints: InvestigationDataFlowHint[],
  preferredTerms: string[],
): InvestigationDataFlowHint[] {
  const runtimeFieldsByTable = new Map<string, Set<string>>();
  const runtimeColumnsByTable = new Map<string, InvestigationDataFlowColumnHint[]>()
  for (const hint of hints) {
    if (hint.provenance !== "runtime_context" || !hint.sourceTerm) continue;
    const fields = runtimeFieldsByTable.get(hint.tableName) || new Set<string>();
    fields.add(hint.sourceTerm);
    runtimeFieldsByTable.set(hint.tableName, fields);
    runtimeColumnsByTable.set(hint.tableName, [
      ...(runtimeColumnsByTable.get(hint.tableName) || []),
      ...(hint.columns || []),
    ])
  }
  const enrichedHints = hints.map(hint => {
    if (hint.artifactType !== "hibernate_mapping" || hint.provenance !== "derived_reference") {
      return hint;
    }
    return {
      ...hint,
      columns: (hint.columns || []).map(column => {
        const key = normalizedFieldKey(column.propertyName || column.name)
        const related = (runtimeColumnsByTable.get(hint.tableName) || [])
          .filter(runtimeColumn =>
            normalizedFieldKey(runtimeColumn.propertyName || runtimeColumn.name) === key,
          )
        return {
          ...column,
          linkedFields: unique([
            ...(column.linkedFields || []),
            ...related.flatMap(runtimeColumn => runtimeColumn.linkedFields || []),
          ]),
        }
      }),
      linkedFields: unique([
        ...(hint.linkedFields || []),
        ...Array.from(runtimeFieldsByTable.get(hint.tableName) || []),
      ]),
    };
  });
  const preferredKeys = new Set(
    preferredTerms
      .map(term => term.toLowerCase().replace(/[^a-z0-9]+/g, ""))
      .filter(Boolean),
  );
  const score = (hint: InvestigationDataFlowHint): number => {
    const columns = hint.columns || [];
    const matchingColumns = columns.filter(column =>
      [column.name, column.propertyName]
        .filter((value): value is string => Boolean(value))
        .some(value => preferredKeys.has(value.toLowerCase().replace(/[^a-z0-9]+/g, ""))),
    ).length;
    return (
      matchingColumns * 1_000
      + (hint.artifactType === "hibernate_mapping" ? 200 : 0)
      + (columns.length > 0 ? 100 : 0)
      + (hint.artifactType === "unknown" ? 0 : 10)
    );
  };

  return enrichedHints
    .filter((hint, index, candidates) =>
      candidates.findIndex(candidate =>
        candidate.sourceRepo === hint.sourceRepo
        && candidate.sourcePath === hint.sourcePath
        && candidate.tableName === hint.tableName,
      ) === index,
    )
    .map((hint, index) => ({ hint, index, score: score(hint) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(entry => entry.hint)
    .slice(0, 40);
}

function normalizedFieldKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function extractHibernateMappedColumns(context: string): Array<{ name: string; propertyName?: string }> {
  const columns: Array<{ name: string; propertyName?: string }> = [];
  for (const match of context.matchAll(/<(?:property|many-to-one)\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:property|many-to-one)>)/gi)) {
    const attributes = match[1] || "";
    const body = match[2] || "";
    const propertyName = xmlAttribute(attributes, "name");
    const columnName = xmlAttribute(attributes, "column")
      || Array.from(body.matchAll(/<column\b([^>]*)\/?\s*>/gi))
        .map(columnMatch => xmlAttribute(columnMatch[1] || "", "name"))
        .find((value): value is string => Boolean(value));
    if (
      columnName
      && /^[A-Za-z_][A-Za-z0-9_]*$/.test(columnName)
      && !columns.some(column => column.name.toLowerCase() === columnName.toLowerCase())
    ) {
      columns.push({ name: columnName, propertyName });
    }
  }
  return columns.slice(0, 100);
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(attributes);
  return match?.[1]?.trim() || undefined;
}

const COMMON_NON_MODEL_CLASSES = new Set([
  "ArrayList",
  "Boolean",
  "Date",
  "HashMap",
  "Integer",
  "List",
  "Long",
  "Map",
  "Object",
  "Optional",
  "Set",
  "String",
])

function normalizeTableName(value: string | null | undefined): string | null {
  const raw = value?.trim().replace(/`/g, "");
  if (!raw) {
    return null;
  }
  const tableName = raw.includes(".") ? raw.split(".").pop() : raw;
  const normalized = tableName?.toLowerCase();
  return normalized && /^[a-z_][a-z0-9_]*$/.test(normalized) ? normalized : null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function camelToSnake(value: string | undefined): string | null {
  if (!value || !/^[A-Z][A-Za-z0-9]+$/.test(value)) {
    return null;
  }
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function includesNormalized(source: string, needle: string): boolean {
  const normalizedSource = source.toLowerCase();
  const normalizedNeedle = needle.toLowerCase();
  return (
    normalizedSource.includes(normalizedNeedle) ||
    normalizedSource
      .replace(/[^a-z0-9]+/g, "")
      .includes(normalizedNeedle.replace(/[^a-z0-9]+/g, ""))
  );
}

function isImplementationSourcePath(fileText: string): boolean {
  const normalized = fileText.toLowerCase();
  return (
    !isTestOrFixturePath(fileText) &&
    /\.(java|kt|scala|ts|tsx|js|jsx|py|go|cs)$/.test(normalized) &&
    (normalized.includes("/src/main/") ||
      normalized.includes("/src/") ||
      normalized.includes("/server/") ||
      normalized.includes("/service/") ||
      normalized.includes("/dao/") ||
      normalized.includes("/handler/"))
  );
}

function isTestOrFixturePath(fileText: string): boolean {
  const normalized = fileText.toLowerCase();
  return (
    normalized.includes("/src/test/") ||
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.includes("/__tests__/") ||
    normalized.includes("/mock/") ||
    normalized.includes("/mocks/") ||
    normalized.includes("/fixture/") ||
    normalized.includes("/fixtures/") ||
    /\.(?:test|spec)\.(?:java|kt|scala|ts|tsx|js|jsx|py|go|cs)$/.test(
      normalized,
    ) ||
    /(?:^|\/)[^/]*test\.(?:java|kt|scala|ts|tsx|js|jsx|py|go|cs)$/.test(
      normalized,
    )
  );
}

function isNonRuntimeDefinitionPath(fileText: string): boolean {
  const normalized = fileText.toLowerCase();
  return (
    normalized.includes("/flyway/") ||
    normalized.includes("/migration/") ||
    normalized.includes("/migrations/") ||
    normalized.includes("/src/main/resources/static/") ||
    normalized.includes("/documentation/") ||
    /\.(sql|hbm\.xml|json|properties|md|txt)$/.test(normalized)
  );
}

function everyTermMatches(
  source: string,
  terms: string[] | undefined,
): boolean {
  return (
    !terms?.length || terms.every((term) => includesNormalized(source, term))
  );
}

function someTermMatches(source: string, terms: string[] | undefined): boolean {
  return (
    !terms?.length || terms.some((term) => includesNormalized(source, term))
  );
}

function ruleMatches(
  rule: InvestigationCodeSemanticRule,
  hit: CodeEvidenceHit,
  fileText: string,
): boolean {
  const combinedText = `${fileText}\n${hit.term}\n${hit.preview}`;
  if (
    !everyTermMatches(combinedText, rule.textAll) ||
    !someTermMatches(combinedText, rule.textAny)
  ) {
    return false;
  }
  if (
    !everyTermMatches(fileText, rule.pathAll) ||
    !someTermMatches(fileText, rule.pathAny)
  ) {
    return false;
  }
  if (
    !everyTermMatches(hit.preview, rule.previewAll) ||
    !someTermMatches(hit.preview, rule.previewAny)
  ) {
    return false;
  }
  if (
    rule.unlessTextAny?.some((term) => includesNormalized(combinedText, term))
  ) {
    return false;
  }
  return true;
}

function isRuntimeCodeHit(hit: CodeEvidenceHit): boolean {
  const fileText = path.posix.normalize(hit.file);
  return (
    isImplementationSourcePath(fileText) &&
    !isNonRuntimeDefinitionPath(fileText)
  );
}

function clientScopedModuleMismatch(fileText: string, normalizedClientId: string | undefined): string | undefined {
  if (!normalizedClientId) return undefined;
  const moduleMatch = fileText.match(/(?:^|\/)mm-service-([^/]+)(?:\/|$)/i);
  if (!moduleMatch?.[1]) return undefined;
  const moduleClient = moduleMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!moduleClient || moduleClient === "gateway") return undefined;
  return moduleClient.includes(normalizedClientId) || normalizedClientId.includes(moduleClient)
    ? undefined
    : moduleMatch[1];
}

function rankCodeHits(
  hits: CodeEvidenceHit[],
  profile: InvestigationCodeSemanticProfile | null,
  clientId?: string,
): RankedCodeEvidenceHit[] {
  const normalizedClientId = clientId?.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const fileTermCounts = new Map<string, number>();
  const termsByFile = new Map<string, Set<string>>();
  for (const hit of hits) {
    const key = `${hit.repoName}:${hit.branch || "unknown"}:${path.posix.normalize(hit.file)}`;
    const terms = termsByFile.get(key) || new Set<string>();
    terms.add(hit.term.toLowerCase());
    termsByFile.set(key, terms);
  }
  for (const [key, terms] of termsByFile) fileTermCounts.set(key, terms.size);
  return hits
    .map((hit, index) => {
      const fileText = path.posix.normalize(hit.file);
      let semanticScore = Math.max(0, 1000 - index);
      const semanticReasons: string[] = [];
      const testOrFixturePath = isTestOrFixturePath(fileText);
      const runtimeSourcePath = isRuntimeCodeHit(hit);
      const fileKey = `${hit.repoName}:${hit.branch || "unknown"}:${fileText}`;
      const normalizedHitTerm = hit.term.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const normalizedFilePath = fileText.toLowerCase().replace(/[^a-z0-9]+/g, "");

      if (profile) {
        semanticScore = 0;

        if (
          profile.preferredTerms.some((term) =>
            includesNormalized(hit.term, term),
          )
        ) {
          semanticScore += 30;
          semanticReasons.push(`matched preferred ticket term "${hit.term}"`);
        }

        for (const term of profile.preferredTerms) {
          if (includesNormalized(hit.preview, term)) {
            semanticScore += 12;
            semanticReasons.push(`line mentions ${term}`);
            break;
          }
        }

        for (const boost of profile.previewBoosts ?? []) {
          if (includesNormalized(hit.preview, boost)) {
            semanticScore += 8;
            semanticReasons.push(`line aligns with ${boost}`);
            break;
          }
        }

        const matchedPathBoosts = (profile.pathBoosts ?? []).filter((boost) =>
          includesNormalized(fileText, boost),
        );
        if (matchedPathBoosts.length > 0) {
          semanticScore += matchedPathBoosts.length * 6;
          semanticReasons.push(
            `path aligns with ${matchedPathBoosts.slice(0, 3).join(", ")}`,
          );
        }

        const negativeMatches = (profile.negativePathTerms ?? []).filter(
          (term) => includesNormalized(fileText, term),
        );
        if (negativeMatches.length > 0) {
          semanticScore -= negativeMatches.length * 10;
        }

        if (isImplementationSourcePath(fileText)) {
          semanticScore += 28;
          semanticReasons.push("implementation source path");
        }

        if (
          /(?:^|\/)(?:service|dao|handler|endpoint|rest|response)(?:\/|[^/]*)/i.test(
            fileText,
          )
        ) {
          semanticScore += 14;
          semanticReasons.push("runtime service/response path");
        }

        if (isNonRuntimeDefinitionPath(fileText)) {
          semanticScore -= 40;
        }

        for (const rule of profile.rules ?? []) {
          if (ruleMatches(rule, hit, fileText)) {
            semanticScore += rule.score;
            if (rule.reason) {
              semanticReasons.push(rule.reason);
            }
          }
        }

        if (semanticReasons.length === 0) {
          semanticReasons.push("keyword hit only; semantic alignment is weak");
        }

        semanticScore -= index / 1000;
      }

      if (runtimeSourcePath) {
        semanticScore += 5000;
        semanticReasons.push("runtime source candidate");
      } else if (testOrFixturePath) {
        semanticScore -= 5000;
        semanticReasons.push("test/support path; down-ranked");
      } else if (isNonRuntimeDefinitionPath(fileText)) {
        semanticScore -= 1000;
        semanticReasons.push(
          "non-runtime definition path; supporting evidence only",
        );
      }

      if (codeHitRetentionClass(fileText) === "service") {
        semanticScore += 1200;
        semanticReasons.push("runtime service/DAO path");
      }

      if (normalizedHitTerm.length >= 4 && normalizedFilePath.includes(normalizedHitTerm)) {
        semanticScore += 2500;
        semanticReasons.push("path matches derived code identifier");
      }

      const fileTermCount = fileTermCounts.get(fileKey) || 1;
      if (fileTermCount > 1) {
        semanticScore += Math.min(fileTermCount, 8) * 120;
        semanticReasons.push(`file matches ${fileTermCount} investigation terms`);
      }

      if (/\.\s*(?:set|put|add)[A-Z][A-Za-z0-9]*\s*\(/.test(hit.preview)) {
        semanticScore += 1500;
        semanticReasons.push("runtime data-mapping statement");
      }

      if (
        normalizedClientId
        && normalizedClientId.length >= 4
        && fileText.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(normalizedClientId)
      ) {
        semanticScore += 2500;
        semanticReasons.push("path matches the investigation client scope");
      }

      const mismatchedModule = clientScopedModuleMismatch(fileText, normalizedClientId);
      if (mismatchedModule) {
        semanticScore -= 6000;
        semanticReasons.push(`client-owned module ${mismatchedModule} does not match investigation scope`);
      }

      return {
        ...hit,
        semanticScore: Number(semanticScore.toFixed(3)),
        semanticReasons: unique(semanticReasons).slice(0, 4),
      };
    })
    .sort(
      (a, b) =>
        b.semanticScore - a.semanticScore ||
        a.repoName.localeCompare(b.repoName) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line,
    );
}

function dedupeRankedHits(
  hits: RankedCodeEvidenceHit[],
): RankedCodeEvidenceHit[] {
  const seen = new Set<string>();
  const deduped: RankedCodeEvidenceHit[] = [];
  for (const hit of hits) {
    const key = `${hit.repoName}:${hit.branch || "unknown"}:${path.posix.normalize(hit.file)}:${hit.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(hit);
  }
  return deduped;
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
      maxBuffer: 1024 * 256,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function runGitStrict(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    maxBuffer: 1024 * 512,
  });
  return stdout.trim();
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  return (
    (await runGit(repoPath, ["rev-parse", "--is-inside-work-tree"])) === "true"
  );
}

async function cloneTargetIfMissing(
  target: InvestigationCodeTarget,
): Promise<void> {
  if (await pathExists(target.repoPath)) {
    return;
  }
  if (!target.repoUrl) {
    throw new Error(
      `Repo path is missing and repoUrl is not configured: ${target.repoPath}`,
    );
  }

  await mkdir(path.dirname(target.repoPath), { recursive: true });
  const authUrl = buildAuthenticatedGitUrl(target.repoUrl);
  await execFileAsync(
    "git",
    ["clone", "--no-single-branch", authUrl, target.repoPath],
    {
      maxBuffer: 1024 * 512,
    },
  );

  const cleanUrl = stripGitCredentials(target.repoUrl);
  await runGit(target.repoPath, ["remote", "set-url", "origin", cleanUrl]);
}

async function resolveTargetBranchCandidates(
  target: InvestigationCodeTarget,
): Promise<string[]> {
  const candidates = new Set<string>();
  if (target.branch) {
    candidates.add(target.branch);
  }
  for (const branch of target.branchCandidates ?? []) {
    if (branch?.trim()) {
      candidates.add(branch.trim());
    }
  }
  const currentBranch = await runGit(target.repoPath, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (currentBranch && currentBranch !== "HEAD") {
    candidates.add(currentBranch);
  }
  if (target.defaultBranch) {
    candidates.add(target.defaultBranch);
  }
  return Array.from(candidates);
}

async function resolveTargetBranch(
  target: InvestigationCodeTarget,
): Promise<string | undefined> {
  return (await resolveTargetBranchCandidates(target))[0];
}

async function resolveRemoteUrl(
  target: InvestigationCodeTarget,
): Promise<string | undefined> {
  return (
    target.repoUrl ||
    (await runGit(target.repoPath, ["remote", "get-url", "origin"])) ||
    undefined
  );
}

async function expandCodeTargetBranchFamily(
  target: InvestigationCodeTarget,
): Promise<InvestigationCodeTarget[]> {
  if (target.refreshFromRemote === false || !target.branchFamilyPatterns?.length) {
    return [target];
  }
  const remoteUrl = await resolveRemoteUrl(target);
  if (!remoteUrl) {
    return [target];
  }

  try {
    const authUrl = buildAuthenticatedGitUrl(remoteUrl);
    const patterns = target.branchFamilyPatterns.map(pattern => `refs/heads/${pattern}`);
    const { stdout } = await execFileAsync("git", ["ls-remote", "--heads", authUrl, ...patterns], {
      maxBuffer: 1024 * 512,
    });
    const configuredOrder = new Map(
      [target.branch, ...(target.branchCandidates || [])]
        .filter((branch): branch is string => Boolean(branch?.trim()))
        .map((branch, index) => [branch, index]),
    );
    const clientToken = target.clientId.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const familyBase = target.branch?.toLowerCase();
    const rankBranch = (branch: string): [number, number] => {
      const configuredRank = configuredOrder.get(branch);
      if (configuredRank !== undefined) {
        return [0, configuredRank];
      }
      const normalized = branch.toLowerCase();
      const clientSpecific = normalized.replace(/[^a-z0-9]+/g, "").includes(clientToken);
      const canonicalFamily = Boolean(familyBase)
        && (normalized.startsWith(`${familyBase}-`) || normalized.startsWith(`${familyBase}.`));
      if (clientSpecific && canonicalFamily) return [1, 0];
      if (clientSpecific) return [2, 0];
      if (canonicalFamily) return [3, 0];
      return [4, 0];
    };
    const branches = Array.from(new Set(stdout
      .split("\n")
      .map(line => line.split(/\s+/)[1]?.replace(/^refs\/heads\//, "").trim())
      .filter((branch): branch is string => Boolean(branch))))
      .filter(branch => {
        if (configuredOrder.has(branch)) return true;
        if (branch === target.branch) return true;
        return branch.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(clientToken);
      })
      .sort((left, right) => {
        const [leftGroup, leftOrder] = rankBranch(left);
        const [rightGroup, rightOrder] = rankBranch(right);
        return leftGroup - rightGroup
          || leftOrder - rightOrder
          || right.localeCompare(left);
      })
      .slice(0, maxReleaseFamilyBranches());

    return branches.length > 0
      ? branches.map(branch => ({
          ...target,
          id: `${target.id}:${branch}`,
          branch,
          branchCandidates: [branch],
          branchFamilyPatterns: [],
        }))
      : [target];
  } catch {
    return [target];
  }
}

async function prepareCodeTargetForScan(
  target: InvestigationCodeTarget,
  runId: string,
): Promise<PreparedCodeTarget> {
  if (target.refreshFromRemote === false && !(await pathExists(target.repoPath))) {
    return {
      sourceTarget: target,
      scanTarget: target,
      status: "missing",
      sourcePath: target.repoPath,
      scanPath: target.repoPath,
      error: "Repo path is unavailable and remote refresh is disabled.",
    };
  }

  try {
    await cloneTargetIfMissing(target);
  } catch (error) {
    return {
      sourceTarget: target,
      scanTarget: target,
      status: "missing",
      sourcePath: target.repoPath,
      scanPath: target.repoPath,
      error: sanitizeGitError(error),
    };
  }

  if (!(await pathExists(target.repoPath))) {
    return {
      sourceTarget: target,
      scanTarget: target,
      status: "missing",
      sourcePath: target.repoPath,
      scanPath: target.repoPath,
    };
  }

  if (target.refreshFromRemote === false) {
    return {
      sourceTarget: target,
      scanTarget: target,
      status: "refresh_disabled",
      sourcePath: target.repoPath,
      scanPath: target.repoPath,
      branch: await resolveTargetBranch(target),
    };
  }

  if (!(await isGitRepo(target.repoPath))) {
    return {
      sourceTarget: target,
      scanTarget: target,
      status: "not_git",
      sourcePath: target.repoPath,
      scanPath: target.repoPath,
    };
  }

  try {
    const branchCandidates = await resolveTargetBranchCandidates(target);
    if (branchCandidates.length === 0) {
      throw new Error("No branch configured and current checkout is detached");
    }

    const remoteUrl = await resolveRemoteUrl(target);
    if (!remoteUrl) {
      throw new Error("No Git remote URL configured");
    }

    const authUrl = buildAuthenticatedGitUrl(remoteUrl);
    const attemptedBranches: PreparedCodeTarget["attemptedBranches"] = [];
    let lastError: unknown;

    for (const branch of branchCandidates) {
      const remoteRef = `refs/remotes/origin/${branch}`;
      try {
        await runGitStrict(target.repoPath, [
          "fetch",
          "--prune",
          "--no-tags",
          authUrl,
          `+refs/heads/${branch}:${remoteRef}`,
        ]);

        const head = await runGitStrict(target.repoPath, [
          "rev-parse",
          "--short",
          remoteRef,
        ]);
        const worktreeParent = codeWorktreeBase();
        await mkdir(worktreeParent, { recursive: true });
        const worktreePrefix = [
          safePathSegment(runId),
          safePathSegment(target.repoName),
          safePathSegment(branch),
          "",
        ].join("-");
        const worktreePath = await mkdtemp(
          path.join(worktreeParent, worktreePrefix),
        );
        await runGitStrict(target.repoPath, [
          "worktree",
          "add",
          "--detach",
          worktreePath,
          remoteRef,
        ]);
        attemptedBranches.push({ branch, status: "resolved" });

        return {
          sourceTarget: target,
          scanTarget: {
            ...target,
            repoPath: worktreePath,
            branch,
          },
          status: "refreshed",
          sourcePath: target.repoPath,
          scanPath: worktreePath,
          branch,
          remoteRef,
          head,
          cleanupPath: worktreePath,
          attemptedBranches,
        };
      } catch (error) {
        lastError = error;
        attemptedBranches.push({
          branch,
          status: "failed",
          error: sanitizeGitError(error),
        });
      }
    }

    throw new Error(
      `No configured remote branch could be fetched. ${sanitizeGitError(lastError)}`,
    );
  } catch (error) {
    return {
      sourceTarget: target,
      scanTarget: target,
      status: "refresh_failed_fallback",
      sourcePath: target.repoPath,
      scanPath: target.repoPath,
      branch: await resolveTargetBranch(target),
      error: sanitizeGitError(error),
      attemptedBranches: await resolveTargetBranchCandidates(target).then(
        (branches) =>
          branches.map((branch) => ({ branch, status: "failed" as const })),
      ),
    };
  }
}

async function cleanupPreparedTargets(
  preparedTargets: PreparedCodeTarget[],
): Promise<void> {
  await Promise.all(
    preparedTargets.map(async (prepared) => {
      if (!prepared.cleanupPath) {
        return;
      }
      await runGit(prepared.sourcePath, [
        "worktree",
        "remove",
        "--force",
        prepared.cleanupPath,
      ]);
      await runGit(prepared.sourcePath, ["worktree", "prune"]);
      await rm(prepared.cleanupPath, { recursive: true, force: true });
    }),
  );
}

async function readGitSnapshot(
  target: InvestigationCodeTarget,
): Promise<GitSnapshot> {
  const [branch, head] = await Promise.all([
    runGit(target.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(target.repoPath, ["rev-parse", "--short", "HEAD"]),
  ]);

  return {
    repoName: target.repoName,
    branch: target.branch || branch || "unknown",
    head: head || "unknown",
    defaultBranch: target.defaultBranch,
    configuredBranch: target.branch,
  };
}

async function searchTerms(
  target: InvestigationCodeTarget,
  terms: string[],
  maxMatches: number,
  preferredPathToken?: string,
  preferredArtifactTerms: string[] = [],
): Promise<CodeSearchBatchResult> {
  if (terms.length === 0) {
    return { hits: [] };
  }
  const patterns = terms.flatMap((term) => ["--regexp", term]);
  const normalizedPathToken = preferredPathToken?.trim().replace(/[^A-Za-z0-9_-]+/g, "");
  const normalizedArtifactTerms = unique(
    preferredArtifactTerms
      .map(term => term.trim().replace(/[^A-Za-z0-9_-]+/g, ""))
      .filter(term => term.length >= 4),
  ).slice(0, 12);
  const args = [
    "--line-number",
    "--no-heading",
    "--color",
    "never",
    "--ignore-case",
    "--fixed-strings",
    "--glob",
    "!node_modules/**",
    "--glob",
    "!dist/**",
    "--glob",
    "!target/**",
    "--glob",
    "!build/**",
    ...(normalizedPathToken && normalizedPathToken.length >= 4
      ? ["--iglob", `**/*${normalizedPathToken}*/**`]
      : []),
    ...normalizedArtifactTerms.flatMap(term => ["--iglob", `**/*${term}*`]),
    ...patterns,
    "--",
    ".",
  ];

  return new Promise<CodeSearchBatchResult>((resolve) => {
    const hitsByTermAndClass = new Map<string, CodeEvidenceHit[]>();
    const priorityByHit = new WeakMap<CodeEvidenceHit, number>();
    const normalizedPreferredTerms = unique(
      terms
        .map(term => term.toLowerCase().replace(/[^a-z0-9]+/g, ""))
        .filter(term => term.length >= 3),
    );
    const searchableTerms = terms.map(term => ({ term, lower: term.toLowerCase() }));
    const child = spawn("rg", args, {
      cwd: target.repoPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutBuffer = "";
    let stderr = "";
    let timedOut = false;
    let scanCapped = false;
    let settled = false;
    let processedLines = 0;
    const maxProcessedLines = Math.max(
      1_000,
      Math.min(maxMatches * Math.max(terms.length, 1) * 20, 10_000),
    );

    const consumeLine = (line: string) => {
      if (scanCapped) return;
      processedLines += 1;
      if (processedLines > maxProcessedLines) {
        scanCapped = true;
        child.kill("SIGTERM");
        return;
      }
      const [file = "", lineNumber = "", ...rest] = line.split(":");
      const parsedLine = Number.parseInt(lineNumber, 10);
      if (!file || !Number.isFinite(parsedLine)) return;
      const preview = rest.join(":").trim().slice(0, 240);
      const lowerPreview = preview.toLowerCase();
      for (const { term, lower } of searchableTerms) {
        if (lowerPreview.includes(lower)) {
          const hitClass = codeHitRetentionClass(file);
          const retentionKey = `${term.toLowerCase()}:${hitClass}`;
          const retained = hitsByTermAndClass.get(retentionKey) || [];
          const candidate: CodeEvidenceHit = {
            repoName: target.repoName,
            branch: target.branch,
            file,
            line: parsedLine,
            term,
            preview,
          };
          if (retained.length < maxMatches) {
            retained.push(candidate);
          } else {
            const priority = (hit: CodeEvidenceHit): number => {
              const cached = priorityByHit.get(hit);
              if (cached !== undefined) return cached;
              const calculated = codeSearchRetentionPriority(
                hit,
                target.clientId,
                normalizedPreferredTerms,
              );
              priorityByHit.set(hit, calculated);
              return calculated;
            };
            const candidatePriority = priority(candidate);
            let lowestIndex = 0;
            for (let index = 1; index < retained.length; index += 1) {
              if (priority(retained[index] as CodeEvidenceHit) < priority(retained[lowestIndex] as CodeEvidenceHit)) {
                lowestIndex = index;
              }
            }
            if (candidatePriority > priority(retained[lowestIndex] as CodeEvidenceHit)) {
              retained[lowestIndex] = candidate;
            }
          }
          hitsByTermAndClass.set(retentionKey, retained);
        }
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, codeSearchTimeoutMs());

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      lines.forEach(consumeLine);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ hits: Array.from(hitsByTermAndClass.values()).flat(), error: sanitizeGitError(error) });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (stdoutBuffer) consumeLine(stdoutBuffer);
      if (timedOut) {
        resolve({ hits: Array.from(hitsByTermAndClass.values()).flat(), error: `rg exceeded ${codeSearchTimeoutMs()}ms timeout` });
        return;
      }
      if (scanCapped) {
        resolve({ hits: Array.from(hitsByTermAndClass.values()).flat(), error: `rg output was capped after ${maxProcessedLines} candidate lines` });
        return;
      }
      if (code !== 0 && code !== 1) {
        resolve({
          hits: Array.from(hitsByTermAndClass.values()).flat(),
          error: sanitizeGitError(stderr || `rg exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`),
        });
        return;
      }
      resolve({ hits: Array.from(hitsByTermAndClass.values()).flat() });
    });
  });
}

function codeSearchRetentionPriority(
  hit: CodeEvidenceHit,
  clientId: string,
  normalizedPreferredTerms: string[],
): number {
  const file = path.posix.normalize(hit.file);
  const normalizedPath = file.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const normalizedTerm = hit.term.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const normalizedClient = clientId.toLowerCase().replace(/[^a-z0-9]+/g, "");
  let score = 0;
  if (isRuntimeCodeHit(hit)) score += 300;
  if (codeHitRetentionClass(file) === "service") score += 200;
  if (normalizedClient.length >= 4 && normalizedPath.includes(normalizedClient)) score += 200;
  if (normalizedTerm.length >= 4 && normalizedPath.includes(normalizedTerm)) score += 400;
  const normalizedPreview = hit.preview.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const corroboratingTerms = normalizedPreferredTerms.filter(term => normalizedPreview.includes(term));
  score += Math.min(corroboratingTerms.length, 4) * 150;
  if (/\.\s*(?:set|put|add)[A-Z][A-Za-z0-9]*\s*\(/.test(hit.preview)) score += 500;
  if (/\bnew\s+[A-Z][A-Za-z0-9]+\b/.test(hit.preview)) score += 250;
  return score;
}

function codeHitRetentionClass(file: string): "service" | "model" | "mapping" | "other" {
  const normalized = path.posix.normalize(file).toLowerCase();
  if (/\.(?:hbm\.xml|sql|properties|ya?ml|json)$/.test(normalized)) return "mapping";
  if (/(?:^|\/)(?:service|dao|handler|controller|endpoint|processor)(?:\/|[^/]*)/i.test(normalized)) return "service";
  if (/(?:^|\/)(?:model|entity|domain|dto)(?:\/|[^/]*)/i.test(normalized)) return "model";
  return "other";
}

function safeRelativeHitPath(file: string): string | undefined {
  const normalized = path.normalize(file);
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.startsWith("..")
  ) {
    return undefined;
  }
  return normalized;
}

async function readHitContext(
  targetByRepoAndBranch: Map<string, InvestigationCodeTarget>,
  hit: CodeEvidenceHit,
): Promise<{ hit: CodeEvidenceHit; context: string } | undefined> {
  const target = targetByRepoAndBranch.get(`${hit.repoName}:${hit.branch || ""}`.toLowerCase());
  const relativePath = safeRelativeHitPath(hit.file);
  if (!target || !relativePath || !Number.isFinite(hit.line)) {
    return undefined;
  }

  try {
    const source = await readFile(
      path.join(target.repoPath, relativePath),
      "utf8",
    );
    if (/\.hbm\.xml$/i.test(relativePath)) {
      return { hit, context: source.slice(0, 200_000) };
    }
    const lines = source.split(/\r?\n/);
    const start = Math.max(0, hit.line - 40);
    const end = Math.min(lines.length, hit.line + 24);
    return {
      hit,
      context: lines.slice(start, end).join("\n").slice(0, 4000),
    };
  } catch {
    return undefined;
  }
}

async function deriveFollowUpTermsFromHits(
  targets: InvestigationCodeTarget[],
  rankedSeedHits: RankedCodeEvidenceHit[],
  seedTerms: string[],
  provenance: 'runtime_context' | 'derived_reference',
): Promise<CodeDiscoveryTrace> {
  const targetByRepoAndBranch = new Map(
    targets.map((target) => [`${target.repoName}:${target.branch || ""}`.toLowerCase(), target]),
  );
  const seedTermKeys = new Set(seedTerms.map(discoveryTermKey));
  const uniquePathHits = rankedSeedHits.filter((hit, index, hits) =>
    hits.findIndex(candidate =>
      candidate.repoName === hit.repoName
      && path.posix.normalize(candidate.file) === path.posix.normalize(hit.file)
      && Math.abs(candidate.line - hit.line) <= 80,
    ) === index,
  );
  const contextHits = dedupeRankedHits([
    ...uniquePathHits.filter(hit => codeHitRetentionClass(hit.file) === "service").slice(0, 8),
    ...uniquePathHits.filter(hit => codeHitRetentionClass(hit.file) === "model").slice(0, 4),
    ...uniquePathHits.filter(hit => codeHitRetentionClass(hit.file) === "mapping").slice(0, 8),
    ...uniquePathHits.filter(hit => codeHitRetentionClass(hit.file) === "other").slice(0, 4),
  ]);
  const contexts = (
    await Promise.all(
      contextHits.map((hit) => readHitContext(targetByRepoAndBranch, hit)),
    )
  ).filter((entry): entry is { hit: CodeEvidenceHit; context: string } =>
    Boolean(entry),
  );

  const derivedTerms = roundRobinUnique(
    contexts.map(entry => extractDiscoveryTermsFromText(entry.context, 12)),
    24,
  )
    .filter((term) => !seedTermKeys.has(discoveryTermKey(term)))
    .slice(0, 12);

  return {
    seedTerms,
    derivedTerms,
    contextFiles: unique(
      contexts.map(
        (entry) =>
          `${entry.hit.repoName}${entry.hit.branch ? `@${entry.hit.branch}` : ""}/${path.posix.normalize(entry.hit.file)}:${entry.hit.line}`,
      ),
    ).slice(0, 12),
    dataFlowHints: contexts
      .flatMap((entry) =>
        extractDataFlowHintsFromText({
          repoName: `${entry.hit.repoName}${entry.hit.branch ? `@${entry.hit.branch}` : ""}`,
          sourcePath: entry.hit.file,
          sourceLine: entry.hit.line,
          sourceTerm: entry.hit.term,
          provenance,
          context: entry.context,
        }),
      )
      .filter((hint, index, hints) =>
        hints.findIndex((candidate) =>
          candidate.sourceRepo === hint.sourceRepo
          && candidate.sourcePath === hint.sourcePath
          && candidate.tableName === hint.tableName,
        ) === index,
      )
      .slice(0, 40),
  };
}

export class NoopCodeInspectionAdapter implements CodeInspectionAdapterContract {
  readonly kind = "code" as const;

  async execute(
    _request: InvestigationAdapterRequest,
  ): Promise<InvestigationAdapterResult> {
    return {
      findings: [],
      evidence: [],
      telemetry: {
        durationMs: 0,
        requestsIssued: 0,
      },
    };
  }
}

export class CodeInspectionAdapter implements CodeInspectionAdapterContract {
  readonly kind = "code" as const;

  constructor(
    private readonly codeRegistry: InvestigationCodeTargetRegistry,
    private readonly maxMatchesPerTerm = 5,
    private readonly semanticProfileRegistry: InvestigationCodeSemanticProfileRegistry = new NoopCodeSemanticProfileRegistry(),
    private readonly discoverTargets?: (
      request: InvestigationAdapterRequest,
      terms: string[],
    ) => Promise<InvestigationCodeTarget[]>,
  ) {}

  async execute(
    request: InvestigationAdapterRequest,
  ): Promise<InvestigationAdapterResult> {
    const startedAt = Date.now();
    const semanticProfile =
      await this.semanticProfileRegistry.resolveProfile(request);
    const focusedTerms = extractFocusedCodeTerms(request);
    const terms = unique([
      ...focusedTerms,
      ...semanticSearchTerms(extractCodeTerms(request), semanticProfile),
    ]).slice(0, 24);
    const configuredTargets = await this.codeRegistry.resolveTargets(
      request.scope.clientId,
      request.scope.environment,
      request.scope.repoNames,
    );
    const discoveredTargets = this.discoverTargets
      ? await this.discoverTargets(request, terms).catch(() => [])
      : [];
    const seenTargets = new Set<string>();
    const targets = [...discoveredTargets, ...configuredTargets].filter((target) => {
      const key = `${target.clientId}:${target.environment || "*"}:${target.repoName}`.toLowerCase();
      if (seenTargets.has(key)) return false;
      seenTargets.add(key);
      return true;
    });

    if (targets.length === 0) {
      return {
        findings: [
          {
            id: `${request.runId}-code-no-target`,
            adapter: "code",
            type: "code_scope_unavailable",
            severity: "low",
            confidence: 0.25,
            title:
              "No approved code target was available for this investigation scope",
            summary: `The Code Agent could not resolve a repo target for ${request.scope.clientId} ${request.scope.environment}.`,
            evidenceRefs: [],
            requiresCodeChange: false,
            requiresDataChange: false,
          },
        ],
        evidence: [],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 0,
        },
      };
    }

    const expandedTargets = (await Promise.all(
      targets.map(expandCodeTargetBranchFamily),
    )).flat();
    const preparedTargets = await mapWithConcurrency(
      expandedTargets,
      codeSearchConcurrency(),
      target => prepareCodeTargetForScan(target, request.runId),
    );

    try {
      const availableTargets = preparedTargets
        .filter((prepared) => prepared.status !== "missing")
        .map((prepared) => prepared.scanTarget);
      const missingTargets = preparedTargets.filter(
        (prepared) => prepared.status === "missing",
      );
      const codeRefresh = preparedTargets.map((prepared) => ({
        repoName: prepared.sourceTarget.repoName,
        status: prepared.status,
        branch: prepared.branch,
        remoteRef: prepared.remoteRef,
        head: prepared.head,
        sourcePath: prepared.sourcePath,
        scanPath: prepared.scanPath,
        error: prepared.error,
        attemptedBranches: prepared.attemptedBranches,
      }));

      if (availableTargets.length === 0) {
        return {
          findings: [
            {
              id: `${request.runId}-code-path-missing`,
              adapter: "code",
              type: "code_workspace_missing",
              severity: "medium",
              confidence: 0.35,
              title:
                "Approved code targets are configured but unavailable on this worker",
              summary: `Missing repo paths: ${missingTargets.map((prepared) => `${prepared.sourceTarget.repoName}:${prepared.sourcePath}`).join(", ")}.`,
              evidenceRefs: [],
              requiresCodeChange: false,
              requiresDataChange: false,
              metadata: {
                codeRefresh,
              },
            },
          ],
          evidence: [],
          telemetry: {
            durationMs: Date.now() - startedAt,
            requestsIssued: 0,
          },
        };
      }

      const [gitSnapshots, initialSearches] = await Promise.all([
        Promise.all(availableTargets.map(readGitSnapshot)),
        mapWithConcurrency(
          availableTargets,
          codeSearchConcurrency(),
          async target => {
            if (focusedTerms.length === 0) {
              return searchTerms(target, terms, this.maxMatchesPerTerm)
            }
            const focusedKeys = new Set(focusedTerms.map(discoveryTermKey))
            const broadTerms = terms.filter(term => !focusedKeys.has(discoveryTermKey(term)))
            const [scopedFocusedResult, globalFocusedResult, broadResult] = await Promise.all([
              searchTerms(target, focusedTerms, this.maxMatchesPerTerm, request.scope.clientId),
              searchTerms(target, focusedTerms, this.maxMatchesPerTerm),
              searchTerms(target, broadTerms, this.maxMatchesPerTerm),
            ]);
            return {
              hits: [
                ...scopedFocusedResult.hits,
                ...globalFocusedResult.hits,
                ...broadResult.hits,
              ],
              error: [
                scopedFocusedResult.error,
                globalFocusedResult.error,
                broadResult.error,
              ].filter(Boolean).join("; ") || undefined,
            };
          },
        ),
      ]);
      const initialHits = initialSearches.flatMap(result => result.hits);
      const seedRankedHits = dedupeRankedHits(
        rankCodeHits(initialHits, semanticProfile, request.scope.clientId),
      );
      const initialDiscoveryTrace = await deriveFollowUpTermsFromHits(
        availableTargets,
        seedRankedHits,
        terms,
        'runtime_context',
      );
      const followUpSearches =
        initialDiscoveryTrace.derivedTerms.length > 0
          ? await mapWithConcurrency(
              availableTargets,
              codeSearchConcurrency(),
              async target => {
                const [globalResult, artifactResult] = await Promise.all([
                  searchTerms(target, initialDiscoveryTrace.derivedTerms, this.maxMatchesPerTerm),
                  searchTerms(
                    target,
                    initialDiscoveryTrace.derivedTerms,
                    this.maxMatchesPerTerm,
                    undefined,
                    initialDiscoveryTrace.derivedTerms,
                  ),
                ]);
                return {
                  hits: [...artifactResult.hits, ...globalResult.hits],
                  error: [artifactResult.error, globalResult.error].filter(Boolean).join("; ") || undefined,
                };
              },
            )
          : [];
      const followUpHits = followUpSearches.flatMap(result => result.hits);
      const followUpDiscoveryTrace = followUpHits.length > 0
        ? await deriveFollowUpTermsFromHits(
            availableTargets,
            dedupeRankedHits(rankCodeHits(followUpHits, semanticProfile, request.scope.clientId)),
            unique([...terms, ...initialDiscoveryTrace.derivedTerms]),
            'derived_reference',
          )
        : { seedTerms: [], derivedTerms: [], contextFiles: [], dataFlowHints: [] };
      const terminalSearches = followUpDiscoveryTrace.derivedTerms.length > 0
        ? await mapWithConcurrency(
            availableTargets,
            codeSearchConcurrency(),
            target => searchTerms(target, followUpDiscoveryTrace.derivedTerms, this.maxMatchesPerTerm),
          )
        : [];
      const terminalHits = terminalSearches.flatMap(result => result.hits);
      const terminalDiscoveryTrace = terminalHits.length > 0
        ? await deriveFollowUpTermsFromHits(
            availableTargets,
            dedupeRankedHits(rankCodeHits(terminalHits, semanticProfile, request.scope.clientId)),
            unique([
              ...terms,
              ...initialDiscoveryTrace.derivedTerms,
              ...followUpDiscoveryTrace.derivedTerms,
            ]),
            'derived_reference',
          )
        : { seedTerms: [], derivedTerms: [], contextFiles: [], dataFlowHints: [] };
      const discoveryTrace: CodeDiscoveryTrace = {
        seedTerms: initialDiscoveryTrace.seedTerms,
        derivedTerms: unique([
          ...initialDiscoveryTrace.derivedTerms,
          ...followUpDiscoveryTrace.derivedTerms,
        ]).slice(0, 24),
        contextFiles: unique([
          ...initialDiscoveryTrace.contextFiles,
          ...followUpDiscoveryTrace.contextFiles,
          ...terminalDiscoveryTrace.contextFiles,
        ]).slice(0, 30),
        dataFlowHints: mergeDataFlowHints(
          [
            ...terminalDiscoveryTrace.dataFlowHints,
            ...followUpDiscoveryTrace.dataFlowHints,
            ...initialDiscoveryTrace.dataFlowHints.filter(hint => hint.artifactType !== 'hibernate_mapping'),
          ],
          unique([
            ...terms,
            ...initialDiscoveryTrace.derivedTerms,
            ...followUpDiscoveryTrace.derivedTerms,
          ]),
        ),
      };
      const searchFailures = [...initialSearches, ...followUpSearches, ...terminalSearches]
        .map((result, index) => result.error
          ? {
              repo: availableTargets[index % availableTargets.length]?.repoName,
              branch: availableTargets[index % availableTargets.length]?.branch,
              error: result.error,
            }
          : null)
        .filter(failure => failure !== null);
      const searchedTerms = unique([...terms, ...discoveryTrace.derivedTerms]);
      const hits = [...initialHits, ...followUpHits, ...terminalHits];
      const searchPassCount = 1
        + (followUpSearches.length > 0 ? 1 : 0)
        + (terminalSearches.length > 0 ? 1 : 0);

      const evidenceId = `${request.runId}-code-evidence`;
      const rankedHits = dedupeRankedHits(rankCodeHits(hits, semanticProfile, request.scope.clientId));
      const topHits = rankedHits.slice(0, 30);
      const strongestSeedHit = seedRankedHits[0] || topHits[0];
      const searchedRepos = unique(availableTargets.map((target) =>
        `${target.repoName}${target.branch ? `@${target.branch}` : ""}`,
      ));
      const refreshFailures = preparedTargets.filter(
        (prepared) => prepared.status === "refresh_failed_fallback",
      );
      const baseMetadata = {
        terms: searchedTerms,
        discoveryTrace,
        dataFlowHints: discoveryTrace.dataFlowHints,
        searchedRepos,
        gitSnapshots,
        codeRefresh,
        searchFailures,
        semanticProfile: semanticProfile
          ? {
              id: semanticProfile.id,
              title: semanticProfile.title,
              summary: semanticProfile.summary,
            }
          : null,
        missingTargets: missingTargets.map((prepared) => ({
          repoName: prepared.sourceTarget.repoName,
          repoPath: prepared.sourcePath,
          error: prepared.error,
        })),
      };
      const traceSteps = [
        {
          title: "Resolve approved code targets",
          detail: `Resolved ${availableTargets.length} available repo target(s) for ${request.scope.clientId}.`,
        },
        {
          title: "Refresh GitHub code targets",
          detail: `Prepared ${preparedTargets.length} repo target(s); ${preparedTargets.filter((prepared) => prepared.status === "refreshed").length} scanned from fresh remote worktree(s).`,
        },
      ];

      if (topHits.length === 0) {
        const incompleteSearch = refreshFailures.length > 0 || searchFailures.length > 0;
        return {
          findings: [
            {
              id: `${request.runId}-code-no-hit`,
              adapter: "code",
              type: "code_no_candidate",
              severity: incompleteSearch ? "low" : "info",
              confidence: incompleteSearch ? 0.4 : 0.55,
              title: "Code Agent did not find a concrete file-level match",
              summary:
                searchFailures.length > 0
                  ? `No concrete hit was retained, and ${searchFailures.length} bounded branch scan(s) did not complete. No code root cause was inferred.`
                  : searchedTerms.length > 0
                  ? `Searched ${searchedRepos.join(", ")} for ${searchedTerms.join(", ")} without concrete hits. No code root cause was inferred.`
                  : `No useful code search terms were extracted for ${searchedRepos.join(", ")}. No code root cause was inferred.`,
              evidenceRefs: [evidenceId],
              requiresCodeChange: false,
              requiresDataChange: false,
              metadata: {
                codeRefresh,
              },
            },
          ],
          evidence: [
            {
              id: evidenceId,
              adapter: "code",
              title: "Code Agent strict validation scan",
              summary:
                "No file/line candidates were found. This is an evidence result, not an RCA conclusion.",
              contentType: "application/json",
              metadata: {
                ...baseMetadata,
                traceSteps: [
                  ...traceSteps,
                  {
                    title: "Run deterministic code search",
                    detail: semanticProfile
                      ? `Searched ${searchedTerms.length} extracted/derived term(s) using rg, including ${semanticProfile.title} issue-profile terms. No LLM inference was used for this scan.`
                      : `Searched ${searchedTerms.length} extracted/derived term(s) using rg. No LLM inference was used for this scan.`,
                  },
                  ...(discoveryTrace.derivedTerms.length > 0
                    ? [
                        {
                          title: "Derive follow-up code terms",
                          detail: `Mined ${discoveryTrace.derivedTerms.length} runtime/config identifier(s) and searched them through ${searchPassCount - 1} bounded follow-up pass(es).`,
                          rowCount: discoveryTrace.derivedTerms.length,
                        },
                      ]
                    : []),
                ],
              },
            },
          ],
          telemetry: {
            durationMs: Date.now() - startedAt,
            requestsIssued:
              availableTargets.length * searchPassCount,
          },
        };
      }

      const firstHit = strongestSeedHit;
      const firstPath = firstHit
        ? `${firstHit.repoName}${firstHit.branch ? `@${firstHit.branch}` : ""}/${firstHit.file}:${firstHit.line}`
        : "unknown";
      const semanticLabel = semanticProfile
        ? `${semanticProfile.title} semantic candidate`
        : "strongest candidate";

      return {
        findings: [
          {
            id: `${request.runId}-code-candidates`,
            adapter: "code",
            type: "code_path_candidates",
            severity: refreshFailures.length > 0 ? "low" : "medium",
            confidence: refreshFailures.length > 0 ? 0.4 : 0.48,
            title: "Code Agent found file-level candidate evidence",
            summary: `Found ${topHits.length} bounded file/line hit(s); ${semanticLabel} starts at ${firstPath}. These lexical candidates require relationship validation and do not establish code-path relevance or RCA.`,
            evidenceRefs: [evidenceId],
            requiresCodeChange: false,
            requiresDataChange: false,
            metadata: {
              strongestCandidate: firstPath,
              semanticProfileId: semanticProfile?.id,
              codeRefresh,
            },
          },
        ],
        evidence: [
          {
            id: evidenceId,
            adapter: "code",
            title: "Code Agent strict validation scan",
            summary: `Searched ${searchedRepos.join(", ")} and found ${topHits.length} file/line candidate(s).`,
            contentType: "application/json",
            metadata: {
              ...baseMetadata,
              hits: topHits.map((hit) => ({
                repoName: hit.repoName,
                branch: hit.branch,
                path: path.posix.normalize(hit.file),
                line: hit.line,
                term: hit.term,
                preview: hit.preview,
                semanticScore: hit.semanticScore,
                semanticReasons: hit.semanticReasons,
              })),
              traceSteps: [
                ...traceSteps,
                {
                  title: semanticProfile
                    ? "Run semantic code ranking"
                    : "Run deterministic code search",
                  detail: semanticProfile
                    ? `Searched ${searchedTerms.length} extracted/derived term(s) using rg, ranked ${rankedHits.length} unique hit(s) against ${semanticProfile.title}, and captured bounded file/line evidence only.`
                    : `Searched ${searchedTerms.length} extracted/derived term(s) using rg and captured file/line evidence only.`,
                  rowCount: topHits.length,
                },
                ...(discoveryTrace.derivedTerms.length > 0
                  ? [
                      {
                        title: "Derive follow-up code terms",
                        detail: `Mined ${discoveryTrace.derivedTerms.length} runtime/config identifier(s) and searched them through ${searchPassCount - 1} bounded follow-up pass(es).`,
                        rowCount: discoveryTrace.derivedTerms.length,
                      },
                    ]
                  : []),
              ],
            },
          },
        ],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued:
            availableTargets.length * searchPassCount,
        },
      };
    } finally {
      await cleanupPreparedTargets(preparedTargets);
    }
  }
}
