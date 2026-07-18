import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  adfToMarkdown,
  createJiraClient,
  type JiraAttachment,
  type JiraComment,
  type JiraFieldMetadata,
  type JiraIssue,
} from "../../../src/orchestrator/JiraClient.js";
import {
  extractJsonPayloadEvidence,
  getAnchorDiagnosticsConfig,
  type TicketAnchorExtractionConfig,
} from "../../../src/investigation/index.js";
import type {
  InvestigationTicketIdentifierContext,
  InvestigationTicketAttachmentContext,
  InvestigationTicketContext,
  InvestigationTimeWindow,
} from "../../../src/investigation/index.js";
import { assertValidJiraKey } from "./oneshotRunRequestSupport.js";

const execFileAsync = promisify(execFile);

const DEFAULT_ATTACHMENT_DOWNLOAD_LIMIT = 64_000;
const DEFAULT_IMAGE_ATTACHMENT_DOWNLOAD_LIMIT = 512_000;
const DEFAULT_ATTACHMENT_TEXT_LIMIT = 12_000;
const DEFAULT_CONTEXT_LIMIT = 80_000;
const DEFAULT_JIRA_FIELD_METADATA_CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_COMMENTS = 100;
const MAX_ATTACHMENTS = 100;
const MAX_LABELS = 100;
const MAX_SENSITIVE_IDENTIFIERS = 50;
const MAX_RELEASE_FIELD_IDS = 8;
const RELEASE_VERSION_PATTERN = /(?:^|[^a-z0-9])v?([0-9]+(?:[._-][0-9]+){1,4})(?=$|[^0-9])/i;

const SECRET_KEY_VALUE = /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|credential|private[_.-]?key|access[_.-]?key|session[_.-]?token|api[_.-]?key|auth[_.-]?key|client[_.-]?secret|keystore(?:[_.-]?(?:pass|password))?|truststore(?:[_.-]?(?:pass|password))?)[A-Za-z0-9_.-]*)\b\s*[:=]\s*['"]?[^,'"\n)]+?(?=\s+[A-Za-z0-9_.-]+\s*[:=]|[,)'"\n]|$)/gi;
const SENSITIVE_KEY_VALUE = /\b([A-Za-z0-9_.-]*(?:member(?:[_.-]|\s*)?id|memberid|member(?:[_.-]|\s*)?no|subscriber(?:[_.-]|\s*)?id|subscriberid|person(?:[_.-]|\s*)?id|personid|patient(?:[_.-]|\s*)?id|patientid|medicare(?:[_.-]|\s*)?no|medicareno|medicare(?:[_.-]|\s*)?id|medicaid(?:[_.-]|\s*)?no|medicaidno|medicaid(?:[_.-]|\s*)?id|mbi|hicn|policy(?:[_.-]|\s*)?number|policynumber|mrn|ext(?:[_.-]|\s*)?id|first(?:[_.-]|\s*)?name|firstname|last(?:[_.-]|\s*)?name|lastname|full(?:[_.-]|\s*)?name|fullname|dob|date(?:[_.-]|\s*)?of(?:[_.-]|\s*)?birth|ssn|email|phone|fax|address(?:[_.-]|\s*)?[0-9]?|city|zip|npi|tax(?:[_.-]|\s*)?id)[A-Za-z0-9_.-]*)\b\s*[:=]\s*['"]?[^,'"\n)]+?(?=\s+[A-Za-z0-9_.-]+\s*[:=]|[,)'"\n]|$)/gi;
const INLINE_SECRET_QUERY_PARAM = /([?&](?:password|passwd|pwd|secret|token|access[_.-]?key|session[_.-]?token|api[_.-]?key|auth[_.-]?key)=)[^&\s,'")]+/gi;
const IMAGE_OCR_PHI_SIGNAL = /\b(?:member|subscriber|person|patient|medicare|medicaid|mbi|hicn|policy|mrn|first\s*name|last\s*name|full\s*name|dob|date\s*of\s*birth|ssn|email|phone|fax|address|city|zip|npi|tax\s*id)\b|\b\d{3}-\d{2}-\d{4}\b/i;
const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;
const STOP_TERMS = new Set([
  "ticket",
  "description",
  "comment",
  "please",
  "thanks",
  "issue",
  "client",
  "environment",
  "investigation",
  "attached",
  "attachment",
  "screen",
  "screenshot",
  "support",
  "cpht",
  "ate",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "communities",
  "member",
  "subscriber",
  "patient",
  "firstname",
  "lastname",
  "address",
]);

let cachedJiraFieldMetadata: {
  expiresAt: number;
  fields: JiraFieldMetadata[];
} | undefined;
let jiraFieldMetadataInflight: Promise<JiraFieldMetadata[]> | undefined;
const jiraAssetTextCache = new Map<string, string>();

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function numericEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1_000, Math.min(200_000, parsed));
}

function boundedNumericEnv(name: string, fallback: number, min = 0, max = 3_600_000): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

export function isInvestigationJiraContextConfigured(): boolean {
  return Boolean(envValue("JIRA_BASE_URL") && envValue("JIRA_USERNAME") && envValue("JIRA_TOKEN"));
}

function missingJiraContextEnv(): string[] {
  return ["JIRA_BASE_URL", "JIRA_USERNAME", "JIRA_TOKEN"].filter((name) => !envValue(name));
}

export function redactTicketContextText(value: string): string {
  return value
    .replace(INLINE_SECRET_QUERY_PARAM, "$1[REDACTED]")
    .replace(SECRET_KEY_VALUE, (_match, label) => `${label}=[REDACTED]`)
    .replace(SENSITIVE_KEY_VALUE, (_match, label) => `${label}=[REDACTED]`);
}

