/**
 * MERIDIANWorker - Jira-driven SQL generation through the Meridian engine.
 *
 * This worker intentionally fetches the raw Jira ticket itself and does not use
 * the generic task-description LLM pipeline. Meridian owns its own PHI/PII
 * redaction and only uses the LLM path inside the Meridian backend when needed.
 */

import { spawn, execFile, type ChildProcess } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import * as fs from "fs/promises";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import mysql, { type Connection } from "mysql2/promise";
import * as XLSX from "xlsx";
import { AgentWorker, type ProcessResult } from "../AgentWorker.js";
import { adfToMarkdown, type AdfNode } from "../JiraClient.js";
import { createLogger } from "../../utils/logger.js";
import type { EventEmitter } from "events";

const logger = createLogger("meridian-worker");
const execFileAsync = promisify(execFile);

const DEFAULT_MERIDIAN_API_BASE_URL = "http://127.0.0.1:8001/api";
const DEFAULT_MERIDIAN_BACKEND_DIR = "meridian/backend";
const MYSQL_PORT = 3306;
const LDAP_SSH_NETWORK_PATHS = new Set(["ssh", "ssh_public", "ldap_ssh"]);
const DIRECT_LOCAL_NETWORK_PATHS = new Set(["direct_local", "local_loopback"]);
const DIRECT_NETWORK_PATHS = new Set(["private_vpc", "vpn"]);
const DEFAULT_COCKPIT_SQL_ARTIFACT_MAX_BYTES = 5_000_000;

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

function requireOperatorDbCredentials(): boolean {
  return envFlag("MERIDIAN_REQUIRE_OPERATOR_DB_CREDENTIALS", true);
}

function allowHostedMeridianAccess(): boolean {
  return envFlag("MERIDIAN_ALLOW_HOSTED_ACCESS", false);
}

function cockpitSqlArtifactMaxBytes(): number {
  const raw = process.env.MERIDIAN_COCKPIT_SQL_MAX_BYTES?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_COCKPIT_SQL_ARTIFACT_MAX_BYTES;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COCKPIT_SQL_ARTIFACT_MAX_BYTES;
}

interface JiraIssueForMeridian {
  key: string;
  names?: Record<string, string>;
  renderedFields?: Record<string, unknown>;
  fields: {
    summary?: string;
    description?: AdfNode;
    labels?: string[];
    attachment?: JiraAttachment[];
    [key: string]: unknown;
  };
}

interface JiraAttachment {
  id: string;
  filename: string;
  content?: string;
  mimeType?: string;
  size?: number;
  created?: string;
}

export interface MeridianTarget {
  id: string;
  clients: string[];
  environments?: string[];
  region?: string;
  instanceId?: string;
  networkPath?: string;
  remoteHost: string;
  remotePort?: number;
  publicHost?: string;
  sshHost?: string;
  loginHost?: string;
  bastionHost?: string;
  sshPort?: number;
  sshUser?: string;
  sshAuthMode?: "operator_ldap" | "ssh_agent" | string;
  sshControlPath?: string;
  sshAllowed?: boolean;
  ssmAllowed?: boolean;
  database?: string;
  databaseName?: string;
  dbUser?: string;
  dbUsername?: string;
  secretRef?: string;
  dbSecretId?: string;
  dbSecretRegion?: string;
  assumeRoleArn?: string;
  awsProfile?: string;
}

interface MeridianTargetsFile {
  targets: MeridianTarget[];
}

interface AwsExecutionContext {
  env: NodeJS.ProcessEnv;
  profileArgs: string[];
}

export interface DbCredentials {
  username: string;
  password: string;
  database: string;
  authPlugin?: string;
  krbServicePrincipal?: string;
  sslCa?: string;
  sslVerifyIdentity?: boolean;
  operatorRuntime?: boolean;
}

interface MeridianDbTunnel {
  process: ChildProcess;
  localPort: number;
  stderrTail: string[];
  accessPath: "ldap_ssh";
}

interface MeridianDbEndpoint {
  host: string;
  port: number;
  accessPath: "ldap_ssh" | "direct_local" | "direct_network";
  tunnel?: MeridianDbTunnel;
}

interface MeridianBackendHandle {
  process: ChildProcess;
  profilesDir: string;
}

interface DownloadedAttachment {
  filename: string;
  localPath: string;
  buffer: Buffer;
}

interface CorrespondenceRow {
  rowNumber: number;
  id: number;
  expectedStatus: string;
  expectedTimestamp?: string;
}

interface CorrespondenceDbRow {
  id: number;
  status_id: number | null;
  status_datetime: Date | string | null;
  update_datetime: Date | string | null;
  status_reason: string | null;
}

interface MeridianGenerationResult {
  summary: string;
  sql: string;
  filename: string;
  source: "meridian-api" | "correspondence-fallback" | "ticket-text";
  rowCount?: number;
  updateCount?: number;
  skippedCount?: number;
}

export class MERIDIANWorker extends AgentWorker {
  private readonly jiraBaseUrl: string;
  private readonly meridianApiBaseUrl: string;
  private readonly meridianApiBaseUrlConfigured: boolean;
  private readonly autostartMeridianBackend: boolean;
  private readonly cockpitApiBaseUrl?: string;
  private readonly meridianBackendToken: string;

  constructor(repositoryPath: string, enableStatusServer: boolean = false) {
    super({
      agentName: "MERIDIAN",
      repositoryPath,
      pollingIntervalMs: 10000,
      batchSize: 1,
      enableStatusServer,
    });

    this.jiraBaseUrl = (process.env.JIRA_BASE_URL || "").replace(/\/$/, "");
    const configuredMeridianApiBaseUrl = process.env.MERIDIAN_API_BASE_URL?.trim();
    this.meridianApiBaseUrlConfigured = Boolean(configuredMeridianApiBaseUrl);
    this.meridianApiBaseUrl = (configuredMeridianApiBaseUrl || DEFAULT_MERIDIAN_API_BASE_URL).replace(
      /\/$/,
      "",
    );
    this.autostartMeridianBackend =
      process.env.MERIDIAN_BACKEND_AUTOSTART === undefined
        ? !this.meridianApiBaseUrlConfigured
        : readBooleanEnv(process.env.MERIDIAN_BACKEND_AUTOSTART, true);
    this.cockpitApiBaseUrl = process.env.INVESTIGATION_COCKPIT_API_BASE_URL?.trim().replace(/\/$/, "") || undefined;
    this.meridianBackendToken =
      process.env.MERIDIAN_BACKEND_TOKEN?.trim() ||
      (this.autostartMeridianBackend ? randomUUID() : "");

    logger.info(
      {
        repositoryPath,
        enableStatusServer,
        meridianApiBaseUrl: this.meridianApiBaseUrl,
        autostartMeridianBackend: this.autostartMeridianBackend,
        cockpitCallbackConfigured: Boolean(this.cockpitApiBaseUrl),
      },
      "[MERIDIAN_WORKER_INIT] MERIDIANWorker initialized",
    );
  }

  async processJiraTicketDirect(
    jiraNumber: string,
    options: {
      taskId?: number;
      repositoryPath?: string;
      eventEmitter?: EventEmitter;
    } = {},
  ): Promise<ProcessResult> {
    return this.process(
      jiraNumber,
      options.taskId ?? Date.now(),
      "",
      "Direct Investigation Cockpit MERIDIAN handoff; no task_management row was created.",
      options.repositoryPath ?? this.config.repositoryPath,
      options.eventEmitter,
    );
  }

