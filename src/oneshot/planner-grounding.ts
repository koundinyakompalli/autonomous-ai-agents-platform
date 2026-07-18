import * as fs from "fs/promises";
import type { Dirent } from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type {
  OneShotFileChangeContractEntry,
  OneShotPlan,
} from "./schema/plan.js";
import type { OneShotModelUsage } from "./model-usage.js";
import type { RepoRouteCard } from "./repo-route-cards.js";
import type { RepoScanResult } from "./repo-scanner.js";
import type { TicketEvidenceV1 } from "./ticket-evidence.js";
import { getRepoRouteCardMatches } from "./repo-route-cards.js";

const execFileAsync = promisify(execFile);
const MAX_FILES = 10_000;
const MAX_TERMS = 18;
const MAX_CANDIDATE_FILES = 24;
const MAX_SNIPPETS = 30;
const MAX_SNIPPETS_PER_TERM = 10;
const MAX_SNIPPET_TEXT = 260;
const SEARCH_TIMEOUT_MS = 8_000;
const FILE_LIST_TIMEOUT_MS = 12_000;

type GroundingConfidence = "strong" | "medium" | "weak";
type GroundingTermKind = "identifier" | "phrase" | "word";

export interface PlannerGroundingTerm {
  value: string;
  kind: GroundingTermKind;
  weight: number;
}

export interface PlannerGroundingRouteCard {
  id: string;
  title: string;
  entrypointHints: string[];
}

export interface PlannerGroundingCandidateFile {
  path: string;
  score: number;
  reasons: string[];
  matchedTerms: string[];
  exists: boolean;
}

export interface PlannerGroundingSnippet {
  file: string;
  line: number;
  term: string;
  text: string;
}

export interface PlannerGroundingSourceTestPair {
  sourceFile: string;
  testFiles: string[];
}

export interface PlannerTicketExplicitNewSourceCandidate {
  className: string;
  fileName: string;
  packageName?: string;
  path?: string;
  sources: string[];
  evidenceText: string;
}

export interface PlannerGroundingFrontendFeatureCandidate {
  label: string;
  slug: string;
  sources: string[];
  apiIntent: boolean;
}

export interface PlannerGroundingQualificationEvidence {
  strong: boolean;
  trusted: boolean;
  verifiedInspectedFiles: string[];
  inspectionSummary?: string;
  reasons: string[];
}

export interface PlannerGroundingQualificationInput {
  qualified?: boolean;
  acceptanceCriteriaPresent?: boolean;
  blockingReasons?: string[];
  repoInspectionPerformed?: boolean;
  inspectedFiles?: string[];
  inspectionSummary?: string;
}

export interface PlannerScoutEvidenceReport {
  workItemId: string;
  objective: string;
  status: "valid" | "failed" | "ignored";
  inspectedFiles: string[];
  verifiedInspectedFiles: string[];
  snippets: PlannerGroundingSnippet[];
  symbols: string[];
  testFiles: string[];
  commands: string[];
  templateMappings?: Array<{
    targetPattern: string;
    templateFile: string;
    rationale: string;
  }>;
  confidence: GroundingConfidence;
  summary?: string;
  blockers: string[];
  failureReason?: string;
  toolCalls: number;
  durationMs: number;
  tokensUsed?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  costUsd?: number;
  costUsdExact?: boolean;
  modelUsed?: string;
  modelUsage?: OneShotModelUsage;
  invocationFailed?: boolean;
}

export interface PlannerScoutCoverage {
  requirementCount: number;
  evidenceBackedRequirementCount: number;
  uncoveredRequirementCount: number;
}

export interface PlannerEvidenceContext {
  generatedAt: string;
  jiraKey: string;
  repoName: string;
  confidence: GroundingConfidence;
  scoutStatus:
    | "scouts_disabled"
    | "scouts_skipped_strong_qualifier"
    | "scouts_skipped_strong_grounding"
    | "scouts_no_work_items"
    | "scouts_no_requirements"
    | "scouts_error"
    | "scouts_all_failed"
    | "scouts_partial_success"
    | "scouts_supported_plan";
  qualificationEvidence?: PlannerGroundingQualificationEvidence;
  grounding?: PlannerGroundingContext;
  scoutReports: PlannerScoutEvidenceReport[];
  scoutCoverage?: PlannerScoutCoverage;
  scoutInvocationFailed: boolean;
  scoutReturnedNothing: boolean;
  failedScoutCount: number;
  warnings: string[];
}

export interface PlannerGroundingContext {
  generatedAt: string;
  jiraKey: string;
  repoName: string;
  confidence: GroundingConfidence;
  terms: PlannerGroundingTerm[];
  routeCards: PlannerGroundingRouteCard[];
  candidateFiles: PlannerGroundingCandidateFile[];
  snippets: PlannerGroundingSnippet[];
  sourceTestPairs: PlannerGroundingSourceTestPair[];
  ticketExplicitNewSourceCandidates?: PlannerTicketExplicitNewSourceCandidate[];
  frontendFeatureCandidates?: PlannerGroundingFrontendFeatureCandidate[];
  qualificationEvidence?: PlannerGroundingQualificationEvidence;
  buildCommand?: string;
  testCommand?: string;
  testPattern?: string;
  riskFiles: string[];
  warnings: string[];
}

export interface PlannerGroundingValidationOptions {
  finalPlannerReadFiles?: string[];
  finalPlannerDiscoveredFiles?: string[];
  allowAdjacentTestWithRationale?: boolean;
  recoveredSourceRationaleFiles?: string[];
}

export type PlannerTargetValidationKind =
  | "exact_evidence"
  | "adjacent_source_or_mapping"
  | "adjacent_source_accepted_soft"
  | "adjacent_style_asset"
  | "adjacent_ui_asset"
  | "flyway_migration"
  | "adjacent_test"
  | "adjacent_colocated_test"
  | "adjacent_test_accepted_soft"
  | "adjacent_test_scenario_soft"
  | "same_package_java_test_accepted_soft"
  | "adjacent_test_fixture"
  | "ticket_explicit_new_source"
  | "source_rationale_recovery_candidate"
  | "source_accepted_via_rationale_recovery"
  | "source_recovery_rejected"
  | "ticket_template_backed_new_ui_target"
  | "ticket_template_backed_new_api_target"
  | "rejected";

export type PlannerTargetValidationEvidenceSource =
  | "file_change_contract_evidence"
  | "target_file_rationale_evidence"
  | "missing_file_change_contract_evidence"
  | "contract_marks_target_non_editable";

export interface PlannerTargetValidationDecision {
  rawTargetFile: string;
  targetFile: string;
  kind: PlannerTargetValidationKind;
  ok: boolean;
  reason?: string;
  supportingFiles?: string[];
  recoveryCandidateFiles?: string[];
  rationaleRequired?: boolean;
  rationalePresent?: boolean;
  evidenceSource?: PlannerTargetValidationEvidenceSource;
}

export interface PlannerGroundingValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  decisions: PlannerTargetValidationDecision[];
}

export class PlannerGroundingValidationError extends Error {
  constructor(
    public readonly errors: string[],
    public readonly diagnostics?: PlannerGroundingValidationResult,
  ) {
    super(
      `Planner target files are not backed by deterministic grounding: ${errors.join("; ")}`,
    );
    this.name = "PlannerGroundingValidationError";
  }
}

export interface BuildPlannerGroundingRequest {
  workspacePath: string;
  repoName: string;
  jiraKey: string;
  ticketSummary: string;
  taskDescription: string;
  qualificationSummary?: {
    qualified?: boolean;
    requirementsSummary?: string[];
    acceptanceCriteriaPresent?: boolean;
    blockingReasons?: string[];
    nonBlockingWarnings?: string[];
    repoInspectionPerformed?: boolean;
    inspectedFiles?: string[];
    inspectionSummary?: string;
  };
  repoScan?: RepoScanResult | null;
  routeCardContext?: string;
  ticketEvidence?: TicketEvidenceV1 | null;
}

interface MutableCandidate {
  path: string;
  score: number;
  reasons: Set<string>;
  matchedTerms: Set<string>;
  exists: boolean;
}

interface SearchMatch {
  file: string;
  line: number;
  text: string;
  term: string;
}

const EXCLUDED_PATH_PARTS = [
  ".git",
  ".claude",
  "node_modules",
  "target",
  "build",
  "dist",
  "coverage",
  ".next",
];

const STOP_WORDS = new Set([
  "about",
  "above",
  "active",
  "after",
  "against",
  "also",
  "and",
  "before",
  "branch",
  "change",
  "code",
  "default",
  "does",
  "existing",
  "from",
  "have",
  "into",
  "keep",
  "local",
  "need",
  "only",
  "repo",
  "repository",
  "root",
  "runnable",
  "should",
  "stage",
  "test",
  "that",
  "the",
  "this",
  "true",
  "with",
]);

const LOW_SIGNAL_GROUNDING_TERMS = new Set([
  "acceptance",
  "active",
  "apis",
  "backlog",
  "business",
  "case",
  "cases",
  "compliance",
  "cpdev",
  "criteria",
  "current",
  "currently",
  "duration",
  "edit",
  "epic",
  "establish",
  "full",
  "future",
  "implementation",
  "platform",
  "solution",
  "solutions",
  "system",
  "task",
  "tasks",
  "user",
  "users",
]);

const FRONTEND_FEATURE_STOP_WORDS = new Set([
  "a",
  "add",
  "admin",
  "as",
  "based",
  "component",
  "components",
  "create",
  "display",
  "feature",
  "features",
  "functionality",
  "implement",
  "integration",
  "interface",
  "menu",
  "module",
  "modules",
  "new",
  "of",
  "on",
  "page",
  "pages",
  "react",
  "screen",
  "smartprominence",
  "tab",
  "tabs",
  "the",
  "to",
  "ui",
  "update",
  "updated",
  "using",
  "view",
]);

interface PlannerGroundingTextSection {
  source: string;
  text: string;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function featureWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => word.length > 1)
    .filter((word) => !FRONTEND_FEATURE_STOP_WORDS.has(word));
}

function slugForFrontendFeature(value: string): string | undefined {
  const words = featureWords(value);
  if (words.length < 2) {
    return undefined;
  }
  const slug = words.slice(0, 4).join("-");
  return slug.length >= 5 ? slug : undefined;
}

