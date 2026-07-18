import { spawn } from "child_process";
import { EventEmitter } from "events";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type {
  InvestigationClientTarget,
  InvestigationConnectionTarget,
  InvestigationHostTarget,
  InvestigationRunExecution,
  InvestigationTicketContext,
} from "../../../src/investigation/index.js";
import { evaluateInvestigationResolutionGate } from "../../../src/investigation/control-plane/ResolutionGate.js";
import { createAgentTaskHandoff } from "./agentTaskHandoff.js";

export interface MeridianHandoffDecision {
  shouldCreate: boolean;
  reason: string;
}

export interface MeridianHandoffResult {
  status: "created" | "existing" | "skipped" | "failed";
  reason: string;
  taskManagementId?: number;
}

const MERIDIAN_TICKET_FAMILY_INTENT = /\b(?:BECU|CCIU)\b/i;
const MERIDIAN_FIELD_CHANGE_INTENT = /\b(?:add|clear|update|correct|fix|change|set|null(?:\s+out)?|(?:remove|delete)\b.{0,80}\b(?:field|date|time|value))\b/i;
const MERIDIAN_RECORD_DELETE_INTENT = /\b(?:delete|remove)\s+(?:the\s+)?(?:record|row|case|entry|line)\b/i;
const MERIDIAN_NEGATED_CHANGE_INTENT = /\b(?:no|without)\s+(?:requested\s+)?(?:backend\s+)?(?:data\s+)?change\b/i;
const MERIDIAN_CASE_UPDATE_INTENT = /\b(?:backend\s+update|back[-\s]?end\s+update|backend\s+case\s+(?:edit|update)|back[-\s]?end\s+case\s+(?:edit|update)|backend\s+ticket|back[-\s]?end\s+ticket|case\s+edit|case\s+update|case\s+updates|bulk\s+case|bulk\s+update|provider_appeals_mgmt|process_flow|jbpm4_hist_actinst|remediation\s+sql|sql\s+remediation|sql\s+generation|generate\s+sql|data\s+fix|script\s+fix)\b/i;
const MERIDIAN_FIELD_UPDATE_INTENT = /\b(?:update|correct|fix|change|set)\s+(?:the\s+)?(?:status\s+reason|case\s+closure|closed\s+date|category|sub\s*category)\b/i;
const SPREADSHEET_ATTACHMENT_INTENT = /\.(?:xlsx|xls|csv)\b/i;
const directMeridianRuns = new Set<string>();
const serviceDirectory = path.dirname(fileURLToPath(import.meta.url));

interface DerivedMeridianTarget {
  id: string;
  clients: string[];
  networkPath: "ldap_ssh" | "direct_local" | "private_vpc" | "vpn";
  remoteHost: string;
  remotePort: number;
  publicHost?: string;
  sshPort: number;
  sshUser?: string;
  sshAuthMode: "operator_ldap";
  sshControlPath?: string;
  sshAllowed: boolean;
  ssmAllowed: false;
  databaseName: string;
  dbUser: "env://MERIDIAN_DB_USERNAME";
  secretRef: "env://MERIDIAN_DB_PASSWORD";
}

function handoffEnabled(): boolean {
  return process.env.INVESTIGATION_MERIDIAN_HANDOFF_ENABLED !== "false";
}

function directFallbackEnabled(): boolean {
  return process.env.INVESTIGATION_MERIDIAN_DIRECT_FALLBACK === "true";
}

function cockpitApiBaseUrl(): string {
  const configured = process.env.INVESTIGATION_COCKPIT_API_BASE_URL?.trim().replace(/\/$/, "");
  if (configured) {
    return configured;
  }
  const port = process.env.PORT?.trim() || "3001";
  return `http://127.0.0.1:${port}/api/investigation`;
}

function directFallbackTaskId(): number {
  return Math.floor(Date.now() % 1_000_000_000);
}

