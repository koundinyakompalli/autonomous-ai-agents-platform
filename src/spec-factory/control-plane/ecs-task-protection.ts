import { createLogger, type Logger } from "../../utils/logger.js";

const DEFAULT_EXPIRES_IN_MINUTES = 30;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const MAX_EXPIRES_IN_MINUTES = 2_880;
const DEFAULT_MAX_REFRESH_MS = 300_000;
const MIN_REFRESH_MS = 10_000;

export interface AsyncWorkScope {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export interface EcsTaskProtectionSnapshot {
  enabled: boolean;
  activeScopes: number;
  protected: boolean;
  lastRefreshAt: Date | null;
  lastError: string | null;
}

type TaskProtectionFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "status" | "text">>;

type TaskProtectionLogger = Pick<Logger, "debug" | "warn">;

export interface SpecFactoryEcsTaskProtectionOptions {
  enabled?: boolean;
  agentUri?: string;
  expiresInMinutes?: number;
  refreshMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: TaskProtectionFetch;
  logger?: TaskProtectionLogger;
}

export interface SpecFactoryEcsTaskProtectionEnvironment {
  ECS_AGENT_URI?: string;
  SPEC_FACTORY_ECS_TASK_PROTECTION_ENABLED?: string;
  SPEC_FACTORY_ECS_TASK_PROTECTION_EXPIRES_MINUTES?: string;
  SPEC_FACTORY_ECS_TASK_PROTECTION_REFRESH_MS?: string;
  SPEC_FACTORY_ECS_TASK_PROTECTION_REQUEST_TIMEOUT_MS?: string;
}

export class SpecFactoryEcsTaskProtection implements AsyncWorkScope {
  private readonly enabled: boolean;
  private readonly endpoint: string | null;
  private readonly expiresInMinutes: number;
  private readonly refreshMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: TaskProtectionFetch;
  private readonly logger: TaskProtectionLogger;
  private activeScopes = 0;
  private protected = false;
  private lastRefreshAt: Date | null = null;
  private lastError: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private transition: Promise<void> = Promise.resolve();

  constructor(options: SpecFactoryEcsTaskProtectionOptions = {}) {
    this.enabled = options.enabled ?? false;
    this.endpoint = this.enabled
      ? taskProtectionEndpoint(requireAgentUri(options.agentUri))
      : null;
    this.expiresInMinutes = boundedInteger(
      options.expiresInMinutes,
      DEFAULT_EXPIRES_IN_MINUTES,
      1,
      MAX_EXPIRES_IN_MINUTES,
      "SPEC_FACTORY_ECS_TASK_PROTECTION_EXPIRES_MINUTES",
    );
    const expirationMs = this.expiresInMinutes * 60_000;
    this.refreshMs = boundedInteger(
      options.refreshMs,
      defaultRefreshMs(expirationMs),
      MIN_REFRESH_MS,
      expirationMs - 1,
      "SPEC_FACTORY_ECS_TASK_PROTECTION_REFRESH_MS",
    );
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      100,
      30_000,
      "SPEC_FACTORY_ECS_TASK_PROTECTION_REQUEST_TIMEOUT_MS",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger =
      options.logger ?? createLogger("spec-factory-ecs-task-protection");
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (!this.enabled) return work();
    try {
      await this.acquire();
    } catch {
      // Durable SQS receipts and database leases recover interrupted work. A
      // protection control-plane outage must not stop the queue from draining.
      return work();
    }
    try {
      return await work();
    } finally {
      await this.release();
    }
  }

  snapshot(): EcsTaskProtectionSnapshot {
    return {
      enabled: this.enabled,
      activeScopes: this.activeScopes,
      protected: this.protected,
      lastRefreshAt: this.lastRefreshAt,
      lastError: this.lastError,
    };
  }

  private async acquire(): Promise<void> {
    await this.serialize(async () => {
      if (this.activeScopes === 0) {
        try {
          await this.setProtection(true);
        } catch (error) {
          this.lastError = errorMessage(error);
          this.logger.warn(
            { err: error },
            "Spec Factory ECS task protection acquisition failed",
          );
          throw error;
        }
        this.startRefreshTimer();
      }
      this.activeScopes += 1;
    });
  }

  private async release(): Promise<void> {
    await this.serialize(async () => {
      if (this.activeScopes === 0) return;
      this.activeScopes -= 1;
      if (this.activeScopes > 0) return;
      this.stopRefreshTimer();
      try {
        await this.setProtection(false);
      } catch (error) {
        this.lastError = errorMessage(error);
        this.logger.warn(
          { err: error },
          "Spec Factory ECS task protection release failed; expiry remains the safety net",
        );
      }
    });
  }

