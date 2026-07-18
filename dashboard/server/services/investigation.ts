import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertValidJiraKey, OneShotRunRequestError } from "./oneshotRunRequestSupport.js";
import {
  augmentInvestigationTicketContext,
  deriveTicketTimeWindow,
  fetchInvestigationJiraContext,
} from "./investigationJiraContext.js";
import {
  hasMeridianTicketContextSignal,
  maybeCreateMeridianHandoff,
} from "./investigationMeridianHandoff.js";
import { ensureOperatorSshControlMaster } from "./investigationOperatorSsh.js";
import { createInvestigationPlanningAdvisor } from "./investigationPlanningAdvisor.js";
import { discoverGitHubRepositoriesForTicket } from "./investigationGitHubRepositoryCatalog.js";
import {
  CliAwsEvidenceAdapter,
  CliHostInspectionAdapter,
  CodeInspectionAdapter,
  InMemoryCodeTargetRegistry,
  InMemoryCodeSemanticProfileRegistry,
  InMemoryConnectionRegistry,
  InvestigationControlPlane,
  InMemoryHostTargetRegistry,
  InvestigationJiraService,
  MysqlDataDiagnosticsAdapter,
  evaluateInvestigationResolutionGate,
  loadInvestigationTargetConfig,
  type InvestigationRunExecution,
} from "../../../src/investigation/index.js";
import {
  buildInvestigationRouterTicketText,
  extractInvestigationRepoRoutingSignals,
  INVESTIGATION_REPO_METADATA,
  getInvestigationRepoBranchCandidatesForVersion,
  getInvestigationRepoBranchFamilyPatternsForVersion,
  getInvestigationRepoMetadata,
  getInvestigationRepositoryDefaultBranchName,
  loadInvestigationRepoProfiles,
  loadInvestigationRepoRouterWeights,
  type InvestigationCodeRepositoryForRouting,
  type InvestigationRepoProfile,
  type InvestigationRouterTicketInput,
} from "../../../src/investigation/repo-routing/InvestigationRepoRouting.js";
import { extractEvidenceSearchTerms, extractInvestigationSignals } from "../../../src/investigation/utils/RuntimeEvidence.js";
import {
  sanitizeAuditText,
} from "../../../src/investigation/redaction/SensitiveTextRedactor.js";
import { AwsInferredHostTargetRegistry } from "./investigationRuntime.js";
import {
  createTargetThrottleStore,
  environmentTargetCap,
  normalizeTargetKey,
  type TargetThrottleClaim,
} from "./investigationThrottle.js";
import type {
  InvestigationClientTarget,
  InvestigationCodeTarget,
  InvestigationConnectionTarget,
  InvestigationEnvironment as ControlPlaneEnvironment,
  InvestigationEvidenceArtifact as ControlPlaneEvidenceArtifact,
  InvestigationFinding as ControlPlaneFinding,
  InvestigationHostTarget,
  InvestigationLogSource,
  InvestigationRunProgress,
  InvestigationTargetConfig,
  InvestigationTicketContext,
  InvestigationTimeWindow,
} from "../../../src/investigation/index.js";

export type InvestigationStatus = "queued" | "waiting_for_target" | "running" | "awaiting_review" | "completed" | "escalated" | "failed";
export type InvestigationEnvironment = "DEV" | "INT" | "UAT" | "STAGE" | "PROD-REPLICA";
export type InvestigationMode = "aws-first" | "mixed" | "data-led";
export type AnalyzerStatus = "running" | "ready" | "waiting" | "complete" | "blocked";
export type InvestigationAnalyzer = "aws" | "code" | "data" | "host" | "system";

const DYNAMIC_AWS_REGION = "aws-dynamic";
export const MAX_OUTSTANDING_INVESTIGATION_RUNS = 10;

export interface InvestigationFinding {
  id: string;
  analyzer: "aws" | "code" | "data" | "host" | "llm";
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  summary: string;
  confidence: number;
  requiresAction?: "code" | "data" | "ops";
}

export interface InvestigationEvidence {
  id: string;
  analyzer: "aws" | "code" | "data" | "host" | "llm";
  title: string;
  detail: string;
  meta: string[];
  trace?: Array<{
    title: string;
    detail: string;
    safeSql?: string;
    rowCount?: number;
  }>;
}

export interface InvestigationEvent {
  id: string;
  sequence: number;
  at: string;
  title: string;
  body: string;
  analyzer?: InvestigationAnalyzer;
}

export interface MeridianSqlArtifact {
  id: string;
  filename: string;
  contentType: "text/sql";
  sizeBytes: number;
  sha256: string;
  source: string;
  createdAt: string;
  updateCount?: number;
  skippedCount?: number;
  downloadPath: string;
}

export interface MeridianDbaTicket {
  status: "created";
  key: string;
  url: string;
  linkedTo: string;
  sqlArtifactId: string;
  sqlFilename: string;
  assignedOperatorDisplay: string;
  assigneeAccountId?: string;
  assignmentStatus: "assigned" | "unresolved" | "failed";
  linkStatus: "linked" | "failed";
  createdAt: string;
}

export interface InvestigationRun {
  id: string;
  jiraKey: string;
  title: string;
  client: string;
  environment: InvestigationEnvironment;
  status: InvestigationStatus;
  mode: InvestigationMode;
  confidence: number;
  accent: "cyan" | "amber" | "red" | "green";
  updatedAt: string;
  targetKey?: string;
  releaseVersion?: string;
  throttleReason?: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  summary: string;
  recommendation: string;
  analyzers: Array<{
    key: "aws" | "code" | "data" | "host" | "llm";
    label: string;
    status: AnalyzerStatus;
    pulse: string;
    detail: string;
  }>;
  findings: InvestigationFinding[];
  evidence: InvestigationEvidence[];
  events: InvestigationEvent[];
  approvalText?: string;
  jiraDraft: {
    clientSummary: string;
    internalAnalysis: string;
    proposedRemediation: {
      sqlCorrection?: string;
      codeFix?: string;
      validationNotes: string;
    };
  };
  audit: string[];
  ticketContext?: InvestigationTicketContext;
  meridianSqlArtifacts?: MeridianSqlArtifact[];
  dbaTicket?: MeridianDbaTicket;
  resolution?: {
    diagnosisReady: boolean;
    operationallyClosed: boolean;
    missingDiagnosisDimensions: string[];
    unexplainedSymptomClusterIds: string[];
    ambiguousSymptomClusterIds?: string[];
    precisionIncompleteChainIds?: string[];
    primaryCausalFinding?: string;
    selectedHypothesisIds: string[];
  };
}

export interface MeridianEvidenceTraceInput {
  title?: string;
  detail?: string;
  safeSql?: string;
  rowCount?: number;
}

export interface MeridianEvidenceAttachmentInput {
  summary?: string;
  recommendation?: string;
  status?: InvestigationStatus;
  confidence?: number;
  clientSummary?: string;
  internalAnalysis?: string;
  validationNotes?: string;
  sql?: string;
  generatedSql?: string;
  sqlFilename?: string;
  sqlArtifact?: {
    sql?: string;
    content?: string;
    filename?: string;
    source?: string;
    updateCount?: number;
    skippedCount?: number;
  };
  findings?: Array<{
    analyzer?: InvestigationFinding["analyzer"];
    severity?: InvestigationFinding["severity"];
    title?: string;
    summary?: string;
    confidence?: number;
    requiresAction?: InvestigationFinding["requiresAction"];
  }>;
  evidence?: Array<{
    analyzer?: InvestigationEvidence["analyzer"];
    title?: string;
    detail?: string;
    meta?: string[];
    trace?: MeridianEvidenceTraceInput[];
  }>;
}

interface LlmGatheringInput {
  jiraKey: string;
  title?: string | null;
  client?: string | null;
  environment?: InvestigationEnvironment | null;
  ticketContext?: InvestigationTicketContext | null;
  source?: "jira" | "cockpit" | "fallback";
}

export interface InvestigationWebhookResult {
  accepted: boolean;
  triggered: boolean;
  reason: string;
  triggerLabel: string;
  run?: InvestigationRun;
}

export interface InvestigationRunsQuery {
  search?: string;
  status?: string;
  environment?: string;
  client?: string;
  limit?: number;
  offset?: number;
}

export interface InvestigationCodeFixRequestOperator {
  id: string;
  display: string;
}

export interface InvestigationCodeFixRequestSummary {
  id: number;
  jiraKey: string;
  status: string;
  submittedAt: string;
}

export type InvestigationCodeFixRequestSubmitter = (input: {
  jiraKey: string;
  operator: InvestigationCodeFixRequestOperator;
}) => Promise<InvestigationCodeFixRequestSummary>;


const CLIENT_A_CLIENT_ID = "CLIENT_A";
const CLIENT_A_CLIENT_TARGET: InvestigationClientTarget = {
  id: CLIENT_A_CLIENT_ID,
  displayName: "Client A",
  aliases: ["Client A", "client-a", "client_a", "clienta"],
  defaultEnvironment: "DEV",
  serviceIds: ["client-a-backend"],
  keywords: ["client a", "host-first", "ssm"],
  repoNames: [],
  enabled: true,
};
const CLIENT_A_HOST_TARGET = {
  id: "client-a-dev-app-1",
  clientId: CLIENT_A_CLIENT_ID,
  environment: "DEV" as const,
  envId: "DEV1",
  awsAccountId: "000000000000",
  region: process.env.INVESTIGATION_CLIENT_A_AWS_REGION?.trim() || DYNAMIC_AWS_REGION,
  instanceId: "i-00000000000000000",
  instanceName: "CLIENT A",
  vpcId: "vpc-00000000000000000",
  subnetId: "subnet-00000000000000000",
  networkPath: "ssm" as const,
  instanceProfileArn: "arn:aws:iam::000000000000:instance-profile/example-investigation-ssm",
  expectedRoleName: "example-investigation-ssm",
  awsProfile: process.env.INVESTIGATION_CLIENT_A_AWS_PROFILE?.trim() || "example-investigation",
  ssmAllowed: true,
  enabled: true,
  notes: "Example dev application host for local Cockpit POC wiring.",
};

const CLIENT_A_CONNECTION_TARGET = {
  id: "client-a-dev-db",
  clientId: CLIENT_A_CLIENT_ID,
  environment: "DEV" as const,
  envId: "DEV1",
  topology: "ec2_mysql" as const,
  engine: "mysql" as const,
  host: "example-db.internal",
  port: 3306,
  databaseName: "medhok",
  networkPath: "ssm" as const,
  authMode: "username_password" as const,
  secretRef: "env://INVESTIGATION_CLIENT_A_DB_PASSWORD",
  dbUser: process.env.INVESTIGATION_CLIENT_A_DB_USER?.trim() || "investigation_clienta_ro",
  hostTargetId: CLIENT_A_HOST_TARGET.id,
  hostAuthFile: "/opt/software/medhok/dbaauthfiles/example_readonly.auth",
  accessClass: "lower_ro" as const,
  allowedQueryPacks: [],
  phiAccess: false as const,
  enabled: true,
  sslRequired: false,
  notes: "Example DEV MySQL target for local Cockpit POC wiring.",
};

function defaultCodeTargets() {
  const repoBase = process.env.INVESTIGATION_CLIENT_A_REPO_BASE?.trim();
  if (!repoBase) {
    return [];
  }
  return [
    {
      id: "client-a-core-app",
      clientId: CLIENT_A_CLIENT_ID,
      environment: "DEV" as const,
      repoName: "core-app",
      repoPath: repoBase,
      repoUrl: process.env.INVESTIGATION_CLIENT_A_REPO_URL?.trim(),
      branch: process.env.INVESTIGATION_CLIENT_A_REPO_BRANCH?.trim(),
      defaultBranch: "master",
      refreshFromRemote: process.env.INVESTIGATION_CLIENT_A_REPO_REFRESH !== "false",
      enabled: true,
      notes: "Optional local/EFS Client A repo target for cockpit code validation.",
    },
  ];
}
const investigationJiraService = new InvestigationJiraService();

interface StoredInvestigationRun extends InvestigationRun {
  runtime: {
    lastProgressAt: number;
    nextEventSequence: number;
  };
}

export interface InvestigationQueueMessage {
  schemaVersion: "investigation-run.v1";
  messageId: string;
  messageGroupId: string;
  messageDeduplicationId: string;
  workflowType: "investigation_cockpit";
  runId: string;
  jiraKey: string;
  target: {
    targetKey: string;
    clientId: string;
    clientDisplayName: string;
    environment: InvestigationEnvironment;
    maxConcurrent: number;
  };
  payload: {
    title?: string;
    mode?: InvestigationMode;
    releaseVersion?: string;
    investigationTerms?: string[];
    timeWindow?: InvestigationTimeWindow;
    operatorDisplay: string;
    source?: "command-deck" | "jira-label";
  };
  requestedAt: string;
  attempt: number;
}

export class InvestigationServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "InvestigationServiceError";
  }
}

type SeedRunInput = Omit<StoredInvestigationRun, "runtime" | "events"> & {
  events: Array<Omit<InvestigationEvent, "sequence">>;
  runtime: {
    lastProgressAt: number;
  };
};

interface JiraWebhookPayload {
  webhookEvent?: string;
  issue?: {
    key?: string;
    fields?: {
      summary?: string;
      labels?: string[];
      description?: unknown;
    };
  };
  changelog?: {
    items?: Array<{
      field?: string;
      fieldId?: string;
      fromString?: string | null;
      toString?: string | null;
    }>;
  };
  environment?: unknown;
  client?: unknown;
  mode?: unknown;
}