function labelForFrontendFeature(value: string): string | undefined {
  const words = featureWords(value);
  if (words.length < 2) {
    return undefined;
  }
  return words
    .slice(0, 4)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function hasFrontendApiIntent(text: string): boolean {
  if (
    /\b(api|backend|endpoint|configuration|config|configured|uniqueness|unique|metadata|processing|mutation|query|rtk|store|multipart|formdata|extraction)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  return (
    /\bupload(?:s|ed|ing)?\b/i.test(text) &&
    /\b(file|files|document|documents|metadata|backend|process|processing|config|configuration|validate|validation|duplicate|unique|size|type|types)\b/i.test(
      text,
    )
  );
}

function addFrontendFeatureCandidate(
  candidates: Map<string, PlannerGroundingFrontendFeatureCandidate>,
  rawLabel: string,
  source: string,
  apiIntent: boolean,
): void {
  const slug = slugForFrontendFeature(rawLabel);
  const label = labelForFrontendFeature(rawLabel);
  if (!slug || !label) {
    return;
  }
  const existing = candidates.get(slug);
  if (existing) {
    existing.apiIntent = existing.apiIntent || apiIntent;
    existing.sources = unique([...existing.sources, source]);
    return;
  }
  candidates.set(slug, {
    label,
    slug,
    sources: [source],
    apiIntent,
  });
}

function extractFrontendFeatureCandidates(
  sections: PlannerGroundingTextSection[],
): PlannerGroundingFrontendFeatureCandidate[] {
  const candidates = new Map<string, PlannerGroundingFrontendFeatureCandidate>();

  for (const section of sections) {
    const text = section.text;
    const apiIntent = hasFrontendApiIntent(text);
    const quotedPhrases = text.match(/["'`](.{3,80}?)["'`]/g) ?? [];
    for (const phrase of quotedPhrases) {
      addFrontendFeatureCandidate(
        candidates,
        phrase.replace(/^["'`]|["'`]$/g, ""),
        section.source,
        apiIntent,
      );
    }

    const titleCasePhrases =
      text.match(/\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*){1,5}\b/g) ??
      [];
    for (const phrase of titleCasePhrases) {
      addFrontendFeatureCandidate(candidates, phrase, section.source, apiIntent);
    }

    const featureContextPattern =
      /\b([A-Za-z][A-Za-z0-9]*(?:\s+[A-Za-z][A-Za-z0-9]*){0,5})\s+(?:UI|interface|screen|page|pages|tab|tabs|functionality|module|feature)\b/gi;
    let contextMatch: RegExpExecArray | null;
    while ((contextMatch = featureContextPattern.exec(text)) !== null) {
      addFrontendFeatureCandidate(
        candidates,
        contextMatch[1],
        section.source,
        apiIntent,
      );
    }

    const repoPathPattern = /\bsrc\/(?:[a-z0-9_.-]+\/)*([a-z][a-z0-9-]+)\b/gi;
    let pathMatch: RegExpExecArray | null;
    while ((pathMatch = repoPathPattern.exec(text)) !== null) {
      addFrontendFeatureCandidate(
        candidates,
        pathMatch[1],
        section.source,
        apiIntent,
      );
    }
  }

  return Array.from(candidates.values()).sort((left, right) =>
    left.slug.localeCompare(right.slug),
  );
}

function featureCandidateText(
  candidate: PlannerGroundingFrontendFeatureCandidate,
): string[] {
  return unique([candidate.label, candidate.slug, ...featureWords(candidate.label)]);
}

function isExcludedPath(filePath: string): boolean {
  const parts = normalizePath(filePath).split("/");
  return parts.some((part) => EXCLUDED_PATH_PARTS.includes(part));
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function isSafeWorkspaceRelativePath(filePath: string): boolean {
  const normalizedPath = normalizePath(filePath);
  return (
    Boolean(normalizedPath) &&
    !normalizedPath.split("/").some((part) => part === "..")
  );
}

function scoreTerm(term: PlannerGroundingTerm): number {
  if (term.kind === "identifier") {
    return 8;
  }
  if (term.kind === "phrase") {
    return 6;
  }
  return Math.max(2, Math.min(5, term.value.length - 2));
}

function isHighSignalGroundingTerm(value: string): boolean {
  const normalized = normalizeForMatch(value);
  if (normalized.length < 5) {
    return false;
  }
  if (/^[a-z]+dev$/.test(normalized) || /^cp[a-z]*\d*$/.test(normalized)) {
    return false;
  }
  return !LOW_SIGNAL_GROUNDING_TERMS.has(normalized);
}

function hasHighSignalSnippet(snippets: PlannerGroundingSnippet[]): boolean {
  return snippets.some((snippet) => isHighSignalGroundingTerm(snippet.term));
}

function hasHighSignalContentCandidate(
  candidates: PlannerGroundingCandidateFile[],
): boolean {
  return candidates.some(
    (candidate) =>
      candidate.reasons.includes("content match") &&
      candidate.matchedTerms.some((term) => isHighSignalGroundingTerm(term)),
  );
}

function addTerm(
  terms: Map<string, PlannerGroundingTerm>,
  value: string,
  kind: GroundingTermKind,
  weight: number,
): void {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (cleaned.length < 3) {
    return;
  }
  const key = cleaned.toLowerCase();
  const existing = terms.get(key);
  if (!existing || existing.weight < weight) {
    terms.set(key, { value: cleaned, kind, weight });
  }
}

export function extractPlannerGroundingTerms(
  text: string,
): PlannerGroundingTerm[] {
  const terms = new Map<string, PlannerGroundingTerm>();
  const identifiers = text.match(/\b[A-Z][A-Za-z0-9_]{3,}\b/g) ?? [];
  for (const identifier of identifiers) {
    addTerm(terms, identifier, "identifier", 10);
  }

  const normalizedWords = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));

  for (const word of normalizedWords) {
    addTerm(terms, word, "word", 3);
  }

  for (let index = 0; index < normalizedWords.length - 1; index++) {
    const first = normalizedWords[index];
    const second = normalizedWords[index + 1];
    if (first.length >= 4 || second.length >= 4) {
      addTerm(terms, `${first} ${second}`, "phrase", 7);
    }
  }

  return Array.from(terms.values())
    .sort(
      (left, right) =>
        right.weight - left.weight || left.value.localeCompare(right.value),
    )
    .slice(0, MAX_TERMS);
}

interface TicketEvidenceTextSection {
  source: string;
  text: string;
}

function ticketEvidenceSections(
  request: Pick<
    BuildPlannerGroundingRequest,
    "ticketSummary" | "taskDescription" | "qualificationSummary" | "ticketEvidence"
  >,
): TicketEvidenceTextSection[] {
  const sections: TicketEvidenceTextSection[] = [];
  const addSection = (source: string, text: string | undefined): void => {
    const trimmed = text?.trim();
    if (trimmed) {
      sections.push({ source, text: trimmed });
    }
  };

  if (request.ticketEvidence) {
    addSection("ticket_summary", request.ticketEvidence.issue.summary);
    addSection("ticket_description", request.ticketEvidence.descriptionMarkdown);
    for (const comment of request.ticketEvidence.comments) {
      addSection(`ticket_comment:${comment.id}`, comment.bodyMarkdown);
    }
    for (const attachment of request.ticketEvidence.attachments) {
      addSection(
        `ticket_attachment:${attachment.filename}`,
        attachment.extractedText,
      );
    }
    return sections;
  }

  addSection("ticket_summary", request.ticketSummary);
  addSection("task_description", request.taskDescription);
  for (const requirement of request.qualificationSummary?.requirementsSummary ??
    []) {
    addSection("qualification_requirement", requirement);
  }
  return sections;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function javaPathToPackage(filePath: string): string | undefined {
  const normalized = normalizePath(filePath);
  const parts = path.posix.dirname(normalized).split("/").filter(Boolean);
  const srcIndex = parts.findIndex(
    (part, index) =>
      part === "src" &&
      parts[index + 1] === "main" &&
      parts[index + 2] === "java",
  );
  if (srcIndex < 0 || parts.length <= srcIndex + 3) {
    return undefined;
  }
  return parts.slice(srcIndex + 3).join(".");
}

function addTicketExplicitCandidate(
  candidates: Map<string, PlannerTicketExplicitNewSourceCandidate>,
  input: {
    className: string;
    source: string;
    evidenceText: string;
    packageName?: string;
    path?: string;
  },
): void {
  const className = input.className.trim();
  if (!/^[A-Z][A-Za-z0-9_]*$/.test(className)) {
    return;
  }
  const normalizedPath = input.path ? normalizePath(input.path) : undefined;
  if (normalizedPath && !isSafePlanTargetPath(normalizedPath)) {
    return;
  }
  const packageName = input.packageName?.trim();
  const key = [
    className,
    packageName ?? "",
    normalizedPath ?? "",
  ].join("|");
  const existing = candidates.get(key);
  if (existing) {
    existing.sources = uniqueStrings([...existing.sources, input.source]);
    return;
  }
  candidates.set(key, {
    className,
    fileName: `${className}.java`,
    ...(packageName ? { packageName } : {}),
    ...(normalizedPath ? { path: normalizedPath } : {}),
    sources: [input.source],
    evidenceText: input.evidenceText.trim().slice(0, 700),
  });
}

function extractTicketExplicitNewSourceCandidates(
  request: Pick<
    BuildPlannerGroundingRequest,
    "ticketSummary" | "taskDescription" | "qualificationSummary" | "ticketEvidence"
  >,
): PlannerTicketExplicitNewSourceCandidate[] {
  const candidates = new Map<string, PlannerTicketExplicitNewSourceCandidate>();
  const javaPathPattern =
    /(?:^|[\s`"'(:])((?:[A-Za-z0-9_.-]+\/)*src\/main\/java\/[A-Za-z0-9_./-]+\.java)\b/g;
  const fileNamePattern = /\b([A-Z][A-Za-z0-9_]*)\.java\b/g;
  const classDeclarationPattern =
    /\b(?:class|interface|enum|record)\s+([A-Z][A-Za-z0-9_]*)\b/g;
  const packagePattern =
    /\bpackage\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\b/g;

  for (const section of ticketEvidenceSections(request)) {
    const packages = uniqueStrings(
      Array.from(section.text.matchAll(packagePattern)).map(
        (match) => match[1],
      ),
    );
    for (const match of section.text.matchAll(javaPathPattern)) {
      const normalizedPath = normalizePath(match[1]);
      const className = path.posix.basename(normalizedPath, ".java");
      addTicketExplicitCandidate(candidates, {
        className,
        source: section.source,
        evidenceText: section.text,
        packageName: javaPathToPackage(normalizedPath),
        path: normalizedPath,
      });
    }
    for (const match of section.text.matchAll(fileNamePattern)) {
      addTicketExplicitCandidate(candidates, {
        className: match[1],
        source: section.source,
        evidenceText: section.text,
        ...(packages.length === 1 ? { packageName: packages[0] } : {}),
      });
    }
    for (const match of section.text.matchAll(classDeclarationPattern)) {
      addTicketExplicitCandidate(candidates, {
        className: match[1],
        source: section.source,
        evidenceText: section.text,
        ...(packages.length === 1 ? { packageName: packages[0] } : {}),
      });
    }
  }

  return Array.from(candidates.values()).sort(
    (left, right) =>
      left.className.localeCompare(right.className) ||
      (left.packageName ?? "").localeCompare(right.packageName ?? "") ||
      (left.path ?? "").localeCompare(right.path ?? ""),
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(
  dirPath: string,
  workspacePath: string,
  files: string[],
): Promise<void> {
  if (files.length >= MAX_FILES) {
    return;
  }

  let entries: Dirent[];
  try {
    entries = (await fs.readdir(dirPath, {
      withFileTypes: true,
    })) as unknown as Dirent[];
  } catch {
    return;
  }

  for (const entry of entries) {
    if (files.length >= MAX_FILES) {
      return;
    }
    const entryName = entry.name as unknown as string;
    const absolutePath = path.join(dirPath, entryName);
    const relativePath = normalizePath(
      path.relative(workspacePath, absolutePath),
    );
    if (isExcludedPath(relativePath)) {
      continue;
    }
    if (entry.isDirectory()) {
      await walkFiles(absolutePath, workspacePath, files);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
}

async function listRepoFiles(workspacePath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "--files",
        "--glob",
        "!**/.git/**",
        "--glob",
        "!**/.claude/**",
        "--glob",
        "!**/node_modules/**",
        "--glob",
        "!**/target/**",
        "--glob",
        "!**/build/**",
        "--glob",
        "!**/dist/**",
        "--glob",
        "!**/coverage/**",
      ],
      {
        cwd: workspacePath,
        timeout: FILE_LIST_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return stdout
      .split("\n")
      .map((line) => normalizePath(line.trim()))
      .filter(Boolean)
      .filter((file) => !isExcludedPath(file))
      .slice(0, MAX_FILES);
  } catch {
    const files: string[] = [];
    await walkFiles(workspacePath, workspacePath, files);
    return files.slice(0, MAX_FILES);
  }
}

async function searchTerm(
  workspacePath: string,
  term: PlannerGroundingTerm,
): Promise<SearchMatch[]> {
  try {
    const { stdout } = await execFileAsync(
      "rg",
      [
        "--line-number",
        "--ignore-case",
        "--fixed-strings",
        "--glob",
        "!**/.git/**",
        "--glob",
        "!**/.claude/**",
        "--glob",
        "!**/node_modules/**",
        "--glob",
        "!**/target/**",
        "--glob",
        "!**/build/**",
        "--glob",
        "!**/dist/**",
        term.value,
        ".",
      ],
      {
        cwd: workspacePath,
        timeout: SEARCH_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
    );

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line): SearchMatch | null => {
        const firstColon = line.indexOf(":");
        if (firstColon < 0) {
          return null;
        }
        const secondColon = line.indexOf(":", firstColon + 1);
        if (secondColon < 0) {
          return null;
        }
        const file = normalizePath(line.slice(0, firstColon));
        const parsedLine = Number(line.slice(firstColon + 1, secondColon));
        if (!file || !Number.isFinite(parsedLine) || isExcludedPath(file)) {
          return null;
        }
        return {
          file,
          line: parsedLine,
          term: term.value,
          text: line
            .slice(secondColon + 1)
            .trim()
            .slice(0, MAX_SNIPPET_TEXT),
        };
      })
      .filter((match): match is SearchMatch => Boolean(match))
      .slice(0, MAX_SNIPPETS_PER_TERM);
  } catch (error) {
    // rg exits non-zero when no matches are found (code 1) and also when the
    // binary is missing (ENOENT). Production environments ship ripgrep; the
    // in-process fallback exists so tests and dev environments without rg
    // still produce content grounding. Bounded by MAX_FILES and
    // MAX_SNIPPETS_PER_TERM so cost stays predictable.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      return [];
    }
    return searchTermInProcess(workspacePath, term);
  }
}

async function searchTermInProcess(
  workspacePath: string,
  term: PlannerGroundingTerm,
): Promise<SearchMatch[]> {
  const files = await listRepoFiles(workspacePath);
  const needle = term.value.toLowerCase();
  if (!needle) {
    return [];
  }
  const matches: SearchMatch[] = [];
  for (const file of files) {
    if (matches.length >= MAX_SNIPPETS_PER_TERM) {
      break;
    }
    let content: string;
    try {
      content = await fs.readFile(path.join(workspacePath, file), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (matches.length >= MAX_SNIPPETS_PER_TERM) {
        break;
      }
      const line = lines[index];
      if (!line.toLowerCase().includes(needle)) {
        continue;
      }
      matches.push({
        file: normalizePath(file),
        line: index + 1,
        term: term.value,
        text: line.trim().slice(0, MAX_SNIPPET_TEXT),
      });
    }
  }
  return matches;
}

function getCoreAppPathBoost(
  filePath: string,
  terms: PlannerGroundingTerm[],
): number {
  const normalizedPath = normalizePath(filePath);
  const lowerPath = normalizedPath.toLowerCase();
  const normalizedTerms = terms.map((term) => term.value.toLowerCase());
  let boost = 0;

  if (lowerPath.startsWith("medicalmgmt/")) {
    boost += 5;
  }
  if (lowerPath.includes("/src/main/java/")) {
    boost += 3;
  }
  if (lowerPath.includes("/client/member/")) {
    boost += 4;
  }
  if (lowerPath.includes("/server/handlers/")) {
    boost += 3;
  }
  if (
    lowerPath.includes("/server/service/") ||
    lowerPath.includes("/server/bff/services/")
  ) {
    boost += 3;
  }
  if (lowerPath.includes("/src/test/")) {
    boost += 2;
  }
  if (
    normalizedTerms.some((term) =>
      ["style", "button", "theme", "css", "scss"].includes(term),
    ) &&
    (lowerPath.includes("/themes/") ||
      lowerPath.endsWith(".scss") ||
      lowerPath.endsWith(".css"))
  ) {
    boost += 5;
  }
  if (lowerPath.startsWith("docs/") || lowerPath.includes("/docs/")) {
    boost -= 3;
  }

  return boost;
}

function addCandidate(
  candidates: Map<string, MutableCandidate>,
  filePath: string,
  score: number,
  reason: string,
  matchedTerm?: string,
  exists = true,
): void {
  const normalizedPath = normalizePath(filePath);
  if (!normalizedPath || isExcludedPath(normalizedPath)) {
    return;
  }

  const current = candidates.get(normalizedPath) ?? {
    path: normalizedPath,
    score: 0,
    reasons: new Set<string>(),
    matchedTerms: new Set<string>(),
    exists,
  };
  current.score += score;
  current.exists = current.exists || exists;
  current.reasons.add(reason);
  if (matchedTerm) {
    current.matchedTerms.add(matchedTerm);
  }
  candidates.set(normalizedPath, current);
}

function routeCardSummaries(
  routeCards: RepoRouteCard[],
): PlannerGroundingRouteCard[] {
  return routeCards.map((card) => ({
    id: card.id,
    title: card.title,
    entrypointHints: card.entrypointHints ?? [],
  }));
}

function isRiskFile(filePath: string): boolean {
  const lowerPath = normalizePath(filePath).toLowerCase();
  return (
    lowerPath.endsWith("pom.xml") ||
    lowerPath.endsWith("skin_styles.css") ||
    lowerPath.endsWith("medhok.css") ||
    lowerPath.endsWith("medhok2.css") ||
    lowerPath.endsWith("medhok3.css") ||
    lowerPath.includes("/themes/") ||
    lowerPath.endsWith("transactionalworkspace.java") ||
    lowerPath.endsWith("/workspace.java")
  );
}

const GENERATED_OR_GLOBAL_STYLE_FILE_NAMES = new Set([
  "skin_styles.css",
  "medhok.css",
  "medhok2.css",
  "medhok3.css",
]);

function isStyleAssetPath(filePath: string): boolean {
  return [".scss", ".css"].includes(extensionOf(filePath));
}

const UI_ASSET_EXTENSIONS = new Set([
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
]);

const UI_ASSET_DIRECTORY_PARTS = new Set([
  "asset",
  "assets",
  "icon",
  "icons",
  "image",
  "images",
  "logo",
  "logos",
]);

function isUiAssetPath(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();
  if (!UI_ASSET_EXTENSIONS.has(extensionOf(normalized))) {
    return false;
  }
  return normalized
    .split("/")
    .some((part) => UI_ASSET_DIRECTORY_PARTS.has(part));
}

function isThemeSourceSassPath(filePath: string): boolean {
  return /\/themes\/[^/]+_source\/sass\//i.test(`/${normalizePath(filePath)}`);
}

function isGeneratedOrGlobalStyleFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  const lowerPath = normalized.toLowerCase();
  const baseName = path.posix.basename(lowerPath);
  if (GENERATED_OR_GLOBAL_STYLE_FILE_NAMES.has(baseName)) {
    return true;
  }

  if (!lowerPath.includes("/themes/")) {
    return false;
  }

  return lowerPath.includes("/template/") || !isThemeSourceSassPath(normalized);
}

function stem(filePath: string): string {
  return path
    .basename(filePath)
    .replace(/\.[^.]+$/, "")
    .replace(/test$/i, "")
    .replace(/spec$/i, "");
}

function isTestLikePath(filePath: string): boolean {
  const lowerPath = normalizePath(filePath).toLowerCase();
  return (
    lowerPath.includes("/src/test/") ||
    lowerPath.includes("/test/") ||
    lowerPath.includes("/tests/") ||
    lowerPath.includes("/__tests__/") ||
    /\.test\.[jt]sx?$/.test(lowerPath) ||
    /\.spec\.[jt]sx?$/.test(lowerPath) ||
    lowerPath.endsWith("test.java") ||
    lowerPath.endsWith("tests.java")
  );
}

function buildSourceTestPairs(
  candidates: PlannerGroundingCandidateFile[],
  allFiles: string[],
): PlannerGroundingSourceTestPair[] {
  const testFiles = allFiles.filter(isTestLikePath);
  const sourceFiles = candidates
    .map((candidate) => candidate.path)
    .filter((file) => !isTestLikePath(file))
    .slice(0, 12);

  return sourceFiles
    .map((sourceFile) => {
      const sourceStem = normalizeForMatch(stem(sourceFile));
      const tests = testFiles
        .filter((testFile) =>
          normalizeForMatch(stem(testFile)).includes(sourceStem),
        )
        .slice(0, 5);
      return { sourceFile, testFiles: tests };
    })
    .filter((pair) => pair.testFiles.length > 0)
    .slice(0, 8);
}

async function readJsonFile(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

async function resolveCommands(
  workspacePath: string,
  candidateFiles: PlannerGroundingCandidateFile[],
  allFiles: string[],
  repoScan?: RepoScanResult | null,
): Promise<{
  buildCommand?: string;
  testCommand?: string;
  testPattern?: string;
}> {
  const rootPackageJson = await readJsonFile(
    path.join(workspacePath, "package.json"),
  );
  if (rootPackageJson) {
    const scripts = (rootPackageJson.scripts ?? {}) as Record<string, unknown>;
    return {
      buildCommand:
        typeof scripts.build === "string" ? "npm run build" : undefined,
      testCommand: typeof scripts.test === "string" ? "npm test" : undefined,
      testPattern: allFiles.some(
        (file) => file.includes("__tests__") || /\.test\.[jt]sx?$/.test(file),
      )
        ? "JavaScript/TypeScript tests under __tests__ or *.test.* files."
        : undefined,
    };
  }

  const moduleWithPom = candidateFiles
    .map((candidate) => normalizePath(candidate.path).split("/")[0])
    .filter(Boolean)
    .find((moduleName) => allFiles.includes(`${moduleName}/pom.xml`));
  if (moduleWithPom) {
    return {
      buildCommand: `mvn -f ${moduleWithPom}/pom.xml -DskipTests compile`,
      testCommand: `mvn -f ${moduleWithPom}/pom.xml test`,
      testPattern: `${moduleWithPom}/src/test/java/**/*Test.java`,
    };
  }

  if (allFiles.includes("pom.xml")) {
    return {
      buildCommand: "mvn -DskipTests compile",
      testCommand: "mvn test",
      testPattern: "src/test/java/**/*Test.java",
    };
  }

  if (repoScan?.techStack.buildTool === "gradle") {
    return {
      buildCommand: "./gradlew build -x test",
      testCommand: "./gradlew test",
      testPattern: "src/test/**/*Test.*",
    };
  }

  return {};
}

function calculateConfidence(
  candidateFiles: PlannerGroundingCandidateFile[],
  snippets: PlannerGroundingSnippet[],
  routeCards: PlannerGroundingRouteCard[],
  qualificationEvidence?: PlannerGroundingQualificationEvidence,
): GroundingConfidence {
  if (
    (qualificationEvidence?.strong || qualificationEvidence?.trusted) &&
    qualificationEvidence.verifiedInspectedFiles.length > 0
  ) {
    return "strong";
  }
  if (candidateFiles.length >= 2 && snippets.length >= 2) {
    return "strong";
  }
  if (candidateFiles.length >= 1 && snippets.length >= 1) {
    return "strong";
  }
  if (candidateFiles.length >= 1 || routeCards.length >= 1) {
    return "medium";
  }
  return "weak";
}

export function isPlannerGroundingStrong(
  grounding?: PlannerGroundingContext,
): boolean {
  if (!grounding) {
    return false;
  }
  if (
    (grounding.qualificationEvidence?.strong ||
      grounding.qualificationEvidence?.trusted) &&
    grounding.qualificationEvidence.verifiedInspectedFiles.length > 0
  ) {
    return grounding.confidence === "strong";
  }
  return (
    grounding.confidence === "strong" &&
    grounding.candidateFiles.length > 0 &&
    hasHighSignalSnippet(grounding.snippets) &&
    hasHighSignalContentCandidate(grounding.candidateFiles)
  );
}

function validScoutReports(
  evidence?: PlannerEvidenceContext,
): PlannerScoutEvidenceReport[] {
  return (evidence?.scoutReports ?? []).filter(
    (report) =>
      report.status === "valid" && report.verifiedInspectedFiles.length > 0,
  );
}

function primaryScoutTargetFiles(report: PlannerScoutEvidenceReport): string[] {
  const testFiles = new Set(report.testFiles.map(normalizePath));
  const templateOnlyFiles = new Set(
    (report.templateMappings ?? []).map((mapping) =>
      normalizePath(mapping.templateFile),
    ),
  );

  return report.verifiedInspectedFiles
    .map(normalizePath)
    .filter((file) => {
      if (isTestLikePath(file) || testFiles.has(file)) {
        return false;
      }
      if (templateOnlyFiles.has(file)) {
        return false;
      }
      return true;
    });
}

function validPrimaryScoutReports(
  evidence?: PlannerEvidenceContext,
): PlannerScoutEvidenceReport[] {
  return validScoutReports(evidence).filter(
    (report) => primaryScoutTargetFiles(report).length > 0,
  );
}

export function isPlannerEvidenceStrong(
  evidence?: PlannerEvidenceContext,
): boolean {
  if (!evidence) {
    return false;
  }
  if (isPlannerGroundingStrong(evidence.grounding)) {
    return true;
  }
  return evidence.confidence === "strong" && validPrimaryScoutReports(evidence).length > 0;
}

export async function evaluateQualifierEvidence(
  qualification: PlannerGroundingQualificationInput | undefined,
  workspacePath: string,
  allFiles: string[] = [],
): Promise<PlannerGroundingQualificationEvidence | undefined> {
  if (!qualification) {
    return undefined;
  }

  const inspectionSummary = qualification.inspectionSummary?.trim();
  const reasons: string[] = [];
  const inspectedFiles = unique(
    (qualification.inspectedFiles ?? [])
      .map((file) => normalizePath(file))
      .filter(Boolean),
  );
  const safeInspectedFiles = inspectedFiles.filter(isSafeWorkspaceRelativePath);
  const verifiedInspectedFiles: string[] = [];

  for (const inspectedFile of safeInspectedFiles) {
    const listedFile = allFiles.find(
      (candidate) => normalizePath(candidate) === inspectedFile,
    );
    if (listedFile) {
      verifiedInspectedFiles.push(listedFile);
      continue;
    }
    if (await pathExists(path.join(workspacePath, inspectedFile))) {
      verifiedInspectedFiles.push(inspectedFile);
    }
  }

  if (qualification.qualified !== true) {
    reasons.push("qualification did not mark the ticket ready");
  }
  if (safeInspectedFiles.length !== inspectedFiles.length) {
    reasons.push("qualification inspected files contained unsafe paths");
  }
  if ((qualification.blockingReasons ?? []).length > 0) {
    reasons.push("qualification has blocking reasons");
  }
  if (qualification.acceptanceCriteriaPresent !== true) {
    reasons.push("qualification did not confirm acceptance criteria");
  }
  if (qualification.repoInspectionPerformed !== true) {
    reasons.push("qualification did not perform repository inspection");
  }
  if (!inspectionSummary) {
    reasons.push("qualification inspection summary is empty");
  }
  if (
    verifiedInspectedFiles.length === 0 &&
    (qualification.inspectedFiles ?? []).length > 0
  ) {
    reasons.push(
      "qualification inspected files were not found in the workspace",
    );
  }
  if ((qualification.inspectedFiles ?? []).length === 0) {
    reasons.push("qualification inspected files are empty");
  }

  const trusted = reasons.length === 0 && verifiedInspectedFiles.length > 0;
  return {
    strong: trusted,
    trusted,
    verifiedInspectedFiles: unique(verifiedInspectedFiles),
    ...(inspectionSummary ? { inspectionSummary } : {}),
    reasons,
  };
}

export async function buildPlannerGroundingContext(
  request: BuildPlannerGroundingRequest,
): Promise<PlannerGroundingContext> {
  const textSections: PlannerGroundingTextSection[] = [
    { source: "jira key", text: request.jiraKey },
    { source: "ticket summary", text: request.ticketSummary },
    { source: "task description", text: request.taskDescription },
    ...(request.qualificationSummary?.requirementsSummary ?? []).map(
      (text, index) => ({
        source: `qualification requirement ${index + 1}`,
        text,
      }),
    ),
    ...(request.qualificationSummary?.nonBlockingWarnings ?? []).map(
      (text, index) => ({
        source: `qualification warning ${index + 1}`,
        text,
      }),
    ),
  ].filter((section) => section.text.trim().length > 0);
  const taskText = [
    ...textSections.map((section) => section.text),
  ].join("\n");
  const frontendFeatureCandidates =
    extractFrontendFeatureCandidates(textSections);
  const terms = extractPlannerGroundingTerms(taskText);
  const routeCards = getRepoRouteCardMatches(request.repoName, taskText);
  const allFiles = await listRepoFiles(request.workspacePath);
  const ticketExplicitNewSourceCandidates =
    extractTicketExplicitNewSourceCandidates(request);
  const qualificationEvidence = await evaluateQualifierEvidence(
    request.qualificationSummary,
    request.workspacePath,
    allFiles,
  );
  const candidates = new Map<string, MutableCandidate>();
  const snippets: PlannerGroundingSnippet[] = [];

  for (const keyFile of request.repoScan?.keyFiles ?? []) {
    addCandidate(
      candidates,
      keyFile.path,
      2,
      `repo scan key file: ${keyFile.role}`,
    );
  }

  for (const inspectedFile of qualificationEvidence?.verifiedInspectedFiles ??
    []) {
    addCandidate(
      candidates,
      inspectedFile,
      60,
      "qualification inspected file",
      "qualification inspection",
      true,
    );
  }

  for (const card of routeCards) {
    for (const hint of card.entrypointHints ?? []) {
      const matchingFile = allFiles.find(
        (file) => normalizePath(file) === normalizePath(hint),
      );
      const exists =
        Boolean(matchingFile) ||
        (await pathExists(path.join(request.workspacePath, hint)));
      addCandidate(
        candidates,
        matchingFile ?? hint,
        14,
        `route card ${card.id}`,
        card.title,
        exists,
      );
    }
  }

  for (const term of terms) {
    const normalizedTerm = normalizeForMatch(term.value);
    if (normalizedTerm.length < 4) {
      continue;
    }
    for (const file of allFiles) {
      if (normalizeForMatch(file).includes(normalizedTerm)) {
        addCandidate(
          candidates,
          file,
          scoreTerm(term) +
            (request.repoName === "core-app"
              ? getCoreAppPathBoost(file, terms)
              : 0),
          "file path match",
          term.value,
        );
      }
    }
  }

  for (const term of terms.slice(0, 12)) {
    const matches = await searchTerm(request.workspacePath, term);
    for (const match of matches) {
      addCandidate(
        candidates,
        match.file,
        scoreTerm(term) +
          4 +
          (request.repoName === "core-app"
            ? getCoreAppPathBoost(match.file, terms)
            : 0),
        "content match",
        term.value,
      );
      if (snippets.length < MAX_SNIPPETS) {
        snippets.push({
          file: match.file,
          line: match.line,
          term: match.term,
          text: match.text,
        });
      }
    }
  }

  const candidateFiles = Array.from(candidates.values())
    .map((candidate) => ({
      path: candidate.path,
      score: candidate.score,
      reasons: Array.from(candidate.reasons).sort(),
      matchedTerms: Array.from(candidate.matchedTerms).sort(),
      exists: candidate.exists,
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.path.localeCompare(right.path),
    )
    .slice(0, MAX_CANDIDATE_FILES);

  const sourceTestPairs = buildSourceTestPairs(candidateFiles, allFiles);
  const commands = await resolveCommands(
    request.workspacePath,
    candidateFiles,
    allFiles,
    request.repoScan,
  );
  const routeCardContextWarning =
    request.routeCardContext && routeCards.length === 0
      ? [
          "Route-card prompt context was available, but no route card directly matched ticket terms.",
        ]
      : [];
  const warnings = [
    ...routeCardContextWarning,
    ...(candidateFiles.length === 0
      ? ["No candidate files matched ticket terms."]
      : []),
    ...(snippets.length === 0
      ? ["No content snippets matched ticket terms."]
      : []),
    ...(snippets.length > 0 && !hasHighSignalSnippet(snippets)
      ? ["Only low-signal content snippets matched ticket terms."]
      : []),
    ...(qualificationEvidence &&
    !qualificationEvidence.trusted &&
    qualificationEvidence.reasons.length > 0
      ? [
          `Qualification inspection was not trusted for grounding: ${qualificationEvidence.reasons.join("; ")}.`,
        ]
      : []),
  ];
  const confidence = calculateConfidence(
    candidateFiles,
    snippets,
    routeCardSummaries(routeCards),
    qualificationEvidence,
  );

  return {
    generatedAt: new Date().toISOString(),
    jiraKey: request.jiraKey,
    repoName: request.repoName,
    confidence,
    terms,
    routeCards: routeCardSummaries(routeCards),
    candidateFiles,
    snippets,
    sourceTestPairs,
    ...(ticketExplicitNewSourceCandidates.length > 0
      ? { ticketExplicitNewSourceCandidates }
      : {}),
    ...(frontendFeatureCandidates.length > 0
      ? { frontendFeatureCandidates }
      : {}),
    ...(qualificationEvidence ? { qualificationEvidence } : {}),
    ...commands,
    riskFiles: candidateFiles
      .map((candidate) => candidate.path)
      .filter(isRiskFile),
    warnings,
  };
}

export function formatPlannerGroundingForPrompt(
  grounding: PlannerGroundingContext,
): string {
  const candidateLines =
    grounding.candidateFiles.length > 0
      ? grounding.candidateFiles
          .slice(0, 12)
          .map((candidate) => {
            const reasons = candidate.reasons.join(", ");
            const terms = candidate.matchedTerms.length
              ? `; terms: ${candidate.matchedTerms.join(", ")}`
              : "";
            return `- \`${candidate.path}\` (score ${candidate.score}; ${reasons}${terms})`;
          })
          .join("\n")
      : "- none";
  const snippetLines =
    grounding.snippets.length > 0
      ? grounding.snippets
          .slice(0, 12)
          .map(
            (snippet) =>
              `- \`${snippet.file}:${snippet.line}\` matched "${snippet.term}": ${snippet.text}`,
          )
          .join("\n")
      : "- none";
  const routeCardLines =
    grounding.routeCards.length > 0
      ? grounding.routeCards
          .map(
            (card) =>
              `- ${card.title} (${card.id})${card.entrypointHints.length ? `: ${card.entrypointHints.map((hint) => `\`${hint}\``).join(", ")}` : ""}`,
          )
          .join("\n")
      : "- none";
  const qualificationLines = grounding.qualificationEvidence
    ? [
        `- Trusted: ${grounding.qualificationEvidence.trusted ? "yes" : "no"}`,
        `- Verified inspected files: ${grounding.qualificationEvidence.verifiedInspectedFiles.map((file) => `\`${file}\``).join(", ") || "none"}`,
        grounding.qualificationEvidence.inspectionSummary
          ? `- Inspection summary: ${grounding.qualificationEvidence.inspectionSummary}`
          : undefined,
        grounding.qualificationEvidence.reasons.length
          ? `- Trust blockers: ${grounding.qualificationEvidence.reasons.join("; ")}`
          : undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    : "- none";
  const sourceTestLines =
    grounding.sourceTestPairs.length > 0
      ? grounding.sourceTestPairs
          .map(
            (pair) =>
              `- \`${pair.sourceFile}\` -> ${pair.testFiles.map((file) => `\`${file}\``).join(", ")}`,
          )
          .join("\n")
      : "- none";
  const ticketExplicitLines =
    (grounding.ticketExplicitNewSourceCandidates ?? []).length > 0
      ? (grounding.ticketExplicitNewSourceCandidates ?? [])
          .slice(0, 12)
          .map((candidate) => {
            const packageText = candidate.packageName
              ? `; package: ${candidate.packageName}`
              : "";
            const pathText = candidate.path ? `; path: ${candidate.path}` : "";
            return `- \`${candidate.fileName}\`${packageText}${pathText}; sources: ${candidate.sources.join(", ")}`;
          })
          .join("\n")
      : "- none";
  const frontendFeatureLines =
    (grounding.frontendFeatureCandidates ?? []).length > 0
      ? (grounding.frontendFeatureCandidates ?? [])
          .map(
            (candidate) =>
              `- ${candidate.label} (slug: \`${candidate.slug}\`; API/backend intent: ${candidate.apiIntent ? "yes" : "no"}; sources: ${candidate.sources.join(", ")})`,
          )
          .join("\n")
      : "- none";

  return [
    "## Deterministic Planner Grounding",
    "",
    `Confidence: ${grounding.confidence}`,
    `Terms: ${grounding.terms.map((term) => term.value).join(", ") || "none"}`,
    "",
    "**Matched Route Cards**:",
    routeCardLines,
    "",
    "**Qualification Inspection Evidence**:",
    qualificationLines,
    "",
    "**Candidate Files**:",
    candidateLines,
    "",
    "**Evidence Snippets**:",
    snippetLines,
    "",
    "**Ticket-Explicit New Java Sources**:",
    ticketExplicitLines,
    "Only plan a ticket-explicit new Java source target when the ticket names the exact class/file, any ticket package/path evidence matches the target, and fileChangeContract cites both ticket evidence and repo-backed module evidence.",
    "",
    "**Likely Tests**:",
    sourceTestLines,
    "",
    "**Ticket-backed frontend feature candidates**:",
    frontendFeatureLines,
    "",
    `Build command: ${grounding.buildCommand ?? "unknown"}`,
    `Test command: ${grounding.testCommand ?? "unknown"}`,
    `Test pattern: ${grounding.testPattern ?? "unknown"}`,
    `Risk files: ${grounding.riskFiles.join(", ") || "none"}`,
    `Warnings: ${grounding.warnings.join("; ") || "none"}`,
    "",
    "Use this deterministic evidence as the primary navigation packet. If you choose a target file not listed here, explain why it is adjacent to the evidence. New frontend UI/API files are allowed only when their feature slug is ticket-backed here and the fileChangeContract cites both ticket intent and inspected repo template evidence.",
  ].join("\n");
}

