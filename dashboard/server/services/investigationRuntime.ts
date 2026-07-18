import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import type { InvestigationAdapterRegistry, DataDiagnosticsAdapter, HostInspectionAdapter } from "../../../src/investigation/adapters/types.js";
import { ConfidenceScorer } from "../../../src/investigation/control-plane/ConfidenceScorer.js";
import { enrichScopeWithDiagnosticEvidence } from "../../../src/investigation/control-plane/DiagnosticScope.js";
import { EscalationPolicy, type InvestigationNextStep } from "../../../src/investigation/control-plane/EscalationPolicy.js";
import type { InvestigationConnectionRegistry, InvestigationConnectionTarget } from "../../../src/investigation/data/ConnectionRegistry.js";
import type {
  InvestigationCloudWatchLogScope,
  InvestigationHostTarget,
  InvestigationHostTargetRegistry,
} from "../../../src/investigation/data/HostTargetRegistry.js";
import {
  buildAnchorProbeQueries,
  buildColumnInventoryQuery,
  getAnchorDiagnosticTables,
  hasAnchorDrivenProbeScope,
  type AnchorProbeQuery,
  type CodeFlowColumnInventoryRow,
} from "../../../src/investigation/data/AnchorDrivenDataProbe.js";
import { planCodeDerivedDiagnostic } from "../../../src/investigation/data/CodeDerivedDiagnosticPlanner.js";
import { PhiGuard } from "../../../src/investigation/data/PhiGuard.js";
import { QueryPackRegistry } from "../../../src/investigation/data/QueryPackRegistry.js";
import { QueryValidator } from "../../../src/investigation/data/QueryValidator.js";
import { sanitizeTextValue } from "../../../src/investigation/redaction/SensitiveTextRedactor.js";
import { callWatchdogMcpTool } from "./watchdogMcpClient.js";
import type {
  InvestigationAdapterKind,
  InvestigationAdapterRequest,
  InvestigationAdapterResult,
  InvestigationAdapterTraceStep,
  InvestigationCorrelationResult,
  InvestigationEvidenceArtifact,
  InvestigationEnvironment,
  InvestigationFinding,
  InvestigationRunRecord,
  InvestigationScope,
} from "../../../src/investigation/types/investigation.js";

const execFileAsync = promisify(execFile);

type WatchdogMcpCaller = <T = unknown>(name: string, args: Record<string, unknown>) => Promise<T>;

interface HostDeployedConfigInspectionAdapter extends HostInspectionAdapter {
  executeDeployedConfigOnly?(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult>;
}

interface WatchdogMcpResponse {
  status?: string;
  message?: string;
  scope?: Record<string, unknown>;
  [key: string]: unknown;
}

interface WatchdogMcpSearchBundle extends WatchdogMcpResponse {
  search_id?: string;
  summary_counts?: {
    total_matches?: number;
    returned_samples?: number;
    regions?: Record<string, number>;
    log_groups?: Record<string, number>;
  };
  top_samples?: Array<Record<string, unknown>>;
  warnings?: string[];
}

export interface DashboardCreateInvestigationRunInput {
  jiraKey: string;
  title: string;
  scope: InvestigationScope;
}

export interface DashboardInvestigationRunExecution {
  run: InvestigationRunRecord;
  findings: InvestigationFinding[];
  evidence: InvestigationEvidenceArtifact[];
  correlation: InvestigationCorrelationResult;
  nextStep: InvestigationNextStep;
}

interface SecretResolver {
  resolve(target: InvestigationConnectionTarget): Promise<{ password: string | null }>;
}

interface DbCredentialMaterial {
  username: string;
  password: string;
  database?: string;
  source: "operator_runtime" | "target_secret";
}

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

function requireOperatorDbCredentials(): boolean {
  return envFlag("INVESTIGATION_REQUIRE_OPERATOR_DB_CREDENTIALS", true);
}

function allowTargetSecretDbCredentials(): boolean {
  return envFlag("INVESTIGATION_ALLOW_TARGET_SECRET_DB_CREDENTIALS", false);
}

function operatorDbCredentialMaterial(target: InvestigationConnectionTarget): DbCredentialMaterial {
  const username = process.env.INVESTIGATION_DB_USERNAME?.trim() || process.env.MERIDIAN_DB_USERNAME?.trim();
  const password = process.env.INVESTIGATION_DB_PASSWORD || process.env.MERIDIAN_DB_PASSWORD;
  const database = process.env.INVESTIGATION_DB_DATABASE?.trim() || process.env.MERIDIAN_DB_DATABASE?.trim() || target.databaseName || undefined;

  if (!username || !password) {
    throw new Error(
      "Investigation Cockpit operator DB credential mode is enabled. "
      + "Set INVESTIGATION_DB_USERNAME/INVESTIGATION_DB_PASSWORD or MERIDIAN_DB_USERNAME/MERIDIAN_DB_PASSWORD for the attended run; "
      + "target/shared DB credentials are not allowed in this mode.",
    );
  }

  return {
    username,
    password,
    database,
    source: "operator_runtime",
  };
}

function dbSslOptions(target: InvestigationConnectionTarget): { ca: string; rejectUnauthorized: true } | undefined {
  if (!target.sslRequired) {
    return undefined;
  }

  const caPath = target.sslCa || process.env.INVESTIGATION_DB_SSL_CA?.trim();
  if (!caPath) {
    throw new Error(`DB target ${target.id} requires TLS, but no sslCa or INVESTIGATION_DB_SSL_CA is configured`);
  }

  return {
    ca: readFileSync(caPath, "utf8"),
    rejectUnauthorized: true,
  };
}

async function enforceReadonlyMysqlSession(connection: mysql.Connection, targetId: string): Promise<void> {
  await connection.query("SET SESSION max_execution_time=10000, SESSION transaction_read_only=ON");
  const [readonlyRows] = await connection.query<RowDataPacket[]>("SELECT @@session.transaction_read_only AS session_readonly");
  const sessionReadonly =
    Array.isArray(readonlyRows) && readonlyRows.length > 0
      ? String((readonlyRows[0] as Record<string, unknown>).session_readonly)
      : "0";
  if (!["1", "ON", "on", "true", "True"].includes(sessionReadonly)) {
    throw new Error(`DB target ${targetId} did not enter transaction_read_only session mode`);
  }
}

class DefaultSecretResolver implements SecretResolver {
  async resolve(target: InvestigationConnectionTarget): Promise<{ password: string | null }> {
    if (target.secretRef.startsWith("env://")) {
      const envName = target.secretRef.slice("env://".length);
      return { password: process.env[envName]?.trim() || null };
    }

    if (target.secretRef.startsWith("sm://")) {
      const secretId = target.secretRef.slice("sm://".length);
      const args = [
        ...(process.env.INVESTIGATION_CLIENT_A_AWS_PROFILE ? ["--profile", process.env.INVESTIGATION_CLIENT_A_AWS_PROFILE] : []),
        "secretsmanager",
        "get-secret-value",
        "--region",
        process.env.INVESTIGATION_CLIENT_A_AWS_REGION || "us-east-2",
        "--secret-id",
        secretId,
        "--output",
        "json",
      ];
      const { stdout } = await execFileAsync("aws", args, { maxBuffer: 1024 * 1024 * 4 });
      const payload = JSON.parse(stdout) as { SecretString?: string };
      if (!payload.SecretString) {
        return { password: null };
      }
      try {
        const parsed = JSON.parse(payload.SecretString) as { password?: string };
        return { password: parsed.password?.trim() || null };
      } catch {
        return { password: payload.SecretString.trim() || null };
      }
    }

    return { password: null };
  }
}

export class DashboardInvestigationControlPlane {
  private readonly runner: DashboardInvestigationRunner;

  constructor(adapters: InvestigationAdapterRegistry) {
    this.runner = new DashboardInvestigationRunner(adapters);
  }

  createRun(input: DashboardCreateInvestigationRunInput): InvestigationRunRecord {
    const timestamp = new Date().toISOString();
    return {
      id: `inv-${Date.now()}`,
      jiraKey: input.jiraKey,
      title: input.title,
      scope: input.scope,
      status: "queued",
      currentStage: "intake",
      confidence: null,
      summary: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  executeRun(run: InvestigationRunRecord): Promise<DashboardInvestigationRunExecution> {
    return this.runner.execute({
      ...run,
      status: "running",
      currentStage: "aws_triage",
      updatedAt: new Date().toISOString(),
    });
  }
}

class DashboardInvestigationRunner {
  private readonly scorer = new ConfidenceScorer();
  private readonly escalationPolicy = new EscalationPolicy();

  constructor(private readonly adapters: InvestigationAdapterRegistry) {}

  async execute(run: InvestigationRunRecord): Promise<DashboardInvestigationRunExecution> {
    const findings: InvestigationFinding[] = [];
    const evidence: InvestigationEvidenceArtifact[] = [];

    await this.executeAdapter("aws", run, findings, evidence);

    const initialCorrelation = this.scorer.score(findings);
    let hostProbeRan = false;
    let dataProbeRan = false;
    const codeRequired = requiresCodeInspection(run.scope);
    const runtimeLogsRequired = requiresRuntimeLogInspection(run.scope);

    if (initialCorrelation.shouldProbeHost || runtimeLogsRequired) {
      await this.executeAdapter("host", run, findings, evidence);
      hostProbeRan = true;
    }

    const runtimeEnrichedRun = {
      ...run,
      scope: enrichScopeWithRuntimeEvidence(run.scope, findings, evidence),
    };
    const afterRuntimeCorrelation = this.scorer.score(findings);
    if (
      afterRuntimeCorrelation.shouldProbeCode
      || codeRequired
      || requiresCodeInspection(runtimeEnrichedRun.scope)
    ) {
      await this.executeAdapter("code", runtimeEnrichedRun, findings, evidence);
    }

    const codeEnrichedRun = {
      ...runtimeEnrichedRun,
      scope: enrichScopeWithCodeEvidence(runtimeEnrichedRun.scope, findings, evidence),
    };
    if (
      hostProbeRan
      && shouldRetryDeployedConfigHostProbe(runtimeEnrichedRun.scope, codeEnrichedRun.scope, findings, evidence)
    ) {
      removeSshConfigProbeResults(findings, evidence);
      await this.executeHostDeployedConfigOnly(codeEnrichedRun, findings, evidence);
    }

    const afterCodeCorrelation = this.scorer.score(findings);
    if (
      afterCodeCorrelation.shouldProbeData
      || requiresDataDiagnostics(codeEnrichedRun.scope, findings, evidence)
    ) {
      await this.executeAdapter("data", {
        ...codeEnrichedRun,
        scope: enrichScopeWithDiagnosticEvidence(codeEnrichedRun.scope, findings, evidence),
      }, findings, evidence);
      dataProbeRan = true;
    }
    if (!hostProbeRan && afterCodeCorrelation.shouldProbeHost) {
      await this.executeAdapter("host", codeEnrichedRun, findings, evidence);
      hostProbeRan = true;
    }
    if (
      !afterCodeCorrelation.shouldEscalate
      && hostProbeRan
      && !dataProbeRan
      && requiresDataDiagnostics(codeEnrichedRun.scope, findings, evidence)
    ) {
      await this.executeAdapter("data", {
        ...codeEnrichedRun,
        scope: enrichScopeWithDiagnosticEvidence(codeEnrichedRun.scope, findings, evidence),
      }, findings, evidence);
    }

    const correlation = this.scorer.score(findings);
    const nextStep = enforceMandatoryDeployedConfigGate(
      enforceMandatoryCodeGate(
        this.escalationPolicy.decide(correlation),
        run.scope,
        findings,
        evidence,
      ),
      run.scope,
      findings,
      evidence,
    );
    const completedRun: InvestigationRunRecord = {
      ...run,
      status: nextStep.status,
      currentStage: nextStep.stage,
      confidence: correlation.confidence,
      summary: correlation.summary,
      updatedAt: new Date().toISOString(),
    };

    return {
      run: completedRun,
      findings,
      evidence,
      correlation,
      nextStep,
    };
  }

  private async executeAdapter(
    kind: InvestigationAdapterKind,
    run: InvestigationRunRecord,
    findings: InvestigationFinding[],
    evidence: InvestigationEvidenceArtifact[],
  ): Promise<InvestigationAdapterResult> {
    const adapter = this.adapters[kind];
    const request: InvestigationAdapterRequest = {
      runId: run.id,
      jiraKey: run.jiraKey,
      adapter: kind,
      scope: run.scope,
      constraints: {
        timeoutMs: 60_000,
        maxRows: 100,
        maxArtifacts: 20,
        redactionRequired: true,
      },
    };

    const result = await adapter.execute(request);
    findings.push(...result.findings);
    evidence.push(...result.evidence);
    return result;
  }

  private async executeHostDeployedConfigOnly(
    run: InvestigationRunRecord,
    findings: InvestigationFinding[],
    evidence: InvestigationEvidenceArtifact[],
  ): Promise<void> {
    const adapter = this.adapters.host as HostDeployedConfigInspectionAdapter;
    const request: InvestigationAdapterRequest = {
      runId: run.id,
      jiraKey: run.jiraKey,
      adapter: "host",
      scope: run.scope,
      constraints: {
        timeoutMs: 60_000,
        maxRows: 100,
        maxArtifacts: 20,
        redactionRequired: true,
      },
    };

    const result = adapter.executeDeployedConfigOnly
      ? await adapter.executeDeployedConfigOnly(request)
      : await adapter.execute(request);
    findings.push(...result.findings.filter(isSshConfigFinding));
    evidence.push(...result.evidence.filter(isSshConfigEvidence));
  }
}

function requiresCodeInspection(scope: InvestigationScope): boolean {
  if ((scope.repoNames?.length ?? 0) > 0) {
    return true;
  }

  const text = [
    ...(scope.serviceIds || []),
    ...(scope.keywords || []),
    ...(scope.hostTargets || []),
  ].join(" ").toLowerCase();

  return /\b(service|batch|job|processor|handler|controller|repository|manager|api|rest|endpoint|url|properties|property|config|class|method|exception|stack|queue|topic|lambda|scheduler|scheduled|cron|script|extract|extractor|export|exporter|import|importer|report|reporting|feed|program|process|utility|x12|ncpdp)\b/.test(text)
    || /\b[A-Za-z]+(?:Service|Processor|Handler|Controller|Manager|Repository|Batch|Job|Extract|Extractor|Export|Exporter|Import|Importer|Report|Reporting|Feed|Program|Process|Utility)\b/.test(text)
    || /\b[a-z0-9_.-]+\.(?:properties|yaml|yml|xml|java|ts|js)\b/i.test(text);
}

function requiresDataDiagnostics(
  scope: InvestigationScope,
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
): boolean {
  if (findings.some((finding) => finding.requiresDataChange)) {
    return true;
  }

  const text = [
    ...(scope.serviceIds || []),
    ...(scope.keywords || []),
    ...findings.map((finding) => `${finding.type}\n${finding.title}\n${finding.summary}\n${JSON.stringify(finding.metadata || {})}`),
    ...evidence.map((artifact) => `${artifact.title}\n${artifact.summary}\n${JSON.stringify(artifact.metadata || {})}`),
  ].join("\n").toLowerCase();

  return /\b(db|database|mysql|rds|sql|query|table|schema|transaction|batch_job_status|client_feature_flags|client_configurations)\b/.test(text)
    || /\b(feature flag|job state|job status|data state|database state|persistent state|reference data|transaction status)\b/.test(text);
}

function requiresRuntimeLogInspection(scope: InvestigationScope): boolean {
  if (process.env.INVESTIGATION_RUNTIME_LOGS_ENABLED === "false") {
    return false;
  }

  const text = [
    ...(scope.serviceIds || []),
    ...(scope.keywords || []),
    ...(scope.hostTargets || []),
  ].join(" ").toLowerCase();

  return (scope.serviceIds?.length ?? 0) > 0
    || /\b(watchdog|cloudwatch|log|logs|file\.log|runtime|service|batch|job|processor|handler|api|rest|endpoint|http|exception|error|failed|failure|timeout|queue|scheduler|scheduled|cron|script)\b/.test(text);
}

function requiresDeployedConfigInspection(scope: InvestigationScope): boolean {
  if (process.env.INVESTIGATION_DEPLOYED_CONFIG_PROBE_REQUIRED === "false") {
    return false;
  }

  const text = [
    scope.codeVersion,
    ...(scope.serviceIds || []),
    ...(scope.keywords || []),
    ...(scope.repoNames || []),
  ].join(" ").toLowerCase();

  return /\b(page\s*size|pagesize|properties|property|config|configuration|batch|job|scheduler|queue|backlog)\b/.test(text)
    || /\b[a-z0-9_.-]+\.(?:properties|yaml|yml|xml|conf|cfg)\b/i.test(text);
}

function enrichScopeWithRuntimeEvidence(
  scope: InvestigationScope,
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
): InvestigationScope {
  const runtimeTerms = extractRuntimeEvidenceTerms(findings, evidence);
  if (runtimeTerms.length === 0) {
    return scope;
  }

  return {
    ...scope,
    keywords: Array.from(new Set([
      ...(scope.keywords || []),
      ...runtimeTerms,
    ])).slice(0, 80),
  };
}

function extractRuntimeEvidenceTerms(
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
): string[] {
  const hostFindings = findings.filter((finding) => finding.adapter === "host");
  const hostEvidence = evidence.filter((artifact) => artifact.adapter === "host");
  const text = [
    ...hostFindings.map((finding) => `${finding.title}\n${finding.summary}\n${JSON.stringify(finding.metadata || {})}`),
    ...hostEvidence.map((artifact) => `${artifact.title}\n${artifact.summary}\n${JSON.stringify(artifact.metadata || {})}`),
  ].join("\n");

  return Array.from(new Set([
    ...extractPatternTerms(text, /\b[A-Za-z0-9_.$]*(?:Exception|Error|Service|Client|Handler|Processor|Watcher|Controller|Manager|Repository|Batch|Job|Config|Configuration)\b/g),
    ...extractPatternTerms(text, /\b[A-Za-z0-9_.-]+(?:-service|-processor|-handler|-watcher|-batch|-job)\b/gi),
    ...extractPatternTerms(text, /\b[A-Za-z][A-Za-z0-9_.-]*\.jar\b/gi),
    ...extractPatternTerms(text, /\bHTTP\s*(?:RESPONSE STATUS CODE\s*:?\s*)?[45]\d\d\b/gi),
    ...extractPatternTerms(text, /\bstatus\s*:?\s*[45]\d\d\b/gi),
    ...extractPatternTerms(text, /\b[A-Za-z][A-Za-z0-9_]*(?:Id|ID|Url|URL|Token|Session|Queue|Route|Endpoint)\b/g),
  ]))
    .map((term) => term.trim())
    .filter((term) => term.length >= 4 && term.length <= 100)
    .filter((term) => !isJiraIssueKeyLike(term))
    .slice(0, 30);
}

function isJiraIssueKeyLike(value: string): boolean {
  return /^[A-Z][A-Z0-9]+-\d+$/i.test(value.trim());
}

function compactNoiseTerm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isGenericInvestigationNoiseTerm(value: string): boolean {
  const compact = compactNoiseTerm(value);
  return new Set([
    "dev",
    "development",
    "int",
    "integration",
    "lower",
    "prod",
    "production",
    "prodreplica",
    "qa",
    "stage",
    "staging",
    "uat",
  ]).has(compact);
}

function cleanScopeEvidenceTerm(value: string): string {
  return value
    .trim()
    .replace(/^[`"',;:()[\]{}<>]+|[`"',;:()[\]{}<>.]+$/g, "")
    .replace(/\\\//g, "/")
    .trim();
}

function scopeEvidenceTermVariants(value: string): string[] {
  const clean = cleanScopeEvidenceTerm(value);
  if (!clean) {
    return [];
  }

  const variants = new Set<string>();
  if (!/[\\/]/.test(clean) || clean.startsWith("/")) {
    variants.add(clean);
  }
  const segments = clean.split(/[\\/]/).filter(Boolean);
  const base = segments.at(-1);
  const parent = segments.length > 1 ? segments.at(-2) : undefined;
  if (base) {
    variants.add(base);
    variants.add(base.replace(/\.(?:jar|properties|ya?ml|xml|conf|cfg|json|sh|ksh|bash|py|sql|log)$/i, ""));
  }
  if (parent && parent.length >= 4) {
    variants.add(parent);
  }
  for (const variant of [...variants]) {
    if (variant.includes("_")) {
      variants.add(variant.replace(/_/g, "-"));
    }
    if (variant.includes("-")) {
      variants.add(variant.replace(/-/g, "_"));
    }
  }
  return [...variants].filter(Boolean);
}

function isUsefulCodeEvidenceTerm(value: string): boolean {
  return value.length >= 4
    && value.length <= 180
    && !isJiraIssueKeyLike(value)
    && !/^\d+(?:\.\d+){1,2}$/.test(value)
    && !isGenericInvestigationNoiseTerm(value)
    && !/^(main|application|config|configuration|properties|property|service|client|batch|job|jobs|core-app|batch-jobs)$/i.test(value);
}

function codeEvidenceTermScore(value: string): number {
  return value.length
    + (value.startsWith("/") ? 300 : 0)
    - (/[\\/]/.test(value) && !value.startsWith("/") ? 160 : 0)
    + (/\.(?:jar|properties|ya?ml|xml|conf|cfg|sh|ksh|bash)$/i.test(value) ? 240 : 0)
    + (/(?:service|processor|handler|watcher|batch|job|scheduler|intake|config|properties|jar)/i.test(value) ? 100 : 0)
    + (/[._-]/.test(value) ? 60 : 0)
    - (/^(core-app|batch-jobs|jobs|queues?|move|status|tracking)$/i.test(value) ? 180 : 0);
}

function extractCodeEvidenceTerms(
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
): string[] {
  const codeFindings = findings.filter((finding) => finding.adapter === "code");
  const codeEvidence = evidence.filter((artifact) => artifact.adapter === "code");
  const priorityTerms = new Set<string>();
  const secondaryTerms = new Set<string>();
  const text = [
    ...codeFindings.map((finding) => `${finding.title}\n${finding.summary}\n${JSON.stringify(finding.metadata || {})}`),
    ...codeEvidence.map((artifact) => `${artifact.title}\n${artifact.summary}\n${JSON.stringify(artifact.metadata || {})}`),
  ].join("\n");
  const add = (value: string | undefined, bucket: Set<string> = secondaryTerms) => {
    if (!value) {
      return;
    }
    for (const variant of scopeEvidenceTermVariants(value)) {
      if (isUsefulCodeEvidenceTerm(variant)) {
        bucket.add(variant);
      }
    }
  };
  const addEmbedded = (value: string | undefined, bucket: Set<string> = secondaryTerms) => {
    if (!value) {
      return;
    }
    add(value, bucket);
    for (const match of value.matchAll(/\b[A-Za-z0-9_.\/-]+\.(?:jar|properties|ya?ml|xml|conf|cfg|json|sh|ksh|bash|py|sql|log)\b/gi)) {
      add(match[0], bucket);
    }
    for (const match of value.matchAll(/\/(?:opt|medhok|usr|var|etc)\/[A-Za-z0-9_.\/-]{4,180}/gi)) {
      add(match[0], bucket);
    }
    for (const match of value.matchAll(/\b[A-Za-z][A-Za-z0-9_.$-]*(?:Exception|Error|Service|Client|Handler|Processor|Watcher|Controller|Manager|Repository|Batch|Job|Config|Configuration|Scheduler|Command|Script)\b/g)) {
      add(match[0], bucket);
    }
    for (const match of value.matchAll(/\b[A-Za-z0-9_.-]+(?:-service|-processor|-handler|-watcher|-batch|-job|-scheduler|-intake|-loader|-runner|_service|_processor|_handler|_watcher|_batch|_job|_scheduler|_intake|_loader|_runner)\b/gi)) {
      add(match[0], bucket);
    }
    for (const match of value.matchAll(/\b[A-Za-z0-9_.-]+\.(?:properties|conf|cfg|ya?ml|xml)\s*=\s*([A-Za-z0-9_.\/-]+\.(?:properties|conf|cfg|ya?ml|xml))\b/gi)) {
      add(match[1], bucket);
    }
  };
  const collectHitMetadata = (value: unknown, bucket: Set<string>) => {
    if (!value || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of ["path", "file", "term", "preview"]) {
      if (typeof record[key] === "string") {
        addEmbedded(record[key] as string, bucket);
      }
    }
  };
  const collectHitArray = (value: unknown, bucket: Set<string>, limit = 40) => {
    if (!Array.isArray(value)) {
      return;
    }
    value.slice(0, limit).forEach((entry) => collectHitMetadata(entry, bucket));
  };
  const collectStructuredMetadata = (value: unknown) => {
    if (typeof value === "string") {
      addEmbedded(value, priorityTerms);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.strongestCandidate === "string") {
      addEmbedded(record.strongestCandidate, priorityTerms);
    }
    collectHitArray(record.hits, priorityTerms);
    const discovery = record.batchSchedulerDiscovery as Record<string, unknown> | undefined;
    if (discovery && typeof discovery === "object") {
      collectHitArray(discovery.schedulerHits, priorityTerms);
      collectHitArray(discovery.configHits, priorityTerms);
      if (Array.isArray(discovery.schedulerTerms)) {
        discovery.schedulerTerms.slice(0, 240).forEach((term) => {
          if (typeof term === "string") {
            addEmbedded(term, secondaryTerms);
          }
        });
      }
    }
    if (Array.isArray(record.schedulerTerms)) {
      record.schedulerTerms.slice(0, 120).forEach((term) => {
        if (typeof term === "string") {
          addEmbedded(term, secondaryTerms);
        }
      });
    }
    if (Array.isArray(record.terms)) {
      record.terms.slice(0, 80).forEach((term) => {
        if (typeof term === "string") {
          addEmbedded(term, secondaryTerms);
        }
      });
    }
  };

  codeFindings.forEach((finding) => collectStructuredMetadata(finding.metadata));
  codeEvidence.forEach((artifact) => collectStructuredMetadata(artifact.metadata));

  for (const match of text.matchAll(/\b[A-Za-z0-9_.\/-]+\.(?:jar|properties|ya?ml|xml|conf|cfg|json|sh|ksh|bash|py|sql|log)\b/gi)) {
    add(match[0]);
  }
  for (const match of text.matchAll(/\/(?:opt|medhok|usr|var|etc)\/[A-Za-z0-9_.\/-]{4,180}/gi)) {
    add(match[0]);
  }
  for (const match of text.matchAll(/\b[A-Za-z][A-Za-z0-9_.$-]*(?:Exception|Error|Service|Client|Handler|Processor|Watcher|Controller|Manager|Repository|Batch|Job|Config|Configuration|Scheduler|Command|Script)\b/g)) {
    add(match[0]);
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9_.-]+(?:-service|-processor|-handler|-watcher|-batch|-job|-scheduler|-intake|-loader|-runner|_service|_processor|_handler|_watcher|_batch|_job|_scheduler|_intake|_loader|_runner)\b/gi)) {
    add(match[0]);
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9_.-]+\.(?:properties|conf|cfg|ya?ml|xml)\s*=\s*([A-Za-z0-9_.\/-]+\.(?:properties|conf|cfg|ya?ml|xml))\b/gi)) {
    add(match[1]);
  }

  const sortTerms = (terms: Set<string>) => [...terms]
    .sort((left, right) =>
      codeEvidenceTermScore(right) - codeEvidenceTermScore(left)
      || right.length - left.length
      || left.localeCompare(right),
    );

  return Array.from(new Set([
    ...sortTerms(priorityTerms),
    ...sortTerms(secondaryTerms),
  ])).slice(0, 160);
}

function enrichScopeWithCodeEvidence(
  scope: InvestigationScope,
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
): InvestigationScope {
  const codeTerms = extractCodeEvidenceTerms(findings, evidence);
  if (codeTerms.length === 0) {
    return scope;
  }

  return {
    ...scope,
    keywords: Array.from(new Set([
      ...(scope.keywords || []),
      ...codeTerms,
    ])).slice(0, 180),
    diagnosticContext: {
      ...scope.diagnosticContext,
      codeEvidenceTerms: Array.from(new Set([
        ...(scope.diagnosticContext?.codeEvidenceTerms || []),
        ...codeTerms,
      ])).slice(0, 160),
    },
  };
}

function hasNewDeployedConfigTerms(before: InvestigationScope, after: InvestigationScope): boolean {
  const beforeTerms = new Set([
    ...(before.keywords || []),
    ...(before.serviceIds || []),
  ].map((term) => term.toLowerCase()));
  return [
    ...(after.keywords || []),
    ...(after.diagnosticContext?.codeEvidenceTerms || []),
  ].some((term) =>
    !beforeTerms.has(term.toLowerCase())
    && /(?:[._/-]|service|processor|handler|watcher|batch|job|scheduler|intake|loader|runner|config|properties|\.jar)/i.test(term),
  );
}

function extractPatternTerms(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

function hasCodeValidationEvidence(evidence: InvestigationEvidenceArtifact[]): boolean {
  return evidence.some((artifact) => artifact.adapter === "code");
}

function hasCodeUnavailableFinding(findings: InvestigationFinding[]): boolean {
  return findings.some((finding) =>
    finding.adapter === "code"
    && (
      finding.type === "code_scope_unavailable"
      || finding.type === "code_workspace_missing"
      || finding.type === "code_remote_refresh_required"
    ),
  );
}

function hasDeployedConfigEvidence(evidence: InvestigationEvidenceArtifact[]): boolean {
  return evidence.some((artifact) =>
    artifact.adapter === "host"
    && artifact.id.endsWith("ssh-config-evidence")
    && /^LDAP SSH deployed (?:jar\/properties|properties) probe$/.test(artifact.title)
    && Array.isArray(artifact.metadata?.matchedFiles)
    && artifact.metadata.matchedFiles.length > 0,
  );
}

function hasDeployedConfigUnavailableFinding(findings: InvestigationFinding[]): boolean {
  return findings.some((finding) =>
    finding.adapter === "host"
    && (
      finding.type === "ssh_config_unavailable"
      || finding.type === "ssh_config_no_evidence"
    ),
  );
}

function isSshConfigFinding(finding: InvestigationFinding): boolean {
  return finding.adapter === "host"
    && (
      finding.type === "ssh_config_evidence"
      || finding.type === "ssh_config_unavailable"
      || finding.type === "ssh_config_no_evidence"
      || finding.id.includes("ssh-config")
    );
}

function isSshConfigEvidence(artifact: InvestigationEvidenceArtifact): boolean {
  return artifact.adapter === "host"
    && (
      artifact.id.endsWith("ssh-config-evidence")
      || artifact.id.endsWith("ssh-config-unavailable")
      || /^LDAP SSH deployed (?:jar\/properties|properties) probe/.test(artifact.title)
    );
}

function removeSshConfigProbeResults(
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
): void {
  for (let index = findings.length - 1; index >= 0; index -= 1) {
    if (isSshConfigFinding(findings[index])) {
      findings.splice(index, 1);
    }
  }
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    if (isSshConfigEvidence(evidence[index])) {
      evidence.splice(index, 1);
    }
  }
}

function shouldRetryDeployedConfigHostProbe(
  beforeScope: InvestigationScope,
  afterScope: InvestigationScope,
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
): boolean {
  return requiresDeployedConfigInspection(afterScope)
    && hasDeployedConfigUnavailableFinding(findings)
    && !hasDeployedConfigEvidence(evidence)
    && hasNewDeployedConfigTerms(beforeScope, afterScope);
}

function enforceMandatoryCodeGate(
  nextStep: InvestigationNextStep,
  scope: InvestigationScope,
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
): InvestigationNextStep {
  if (!requiresCodeInspection(scope)) {
    return nextStep;
  }

  if (hasCodeValidationEvidence(evidence) && !hasCodeUnavailableFinding(findings)) {
    return nextStep;
  }

  return {
    status: "awaiting_review",
    stage: "summary",
    reason: hasCodeUnavailableFinding(findings)
      ? "Code Agent is mandatory for this ticket, but the GitHub-backed code target is unavailable or blocked. Configure the repo target and rerun before final RCA."
      : "Code Agent is mandatory for this ticket, but no code evidence was attached. Rerun with GitHub-backed code inspection before final RCA.",
  };
}

function enforceMandatoryDeployedConfigGate(
  nextStep: InvestigationNextStep,
  scope: InvestigationScope,
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
): InvestigationNextStep {
  if (!requiresDeployedConfigInspection(scope)) {
    return nextStep;
  }

  if (hasDeployedConfigEvidence(evidence) && !hasDeployedConfigUnavailableFinding(findings)) {
    return nextStep;
  }

  return {
    status: "escalated",
    stage: "host_probe",
    reason: hasDeployedConfigUnavailableFinding(findings)
      ? "Deployed jar/properties evidence is mandatory for this ticket, but the LDAP SSH probe is unavailable or found no matching deployed artifact/config. Refresh operator LDAP SSH access and rerun before final RCA."
      : "Deployed jar/properties evidence is mandatory for this ticket, but no LDAP SSH jar/properties evidence was attached. Configure the approved SSH host target and rerun before final RCA.",
  };
}

interface AwsCliCommandRunner {
  runJson<T>(args: string[], options?: { maxBuffer?: number }): Promise<T>;
  runText(args: string[], options?: { maxBuffer?: number }): Promise<string>;
  runBuffer?(args: string[], options?: { maxBuffer?: number }): Promise<Buffer>;
}

class ProfileAwsCliCommandRunner implements AwsCliCommandRunner {
  constructor(private readonly profile?: string) {}