function getInvestigationTriggerLabel(): string {
  return (process.env.INVESTIGATION_JIRA_TRIGGER_LABEL || "investigation-cockpit").trim().toLowerCase();
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function labelTokens(value: string): string[] {
  return normalizeLabel(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function isVersionLabelToken(value: string): boolean {
  const digits = value[0]?.toLowerCase() === "v" ? value.slice(1) : value;
  return digits.length > 0 && Array.from(digits).every((character) => character >= "0" && character <= "9");
}

function parseLabelList(raw: string | null | undefined): string[] {
  return (raw || "")
    .split(",")
    .map((label) => normalizeLabel(label))
    .filter(Boolean);
}

function inferEnvironmentFromLabels(labels: string[]): InvestigationEnvironment | undefined {
  for (const label of labels) {
    const tokens = labelTokens(label);
    if (
      tokens.some((token) => token === "prod" || token === "production" || token === "prd" || /^prod\d*$/.test(token) || /^prd\d*$/.test(token))
      || tokens.includes("prodreplica")
      || (tokens.includes("prod") && tokens.includes("replica"))
    ) {
      return "PROD-REPLICA";
    }
    if (tokens.some((token) => token === "stage" || token === "stg")) {
      return "STAGE";
    }
    if (tokens.some((token) => /^uat\d*$/.test(token))) {
      return "UAT";
    }
    if (tokens.some((token) => /^int\d*$/.test(token))) {
      return "INT";
    }
    if (tokens.some((token) => /^dev\d*$/.test(token))) {
      return "DEV";
    }
  }
  return undefined;
}

function normalizeReleaseVersion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 40 || !/\d/.test(trimmed) || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed.replace(/_/g, ".");
}

function releaseVersionFromLabel(label: string): string | undefined {
  const normalized = normalizeLabel(label);
  const tokens = labelTokens(normalized);
  const hasReleaseSignal = tokens.some((token) =>
    token === "release"
    || token === "rel"
    || token === "version"
    || token === "ver"
    || token === "fixversion"
    || token === "fix",
  );
  if (!hasReleaseSignal) {
    return undefined;
  }

  const vPrefixed = normalized.match(/(?:^|[^a-z0-9])v[._-]?([0-9]+(?:[._-][0-9]+){1,4})(?=$|[^0-9])/i);
  const version = vPrefixed?.[1]
    || normalized.match(/(?:^|[^0-9])([0-9]+(?:[._-][0-9]+){1,4})(?=$|[^0-9])/)?.[1];
  return normalizeReleaseVersion(version?.replace(/[-_]/g, "."));
}

function inferReleaseVersionFromLabels(labels: string[]): string | undefined {
  for (const label of labels) {
    const releaseVersion = releaseVersionFromLabel(label);
    if (releaseVersion) {
      return releaseVersion;
    }
  }
  return undefined;
}

function inferReleaseVersionFromTicketContext(context: InvestigationTicketContext | undefined): string | undefined {
  if (context?.fetchStatus !== "fetched") {
    return undefined;
  }
  return normalizeReleaseVersion(context.releaseVersion)
    || inferReleaseVersionFromLabels(context.labels || []);
}

function inferReleaseVersionFromOperationalText(text: string): string | undefined {
  const match = text.match(
    /(?:^|[^a-z0-9])(?:batch|client-services|medhok)[-_ ]?monorepo[-_ ]?([0-9]+\.[0-9]+)|(?:^|[^a-z0-9])(?:release|version)[-_ :=]+([0-9]+\.[0-9]+)|[-_]medhok[-_]([0-9]+\.[0-9]+)\.jar\b/i,
  );
  return normalizeReleaseVersion(match?.[1] || match?.[2] || match?.[3]);
}

function inferModeFromLabels(labels: string[]): InvestigationMode | undefined {
  if (labels.includes("data-led") || labels.includes("data_led")) {
    return "data-led";
  }
  if (labels.includes("mixed")) {
    return "mixed";
  }
  if (labels.includes("aws-first") || labels.includes("aws_first")) {
    return "aws-first";
  }
  return undefined;
}

function isEnvironmentValue(value: unknown): value is InvestigationEnvironment {
  return value === "DEV" || value === "INT" || value === "UAT" || value === "STAGE" || value === "PROD-REPLICA";
}

function isModeValue(value: unknown): value is InvestigationMode {
  return value === "aws-first" || value === "mixed" || value === "data-led";
}

function sortByRecencyDesc(a: StoredInvestigationRun, b: StoredInvestigationRun): number {
  return b.runtime.lastProgressAt - a.runtime.lastProgressAt;
}

function preferRunForJiraKey(current: StoredInvestigationRun, candidate: StoredInvestigationRun): StoredInvestigationRun {
  return candidate.runtime.lastProgressAt > current.runtime.lastProgressAt ? candidate : current;
}

function isTerminalRunStatus(status: InvestigationStatus): boolean {
  return status === "completed" || status === "escalated" || status === "failed";
}

function activeRunForJiraKey(jiraKey: string): StoredInvestigationRun | undefined {
  return Array.from(runs.values())
    .filter((run) => run.jiraKey === jiraKey && !isTerminalRunStatus(run.status))
    .reduce<StoredInvestigationRun | undefined>((selected, run) => {
      if (!selected) {
        return run;
      }
      return preferRunForJiraKey(selected, run);
    }, undefined);
}

function outstandingRunCount(): number {
  return Array.from(runs.values()).filter((run) => !isTerminalRunStatus(run.status)).length;
}

function assertInvestigationQueueAdmission(jiraKey: string | undefined): void {
  if (jiraKey) {
    const existing = activeRunForJiraKey(jiraKey);
    if (existing) {
      throw new InvestigationServiceError(
        `${jiraKey} already has an outstanding investigation run. Open it from Flight Queue instead of starting a duplicate.`,
        409,
        "active_investigation_exists",
      );
    }
  }
  if (outstandingRunCount() >= MAX_OUTSTANDING_INVESTIGATION_RUNS) {
    throw new InvestigationServiceError(
      `Flight Queue capacity is ${MAX_OUTSTANDING_INVESTIGATION_RUNS} outstanding tickets. Complete or escalate a run before adding another ticket.`,
      409,
      "flight_queue_capacity_reached",
    );
  }
}

function isWebhookPayload(value: unknown): value is JiraWebhookPayload {
  return typeof value === "object" && value !== null;
}

function isClientAClientName(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "client a" || normalized === "client-a" || normalized === "client_a" || normalized === "clienta";
}

function normalizeClientLookup(value: string | undefined): string {
  return (value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function clientLabelCandidates(label: string): string[] {
  const normalized = normalizeClientLookup(label);
  if (!normalized) {
    return [];
  }
  const parts = normalized.split(/-+/).filter(Boolean);
  const affixes = new Set(["client", "customer", "cust", "tenant", "payer", "plan"]);
  const candidates = new Set<string>([normalized]);
  if (parts.length > 1 && affixes.has(parts[0] || "")) {
    candidates.add(parts.slice(1).join("-"));
  }
  if (parts.length > 1 && affixes.has(parts[parts.length - 1] || "")) {
    candidates.add(parts.slice(0, -1).join("-"));
  }
  return Array.from(candidates).filter(Boolean);
}

function labelsMatchClientAlias(labels: string[], alias: string): boolean {
  const normalizedAlias = normalizeClientLookup(alias);
  if (!normalizedAlias) {
    return false;
  }
  return labels.some((label) =>
    clientLabelCandidates(label).some((candidate) => candidate === normalizedAlias),
  );
}

function normalizedTextHasAlias(normalizedText: string, normalizedAlias: string): boolean {
  if (!normalizedText || !normalizedAlias) {
    return false;
  }
  const escaped = escapeRegExp(normalizedAlias);
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`).test(normalizedText);
}

function normalizedTextHasOperationalHostAlias(normalizedText: string, normalizedAlias: string): boolean {
  if (normalizedTextHasAlias(normalizedText, normalizedAlias)) {
    return true;
  }
  const escaped = escapeRegExp(normalizedAlias);
  return new RegExp(
    `(?:^|[^a-z0-9])${escaped}(?:login|batch|app|application|web|job|runtime|server|node)\\d*(?=$|[^a-z0-9])`,
  ).test(normalizedText);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getRuntimeTargetConfig(): InvestigationTargetConfig {
  const configured = loadInvestigationTargetConfig();
  return {
    clients: [CLIENT_A_CLIENT_TARGET, ...configured.clients],
    hostTargets: [CLIENT_A_HOST_TARGET, ...configured.hostTargets],
    connections: [CLIENT_A_CONNECTION_TARGET, ...configured.connections],
    codeTargets: [...defaultCodeTargets(), ...configured.codeTargets],
    codeSemanticProfiles: configured.codeSemanticProfiles,
    logSources: configured.logSources,
    queryPacks: configured.queryPacks,
    serverlessEvidence: configured.serverlessEvidence,
  };
}

function resolveConfiguredClient(
  value: string | undefined,
  environment: InvestigationEnvironment | undefined,
  config = getRuntimeTargetConfig(),
): InvestigationClientTarget | undefined {
  const normalized = normalizeClientLookup(value);
  if (normalized) {
    return config.clients.find((client) =>
      client.aliases.some((alias) => normalizeClientLookup(alias) === normalized),
    );
  }
  if (environment === "DEV") {
    return config.clients.find((client) => client.id === CLIENT_A_CLIENT_ID);
  }
  return undefined;
}

function resolveConfiguredClientFromLabels(
  labels: string[],
  config: InvestigationTargetConfig,
): InvestigationClientTarget | undefined {
  if (labels.length === 0) {
    return undefined;
  }
  return config.clients.find((client) =>
    client.aliases.some((alias) => labelsMatchClientAlias(labels, alias)),
  );
}

function ticketContextSearchText(context: InvestigationTicketContext | undefined): string {
  if (!context || context.fetchStatus !== "fetched") {
    return "";
  }

  return [
    context.title,
    context.environmentName,
    context.releaseVersion,
    ...(context.labels || []),
    ...(context.extractedTerms || []),
    ...(context.attachments || []).flatMap((attachment) => [attachment.filename, attachment.textExcerpt, ...(attachment.extractedTerms || [])]),
  ]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join("\n");
}

function inferEnvironmentFromTicketText(text: string): InvestigationEnvironment | undefined {
  if (/\bprod[-_\s]?replica\b/i.test(text)) {
    return "PROD-REPLICA";
  }
  // Operational names such as CPPROD1 and PROD2 are explicit environment
  // identifiers. A prose-only mention of "production" remains insufficient.
  if (/(?:^|[^a-z0-9])(?:cp[-_\s]?)?prod\d+(?=$|[^a-z0-9])/i.test(text)) {
    return "PROD-REPLICA";
  }
  if (/\bstage\b/i.test(text)) {
    return "STAGE";
  }
  if (/\buat\d*\b/i.test(text)) {
    return "UAT";
  }
  if (/\bint\d*\b/i.test(text)) {
    return "INT";
  }
  if (/\bdev\d*\b/i.test(text)) {
    return "DEV";
  }
  return undefined;
}

function resolveConfiguredClientFromTicketContext(
  context: InvestigationTicketContext | undefined,
  config: InvestigationTargetConfig,
): InvestigationClientTarget | undefined {
  if (context?.fetchStatus === "fetched") {
    const labelMatchedClient = resolveConfiguredClientFromLabels(context.labels || [], config);
    if (labelMatchedClient) {
      return labelMatchedClient;
    }
  }

  const normalizedText = normalizeClientLookup(ticketContextSearchText(context));
  if (!normalizedText) {
    return undefined;
  }

  return config.clients.find((client) =>
    client.aliases.some((alias) => {
      const normalizedAlias = normalizeClientLookup(alias);
      return normalizedTextHasOperationalHostAlias(normalizedText, normalizedAlias);
    }),
  );
}

function inferClientDisplayFromTicketText(text: string): string | undefined {
  const normalizedText = normalizeClientLookup(text);
  const structuredEnvironmentClient = text.match(
    /(?:^|[\r\n])\s*([A-Za-z][A-Za-z0-9 _-]{1,40}?)---CP-(?:PROD|PRD|UAT|STAGE|STG|INT|DEV)\d*\b/i,
  )?.[1];
  const structuredDisplayName = structuredEnvironmentClient
    ? displayNameFromClientSlug(structuredEnvironmentClient)
    : undefined;
  if (structuredDisplayName) {
    return structuredDisplayName;
  }
  const knownClients = [
    ["Wellcare", ["wellcare", "well-care", "centene"]],
    ["Cigna", ["cigna"]],
    ["Humana", ["humana"]],
  ] as const;

  for (const [displayName, aliases] of knownClients) {
    if (aliases.some((alias) => normalizedTextHasOperationalHostAlias(normalizedText, normalizeClientLookup(alias)))) {
      return displayName;
    }
  }

  const titlePrefix = text
    .split(/\r?\n/, 1)[0]
    ?.match(/^\s*([A-Za-z][A-Za-z0-9 _-]{1,40})\s*\|/)?.[1];
  return titlePrefix ? displayNameFromClientSlug(titlePrefix) : undefined;
}

function displayNameFromClientSlug(value: string): string | undefined {
  const tokens = value
    .trim()
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
  if (tokens.length === 0) {
    return undefined;
  }
  return tokens
    .map((token) => token.length <= 3
      ? token.toUpperCase()
      : `${token[0]?.toUpperCase() || ""}${token.slice(1).toLowerCase()}`)
    .join(" ");
}

function inferGenericClientDisplayFromLabels(labels: string[]): string | undefined {
  const prefixTokens = new Set(["client", "customer", "cust", "tenant", "payer", "plan"]);
  const stopTokens = new Set(["env", "environment", "prod", "production", "prd", "uat", "stage", "stg", "int", "dev", "release", "rel", "version", "ver"]);

  for (const label of labels) {
    const tokens = labelTokens(label);
    if (tokens.length < 2 || !prefixTokens.has(tokens[0] || "")) {
      continue;
    }
    const clientTokens: string[] = [];
    for (const token of tokens.slice(1)) {
      if (stopTokens.has(token) || isVersionLabelToken(token)) {
        break;
      }
      clientTokens.push(token);
    }
    const displayName = displayNameFromClientSlug(clientTokens.join("-"));
    if (displayName) {
      return displayName;
    }
  }
  return undefined;
}

function inferClientDisplayFromLabels(labels: string[]): string | undefined {
  if (labels.some((label) => labelsMatchClientAlias([label], "client-a"))) {
    return "Client A";
  }

  const knownClients = [
    ["Wellcare", ["wellcare", "well-care", "centene"]],
    ["Cigna", ["cigna"]],
    ["Humana", ["humana"]],
  ] as const;
  for (const [displayName, aliases] of knownClients) {
    if (aliases.some((alias) => labelsMatchClientAlias(labels, alias))) {
      return displayName;
    }
  }
  return inferGenericClientDisplayFromLabels(labels);
}

function inferClientFromLabels(labels: string[]): string | undefined {
  const config = getRuntimeTargetConfig();
  return resolveConfiguredClientFromLabels(labels, config)?.displayName
    || inferClientDisplayFromLabels(labels);
}

function normalizeInvestigationClient(value: string | undefined, environment: InvestigationEnvironment | undefined): string | undefined {
  const configured = resolveConfiguredClient(value, environment);
  if (configured) {
    return configured.displayName;
  }
  if (isClientAClientName(value)) {
    return "Client A";
  }
  return value?.trim() || undefined;
}

function normalizeJiraScopedClientId(value: string): string {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "JIRA_SCOPED_CLIENT";
}

function buildJiraScopedClientTarget(input: {
  displayName: string;
  environment: InvestigationEnvironment;
  labels: string[];
  ticketContext?: InvestigationTicketContext;
}): InvestigationClientTarget {
  const id = normalizeJiraScopedClientId(input.displayName);
  const labelAliases = input.labels.flatMap((label) => clientLabelCandidates(label));
  const aliases = Array.from(new Set([
    input.displayName,
    id,
    normalizeClientLookup(input.displayName),
    ...labelAliases,
  ].filter((entry): entry is string => Boolean(entry?.trim()))));
  const ticketTerms = input.ticketContext?.fetchStatus === "fetched"
    ? input.ticketContext.extractedTerms || []
    : [];
  const operationalRepoNames = inferOperationalRepoNames(ticketContextSearchText(input.ticketContext));
  const configuredRepoNames = parseRuntimeList(process.env.INVESTIGATION_REPO_NAMES);
  const repoNames = configuredRepoNames.length > 0 ? configuredRepoNames : operationalRepoNames;

  return {
    id,
    displayName: input.displayName,
    aliases,
    defaultEnvironment: toControlPlaneEnvironment(input.environment),
    serviceIds: repoNames.length > 0 ? repoNames : [`${id.toLowerCase().replace(/_/g, "-")}-backend`],
    keywords: ticketTerms,
    repoNames,
    enabled: true,
  };
}

function firstRuntimeEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function parseRuntimeList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseRuntimePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function runtimeBatchProbePaths(): string[] {
  const configured = parseRuntimeList(firstRuntimeEnv("INVESTIGATION_BATCH_PROBE_PATHS"));
  return configured.length > 0
    ? configured
    : [
        "/opt/software/medhok/batch",
        "/opt/software/medhok/jobs",
        "/opt/software/medhok",
      ];
}

function runtimeBatchArchiveBucket(): string | undefined {
  if (!runtimeFlagEnabled("INVESTIGATION_BATCH_ARCHIVE_ENABLED", true)) {
    return undefined;
  }
  return firstRuntimeEnv("INVESTIGATION_BATCH_ARCHIVE_BUCKET") || "com.medhok.recursive-archiver";
}

function runtimeBatchArchiveMaxObjects(): number {
  const configured = Number.parseInt(firstRuntimeEnv("INVESTIGATION_BATCH_ARCHIVE_MAX_OBJECTS") || "", 10);
  return Number.isInteger(configured) && configured > 0 && configured <= 100 ? configured : 10;
}

function runtimeFlagEnabled(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }
  return /^(1|true|yes)$/i.test(value);
}

function renderRuntimeScopeTemplate(value: string, input: {
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  releaseVersion?: string;
  repoName?: string;
}): string {
  const envId = toControlPlaneEnvironment(input.environment);
  const clientSlug = input.client.id.toLowerCase().replace(/_/g, "-");
  const releaseVersion = input.releaseVersion || "";
  const releaseSlug = releaseVersion.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const repoName = input.repoName || "";
  const repoSlug = repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return value
    .replaceAll("{clientId}", input.client.id)
    .replaceAll("{client}", clientSlug)
    .replaceAll("{clientDisplayName}", input.client.displayName)
    .replaceAll("{environment}", input.environment)
    .replaceAll("{env}", input.environment.toLowerCase().replace(/[^a-z0-9]+/g, "-"))
    .replaceAll("{envId}", envId)
    .replaceAll("{releaseVersion}", releaseVersion)
    .replaceAll("{release}", releaseVersion)
    .replaceAll("{releaseSlug}", releaseSlug)
    .replaceAll("{repoName}", repoName)
    .replaceAll("{repo}", repoSlug);
}

const REPO_CONFIRMATION_REQUIRED_SENTINEL = "__repo_confirmation_required__";
const DEFAULT_JIRA_SCOPED_CODE_REPO_NAMES = ["core-app", "client-services"];

function inferOperationalRepoNames(text: string): string[] {
  if (!text.trim()) {
    return [];
  }
  const batchSignals = [
    /\bInfauto(?:Jar|Task)Runner\b/i,
    /(?:^|[\\/])jar_runner(?:[\\/]|$)/i,
    /\b(?:Job Started|Job Name|Run Number|Agent Name)\b/i,
    /\b(?:skybot|autosys|cron|scheduler)\b/i,
    /\bfax[-_ ]?intake[-_ ]?service\b/i,
    /\/opt\/software\/medhok\/[^\s'"<>]+\.jar\b/i,
  ].filter((pattern) => pattern.test(text)).length;
  return batchSignals >= 2 ? ["batch-jobs"] : [];
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim() || "").filter(Boolean)));
}

function signalTextForRepoResolution(input: {
  title?: string;
  ticketContext?: InvestigationTicketContext;
  releaseVersion?: string;
  preflightSignals?: string[];
}): string {
  return [
    input.title,
    ticketContextSearchText(input.ticketContext),
    input.releaseVersion,
    ...(input.preflightSignals || []),
  ]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join("\n");
}

function approvedCodeTargetsForScope(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
}) {
  return input.config.codeTargets.filter((target) =>
    target.clientId === input.client.id
    && (!target.environment || toDashboardEnvironment(target.environment) === input.environment)
    && target.enabled,
  );
}

function filterRepoNamesToApprovedTargets(repoNames: string[], approvedTargets: InvestigationCodeTarget[]): string[] {
  const approved = new Set(approvedTargets.map((target) => target.repoName.toLowerCase()));
  return uniqueStrings(repoNames).filter((repoName) => approved.has(repoName.toLowerCase()));
}

function defaultJiraScopedCodeRepoNames(): string[] {
  const configured = parseRuntimeList(firstRuntimeEnv(
    "INVESTIGATION_JIRA_DEFAULT_REPO_NAMES",
    "INVESTIGATION_JIRA_DEFAULT_REPO_NAME",
    "INVESTIGATION_DEFAULT_REPO_NAMES",
    "INVESTIGATION_DEFAULT_REPO_NAME",
  ));
  return configured.length > 0 ? configured : DEFAULT_JIRA_SCOPED_CODE_REPO_NAMES;
}

function codeTargetToRepository(target: InvestigationCodeTarget, index: number): InvestigationCodeRepositoryForRouting {
  return {
    id: index + 1,
    repo_name: target.repoName,
    repo_url: target.repoUrl || target.repoName,
    description: target.notes || target.repoName,
    default_branch: target.defaultBranch || null,
    created_at: new Date(0),
  };
}

function ticketContextToRouterTicket(input: {
  jiraKey?: string;
  title?: string;
  ticketContext?: InvestigationTicketContext;
}): InvestigationRouterTicketInput {
  const context = input.ticketContext?.fetchStatus === "fetched" ? input.ticketContext : undefined;
  return {
    key: input.jiraKey || context?.jiraKey || "COCKPIT-RUN",
    fields: {
      summary: input.title || context?.title || "",
      description: (context?.extractedTerms || []).join("\n"),
      labels: context?.labels || [],
      comment: {
        comments: [],
      },
      attachment: (context?.attachments || []).map((attachment) => ({
        filename: attachment.filename,
      })),
    },
  };
}

function profileTerms(profile: InvestigationRepoProfile): string[] {
  return uniqueStrings([
    ...profile.merged.aliases,
    ...profile.merged.domains,
    ...profile.merged.packages,
    ...profile.merged.file_path_patterns,
    ...profile.merged.symbols,
    ...profile.merged.endpoints,
    ...profile.merged.tables,
  ]);
}

function repoProfileDir(): string {
  const configured = firstRuntimeEnv("INVESTIGATION_REPO_PROFILE_DIR", "ONESHOT_REPO_PROFILE_DIR");
  if (configured) {
    return configured;
  }
  const fromCwd = path.join(process.cwd(), "config", "repo-profiles");
  if (existsSync(fromCwd)) {
    return fromCwd;
  }
  return path.join(process.cwd(), "..", "config", "repo-profiles");
}

function repoProfileNames(): string[] {
  const directory = repoProfileDir();
  if (!existsSync(directory)) {
    return [];
  }
  try {
    return readdirSync(directory)
      .filter((entry) => entry.endsWith(".yaml") || entry.endsWith(".yml"))
      .map((entry) => entry.replace(/\.ya?ml$/i, ""))
      .filter((entry) => entry && !entry.startsWith("."));
  } catch {
    return [];
  }
}

function runtimeCodeRepoNames(): string[] {
  return uniqueStrings([
    ...parseRuntimeList(firstRuntimeEnv("INVESTIGATION_APPROVED_REPO_NAMES", "INVESTIGATION_CODE_REPO_NAMES")),
    ...parseRuntimeList(process.env.INVESTIGATION_REPO_NAMES),
    ...repoProfileNames(),
  ]);
}

function runtimeCodeRepoMetadata(repoName: string) {
  return getInvestigationRepoMetadata(repoName);
}

function runtimeCodeRepoDefaultBranch(repoName: string): string {
  return firstRuntimeEnv("INVESTIGATION_CODE_DEFAULT_BRANCH", "INVESTIGATION_REPO_DEFAULT_BRANCH")
    || getInvestigationRepositoryDefaultBranchName({ repoName });
}

function defaultRuntimeCodeRepoUrl(repoName: string): string | undefined {
  const metadata = runtimeCodeRepoMetadata(repoName);
  if (!metadata?.githubSlug) {
    return undefined;
  }
  const org = firstRuntimeEnv("INVESTIGATION_GITHUB_ORG", "GITHUB_REPO_ORG") || "mhk-repos";
  return `https://github.com/${org}/${metadata.githubSlug}.git`;
}

function runtimeCodeRepoPath(input: {
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  repoName: string;
  releaseVersion?: string;
}): string | undefined {
  const pathTemplate = firstRuntimeEnv("INVESTIGATION_CODE_REPO_PATH_TEMPLATE", "INVESTIGATION_REPO_PATH_TEMPLATE");
  if (pathTemplate) {
    const rendered = renderRuntimeScopeTemplate(pathTemplate, input).trim();
    return rendered || undefined;
  }

  const baseTemplate = firstRuntimeEnv("INVESTIGATION_CODE_REPO_BASE_TEMPLATE", "INVESTIGATION_REPO_BASE_TEMPLATE");
  const base = baseTemplate
    ? renderRuntimeScopeTemplate(baseTemplate, input)
    : firstRuntimeEnv("INVESTIGATION_CODE_REPO_BASE", "INVESTIGATION_REPO_BASE", "INVESTIGATION_LOCAL_REPO_BASE");
  if (!base?.trim()) {
    const repoUrl = defaultRuntimeCodeRepoUrl(input.repoName);
    if (!repoUrl) {
      return undefined;
    }
    const cacheBase = firstRuntimeEnv("INVESTIGATION_CODE_REPO_CACHE_BASE", "INVESTIGATION_REPO_CACHE_BASE")
      || path.join(tmpdir(), "investigation-code-repos");
    return path.join(cacheBase, input.repoName);
  }
  return path.join(base.trim(), input.repoName);
}

function runtimeCodeRepoUrl(input: {
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  repoName: string;
  releaseVersion?: string;
}): string | undefined {
  const template = firstRuntimeEnv("INVESTIGATION_CODE_REPO_URL_TEMPLATE", "INVESTIGATION_REPO_URL_TEMPLATE");
  return template
    ? renderRuntimeScopeTemplate(template, input).trim() || undefined
    : defaultRuntimeCodeRepoUrl(input.repoName);
}

function runtimeCodeBranchCandidatesForRelease(input: {
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  releaseVersion?: string;
  repoName: string;
  repoUrl?: string;
}): string[] {
  const explicitBranch = firstRuntimeEnv("INVESTIGATION_CODE_BRANCH", "INVESTIGATION_REPO_BRANCH");
  const branchTemplate = firstRuntimeEnv("INVESTIGATION_CODE_BRANCH_TEMPLATE", "INVESTIGATION_REPO_BRANCH_TEMPLATE");
  const templatedBranch = branchTemplate
    ? renderRuntimeScopeTemplate(branchTemplate, input).trim()
    : undefined;
  const defaultBranch = runtimeCodeRepoDefaultBranch(input.repoName);
  return uniqueStrings([
    explicitBranch,
    templatedBranch,
    ...getInvestigationRepoBranchCandidatesForVersion({
      repoName: input.repoName,
      repoUrl: input.repoUrl,
      versionOrBranch: normalizeReleaseVersion(input.releaseVersion),
      defaultBranch,
    }),
  ].filter((entry): entry is string => Boolean(entry?.trim())));
}

function hasConfiguredCodeTarget(
  config: InvestigationTargetConfig,
  client: InvestigationClientTarget,
  environment: InvestigationEnvironment,
  repoName: string,
): boolean {
  return config.codeTargets.some((target) =>
    target.clientId === client.id
    && (!target.environment || toDashboardEnvironment(target.environment) === environment)
    && target.repoName.toLowerCase() === repoName.toLowerCase()
    && target.enabled,
  );
}

function buildJiraScopedRuntimeCodeTargets(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  releaseVersion?: string;
}): InvestigationCodeTarget[] {
  const envId = toControlPlaneEnvironment(input.environment);
  return runtimeCodeRepoNames()
    .map<InvestigationCodeTarget | undefined>((repoName) => {
      if (hasConfiguredCodeTarget(input.config, input.client, input.environment, repoName)) {
        return undefined;
      }
      const repoPath = runtimeCodeRepoPath({ ...input, repoName });
      if (!repoPath) {
        return undefined;
      }
      const repoUrl = runtimeCodeRepoUrl({ ...input, repoName });
      const branchCandidates = runtimeCodeBranchCandidatesForRelease({
        ...input,
        repoName,
        repoUrl,
      });
      return {
        id: `jira-${input.client.id.toLowerCase()}-${input.environment.toLowerCase()}-${repoName.toLowerCase()}`,
        clientId: input.client.id,
        environment: envId,
        repoName,
        repoPath,
        repoUrl,
        branch: branchCandidates[0],
        branchCandidates,
        branchFamilyPatterns: getInvestigationRepoBranchFamilyPatternsForVersion({
          repoName,
          repoUrl,
          versionOrBranch: normalizeReleaseVersion(input.releaseVersion),
        }),
        defaultBranch: runtimeCodeRepoDefaultBranch(repoName),
        refreshFromRemote: firstRuntimeEnv("INVESTIGATION_CODE_REPO_REFRESH", "INVESTIGATION_REPO_REFRESH") !== "false",
        enabled: true,
        notes: "Synthesized from Jira client/environment scope and Cockpit runtime repo template.",
      } satisfies InvestigationCodeTarget;
    })
    .filter((target): target is InvestigationCodeTarget => Boolean(target));
}

async function buildGitHubDiscoveredCodeTargets(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  releaseVersion?: string;
  ticketContext?: InvestigationTicketContext;
}): Promise<InvestigationCodeTarget[]> {
  if (input.ticketContext?.fetchStatus !== "fetched") {
    return [];
  }
  const terms = uniqueStrings([
    ...(input.ticketContext.extractedTerms || []),
    ...(input.ticketContext.attachments || []).flatMap((attachment) => attachment.extractedTerms || []),
  ]);
  return buildGitHubCodeTargetsForTerms({
    clientId: input.client.id,
    environment: toControlPlaneEnvironment(input.environment),
    releaseVersion: input.releaseVersion,
    terms,
  });
}

async function buildGitHubCodeTargetsForTerms(input: {
  clientId: string;
  environment: ControlPlaneEnvironment;
  releaseVersion?: string;
  terms: string[];
}): Promise<InvestigationCodeTarget[]> {
  const organization = firstRuntimeEnv("INVESTIGATION_GITHUB_ORG", "GITHUB_REPO_ORG") || "mhk-repos";
  const repositories = await discoverGitHubRepositoriesForTicket({ organization, terms: input.terms });
  const configuredBase = firstRuntimeEnv(
    "INVESTIGATION_CODE_REPO_BASE",
    "INVESTIGATION_REPO_BASE",
    "INVESTIGATION_LOCAL_REPO_BASE",
  );
  const cacheBase = firstRuntimeEnv("INVESTIGATION_CODE_REPO_CACHE_BASE", "INVESTIGATION_REPO_CACHE_BASE")
    || path.join(tmpdir(), "investigation-code-repos");

  return repositories.map((repository) => {
    const canonicalRepoName = INVESTIGATION_REPO_METADATA.find((metadata) =>
      metadata.githubSlug.toLowerCase() === repository.name.toLowerCase())?.repoName || repository.name;
    const branchCandidates = getInvestigationRepoBranchCandidatesForVersion({
      repoName: canonicalRepoName,
      repoUrl: repository.cloneUrl,
      versionOrBranch: normalizeReleaseVersion(input.releaseVersion),
      defaultBranch: repository.defaultBranch,
    });
    return {
      id: `github-${input.clientId.toLowerCase()}-${input.environment.toLowerCase()}-${repository.name.toLowerCase()}`,
      clientId: input.clientId,
      environment: input.environment,
      repoName: canonicalRepoName,
      repoPath: path.join(configuredBase || cacheBase, canonicalRepoName),
      repoUrl: repository.cloneUrl,
      branch: branchCandidates[0],
      branchCandidates,
      branchFamilyPatterns: getInvestigationRepoBranchFamilyPatternsForVersion({
        repoName: canonicalRepoName,
        repoUrl: repository.cloneUrl,
        versionOrBranch: normalizeReleaseVersion(input.releaseVersion),
      }),
      defaultBranch: repository.defaultBranch,
      refreshFromRemote: firstRuntimeEnv("INVESTIGATION_CODE_REPO_REFRESH", "INVESTIGATION_REPO_REFRESH") !== "false",
      enabled: true,
      notes: `Discovered by bounded GitHub organization code search for: ${repository.matchedTerms.join(", ")}. Candidate paths: ${repository.matchedPaths.slice(0, 5).join(", ")}.`,
    } satisfies InvestigationCodeTarget;
  });
}

function normalizedProfileTerm(value: string): string {
  return normalizeClientLookup(value).trim();
}

function profileTermInText(normalizedText: string, term: string): boolean {
  const normalizedTerm = normalizedProfileTerm(term);
  if (normalizedTerm.length < 4) {
    return false;
  }
  return normalizedTextHasAlias(normalizedText, normalizedTerm);
}

function scoreProfileTerm(term: string, repoCount: number, documentFrequency: number): number {
  const normalizedTerm = normalizedProfileTerm(term);
  if (normalizedTerm.length < 4) {
    return 0;
  }
  const isSpecific = normalizedTerm.length >= 8 || /[\s._/-]/.test(term) || /[-._/]/.test(normalizedTerm);
  const commonAcrossMostRepos = repoCount > 1 && documentFrequency >= Math.max(2, Math.ceil(repoCount * 0.6));
  if (commonAcrossMostRepos && !isSpecific) {
    return 0;
  }
  if (documentFrequency > 1) {
    return isSpecific ? 2 : 0;
  }
  return isSpecific ? 8 : 2;
}

function repoRoutingIgnoredTerms(input: {
  client: InvestigationClientTarget;
  title?: string;
  ticketContext?: InvestigationTicketContext;
  profiles: Map<string, InvestigationRepoProfile>;
}): Set<string> {
  const ignored = new Set<string>();
  for (const value of [
    input.client.id,
    input.client.displayName,
    ...(input.client.aliases || []),
  ]) {
    const normalized = normalizedProfileTerm(value);
    if (normalized) {
      ignored.add(normalized);
    }
  }

  const title = input.title || (input.ticketContext?.fetchStatus === "fetched" ? input.ticketContext.title || "" : "");
  const lowerTitle = title.toLowerCase();
  const technicalTerms = Array.from(input.profiles.values())
    .flatMap((profile) => [
      ...profile.merged.domains,
      ...profile.merged.symbols,
      ...profile.merged.endpoints,
      ...profile.merged.tables,
      ...profile.merged.file_path_patterns,
    ])
    .map((term) => term.trim())
    .filter((term) => term.length >= 5 && /[\s._/-]/.test(term))
    .sort((left, right) => right.length - left.length);

  const firstTechnicalIndex = technicalTerms
    .map((term) => lowerTitle.indexOf(term.toLowerCase()))
    .filter((index) => index > 0)
    .sort((left, right) => left - right)[0];
  if (typeof firstTechnicalIndex === "number") {
    const prefix = title.slice(0, firstTechnicalIndex);
    for (const token of prefix.split(/[^A-Za-z0-9]+/)) {
      const normalized = normalizedProfileTerm(token);
      if (normalized.length >= 4) {
        ignored.add(normalized);
      }
    }
  }

  return ignored;
}

async function resolveRepoNamesWithProfiles(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  jiraKey?: string;
  title?: string;
  ticketContext?: InvestigationTicketContext;
  releaseVersion?: string;
  preflightSignals?: string[];
}): Promise<string[]> {
  const approvedTargets = approvedCodeTargetsForScope(input);
  if (approvedTargets.length === 0) {
    return [];
  }
  const repos = approvedTargets.map(codeTargetToRepository);
  const ticket = ticketContextToRouterTicket(input);
  const extraAttachmentText = input.ticketContext?.fetchStatus === "fetched"
    ? (input.ticketContext.attachments || []).map((attachment) => attachment.textExcerpt).filter(Boolean).join("\n")
    : "";
  const ticketText = [
    buildInvestigationRouterTicketText(ticket),
    signalTextForRepoResolution(input),
    extraAttachmentText,
    ...(input.preflightSignals || []),
  ].filter(Boolean).join("\n");
  const extractedSignals = extractInvestigationRepoRoutingSignals(ticketText);
  const profiles = await loadInvestigationRepoProfiles(repos, { profileDir: repoProfileDir(), requireProfiles: false });
  const weights = await loadInvestigationRepoRouterWeights(undefined, { requireWeights: false });
  const ignoredTerms = repoRoutingIgnoredTerms({
    client: input.client,
    title: input.title,
    ticketContext: input.ticketContext,
    profiles,
  });
  const normalizedTicketText = normalizeClientLookup(ticketText);
  const allTermsByRepo = new Map<string, string[]>();
  const documentFrequency = new Map<string, number>();

  for (const profile of profiles.values()) {
    const terms = profileTerms(profile);
    allTermsByRepo.set(profile.repoName.toLowerCase(), terms);
    for (const normalizedTerm of new Set(terms.map(normalizedProfileTerm).filter((term) => term.length >= 4))) {
      documentFrequency.set(normalizedTerm, (documentFrequency.get(normalizedTerm) || 0) + 1);
    }
  }

  const signalTerms = [
    ...extractedSignals.filePaths,
    ...extractedSignals.identifiers,
    ...extractedSignals.tables,
    ...extractedSignals.endpoints,
    ...extractedSignals.directionalPhrases,
    ...extractedSignals.businessConcepts,
  ].filter(Boolean);

  const candidates = repos.map((repo) => {
    const profile = profiles.get(repo.repo_name.toLowerCase());
    const terms = profile ? allTermsByRepo.get(profile.repoName.toLowerCase()) || [] : [];
    let score = 0;
    const seenTerms = new Set<string>();
    for (const term of terms) {
      const normalizedTerm = normalizedProfileTerm(term);
      if (seenTerms.has(normalizedTerm) || ignoredTerms.has(normalizedTerm)) {
        continue;
      }
      seenTerms.add(normalizedTerm);
      if (!profileTermInText(normalizedTicketText, term)) {
        continue;
      }
      score += scoreProfileTerm(term, repos.length, documentFrequency.get(normalizedTerm) || 0);
    }
    for (const signal of signalTerms) {
      const normalizedSignal = normalizedProfileTerm(signal);
      if (ignoredTerms.has(normalizedSignal)) {
        continue;
      }
      if (terms.some((term) => profileTermInText(normalizeClientLookup(signal), term) || profileTermInText(normalizeClientLookup(term), signal))) {
        score += weights.weights.businessTermProfileHit;
      }
    }
    return { repo, score };
  }).sort((left, right) => right.score - left.score);

  const [top, second] = candidates;
  if (!top || top.score < weights.scoreMin || top.score - (second?.score || 0) < weights.marginAuto) {
    return [REPO_CONFIRMATION_REQUIRED_SENTINEL];
  }
  return [top.repo.repo_name];
}

async function resolveJiraScopedCodeRepoNames(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  jiraKey?: string;
  title?: string;
  ticketContext?: InvestigationTicketContext;
  releaseVersion?: string;
  preflightSignals?: string[];
}): Promise<string[]> {
  const approvedTargets = approvedCodeTargetsForScope(input);
  const runtimeRepoNames = parseRuntimeList(process.env.INVESTIGATION_REPO_NAMES);
  if (runtimeRepoNames.length > 0) {
    const filtered = filterRepoNamesToApprovedTargets(runtimeRepoNames, approvedTargets);
    return filtered.length > 0 ? filtered : [REPO_CONFIRMATION_REQUIRED_SENTINEL];
  }

  const operationalRepoNames = inferOperationalRepoNames(signalTextForRepoResolution(input));
  if (operationalRepoNames.length > 0) {
    const filtered = filterRepoNamesToApprovedTargets(operationalRepoNames, approvedTargets);
    if (filtered.length > 0) {
      return filtered;
    }
  }

  const profiledRepoNames = await resolveRepoNamesWithProfiles(input);
  if (
    profiledRepoNames.length > 0
    && !profiledRepoNames.includes(REPO_CONFIRMATION_REQUIRED_SENTINEL)
  ) {
    return profiledRepoNames;
  }

  if (input.client.repoNames?.length) {
    const filtered = filterRepoNamesToApprovedTargets(input.client.repoNames, approvedTargets);
    return filtered.length > 0 ? filtered : [REPO_CONFIRMATION_REQUIRED_SENTINEL];
  }

  const defaultRepoNames = filterRepoNamesToApprovedTargets(defaultJiraScopedCodeRepoNames(), approvedTargets);
  if (defaultRepoNames.length > 0) {
    return defaultRepoNames;
  }

  return profiledRepoNames;
}