function boundedText(value: string, maxChars: number): string {
  const redacted = redactTicketContextText(value.trim());
  return redacted.length > maxChars ? `${redacted.slice(0, maxChars)}\n[TRUNCATED]` : redacted;
}

function jiraFieldToText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const text = value
      .map((entry) => jiraFieldToText(entry))
      .filter((entry): entry is string => Boolean(entry?.trim()))
      .join("\n");
    return text || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "doc") {
    return adfToMarkdown(value as Parameters<typeof adfToMarkdown>[0]);
  }
  for (const key of ["label", "name", "value", "displayName", "objectKey"]) {
    const fieldValue = record[key];
    if (typeof fieldValue === "string" && fieldValue.trim()) {
      return fieldValue;
    }
  }
  return undefined;
}

function normalizeJiraFieldName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function configuredJiraEnvironmentFieldIds(): string[] {
  return uniqueStrings([
    "INVESTIGATION_JIRA_ENVIRONMENT_FIELD_IDS",
    "INVESTIGATION_JIRA_ENVIRONMENT_FIELD_ID",
    "JIRA_ENVIRONMENT_FIELD_IDS",
    "JIRA_ENVIRONMENT_FIELD_ID",
    "JIRA_ENVIRONMENT_FIELD",
  ].flatMap((name) =>
    (process.env[name] || "")
      .split(",")
      .map((fieldId) => fieldId.trim())
      .filter((fieldId) => /^[A-Za-z0-9_]+$/.test(fieldId)),
  )).filter((fieldId) => fieldId !== "environment");
}

function configuredJiraReleaseFieldIds(): string[] {
  return uniqueStrings([
    "INVESTIGATION_JIRA_RELEASE_FIELD_IDS",
    "INVESTIGATION_JIRA_RELEASE_FIELD_ID",
    "INVESTIGATION_JIRA_RELEASE_VERSION_FIELD_IDS",
    "INVESTIGATION_JIRA_RELEASE_VERSION_FIELD_ID",
    "JIRA_RELEASE_FIELD_IDS",
    "JIRA_RELEASE_FIELD_ID",
    "JIRA_RELEASE_VERSION_FIELD_IDS",
    "JIRA_RELEASE_VERSION_FIELD_ID",
  ].flatMap((name) =>
    (process.env[name] || "")
      .split(",")
      .map((fieldId) => fieldId.trim())
      .filter((fieldId) => /^[A-Za-z0-9_]+$/.test(fieldId)),
  )).filter((fieldId) => fieldId !== "fixVersions");
}

function isEnvironmentField(field: JiraFieldMetadata): boolean {
  const normalized = normalizeJiraFieldName(field.name);
  return (
    normalized === "environment"
    || normalized === "environments"
    || normalized.endsWith(" environment")
    || normalized.includes(" environment ")
  );
}

function releaseFieldRank(field: JiraFieldMetadata): number | undefined {
  const normalized = normalizeJiraFieldName(field.name);
  if (normalized === "release version") {
    return 0;
  }
  if (normalized === "release") {
    return 1;
  }
  if (normalized === "fix version" || normalized === "fix versions") {
    return 2;
  }
  if (normalized.endsWith(" release version") || normalized.includes(" release version ")) {
    return 3;
  }
  if (normalized.endsWith(" release") || normalized.includes(" release ")) {
    return 4;
  }
  return undefined;
}

async function resolveJiraEnvironmentFieldIds(client: ReturnType<typeof createJiraClient>): Promise<string[]> {
  const configuredFieldIds = configuredJiraEnvironmentFieldIds();
  if (configuredFieldIds.length > 0) {
    return configuredFieldIds.slice(0, 8);
  }

  const fields = await fetchCachedJiraFields(client).catch(() => []);
  return fields
    .filter(isEnvironmentField)
    .map((field) => field.id)
    .filter((fieldId) => fieldId !== "environment")
    .slice(0, 8);
}

async function resolveJiraReleaseFieldIds(client: ReturnType<typeof createJiraClient>): Promise<string[]> {
  const configuredFieldIds = configuredJiraReleaseFieldIds();
  if (configuredFieldIds.length > 0) {
    return configuredFieldIds.slice(0, MAX_RELEASE_FIELD_IDS);
  }

  const fields = await fetchCachedJiraFields(client).catch(() => []);
  return fields
    .map((field) => ({ field, rank: releaseFieldRank(field) }))
    .filter((entry): entry is { field: JiraFieldMetadata; rank: number } => entry.rank !== undefined)
    .sort((left, right) => left.rank - right.rank)
    .map(({ field }) => field.id)
    .filter((fieldId) => fieldId !== "fixVersions")
    .slice(0, MAX_RELEASE_FIELD_IDS);
}

function normalizeJiraReleaseVersion(value: string | undefined): string | undefined {
  const match = value?.trim().match(RELEASE_VERSION_PATTERN);
  return match?.[1]?.replace(/[_-]/g, ".");
}

function issueReleaseVersion(issue: JiraIssue, releaseFieldIds: string[]): string | undefined {
  const customFieldCandidates = releaseFieldIds
    .map((fieldId) => jiraFieldToText(issue.fields[fieldId]))
    .filter((value): value is string => Boolean(value?.trim()));
  const fixVersionCandidates = (issue.fields.fixVersions || [])
    .map((version) => version.name)
    .filter((value): value is string => Boolean(value?.trim()));

  for (const candidate of [...customFieldCandidates, ...fixVersionCandidates]) {
    const releaseVersion = normalizeJiraReleaseVersion(candidate);
    if (releaseVersion) {
      return releaseVersion;
    }
  }
  return undefined;
}