  protected async process(
    jiraNumber: string,
    taskId: number,
    taskDescription: string,
    additionalContext: string,
    repositoryPath: string,
    eventEmitter?: EventEmitter,
  ): Promise<ProcessResult> {
    const startTime = Date.now();
    const logContext = {
      jira: jiraNumber,
      taskId,
      correlationId: `meridian-${taskId}-${jiraNumber}`,
    };

    logger.info(logContext, "[MERIDIAN_PROCESS_START] Starting Meridian workflow");

    let tunnel: MeridianDbTunnel | null = null;
    let backend: MeridianBackendHandle | null = null;
    let attachment: DownloadedAttachment | null = null;

    try {
      const issue = await this.fetchIssue(jiraNumber);
      const target = this.resolveTarget(issue);
      const awsContext = await this.buildAwsExecutionContext(target);
      const credentials = await this.resolveDbCredentials(target, awsContext);

      backend = await this.ensureMeridianBackend(credentials);

      const dbEndpoint = await this.prepareDbEndpoint(target);
      tunnel = dbEndpoint.tunnel || null;

      await this.activateMeridianConnection(target, dbEndpoint.host, dbEndpoint.port, credentials);

      attachment = await this.downloadBestSpreadsheet(issue, logContext);
      let result: MeridianGenerationResult;

      if (attachment) {
        result = await this.generateFromSpreadsheet(jiraNumber, issue, attachment);
        if (this.shouldTryCorrespondenceFallback(result.sql)) {
          const fallback = await this.generateCorrespondenceSql(
            jiraNumber,
            issue,
            attachment,
            target,
            credentials,
            dbEndpoint.host,
            dbEndpoint.port,
          );
          if (fallback) {
            result = fallback;
          }
        }
      } else {
        result = await this.generateFromTicketText(jiraNumber, issue);
      }

      const durationMs = Date.now() - startTime;
      const localSqlPath = await this.writeLocalSqlArtifact(result, logContext);
      const output = this.formatOutput(jiraNumber, issue, target, result, durationMs, localSqlPath);
      await this.attachSqlToCockpitRun(jiraNumber, target, result, durationMs, logContext);

      logger.info(
        {
          ...logContext,
          durationMs,
          source: result.source,
          sqlLength: result.sql.length,
          rowCount: result.rowCount,
          updateCount: result.updateCount,
          skippedCount: result.skippedCount,
        },
        "[MERIDIAN_PROCESS_SUCCESS] Meridian workflow completed",
      );

      return {
        success: true,
        output,
        metrics: {
          durationMs,
          iterations: 0,
          cost: 0,
        },
      };
    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      logger.error(
        {
          ...logContext,
          durationMs,
          errorName: error?.name,
          errorMessage: error?.message,
          errorStack: error?.stack,
        },
        "[MERIDIAN_PROCESS_ERROR] Meridian workflow failed",
      );
      return {
        success: false,
        output: "",
        error: error?.message || String(error),
        metrics: { durationMs },
      };
    } finally {
      if (tunnel) {
        await this.stopDbTunnel(tunnel);
      }
      if (attachment) {
        await fs.unlink(attachment.localPath).catch(() => undefined);
      }
      if (backend) {
        await this.stopMeridianBackend(backend);
      }
    }
  }

  private getJiraCredentials(): { username: string; token: string } {
    const username = (this.agentJiraUsername || process.env.JIRA_USERNAME || "").trim();
    const token = (this.agentJiraToken || process.env.JIRA_TOKEN || "").trim();
    if (!username || !token) {
      throw new Error("JIRA_USERNAME and JIRA_TOKEN are required for MERIDIAN");
    }
    return { username, token };
  }

  private getAuthHeader(): string {
    const { username, token } = this.getJiraCredentials();
    const encoded = Buffer.from(
      `${username}:${token}`,
    ).toString("base64");
    return `Basic ${encoded}`;
  }

