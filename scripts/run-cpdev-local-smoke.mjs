#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config as loadDotenv } from "dotenv";
import mysql from "mysql2/promise";
import {
  GetQueueAttributesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  DEFAULT_MAVEN_SETTINGS_CANDIDATES,
  isMavenBuildsEnabledEnv,
  validateMavenSmokeEnvironment,
} from "./maven-smoke-preflight.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_JIRA_KEY = "CPDEV-21980";
const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:3001";
const DEFAULT_MOTO_ENDPOINT = "http://127.0.0.1:5002";
const DEFAULT_REGION = "us-east-2";
const DEFAULT_OUTPUT_ROOT = path.join("local-e2e", "results");
const REQUIRED_REPO_NAME = "core-app";
const REQUIRED_REPO_URL = "https://github.com/mhk-repos/cp-medhok-monorepo.git";
const TERMINAL_STATES = new Set([
  "approved",
  "blocked",
  "escalated",
  "replan_required",
  "pr_open",
  "completed",
  "failed",
]);
const QUEUE_STAGE_BY_STATE = {
  queued_for_planning: "planning",
  queued_for_review: "review",
  queued_for_implementation: "implementation",
  queued_for_code_review: "code_review",
  queued_for_testing: "testing",
};
const QUEUE_NAME_BY_STAGE = {
  planning: "oneshot-planning.fifo",
  review: "oneshot-review.fifo",
  implementation: "oneshot-implementation.fifo",
  code_review: "oneshot-code-review.fifo",
  testing: "oneshot-testing.fifo",
};
const WORKSPACE_V2_CONTAINER_NAMES = [
  "specter-oneshot-orchestrator",
  "specter-oneshot-qualifier",
  "specter-oneshot-planner",
  "specter-oneshot-reviewer",
  "specter-oneshot-implementer",
  "specter-oneshot-code-reviewer",
  "specter-oneshot-tester",
];
const WORKSPACE_V2_REQUIRED_ENV = [
  "ONESHOT_WORKSPACE_LEASE_TTL_SECONDS",
  "ONESHOT_WORKSPACE_LEASE_HEARTBEAT_SECONDS",
  "ONESHOT_REPO_CACHE_FRESHNESS_TTL_MS",
];
const MULTI_REPO_FULL_DELIVERY_JIRA_KEYS = new Set(["CPDEV-23958"]);
const MULTI_REPO_FEATURE_CONTAINER_NAMES = ["specter-oneshot-qualifier"];
const DEFAULT_QUEUED_STRANDED_GRACE_MS = 10 * 60_000;

function normalizeJiraKey(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(normalized)) {
    throw new Error(`Invalid Jira key: ${value}`);
  }
  return normalized;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    jiraKey: DEFAULT_JIRA_KEY,
    execute: false,
    fullDelivery: false,
    timeoutMinutes: 180,
    pollIntervalMs: 10_000,
    dashboardUrl: DEFAULT_DASHBOARD_URL,
    motoEndpoint: DEFAULT_MOTO_ENDPOINT,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    mysql: {
      host: process.env.MYSQL_HOST ?? "127.0.0.1",
      port: Number.parseInt(
        process.env.MYSQL_PORT ?? process.env.ONESHOT_LOCAL_MYSQL_PORT ?? "3307",
        10,
      ),
      user: process.env.MYSQL_USER ?? "root",
      password: process.env.MYSQL_PASS ?? process.env.DB_PASSWORD ?? "specter_local",
      database: process.env.MYSQL_DB ?? process.env.DB_NAME ?? "Specter",
    },
    operatorId: process.env.ONESHOT_SMOKE_OPERATOR_ID ?? process.env.USER ?? "local-smoke",
    operatorName:
      process.env.ONESHOT_SMOKE_OPERATOR_NAME ??
      process.env.USER ??
      "Local OneShot Smoke",
    skipMavenPreflight: false,
    diagnoseMavenEnv: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`Missing value for ${token}`);
      }
      return argv[i];
    };

    switch (token) {
      case "--jira":
        args.jiraKey = normalizeJiraKey(next());
        break;
      case "--execute":
        args.execute = true;
        break;
      case "--full-delivery":
        args.fullDelivery = true;
        break;
      case "--skip-maven-preflight":
        args.skipMavenPreflight = true;
        break;
      case "--diagnose-maven-env":
        args.diagnoseMavenEnv = true;
        break;
      case "--timeout-minutes":
        args.timeoutMinutes = Number.parseInt(next(), 10);
        break;
      case "--poll-interval-ms":
        args.pollIntervalMs = Number.parseInt(next(), 10);
        break;
      case "--dashboard-url":
        args.dashboardUrl = next().replace(/\/$/, "");
        break;
      case "--moto-endpoint":
        args.motoEndpoint = next().replace(/\/$/, "");
        break;
      case "--output-root":
        args.outputRoot = next();
        break;
      case "--mysql-host":
        args.mysql.host = next();
        break;
      case "--mysql-port":
        args.mysql.port = Number.parseInt(next(), 10);
        break;
      case "--mysql-user":
        args.mysql.user = next();
        break;
      case "--mysql-password":
        args.mysql.password = next();
        break;
      case "--mysql-db":
        args.mysql.database = next();
        break;
      case "--operator-id":
        args.operatorId = next();
        break;
      case "--operator-name":
        args.operatorName = next();
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  if (!Number.isFinite(args.timeoutMinutes) || args.timeoutMinutes <= 0) {
    throw new Error("--timeout-minutes must be a positive integer");
  }
  if (!Number.isFinite(args.pollIntervalMs) || args.pollIntervalMs <= 0) {
    throw new Error("--poll-interval-ms must be a positive integer");
  }
  args.jiraKey = normalizeJiraKey(args.jiraKey);
  return args;
}