  async runJson<T>(args: string[], options: { maxBuffer?: number } = {}): Promise<T> {
    const stdout = await this.runText([...args, "--output", "json"], options);
    return JSON.parse(stdout) as T;
  }

  async runText(args: string[], options: { maxBuffer?: number } = {}): Promise<string> {
    const baseArgs = this.profile ? ["--profile", this.profile] : [];
    const { stdout } = await execFileAsync("aws", [...baseArgs, ...args], {
      maxBuffer: options.maxBuffer || 1024 * 1024 * 8,
    });
    return stdout;
  }

  async runBuffer(args: string[], options: { maxBuffer?: number } = {}): Promise<Buffer> {
    const baseArgs = this.profile ? ["--profile", this.profile] : [];
    const result = await execFileAsync("aws", [...baseArgs, ...args], {
      encoding: "buffer",
      maxBuffer: options.maxBuffer || 1024 * 1024 * 16,
    } as Parameters<typeof execFile>[2]) as unknown as { stdout: Buffer | string };
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  }
}

interface Ec2Tag {
  Key?: string;
  Value?: string;
}

interface Ec2InstanceSummary {
  InstanceId?: string;
  State?: { Name?: string };
  PublicDnsName?: string;
  PublicIpAddress?: string;
  PrivateDnsName?: string;
  PrivateIpAddress?: string;
  VpcId?: string;
  SubnetId?: string;
  Tags?: Ec2Tag[];
  IamInstanceProfile?: { Arn?: string };
}

interface Ec2ReservationSummary {
  OwnerId?: string;
  Instances?: Ec2InstanceSummary[];
}

interface Ec2DescribeInstancesSummary {
  Reservations?: Ec2ReservationSummary[];
}

interface Ec2DescribeRegionsResponse {
  Regions?: Array<{ RegionName?: string }>;
}

interface DiscoveredEc2Instance {
  region: string;
  accountId: string;
  instance: Ec2InstanceSummary;
  name: string;
}

function parseCsvEnv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function compactDiscoveryToken(value: string | undefined): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function discoveryCaseVariants(value: string): string[] {
  if (!value) {
    return [];
  }
  return Array.from(new Set([
    value.toUpperCase(),
    value.toLowerCase(),
    `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}`,
  ]));
}

function ec2TagValue(instance: Ec2InstanceSummary, key: string): string | undefined {
  return instance.Tags?.find((tag) => tag.Key?.toLowerCase() === key.toLowerCase())?.Value?.trim();
}

function awsDiscoveryProfile(): string | undefined {
  return process.env.INVESTIGATION_AWS_PROFILE?.trim() || process.env.AWS_PROFILE?.trim() || undefined;
}

const DYNAMIC_AWS_REGION = "aws-dynamic";
const DEFAULT_AWS_EC2_DISCOVERY_REGIONS = ["us-east-2", "us-east-1", "us-west-2"];
const MAX_AWS_EC2_DISCOVERY_REGIONS = 24;
const AWS_DISCOVERY_NAME_VALUES_PER_REQUEST = 20;
const AWS_DISCOVERY_NAME_BATCHES_PER_REGION = 4;

function isConcreteAwsRegion(value: string | undefined): value is string {
  const region = value?.trim();
  return Boolean(region && region !== DYNAMIC_AWS_REGION && region !== "auto");
}

async function awsDiscoveryRegions(
  runner: AwsCliCommandRunner,
  configuredRegion?: string,
): Promise<string[]> {
  const explicitDiscoveryRegions = parseCsvEnv(process.env.INVESTIGATION_AWS_DISCOVERY_REGIONS)
    .filter(isConcreteAwsRegion);
  const configuredInvestigationRegions = [
    ...parseCsvEnv(process.env.INVESTIGATION_AWS_REGION),
  ].filter(isConcreteAwsRegion);
  const ambientRegions = [
    ...parseCsvEnv(process.env.AWS_REGION),
    ...parseCsvEnv(process.env.AWS_DEFAULT_REGION),
  ].filter(isConcreteAwsRegion);

  const profileRegion = await runner.runText(["configure", "get", "region"]).catch(() => "");
  const dynamicDiscoveryRegions = (isConcreteAwsRegion(configuredRegion)
    || explicitDiscoveryRegions.length > 0
    || configuredInvestigationRegions.length > 0)
    ? []
    : await runner.runJson<Ec2DescribeRegionsResponse>([
        "ec2",
        "describe-regions",
        "--region",
        "us-east-1",
        "--all-regions",
        "--filters",
        "Name=opt-in-status,Values=opt-in-not-required,opted-in",
        "--output",
        "json",
      ])
        .then((response) => (response.Regions || [])
          .map((region) => region.RegionName)
          .filter(isConcreteAwsRegion))
        .catch(() => []);

  return Array.from(new Set([
    ...(isConcreteAwsRegion(configuredRegion) ? [configuredRegion.trim()] : []),
    ...explicitDiscoveryRegions,
    ...configuredInvestigationRegions,
    ...DEFAULT_AWS_EC2_DISCOVERY_REGIONS,
    ...dynamicDiscoveryRegions,
    ...ambientRegions,
    ...(isConcreteAwsRegion(profileRegion) ? [profileRegion.trim()] : []),
  ])).slice(0, MAX_AWS_EC2_DISCOVERY_REGIONS);
}

function compactEnvTokens(environment: InvestigationEnvironment, envId?: string): string[] {
  const tokens = new Set<string>();
  const environmentToken = compactDiscoveryToken(environment);
  const envIdToken = compactDiscoveryToken(envId);
  if (environment === "PROD_REPLICA") {
    tokens.add("prod");
    if (envIdToken) tokens.add(envIdToken);
    tokens.add("production");
    tokens.add("prodreplica");
    tokens.add("replica");
    tokens.add("slave");
    tokens.add("secondary");
  } else {
    if (envIdToken) tokens.add(envIdToken);
    if (environmentToken) tokens.add(environmentToken);
  }
  const withoutTrailingDigits = envIdToken.replace(/\d+$/, "");
  if (withoutTrailingDigits) {
    tokens.add(withoutTrailingDigits);
  }
  return Array.from(tokens);
}

function awsDiscoveryRoleTokens(environment: InvestigationEnvironment, roleHints: string[] = []): string[] {
  const normalizedHints = roleHints.map(compactDiscoveryToken).filter(Boolean);
  const roleTokens = parseCsvEnv(process.env.INVESTIGATION_AWS_DISCOVERY_ROLE_HINTS)
    .map(compactDiscoveryToken)
    .filter(Boolean);
  const common = ["db", "database", "login", "app", "web", "batch"];
  return Array.from(new Set([
    ...normalizedHints,
    ...roleTokens,
    ...(environment === "PROD_REPLICA" ? ["secondary", "slave"] : []),
    ...common,
  ]));
}

function awsDiscoveryNameValues(
  clientId: string,
  environment: InvestigationEnvironment,
  envId?: string,
  roleHints: string[] = [],
  discoveryAliases: string[] = [],
): string[] {
  const clientTokens = Array.from(new Set([clientId, ...discoveryAliases]
    .map(compactDiscoveryToken)
    .filter((token) => token.length >= 3 && token.length <= 40)));
  const clientVariants = Array.from(new Set(clientTokens
    .flatMap((client) => [client.toUpperCase(), client.toLowerCase()])));
  const envVariants = Array.from(new Set(compactEnvTokens(environment, envId)
    .flatMap((token) => [token.toUpperCase(), token.toLowerCase()])));
  const roles = awsDiscoveryRoleTokens(environment, roleHints);
  const values = new Set<string>();
  // Give every approved client identity a bounded broad probe before adding
  // environment/role combinations, so aliases are not starved by batch caps.
  for (const clientVariant of clientVariants) {
    values.add(`*${clientVariant}*`);
  }
  for (const clientVariant of clientVariants) {
    const roleVariants = roles.flatMap(discoveryCaseVariants);
    for (const envVariant of envVariants.slice(0, 6)) {
      for (const role of roleVariants.slice(0, 24)) {
        values.add(`*${clientVariant}*${envVariant}*${role}*`);
        values.add(`*${clientVariant}*${role}*${envVariant}*`);
      }
      values.add(`*${clientVariant}*${envVariant}*`);
    }
    for (const role of roleVariants.slice(0, 18)) {
      values.add(`*${clientVariant}*${role}*`);
    }
  }
  return Array.from(values);
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function sshReachableHost(instance: Ec2InstanceSummary): string | undefined {
  return instance.PublicDnsName || instance.PublicIpAddress || instance.PrivateDnsName || instance.PrivateIpAddress;
}

function databaseReachableHost(instance: Ec2InstanceSummary): string | undefined {
  return instance.PrivateDnsName || instance.PrivateIpAddress || instance.PublicDnsName || instance.PublicIpAddress;
}

function isGatewayInstance(candidate: DiscoveredEc2Instance): boolean {
  const name = compactDiscoveryToken(candidate.name);
  return name.includes("login") || name.includes("bastion") || name.includes("jump");
}

function isDatabaseInstance(candidate: DiscoveredEc2Instance): boolean {
  const name = compactDiscoveryToken(candidate.name);
  return name.includes("secondary")
    || name.includes("slave")
    || name.includes("replica")
    || name.includes("database")
    || name.includes("db");
}

function ec2InstanceScore(
  candidate: DiscoveredEc2Instance,
  clientId: string,
  environment: InvestigationEnvironment,
  envId?: string,
  roleHints: string[] = [],
  discoveryAliases: string[] = [],
): number {
  const name = compactDiscoveryToken(candidate.name);
  const clientTokens = Array.from(new Set([clientId, ...discoveryAliases]
    .map(compactDiscoveryToken)
    .filter((token) => token.length >= 3 && token.length <= 40)));
  const envTokens = compactEnvTokens(environment, envId);
  const host = sshReachableHost(candidate.instance);
  let score = 0;
  if (clientTokens.some((client) => name.includes(client))) score += 30;
  if (envTokens.some((token) => name.includes(token))) score += 25;
  if (name.includes("login")) score += 30;
  if (name.includes("bastion")) score += 20;
  if (name.includes("app") || name.includes("web")) score += 8;
  if (name.includes("secondary") || name.includes("slave")) score += 35;
  if (name.includes("db") || name.includes("database")) score += 12;
  if (name.includes("batch")) score -= 8;
  if (roleHints.some((role) => name.includes(compactDiscoveryToken(role)))) score += 90;
  if (environment === "PROD_REPLICA" && (name.includes("primary") || name.includes("master"))) score -= 120;
  if (host) score += 15;
  return score;
}

function isDisallowedProdReplicaHost(candidate: DiscoveredEc2Instance, environment: InvestigationEnvironment): boolean {
  if (environment !== "PROD_REPLICA") {
    return false;
  }
  const name = compactDiscoveryToken(candidate.name);
  return name.includes("primary") || name.includes("master");
}

function expectedRoleNameFromArn(arn: string | undefined): string {
  const value = arn?.trim();
  if (!value) return "";
  return value.split("/").filter(Boolean).at(-1) || "";
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charAt(start) === "-") {
    start += 1;
  }
  while (end > start && value.charAt(end - 1) === "-") {
    end -= 1;
  }
  return value.slice(start, end);
}

function lowerDashSlug(value: string, limit: number): string {
  let output = "";
  let previousWasDash = false;
  for (const char of value.toLowerCase()) {
    const code = char.charCodeAt(0);
    const isAlphaNumeric = (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    if (isAlphaNumeric) {
      output += char;
      previousWasDash = false;
    } else if (!previousWasDash) {
      output += "-";
      previousWasDash = true;
    }
    if (output.length >= limit + 2) {
      break;
    }
  }
  return trimDashes(output.slice(0, limit));
}

function inferredTargetId(clientId: string, environment: InvestigationEnvironment, instanceId: string): string {
  return lowerDashSlug(`inferred-${clientId}-${environment}-${instanceId}`, 120);
}

function defaultOperatorSshControlPath(input: {
  clientId: string;
  environment: InvestigationEnvironment;
  host: string;
  user?: string;
  port?: number;
}): string {
  const rawKey = [
    "cockpit-ssh",
    input.clientId,
    input.environment,
    input.user || "operator",
    input.host,
    String(input.port || 22),
  ].join("-");
  const prefix = lowerDashSlug(`cockpit-ssh-${input.clientId}-${input.environment}`, 36);
  const digest = createHash("sha256").update(rawKey).digest("hex").slice(0, 16);
  const controlDir = process.env.INVESTIGATION_SSH_CONTROL_DIR?.trim()
    || process.env.MERIDIAN_SSH_CONTROL_DIR?.trim()
    || "/tmp";
  return join(controlDir, `${prefix}-${digest}.sock`);
}

export class AwsInferredHostTargetRegistry implements InvestigationHostTargetRegistry {
  private readonly cache = new Map<string, Promise<InvestigationHostTarget | null>>();
  private readonly runtimeTargetCache = new Map<string, Promise<InvestigationHostTarget[]>>();

  constructor(
    private readonly baseRegistry: InvestigationHostTargetRegistry,
    private readonly runnerFactory: (profile?: string) => AwsCliCommandRunner = profile => new ProfileAwsCliCommandRunner(profile),
  ) {}

  async resolveTarget(
    clientId: string,
    environment: InvestigationEnvironment,
    hostTargetId?: string,
    envId?: string,
  ): Promise<InvestigationHostTarget | null> {
    const configured = await this.baseRegistry.resolveTarget(clientId, environment, hostTargetId, envId);
    if (!envFlag("INVESTIGATION_AWS_INFER_HOST_TARGETS", false)) {
      return configured;
    }
    if (configured?.scopeKind === "aws_service") {
      return configured;
    }
    if (configured?.sshAllowed && configured.publicHost && !(configured.roleHints?.length)) {
      return configured;
    }

    const cacheKey = `${clientId}\0${environment}\0${envId || ""}`;
    if (!this.cache.has(cacheKey)) {
      this.cache.set(cacheKey, this.discoverTarget(clientId, environment, envId, configured || undefined));
    }
    return (await this.cache.get(cacheKey)) || configured;
  }

  async listTargets(): Promise<InvestigationHostTarget[]> {
    return this.baseRegistry.listTargets();
  }

  async resolveRuntimeTargets(
    clientId: string,
    environment: InvestigationEnvironment,
    envId?: string,
  ): Promise<InvestigationHostTarget[]> {
    const configuredTargets = (await this.baseRegistry.listTargets())
      .filter((target) => target.clientId === clientId && target.environment === environment && target.enabled)
      .filter((target) => isApplicationRuntimeName(target.instanceName))
      .slice(0, runtimeApplicationTargetLimit());
    if (!envFlag("INVESTIGATION_AWS_INFER_HOST_TARGETS", false)) {
      return configuredTargets;
    }

    const cacheKey = `${clientId}\0${environment}\0${envId || ""}`;
    if (!this.runtimeTargetCache.has(cacheKey)) {
      this.runtimeTargetCache.set(cacheKey, this.discoverRuntimeTargets(clientId, environment, envId));
    }
    const discovered = await this.runtimeTargetCache.get(cacheKey) as InvestigationHostTarget[];
    return discovered.length > 0 ? discovered : configuredTargets;
  }

  private async discoverRuntimeTargets(
    clientId: string,
    environment: InvestigationEnvironment,
    envId?: string,
  ): Promise<InvestigationHostTarget[]> {
    const configured = await this.baseRegistry.resolveTarget(clientId, environment, undefined, envId);
    const profile = configured?.awsProfile || awsDiscoveryProfile();
    const runner = this.runnerFactory(profile);
    const regions = await awsDiscoveryRegions(runner, configured?.region);
    const targetEnvId = envId || configured?.envId;
    const candidates: DiscoveredEc2Instance[] = [];
    const nameValues = runtimeApplicationNameValues(clientId, environment, targetEnvId);

    for (const region of regions.slice(0, 6)) {
      const response = await runner.runJson<Ec2DescribeInstancesSummary>([
        "ec2",
        "describe-instances",
        "--region",
        region,
        "--filters",
        "Name=instance-state-name,Values=running",
        `Name=tag:Name,Values=${nameValues.join(",")}`,
      ], { maxBuffer: 1024 * 1024 * 8 }).catch(() => null);
      if (!response) continue;
      for (const reservation of response.Reservations || []) {
        for (const instance of reservation.Instances || []) {
          const name = ec2TagValue(instance, "Name") || instance.InstanceId || "";
          if (instance.InstanceId && isApplicationRuntimeName(name)) {
            candidates.push({ region, accountId: reservation.OwnerId || "", instance, name });
          }
        }
      }
    }

    const sshUser = process.env.INVESTIGATION_SSH_USER?.trim() || process.env.USER?.trim();
    const sshPort = Number(process.env.INVESTIGATION_SSH_PORT || "22");
    const uniqueCandidates = Array.from(new Map(
      candidates.map((candidate) => [candidate.instance.InstanceId || `${candidate.region}:${candidate.name}`, candidate]),
    ).values());
    return uniqueCandidates
      .filter((candidate) => Boolean(sshReachableHost(candidate.instance)))
      .map((candidate, index) => ({
        candidate,
        index,
        score: runtimeApplicationTargetScore(candidate, clientId, environment, targetEnvId),
      }))
      .filter((entry) => entry.score >= 80)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, runtimeApplicationTargetLimit())
      .map(({ candidate }): InvestigationHostTarget => {
        const publicHost = sshReachableHost(candidate.instance) as string;
        return {
          id: inferredTargetId(clientId, environment, candidate.instance.InstanceId as string),
          clientId,
          environment,
          envId: targetEnvId || environment,
          awsAccountId: candidate.accountId,
          region: candidate.region,
          awsProfile: profile,
          instanceId: candidate.instance.InstanceId as string,
          instanceName: candidate.name,
          vpcId: candidate.instance.VpcId || "",
          subnetId: candidate.instance.SubnetId || "",
          networkPath: "ssh_public",
          publicHost,
          sshPort,
          sshUser,
          sshAuthMode: "operator_ldap",
          sshControlPath: defaultOperatorSshControlPath({
            clientId,
            environment,
            host: publicHost,
            user: sshUser,
            port: sshPort,
          }),
          sshControlPathDedicated: true,
          sshAllowed: true,
          logRoots: parseCsvEnv(process.env.INVESTIGATION_SSH_LOG_ROOTS),
          instanceProfileArn: candidate.instance.IamInstanceProfile?.Arn || "",
          expectedRoleName: expectedRoleNameFromArn(candidate.instance.IamInstanceProfile?.Arn),
          ssmAllowed: false,
          enabled: true,
          notes: "Inferred application runtime target for bounded LDAP SSH log collection; separate from the database/login target.",
        };
      });
  }

  private async discoverTarget(
    clientId: string,
    environment: InvestigationEnvironment,
    envId?: string,
    configured?: InvestigationHostTarget,
  ): Promise<InvestigationHostTarget | null> {
    const profile = configured?.awsProfile || awsDiscoveryProfile();
    const runner = this.runnerFactory(profile);
    const regions = await awsDiscoveryRegions(runner, configured?.region);
    if (regions.length === 0) {
      return null;
    }

    const candidates: DiscoveredEc2Instance[] = [];
    const targetEnvId = envId || configured?.envId;
    const aliasAwareNameValueBatches = chunkArray(
      awsDiscoveryNameValues(
        clientId,
        environment,
        targetEnvId,
        configured?.roleHints,
        configured?.discoveryAliases,
      ),
      AWS_DISCOVERY_NAME_VALUES_PER_REQUEST,
    );
    for (const region of regions.slice(0, 6)) {
      for (const nameValues of aliasAwareNameValueBatches.slice(0, AWS_DISCOVERY_NAME_BATCHES_PER_REGION)) {
        const beforeCount = candidates.length;
        const response = await runner.runJson<Ec2DescribeInstancesSummary>([
          "ec2",
          "describe-instances",
          "--region",
          region,
          "--filters",
          "Name=instance-state-name,Values=running",
          `Name=tag:Name,Values=${nameValues.join(",")}`,
        ], { maxBuffer: 1024 * 1024 * 8 }).catch(() => null);
        if (!response) {
          continue;
        }
        for (const reservation of response.Reservations || []) {
          for (const instance of reservation.Instances || []) {
            const name = ec2TagValue(instance, "Name") || instance.InstanceId || "";
            if (instance.InstanceId) {
              candidates.push({
                region,
                accountId: reservation.OwnerId || "",
                instance,
                name,
              });
            }
          }
        }
        if (candidates.length > beforeCount) {
          break;
        }
      }
    }

    const scoredCandidates = candidates
      .filter((candidate) => sshReachableHost(candidate.instance))
      .filter((candidate) => !isDisallowedProdReplicaHost(candidate, environment))
      .map((candidate, index) => ({
        candidate,
        index,
        score: ec2InstanceScore(
          candidate,
          clientId,
          environment,
          targetEnvId,
          configured?.roleHints,
          configured?.discoveryAliases,
        ),
      }))
      .filter((entry) => entry.score >= 55)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const selected = scoredCandidates.find(({ candidate }) => isGatewayInstance(candidate))?.candidate
      || scoredCandidates[0]?.candidate;
    if (!selected?.instance.InstanceId) {
      return null;
    }

    const databaseCandidate = scoredCandidates
      .find(({ candidate }) => isDatabaseInstance(candidate))?.candidate;

    const publicHost = sshReachableHost(selected.instance);
    if (!publicHost) {
      return null;
    }

    const sshUser = process.env.INVESTIGATION_SSH_USER?.trim() || process.env.USER?.trim();
    const sshPort = Number(process.env.INVESTIGATION_SSH_PORT || "22");
    return {
      id: inferredTargetId(clientId, environment, selected.instance.InstanceId),
      clientId,
      environment,
      envId: targetEnvId || environment,
      awsAccountId: selected.accountId,
      region: selected.region,
      awsProfile: profile,
      instanceId: selected.instance.InstanceId,
      instanceName: selected.name,
      vpcId: selected.instance.VpcId || "",
      subnetId: selected.instance.SubnetId || "",
      networkPath: "ssh_public",
      publicHost,
      databaseHost: databaseCandidate ? databaseReachableHost(databaseCandidate.instance) : undefined,
      databasePort: 3306,
      sshPort,
      sshUser,
      sshAuthMode: "operator_ldap",
      sshControlPath: process.env.INVESTIGATION_SSH_CONTROL_PATH?.trim() || defaultOperatorSshControlPath({
        clientId,
        environment,
        host: publicHost,
        user: sshUser,
        port: sshPort,
      }),
      sshAllowed: true,
      configProbePaths: parseCsvEnv(process.env.INVESTIGATION_SSH_CONFIG_PROBE_ROOTS),
      instanceProfileArn: selected.instance.IamInstanceProfile?.Arn || "",
      expectedRoleName: expectedRoleNameFromArn(selected.instance.IamInstanceProfile?.Arn),
      ssmAllowed: false,
      enabled: true,
      notes: "Inferred at runtime from Jira client/environment scope and AWS EC2 Name tag discovery; SSM is intentionally disabled for operator LDAP SSH runs.",
    };
  }
}

function runtimeApplicationTargetLimit(): number {
  const configured = Number(process.env.INVESTIGATION_RUNTIME_APP_HOST_MAX || "4");
  return Number.isFinite(configured) ? Math.max(1, Math.min(8, Math.floor(configured))) : 4;
}

function isApplicationRuntimeName(value: string): boolean {
  const name = compactDiscoveryToken(value);
  return (name.includes("app") || name.includes("web"))
    && !name.includes("db")
    && !name.includes("database")
    && !name.includes("login")
    && !name.includes("bastion")
    && !name.includes("batch")
    && !name.includes("portal");
}

function runtimeApplicationNameValues(
  clientId: string,
  environment: InvestigationEnvironment,
  envId?: string,
): string[] {
  const clients = discoveryCaseVariants(compactDiscoveryToken(clientId));
  const environments = compactEnvTokens(environment, envId).flatMap(discoveryCaseVariants);
  const roles = ["APP", "App", "app", "WEB", "Web", "web"];
  const values = new Set<string>();
  for (const client of clients) {
    for (const environmentToken of environments.slice(0, 9)) {
      for (const role of roles) {
        values.add(`*${client}*${environmentToken}*${role}*`);
        values.add(`*${client}*${role}*${environmentToken}*`);
      }
    }
  }
  return Array.from(values).slice(0, AWS_DISCOVERY_NAME_VALUES_PER_REQUEST);
}

function runtimeApplicationTargetScore(
  candidate: DiscoveredEc2Instance,
  clientId: string,
  environment: InvestigationEnvironment,
  envId?: string,
): number {
  const name = compactDiscoveryToken(candidate.name);
  let score = 0;
  if (name.includes(compactDiscoveryToken(clientId))) score += 35;
  if (compactEnvTokens(environment, envId).some((token) => name.includes(token))) score += 30;
  if (name.includes("app")) score += 35;
  if (name.includes("web")) score += 25;
  if (sshReachableHost(candidate.instance)) score += 15;
  return score;
}

interface SshCommandRunner {
  runText(target: InvestigationHostTarget, command: string, options?: { maxBuffer?: number; timeoutMs?: number }): Promise<string>;
}

export function buildSshCommandArgs(
  target: InvestigationHostTarget,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const host = target.publicHost?.trim();
  if (!host) {
    throw new Error(`Host target ${target.id} does not define a publicHost for SSH inspection.`);
  }

  const envSshUser = env.INVESTIGATION_SSH_USER?.trim();
  const targetSshUser = target.sshUser?.trim();
  const envControlPath = env.INVESTIGATION_SSH_CONTROL_PATH?.trim();
  const targetControlPath = target.sshControlPath?.trim();
  const usesOperatorLdap = target.sshAuthMode === "operator_ldap";
  const sshUser = usesOperatorLdap
    ? envSshUser || targetSshUser
    : targetSshUser || envSshUser;
  const controlPath = usesOperatorLdap
    ? target.sshControlPathDedicated
      ? targetControlPath || envControlPath
      : envControlPath || targetControlPath
    : targetControlPath || envControlPath;
  const destination = sshUser ? `${sshUser}@${host}` : host;
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=10",
    "-o", "ServerAliveCountMax=1",
    "-o", "StrictHostKeyChecking=accept-new",
  ];
  if (controlPath) {
    args.push(
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${controlPath}`,
      "-o", "ControlPersist=5m",
    );
  }
  if (target.sshPort && target.sshPort > 0) {
    args.push("-p", String(target.sshPort));
  }
  args.push(destination, `sh -lc ${shellQuote(command)}`);
  return args;
}

class CliSshCommandRunner implements SshCommandRunner {
  async runText(target: InvestigationHostTarget, command: string, options: { maxBuffer?: number; timeoutMs?: number } = {}): Promise<string> {
    const args = buildSshCommandArgs(target, command);

    const { stdout } = await execFileAsync("ssh", args, {
      maxBuffer: options.maxBuffer || 1024 * 1024 * 4,
      timeout: options.timeoutMs || Number(process.env.INVESTIGATION_SSH_CONFIG_TIMEOUT_MS || "45000"),
      killSignal: "SIGTERM",
    });
    return stdout;
  }
}

interface CloudWatchDescribeLogGroupsResponse {
  logGroups?: Array<{ logGroupName?: string }>;
}

interface CloudWatchFilterLogEventsResponse {
  events?: Array<{
    timestamp?: number;
    logGroupName?: string;
    logStreamName?: string;
    message?: string;
  }>;
}

interface SelectedCloudWatchLogGroup {
  name: string;
  region: string;
  scopeId?: string;
}

interface SsmSendCommandResponse {
  Command?: { CommandId?: string };
}

interface SsmGetCommandInvocationResponse {
  Status?: string;
  StandardOutputContent?: string;
  StandardErrorContent?: string;
}

interface S3ListObjectsV2Response {
  Contents?: Array<{
    Key?: string;
    Size?: number;
    LastModified?: string;
  }>;
}

interface RuntimeLogSample {
  source: "cloudwatch" | "ssm_file" | "s3_archive";
  timestamp?: string;
  location: string;
  stream?: string;
  message: string;
}

interface HostConfigSample {
  location: string;
  message: string;
}

function defaultRuntimeLogTimeWindow(): NonNullable<InvestigationScope["timeWindow"]> {
  const hours = Number(process.env.INVESTIGATION_RUNTIME_LOG_DEFAULT_HOURS || "24");
  const boundedHours = Number.isFinite(hours) ? Math.max(1, Math.min(168, Math.floor(hours))) : 24;
  const end = new Date();
  const start = new Date(end.getTime() - boundedHours * 60 * 60 * 1000);
  return {
    startTs: start.toISOString(),
    endTs: end.toISOString(),
  };
}

function runtimeTimeWindow(scope: InvestigationScope): NonNullable<InvestigationScope["timeWindow"]> {
  return scope.timeWindow || defaultRuntimeLogTimeWindow();
}

function timeWindowStartMs(scope: InvestigationScope): number {
  return new Date(runtimeTimeWindow(scope).startTs).getTime();
}

function timeWindowEndMs(scope: InvestigationScope): number {
  return new Date(runtimeTimeWindow(scope).endTs).getTime();
}

function timeWindowDateToken(scope: InvestigationScope): string {
  return new Date(runtimeTimeWindow(scope).startTs).toISOString().slice(0, 10);
}

const RUNTIME_COMPONENT_WORDS = [
  "service",
  "processor",
  "handler",
  "watcher",
  "batch",
  "job",
  "scheduler",
  "api",
  "config",
  "properties",
  "extract",
  "extractor",
  "export",
  "exporter",
  "import",
  "importer",
  "report",
  "reporting",
  "loader",
  "load",
  "utility",
  "generator",
  "feed",
  "process",
  "program",
  "runner",
  "intake",
];
const RUNTIME_COMPONENT_SIGNAL_PATTERN = new RegExp(`(?:${RUNTIME_COMPONENT_WORDS.join("|")})`, "i");
const RUNTIME_COMPONENT_WORD_PATTERN = new RegExp(`^(?:${RUNTIME_COMPONENT_WORDS.join("|")})s?$`, "i");

function surfaceSignalTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/g)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .filter((token) => token.length >= 2 && token.length <= 36)
    .filter((token) => !/^\d+$/.test(token));
}

function ignoredSurfaceTokens(scope: InvestigationScope): Set<string> {
  return new Set([
    "cp",
    "prod",
    "prod1",
    "uat",
    "dev",
    "int",
    "stage",
    "replica",
    "client",
    "backend",
    "frontend",
    "app",
    "application",
    ...surfaceSignalTokens(scope.clientId),
    ...surfaceSignalTokens(scope.environment),
  ]);
}

function isScopeNoiseTerm(value: string, scope: InvestigationScope): boolean {
  const compact = compactNoiseTerm(value);
  if (isGenericInvestigationNoiseTerm(value)) {
    return true;
  }
  return ignoredSurfaceTokens(scope).has(compact);
}

function scopedSurfaceIntentTokens(scope: InvestigationScope): Set<string> {
  const ignored = ignoredSurfaceTokens(scope);
  return new Set(runtimeComponentTerms(scope)
    .flatMap(surfaceSignalTokens)
    .filter((token) => !ignored.has(token))
    .filter((token) => !/^(error|errors|failed|failure|exception|exceptions|http|https|status|queue|queues|file|files|data|fix)$/i.test(token)));
}

function surfaceTokenOverlapScore(name: string, scope: InvestigationScope): number {
  const groupTokens = new Set(surfaceSignalTokens(name).filter((token) => !ignoredSurfaceTokens(scope).has(token)));
  const intentTokens = scopedSurfaceIntentTokens(scope);
  const matchedSpecific = [...intentTokens].filter((token) =>
    groupTokens.has(token) && !RUNTIME_COMPONENT_WORD_PATTERN.test(token));
  const matchedComponent = [...intentTokens].filter((token) =>
    groupTokens.has(token) && RUNTIME_COMPONENT_WORD_PATTERN.test(token));

  let score = matchedSpecific.length * 55 + matchedComponent.length * 18;
  if (matchedSpecific.length > 0 && matchedComponent.length > 0) {
    score += 35;
  }
  return score;
}

function runtimeSearchTerms(scope: InvestigationScope): string[] {
  const rawTerms = [
    ...(scope.keywords || []),
    ...(scope.serviceIds || []),
  ];
  const terms = Array.from(new Set(rawTerms
    .map((term) => term.trim())
    .filter(Boolean)
    .filter((term) => !isJiraIssueKeyLike(term))
    .filter((term) => !/^\d+(?:\.\d+){1,2}$/.test(term))
    .filter((term) => !isScopeNoiseTerm(term, scope))
    .filter((term) => term.length >= 4 && term.length <= 80)
  ));

  const priorityPatterns = [
    RUNTIME_COMPONENT_SIGNAL_PATTERN,
    /queue/i,
    /archive|move|download|image|document/i,
    /http|status|500|501|unexpected|error|failed|failure|exception/i,
  ];

  const prioritized = terms
    .map((term, index) => ({
      term,
      index,
      score: priorityPatterns.reduce((score, pattern, priorityIndex) =>
        score + (pattern.test(term) ? 100 - priorityIndex : 0), 0),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.term);

  return prioritized.length > 0 ? prioritized.slice(0, 12) : ["error", "exception", "failed", "failure", "timeout", "HTTP"];
}

function runtimeComponentTerms(scope: InvestigationScope): string[] {
  return Array.from(new Set([
    ...(scope.serviceIds || []),
    ...(scope.keywords || []).filter((term) => RUNTIME_COMPONENT_SIGNAL_PATTERN.test(term)),
  ]
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && term.length <= 80)
  )).slice(0, 10);
}

function hasRuntimeApiSignal(scope: InvestigationScope): boolean {
  const text = [
    ...(scope.serviceIds || []),
    ...(scope.keywords || []),
  ].join(" ").toLowerCase();
  return /\b(api|rest|http|https|webservice|ws|endpoint|image|download|archive|move|token|session|queue|backlog)\b/.test(text);
}

function cloudWatchCandidatePrefixes(basePrefix: string, scope: InvestigationScope): string[] {
  const serviceNames = Array.from(new Set([
    ...(scope.serviceIds || []),
    ...runtimeComponentTerms(scope),
  ]
    .map((term) => term.trim())
    .flatMap((term) => configProbeTermCandidates(term))
    .filter((term) => /^[A-Za-z0-9_.-]{3,80}$/.test(term))))
    .sort((left, right) => configProbeSurfaceCandidateScore(right) - configProbeSurfaceCandidateScore(left) || left.localeCompare(right));
  const candidates = new Set<string>();

  for (const serviceName of serviceNames) {
    candidates.add(`${basePrefix}/batch/${serviceName}`);
    candidates.add(`${basePrefix}/${serviceName}`);
    candidates.add(`${basePrefix}/ws/${serviceName}`);
    candidates.add(`${basePrefix}/core/${serviceName}`);
  }

  if (hasRuntimeApiSignal(scope)) {
    candidates.add(`${basePrefix}/ws`);
    candidates.add(`${basePrefix}/ws/catalina`);
  }

  return [...candidates].slice(0, 12);
}

function cloudWatchGroupScore(name: string, scope: InvestigationScope): number {
  const lower = name.toLowerCase();
  const componentTerms = runtimeComponentTerms(scope).map((term) => term.toLowerCase());
  const apiSignal = hasRuntimeApiSignal(scope);
  let score = 0;

  for (const term of componentTerms) {
    if (lower.includes(term)) {
      score += 120;
    }
    if (lower.includes(`/batch/${term}`) || lower.endsWith(`/${term}`)) {
      score += 120;
    }
  }

  if (apiSignal && /\/ws(?:\/|$)/.test(lower)) score += 90;
  if (apiSignal && /\/ws\/catalina$/.test(lower)) score += 85;
  if (apiSignal && /\/batch\//.test(lower)) score += 30;
  if (/\b(queue|backlog)\b/i.test([...(scope.keywords || []), ...(scope.serviceIds || [])].join(" ")) && lower.includes("queue")) score += 35;
  if (lower.includes("workflow")) score += 8;
  score += surfaceTokenOverlapScore(name, scope);

  return score;
}

function renderCloudWatchScopeTemplate(template: string, target: InvestigationHostTarget, scope: InvestigationScope): string {
  return template
    .replace(/\{clientId\}/g, scope.clientId)
    .replace(/\{envId\}/g, target.envId)
    .replace(/\{environment\}/g, scope.environment)
    .replace(/\{targetId\}/g, target.id)
    .replace(/\{instanceName\}/g, target.instanceName);
}

function configuredScopeTerms(scope: InvestigationScope): string[] {
  return [
    ...(scope.serviceIds || []),
    ...(scope.keywords || []),
    ...runtimeComponentTerms(scope),
  ].map((term) => term.trim().toLowerCase()).filter(Boolean);
}

function cloudWatchScopeMatches(logScope: InvestigationCloudWatchLogScope, scope: InvestigationScope): boolean {
  const terms = configuredScopeTerms(scope);
  const scopedServiceIds = (scope.serviceIds || []).map((term) => term.toLowerCase());
  const selectors = [
    ...(logScope.serviceIds || []).map((term) => ({ kind: "service", term: term.toLowerCase() })),
    ...(logScope.keywords || []).map((term) => ({ kind: "keyword", term: term.toLowerCase() })),
  ];

  if (selectors.length > 0) {
    return selectors.some((selector) =>
      selector.kind === "service"
        ? scopedServiceIds.includes(selector.term) || terms.some((term) => term.includes(selector.term))
        : terms.some((term) => term.includes(selector.term) || selector.term.includes(term)),
    );
  }

  if (logScope.default) {
    return true;
  }

  if (logScope.kind === "ws" || logScope.kind === "catalina") {
    return hasRuntimeApiSignal(scope);
  }

  if (logScope.kind === "batch") {
    const text = terms.join(" ");
    return runtimeComponentTerms(scope).length > 0 || /\b(batch|job|queue|workflow|watcher|scheduler|extract|extractor|export|import|report|feed|program|process)\b/.test(text);
  }

  if (logScope.kind === "core") {
    const text = terms.join(" ");
    return hasRuntimeApiSignal(scope) || scopedServiceIds.includes("core-app") || /\b(core|core-app|application|app)\b/.test(text);
  }

  if (logScope.kind === "cas") {
    const text = terms.join(" ");
    return /\b(cas|sso|login|authentication|auth)\b/.test(text);
  }

  if (logScope.kind === "portal") {
    const text = terms.join(" ");
    return /\b(peer|portal)\b/.test(text);
  }

  if (logScope.kind === "spagobi") {
    return /\bspago(?:bi)?\b/.test(terms.join(" "));
  }

  if (logScope.kind === "knowage") {
    return /\bknowage\b/.test(terms.join(" "));
  }

  if (logScope.kind === "service") {
    return runtimeComponentTerms(scope).length > 0;
  }

  return false;
}

function cloudWatchGroupKey(group: SelectedCloudWatchLogGroup): string {
  return `${group.region}\n${group.name}`;
}

function selectCloudWatchLogGroupEntries(groupEntries: SelectedCloudWatchLogGroup[], scope: InvestigationScope, maxGroups: number): SelectedCloudWatchLogGroup[] {
  const uniqueGroups = new Map<string, SelectedCloudWatchLogGroup>();
  for (const group of groupEntries) {
    if (group.name.trim() && group.region.trim()) {
      uniqueGroups.set(cloudWatchGroupKey(group), group);
    }
  }

  return Array.from(uniqueGroups.values())
    .map((group, index) => ({ group, index, score: cloudWatchGroupScore(group.name, scope) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxGroups)
    .map((entry) => entry.group);
}

function selectCloudWatchLogGroups(groupNames: string[], scope: InvestigationScope, maxGroups: number, region: string): SelectedCloudWatchLogGroup[] {
  return selectCloudWatchLogGroupEntries(groupNames.map((name) => ({ name, region })), scope, maxGroups);
}

function formatSelectedLogGroup(group: SelectedCloudWatchLogGroup): string {
  return `${group.name}@${group.region}`;
}

function summarizeLogGroups(groups: SelectedCloudWatchLogGroup[]): string {
  if (groups.length === 0) {
    return "none";
  }
  const visible = groups.slice(0, 8).map(formatSelectedLogGroup);
  const suffix = groups.length > visible.length ? `, +${groups.length - visible.length} more` : "";
  return `${visible.join(", ")}${suffix}`;
}

async function resolveConfiguredCloudWatchLogGroups(input: {
  target: InvestigationHostTarget;
  scope: InvestigationScope;
  runner: AwsCliCommandRunner;
  maxGroups: number;
}): Promise<{ configured: boolean; groups: SelectedCloudWatchLogGroup[]; describeRequests: number; scopeIds: string[] }> {
  const configuredScopes = input.target.cloudWatchLogScopes || [];
  if (configuredScopes.length === 0) {
    return { configured: false, groups: [], describeRequests: 0, scopeIds: [] };
  }

  const matchingScopes = configuredScopes.filter((logScope) => cloudWatchScopeMatches(logScope, input.scope));
  const groupEntries: SelectedCloudWatchLogGroup[] = [];
  let describeRequests = 0;

  for (const logScope of matchingScopes) {
    const region = logScope.region || input.target.region;
    if (logScope.nameTemplate) {
      groupEntries.push({
        name: renderCloudWatchScopeTemplate(logScope.nameTemplate, input.target, input.scope),
        region,
        scopeId: logScope.id,
      });
    }
    if (logScope.prefixTemplate) {
      const prefix = renderCloudWatchScopeTemplate(logScope.prefixTemplate, input.target, input.scope);
      describeRequests += 1;
      const response = await input.runner.runJson<CloudWatchDescribeLogGroupsResponse>([
        "logs",
        "describe-log-groups",
        "--region",
        region,
        "--log-group-name-prefix",
        prefix,
        "--limit",
        String(Math.min(50, Math.max(10, logScope.maxGroups || input.maxGroups))),
      ]);
      const scopeGroups = (response.logGroups || [])
        .map((group): SelectedCloudWatchLogGroup | null => group.logGroupName
          ? { name: group.logGroupName, region, scopeId: logScope.id }
          : null)
        .filter((entry): entry is SelectedCloudWatchLogGroup => Boolean(entry));
      groupEntries.push(...selectCloudWatchLogGroupEntries(scopeGroups, input.scope, logScope.maxGroups || input.maxGroups));
    }
  }

  return {
    configured: true,
    groups: selectCloudWatchLogGroupEntries(groupEntries, input.scope, input.maxGroups),
    describeRequests,
    scopeIds: matchingScopes.map((scope) => scope.id),
  };
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runtimeGrepPattern(scope: InvestigationScope): string {
  return runtimeSearchTerms(scope)
    .map(regexEscape)
    .join("|") || "error|exception|failed|failure|timeout|HTTP";
}

function configProbeTerms(scope: InvestigationScope): string[] {
  const rawTerms = [
    ...(scope.diagnosticContext?.codeEvidenceTerms || []),
    scope.codeVersion,
    ...(scope.serviceIds || []),
    ...(scope.keywords || []),
    ...runtimeComponentTerms(scope),
  ];

  return Array.from(new Map(rawTerms
    .map((term) => term?.trim() || "")
    .filter(Boolean)
    .filter((term) => !isJiraIssueKeyLike(term))
    .filter((term) => !isScopeNoiseTerm(term, scope))
    .filter((term) => !isRepositoryConfigFileSignal(term))
    .filter((term) => term.length >= 3 && term.length <= 100)
    .map((term, index) => [term.toLowerCase(), { term, index }] as const)
  ).values())
    .map(({ term, index }) => ({
      term,
      index,
      score:
        (/[\\/]/.test(term) ? 240 : 0)
        + (/\.(?:jar|properties|ya?ml|xml|conf|cfg|sh|ksh|bash)$/i.test(term) ? 220 : 0)
        + ((RUNTIME_COMPONENT_SIGNAL_PATTERN.test(term) || /jar/i.test(term)) ? 90 : 0)
        + (/[._-]/.test(term) ? 50 : 0)
        - (/^(core-app|batch-jobs|jobs|queues?|move)$/i.test(term) ? 140 : 0),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.term)
    .slice(0, 20);
}

function configProbeRawTerms(scope: InvestigationScope): string[] {
  return Array.from(new Set([
    ...(scope.diagnosticContext?.codeEvidenceTerms || []),
    ...(scope.serviceIds || []),
    ...(scope.keywords || []),
  ]
    .flatMap((term) => configProbeTermCandidates(term))
    .filter(Boolean)
    .filter((term) => !isJiraIssueKeyLike(term))
    .filter((term) => !isScopeNoiseTerm(term, scope))
    .filter((term) => term.length >= 3 && term.length <= 180)));
}

function configProbePreferredRawTerms(scope: InvestigationScope): string[] {
  return Array.from(new Set((scope.serviceIds || [])
    .flatMap((term) => configProbeTermCandidates(term))
    .filter(Boolean)
    .filter((term) => !isJiraIssueKeyLike(term))
    .filter((term) => !isScopeNoiseTerm(term, scope))
    .filter((term) => term.length >= 3 && term.length <= 180)))
    .sort((left, right) => configProbeSurfaceCandidateScore(right) - configProbeSurfaceCandidateScore(left) || left.localeCompare(right));
}

function configProbeSurfaceTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => token.length >= 2 && token.length <= 36)
    .filter((token) => !/^\d+$/.test(token));
}

function configProbePascalToken(token: string): string {
  if (/^[A-Z0-9]{2,}$/.test(token)) {
    return token.toUpperCase();
  }
  const lower = token.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function addConfigProbeSurfaceVariants(candidates: Set<string>, value: string) {
  const tokens = configProbeSurfaceTokens(value);
  if (
    tokens.length < 2
    || tokens.length > 5
    || !tokens.some((token) => RUNTIME_COMPONENT_WORD_PATTERN.test(token))
    || !tokens.some((token) => !RUNTIME_COMPONENT_WORD_PATTERN.test(token))
  ) {
    return;
  }

  const pascalTokens = tokens.map(configProbePascalToken);
  const lowerTokens = tokens.map((token) => token.toLowerCase());
  candidates.add(tokens.join("_"));
  candidates.add(tokens.join("-"));
  candidates.add(pascalTokens.join(""));
  candidates.add(pascalTokens.join("_"));
  candidates.add(lowerTokens.join("-"));
  candidates.add(lowerTokens.join("_"));
  if (pascalTokens.length >= 3) {
    const suffix = pascalTokens[pascalTokens.length - 1];
    const prefix = pascalTokens.slice(0, -1).join("");
    candidates.add(`${prefix}_${suffix}`);
    candidates.add(`${prefix}-${suffix}`);
  }

  if (tokens.length >= 3 && /^[A-Z0-9]{2,}$/.test(tokens[0]) && !/^[A-Z0-9]{2,}$/.test(tokens[1])) {
    const reordered = [tokens[1], tokens[0], ...tokens.slice(2)];
    const reorderedPascal = reordered.map(configProbePascalToken);
    const reorderedLower = reordered.map((token) => token.toLowerCase());
    candidates.add(`${configProbePascalToken(tokens[1])}${tokens[0].toUpperCase()}_${tokens.slice(2).map(configProbePascalToken).join("_")}`);
    candidates.add(reorderedPascal.join(""));
    candidates.add(reorderedPascal.join("_"));
    candidates.add(reorderedLower.join("-"));
    candidates.add(reorderedLower.join("_"));
    const reorderedSuffix = reorderedPascal[reorderedPascal.length - 1];
    const reorderedPrefix = reorderedPascal.slice(0, -1).join("");
    candidates.add(`${reorderedPrefix}_${reorderedSuffix}`);
    candidates.add(`${reorderedPrefix}-${reorderedSuffix}`);
  }
}

function configProbeSurfaceCandidateScore(value: string): number {
  const tokens = configProbeSurfaceTokens(value);
  const lowerTokens = tokens.map((token) => token.toLowerCase());
  let score = 0;

  if (tokens.some((token) => RUNTIME_COMPONENT_WORD_PATTERN.test(token))
    && tokens.some((token) => !RUNTIME_COMPONENT_WORD_PATTERN.test(token))) {
    score += 120;
  }
  if (!/\s/.test(value)) {
    score += 90;
  }
  if (/[._-]/.test(value)) {
    score += 55;
  }
  if (tokens.some((token) => /^[A-Z0-9]{2,}$/.test(token))) {
    score += 25;
  }
  if (/^[A-Z0-9]{2,}[._-][A-Z][A-Za-z0-9]+/.test(value)) {
    score -= 25;
  }

  const actionWords = new Set(["add", "change", "correct", "correction", "create", "delete", "enhance", "fix", "remove", "update"]);
  if (actionWords.has(lowerTokens[0] || "")) {
    score -= 180;
  }
  score -= lowerTokens.filter((token) => actionWords.has(token)).length * 35;
  score -= Math.max(0, tokens.length - 3) * 35;
  score -= Math.max(0, value.length - 48);

  return score;
}

function configProbeTermCandidates(value: string | undefined): string[] {
  const term = value?.trim() || "";
  if (!term) {
    return [];
  }
  const candidates = new Set<string>([term]);
  const labeled = term.match(/^[A-Za-z0-9_.-]+\s*[:=]\s*["']?([^"'\s][^"']{2,180})["']?$/);
  if (labeled?.[1]) {
    candidates.add(labeled[1].trim());
  }
  const assignment = term.match(/\b[A-Za-z0-9_.-]+\.(?:properties|conf|cfg|ya?ml|xml)\s*=\s*([A-Za-z0-9_.\/-]+\.(?:properties|conf|cfg|ya?ml|xml))\b/i);
  if (assignment?.[1]) {
    candidates.add(assignment[1].trim());
  }
  for (const candidate of [...candidates]) {
    if (candidate.includes("_")) {
      candidates.add(candidate.replace(/_/g, "-"));
    }
    if (candidate.includes("-")) {
      candidates.add(candidate.replace(/-/g, "_"));
    }
    addConfigProbeSurfaceVariants(candidates, candidate);
  }
  return [...candidates].map(cleanConfigProbeCandidate).filter(Boolean);
}

function cleanConfigProbeCandidate(value: string): string {
  return value
    .trim()
    .replace(/^[`"',;:()[\]{}<>]+|[`"',;:()[\]{}<>.]+$/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function isSimpleConfigProbeToken(value: string): boolean {
  return /^[A-Za-z0-9_.\/-]+$/.test(value);
}

function configProbeExactFileNames(scope: InvestigationScope): string[] {
  return Array.from(new Set(configProbeRawTerms(scope)
    .filter((term) => /\.(?:jar|properties|conf|cfg|sh|ksh|bash)$/i.test(term))
    .map((term) => pathBasename(term))
    .filter((term) => term.length >= 4 && term.length <= 120)
    .filter(isSimpleConfigProbeToken)
    .filter((term) => !isGenericPathSignal(stripKnownArtifactExtension(term)))))
    .sort((left, right) => configProbeExactFileNameScore(right) - configProbeExactFileNameScore(left) || left.localeCompare(right))
    .slice(0, 24);
}

function configProbeExactFileNameScore(value: string): number {
  const base = stripKnownArtifactExtension(value);
  return value.length
    + (/\.(?:jar|properties)$/i.test(value) ? 260 : 0)
    + (/main/i.test(base) ? 180 : 0)
    + ((RUNTIME_COMPONENT_SIGNAL_PATTERN.test(base) || /runner/i.test(base)) ? 110 : 0)
    + (/[._-]/.test(base) ? 80 : 0)
    - (/\.(?:xml|ya?ml)$/i.test(value) ? 80 : 0)
    - (isGenericPathSignal(base) ? 500 : 0);
}

interface ConfigProbeDirectoryCandidate {
  path: string;
  preferred: boolean;
}

function configProbeExactDirectories(scope: InvestigationScope): string[] {
  const directoryCandidates = new Map<string, ConfigProbeDirectoryCandidate>();
  const preferredTerms = configProbePreferredRawTerms(scope);
  const preferredTermKeys = new Set(preferredTerms.map((term) => term.toLowerCase()));

  const addDirectory = (entry: string, preferred: boolean) => {
    const trimmed = entry.trim();
    if (!trimmed.startsWith("/") || trimmed.length < 4 || trimmed.length > 180) {
      return;
    }
    const existing = directoryCandidates.get(trimmed);
    directoryCandidates.set(trimmed, {
      path: trimmed,
      preferred: Boolean(existing?.preferred || preferred),
    });
  };

  const addTermDirectories = (term: string, preferred: boolean) => {
    if (term.startsWith("/")) {
      if (!isSimpleConfigProbeToken(term)) {
        return;
      }
      const normalized = term.replace(/\/+$/g, "");
      if (/\.(?:jar|properties|xml|ya?ml|conf|cfg|sh|ksh|bash)$/i.test(normalized)) {
        if (!isGenericPathSignal(stripKnownArtifactExtension(pathBasename(normalized)))) {
          addDirectory(path.posix.dirname(normalized), preferred);
        }
      } else {
        addDirectory(path.posix.dirname(normalized), preferred);
        if (RUNTIME_COMPONENT_SIGNAL_PATTERN.test(normalized) || /runner/i.test(normalized)) {
          addDirectory(normalized, preferred);
        }
      }
    }
    const basename = stripKnownArtifactExtension(pathBasename(term));
    if (
      !/\.(?:jar|properties|xml|ya?ml|conf|cfg|sh|ksh|bash)$/i.test(term)
      && isSimpleConfigProbeToken(term)
      && /[._-]/.test(basename)
      && !basename.includes(".")
      && !/(?:snapshot|\d+[_-]\d+)/i.test(basename)
      && (RUNTIME_COMPONENT_SIGNAL_PATTERN.test(basename) || /runner/i.test(basename))
      && !isRepositoryConfigNameSignal(basename)
      && !isGenericPathSignal(basename)
    ) {
      for (const root of ["/opt/software/medhok", "/medhok"]) {
        addDirectory(`${root}/${basename}`, preferred);
      }
    }
  };

  for (const term of preferredTerms) {
    addTermDirectories(term, true);
  }
  for (const term of configProbeRawTerms(scope)) {
    addTermDirectories(term, preferredTermKeys.has(term.toLowerCase()));
  }

  return Array.from(directoryCandidates.values())
    .sort((left, right) =>
      configProbeExactDirectoryCandidateScore(right) - configProbeExactDirectoryCandidateScore(left)
      || left.path.localeCompare(right.path),
    )
    .map((entry) => entry.path)
    .slice(0, 24);
}

function isRepositoryConfigNameSignal(value: string): boolean {
  const normalized = value.toLowerCase();
  return /(?:^|[_-])(?:jar[_-]?runner|sql[_-]?runner|file[_-]?copier|prod|lower|uat|dev|stage|config\d*|cp(?:prod|lower|uat|dev|stage|qa|int)?)(?:[_-]|$)/.test(normalized);
}

function isRepositoryConfigFileSignal(value: string): boolean {
  const basename = pathBasename(value);
  return /\.(?:ya?ml|xml)$/i.test(basename)
    && isRepositoryConfigNameSignal(stripKnownArtifactExtension(basename));
}

function configProbeExactPaths(scope: InvestigationScope): string[] {
  return Array.from(new Set(configProbeRawTerms(scope)
    .filter((term) => term.startsWith("/") && /\.(?:jar|properties|xml|ya?ml|conf|cfg|sh|ksh|bash)$/i.test(term))
    .filter(isSimpleConfigProbeToken)
    .filter((term) => !isGenericPathSignal(stripKnownArtifactExtension(pathBasename(term))))
    .filter((term) => term.length >= 4 && term.length <= 220)))
    .sort((left, right) => configProbeExactPathScore(right) - configProbeExactPathScore(left) || left.localeCompare(right))
    .slice(0, 24);
}

function configProbeExactDirectoryScore(value: string): number {
  const base = pathBasename(value);
  return value.length
    + (value.startsWith("/opt/software/medhok/") ? 240 : 0)
    + ((RUNTIME_COMPONENT_SIGNAL_PATTERN.test(base) || /runner/i.test(base)) ? 220 : 0)
    + (/[._-]/.test(base) ? 80 : 0)
    - (/\/(?:config|logs?|tmp|backup|archive|old)$/i.test(value) ? 280 : 0)
    - (isGenericPathSignal(base) ? 500 : 0);
}

function configProbeExactDirectoryCandidateScore(candidate: ConfigProbeDirectoryCandidate): number {
  return configProbeExactDirectoryScore(candidate.path)
    + (candidate.preferred ? 1_000 : 0);
}

function configProbeExactPathScore(value: string): number {
  const base = pathBasename(value);
  return value.length
    + (value.startsWith("/opt/software/medhok/") ? 240 : 0)
    + (/\.(?:jar|properties)$/i.test(base) ? 260 : 0)
    + (/main/i.test(base) ? 180 : 0)
    + (RUNTIME_COMPONENT_SIGNAL_PATTERN.test(value) ? 140 : 0)
    + (/[._-]/.test(base) ? 80 : 0)
    - (isGenericPathSignal(stripKnownArtifactExtension(base)) ? 500 : 0);
}

function configProbeCandidateMetadata(scope: InvestigationScope) {
  return {
    searchTerms: configProbeTerms(scope),
    exactFileNames: configProbeExactFileNames(scope),
    exactDirectories: configProbeExactDirectories(scope),
    exactPaths: configProbeExactPaths(scope),
  };
}

function configProbeGrepPattern(scope: InvestigationScope): string {
  return configProbeTerms(scope)
    .map(regexEscape)
    .join("|") || "properties|config|service|batch|job";
}

function pathBasename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}

function stripKnownArtifactExtension(value: string): string {
  return value.replace(/\.(?:jar|properties|xml|ya?ml|conf|cfg|sh|ksh|bash)$/i, "");
}

function kebabSignal(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function compactConfigSignal(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isGenericPathSignal(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return /^(api|apis|rest|http|https|url|uri|runtime|configuration|config|configs|properties|property|queue|queues|job|jobs|batch|batchjob|batchjobs|service|services|processor|processors|extract|extracts|extractor|extractors|export|exports|import|imports|report|reports|reporting|feed|feeds|process|processes|program|programs|coreapp|move|moves|tracking|status|error|errors|failed|failure|exception|exceptions|download|downloads|image|images|document|documents|database|db|slavedb|datasource|logback|logging|logger|prod|prodreplica)$/.test(normalized)
    || /^\d+$/.test(normalized);
}

function derivedScopePathSignals(scope: InvestigationScope): string[] {
  const rawTerms = [
    ...(scope.serviceIds || []),
    ...(scope.keywords || []),
    ...(scope.repoNames || []),
  ];
  const signals: string[] = [];

  for (const rawTerm of rawTerms) {
    const term = rawTerm?.trim();
    if (!term || isJiraIssueKeyLike(term) || isScopeNoiseTerm(term, scope)) continue;
    if (isRepositoryConfigFileSignal(term)) continue;
    const basename = stripKnownArtifactExtension(pathBasename(term));
    const kebab = kebabSignal(basename);
    const compact = compactConfigSignal(basename);
    signals.push(term, basename, kebab);
    signals.push(...configProbeTermCandidates(basename)
      .filter((candidate) => !candidate.startsWith("/"))
      .filter((candidate) => !/\.(?:jar|properties|xml|ya?ml|conf|cfg|sh|ksh|bash)$/i.test(candidate)));
    if (RUNTIME_COMPONENT_SIGNAL_PATTERN.test(term)) {
      signals.push(kebab.replace(/-(service|processor|handler|watcher|batch|job|intake|loader|runner|api|config|properties|extract|extractor|export|exporter|import|importer|report|reporting|utility|generator|feed|process|program)$/i, ""));
    }
    if (compact.length >= 6) {
      signals.push(compact);
    }
  }

  return Array.from(new Set(signals
    .map((signal) => signal.trim())
    .filter((signal) => signal.length >= 3 && signal.length <= 100)
    .filter((signal) => !isGenericPathSignal(signal))
    .filter((signal) => !isScopeNoiseTerm(signal, scope))));
}

function configProbeDirectoryPattern(scope: InvestigationScope): string {
  const scopedTerms = derivedScopePathSignals(scope);
  return Array.from(new Set([
    ...scopedTerms,
    "config",
    "properties",
  ]))
    .map(regexEscape)
    .join("|");
}

function configProbeDirectoryNames(scope: InvestigationScope): string[] {
  const serviceNames = (scope.serviceIds || [])
    .flatMap((serviceId) => {
      return configProbeTermCandidates(serviceId)
        .sort((left, right) => configProbeSurfaceCandidateScore(right) - configProbeSurfaceCandidateScore(left) || left.localeCompare(right))
        .flatMap((candidate) => {
          const kebab = kebabSignal(candidate);
          return [
            candidate,
            kebab,
            `${kebab}-file`,
            `${kebab}-config`,
          ];
        });
    });

  return Array.from(new Set([
    ...serviceNames,
    "config",
  ].map((entry) => entry.trim()).filter((entry) => entry.length >= 3)));
}

function configProbePathSignalPattern(scope: InvestigationScope): string {
  return derivedScopePathSignals(scope)
    .map(regexEscape)
    .join("|");
}

function sshConfigProbeRoots(target: InvestigationHostTarget): string[] {
  const configured = process.env.INVESTIGATION_SSH_CONFIG_PROBE_ROOTS?.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (configured?.length) {
    return configured.slice(0, 6);
  }
  if (target.configProbePaths?.length) {
    return target.configProbePaths.slice(0, 6);
  }
  return ["/opt/software/medhok", "/usr/local/tomcat", "/opt/tomcat", "/medhok"];
}

function buildSshConfigProbeScript(request: InvestigationAdapterRequest, target: InvestigationHostTarget): string {
  const roots = sshConfigProbeRoots(target);
  const pattern = configProbeGrepPattern(request.scope);
  const directoryPattern = configProbeDirectoryPattern(request.scope);
  const directoryNames = configProbeDirectoryNames(request.scope);
  const pathSignalPattern = configProbePathSignalPattern(request.scope);
  const exactFileNames = configProbeExactFileNames(request.scope);
  const exactDirectories = configProbeExactDirectories(request.scope);
  const exactPaths = configProbeExactPaths(request.scope);
  const versionPattern = request.scope.codeVersion?.trim() ? regexEscape(request.scope.codeVersion.trim()) : "";
  const jarEntryPattern = [
    pattern,
    directoryPattern,
    pathSignalPattern,
    "service",
    "client",
    "handler",
    "processor",
    "controller",
    "download",
    "image",
    "queue",
    "session",
    "token",
    "api",
    "rest",
    "http",
    "properties",
    "config",
  ].filter(Boolean).join("|");
  const maxFiles = Math.max(1, Math.min(30, target.configProbeMaxMatches || Number(process.env.INVESTIGATION_SSH_CONFIG_MAX_FILES || "18")));
  const maxCandidates = Math.max(maxFiles, Math.min(400, Number(process.env.INVESTIGATION_SSH_CONFIG_MAX_CANDIDATES || "300")));
  const maxMatches = Math.max(1, Math.min(180, Number(process.env.INVESTIGATION_SSH_CONFIG_MAX_MATCHES || "90")));
  const discoverDirs = process.env.INVESTIGATION_SSH_CONFIG_DISCOVER_DIRS?.trim().toLowerCase() !== "false";

  return [
    "set -eu",
    `PATTERN=${shellQuote(pattern)}`,
    `DIR_PATTERN=${shellQuote(directoryPattern)}`,
    `PATH_SIGNAL_PATTERN=${shellQuote(pathSignalPattern)}`,
    `VERSION_PATTERN=${shellQuote(versionPattern)}`,
    `JAR_ENTRY_PATTERN=${shellQuote(jarEntryPattern)}`,
    `MAX_FILES=${maxFiles}`,
    `MAX_CANDIDATES=${maxCandidates}`,
    `MAX_MATCHES=${maxMatches}`,
    "TMP_DIRS=$(mktemp)",
    "TMP_ALL=$(mktemp)",
    "TMP_PATH_MATCHES=$(mktemp)",
    "TMP_MATCHES=$(mktemp)",
    "TMP_COMPANIONS=$(mktemp)",
    "trap 'rm -f \"$TMP_DIRS\" \"$TMP_ALL\" \"$TMP_PATH_MATCHES\" \"$TMP_MATCHES\" \"$TMP_COMPANIONS\"' EXIT",
    "score_candidates() { awk -v version=\"$VERSION_PATTERN\" -v signal=\"$PATH_SIGNAL_PATTERN\" 'BEGIN { IGNORECASE=1 } { score=500; path=$0; generic=(path ~ /\\/(main|application|config|service|client)[^\\/]*\\.properties$/); config=(path ~ /\\.(properties|conf|cfg|xml|ya?ml)$/); if (path ~ /\\/lib\\//) score += 300; if (path ~ /(rollback|bkp|backup|archive|old)/) score += 180; if (generic) score -= 240; else if (config) score -= 160; if (path ~ /\\.jar$/) score -= 60; if (signal != \"\" && path ~ signal) score -= 220; if (signal != \"\" && config && !generic && path ~ signal) score -= 260; if (version != \"\" && path ~ version && signal != \"\" && path ~ signal) score -= 180; printf \"%04d %s\\n\", score, path }' | sort | sed 's/^[0-9][0-9][0-9][0-9] //' ; }",
    "> \"$TMP_MATCHES\"",
    "{",
    `  for FILE in ${(exactPaths.length ? exactPaths : [""]).map(shellQuote).join(" ")}; do`,
    "    [ -n \"$FILE\" ] || continue",
    "    [ -f \"$FILE\" ] && printf '%s\\n' \"$FILE\"",
    "  done",
    `  for DIR in ${(exactDirectories.length ? exactDirectories : [""]).map(shellQuote).join(" ")}; do`,
    "    [ -n \"$DIR\" ] || continue",
    "    [ -d \"$DIR\" ] || continue",
    `    for NAME in ${(exactFileNames.length ? exactFileNames : [""]).map(shellQuote).join(" ")}; do`,
    "      [ -n \"$NAME\" ] || continue",
    "      [ -f \"$DIR/$NAME\" ] && printf '%s\\n' \"$DIR/$NAME\"",
    "    done",
    "    find \"$DIR\" -maxdepth 2 -type f \\( -name '*.properties' -o -name '*.xml' -o -name '*.yaml' -o -name '*.yml' -o -name '*.conf' -o -name '*.cfg' -o -name '*.jar' -o -name '*.sh' -o -name '*.ksh' -o -name '*.bash' \\) -size -2048k -print 2>/dev/null || true",
    "  done",
    "} | awk '!seen[$0]++' | score_candidates | head -n \"$MAX_FILES\" > \"$TMP_MATCHES\" || true",
    "if [ \"$(wc -l < \"$TMP_MATCHES\" | tr -d ' ')\" -eq 0 ]; then",
    "{",
    ...roots.map((root) => [
      `[ -d ${shellQuote(root)} ] && {`,
      `  ROOT=${shellQuote(root)}`,
      `  for NAME in ${(exactFileNames.length ? exactFileNames : [""]).map(shellQuote).join(" ")}; do`,
      "    [ -n \"$NAME\" ] || continue",
      "    find \"$ROOT\" -maxdepth 5 -type f -name \"$NAME\" -size -2048k -print 2>/dev/null || true",
      "  done",
      "} || true",
    ].join("\n")),
    "} | awk '!seen[$0]++' | score_candidates | head -n \"$MAX_FILES\" >> \"$TMP_MATCHES\" || true",
    "fi",
    "if [ \"$(wc -l < \"$TMP_MATCHES\" | tr -d ' ')\" -eq 0 ]; then",
    "{",
    ...roots.map((root) => [
      `[ -d ${shellQuote(root)} ] && {`,
      `  ROOT=${shellQuote(root)}`,
      "  printf '%s\\n' \"$ROOT\" | grep -Eaiq \"$DIR_PATTERN|config|service|batch|job\" && printf '%s\\n' \"$ROOT\" || true",
      `  for NAME in ${directoryNames.map(shellQuote).join(" ")}; do`,
      "    [ -d \"$ROOT/$NAME\" ] && printf '%s\\n' \"$ROOT/$NAME\"",
      "  done",
      discoverDirs
        ? "  find \"$ROOT\" -mindepth 1 -maxdepth 2 -type d 2>/dev/null | grep -Eai \"$DIR_PATTERN\" | head -n 80 || true"
        : "  :",
      "} || true",
    ].join("\n")),
    "} | awk '!seen[$0]++' | head -n \"$MAX_CANDIDATES\" > \"$TMP_DIRS\"",
    "while IFS= read -r DIR; do",
    "  [ -d \"$DIR\" ] || continue",
    "  find \"$DIR\" -maxdepth 3 \\( -path '*/.git' -o -path '*/node_modules' -o -path '*/target' -o -path '*/build' -o -path '*/logs' -o -path '*/log' \\) -prune -o -type f \\( -name '*.properties' -o -name '*.xml' -o -name '*.yaml' -o -name '*.yml' -o -name '*.conf' -o -name '*.cfg' -o -name '*.jar' -o -name '*.sh' -o -name '*.ksh' -o -name '*.bash' \\) -size -2048k -print 2>/dev/null || true",
    "done < \"$TMP_DIRS\" | grep -Eai \"$PATTERN|$DIR_PATTERN\" | score_candidates | head -n \"$MAX_FILES\" > \"$TMP_PATH_MATCHES\" || true",
    "cat \"$TMP_PATH_MATCHES\" >> \"$TMP_MATCHES\"",
    "fi",
    "> \"$TMP_ALL\"",
    "if [ \"$(wc -l < \"$TMP_MATCHES\" | tr -d ' ')\" -eq 0 ]; then",
    "{",
    ...roots.map((root) => `[ -d ${shellQuote(root)} ] && find ${shellQuote(root)} -maxdepth 3 \\( -path '*/.git' -o -path '*/node_modules' -o -path '*/target' -o -path '*/build' -o -path '*/logs' -o -path '*/log' \\) -prune -o -type f \\( -name '*.properties' -o -name '*.xml' -o -name '*.yaml' -o -name '*.yml' -o -name '*.conf' -o -name '*.cfg' -o -name '*.jar' -o -name '*.sh' -o -name '*.ksh' -o -name '*.bash' \\) -size -2048k -print 2>/dev/null || true`),
    "} | score_candidates | head -n \"$MAX_CANDIDATES\" > \"$TMP_ALL\"",
    "while IFS= read -r FILE; do",
    "  [ -f \"$FILE\" ] || continue",
    "  grep -Fxq \"$FILE\" \"$TMP_MATCHES\" && continue",
    "  if printf '%s\\n' \"$FILE\" | grep -Eaiq \"$PATTERN\"; then",
    "    printf '%s\\n' \"$FILE\"",
    "  fi",
    "  case \"$FILE\" in",
    "    *.jar) : ;;",
    "    *) grep -Eaiq \"$PATTERN\" \"$FILE\" && printf '%s\\n' \"$FILE\" || true ;;",
    "  esac",
    "done < \"$TMP_ALL\" | score_candidates | head -n \"$MAX_FILES\" >> \"$TMP_MATCHES\"",
    "fi",
    "> \"$TMP_COMPANIONS\"",
    "while IFS= read -r FILE; do",
    "  [ -f \"$FILE\" ] || continue",
    "  case \"$FILE\" in",
    "    *.jar)",
    "      DIR=${FILE%/*}",
      "      find \"$DIR\" -maxdepth 1 -type f \\( -name '*.properties' -o -name '*.xml' -o -name '*.yaml' -o -name '*.yml' -o -name '*.conf' -o -name '*.cfg' \\) -print 2>/dev/null | grep -Eai \"$PATTERN|$DIR_PATTERN|main|application|config|service|client\" | score_candidates | head -n 8 || true",
    "      ;;",
    "  esac",
    "done < \"$TMP_MATCHES\" > \"$TMP_COMPANIONS\"",
    "cat \"$TMP_COMPANIONS\" >> \"$TMP_MATCHES\"",
    "awk '!seen[$0]++' \"$TMP_MATCHES\" | score_candidates | head -n \"$MAX_FILES\" > \"$TMP_PATH_MATCHES\"",
    "cat \"$TMP_PATH_MATCHES\" > \"$TMP_MATCHES\"",
    "{",
    "while IFS= read -r FILE; do",
    "  [ -f \"$FILE\" ] || continue",
    "  case \"$FILE\" in",
    "    *.jar) : ;;",
    "    *)",
    "      if grep -Eaiq '(^|[[:space:]])(java|nohup|sh|bash|ksh|python|perl|.*\\.jar|-[A-Za-z][A-Za-z0-9_]{2,})' \"$FILE\" 2>/dev/null; then",
    "        echo \"###FILE:$FILE\"",
    "        grep -Eai -m 8 '(^|[[:space:]])(java|nohup|sh|bash|ksh|python|perl|.*\\.jar|-[A-Za-z][A-Za-z0-9_]{2,})' \"$FILE\" | grep -Eai \"$PATTERN|$DIR_PATTERN|-[A-Za-z][A-Za-z0-9_]{2,}\" | sed 's/^/launch.command=/' || true",
    "      fi",
    "      ;;",
    "  esac",
    "done < \"$TMP_MATCHES\"",
    "while IFS= read -r FILE; do",
    "  [ -f \"$FILE\" ] || continue",
    "  echo \"###MATCHED_FILE:$FILE\"",
    "done < \"$TMP_MATCHES\"",
    "while IFS= read -r FILE; do",
    "  [ -f \"$FILE\" ] || continue",
    "  echo \"###FILE:$FILE\"",
    "  if printf '%s\\n' \"$FILE\" | grep -Eaiq \"$PATTERN\"; then",
    "    printf 'path=%s\\n' \"$FILE\"",
    "  fi",
    "  case \"$FILE\" in",
    "    *.jar)",
    "      if command -v unzip >/dev/null 2>&1; then",
    "        unzip -p \"$FILE\" META-INF/MANIFEST.MF 2>/dev/null | grep -Eai '^(Implementation|Specification|Main-Class|Build|Built|Version|Created-By)' | head -n 8 | sed 's/^/jar.manifest=/' || true",
    "        unzip -Z1 \"$FILE\" 2>/dev/null | grep -Eai \"$JAR_ENTRY_PATTERN\" | head -n 12 | sed 's/^/jar.entry=/' || true",
    "      elif command -v jar >/dev/null 2>&1; then",
    "        jar tf \"$FILE\" 2>/dev/null | grep -Eai \"$JAR_ENTRY_PATTERN\" | head -n 12 | sed 's/^/jar.entry=/' || true",
    "      fi",
    "      ;;",
    "    *)",
    "      grep -Eai -m 20 \"$PATTERN\" \"$FILE\" || true",
    "      grep -Eai -m 12 '^[[:space:]]*[A-Za-z0-9_.-]+[[:space:]]*[:=]' \"$FILE\" | sed -E 's/[[:space:]]*[:=].*/=present/' | sed 's/^/property.key=/' || true",
    "      ;;",
    "  esac",
    "done < \"$TMP_MATCHES\"",
    "} | head -n \"$MAX_MATCHES\"",
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function redactHostConfigLine(value: string): string {
  return sanitizeTextValue(redactRuntimeLogLine(value), "", 1_500);
}

function normalizeLaunchCommandLine(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, "[ENV]")
    .trim()
    .slice(0, 1_500);
}

function redactRuntimeLogLine(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]")
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, "[REDACTED_PHONE]")
    .replace(/\b(member|patient|subscriber|medicare|mbi|hicn|firstName|lastName|fullName|name|dob|dateOfBirth)\s*[=:]\s*[^,\s|;]+/gi, "$1=[REDACTED]")
    .replace(/\b\d{10,}\b/g, "[REDACTED_NUMBER]")
    .slice(0, 1_500);
}

function sanitizeRuntimeUnavailableReason(value: string, source: RuntimeLogSample["source"]): string {
  if (source === "ssm_file" && /AccessDeniedException/i.test(value) && /ssm:SendCommand/i.test(value)) {
    return "SSM file-log search could not run because the active AWS role is not authorized for ssm:SendCommand on the approved host target. Grant bounded SSM command/session permission or configure S3 archived logs for older host files.";
  }

  if (source === "s3_archive" && /AccessDenied|AccessDeniedException|Forbidden/i.test(value)) {
    return "S3 archived-log search could not run because the active AWS role is not authorized for the configured archive bucket or prefix.";
  }

  if (source === "cloudwatch" && /AccessDenied|AccessDeniedException/i.test(value)) {
    return "CloudWatch runtime-log search could not run because the active AWS role is not authorized for the selected log-group scope.";
  }

  return value
    .replace(/Command failed:\s*aws[\s\S]*/i, "AWS CLI command failed; command details redacted.")
    .replace(/arn:aws:[^\s,;)"']+/gi, "[REDACTED_AWS_ARN]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .slice(0, 1_500);
}

function sanitizeSshConfigUnavailableReason(value: string): string {
  if (/mux_client_request_session|session open refused|open failed/i.test(value)) {
    return "LDAP SSH control socket is present but refused a command session. Start a dedicated no-session LDAP SSH control master for the configured ControlPath and rerun the cockpit investigation.";
  }
  if (/timeout|timed out|SIGTERM|ETIMEDOUT|killed/i.test(value)) {
    return "LDAP SSH config probe timed out before deployed jar/properties evidence could be collected. Narrow the approved config roots or rerun after confirming the login host filesystem is responsive.";
  }
  if (/Permission denied|Authentication failed|No supported authentication methods|publickey|keyboard-interactive/i.test(value)) {
    return "LDAP SSH config probe could not authenticate to the approved host target. Start or refresh the operator LDAP SSH session/agent and rerun the cockpit investigation.";
  }
  if (/Connection timed out|No route to host|Connection refused|Could not resolve hostname/i.test(value)) {
    return "LDAP SSH config probe could not reach the approved host target over the configured public SSH endpoint.";
  }
  return value
    .replace(/Command failed:\s*ssh[\s\S]*/i, "SSH command failed; command details redacted.")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[REDACTED_IP]")
    .slice(0, 1_500);
}

function hasRuntimeApplicationFailureSignal(
  text: string,
  statusCodes: string[],
  exceptionMatch?: RegExpMatchArray | null,
): boolean {
  return statusCodes.some((code) => code.startsWith("5"))
    || Boolean(exceptionMatch)
    || /\b[A-Za-z0-9_.$]*(?:Exception|Error)\b/.test(text)
    || /\b(exception|error|failed|failure|timeout|timed out|connection refused|cannot connect)\b/i.test(text);
}

function buildRuntimeLogFinding(input: {
  request: InvestigationAdapterRequest;
  evidenceId: string;
  samples: RuntimeLogSample[];
  source: RuntimeLogSample["source"];
}): InvestigationFinding {
  if (input.samples.length === 0) {
    const sourceLabel = input.source === "cloudwatch"
      ? "CloudWatch"
      : input.source === "s3_archive"
      ? "S3 archived logs"
      : "SSM file logs";
    return {
      id: `${input.request.runId}-${input.source}-log-no-evidence`,
      adapter: "host",
      type: `${input.source}_log_no_evidence`,
      severity: "info",
      confidence: 0.55,
      title: `${sourceLabel} did not return matching runtime log events`,
      summary: `The bounded ${sourceLabel} search completed, but no matching redacted runtime evidence was found.`,
      evidenceRefs: [input.evidenceId],
      requiresCodeChange: false,
      requiresDataChange: false,
    };
  }

  const combined = input.samples.map((sample) => sample.message).join("\n");
  const statusCodes = Array.from(new Set(
    [...combined.matchAll(/\b(?:HTTP(?: RESPONSE STATUS CODE)?|status)\s*:?\s*(5\d\d|4\d\d)\b/gi)]
      .map((match) => match[1]),
  ));
  const runtimeApplicationFailure = hasRuntimeApplicationFailureSignal(combined, statusCodes);
  const apiFailureSignal = hasRuntimeApiSignal(input.request.scope)
    || /\b(api|rest|http|endpoint|token|session|download|image|document)\b/i.test(combined);
  const sourceLabel = input.source === "cloudwatch"
    ? "CloudWatch"
    : input.source === "s3_archive"
    ? "S3 archived logs"
    : "SSM file logs";
  const title = apiFailureSignal && statusCodes.some((code) => code.startsWith("5"))
    ? `${sourceLabel} found HTTP ${statusCodes.filter((code) => code.startsWith("5")).join("/")} runtime failures`
    : `${sourceLabel} found ${input.samples.length} matching runtime log sample(s)`;
  const locations = Array.from(new Set(input.samples.map((sample) => sample.location))).slice(0, 4);

  return {
    id: `${input.request.runId}-${input.source}-log-evidence`,
    adapter: "host",
    type: `${input.source}_log_evidence`,
    severity: statusCodes.some((code) => code.startsWith("5")) ? "high" : "medium",
    confidence: apiFailureSignal || statusCodes.length > 0 ? 0.84 : 0.72,
    title,
    summary: [
      `${sourceLabel} returned ${input.samples.length} redacted runtime sample(s).`,
      statusCodes.length > 0 ? `Observed HTTP/status code(s): ${statusCodes.join(", ")}.` : undefined,
      locations.length > 0 ? `Source scope: ${locations.join(", ")}.` : undefined,
    ].filter(Boolean).join(" "),
    evidenceRefs: [input.evidenceId],
    requiresCodeChange: runtimeApplicationFailure,
    requiresDataChange: false,
    metadata: {
      source: input.source,
      statusCodes,
      runtimeApplicationFailure,
      sampleCount: input.samples.length,
      locations,
      firstSeen: input.samples[0]?.timestamp,
    },
  };
}

function runtimeLogEvidenceArtifact(input: {
  request: InvestigationAdapterRequest;
  source: RuntimeLogSample["source"];
  title: string;
  summary: string;
  samples: RuntimeLogSample[];
  traceSteps: InvestigationAdapterTraceStep[];
  metadata?: Record<string, unknown>;
}): InvestigationEvidenceArtifact {
  const sourceId = input.source.replace(/_/g, "-");
  return {
    id: `${input.request.runId}-${sourceId}-runtime-log-evidence`,
    adapter: "host",
    title: input.title,
    summary: input.summary,
    contentType: "application/json",
    metadata: {
      ...input.metadata,
      redactedSamples: input.samples.slice(0, input.request.constraints.maxArtifacts || 20),
      traceSteps: input.traceSteps.map(toEvidenceTraceStep),
    },
  };
}

function hostTargetEvidenceMetadata(target: InvestigationHostTarget): Record<string, unknown> {
  return {
    targetId: target.id,
    instanceId: target.instanceId,
    instanceName: target.instanceName,
    region: target.region,
    envId: target.envId,
    publicHost: target.publicHost,
    sshPort: target.sshPort,
    sshAuthMode: target.sshAuthMode,
  };
}

function parseSshConfigProbeOutput(output: string, request: InvestigationAdapterRequest): {
  files: string[];
  samples: HostConfigSample[];
} {
  const files: string[] = [];
  const samples: HostConfigSample[] = [];
  const maxSamples = Math.max(request.constraints.maxArtifacts || 20, 40);
  const seenSamples = new Set<string>();
  let currentFile = "unknown";

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("###FILE:")) {
      currentFile = line.slice("###FILE:".length).trim() || currentFile;
      if (!files.includes(currentFile)) {
        files.push(currentFile);
      }
      continue;
    }
    if (line.startsWith("###MATCHED_FILE:")) {
      const matchedFile = line.slice("###MATCHED_FILE:".length).trim();
      if (matchedFile && !files.includes(matchedFile)) {
        files.push(matchedFile);
      }
      continue;
    }
    const sample = {
      location: currentFile,
      message: redactHostConfigLine(line),
    };
    const sampleKey = `${sample.location}\n${sample.message}`;
    if (!seenSamples.has(sampleKey)) {
      seenSamples.add(sampleKey);
      samples.push(sample);
    }
    if (samples.length >= maxSamples) break;
  }

  return {
    files: files.slice(0, 50),
    samples,
  };
}

function extractLaunchCommands(samples: HostConfigSample[]): Array<{ location: string; command: string }> {
  return samples
    .filter((sample) => /^launch\.command=/i.test(sample.message))
    .map((sample) => ({
      location: sample.location,
      command: normalizeLaunchCommandLine(sample.message.replace(/^launch\.command=/i, "")),
    }))
    .filter((sample) => sample.command)
    .slice(0, 12);
}

function extractJarManifestVersions(samples: HostConfigSample[]): Array<{ location: string; manifest: string }> {
  return samples
    .filter((sample) => /^jar\.manifest=/i.test(sample.message))
    .map((sample) => ({
      location: sample.location,
      manifest: sample.message.replace(/^jar\.manifest=/i, "").trim(),
    }))
    .filter((sample) => sample.manifest)
    .slice(0, 16);
}

function buildSshConfigFinding(input: {
  request: InvestigationAdapterRequest;
  evidenceId: string;
  target: InvestigationHostTarget;
  files: string[];
  samples: HostConfigSample[];
}): InvestigationFinding {
  if (input.files.length === 0) {
    return {
      id: `${input.request.runId}-ssh-config-no-evidence`,
      adapter: "host",
      type: "ssh_config_no_evidence",
      severity: "info",
      confidence: 0.55,
      title: "LDAP SSH deployed jar/properties probe did not find matching files",
      summary: `The bounded SSH deployed jar/properties search completed on ${input.target.instanceName}, but no matching deployed jar/properties evidence was found.`,
      evidenceRefs: [input.evidenceId],
      requiresCodeChange: false,
      requiresDataChange: false,
      metadata: {
        targetId: input.target.id,
        probeRoots: sshConfigProbeRoots(input.target),
      },
    };
  }

  return {
    id: `${input.request.runId}-ssh-config-evidence`,
    adapter: "host",
    type: "ssh_config_evidence",
    severity: "medium",
    confidence: input.samples.length > 0 ? 0.78 : 0.68,
    title: "LDAP SSH deployed jar/properties probe found candidates",
    summary: `Found ${input.files.length} deployed jar/properties candidate(s) on ${input.target.instanceName}; captured ${input.samples.length} redacted manifest/config line(s).`,
    evidenceRefs: [input.evidenceId],
    requiresCodeChange: true,
    requiresDataChange: false,
    metadata: {
      targetId: input.target.id,
      matchedFiles: input.files.slice(0, 12),
      sampleCount: input.samples.length,
    },
  };
}

function sshConfigEvidenceArtifact(input: {
  request: InvestigationAdapterRequest;
  target: InvestigationHostTarget;
  files: string[];
  samples: HostConfigSample[];
  traceSteps: InvestigationAdapterTraceStep[];
}): InvestigationEvidenceArtifact {
  const candidates = configProbeCandidateMetadata(input.request.scope);
  const launchCommands = extractLaunchCommands(input.samples);
  const jarManifestVersions = extractJarManifestVersions(input.samples);
  return {
    id: `${input.request.runId}-ssh-config-evidence`,
    adapter: "host",
    title: "LDAP SSH deployed jar/properties probe",
    summary: `LDAP SSH searched approved config roots on ${input.target.instanceName} and found ${input.files.length} deployed jar/properties candidate(s).`,
    contentType: "application/json",
    metadata: {
      targetId: input.target.id,
      instanceId: input.target.instanceId,
      publicHost: input.target.publicHost,
      sshAuthMode: input.target.sshAuthMode,
      probeRoots: sshConfigProbeRoots(input.target),
      searchTerms: candidates.searchTerms,
      exactFileNames: candidates.exactFileNames,
      exactDirectories: candidates.exactDirectories,
      exactPaths: candidates.exactPaths,
      matchedFiles: input.files,
      launchCommands,
      jarManifestVersions,
      redactedSamples: input.samples.slice(0, input.request.constraints.maxArtifacts || 20),
      traceSteps: input.traceSteps.map(toEvidenceTraceStep),
    },
  };
}

function emptyHostResult(startedAt: number, traceSteps: InvestigationAdapterTraceStep[]): InvestigationAdapterResult {
  return {
    findings: [],
    evidence: [],
    telemetry: {
      durationMs: Date.now() - startedAt,
      requestsIssued: 0,
      traceSteps,
    },
  };
}

function traceStep(input: {
  request: InvestigationAdapterRequest;
  idSuffix: string;
  phase: InvestigationAdapterTraceStep["phase"];
  title: string;
  detail: string;
  rowCount?: number;
}): InvestigationAdapterTraceStep {
  const now = new Date().toISOString();
  return {
    id: `${input.request.runId}-${input.idSuffix}`,
    adapter: "host",
    phase: input.phase,
    title: input.title,
    detail: input.detail,
    startedAt: now,
    completedAt: now,
    rowCount: input.rowCount,
  };
}

function defaultWatchdogTimeWindow(): NonNullable<InvestigationScope["timeWindow"]> {
  const hours = Number(process.env.INVESTIGATION_WATCHDOG_DEFAULT_HOURS || "24");
  const boundedHours = Number.isFinite(hours) ? Math.max(1, Math.min(168, Math.floor(hours))) : 24;
  const end = new Date();
  const start = new Date(end.getTime() - boundedHours * 60 * 60 * 1000);
  return {
    startTs: start.toISOString(),
    endTs: end.toISOString(),
  };
}

function makeTraceStep(
  request: InvestigationAdapterRequest,
  phase: InvestigationAdapterTraceStep["phase"],
  title: string,
  detail: string,
): InvestigationAdapterTraceStep {
  const now = new Date().toISOString();
  return {
    id: `${request.runId}-watchdog-${phase}-${Math.random().toString(36).slice(2, 8)}`,
    adapter: "host",
    phase,
    title,
    detail,
    startedAt: now,
    completedAt: now,
  };
}

function toEvidenceTraceStep(step: InvestigationAdapterTraceStep) {
  return {
    title: step.title,
    detail: step.detail,
    safeSql: step.safeSql,
    rowCount: step.rowCount,
  };
}

function buildWatchdogQuerySpec(scope: InvestigationScope) {
  const rawTerms = [
    ...(scope.keywords || []),
    ...(scope.serviceIds || []),
  ];
  const normalized = Array.from(new Set(rawTerms
    .map((term) => term.trim())
    .filter(Boolean)
    .filter((term) => !isJiraIssueKeyLike(term))
    .filter((term) => !/^\d+(?:\.\d+){1,2}$/.test(term))
    .filter((term) => term.length >= 4)
  ));
  const exact_phrases = normalized
    .filter((term) => /\s/.test(term))
    .slice(0, 4);
  const keywords = normalized
    .filter((term) => !/\s/.test(term))
    .filter((term) => !isScopeNoiseTerm(term, scope))
    .slice(0, 8);

  return {
    template_id: keywords.length > 0 || exact_phrases.length > 0 ? "keyword_scan" : "errors",
    keywords,
    exact_phrases,
    severity: keywords.length > 0 || exact_phrases.length > 0 ? [] : ["error"],
    component_filters: Array.from(new Set(scope.serviceIds || [])).slice(0, 6),
    limit: 100,
  };
}

function summarizeWatchdogSearch(search: WatchdogMcpSearchBundle): string {
  const counts = search.summary_counts || {};
  const total = Number(counts.total_matches || 0);
  const returned = Number(counts.returned_samples || 0);
  const logGroups = Object.keys(counts.log_groups || {});
  const logGroupText = logGroups.length > 0 ? ` across ${logGroups.slice(0, 4).join(", ")}` : "";
  return `Watchdog CloudWatch search ${search.search_id || "unknown"} found ${total} matching event(s) and returned ${returned} redacted sample(s)${logGroupText}.`;
}

function normalizeWatchdogUnavailableReason(reason: string): string {
  return /aborted|aborterror/i.test(reason)
    ? "Watchdog CloudWatch search timed out before returning bounded log evidence."
    : reason;
}

function normalizeWatchdogSamples(samples: Array<Record<string, unknown>>) {
  return samples
    .map((sample) => ({
      timestamp: stringMetadata(sample.timestamp),
      logGroup: stringMetadata(sample.log_group_name) || stringMetadata(sample.logGroup),
      logStream: stringMetadata(sample.log_stream) || stringMetadata(sample.logStream),
      message: stringMetadata(sample.message) || "",
    }))
    .filter((sample) => sample.message.trim())
    .slice(0, 25);
}

function stringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1_500) : undefined;
}