export function buildPlannerEvidenceContext(input: {
  jiraKey: string;
  repoName: string;
  grounding?: PlannerGroundingContext | null;
  scoutStatus: PlannerEvidenceContext["scoutStatus"];
  scoutReports?: PlannerScoutEvidenceReport[];
  scoutCoverage?: PlannerScoutCoverage;
  scoutInvocationFailed?: boolean;
  scoutReturnedNothing?: boolean;
  warnings?: string[];
}): PlannerEvidenceContext {
  const scoutReports = input.scoutReports ?? [];
  const validScouts = scoutReports.filter(
    (report) =>
      report.status === "valid" && primaryScoutTargetFiles(report).length > 0,
  );
  const grounding = input.grounding ?? undefined;
  const groundingStrong = isPlannerGroundingStrong(grounding);
  const confidence: GroundingConfidence =
    groundingStrong || validScouts.length > 0
      ? "strong"
      : (grounding?.confidence ?? "weak");
  return {
    generatedAt: new Date().toISOString(),
    jiraKey: input.jiraKey,
    repoName: input.repoName,
    confidence,
    scoutStatus: input.scoutStatus,
    ...(grounding?.qualificationEvidence
      ? { qualificationEvidence: grounding.qualificationEvidence }
      : {}),
    ...(grounding ? { grounding } : {}),
    scoutReports,
    ...(input.scoutCoverage ? { scoutCoverage: input.scoutCoverage } : {}),
    scoutInvocationFailed: input.scoutInvocationFailed ?? false,
    scoutReturnedNothing: input.scoutReturnedNothing ?? false,
    failedScoutCount: scoutReports.filter((report) => report.status !== "valid")
      .length,
    warnings: input.warnings ?? [],
  };
}