async function fetchCachedJiraFields(client: ReturnType<typeof createJiraClient>): Promise<JiraFieldMetadata[]> {
  const ttlMs = boundedNumericEnv(
    "INVESTIGATION_JIRA_FIELD_METADATA_CACHE_TTL_MS",
    DEFAULT_JIRA_FIELD_METADATA_CACHE_TTL_MS,
  );
  const now = Date.now();
  if (ttlMs > 0 && cachedJiraFieldMetadata && cachedJiraFieldMetadata.expiresAt > now) {
    return cachedJiraFieldMetadata.fields;
  }
  if (jiraFieldMetadataInflight) {
    return jiraFieldMetadataInflight;
  }

  const fetchPromise = client.fetchFields().then((fields) => {
    if (ttlMs > 0 && fields.length > 0) {
      cachedJiraFieldMetadata = {
        expiresAt: Date.now() + ttlMs,
        fields,
      };
    }
    return fields;
  });
  jiraFieldMetadataInflight = fetchPromise;
  try {
    return await fetchPromise;
  } finally {
    if (jiraFieldMetadataInflight === fetchPromise) {
      jiraFieldMetadataInflight = undefined;
    }
  }
}

interface JiraAssetObjectRef {
  workspaceId?: string;
  objectId: string;
}

function extractJiraAssetObjectRefs(value: unknown): JiraAssetObjectRef[] {
  if (Array.isArray(value)) {
    return value.flatMap(extractJiraAssetObjectRefs);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const objectId = typeof record.objectId === "string" || typeof record.objectId === "number"
    ? String(record.objectId)
    : undefined;
  if (!objectId) {
    return [];
  }
  return [{
    workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : undefined,
    objectId,
  }];
}

function assetObjectUrlCandidates(ref: JiraAssetObjectRef): string[] {
  const baseUrl = envValue("JIRA_BASE_URL")?.replace(/\/$/, "") || "";
  return [
    ref.workspaceId
      ? `https://api.atlassian.com/jsm/assets/workspace/${encodeURIComponent(ref.workspaceId)}/v1/object/${encodeURIComponent(ref.objectId)}`
      : undefined,
    baseUrl
      ? `${baseUrl}/rest/assets/1.0/object/${encodeURIComponent(ref.objectId)}`
      : undefined,
    baseUrl
      ? `${baseUrl}/rest/servicedesk/cmdb/1/object/${encodeURIComponent(ref.objectId)}`
      : undefined,
  ].filter((url): url is string => Boolean(url));
}

function assetObjectPayloadText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const direct = jiraFieldToText(record);
  if (direct && !/^\d+$/.test(direct)) {
    return direct;
  }

  const attributes = Array.isArray(record.attributes) ? record.attributes : [];
  const values: string[] = [];
  for (const attribute of attributes) {
    if (!attribute || typeof attribute !== "object") {
      continue;
    }
    const attrRecord = attribute as Record<string, unknown>;
    const objectTypeAttribute = attrRecord.objectTypeAttribute as Record<string, unknown> | undefined;
    const attrName = typeof objectTypeAttribute?.name === "string" ? objectTypeAttribute.name : "";
    const attrValues = Array.isArray(attrRecord.objectAttributeValues)
      ? attrRecord.objectAttributeValues
      : [];
    for (const attrValue of attrValues) {
      const text = jiraFieldToText(attrValue);
      if (text && (
        /envid|environment|client|release/i.test(attrName)
        || /^(?:[A-Z0-9]+---)?[A-Z]+[-_ ]*(?:CP[-_ ]*)?(?:PROD|PRD|UAT|INT|DEV|STAGE|STG)\d*/i.test(text)
      )) {
        values.push(text);
      }
    }
  }
  return uniqueStrings(values).join("\n") || undefined;
}

async function fetchJiraAssetObjectText(ref: JiraAssetObjectRef): Promise<string | undefined> {
  const cacheKey = `${ref.workspaceId || "site"}:${ref.objectId}`;
  const cached = jiraAssetTextCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  for (const url of assetObjectUrlCandidates(ref)) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: jiraAuthHeader(),
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        continue;
      }
      const payload = await response.json().catch(() => undefined);
      const text = assetObjectPayloadText(payload);
      if (text) {
        const bounded = boundedText(text, 500);
        jiraAssetTextCache.set(cacheKey, bounded);
        return bounded;
      }
    } catch {
      // Best-effort enrichment only; the ticket remains usable without labels.
    }
  }
  return undefined;
}

async function issueEnvironmentName(issue: JiraIssue, environmentFieldIds: string[]): Promise<string> {
  const rawCandidates = [
    issue.fields.environment,
    ...environmentFieldIds.map((fieldId) => issue.fields[fieldId]),
  ];
  const candidates = rawCandidates
    .map((value) => jiraFieldToText(value))
    .filter((value): value is string => Boolean(value?.trim()));
  const assetTexts = await Promise.all(rawCandidates
    .flatMap(extractJiraAssetObjectRefs)
    .slice(0, 8)
    .map(fetchJiraAssetObjectText));
  return boundedText(uniqueStrings([
    ...candidates,
    ...assetTexts.filter((value): value is string => Boolean(value?.trim())),
  ]).join("\n"), 500);
}

function buildCombinedText(context: Pick<InvestigationTicketContext, "title" | "environmentName" | "description" | "comments" | "attachments" | "labels">): string {
  return [
    context.title,
    context.environmentName,
    ...(context.labels || []),
    context.description,
    ...(context.comments || []).map((comment) => comment.body),
    ...(context.attachments || []).flatMap((attachment) => [attachment.filename, attachment.textExcerpt]),
  ]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join("\n");
}