function firstExistingPath(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

function repositoryRoot(): string {
  const configured = process.env.INVESTIGATION_REPO_ROOT?.trim();
  const candidates = [
    configured,
    path.resolve(serviceDirectory, "../../.."),
    path.resolve(serviceDirectory, "../../../.."),
    process.cwd(),
    path.resolve(process.cwd(), ".."),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(path.join(candidate, "scripts", "meridian-direct-run.ts")))
    || path.resolve(serviceDirectory, "../../..");
}

function tsxCliPath(): string {
  const root = repositoryRoot();
  return firstExistingPath([
    path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(root, "dashboard", "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
  ]) || path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
}

function meridianDirectScriptPath(): string {
  return path.join(repositoryRoot(), "scripts", "meridian-direct-run.ts");
}

function envValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}

function firstEnvValue(names: string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  return names.map((name) => envValue(name, env)).find((value): value is string => Boolean(value));
}

function firstRenderedEnvValue(
  names: string[],
  input: {
    execution: InvestigationRunExecution;
    client: InvestigationClientTarget;
    env: NodeJS.ProcessEnv;
  },
): string | undefined {
  return renderScopeTemplate(firstEnvValue(names, input.env), input);
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isLoopbackHost(value: string | undefined): boolean {
  const host = value?.trim().toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function scopeTemplateValues(input: {
  execution: InvestigationRunExecution;
  client: InvestigationClientTarget;
}): Record<string, string> {
  const environment = input.execution.run.scope.environment;
  const envId = environment.toLowerCase().replace(/_/g, "-");
  return {
    client: input.client.id.toLowerCase(),
    clientId: input.client.id,
    clientName: input.client.displayName,
    env: envId,
    environment: envId,
    environmentId: environment,
  };
}

function renderScopeTemplate(
  value: string | undefined,
  input: {
    execution: InvestigationRunExecution;
    client: InvestigationClientTarget;
  },
): string | undefined {
  if (!value) {
    return undefined;
  }
  const values = scopeTemplateValues(input);
  return value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key: string) => values[key] || match);
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function evidenceMetadataString(
  execution: InvestigationRunExecution,
  field: string,
): string | undefined {
  for (const artifact of execution.evidence || []) {
    const value = artifact.metadata?.[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function evidenceMetadataPort(
  execution: InvestigationRunExecution,
  field: string,
): string | undefined {
  for (const artifact of execution.evidence || []) {
    const value = artifact.metadata?.[field];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return String(value);
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function buildCockpitDerivedMeridianTarget(input: {
  execution: InvestigationRunExecution;
  client: InvestigationClientTarget;
  connectionTarget?: InvestigationConnectionTarget;
  hostTarget?: InvestigationHostTarget;
  env: NodeJS.ProcessEnv;
}): DerivedMeridianTarget {
  const cockpitDbHost = input.connectionTarget?.host || firstRenderedEnvValue([
    "INVESTIGATION_DB_HOST_TEMPLATE",
    "INVESTIGATION_DB_HOST",
    "INVESTIGATION_DB_LOCAL_HOST",
  ], input) || "127.0.0.1";
  const remoteDbHost = firstRenderedEnvValue([
    "INVESTIGATION_DB_REMOTE_HOST_TEMPLATE",
    "MERIDIAN_DB_REMOTE_HOST_TEMPLATE",
    "INVESTIGATION_DB_REMOTE_HOST",
    "MERIDIAN_DB_REMOTE_HOST",
  ], input);
  const sshHost = input.hostTarget?.publicHost || firstRenderedEnvValue([
    "INVESTIGATION_SSH_HOST_TEMPLATE",
    "INVESTIGATION_PUBLIC_HOST_TEMPLATE",
    "INVESTIGATION_BASTION_HOST_TEMPLATE",
    "INVESTIGATION_SSH_HOST",
    "INVESTIGATION_PUBLIC_HOST",
    "INVESTIGATION_BASTION_HOST",
    "INVESTIGATION_SSH_MASTER_HOST",
    "SSH_MASTER_HOST",
  ], input) || evidenceMetadataString(input.execution, "publicHost");
  const sshControlPath = input.hostTarget?.sshControlPath || firstRenderedEnvValue([
    "MERIDIAN_SSH_CONTROL_PATH",
    "INVESTIGATION_SSH_CONTROL_PATH",
  ], input) || evidenceMetadataString(input.execution, "sshControlPath");
  const environment = input.execution.run.scope.environment.toLowerCase().replace(/_/g, "-");
  const clients = uniqueNonEmpty([
    input.client.displayName,
    input.client.id,
    ...(input.client.aliases || []),
    input.execution.run.scope.ticketContext?.clientName,
  ]);
  const configuredNetworkPath = input.connectionTarget?.networkPath;
  const networkPath = configuredNetworkPath === "ssh_public"
    ? "ldap_ssh"
    : configuredNetworkPath === "private_vpc" || configuredNetworkPath === "vpn"
      ? configuredNetworkPath
      : !remoteDbHost && isLoopbackHost(cockpitDbHost)
        ? "direct_local"
        : "ldap_ssh";
  const directLocal = networkPath === "direct_local";
  const remotePort = input.connectionTarget?.port || (directLocal
    ? parsePort(firstEnvValue(["INVESTIGATION_DB_LOCAL_PORT", "INVESTIGATION_DB_PORT"], input.env), 3306)
    : parsePort(firstEnvValue([
      "INVESTIGATION_DB_REMOTE_PORT",
      "MERIDIAN_DB_REMOTE_PORT",
      "INVESTIGATION_DB_PORT",
    ], input.env), 3306));

  return {
    id: `cockpit-${input.client.id.toLowerCase()}-${environment}-ldap-db`,
    clients: clients.length ? clients : [input.client.id],
    networkPath,
    remoteHost: input.connectionTarget?.host || (directLocal ? cockpitDbHost : remoteDbHost || cockpitDbHost),
    remotePort,
    ...(sshHost ? { publicHost: sshHost } : {}),
    sshPort: parsePort(
      String(input.hostTarget?.sshPort || firstEnvValue(["INVESTIGATION_SSH_PORT"], input.env) || evidenceMetadataPort(input.execution, "port") || "22"),
      22,
    ),
    ...(input.hostTarget?.sshUser || firstEnvValue(["INVESTIGATION_OPERATOR_SSH_USER", "INVESTIGATION_SSH_USER"], input.env)
      ? { sshUser: input.hostTarget?.sshUser || firstEnvValue(["INVESTIGATION_OPERATOR_SSH_USER", "INVESTIGATION_SSH_USER"], input.env) }
      : {}),
    sshAuthMode: "operator_ldap",
    ...(sshControlPath
      ? { sshControlPath }
      : {}),
    sshAllowed: networkPath === "ldap_ssh",
    ssmAllowed: false,
    databaseName: input.connectionTarget?.databaseName || firstEnvValue(["INVESTIGATION_DB_DATABASE"], input.env) || "medhok",
    dbUser: "env://MERIDIAN_DB_USERNAME",
    secretRef: "env://MERIDIAN_DB_PASSWORD",
  };
}

function buildDirectFallbackEnv(input: {
  execution: InvestigationRunExecution;
  client: InvestigationClientTarget;
  connectionTarget?: InvestigationConnectionTarget;
  hostTarget?: InvestigationHostTarget;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    INVESTIGATION_COCKPIT_API_BASE_URL: cockpitApiBaseUrl(),
    MERIDIAN_TARGET_CLIENT_OVERRIDE: input.client.displayName,
    MERIDIAN_TARGET_ENVIRONMENT_OVERRIDE: input.execution.run.scope.environment,
  };

  if (envValue("INVESTIGATION_DB_USERNAME", env)) {
    env.MERIDIAN_DB_USERNAME = envValue("INVESTIGATION_DB_USERNAME", env);
  }
  if (envValue("INVESTIGATION_DB_PASSWORD", env)) {
    env.MERIDIAN_DB_PASSWORD = env.INVESTIGATION_DB_PASSWORD;
  }
  if (envValue("INVESTIGATION_DB_DATABASE", env)) {
    env.MERIDIAN_DB_DATABASE = envValue("INVESTIGATION_DB_DATABASE", env);
  }

  if (!envValue("MERIDIAN_TARGETS_JSON", env) && !envValue("MERIDIAN_TARGETS_FILE", env)) {
    const target = buildCockpitDerivedMeridianTarget({ ...input, env });
    if (target.networkPath === "ldap_ssh" && !target.publicHost) {
      throw new Error(
        "Approved database target requires LDAP SSH, but Cockpit did not resolve an approved SSH gateway. Configure the client connection and host targets before retrying Meridian.",
      );
    }
    env.MERIDIAN_TARGETS_JSON = JSON.stringify({
      targets: [target],
    });
  }

  return env;
}

function stripAnsiControlSequences(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 27 || value[index + 1] !== "[") {
      result += value[index];
      continue;
    }
    index += 2;
    while (index < value.length && !/[A-Za-z]/.test(value[index])) {
      index += 1;
    }
  }
  return result;
}

function formatDirectFailure(error: unknown): string {
  const raw = stripAnsiControlSequences(error instanceof Error ? error.message : String(error));
  const lastLine = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) || raw.trim();
  return lastLine
    .replace(/(password|token|secret|authorization)\s*[:=]\s*[^,\s;]+/gi, "$1=[REDACTED]")
    .replace(/\/Users\/[^/\s]+\/[^\s]*/g, "[LOCAL_PATH_REDACTED]")
    .slice(0, 600)
    .trim() || "MERIDIAN direct local fallback failed without an error message.";
}

async function attachDirectFailure(runId: string, message: string): Promise<void> {
  await fetch(`${cockpitApiBaseUrl()}/runs/${encodeURIComponent(runId)}/meridian/evidence`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-operator-id": "meridian-direct-fallback",
      "x-operator-name": "MERIDIAN Direct Fallback",
    },
    body: JSON.stringify({
      summary: "Meridian SQL planning is blocked by incomplete approved database access configuration.",
      recommendation: "Configure or discover the approved client database and access target before retrying Meridian.",
      status: "escalated",
      confidence: 0.9,
      clientSummary: "Meridian SQL generation did not complete.",
      internalAnalysis: `Meridian database access preflight failed: ${message}`,
      validationNotes: "No SQL was generated or executed.",
      findings: [{
        analyzer: "data",
        severity: "medium",
        title: "Meridian database access unavailable",
        summary: message,
        confidence: 0.95,
        requiresAction: "data",
      }],
      evidence: [{
        analyzer: "data",
        title: "Meridian database access preflight",
        detail: message,
        meta: ["source:MERIDIAN", "direct-fallback", "failed"],
        trace: [],
      }],
    }),
  });
}

function startDirectMeridianFallback(input: {
  runId: string;
  jiraKey: string;
  execution: InvestigationRunExecution;
  client: InvestigationClientTarget;
  connectionTarget?: InvestigationConnectionTarget;
  hostTarget?: InvestigationHostTarget;
}): MeridianHandoffResult {
  const runKey = `${input.runId}:${input.jiraKey}`;
  if (directMeridianRuns.has(runKey)) {
    return {
      status: "existing",
      reason: "MERIDIAN direct local fallback is already running for this Cockpit run.",
    };
  }

  let childEnv: NodeJS.ProcessEnv;
  try {
    childEnv = buildDirectFallbackEnv(input);
  } catch (error) {
    const message = formatDirectFailure(error);
    void attachDirectFailure(input.runId, message).catch((attachError) => {
      console.error(
        `[meridian-direct-fallback] failed to attach preflight failure to Cockpit: ${formatDirectFailure(attachError)}`,
      );
    });
    return {
      status: "failed",
      reason: message,
    };
  }

  directMeridianRuns.add(runKey);
  const stderrTail: string[] = [];
  const child = spawn(process.execPath, [
    tsxCliPath(),
    meridianDirectScriptPath(),
    "--jira",
    input.jiraKey,
    "--task-id",
    String(directFallbackTaskId()),
  ], {
    cwd: repositoryRoot(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const trackOutput = (chunk: unknown) => {
    const text = String(chunk);
    stderrTail.push(text);
    while (stderrTail.join("").length > 4000) {
      stderrTail.shift();
    }
  };
  (child.stdout as EventEmitter | null | undefined)?.on("data", trackOutput);
  (child.stderr as EventEmitter | null | undefined)?.on("data", trackOutput);

  const fail = (error: unknown) => {
    const output = stderrTail.join("").trim();
    const message = formatDirectFailure(output || error);
    console.error(`[meridian-direct-fallback] ${input.jiraKey}: ${message}`);
    void attachDirectFailure(input.runId, message).catch((attachError) => {
      console.error(
        `[meridian-direct-fallback] failed to attach failure to Cockpit: ${formatDirectFailure(attachError)}`,
      );
    });
  };

  child.on("error", (error) => {
    directMeridianRuns.delete(runKey);
    fail(error);
  });
  child.on("close", (code) => {
    directMeridianRuns.delete(runKey);
    if (code && code !== 0) {
      fail(new Error(`MERIDIAN direct local fallback exited with code ${code}`));
    }
  });

  return {
    status: "created",
    reason: "Platform queue unavailable; started MERIDIAN direct local fallback. MERIDIAN owns LDAP SSH/client DB connectivity.",
  };
}

function ticketContextText(context?: InvestigationTicketContext): string {
  if (!context || context.fetchStatus !== "fetched") {
    return "";
  }
  return [
    context.title,
    context.environmentName,
    ...(context.labels || []),
    context.description,
    ...(context.comments || []).map((comment) => comment.body),
    ...(context.attachments || []).flatMap((attachment) => [
      attachment.filename,
      attachment.textExcerpt,
      ...(attachment.extractedTerms || []),
    ]),
    ...(context.extractedTerms || []),
    ...(context.identifiers || []).map((identifier) => identifier.value),
  ]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join("\n")
    .slice(0, 120_000);
}

function hasExplicitFamilyChange(routingText: string): boolean {
  return MERIDIAN_TICKET_FAMILY_INTENT.test(routingText)
    && (MERIDIAN_FIELD_CHANGE_INTENT.test(routingText) || MERIDIAN_RECORD_DELETE_INTENT.test(routingText))
    && !MERIDIAN_NEGATED_CHANGE_INTENT.test(routingText);
}

export function hasMeridianTicketContextSignal(input: {
  ticketContext?: InvestigationTicketContext;
  client?: InvestigationClientTarget;
  title?: string;
}): boolean {
  if (input.ticketContext?.fetchStatus !== "fetched" && !input.title?.trim()) {
    return false;
  }
  const contextText = input.ticketContext?.fetchStatus === "fetched"
    ? ticketContextText(input.ticketContext)
    : "";
  const clientText = input.client
    ? `${input.client.id} ${input.client.displayName} ${(input.client.aliases || []).join(" ")}`
    : "";
  const routingText = `${clientText}\n${input.title || ""}\n${contextText}`;
  const explicitChangeIntent = MERIDIAN_CASE_UPDATE_INTENT.test(routingText)
    || (SPREADSHEET_ATTACHMENT_INTENT.test(contextText) && MERIDIAN_FIELD_UPDATE_INTENT.test(routingText))
    || MERIDIAN_FIELD_UPDATE_INTENT.test(routingText)
    || hasExplicitFamilyChange(routingText);
  return explicitChangeIntent;
}

export function decideMeridianHandoff(input: {
  execution: InvestigationRunExecution;
  client: InvestigationClientTarget;
}): MeridianHandoffDecision {
  if (!handoffEnabled()) {
    return { shouldCreate: false, reason: "MERIDIAN handoff is disabled by INVESTIGATION_MERIDIAN_HANDOFF_ENABLED=false." };
  }
  if (!input.execution.run.jiraKey) {
    return { shouldCreate: false, reason: "No Jira key is attached to this investigation." };
  }
  if (input.execution.run.scope.ticketContext?.fetchStatus !== "fetched") {
    return { shouldCreate: false, reason: "Jira ticket context was not ingested, so MERIDIAN routing was not attempted." };
  }

  const contextText = ticketContextText(input.execution.run.scope.ticketContext);
  const clientText = `${input.client.id} ${input.client.displayName} ${(input.client.aliases || []).join(" ")}`;
  const routingText = `${clientText}\n${contextText}`;
  const explicitCaseUpdate = MERIDIAN_CASE_UPDATE_INTENT.test(routingText);
  const explicitSpreadsheetUpdate = SPREADSHEET_ATTACHMENT_INTENT.test(contextText)
    && MERIDIAN_FIELD_UPDATE_INTENT.test(routingText);
  const explicitFieldUpdate = MERIDIAN_FIELD_UPDATE_INTENT.test(routingText);
  const explicitFamilyChange = hasExplicitFamilyChange(routingText);
  const explicitPlannedChange = explicitCaseUpdate || explicitSpreadsheetUpdate || explicitFieldUpdate || explicitFamilyChange;
  const plannedChangeDecision = evaluateInvestigationResolutionGate({
    action: "request_data_remediation",
    assessment: input.execution.rcaAssessment,
    plannedChange: explicitPlannedChange,
  });
  if (explicitPlannedChange && !plannedChangeDecision.allowed) {
    return { shouldCreate: false, reason: plannedChangeDecision.reason };
  }
  if (MERIDIAN_TICKET_FAMILY_INTENT.test(routingText) && explicitPlannedChange) {
    return { shouldCreate: true, reason: "Ticket context indicates BECU/CCIU backend case-update SQL generation intent." };
  }
  if (explicitCaseUpdate) {
    return { shouldCreate: true, reason: "Ticket context indicates backend/case-update SQL generation intent." };
  }
  if (explicitSpreadsheetUpdate) {
    return { shouldCreate: true, reason: "Spreadsheet-backed ticket context indicates field-update SQL generation intent." };
  }
  if (explicitFieldUpdate) {
    return { shouldCreate: true, reason: "Ticket context indicates field-update SQL generation intent." };
  }

  const dataChangeFinding = input.execution.findings.find((finding) => {
    const analyzer = "analyzer" in finding ? (finding as { analyzer?: unknown }).analyzer : undefined;
    return finding.requiresDataChange && (finding.adapter === "data" || analyzer === "data");
  });
  if (dataChangeFinding) {
    const resolutionDecision = evaluateInvestigationResolutionGate({
      action: "request_data_remediation",
      assessment: input.execution.rcaAssessment,
    });
    if (!resolutionDecision.allowed) {
      return {
        shouldCreate: false,
        reason: `A data-remediation finding exists, but the shared resolution gate blocked handoff. ${resolutionDecision.reason}`,
      };
    }
    return { shouldCreate: true, reason: `Investigation finding requires data remediation: ${dataChangeFinding.title}` };
  }

  return { shouldCreate: false, reason: "No backend/case-update or data-remediation signal was found." };
}

export async function maybeCreateMeridianHandoff(input: {
  execution: InvestigationRunExecution;
  client: InvestigationClientTarget;
  connectionTarget?: InvestigationConnectionTarget;
  hostTarget?: InvestigationHostTarget;
}): Promise<MeridianHandoffResult> {
  const decision = decideMeridianHandoff(input);
  if (!decision.shouldCreate) {
    return { status: "skipped", reason: decision.reason };
  }

  const jiraKey = input.execution.run.jiraKey;
  if (!jiraKey) {
    return { status: "skipped", reason: "No Jira key is attached to this investigation." };
  }

  const handoff = await createAgentTaskHandoff({
    agentName: "MERIDIAN",
    jiraKey,
    client: input.client,
    taskType: "sql_generation",
    source: "api",
  });

  if (handoff.status === "created" || handoff.status === "existing") {
    return {
      status: handoff.status,
      taskManagementId: handoff.taskManagementId,
      reason: `${decision.reason} ${handoff.reason} MERIDIAN worker owns LDAP SSH/client DB connectivity.`,
    };
  }

  if (
    handoff.status === "failed" &&
    directFallbackEnabled() &&
    handoff.reason.includes("platform DB task creation failed")
  ) {
    const direct = startDirectMeridianFallback({
      runId: input.execution.run.id,
      jiraKey,
      execution: input.execution,
      client: input.client,
      connectionTarget: input.connectionTarget,
      hostTarget: input.hostTarget,
    });
    return {
      status: direct.status,
      reason: `${decision.reason} ${direct.reason}`,
    };
  }

  return handoff;
}