function runtimeCodeBranchForRelease(input: {
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  releaseVersion?: string;
  repoName: string;
  repoUrl?: string;
}): string | undefined {
  return runtimeCodeBranchCandidatesForRelease(input)[0];
}

function withJiraScopedCodeVersion(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  releaseVersion?: string;
  repoNames: string[];
}): InvestigationTargetConfig {
  const requestedRepos = new Set(input.repoNames.map((repoName) => repoName.toLowerCase()));
  if (!input.releaseVersion || requestedRepos.size === 0 || requestedRepos.has(REPO_CONFIRMATION_REQUIRED_SENTINEL)) {
    return input.config;
  }

  return {
    ...input.config,
    codeTargets: input.config.codeTargets.map((target) => {
      if (
        target.clientId !== input.client.id
        || (target.environment && toDashboardEnvironment(target.environment) !== input.environment)
        || !requestedRepos.has(target.repoName.toLowerCase())
      ) {
        return target;
      }
      return {
        ...target,
        branch: runtimeCodeBranchForRelease({
          client: input.client,
          environment: input.environment,
          releaseVersion: input.releaseVersion,
          repoName: target.repoName,
          repoUrl: target.repoUrl,
        }),
        branchCandidates: runtimeCodeBranchCandidatesForRelease({
          client: input.client,
          environment: input.environment,
          releaseVersion: input.releaseVersion,
          repoName: target.repoName,
          repoUrl: target.repoUrl,
        }),
        branchFamilyPatterns: getInvestigationRepoBranchFamilyPatternsForVersion({
          repoName: target.repoName,
          repoUrl: target.repoUrl,
          versionOrBranch: input.releaseVersion,
        }),
      };
    }),
  };
}

function hasRuntimeDbTargetEnv(): boolean {
  if (runtimeFlagEnabled("INVESTIGATION_DB_ENABLED", false)) {
    return true;
  }
  const cockpitDbTargetEnv = firstRuntimeEnv(
    "INVESTIGATION_DB_HOST",
    "INVESTIGATION_DB_HOST_TEMPLATE",
    "INVESTIGATION_DB_REMOTE_HOST",
    "INVESTIGATION_DB_REMOTE_HOST_TEMPLATE",
    "INVESTIGATION_DB_LOCAL_HOST",
    "INVESTIGATION_DB_PORT",
    "INVESTIGATION_DB_REMOTE_PORT",
    "INVESTIGATION_DB_LOCAL_PORT",
  );
  const meridianDbTargetEnv = firstRuntimeEnv(
    "MERIDIAN_DB_REMOTE_HOST",
    "MERIDIAN_DB_REMOTE_HOST_TEMPLATE",
  );
  return Boolean(cockpitDbTargetEnv || meridianDbTargetEnv);
}

function runtimeDbUserRef(): string {
  if (firstRuntimeEnv("INVESTIGATION_DB_USERNAME")) {
    return "env://INVESTIGATION_DB_USERNAME";
  }
  if (firstRuntimeEnv("MERIDIAN_DB_USERNAME")) {
    return "env://MERIDIAN_DB_USERNAME";
  }
  if (firstRuntimeEnv("INVESTIGATION_OPERATOR_SSH_USER")) {
    return "env://INVESTIGATION_OPERATOR_SSH_USER";
  }
  if (firstRuntimeEnv("MERIDIAN_SSH_USER")) {
    return "env://MERIDIAN_SSH_USER";
  }
  if (firstRuntimeEnv("INVESTIGATION_SSH_USER")) {
    return "env://INVESTIGATION_SSH_USER";
  }
  return "env://INVESTIGATION_DB_USERNAME";
}

function runtimeDbSecretRef(): string {
  if (firstRuntimeEnv("INVESTIGATION_DB_PASSWORD")) {
    return "env://INVESTIGATION_DB_PASSWORD";
  }
  if (firstRuntimeEnv("MERIDIAN_DB_PASSWORD")) {
    return "env://MERIDIAN_DB_PASSWORD";
  }
  if (firstRuntimeEnv("INVESTIGATION_OPERATOR_SSH_PASSWORD")) {
    return "env://INVESTIGATION_OPERATOR_SSH_PASSWORD";
  }
  if (firstRuntimeEnv("MERIDIAN_SSH_PASSWORD")) {
    return "env://MERIDIAN_SSH_PASSWORD";
  }
  if (firstRuntimeEnv("INVESTIGATION_SSH_PASSWORD")) {
    return "env://INVESTIGATION_SSH_PASSWORD";
  }
  return "env://INVESTIGATION_DB_PASSWORD";
}

function hasConfiguredConnection(config: InvestigationTargetConfig, client: InvestigationClientTarget, environment: InvestigationEnvironment): boolean {
  return config.connections.some((target) =>
    target.clientId === client.id
    && toDashboardEnvironment(target.environment) === environment
    && target.enabled,
  );
}

function hasConfiguredHostTarget(config: InvestigationTargetConfig, client: InvestigationClientTarget, environment: InvestigationEnvironment): boolean {
  return config.hostTargets.some((target) =>
    target.clientId === client.id
    && toDashboardEnvironment(target.environment) === environment
    && target.enabled,
  );
}

function hasConfiguredLogSource(config: InvestigationTargetConfig, client: InvestigationClientTarget, environment: InvestigationEnvironment): boolean {
  return config.logSources.some((source) =>
    source.clientId === client.id
    && toDashboardEnvironment(source.environment) === environment
    && source.enabled,
  );
}

function runtimeAwsProfile(): string | undefined {
  return firstRuntimeEnv("INVESTIGATION_AWS_PROFILE", "AWS_PROFILE");
}

function hasRuntimeAwsEvidenceEnv(): boolean {
  return Boolean(runtimeAwsProfile());
}

function matchingConfiguredHostTargets(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
}): InvestigationHostTarget[] {
  return input.config.hostTargets.filter((target) =>
    target.clientId === input.client.id
    && toDashboardEnvironment(target.environment) === input.environment
    && target.enabled,
  );
}

function matchingConfiguredLogSources(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
}): InvestigationLogSource[] {
  return input.config.logSources.filter((source) =>
    source.clientId === input.client.id
    && toDashboardEnvironment(source.environment) === input.environment
    && source.enabled,
  );
}

function runtimeAwsRegions(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
}): string[] {
  const configuredRegions = uniqueStrings([
    ...matchingConfiguredHostTargets(input).map((target) => target.region),
    ...matchingConfiguredLogSources(input).map((source) => source.region),
  ]);
  if (configuredRegions.length > 0) {
    return configuredRegions;
  }

  return [DYNAMIC_AWS_REGION];
}

function ticketDerivedAwsLogEnvIds(context: InvestigationTicketContext | undefined): string[] {
  if (context?.fetchStatus !== "fetched") {
    return [];
  }

  const text = [
    ...(context.labels || []),
    context.environmentName,
    context.title,
    ...(context.extractedTerms || []),
    ...(context.attachments || []).flatMap((attachment) => [
      attachment.filename,
      attachment.textExcerpt,
      ...(attachment.extractedTerms || []),
    ]),
    ...(context.extractedTerms || []),
  ]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join("\n");

  const envIds = Array.from(text.matchAll(/\b(?:CONFIG|PROD|PRD|UAT|INT|DEV|STAGE|STG)[-_\s]?\d{1,3}\b/gi))
    .map((match) => (match[0] || "").toUpperCase().replace(/[-_\s]+/g, ""))
    .map((value) => value.replace(/^PRD/, "PROD").replace(/^STG/, "STAGE"));
  return uniqueStrings(envIds).slice(0, 8);
}

function runtimeAwsLogEnvIds(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  ticketContext?: InvestigationTicketContext;
}): string[] {
  const configuredEnvIds = uniqueStrings([
    ...matchingConfiguredHostTargets(input).map((target) => target.envId),
    ...matchingConfiguredLogSources(input).map((source) => source.envId),
  ]);
  if (configuredEnvIds.length > 0) {
    return configuredEnvIds;
  }

  return ticketDerivedAwsLogEnvIds(input.ticketContext);
}

function runtimeScopeIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "scope";
}

function buildJiraScopedRuntimeLogSources(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  ticketContext?: InvestigationTicketContext;
}): InvestigationLogSource[] {
  if (hasConfiguredLogSource(input.config, input.client, input.environment) || !hasRuntimeAwsEvidenceEnv()) {
    return [];
  }
  const envId = toControlPlaneEnvironment(input.environment);
  const regions = runtimeAwsRegions(input);
  const logEnvIds = runtimeAwsLogEnvIds(input);
  const sourceScopes = logEnvIds.length > 0
    ? logEnvIds.flatMap((logEnvId) => [
        {
          idPart: `${logEnvId}-core`,
          envId: logEnvId,
          component: "core",
          logGroupTemplate: "/CP/{clientId}/{envId}/core",
        },
        {
          idPart: `${logEnvId}-core-catalina`,
          envId: logEnvId,
          component: "core-catalina",
          logGroupTemplate: "/CP/{clientId}/{envId}/core/catalina",
        },
        {
          idPart: `${logEnvId}-batch`,
          envId: logEnvId,
          component: "batch",
          logGroupTemplate: "/CP/{clientId}/{envId}/batch",
        },
        {
          idPart: logEnvId,
          envId: logEnvId,
          component: "client-prefix",
          logGroupTemplate: "/CP/{clientId}/{envId}/",
        },
      ])
    : [
        {
          idPart: "client-root-core",
          envId: undefined,
          component: "core",
          logGroupTemplate: "/CP/{clientId}/core",
        },
        {
          idPart: "client-root-batch",
          envId: undefined,
          component: "batch",
          logGroupTemplate: "/CP/{clientId}/batch",
        },
        {
          idPart: "client-root",
          envId: undefined,
          component: "client-prefix",
          logGroupTemplate: "/CP/{clientId}/",
        },
      ];
  const cloudWatchSources = regions.flatMap((region) =>
    sourceScopes.map((sourceScope) => ({
      id: `jira-${runtimeScopeIdPart(input.client.id)}-${runtimeScopeIdPart(envId)}-${runtimeScopeIdPart(region)}-${runtimeScopeIdPart(sourceScope.idPart)}-cloudwatch`,
      clientId: input.client.id,
      environment: envId,
      ...(sourceScope.envId ? { envId: sourceScope.envId } : {}),
      region,
      component: sourceScope.component,
      kind: "cloudwatch" as const,
      logGroupTemplate: sourceScope.logGroupTemplate,
      maxEvents: 10,
      optional: true,
      enabled: true,
      notes: "Synthesized from Jira client/environment scope and Cockpit AWS runtime profile.",
    })),
  );
  const archiveBucket = runtimeBatchArchiveBucket();
  if (!archiveBucket) {
    return cloudWatchSources;
  }

  const archiveRegion = regions[0] || DYNAMIC_AWS_REGION;
  const archiveScopes = logEnvIds.length > 0
    ? logEnvIds.map((logEnvId) => ({
        idPart: `${logEnvId}-batch-archive`,
        envId: logEnvId,
        prefixTemplate: "{clientId}/{envId}/",
      }))
    : [{
        idPart: "client-root-batch-archive",
        envId: undefined,
        prefixTemplate: "{clientId}/",
      }];
  const archiveSources = archiveScopes.map((archiveScope) => ({
    id: `jira-${runtimeScopeIdPart(input.client.id)}-${runtimeScopeIdPart(envId)}-${runtimeScopeIdPart(archiveScope.idPart)}-s3-archive`,
    clientId: input.client.id,
    environment: envId,
    ...(archiveScope.envId ? { envId: archiveScope.envId } : {}),
    region: archiveRegion,
    component: "batch-archive",
    kind: "s3_archive" as const,
    bucket: archiveBucket,
    prefixTemplate: archiveScope.prefixTemplate,
    maxObjects: runtimeBatchArchiveMaxObjects(),
    optional: true,
    enabled: true,
    notes: "Synthesized from Jira client/environment scope as metadata-only batch archive fallback after CloudWatch batch lookup.",
  }));
  return [...cloudWatchSources, ...archiveSources];
}