function ticketAnchorExtractionConfig(
  kind: InvestigationTicketIdentifierContext["kind"],
): TicketAnchorExtractionConfig | undefined {
  return getAnchorDiagnosticsConfig().ticketAnchorExtraction[kind];
}

function firstPatternMatch(value: string, patterns: RegExp[]): RegExpMatchArray | null {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match;
  }
  return null;
}

function matchesAnyPattern(value: string, patterns: RegExp[]): boolean {
  return firstPatternMatch(value, patterns) !== null;
}

function valuesMatchingPatterns(value: string, patterns: RegExp[]): string[] {
  const matches = patterns.flatMap((pattern) => {
    const flags = `${pattern.ignoreCase ? "i" : ""}${pattern.multiline ? "m" : ""}g`;
    return value.match(new RegExp(pattern.source, flags)) || [];
  });
  return uniqueStrings(matches);
}

function isConfiguredTicketLabel(value: string): boolean {
  return Object.values(getAnchorDiagnosticsConfig().ticketAnchorExtraction)
    .some((config) => Boolean(config && matchesAnyPattern(value, config.labelPatterns)));
}

function nextConfiguredTicketLabelIndex(value: string): number | undefined {
  const indexes = Object.values(getAnchorDiagnosticsConfig().ticketAnchorExtraction)
    .flatMap((config) => config?.labelPatterns || [])
    .map((pattern) => value.match(pattern)?.index)
    .filter((index): index is number => index !== undefined);
  return indexes.length > 0 ? Math.min(...indexes) : undefined;
}

function extractConfiguredIdentifiersFromTicketText(
  text: string,
  source: InvestigationTicketIdentifierContext["source"],
  kind: InvestigationTicketIdentifierContext["kind"],
): InvestigationTicketIdentifierContext[] {
  const config = ticketAnchorExtractionConfig(kind);
  if (!config?.labelPatterns.length || !config.valuePatterns.length) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const identifiers: InvestigationTicketIdentifierContext[] = [];
  const seen = new Set<string>();

  function addValues(values: string[]) {
    for (const value of values) {
      if (seen.has(value)) {
        continue;
      }
      seen.add(value);
      identifiers.push({
        kind,
        source,
        value,
        sensitive: true,
      });
      if (identifiers.length >= MAX_SENSITIVE_IDENTIFIERS) {
        return;
      }
    }
  }

  for (let index = 0; index < lines.length && identifiers.length < MAX_SENSITIVE_IDENTIFIERS; index += 1) {
    const line = lines[index].trim();
    const labelMatch = firstPatternMatch(line, config.labelPatterns);
    if (!labelMatch || matchesAnyPattern(line, config.rejectLabelPatterns)) continue;

    const unboundedAfterLabel = line.slice((labelMatch.index || 0) + labelMatch[0].length);
    const nextLabelIndex = nextConfiguredTicketLabelIndex(unboundedAfterLabel);
    const afterLabel = nextLabelIndex === undefined
      ? unboundedAfterLabel
      : unboundedAfterLabel.slice(0, nextLabelIndex);
    const sameLineValues = valuesMatchingPatterns(afterLabel, config.valuePatterns);
    if (sameLineValues.length > 0) {
      addValues(sameLineValues);
      continue;
    }

    for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 4); lookahead += 1) {
      const candidate = lines[lookahead].trim();
      if (!candidate) {
        continue;
      }
      if (isConfiguredTicketLabel(candidate)) break;
      const values = valuesMatchingPatterns(candidate, config.valuePatterns);
      if (values.length > 0) {
        addValues(values);
      }
      break;
    }
  }

  return identifiers;
}

export function extractCaseIdentifiersFromTicketText(
  text: string,
  source: InvestigationTicketIdentifierContext["source"],
): InvestigationTicketIdentifierContext[] {
  return extractConfiguredIdentifiersFromTicketText(text, source, "case_number");
}

export function extractMemberIdentifiersFromTicketText(
  text: string,
  source: InvestigationTicketIdentifierContext["source"],
): InvestigationTicketIdentifierContext[] {
  return extractConfiguredIdentifiersFromTicketText(text, source, "member_identifier");
}

export function extractMemberIdentifiersFromJson(
  text: string,
  source: InvestigationTicketIdentifierContext["source"],
): InvestigationTicketIdentifierContext[] {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }

  const identifiers: InvestigationTicketIdentifierContext[] = [];
  const seen = new Set<string>();
  const config = ticketAnchorExtractionConfig("member_identifier");
  if (!config?.jsonKeyPatterns.length || !config.valuePatterns.length) return [];
  const addValue = (candidate: unknown) => {
    if (typeof candidate !== "string" && typeof candidate !== "number") return;
    const value = String(candidate).trim();
    if (!valuesMatchingPatterns(value, config.valuePatterns).includes(value) || seen.has(value)) return;
    seen.add(value);
    identifiers.push({ kind: "member_identifier", source, value, sensitive: true });
  };
  const visit = (value: unknown) => {
    if (identifiers.length >= MAX_SENSITIVE_IDENTIFIERS || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    for (const [key, candidate] of Object.entries(value)) {
      const normalizedKey = key.replace(/[^A-Za-z0-9]/g, "");
      if (matchesAnyPattern(normalizedKey, config.jsonKeyPatterns)) {
        if (Array.isArray(candidate)) {
          for (const item of candidate) addValue(item);
        } else {
          addValue(candidate);
        }
      }
      visit(candidate);
    }
  };

  visit(payload);
  return identifiers;
}

export function extractMemberIdentifierFromAttachmentFilename(
  filename: string,
): InvestigationTicketIdentifierContext[] {
  const basename = path.parse(filename.trim()).name;
  const config = ticketAnchorExtractionConfig("member_identifier");
  if (!config?.filenamePatterns.length || !matchesAnyPattern(basename, config.filenamePatterns)) return [];
  return [{ kind: "member_identifier", source: "attachment", value: basename, sensitive: true }];
}