export function formatPlannerEvidenceForPrompt(
  evidence: PlannerEvidenceContext,
): string {
  const scoutCoverage = evidence.scoutCoverage
    ? [
        `Scout requirements: ${evidence.scoutCoverage.requirementCount}`,
        `Scout evidence-backed requirements: ${evidence.scoutCoverage.evidenceBackedRequirementCount}`,
        `Scout uncovered requirements: ${evidence.scoutCoverage.uncoveredRequirementCount}`,
      ].join("\n")
    : "Scout requirements: unknown";
  const scoutStatusExplanation: Record<
    PlannerEvidenceContext["scoutStatus"],
    string
  > = {
    scouts_disabled: "Planner Scout was disabled.",
    scouts_skipped_strong_qualifier:
      "Planner Scout was skipped because qualifier evidence was already strong.",
    scouts_skipped_strong_grounding:
      "Planner Scout was skipped because deterministic grounding was already strong.",
    scouts_no_work_items:
      "Planner Scout had no uncovered work because requirements were already backed by existing evidence.",
    scouts_no_requirements:
      "Planner Scout received no qualification requirements; treat this as an upstream extraction warning and decide from the ticket and repository evidence.",
    scouts_error:
      "Planner Scout could not run successfully; treat scout output as advisory and decide from the ticket and repository evidence.",
    scouts_all_failed:
      "Planner Scout ran but returned no usable repository evidence; treat this as advisory and verify with your own repository tools.",
    scouts_partial_success:
      "Planner Scout returned partial usable repository evidence.",
    scouts_supported_plan:
      "Planner Scout returned usable repository evidence.",
  };
  const scoutLines =
    evidence.scoutReports.length > 0
      ? evidence.scoutReports
          .map((report) => {
            const files =
              report.verifiedInspectedFiles
                .map((file) => `\`${file}\``)
                .join(", ") || "none";
            const snippets =
              report.snippets
                .slice(0, 4)
                .map(
                  (snippet) =>
                    `${snippet.file}:${snippet.line} ${snippet.text}`,
                )
                .join(" | ") || "none";
            const templates =
              (report.templateMappings ?? [])
                .slice(0, 4)
                .map(
                  (mapping) =>
                    `${mapping.targetPattern} from ${mapping.templateFile}: ${mapping.rationale}`,
                )
                .join(" | ") || "none";
            const symbols =
              report.symbols.slice(0, 6).join(", ") || "none";
            const tests =
              report.testFiles.map((file) => `\`${file}\``).slice(0, 4).join(", ") ||
              "none";
            const commands =
              report.commands
                .slice(0, 4)
                .map((command) => `advisory: ${command}`)
                .join(" | ") || "none";
            const blockers =
              report.blockers.slice(0, 4).join(" | ") || "none";
            const failure = report.failureReason
              ? `; failure: ${report.failureReason}`
              : "";
            return `- ${report.workItemId} (${report.status}, ${report.confidence}; tools ${report.toolCalls}; files: ${files}${failure}) ${report.summary ?? ""} snippets: ${snippets}; symbols: ${symbols}; tests: ${tests}; advisory validation commands: ${commands}; risks/gaps: ${blockers}; template mappings: ${templates}`;
          })
          .join("\n")
      : "- none";
  const qualifierFiles =
    evidence.qualificationEvidence?.verifiedInspectedFiles
      .map((file) => `\`${file}\``)
      .join(", ") || "none";

  return [
    "## Planner Evidence Context",
    "",
    "Planner Scout is advisory only. Use it as context, then decide from the ticket, qualification evidence, repository tools, and normal plan validation rules.",
    "",
    `Confidence: ${evidence.confidence}`,
    `Scout status: ${evidence.scoutStatus}`,
    `Scout status meaning: ${scoutStatusExplanation[evidence.scoutStatus]}`,
    scoutCoverage,
    `Scout invocation failed: ${evidence.scoutInvocationFailed ? "yes" : "no"}`,
    `Scout returned nothing: ${evidence.scoutReturnedNothing ? "yes" : "no"}`,
    `Qualifier evidence strong: ${evidence.qualificationEvidence?.strong ? "yes" : "no"}`,
    `Qualifier files: ${qualifierFiles}`,
    `Deterministic grounding strong: ${isPlannerGroundingStrong(evidence.grounding) ? "yes" : "no"}`,
    "",
    "**Scout Evidence**:",
    scoutLines,
    "",
    `Warnings: ${evidence.warnings.join("; ") || "none"}`,
  ].join("\n");
}

