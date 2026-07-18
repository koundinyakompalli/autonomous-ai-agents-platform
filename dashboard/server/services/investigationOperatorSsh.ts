import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { InvestigationHostTarget } from "../../../src/investigation/index.js";

const execFileAsync = promisify(execFile);

type ExecFileAsync = (
  file: string,
  args: string[],
  options?: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export type OperatorSshControlMasterStatus = "skipped" | "active" | "opened" | "password_required";

export interface OperatorSshControlMasterResult {
  status: OperatorSshControlMasterStatus;
  reason: string;
  publicHost?: string;
  destination?: string;
  controlPath?: string;
}

export interface EnsureOperatorSshControlMasterInput {
  hostTarget?: InvestigationHostTarget | null;
  operatorSshPassword?: string;
  jiraKey?: string;
  clientId?: string;
  environment?: string;
  operatorDisplay?: string;
}

export interface EnsureOperatorSshControlMasterOptions {
  execFileAsync?: ExecFileAsync;
  env?: NodeJS.ProcessEnv;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function safeAuditToken(value: string | undefined, fallback: string): string {
  const normalized = value?.trim().replace(/[^A-Za-z0-9_.:@-]+/g, "_").slice(0, 80);
  return normalized || fallback;
}

function sshpassPath(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.INVESTIGATION_SSHPASS_BIN?.trim() || env.MERIDIAN_SSHPASS_BIN?.trim();
  if (configured) {
    return configured;
  }
  return existsSync("/opt/homebrew/bin/sshpass") ? "/opt/homebrew/bin/sshpass" : undefined;
}

function resolveSshUser(target: InvestigationHostTarget, env: NodeJS.ProcessEnv): string | undefined {
  return firstNonEmpty(
    env.INVESTIGATION_OPERATOR_SSH_USER,
    env.INVESTIGATION_SSH_USER,
    env.MERIDIAN_SSH_USER,
    target.sshUser,
    env.USER,
  );
}

function resolveSshPort(target: InvestigationHostTarget, env: NodeJS.ProcessEnv): number {
  const parsed = Number(firstNonEmpty(env.INVESTIGATION_SSH_PORT, env.MERIDIAN_SSH_PORT, String(target.sshPort || "")));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 22;
}

function resolveControlPath(target: InvestigationHostTarget, env: NodeJS.ProcessEnv): string | undefined {
  return target.sshControlPathDedicated
    ? firstNonEmpty(target.sshControlPath, env.INVESTIGATION_SSH_CONTROL_PATH, env.MERIDIAN_SSH_CONTROL_PATH)
    : firstNonEmpty(env.INVESTIGATION_SSH_CONTROL_PATH, env.MERIDIAN_SSH_CONTROL_PATH, target.sshControlPath);
}

function redactedExecError(error: unknown): string {
  if (error instanceof Error) {
    const detail = "stderr" in error && typeof (error as { stderr?: unknown }).stderr === "string"
      ? ` ${(error as { stderr: string }).stderr.trim()}`
      : "";
    return `${error.message}${detail}`.replace(/\s+/g, " ").trim();
  }
  return String(error);
}

function isOwnerOnlySocketMode(mode: number): boolean {
  const perms = mode & 0o777;
  return perms === 0o600 || perms === 0o700;
}

async function isControlMasterActive(input: {
  execFileAsync: ExecFileAsync;
  controlPath: string;
  destination: string;
  sshPort: number;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  try {
    await input.execFileAsync("ssh", [
      "-S",
      input.controlPath,
      "-O",
      "check",
      "-p",
      String(input.sshPort),
      input.destination,
    ], {
      timeout: 5_000,
      maxBuffer: 1024 * 128,
      env: input.env,
    });
    return true;
  } catch {
    return false;
  }
}

async function verifyControlPathPermissions(controlPath: string): Promise<void> {
  const socketStat = await stat(controlPath);
  if (!isOwnerOnlySocketMode(socketStat.mode)) {
    throw new Error(
      `SSH control socket permissions for ${controlPath} are too broad; expected 600 or 700.`,
    );
  }
}

async function sendSessionAuditMarker(input: {
  execFileAsync: ExecFileAsync;
  controlPath: string;
  destination: string;
  sshPort: number;
  jiraKey?: string;
  clientId?: string;
  environment?: string;
  operatorDisplay?: string;
  publicHost: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const marker = [
    "SESSION_START",
    "agent=cockpit-meridian",
    `operator=${safeAuditToken(input.operatorDisplay, "operator")}`,
    `host=${safeAuditToken(input.publicHost, "unknown-host")}`,
    `ticket=${safeAuditToken(input.jiraKey, "unknown-ticket")}`,
    `client=${safeAuditToken(input.clientId, "unknown-client")}`,
    `env=${safeAuditToken(input.environment, "unknown-env")}`,
  ].join(" ");

  await input.execFileAsync("ssh", [
    "-S",
    input.controlPath,
    "-p",
    String(input.sshPort),
    input.destination,
    `logger -t COCKPIT-MERIDIAN ${shellSingleQuote(marker)}`,
  ], {
    timeout: 5_000,
    maxBuffer: 1024 * 128,
    env: input.env,
  });
}

export async function ensureOperatorSshControlMaster(
  input: EnsureOperatorSshControlMasterInput,
  options: EnsureOperatorSshControlMasterOptions = {},
): Promise<OperatorSshControlMasterResult> {
  const env = options.env || process.env;
  const runExecFile = options.execFileAsync || execFileAsync;
  const target = input.hostTarget;
  if (!target || target.networkPath !== "ssh_public" || target.sshAllowed !== true) {
    return { status: "skipped", reason: "No operator LDAP SSH target is attached to this run." };
  }

  const publicHost = target.publicHost?.trim();
  if (!publicHost) {
    return { status: "skipped", reason: "Resolved host target does not define a public SSH endpoint." };
  }

  const sshUser = resolveSshUser(target, env);
  if (!sshUser) {
    return { status: "skipped", reason: "Resolved host target does not define an operator SSH user." };
  }

  const sshPort = resolveSshPort(target, env);
  const controlPath = resolveControlPath(target, env);
  if (!controlPath) {
    return { status: "skipped", reason: "Resolved host target does not define an SSH ControlPath." };
  }

  const destination = publicHost.includes("@") ? publicHost : `${sshUser}@${publicHost}`;
  const active = await isControlMasterActive({
    execFileAsync: runExecFile,
    controlPath,
    destination,
    sshPort,
    env,
  });
  if (active) {
    return {
      status: "active",
      reason: "An operator LDAP SSH ControlMaster socket is already active.",
      publicHost,
      destination,
      controlPath,
    };
  }

  if (!input.operatorSshPassword) {
    return {
      status: "password_required",
      reason: "No active operator LDAP SSH ControlMaster socket was found.",
      publicHost,
      destination,
      controlPath,
    };
  }

  await mkdir(path.dirname(controlPath), { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(path.join(tmpdir(), "cockpit-sshpass-"));
  const passwordFile = path.join(tempDir, `password-${createHash("sha256").update(controlPath).digest("hex").slice(0, 10)}`);
  const askpassFile = path.join(tempDir, "askpass.sh");
  try {
    await writeFile(passwordFile, input.operatorSshPassword, { mode: 0o600 });
    await chmod(passwordFile, 0o600);

    const sshArgs = [
      "-M",
      "-S",
      controlPath,
      "-o",
      "ControlMaster=yes",
      "-o",
      "ControlPersist=30m",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-fN",
      "-p",
      String(sshPort),
      destination,
    ];
    const configuredSshpass = sshpassPath(env);
    if (configuredSshpass) {
      await runExecFile(configuredSshpass, [
        "-f",
        passwordFile,
        "ssh",
        ...sshArgs,
      ], {
        timeout: 15_000,
        maxBuffer: 1024 * 256,
        env,
      });
    } else {
      await writeFile(
        askpassFile,
        "#!/bin/sh\nexec cat \"$COCKPIT_SSH_PASSWORD_FILE\"\n",
        { mode: 0o700 },
      );
      await chmod(askpassFile, 0o700);
      await runExecFile("ssh", sshArgs, {
        timeout: 15_000,
        maxBuffer: 1024 * 256,
        env: {
          ...env,
          SSH_ASKPASS: askpassFile,
          SSH_ASKPASS_REQUIRE: "force",
          DISPLAY: env.DISPLAY || "cockpit-askpass",
          COCKPIT_SSH_PASSWORD_FILE: passwordFile,
        },
      });
    }
  } catch (error) {
    const detail = redactedExecError(error);
    throw new Error(`Operator LDAP SSH authentication failed; no retry was attempted. ${detail}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const verified = await isControlMasterActive({
    execFileAsync: runExecFile,
    controlPath,
    destination,
    sshPort,
    env,
  });
  if (!verified) {
    throw new Error("Operator LDAP SSH ControlMaster did not become active after authentication.");
  }

  await verifyControlPathPermissions(controlPath);

  await sendSessionAuditMarker({
    execFileAsync: runExecFile,
    controlPath,
    destination,
    sshPort,
    jiraKey: input.jiraKey,
    clientId: input.clientId,
    environment: input.environment,
    operatorDisplay: input.operatorDisplay,
    publicHost,
    env,
  }).catch(() => undefined);

  return {
    status: "opened",
    reason: "Opened an operator LDAP SSH ControlMaster socket for the approved target; the one-time password was discarded.",
    publicHost,
    destination,
    controlPath,
  };
}