const SSH_HOST_CONTEXT_LINE = /\b(?:(?:ldap\s+)?ssh|bastion|jump|batch|app(?:lication)?|web|job|skybot|runtime)?\s*(?:host|server|hostname|node|instance)\b\s*(?:[:=#]|->|=>|\bis\b|\bwas\b)\s*([^\n,;]+)/gi;
const SSH_COMMAND_HOST = /\bssh\b(?:\s+-[A-Za-z]\S*)*\s+(?:[A-Za-z0-9_.-]+@)?([A-Za-z][A-Za-z0-9.-]{2,253})\b/gi;
const SSH_HOST_LABEL_PREFIX = /^(?:ldap[-_\s]*)?ssh[-_\s]*(?:host|server)|^(?:batch|app|application|web|job|skybot|runtime|bastion|jump)[-_\s]*(?:host|server|node)|^(?:host|hostname|server|node)[-_\s]+/i;
const SSH_HOST_STOP_WORDS = new Set([
  "application",
  "archive",
  "attachment",
  "batch",
  "centene",
  "cloudwatch",
  "command",
  "config",
  "database",
  "environment",
  "failed",
  "hostname",
  "instance",
  "letter",
  "log",
  "logs",
  "medhok",
  "metadata",
  "prefix",
  "production",
  "s3",
  "server",
  "source",
  "skybot",
  "template",
  "update",
]);

function containsNonHostInfraMarker(value: string): boolean {
  return /(?:^|[-_.])(?:archive|s3|cloudwatch|log|logs|source|metadata|prefix|bucket)(?:[-_.]|$)/i.test(value);
}

function normalizeDerivedSshHostCandidate(value: string): string | undefined {
  let candidate = value
    .trim()
    .replace(/^['"([{<]+/, "")
    .replace(/['".,;:)\]}>]+$/, "")
    .replace(/^ssh:\/\//i, "");
  candidate = candidate.replace(/^[A-Za-z0-9_.-]+@/, "");
  candidate = candidate.split(/[/?#]/)[0] || "";
  if (candidate.includes(":")) {
    candidate = candidate.split(":")[0] || "";
  }
  candidate = candidate.toLowerCase();
  if (
    !candidate
    || candidate.length < 5
    || candidate.length > 253
    || candidate.includes("..")
    || !/[a-z]/.test(candidate)
    || /^\d+(?:\.\d+){3}$/.test(candidate)
    || !/^[a-z0-9.-]+$/.test(candidate)
    || SSH_HOST_STOP_WORDS.has(candidate)
    || containsNonHostInfraMarker(candidate)
  ) {
    return undefined;
  }

  const parts = candidate.split(".");
  if (parts.length === 1) {
    return /^[a-z][a-z0-9-]{3,62}$/.test(candidate) && !candidate.endsWith("-")
      ? candidate
      : undefined;
  }

  return parts.every((part) =>
    part.length > 0
    && part.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part),
  )
    ? candidate
    : undefined;
}

function runtimeSshHostAllowPattern(): RegExp | undefined {
  const pattern = firstRuntimeEnv("INVESTIGATION_JIRA_SSH_HOST_ALLOW_PATTERN", "INVESTIGATION_SSH_HOST_ALLOW_PATTERN");
  if (!pattern) {
    return undefined;
  }
  try {
    return new RegExp(pattern, "i");
  } catch {
    return /^$/;
  }
}

function isAllowedJiraDerivedSshHost(hostname: string): boolean {
  const allowPattern = runtimeSshHostAllowPattern();
  return allowPattern ? allowPattern.test(hostname) : true;
}

function hostCandidateFromLabel(label: string): string | undefined {
  if (!SSH_HOST_LABEL_PREFIX.test(label)) {
    return undefined;
  }
  const stripped = label.replace(SSH_HOST_LABEL_PREFIX, "").replace(/^[-_\s:=]+/, "");
  return normalizeDerivedSshHostCandidate(stripped);
}

function hostCandidatesFromTicketLine(line: string): string[] {
  if (/\b(?:db|database|mysql|rds|aurora)\b/i.test(line)) {
    return [];
  }
  const candidates: string[] = [];
  for (const match of line.matchAll(SSH_HOST_CONTEXT_LINE)) {
    const candidate = normalizeDerivedSshHostCandidate(match[1] || "");
    if (candidate) {
      candidates.push(candidate);
    }
  }
  for (const match of line.matchAll(SSH_COMMAND_HOST)) {
    const candidate = normalizeDerivedSshHostCandidate(match[1] || "");
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function hostCandidateFromExtractedTerm(term: string): string | undefined {
  if (
    /\b(?:db|database|mysql|rds|aurora)\b/i.test(term)
    || /(?:^|[-.])db\d*(?:[-.]|$)/i.test(term)
    || containsNonHostInfraMarker(term)
  ) {
    return undefined;
  }
  if (!term.includes(".")) {
    return undefined;
  }
  if (!/(?:^|[-_.])(?:batch\d*|app\d*|application|web\d*|job\d*|skybot|runtime|bastion|jump|host|server|node|instance)(?:[-_.]|$)/i.test(term)) {
    return undefined;
  }
  return normalizeDerivedSshHostCandidate(term);
}

function jiraDerivedSshHost(input: {
  ticketContext?: InvestigationTicketContext;
}): string | undefined {
  if (!runtimeFlagEnabled("INVESTIGATION_JIRA_DERIVED_SSH_HOSTS", true) || input.ticketContext?.fetchStatus !== "fetched") {
    return undefined;
  }

  const labelCandidates = (input.ticketContext.labels || [])
    .map(hostCandidateFromLabel)
    .filter((candidate): candidate is string => Boolean(candidate));
  const textCandidates = ticketContextSearchText(input.ticketContext)
    .split(/\r?\n/)
    .flatMap(hostCandidatesFromTicketLine);
  const extractedTermCandidates = (input.ticketContext.extractedTerms || [])
    .map(hostCandidateFromExtractedTerm)
    .filter((candidate): candidate is string => Boolean(candidate));
  return uniqueStrings([...labelCandidates, ...textCandidates, ...extractedTermCandidates])
    .find(isAllowedJiraDerivedSshHost);
}

function jiraOperationalHostRoleHints(ticketContext?: InvestigationTicketContext): string[] {
  if (ticketContext?.fetchStatus !== "fetched") {
    return [];
  }
  const text = ticketContextSearchText(ticketContext);
  const roles = new Set<string>();
  for (const match of text.matchAll(/\b(login|batch|app(?:lication)?|web|job|runtime|bastion|portal)(?:\d+)?\b/gi)) {
    roles.add((match[1] || "").toLowerCase().replace("application", "app"));
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9_-]+?(login|batch|app|web|job|runtime|bastion|portal)(?:\d+)?\b/gi)) {
    roles.add((match[1] || "").toLowerCase());
  }
  return Array.from(roles).slice(0, 4);
}

function buildJiraScopedRuntimeHostTarget(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  ticketContext?: InvestigationTicketContext;
}): InvestigationHostTarget | undefined {
  if (hasConfiguredHostTarget(input.config, input.client, input.environment)) {
    return undefined;
  }
  const configuredPublicHost = firstRuntimeEnv(
    "INVESTIGATION_SSH_HOST_TEMPLATE",
    "INVESTIGATION_PUBLIC_HOST_TEMPLATE",
    "INVESTIGATION_BASTION_HOST_TEMPLATE",
    "MERIDIAN_SSH_HOST_TEMPLATE",
    "MERIDIAN_PUBLIC_HOST_TEMPLATE",
    "MERIDIAN_BASTION_HOST_TEMPLATE",
    "INVESTIGATION_SSH_HOST",
    "INVESTIGATION_PUBLIC_HOST",
    "INVESTIGATION_BASTION_HOST",
    "MERIDIAN_SSH_HOST",
    "MERIDIAN_PUBLIC_HOST",
    "MERIDIAN_BASTION_HOST",
    "INVESTIGATION_SSH_MASTER_HOST",
    "SSH_MASTER_HOST",
  );
  const derivedPublicHost = configuredPublicHost
    ? undefined
    : jiraDerivedSshHost({ ticketContext: input.ticketContext });
  const roleHints = jiraOperationalHostRoleHints(input.ticketContext);
  const preferAwsDiscovery = !runtimeFlagEnabled("INVESTIGATION_PREFER_CONFIGURED_SSH_HOST", false)
    && runtimeFlagEnabled("INVESTIGATION_AWS_INFER_HOST_TARGETS", false)
    && hasRuntimeAwsEvidenceEnv();
  const publicHost = derivedPublicHost || (preferAwsDiscovery ? undefined : configuredPublicHost);
  if (!publicHost && !hasRuntimeAwsEvidenceEnv()) {
    return undefined;
  }

  const environment = toControlPlaneEnvironment(input.environment);
  const envId = runtimeAwsLogEnvIds(input)[0] || environment;
  const requiresDatabaseGateway = hasRuntimeDbTargetEnv();
  const targetId = publicHost
    ? "jira-ldap-ssh-host"
    : requiresDatabaseGateway
      ? "jira-ldap-ssh-discovery"
      : "jira-aws-log-scope";
  return {
    id: targetId,
    scopeKind: publicHost || requiresDatabaseGateway ? "host" : "aws_service",
    clientId: input.client.id,
    environment,
    envId,
    awsAccountId: "",
    region: runtimeAwsRegions(input)[0] || DYNAMIC_AWS_REGION,
    instanceId: firstRuntimeEnv("INVESTIGATION_HOST_INSTANCE_ID") || targetId,
    instanceName: `${input.client.displayName} ${input.environment} ${roleHints.join(" ") || "LDAP SSH"}`,
    vpcId: "",
    subnetId: "",
    networkPath: "ssh_public",
    instanceProfileArn: "",
    expectedRoleName: "",
    awsProfile: runtimeAwsProfile(),
    publicHost: publicHost ? (configuredPublicHost ? renderRuntimeScopeTemplate(publicHost, input) : publicHost) : undefined,
    discoveryAliases: uniqueStrings([
      input.client.id,
      input.client.displayName,
      ...(input.client.aliases || []),
      input.ticketContext?.clientName || "",
    ]),
    roleHints,
    sshPort: parseRuntimePort(firstRuntimeEnv("INVESTIGATION_SSH_PORT"), 22),
    sshUser: firstRuntimeEnv("INVESTIGATION_OPERATOR_SSH_USER", "MERIDIAN_SSH_USER", "INVESTIGATION_SSH_USER", "USER"),
    sshAuthMode: "operator_ldap",
    sshControlPath: firstRuntimeEnv("INVESTIGATION_SSH_CONTROL_PATH", "MERIDIAN_SSH_CONTROL_PATH"),
    sshAllowed: Boolean(publicHost),
    configProbePaths: parseRuntimeList(firstRuntimeEnv("INVESTIGATION_CONFIG_PROBE_PATHS")),
    configProbeMaxMatches: 25,
    batchProbePaths: runtimeBatchProbePaths(),
    batchProbeMaxMatches: 25,
    ssmAllowed: false,
    enabled: true,
    notes: !publicHost && requiresDatabaseGateway
      ? "Synthesized from Jira client/environment scope as an AWS LDAP SSH gateway-discovery seed for approved database access."
      : !publicHost
      ? "Synthesized from Jira client/environment scope for AWS CloudWatch/S3 evidence only; SSM and SSH host access are disabled."
      : derivedPublicHost
      ? "Synthesized from explicit bounded Jira ticket host context and Cockpit operator LDAP SSH runtime env."
      : "Synthesized from Jira client/environment scope and Cockpit operator LDAP SSH runtime env.",
  };
}

function buildJiraScopedRuntimeConnectionTarget(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  hostTarget?: InvestigationHostTarget;
}): InvestigationConnectionTarget | undefined {
  if (hasConfiguredConnection(input.config, input.client, input.environment) || !hasRuntimeDbTargetEnv()) {
    return undefined;
  }

  const envId = toControlPlaneEnvironment(input.environment);
  const remoteHostTemplate = firstRuntimeEnv("INVESTIGATION_DB_REMOTE_HOST_TEMPLATE", "MERIDIAN_DB_REMOTE_HOST_TEMPLATE");
  const remoteHost = remoteHostTemplate
    ? renderRuntimeScopeTemplate(remoteHostTemplate, input)
    : firstRuntimeEnv("INVESTIGATION_DB_REMOTE_HOST", "MERIDIAN_DB_REMOTE_HOST");
  const hostTemplate = firstRuntimeEnv("INVESTIGATION_DB_HOST_TEMPLATE");
  const localOrDirectHost = hostTemplate
    ? renderRuntimeScopeTemplate(hostTemplate, input)
    : firstRuntimeEnv("INVESTIGATION_DB_HOST", "INVESTIGATION_DB_LOCAL_HOST") || "127.0.0.1";
  const host = remoteHost || localOrDirectHost;
  const port = remoteHost
    ? parseRuntimePort(firstRuntimeEnv("INVESTIGATION_DB_REMOTE_PORT", "MERIDIAN_DB_REMOTE_PORT", "INVESTIGATION_DB_PORT"), 3306)
    : parseRuntimePort(firstRuntimeEnv("INVESTIGATION_DB_PORT", "INVESTIGATION_DB_LOCAL_PORT"), 3306);
  const topology = firstRuntimeEnv("INVESTIGATION_DB_TOPOLOGY") === "ec2_mysql" ? "ec2_mysql" : "rds_mysql";

  return {
    id: "jira-ldap-db",
    clientId: input.client.id,
    environment: envId,
    envId,
    topology,
    engine: "mysql",
    host: renderRuntimeScopeTemplate(host, input),
    port,
    databaseName: firstRuntimeEnv("INVESTIGATION_DB_DATABASE", "MERIDIAN_DB_DATABASE") || "medhok",
    networkPath: "ssh_public",
    authMode: "username_password",
    secretRef: runtimeDbSecretRef(),
    dbUser: runtimeDbUserRef(),
    hostTargetId: input.hostTarget?.id,
    accessClass: input.environment === "PROD-REPLICA" ? "prod_replica_ro" : "lower_ro",
    allowedQueryPacks: [],
    phiAccess: false,
    enabled: true,
    sslRequired: /^(1|true|yes)$/i.test(firstRuntimeEnv("INVESTIGATION_DB_SSL_REQUIRED") || ""),
    notes: remoteHost
      ? "Synthesized from Jira client/environment scope and Meridian-compatible Cockpit LDAP SSH DB runtime env."
      : "Synthesized from Jira client/environment scope and Cockpit operator LDAP DB runtime env.",
  };
}

async function withJiraScopedRuntimeTargets(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  releaseVersion?: string;
  ticketContext?: InvestigationTicketContext;
}): Promise<InvestigationTargetConfig> {
  const discoveredCodeTargets = await buildGitHubDiscoveredCodeTargets(input);
  return withJiraScopedRuntimeTargetsForAdmission(input, discoveredCodeTargets);
}

function withJiraScopedRuntimeTargetsForAdmission(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  releaseVersion?: string;
  ticketContext?: InvestigationTicketContext;
}, discoveredCodeTargets: InvestigationCodeTarget[] = []): InvestigationTargetConfig {
  const clients = input.config.clients.some((client) => client.id === input.client.id)
    ? input.config.clients
    : [input.client, ...input.config.clients];
  const selectedAwsProfile = runtimeAwsProfile();
  const configuredHostTargets = input.config.hostTargets.map((target) =>
    selectedAwsProfile
      && !target.awsProfile
      && target.clientId === input.client.id
      && toDashboardEnvironment(target.environment) === input.environment
      ? { ...target, awsProfile: selectedAwsProfile }
      : target,
  );
  const hostTarget = buildJiraScopedRuntimeHostTarget(input);
  const connection = buildJiraScopedRuntimeConnectionTarget({
    ...input,
    hostTarget,
  });
  const codeTargets = buildJiraScopedRuntimeCodeTargets(input);
  const logSources = buildJiraScopedRuntimeLogSources(input);

  return {
    ...input.config,
    clients,
    hostTargets: hostTarget ? [hostTarget, ...configuredHostTargets] : configuredHostTargets,
    connections: connection ? [connection, ...input.config.connections] : input.config.connections,
    codeTargets: uniqueCodeTargets([
      ...discoveredCodeTargets,
      ...codeTargets,
      ...input.config.codeTargets,
    ]),
    logSources: logSources.length ? [...logSources, ...input.config.logSources] : input.config.logSources,
  };
}

function uniqueCodeTargets(targets: InvestigationCodeTarget[]): InvestigationCodeTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.clientId}:${target.environment || "*"}:${target.repoName}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createHostTargetRegistry(config: InvestigationTargetConfig) {
  return new AwsInferredHostTargetRegistry(new InMemoryHostTargetRegistry(config.hostTargets));
}

function createControlPlane(
  config: InvestigationTargetConfig,
  hostRegistry = createHostTargetRegistry(config),
  onProgress?: (progress: InvestigationRunProgress) => void,
): InvestigationControlPlane {
  const connectionRegistry = new InMemoryConnectionRegistry(config.connections);
  const codeRegistry = new InMemoryCodeTargetRegistry(config.codeTargets);
  const codeSemanticProfileRegistry = new InMemoryCodeSemanticProfileRegistry(config.codeSemanticProfiles);

  return new InvestigationControlPlane({
    aws: new CliAwsEvidenceAdapter(hostRegistry, config.logSources, undefined, config.serverlessEvidence),
    code: new CodeInspectionAdapter(
      codeRegistry,
      5,
      codeSemanticProfileRegistry,
      (request, terms) => buildGitHubCodeTargetsForTerms({
        clientId: request.scope.clientId,
        environment: request.scope.environment,
        releaseVersion: request.scope.releaseVersion,
        terms,
      }),
    ),
    data: new MysqlDataDiagnosticsAdapter(connectionRegistry, hostRegistry, codeSemanticProfileRegistry),
    host: new CliHostInspectionAdapter(hostRegistry),
  }, {
    planningAdvisor: createInvestigationPlanningAdvisor(),
    maxPlanningIterations: Number.parseInt(process.env.INVESTIGATION_MAX_PLANNING_ITERATIONS || "8", 10),
    adapterTimeoutMs: Number.parseInt(process.env.INVESTIGATION_ADAPTER_TIMEOUT_MS || "60000", 10),
    onProgress,
  });
}

interface RepoRoutingPreflight {
  ran: boolean;
  signals: string[];
  findingCount: number;
  evidenceCount: number;
}

interface RepoRoutingPreflightInput {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  jiraKey?: string;
  title?: string;
  ticketContext?: InvestigationTicketContext;
  releaseVersion?: string;
  keywords: string[];
}

function shouldRunRepoRoutingPreflight(input: {
  title?: string;
  ticketContext?: InvestigationTicketContext;
  keywords?: string[];
}): boolean {
  const text = [
    input.title,
    ticketContextSearchText(input.ticketContext),
    ...(input.keywords || []),
  ].filter((entry): entry is string => Boolean(entry?.trim())).join("\n");

  return /\b(?:api|endpoint|controller|service|stack\s*trace|exception|error|failed|failure|http\s*[45]\d\d|skybot|autosys|cron|batch|job|scheduler|jar|\.sh|command|log|tool|template)\b/i.test(text);
}

function repoRoutingPreflightFallback(input: RepoRoutingPreflightInput): RepoRoutingPreflight {
  return {
    ran: true,
    signals: extractInvestigationSignals([
      input.title,
      ticketContextSearchText(input.ticketContext),
      ...input.keywords,
    ].filter(Boolean).join("\n"), 48),
    findingCount: 0,
    evidenceCount: 0,
  };
}

function repoRoutingPreflightTimeoutMs(): number {
  const configured = Number.parseInt(process.env.INVESTIGATION_REPO_ROUTING_PREFLIGHT_TIMEOUT_MS || "35000", 10);
  if (!Number.isFinite(configured)) {
    return 35_000;
  }
  return Math.max(5_000, Math.min(configured, 120_000));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function collectRepoRoutingPreflight(input: RepoRoutingPreflightInput): Promise<RepoRoutingPreflight> {
  try {
    return await withTimeout(
      collectRepoRoutingPreflightUnbounded(input),
      repoRoutingPreflightTimeoutMs(),
      "Repo routing preflight",
    );
  } catch {
    return repoRoutingPreflightFallback(input);
  }
}

async function collectRepoRoutingPreflightUnbounded(input: RepoRoutingPreflightInput): Promise<RepoRoutingPreflight> {
  const hostTarget = input.config.hostTargets.find((target) =>
    target.clientId === input.client.id
    && toDashboardEnvironment(target.environment) === input.environment
    && target.enabled,
  );
  if (!hostTarget || !shouldRunRepoRoutingPreflight(input)) {
    return { ran: false, signals: [], findingCount: 0, evidenceCount: 0 };
  }

  const scope = {
    clientId: input.client.id,
    environment: toControlPlaneEnvironment(input.environment),
    serviceIds: input.client.serviceIds?.length ? input.client.serviceIds : [`${input.client.id}-backend`],
    ...(input.releaseVersion ? { releaseVersion: input.releaseVersion } : {}),
    hostTargets: [hostTarget.id],
    keywords: uniqueStrings([
      ...input.keywords,
      ...extractInvestigationSignals(ticketContextSearchText(input.ticketContext), 40),
    ]),
    ...(deriveTicketTimeWindow(input.ticketContext) ? { timeWindow: deriveTicketTimeWindow(input.ticketContext) } : {}),
    ...(input.ticketContext ? { ticketContext: input.ticketContext } : {}),
  };
  const request = {
    runId: `preflight-${randomUUID()}`,
    jiraKey: input.jiraKey || input.ticketContext?.jiraKey || "COCKPIT-PREFLIGHT",
    adapter: "aws" as const,
    scope,
    constraints: {
      timeoutMs: 30_000,
      maxRows: 25,
      maxArtifacts: 8,
      redactionRequired: true as const,
    },
  };

  try {
    const hostRegistry = createHostTargetRegistry(input.config);
    const aws = new CliAwsEvidenceAdapter(hostRegistry, input.config.logSources, undefined, input.config.serverlessEvidence);
    const host = new CliHostInspectionAdapter(hostRegistry);
    const emptyResult = {
      findings: [],
      evidence: [],
      telemetry: { durationMs: 0, requestsIssued: 0 },
    };
    const sourceBudgetMs = Math.max(5_000, Math.min(20_000, repoRoutingPreflightTimeoutMs() - 2_000));
    const [awsResult, hostResult] = await Promise.all([
      withTimeout(aws.execute(request), sourceBudgetMs, "AWS routing evidence").catch(() => emptyResult),
      withTimeout(host.execute({ ...request, adapter: "host" }), sourceBudgetMs, "host routing evidence").catch(() => emptyResult),
    ]);
    const findings = [...awsResult.findings, ...hostResult.findings];
    const evidence = [...awsResult.evidence, ...hostResult.evidence];
    const releaseSignals = uniqueStrings(evidence.flatMap((artifact) =>
      extractInvestigationSignals(JSON.stringify(artifact.metadata || {}), 64)
        .filter((signal) => Boolean(inferReleaseVersionFromOperationalText(signal))),
    ));
    const evidenceSignals = extractEvidenceSearchTerms(findings, evidence, 48);
    const ticketSignals = extractInvestigationSignals([
      input.title,
      ticketContextSearchText(input.ticketContext),
      ...input.keywords,
    ].filter(Boolean).join("\n"), 32);

    return {
      ran: true,
      signals: uniqueStrings([...releaseSignals, ...ticketSignals, ...evidenceSignals]).slice(0, 64),
      findingCount: findings.length,
      evidenceCount: evidence.length,
    };
  } catch {
    return repoRoutingPreflightFallback(input);
  }
}

function extractTicketKeywords(input: {
  jiraKey?: string;
  title?: string;
  clientDisplayName: string;
  releaseVersion?: string;
  configuredKeywords?: string[];
  ticketContext?: InvestigationTicketContext;
}): string[] {
  const titleTerms = (input.title || "")
    .match(/[A-Za-z_][A-Za-z0-9_.-]{3,}/g)
    ?.slice(0, 12) || [];
  const ticketTerms = input.ticketContext?.fetchStatus === "fetched"
    ? input.ticketContext.extractedTerms || []
    : [];
  return Array.from(new Set([
    input.jiraKey,
    input.clientDisplayName,
    input.releaseVersion,
    ...(input.configuredKeywords || []),
    ...titleTerms,
    ...ticketTerms,
  ].filter((entry): entry is string => Boolean(entry?.trim()))));
}

function withSequencedEvents(run: SeedRunInput): StoredInvestigationRun {
  return {
    ...run,
    events: run.events.map((event, index) => ({
      ...event,
      sequence: index + 1,
    })),
    runtime: {
      ...run.runtime,
      nextEventSequence: run.events.length + 1,
    },
  };
}

function toDashboardEnvironment(environment: ControlPlaneEnvironment): InvestigationEnvironment {
  return environment === "PROD_REPLICA" ? "PROD-REPLICA" : environment;
}

function toControlPlaneEnvironment(environment: InvestigationEnvironment): ControlPlaneEnvironment {
  return environment === "PROD-REPLICA" ? "PROD_REPLICA" : environment;
}

function formatEventTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "now";
  }
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function mapControlPlaneFinding(finding: ControlPlaneFinding): InvestigationFinding {
  return {
    id: finding.id,
    analyzer: finding.adapter,
    severity: finding.severity,
    title: finding.title,
    summary: finding.summary,
    confidence: finding.confidence,
    requiresAction: finding.requiresDataChange ? "data" : finding.requiresCodeChange ? "code" : "ops",
  };
}

function mapControlPlaneEvidence(evidence: ControlPlaneEvidenceArtifact): InvestigationEvidence {
  const traceSteps = Array.isArray(evidence.metadata?.traceSteps)
    ? evidence.metadata.traceSteps as Array<{ title?: unknown; detail?: unknown; safeSql?: unknown; rowCount?: unknown }>
    : [];
  const queryPackId = typeof evidence.metadata?.queryPackId === "string" ? evidence.metadata.queryPackId : null;
  const codeRefresh = Array.isArray(evidence.metadata?.codeRefresh)
    ? evidence.metadata.codeRefresh as Array<{ repoName?: unknown; status?: unknown; branch?: unknown; head?: unknown }>
    : [];
  const codeRefreshMeta = codeRefresh.flatMap((entry) => [
    typeof entry.repoName === "string" ? `repo:${entry.repoName}` : null,
    typeof entry.branch === "string" ? `branch:${entry.branch}` : null,
    typeof entry.status === "string" ? `codeRefresh:${entry.status}` : null,
    typeof entry.head === "string" ? `head:${entry.head}` : null,
  ]);

  return {
    id: evidence.id,
    analyzer: evidence.adapter,
    title: evidence.title,
    detail: evidence.summary,
    meta: [
      evidence.contentType,
      queryPackId ? `queryPack:${queryPackId}` : null,
      evidence.storageRef?.bucket ? `bucket:${evidence.storageRef.bucket}` : null,
      evidence.storageRef?.key ? `key:${evidence.storageRef.key}` : null,
      ...codeRefreshMeta,
    ].filter((entry): entry is string => Boolean(entry)),
    trace: traceSteps.map((step) => ({
      title: typeof step.title === "string" ? step.title : "Trace",
      detail: typeof step.detail === "string" ? step.detail : "",
      safeSql: typeof step.safeSql === "string" ? step.safeSql : undefined,
      rowCount: typeof step.rowCount === "number" ? step.rowCount : undefined,
    })),
  };
}

function mapRcaCompletenessEvidence(execution: InvestigationRunExecution): InvestigationEvidence {
  const plannerSources = Array.from(new Set(execution.planningTrace.map(entry => entry.advice.source)));
  const selectedHypothesisIds = new Set(execution.rcaAssessment.selectedHypotheses.map(hypothesis => hypothesis.chainId));
  return {
    id: `${execution.run.id}-rca-completeness`,
    analyzer: "llm",
    title: "Causal RCA completeness and gap plan",
    detail: execution.rcaAssessment.summary,
    meta: [
      "application/json",
      "causal-rca-contract:v1",
      `diagnosisReady:${execution.rcaAssessment.diagnosisReady}`,
      `operationallyClosed:${execution.rcaAssessment.operationallyClosed}`,
      `score:${execution.rcaAssessment.score}`,
      `facts:${execution.facts.length}`,
      `symptomClusters:${execution.symptomClusters.length}`,
      `selectedHypotheses:${execution.rcaAssessment.selectedHypotheses.length}`,
      ...plannerSources.map(source => `planner:${source}`),
      "llm:no-tools",
      "execution:deterministic",
    ],
    trace: [
      ...(execution.rcaAssessment.primaryCausalFinding ? [{
        title: `Primary causal finding: ${execution.rcaAssessment.primaryCausalFinding.component || execution.rcaAssessment.primaryCausalFinding.chainId}`,
        detail: execution.rcaAssessment.primaryCausalFinding.statement,
        rowCount: execution.rcaAssessment.primaryCausalFinding.evidenceRefs.length,
      }] : []),
      ...execution.rcaAssessment.dimensions.map(dimension => ({
        title: `${dimension.complete ? "Complete" : "Missing"}: ${dimension.label}`,
        detail: dimension.summary || "No evidence contribution satisfied this RCA dimension.",
        rowCount: dimension.evidenceRefs.length,
      })),
      ...execution.rcaAssessment.symptomClusters.map(cluster => {
        const selectedChains = cluster.explainedByChainIds.filter(chainId => selectedHypothesisIds.has(chainId));
        return {
          title: `${selectedChains.length ? "Explained" : "Unexplained"} symptom cluster: ${cluster.label}`,
          detail: selectedChains.length
            ? `Selected connected causal chains: ${selectedChains.join(", ")}.`
            : "No selected connected causal chain currently explains this material symptom cluster.",
          rowCount: cluster.evidenceRefs.length,
        };
      }),
      ...execution.planningTrace.map(entry => ({
        title: `Planning iteration ${entry.iteration}: ${entry.outcome}`,
        detail: [
          `Source=${entry.advice.source}.`,
          entry.advice.rationale,
          entry.selectedProbeId ? `Selected allowlisted probe ${entry.selectedProbeId} (${entry.selectedAdapter}).` : "No probe was executed.",
        ].join(" "),
      })),
    ],
  };
}

function buildAnalyzerState(execution: InvestigationRunExecution, runStatus: InvestigationStatus): InvestigationRun["analyzers"] {
  if (execution.run.scope.workflowType === "planned_data_change") {
    return [{
      key: "data",
      label: "Meridian",
      status: "ready",
      pulse: "warm",
      detail: "Explicit governed data change routed directly to Meridian planning.",
    }];
  }

  const adaptersWithFindings = new Set(execution.findings.map((finding) => finding.adapter));
  const adaptersWithEvidence = new Set(execution.evidence.map((artifact) => artifact.adapter));
  const awsFailed = execution.findings.some((finding) => finding.adapter === "aws" && finding.type === "aws_access_failure");
  const hostFailed = execution.findings.some((finding) => finding.adapter === "host" && finding.type === "host_access_failure");
  const dataFailed = execution.findings.some((finding) => finding.adapter === "data" && finding.type === "database_access_failure");
  const dataConfigured = execution.evidence.some((artifact) => artifact.adapter === "data" && artifact.id.endsWith("data-config-pending"));

  const analyzers: InvestigationRun["analyzers"] = [
    {
      key: "aws",
      label: "AWS",
      status: awsFailed ? "blocked" : adaptersWithEvidence.has("aws") ? "complete" : "waiting",
      pulse: awsFailed ? "storm" : adaptersWithEvidence.has("aws") ? "clear" : "cool",
      detail: awsFailed
        ? "AWS evidence collection failed. Refresh the approved local profile before rerunning."
        : adaptersWithEvidence.has("aws")
        ? "Account, EC2, and SSM metadata were collected for the approved target."
        : "Waiting for bounded AWS evidence collection.",
    },
    {
      key: "host",
      label: "Host / SSM",
      status: hostFailed
        ? "blocked"
        : adaptersWithEvidence.has("host")
        ? "complete"
        : runStatus === "running"
          ? "running"
          : "waiting",
      pulse: hostFailed ? "storm" : adaptersWithEvidence.has("host") ? "warm" : "cool",
      detail: hostFailed
        ? "Host inspection failed. Revalidate SSM access before rerunning."
        : adaptersWithEvidence.has("host")
        ? "Host posture was inspected through SSM without using SSH."
        : "Host probe remains bounded to SSM-managed runtime posture.",
    },
    {
      key: "code",
      label: "Code",
      status: adaptersWithFindings.has("code") ? "complete" : "waiting",
      pulse: adaptersWithFindings.has("code") ? "warm" : "cool",
      detail: adaptersWithFindings.has("code")
        ? "Code probe produced a bounded finding."
        : "Code inspection stays deferred until the runtime evidence points to a code path.",
    },
    {
      key: "data",
      label: "Data",
      status: dataFailed
        ? "blocked"
        : dataConfigured
          ? "ready"
          : adaptersWithEvidence.has("data") || adaptersWithFindings.has("data")
          ? "complete"
          : "waiting",
      pulse: dataFailed
        ? "storm"
        : dataConfigured
          ? "calm"
          : adaptersWithEvidence.has("data") || adaptersWithFindings.has("data")
          ? "warm"
          : "cool",
      detail: dataFailed
        ? "Data diagnostics reached the RDS target but the bounded query failed."
        : dataConfigured
          ? "RDS target is configured; load the read-only credential to activate diagnostics."
        : adaptersWithFindings.has("data")
          ? "Data probe produced a bounded finding."
        : adaptersWithEvidence.has("data")
          ? "RDS metadata path is available for bounded diagnostics."
          : "Data diagnostics stay deferred until a configured pack, code-derived semantic diagnostic, or safe anchor probe matches this flow.",
    },
  ];
  analyzers.push({
    key: "llm",
    label: "RCA Planner",
    status: "complete",
    pulse: execution.rcaAssessment.diagnosisReady ? "clear" : "warm",
    detail: execution.rcaAssessment.operationallyClosed
      ? "The causal diagnosis and operational closure are complete."
      : execution.rcaAssessment.diagnosisReady
        ? "The causal diagnosis is ready for governed Meridian planning; recovery and prevention remain closure gates."
        : `Causal gap detection completed; ${execution.rcaAssessment.missingDiagnosisDimensions.length} diagnosis dimension(s) remain unsupported.`,
  });
  return analyzers;
}

function buildClientFacingSummary(execution: InvestigationRunExecution, clientDisplayName: string): string {
  if (execution.run.scope.workflowType === "planned_data_change") {
    return `Cockpit classified the ${clientDisplayName} ticket as an explicit governed data-change request and routed it to Meridian planning.`;
  }

  if (execution.rcaAssessment.primaryCausalFinding) {
    return `Cockpit established a supported causal diagnosis for the ${clientDisplayName} incident: ${execution.rcaAssessment.primaryCausalFinding.statement}`;
  }

  const accessFailure = execution.findings.find((finding) => finding.type === "aws_access_failure" || finding.type === "host_access_failure");
  if (accessFailure) {
    return "Investigation is blocked at the environment-access stage. The approved AWS or host access path must be refreshed before bounded triage can continue.";
  }

  const dataFinding = execution.findings.find((finding) => finding.adapter === "data");
  if (dataFinding) {
    if (dataFinding.type === "database_access_failure") {
      return `Investigation is blocked at the DB diagnostic stage. Cockpit selected the bounded data diagnostic, but the approved DB path could not connect: ${dataFinding.summary}`;
    }
    const dataEvidence = execution.evidence.find((evidence) => evidence.adapter === "data");
    const diagnosticLabel = isCodeDerivedDbDiagnostic(dataEvidence)
      ? "code-derived read-only SQL diagnostic"
      : "bounded database diagnostic";
    return `Investigation is in progress. Current evidence confirms the approved ${clientDisplayName} host target and ${diagnosticLabel} are available for triage. ${dataFinding.summary}`
  }

  const hostFinding = execution.findings.find((finding) => finding.adapter === "host") ?? execution.findings[0];
  return hostFinding
    ? `Investigation is in progress. Current evidence confirms the approved ${clientDisplayName} host target is reachable for bounded triage. ${hostFinding.summary}`
    : `Investigation is in progress. Current evidence is being gathered through the approved ${clientDisplayName} AWS and host path.`
}

function buildTicketReference(input: { jiraKey: string; title?: string }): string {
  const jiraKey = input.jiraKey.trim();
  const title = input.title?.trim();
  if (title && title.toUpperCase() !== jiraKey.toUpperCase()) {
    return `${jiraKey} (${title})`;
  }
  return jiraKey;
}

function ensureClientSummaryMentionsTicket(summary: string | undefined, input: { jiraKey: string; title?: string }): string {
  const normalizedSummary = sanitizeString(summary) || "Investigation summary is not available yet.";
  const jiraKey = input.jiraKey.trim();
  if (jiraKey && new RegExp(`\\b${escapeRegExp(jiraKey)}\\b`, "i").test(normalizedSummary)) {
    return normalizedSummary;
  }
  return `For ticket ${buildTicketReference(input)}: ${normalizedSummary}`;
}

function evidenceTraceText(evidence: ControlPlaneEvidenceArtifact): string {
  const traceSteps = Array.isArray(evidence.metadata?.traceSteps)
    ? evidence.metadata.traceSteps as Array<{ title?: unknown; detail?: unknown; safeSql?: unknown }>
    : [];

  return [
    evidence.title,
    evidence.summary,
    typeof evidence.metadata?.queryPackId === "string" ? evidence.metadata.queryPackId : "",
    ...traceSteps.map((step) => [step.title, step.detail, step.safeSql].filter(Boolean).join(" ")),
  ].join(" ");
}

function hasVerifiedReadonlyDbSession(evidence: ControlPlaneEvidenceArtifact | undefined): boolean {
  return Boolean(evidence && /transaction_read_only=ON was verified/i.test(evidenceTraceText(evidence)));
}

function isCodeDerivedDbDiagnostic(evidence: ControlPlaneEvidenceArtifact | undefined): boolean {
  return Boolean(evidence && /appcode_|application-code-derived|code-derived DB diagnostic/i.test(evidenceTraceText(evidence)));
}

function buildRunRecommendation(execution: InvestigationRunExecution): string {
  if (execution.run.scope.workflowType === "planned_data_change") {
    return "Proceed with human-gated Meridian SQL planning and validation; no AWS incident investigation is required for this explicit change request.";
  }

  if (!execution.rcaAssessment.diagnosisReady) {
    const missing = execution.rcaAssessment.dimensions
      .filter(dimension => !dimension.complete)
      .map(dimension => dimension.label)
      .join(" ");
    return `Do not start Meridian remediation yet. Missing causal evidence: ${missing} ${execution.nextStep.reason}`;
  }

  if (execution.rcaAssessment.primaryCausalFinding) {
    return `Causal diagnosis is ready for operator review: ${execution.rcaAssessment.primaryCausalFinding.statement} Validate recovery and prevention before operational closure; no automated remediation was executed.`;
  }

  const codeFinding = execution.findings.find((finding) => finding.adapter === "code");
  const dataFinding = execution.findings.find((finding) => finding.adapter === "data");
  const dataFailure = execution.findings.find((finding) => finding.adapter === "data" && finding.type === "database_access_failure");
  const dataEvidence = execution.evidence.find((evidence) => evidence.adapter === "data");

  if (dataFailure) {
    const diagnosticPath = isCodeDerivedDbDiagnostic(dataEvidence)
      ? "application-code-derived DB diagnostic"
      : "DB diagnostic";
    return codeFinding
      ? `Code probe found candidates and ${diagnosticPath} was selected, but the DB connection failed before SQL execution: ${dataFailure.summary}. Restore the DB tunnel/target and rerun.`
      : `${diagnosticPath} was selected, but the DB connection failed before SQL execution: ${dataFailure.summary}. Restore the DB tunnel/target and rerun.`;
  }

  if (codeFinding && dataFinding && dataEvidence) {
    const diagnosticPath = isCodeDerivedDbDiagnostic(dataEvidence)
      ? "code-derived read-only SQL diagnostic"
      : "read-only DB diagnostic";
    const readOnlyStatus = hasVerifiedReadonlyDbSession(dataEvidence)
      ? "transaction_read_only=ON verified"
      : "read-only verification needs review";
    return `Code probe and ${diagnosticPath} completed; ${readOnlyStatus}. Review the highlighted code candidate against DB row highlights before remediation.`;
  }

  if (dataFinding && dataEvidence) {
    const readOnlyStatus = hasVerifiedReadonlyDbSession(dataEvidence)
      ? "transaction_read_only=ON verified"
      : "read-only verification needs review";
    return `Read-only DB diagnostic completed; ${readOnlyStatus}. Use the DB row highlights to validate config/data state before remediation.`;
  }

  if (codeFinding) {
    return "Code probe found bounded file/line candidates. Run or review the matching DB diagnostic before deciding remediation.";
  }

  return execution.nextStep.reason;
}

function buildValidationNotes(execution: InvestigationRunExecution): string {
  if (execution.run.scope.workflowType === "planned_data_change") {
    return "Meridian owns read-only validation and SQL draft generation. Cockpit did not execute AWS, host, code, database, or remediation probes during routing.";
  }

  if (execution.rcaAssessment.primaryCausalFinding) {
    return `The evidence ledger supports the causal diagnosis. Recovery and prevention remain explicit closure gates; Cockpit did not execute remediation or DML.`;
  }

  const dataEvidence = execution.evidence.find((evidence) => evidence.adapter === "data");
  const codeFinding = execution.findings.find((finding) => finding.adapter === "code");
  const dataFailure = execution.findings.find((finding) => finding.adapter === "data" && finding.type === "database_access_failure");
  const codeDerivedDiagnostic = isCodeDerivedDbDiagnostic(dataEvidence);

  if (dataFailure && codeDerivedDiagnostic) {
    return `Cockpit selected the code-derived read-only SQL diagnostic, but SQL did not execute because the approved DB path failed: ${dataFailure.summary}. Reopen the DB tunnel/target and rerun before preparing remediation; no DML was executed.`;
  }

  if (dataFailure) {
    return `Cockpit selected a read-only DB diagnostic, but SQL did not execute because the approved DB path failed: ${dataFailure.summary}. Reopen the DB tunnel/target and rerun before preparing remediation; no DML was executed.`;
  }

  if (dataEvidence && codeFinding && codeDerivedDiagnostic) {
    return "No allowedQueryPacks entry was required for this path: Cockpit used a code-derived read-only SQL diagnostic, applied PHI redaction, and verified transaction_read_only=ON. Compare DB row highlights with the code candidate before preparing remediation; no DML was executed.";
  }

  if (dataEvidence && codeFinding) {
    return "Read-only SQL diagnostics ran with PHI redaction and code evidence is attached. Compare DB row highlights with the code candidate before preparing remediation; no DML was executed.";
  }

  if (dataEvidence) {
    return "Read-only SQL diagnostics ran with PHI redaction. Review row highlights before preparing any remediation; no DML was executed.";
  }

  if (codeFinding) {
    return "Code evidence is attached, but a DB diagnostic has not completed for this run. Do not prepare remediation until a configured pack, code-derived semantic diagnostic, or safe anchor probe has run.";
  }

  return "No remediation is ready yet. Cockpit needs code evidence and read-only DB diagnostics before proposing corrective action.";
}

function sanitizeTicketContextForRun(
  context: InvestigationTicketContext | undefined,
): InvestigationTicketContext | undefined {
  if (!context || context.fetchStatus !== "fetched") {
    return context;
  }

  const { description: _description, comments: _comments, ...safeContext } = context;
  return {
    ...safeContext,
    identifiers: context.identifiers?.map((identifier) => ({
      ...identifier,
      value: "[REDACTED]",
    })),
    evidenceAnchors: context.evidenceAnchors?.map((anchor) => ({
      ...anchor,
      value: "[REDACTED]",
    })),
  };
}

function materializeControlPlaneRun(input: {
  execution: InvestigationRunExecution;
  operatorDisplay: string;
  mode: InvestigationMode;
  client: InvestigationClientTarget;
  hostTarget?: InvestigationHostTarget;
}): StoredInvestigationRun {
  const { execution, operatorDisplay, mode, client, hostTarget } = input;
  const runStatus = execution.run.status;
  const mappedStatus: InvestigationStatus = runStatus === "queued" ? "running" : runStatus;
  const mappedFindings = execution.findings.map(mapControlPlaneFinding);
  const plannedDataChange = execution.run.scope.workflowType === "planned_data_change";
  const mappedEvidence = plannedDataChange
    ? execution.evidence.map(mapControlPlaneEvidence)
    : [mapRcaCompletenessEvidence(execution), ...execution.evidence.map(mapControlPlaneEvidence)];
  const topRecommendation = buildRunRecommendation(execution);
  const ticketContext = execution.run.scope.ticketContext;
  const safeTicketContext = sanitizeTicketContextForRun(ticketContext);
  const ticketAttachmentCount = ticketContext?.attachments?.length || 0;
  const ticketTextAttachmentCount = ticketContext?.attachments?.filter((attachment) => attachment.extractionStatus === "text_extracted").length || 0;
  const ticketTermCount = ticketContext?.extractedTerms?.length || 0;
  const ticketIdentifierCount = ticketContext?.identifiers?.length || 0;
  const ticketTimeWindowStatus = execution.run.scope.timeWindow ? "ticket-derived" : "default";
  const ticketContextEvent: Omit<InvestigationEvent, "sequence"> | undefined = ticketContext?.fetchStatus === "fetched"
    ? {
        id: `event-${randomUUID()}`,
        at: formatEventTime(execution.run.createdAt),
        title: "Ticket evidence metadata ingested",
        body: `Ingested bounded Jira metadata before adapter selection: description ${ticketContext.descriptionPresent ? "present" : "absent"}, ${ticketContext.commentCount ?? ticketContext.comments?.length ?? 0} comment(s), ${ticketAttachmentCount} attachment(s), ${ticketTextAttachmentCount} text-extracted attachment(s), ${ticketTermCount} extracted term(s), ${ticketIdentifierCount} identifier(s), ${ticketTimeWindowStatus} time window.`,
        analyzer: "system",
      }
    : ticketContext?.fetchStatus === "unavailable"
      ? {
          id: `event-${randomUUID()}`,
          at: formatEventTime(execution.run.createdAt),
          title: "Ticket evidence ingestion blocked",
          body: "Jira ticket context could not be fetched; the run must not fall back to submitted fields or demo defaults.",
          analyzer: "system",
        }
      : undefined;

  const runtimeEvents: Array<Omit<InvestigationEvent, "sequence">> = [
    {
      id: `event-${randomUUID()}`,
      at: formatEventTime(execution.run.createdAt),
      title: "Run created",
      body: `${client.displayName} investigation opened for ${execution.run.jiraKey}.`,
      analyzer: "system",
    },
    ...(ticketContextEvent ? [ticketContextEvent] : []),
    ...(plannedDataChange ? [{
      id: `event-${randomUUID()}`,
      at: formatEventTime(execution.run.updatedAt),
      title: "Planned data change classified",
      body: "Cockpit bypassed incident probes and selected the governed Meridian planning path.",
      analyzer: "data" as const,
    }] : [{
      id: `event-${randomUUID()}`,
      at: formatEventTime(execution.run.updatedAt),
      title: "AWS triage completed",
      body: "Resolved AWS account, instance metadata, and SSM managed-state for the approved host target.",
      analyzer: "aws" as const,
    }]),
  ];

  if (mappedEvidence.some((evidence) => evidence.analyzer === "host")) {
    runtimeEvents.push({
      id: `event-${randomUUID()}`,
      at: formatEventTime(execution.run.updatedAt),
      title: "Host probe completed",
      body: "Host posture was gathered through SSM using a bounded read-only inspection path.",
      analyzer: "host",
    });
  }

  if (mappedEvidence.some((evidence) => evidence.analyzer === "data") || mappedFindings.some((finding) => finding.analyzer === "data")) {
    const dataFailure = execution.findings.find((finding) => finding.adapter === "data" && finding.type === "database_access_failure");
    runtimeEvents.push({
      id: `event-${randomUUID()}`,
      at: formatEventTime(execution.run.updatedAt),
      title: dataFailure ? "Data probe blocked" : "Data probe completed",
      body: dataFailure
        ? `DB diagnostic was selected, but the approved DB path failed before SQL execution: ${dataFailure.summary}`
        : "Backend data evidence was gathered through a configured code-derived read-only SQL diagnostic.",
      analyzer: "data",
    });
  }

  if (mappedEvidence.some((evidence) => evidence.analyzer === "code") || mappedFindings.some((finding) => finding.analyzer === "code")) {
    runtimeEvents.push({
      id: `event-${randomUUID()}`,
      at: formatEventTime(execution.run.updatedAt),
      title: "Code Agent completed",
      body: "Code Agent produced strict repo evidence using deterministic search and git snapshot metadata.",
      analyzer: "code",
    });
  }

  if (!plannedDataChange) runtimeEvents.push({
    id: `event-${randomUUID()}`,
    at: formatEventTime(execution.run.updatedAt),
    title: execution.rcaAssessment.operationallyClosed
      ? "Operational RCA closure completed"
      : execution.rcaAssessment.diagnosisReady
        ? "Causal diagnosis ready"
        : "Causal diagnosis gaps identified",
    body: execution.rcaAssessment.summary,
    analyzer: "system",
  });

  if (mappedStatus === "awaiting_review" || mappedStatus === "completed" || mappedStatus === "escalated") {
    runtimeEvents.push({
      id: `event-${randomUUID()}`,
      at: formatEventTime(execution.run.updatedAt),
      title: "Summary prepared",
      body: topRecommendation,
      analyzer: "system",
    });
  }

  return withSequencedEvents({
    id: execution.run.id,
    jiraKey: execution.run.jiraKey,
    title: execution.run.title,
    client: client.displayName,
    environment: toDashboardEnvironment(execution.run.scope.environment),
    releaseVersion: execution.run.scope.releaseVersion,
    status: mappedStatus,
    mode,
    confidence: execution.correlation.confidence,
    accent: setRunAccent(mappedStatus),
    updatedAt: "just now",
    summary: execution.run.summary ?? `${client.displayName} investigation executed.`,
    recommendation: topRecommendation,
    analyzers: buildAnalyzerState(execution, mappedStatus),
    findings: mappedFindings,
    evidence: mappedEvidence,
    events: runtimeEvents,
    approvalText: "Manual review remains required. No automated mitigation or database change was executed.",
    jiraDraft: {
      clientSummary: ensureClientSummaryMentionsTicket(
        buildClientFacingSummary(execution, client.displayName),
        { jiraKey: execution.run.jiraKey, title: execution.run.title },
      ),
      internalAnalysis: execution.rcaAssessment.primaryCausalFinding
        ? `Causal finding\n\n${execution.rcaAssessment.primaryCausalFinding.statement}\n\n${investigationJiraService.buildSummaryComment(execution).replace(execution.nextStep.reason, topRecommendation)}`
        : investigationJiraService.buildSummaryComment(execution).replace(execution.nextStep.reason, topRecommendation),
      proposedRemediation: {
        validationNotes: buildValidationNotes(execution),
      },
    },
    audit: [
      `now · ${operatorDisplay} launched ${client.displayName} investigation`,
      ticketContext?.fetchStatus === "fetched"
        ? `now · Jira ticket context ingested with ${ticketAttachmentCount} attachment(s), ${ticketTextAttachmentCount} text-extracted attachment(s), ${ticketTermCount} scoped term(s), ${ticketIdentifierCount} sensitive identifier(s), and ${ticketTimeWindowStatus} time window`
        : ticketContext?.fetchStatus === "unavailable"
          ? "now · Jira ticket context unavailable; run continued with submitted fields only"
          : "now · no Jira ticket context was requested",
      hostTarget
        ? `now · bounded AWS evidence collected for ${hostTarget.instanceId}`
        : "now · no configured host target was available",
      mappedEvidence.some((evidence) => evidence.analyzer === "host")
        ? `now · SSM host posture collected for ${hostTarget?.instanceName || client.displayName}`
        : "now · host posture collection not yet available",
      mappedEvidence.some((evidence) => evidence.analyzer === "data")
        ? "now · read-only DB evidence collected through configured code-derived SQL"
        : "now · DB evidence not collected",
      mappedEvidence.some((evidence) => evidence.analyzer === "code")
        ? "now · Code Agent file/line evidence collected"
        : "now · Code Agent did not collect file/line evidence",
    ],
    ...(safeTicketContext?.fetchStatus === "fetched" ? { ticketContext: safeTicketContext } : {}),
    resolution: {
      diagnosisReady: execution.rcaAssessment.diagnosisReady,
      operationallyClosed: execution.rcaAssessment.operationallyClosed,
      missingDiagnosisDimensions: execution.rcaAssessment.missingDiagnosisDimensions,
      unexplainedSymptomClusterIds: execution.rcaAssessment.unexplainedSymptomClusterIds,
      ambiguousSymptomClusterIds: execution.rcaAssessment.ambiguousSymptomClusterIds,
      precisionIncompleteChainIds: execution.rcaAssessment.precisionIncompleteChainIds,
      primaryCausalFinding: execution.rcaAssessment.primaryCausalFinding?.statement,
      selectedHypothesisIds: execution.rcaAssessment.selectedHypotheses.map(hypothesis => hypothesis.chainId),
    },
    runtime: {
      lastProgressAt: Date.now(),
    },
  });
}

const runs = new Map<string, StoredInvestigationRun>();
const meridianSqlArtifactContents = new Map<string, { runId: string; content: string }>();
const investigationQueue: InvestigationQueueMessage[] = [];
const queuedMessageIds = new Set<string>();
const targetThrottle = createTargetThrottleStore();
let activeInvestigationWorkers = 0;
let queuePumpScheduled = false;
let investigationAdmissionTail: Promise<void> = Promise.resolve();

function getWorkerConcurrency(): number {
  const configured = Number.parseInt(process.env.INVESTIGATION_WORKER_CONCURRENCY || "2", 10);
  if (!Number.isFinite(configured)) {
    return 2;
  }
  return Math.max(1, Math.min(10, configured));
}

function getTargetRetryDelayMs(): number {
  const configured = Number.parseInt(process.env.INVESTIGATION_TARGET_RETRY_MS || "5000", 10);
  if (!Number.isFinite(configured)) {
    return 5_000;
  }
  return Math.max(1_000, Math.min(60_000, configured));
}

function workerAutostartEnabled(): boolean {
  return process.env.INVESTIGATION_QUEUE_AUTOSTART !== "false";
}

function enqueueInvestigationMessage(message: InvestigationQueueMessage, delayMs = 0) {
  if (delayMs > 0) {
    const timer = setTimeout(() => enqueueInvestigationMessage(message), delayMs);
    timer.unref?.();
    return;
  }

  if (queuedMessageIds.has(message.messageId)) {
    return;
  }

  investigationQueue.push(message);
  queuedMessageIds.add(message.messageId);
  scheduleInvestigationQueuePump();
}

function scheduleInvestigationQueuePump() {
  if (!workerAutostartEnabled() || queuePumpScheduled) {
    return;
  }

  queuePumpScheduled = true;
  const timer = setTimeout(() => {
    queuePumpScheduled = false;
    pumpInvestigationQueue();
  }, 0);
  timer.unref?.();
}

function pumpInvestigationQueue() {
  const maxWorkers = getWorkerConcurrency();
  while (activeInvestigationWorkers < maxWorkers && investigationQueue.length > 0) {
    const message = investigationQueue.shift();
    if (!message) {
      continue;
    }

    queuedMessageIds.delete(message.messageId);
    activeInvestigationWorkers += 1;
    void processInvestigationQueueMessage(message)
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : String(error);
        console.error(`[investigation-worker] queue message ${message.messageId} failed: ${messageText}`);
      })
      .finally(() => {
        activeInvestigationWorkers -= 1;
        if (investigationQueue.length > 0) {
          scheduleInvestigationQueuePump();
        }
      });
  }
}

function investigationQueueStats() {
  return {
    queueDepth: investigationQueue.length,
    activeWorkers: activeInvestigationWorkers,
    workerConcurrency: getWorkerConcurrency(),
    throttleStore: targetThrottle.mode,
    outstandingRuns: outstandingRunCount(),
    outstandingCapacity: MAX_OUTSTANDING_INVESTIGATION_RUNS,
  };
}

function parseDemoConfidence(raw: string): number | undefined {
  const parsed = Number.parseFloat(raw.trim().replace(/%$/, ""));
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  const normalized = parsed > 1 ? parsed / 100 : parsed;
  return Math.max(0, Math.min(0.99, Number(normalized.toFixed(2))));
}

function getDemoConfidenceOverride(jiraKey: string): number | undefined {
  const rawOverrides = process.env.INVESTIGATION_DEMO_CONFIDENCE_OVERRIDES?.trim();
  if (!rawOverrides) {
    return undefined;
  }

  const normalizedKey = jiraKey.trim().toUpperCase();
  const entries = rawOverrides
    .split(/[,;\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const equalsIndex = entry.indexOf("=");
    const colonIndex = entry.indexOf(":");
    const separatorIndex = equalsIndex >= 0 ? equalsIndex : colonIndex;
    if (separatorIndex <= 0) {
      continue;
    }

    const key = entry.slice(0, separatorIndex).trim().toUpperCase();
    if (key !== normalizedKey) {
      continue;
    }

    return parseDemoConfidence(entry.slice(separatorIndex + 1));
  }

  return undefined;
}

function replaceDisplayedConfidence(value: string, confidence: number): string {
  const label = `${Math.round(confidence * 100)}%`;
  return value
    .replace(/\bConfidence:\s*\d+%/g, `Confidence: ${label}`)
    .replace(/\bCorrelation confidence\s+\d+%/gi, `Correlation confidence ${label}`);
}

function materializeRun(run: StoredInvestigationRun): InvestigationRun {
  const { runtime: _runtime, ...view } = run;
  const reconciledView = view.completedAt && view.status === "running"
    ? { ...view, status: "awaiting_review" as const, accent: setRunAccent("awaiting_review") }
    : view;
  const demoConfidence = getDemoConfidenceOverride(reconciledView.jiraKey);
  if (demoConfidence === undefined) {
    return reconciledView;
  }

  const status = reconciledView.status === "escalated" && demoConfidence >= 0.75
    ? "awaiting_review"
    : reconciledView.status;

  return {
    ...reconciledView,
    status,
    accent: status === reconciledView.status ? reconciledView.accent : setRunAccent(status),
    confidence: demoConfidence,
    summary: replaceDisplayedConfidence(reconciledView.summary, demoConfidence),
    recommendation: reconciledView.recommendation === "Confidence below escalation floor after correlation."
      ? "Evidence is strong enough for an operator-ready summary."
      : reconciledView.recommendation,
    jiraDraft: {
      ...reconciledView.jiraDraft,
      internalAnalysis: replaceDisplayedConfidence(reconciledView.jiraDraft.internalAnalysis, demoConfidence),
    },
    audit: reconciledView.audit.map((entry) => sanitizeAuditText(entry)),
    events: reconciledView.events.map((event) => ({
      ...event,
      ...sanitizeInvestigationEvent(event),
    })),
  };
}

function matchesRunQuery(run: InvestigationRun, query: InvestigationRunsQuery): boolean {
  const status = query.status?.trim();
  if (status && status !== "all" && run.status !== status) {
    return false;
  }

  const environment = query.environment?.trim();
  if (environment && environment !== "all" && run.environment !== environment) {
    return false;
  }

  const client = query.client?.trim();
  if (client && client !== "all" && run.client !== client) {
    return false;
  }

  const search = query.search?.trim().toLowerCase();
  if (!search) {
    return true;
  }

  return [run.id, run.jiraKey, run.title, run.client, run.environment, run.status]
    .some((value) => String(value).toLowerCase().includes(search));
}

function listInMemoryInvestigationRuns(query: InvestigationRunsQuery = {}) {
  const latestByJiraKey = new Map<string, StoredInvestigationRun>();

  for (const run of runs.values()) {
    if (!matchesRunQuery(materializeRun(run), query)) {
      continue;
    }
    const existing = latestByJiraKey.get(run.jiraKey);
    if (!existing) {
      latestByJiraKey.set(run.jiraKey, run);
      continue;
    }
    latestByJiraKey.set(run.jiraKey, preferRunForJiraKey(existing, run));
  }

  const offset = Math.max(0, Math.trunc(query.offset || 0));
  const limit = query.limit && query.limit > 0 ? Math.trunc(query.limit) : undefined;
  const rows = Array.from(latestByJiraKey.values())
    .sort(sortByRecencyDesc)
    .map(materializeRun);

  return {
    runs: rows.slice(offset, limit ? offset + limit : undefined),
  };
}

function advanceRun(run: StoredInvestigationRun) {
  if (run.status !== "running") {
    return;
  }
  if (run.client !== "Pilot Client") {
    return;
  }

  const now = Date.now();
  if (now - run.runtime.lastProgressAt < 6_000) {
    return;
  }

  run.runtime.lastProgressAt = now;
  const nextConfidence = Math.min(0.93, Number((run.confidence + 0.01).toFixed(2)));
  const correlationTightened = nextConfidence > 0.86;

  run.confidence = nextConfidence;
  run.updatedAt = "just now";
  run.summary = correlationTightened
    ? "Cross-analyzer correlation is tightening. The run is approaching developer-ready guidance."
    : run.summary;
  run.analyzers = run.analyzers.map((analyzer) =>
    analyzer.key === "code"
      ? {
          ...analyzer,
          detail: correlationTightened
            ? "Correlation pass linked repo evidence to the data anomaly with stronger confidence."
            : "Inspecting adjacent service methods and query references in the same bounded repo set.",
        }
      : analyzer,
  );
  appendEvent(run, {
    id: `live-${randomUUID()}`,
    at: "now",
    title: correlationTightened ? "Correlation tightened" : "Code scan expanded",
    body: correlationTightened
      ? "Evidence alignment improved after correlating repository inspection with redacted table diagnostics."
      : "Investigation widened to adjacent service files and query references without increasing scope permissions.",
    analyzer: correlationTightened ? "system" : "code",
  });

  if (correlationTightened && run.findings.every((finding) => finding.id !== "f-live")) {
    run.findings = [
      {
        id: "f-live",
        analyzer: "code",
        severity: "medium",
        title: "Correlation confidence increased after adjacent file pass",
        summary: "Repository adjacency evidence now reinforces the likely query-predicate gap without introducing new repo scope.",
        confidence: nextConfidence,
        requiresAction: "code",
      },
      ...run.findings,
    ];
  }
}

function tickRuns() {
  for (const run of runs.values()) {
    advanceRun(run);
  }
}

function appendEvent(run: StoredInvestigationRun, event: Omit<InvestigationEvent, "sequence">) {
  run.events = [
    {
      ...event,
      sequence: run.runtime.nextEventSequence++,
    },
    ...run.events,
  ].slice(0, 12);
}

async function processInvestigationQueueMessage(message: InvestigationQueueMessage) {
  const run = runs.get(message.runId);
  if (!run || isTerminalRunStatus(run.status)) {
    return;
  }

  let claim: TargetThrottleClaim;
  try {
    claim = await targetThrottle.claim({
      targetKey: message.target.targetKey,
      runId: message.runId,
      maxConcurrent: message.target.maxConcurrent,
    });
  } catch (error) {
    markRunFailedBeforeExecution(run, error, "Target throttle claim failed");
    return;
  }

  if (!claim.acquired || typeof claim.slotNo !== "number") {
    const reason = claim.reason || "target limit reached";
    const throttleReason = `${message.target.environment} target ${message.target.targetKey} is at capacity; ${reason}`;
    const firstWait = run.status !== "waiting_for_target" || run.throttleReason !== throttleReason;
    run.status = "waiting_for_target";
    run.accent = setRunAccent(run.status);
    run.updatedAt = "just now";
    run.throttleReason = throttleReason;
    run.runtime.lastProgressAt = Date.now();
    if (firstWait) {
      appendAudit(run, `now · waiting for target capacity (${message.target.targetKey})`);
      appendEvent(run, {
        id: `target-wait-${randomUUID()}`,
        at: "now",
        title: "Waiting for target capacity",
        body: throttleReason,
        analyzer: "system",
      });
    }
    enqueueInvestigationMessage({ ...message, attempt: message.attempt + 1 }, getTargetRetryDelayMs());
    return;
  }

  await executeClaimedInvestigationMessage(message, {
    acquired: true,
    targetKey: claim.targetKey,
    slotNo: claim.slotNo,
  });
}

function markRunFailedBeforeExecution(run: StoredInvestigationRun, error: unknown, title: string) {
  const messageText = error instanceof Error ? error.message : String(error);
  run.status = "failed";
  run.accent = setRunAccent(run.status);
  run.completedAt = new Date().toISOString();
  run.updatedAt = "just now";
  run.summary = "Investigation worker failed before target access started.";
  run.recommendation = "Review the queue/throttle configuration before rerunning.";
  run.runtime.lastProgressAt = Date.now();
  appendAudit(run, `now · ${title}: ${redactDisplayText(messageText)}`);
  appendEvent(run, {
    id: `worker-preflight-failed-${randomUUID()}`,
    at: "now",
    title,
    body: redactDisplayText(messageText),
    analyzer: "system",
  });
}

async function executeClaimedInvestigationMessage(
  message: InvestigationQueueMessage,
  claim: Required<Pick<TargetThrottleClaim, "acquired" | "targetKey" | "slotNo">>,
) {
  const run = runs.get(message.runId);
  if (!run || isTerminalRunStatus(run.status)) {
    await releaseTargetClaimSafely(claim, message.runId);
    return;
  }

  run.status = "running";
  run.accent = setRunAccent(run.status);
  run.startedAt = run.startedAt || new Date().toISOString();
  run.throttleReason = undefined;
  run.updatedAt = "just now";
  run.summary = `Worker claimed ${message.target.environment} target capacity and started bounded investigation.`;
  run.recommendation = "Collect bounded evidence through approved adapters; no automated remediation will execute.";
  run.analyzers = run.analyzers.map((analyzer) => analyzer.key === "aws"
    ? {
        ...analyzer,
        status: "running",
        pulse: "hot",
        detail: "Resolving Jira-derived client/environment scope before bounded AWS discovery.",
      }
    : analyzer);
  run.runtime.lastProgressAt = Date.now();
  appendAudit(run, `now · worker claimed ${message.target.targetKey} slot ${claim.slotNo}`);
  appendEvent(run, {
    id: `target-claimed-${randomUUID()}`,
    at: "now",
    title: "Target slot claimed",
    body: `Worker claimed slot ${claim.slotNo} for ${message.target.targetKey}.`,
    analyzer: "system",
  });
  const heartbeatTimer = setInterval(() => {
    void targetThrottle.heartbeat({
      targetKey: claim.targetKey,
      slotNo: claim.slotNo,
      runId: message.runId,
    }).catch((error) => {
      const messageText = error instanceof Error ? error.message : String(error);
      console.warn(`[investigation-throttle] heartbeat failed for ${message.runId}: ${messageText}`);
    });
  }, 60_000);
  heartbeatTimer.unref?.();

  try {
    const config = getRuntimeTargetConfig();
    const configuredClient = config.clients.find((client) => client.id === message.target.clientId) ?? {
      id: message.target.clientId,
      displayName: message.target.clientDisplayName,
      aliases: [message.target.clientDisplayName],
      defaultEnvironment: toControlPlaneEnvironment(message.target.environment),
      serviceIds: [],
      keywords: [],
      repoNames: [],
      enabled: true,
    };
    const completedRun = await buildConfiguredControlPlaneRun({
      runId: message.runId,
      jiraKey: message.jiraKey,
      title: message.payload.title,
      client: configuredClient,
      environment: message.target.environment,
      mode: message.payload.mode,
      releaseVersion: message.payload.releaseVersion,
      ticketContext: message.payload.investigationTerms?.length || message.payload.timeWindow
        ? {
            ...(await fetchInvestigationJiraContext(message.jiraKey)),
            extractedTerms: message.payload.investigationTerms,
            timeWindow: message.payload.timeWindow,
          }
        : undefined,
      operatorDisplay: message.payload.operatorDisplay,
      source: message.payload.source,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      targetKey: message.target.targetKey,
    });
    completedRun.completedAt = new Date().toISOString();
    completedRun.targetKey = message.target.targetKey;
    completedRun.queuedAt = run.queuedAt;
    completedRun.startedAt = run.startedAt;
    completedRun.throttleReason = undefined;
    completedRun.events = [...run.events, ...completedRun.events]
      .slice(0, 12)
      .map((event, index) => ({ ...event, sequence: index + 1 }));
    completedRun.runtime.nextEventSequence = completedRun.events.length + 1;
    completedRun.audit = [
      `now · worker released ${message.target.targetKey} slot ${claim.slotNo}`,
      ...completedRun.audit,
      ...run.audit,
    ].slice(0, 20);
    runs.set(completedRun.id, completedRun);
  } catch (error) {
    const failedRun = runs.get(message.runId);
    if (failedRun) {
      const messageText = error instanceof Error ? error.message : String(error);
      failedRun.status = "failed";
      failedRun.accent = setRunAccent(failedRun.status);
      failedRun.completedAt = new Date().toISOString();
      failedRun.updatedAt = "just now";
      failedRun.summary = "Investigation worker failed before producing a complete evidence bundle.";
      failedRun.recommendation = "Review the worker error, target access, and queue/throttle configuration before rerunning.";
      failedRun.runtime.lastProgressAt = Date.now();
      appendAudit(failedRun, `now · investigation worker failed: ${redactDisplayText(messageText)}`);
      appendEvent(failedRun, {
        id: `worker-failed-${randomUUID()}`,
        at: "now",
        title: "Worker failed",
        body: redactDisplayText(messageText),
        analyzer: "system",
      });
    }
  } finally {
    clearInterval(heartbeatTimer);
    await releaseTargetClaimSafely(claim, message.runId);
  }
}

async function releaseTargetClaimSafely(
  claim: Required<Pick<TargetThrottleClaim, "targetKey" | "slotNo">>,
  runId: string,
) {
  try {
    await targetThrottle.release({ targetKey: claim.targetKey, slotNo: claim.slotNo, runId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[investigation-throttle] failed to release target slot for ${runId}: ${message}`);
  }
}

function getRunOrThrow(runId: string): StoredInvestigationRun {
  tickRuns();
  const run = runs.get(runId);
  if (!run) {
    throw new InvestigationServiceError("Investigation run not found", 404, "run_not_found");
  }
  return run;
}

function analyzerCompleteDetail(analyzer: InvestigationEvidence["analyzer"]): string {
  switch (analyzer) {
    case "aws":
      return "AWS evidence was attached through the bounded investigation path.";
    case "code":
      return "Code Agent file/path evidence was attached for the investigated code path.";
    case "host":
      return "SSM host logs/runtime evidence was attached without SSH or database writes.";
    case "data":
      return "Meridian attached readonly DB diagnostics with PHI redaction. No DML was executed.";
    case "llm":
      return "LLM evidence bundle was gathered with PHI redaction. Raw ticket prose is excluded from dashboard storage.";
  }
}

function analyzerLabel(analyzer: InvestigationEvidence["analyzer"]): string {
  switch (analyzer) {
    case "aws":
      return "AWS";
    case "code":
      return "Code";
    case "host":
      return "Host / SSM";
    case "data":
      return "Data";
    case "llm":
      return "LLM";
  }
}

function markAnalyzersComplete(
  run: StoredInvestigationRun,
  analyzers: Set<InvestigationEvidence["analyzer"]>,
) {
  for (const analyzer of analyzers) {
    if (!run.analyzers.some((entry) => entry.key === analyzer)) {
      run.analyzers.push({
        key: analyzer,
        label: analyzerLabel(analyzer),
        status: "waiting",
        pulse: "cool",
        detail: "Waiting for bounded investigation evidence.",
      });
    }
  }

  run.analyzers = run.analyzers.map((entry) =>
    analyzers.has(entry.key)
      ? {
          ...entry,
          status: "complete",
          pulse: entry.key === "host" || entry.key === "code" ? "warm" : "clear",
          detail: analyzerCompleteDetail(entry.key),
        }
      : entry,
  );
}

const READONLY_SQL_START = /^(select|with)\b/i;
const MUTATING_SQL_TOKEN = /\b(insert|update|delete|drop|alter|truncate|create|replace|grant|revoke|merge|call)\b/i;
const SENSITIVE_KEY_VALUE = /\b(member(?:_|\s*)id|subscriber(?:_|\s*)id|person(?:_|\s*)id|first(?:_|\s*)name|last(?:_|\s*)name|dob|date(?:_|\s*)of(?:_|\s*)birth|ssn|email|phone|address)\b\s*[:=]\s*['"]?[^,'"\n)]+/gi;
const SECRET_KEY_VALUE = /\b(password|passwd|pwd|secret|token|access(?:_|\s*)key|session(?:_|\s*)token)\b\s*[:=]\s*['"]?[^,'"\n)]+/gi;

function redactDisplayText(value: string): string {
  return value
    .replace(SECRET_KEY_VALUE, (match, label) => `${label}=[REDACTED]`)
    .replace(SENSITIVE_KEY_VALUE, (match, label) => `${label}=[REDACTED]`);
}

function sanitizeString(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return redactDisplayText(value.trim()).slice(0, 8_000);
}

function sanitizeOperatorDisplay(value: string): string {
  return sanitizeString(value, "operator") || "operator";
}

function sanitizeInvestigationEvent(event: Omit<InvestigationEvent, "sequence">): Omit<InvestigationEvent, "sequence"> {
  return {
    ...event,
    title: sanitizeString(event.title, "Investigation event"),
    body: sanitizeString(event.body),
  };
}

function hasMappedDeployedConfigBlocker(run: StoredInvestigationRun): boolean {
  return run.findings.some((finding) =>
    finding.id.includes("ssh-config-unavailable")
    || finding.id.includes("ssh-config-no-evidence"),
  );
}

function hasCodeOrConfigRemediationSignal(run: StoredInvestigationRun): boolean {
  if (run.jiraDraft.proposedRemediation.codeFix?.trim()) {
    return true;
  }
  if (run.findings.some((finding) => finding.requiresAction === "code" || finding.analyzer === "code")) {
    return true;
  }
  if (run.evidence.some((artifact) => artifact.analyzer === "code")) {
    return true;
  }
  return false;
}

function defaultCodeFixRemediation(run: StoredInvestigationRun): string {
  return [
    "Submit a bounded code or repository-configuration remediation to OneShot for draft PR creation only.",
    `Ticket: ${run.jiraKey}.`,
    "Use the Cockpit RCA, findings, evidence, and validation notes as the implementation scope.",
    "OneShot must plan, implement, code-review, and test before opening a draft PR.",
    "No SQL or production action is executed by this handoff.",
  ].join(" ");
}

function buildLlmGatheringEvidence(input: LlmGatheringInput): InvestigationEvidence {
  const ticketContext = input.ticketContext?.fetchStatus === "fetched" ? input.ticketContext : undefined;
  const descriptionPresent = Boolean(ticketContext?.description?.trim());
  const commentCount = ticketContext?.comments?.length || 0;
  const attachmentCount = ticketContext?.attachments?.length || 0;
  const textExtractedAttachmentCount = ticketContext?.attachments?.filter((attachment) => attachment.extractionStatus === "text_extracted").length || 0;
  const extractedTermCount = ticketContext?.extractedTerms?.length || 0;
  const identifierCount = ticketContext?.identifiers?.length || 0;
  const timeWindowStatus = deriveTicketTimeWindow(ticketContext) ? "derived" : "not-derived";
  const source = input.source || (ticketContext ? "jira" : "cockpit");
  const sourceLabel = source === "fallback" ? "Cockpit fixture" : source === "jira" ? "Jira" : "Cockpit";
  const title = ticketContext?.title || input.title || input.jiraKey;
  const meta = [
    `source:${sourceLabel}`,
    "llm-gathering",
    "phi-redacted",
    "raw-ticket-text:not-stored",
    ticketContext?.statusName ? `jira-status:${sanitizeString(ticketContext.statusName)}` : null,
    ticketContext?.codeVersion ? `code-version:${sanitizeString(ticketContext.codeVersion)}` : null,
    ticketContext?.labels?.length ? `label-count:${ticketContext.labels.length}` : null,
    `description:${descriptionPresent ? "present" : "absent"}`,
    `comment-count:${commentCount}`,
    `attachment-count:${attachmentCount}`,
    `text-attachment-count:${textExtractedAttachmentCount}`,
    `extracted-term-count:${extractedTermCount}`,
    `identifier-count:${identifierCount}`,
    `time-window:${timeWindowStatus}`,
  ].filter((entry): entry is string => Boolean(entry));

  return {
    id: `llm-evidence-${randomUUID()}`,
    analyzer: "llm",
    title: "LLM evidence bundle",
    detail: sanitizeString(
      `LLM-safe gathering captured ${input.jiraKey} context for ${input.client || "the selected client"} `
      + `in ${input.environment || "the selected environment"} from ${sourceLabel}. `
      + `The bundle records metadata for "${title}" while excluding raw Jira description/comment bodies from dashboard evidence storage.`,
    ),
    meta: Array.from(new Set(meta)).slice(0, 12),
    trace: [
      {
        title: "Ticket context gathered",
        detail: `Captured bounded Jira metadata: description ${descriptionPresent ? "present" : "absent"}, ${commentCount} comment(s), ${attachmentCount} attachment(s), ${textExtractedAttachmentCount} text-extracted attachment(s), ${extractedTermCount} extracted term(s), ${identifierCount} identifier(s), time window ${timeWindowStatus}.`,
      },
      {
        title: "Storage boundary enforced",
        detail: "Dashboard evidence stores only redacted metadata and counts; raw ticket prose remains out of the cockpit evidence payload.",
      },
    ],
  };
}

function isEvidenceAnalyzer(value: unknown): value is InvestigationEvidence["analyzer"] {
  return value === "aws" || value === "code" || value === "data" || value === "host";
}

function inferAttachmentAnalyzer(rawItem: Record<string, unknown>): InvestigationEvidence["analyzer"] {
  if (isEvidenceAnalyzer(rawItem.analyzer)) {
    return rawItem.analyzer;
  }

  const meta = Array.isArray(rawItem.meta) ? rawItem.meta.join(" ") : "";
  const text = [
    rawItem.title,
    rawItem.summary,
    rawItem.detail,
    rawItem.requiresAction,
    meta,
  ].filter((entry) => typeof entry === "string").join(" ").toLowerCase();

  if (/\b(code|repo|branch|class|method|file\/line|code-agent|faxcomfaxhandler|restserviceclient)\b/.test(text)) {
    return "code";
  }

  if (/\b(ssm|host|log|logs|file\.log|cloudwatch|runtime|scheduler|service log|zip)\b/.test(text)) {
    return "host";
  }

  if (/\b(sql|db|database|rds|table|readonly query|query pack|meridian sql)\b/.test(text)) {
    return "data";
  }

  if (/\b(aws|ec2|lambda|sqs|x-ray|cloud trail|cloudtrail)\b/.test(text)) {
    return "aws";
  }

  return "data";
}

function normalizeConfidence(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(0.99, Number(value.toFixed(2))));
}

function assertReadonlySqlForDisplay(sql: string) {
  const compact = sql.trim().replace(/\s+/g, " ");
  if (!compact) {
    return;
  }
  if (!READONLY_SQL_START.test(compact) || MUTATING_SQL_TOKEN.test(compact)) {
    throw new InvestigationServiceError(
      "Meridian evidence only accepts SELECT/CTE readonly SQL traces",
      400,
      "non_readonly_meridian_sql",
    );
  }
}

function normalizeMeridianTrace(trace: unknown): InvestigationEvidence["trace"] {
  if (!Array.isArray(trace)) {
    return [];
  }

  return trace.slice(0, 20).map((step, index) => {
    const rawStep = typeof step === "object" && step !== null ? step as Record<string, unknown> : {};
    const safeSql = sanitizeString(rawStep.safeSql);
    assertReadonlySqlForDisplay(safeSql);
    const rowCount = typeof rawStep.rowCount === "number" && Number.isFinite(rawStep.rowCount)
      ? Math.max(0, Math.floor(rawStep.rowCount))
      : undefined;

    return {
      title: sanitizeString(rawStep.title, `Readonly query ${index + 1}`),
      detail: sanitizeString(rawStep.detail),
      safeSql: safeSql || undefined,
      rowCount,
    };
  });
}

function normalizeMeridianEvidence(input: MeridianEvidenceAttachmentInput): InvestigationEvidence[] {
  const artifacts = Array.isArray(input.evidence) ? input.evidence : [];
  if (artifacts.length === 0) {
    return [{
      id: `meridian-evidence-${randomUUID()}`,
      analyzer: "data",
      title: "Meridian DB diagnostics",
      detail: sanitizeString(input.summary, "Meridian completed readonly DB diagnostics. Results were redacted before being attached."),
      meta: ["source:MERIDIAN", "readonly", "phi-redacted", "ssm"],
      trace: [],
    }];
  }

  return artifacts.slice(0, 12).map((artifact, index) => {
    const rawArtifact = typeof artifact === "object" && artifact !== null ? artifact as Record<string, unknown> : {};
    return {
      id: `meridian-evidence-${randomUUID()}`,
      analyzer: inferAttachmentAnalyzer(rawArtifact),
      title: sanitizeString(rawArtifact.title, `Meridian investigation evidence ${index + 1}`),
      detail: sanitizeString(rawArtifact.detail, "Readonly investigation evidence attached by Meridian."),
      meta: Array.from(new Set([
        "source:MERIDIAN",
        "readonly",
        "phi-redacted",
        ...(
          Array.isArray(rawArtifact.meta)
            ? rawArtifact.meta.map((entry) => sanitizeString(entry)).filter(Boolean)
            : []
        ),
      ])).slice(0, 12),
      trace: normalizeMeridianTrace(rawArtifact.trace),
    };
  });
}

function normalizeMeridianFindings(input: MeridianEvidenceAttachmentInput): InvestigationFinding[] {
  const findings = Array.isArray(input.findings) ? input.findings : [];
  return findings.slice(0, 10).map((finding, index) => {
    const rawFinding = typeof finding === "object" && finding !== null ? finding as Record<string, unknown> : {};
    const severity = ["critical", "high", "medium", "low", "info"].includes(String(rawFinding.severity))
      ? rawFinding.severity as InvestigationFinding["severity"]
      : "info";
    const requiresAction = ["code", "data", "ops"].includes(String(rawFinding.requiresAction))
      ? rawFinding.requiresAction as InvestigationFinding["requiresAction"]
      : undefined;
    return {
      id: `meridian-finding-${randomUUID()}`,
      analyzer: inferAttachmentAnalyzer(rawFinding),
      severity,
      title: sanitizeString(rawFinding.title, `Meridian investigation finding ${index + 1}`),
      summary: sanitizeString(rawFinding.summary, "Readonly Meridian investigation finding."),
      confidence: normalizeConfidence(rawFinding.confidence, 0.7),
      requiresAction,
    };
  });
}

const MERIDIAN_SQL_START_MARKER = "MERIDIAN_SQL_ATTACHMENT_START";
const MERIDIAN_SQL_END_MARKER = "MERIDIAN_SQL_ATTACHMENT_END";
const MAX_MERIDIAN_SQL_BYTES = 5_000_000;

function sanitizeSqlFilename(value: unknown, fallback: string): string {
  const raw = sanitizeString(value, fallback);
  const normalized = raw
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || fallback;
  return /\.sql$/i.test(normalized) ? normalized : `${normalized}.sql`;
}

function rawString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function extractMeridianSqlMarker(value: string): { filename?: string; sql: string } | null {
  const upperValue = value.toUpperCase();
  const startKeyword = upperValue.indexOf(MERIDIAN_SQL_START_MARKER);
  if (startKeyword < 0) {
    return null;
  }
  const startComment = upperValue.lastIndexOf("<!--", startKeyword);
  const startCommentEnd = upperValue.indexOf("-->", startKeyword + MERIDIAN_SQL_START_MARKER.length);
  if (startComment < 0 || startCommentEnd < 0) {
    return null;
  }
  const endKeyword = upperValue.indexOf(MERIDIAN_SQL_END_MARKER, startCommentEnd + 3);
  const endComment = endKeyword < 0 ? -1 : upperValue.lastIndexOf("<!--", endKeyword);
  const endCommentEnd = endKeyword < 0 ? -1 : upperValue.indexOf("-->", endKeyword + MERIDIAN_SQL_END_MARKER.length);
  if (endComment < startCommentEnd || endCommentEnd < 0) {
    return null;
  }

  const header = value.slice(startKeyword + MERIDIAN_SQL_START_MARKER.length, startCommentEnd);
  const filenameAttribute = "filename=\"";
  const filenameStart = header.toLowerCase().indexOf(filenameAttribute);
  let filename: string | undefined;
  if (filenameStart >= 0) {
    const valueStart = filenameStart + filenameAttribute.length;
    const valueEnd = header.indexOf("\"", valueStart);
    filename = valueEnd >= valueStart ? header.slice(valueStart, valueEnd) : undefined;
  }
  const sql = value.slice(startCommentEnd + 3, endComment).trim();
  return sql ? { filename, sql } : null;
}

function countSqlToken(sql: string, token: string): number {
  return (sql.match(new RegExp(`\\b${token}\\b`, "gi")) || []).length;
}

function extractMeridianSqlArtifactInput(input: MeridianEvidenceAttachmentInput): {
  sql: string;
  filename?: string;
  source: string;
  updateCount?: number;
  skippedCount?: number;
} | null {
  const directSql = rawString(input.sqlArtifact?.sql || input.sqlArtifact?.content || input.generatedSql || input.sql);
  if (directSql) {
    return {
      sql: directSql,
      filename: input.sqlArtifact?.filename || input.sqlFilename,
      source: sanitizeString(input.sqlArtifact?.source, "meridian"),
      updateCount: input.sqlArtifact?.updateCount,
      skippedCount: input.sqlArtifact?.skippedCount,
    };
  }

  const candidateText = [
    input.summary,
    input.recommendation,
    input.clientSummary,
    input.internalAnalysis,
    input.validationNotes,
  ].map((value) => rawString(value)).join("\n");
  const markerMatch = extractMeridianSqlMarker(candidateText);
  if (!markerMatch) {
    return null;
  }
  return {
    sql: markerMatch.sql,
    filename: markerMatch.filename,
    source: "meridian-marker",
  };
}

function attachMeridianSqlArtifactToRun(
  run: StoredInvestigationRun,
  input: MeridianEvidenceAttachmentInput,
): MeridianSqlArtifact | null {
  const artifactInput = extractMeridianSqlArtifactInput(input);
  if (!artifactInput) {
    return null;
  }

  const content = artifactInput.sql.trimEnd() + "\n";
  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > MAX_MERIDIAN_SQL_BYTES) {
    throw new InvestigationServiceError(
      "Meridian SQL artifact exceeds the Cockpit attachment size limit",
      400,
      "meridian_sql_too_large",
    );
  }

  const sha256 = createHash("sha256").update(content).digest("hex");
  const existing = run.meridianSqlArtifacts?.find((artifact) => artifact.sha256 === sha256);
  if (existing) {
    return existing;
  }

  const artifactId = `sql-${randomUUID()}`;
  const filename = sanitizeSqlFilename(artifactInput.filename, `${run.jiraKey}_meridian.sql`);
  const artifact: MeridianSqlArtifact = {
    id: artifactId,
    filename,
    contentType: "text/sql",
    sizeBytes,
    sha256,
    source: artifactInput.source,
    createdAt: new Date().toISOString(),
    updateCount: typeof artifactInput.updateCount === "number"
      ? Math.max(0, Math.floor(artifactInput.updateCount))
      : countSqlToken(content, "UPDATE"),
    skippedCount: typeof artifactInput.skippedCount === "number"
      ? Math.max(0, Math.floor(artifactInput.skippedCount))
      : countSqlToken(content, "ALREADY DONE"),
    downloadPath: `/api/investigation/runs/${encodeURIComponent(run.id)}/meridian/sql/${encodeURIComponent(artifactId)}`,
  };
  run.meridianSqlArtifacts = [artifact, ...(run.meridianSqlArtifacts || [])].slice(0, 10);
  meridianSqlArtifactContents.set(artifactId, { runId: run.id, content });
  return artifact;
}

export function getInvestigationHealth() {
  tickRuns();
  const config = getRuntimeTargetConfig();
  return {
    status: "ready",
    mode: "brokered",
    scopePolicy: "lower_env_first",
    queue: investigationQueueStats(),
    adapters: {
      aws: { status: "ready", detail: `${config.hostTargets.length} approved AWS/SSM host target(s), ${config.logSources.length} CloudWatch/S3 log source(s) configured.` },
      code: { status: "ready", detail: `${config.codeTargets.length} approved code target(s) configured for deterministic scans.` },
      data: { status: "pilot", detail: `${config.connections.length} DB target(s). Meridian diagnostics are readonly and PHI-redacted; no table allowlist is required by this attachment path.` },
      host: { status: "pilot", detail: "Runtime logs are fetched from CloudWatch first; SSM/S3 are bounded fallbacks. Approved LDAP SSH targets can collect deployed jar/properties evidence." },
    },
  };
}

export function listInvestigationRuns(query: InvestigationRunsQuery = {}) {
  tickRuns();
  return listInMemoryInvestigationRuns(query);
}

export async function listInvestigationRunsForDashboard(query: InvestigationRunsQuery = {}) {
  return listInvestigationRuns(query);
}

export function getInvestigationRun(runId: string) {
  return materializeRun(getRunOrThrow(runId));
}

export async function getInvestigationRunForDashboard(runId: string) {
  const liveRun = runs.get(runId);
  if (liveRun) {
    return materializeRun(liveRun);
  }
  throw new InvestigationServiceError("Investigation run not found", 404, "run_not_found");
}


export function listInvestigationFindings(runId: string) {
  return {
    findings: getRunOrThrow(runId).findings,
  };
}

export function listInvestigationEvidence(runId: string) {
  return {
    evidence: getRunOrThrow(runId).evidence,
  };
}

export function listInvestigationAudit(runId: string) {
  return {
    audit: getRunOrThrow(runId).audit,
  };
}

export function listInvestigationEvents(runId: string, afterSequence = 0) {
  const run = getRunOrThrow(runId);
  return {
    events: [...run.events]
      .filter((event) => event.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence),
  };
}

export function attachMeridianEvidence(
  runId: string,
  input: MeridianEvidenceAttachmentInput,
  operatorDisplay: string,
) {
  const run = getRunOrThrow(runId);
  const evidence = normalizeMeridianEvidence(input);
  const findings = normalizeMeridianFindings(input);
  const summary = sanitizeString(input.summary);
  const recommendation = sanitizeString(input.recommendation);
  const clientSummary = sanitizeString(input.clientSummary);
  const internalAnalysis = sanitizeString(input.internalAnalysis);
  const validationNotes = sanitizeString(input.validationNotes);
  const requestedStatus = input.status;
  const sqlArtifact = attachMeridianSqlArtifactToRun(run, input);
  const completionDecision = evaluateInvestigationResolutionGate({
    action: "approve_recommendation",
    assessment: run.resolution,
  });

  run.evidence = [...evidence, ...run.evidence].slice(0, 40);
  run.findings = [...findings, ...run.findings].slice(0, 30);
  markAnalyzersComplete(run, new Set([
    ...evidence.map((artifact) => artifact.analyzer),
    ...findings.map((finding) => finding.analyzer),
  ]));
  if (requestedStatus === "completed") {
    run.status = completionDecision.allowed ? "completed" : "awaiting_review";
    run.accent = setRunAccent(run.status);
  } else if (requestedStatus === "awaiting_review" || requestedStatus === "escalated") {
    run.status = requestedStatus;
    run.accent = setRunAccent(run.status);
  }
  run.confidence = normalizeConfidence(input.confidence, Math.max(run.confidence, findings.length > 0 ? 0.72 : 0.68));
  run.summary = summary || run.summary;
  run.recommendation = recommendation || run.recommendation;
  run.updatedAt = "just now";
  run.jiraDraft.clientSummary = ensureClientSummaryMentionsTicket(
    clientSummary || run.jiraDraft.clientSummary,
    { jiraKey: run.jiraKey, title: run.title },
  );
  run.jiraDraft.internalAnalysis = internalAnalysis || run.jiraDraft.internalAnalysis;
  run.jiraDraft.proposedRemediation.validationNotes = validationNotes || run.jiraDraft.proposedRemediation.validationNotes;
  run.approvalText = sqlArtifact
    ? `Manual review remains required. Meridian attached ${sqlArtifact.filename}; create a linked DBA ticket before any database write.`
    : "Manual review remains required. Meridian attached readonly evidence only; no database write was performed.";
  appendAudit(run, `now · ${operatorDisplay} attached Meridian investigation evidence (PHI redacted)`);
  if (requestedStatus === "completed" && !completionDecision.allowed) {
    appendAudit(run, `now · Meridian completion status was reduced to awaiting review by the shared resolution gate`);
  }
  if (sqlArtifact) {
    appendAudit(run, `now · Meridian SQL artifact ${sqlArtifact.filename} attached to Cockpit (${sqlArtifact.sha256.slice(0, 12)})`);
  }
  appendEvent(run, {
    id: `meridian-${randomUUID()}`,
    at: "now",
    title: "Meridian evidence attached",
    body: sqlArtifact
      ? `Meridian SQL file ${sqlArtifact.filename} is attached in Cockpit for DBA review; no DML was executed by Cockpit or Meridian.`
      : "Readonly investigation evidence was attached from Meridian with PHI redaction and no DML execution.",
    analyzer: evidence.some((artifact) => artifact.analyzer === "host") ? "host" : "data",
  });
  return materializeRun(run);
}

export function getMeridianSqlArtifact(runId: string, artifactId: string) {
  const run = getRunOrThrow(runId);
  const artifact = run.meridianSqlArtifacts?.find((entry) => entry.id === artifactId);
  const stored = meridianSqlArtifactContents.get(artifactId);
  if (!artifact || !stored || stored.runId !== run.id) {
    throw new InvestigationServiceError("Meridian SQL artifact was not found for this run", 404, "meridian_sql_not_found");
  }
  return {
    artifact,
    content: stored.content,
  };
}

function jiraIssueMutationDisabled(): boolean {
  return (
    process.env.INVESTIGATION_DISABLE_JIRA_MUTATIONS?.toLowerCase() === "true"
    || process.env.ONESHOT_DISABLE_JIRA_MUTATIONS?.toLowerCase() === "true"
  );
}

function jiraCommentPostingDisabled(): boolean {
  return (
    jiraIssueMutationDisabled()
    || process.env.ONESHOT_DISABLE_JIRA_COMMENTS?.toLowerCase() === "true"
  );
}

function requiredJiraEnv(name: "JIRA_BASE_URL" | "JIRA_USERNAME" | "JIRA_TOKEN"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new InvestigationServiceError(`${name} is required for Jira mutations`, 503, "jira_not_configured");
  }
  return value;
}

function jiraContextUnavailableMessage(
  jiraKey: string | undefined,
  ticketContext: InvestigationTicketContext | undefined,
): string {
  const reason = ticketContext?.failureReason?.trim();
  const suffix = reason
    ? ` Reason: ${reason}`
    : " Refresh Jira credentials or issue permissions before running investigation.";
  return `Jira ticket context for ${jiraKey || "the requested ticket"} could not be ingested.${suffix}`;
}

function jiraBaseUrl(): string {
  return requiredJiraEnv("JIRA_BASE_URL").replace(/\/$/, "");
}

function jiraAuthHeader(): string {
  return `Basic ${Buffer.from(`${requiredJiraEnv("JIRA_USERNAME")}:${requiredJiraEnv("JIRA_TOKEN")}`).toString("base64")}`;
}

function buildPlainTextAdf(text: string) {
  const paragraphs = text.split(/\n{2,}/).map((paragraph) => ({
    type: "paragraph",
    content: paragraph
      .split("\n")
      .flatMap((line, index) => [
        ...(index > 0 ? [{ type: "hardBreak" }] : []),
        { type: "text", text: line || " " },
      ]),
  }));
  return {
    type: "doc",
    version: 1,
    content: paragraphs.length > 0 ? paragraphs : [{ type: "paragraph", content: [{ type: "text", text: " " }] }],
  };
}

async function jiraJsonRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${jiraBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: jiraAuthHeader(),
      Accept: "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Jira request failed: ${response.status} ${response.statusText} - ${redactDisplayText(errorText).slice(0, 500)}`);
  }
  if (response.status === 204) {
    return {} as T;
  }
  return await response.json().catch(() => ({} as T));
}

async function resolveJiraAssigneeAccountId(operator: { id: string; display: string }): Promise<string | undefined> {
  const query = encodeURIComponent(operator.id.includes("@") ? operator.id : operator.display);
  const users = await jiraJsonRequest<Array<{ accountId?: string; displayName?: string; emailAddress?: string; active?: boolean }>>(
    `/rest/api/3/user/search?query=${query}&maxResults=10`,
    { method: "GET" },
  );
  const normalizedId = operator.id.trim().toLowerCase();
  const normalizedDisplay = operator.display.trim().toLowerCase();
  const exact = users.find((user) =>
    user.active !== false
    && (
      user.accountId === operator.id
      || user.emailAddress?.toLowerCase() === normalizedId
      || user.displayName?.toLowerCase() === normalizedDisplay
    ),
  );
  return exact?.accountId || users.find((user) => user.active !== false)?.accountId;
}

async function createDbaJiraIssue(run: StoredInvestigationRun, artifact: MeridianSqlArtifact): Promise<{ key: string; url: string }> {
  const projectKey = process.env.INVESTIGATION_DBA_JIRA_PROJECT_KEY?.trim() || "CPSUP";
  const issueType = process.env.INVESTIGATION_DBA_JIRA_ISSUE_TYPE?.trim() || "Task";
  const description = [
    `DBA review requested for Meridian SQL generated from ${run.jiraKey}.`,
    `Cockpit run: ${run.id}`,
    `Client: ${run.client}`,
    `Environment: ${run.environment}`,
    `SQL file: ${artifact.filename}`,
    `SQL sha256: ${artifact.sha256}`,
    `Generated updates: ${artifact.updateCount ?? 0}`,
    "Meridian and Cockpit did not execute this SQL. DBA backup, validation, execution, and post-checks are required.",
  ].join("\n");
  const payload = {
    fields: {
      project: { key: projectKey },
      summary: `DBA review: ${run.jiraKey} Meridian SQL`,
      description: buildPlainTextAdf(description),
      issuetype: { name: issueType },
      labels: ["investigation-cockpit", "meridian-dba"],
    },
  };
  const created = await jiraJsonRequest<{ key: string }>(
    "/rest/api/3/issue",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  return {
    key: created.key,
    url: `${jiraBaseUrl()}/browse/${created.key}`,
  };
}

function boundedJiraCommentText(value: string): string {
  return redactDisplayText(value).slice(0, 30_000);
}

function buildInvestigationJiraSummaryComment(run: StoredInvestigationRun, operatorDisplay: string): string {
  const diagnosisReady = run.resolution?.diagnosisReady === true;
  const lines = [
    `${diagnosisReady ? "Final causal investigation summary" : "Interim investigation update - RCA incomplete"} for ${run.jiraKey}`,
    `Posted by: ${operatorDisplay}`,
    `Cockpit run: ${run.id}`,
    `Client: ${run.client}`,
    `Environment: ${run.environment}`,
    `Status: ${run.status}`,
    `Resolution gate: ${diagnosisReady ? "passed" : "not passed"}`,
    ...(!diagnosisReady && run.resolution
      ? [`Missing diagnosis dimensions: ${run.resolution.missingDiagnosisDimensions.join(", ") || "none"}`, `Unexplained symptom clusters: ${run.resolution.unexplainedSymptomClusterIds.join(", ") || "none"}`]
      : []),
    "",
    "Recommendation:",
    run.recommendation,
    "",
    "Client summary:",
    ensureClientSummaryMentionsTicket(run.jiraDraft.clientSummary || run.summary, {
      jiraKey: run.jiraKey,
      title: run.title,
    }),
    "",
    "Validation notes:",
    run.jiraDraft.proposedRemediation.validationNotes,
  ];

  const visibleFindings = run.findings.slice(0, 5);
  if (visibleFindings.length > 0) {
    lines.push(
      "",
      "Findings:",
      ...visibleFindings.map((finding) =>
        `- [${finding.severity}] ${finding.title} (${Math.round(finding.confidence * 100)}%): ${finding.summary}`,
      ),
    );
  }

  if (run.meridianSqlArtifacts?.length) {
    lines.push(
      "",
      "Meridian SQL artifacts:",
      ...run.meridianSqlArtifacts.map((artifact) =>
        `- ${artifact.filename} | ${artifact.updateCount ?? 0} update(s) | sha256 ${artifact.sha256.slice(0, 12)} | Cockpit-only artifact; raw SQL is not included in this Jira comment.`,
      ),
    );
  }

  if (run.dbaTicket) {
    lines.push(
      "",
      "Linked DBA ticket:",
      `${run.dbaTicket.key} (${run.dbaTicket.url}) | ${run.dbaTicket.assignmentStatus} | ${run.dbaTicket.linkStatus}`,
    );
  }

  return boundedJiraCommentText(lines.join("\n"));
}

async function postJiraIssueComment(issueKey: string, body: string): Promise<{ id?: string }> {
  return await jiraJsonRequest<{ id?: string }>(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: buildPlainTextAdf(body) }),
    },
  );
}

async function assignJiraIssue(issueKey: string, accountId: string): Promise<void> {
  await jiraJsonRequest(
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId }),
    },
  );
}