function normalizedTargetSet(
  grounding?: PlannerGroundingContext,
  evidence?: PlannerEvidenceContext,
  options?: PlannerGroundingValidationOptions,
): Set<string> {
  return new Set([
    ...(grounding?.candidateFiles ?? []).map((candidate) =>
      normalizePath(candidate.path),
    ),
    ...(grounding?.routeCards ?? []).flatMap((card) =>
      card.entrypointHints.map(normalizePath),
    ),
    ...(grounding?.qualificationEvidence?.verifiedInspectedFiles ?? []).map(
      normalizePath,
    ),
    ...(evidence?.qualificationEvidence?.verifiedInspectedFiles ?? []).map(
      normalizePath,
    ),
    ...validScoutReports(evidence)
      .flatMap((report) => [
        ...report.verifiedInspectedFiles,
        ...report.testFiles,
      ])
      .map(normalizePath),
    ...(options?.finalPlannerReadFiles ?? []).map(normalizePath),
  ]);
}

function isAbsoluteLikePath(filePath: string): boolean {
  return /^(?:[a-zA-Z]:)?[\\/]/.test(filePath);
}

function isSafePlanTargetPath(filePath: string): boolean {
  return !isAbsoluteLikePath(filePath) && isSafeWorkspaceRelativePath(filePath);
}

function extensionOf(filePath: string): string {
  const normalized = normalizePath(filePath).toLowerCase();
  if (normalized.endsWith(".hbm.xml")) {
    return ".hbm.xml";
  }
  return path.extname(normalized);
}

function evidenceFiles(
  grounding?: PlannerGroundingContext,
  evidence?: PlannerEvidenceContext,
  options?: PlannerGroundingValidationOptions,
): string[] {
  return Array.from(normalizedTargetSet(grounding, evidence, options)).filter(
    isSafeWorkspaceRelativePath,
  );
}

function sameDirectory(left: string, right: string): boolean {
  return (
    path.posix.dirname(normalizePath(left)) ===
    path.posix.dirname(normalizePath(right))
  );
}

function hasEvidenceInSameDirectory(
  targetFile: string,
  files: string[],
): boolean {
  return files.some((file) => sameDirectory(targetFile, file));
}

function evidenceInSameDirectory(
  targetFile: string,
  files: string[],
): string[] {
  return files.filter((file) => sameDirectory(targetFile, file));
}

const EVIDENCE_BACKED_SEMANTIC_DIRS = new Set([
  "controller",
  "controllers",
  "dto",
  "model",
  "models",
  "service",
  "services",
  "mapping",
  "mappings",
  "businessservice",
]);

function evidenceBackedSemanticRoot(filePath: string): string | undefined {
  const parts = path.posix
    .dirname(normalizePath(filePath))
    .split("/")
    .filter(Boolean);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (EVIDENCE_BACKED_SEMANTIC_DIRS.has(parts[index].toLowerCase())) {
      return parts.slice(0, index + 1).join("/");
    }
  }
  return undefined;
}

function hasEvidenceInSameSemanticDirectory(
  targetFile: string,
  files: string[],
): boolean {
  const targetRoot = evidenceBackedSemanticRoot(targetFile);
  if (!targetRoot) {
    return false;
  }
  return files.some((file) => evidenceBackedSemanticRoot(file) === targetRoot);
}

function javaPackageModuleRoot(filePath: string): string | undefined {
  const parts = path.posix
    .dirname(normalizePath(filePath))
    .split("/")
    .filter(Boolean);
  const srcIndex = parts.findIndex(
    (part, index) =>
      part === "src" &&
      parts[index + 1] === "main" &&
      parts[index + 2] === "java",
  );
  if (srcIndex < 0) {
    return undefined;
  }

  const packageStart = srcIndex + 3;
  const serverIndex = parts.findIndex(
    (part, index) => index >= packageStart && part === "server",
  );
  if (serverIndex >= 0 && parts[serverIndex + 1]) {
    return parts.slice(0, serverIndex + 2).join("/");
  }
  if (parts[packageStart]) {
    return parts.slice(0, Math.min(parts.length, packageStart + 4)).join("/");
  }
  return undefined;
}

function hasEvidenceInSameJavaModule(
  targetFile: string,
  files: string[],
): boolean {
  if (!evidenceBackedSemanticRoot(targetFile)) {
    return false;
  }
  const targetRoot = javaPackageModuleRoot(targetFile);
  if (!targetRoot) {
    return false;
  }
  return files.some((file) => javaPackageModuleRoot(file) === targetRoot);
}

function javaSourceModuleRoot(filePath: string): string | undefined {
  const normalized = normalizePath(filePath);
  if (!normalized.toLowerCase().endsWith(".java")) {
    return undefined;
  }
  const parts = path.posix.dirname(normalized).split("/").filter(Boolean);
  const srcIndex = parts.findIndex(
    (part, index) =>
      part === "src" &&
      parts[index + 1] === "main" &&
      parts[index + 2] === "java",
  );
  if (srcIndex < 0) {
    return undefined;
  }
  return parts.slice(0, srcIndex).join("/");
}

function javaMainSourcePackageName(filePath: string): string | undefined {
  const normalized = normalizePath(filePath);
  if (!normalized.toLowerCase().endsWith(".java")) {
    return undefined;
  }
  const parts = path.posix.dirname(normalized).split("/").filter(Boolean);
  const srcIndex = parts.findIndex(
    (part, index) =>
      part === "src" &&
      parts[index + 1] === "main" &&
      parts[index + 2] === "java",
  );
  if (srcIndex < 0 || parts.length <= srcIndex + 3) {
    return undefined;
  }
  return parts.slice(srcIndex + 3).join(".");
}

function isJavaMainSourceTarget(filePath: string): boolean {
  return javaSourceModuleRoot(filePath) !== undefined;
}

function sameJavaSourceModule(left: string, right: string): boolean {
  const leftRoot = javaSourceModuleRoot(left);
  const rightRoot = javaSourceModuleRoot(right);
  return (
    leftRoot !== undefined && rightRoot !== undefined && leftRoot === rightRoot
  );
}

function ticketExplicitModuleEvidence(
  targetFile: string,
  files: string[],
): string[] {
  const normalizedTarget = normalizePath(targetFile);
  return files
    .map(normalizePath)
    .filter((file) => file !== normalizedTarget)
    .filter((file) => [".java", ".xml", ".hbm.xml"].includes(extensionOf(file)))
    .filter((file) => sameJavaSourceModule(normalizedTarget, file));
}

function isFlywayMigrationPath(filePath: string): boolean {
  const normalized = normalizePath(filePath).toLowerCase();
  return (
    normalized.startsWith("flyway/sql/") || normalized.includes("/flyway/sql/")
  );
}

function isFlywayMigrationFileName(filePath: string): boolean {
  return /^V\d+\.\d{4}-\d{2}-\d{2}-\d+__[A-Za-z0-9_-]+\.sql$/.test(
    path.posix.basename(filePath),
  );
}

const TEST_FIXTURE_EXTENSIONS = new Set([
  ".json",
  ".yaml",
  ".yml",
  ".xml",
  ".txt",
  ".csv",
  ".properties",
  ".sql",
]);

function isTestFixtureExtension(filePath: string): boolean {
  return TEST_FIXTURE_EXTENSIONS.has(extensionOf(filePath));
}

function adjacentSourceOrMappingEvidence(
  targetFile: string,
  files: string[],
): string[] {
  const extension = extensionOf(targetFile);
  if (![".java", ".xml", ".hbm.xml"].includes(extension)) {
    return [];
  }
  return files.filter(
    (file) =>
      sameDirectory(targetFile, file) ||
      hasEvidenceInSameSemanticDirectory(targetFile, [file]) ||
      hasEvidenceInSameJavaModule(targetFile, [file]),
  );
}

export function isRecoverableSourceRationaleSupport(
  targetFile: string,
  supportingFile: string,
): boolean {
  if (
    !isSafePlanTargetPath(targetFile) ||
    !isSafePlanTargetPath(supportingFile)
  ) {
    return false;
  }
  const normalizedTarget = normalizePath(targetFile);
  const normalizedSupport = normalizePath(supportingFile);
  if (normalizedTarget === normalizedSupport) {
    return false;
  }
  if (![".java", ".xml", ".hbm.xml"].includes(extensionOf(normalizedSupport))) {
    return false;
  }
  return (
    adjacentSourceOrMappingEvidence(normalizedTarget, [normalizedSupport])
      .length > 0
  );
}

function adjacentStyleAssetEvidence(
  targetFile: string,
  files: string[],
): string[] {
  if (!isStyleAssetPath(targetFile)) {
    return [];
  }
  if (isGeneratedOrGlobalStyleFile(targetFile)) {
    return [];
  }

  return evidenceInSameDirectory(targetFile, files)
    .filter((file) => isStyleAssetPath(file))
    .filter((file) => !isGeneratedOrGlobalStyleFile(file));
}

function adjacentUiAssetEvidence(targetFile: string, files: string[]): string[] {
  if (!isUiAssetPath(targetFile)) {
    return [];
  }

  const normalizedTarget = normalizePath(targetFile);
  return evidenceInSameDirectory(targetFile, files)
    .filter((file) => normalizePath(file) !== normalizedTarget)
    .filter(isUiAssetPath);
}

function classifyAdjacentTarget(
  targetFile: string,
  files: string[],
  discoveredFiles: string[] = [],
): {
  ok: boolean;
  kind?: PlannerTargetValidationKind;
  reason?: string;
  supportingFiles?: string[];
} {
  if (!isSafePlanTargetPath(targetFile)) {
    return {
      ok: false,
      reason: "target path is not a safe workspace-relative path",
    };
  }

  if (isFlywayMigrationPath(targetFile)) {
    if (!isFlywayMigrationFileName(targetFile)) {
      return {
        ok: false,
        reason:
          "Flyway migration target does not match the repo migration filename pattern",
      };
    }
    if (!hasEvidenceInSameDirectory(targetFile, files)) {
      return {
        ok: false,
        reason: "Flyway migration directory is not backed by planner evidence",
      };
    }
    return {
      ok: true,
      kind: "flyway_migration",
      supportingFiles: evidenceInSameDirectory(targetFile, files),
    };
  }

  const sourceOrMappingEvidence = adjacentSourceOrMappingEvidence(
    targetFile,
    files,
  );
  if (sourceOrMappingEvidence.length > 0) {
    return {
      ok: true,
      kind: "adjacent_source_or_mapping",
      supportingFiles: sourceOrMappingEvidence,
    };
  }

  const uiAssetEvidence = adjacentUiAssetEvidence(targetFile, [
    ...files,
    ...discoveredFiles,
  ]);
  if (uiAssetEvidence.length > 0) {
    return {
      ok: true,
      kind: "adjacent_ui_asset",
      supportingFiles: uiAssetEvidence,
    };
  }

  if (
    isStyleAssetPath(targetFile) &&
    isGeneratedOrGlobalStyleFile(targetFile)
  ) {
    return {
      ok: false,
      reason:
        "style target is a generated or global theme file and cannot be accepted by adjacency",
    };
  }

  const styleEvidence = adjacentStyleAssetEvidence(targetFile, files);
  if (styleEvidence.length > 0) {
    return {
      ok: true,
      kind: "adjacent_style_asset",
      supportingFiles: styleEvidence,
    };
  }

  return {
    ok: false,
    reason:
      "target is not exact evidence and is not an allowed adjacent source, UI asset, style asset, mapping, migration, or test file",
  };
}

function javaSourcePackage(
  filePath: string,
  sourceKind: "main" | "test",
): { moduleRoot: string; packageDir: string } | undefined {
  const normalized = normalizePath(filePath);
  if (!normalized.toLowerCase().endsWith(".java")) {
    return undefined;
  }
  const parts = path.posix.dirname(normalized).split("/").filter(Boolean);
  const srcKind = sourceKind === "main" ? "main" : "test";
  const srcIndex = parts.findIndex(
    (part, index) =>
      part === "src" &&
      parts[index + 1] === srcKind &&
      parts[index + 2] === "java",
  );
  if (srcIndex < 0) {
    return undefined;
  }
  return {
    moduleRoot: parts.slice(0, srcIndex).join("/"),
    packageDir: parts.slice(srcIndex + 3).join("/"),
  };
}

function isJavaScenarioTestForSource(
  targetFile: string,
  sourceFile: string,
): boolean {
  const targetPackage = javaSourcePackage(targetFile, "test");
  const sourcePackage = javaSourcePackage(sourceFile, "main");
  if (!targetPackage || !sourcePackage) {
    return false;
  }
  if (
    targetPackage.moduleRoot !== sourcePackage.moduleRoot ||
    targetPackage.packageDir !== sourcePackage.packageDir
  ) {
    return false;
  }

  const sourceStem = normalizeForMatch(stem(sourceFile));
  const targetStem = normalizeTestStem(stem(targetFile));
  return (
    sourceStem.length >= 4 &&
    targetStem.startsWith(sourceStem) &&
    targetStem.length > sourceStem.length
  );
}

function isSamePackageJavaTestForSource(
  targetFile: string,
  sourceFile: string,
): boolean {
  const targetPackage = javaSourcePackage(targetFile, "test");
  const sourcePackage = javaSourcePackage(sourceFile, "main");
  if (!targetPackage || !sourcePackage) {
    return false;
  }
  return (
    targetPackage.moduleRoot === sourcePackage.moduleRoot &&
    targetPackage.packageDir === sourcePackage.packageDir
  );
}