function buildWatchdogLogFinding(input: {
  request: InvestigationAdapterRequest;
  evidenceId: string;
  search: WatchdogMcpSearchBundle;
  samples: ReturnType<typeof normalizeWatchdogSamples>;
  totalMatches: number;
}): InvestigationFinding {
  if (input.totalMatches <= 0) {
    return {
      id: `${input.request.runId}-watchdog-log-no-evidence`,
      adapter: "host",
      type: "watchdog_log_no_evidence",
      severity: "info",
      confidence: 0.65,
      title: "Watchdog did not find matching CloudWatch log events",
      summary: "The bounded Watchdog search completed, but no matching runtime log events were found in the approved scope.",
      evidenceRefs: [input.evidenceId],
      requiresCodeChange: false,
      requiresDataChange: false,
      metadata: {
        searchId: input.search.search_id,
        summaryCounts: input.search.summary_counts || {},
      },
    };
  }

  const combined = input.samples.map((sample) => sample.message).join("\n");
  const statusCodes = Array.from(new Set(
    [...combined.matchAll(/\b(?:HTTP(?: RESPONSE STATUS CODE)?|status)\s*:?\s*(5\d\d|4\d\d)\b/gi)]
      .map((match) => match[1]),
  ));
  const lower = combined.toLowerCase();
  const apiFailureSignal = hasRuntimeApiSignal(input.request.scope)
    || /\b(api|rest|http|endpoint|token|session|download|image|document)\b/i.test(combined);
  const operationSignals = [
    lower.includes("archive") || lower.includes("/move") || lower.includes(" move ") ? "archive/move" : undefined,
    lower.includes("download") || lower.includes("image") || lower.includes("document") ? "download/image" : undefined,
    lower.includes("uniquejobid") ? "uniqueJobId" : undefined,
    lower.includes("subsession") ? "subsessionId" : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  const exceptionMatch = combined.match(/([A-Za-z0-9_.$]+(?:Exception|Error)):\s*([^;\n]+)/);
  const logGroups = Object.keys(input.search.summary_counts?.log_groups || {});
  const title = apiFailureSignal && statusCodes.some((code) => code.startsWith("5"))
    ? `Watchdog found HTTP ${statusCodes.filter((code) => code.startsWith("5")).join("/")} runtime failures`
    : exceptionMatch
    ? `Watchdog found ${exceptionMatch[1].split(".").at(-1)} in runtime logs`
    : `Watchdog found ${input.totalMatches} matching CloudWatch log events`;
  const summary = [
    `Watchdog found ${input.totalMatches} matching CloudWatch event(s).`,
    statusCodes.length > 0 ? `Observed HTTP/status code(s): ${statusCodes.join(", ")}.` : undefined,
    operationSignals.length > 0 ? `Relevant operation signal(s): ${operationSignals.join(", ")}.` : undefined,
    logGroups.length > 0 ? `Log group scope: ${logGroups.slice(0, 3).join(", ")}.` : undefined,
  ].filter(Boolean).join(" ");

  return {
    id: `${input.request.runId}-watchdog-log-evidence`,
    adapter: "host",
    type: "watchdog_log_evidence",
    severity: statusCodes.some((code) => code.startsWith("5")) || /Exception|Error/.test(exceptionMatch?.[1] || "") ? "high" : "medium",
    confidence: apiFailureSignal || statusCodes.length > 0 || exceptionMatch ? 0.82 : 0.72,
    title,
    summary,
    evidenceRefs: [input.evidenceId],
    requiresCodeChange: false,
    requiresDataChange: false,
    metadata: {
      searchId: input.search.search_id,
      summaryCounts: input.search.summary_counts || {},
      statusCodes,
      operationSignals,
      sampleCount: input.samples.length,
      firstSeen: input.samples[0]?.timestamp,
      logGroups,
      warnings: input.search.warnings || [],
    },
  };
}

export class DashboardWatchdogLogInspectionAdapter implements HostInspectionAdapter {
  readonly kind = "host" as const;

  constructor(
    private readonly fallback?: HostInspectionAdapter,
    private readonly mcpCaller: WatchdogMcpCaller = callWatchdogMcpTool,
    private readonly hostRegistry?: InvestigationHostTargetRegistry,
  ) {}

  async execute(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    const startedAt = Date.now();
    const traceSteps: InvestigationAdapterTraceStep[] = [];
    const watchdogResult = await this.collectWatchdogLogs(request, startedAt, traceSteps);

    if (!this.fallback || request.scope.hostTargets?.length === 0 || process.env.INVESTIGATION_HOST_SSM_POSTURE_ENABLED === "false") {
      return watchdogResult;
    }

    const fallbackResult = await this.fallback.execute(request);
    return {
      findings: [...watchdogResult.findings, ...fallbackResult.findings],
      evidence: [...watchdogResult.evidence, ...fallbackResult.evidence],
      telemetry: {
        durationMs: Date.now() - startedAt,
        requestsIssued: watchdogResult.telemetry.requestsIssued + fallbackResult.telemetry.requestsIssued,
        rowsRead: (watchdogResult.telemetry.rowsRead || 0) + (fallbackResult.telemetry.rowsRead || 0),
        traceSteps: [
          ...(watchdogResult.telemetry.traceSteps || []),
          ...(fallbackResult.telemetry.traceSteps || []),
        ],
      },
    };
  }

  private async collectWatchdogLogs(
    request: InvestigationAdapterRequest,
    startedAt: number,
    traceSteps: InvestigationAdapterTraceStep[],
  ): Promise<InvestigationAdapterResult> {
    if (process.env.INVESTIGATION_WATCHDOG_LOGS_ENABLED === "false") {
      return {
        findings: [],
        evidence: [],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 0,
          traceSteps,
        },
      };
    }

    const timeWindow = request.scope.timeWindow || defaultWatchdogTimeWindow();
    const querySpec = buildWatchdogQuerySpec(request.scope);
    const watchdogEnvironment = await this.resolveWatchdogEnvironment(request);

    try {
      traceSteps.push(makeTraceStep(request, "resolve_target", "Check Watchdog MCP health", "Validating Watchdog MCP before bounded CloudWatch search."));
      const health = await this.mcpCaller<WatchdogMcpResponse>("healthcheck", {});
      if (health.status && !["ok", "degraded"].includes(health.status)) {
        return this.unavailableResult(request, startedAt, traceSteps, `Watchdog MCP healthcheck returned ${health.status}.`);
      }

      traceSteps.push(makeTraceStep(request, "resolve_target", "Build Watchdog log scope", `Resolving ${request.scope.clientId} ${watchdogEnvironment} log scope through Watchdog.`));
      const scopeResponse = await this.mcpCaller<WatchdogMcpResponse>("build_investigation_scope", {
        session_id: request.runId,
        selected_client: request.scope.clientId,
        environment: watchdogEnvironment,
        start_ts: timeWindow.startTs,
        end_ts: timeWindow.endTs,
        jira_issue_key: request.jiraKey,
      });

      if (scopeResponse.status !== "ok" || !scopeResponse.scope) {
        return this.unavailableResult(
          request,
          startedAt,
          traceSteps,
          scopeResponse.message || "Watchdog MCP could not resolve a CloudWatch log scope for this client/environment.",
          scopeResponse,
        );
      }

      traceSteps.push(makeTraceStep(request, "execute_query", "Run Watchdog CloudWatch search", `Searching CloudWatch through Watchdog using ${querySpec.keywords.length + querySpec.exact_phrases.length || querySpec.severity.length} bounded signal(s).`));
      const search = await this.mcpCaller<WatchdogMcpSearchBundle>("search_logs_by_client", {
        scope: scopeResponse.scope,
        query_spec: querySpec,
      });

      if (search.status && search.status !== "ok") {
        return this.unavailableResult(
          request,
          startedAt,
          traceSteps,
          search.message || `Watchdog MCP search returned ${search.status}.`,
          search,
        );
      }

      return this.searchResult(request, search, querySpec, timeWindow, traceSteps, startedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.unavailableResult(request, startedAt, traceSteps, message);
    }
  }

  private async resolveWatchdogEnvironment(request: InvestigationAdapterRequest): Promise<string> {
    if (!this.hostRegistry) return request.scope.environment;

    const target = await this.hostRegistry.resolveTarget(
      request.scope.clientId,
      request.scope.environment,
      request.scope.hostTargets?.[0],
    );

    return target?.envId || request.scope.environment;
  }

  private unavailableResult(
    request: InvestigationAdapterRequest,
    startedAt: number,
    traceSteps: InvestigationAdapterTraceStep[],
    reason: string,
    metadata?: Record<string, unknown>,
  ): InvestigationAdapterResult {
    const evidenceId = `${request.runId}-watchdog-log-unavailable`;
    const normalizedReason = normalizeWatchdogUnavailableReason(reason);
    return {
      findings: [{
        id: `${request.runId}-watchdog-log-scope-unavailable`,
        adapter: "host",
        type: "watchdog_log_scope_unavailable",
        severity: "info",
        confidence: 0.35,
        title: "Watchdog CloudWatch log evidence is not available for this run",
        summary: normalizedReason,
        evidenceRefs: [evidenceId],
        requiresCodeChange: false,
        requiresDataChange: false,
      }],
      evidence: [{
        id: evidenceId,
        adapter: "host",
        title: "Watchdog CloudWatch search not completed",
        summary: normalizedReason,
        contentType: "application/json",
        metadata: {
          ...metadata,
          rawReason: reason,
          traceSteps: traceSteps.map(toEvidenceTraceStep),
        },
      }],
      telemetry: {
        durationMs: Date.now() - startedAt,
        requestsIssued: traceSteps.length,
        traceSteps,
      },
    };
  }

  private searchResult(
    request: InvestigationAdapterRequest,
    search: WatchdogMcpSearchBundle,
    querySpec: ReturnType<typeof buildWatchdogQuerySpec>,
    timeWindow: InvestigationScope["timeWindow"],
    traceSteps: InvestigationAdapterTraceStep[],
    startedAt: number,
  ): InvestigationAdapterResult {
    const evidenceId = `${request.runId}-watchdog-log-evidence`;
    const totalMatches = Number(search.summary_counts?.total_matches || 0);
    const samples = normalizeWatchdogSamples(search.top_samples || []);
    const finding = buildWatchdogLogFinding({
      request,
      evidenceId,
      search,
      samples,
      totalMatches,
    });

    return {
      findings: [finding],
      evidence: [{
        id: evidenceId,
        adapter: "host",
        title: "Watchdog CloudWatch log search",
        summary: summarizeWatchdogSearch(search),
        contentType: "application/json",
        metadata: {
          searchId: search.search_id,
          querySpec,
          timeWindow,
          summaryCounts: search.summary_counts || {},
          warnings: search.warnings || [],
          redactedSamples: samples.slice(0, 12),
          traceSteps: traceSteps.map(toEvidenceTraceStep),
        },
      }],
      telemetry: {
        durationMs: Date.now() - startedAt,
        requestsIssued: 3,
        artifactsStored: samples.length,
        traceSteps,
      },
    };
  }
}

export class DashboardCloudWatchLogInspectionAdapter implements HostInspectionAdapter {
  readonly kind = "host" as const;

  constructor(
    private readonly hostRegistry: InvestigationHostTargetRegistry,
    private readonly runnerFactory: (target: InvestigationHostTarget) => AwsCliCommandRunner = target => new ProfileAwsCliCommandRunner(target.awsProfile),
  ) {}

  async execute(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    const startedAt = Date.now();
    const traceSteps: InvestigationAdapterTraceStep[] = [];
    if (process.env.INVESTIGATION_CLOUDWATCH_LOGS_ENABLED === "false") {
      return emptyHostResult(startedAt, traceSteps);
    }

    const target = await this.hostRegistry.resolveTarget(
      request.scope.clientId,
      request.scope.environment,
      request.scope.hostTargets?.[0],
    );
    traceSteps.push(traceStep({
      request,
      idSuffix: "cloudwatch-resolve-target",
      phase: "resolve_target",
      title: "Resolve CloudWatch scope target",
      detail: target
        ? `Resolved ${target.instanceName} for ${request.scope.clientId} ${target.envId}.`
        : `No approved host target exists for ${request.scope.clientId} ${request.scope.environment}.`,
    }));

    if (!target) return emptyHostResult(startedAt, traceSteps);

    const runner = this.runnerFactory(target);
    const logGroupPrefix = `/CP/${request.scope.clientId}/${target.envId}`;
    const maxGroups = Number(process.env.INVESTIGATION_CLOUDWATCH_MAX_GROUPS || "8");
    const terms = runtimeSearchTerms(request.scope);

    try {
      const configuredSelection = await resolveConfiguredCloudWatchLogGroups({
        target,
        scope: request.scope,
        runner,
        maxGroups,
      });
      let selectedGroups = configuredSelection.groups;
      let describeRequests = configuredSelection.describeRequests;
      let selectionDetail = configuredSelection.configured
        ? `Selected ${selectedGroups.length} group(s) from configured CloudWatch scope(s) ${configuredSelection.scopeIds.join(", ") || "none"}: ${summarizeLogGroups(selectedGroups)}.`
        : "";

      if (!configuredSelection.configured) {
        const candidatePrefixes = cloudWatchCandidatePrefixes(logGroupPrefix, request.scope);
        const groups = await runner.runJson<CloudWatchDescribeLogGroupsResponse>([
          "logs",
          "describe-log-groups",
          "--region",
          target.region,
          "--log-group-name-prefix",
          logGroupPrefix,
          "--limit",
          "50",
        ]);
        const candidateGroupResponses = await Promise.all(candidatePrefixes.map((candidatePrefix) =>
          runner.runJson<CloudWatchDescribeLogGroupsResponse>([
            "logs",
            "describe-log-groups",
            "--region",
            target.region,
            "--log-group-name-prefix",
            candidatePrefix,
            "--limit",
            "10",
          ]),
        ));
        describeRequests = 1 + candidatePrefixes.length;
        const allGroupNames = [
          ...candidateGroupResponses.flatMap((response) => response.logGroups || []),
          ...(groups.logGroups || []),
        ]
          .map((group) => group.logGroupName)
          .filter((entry): entry is string => Boolean(entry));
        selectedGroups = selectCloudWatchLogGroups(allGroupNames, request.scope, maxGroups, target.region);
        selectionDetail = `Selected ${selectedGroups.length} group(s) from legacy prefix ${logGroupPrefix}: ${summarizeLogGroups(selectedGroups)}.`;
      }

      traceSteps.push(traceStep({
        request,
        idSuffix: "cloudwatch-select-groups",
        phase: "select_query_pack",
        title: "Select bounded CloudWatch log groups",
        detail: selectionDetail,
        rowCount: selectedGroups.length,
      }));

      const samples: RuntimeLogSample[] = [];
      for (const logGroup of selectedGroups) {
        for (const term of terms.slice(0, 4)) {
          const response = await runner.runJson<CloudWatchFilterLogEventsResponse>([
            "logs",
            "filter-log-events",
            "--region",
            logGroup.region,
            "--log-group-name",
            logGroup.name,
            "--start-time",
            String(timeWindowStartMs(request.scope)),
            "--end-time",
            String(timeWindowEndMs(request.scope)),
            "--filter-pattern",
            `"${term.replace(/"/g, "")}"`,
            "--limit",
            "20",
          ]);
          for (const event of response.events || []) {
            if (!event.message?.trim()) continue;
            samples.push({
              source: "cloudwatch",
              timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : undefined,
              location: logGroup.name,
              stream: event.logStreamName,
              message: redactRuntimeLogLine(event.message),
            });
          }
          if (samples.length >= (request.constraints.maxArtifacts || 20)) break;
        }
        if (samples.length >= (request.constraints.maxArtifacts || 20)) break;
      }

      traceSteps.push(traceStep({
        request,
        idSuffix: "cloudwatch-search",
        phase: "execute_query",
        title: "Search CloudWatch runtime logs",
        detail: `Searched ${selectedGroups.length} group(s) using ${Math.min(terms.length, 4)} term(s): ${summarizeLogGroups(selectedGroups)}.`,
        rowCount: samples.length,
      }));

      const evidenceId = `${request.runId}-cloudwatch-runtime-log-evidence`;
      return {
        findings: [buildRuntimeLogFinding({ request, evidenceId, samples, source: "cloudwatch" })],
        evidence: [runtimeLogEvidenceArtifact({
          request,
          source: "cloudwatch",
          title: "CloudWatch runtime log search",
          summary: `CloudWatch searched ${selectedGroups.length} approved log group(s) and returned ${samples.length} redacted sample(s).`,
          samples,
          traceSteps,
          metadata: {
            ...hostTargetEvidenceMetadata(target),
            logGroupPrefix,
            configuredScopesUsed: configuredSelection.configured,
            selectedGroups: selectedGroups.map((group) => group.name),
            selectedGroupRegions: Object.fromEntries(selectedGroups.map((group) => [group.name, group.region])),
            timeWindow: runtimeTimeWindow(request.scope),
            searchTerms: terms.slice(0, 4),
          },
        })],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: describeRequests + (selectedGroups.length * Math.min(terms.length, 4)),
          artifactsStored: samples.length,
          traceSteps,
        },
      };
    } catch (error) {
      const message = sanitizeRuntimeUnavailableReason(error instanceof Error ? error.message : String(error), "cloudwatch");
      const evidenceId = `${request.runId}-cloudwatch-runtime-log-unavailable`;
      return {
        findings: [{
          id: `${request.runId}-cloudwatch-log-unavailable`,
          adapter: "host",
          type: "cloudwatch_log_unavailable",
          severity: "info",
          confidence: 0.35,
          title: "CloudWatch runtime log search is not available for this run",
          summary: message,
          evidenceRefs: [evidenceId],
          requiresCodeChange: false,
          requiresDataChange: false,
        }],
        evidence: [runtimeLogEvidenceArtifact({
          request,
          source: "cloudwatch",
          title: "CloudWatch runtime log search not completed",
          summary: message,
          samples: [],
          traceSteps,
          metadata: hostTargetEvidenceMetadata(target),
        })],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: traceSteps.length,
          traceSteps,
        },
      };
    }
  }
}