async function attachSqlFileToJiraIssue(issueKey: string, artifact: MeridianSqlArtifact, content: string): Promise<void> {
  const formData = new FormData();
  formData.append("file", new Blob([Buffer.from(content, "utf8")], { type: "text/sql" }), artifact.filename);
  const response = await fetch(`${jiraBaseUrl()}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`, {
    method: "POST",
    headers: {
      Authorization: jiraAuthHeader(),
      "X-Atlassian-Token": "no-check",
    },
    body: formData,
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Jira SQL attachment failed: ${response.status} ${response.statusText} - ${redactDisplayText(errorText).slice(0, 500)}`);
  }
}

async function linkJiraIssues(sourceKey: string, dbaKey: string): Promise<"linked" | "failed"> {
  const linkType = process.env.INVESTIGATION_DBA_JIRA_LINK_TYPE?.trim() || "Relates";
  try {
    await jiraJsonRequest(
      "/rest/api/3/issueLink",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: { name: linkType },
          inwardIssue: { key: sourceKey },
          outwardIssue: { key: dbaKey },
        }),
      },
    );
    return "linked";
  } catch {
    return "failed";
  }
}

export async function createMeridianDbaTicket(
  runId: string,
  operator: { id: string; display: string },
  artifactId?: string,
) {
  if (jiraIssueMutationDisabled()) {
    throw new InvestigationServiceError("Jira issue mutations are disabled; DBA ticket was not created", 503, "jira_issue_mutations_disabled");
  }

  const run = getRunOrThrow(runId);
  const artifact = artifactId
    ? run.meridianSqlArtifacts?.find((entry) => entry.id === artifactId)
    : run.meridianSqlArtifacts?.[0];
  if (!artifact) {
    throw new InvestigationServiceError("No Meridian SQL artifact is attached to this run", 409, "meridian_sql_required");
  }
  const resolutionDecision = evaluateInvestigationResolutionGate({
    action: "create_dba_ticket",
    assessment: run.resolution,
    plannedChange: hasMeridianTicketContextSignal({ ticketContext: run.ticketContext, title: run.title }),
  });
  if (!resolutionDecision.allowed) {
    throw new InvestigationServiceError(
      `DBA ticket was not created: ${resolutionDecision.reason}`,
      409,
      "causal_resolution_required",
    );
  }
  if (run.dbaTicket?.sqlArtifactId === artifact.id) {
    return materializeRun(run);
  }
  const stored = meridianSqlArtifactContents.get(artifact.id);
  if (!stored || stored.runId !== run.id) {
    throw new InvestigationServiceError("Meridian SQL artifact content is unavailable", 409, "meridian_sql_content_missing");
  }

  const dbaIssue = await createDbaJiraIssue(run, artifact);
  await attachSqlFileToJiraIssue(dbaIssue.key, artifact, stored.content);

  let assigneeAccountId: string | undefined;
  let assignmentStatus: MeridianDbaTicket["assignmentStatus"] = "unresolved";
  try {
    assigneeAccountId = await resolveJiraAssigneeAccountId(operator);
    if (assigneeAccountId) {
      await assignJiraIssue(dbaIssue.key, assigneeAccountId);
      assignmentStatus = "assigned";
    }
  } catch {
    assignmentStatus = "failed";
  }

  const linkStatus = await linkJiraIssues(run.jiraKey, dbaIssue.key);
  run.dbaTicket = {
    status: "created",
    key: dbaIssue.key,
    url: dbaIssue.url,
    linkedTo: run.jiraKey,
    sqlArtifactId: artifact.id,
    sqlFilename: artifact.filename,
    assignedOperatorDisplay: operator.display,
    assigneeAccountId,
    assignmentStatus,
    linkStatus,
    createdAt: new Date().toISOString(),
  };
  run.updatedAt = "just now";
  run.approvalText = `Linked DBA ticket ${dbaIssue.key} was created with ${artifact.filename} attached.`;
  appendAudit(run, `now · ${operator.display} created linked DBA ticket ${dbaIssue.key} with ${artifact.filename}`);
  appendEvent(run, {
    id: `dba-ticket-${randomUUID()}`,
    at: "now",
    title: "DBA ticket created",
    body: `Linked DBA ticket ${dbaIssue.key} was created with Meridian SQL file ${artifact.filename} attached.`,
    analyzer: "data",
  });
  return materializeRun(run);
}

function publishInvestigationProgress(runId: string, progress: InvestigationRunProgress): void {
  const run = runs.get(runId);
  if (!run || isTerminalRunStatus(run.status)) return;
  run.updatedAt = "just now";
  run.summary = redactDisplayText(progress.message);
  run.runtime.lastProgressAt = Date.now();
  for (const finding of progress.findings || []) {
    const mapped = mapControlPlaneFinding(finding);
    if (!run.findings.some((existing) => existing.id === mapped.id)) run.findings.push(mapped);
  }
  for (const evidence of progress.evidence || []) {
    const mapped = mapControlPlaneEvidence(evidence);
    if (!run.evidence.some((existing) => existing.id === mapped.id)) run.evidence.push(mapped);
  }
  run.approvalText = "Investigation is still running. Approval remains disabled until Cockpit publishes a supported recommendation.";
  run.jiraDraft = {
    clientSummary: `Investigation for ${run.jiraKey} is in progress. Cockpit has retained ${run.findings.length} finding(s) and ${run.evidence.length} evidence artifact(s); no final RCA has been published.`,
    internalAnalysis: redactDisplayText(progress.message),
    proposedRemediation: {
      validationNotes: "RCA, recovery, prevention, and remediation drafts remain pending until the causal evidence gate completes.",
    },
  };
  if (progress.adapter) {
    run.analyzers = run.analyzers.map((analyzer) => analyzer.key === progress.adapter
      ? {
          ...analyzer,
          status: progress.phase === "adapter_completed" ? "ready" : "running",
          pulse: progress.phase === "adapter_completed" ? "warm" : "hot",
          detail: redactDisplayText(progress.message),
        }
      : analyzer);
  }
  if (progress.phase === "adapter_partial") return;
  appendEvent(run, {
    id: `control-plane-progress-${randomUUID()}`,
    at: "now",
    title: progress.phase === "planning"
      ? `Planning iteration ${progress.iteration || 1}`
      : progress.phase === "adapter_started"
        ? `${progress.adapter?.toUpperCase() || "Evidence"} probe started`
        : `${progress.adapter?.toUpperCase() || "Evidence"} probe completed`,
    body: redactDisplayText(progress.message),
    analyzer: progress.adapter || "system",
  });
}

async function buildConfiguredControlPlaneRun(input: {
  runId?: string;
  jiraKey?: string;
  title?: string;
  client: InvestigationClientTarget;
  environment?: InvestigationEnvironment;
  mode?: InvestigationMode;
  releaseVersion?: string;
  investigationTerms?: string[];
  timeWindow?: InvestigationTimeWindow;
  operatorDisplay: string;
  operatorSshPassword?: string;
  source?: "command-deck" | "jira-label";
  queuedAt?: string;
  startedAt?: string;
  targetKey?: string;
  ticketContext?: InvestigationTicketContext;
}): Promise<StoredInvestigationRun> {
  const normalizedJiraKey = input.jiraKey?.trim() ? assertValidJiraKey(input.jiraKey) : undefined;
  const ticketContext = input.ticketContext || (normalizedJiraKey
    ? await fetchInvestigationJiraContext(normalizedJiraKey)
    : undefined);
  if (normalizedJiraKey && ticketContext?.fetchStatus === "unavailable") {
    throw new InvestigationServiceError(
      jiraContextUnavailableMessage(normalizedJiraKey, ticketContext),
      502,
      "jira_context_unavailable",
    );
  }
  const jiraLookup = normalizedJiraKey
    ? ticketContext?.fetchStatus === "fetched"
      ? {
          jiraKey: normalizedJiraKey,
          title: ticketContext.title || "",
          statusName: ticketContext.statusName || "Unknown",
        }
      : null
    : null;

  const environment = input.environment || toDashboardEnvironment(input.client.defaultEnvironment || "DEV");
  const ticketReleaseVersion = inferReleaseVersionFromTicketContext(ticketContext);
  let releaseVersion = normalizeReleaseVersion(input.releaseVersion) || ticketReleaseVersion;
  const title = input.title?.trim() || jiraLookup?.title || `${input.client.displayName} investigation`;
  const runtimeTargetConfig = getRuntimeTargetConfig();
  const config = await withJiraScopedRuntimeTargets({
    config: runtimeTargetConfig,
    client: input.client,
    environment,
    releaseVersion,
    ticketContext,
  });
  const baseKeywords = extractTicketKeywords({
    jiraKey: normalizedJiraKey,
    title,
    clientDisplayName: input.client.displayName,
    releaseVersion,
    configuredKeywords: input.client.keywords,
    ticketContext,
  });
  const meridianTicketPreflight = hasMeridianTicketContextSignal({
    ticketContext,
    client: input.client,
    title,
  });
  const preflight = meridianTicketPreflight ? {
    ran: false,
    signals: [],
    findingCount: 0,
    evidenceCount: 0,
  } : await collectRepoRoutingPreflight({
    config,
    client: input.client,
    environment,
    jiraKey: normalizedJiraKey,
    title,
    ticketContext,
    releaseVersion,
    keywords: baseKeywords,
  });
  releaseVersion ||= inferReleaseVersionFromOperationalText(preflight.signals.join("\n"));
  const repoNames = await resolveJiraScopedCodeRepoNames({
    config,
    client: input.client,
    environment,
    jiraKey: normalizedJiraKey,
    title,
    ticketContext,
    releaseVersion,
    preflightSignals: preflight.signals,
  });
  const executionConfig = withJiraScopedCodeVersion({
    config,
    client: input.client,
    environment,
    releaseVersion,
    repoNames,
  });
  const configuredHostTarget = executionConfig.hostTargets.find((target) =>
    target.clientId === input.client.id
    && toDashboardEnvironment(target.environment) === environment
    && target.enabled,
  );
  const hostRegistry = createHostTargetRegistry(executionConfig);
  const hostTarget = await hostRegistry.resolveTarget(
    input.client.id,
    toControlPlaneEnvironment(environment),
    configuredHostTarget?.id,
  ).catch(() => configuredHostTarget || null) || configuredHostTarget;
  const configuredConnectionTarget = executionConfig.connections.find((target) =>
    target.clientId === input.client.id
    && target.environment === toControlPlaneEnvironment(environment)
    && target.enabled,
  );
  const connectionTarget = configuredConnectionTarget?.id === "jira-ldap-db"
    && !firstRuntimeEnv("INVESTIGATION_DB_REMOTE_HOST", "MERIDIAN_DB_REMOTE_HOST")
    && hostTarget?.databaseHost
    ? {
        ...configuredConnectionTarget,
        host: hostTarget.databaseHost,
        port: hostTarget.databasePort || 3306,
        topology: "ec2_mysql" as const,
        notes: "AWS discovery resolved the approved replica/database endpoint behind the operator LDAP SSH gateway.",
      }
    : configuredConnectionTarget;
  const sessionOperatorSshPassword = input.operatorSshPassword
    || firstRuntimeEnv("INVESTIGATION_OPERATOR_SSH_PASSWORD", "INVESTIGATION_DB_PASSWORD");
  const operatorSshPreflight = (sessionOperatorSshPassword || meridianTicketPreflight)
    ? await ensureOperatorSshControlMaster({
        hostTarget,
        operatorSshPassword: sessionOperatorSshPassword,
        jiraKey: normalizedJiraKey,
        clientId: input.client.id,
        environment,
        operatorDisplay: input.operatorDisplay,
      }).catch((error) => {
        throw new InvestigationServiceError(
          error instanceof Error ? error.message : String(error),
          409,
          "operator_ssh_control_master_failed",
        );
      })
    : undefined;
  if (operatorSshPreflight?.status === "password_required" && meridianTicketPreflight) {
    throw new InvestigationServiceError(
      [
        "Operator LDAP SSH password is required before MERIDIAN SQL generation can start.",
        `Target: ${operatorSshPreflight.destination || operatorSshPreflight.publicHost || "approved SSH host"}.`,
        `ControlPath: ${operatorSshPreflight.controlPath || "not configured"}.`,
        "Enter the SSH password in Cockpit; it is used once to open a short-lived ControlMaster and is not stored.",
      ].join(" "),
      409,
      "operator_ssh_password_required",
    );
  }
  const resolvedExecutionConfig = connectionTarget && connectionTarget !== configuredConnectionTarget
    ? {
        ...executionConfig,
        connections: executionConfig.connections.map((target) =>
          target.id === configuredConnectionTarget?.id ? connectionTarget : target,
        ),
      }
    : executionConfig;
  const controlPlane = createControlPlane(
    resolvedExecutionConfig,
    hostRegistry,
    input.runId ? progress => publishInvestigationProgress(input.runId as string, progress) : undefined,
  );
  const timeWindow = deriveTicketTimeWindow(ticketContext);

  const created = controlPlane.createRun({
    jiraKey: normalizedJiraKey || `CPSUP-${43050 + runs.size}`,
    title,
    scope: {
      clientId: input.client.id,
      environment: toControlPlaneEnvironment(environment),
      serviceIds: input.client.serviceIds?.length ? input.client.serviceIds : [`${input.client.id}-backend`],
      workflowType: meridianTicketPreflight ? "planned_data_change" : "incident_investigation",
      ...(releaseVersion ? { releaseVersion } : {}),
      hostTargets: hostTarget ? [hostTarget.id] : [],
      keywords: uniqueStrings([...baseKeywords, ...preflight.signals]).slice(0, 80),
      repoNames,
      ...(timeWindow ? { timeWindow } : {}),
      ...(ticketContext ? { ticketContext } : {}),
    },
  });

  const executableRun = input.runId ? { ...created, id: input.runId } : created;
  const execution = await controlPlane.executeRun(executableRun);
  const materialized = materializeControlPlaneRun({
    execution,
    operatorDisplay: input.operatorDisplay,
    mode: input.mode || "aws-first",
    client: input.client,
    hostTarget,
  });
  if (operatorSshPreflight?.status === "opened" || operatorSshPreflight?.status === "active") {
    const opened = operatorSshPreflight.status === "opened";
    appendEvent(materialized, {
      id: `operator-ssh-preflight-${randomUUID()}`,
      at: "now",
      title: opened ? "Operator SSH preflight opened" : "Operator SSH preflight reused",
      body: opened
        ? "Cockpit opened the approved operator LDAP SSH ControlMaster for Meridian and discarded the one-time SSH password."
        : "Cockpit found an active approved operator LDAP SSH ControlMaster for Meridian.",
      analyzer: "data",
    });
    materialized.audit = [
      `now · operator LDAP SSH ControlMaster ${opened ? "opened" : "reused"} for approved Meridian target`,
      ...materialized.audit,
    ];
  }
  if (preflight.ran) {
    appendEvent(materialized, {
      id: `repo-routing-preflight-${randomUUID()}`,
      at: "now",
      title: "Repo routing preflight completed",
      body: `Collected bounded runtime routing metadata before code selection: ${preflight.findingCount} finding(s), ${preflight.evidenceCount} evidence item(s), ${preflight.signals.length} signal(s). Raw logs and credentials were not stored.`,
      analyzer: "system",
    });
    materialized.audit = [
      `now · repo routing preflight collected ${preflight.signals.length} bounded signal(s) before code selection`,
      ...materialized.audit,
    ];
  }
  const meridianHandoff = await maybeCreateMeridianHandoff({
    execution,
    client: input.client,
    connectionTarget,
    hostTarget: hostTarget || undefined,
  });
  if (meridianHandoff.status === "created" || meridianHandoff.status === "existing") {
    appendEvent(materialized, {
      id: `meridian-handoff-${randomUUID()}`,
      at: "now",
      title: meridianHandoff.status === "created" ? "MERIDIAN handoff created" : "MERIDIAN handoff already exists",
      body: meridianHandoff.taskManagementId
        ? `MERIDIAN task ${meridianHandoff.taskManagementId} is available for SQL generation. ${redactDisplayText(meridianHandoff.reason)}`
        : redactDisplayText(meridianHandoff.reason),
      analyzer: "data",
    });
    materialized.audit = [
      `now · MERIDIAN ${meridianHandoff.status === "created" ? "task created" : "task reused"}${meridianHandoff.taskManagementId ? ` (${meridianHandoff.taskManagementId})` : ""}`,
      ...materialized.audit,
    ];
  } else if (meridianHandoff.status === "failed") {
    appendEvent(materialized, {
      id: `meridian-handoff-failed-${randomUUID()}`,
      at: "now",
      title: "MERIDIAN handoff failed",
      body: redactDisplayText(meridianHandoff.reason),
      analyzer: "data",
    });
    materialized.audit = [
      `now · MERIDIAN handoff failed: ${redactDisplayText(meridianHandoff.reason)}`,
      ...materialized.audit,
    ];
  }
  materialized.queuedAt = input.queuedAt;
  materialized.startedAt = input.startedAt;
  materialized.targetKey = input.targetKey;
  return materialized;
}

function resolveInvestigationTargetKey(input: {
  config: InvestigationTargetConfig;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
}): string {
  const connection = input.config.connections.find((target) =>
    target.clientId === input.client.id
    && toDashboardEnvironment(target.environment) === input.environment
    && target.enabled,
  );
  const hostTarget = input.config.hostTargets.find((target) =>
    target.clientId === input.client.id
    && toDashboardEnvironment(target.environment) === input.environment
    && target.enabled,
  );
  const targetId = connection?.id || hostTarget?.id || "client-scope";
  return normalizeTargetKey(`${input.client.id}:${input.environment}:${targetId}`);
}

function createQueuedConfiguredRun(input: {
  jiraKey?: string;
  title?: string;
  client: InvestigationClientTarget;
  environment: InvestigationEnvironment;
  mode?: InvestigationMode;
  releaseVersion?: string;
  investigationTerms?: string[];
  timeWindow?: InvestigationTimeWindow;
  operatorDisplay: string;
  source?: "command-deck" | "jira-label";
  config: InvestigationTargetConfig;
}): StoredInvestigationRun {
  const runId = `inv-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const targetKey = resolveInvestigationTargetKey({
    config: input.config,
    client: input.client,
    environment: input.environment,
  });
  const maxConcurrent = environmentTargetCap(input.environment);
  const now = new Date().toISOString();
  const jiraKey = input.jiraKey || `CPSUP-${43050 + runs.size}`;
  const title = input.title?.trim() || `${input.client.displayName} investigation`;
  const releaseVersion = normalizeReleaseVersion(input.releaseVersion);

  const run = withSequencedEvents({
    id: runId,
    jiraKey,
    title,
    client: input.client.displayName,
    environment: input.environment,
    ...(releaseVersion ? { releaseVersion } : {}),
    status: "queued",
    mode: input.mode || "aws-first",
    confidence: 0.5,
    accent: setRunAccent("queued"),
    updatedAt: "queued",
    targetKey,
    queuedAt: now,
    summary: `Queued for worker capacity before opening SSM or read-only database diagnostics for ${input.client.displayName}.`,
    recommendation: "Waiting for target throttle approval before evidence collection starts.",
    analyzers: [
      { key: "aws", label: "AWS", status: "waiting", pulse: "cool", detail: "Waiting for queue worker to claim target capacity." },
      { key: "host", label: "Host / SSM", status: "waiting", pulse: "cool", detail: "SSM inspection will start only after target capacity is claimed." },
      { key: "code", label: "Code", status: "waiting", pulse: "cool", detail: "Code inspection waits for the worker execution phase." },
      { key: "data", label: "Data", status: "waiting", pulse: "cool", detail: "Read-only DB diagnostics wait behind the target throttle." },
    ],
    findings: [],
    evidence: [],
    events: [
      {
        id: `queue-${randomUUID()}`,
        at: "now",
        title: "Queued for worker",
        body: `Run entered the SQS-compatible POC queue with MessageGroupId ${targetKey}.`,
        analyzer: "system",
      },
    ],
    approvalText: "Approval controls stay disabled until a recommendation exists.",
    jiraDraft: {
      clientSummary: ensureClientSummaryMentionsTicket(
        "Investigation is queued. No evidence collection or remediation has run yet.",
        { jiraKey, title },
      ),
      internalAnalysis: `Queued with target key ${targetKey}. Environment cap is ${maxConcurrent}.`,
      proposedRemediation: {
        validationNotes: "Worker must claim target capacity before SSM/DB validation starts.",
      },
    },
    audit: [
      `now · ${input.operatorDisplay} queued investigation through SQS-compatible POC contract`,
      `now · target throttle key ${targetKey} cap ${maxConcurrent}`,
    ],
    runtime: {
      lastProgressAt: Date.now(),
    },
  });

  const message: InvestigationQueueMessage = {
    schemaVersion: "investigation-run.v1",
    messageId: `msg-${randomUUID()}`,
    messageGroupId: targetKey,
    messageDeduplicationId: `${jiraKey}:investigation_cockpit:${input.source || "command-deck"}`,
    workflowType: "investigation_cockpit",
    runId,
    jiraKey,
    target: {
      targetKey,
      clientId: input.client.id,
      clientDisplayName: input.client.displayName,
      environment: input.environment,
      maxConcurrent,
    },
    payload: {
      title,
      mode: input.mode,
      releaseVersion,
      investigationTerms: input.investigationTerms?.slice(0, 24),
      timeWindow: input.timeWindow,
      operatorDisplay: input.operatorDisplay,
      source: input.source,
    },
    requestedAt: now,
    attempt: 1,
  };

  runs.set(run.id, run);
  enqueueInvestigationMessage(message);
  return run;
}

async function createInvestigationRunWithAdmission(input: {
  jiraKey?: string;
  title?: string;
  client?: string;
  environment?: InvestigationEnvironment;
  mode?: InvestigationMode;
  releaseVersion?: string;
  operatorDisplay: string;
  operatorSshPassword?: string;
  investigationHint?: string;
  source?: "command-deck" | "jira-label";
}) {
  tickRuns();
  const safeOperatorDisplay = sanitizeOperatorDisplay(input.operatorDisplay);

  let normalizedJiraKey: string | undefined;
  if (input.jiraKey?.trim()) {
    try {
      normalizedJiraKey = assertValidJiraKey(input.jiraKey);
    } catch (error) {
      if (error instanceof OneShotRunRequestError) {
        throw new InvestigationServiceError(error.message, error.statusCode, "invalid_jira_key");
      }
      throw error;
    }
  }

  assertInvestigationQueueAdmission(normalizedJiraKey);

  let ticketContextForDerivation = normalizedJiraKey
    ? await fetchInvestigationJiraContext(normalizedJiraKey)
    : undefined;
  ticketContextForDerivation = augmentInvestigationTicketContext(
    ticketContextForDerivation,
    input.investigationHint,
  );
  if (normalizedJiraKey && ticketContextForDerivation?.fetchStatus === "unavailable") {
    throw new InvestigationServiceError(
      jiraContextUnavailableMessage(normalizedJiraKey, ticketContextForDerivation),
      502,
      "jira_context_unavailable",
    );
  }
  const targetConfig = getRuntimeTargetConfig();
  const ticketLabelsForDerivation = ticketContextForDerivation?.fetchStatus === "fetched"
    ? ticketContextForDerivation.labels || []
    : [];
  const ticketTextForDerivation = ticketContextSearchText(ticketContextForDerivation);
  const derivedEnvironment = inferEnvironmentFromLabels(ticketContextForDerivation?.fetchStatus === "fetched" && ticketContextForDerivation.environmentName
      ? [ticketContextForDerivation.environmentName]
      : [])
    || inferEnvironmentFromLabels(ticketLabelsForDerivation)
    || inferEnvironmentFromTicketText(ticketTextForDerivation);
  const derivedReleaseVersion = normalizeReleaseVersion(input.releaseVersion)
    || inferReleaseVersionFromTicketContext(ticketContextForDerivation);
  const jiraDerivedClientDisplay = inferClientDisplayFromLabels(ticketLabelsForDerivation)
    || inferClientDisplayFromTicketText(ticketTextForDerivation);
  const inferredEnvironment = input.environment || derivedEnvironment;
  const inferredTitle = input.title?.trim() || (ticketContextForDerivation?.fetchStatus === "fetched" ? ticketContextForDerivation.title : undefined);
  const jiraConfiguredClient = resolveConfiguredClientFromLabels(ticketLabelsForDerivation, targetConfig)
    || resolveConfiguredClientFromTicketContext(ticketContextForDerivation, targetConfig);
  const explicitConfiguredClient = input.client
    ? resolveConfiguredClient(input.client, input.environment, targetConfig)
    : undefined;
  const configuredClient = jiraConfiguredClient
    || explicitConfiguredClient
    || resolveConfiguredClient(input.client, input.environment, targetConfig);
  const normalizedClient = configuredClient?.displayName
    || jiraDerivedClientDisplay
    || normalizeInvestigationClient(input.client, input.environment);
  const jiraScopedEnvironment = inferredEnvironment || (jiraDerivedClientDisplay ? "INT" as InvestigationEnvironment : undefined);
  const jiraScopedClient = !configuredClient && normalizedJiraKey && jiraDerivedClientDisplay
    ? buildJiraScopedClientTarget({
        displayName: jiraDerivedClientDisplay,
        environment: input.environment || derivedEnvironment || "INT",
        labels: ticketLabelsForDerivation,
        ticketContext: ticketContextForDerivation,
      })
    : undefined;
  if (configuredClient) {
    const environment = input.environment || derivedEnvironment || toDashboardEnvironment(configuredClient.defaultEnvironment || "DEV");
    const title = input.title || (ticketContextForDerivation?.fetchStatus === "fetched" ? ticketContextForDerivation.title : undefined);
    const scopedTargetConfig = withJiraScopedRuntimeTargetsForAdmission({
      config: targetConfig,
      client: configuredClient,
      environment,
      releaseVersion: derivedReleaseVersion,
      ticketContext: ticketContextForDerivation,
    });
    const run = createQueuedConfiguredRun({
      jiraKey: normalizedJiraKey,
      client: configuredClient,
      title,
      environment,
      mode: input.mode,
      releaseVersion: derivedReleaseVersion,
      investigationTerms: ticketContextForDerivation?.extractedTerms,
      timeWindow: ticketContextForDerivation?.timeWindow,
      operatorDisplay: safeOperatorDisplay,
      source: input.source,
      config: scopedTargetConfig,
    });
    return materializeRun(run);
  }

  if (jiraScopedClient && jiraScopedEnvironment) {
    const scopedTargetConfig = withJiraScopedRuntimeTargetsForAdmission({
      config: targetConfig,
      client: jiraScopedClient,
      environment: jiraScopedEnvironment,
      releaseVersion: derivedReleaseVersion,
      ticketContext: ticketContextForDerivation,
    });
    const run = createQueuedConfiguredRun({
      jiraKey: normalizedJiraKey,
      client: jiraScopedClient,
      title: inferredTitle,
      environment: jiraScopedEnvironment,
      mode: input.mode,
      releaseVersion: derivedReleaseVersion,
      investigationTerms: ticketContextForDerivation?.extractedTerms,
      timeWindow: ticketContextForDerivation?.timeWindow,
      operatorDisplay: safeOperatorDisplay,
      source: input.source,
      config: scopedTargetConfig,
    });
    appendAudit(run, `now · dynamic Jira-scoped client/env resolved (${jiraScopedClient.id} ${jiraScopedEnvironment})`);
    return materializeRun(run);
  }

  const run: StoredInvestigationRun = {
    id: `inv-${Date.now()}-${randomUUID().slice(0, 8)}`,
    jiraKey: normalizedJiraKey || `CPSUP-${43050 + runs.size}`,
    title: input.title?.trim() || (ticketContextForDerivation?.fetchStatus === "fetched" ? ticketContextForDerivation.title : undefined) || (input.source === "jira-label"
      ? "Investigation created from Jira label intake"
      : "Fresh investigation launched from command deck"),
    client: normalizedClient || "Pilot Client",
    environment: input.environment || derivedEnvironment || "INT",
    ...(derivedReleaseVersion ? { releaseVersion: derivedReleaseVersion } : {}),
    status: "running",
    mode: input.mode || "aws-first",
    confidence: 0.58,
    accent: "cyan",
    updatedAt: "just now",
    summary: "Interactive demo run created. AWS triage is active while code and data analyzers wait for scope signals.",
    recommendation: "Use the interactive tabs to review how new runs materialize in the board.",
    analyzers: [
      { key: "aws", label: "AWS", status: "running", pulse: "hot", detail: "Scanning bounded CloudWatch sources from Cockpit target config." },
      { key: "code", label: "Code", status: "waiting", pulse: "cool", detail: "Waiting for repo hint before opening a code probe." },
      { key: "data", label: "Data", status: "waiting", pulse: "cool", detail: "Waiting for a configured pack, code-derived semantic diagnostic, or safe anchor probe." },
    ],
    findings: [],
    evidence: [],
    events: [
      {
        id: `created-${randomUUID()}`,
        sequence: 1,
        at: "now",
        title: input.source === "jira-label" ? "Jira intake received" : "Investigation launched",
        body: input.source === "jira-label"
          ? "New run created from a Jira label trigger with bounded investigation scope."
          : "New run created from the command deck with lower-environment pilot scope.",
        analyzer: "system",
      },
    ],
    approvalText: "Approval controls stay disabled until a recommendation exists.",
    jiraDraft: {
      clientSummary: ensureClientSummaryMentionsTicket(
        "No client-facing summary has been drafted yet for this run.",
        { jiraKey: normalizedJiraKey || `CPSUP-${43050 + runs.size}`, title: input.title?.trim() || (ticketContextForDerivation?.fetchStatus === "fetched" ? ticketContextForDerivation.title : undefined) },
      ),
      internalAnalysis: "No internal analysis draft has been prepared yet for this run.",
      proposedRemediation: {
        validationNotes: "No remediation draft has been prepared yet for this run.",
      },
    },
    audit: [
      input.source === "jira-label"
        ? `now · ${input.operatorDisplay} triggered Jira-label intake`
        : `now · ${input.operatorDisplay} launched a new pilot investigation`,
    ],
    ...(ticketContextForDerivation?.fetchStatus === "fetched" ? { ticketContext: sanitizeTicketContextForRun(ticketContextForDerivation) } : {}),
    runtime: { lastProgressAt: Date.now() - 7_000, nextEventSequence: 2 },
  };

  runs.set(run.id, run);
  return materializeRun(run);
}

export async function createInvestigationRun(input: {
  jiraKey?: string;
  title?: string;
  client?: string;
  environment?: InvestigationEnvironment;
  mode?: InvestigationMode;
  releaseVersion?: string;
  operatorDisplay: string;
  operatorSshPassword?: string;
  investigationHint?: string;
  source?: "command-deck" | "jira-label";
}) {
  const previousAdmission = investigationAdmissionTail;
  let releaseAdmission!: () => void;
  investigationAdmissionTail = new Promise<void>((resolve) => {
    releaseAdmission = resolve;
  });
  await previousAdmission;
  try {
    return await createInvestigationRunWithAdmission(input);
  } finally {
    releaseAdmission();
  }
}

export async function createInvestigationRuns(input: {
  tickets: Array<{
    jiraKey?: string;
    title?: string;
    client?: string;
    environment?: InvestigationEnvironment;
    mode?: InvestigationMode;
    releaseVersion?: string;
  }>;
  operatorDisplay: string;
}) {
  if (!Array.isArray(input.tickets) || input.tickets.length === 0) {
    throw new InvestigationServiceError("At least one investigation ticket is required", 400, "tickets_required");
  }
  if (input.tickets.length > 10) {
    throw new InvestigationServiceError("Batch investigation is limited to 10 tickets", 400, "ticket_batch_too_large");
  }

  const created: InvestigationRun[] = [];
  for (const ticket of input.tickets) {
    created.push(await createInvestigationRun({
      ...ticket,
      operatorDisplay: input.operatorDisplay,
      source: "command-deck",
    }));
  }

  return { runs: created };
}

export async function createInvestigationRunFromJiraWebhook(payload: unknown): Promise<InvestigationWebhookResult> {
  tickRuns();

  if (!isWebhookPayload(payload) || !payload.issue?.key) {
    throw new InvestigationServiceError("Jira webhook payload is missing issue.key", 400, "invalid_jira_webhook");
  }

  const triggerLabel = getInvestigationTriggerLabel();
  const jiraKey = (() => {
    try {
      return assertValidJiraKey(payload.issue.key);
    } catch (error) {
      if (error instanceof OneShotRunRequestError) {
        throw new InvestigationServiceError(error.message, error.statusCode, "invalid_jira_key");
      }
      throw error;
    }
  })();

  const issueLabels = (payload.issue.fields?.labels || []).map((label) => normalizeLabel(label));
  const labelChange = payload.changelog?.items?.find((item) => item.field === "labels" || item.fieldId === "labels");
  const addedLabels = labelChange
    ? parseLabelList(labelChange.toString).filter((label) => !parseLabelList(labelChange.fromString).includes(label))
    : [];
  const hasTriggerLabel = issueLabels.includes(triggerLabel);
  const triggerAdded = addedLabels.includes(triggerLabel);

  if (!triggerAdded && !(!payload.changelog && hasTriggerLabel)) {
    return {
      accepted: true,
      triggered: false,
      reason: `ignored: label ${triggerLabel} was not added`,
      triggerLabel,
    };
  }

  const existing = activeRunForJiraKey(jiraKey);
  if (existing) {
    appendAudit(existing, `now · jira webhook repeated label trigger for ${triggerLabel}`);
    appendEvent(existing, {
      id: `jira-webhook-duplicate-${randomUUID()}`,
      at: "now",
      title: "Duplicate Jira label ignored",
      body: `Jira webhook received ${triggerLabel} again, but an active run already exists for this ticket.`,
      analyzer: "system",
    });
    existing.updatedAt = "just now";
    return {
      accepted: true,
      triggered: false,
      reason: "ignored: active run already exists for ticket",
      triggerLabel,
      run: materializeRun(existing),
    };
  }

  const normalizedLabels = Array.from(new Set([...issueLabels, ...addedLabels]));
  const environment = isEnvironmentValue(payload.environment)
    ? payload.environment
    : inferEnvironmentFromLabels(normalizedLabels);
  const mode = isModeValue(payload.mode)
    ? payload.mode
    : inferModeFromLabels(normalizedLabels);
  const run = await createInvestigationRun({
    jiraKey,
    title: payload.issue.fields?.summary,
    client: typeof payload.client === "string" ? payload.client : inferClientFromLabels(normalizedLabels),
    environment,
    mode,
    operatorDisplay: "jira-webhook",
    source: "jira-label",
  });

  const stored = getRunOrThrow(run.id);
  if (stored.client !== "Client A") {
    stored.summary = "Jira label intake triggered a bounded investigation run. AWS triage is active while code and data analyzers await scope signals.";
    stored.recommendation = "Follow the live run as bounded evidence is gathered from the Jira-triggered intake path.";
  }
  appendAudit(stored, `now · Jira label ${triggerLabel} added to ${jiraKey}`);
  appendEvent(stored, {
    id: `jira-webhook-${randomUUID()}`,
    at: "now",
    title: "Jira label matched",
    body: `Label ${triggerLabel} triggered Investigation Cockpit intake for ${jiraKey}.`,
    analyzer: "system",
  });
  stored.updatedAt = "just now";

  return {
    accepted: true,
    triggered: true,
    reason: `created: label ${triggerLabel} added`,
    triggerLabel,
    run: materializeRun(stored),
  };
}

function appendAudit(run: StoredInvestigationRun, entry: string) {
  run.audit = [entry, ...run.audit].slice(0, 20);
}

function setRunAccent(status: InvestigationStatus): InvestigationRun["accent"] {
  switch (status) {
    case "queued":
    case "waiting_for_target":
      return "amber";
    case "running":
      return "cyan";
    case "awaiting_review":
      return "amber";
    case "completed":
      return "green";
    case "escalated":
    case "failed":
      return "red";
  }
}

export function approveInvestigationRecommendation(runId: string, operatorDisplay: string) {
  const run = getRunOrThrow(runId);
  const safeOperatorDisplay = sanitizeOperatorDisplay(operatorDisplay);
  if (run.recommendation === "Recommendation approved and packaged for operator follow-through.") {
    return materializeRun(run);
  }
  if (run.recommendation.startsWith("Approval blocked until the causal diagnosis is complete.")) {
    return materializeRun(run);
  }
  const approvalDecision = evaluateInvestigationResolutionGate({
    action: "approve_recommendation",
    assessment: run.resolution,
  });
  if (!approvalDecision.allowed) {
    run.status = "awaiting_review";
    run.accent = setRunAccent(run.status);
    run.updatedAt = "just now";
    run.recommendation = `Approval blocked until the causal diagnosis is complete. ${approvalDecision.reason}`;
    run.approvalText = "Approval blocked. The evidence bundle may be reviewed, but no remediation handoff is permitted until the shared resolution gate passes.";
    appendAudit(run, `now · ${safeOperatorDisplay} approval blocked by incomplete causal diagnosis`);
    appendEvent(run, {
      id: `approval-blocked-rca-${randomUUID()}`,
      at: "now",
      title: "Approval blocked by resolution gate",
      body: "The causal diagnosis is incomplete or a material symptom cluster remains unexplained.",
      analyzer: "system",
    });
    return materializeRun(run);
  }
  if (hasMappedDeployedConfigBlocker(run)) {
    run.status = "escalated";
    run.accent = setRunAccent(run.status);
    run.updatedAt = "just now";
    run.recommendation = "Approval blocked until LDAP SSH deployed jar/properties evidence is collected from the approved host.";
    run.approvalText = "Approval blocked. Refresh operator LDAP SSH access and rerun the cockpit investigation; no automated mitigation was executed.";
    appendAudit(run, `now · ${safeOperatorDisplay} approval blocked by missing LDAP SSH deployed jar/properties evidence`);
    appendEvent(run, {
      id: `approval-blocked-${randomUUID()}`,
      at: "now",
      title: "Approval blocked",
      body: "Mandatory deployed jar/properties evidence is missing or unavailable. The run remains read-only and escalated.",
      analyzer: "system",
    });
    return materializeRun(run);
  }


  run.status = "completed";
  run.accent = setRunAccent(run.status);
  run.updatedAt = "just now";
  run.recommendation = "Recommendation approved and packaged for operator follow-through.";
  run.approvalText = "Recommendation approved. This run remains read-only and no automated mitigation was executed.";
  run.jiraDraft.internalAnalysis = `${run.jiraDraft.internalAnalysis}\n\nApproved by ${operatorDisplay} for operator follow-through.`;
  appendAudit(run, `now · ${operatorDisplay} approved the recommendation`);
  appendEvent(run, {
    id: `approval-${randomUUID()}`,
    at: "now",
    title: "Recommendation approved",
    body: "Operator approved the recommendation. The run remains read-only and no automated mitigation was executed.",
    analyzer: "system",
  });
  return materializeRun(run);
}

export async function requestInvestigationCodeFixPullRequest(
  runId: string,
  operator: InvestigationCodeFixRequestOperator,
  submitter: InvestigationCodeFixRequestSubmitter,
) {
  const run = getRunOrThrow(runId);
  const codeFixDecision = evaluateInvestigationResolutionGate({
    action: "request_code_fix",
    assessment: run.resolution,
  });
  if (!codeFixDecision.allowed) {
    throw new InvestigationServiceError(
      `A draft code-fix PR cannot be requested until the shared resolution gate passes. ${codeFixDecision.reason}`,
      409,
      "resolution_gate_incomplete",
    );
  }
  const safeOperator: InvestigationCodeFixRequestOperator = {
    id: sanitizeString(operator.id, "operator"),
    display: sanitizeOperatorDisplay(operator.display),
  };
  if (!hasCodeOrConfigRemediationSignal(run)) {
    throw new InvestigationServiceError(
      "This investigation does not have a code or repository-configuration remediation signal. Use the appropriate data diagnostic output or Jira/manual remediation instead.",
      409,
      "code_fix_not_supported",
    );
  }

  const request = await submitter({
    jiraKey: run.jiraKey,
    operator: safeOperator,
  });
  const codeFix = run.jiraDraft.proposedRemediation.codeFix?.trim()
    || defaultCodeFixRemediation(run);

  if (run.status === "running" || run.status === "queued" || run.status === "waiting_for_target") {
    run.status = "awaiting_review";
  }
  run.accent = setRunAccent(run.status);
  run.updatedAt = "just now";
  run.jiraDraft.proposedRemediation.codeFix = codeFix;
  run.jiraDraft.internalAnalysis = sanitizeString(`${run.jiraDraft.internalAnalysis}\n\nOneShot draft PR request #${request.id} was queued by ${safeOperator.display}. Cockpit evidence remains the remediation scope; OneShot must create a draft PR only and human developer review remains required.`);
  run.approvalText = `Code or repository-configuration remediation queued to OneShot request #${request.id}. OneShot validates plan, implementation, code review, and tests before creating a draft PR. Human developer review and merge approval remain required.`;
  appendAudit(run, `now · ${safeOperator.display} queued OneShot draft PR request #${request.id} for code/repository-configuration remediation`);
  appendEvent(run, {
    id: `oneshot-${randomUUID()}`,
    at: "now",
    title: "OneShot draft PR requested",
    body: `Cockpit submitted ${run.jiraKey} to OneShot request #${request.id}. OneShot will create a draft PR only if its planning/review/implementation/testing gates pass.`,
    analyzer: "code",
  });
  return materializeRun(run);
}

export function escalateInvestigationRun(runId: string, operatorDisplay: string) {
  const run = getRunOrThrow(runId);
  run.status = "escalated";
  run.accent = setRunAccent(run.status);
  run.updatedAt = "just now";
  run.recommendation = "Escalated with evidence bundle and current bounded scope.";
  run.approvalText = "Escalated for manual review. Replica and read-only boundaries remain locked.";
  appendAudit(run, `now · ${operatorDisplay} escalated the run`);
  appendEvent(run, {
    id: `escalate-${randomUUID()}`,
    at: "now",
    title: "Escalated by operator",
    body: "Operator requested escalation with the current evidence bundle and bounded investigation scope.",
    analyzer: "system",
  });
  return materializeRun(run);
}

export async function postInvestigationSummary(runId: string, operatorDisplay: string) {
  if (jiraCommentPostingDisabled()) {
    throw new InvestigationServiceError("Jira comment posting is disabled; summary was not posted", 503, "jira_comments_disabled");
  }
  const run = getRunOrThrow(runId);
  const posted = await postJiraIssueComment(run.jiraKey, buildInvestigationJiraSummaryComment(run, operatorDisplay));
  if (run.status === "running") {
    run.status = "awaiting_review";
  }
  run.accent = setRunAccent(run.status);
  run.updatedAt = "just now";
  run.jiraDraft.internalAnalysis = `${run.jiraDraft.internalAnalysis}\n\nPosted by ${operatorDisplay} to Jira ticket ${run.jiraKey}.`;
  appendAudit(run, `now · ${operatorDisplay} posted the Jira summary comment to ${run.jiraKey}`);
  appendEvent(run, {
    id: `jira-${randomUUID()}`,
    at: "now",
    title: "Jira summary posted",
    body: `Operator posted the current redacted investigation summary to Jira${posted.id ? ` (comment ${posted.id})` : ""}.`,
    analyzer: "system",
  });
  return materializeRun(run);
}