function colocatedJsTsSourceEvidence(
  targetFile: string,
  candidateFiles: string[],
): string[] {
  const normalizedTarget = normalizePath(targetFile);
  const targetBase = path.posix.basename(normalizedTarget);
  const match = targetBase.match(/^(.+)\.(?:test|spec)\.([jt]sx?)$/i);
  if (!match) {
    return [];
  }
  const [, sourceStem, targetExtension] = match;
  const targetDir = path.posix.dirname(normalizedTarget);
  const sourceExtensions =
    targetExtension.toLowerCase().endsWith("x")
      ? [`.${targetExtension.toLowerCase()}`]
      : [
          `.${targetExtension.toLowerCase()}`,
          `.${targetExtension.toLowerCase()}x`,
        ];

  return unique(
    candidateFiles
      .map(normalizePath)
      .filter((candidateFile) => !isTestLikePath(candidateFile))
      .filter(
        (candidateFile) => path.posix.dirname(candidateFile) === targetDir,
      )
      .filter((candidateFile) =>
        sourceExtensions.includes(extensionOf(candidateFile)),
      )
      .filter(
        (candidateFile) =>
          normalizeForMatch(stem(candidateFile)) ===
          normalizeForMatch(sourceStem),
      ),
  );
}

function classifyAdjacentTestTarget(
  targetFile: string,
  grounding?: PlannerGroundingContext,
  evidence?: PlannerEvidenceContext,
  evidenceBackedFiles: string[] = [],
  acceptedNewSourceTargets: string[] = [],
): {
  ok: boolean;
  kind?: PlannerTargetValidationKind;
  supportingFiles?: string[];
  reason?: string;
} {
  if (!isTestLikePath(targetFile)) {
    return { ok: false, reason: "target is not a test-like path" };
  }

  const normalizedTarget = normalizePath(targetFile);
  const targetStem = normalizeTestStem(stem(normalizedTarget));
  const candidateFiles = [
    ...(grounding?.candidateFiles ?? []).map((candidate) => candidate.path),
    ...(grounding?.qualificationEvidence?.verifiedInspectedFiles ?? []),
    ...(evidence?.qualificationEvidence?.verifiedInspectedFiles ?? []),
    ...validScoutReports(evidence).flatMap(
      (report) => report.verifiedInspectedFiles,
    ),
    ...evidenceBackedFiles,
    ...acceptedNewSourceTargets,
  ];
  const exactStemSupport = candidateFiles.find((candidateFile) => {
    const candidateStem = normalizeForMatch(stem(candidateFile));
    return candidateStem.length >= 4 && targetStem === candidateStem;
  });
  if (exactStemSupport) {
    return {
      ok: true,
      kind: "adjacent_test",
      supportingFiles: [normalizePath(exactStemSupport)],
    };
  }

  const colocatedSourceSupport = colocatedJsTsSourceEvidence(
    normalizedTarget,
    candidateFiles,
  );
  if (colocatedSourceSupport.length > 0) {
    return {
      ok: true,
      kind: "adjacent_colocated_test",
      supportingFiles: colocatedSourceSupport,
    };
  }

  const scenarioSupport = evidenceBackedFiles.find((candidateFile) =>
    isJavaScenarioTestForSource(normalizedTarget, candidateFile),
  );
  if (scenarioSupport) {
    return {
      ok: true,
      kind: "adjacent_test_scenario_soft",
      supportingFiles: [normalizePath(scenarioSupport)],
    };
  }

  const samePackageJavaSupport = candidateFiles.find((candidateFile) =>
    isSamePackageJavaTestForSource(normalizedTarget, candidateFile),
  );
  if (samePackageJavaSupport) {
    return {
      ok: true,
      kind: "same_package_java_test_accepted_soft",
      supportingFiles: [normalizePath(samePackageJavaSupport)],
    };
  }

  return {
    ok: false,
    reason:
      "test target does not match evidence-backed source or accepted new source target",
  };
}

function normalizeTestStem(value: string): string {
  return normalizeForMatch(value).replace(/(?:tests?|spec|it)$/i, "");
}

function rationaleForTarget(
  spec: OneShotPlan["specs"][number],
  targetFile: string,
) {
  return (spec.targetFileRationales ?? []).find(
    (rationale) => normalizePath(rationale.targetFile) === targetFile,
  );
}

const EDITABLE_CONTRACT_ROLES = new Set<
  OneShotFileChangeContractEntry["role"]
>(["runtime_required", "test_required", "config_required", "source_parity"]);

function contractForTarget(
  plan: OneShotPlan,
  targetFile: string,
): OneShotFileChangeContractEntry | undefined {
  return (plan.fileChangeContract ?? []).find(
    (entry) => normalizePath(entry.path) === targetFile,
  );
}

function exactEvidenceReferencePresent(
  evidenceText: string,
  supportFile: string,
): boolean {
  const normalizedText = normalizePath(evidenceText);
  return normalizedText.includes(normalizePath(supportFile));
}

function supportBasenameMatches(
  evidenceText: string,
  supportFile: string,
  adjacencySupportingFiles: readonly string[],
): boolean {
  const supportBasename = path.posix.basename(normalizePath(supportFile));
  if (!supportBasename) {
    return false;
  }
  const sameBasenameSupport = adjacencySupportingFiles.filter(
    (candidate) => path.posix.basename(normalizePath(candidate)) === supportBasename,
  );
  if (sameBasenameSupport.length !== 1) {
    return false;
  }
  return evidenceText.includes(supportBasename);
}

function contractReferencesAdjacentSupport(
  contract: OneShotFileChangeContractEntry,
  adjacencySupportingFiles: readonly string[],
): boolean {
  const evidenceText = [
    contract.rationale,
    ...contract.supportingEvidence,
  ].join("\n");
  return adjacencySupportingFiles.some(
    (supportFile) =>
      exactEvidenceReferencePresent(evidenceText, supportFile) ||
      supportBasenameMatches(evidenceText, supportFile, adjacencySupportingFiles),
  );
}

function validateFileChangeContractEvidence(
  plan: OneShotPlan,
  targetFile: string,
  adjacencySupportingFiles: string[],
): {
  ok: boolean;
  reason?: string;
  evidenceSource: PlannerTargetValidationEvidenceSource;
  rationalePresent: boolean;
} {
  const contract = contractForTarget(plan, targetFile);
  if (!contract) {
    return {
      ok: false,
      reason: "adjacent target requires fileChangeContract evidence",
      evidenceSource: "missing_file_change_contract_evidence",
      rationalePresent: false,
    };
  }

  if (!contract.editable || !EDITABLE_CONTRACT_ROLES.has(contract.role)) {
    return {
      ok: false,
      reason:
        "fileChangeContract marks adjacent target as non-editable or read-only",
      evidenceSource: "contract_marks_target_non_editable",
      rationalePresent: Boolean(contract.rationale),
    };
  }

  if (
    contract.rationale.trim().length === 0 ||
    contract.supportingEvidence.length === 0
  ) {
    return {
      ok: false,
      reason:
        "fileChangeContract requires rationale and supportingEvidence for adjacent targets",
      evidenceSource: "file_change_contract_evidence",
      rationalePresent: Boolean(contract.rationale.trim()),
    };
  }

  if (!contractReferencesAdjacentSupport(contract, adjacencySupportingFiles)) {
    return {
      ok: false,
      reason:
        "fileChangeContract supportingEvidence must reference an adjacency-supporting evidence file",
      evidenceSource: "file_change_contract_evidence",
      rationalePresent: true,
    };
  }

  return {
    ok: true,
    evidenceSource: "file_change_contract_evidence",
    rationalePresent: true,
  };
}

function contractMentionsTicketEvidence(
  contract: OneShotFileChangeContractEntry,
  targetFile: string,
  candidate: PlannerTicketExplicitNewSourceCandidate,
): boolean {
  const evidenceText = [
    contract.rationale,
    ...contract.supportingEvidence,
  ].join("\n");
  const normalizedEvidence = evidenceText.toLowerCase();
  const ticketSourceMentioned =
    /\b(ticket|jira|requirement|acceptance|prism)\b/i.test(evidenceText);
  const targetMentioned = [
    candidate.className,
    candidate.fileName,
    candidate.path,
    targetFile,
  ]
    .filter((value): value is string => Boolean(value))
    .some((value) =>
      normalizedEvidence.includes(normalizePath(value).toLowerCase()),
    );
  return ticketSourceMentioned && targetMentioned;
}

function validateTicketExplicitNewSourceTarget(
  plan: OneShotPlan,
  targetFile: string,
  evidenceBackedFiles: string[],
  candidates: PlannerTicketExplicitNewSourceCandidate[],
): PlannerTargetValidationDecision | undefined {
  if (!isJavaMainSourceTarget(targetFile) || candidates.length === 0) {
    return undefined;
  }

  const targetClassName = path.posix.basename(targetFile, ".java");
  const targetFileName = `${targetClassName}.java`;
  const targetPackageName = javaMainSourcePackageName(targetFile);
  const matchingClassCandidates = candidates.filter(
    (candidate) =>
      candidate.className === targetClassName ||
      candidate.fileName === targetFileName,
  );

  const baseDecision = {
    rawTargetFile: targetFile,
    targetFile,
    kind: "ticket_explicit_new_source" as const,
    rationaleRequired: true,
  };

  if (matchingClassCandidates.length === 0) {
    return {
      ...baseDecision,
      ok: false,
      reason: `ticket evidence did not name ${targetFileName}`,
      rationalePresent: Boolean(contractForTarget(plan, targetFile)?.rationale),
    };
  }

  const pathCandidates = matchingClassCandidates.filter(
    (candidate) => candidate.path,
  );
  if (
    pathCandidates.length > 0 &&
    !pathCandidates.some((candidate) => normalizePath(candidate.path!) === targetFile)
  ) {
    return {
      ...baseDecision,
      ok: false,
      reason: "ticket evidence path does not match target path",
      rationalePresent: Boolean(contractForTarget(plan, targetFile)?.rationale),
    };
  }

  const packageCandidates = matchingClassCandidates.filter(
    (candidate) => candidate.packageName,
  );
  if (
    packageCandidates.length > 0 &&
    !packageCandidates.some(
      (candidate) => candidate.packageName === targetPackageName,
    )
  ) {
    return {
      ...baseDecision,
      ok: false,
      reason: "ticket evidence package does not match target package",
      rationalePresent: Boolean(contractForTarget(plan, targetFile)?.rationale),
    };
  }

  const selectedCandidate =
    matchingClassCandidates.find(
      (candidate) =>
        (!candidate.path || normalizePath(candidate.path) === targetFile) &&
        (!candidate.packageName ||
          candidate.packageName === targetPackageName),
    ) ?? matchingClassCandidates[0];
  const contract = contractForTarget(plan, targetFile);
  if (!contract) {
    return {
      ...baseDecision,
      ok: false,
      reason: "ticket-explicit target requires fileChangeContract evidence",
      rationalePresent: false,
      evidenceSource: "missing_file_change_contract_evidence",
    };
  }
  if (!contract.editable || !EDITABLE_CONTRACT_ROLES.has(contract.role)) {
    return {
      ...baseDecision,
      ok: false,
      reason:
        "fileChangeContract marks ticket-explicit target as non-editable or read-only",
      rationalePresent: Boolean(contract.rationale),
      evidenceSource: "contract_marks_target_non_editable",
    };
  }
  if (
    contract.rationale.trim().length === 0 ||
    contract.supportingEvidence.length === 0
  ) {
    return {
      ...baseDecision,
      ok: false,
      reason:
        "fileChangeContract requires rationale and supportingEvidence for ticket-explicit targets",
      rationalePresent: Boolean(contract.rationale.trim()),
      evidenceSource: "file_change_contract_evidence",
    };
  }
  if (!contractMentionsTicketEvidence(contract, targetFile, selectedCandidate)) {
    return {
      ...baseDecision,
      ok: false,
      reason:
        "fileChangeContract supportingEvidence must cite ticket evidence for the exact ticket-named class",
      rationalePresent: true,
      evidenceSource: "file_change_contract_evidence",
    };
  }

  const moduleEvidence = ticketExplicitModuleEvidence(
    targetFile,
    evidenceBackedFiles,
  );
  if (moduleEvidence.length === 0) {
    return {
      ...baseDecision,
      ok: false,
      reason: "ticket-explicit target has no repo-backed module evidence",
      rationalePresent: true,
      evidenceSource: "file_change_contract_evidence",
    };
  }
  if (!contractReferencesAdjacentSupport(contract, moduleEvidence)) {
    return {
      ...baseDecision,
      ok: false,
      reason:
        "fileChangeContract supportingEvidence must reference repo-backed module evidence",
      supportingFiles: moduleEvidence,
      rationalePresent: true,
      evidenceSource: "file_change_contract_evidence",
    };
  }

  return {
    ...baseDecision,
    ok: true,
    supportingFiles: moduleEvidence,
    rationalePresent: true,
    evidenceSource: "file_change_contract_evidence",
  };
}

const FRONTEND_SOURCE_EXTENSIONS = new Set([".tsx", ".ts", ".scss", ".css"]);
const FRONTEND_API_MODULE_FILES = new Set(["slice.ts", "types.ts", "index.ts"]);
const GLOBAL_FRONTEND_STYLE_FILE_NAMES = new Set([
  "global.css",
  "global.scss",
  "globals.css",
  "globals.scss",
  "style.css",
  "style.scss",
  "styles.css",
  "styles.scss",
  "theme.css",
  "theme.scss",
  "variables.css",
  "variables.scss",
]);

function isFrontendSourceExtension(filePath: string): boolean {
  return FRONTEND_SOURCE_EXTENSIONS.has(extensionOf(filePath));
}

function isGeneratedOrGlobalFrontendStyleFile(filePath: string): boolean {
  if (!isStyleAssetPath(filePath)) {
    return false;
  }
  return (
    isGeneratedOrGlobalStyleFile(filePath) ||
    GLOBAL_FRONTEND_STYLE_FILE_NAMES.has(
      path.posix.basename(normalizePath(filePath).toLowerCase()),
    )
  );
}