export class DashboardSsmFileLogInspectionAdapter implements HostInspectionAdapter {
  readonly kind = "host" as const;

  constructor(
    private readonly hostRegistry: InvestigationHostTargetRegistry,
    private readonly runnerFactory: (target: InvestigationHostTarget) => AwsCliCommandRunner = target => new ProfileAwsCliCommandRunner(target.awsProfile),
  ) {}

  async execute(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    const startedAt = Date.now();
    const traceSteps: InvestigationAdapterTraceStep[] = [];
    if (process.env.INVESTIGATION_SSM_FILE_LOGS_ENABLED === "false") {
      return emptyHostResult(startedAt, traceSteps);
    }

    const target = await this.hostRegistry.resolveTarget(
      request.scope.clientId,
      request.scope.environment,
      request.scope.hostTargets?.[0],
    );
    traceSteps.push(traceStep({
      request,
      idSuffix: "ssm-file-resolve-target",
      phase: "resolve_target",
      title: "Resolve SSM file-log target",
      detail: target
        ? `Resolved ${target.instanceName} (${target.instanceId}) for bounded file-log search.`
        : `No approved SSM host target exists for ${request.scope.clientId} ${request.scope.environment}.`,
    }));

    if (!target || !target.ssmAllowed) {
      return emptyHostResult(startedAt, traceSteps);
    }

    const runner = this.runnerFactory(target);
    const script = buildSsmFileLogScript(request, target);

    try {
      const send = await runner.runJson<SsmSendCommandResponse>([
        "ssm",
        "send-command",
        "--region",
        target.region,
        "--instance-ids",
        target.instanceId,
        "--document-name",
        "AWS-RunShellScript",
        "--comment",
        `Investigation Cockpit file-log search ${request.runId}`,
        "--parameters",
        JSON.stringify({ commands: [script], executionTimeout: ["60"] }),
      ]);
      const commandId = send.Command?.CommandId;
      if (!commandId) throw new Error("SSM send-command did not return a command id.");

      traceSteps.push(traceStep({
        request,
        idSuffix: "ssm-file-command-sent",
        phase: "execute_query",
        title: "Run bounded SSM file-log command",
        detail: `Sent AWS-RunShellScript command ${commandId} to ${target.instanceId}.`,
      }));

      const invocation = await pollSsmInvocation(runner, target, commandId);
      const samples = parseSsmFileLogOutput(invocation.StandardOutputContent || "", request);
      const stderr = (invocation.StandardErrorContent || "").trim();
      const evidenceId = `${request.runId}-ssm-file-runtime-log-evidence`;

      traceSteps.push(traceStep({
        request,
        idSuffix: "ssm-file-parse-output",
        phase: "redact_results",
        title: "Redact SSM file-log output",
        detail: `Parsed and redacted ${samples.length} matching file-log sample(s).`,
        rowCount: samples.length,
      }));

      return {
        findings: [buildRuntimeLogFinding({ request, evidenceId, samples, source: "ssm_file" })],
        evidence: [runtimeLogEvidenceArtifact({
          request,
          source: "ssm_file",
          title: "SSM file-log runtime search",
          summary: `SSM searched approved host log roots on ${target.instanceName} and returned ${samples.length} redacted sample(s).`,
          samples,
          traceSteps,
          metadata: {
            ...hostTargetEvidenceMetadata(target),
            commandId,
            timeWindow: runtimeTimeWindow(request.scope),
            dateToken: timeWindowDateToken(request.scope),
            logRoots: runtimeLogRoots(target),
            stderr: stderr ? redactRuntimeLogLine(stderr).slice(0, 1_500) : undefined,
          },
        })],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 2,
          artifactsStored: samples.length,
          traceSteps,
        },
      };
    } catch (error) {
      const message = sanitizeRuntimeUnavailableReason(error instanceof Error ? error.message : String(error), "ssm_file");
      const evidenceId = `${request.runId}-ssm-file-runtime-log-unavailable`;
      return {
        findings: [{
          id: `${request.runId}-ssm-file-log-unavailable`,
          adapter: "host",
          type: "ssm_file_log_unavailable",
          severity: "info",
          confidence: 0.35,
          title: "SSM file-log search is not available for this run",
          summary: message,
          evidenceRefs: [evidenceId],
          requiresCodeChange: false,
          requiresDataChange: false,
        }],
        evidence: [runtimeLogEvidenceArtifact({
          request,
          source: "ssm_file",
          title: "SSM file-log runtime search not completed",
          summary: message,
          samples: [],
          traceSteps,
          metadata: hostTargetEvidenceMetadata(target),
        })],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: traceSteps.length,
          traceSteps,
        },
      };
    }
  }
}