export function validateExecutionMode(args) {
  if (args.execute && !args.fullDelivery) {
    return [
      "--execute requires --full-delivery for this CPDEV local smoke so external side effects are explicit.",
    ];
  }
  if (args.jiraKey === DEFAULT_JIRA_KEY && args.skipMavenPreflight) {
    return [
      "--skip-maven-preflight is not allowed for CPDEV-21980 because it is a Maven full-delivery smoke.",
    ];
  }
  return [];
}

export function validateRequiredEnvironment(env, args, options = {}) {
  const missing = [];
  const warnings = [];
  for (const name of ["JIRA_BASE_URL", "JIRA_USERNAME", "JIRA_TOKEN"]) {
    if (!env[name]) missing.push(name);
  }
  for (const name of [
    "GITHUB_REPO_TOKEN",
    "GITHUB_WRITE_TOKEN",
    "DASHBOARD_OPERATOR_ID_HEADER",
    "DASHBOARD_OPERATOR_NAME_HEADER",
  ]) {
    if (!env[name]) missing.push(name);
  }

  const reviewerProvider = (env.ONESHOT_REVIEWER_PROVIDER ?? "openai").toLowerCase();
  const codeReviewerProvider = (
    env.ONESHOT_CODE_REVIEWER_PROVIDER ?? "openai"
  ).toLowerCase();
  if (
    (reviewerProvider === "openai" || codeReviewerProvider === "openai") &&
    !env.OPENAI_API_KEY
  ) {
    missing.push("OPENAI_API_KEY");
  }

  const usesBedrock = env.CLAUDE_CODE_USE_BEDROCK !== "0";
  if (
    usesBedrock &&
    !env.AWS_ACCESS_KEY_ID &&
    !env.AWS_PROFILE &&
    !env.AWS_WEB_IDENTITY_TOKEN_FILE
  ) {
    missing.push("AWS_ACCESS_KEY_ID or AWS_PROFILE");
  }

  const maven = validateMavenSmokeEnvironment(env, {
    fullDelivery: Boolean(args.execute && args.fullDelivery),
    skipMavenPreflight: args.skipMavenPreflight,
    mavenBuildsEnabled: isMavenBuildsEnabledEnv(env),
    settingsXmlContents: options.mavenSettingsXmlContents ?? [],
  });
  warnings.push(...maven.warnings);

  if (!args.operatorId || !args.operatorName) {
    missing.push("operator identity (--operator-id/--operator-name)");
  }

  return {
    ok: missing.length === 0 && maven.ok,
    missing: [...new Set(missing)],
    warnings,
    maven,
  };
}