  private cockpitHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const operatorIdHeader = process.env.DASHBOARD_OPERATOR_ID_HEADER?.trim();
    const operatorNameHeader = process.env.DASHBOARD_OPERATOR_NAME_HEADER?.trim();
    if (operatorIdHeader) {
      headers[operatorIdHeader] = process.env.MERIDIAN_COCKPIT_OPERATOR_ID?.trim() || "meridian-worker";
    }
    if (operatorNameHeader) {
      headers[operatorNameHeader] = process.env.MERIDIAN_COCKPIT_OPERATOR_NAME?.trim() || "MERIDIAN Worker";
    }
    return headers;
  }

  private meridianHeaders(headers: unknown = {}): Record<string, string> {
    const merged: Record<string, string> = {};
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        merged[key] = value;
      });
    } else if (Array.isArray(headers)) {
      for (const [key, value] of headers) {
        if (key && value !== undefined) {
          merged[key] = value;
        }
      }
    } else if (headers && typeof headers === "object") {
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          merged[key] = value.join(", ");
        } else if (value !== undefined && value !== null) {
          merged[key] = String(value);
        }
      }
    }
    if (this.meridianBackendToken) {
      merged.Authorization = `Bearer ${this.meridianBackendToken}`;
    }
    return merged;
  }

  private async attachSqlToCockpitRun(
    jiraNumber: string,
    target: MeridianTarget,
    result: MeridianGenerationResult,
    durationMs: number,
    logContext: Record<string, unknown>,
  ): Promise<void> {
    if (!this.cockpitApiBaseUrl) {
      return;
    }

    try {
      const listResponse = await fetch(`${this.cockpitApiBaseUrl}/runs`, {
        method: "GET",
        headers: this.cockpitHeaders(),
      });
      if (!listResponse.ok) {
        throw new Error(`Cockpit run lookup failed: ${listResponse.status} ${listResponse.statusText}`);
      }
      const payload = await listResponse.json().catch(() => ({})) as {
        runs?: Array<{ id?: string; jiraKey?: string }>;
      };
      const run = payload.runs?.find((candidate) => candidate.jiraKey === jiraNumber && candidate.id);
      if (!run?.id) {
        logger.warn({ ...logContext }, "[MERIDIAN_COCKPIT_ATTACH_SKIP] No matching Cockpit run found");
        return;
      }

      const attachResponse = await fetch(`${this.cockpitApiBaseUrl}/runs/${encodeURIComponent(run.id)}/meridian/evidence`, {
        method: "POST",
        headers: this.cockpitHeaders(),
        body: JSON.stringify({
          summary: result.summary,
          recommendation: "Review the generated SQL file in Cockpit and create the linked DBA ticket before execution.",
          status: "awaiting_review",
          confidence: result.updateCount && result.updateCount > 0 ? 0.74 : 0.68,
          clientSummary: "Meridian generated a DBA-review SQL file from the Jira ticket context.",
          internalAnalysis: [
            "Meridian generated SQL and attached it to Cockpit as a file artifact.",
            `Target: ${target.id}`,
            `Source: ${result.source}`,
            `Duration: ${(durationMs / 1000).toFixed(1)}s`,
            `Updates detected: ${result.updateCount ?? 0}`,
            `Already matching/skipped: ${result.skippedCount ?? 0}`,
            "Meridian did not execute DML.",
          ].join("\n"),
          validationNotes: "DBA must take backup, run validation SELECTs, execute the attached SQL if approved, and run post-check validation.",
          findings: result.updateCount && result.updateCount > 0
            ? [{
                analyzer: "data",
                severity: "medium",
                title: "Meridian generated DBA-review SQL",
                summary: `${result.updateCount} update statement(s) were generated and attached as a SQL file.`,
                confidence: 0.74,
                requiresAction: "data",
              }]
            : [],
          evidence: [{
            analyzer: "data",
            title: "Meridian SQL generation",
            detail: result.summary,
            meta: ["source:MERIDIAN", result.source, target.id, "sql-attached"],
            trace: [],
          }],
          sqlArtifact: {
            content: result.sql,
            filename: result.filename,
            source: result.source,
            updateCount: result.updateCount,
            skippedCount: result.skippedCount,
          },
        }),
      });
      if (!attachResponse.ok) {
        const text = await attachResponse.text().catch(() => "");
        throw new Error(`Cockpit SQL attach failed: ${attachResponse.status} ${attachResponse.statusText} ${text.slice(0, 300)}`);
      }
      logger.info({ ...logContext, runId: run.id }, "[MERIDIAN_COCKPIT_ATTACH_SUCCESS] SQL attached to Cockpit run");
    } catch (error) {
      logger.warn(
        { ...logContext, error: error instanceof Error ? error.message : String(error) },
        "[MERIDIAN_COCKPIT_ATTACH_WARN] Failed to attach SQL to Cockpit run",
      );
    }
  }

  private async writeLocalSqlArtifact(
    result: MeridianGenerationResult,
    logContext: Record<string, unknown>,
  ): Promise<string | undefined> {
    const configuredDir = (
      process.env.MERIDIAN_LOCAL_SQL_OUTPUT_DIR ||
      process.env.INVESTIGATION_MERIDIAN_LOCAL_SQL_OUTPUT_DIR ||
      ""
    ).trim();
    if (!configuredDir) {
      return undefined;
    }

    const outputDir = expandHomePath(configuredDir);
    const filename = sanitizeFilename(result.filename);
    const outputPath = await uniqueOutputPath(outputDir, filename);
    await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(outputPath, result.sql.trimEnd() + "\n", { encoding: "utf8", mode: 0o600 });
    logger.info(
      {
        ...logContext,
        outputPath,
        filename,
        source: result.source,
        updateCount: result.updateCount,
        skippedCount: result.skippedCount,
      },
      "[MERIDIAN_LOCAL_SQL_WRITTEN] Local SQL artifact written",
    );
    return outputPath;
  }

  private async fetchIssue(jiraNumber: string): Promise<JiraIssueForMeridian> {
    if (!this.jiraBaseUrl) {
      throw new Error("JIRA_BASE_URL is required for MERIDIAN");
    }

    const params = new URLSearchParams({
      expand: "names,renderedFields",
      fields: "*all",
    });
    const url = `${this.jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(jiraNumber)}?${params.toString()}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.getAuthHeader(),
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `JIRA fetch failed: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`,
      );
    }

    return (await response.json()) as JiraIssueForMeridian;
  }

  private loadTargets(): MeridianTarget[] {
    const rawJson = process.env.MERIDIAN_TARGETS_JSON?.trim();
    if (rawJson) {
      const parsed = JSON.parse(rawJson) as MeridianTargetsFile | MeridianTarget[];
      return Array.isArray(parsed) ? parsed : parsed.targets || [];
    }

    const filePath = process.env.MERIDIAN_TARGETS_FILE?.trim();
    if (filePath) {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as MeridianTargetsFile | MeridianTarget[];
      return Array.isArray(parsed) ? parsed : parsed.targets || [];
    }

    return [];
  }

  private resolveTarget(issue: JiraIssueForMeridian): MeridianTarget {
    const targets = this.loadTargets();
    if (targets.length === 0) {
      throw new Error(
        "No MERIDIAN targets configured. Set MERIDIAN_TARGETS_JSON or MERIDIAN_TARGETS_FILE.",
      );
    }

    const client = this.extractClient(issue);
    const environment = this.extractEnvironment(issue);
    const normalizedClient = normalizeToken(client || "");
    const normalizedEnvironment = normalizeToken(environment || "");

    const matching = targets.filter((target) => {
      const clientMatch = target.clients.some((candidate) =>
        tokenMatches(normalizedClient, normalizeToken(candidate)),
      );
      const envs = target.environments || [];
      const envMatch =
        envs.length === 0 ||
        envs.some((candidate) =>
          tokenMatches(normalizedEnvironment, normalizeToken(candidate)),
        );
      return clientMatch && envMatch;
    });

    if (matching.length === 1) {
      return matching[0];
    }

    if (matching.length > 1) {
      const preferred = matching.find((target) => target.environments?.length);
      if (preferred) {
        return preferred;
      }
    }

    throw new Error(
      `No MERIDIAN target matched Jira client/env. client=${client || "unknown"}, environment=${environment || "unknown"}`,
    );
  }

  private extractClient(issue: JiraIssueForMeridian): string | null {
    const scopeOverride = process.env.MERIDIAN_TARGET_CLIENT_OVERRIDE?.trim();
    if (scopeOverride) {
      return scopeOverride;
    }

    const candidates = [
      "customer",
      "client",
      "client name",
      "customer name",
      "customfield_10047",
      "customfield_10100",
    ];

    const byName = this.extractFieldByName(issue, candidates);
    if (byName) {
      return byName;
    }

    const summary = issue.fields.summary || "";
    const labels = issue.fields.labels || [];
    const haystack = `${summary} ${labels.join(" ")}`;
    const match = haystack.match(/\b(BSC|BSCA|Cigna|CVS|Wellcare|Centene|Humana)\b/i);
    return match?.[1] || null;
  }

  private extractEnvironment(issue: JiraIssueForMeridian): string | null {
    const scopeOverride = process.env.MERIDIAN_TARGET_ENVIRONMENT_OVERRIDE?.trim();
    if (scopeOverride) {
      return scopeOverride;
    }

    const byName = this.extractFieldByName(issue, [
      "environment",
      "env",
      "target environment",
      "deployment environment",
    ]);
    if (byName) {
      return byName;
    }

    const text = [
      issue.fields.summary || "",
      ...(issue.fields.labels || []),
      adfToMarkdown(issue.fields.description),
    ].join(" ");
    const match = text.match(/\b(PROD1|PROD|DR|UAT1|UAT|QA|DEV)\b/i);
    return match?.[1]?.toUpperCase() || "PROD";
  }

  private extractFieldByName(issue: JiraIssueForMeridian, names: string[]): string | null {
    const wanted = names.map((name) => name.toLowerCase());
    for (const [fieldId, value] of Object.entries(issue.fields)) {
      const displayName = issue.names?.[fieldId]?.toLowerCase() || fieldId.toLowerCase();
      if (!wanted.some((name) => displayName === name || displayName.includes(name))) {
        continue;
      }
      const normalized = sanitizeJiraValue(value);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  private async buildAwsExecutionContext(target: MeridianTarget): Promise<AwsExecutionContext> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const profileArgs = target.awsProfile ? ["--profile", target.awsProfile] : [];

    if (!target.assumeRoleArn) {
      return { env, profileArgs };
    }
    if (!allowHostedMeridianAccess()) {
      throw new Error(
        `MERIDIAN target ${target.id} requires assume-role access. Hosted access is disabled by default for local governance-review runs; set MERIDIAN_ALLOW_HOSTED_ACCESS=true only after separate approval.`,
      );
    }

    const args = [
      "sts",
      "assume-role",
      ...profileArgs,
      "--role-arn",
      target.assumeRoleArn,
      "--role-session-name",
      `meridian-${Date.now()}`,
      "--output",
      "json",
    ];
    const { stdout } = await execFileAsync("aws", args, { env });
    const payload = JSON.parse(stdout) as {
      Credentials?: {
        AccessKeyId?: string;
        SecretAccessKey?: string;
        SessionToken?: string;
      };
    };
    const credentials = payload.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
      throw new Error("aws sts assume-role did not return temporary credentials");
    }

    env.AWS_ACCESS_KEY_ID = credentials.AccessKeyId;
    env.AWS_SECRET_ACCESS_KEY = credentials.SecretAccessKey;
    env.AWS_SESSION_TOKEN = credentials.SessionToken;
    delete env.AWS_PROFILE;

    return { env, profileArgs: [] };
  }

  private async resolveDbCredentials(
    target: MeridianTarget,
    awsContext: AwsExecutionContext,
  ): Promise<DbCredentials> {
    const username = firstNonEmpty(
      process.env.MERIDIAN_DB_USERNAME,
      process.env.INVESTIGATION_DB_USERNAME,
    );
    const password = firstNonEmpty(
      process.env.MERIDIAN_DB_PASSWORD,
      process.env.INVESTIGATION_DB_PASSWORD,
    );
    const database = firstNonEmpty(
      process.env.MERIDIAN_DB_DATABASE,
      process.env.INVESTIGATION_DB_DATABASE,
      target.database,
      target.databaseName,
    ) || "medhok";
    const authPlugin = process.env.MERIDIAN_DB_AUTH_PLUGIN?.trim() || undefined;
    const krbServicePrincipal = process.env.MERIDIAN_DB_KRB_SERVICE_PRINCIPAL?.trim() || undefined;
    const sslCa = process.env.MERIDIAN_DB_SSL_CA?.trim() || undefined;
    const sslVerifyIdentity = envFlag("MERIDIAN_DB_SSL_VERIFY_IDENTITY", true);
    if (requireOperatorDbCredentials()) {
      if (!username || !password) {
        throw new Error(
          `MERIDIAN operator credential mode is enabled for target ${target.id}. Set MERIDIAN_DB_USERNAME/MERIDIAN_DB_PASSWORD or Cockpit INVESTIGATION_DB_USERNAME/INVESTIGATION_DB_PASSWORD to the operator's own LDAP DB credential; target/service secrets are not allowed.`,
        );
      }
      logger.info(
        {
          targetId: target.id,
          database,
          authPlugin: authPlugin || "server_default",
          sslCaConfigured: Boolean(sslCa),
        },
        "[MERIDIAN_OPERATOR_DB_AUTH] Using operator-supplied DB credential",
      );
      return {
        username,
        password,
        database,
        authPlugin,
        krbServicePrincipal,
        sslCa,
        sslVerifyIdentity,
        operatorRuntime: true,
      };
    }

    if (!allowHostedMeridianAccess()) {
      throw new Error(
        `Shared/service DB credential fallback is disabled for MERIDIAN target ${target.id}. Operator LDAP DB credentials are required by default; set MERIDIAN_ALLOW_HOSTED_ACCESS=true only after separate hosted-access approval.`,
      );
    }

    if (target.dbSecretId) {
      const args = [
        "secretsmanager",
        "get-secret-value",
        ...awsContext.profileArgs,
        "--region",
        this.resolveSecretRegion(target),
        "--secret-id",
        target.dbSecretId,
        "--query",
        "SecretString",
        "--output",
        "text",
      ];
      const { stdout } = await execFileAsync("aws", args, { env: awsContext.env });
      const secretString = stdout.trim();
      const parsed = parseSecretString(secretString);
      return {
        username: parsed.username,
        password: parsed.password,
        database: parsed.database || target.database || "medhok",
      };
    }

    return resolveMeridianDbCredentialsFromEnv(target);
  }

  private resolveSecretRegion(target: MeridianTarget): string {
    const region = target.dbSecretRegion || target.region;
    if (!region) {
      throw new Error(
        `MERIDIAN target ${target.id} uses dbSecretId but does not define dbSecretRegion or region.`,
      );
    }
    return region;
  }

  private async startLdapSshTunnel(
    target: MeridianTarget,
    localPort: number,
  ): Promise<MeridianDbTunnel> {
    const args = buildMeridianLdapSshTunnelArgs(target, localPort);
    const sshHost = resolveMeridianSshHost(target);
    const remotePort = target.remotePort || MYSQL_PORT;

    logger.info(
      {
        targetId: target.id,
        sshHost,
        remoteHost: target.remoteHost,
        remotePort,
        localPort,
      },
      "[MERIDIAN_LDAP_SSH_START] Starting LDAP SSH DB port forward",
    );

    const child = spawn("ssh", args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrTail: string[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      pushTail(stderrTail, chunk.toString("utf8"));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text.includes("Port") || text.includes("Waiting")) {
        logger.debug({ targetId: target.id, message: text.trim() }, "[MERIDIAN_LDAP_SSH_STDOUT]");
      }
    });
    child.on("exit", (code, signal) => {
      logger.info({ targetId: target.id, code, signal }, "[MERIDIAN_LDAP_SSH_EXIT]");
    });

    await this.waitForLdapSshStartup(target, localPort, child, stderrTail);

    return { process: child, localPort, stderrTail, accessPath: "ldap_ssh" };
  }

  private async waitForLdapSshStartup(
    target: MeridianTarget,
    localPort: number,
    child: Pick<EventEmitter, "once">,
    stderrTail: string[],
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      timer = setTimeout(settleResolve, 1000);
      child.once("error", (error) => {
        settleReject(error);
      });
      child.once("exit", async (code) => {
        if (code === 0) {
          try {
            await this.waitForPort(localPort, 5000, "muxed LDAP SSH local DB tunnel port");
            logger.info(
              { targetId: target.id, localPort },
              "[MERIDIAN_LDAP_SSH_MUX_FORWARD_READY] Reused ControlMaster port forward is ready",
            );
            settleResolve();
          } catch (error) {
            settleReject(
              new Error(
                `${buildMeridianSshEarlyExitMessage(target, code, stderrTail, process.env)} Local port ${localPort} did not become reachable after the successful mux client exit: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
          return;
        }

        settleReject(
          new Error(
            buildMeridianSshEarlyExitMessage(target, code, stderrTail, process.env),
          ),
        );
      });
    });
  }

  private async prepareDbEndpoint(target: MeridianTarget): Promise<MeridianDbEndpoint> {
    const directLocal = isDirectLocalMeridianTarget(target);
    const directNetwork = DIRECT_NETWORK_PATHS.has(normalizeNetworkPath(target.networkPath));
    if (directLocal || directNetwork) {
      const host = target.remoteHost.trim();
      const port = target.remotePort || MYSQL_PORT;
      if (!(await canConnect(host, port))) {
        throw new Error(
          `MERIDIAN approved ${directLocal ? "direct local" : "private network"} DB endpoint is not reachable at ${host}:${port}. Verify the resolved Cockpit connection target and operator network access.`,
        );
      }
      logger.info(
        {
          targetId: target.id,
          host,
          port,
        },
        directLocal
          ? "[MERIDIAN_DIRECT_LOCAL_DB] Using approved local DB endpoint"
          : "[MERIDIAN_DIRECT_NETWORK_DB] Using approved private network DB endpoint",
      );
      return { host, port, accessPath: directLocal ? "direct_local" : "direct_network" };
    }

    const localPort = await this.getFreePort();
    const activeTunnel = await this.startLdapSshTunnel(target, localPort);
    await this.waitForPort(localPort, 30000, "LDAP SSH local DB tunnel port");
    return {
      host: "127.0.0.1",
      port: localPort,
      accessPath: "ldap_ssh",
      tunnel: activeTunnel,
    };
  }

  private async stopDbTunnel(tunnel: MeridianDbTunnel): Promise<void> {
    if (tunnel.process.exitCode !== null) {
      return;
    }

    tunnel.process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      tunnel.process.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    if (tunnel.process.exitCode === null) {
      tunnel.process.kill("SIGKILL");
    }
  }

  private async getFreePort(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Could not allocate local port"));
          return;
        }
        const port = address.port;
        server.close(() => resolve(port));
      });
    });
  }

  private async waitForPort(port: number, timeoutMs: number, label: string = "local port"): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await canConnect("127.0.0.1", port);
      if (ok) {
        return;
      }
      await sleep(500);
    }
    throw new Error(`Timed out waiting for ${label} ${port}`);
  }

  private async ensureMeridianHealthy(): Promise<void> {
    const response = await fetch(`${this.meridianApiBaseUrl}/health`);
    if (!response.ok) {
      throw new Error(`Meridian API health check failed: ${response.status}`);
    }
  }

  private async ensureMeridianBackend(credentials: DbCredentials): Promise<MeridianBackendHandle | null> {
    try {
      await this.ensureMeridianHealthy();
      return null;
    } catch (error) {
      if (!this.autostartMeridianBackend) {
        throw error;
      }
    }

    const backendDir = path.resolve(
      process.cwd(),
      process.env.MERIDIAN_BACKEND_DIR || DEFAULT_MERIDIAN_BACKEND_DIR,
    );
    await fs.access(path.join(backendDir, "main.py")).catch(() => {
      throw new Error(
        `Packaged Meridian backend was not found at ${backendDir}. Set MERIDIAN_API_BASE_URL for an external backend or MERIDIAN_BACKEND_DIR for a packaged backend.`,
      );
    });

    const port = this.getEmbeddedBackendPort();
    const python = process.env.MERIDIAN_BACKEND_PYTHON || "python3";
    const profilesDir =
      process.env.MERIDIAN_PROFILES_DIR ||
      path.join(os.tmpdir(), "meridian-profiles");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      MERIDIAN_BACKEND_PORT: String(port),
      MERIDIAN_PACKAGED_BACKEND: process.env.MERIDIAN_PACKAGED_BACKEND || "true",
      MERIDIAN_BACKEND_TOKEN: this.meridianBackendToken,
      MERIDIAN_ENABLE_PROFILE_STORE: process.env.MERIDIAN_ENABLE_PROFILE_STORE || "false",
      MERIDIAN_REQUIRE_BACKEND_AUTH: process.env.MERIDIAN_REQUIRE_BACKEND_AUTH || "true",
      MERIDIAN_PROFILES_DIR: profilesDir,
      MERIDIAN_DB_USERNAME: process.env.MERIDIAN_DB_USERNAME || credentials.username,
      MERIDIAN_DB_PASSWORD: process.env.MERIDIAN_DB_PASSWORD || credentials.password,
      MERIDIAN_DB_DATABASE: process.env.MERIDIAN_DB_DATABASE || credentials.database,
      MERIDIAN_LLM_MODEL_ID:
        process.env.MERIDIAN_LLM_MODEL_ID ||
        this.agentModel ||
        process.env.AGENT_MODEL ||
        process.env.ANTHROPIC_MODEL,
      MERIDIAN_LLM_REGION:
        process.env.MERIDIAN_LLM_REGION ||
        process.env.AWS_REGION ||
        process.env.AWS_DEFAULT_REGION,
    };

    logger.info(
      {
        backendDir,
        port,
        model: env.MERIDIAN_LLM_MODEL_ID,
      },
      "[MERIDIAN_BACKEND_START] Starting embedded Meridian backend",
    );
    const child = spawn(
      python,
      ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(port)],
      {
        cwd: backendDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const stderrTail: string[] = [];
    child.stdout.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        logger.debug({ message }, "[MERIDIAN_BACKEND_STDOUT]");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      pushTail(stderrTail, chunk.toString("utf8"));
    });
    child.on("exit", (code, signal) => {
      logger.info({ code, signal }, "[MERIDIAN_BACKEND_EXIT]");
    });

    try {
      await this.waitForMeridianBackend(child, stderrTail, 30000);
      return { process: child, profilesDir };
    } catch (error) {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      throw error;
    }
  }

  private getEmbeddedBackendPort(): number {
    const configured = process.env.MERIDIAN_BACKEND_PORT?.trim();
    if (configured) {
      const parsed = Number.parseInt(configured, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
    try {
      const apiUrl = new URL(this.meridianApiBaseUrl);
      const parsed = apiUrl.port ? Number.parseInt(apiUrl.port, 10) : 8001;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 8001;
    } catch {
      return 8001;
    }
  }

  private async waitForMeridianBackend(
    child: ChildProcess,
    stderrTail: string[],
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `Packaged Meridian backend exited before becoming healthy, code=${child.exitCode}. ${stderrTail.join(" ")}`,
        );
      }
      try {
        await this.ensureMeridianHealthy();
        return;
      } catch {
        await sleep(500);
      }
    }
    throw new Error(
      `Timed out waiting for packaged Meridian backend health check. ${stderrTail.join(" ")}`,
    );
  }

  private async stopMeridianBackend(handle: MeridianBackendHandle): Promise<void> {
    if (handle.process.exitCode === null) {
      handle.process.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        handle.process.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    if (handle.process.exitCode === null) {
      handle.process.kill("SIGKILL");
    }
    await fs.rm(handle.profilesDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private async activateMeridianConnection(
    target: MeridianTarget,
    host: string,
    port: number,
    credentials: DbCredentials,
  ): Promise<void> {
    const requestBody = {
      client: target.clients[0] || target.id,
      environment: target.environments?.[0] || "PROD",
      host,
      port,
      database: credentials.database,
    };

    await this.fetchMeridianJson("/connections/activate-from-ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
  }

  private async fetchMeridianJson(pathname: string, init?: RequestInit): Promise<any> {
    const response = await fetch(`${this.meridianApiBaseUrl}${pathname}`, {
      ...init,
      headers: this.meridianHeaders(init?.headers),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Meridian API ${pathname} failed: ${response.status} ${response.statusText} - ${text.substring(0, 300)}`,
      );
    }
    return await response.json().catch(() => ({}));
  }

  private async downloadBestSpreadsheet(
    issue: JiraIssueForMeridian,
    logContext: Record<string, unknown>,
  ): Promise<DownloadedAttachment | null> {
    const attachments = issue.fields.attachment || [];
    const candidates = attachments
      .filter((attachment) => /\.(xlsx|xls|csv)$/i.test(attachment.filename || ""))
      .sort((a, b) => (b.created || "").localeCompare(a.created || ""));

    if (candidates.length === 0) {
      logger.info(logContext, "[MERIDIAN_ATTACHMENT_NONE] No spreadsheet attachment found");
      return null;
    }

    const selected = candidates[0];
    if (!selected.content) {
      throw new Error(`Spreadsheet attachment ${selected.filename} has no content URL`);
    }

    const response = await fetch(selected.content, {
      method: "GET",
      headers: { Authorization: this.getAuthHeader(), Accept: "*/*" },
    });
    if (!response.ok) {
      throw new Error(
        `Jira attachment download failed for ${selected.filename}: ${response.status} ${response.statusText}`,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const safeName = sanitizeFilename(selected.filename);
    const localPath = path.join(os.tmpdir(), `meridian-${issue.key}-${Date.now()}-${safeName}`);
    await fs.writeFile(localPath, buffer);

    logger.info(
      {
        ...logContext,
        filename: selected.filename,
        size: buffer.length,
      },
      "[MERIDIAN_ATTACHMENT_DOWNLOADED] Spreadsheet attachment downloaded",
    );

    return { filename: selected.filename, localPath, buffer };
  }

  private async generateFromSpreadsheet(
    jiraNumber: string,
    issue: JiraIssueForMeridian,
    attachment: DownloadedAttachment,
  ): Promise<MeridianGenerationResult> {
    const form = new FormData();
    form.append("file", new Blob([Uint8Array.from(attachment.buffer)]), attachment.filename);
    form.append("ticket_text", [
      `Jira: ${jiraNumber}`,
      `Summary: ${issue.fields.summary || ""}`,
      "",
      adfToMarkdown(issue.fields.description),
    ].join("\n"));

    const response = await fetch(`${this.meridianApiBaseUrl}/generate/from-spreadsheet`, {
      method: "POST",
      headers: this.meridianHeaders(),
      body: form,
    });
    const sql = await response.text();
    if (!response.ok) {
      throw new Error(
        `Meridian spreadsheet generation failed: ${response.status} ${sql.substring(0, 300)}`,
      );
    }

    const updateCount = countSqlUpdates(sql);
    const skippedCount = countAlreadyDone(sql);
    return {
      summary: [
        "Meridian generated SQL from the spreadsheet attachment.",
        `Source file: ${attachment.filename}`,
        `Updates detected in generated SQL: ${updateCount}`,
      ].join("\n"),
      sql,
      filename: `${jiraNumber}_meridian.sql`,
      source: "meridian-api",
      updateCount,
      skippedCount,
    };
  }

  private async generateFromTicketText(
    jiraNumber: string,
    issue: JiraIssueForMeridian,
  ): Promise<MeridianGenerationResult> {
    const ticketText = [
      `Jira: ${jiraNumber}`,
      `Summary: ${issue.fields.summary || ""}`,
      "",
      adfToMarkdown(issue.fields.description),
    ].join("\n");

    const parseResponse = await this.fetchMeridianJson("/parse-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: ticketText }),
    });
    const rows = Array.isArray(parseResponse.rows) ? parseResponse.rows : [];
    if (rows.length === 0) {
      return {
        summary:
          "Meridian could not extract deterministic case updates from the Jira text. No SQL was generated.",
        sql: "/* No changes to generate. Meridian parse-text returned zero rows. */\n",
        filename: `${jiraNumber}_meridian.sql`,
        source: "ticket-text",
        rowCount: 0,
        updateCount: 0,
        skippedCount: 0,
      };
    }

    const response = await fetch(`${this.meridianApiBaseUrl}/generate/download`, {
      method: "POST",
      headers: this.meridianHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        changes: rows,
        debug: true,
        source_file: `${jiraNumber}-jira-text`,
      }),
    });
    const sql = await response.text();
    if (!response.ok) {
      throw new Error(`Meridian text generation failed: ${response.status} ${sql}`);
    }

    return {
      summary: `Meridian extracted ${rows.length} change row(s) from Jira text and generated SQL.`,
      sql,
      filename: `${jiraNumber}_meridian.sql`,
      source: "ticket-text",
      rowCount: rows.length,
      updateCount: countSqlUpdates(sql),
      skippedCount: countAlreadyDone(sql),
    };
  }

  private shouldTryCorrespondenceFallback(sql: string): boolean {
    return /No rows parsed from spreadsheet|No changes to generate/i.test(sql);
  }

  private async generateCorrespondenceSql(
    jiraNumber: string,
    issue: JiraIssueForMeridian,
    attachment: DownloadedAttachment,
    target: MeridianTarget,
    credentials: DbCredentials,
    host: string,
    port: number,
  ): Promise<MeridianGenerationResult | null> {
    const rows = parseCorrespondenceRows(attachment.buffer);
    if (!rows) {
      return null;
    }

    const connection = await mysql.createConnection({
      host,
      port,
      user: credentials.username,
      password: credentials.password,
      database: credentials.database,
      connectTimeout: 15000,
    });

    try {
      await setDirectReadonlySession(connection);
      await verifyDirectReadonlyGrants(connection);

      const statusRows = await queryRows<{ id: number; description: string }>(
        connection,
        "SELECT id, description FROM correspondance_status",
      );
      const statusByName = new Map(
        statusRows.map((row) => [String(row.description).trim().toLowerCase(), Number(row.id)]),
      );

      const ids = rows.map((row) => row.id);
      const dbRows = await fetchCorrespondenceDbRows(connection, ids);
      const byId = new Map(dbRows.map((row) => [Number(row.id), row]));
      const missing = rows.filter((row) => !byId.has(row.id));

      const sqlLines: string[] = [];
      const generatedAt = new Date().toISOString();
      sqlLines.push("/*");
      sqlLines.push(`MERIDIAN Correspondence Validation SQL`);
      sqlLines.push(`Jira: ${jiraNumber}`);
      sqlLines.push(`Source file: ${attachment.filename}`);
      sqlLines.push(`Target: ${target.id}`);
      sqlLines.push(`Generated: ${generatedAt}`);
      sqlLines.push("MERIDIAN does not execute this SQL. DBA review is required.");
      sqlLines.push("*/");
      sqlLines.push("");
      sqlLines.push("/* Status reference */");
      sqlLines.push("SELECT id, description FROM correspondance_status ORDER BY id;");
      sqlLines.push("");
      sqlLines.push(`/* Input validation: expected ${rows.length} spreadsheet row(s) */`);
      sqlLines.push(`SELECT COUNT(*) AS matched_rows`);
      sqlLines.push(`FROM correspondance_tracking`);
      sqlLines.push(`WHERE id IN (${formatIdList(ids)});`);
      sqlLines.push("");

      let updates = 0;
      let alreadyDone = 0;
      let manualReview = missing.length;

      const updateLines: string[] = [];
      for (const row of rows) {
        const current = byId.get(row.id);
        if (!current) {
          continue;
        }

        const expectedKey = row.expectedStatus.trim().toLowerCase();
        const targetStatusId = statusByName.get(expectedKey);
        if (!targetStatusId) {
          manualReview += 1;
          continue;
        }

        if (current.status_id === targetStatusId) {
          alreadyDone += 1;
          continue;
        }

        updates += 1;
        updateLines.push(...buildCorrespondenceUpdateBlock(row, current, targetStatusId));
      }

      if (updates > 0) {
        sqlLines.push("START TRANSACTION;");
        sqlLines.push("");
        sqlLines.push(...updateLines);
        sqlLines.push("/* DBA: run COMMIT only after backup and validate queries return expected rows. */");
        sqlLines.push("COMMIT;");
        sqlLines.push("");
      } else {
        sqlLines.push("/* No UPDATE statements generated: live DB already matches resolvable expected statuses. */");
        sqlLines.push("");
      }

      sqlLines.push("/* Final status breakdown for all spreadsheet rows */");
      sqlLines.push("SELECT cs.description AS current_status, COUNT(*) AS row_count");
      sqlLines.push("FROM correspondance_tracking ct");
      sqlLines.push("LEFT JOIN correspondance_status cs ON cs.id = ct.status_id");
      sqlLines.push(`WHERE ct.id IN (${formatIdList(ids)})`);
      sqlLines.push("GROUP BY cs.description");
      sqlLines.push("ORDER BY row_count DESC, current_status;");
      sqlLines.push("");

      if (missing.length > 0) {
        sqlLines.push("/* Missing spreadsheet IDs, manual review required */");
        sqlLines.push(`/* ${missing.map((row) => row.id).join(", ")} */`);
        sqlLines.push("");
      }

      const retriggered = rows.filter((row) =>
        /retriggered by mhk through script fix/i.test(row.expectedStatus),
      );
      if (retriggered.length > 0) {
        manualReview += retriggered.length;
        sqlLines.push("/* Rows marked 'Retriggered by MHK through script fix' require manual/script review. */");
        sqlLines.push(`/* Count: ${retriggered.length} */`);
        sqlLines.push("");
      }

      const summary = [
        "Meridian used the correspondence-tracking fallback because the standard module parser found no rows.",
        `Spreadsheet rows: ${rows.length}`,
        `DB matches: ${dbRows.length}`,
        `Generated UPDATE statements: ${updates}`,
        `Already matching target status: ${alreadyDone}`,
        `Manual review rows: ${manualReview}`,
      ].join("\n");

      return {
        summary,
        sql: sqlLines.join("\n"),
        filename: `${jiraNumber}_meridian_correspondence.sql`,
        source: "correspondence-fallback",
        rowCount: rows.length,
        updateCount: updates,
        skippedCount: alreadyDone,
      };
    } finally {
      await connection.end();
    }
  }

  private formatOutput(
    jiraNumber: string,
    issue: JiraIssueForMeridian,
    target: MeridianTarget,
    result: MeridianGenerationResult,
    durationMs: number,
    localSqlPath?: string,
  ): string {
    const sqlFilename = sanitizeFilename(result.filename);
    const attachmentFilename = redactedSqlFilename(sqlFilename);
    const sqlAttachment = buildRedactedSqlPreview(result.sql).trimEnd();
    return [
      `## MERIDIAN SQL Generation: ${jiraNumber}`,
      "",
      `Summary: ${issue.fields.summary || "(no summary)"}`,
      "",
      result.summary,
      "",
      "Safeguards applied:",
      "- Jira ticket and attachment were fetched directly by MERIDIAN.",
      "- DB access requires the attended, approved local network path for this governance-review build.",
      "- Operator LDAP DB credentials are required by default and are not written to logs.",
      "- MERIDIAN generated SQL only; it did not execute DML.",
      "- Jira receives a redacted SQL preview only; executable SQL must use an approved secure DBA handoff path.",
      "- Human DBA review remains required before execution.",
      "",
      `Target: ${target.id}`,
      `Source: ${result.source}`,
      `Duration: ${(durationMs / 1000).toFixed(1)}s`,
      "",
      `SQL attachment: ${attachmentFilename}`,
      ...(localSqlPath ? [`Local SQL artifact: ${localSqlPath}`] : []),
      "",
      `<!-- MERIDIAN_SQL_ATTACHMENT_START filename="${attachmentFilename}" -->`,
      sqlAttachment,
      `<!-- MERIDIAN_SQL_ATTACHMENT_END -->`,
      "",
      "*Generated by MERIDIAN.*",
    ].join("\n");
  }
}

function sanitizeJiraValue(value: unknown): string | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = sanitizeJiraValue(item);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return sanitizeJiraValue(
      record.value ?? record.name ?? record.displayName ?? record.key ?? null,
    );
  }
  return String(value);
}

function normalizeToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(cp|prod|production)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function tokenMatches(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }
  return left === right || left.includes(right) || right.includes(left);
}

function normalizeNetworkPath(value: string | undefined): string {
  return (value || "ssh_public").trim().toLowerCase();
}

function isLoopbackHost(value: string | undefined): boolean {
  const host = value?.trim().toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isDirectLocalMeridianTarget(target: MeridianTarget): boolean {
  const networkPath = normalizeNetworkPath(target.networkPath);
  if (!DIRECT_LOCAL_NETWORK_PATHS.has(networkPath)) {
    return false;
  }
  if (!isLoopbackHost(target.remoteHost)) {
    throw new Error(
      `MERIDIAN target ${target.id} uses networkPath=${target.networkPath}, but direct-local DB access is only allowed for loopback hosts.`,
    );
  }
  return true;
}

function resolveMeridianSshHost(target: MeridianTarget): string | undefined {
  return (
    target.publicHost ||
    target.sshHost ||
    target.loginHost ||
    target.bastionHost
  )?.trim();
}

function resolveMeridianSshUser(
  target: MeridianTarget,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return (
    env.MERIDIAN_SSH_USER ||
    env.INVESTIGATION_SSH_USER ||
    target.sshUser ||
    env.USER
  )?.trim();
}

function resolveMeridianSshPort(
  target: MeridianTarget,
  env: NodeJS.ProcessEnv,
): number {
  for (const candidate of [
    env.MERIDIAN_SSH_PORT,
    env.INVESTIGATION_SSH_PORT,
    target.sshPort,
  ]) {
    const parsed = Number(candidate);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 22;
}

function resolveMeridianSshControlPath(
  target: MeridianTarget,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return (
    env.MERIDIAN_SSH_CONTROL_PATH ||
    env.INVESTIGATION_SSH_CONTROL_PATH ||
    target.sshControlPath
  )?.trim();
}

function meridianSshDestination(target: MeridianTarget, env: NodeJS.ProcessEnv): string {
  const sshHost = resolveMeridianSshHost(target) || "<ssh-host>";
  const sshUser = resolveMeridianSshUser(target, env);
  return sshHost.includes("@") || !sshUser ? sshHost : `${sshUser}@${sshHost}`;
}

function buildMeridianSshEarlyExitMessage(
  target: MeridianTarget,
  code: number | null,
  stderrTail: string[],
  env: NodeJS.ProcessEnv,
): string {
  const stderrText = stderrTail.join(" ").trim();
  const permissionDenied = /permission denied/i.test(stderrText);
  if (!permissionDenied) {
    return `LDAP SSH tunnel exited before readiness check, code=${code}. ${stderrText}`;
  }

  const sshPort = resolveMeridianSshPort(target, env);
  const controlPath = resolveMeridianSshControlPath(target, env);
  const destination = meridianSshDestination(target, env);
  const controlSocketHint = controlPath
    ? ` Start an attended operator SSH ControlMaster before retrying: ssh -MNf -S ${controlPath} -p ${sshPort} ${destination}`
    : " Start an attended operator SSH session/key/GSSAPI login or set MERIDIAN_SSH_CONTROL_PATH/INVESTIGATION_SSH_CONTROL_PATH to an active ControlMaster socket before retrying.";

  return [
    `LDAP SSH tunnel exited before readiness check, code=${code}.`,
    stderrText,
    "Non-interactive operator LDAP SSH authentication failed; Meridian does not prompt for or store LDAP SSH passwords.",
    controlSocketHint,
  ].filter(Boolean).join(" ");
}

function assertMeridianLdapSshTarget(
  target: MeridianTarget,
  env: NodeJS.ProcessEnv,
): void {
  const networkPath = normalizeNetworkPath(target.networkPath);
  if (DIRECT_LOCAL_NETWORK_PATHS.has(networkPath)) {
    throw new Error(
      `MERIDIAN target ${target.id} uses networkPath=${target.networkPath}; direct-local DB access does not open an LDAP SSH tunnel.`,
    );
  }
  if (!LDAP_SSH_NETWORK_PATHS.has(networkPath)) {
    throw new Error(
      `MERIDIAN target ${target.id} uses networkPath=${target.networkPath || "unset"}. SSM is disabled for MERIDIAN; configure networkPath=ssh_public with operator LDAP SSH.`,
    );
  }
  if (target.ssmAllowed === true) {
    throw new Error(
      `MERIDIAN target ${target.id} has ssmAllowed=true. SSM is disabled for MERIDIAN; set ssmAllowed=false and use LDAP SSH.`,
    );
  }
  if (target.sshAllowed !== true) {
    throw new Error(
      `MERIDIAN target ${target.id} must set sshAllowed=true for LDAP SSH DB access.`,
    );
  }
  const authMode = (target.sshAuthMode || "operator_ldap").trim().toLowerCase();
  if (authMode !== "operator_ldap") {
    throw new Error(
      `MERIDIAN target ${target.id} must use sshAuthMode=operator_ldap; received ${target.sshAuthMode}.`,
    );
  }
  if (!target.remoteHost?.trim()) {
    throw new Error(`MERIDIAN target ${target.id} must define remoteHost for the database endpoint.`);
  }
  const sshHost = resolveMeridianSshHost(target);
  if (!sshHost) {
    throw new Error(
      `MERIDIAN target ${target.id} must define publicHost, sshHost, loginHost, or bastionHost for LDAP SSH.`,
    );
  }
  if (!sshHost.includes("@") && !resolveMeridianSshUser(target, env)) {
    throw new Error(
      `MERIDIAN target ${target.id} must define sshUser or MERIDIAN_SSH_USER/INVESTIGATION_SSH_USER for LDAP SSH.`,
    );
  }
}

export function buildMeridianLdapSshTunnelArgs(
  target: MeridianTarget,
  localPort: number,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  assertMeridianLdapSshTarget(target, env);

  const sshHost = resolveMeridianSshHost(target)!;
  const sshUser = resolveMeridianSshUser(target, env);
  const sshPort = resolveMeridianSshPort(target, env);
  const controlPath = resolveMeridianSshControlPath(target, env);
  const remotePort = target.remotePort || MYSQL_PORT;
  const destination = sshHost.includes("@") ? sshHost : `${sshUser}@${sshHost}`;
  const args = [
    "-N",
    "-L",
    `127.0.0.1:${localPort}:${target.remoteHost}:${remotePort}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=1",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];

  if (controlPath) {
    args.push(
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${controlPath}`,
      "-o",
      "ControlPersist=5m",
    );
  }

  if (sshPort !== 22) {
    args.push("-p", String(sshPort));
  }

  args.push(destination);
  return args;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function resolveEnvReference(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!trimmed.startsWith("env://")) {
    return trimmed;
  }
  const envName = trimmed.slice("env://".length).trim();
  if (!envName) {
    return undefined;
  }
  return env[envName]?.trim() || undefined;
}

export function resolveMeridianDbCredentialsFromEnv(
  target: MeridianTarget,
  env: NodeJS.ProcessEnv = process.env,
): DbCredentials {
  const username = firstNonEmpty(
    env.MERIDIAN_DB_USERNAME,
    env.INVESTIGATION_DB_USERNAME,
    resolveEnvReference(target.dbUser, env),
    resolveEnvReference(target.dbUsername, env),
    env.MERIDIAN_SSH_USER,
    env.INVESTIGATION_SSH_USER,
    target.sshUser,
  );
  const password = firstNonEmpty(
    env.MERIDIAN_DB_PASSWORD,
    env.INVESTIGATION_DB_PASSWORD,
    resolveEnvReference(target.secretRef, env),
  );
  const database = firstNonEmpty(
    env.MERIDIAN_DB_DATABASE,
    env.INVESTIGATION_DB_DATABASE,
    target.database,
    target.databaseName,
  ) || "medhok";

  if (!username || !password) {
    throw new Error(
      `No DB credentials configured for MERIDIAN target ${target.id}. Set dbSecretId, MERIDIAN_DB_USERNAME/MERIDIAN_DB_PASSWORD, or Cockpit INVESTIGATION_DB_USERNAME/INVESTIGATION_DB_PASSWORD.`,
    );
  }

  return { username, password, database };
}

function parseSecretString(secretString: string): DbCredentials {
  try {
    const parsed = JSON.parse(secretString) as Record<string, unknown>;
    const username = String(parsed.username || parsed.user || "");
    const password = String(parsed.password || "");
    const database = String(parsed.database || parsed.dbname || parsed.db || "");
    if (!username || !password) {
      throw new Error("missing username/password");
    }
    return { username, password, database };
  } catch (error) {
    throw new Error("MERIDIAN DB secret must be JSON with username and password fields");
  }
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "meridian.sql";
}

function expandHomePath(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return path.resolve(inputPath);
}

async function uniqueOutputPath(outputDir: string, filename: string): Promise<string> {
  const parsed = path.parse(filename);
  const base = parsed.name || "meridian";
  const ext = parsed.ext || ".sql";
  for (let index = 0; index < 100; index += 1) {
    const candidate = path.join(outputDir, index === 0 ? `${base}${ext}` : `${base}-${index}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(outputDir, `${base}-${Date.now()}${ext}`);
}

function pushTail(lines: string[], text: string): void {
  lines.push(text.trim());
  while (lines.length > 10) {
    lines.shift();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function canConnect(host: string, port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function countSqlUpdates(sql: string): number {
  return (sql.match(/\bUPDATE\b/gi) || []).length;
}

function countAlreadyDone(sql: string): number {
  return (sql.match(/\bALREADY DONE\b/gi) || []).length;
}

const WRITE_OR_ADMIN_GRANTS = new Set([
  "ALL",
  "ALL PRIVILEGES",
  "ALTER",
  "CREATE",
  "CREATE ROUTINE",
  "CREATE TEMPORARY TABLES",
  "CREATE USER",
  "CREATE VIEW",
  "DELETE",
  "DROP",
  "EVENT",
  "EXECUTE",
  "FILE",
  "GRANT OPTION",
  "INDEX",
  "INSERT",
  "LOCK TABLES",
  "PROCESS",
  "REFERENCES",
  "RELOAD",
  "REPLACE",
  "SHUTDOWN",
  "SUPER",
  "TRIGGER",
  "UPDATE",
]);

async function setDirectReadonlySession(connection: Connection): Promise<void> {
  await connection.query("SET SESSION max_execution_time=10000, SESSION transaction_read_only=ON");
}

async function verifyDirectReadonlyGrants(connection: Connection): Promise<void> {
  const [currentUserRows] = await connection.query("SELECT CURRENT_USER() AS current_user");
  const currentUser =
    Array.isArray(currentUserRows) && currentUserRows.length > 0
      ? String((currentUserRows[0] as Record<string, unknown>).current_user || "unknown")
      : "unknown";
  const [readonlyRows] = await connection.query("SELECT @@session.transaction_read_only AS session_readonly");
  const sessionReadonly =
    Array.isArray(readonlyRows) && readonlyRows.length > 0
      ? String((readonlyRows[0] as Record<string, unknown>).session_readonly)
      : "0";
  if (!["1", "ON", "on", "true", "True"].includes(sessionReadonly)) {
    throw new Error(`MERIDIAN DB session for ${currentUser} is not read-only; transaction_read_only is OFF`);
  }
  const [grantRows] = await connection.query("SHOW GRANTS FOR CURRENT_USER()");
  const denied = new Set<string>();

  for (const row of Array.isArray(grantRows) ? grantRows : []) {
    const grantText = Object.values(row as Record<string, unknown>).map(String).join(" ");
    for (const privilege of parseGrantPrivileges(grantText)) {
      if (WRITE_OR_ADMIN_GRANTS.has(privilege)) {
        denied.add(privilege);
      }
    }
    if (/WITH\s+GRANT\s+OPTION/i.test(grantText)) {
      denied.add("GRANT OPTION");
    }
  }

  if (denied.size > 0) {
    throw new Error(
      `MERIDIAN DB user ${currentUser} is not read-only; denied privilege(s): ${[...denied].sort().join(", ")}`,
    );
  }
}

function parseGrantPrivileges(grantText: string): string[] {
  const match = grantText.toUpperCase().match(/\bGRANT\s+(.+?)\s+ON\b/);
  if (!match) {
    return [];
  }
  return splitGrantPrivileges(match[1])
    .map(normalizeGrantPrivilege)
    .filter((privilege): privilege is string => Boolean(privilege))
    .flatMap((privilege) =>
      privilege === "ALL" ? ["ALL", "ALL PRIVILEGES"] : [privilege],
    );
}

function splitGrantPrivileges(privilegeList: string): string[] {
  const privileges: string[] = [];
  let current = "";
  let parenDepth = 0;

  for (const char of privilegeList) {
    if (char === "(") {
      parenDepth += 1;
      current += char;
      continue;
    }

    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      current += char;
      continue;
    }

    if (char === "," && parenDepth === 0) {
      privileges.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    privileges.push(current);
  }

  return privileges;
}

function normalizeGrantPrivilege(privilege: string): string | null {
  const normalized = privilege.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  return normalized.replace(/\s*\([^)]*\)\s*$/, "").trim() || null;
}

export function parseMeridianGrantPrivilegesForTest(grantText: string): string[] {
  return parseGrantPrivileges(grantText);
}

function redactedSqlFilename(filename: string): string {
  if (/\.sql$/i.test(filename)) {
    return filename.replace(/\.sql$/i, "_redacted_preview.sql");
  }
  return `${filename}_redacted_preview.sql`;
}

function buildRedactedSqlPreview(sql: string): string {
  const body = redactSqlForJira(sql);
  return [
    "/*",
    "MERIDIAN REDACTED SQL PREVIEW - DO NOT EXECUTE FROM JIRA.",
    "String literals and long identifiers are masked to prevent PHI/PII exposure.",
    "DBA execution requires the approved secure SQL handoff path outside Jira.",
    "*/",
    "",
    body,
  ].join("\n");
}

function redactSqlForJira(sql: string): string {
  return sql
    .replace(/'([^'\\]|\\.)*'/g, "'<redacted_value>'")
    .replace(/"([^"\\]|\\.)*"/g, '"<redacted_value>"')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted_email>")
    .replace(/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "<redacted_phone>")
    .replace(/\b\d{6,}\b/g, "<redacted_number>");
}


function parseCorrespondenceRows(buffer: Buffer): CorrespondenceRow[] | null {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  } catch {
    return null;
  }

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return null;
  }

  const sheet = workbook.Sheets[firstSheetName];
  const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: false,
  });
  if (records.length === 0) {
    return null;
  }

  const headerMap = buildHeaderMap(Object.keys(records[0]));
  const idHeader = headerMap.get("correspondence internal id");
  const expectedStatusHeader = headerMap.get("expected status to be updated in mhk");
  if (!idHeader || !expectedStatusHeader) {
    return null;
  }

  const expectedTimestampHeader = headerMap.get("expected time stamp to be updated in mhk");
  const rows: CorrespondenceRow[] = [];
  records.forEach((record, index) => {
    const id = Number(record[idHeader]);
    const expectedStatus = String(record[expectedStatusHeader] || "").trim();
    if (!Number.isFinite(id) || !expectedStatus) {
      return;
    }
    const expectedTimestamp = expectedTimestampHeader
      ? normalizeTimestamp(record[expectedTimestampHeader])
      : undefined;
    rows.push({
      rowNumber: index + 2,
      id,
      expectedStatus,
      expectedTimestamp,
    });
  });

  return rows.length > 0 ? rows : null;
}

function buildHeaderMap(headers: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const header of headers) {
    map.set(
      header
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim(),
      header,
    );
  }
  return map;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }
  const raw = String(value).trim();
  if (!raw) {
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return raw;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
}

async function queryRows<T>(
  connection: Connection,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const [rows] = await connection.query(sql, params);
  return rows as T[];
}

async function fetchCorrespondenceDbRows(
  connection: Connection,
  ids: number[],
): Promise<CorrespondenceDbRow[]> {
  const rows: CorrespondenceDbRow[] = [];
  for (const chunk of chunkArray(ids, 500)) {
    const placeholders = chunk.map(() => "?").join(",");
    rows.push(
      ...(await queryRows<CorrespondenceDbRow>(
        connection,
        `SELECT id, status_id, status_datetime, update_datetime, status_reason
         FROM correspondance_tracking
         WHERE id IN (${placeholders})`,
        chunk,
      )),
    );
  }
  return rows;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function formatIdList(ids: number[]): string {
  return chunkArray(ids, 12)
    .map((chunk) => chunk.join(", "))
    .join(",\n  ");
}

function buildCorrespondenceUpdateBlock(
  row: CorrespondenceRow,
  current: CorrespondenceDbRow,
  targetStatusId: number,
): string[] {
  const lines: string[] = [];
  const timestampSet = row.expectedTimestamp
    ? `,\n    update_datetime = '${escapeSql(row.expectedTimestamp)}'`
    : ",\n    update_datetime = NOW()";

  lines.push(`/* Row ${row.rowNumber}: correspondance_tracking.id=${row.id} */`);
  lines.push("/* Backup (Expected: 1 row fetched) */");
  lines.push(
    "SELECT id, status_id, status_datetime, update_datetime, status_reason " +
      `FROM correspondance_tracking WHERE id = ${row.id};`,
  );
  lines.push("");
  lines.push(
    `/* Update status to ${escapeSql(row.expectedStatus)} (status_id=${targetStatusId}); Expected: 1 row affected */`,
  );
  lines.push("UPDATE correspondance_tracking SET");
  lines.push(`    status_id = ${targetStatusId}${timestampSet}`);
  lines.push(`WHERE id = ${row.id} AND status_id <=> ${current.status_id ?? "NULL"};`);
  lines.push("");
  lines.push("/* Validate (Expected: 1 row fetched) */");
  lines.push(
    "SELECT id, status_id, status_datetime, update_datetime, status_reason " +
      `FROM correspondance_tracking WHERE id = ${row.id};`,
  );
  lines.push("");
  return lines;
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function readBooleanEnv(value: string, defaultValue: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

export default MERIDIANWorker;