export function extractTicketIdentifiersFromTicketText(
  text: string,
  source: InvestigationTicketIdentifierContext["source"],
): InvestigationTicketIdentifierContext[] {
  return [
    ...extractCaseIdentifiersFromTicketText(text, source),
    ...extractMemberIdentifiersFromTicketText(text, source),
  ];
}

export function extractInvestigationTermsFromTicketContext(
  context: Pick<InvestigationTicketContext, "title" | "environmentName" | "description" | "comments" | "attachments" | "labels">,
): string[] {
  const rawText = boundedText(buildCombinedText(context), numericEnv("INVESTIGATION_JIRA_CONTEXT_MAX_CHARS", DEFAULT_CONTEXT_LIMIT));
  const safeSeedText = [
    context.title,
    context.environmentName,
    ...(context.labels || []),
    ...(context.attachments || []).map((attachment) => attachment.filename),
  ]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join("\n")
    .toLowerCase();
  const quoted = Array.from(rawText.matchAll(/"([^"\n]{4,100})"/g))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const identifiers = rawText.match(/[A-Za-z_][A-Za-z0-9_.-]{3,}/g) || [];
  const terms = [...quoted, ...identifiers].filter((term) => {
    const normalized = term.toLowerCase();
    const normalizedStopKey = normalized.replace(/[.]+$/g, "");
    const safeSeedTerm = safeSeedText.includes(normalized);
    const looksLikeEmailOrDomainFragment = (
      /^[A-Za-z0-9.-]+\.(?:com|net|org|edu|gov|io|co)$/i.test(term)
      || /^[A-Za-z]+(?:\.[A-Za-z0-9]+)+$/.test(term)
    );
    const looksLikePersonName = /^[A-Z][a-z]{2,}$/.test(term) && !safeSeedTerm;
    const looksLikeSupportMailbox = normalized.includes("support") && !safeSeedTerm;
    return (
      !STOP_TERMS.has(normalizedStopKey)
      && !JIRA_KEY_PATTERN.test(term)
      && !normalized.includes("[redacted]")
      && !looksLikeEmailOrDomainFragment
      && !looksLikePersonName
      && !looksLikeSupportMailbox
      && (
        term.length >= 7
        || term.includes("_")
        || term.includes(".")
        || /[A-Z]/.test(term.slice(1))
        || /(Exception|Error|Service|Controller|Manager|Handler|Repository|Processor|Batch|Job|Config|Appeal|EAppeal|ePA)$/i.test(term)
      )
    );
  });
  return Array.from(new Set(terms)).slice(0, 24);
}

function isSupportedTextAttachment(attachment: JiraAttachment): boolean {
  const mimeType = (attachment.mimeType ?? "").toLowerCase();
  const filename = (attachment.filename ?? "").toLowerCase();
  if (mimeType.startsWith("text/")) {
    return true;
  }
  if (
    mimeType === "application/json"
    || mimeType === "application/xml"
    || mimeType === "text/xml"
    || mimeType === "application/yaml"
    || mimeType === "application/x-yaml"
    || mimeType.endsWith("+json")
    || mimeType.endsWith("+xml")
  ) {
    return true;
  }
  if (mimeType === "application/javascript") {
    return true;
  }
  return [
    ".txt",
    ".log",
    ".json",
    ".xml",
    ".yaml",
    ".yml",
    ".md",
    ".markdown",
    ".csv",
    ".sql",
    ".sh",
    ".bash",
    ".py",
    ".js",
    ".ts",
    ".java",
    ".properties",
    ".conf",
    ".cfg",
    ".ini",
    ".env",
    ".html",
    ".htm",
    ".css",
    ".config",
    ".gradle",
  ].some((extension) => filename.endsWith(extension));
}

function isSupportedImageAttachment(attachment: JiraAttachment): boolean {
  const mimeType = (attachment.mimeType ?? "").toLowerCase();
  const filename = (attachment.filename ?? "").toLowerCase();
  return (
    mimeType === "image/png"
    || mimeType === "image/jpeg"
    || filename.endsWith(".png")
    || filename.endsWith(".jpg")
    || filename.endsWith(".jpeg")
  );
}

function imageOcrEnabled(): boolean {
  return !/^(0|false|no)$/i.test(envValue("INVESTIGATION_JIRA_IMAGE_OCR_ENABLED") || "true");
}

function imageOcrPhiGuardEnabled(): boolean {
  return !/^(0|false|no)$/i.test(envValue("INVESTIGATION_JIRA_IMAGE_OCR_SKIP_PHI") || "true");
}

function containsImageOcrPhiSignal(value: string): boolean {
  return IMAGE_OCR_PHI_SIGNAL.test(value);
}

function imageOcrCommand(): string {
  return envValue("INVESTIGATION_JIRA_IMAGE_OCR_COMMAND") || "tesseract";
}

function imageOcrArgs(imagePath: string): string[] {
  const configured = envValue("INVESTIGATION_JIRA_IMAGE_OCR_ARGS");
  if (configured) {
    return configured
      .split(/\s+/)
      .map((arg) => arg.replaceAll("{input}", imagePath))
      .filter(Boolean);
  }
  return [imagePath, "stdout"];
}

function jiraAuthHeader(): string {
  return `Basic ${Buffer.from(`${envValue("JIRA_USERNAME") || ""}:${envValue("JIRA_TOKEN") || ""}`).toString("base64")}`;
}