export class DashboardS3ArchivedLogInspectionAdapter implements HostInspectionAdapter {
  readonly kind = "host" as const;

  constructor(
    private readonly hostRegistry: InvestigationHostTargetRegistry,
    private readonly runnerFactory: (target: InvestigationHostTarget) => AwsCliCommandRunner = target => new ProfileAwsCliCommandRunner(target.awsProfile),
  ) {}

  async execute(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    const startedAt = Date.now();
    const traceSteps: InvestigationAdapterTraceStep[] = [];
    if (process.env.INVESTIGATION_S3_ARCHIVE_LOGS_ENABLED === "false") {
      return emptyHostResult(startedAt, traceSteps);
    }

    const target = await this.hostRegistry.resolveTarget(
      request.scope.clientId,
      request.scope.environment,
      request.scope.hostTargets?.[0],
    );
    if (!target?.s3LogArchives?.length) {
      return emptyHostResult(startedAt, traceSteps);
    }

    const runner = this.runnerFactory(target);
    const archive = target.s3LogArchives[0];
    const dateToken = timeWindowDateToken(request.scope);
    const prefix = renderS3PrefixTemplate(archive.prefixTemplate || "{clientId}/{envId}/{date}/", {
      clientId: request.scope.clientId,
      envId: target.envId,
      date: dateToken,
    });

    traceSteps.push(traceStep({
      request,
      idSuffix: "s3-archive-resolve",
      phase: "resolve_target",
      title: "Resolve S3 archived-log scope",
      detail: `Resolved s3://${archive.bucket}/${prefix} for archived runtime-log fallback.`,
    }));

    try {
      const listed = await runner.runJson<S3ListObjectsV2Response>([
        "s3api",
        "list-objects-v2",
        "--region",
        archive.region || target.region,
        "--bucket",
        archive.bucket,
        "--prefix",
        prefix,
        "--max-keys",
        "50",
      ]);
      const componentTerms = runtimeComponentTerms(request.scope).map((term) => term.toLowerCase());
      const maxObjectBytes = Math.max(1, Math.min(
        100 * 1024 * 1024,
        Number(process.env.INVESTIGATION_S3_ARCHIVE_MAX_OBJECT_BYTES || `${20 * 1024 * 1024}`),
      ));
      const keys = (listed.Contents || [])
        .filter((entry) => Boolean(entry.Key))
        .filter((entry) => entry.Size === undefined || entry.Size <= maxObjectBytes)
        .map((entry) => entry.Key)
        .filter((entry): entry is string => Boolean(entry))
        .filter(isRuntimeLogObjectKey)
        .filter((key) => componentTerms.length === 0 || componentTerms.some((term) => key.toLowerCase().includes(term)))
        .slice(0, Number(process.env.INVESTIGATION_S3_ARCHIVE_MAX_OBJECTS || "5"));
      const pattern = new RegExp(runtimeSearchTerms(request.scope).map(regexEscape).join("|"), "i");
      const samples: RuntimeLogSample[] = [];

      for (const key of keys) {
        const body = await readS3RuntimeLogObject({
          runner,
          bucket: archive.bucket,
          key,
          region: archive.region || target.region,
          maxBuffer: maxObjectBytes,
        });
        for (const line of body.split(/\r?\n/)) {
          if (!pattern.test(line)) continue;
          samples.push({
            source: "s3_archive",
            location: `s3://${archive.bucket}/${key}`,
            message: redactRuntimeLogLine(line),
          });
          if (samples.length >= (request.constraints.maxArtifacts || 20)) break;
        }
        if (samples.length >= (request.constraints.maxArtifacts || 20)) break;
      }

      const evidenceId = `${request.runId}-s3-archive-runtime-log-evidence`;
      return {
        findings: [buildRuntimeLogFinding({ request, evidenceId, samples, source: "s3_archive" })],
        evidence: [runtimeLogEvidenceArtifact({
          request,
          source: "s3_archive",
          title: "S3 archived runtime-log search",
          summary: `S3 archived-log fallback searched ${keys.length} object(s) and returned ${samples.length} redacted sample(s).`,
          samples,
          traceSteps,
          metadata: {
            ...hostTargetEvidenceMetadata(target),
            bucket: archive.bucket,
            prefix,
            keys,
            timeWindow: runtimeTimeWindow(request.scope),
          },
        })],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 1 + keys.length,
          artifactsStored: samples.length,
          traceSteps,
        },
      };
    } catch (error) {
      const message = sanitizeRuntimeUnavailableReason(error instanceof Error ? error.message : String(error), "s3_archive");
      const evidenceId = `${request.runId}-s3-archive-runtime-log-unavailable`;
      return {
        findings: [{
          id: `${request.runId}-s3-archive-log-unavailable`,
          adapter: "host",
          type: "s3_archive_log_unavailable",
          severity: "info",
          confidence: 0.35,
          title: "S3 archived-log search is not available for this run",
          summary: message,
          evidenceRefs: [evidenceId],
          requiresCodeChange: false,
          requiresDataChange: false,
        }],
        evidence: [runtimeLogEvidenceArtifact({
          request,
          source: "s3_archive",
          title: "S3 archived runtime-log search not completed",
          summary: message,
          samples: [],
          traceSteps,
          metadata: hostTargetEvidenceMetadata(target),
        })],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: traceSteps.length,
          traceSteps,
        },
      };
    }
  }
}