function queuedStateWithinGrace(run, options = {}) {
  const updatedAt = run?.updated_at;
  if (!updatedAt) return false;
  const updatedAtMs =
    updatedAt instanceof Date ? updatedAt.getTime() : Date.parse(String(updatedAt));
  if (!Number.isFinite(updatedAtMs)) return false;
  const nowMs =
    options.now instanceof Date
      ? options.now.getTime()
      : Number.isFinite(options.now)
        ? Number(options.now)
        : Date.now();
  const graceMs = options.graceMs ?? DEFAULT_QUEUED_STRANDED_GRACE_MS;
  return nowMs - updatedAtMs < graceMs;
}

export function detectQueuedWithoutMessage(run, queueStats, options = {}) {
  if (!run || !QUEUE_STAGE_BY_STATE[run.state]) {
    return null;
  }
  const stage = QUEUE_STAGE_BY_STATE[run.state];
  const stats = queueStats[stage];
  if (!stats) {
    return {
      stage,
      reason: `Missing SQS queue stats for queued state ${run.state}`,
    };
  }
  const visible = stats.visible ?? 0;
  const notVisible = stats.notVisible ?? 0;
  const delayed = stats.delayed ?? 0;
  if (visible + notVisible + delayed === 0) {
    if (queuedStateWithinGrace(run, options)) {
      return null;
    }
    return {
      stage,
      reason: `Run is ${run.state}, but ${stage} queue has no visible, in-flight, or delayed messages.`,
    };
  }
  return null;
}

export function buildReportSummary(snapshot) {
  const run = snapshot.run;
  return {
    jiraKey: snapshot.jira?.jiraKey ?? snapshot.args.jiraKey,
    status: snapshot.status,
    runId: run?.id ?? null,
    runState: run?.state ?? null,
    workspaceMode: run?.workspace_mode ?? null,
    currentPrUrl: run?.current_pr_url ?? null,
    currentImplementationBranch: run?.current_implementation_branch ?? null,
    currentImplementationCommitSha: run?.current_implementation_commit_sha ?? null,
    totalTokensUsed: run?.total_tokens_used ?? 0,
    candidateVersion: snapshot.candidate?.candidate_version ?? null,
    candidateSha: snapshot.candidate?.candidate_commit_sha ?? null,
    artifactCount: snapshot.artifacts?.length ?? 0,
    eventCount: snapshot.events?.length ?? 0,
    strandedQueue: snapshot.strandedQueue ?? null,
  };
}

export function findWorkspaceV2EnvFailures(workspaceV2Env) {
  const failures = [];
  for (const containerName of WORKSPACE_V2_CONTAINER_NAMES) {
    const check = workspaceV2Env?.[containerName];
    if (!check) {
      failures.push(`${containerName} workspace v2 env was not inspected`);
      continue;
    }
    if (check.error) {
      failures.push(`${containerName} workspace v2 env check failed: ${check.error}`);
      continue;
    }
    for (const name of WORKSPACE_V2_REQUIRED_ENV) {
      const value = check[name];
      const parsed = Number.parseInt(value ?? "", 10);
      if (!value || !Number.isFinite(parsed) || parsed <= 0) {
        failures.push(`${containerName} has invalid ${name}=${value ?? "missing"}`);
      }
    }
  }
  return failures;
}

export function findMultiRepoFeatureEnvFailures(featureEnv, args) {
  if (
    !args.execute ||
    !args.fullDelivery ||
    !MULTI_REPO_FULL_DELIVERY_JIRA_KEYS.has(args.jiraKey)
  ) {
    return [];
  }

  const failures = [];
  for (const containerName of MULTI_REPO_FEATURE_CONTAINER_NAMES) {
    const check = featureEnv?.[containerName];
    if (!check) {
      failures.push(`${containerName} multi-repo feature env was not inspected`);
      continue;
    }
    if (check.error) {
      failures.push(`${containerName} multi-repo feature env check failed: ${check.error}`);
      continue;
    }
    if (check.ONESHOT_MULTI_REPO_ENABLED !== "true") {
      failures.push(
        `${containerName} requires ONESHOT_MULTI_REPO_ENABLED=true for ${args.jiraKey} full delivery`,
      );
    }
  }
  return failures;
}