function isTicketBackedUiFeaturePath(
  targetFile: string,
  candidate: PlannerGroundingFrontendFeatureCandidate,
): boolean {
  const normalized = normalizePath(targetFile).toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  if (parts[0] !== "src" || normalized.startsWith("src/core/api/")) {
    return false;
  }
  if (parts[1] === candidate.slug) {
    return true;
  }
  const pagesIndex = parts.indexOf("pages");
  if (pagesIndex >= 0 && parts[pagesIndex + 1] === candidate.slug) {
    return true;
  }
  return false;
}

function isTicketBackedApiFeaturePath(
  targetFile: string,
  candidate: PlannerGroundingFrontendFeatureCandidate,
): boolean {
  const normalized = normalizePath(targetFile).toLowerCase();
  if (!normalized.startsWith(`src/core/api/${candidate.slug}/`)) {
    return false;
  }
  return FRONTEND_API_MODULE_FILES.has(path.posix.basename(normalized));
}

function frontendUiTemplateEvidence(
  targetFile: string,
  files: string[],
): string[] {
  const normalizedTarget = normalizePath(targetFile);
  return unique(
    files
      .map(normalizePath)
      .filter((file) => file !== normalizedTarget)
      .filter((file) => !isTestLikePath(file))
      .filter((file) => isFrontendSourceExtension(file))
      .filter((file) => {
        const lowerFile = file.toLowerCase();
        return (
          lowerFile.includes("/pages/") ||
          lowerFile.includes("/components/") ||
          lowerFile.includes("/design-system/") ||
          lowerFile.endsWith("/router.tsx") ||
          lowerFile.endsWith("/routes/index.ts") ||
          lowerFile.endsWith("/layout.tsx") ||
          lowerFile.endsWith("-layout.tsx") ||
          lowerFile.endsWith(".module.scss")
        );
      }),
  );
}

function frontendApiTemplateEvidence(
  targetFile: string,
  files: string[],
): string[] {
  const normalizedTarget = normalizePath(targetFile);
  return unique(
    files
      .map(normalizePath)
      .filter((file) => file !== normalizedTarget)
      .filter((file) => !isTestLikePath(file))
      .filter((file) => {
        const lowerFile = file.toLowerCase();
        if (lowerFile.startsWith("src/core/api/")) {
          return (
            lowerFile.endsWith("/slice.ts") ||
            lowerFile.endsWith("/types.ts") ||
            lowerFile.endsWith("/index.ts") ||
            lowerFile.endsWith("-api.ts") ||
            lowerFile.endsWith("/api-config.ts")
          );
        }
        return lowerFile === "src/app/store.ts";
      }),
  );
}

function contractReferencesTicketFeature(
  contract: OneShotFileChangeContractEntry,
  candidate: PlannerGroundingFrontendFeatureCandidate,
): boolean {
  const evidenceText = normalizeForMatch(
    [contract.rationale, ...contract.supportingEvidence].join("\n"),
  );
  const candidateTerms = featureCandidateText(candidate)
    .map(normalizeForMatch)
    .filter((term) => term.length >= 4);
  if (candidateTerms.some((term) => evidenceText.includes(term))) {
    return true;
  }
  const words = featureWords(candidate.label)
    .map(normalizeForMatch)
    .filter((term) => term.length >= 4);
  return words.length > 0 && words.every((word) => evidenceText.includes(word));
}

function ticketBackedFrontendDecision(
  plan: OneShotPlan,
  targetFile: string,
  evidenceBackedFiles: string[],
  candidates: PlannerGroundingFrontendFeatureCandidate[],
):
  | Omit<PlannerTargetValidationDecision, "rawTargetFile" | "targetFile">
  | undefined {
  const apiCandidate = candidates.find((candidate) =>
    isTicketBackedApiFeaturePath(targetFile, candidate),
  );
  if (apiCandidate) {
    const supportingFiles = frontendApiTemplateEvidence(
      targetFile,
      evidenceBackedFiles,
    );
    if (!apiCandidate.apiIntent) {
      return {
        kind: "ticket_template_backed_new_api_target",
        ok: false,
        reason:
          "ticket-backed API target requires ticket API/backend/upload/config intent",
        supportingFiles,
        rationaleRequired: true,
        rationalePresent: Boolean(contractForTarget(plan, targetFile)?.rationale),
        evidenceSource: contractForTarget(plan, targetFile)
          ? "file_change_contract_evidence"
          : "missing_file_change_contract_evidence",
      };
    }
    if (supportingFiles.length === 0) {
      return {
        kind: "ticket_template_backed_new_api_target",
        ok: false,
        reason:
          "ticket-backed API target requires inspected repo API template evidence",
        rationaleRequired: true,
        rationalePresent: Boolean(contractForTarget(plan, targetFile)?.rationale),
        evidenceSource: contractForTarget(plan, targetFile)
          ? "file_change_contract_evidence"
          : "missing_file_change_contract_evidence",
      };
    }
    const contract = contractForTarget(plan, targetFile);
    if (contract && !contractReferencesTicketFeature(contract, apiCandidate)) {
      return {
        kind: "ticket_template_backed_new_api_target",
        ok: false,
        reason:
          "fileChangeContract supportingEvidence must cite ticket-backed frontend feature intent",
        supportingFiles,
        rationaleRequired: true,
        rationalePresent: Boolean(contract.rationale.trim()),
        evidenceSource: "file_change_contract_evidence",
      };
    }
    const contractEvidence = validateFileChangeContractEvidence(
      plan,
      targetFile,
      supportingFiles,
    );
    return {
      kind: "ticket_template_backed_new_api_target",
      ok: contractEvidence.ok,
      ...(contractEvidence.reason ? { reason: contractEvidence.reason } : {}),
      supportingFiles,
      rationaleRequired: true,
      rationalePresent: contractEvidence.rationalePresent,
      evidenceSource: contractEvidence.evidenceSource,
    };
  }

  const uiCandidate = candidates.find((candidate) =>
    isTicketBackedUiFeaturePath(targetFile, candidate),
  );
  if (!uiCandidate) {
    return undefined;
  }
  if (!isFrontendSourceExtension(targetFile) || isTestLikePath(targetFile)) {
    return undefined;
  }
  if (isGeneratedOrGlobalFrontendStyleFile(targetFile)) {
    return {
      kind: "ticket_template_backed_new_ui_target",
      ok: false,
      reason:
        "ticket-backed frontend target cannot be a generated or global style file",
      rationaleRequired: true,
      rationalePresent: Boolean(contractForTarget(plan, targetFile)?.rationale),
      evidenceSource: contractForTarget(plan, targetFile)
        ? "file_change_contract_evidence"
        : "missing_file_change_contract_evidence",
    };
  }
  const supportingFiles = frontendUiTemplateEvidence(
    targetFile,
    evidenceBackedFiles,
  );
  if (supportingFiles.length === 0) {
    return {
      kind: "ticket_template_backed_new_ui_target",
      ok: false,
      reason:
        "ticket-backed frontend target requires inspected repo UI template evidence",
      rationaleRequired: true,
      rationalePresent: Boolean(contractForTarget(plan, targetFile)?.rationale),
      evidenceSource: contractForTarget(plan, targetFile)
        ? "file_change_contract_evidence"
        : "missing_file_change_contract_evidence",
    };
  }
  const contract = contractForTarget(plan, targetFile);
  if (contract && !contractReferencesTicketFeature(contract, uiCandidate)) {
    return {
      kind: "ticket_template_backed_new_ui_target",
      ok: false,
      reason:
        "fileChangeContract supportingEvidence must cite ticket-backed frontend feature intent",
      supportingFiles,
      rationaleRequired: true,
      rationalePresent: Boolean(contract.rationale.trim()),
      evidenceSource: "file_change_contract_evidence",
    };
  }
  const contractEvidence = validateFileChangeContractEvidence(
    plan,
    targetFile,
    supportingFiles,
  );
  return {
    kind: "ticket_template_backed_new_ui_target",
    ok: contractEvidence.ok,
    ...(contractEvidence.reason ? { reason: contractEvidence.reason } : {}),
    supportingFiles,
    rationaleRequired: true,
    rationalePresent: contractEvidence.rationalePresent,
    evidenceSource: contractEvidence.evidenceSource,
  };
}

function validateAdjacentTargetRationale(
  spec: OneShotPlan["specs"][number],
  targetFile: string,
  adjacencySupportingFiles: string[],
): { ok: boolean; reason?: string; rationalePresent: boolean } {
  const rationale = rationaleForTarget(spec, targetFile);
  if (!rationale) {
    return {
      ok: false,
      reason: "adjacent target requires a targetFileRationales entry",
      rationalePresent: false,
    };
  }

  const evidenceSet = new Set(adjacencySupportingFiles.map(normalizePath));
  const hasEvidenceBackedSupport = rationale.supportingFiles
    .map(normalizePath)
    .some((file) => evidenceSet.has(file));
  if (!hasEvidenceBackedSupport) {
    return {
      ok: false,
      reason:
        "adjacent target rationale must reference at least one adjacency-supporting evidence file",
      rationalePresent: true,
    };
  }

  return { ok: true, rationalePresent: true };
}

function recoverableSourceRationaleFiles(
  spec: OneShotPlan["specs"][number],
  targetFile: string,
): string[] {
  const rationale = rationaleForTarget(spec, targetFile);
  if (!rationale) {
    return [];
  }
  return unique(
    rationale.supportingFiles
      .filter(isSafePlanTargetPath)
      .map(normalizePath)
      .filter((file) => file !== targetFile),
  );
}