export class DashboardSshConfigInspectionAdapter implements HostInspectionAdapter {
  readonly kind = "host" as const;

  constructor(
    private readonly hostRegistry: InvestigationHostTargetRegistry,
    private readonly runner: SshCommandRunner = new CliSshCommandRunner(),
  ) {}

  async execute(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    const startedAt = Date.now();
    const traceSteps: InvestigationAdapterTraceStep[] = [];
    if (process.env.INVESTIGATION_SSH_CONFIG_PROBE_ENABLED === "false") {
      return emptyHostResult(startedAt, traceSteps);
    }

    const target = await this.hostRegistry.resolveTarget(
      request.scope.clientId,
      request.scope.environment,
      request.scope.hostTargets?.[0],
    );
    traceSteps.push(traceStep({
      request,
      idSuffix: "ssh-config-resolve-target",
      phase: "resolve_target",
      title: "Resolve LDAP SSH config target",
      detail: target
        ? `Resolved ${target.instanceName} (${target.id}) for bounded deployed jar/properties search.`
        : `No approved SSH host target exists for ${request.scope.clientId} ${request.scope.environment}.`,
    }));

    if (!target) {
      return emptyHostResult(startedAt, traceSteps);
    }
    if (target.networkPath !== "ssh_public" || !target.sshAllowed) {
      traceSteps.push(traceStep({
        request,
        idSuffix: "ssh-config-skip",
        phase: "resolve_target",
        title: "LDAP SSH config probe not approved",
        detail: `Target ${target.id} is registered with networkPath=${target.networkPath}; sshAllowed=${Boolean(target.sshAllowed)}.`,
      }));
      return emptyHostResult(startedAt, traceSteps);
    }

    const script = buildSshConfigProbeScript(request, target);

    try {
      traceSteps.push(traceStep({
        request,
        idSuffix: "ssh-config-command",
        phase: "execute_query",
        title: "Run bounded LDAP SSH deployed jar/properties search",
        detail: `Searching ${sshConfigProbeRoots(target).length} approved config root(s) on ${target.instanceName} using operator LDAP SSH authentication.`,
      }));

      const output = await this.runner.runText(target, script, {
        maxBuffer: 1024 * 1024 * 4,
        timeoutMs: Math.min(request.constraints.timeoutMs, Number(process.env.INVESTIGATION_SSH_CONFIG_TIMEOUT_MS || "45000")),
      });
      const parsed = parseSshConfigProbeOutput(output, request);
      const evidenceId = `${request.runId}-ssh-config-evidence`;

      traceSteps.push(traceStep({
        request,
        idSuffix: "ssh-config-redact",
        phase: "redact_results",
        title: "Redact deployed jar/properties evidence",
        detail: `Parsed ${parsed.files.length} deployed jar/properties candidate(s) and ${parsed.samples.length} redacted manifest/config line sample(s).`,
        rowCount: parsed.samples.length,
      }));

      return {
        findings: [buildSshConfigFinding({
          request,
          evidenceId,
          target,
          files: parsed.files,
          samples: parsed.samples,
        })],
        evidence: [sshConfigEvidenceArtifact({
          request,
          target,
          files: parsed.files,
          samples: parsed.samples,
          traceSteps,
        })],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 1,
          rowsRead: parsed.samples.length,
          artifactsStored: parsed.files.length,
          traceSteps,
        },
      };
    } catch (error) {
      const message = sanitizeSshConfigUnavailableReason(error instanceof Error ? error.message : String(error));
      const evidenceId = `${request.runId}-ssh-config-unavailable`;
      const candidates = configProbeCandidateMetadata(request.scope);
      return {
        findings: [{
          id: `${request.runId}-ssh-config-unavailable`,
          adapter: "host",
          type: "ssh_config_unavailable",
          severity: "high",
          confidence: 0.35,
          title: "LDAP SSH deployed jar/properties probe is not available for this run",
          summary: message,
          evidenceRefs: [evidenceId],
          requiresCodeChange: false,
          requiresDataChange: false,
          metadata: {
            targetId: target.id,
            sshAuthMode: target.sshAuthMode,
          },
        }],
        evidence: [{
          id: evidenceId,
          adapter: "host",
          title: "LDAP SSH deployed jar/properties probe not completed",
          summary: message,
          contentType: "application/json",
          metadata: {
            targetId: target.id,
            instanceId: target.instanceId,
            sshAuthMode: target.sshAuthMode,
            probeRoots: sshConfigProbeRoots(target),
            searchTerms: candidates.searchTerms,
            exactFileNames: candidates.exactFileNames,
            exactDirectories: candidates.exactDirectories,
            exactPaths: candidates.exactPaths,
            traceSteps: traceSteps.map(toEvidenceTraceStep),
          },
        }],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 1,
          traceSteps,
        },
      };
    }
  }
}