  private startRefreshTimer(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, this.refreshMs);
    this.refreshTimer.unref?.();
  }

  private stopRefreshTimer(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private async refresh(): Promise<void> {
    await this.serialize(async () => {
      if (this.activeScopes === 0) return;
      try {
        await this.setProtection(true);
      } catch (error) {
        this.lastError = errorMessage(error);
        this.logger.warn(
          { err: error, activeScopes: this.activeScopes },
          "Spec Factory ECS task protection refresh failed",
        );
      }
    });
  }

  private async setProtection(protectionEnabled: boolean): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(this.endpoint!, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          protectionEnabled
            ? {
                ProtectionEnabled: true,
                ExpiresInMinutes: this.expiresInMinutes,
              }
            : { ProtectionEnabled: false },
        ),
        signal: controller.signal,
      });
      const responseText = await response.text();
      if (!response.ok) {
        const detail = responseDetail(responseText);
        throw new Error(
          `ecs_task_protection_http_${response.status}${detail ? `:${detail}` : ""}`,
        );
      }
      const payload = parseResponse(responseText);
      const failure = recordValue(payload?.failure);
      if (failure) {
        throw new Error(
          `ecs_task_protection_rejected:${stringValue(failure.Reason) || "unknown"}`,
        );
      }
      const protection = recordValue(payload?.protection);
      if (protection?.ProtectionEnabled !== protectionEnabled) {
        throw new Error("ecs_task_protection_state_mismatch");
      }
      this.protected = protectionEnabled;
      this.lastRefreshAt = protectionEnabled ? new Date() : null;
      this.lastError = null;
      this.logger.debug(
        { protectionEnabled, activeScopes: this.activeScopes },
        "Spec Factory ECS task protection updated",
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("ecs_task_protection_request_timeout", {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transition.then(operation, operation);
    this.transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function createSpecFactoryEcsTaskProtection(
  env: SpecFactoryEcsTaskProtectionEnvironment = process.env,
  options: Pick<
    SpecFactoryEcsTaskProtectionOptions,
    "fetchImpl" | "logger"
  > = {},
): SpecFactoryEcsTaskProtection {
  const enabled = booleanValue(env.SPEC_FACTORY_ECS_TASK_PROTECTION_ENABLED);
  return new SpecFactoryEcsTaskProtection({
    ...options,
    enabled,
    agentUri: env.ECS_AGENT_URI,
    expiresInMinutes: optionalInteger(
      env.SPEC_FACTORY_ECS_TASK_PROTECTION_EXPIRES_MINUTES,
      "SPEC_FACTORY_ECS_TASK_PROTECTION_EXPIRES_MINUTES",
    ),
    refreshMs: optionalInteger(
      env.SPEC_FACTORY_ECS_TASK_PROTECTION_REFRESH_MS,
      "SPEC_FACTORY_ECS_TASK_PROTECTION_REFRESH_MS",
    ),
    requestTimeoutMs: optionalInteger(
      env.SPEC_FACTORY_ECS_TASK_PROTECTION_REQUEST_TIMEOUT_MS,
      "SPEC_FACTORY_ECS_TASK_PROTECTION_REQUEST_TIMEOUT_MS",
    ),
  });
}

function requireAgentUri(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(
      "SPEC_FACTORY_ECS_TASK_PROTECTION_ENABLED requires ECS_AGENT_URI",
    );
  }
  return normalized;
}

function taskProtectionEndpoint(agentUri: string): string {
  const url = new URL(agentUri);
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new Error("ECS_AGENT_URI must use http or https");
  }
  return `${agentUri.replace(/\/+$/, "")}/task-protection/v1/state`;
}

function defaultRefreshMs(expirationMs: number): number {
  return Math.max(
    MIN_REFRESH_MS,
    Math.min(DEFAULT_MAX_REFRESH_MS, Math.floor(expirationMs / 2)),
  );
}

function optionalInteger(
  raw: string | undefined,
  name: string,
): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return resolved;
}

function booleanValue(raw: string | undefined): boolean {
  return ["true", "1", "yes"].includes(raw?.trim().toLowerCase() ?? "");
}

function parseResponse(value: string): Record<string, unknown> | null {
  if (!value.trim()) return null;
  try {
    return recordValue(JSON.parse(value));
  } catch {
    throw new Error("ecs_task_protection_invalid_response");
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 128) : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function responseDetail(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 256);
}