function usage() {
  return `
Usage:
  node scripts/run-cpdev-local-smoke.mjs --jira CPDEV-21980 [--execute --full-delivery]
  node scripts/run-cpdev-local-smoke.mjs --diagnose-maven-env

Default mode is preflight only. It reads local services and Jira validation but
does not create a dashboard request. Use --execute --full-delivery to submit the
run and allow real LLM/GitHub/Jira delivery side effects.

For Maven tickets such as CPDEV-21980, --execute --full-delivery requires
ARTIFACTORY_HOST, MAVEN_USER, and MAVEN_PASSWORD unless
ONESHOT_MAVEN_BUILDS_ENABLED=false. ARTIFACTORY_HOST must be host-only, for
example dev.example.internal, because repo-local Maven settings construct
https://\${env.ARTIFACTORY_HOST}/artifactory/... URLs.

Use --skip-maven-preflight only for non-Maven tickets; it is intentionally
blocked for CPDEV-21980.
`;
}

function logStep(message) {
  process.stdout.write(`==> ${message}${os.EOL}`);
}

async function execText(command, args, options = {}) {
  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs ?? 20_000,
  });
  return stdout.trim();
}

async function optionalExecText(command, args, options = {}) {
  try {
    return { ok: true, stdout: await execText(command, args, options) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function detectContainerRuntime() {
  const requested = process.env.CONTAINER_ENGINE?.trim();
  const candidates = requested ? [requested] : ["podman", "docker"];
  for (const engine of candidates) {
    if (engine !== "podman" && engine !== "docker") {
      return {
        ok: false,
        engine,
        error: `Unsupported CONTAINER_ENGINE=${engine}; expected docker or podman.`,
      };
    }
    const version = await optionalExecText(engine, ["compose", "version"]);
    if (version.ok) {
      return {
        ok: true,
        engine,
        version: version.stdout,
      };
    }
  }
  return {
    ok: false,
    engine: null,
    error: "Neither podman compose nor docker compose is available.",
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!response.ok) {
    const message =
      body?.error ?? body?.message ?? text ?? `${response.status} ${response.statusText}`;
    throw new Error(`${url} failed: ${message}`);
  }
  return body;
}

function operatorHeaders(env, args) {
  return {
    [env.DASHBOARD_OPERATOR_ID_HEADER]: args.operatorId,
    [env.DASHBOARD_OPERATOR_NAME_HEADER]: args.operatorName,
  };
}

async function connectMysql(args) {
  return mysql.createPool({
    ...args.mysql,
    waitForConnections: true,
    connectionLimit: 4,
    multipleStatements: false,
  });
}

async function query(pool, sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

function hostQueueUrl(motoEndpoint, stage) {
  return `${motoEndpoint}/000000000000/${QUEUE_NAME_BY_STAGE[stage]}`;
}

async function getQueueStats(args) {
  const client = new SQSClient({
    region: process.env.AWS_REGION ?? DEFAULT_REGION,
    endpoint: args.motoEndpoint,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "test",
      sessionToken: process.env.AWS_SESSION_TOKEN || undefined,
    },
  });
  const entries = await Promise.all(
    Object.keys(QUEUE_NAME_BY_STAGE).map(async (stage) => {
      try {
        const response = await client.send(
          new GetQueueAttributesCommand({
            QueueUrl: hostQueueUrl(args.motoEndpoint, stage),
            AttributeNames: [
              "ApproximateNumberOfMessages",
              "ApproximateNumberOfMessagesNotVisible",
              "ApproximateNumberOfMessagesDelayed",
            ],
          }),
        );
        const attrs = response.Attributes ?? {};
        return [
          stage,
          {
            visible: Number(attrs.ApproximateNumberOfMessages ?? 0),
            notVisible: Number(attrs.ApproximateNumberOfMessagesNotVisible ?? 0),
            delayed: Number(attrs.ApproximateNumberOfMessagesDelayed ?? 0),
          },
        ];
      } catch (error) {
        return [
          stage,
          {
            error: error instanceof Error ? error.message : String(error),
            visible: 0,
            notVisible: 0,
            delayed: 0,
          },
        ];
      }
    }),
  );
  client.destroy();
  return Object.fromEntries(entries);
}

async function checkLocalServices(args) {
  const checks = {};
  const runtime = await detectContainerRuntime();
  checks.containerRuntime = runtime;
  checks.docker = runtime.ok
    ? { ok: true, stdout: runtime.version }
    : { ok: false, error: runtime.error };
  checks.containers = runtime.ok
    ? await optionalExecText(runtime.engine, [
        "ps",
        "--format",
        "{{.Names}}",
      ])
    : { ok: false, error: runtime.error };
  checks.workspaceV2Env = {};
  checks.featureEnv = {};
  if (runtime.ok) {
    await Promise.all(
      WORKSPACE_V2_CONTAINER_NAMES.map(async (containerName) => {
        const values = {};
        for (const name of WORKSPACE_V2_REQUIRED_ENV) {
          const check = await optionalExecText(runtime.engine, [
            "exec",
            containerName,
            "printenv",
            name,
          ]);
          if (!check.ok) {
            checks.workspaceV2Env[containerName] = {
              ...values,
              error: check.error,
            };
            return;
          }
          values[name] = check.stdout;
        }
        checks.workspaceV2Env[containerName] = values;
      }),
    );
    await Promise.all(
      MULTI_REPO_FEATURE_CONTAINER_NAMES.map(async (containerName) => {
        const check = await optionalExecText(runtime.engine, [
          "exec",
          containerName,
          "printenv",
          "ONESHOT_MULTI_REPO_ENABLED",
        ]);
        checks.featureEnv[containerName] = check.ok
          ? { ONESHOT_MULTI_REPO_ENABLED: check.stdout }
          : { error: check.error };
      }),
    );
  }

  const healthUrls = {
    dashboard: `${args.dashboardUrl}/health/db`,
    orchestrator: "http://127.0.0.1:18085/health",
    qualifier: "http://127.0.0.1:18086/health",
    planner: "http://127.0.0.1:18080/ready",
    reviewer: "http://127.0.0.1:18081/ready",
    implementer: "http://127.0.0.1:18082/ready",
    codeReviewer: "http://127.0.0.1:18083/ready",
    tester: "http://127.0.0.1:18084/ready",
  };
  checks.health = {};
  await Promise.all(
    Object.entries(healthUrls).map(async ([name, url]) => {
      try {
        checks.health[name] = { ok: true, body: await fetchJson(url) };
      } catch (error) {
        checks.health[name] = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return checks;
}

async function readMavenSettingsXmlContents() {
  const contents = [];
  await Promise.all(
    DEFAULT_MAVEN_SETTINGS_CANDIDATES.map(async (candidatePath) => {
      try {
        contents.push(await fs.readFile(candidatePath, "utf8"));
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }),
  );
  return contents;
}

async function checkDatabase(pool, jiraKey) {
  const [workspaceColumn] = await query(
    pool,
    "SHOW COLUMNS FROM oneshot_runs LIKE 'workspace_mode'",
  );
  const workspaceTables = await query(
    pool,
    "SHOW TABLES LIKE 'oneshot_workspace_%'",
  );
  const candidateTables = await query(
    pool,
    "SHOW TABLES LIKE 'oneshot_candidate_versions'",
  );
  const [repo] = await query(
    pool,
    "SELECT id, repo_name, repo_url, default_branch FROM code_repositories WHERE repo_name = ? LIMIT 1",
    [REQUIRED_REPO_NAME],
  );
  const existingRuns = await query(
    pool,
    "SELECT id, state, workspace_mode, current_pr_url FROM oneshot_runs WHERE jira_key = ? ORDER BY id DESC",
    [jiraKey],
  );
  const activeRequests = await query(
    pool,
    "SELECT id, status, task_management_id, error_message FROM oneshot_dashboard_run_requests WHERE jira_key = ? AND status IN ('queued', 'processing') ORDER BY id DESC",
    [jiraKey],
  ).catch((error) => {
    if (String(error?.message ?? error).includes("oneshot_dashboard_run_requests")) {
      return [{ missingTable: true, error: String(error?.message ?? error) }];
    }
    throw error;
  });

  return {
    hasWorkspaceModeColumn: Boolean(workspaceColumn),
    workspaceTableCount: workspaceTables.length,
    hasCandidateVersionsTable: candidateTables.length > 0,
    repo: repo ?? null,
    repoMatchesExpected:
      repo?.repo_name === REQUIRED_REPO_NAME && repo?.repo_url === REQUIRED_REPO_URL,
    existingRuns,
    activeRequests,
  };
}

async function validateJira(args) {
  return fetchJson(`${args.dashboardUrl}/api/oneshot/run-requests/validate`, {
    method: "POST",
    headers: operatorHeaders(process.env, args),
    body: JSON.stringify({ jiraKey: args.jiraKey }),
  });
}

async function submitRunRequest(args) {
  return fetchJson(`${args.dashboardUrl}/api/oneshot/run-requests`, {
    method: "POST",
    headers: operatorHeaders(process.env, args),
    body: JSON.stringify({ jiraKey: args.jiraKey }),
  });
}

async function getRunRequest(args, requestId) {
  return fetchJson(`${args.dashboardUrl}/api/oneshot/run-requests/${requestId}`, {
    headers: operatorHeaders(process.env, args),
  });
}

async function collectRunSnapshot(pool, args, queueStats) {
  const [run] = await query(
    pool,
    `SELECT id,
            workspace_mode,
            jira_key,
            state,
            current_plan_version,
            current_review_version,
            current_implementation_version,
            current_implementation_branch,
            current_implementation_commit_sha,
            current_code_review_version,
            current_test_version,
            current_pr_url,
            final_disposition,
            last_error,
            total_tokens_used,
            updated_at
       FROM oneshot_runs
      WHERE jira_key = ?
      ORDER BY id DESC
      LIMIT 1`,
    [args.jiraKey],
  );
  if (!run) {
    return {
      run: null,
      events: [],
      artifacts: [],
      workspaceState: [],
      leases: [],
      candidate: null,
      cleanupEvents: [],
      strandedQueue: null,
    };
  }

  const [candidate] = await query(
    pool,
    `SELECT candidate_version, candidate_commit_sha, status, finalized_at
       FROM oneshot_candidate_versions
      WHERE oneshot_run_id = ?
        AND status = 'current'
      ORDER BY candidate_version DESC
      LIMIT 1`,
    [run.id],
  ).catch(() => [null]);
  const [workspaceState, leases, events, artifacts, cleanupEvents] =
    await Promise.all([
      query(
        pool,
        `SELECT workspace_mode,
                workspace_path,
                workspace_phase,
                workspace_head_sha,
                current_candidate_version,
                current_candidate_sha,
                last_repo_fetch_at,
                last_remote_head_sha,
                metadata_json
           FROM oneshot_workspace_state
          WHERE oneshot_run_id = ?`,
        [run.id],
      ).catch(() => []),
      query(
        pool,
        `SELECT scope, fencing_token, owner_stage, owner_task_arn, heartbeat_at, expires_at
           FROM oneshot_workspace_leases
          WHERE scope IN (?, ?)`,
        [`run-worktree:${run.id}`, `repo-cache:${REQUIRED_REPO_NAME}`],
      ).catch(() => []),
      query(
        pool,
        `SELECT id, event_type, from_state, to_state, stage, metadata_json, occurred_at
           FROM oneshot_run_events
          WHERE oneshot_run_id = ?
          ORDER BY occurred_at DESC, id DESC
          LIMIT 100`,
        [run.id],
      ),
      query(
        pool,
        `SELECT stage, version, status, s3_bucket, s3_key, provider, model, metadata_json, completed_at
           FROM oneshot_artifacts
          WHERE oneshot_run_id = ?
          ORDER BY created_at ASC, id ASC`,
        [run.id],
      ),
      query(
        pool,
        `SELECT event_type, metadata_json, occurred_at
           FROM oneshot_run_events
          WHERE oneshot_run_id = ?
            AND event_type IN ('workspace_cleanup_requested', 'workspace_cleanup_completed')
          ORDER BY occurred_at DESC, id DESC`,
        [run.id],
      ),
    ]);

  return {
    run,
    candidate: candidate ?? null,
    workspaceState,
    leases,
    events,
    artifacts,
    cleanupEvents,
    strandedQueue: detectQueuedWithoutMessage(run, queueStats),
  };
}

function hasMeaningfulProgress(snapshot) {
  if (!snapshot.run) {
    return false;
  }
  return (
    snapshot.artifacts.some((artifact) => artifact.stage === "implementation") ||
    Boolean(snapshot.run.current_implementation_commit_sha) ||
    Boolean(snapshot.run.current_pr_url) ||
    TERMINAL_STATES.has(snapshot.run.state)
  );
}

async function writeReport(args, payload) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(args.outputRoot, args.jiraKey, timestamp);
  await fs.mkdir(dir, { recursive: true });
  const reportPath = path.join(dir, "report.json");
  await fs.writeFile(reportPath, JSON.stringify(payload, null, 2), "utf8");
  return reportPath;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function assertPreflight(preflight, args) {
  const failures = [];
  failures.push(...validateExecutionMode(args));
  if (preflight.env.missing.length > 0) {
    failures.push(`Missing required env: ${preflight.env.missing.join(", ")}`);
  }
  failures.push(...(preflight.env.maven?.errors ?? []));
  if (!preflight.services.docker.ok) {
    failures.push(
      `Container runtime is not available: ${preflight.services.docker.error}`,
    );
  }
  failures.push(...findWorkspaceV2EnvFailures(preflight.services.workspaceV2Env));
  failures.push(
    ...findMultiRepoFeatureEnvFailures(preflight.services.featureEnv, args),
  );
  for (const [name, check] of Object.entries(preflight.services.health)) {
    if (!check.ok) {
      failures.push(`${name} health check failed: ${check.error}`);
    }
  }
  if (!preflight.db.hasWorkspaceModeColumn) {
    failures.push("oneshot_runs.workspace_mode is missing");
  }
  if (preflight.db.workspaceTableCount === 0) {
    failures.push("oneshot_workspace_* tables are missing");
  }
  if (!preflight.db.hasCandidateVersionsTable) {
    failures.push("oneshot_candidate_versions table is missing");
  }
  if (!preflight.db.repoMatchesExpected) {
    failures.push(
      `Expected ${REQUIRED_REPO_NAME} to route to ${REQUIRED_REPO_URL}; found ${preflight.db.repo?.repo_url ?? "missing repo"}`,
    );
  }
  if (preflight.db.existingRuns.length > 0) {
    failures.push(
      `${args.jiraKey} already has local oneshot_runs rows; run local reset before this full-delivery smoke.`,
    );
  }
  const activeRequests = preflight.db.activeRequests.filter(
    (row) => !row.missingTable,
  );
  if (activeRequests.length > 0) {
    failures.push(`${args.jiraKey} already has an active dashboard run request.`);
  }
  return failures;
}

async function runPreflight(args) {
  loadDotenv({ path: ".env.local", override: false, quiet: true });
  loadDotenv({ path: ".env", override: false, quiet: true });
  const mavenSettingsXmlContents = await readMavenSettingsXmlContents();
  const pool = await connectMysql(args);
  try {
    logStep("Checking required environment");
    const env = validateRequiredEnvironment(process.env, args, {
      mavenSettingsXmlContents,
    });
    logStep("Checking local Docker services");
    const services = await checkLocalServices(args);
    logStep("Checking local MySQL schema and CPDEV-21980 conflicts");
    const db = await checkDatabase(pool, args.jiraKey);
    logStep("Validating Jira ticket through dashboard API");
    const jira = env.ok
      ? await validateJira(args).catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
        }))
      : { skipped: "missing required env" };

    const preflight = { env, services, db, jira };
    return { preflight, failures: assertPreflight(preflight, args) };
  } finally {
    await pool.end();
  }
}

async function runSmoke(args, preflight) {
  const pool = await connectMysql(args);
  let request = null;
  let status = "running";
  let latestSnapshot = null;
  try {
    logStep(`Submitting dashboard run request for ${args.jiraKey}`);
    request = await submitRunRequest(args);
    const deadline = Date.now() + args.timeoutMinutes * 60_000;

    while (Date.now() < deadline) {
      const queueStats = await getQueueStats(args);
      const requestDetail = request?.id
        ? await getRunRequest(args, request.id).catch((error) => ({
            id: request.id,
            status: "unknown",
            error: error instanceof Error ? error.message : String(error),
          }))
        : null;
      latestSnapshot = {
        args: {
          jiraKey: args.jiraKey,
          execute: args.execute,
          fullDelivery: args.fullDelivery,
          timeoutMinutes: args.timeoutMinutes,
        },
        jira: preflight.jira,
        request: requestDetail,
        queueStats,
        ...(await collectRunSnapshot(pool, args, queueStats)),
      };

      if (latestSnapshot.strandedQueue) {
        status = "orchestration_failed";
        break;
      }
      if (requestDetail?.status === "failed") {
        status = "request_failed";
        break;
      }
      if (
        latestSnapshot.run &&
        latestSnapshot.run.workspace_mode !== "v2"
      ) {
        status = "orchestration_failed";
        latestSnapshot.workspaceModeError = "Created run is not workspace_mode=v2";
        break;
      }
      if (
        latestSnapshot.run &&
        TERMINAL_STATES.has(latestSnapshot.run.state) &&
        hasMeaningfulProgress(latestSnapshot)
      ) {
        status =
          latestSnapshot.run.state === "failed"
            ? "terminal_failure"
            : "completed_or_delivered";
        break;
      }
      if (latestSnapshot.run?.current_pr_url) {
        status = "delivery_started";
        break;
      }
      await sleep(args.pollIntervalMs);
    }

    if (!latestSnapshot) {
      latestSnapshot = {
        args,
        jira: preflight.jira,
        request,
        queueStats: await getQueueStats(args),
        ...(await collectRunSnapshot(pool, args, await getQueueStats(args))),
      };
    }
    if (status === "running") {
      status = "timeout";
    }
    latestSnapshot.status = status;
    latestSnapshot.summary = buildReportSummary(latestSnapshot);
    return latestSnapshot;
  } finally {
    await pool.end();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (args.diagnoseMavenEnv) {
    loadDotenv({ path: ".env.local", override: false, quiet: true });
    loadDotenv({ path: ".env", override: false, quiet: true });
    const diagnostics = validateMavenSmokeEnvironment(process.env, {
      fullDelivery: true,
      settingsXmlContents: await readMavenSettingsXmlContents(),
    });
    process.stdout.write(JSON.stringify(diagnostics, null, 2) + os.EOL);
    return diagnostics.ok ? 0 : 1;
  }

  const preflightResult = await runPreflight(args);
  const preflightReport = {
    args: {
      jiraKey: args.jiraKey,
      execute: args.execute,
      fullDelivery: args.fullDelivery,
      skipMavenPreflight: args.skipMavenPreflight,
      timeoutMinutes: args.timeoutMinutes,
    },
    status: preflightResult.failures.length === 0 ? "preflight_passed" : "preflight_failed",
    preflight: preflightResult.preflight,
    failures: preflightResult.failures,
    warnings: preflightResult.preflight.env.warnings,
  };

  if (preflightResult.failures.length > 0) {
    const reportPath = await writeReport(args, preflightReport);
    process.stderr.write(
      `Preflight failed. Report: ${reportPath}${os.EOL}${preflightResult.failures
        .map((failure) => ` - ${failure}`)
        .join(os.EOL)}${os.EOL}`,
    );
    return 1;
  }

  if (!args.execute) {
    const reportPath = await writeReport(args, preflightReport);
    process.stdout.write(`Preflight passed. Report: ${reportPath}${os.EOL}`);
    process.stdout.write("No run was created because --execute was not provided.\n");
    return 0;
  }

  const smokeReport = await runSmoke(args, preflightResult.preflight);
  const reportPath = await writeReport(args, smokeReport);
  process.stdout.write(`Smoke status: ${smokeReport.status}${os.EOL}`);
  process.stdout.write(`Report: ${reportPath}${os.EOL}`);
  process.stdout.write(JSON.stringify(smokeReport.summary, null, 2) + os.EOL);
  return ["orchestration_failed", "request_failed", "timeout"].includes(
    smokeReport.status,
  )
    ? 1
    : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = fileURLToPath(import.meta.url);
if (invokedPath === modulePath) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.stack ?? error.message : String(error)}${os.EOL}`,
      );
      process.exitCode = 1;
    },
  );
}