export class DashboardRuntimeLogInspectionAdapter implements HostInspectionAdapter {
  readonly kind = "host" as const;

  constructor(
    private readonly cloudWatch: HostInspectionAdapter,
    private readonly ssmFile: HostInspectionAdapter,
    private readonly s3Archive: HostInspectionAdapter,
    private readonly sshConfig?: HostInspectionAdapter,
    private readonly posture?: HostInspectionAdapter,
  ) {}

  async execute(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    const startedAt = Date.now();
    const results: InvestigationAdapterResult[] = [];

    if (process.env.INVESTIGATION_CLOUDWATCH_LOGS_ENABLED !== "false") {
      results.push(await this.cloudWatch.execute(request));
    }
    if (!hasPositiveRuntimeLogEvidence(results) && process.env.INVESTIGATION_SSM_FILE_LOGS_ENABLED !== "false") {
      results.push(await this.ssmFile.execute(request));
    }
    if (!hasPositiveRuntimeLogEvidence(results) && process.env.INVESTIGATION_S3_ARCHIVE_LOGS_ENABLED !== "false") {
      results.push(await this.s3Archive.execute(request));
    }
    if (this.sshConfig && process.env.INVESTIGATION_SSH_CONFIG_PROBE_ENABLED !== "false") {
      results.push(await this.sshConfig.execute(request));
    }
    if (this.posture && request.scope.hostTargets?.length !== 0 && process.env.INVESTIGATION_HOST_SSM_POSTURE_ENABLED !== "false") {
      results.push(await this.posture.execute(request));
    }

    return mergeHostResults(results, Date.now() - startedAt);
  }

  async executeDeployedConfigOnly(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    const startedAt = Date.now();
    if (!this.sshConfig || process.env.INVESTIGATION_SSH_CONFIG_PROBE_ENABLED === "false") {
      return emptyHostResult(startedAt, []);
    }
    return mergeHostResults([await this.sshConfig.execute(request)], Date.now() - startedAt);
  }
}

function hasPositiveRuntimeLogEvidence(results: InvestigationAdapterResult[]): boolean {
  return results.some((result) =>
    result.findings.some((finding) =>
      finding.adapter === "host"
      && (
        finding.type === "cloudwatch_log_evidence"
        || finding.type === "ssm_file_log_evidence"
        || finding.type === "s3_archive_log_evidence"
        || finding.type === "watchdog_log_evidence"
      ),
    ),
  );
}

function mergeHostResults(results: InvestigationAdapterResult[], durationMs: number): InvestigationAdapterResult {
  return {
    findings: results.flatMap((result) => result.findings),
    evidence: results.flatMap((result) => result.evidence),
    telemetry: {
      durationMs,
      requestsIssued: results.reduce((sum, result) => sum + result.telemetry.requestsIssued, 0),
      rowsRead: results.reduce((sum, result) => sum + (result.telemetry.rowsRead || 0), 0),
      artifactsStored: results.reduce((sum, result) => sum + (result.telemetry.artifactsStored || 0), 0),
      traceSteps: results.flatMap((result) => result.telemetry.traceSteps || []),
    },
  };
}

function runtimeLogRoots(target: InvestigationHostTarget): string[] {
  const configured = process.env.INVESTIGATION_SSM_LOG_ROOTS?.split(",").map((entry) => entry.trim()).filter(Boolean);
  return configured?.length ? configured : target.logRoots?.length ? target.logRoots : ["/medhok/logs"];
}

function buildSsmFileLogScript(request: InvestigationAdapterRequest, target: InvestigationHostTarget): string {
  const roots = runtimeLogRoots(target);
  const dateToken = timeWindowDateToken(request.scope);
  const pattern = runtimeGrepPattern(request.scope);
  const fileHints = Array.from(new Set([
    dateToken,
    ...runtimeComponentTerms(request.scope),
  ].filter(Boolean)));
  const fileHintPattern = fileHints.map(regexEscape).join("|") || dateToken;
  const maxFiles = Math.max(1, Math.min(80, Number(process.env.INVESTIGATION_SSM_FILE_LOG_MAX_FILES || "40")));
  const maxMatches = Math.max(1, Math.min(300, Number(process.env.INVESTIGATION_SSM_FILE_LOG_MAX_MATCHES || "120")));

  return [
    "set -eu",
    `PATTERN=${shellQuote(pattern)}`,
    `FILE_HINT_PATTERN=${shellQuote(fileHintPattern)}`,
    `MAX_FILES=${maxFiles}`,
    `MAX_MATCHES=${maxMatches}`,
    "TMP_FILE=$(mktemp)",
    "trap 'rm -f \"$TMP_FILE\"' EXIT",
    "{",
    ...roots.map((root) => `[ -d ${shellQuote(root)} ] && find ${shellQuote(root)} -maxdepth 7 -type f \\( -name '*.log' -o -name '*.log.*' -o -name '*.gz' -o -name '*.zip' -o -name '*.txt' \\) 2>/dev/null || true`),
    "} | grep -Eai \"$FILE_HINT_PATTERN\" | head -n \"$MAX_FILES\" > \"$TMP_FILE\" || true",
    "COUNT=0",
    "while IFS= read -r FILE; do",
    "  [ -f \"$FILE\" ] || continue",
    "  echo \"###FILE:$FILE\"",
    "  case \"$FILE\" in",
    "    *.zip) unzip -p \"$FILE\" 2>/dev/null | grep -Eai -m 20 \"$PATTERN\" || true ;;",
    "    *.gz) zgrep -Eai -m 20 \"$PATTERN\" \"$FILE\" || true ;;",
    "    *) grep -Eai -m 20 \"$PATTERN\" \"$FILE\" || true ;;",
    "  esac",
    "  COUNT=$((COUNT + 1))",
    "  [ \"$COUNT\" -ge \"$MAX_FILES\" ] && break",
    "done < \"$TMP_FILE\" | head -n \"$MAX_MATCHES\"",
  ].join("\n");
}

async function pollSsmInvocation(
  runner: AwsCliCommandRunner,
  target: InvestigationHostTarget,
  commandId: string,
): Promise<SsmGetCommandInvocationResponse> {
  let last: SsmGetCommandInvocationResponse | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(attempt === 0 ? 500 : 1_500);
    last = await runner.runJson<SsmGetCommandInvocationResponse>([
      "ssm",
      "get-command-invocation",
      "--region",
      target.region,
      "--command-id",
      commandId,
      "--instance-id",
      target.instanceId,
    ]);
    const status = last.Status || "Unknown";
    if (["Success", "Cancelled", "TimedOut", "Failed", "Cancelling"].includes(status)) {
      if (status !== "Success") {
        throw new Error(`SSM file-log command ${commandId} ended with status ${status}: ${last.StandardErrorContent || ""}`.trim());
      }
      return last;
    }
  }
  throw new Error(`SSM file-log command ${commandId} did not finish before the polling timeout.`);
}

function parseSsmFileLogOutput(output: string, request: InvestigationAdapterRequest): RuntimeLogSample[] {
  const samples: RuntimeLogSample[] = [];
  let currentFile = "unknown";
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("###FILE:")) {
      currentFile = line.slice("###FILE:".length).trim() || currentFile;
      continue;
    }
    samples.push({
      source: "ssm_file",
      location: currentFile,
      message: redactRuntimeLogLine(line),
    });
    if (samples.length >= (request.constraints.maxArtifacts || 20)) break;
  }
  return samples;
}

function renderS3PrefixTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(clientId|envId|date)\}/g, (_match, key: string) => values[key] || "");
}

function isRuntimeLogObjectKey(key: string): boolean {
  return /\.(?:log|txt)(?:\.\d+)?$/i.test(key)
    || /\.(?:log|txt)(?:\.\d+)?\.(?:gz|zip)$/i.test(key)
    || /\.(?:gz|zip)$/i.test(key);
}