export function validatePlanAgainstGrounding(
  plan: OneShotPlan,
  grounding?: PlannerGroundingContext,
  evidence?: PlannerEvidenceContext,
  options?: PlannerGroundingValidationOptions,
): PlannerGroundingValidationResult {
  const strong =
    isPlannerGroundingStrong(grounding) || isPlannerEvidenceStrong(evidence);
  if (!strong) {
    return {
      ok: true,
      errors: [],
      warnings: ["Grounding was not strong enough for target-file validation."],
      decisions: [],
    };
  }

  const supportedTargets = normalizedTargetSet(grounding, evidence, options);
  const evidenceBackedFiles = evidenceFiles(grounding, evidence, options);
  const finalPlannerDiscoveredFiles = unique(
    (options?.finalPlannerDiscoveredFiles ?? [])
      .map(normalizePath)
      .filter(isSafeWorkspaceRelativePath),
  );
  const recoveredSourceRationaleFiles = new Set(
    (options?.recoveredSourceRationaleFiles ?? []).map(normalizePath),
  );
  const errors: string[] = [];
  const warnings = [
    ...(grounding?.warnings ?? []),
    ...(evidence?.warnings ?? []),
  ];
  const decisions: PlannerTargetValidationDecision[] = [];
  const targetFiles = plan.specs.flatMap((spec) =>
    spec.targetFiles.map((file) => ({
      spec,
      raw: file,
      normalized: normalizePath(file),
    })),
  );
  const acceptedNewSourceTargets: string[] = [];

  for (const { spec, raw, normalized: targetFile } of targetFiles.filter(
    (file) => !isTestLikePath(file.normalized),
  )) {
    if (!isSafePlanTargetPath(raw)) {
      errors.push(
        `Plan target file "${targetFile}" is unsafe: target path is not a safe workspace-relative path.`,
      );
      decisions.push({
        rawTargetFile: raw,
        targetFile,
        kind: "rejected",
        ok: false,
        reason: "target path is not a safe workspace-relative path",
      });
      continue;
    }
    if (supportedTargets.has(targetFile)) {
      decisions.push({
        rawTargetFile: raw,
        targetFile,
        kind: "exact_evidence",
        ok: true,
      });
      continue;
    }
    const targetRecoveredSourceSupport = Array.from(
      recoveredSourceRationaleFiles,
    ).filter((file) => isRecoverableSourceRationaleSupport(targetFile, file));
    const recoveredSupportSet = new Set(
      targetRecoveredSourceSupport.map(normalizePath),
    );
    const adjacent = classifyAdjacentTarget(
      targetFile,
      [...evidenceBackedFiles, ...targetRecoveredSourceSupport],
      finalPlannerDiscoveredFiles,
    );
    if (adjacent.ok) {
      const adjacentSupport = adjacent.supportingFiles ?? [];
      const contractEvidence = validateFileChangeContractEvidence(
        plan,
        targetFile,
        adjacentSupport,
      );
      const hasContractEntry = Boolean(contractForTarget(plan, targetFile));
      const legacyRationale = hasContractEntry
        ? {
            ok: false,
            rationalePresent: Boolean(rationaleForTarget(spec, targetFile)),
          }
        : validateAdjacentTargetRationale(spec, targetFile, adjacentSupport);
      const validatedEvidence = hasContractEntry
        ? contractEvidence
        : legacyRationale.ok
          ? {
              ...legacyRationale,
              evidenceSource: "target_file_rationale_evidence" as const,
            }
          : {
              ...contractEvidence,
              reason: `${contractEvidence.reason}; legacy targetFileRationales fallback also failed: ${legacyRationale.reason}`,
              rationalePresent:
                contractEvidence.rationalePresent ||
                legacyRationale.rationalePresent,
            };
      const recoveredSupport = adjacentSupport.filter((file) =>
        recoveredSupportSet.has(normalizePath(file)),
      );
      const recoveryCandidates = recoverableSourceRationaleFiles(
        spec,
        targetFile,
      );
      const canAttemptSourceRecovery =
        adjacent.kind === "adjacent_source_or_mapping" &&
        !validatedEvidence.ok &&
        !hasContractEntry &&
        Boolean(rationaleForTarget(spec, targetFile)) &&
        recoveryCandidates.length > 0;
      const softAcceptSourceOrMapping =
        adjacent.kind === "adjacent_source_or_mapping" &&
        !validatedEvidence.ok &&
        !hasContractEntry &&
        recoveredSupport.length === 0;
      const decisionReason = softAcceptSourceOrMapping
        ? legacyRationale.reason
        : validatedEvidence.reason;
      decisions.push({
        rawTargetFile: raw,
        targetFile,
        kind:
          recoveredSupport.length > 0
            ? "source_accepted_via_rationale_recovery"
            : softAcceptSourceOrMapping
              ? "adjacent_source_accepted_soft"
            : canAttemptSourceRecovery
            ? "source_rationale_recovery_candidate"
              : (adjacent.kind ?? "adjacent_source_or_mapping"),
        ok: validatedEvidence.ok || softAcceptSourceOrMapping,
        ...(decisionReason ? { reason: decisionReason } : {}),
        supportingFiles: adjacentSupport,
        ...(canAttemptSourceRecovery
          ? { recoveryCandidateFiles: recoveryCandidates }
          : {}),
        rationaleRequired: true,
        rationalePresent: validatedEvidence.rationalePresent,
        evidenceSource: softAcceptSourceOrMapping
          ? "target_file_rationale_evidence"
          : validatedEvidence.evidenceSource,
      });
      if (!validatedEvidence.ok) {
        if (softAcceptSourceOrMapping) {
          warnings.push(
            `Plan target file "${targetFile}" was accepted as an adjacent source or mapping target without complete targetFileRationales evidence.`,
          );
          acceptedNewSourceTargets.push(targetFile);
          continue;
        }
        errors.push(
          `Plan target file "${targetFile}" is not backed by planner evidence: ${validatedEvidence.reason}.`,
        );
        continue;
      }
      if (recoveredSupport.length > 0) {
        warnings.push(
          `Plan target file "${targetFile}" was accepted via exact-path source rationale recovery.`,
        );
      }
      acceptedNewSourceTargets.push(targetFile);
      continue;
    }
    const ticketExplicitDecision = validateTicketExplicitNewSourceTarget(
      plan,
      targetFile,
      evidenceBackedFiles,
      grounding?.ticketExplicitNewSourceCandidates ?? [],
    );
    if (ticketExplicitDecision) {
      decisions.push(ticketExplicitDecision);
      if (ticketExplicitDecision.ok) {
        warnings.push(
          `Plan target file "${targetFile}" was accepted as a ticket-explicit new Java source target backed by repo module evidence.`,
        );
        acceptedNewSourceTargets.push(targetFile);
        continue;
      }
      errors.push(
        `Plan target file "${targetFile}" is not backed by planner evidence: ${ticketExplicitDecision.reason}.`,
      );
      continue;
    }
    const ticketBackedFrontend = ticketBackedFrontendDecision(
      plan,
      targetFile,
      evidenceBackedFiles,
      grounding?.frontendFeatureCandidates ?? [],
    );
    if (ticketBackedFrontend) {
      decisions.push({
        rawTargetFile: raw,
        targetFile,
        ...ticketBackedFrontend,
      });
      if (!ticketBackedFrontend.ok) {
        errors.push(
          `Plan target file "${targetFile}" is not backed by planner evidence: ${ticketBackedFrontend.reason}.`,
        );
        continue;
      }
      warnings.push(
        `Plan target file "${targetFile}" was accepted as a ticket-backed new frontend target backed by repo template evidence.`,
      );
      acceptedNewSourceTargets.push(targetFile);
      continue;
    }
    errors.push(
      `Plan target file "${targetFile}" is not backed by planner evidence: ${adjacent.reason}.`,
    );
    decisions.push({
      rawTargetFile: raw,
      targetFile,
      kind: "rejected",
      ok: false,
      reason: adjacent.reason,
    });
  }

  const allowAdjacentTestWithRationale =
    options?.allowAdjacentTestWithRationale !== false;

  for (const { spec, raw, normalized: targetFile } of targetFiles.filter(
    (file) => isTestLikePath(file.normalized),
  )) {
    if (!isSafePlanTargetPath(raw)) {
      errors.push(
        `Plan target file "${targetFile}" is unsafe: target path is not a safe workspace-relative path.`,
      );
      decisions.push({
        rawTargetFile: raw,
        targetFile,
        kind: "rejected",
        ok: false,
        reason: "target path is not a safe workspace-relative path",
      });
      continue;
    }
    const adjacentTest = classifyAdjacentTestTarget(
      targetFile,
      grounding,
      evidence,
      evidenceBackedFiles,
      acceptedNewSourceTargets,
    );
    if (supportedTargets.has(targetFile)) {
      decisions.push({
        rawTargetFile: raw,
        targetFile,
        kind: "exact_evidence",
        ok: true,
      });
      continue;
    }
    if (adjacentTest.ok) {
      const adjacentSupport = adjacentTest.supportingFiles ?? [];
      if (adjacentTest.kind === "adjacent_colocated_test") {
        const contractEvidence = validateFileChangeContractEvidence(
          plan,
          targetFile,
          adjacentSupport,
        );
        const hasContractEntry = Boolean(contractForTarget(plan, targetFile));
        const legacyRationale = hasContractEntry
          ? {
              ok: false,
              rationalePresent: Boolean(rationaleForTarget(spec, targetFile)),
            }
          : validateAdjacentTargetRationale(
              spec,
              targetFile,
              adjacentSupport,
            );
        const validatedEvidence = hasContractEntry
          ? contractEvidence
          : legacyRationale.ok
            ? {
                ...legacyRationale,
                evidenceSource: "target_file_rationale_evidence" as const,
              }
            : {
                ...contractEvidence,
                reason: `${contractEvidence.reason}; legacy targetFileRationales fallback also failed: ${legacyRationale.reason}`,
                rationalePresent:
                  contractEvidence.rationalePresent ||
                  legacyRationale.rationalePresent,
              };
        decisions.push({
          rawTargetFile: raw,
          targetFile,
          kind: "adjacent_colocated_test",
          ok: validatedEvidence.ok,
          supportingFiles: adjacentSupport,
          ...(validatedEvidence.reason
            ? { reason: validatedEvidence.reason }
            : {}),
          rationaleRequired: true,
          rationalePresent: validatedEvidence.rationalePresent,
          evidenceSource: validatedEvidence.evidenceSource,
        });
        if (!validatedEvidence.ok) {
          errors.push(
            `Plan target file "${targetFile}" is not backed by planner evidence: ${validatedEvidence.reason}.`,
          );
          continue;
        }
        warnings.push(
          `Plan target file "${targetFile}" was accepted as a colocated test target backed by source evidence.`,
        );
        continue;
      }
      decisions.push({
        rawTargetFile: raw,
        targetFile,
        kind: adjacentTest.kind ?? "adjacent_test",
        ok: true,
        ...(adjacentSupport.length > 0
          ? { supportingFiles: adjacentSupport }
          : {}),
      });
      if (adjacentTest.kind === "adjacent_test_scenario_soft") {
        warnings.push(
          `Plan target file "${targetFile}" was accepted as a Java scenario test target backed by same-package source evidence.`,
        );
      }
      if (adjacentTest.kind === "same_package_java_test_accepted_soft") {
        warnings.push(
          `Plan target file "${targetFile}" was accepted as a same-package Java test target backed by source evidence.`,
        );
      }
      continue;
    }
    if (isTestFixtureExtension(targetFile)) {
      const sameDirEvidence = evidenceInSameDirectory(
        targetFile,
        evidenceBackedFiles,
      );
      if (sameDirEvidence.length > 0) {
        const rationale = validateAdjacentTargetRationale(
          spec,
          targetFile,
          sameDirEvidence,
        );
        if (rationale.ok) {
          decisions.push({
            rawTargetFile: raw,
            targetFile,
            kind: "adjacent_test_fixture",
            ok: true,
            supportingFiles:
              rationaleForTarget(spec, targetFile)?.supportingFiles.map(
                normalizePath,
              ) ?? [],
            rationaleRequired: true,
            rationalePresent: true,
          });
          warnings.push(
            `Plan target file "${targetFile}" was accepted as an adjacent test fixture backed by an inspected sibling.`,
          );
          continue;
        }
        const siblingList = sameDirEvidence
          .map((file) => `"${file}"`)
          .join(", ");
        errors.push(
          `Plan target file "${targetFile}" is not backed by planner evidence: ` +
            `new test fixture target requires a targetFileRationales entry citing an inspected sibling file in the same directory ` +
            `(found evidence-backed siblings: ${siblingList}).`,
        );
        decisions.push({
          rawTargetFile: raw,
          targetFile,
          kind: "rejected",
          ok: false,
          reason:
            "new test fixture target requires a targetFileRationales entry citing an inspected sibling file in the same directory",
          supportingFiles: sameDirEvidence,
          rationaleRequired: true,
          rationalePresent: Boolean(rationaleForTarget(spec, targetFile)),
        });
        continue;
      }
    }
    if (allowAdjacentTestWithRationale) {
      const rationale = validateAdjacentTargetRationale(
        spec,
        targetFile,
        evidenceBackedFiles,
      );
      if (rationale.ok) {
        decisions.push({
          rawTargetFile: raw,
          targetFile,
          kind: "adjacent_test_accepted_soft",
          ok: true,
          supportingFiles:
            rationaleForTarget(spec, targetFile)?.supportingFiles.map(
              normalizePath,
            ) ?? [],
          rationaleRequired: true,
          rationalePresent: true,
        });
        warnings.push(
          `Plan target file "${targetFile}" was accepted as an adjacent test target with rationale-backed evidence.`,
        );
        continue;
      }
    }
    errors.push(
      `Plan target file "${targetFile}" is not backed by planner evidence: test target does not match evidence-backed source or accepted new source target.`,
    );
    decisions.push({
      rawTargetFile: raw,
      targetFile,
      kind: "rejected",
      ok: false,
      reason:
        "test target does not match evidence-backed source or accepted new source target",
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    decisions,
  };
}

const GROUNDED_DISCOVERY_PATTERN_CAP = 900;

function compactDiscoveryPattern(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= GROUNDED_DISCOVERY_PATTERN_CAP) {
    return trimmed;
  }
  return `${trimmed.slice(0, GROUNDED_DISCOVERY_PATTERN_CAP - 3).trimEnd()}...`;
}

function formatGroundedSourceTestPairs(
  pairs: PlannerGroundingSourceTestPair[],
): string[] {
  if (pairs.length === 0) {
    return [];
  }
  const shownPairs = pairs.slice(0, 3).map((pair) => {
    const tests = pair.testFiles.slice(0, 2).join(", ");
    const moreTests =
      pair.testFiles.length > 2 ? `, +${pair.testFiles.length - 2} more` : "";
    return `${pair.sourceFile} -> ${tests}${moreTests}`;
  });
  const suffix =
    pairs.length > shownPairs.length
      ? `; +${pairs.length - shownPairs.length} more pairs`
      : "";
  return [
    compactDiscoveryPattern(
      `Grounded source/test pairs: ${shownPairs.join("; ")}${suffix}`,
    ),
  ];
}

function formatScoutEvidencePatterns(
  evidence?: PlannerEvidenceContext,
): string[] {
  const reports = validScoutReports(evidence);
  if (reports.length === 0) {
    return [];
  }
  const shownReports = reports
    .slice(0, 3)
    .map(
      (report) =>
        `${report.workItemId}: ${report.verifiedInspectedFiles.slice(0, 3).join(", ")}${
          report.verifiedInspectedFiles.length > 3
            ? `, +${report.verifiedInspectedFiles.length - 3} more`
            : ""
        }`,
    );
  const suffix =
    reports.length > shownReports.length
      ? `; +${reports.length - shownReports.length} more reports`
      : "";
  return [
    compactDiscoveryPattern(
      `Scout evidence: ${shownReports.join("; ")}${suffix}`,
    ),
  ];
}

export function applyGroundingToPlan(
  plan: OneShotPlan,
  grounding?: PlannerGroundingContext,
  evidence?: PlannerEvidenceContext,
): OneShotPlan {
  if (!grounding && !evidence) {
    return plan;
  }

  const existingDiscoveries = plan.plannerDiscoveries ?? {
    entryPoints: [],
    relevantPatterns: [],
    keyDependencies: [],
  };
  const groundedEntryPoints = (grounding?.candidateFiles ?? [])
    .filter((candidate) => candidate.exists)
    .slice(0, 6)
    .map((candidate) => candidate.path);
  const qualificationEntryPoints = [
    ...(grounding?.qualificationEvidence?.verifiedInspectedFiles ?? []),
    ...(evidence?.qualificationEvidence?.verifiedInspectedFiles ?? []),
  ];
  const scoutEntryPoints = validScoutReports(evidence).flatMap(
    (report) => report.verifiedInspectedFiles,
  );
  const sourceTestPatterns = formatGroundedSourceTestPairs(
    grounding?.sourceTestPairs ?? [],
  );
  const scoutPatterns = formatScoutEvidencePatterns(evidence);

  return {
    ...plan,
    plannerDiscoveries: {
      buildCommand: existingDiscoveries.buildCommand ?? grounding?.buildCommand,
      testCommand: existingDiscoveries.testCommand ?? grounding?.testCommand,
      testPattern: existingDiscoveries.testPattern ?? grounding?.testPattern,
      entryPoints: unique([
        ...(existingDiscoveries.entryPoints ?? []),
        ...groundedEntryPoints,
        ...qualificationEntryPoints,
        ...scoutEntryPoints,
      ]).slice(0, 10),
      relevantPatterns: unique([
        ...(existingDiscoveries.relevantPatterns ?? []),
        ...(grounding
          ? [
              `Deterministic grounding confidence: ${grounding.confidence}; candidate files: ${grounding.candidateFiles.length}; snippets: ${grounding.snippets.length}.`,
            ]
          : []),
        ...sourceTestPatterns,
        ...scoutPatterns,
      ]).slice(0, 10),
      keyDependencies: unique([
        ...(existingDiscoveries.keyDependencies ?? []),
      ]).slice(0, 15),
    },
  };
}