async function downloadAttachmentText(attachment: JiraAttachment): Promise<string> {
  if (!attachment.content) {
    throw new Error("attachment download URL missing");
  }
  const response = await fetch(attachment.content, {
    method: "GET",
    headers: {
      Authorization: jiraAuthHeader(),
      Accept: "*/*",
    },
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`attachment download failed: ${response.status} ${response.statusText} ${errorText.slice(0, 200)}`);
  }
  return response.text();
}

async function downloadAttachmentBytes(attachment: JiraAttachment): Promise<Buffer> {
  if (!attachment.content) {
    throw new Error("attachment download URL missing");
  }
  const response = await fetch(attachment.content, {
    method: "GET",
    headers: {
      Authorization: jiraAuthHeader(),
      Accept: attachment.mimeType || "*/*",
    },
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`attachment download failed: ${response.status} ${response.statusText} ${errorText.slice(0, 200)}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function safeImageExtension(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return [".png", ".jpg", ".jpeg"].includes(extension) ? extension : ".png";
}

async function extractImageAttachmentText(attachment: JiraAttachment): Promise<{
  rawText: string;
  sha256: string;
}> {
  if (!imageOcrEnabled()) {
    throw new Error("image OCR disabled");
  }
  const maxBytes = numericEnv("INVESTIGATION_JIRA_IMAGE_ATTACHMENT_MAX_BYTES", DEFAULT_IMAGE_ATTACHMENT_DOWNLOAD_LIMIT);
  if (!attachment.content || (typeof attachment.size === "number" && attachment.size > maxBytes)) {
    throw new Error("image attachment exceeds OCR size limit");
  }

  const bytes = await downloadAttachmentBytes(attachment);
  if (bytes.length > maxBytes) {
    throw new Error("downloaded image attachment exceeds OCR size limit");
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const tempDir = await mkdtemp(path.join(tmpdir(), "investigation-jira-image-"));
  const imagePath = path.join(tempDir, `attachment-${attachment.id}${safeImageExtension(attachment.filename || "")}`);
  try {
    await writeFile(imagePath, bytes);
    const { stdout } = await execFileAsync(imageOcrCommand(), imageOcrArgs(imagePath), {
      maxBuffer: numericEnv("INVESTIGATION_JIRA_IMAGE_OCR_STDOUT_MAX_BYTES", DEFAULT_ATTACHMENT_TEXT_LIMIT * 4),
    });
    return {
      rawText: String(stdout || ""),
      sha256,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function mapAttachment(
  attachment: JiraAttachment,
  identifierSink?: InvestigationTicketIdentifierContext[],
): Promise<InvestigationTicketAttachmentContext> {
  identifierSink?.push(...extractTicketIdentifiersFromTicketText(attachment.filename, "attachment"));
  identifierSink?.push(...extractMemberIdentifierFromAttachmentFilename(attachment.filename));
  const base = {
    id: attachment.id,
    filename: redactTicketContextText(attachment.filename),
    mimeType: attachment.mimeType,
    size: attachment.size,
    created: attachment.created,
  };

  const maxBytes = numericEnv("INVESTIGATION_JIRA_ATTACHMENT_MAX_BYTES", DEFAULT_ATTACHMENT_DOWNLOAD_LIMIT);
  if (isSupportedTextAttachment(attachment) && (!attachment.content || (typeof attachment.size === "number" && attachment.size > maxBytes))) {
    return {
      ...base,
      extractionStatus: "skipped",
    };
  }

  if (isSupportedTextAttachment(attachment)) {
    try {
      const rawText = await downloadAttachmentText(attachment);
      identifierSink?.push(...extractTicketIdentifiersFromTicketText(rawText, "attachment"));
      identifierSink?.push(...extractMemberIdentifiersFromJson(rawText, "attachment"));
      const sha256 = createHash("sha256").update(rawText).digest("hex");
      const contentRef = `jira-attachment:${attachment.id}:sha256:${sha256.slice(0, 12)}`;
      const payloadEvidence = extractJsonPayloadEvidence(rawText, contentRef);
      const textExcerpt = boundedText(rawText, numericEnv("INVESTIGATION_JIRA_ATTACHMENT_TEXT_MAX_CHARS", DEFAULT_ATTACHMENT_TEXT_LIMIT));
      const extractedTerms = extractInvestigationTermsFromTicketContext({
        title: base.filename,
        labels: [],
        description: textExcerpt,
        comments: [],
        attachments: [],
      });
      return {
        ...base,
        extractionStatus: "text_extracted",
        textExcerpt,
        extractedTerms,
        ...(payloadEvidence.fieldTerms.length ? { payloadFieldTerms: payloadEvidence.fieldTerms } : {}),
        ...(payloadEvidence.observedFieldLengths.length ? { observedFieldLengths: payloadEvidence.observedFieldLengths } : {}),
        sha256,
        contentRef,
      };
    } catch {
      return {
        ...base,
        extractionStatus: "failed",
      };
    }
  }

  if (isSupportedImageAttachment(attachment)) {
    if (!imageOcrEnabled()) {
      return {
        ...base,
        extractionStatus: "metadata_only",
      };
    }
    try {
      const { rawText, sha256 } = await extractImageAttachmentText(attachment);
      if (imageOcrPhiGuardEnabled() && containsImageOcrPhiSignal(rawText)) {
        return {
          ...base,
          extractionStatus: "skipped",
          sha256,
          contentRef: `jira-attachment:${attachment.id}:sha256:${sha256.slice(0, 12)}`,
        };
      }
      const textExcerpt = boundedText(rawText, numericEnv("INVESTIGATION_JIRA_ATTACHMENT_TEXT_MAX_CHARS", DEFAULT_ATTACHMENT_TEXT_LIMIT));
      if (!textExcerpt.trim()) {
        return {
          ...base,
          extractionStatus: "failed",
          sha256,
          contentRef: `jira-attachment:${attachment.id}:sha256:${sha256.slice(0, 12)}`,
        };
      }
      const extractedTerms = extractInvestigationTermsFromTicketContext({
        title: base.filename,
        labels: [],
        description: textExcerpt,
        comments: [],
        attachments: [],
      });
      return {
        ...base,
        extractionStatus: "text_extracted",
        textExcerpt,
        extractedTerms,
        sha256,
        contentRef: `jira-attachment:${attachment.id}:sha256:${sha256.slice(0, 12)}`,
      };
    } catch {
      return {
        ...base,
        extractionStatus: "failed",
      };
    }
  }

  return {
    ...base,
    extractionStatus: "metadata_only",
  };
}

function dedupeIdentifiers(
  identifiers: InvestigationTicketIdentifierContext[],
): InvestigationTicketIdentifierContext[] {
  const seen = new Set<string>();
  const deduped: InvestigationTicketIdentifierContext[] = [];
  const sourcePriority: Record<InvestigationTicketIdentifierContext["source"], number> = {
    description: 3,
    comment: 2,
    attachment: 1,
  };
  const ranked = identifiers
    .map((identifier, index) => ({ identifier, index }))
    .sort((left, right) => {
      const score = (entry: InvestigationTicketIdentifierContext): number => {
        const composite = /[\/-]/.test(entry.value) ? 40 : 0;
        const plausibleExternalId = /^\d{6,15}$/.test(entry.value) ? 20 : 0;
        const oversizedPenalty = entry.value.length > 18 ? 20 : 0;
        return sourcePriority[entry.source] * 100 + composite + plausibleExternalId - oversizedPenalty;
      };
      return score(right.identifier) - score(left.identifier) || left.index - right.index;
    });
  for (const { identifier } of ranked) {
    const key = `${identifier.kind}:${identifier.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(identifier);
    if (deduped.length >= MAX_SENSITIVE_IDENTIFIERS) {
      break;
    }
  }
  return deduped;
}

export function deriveTicketTimeWindow(context?: InvestigationTicketContext | null): InvestigationTimeWindow | undefined {
  if (!context || context.fetchStatus !== "fetched") {
    return undefined;
  }
  if (context.timeWindow) {
    return context.timeWindow;
  }
  const text = buildCombinedText(context);
  const incidentDateText = text.match(/\b(?:incident|issue|failure|failed|occurred|observed|reported|production)\b[^\n]{0,60}\b((?:20\d{2}[-/]\d{1,2}[-/]\d{1,2})|(?:\d{1,2}\/\d{1,2}\/20\d{2}))\b/i)?.[1] || "";
  const explicitDate = incidentDateText.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/) || incidentDateText.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  const candidates: Date[] = [];
  const addCandidate = (candidate: Date | string | undefined) => {
    if (!candidate) return;
    const date = candidate instanceof Date ? candidate : new Date(candidate);
    if (!Number.isNaN(date.getTime())) candidates.push(date);
  };
  if (explicitDate) {
    addCandidate(explicitDate[1]?.length === 4
      ? new Date(Date.UTC(Number(explicitDate[1]), Number(explicitDate[2]) - 1, Number(explicitDate[3])))
      : new Date(Date.UTC(Number(explicitDate[3]), Number(explicitDate[1]) - 1, Number(explicitDate[2]))));
  }
  addCandidate(context.createdAt);
  addCandidate(context.updatedAt);
  for (const comment of context.comments || []) {
    addCandidate(comment.created);
    addCandidate(comment.updated);
  }
  for (const attachment of context.attachments || []) {
    addCandidate(attachment.created);
    for (const match of attachment.filename.matchAll(/(?:^|\D)(20\d{2})(\d{2})(\d{2})(?:\D|$)/g)) {
      addCandidate(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
    }
  }

  const relativeLine = text.split(/\r?\n/).find((line) => /\byesterday\b/i.test(line));
  const relativeTime = relativeLine?.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(PST|PDT|MST|MDT|CST|CDT|EST|EDT|UTC|GMT)\b/i,
  );
  const timezoneOffsets: Record<string, number> = {
    PST: -8 * 60,
    PDT: -7 * 60,
    MST: -7 * 60,
    MDT: -6 * 60,
    CST: -6 * 60,
    CDT: -5 * 60,
    EST: -5 * 60,
    EDT: -4 * 60,
    UTC: 0,
    GMT: 0,
  };
  let relativeStart: Date | undefined;
  if (relativeTime) {
    const anchor = new Date(context.createdAt || context.updatedAt || "");
    const zone = (relativeTime[4] || "UTC").toUpperCase();
    const offsetMinutes = timezoneOffsets[zone];
    let hour = Number(relativeTime[1]);
    const minute = Number(relativeTime[2] || "0");
    const meridiem = relativeTime[3]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (!Number.isNaN(anchor.getTime()) && offsetMinutes !== undefined && hour <= 23 && minute <= 59) {
      const localAnchor = new Date(anchor.getTime() + offsetMinutes * 60_000);
      relativeStart = new Date(
        Date.UTC(
          localAnchor.getUTCFullYear(),
          localAnchor.getUTCMonth(),
          localAnchor.getUTCDate() - 1,
          hour,
          minute,
        ) - offsetMinutes * 60_000,
      );
    }
  }

  if (candidates.length === 0 && !relativeStart) {
    return undefined;
  }
  candidates.sort((left, right) => left.getTime() - right.getTime());
  const earliest = relativeStart || candidates[0];
  const latest = candidates[candidates.length - 1] || relativeStart;
  const dayMs = 24 * 60 * 60 * 1000;
  let start = relativeStart || new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), earliest.getUTCDate()));
  const end = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth(), latest.getUTCDate()) + (2 * dayMs));
  if (end.getTime() - start.getTime() > 14 * dayMs) {
    start = new Date(end.getTime() - 14 * dayMs);
  }
  return {
    startTs: start.toISOString(),
    endTs: end.toISOString(),
  };
}

