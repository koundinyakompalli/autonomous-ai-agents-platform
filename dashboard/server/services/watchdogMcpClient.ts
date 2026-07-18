import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

type JsonRpcId = number | string;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcResponse {
  id?: JsonRpcId;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface WatchdogMcpStatus {
  status: "ok" | "not_configured" | "starting" | "unavailable";
  command?: string;
  pid?: number;
  restartCount: number;
  restartBudgetRemaining?: number;
  lastStartedAt?: string;
  lastExitedAt?: string;
  lastError?: string;
  toolCount?: number;
}

export interface WatchdogMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface McpCallToolResult {
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

function parseMcpCommand() {
  if (process.env.WATCHDOG_MCP_HTTP_URL?.trim()) return undefined;
  const raw = process.env.WATCHDOG_MCP_COMMAND?.trim();
  if (!raw) return undefined;
  const commandParts = raw.split(/\s+/).filter(Boolean);
  const executable = commandParts[0];
  const rawArgs = process.env.WATCHDOG_MCP_ARGS?.trim();
  const args = rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : ["run", "--transport", "stdio"];
  return {
    executable,
    args: [...commandParts.slice(1), ...args],
    display: [executable, ...commandParts.slice(1), ...args].join(" "),
  };
}

function httpMcpUrl() {
  return process.env.WATCHDOG_MCP_HTTP_URL?.trim();
}

function mcpChildEnv() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WATCHDOG_MCP_TRANSPORT: "stdio",
  };

  const mcpAccessKeyId = process.env.WATCHDOG_MCP_AWS_ACCESS_KEY_ID;
  const mcpSecretAccessKey = process.env.WATCHDOG_MCP_AWS_SECRET_ACCESS_KEY;
  const mcpSessionToken = process.env.WATCHDOG_MCP_AWS_SESSION_TOKEN;
  const mcpProfile = process.env.WATCHDOG_MCP_AWS_PROFILE;

  if (mcpAccessKeyId?.trim() && mcpSecretAccessKey?.trim()) {
    env.AWS_ACCESS_KEY_ID = mcpAccessKeyId.trim();
    env.AWS_SECRET_ACCESS_KEY = mcpSecretAccessKey.trim();
    if (mcpSessionToken?.trim()) {
      env.AWS_SESSION_TOKEN = mcpSessionToken.trim();
    } else {
      delete env.AWS_SESSION_TOKEN;
    }
    delete env.AWS_PROFILE;
  } else {
    if (process.env.WATCHDOG_MCP_INHERIT_AWS_ENV_CREDS !== "true") {
      delete env.AWS_ACCESS_KEY_ID;
      delete env.AWS_SECRET_ACCESS_KEY;
      delete env.AWS_SESSION_TOKEN;
    }
    if (mcpProfile?.trim()) {
      env.AWS_PROFILE = mcpProfile.trim();
    }
  }

  delete env.WATCHDOG_MCP_AWS_ACCESS_KEY_ID;
  delete env.WATCHDOG_MCP_AWS_SECRET_ACCESS_KEY;
  delete env.WATCHDOG_MCP_AWS_SESSION_TOKEN;
  delete env.WATCHDOG_MCP_AWS_PROFILE;
  return env;
}

function timeoutMs() {
  const value = Number(process.env.WATCHDOG_MCP_REQUEST_TIMEOUT_MS || "5000");
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 5000;
}

function maxRestarts() {
  const value = Number(process.env.WATCHDOG_MCP_MAX_RESTARTS || "3");
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 3;
}

function restartWindowMs() {
  const value = Number(process.env.WATCHDOG_MCP_RESTART_WINDOW_SECONDS || "300");
  return (Number.isFinite(value) && value > 0 ? Math.floor(value) : 300) * 1000;
}

function crashBackoffMs(restartCount: number) {
  const value = Number(process.env.WATCHDOG_MCP_CRASH_BACKOFF_SECONDS || "5");
  const baseSeconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : 5;
  return Math.min(baseSeconds * 1000 * 2 ** Math.max(restartCount - 1, 0), 30_000);
}

class WatchdogMcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private stdout?: ReadlineInterface;
  private requestId = 0;
  private ready = false;
  private starting?: Promise<void>;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private tools: WatchdogMcpTool[] = [];
  private restartCount = 0;
  private restartTimestamps: number[] = [];
  private lastStartedAt?: string;
  private lastExitedAt?: string;
  private lastError?: string;
  private stderrTail = "";

  getStatus(): WatchdogMcpStatus {
    const command = parseMcpCommand();
    if (!command) {
      return { status: "not_configured", restartCount: this.restartCount };
    }
    return {
      status: this.ready ? "ok" : this.child ? "starting" : "unavailable",
      command: command.display,
      pid: this.child?.pid,
      restartCount: this.restartCount,
      restartBudgetRemaining: this.restartBudgetRemaining(),
      lastStartedAt: this.lastStartedAt,
      lastExitedAt: this.lastExitedAt,
      lastError: this.lastError,
      toolCount: this.tools.length || undefined,
    };
  }

  async ensureReady(): Promise<WatchdogMcpStatus> {
    const command = parseMcpCommand();
    if (!command) {
      return this.getStatus();
    }
    if (this.ready) {
      return this.getStatus();
    }
    if (this.starting) {
      await this.starting;
      return this.getStatus();
    }

    this.starting = this.start(command);
    try {
      await this.starting;
      return this.getStatus();
    } finally {
      this.starting = undefined;
    }
  }

  async listTools(): Promise<WatchdogMcpTool[]> {
    await this.ensureReady();
    if (!this.ready) {
      throw new Error("Watchdog MCP is not ready");
    }
    return [...this.tools];
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureReady();
    if (!this.ready) {
      throw new Error("Watchdog MCP is not ready");
    }
    const result = await this.request<McpCallToolResult>("tools/call", { name, arguments: args });
    if (result?.isError) {
      throw new Error(mcpToolErrorMessage(name, result));
    }
    return unwrapToolResult<T>(result);
  }

  private async start(command: { executable: string; args: string[]; display: string }) {
    this.disposeChild();
    if (this.lastExitedAt && this.restartBudgetRemaining() <= 0) {
      throw new Error(
        `Watchdog MCP restart budget exhausted: max ${maxRestarts()} restarts per ${restartWindowMs() / 1000}s`,
      );
    }
    const backoffRemaining = this.backoffRemainingMs();
    if (backoffRemaining > 0) {
      throw new Error(`Watchdog MCP restart backoff active for ${Math.ceil(backoffRemaining / 1000)}s`);
    }
    this.recordRestartAttemptIfNeeded();

    this.ready = false;
    this.lastError = undefined;
    this.stderrTail = "";
    this.lastStartedAt = new Date().toISOString();
    this.child = spawn(command.executable, command.args, {
      cwd: process.env.WATCHDOG_MCP_CWD || process.cwd(),
      env: mcpChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.once("error", (error) => {
      this.lastError = error.message;
      this.rejectAll(error);
    });
    this.child.once("exit", (code, signal) => {
      this.ready = false;
      this.lastExitedAt = new Date().toISOString();
      this.lastError = [
        `MCP subprocess exited with code ${code ?? "null"} signal ${signal ?? "null"}`,
        this.stderrTail || undefined,
      ].filter(Boolean).join("; ");
      this.rejectAll(new Error(this.lastError));
      this.disposeChild();
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        this.stderrTail = `${this.stderrTail}\n${message}`.trim().slice(-1500);
        this.lastError = this.stderrTail;
      }
    });

    this.stdout = createInterface({ input: this.child.stdout });
    this.stdout.on("line", (line) => this.handleLine(line));

    await this.initialize();
    this.tools = await this.fetchTools();
    this.ready = true;
  }

  private async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "specter-watchdog-api", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  private async fetchTools(): Promise<WatchdogMcpTool[]> {
    const response = await this.request<{ tools?: WatchdogMcpTool[] }>("tools/list", {});
    return Array.isArray(response.tools) ? response.tools : [];
  }

  private request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error("Watchdog MCP subprocess stdin is not writable"));
    }
    const id = ++this.requestId;
    const payload = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Watchdog MCP request timed out: ${method}`));
      }, timeoutMs());
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  private notify(method: string, params: Record<string, unknown>) {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      this.lastError = `Non-JSON MCP stdout: ${trimmed.slice(0, 500)}`;
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error.message || "Watchdog MCP request failed"));
      return;
    }
    pending.resolve(message.result);
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private disposeChild() {
    this.stdout?.close();
    this.stdout = undefined;
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = undefined;
  }

  private recordRestartAttemptIfNeeded() {
    if (!this.lastExitedAt) return;
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((timestamp) => now - timestamp <= restartWindowMs());
    this.restartTimestamps.push(now);
    this.restartCount += 1;
  }

  private restartBudgetRemaining() {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter((timestamp) => now - timestamp <= restartWindowMs());
    return maxRestarts() - this.restartTimestamps.length;
  }

  private backoffRemainingMs() {
    if (!this.lastExitedAt) return 0;
    const elapsed = Date.now() - new Date(this.lastExitedAt).getTime();
    return Math.max(crashBackoffMs(this.restartTimestamps.length || 1) - elapsed, 0);
  }
}

const singleton = new WatchdogMcpClient();

let httpTools: WatchdogMcpTool[] = [];
let httpLastError: string | undefined;

async function httpRequest<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
  const url = httpMcpUrl();
  if (!url) {
    throw new Error("WATCHDOG_MCP_HTTP_URL is not configured");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Watchdog MCP HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    const message = parseHttpJsonRpc(text);
    if (message.error) {
      throw new Error(message.error.message || "Watchdog MCP HTTP request failed");
    }
    return message.result as T;
  } catch (error) {
    httpLastError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseHttpJsonRpc(text: string): JsonRpcResponse {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as JsonRpcResponse;
  }
  const dataLine = trimmed
    .split(/\r?\n/)
    .find((line) => line.startsWith("data:"));
  if (!dataLine) {
    throw new Error(`MCP HTTP response did not contain JSON-RPC data: ${trimmed.slice(0, 500)}`);
  }
  return JSON.parse(dataLine.slice("data:".length).trim()) as JsonRpcResponse;
}

async function ensureHttpReady(): Promise<WatchdogMcpStatus> {
  const response = await httpRequest<{ tools?: WatchdogMcpTool[] }>("tools/list", {});
  httpTools = Array.isArray(response.tools) ? response.tools : [];
  return {
    status: "ok",
    command: httpMcpUrl(),
    restartCount: 0,
    lastError: httpLastError,
    toolCount: httpTools.length,
  };
}

function unwrapToolResult<T>(result: McpCallToolResult): T {
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }
  const text = result.content?.find((item) => item.type === "text" && item.text)?.text;
  if (text) {
    try {
      return JSON.parse(text) as T;
    } catch {
      return { text } as T;
    }
  }
  return result as T;
}

function mcpToolErrorMessage(name: string, result: McpCallToolResult): string {
  const text = result.content?.find((item) => item.type === "text" && item.text)?.text?.trim();
  return text ? `Watchdog MCP tool failed: ${name}: ${text}` : `Watchdog MCP tool failed: ${name}`;
}

export async function ensureWatchdogMcpReady() {
  if (httpMcpUrl()) {
    return ensureHttpReady();
  }
  return singleton.ensureReady();
}

export function getWatchdogMcpStatus() {
  const url = httpMcpUrl();
  if (url) {
    return {
      status: httpTools.length > 0 ? "ok" : httpLastError ? "unavailable" : "starting",
      command: url,
      restartCount: 0,
      lastError: httpLastError,
      toolCount: httpTools.length || undefined,
    } satisfies WatchdogMcpStatus;
  }
  return singleton.getStatus();
}

export async function listWatchdogMcpTools() {
  if (httpMcpUrl()) {
    await ensureHttpReady();
    return [...httpTools];
  }
  return singleton.listTools();
}

export async function callWatchdogMcpTool<T = unknown>(name: string, args: Record<string, unknown>) {
  if (httpMcpUrl()) {
    const result = await httpRequest<McpCallToolResult>("tools/call", { name, arguments: args });
    if (result?.isError) {
      throw new Error(mcpToolErrorMessage(name, result));
    }
    return unwrapToolResult<T>(result);
  }
  return singleton.callTool<T>(name, args);
}