async function readS3RuntimeLogObject(input: {
  runner: AwsCliCommandRunner;
  bucket: string;
  key: string;
  region: string;
  maxBuffer: number;
}): Promise<string> {
  const s3Uri = `s3://${input.bucket}/${input.key}`;
  const args = [
    "s3",
    "cp",
    s3Uri,
    "-",
    "--region",
    input.region,
  ];

  if (/\.gz$/i.test(input.key)) {
    if (!input.runner.runBuffer) {
      throw new Error("S3 archived-log gzip reads require binary AWS runner support.");
    }
    return gunzipSync(await input.runner.runBuffer(args, { maxBuffer: input.maxBuffer })).toString("utf8");
  }

  if (/\.zip$/i.test(input.key)) {
    if (!input.runner.runBuffer) {
      throw new Error("S3 archived-log zip reads require binary AWS runner support.");
    }
    const dir = await mkdtemp(join(tmpdir(), "investigation-s3-log-"));
    const archivePath = join(dir, "archive.zip");
    try {
      await writeFile(archivePath, await input.runner.runBuffer(args, { maxBuffer: input.maxBuffer }));
      const { stdout } = await execFileAsync("unzip", ["-p", archivePath], {
        maxBuffer: input.maxBuffer,
      });
      return stdout;
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }

  return input.runner.runText(args, { maxBuffer: input.maxBuffer });
}

export class DashboardMysqlDataDiagnosticsAdapter implements DataDiagnosticsAdapter {
  readonly kind = "data" as const;

  constructor(
    private readonly connectionRegistry: InvestigationConnectionRegistry,
    private readonly hostTargetRegistry?: InvestigationHostTargetRegistry,
    private readonly queryPackRegistry = new QueryPackRegistry(),
    private readonly queryValidator = new QueryValidator(),
    private readonly phiGuard = new PhiGuard(),
    private readonly secretResolver: SecretResolver = new DefaultSecretResolver(),
    private readonly connectionFactory: typeof mysql.createConnection = mysql.createConnection,
  ) {}

  async execute(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    const startedAt = Date.now();
    const traceSteps: InvestigationAdapterTraceStep[] = [];

    const target = await this.connectionRegistry.resolveTarget(
      request.scope.clientId,
      request.scope.environment,
    );

    traceSteps.push({
      id: `${request.runId}-data-resolve`,
      adapter: "data",
      phase: "resolve_target",
      title: "Resolve approved DB target",
      detail: target
        ? `Resolved ${target.topology} target ${target.id} for ${request.scope.clientId} ${request.scope.environment}.`
        : `No approved DB target exists for ${request.scope.clientId} ${request.scope.environment}.`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      connectionTargetId: target?.id,
    });

    if (!target) {
      return this.emptyResult(startedAt, traceSteps);
    }

    const configuredPack = target.allowedQueryPacks
      .map((packId) => this.queryPackRegistry.getById(packId))
      .find((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate && candidate.environments.includes(request.scope.environment)));
    const codeDerivedPack = configuredPack ? null : planCodeDerivedDiagnostic(request.scope);
    const pack = configuredPack ?? codeDerivedPack;
    const packSource = configuredPack ? "configured" : codeDerivedPack ? "code-derived" : null;

    traceSteps.push({
      id: `${request.runId}-data-pack`,
      adapter: "data",
      phase: "select_query_pack",
      title: "Select read-only DB diagnostic path",
      detail: pack
        ? `Selected ${packSource} read-only diagnostic ${pack.id} for ${target.id}.`
        : `No configured query pack is available for ${target.id}; code-flow diagnostics may run if code and ticket anchors are available.`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      queryPackId: pack?.id,
      connectionTargetId: target.id,
    });

    if (!pack) {
      if (!hasAnchorDrivenProbeScope(request.scope)) {
        return this.emptyResult(startedAt, traceSteps);
      }
    }

    if (!pack && target.topology === "ec2_mysql" && target.hostTargetId && target.hostAuthFile) {
      traceSteps.push({
        id: `${request.runId}-data-code-flow-ssm-skip`,
        adapter: "data",
        phase: "select_query_pack",
        title: "Code-flow data probe requires direct MySQL session",
        detail: `Target ${target.id} is configured for host-side SSM credentials; code-flow probes require the operator/direct MySQL credential path in this PR.`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        connectionTargetId: target.id,
      });
      return this.emptyResult(startedAt, traceSteps);
    }

    const validation = pack ? this.queryValidator.validate(pack) : null;
    if (pack && validation) {
      traceSteps.push({
        id: `${request.runId}-data-validate`,
        adapter: "data",
        phase: "validate_query",
        title: "Validate approved SQL",
        detail: validation.valid
          ? `Validated ${pack.id} against the query guardrails.`
          : `Validation failed for ${pack.id}: ${validation.reasons.join("; ")}`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        queryPackId: pack.id,
        connectionTargetId: target.id,
        safeSql: pack.sql,
      });
    }

    if (pack && validation && !validation.valid) {
      return {
        findings: [{
          id: `${request.runId}-data-pack-invalid`,
          adapter: "data",
          type: "query_pack_invalid",
          severity: "critical",
          confidence: 0.2,
          title: "Approved data diagnostic pack failed validation",
          summary: validation.reasons.join("; "),
          evidenceRefs: [],
          requiresCodeChange: false,
          requiresDataChange: false,
        }],
        evidence: [],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 0,
          rowsRead: 0,
          traceSteps,
        },
      };
    }

    if (pack && target.topology === "ec2_mysql" && target.hostTargetId && target.hostAuthFile) {
      if (requireOperatorDbCredentials() || !allowTargetSecretDbCredentials()) {
        traceSteps.push({
          id: `${request.runId}-data-secret`,
          adapter: "data",
          phase: "load_secret",
          title: "Reject host-side DB auth source",
          detail: "Operator DB credential mode is the default; host-side shared auth sources require separate explicit approval.",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          connectionTargetId: target.id,
        });
        return this.dataAccessFailure(
          request.runId,
          "Operator database credential mode blocked host-side DB diagnostics",
          new Error("SSM host-side DB auth cannot attribute the diagnostic query to the operator LDAP identity."),
          startedAt,
          traceSteps,
        );
      }

      traceSteps.push({
        id: `${request.runId}-data-secret`,
        adapter: "data",
        phase: "load_secret",
        title: "Load approved host DB auth source",
        detail: "Using an approved host-side DB auth source for the bounded diagnostic query.",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        connectionTargetId: target.id,
      });
      try {
        return await this.executeViaSsmHost(request, target, withReadOnlySqlPrefix(pack.sql), pack.id, traceSteps, startedAt);
      } catch (error) {
        return this.dataAccessFailure(
          request.runId,
          "SSM-backed database diagnostic could not complete the bounded query",
          error,
          startedAt,
          traceSteps,
        );
      }
    }

    let credentials: DbCredentialMaterial | null;
    try {
      credentials = await this.resolveDbCredentialMaterial(target);
    } catch (error) {
      traceSteps.push({
        id: `${request.runId}-data-secret`,
        adapter: "data",
        phase: "load_secret",
        title: "Load operator DB credential",
        detail: "Operator DB credential mode is enabled, but runtime credentials were not supplied.",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        connectionTargetId: target.id,
      });
      return this.dataAccessFailure(
        request.runId,
        "Operator database credential mode is not configured",
        error,
        startedAt,
        traceSteps,
      );
    }

    traceSteps.push({
      id: `${request.runId}-data-secret`,
      adapter: "data",
      phase: "load_secret",
      title: "Load DB credential",
      detail: credentials
        ? this.describeCredentialSource(credentials)
        : `DB credential is not configured yet for target ${target.id}.`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      connectionTargetId: target.id,
    });

    if (!credentials) {
      return {
        findings: [],
        evidence: [{
          id: `${request.runId}-data-config-pending`,
          adapter: "data",
          title: "Approved data path is configured but credentials are not loaded",
          summary: `Target ${target.id} (${target.topology}) is registered, but the read-only DB password is not configured in this runtime.`,
          contentType: "text/plain",
          metadata: {
            topology: target.topology,
            traceSteps: this.toEvidenceTrace(traceSteps),
          },
        }],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 0,
          rowsRead: 0,
          traceSteps,
        },
      };
    }

    let connection: mysql.Connection | null = null;
    try {
      connection = await this.connectionFactory({
        host: target.host,
        port: target.port,
        user: credentials.username,
        password: credentials.password,
        database: credentials.database,
        ssl: dbSslOptions(target),
        connectTimeout: pack?.timeoutMs || 5_000,
      });
      await enforceReadonlyMysqlSession(connection, target.id);

      traceSteps.push({
        id: `${request.runId}-data-open`,
        adapter: "data",
        phase: "open_connection",
        title: "Open read-only DB session",
        detail: `Opened a read-only ${target.topology} MySQL session for the approved target.`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        connectionTargetId: target.id,
      });

      await this.enforceReadOnlySession(request, target, connection, traceSteps, pack?.id);

      if (!pack) {
        return await this.executeAnchorDrivenProbe(request, target, connection, traceSteps, startedAt);
      }

      const [rows] = await connection.query<RowDataPacket[]>(pack.sql);
      const redactedRows = this.phiGuard.redactRows(rows as Array<Record<string, unknown>>);

      traceSteps.push({
        id: `${request.runId}-data-exec`,
        adapter: "data",
        phase: "execute_query",
        title: "Execute approved data diagnostic",
        detail: `Executed ${pack.id} against ${target.topology}.`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        queryPackId: pack.id,
        connectionTargetId: target.id,
        safeSql: pack.sql,
        rowCount: redactedRows.length,
      });

      traceSteps.push({
        id: `${request.runId}-data-redact`,
        adapter: "data",
        phase: "redact_results",
        title: "Redact diagnostic output",
        detail: `Applied PHI redaction rules to ${redactedRows.length} rows.`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        queryPackId: pack.id,
        connectionTargetId: target.id,
        rowCount: redactedRows.length,
      });

      return this.buildSuccessResult(request, target, pack.id, redactedRows, traceSteps, startedAt);
    } catch (error) {
      return this.dataAccessFailure(
        request.runId,
        "Approved database path could not complete the bounded query",
        error,
        startedAt,
        traceSteps,
      );
    } finally {
      if (connection) {
        await connection.end();
        traceSteps.push({
          id: `${request.runId}-data-close`,
          adapter: "data",
          phase: "close_connection",
          title: "Close DB session",
          detail: `Closed the MySQL session for ${target.id}.`,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          connectionTargetId: target.id,
        });
      }
    }
  }

  private async enforceReadOnlySession(
    request: InvestigationAdapterRequest,
    target: InvestigationConnectionTarget,
    connection: mysql.Connection,
    traceSteps: InvestigationAdapterTraceStep[],
    queryPackId?: string,
  ): Promise<void> {
    void connection;
    traceSteps.push({
      id: `${request.runId}-data-readonly`,
      adapter: "data",
      phase: "validate_query",
      title: "Verify MySQL read-only session",
      detail: "SET SESSION transaction_read_only=ON was applied and verified before diagnostic SQL.",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      queryPackId,
      connectionTargetId: target.id,
      safeSql: "SET SESSION max_execution_time=10000, SESSION transaction_read_only=ON; SELECT @@session.transaction_read_only",
      rowCount: 1,
    });
  }

  private async executeAnchorDrivenProbe(
    request: InvestigationAdapterRequest,
    target: InvestigationConnectionTarget,
    connection: mysql.Connection,
    traceSteps: InvestigationAdapterTraceStep[],
    startedAt: number,
  ): Promise<InvestigationAdapterResult> {
    const tableNames = getAnchorDiagnosticTables(request.scope);
    const inventoryQuery = buildColumnInventoryQuery(tableNames);
    if (!inventoryQuery) {
      return this.buildCodeFlowResult(request, target, [], [], traceSteps, startedAt);
    }

    const [inventoryRows] = await connection.query<RowDataPacket[]>(inventoryQuery.sql, inventoryQuery.parameters);
    traceSteps.push({
      id: `${request.runId}-data-code-flow-inventory`,
      adapter: "data",
      phase: "execute_query",
      title: "Read code-flow column inventory",
      detail: `Loaded column metadata for ${tableNames.length} code-derived table(s).`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      connectionTargetId: target.id,
      safeSql: inventoryQuery.sql,
      rowCount: inventoryRows.length,
    });

    const probeQueries = buildAnchorProbeQueries(
      request.scope,
      inventoryRows as CodeFlowColumnInventoryRow[],
    );
    if (probeQueries.length === 0) {
      return this.buildCodeFlowResult(request, target, [], [], traceSteps, startedAt);
    }

    const redactedRows: Array<Record<string, unknown>> = [];
    const probeSummaries: Array<Record<string, unknown>> = [];

    for (const probe of probeQueries) {
      const [rows] = await connection.query<RowDataPacket[]>(probe.sql, probe.parameters);
      const redacted = this.phiGuard.redactRows(rows as Array<Record<string, unknown>>);
      redactedRows.push(...redacted);
      probeSummaries.push(this.summarizeProbe(probe, redacted));
      traceSteps.push({
        id: `${request.runId}-data-${probe.id}`,
        adapter: "data",
        phase: "execute_query",
        title: probe.title,
        detail: `Executed code-flow diagnostic for ${probe.tableName}.${probe.anchorColumn}; bound values are redacted from traces.`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        connectionTargetId: target.id,
        safeSql: probe.sql,
        rowCount: redacted.length,
      });
    }

    traceSteps.push({
      id: `${request.runId}-data-code-flow-redact`,
      adapter: "data",
      phase: "redact_results",
      title: "Redact code-flow diagnostic output",
      detail: `Applied Meridian PHI column redaction to ${redactedRows.length} diagnostic row(s).`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      connectionTargetId: target.id,
      rowCount: redactedRows.length,
    });

    return this.buildCodeFlowResult(request, target, redactedRows, probeSummaries, traceSteps, startedAt);
  }

  private summarizeProbe(
    probe: AnchorProbeQuery,
    rows: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    const firstRow = rows[0] || {};
    return {
      tableName: probe.tableName,
      anchorKind: probe.anchorKind,
      anchorColumn: probe.anchorColumn,
      sourcePath: probe.sourcePath,
      rowCount: rows.length,
      matchedRows: Number(firstRow.matched_rows ?? firstRow.MATCHED_ROWS ?? 0) || 0,
      sampledRows: Number(firstRow.sampled_rows ?? firstRow.SAMPLED_ROWS ?? 0) || 0,
    };
  }

  private buildCodeFlowResult(
    request: InvestigationAdapterRequest,
    target: InvestigationConnectionTarget,
    redactedRows: Array<Record<string, unknown>>,
    probeSummaries: Array<Record<string, unknown>>,
    traceSteps: InvestigationAdapterTraceStep[],
    startedAt: number,
  ): InvestigationAdapterResult {
    const matchedRows = probeSummaries.reduce((total, summary) =>
      total + (typeof summary.matchedRows === "number" ? summary.matchedRows : 0), 0);
    const evidenceId = `${request.runId}-data-code-flow-evidence`;
    const hasProbes = probeSummaries.length > 0;

    return {
      findings: [{
        id: `${request.runId}-data-code-flow`,
        adapter: "data",
        type: matchedRows > 0 ? "code_flow_data_match" : "code_flow_data_probe",
        severity: matchedRows > 0 ? "medium" : "low",
        confidence: matchedRows > 0 ? 0.74 : hasProbes ? 0.58 : 0.4,
        title: matchedRows > 0
          ? "Code-flow data evidence matched anchored records"
          : hasProbes
          ? "Code-flow data probe completed without anchor matches"
          : "Code-flow data probe did not find runnable anchor columns",
        summary: hasProbes
          ? `Executed ${probeSummaries.length} MySQL read-only code-flow diagnostic(s) for ${target.id}; ${matchedRows} anchored row match(es) were found.`
          : `Code evidence produced table hints for ${target.id}, but no safe anchor columns were found for the current ticket scope.`,
        evidenceRefs: [evidenceId],
        requiresCodeChange: false,
        requiresDataChange: matchedRows > 0,
        metadata: {
          probeCount: probeSummaries.length,
          matchedRows,
        },
      }],
      evidence: [{
        id: evidenceId,
        adapter: "data",
        title: "Code-flow MySQL diagnostic evidence",
        summary: `Ran bounded read-only MySQL diagnostics derived from code-flow evidence; returned ${redactedRows.length} redacted row(s).`,
        contentType: "application/json",
        metadata: {
          topology: target.topology,
          probeSummaries,
          safeRows: redactedRows,
          traceSteps: this.toEvidenceTrace(traceSteps),
        },
      }],
      telemetry: {
        durationMs: Date.now() - startedAt,
        requestsIssued: Math.max(1, probeSummaries.length + 1),
        rowsRead: redactedRows.length,
        traceSteps,
      },
    };
  }

  private emptyResult(startedAt: number, traceSteps: InvestigationAdapterTraceStep[]): InvestigationAdapterResult {
    return {
      findings: [],
      evidence: [],
      telemetry: {
        durationMs: Date.now() - startedAt,
        requestsIssued: 0,
        rowsRead: 0,
        traceSteps,
      },
    };
  }

  private dataAccessFailure(
    runId: string,
    title: string,
    error: unknown,
    startedAt: number,
    traceSteps: InvestigationAdapterTraceStep[],
  ): InvestigationAdapterResult {
    return {
      findings: [{
        id: `${runId}-data-access-failure`,
        adapter: "data",
        type: "database_access_failure",
        severity: "high",
        confidence: 0.25,
        title,
        summary: error instanceof Error ? error.message : String(error),
        evidenceRefs: [],
        requiresCodeChange: false,
        requiresDataChange: false,
      }],
      evidence: [],
      telemetry: {
        durationMs: Date.now() - startedAt,
        requestsIssued: 1,
        rowsRead: 0,
        traceSteps,
      },
    };
  }

  private async resolveDbCredentialMaterial(target: InvestigationConnectionTarget): Promise<DbCredentialMaterial | null> {
    if (requireOperatorDbCredentials()) {
      return operatorDbCredentialMaterial(target);
    }

    if (!allowTargetSecretDbCredentials()) {
      throw new Error(
        "Target/shared DB credentials are disabled by default for Investigation Cockpit. "
        + "Use INVESTIGATION_DB_USERNAME/INVESTIGATION_DB_PASSWORD or MERIDIAN_DB_USERNAME/MERIDIAN_DB_PASSWORD for the attended run; "
        + "set INVESTIGATION_ALLOW_TARGET_SECRET_DB_CREDENTIALS=true only after separate approval.",
      );
    }

    const { password } = await this.secretResolver.resolve(target);
    if (!password) {
      return null;
    }

    return {
      username: target.dbUser,
      password,
      database: target.databaseName || undefined,
      source: "target_secret",
    };
  }

  private describeCredentialSource(credentials: DbCredentialMaterial): string {
    if (credentials.source === "operator_runtime") {
      return "Using runtime operator DB credentials for this attended run; secret material is kept in process memory only.";
    }
    return "Loaded DB credential from the approved target secret reference.";
  }

  private async executeViaSsmHost(
    request: InvestigationAdapterRequest,
    target: InvestigationConnectionTarget,
    sql: string,
    queryPackId: string,
    traceSteps: InvestigationAdapterTraceStep[],
    startedAt: number,
  ): Promise<InvestigationAdapterResult> {
    const hostTarget = await this.hostTargetRegistry?.resolveTarget(
      request.scope.clientId,
      request.scope.environment,
      target.hostTargetId,
    );

    if (!hostTarget) {
      return {
        findings: [{
          id: `${request.runId}-data-host-missing`,
          adapter: "data",
          type: "database_access_failure",
          severity: "high",
          confidence: 0.2,
          title: "Approved host bridge is not available for database diagnostics",
          summary: `Host target ${target.hostTargetId} could not be resolved for ${target.id}.`,
          evidenceRefs: [],
          requiresCodeChange: false,
          requiresDataChange: false,
        }],
        evidence: [],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 0,
          rowsRead: 0,
          traceSteps,
        },
      };
    }

    const sqlBase64 = Buffer.from(sql, "utf8").toString("base64");
    const mysqlCommand = [
      `source ${target.hostAuthFile}`,
      `SQL=$(printf '%s' '${sqlBase64}' | base64 -d)`,
      `mysql -h ${target.host} -u"$DB_USER" -p"$DB_PASSWORD" --batch --raw -e "$SQL"`,
    ].join(" && ");

    const args = [
      ...(hostTarget.awsProfile ? ["--profile", hostTarget.awsProfile] : []),
      "ssm",
      "send-command",
      "--region",
      hostTarget.region,
      "--instance-ids",
      hostTarget.instanceId,
      "--document-name",
      "AWS-RunShellScript",
      "--comment",
      `investigation cockpit data query ${queryPackId}`,
      "--parameters",
      JSON.stringify({ commands: [mysqlCommand] }),
      "--query",
      "Command.CommandId",
      "--output",
      "text",
    ];

    traceSteps.push({
      id: `${request.runId}-data-open`,
      adapter: "data",
      phase: "open_connection",
      title: "Dispatch bounded DB query through SSM",
      detail: `Sent ${queryPackId} to the approved host bridge for bounded execution.`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      queryPackId,
      connectionTargetId: target.id,
      safeSql: sql,
    });

    const { stdout } = await execFileAsync("aws", args, { maxBuffer: 1024 * 1024 * 4 });
    const commandId = stdout.trim();
    const invocation = await this.waitForSsmCommand(
      commandId,
      hostTarget.region,
      hostTarget.instanceId,
      hostTarget.awsProfile,
    );

    if (invocation.status !== "Success") {
      throw new Error(invocation.stderr || invocation.stdout || `SSM execution failed with status ${invocation.status}`);
    }

    const rows = this.parseMysqlBatchOutput(invocation.stdout);
    const redactedRows = this.phiGuard.redactRows(rows);

    traceSteps.push({
      id: `${request.runId}-data-exec`,
      adapter: "data",
      phase: "execute_query",
      title: "Execute approved data diagnostic",
      detail: `Executed ${queryPackId} on ${target.topology} through the approved host bridge.`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      queryPackId,
      connectionTargetId: target.id,
      safeSql: sql,
      rowCount: redactedRows.length,
    });

    traceSteps.push({
      id: `${request.runId}-data-redact`,
      adapter: "data",
      phase: "redact_results",
      title: "Redact diagnostic output",
      detail: `Applied PHI redaction rules to ${redactedRows.length} rows.`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      queryPackId,
      connectionTargetId: target.id,
      rowCount: redactedRows.length,
    });

    return this.buildSuccessResult(request, target, queryPackId, redactedRows, traceSteps, startedAt);
  }

  private async waitForSsmCommand(
    commandId: string,
    region: string,
    instanceId: string,
    profile?: string,
  ): Promise<{ status: string; stdout: string; stderr: string }> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const args = [
        ...(profile ? ["--profile", profile] : []),
        "ssm",
        "get-command-invocation",
        "--region",
        region,
        "--command-id",
        commandId,
        "--instance-id",
        instanceId,
        "--output",
        "json",
      ];
      const { stdout } = await execFileAsync("aws", args, { maxBuffer: 1024 * 1024 * 4 });
      const payload = JSON.parse(stdout) as {
        Status?: string;
        StandardOutputContent?: string;
        StandardErrorContent?: string;
      };
      const status = payload.Status || "Unknown";
      if (!["Pending", "InProgress", "Delayed"].includes(status)) {
        return {
          status,
          stdout: payload.StandardOutputContent || "",
          stderr: payload.StandardErrorContent || "",
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return {
      status: "TimedOut",
      stdout: "",
      stderr: "Timed out waiting for SSM command completion.",
    };
  }

  private parseMysqlBatchOutput(output: string): Array<Record<string, unknown>> {
    const lines = output
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);

    if (lines.length === 0) {
      return [];
    }

    const headers = lines[0].split("\t");
    return lines.slice(1).map((line) => {
      const values = line.split("\t");
      return headers.reduce<Record<string, unknown>>((row, header, index) => {
        row[header] = values[index] ?? null;
        return row;
      }, {});
    });
  }

  private buildSuccessResult(
    request: InvestigationAdapterRequest,
    target: InvestigationConnectionTarget,
    queryPackId: string,
    redactedRows: Array<Record<string, unknown>>,
    traceSteps: InvestigationAdapterTraceStep[],
    startedAt: number,
  ): InvestigationAdapterResult {
    const topSchemas = redactedRows
      .slice(0, 3)
      .map((row) => `${String(row.table_schema)} (${String(row.table_count ?? row.table_name ?? "metadata")})`)
      .join(", ");

    const topologyLabel = target.topology === "rds_mysql" ? "RDS" : "host-backed";

    return {
      findings: [{
        id: `${request.runId}-data-success`,
        adapter: "data",
        type: "database_metadata_ready",
        severity: "medium",
        confidence: 0.78,
        title: `${topologyLabel} metadata path is available for bounded diagnostics`,
        summary: topSchemas
          ? `Collected redacted database metadata from ${target.id}. Top results: ${topSchemas}.`
          : `Collected redacted database metadata from ${target.id}.`,
        evidenceRefs: [`${request.runId}-data-evidence`],
        requiresCodeChange: false,
        requiresDataChange: false,
      }],
      evidence: [{
        id: `${request.runId}-data-evidence`,
        adapter: "data",
        title: `${topologyLabel} metadata snapshot`,
        summary: `Executed ${queryPackId} on ${target.topology} target ${target.id} and returned ${redactedRows.length} redacted rows.`,
        contentType: "application/json",
        metadata: {
          topology: target.topology,
          safeRows: redactedRows,
          traceSteps: this.toEvidenceTrace(traceSteps),
        },
      }],
      telemetry: {
        durationMs: Date.now() - startedAt,
        requestsIssued: 1,
        rowsRead: redactedRows.length,
        traceSteps,
      },
    };
  }

  private toEvidenceTrace(traceSteps: InvestigationAdapterTraceStep[]) {
    return traceSteps.map((step) => ({
      title: step.title,
      detail: step.detail,
      safeSql: step.safeSql,
      rowCount: step.rowCount,
    }));
  }
}

export class DashboardInvestigationJiraService {
  buildSummaryComment(execution: DashboardInvestigationRunExecution): string {
    const topFindings = execution.findings.slice(0, 3)
      .map((finding) => `- [${finding.adapter.toUpperCase()}] ${finding.title}: ${finding.summary}`)
      .join("\n");

    return [
      `Investigation Summary - ${execution.run.jiraKey}`,
      "",
      `Confidence: ${Math.round(execution.correlation.confidence * 100)}%`,
      `Next step: ${execution.nextStep.reason}`,
      "",
      "Top findings:",
      topFindings || "- No findings were produced.",
      "",
      "Operator note: results are intended to be redacted and operationally bounded.",
    ].join("\n");
  }
}

function withReadOnlySqlPrefix(sql: string): string {
  return `SET SESSION transaction_read_only=ON; ${sql}`;
}