export function augmentInvestigationTicketContext(
  context: InvestigationTicketContext | undefined,
  operatorHint: string | undefined,
): InvestigationTicketContext | undefined {
  if (!context || context.fetchStatus !== "fetched" || !operatorHint?.trim()) {
    return context;
  }
  const safeHint = boundedText(redactTicketContextText(operatorHint), 4_000);
  const transientContext: InvestigationTicketContext = {
    ...context,
    timeWindow: undefined,
    comments: [{
      id: "operator-hint",
      created: context.updatedAt || context.createdAt,
      body: safeHint,
    }],
  };
  const hintTerms = extractInvestigationTermsFromTicketContext({
    title: context.title,
    environmentName: context.environmentName,
    labels: context.labels,
    description: safeHint,
    comments: [],
    attachments: [],
  });
  return {
    ...context,
    extractedTerms: Array.from(new Set([...hintTerms, ...(context.extractedTerms || [])])).slice(0, 24),
    timeWindow: deriveTicketTimeWindow(transientContext),
  };
}

export async function fetchInvestigationJiraContext(jiraKey: string): Promise<InvestigationTicketContext | undefined> {
  const normalizedJiraKey = assertValidJiraKey(jiraKey);
  if (!isInvestigationJiraContextConfigured()) {
    return {
      source: "jira",
      jiraKey: normalizedJiraKey,
      fetchStatus: "unavailable",
      failureReason: `Jira ticket context is not configured: ${missingJiraContextEnv().join(", ")} missing`,
    };
  }

  try {
    const client = createJiraClient({
      baseUrl: envValue("JIRA_BASE_URL") || "",
      username: envValue("JIRA_USERNAME") || "",
      token: envValue("JIRA_TOKEN") || "",
      downloadImages: false,
      maxAttachmentBytes: numericEnv("INVESTIGATION_JIRA_ATTACHMENT_MAX_BYTES", DEFAULT_ATTACHMENT_DOWNLOAD_LIMIT),
      maxImageBytes: 1,
    });
    const [environmentFieldIds, releaseFieldIds] = await Promise.all([
      resolveJiraEnvironmentFieldIds(client),
      resolveJiraReleaseFieldIds(client),
    ]);
    const [issue, comments] = await Promise.all([
      client.fetchIssue(normalizedJiraKey, uniqueStrings([...environmentFieldIds, ...releaseFieldIds])),
      client.fetchAllComments(normalizedJiraKey),
    ]);
    const rawDescription = adfToMarkdown(issue.fields.description);
    const environmentName = await issueEnvironmentName(issue, environmentFieldIds);
    const releaseVersion = issueReleaseVersion(issue, releaseFieldIds);
    const labels = (issue.fields.labels || [])
      .slice(0, MAX_LABELS)
      .map((label) => boundedText(String(label), 200))
      .filter(Boolean);
    const rawComments = comments.slice(0, MAX_COMMENTS).map((comment) => ({
      comment,
      rawBody: adfToMarkdown(comment.body),
    }));
    const attachmentIdentifiers: InvestigationTicketIdentifierContext[] = [];
    const attachments = await Promise.all(
      (issue.fields.attachment || [])
        .slice(0, MAX_ATTACHMENTS)
        .map((attachment) => mapAttachment(attachment, attachmentIdentifiers)),
    );
    const extractedTerms = extractInvestigationTermsFromTicketContext({
      title: boundedText(issue.fields.summary || "", 1_000),
      environmentName,
      labels,
      description: rawDescription,
      comments: rawComments.map(({ comment, rawBody }) => ({
        id: comment.id,
        created: comment.created,
        updated: comment.updated,
        body: rawBody,
      })),
      attachments,
    });
    const context: InvestigationTicketContext = {
      source: "jira",
      jiraKey: normalizedJiraKey,
      fetchStatus: "fetched",
      title: boundedText(issue.fields.summary || "", 1_000),
      statusName: boundedText(issue.fields.status?.name || "Unknown", 200),
      ...(environmentName ? { environmentName } : {}),
      ...(releaseVersion ? { releaseVersion } : {}),
      createdAt: issue.fields.created,
      updatedAt: issue.fields.updated,
      labels,
      descriptionPresent: Boolean(rawDescription.trim()),
      commentCount: rawComments.length,
      attachments,
      extractedTerms,
    };
    context.timeWindow = deriveTicketTimeWindow({
      ...context,
      description: rawDescription,
      comments: rawComments.map(({ comment, rawBody }) => ({
        id: comment.id,
        created: comment.created,
        updated: comment.updated,
        body: rawBody,
      })),
    });
    context.identifiers = dedupeIdentifiers([
      ...extractTicketIdentifiersFromTicketText(rawDescription, "description"),
      ...rawComments.flatMap(({ rawBody }) => extractTicketIdentifiersFromTicketText(rawBody, "comment")),
      ...attachmentIdentifiers,
    ]);
    context.evidenceAnchors = context.identifiers.map((identifier) => ({
      kind: identifier.kind,
      source: identifier.source,
      value: identifier.value,
      label: identifier.kind === "member_identifier" ? "member identifier" : "case number",
      sensitive: true,
    }));
    return context;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      source: "jira",
      jiraKey: normalizedJiraKey,
      fetchStatus: "unavailable",
      failureReason: boundedText(message, 1_000),
    };
  }
}
