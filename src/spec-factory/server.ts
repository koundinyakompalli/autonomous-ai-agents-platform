import express from "express";
import type mysql from "mysql2/promise";
import { JiraClient } from "../orchestrator/JiraClient.js";
import { getDatabase, type CodeRepository } from "../orchestrator/database.js";
import { CandidateIngestor } from "./candidate-ingestor.js";
import { SpecFactoryRepository } from "./database.js";
import { DraftGenerator } from "./draft-generator.js";
import { SpecFactoryAttachmentArchiver } from "./attachment-archive.js";
import { SpecFactoryEvidenceCollector } from "./evidence-collector.js";
import {
  JiraPublisher,
  type FindChildIssueByParentAndSummary,
} from "./jira-publisher.js";
import { OneShotSubmitter } from "./oneshot-submitter.js";
import { SpecFactoryRepoContextCollector } from "./repo-context.js";
import {
  assertSpecFactoryRepoCacheReady,
  SpecFactoryRepoWorkspaceManager,
} from "./repo-workspace.js";
import { createSpecFactoryRouter } from "./routes.js";
import { SpecFactoryService } from "./service.js";
import {
  ComposeRepository,
  type ComposeControlPlaneHealth,
} from "./compose-database.js";
import { ComposeEvidenceProvider } from "./compose-evidence-provider.js";
import { ComposeService } from "./compose-service.js";
import { ComposeRepoGrounding } from "./compose-repo-grounding.js";
import { createComposeRouter } from "./compose-routes.js";
import { specFactoryTelemetryMiddleware } from "./telemetry/http.js";
import { SpecFactoryTaskWorkspaceManager } from "./evidence-workspace.js";
import { MarkitdownClient } from "./compose-markitdown-client.js";
import { ComposeAudioClient } from "./compose-audio-client.js";
import { ComposeVoxtral } from "./compose-voxtral.js";
import { ComposeUploads } from "./compose-uploads.js";
import { ComposeConversionWorker } from "./compose-conversion.js";
import { ComposeChatAgent } from "./compose-chat-agent.js";
import {
  ComposeWorkspaceManager,
  assertComposeWorkspaceBaseReady,
} from "./compose-workspace.js";
import { ComposeSseHub, type ComposeSseRuntimeHealth } from "./compose-sse.js";
import { ComposeJiraSourceFetcher } from "./compose-jira-source.js";
import { ComposeRetentionCleaner } from "./compose-retention.js";
import { ComposeArtifactGc } from "./compose-artifact-gc.js";
import { ComposeSourceDeletionCleaner } from "./compose-source-deletion.js";
import { ComposeTurnWorker } from "./compose-turn-worker.js";
import {
  ComposeAgentTaskWorker,
  DEFAULT_AGENT_TASK_LEASE_MS,
} from "./compose-agent-task-worker.js";
import { createContextExecutorRegistry } from "./agents/context-executors.js";
import { createCriticExecutorRegistry } from "./agents/critic-agent.js";
import { createHandoffExecutorRegistry } from "./agents/handoff-builder.js";
import { defaultCapabilityRegistry } from "./agents/capability-registry.js";
import type { CodeResearchRunner } from "./agents/research-executors.js";
import {
  ClaudeAgentSdkResearchRunner,
  DEFAULT_RESEARCH_MAX_RUNTIME_SECONDS,
  createResearchExecutorRegistry,
  researchDistillationEnabled,
  resolveResearchAllowedBashCommandPatterns,
  resolveResearchAllowedTools,
  resolveResearchExecutorMode,
  resolveResearchMaxCostUsd,
  type ResearchExecutorMode,
} from "./agents/research-executors.js";
import {
  ChatCoordinator,
  resolveCoordinatorMaxTasksPerTurn,
} from "./agents/chat-coordinator.js";
import {
  createSpecFactoryLlmGateway,
  type LlmGateway,
  type LlmGatewayEnvironment,
} from "./llm/llm-gateway.js";
import { SpecFactoryLlmCallAuditRepository } from "./llm/llm-audit.js";
import { LlmAuditArtifactRetentionCleaner } from "./llm/llm-audit-retention.js";
import { resolveSpecFactoryRetentionPolicy } from "./session/retention-policy.js";
import { SpecFactoryWorkerHeartbeatRepository } from "./worker-heartbeat.js";
import { SQSClient } from "@aws-sdk/client-sqs";
import { S3Client } from "@aws-sdk/client-s3";
import { SpecFactoryOutboxRepository } from "./control-plane/outbox.js";
import { SpecFactoryOutboxRelay } from "./control-plane/outbox-relay.js";
import {
  SpecFactoryQueueReceiptRepository,
  SpecFactorySqsConsumer,
  SpecFactorySqsPublisher,
  type SpecFactoryQueueName,
  type SpecFactoryQueueUrls,
} from "./control-plane/sqs.js";
import { ImmutableS3ArtifactStore } from "./storage/immutable-s3-artifact-store.js";
import { CanonicalSessionEventSchema } from "./events/canonical-event.js";
import { ValkeySessionEventFanout } from "./events/valkey-fanout.js";
import { SpecFactoryControlPlaneMaintenance } from "./control-plane/maintenance.js";
import { createSpecFactoryEcsTaskProtection } from "./control-plane/ecs-task-protection.js";
import { ContextV4Backfill } from "./repair/context-v4-backfill.js";
import {
  ImmutableArtifactReachabilityGc,
  immutableArtifactRootPrefix,
} from "./storage/immutable-artifact-gc.js";
import {
  SPEC_FACTORY_RUNTIME_MODES,
  type SpecFactoryRuntimeMode,
} from "./runtime-modes.js";

export type { SpecFactoryRuntimeMode } from "./runtime-modes.js";

interface CodeRepositoryRow extends mysql.RowDataPacket, CodeRepository {}

export interface SpecFactoryRuntimeConfig {
  mode: SpecFactoryRuntimeMode;
  httpApi: boolean;
  sseHeartbeat: boolean;
  specProcessing: boolean;
  composeConversion: boolean;
  composeTurnWorker: boolean;
  composeAgentTaskWorker: boolean;
  outboxRelay: boolean;
  retentionCleanup: boolean;
}

const DEFAULT_WORKER_HEARTBEAT_MS = 15_000;
const MAX_ACTIVE_WORKER_ID_LENGTH = 128;
const DEFAULT_COORDINATOR_MAX_COST_USD = 0.25;

type SpecFactoryChatCoordinatorEnvironment = LlmGatewayEnvironment & {
  SPEC_FACTORY_LLM_GATEWAY?: string;
  SPEC_FACTORY_CHAT_COORDINATOR?: string;
  SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN?: string;
  SPEC_FACTORY_COORDINATOR_MAX_COST_USD?: string;
};

type SpecFactoryAgentTaskExecutorEnvironment = LlmGatewayEnvironment & {
  SPEC_FACTORY_LLM_GATEWAY?: string;
  SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM?: string;
  SPEC_FACTORY_CONTEXT_DISTILLATION_MAX_COST_USD?: string;
  SPEC_FACTORY_CONTEXT_DISTILLATION_TIMEOUT_MS?: string;
  SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM?: string;
  SPEC_FACTORY_CONTEXT_MERGE_MAX_COST_USD?: string;
  SPEC_FACTORY_CONTEXT_MERGE_TIMEOUT_MS?: string;
  SPEC_FACTORY_ENABLE_CRITIC?: string;
  SPEC_FACTORY_CRITIC_MAX_COST_USD?: string;
  SPEC_FACTORY_CRITIC_TIMEOUT_MS?: string;
  SPEC_FACTORY_RESEARCH_EXECUTOR?: string;
  SPEC_FACTORY_RESEARCH_MAX_RUNTIME_SECONDS?: string;
  SPEC_FACTORY_RESEARCH_DISTILLATION_ENABLED?: string;
  SPEC_FACTORY_RESEARCH_ALLOWED_TOOLS?: string;
  SPEC_FACTORY_RESEARCH_ALLOWED_BASH_PATTERNS?: string;
  SPEC_FACTORY_RESEARCH_MAX_TURNS?: string;
  SPEC_FACTORY_RESEARCH_MAX_COST_USD?: string;
  SPEC_FACTORY_RESEARCH_COST_CEILING_USD?: string;
  SPEC_FACTORY_RESEARCH_TOOL_BUDGET?: string;
  SPEC_FACTORY_AGENT_TASK_LEASE_MS?: string;
  SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED?: string;
  SPEC_FACTORY_HANDOFF_LLM_SYNTHESIS?: string;
  SPEC_FACTORY_HANDOFF_SYNTHESIS_MAX_COST_USD?: string;
  SPEC_FACTORY_HANDOFF_SYNTHESIS_TIMEOUT_MS?: string;
};

export interface CreateSpecFactoryChatCoordinatorInput {
  env?: SpecFactoryChatCoordinatorEnvironment;
  createLlmGateway?: () => Pick<LlmGateway, "generateObject">;
}

export interface ComposeRuntimeQueueHealth {
  legacyInflight: number;
  legacyQueued: number;
  sse?: ComposeSseRuntimeHealth;
}

export function mergeComposeRuntimeHealth(
  controlPlane: ComposeControlPlaneHealth,
  runtime: ComposeRuntimeQueueHealth,
): ComposeControlPlaneHealth {
  return {
    ...controlPlane,
    turns: {
      ...controlPlane.turns,
      legacyInflight: runtime.legacyInflight,
      legacyQueued: runtime.legacyQueued,
    },
    events: {
      ...controlPlane.events,
      liveDeliveredByThisReplica:
        runtime.sse?.liveDeliveredByThisReplica ??
        controlPlane.events.liveDeliveredByThisReplica,
      replayedByThisReplica:
        runtime.sse?.replayedByThisReplica ??
        controlPlane.events.replayedByThisReplica,
    },
    streams: {
      ...controlPlane.streams,
      activeSubscribers:
        runtime.sse?.activeSubscribers ??
        controlPlane.streams.activeSubscribers,
      activeSessions:
        runtime.sse?.activeSessions ?? controlPlane.streams.activeSessions,
      connectedByThisReplica:
        runtime.sse?.connectedByThisReplica ??
        controlPlane.streams.connectedByThisReplica,
      disconnectedByThisReplica:
        runtime.sse?.disconnectedByThisReplica ??
        controlPlane.streams.disconnectedByThisReplica,
    },
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Spec Factory`);
  return value;
}

export function resolveImmutableArtifactStorageConfig(
  env: NodeJS.ProcessEnv = process.env,
): { bucket: string; rootPrefix: string } | null {
  if (env.SPEC_FACTORY_ARTIFACT_STORE?.trim().toLowerCase() !== "s3") {
    return null;
  }
  const bucket = env.SPEC_FACTORY_ARTIFACT_BUCKET?.trim();
  if (!bucket) {
    throw new Error(
      "SPEC_FACTORY_ARTIFACT_BUCKET is required for Spec Factory",
    );
  }
  return {
    bucket,
    rootPrefix: immutableArtifactRootPrefix(
      env.SPEC_FACTORY_ARTIFACT_PREFIX?.trim() || "spec-factory",
    ),
  };
}

/**
 * Returns `{ [key]: <ms> }` when the env var parses to a positive integer, or
 * `{}` so the worker keeps its built-in default. Lets `...spread` opt in only
 * for explicitly configured overrides.
 */
function optionalPositiveIntMs(
  key: string,
  raw: string | undefined,
): Record<string, number> {
  const value = Number(raw?.trim());
  if (!Number.isInteger(value) || value <= 0) return {};
  return { [key]: value };
}

function booleanEnv(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** Parse a positive number from env, or undefined so the callee keeps its default. */
function optionalPositiveNumber(raw: string | undefined): number | undefined {
  const value = Number(raw?.trim());
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

function resolveCoordinatorMaxCostUsd(
  env: SpecFactoryChatCoordinatorEnvironment,
): number | undefined {
  const configured = optionalPositiveNumber(
    env.SPEC_FACTORY_COORDINATOR_MAX_COST_USD,
  );
  if (configured !== undefined) return configured;
  if (
    optionalPositiveNumber(env.SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD) !==
      undefined ||
    optionalPositiveNumber(
      env.SPEC_FACTORY_LLM_GLOBAL_DAILY_COST_CEILING_USD,
    ) !== undefined
  ) {
    return DEFAULT_COORDINATOR_MAX_COST_USD;
  }
  return undefined;
}

function parseSpecFactoryMode(raw: string | undefined): SpecFactoryRuntimeMode {
  const mode = raw?.trim().toLowerCase() || "all-local";
  if (SPEC_FACTORY_RUNTIME_MODES.includes(mode as SpecFactoryRuntimeMode)) {
    return mode as SpecFactoryRuntimeMode;
  }
  throw new Error(
    `Invalid SPEC_FACTORY_MODE "${raw}". Expected one of: ${SPEC_FACTORY_RUNTIME_MODES.join(", ")}`,
  );
}

export function durableTurnWorkerEnabled(
  raw = process.env.SPEC_FACTORY_DURABLE_TURNS,
): boolean {
  const mode = raw?.trim().toLowerCase();
  return mode === "drain" || mode === "on";
}

export function durableEventsRequired(
  raw = process.env.SPEC_FACTORY_DURABLE_EVENTS,
): boolean {
  return booleanEnv(raw);
}

export function outboxRelayEnabled(
  raw = process.env.SPEC_FACTORY_OUTBOX_ENABLED,
): boolean {
  return booleanEnv(raw);
}

function resolveQueueDispatchMode(
  raw = process.env.SPEC_FACTORY_QUEUE_DISPATCH_MODE,
): "shadow" | "primary" {
  const mode = raw?.trim().toLowerCase() || "shadow";
  if (mode === "shadow" || mode === "primary") return mode;
  throw new Error(`Invalid SPEC_FACTORY_QUEUE_DISPATCH_MODE "${raw}"`);
}

function resolveSpecFactoryQueueUrls(
  env: NodeJS.ProcessEnv = process.env,
): SpecFactoryQueueUrls {
  const read = (name: string): string => {
    const value = env[name]?.trim();
    if (!value)
      throw new Error(`${name} is required when SQS dispatch is enabled`);
    return value;
  };
  return {
    turn: read("SPEC_FACTORY_TURN_QUEUE_URL"),
    context: read("SPEC_FACTORY_CONTEXT_QUEUE_URL"),
    research: read("SPEC_FACTORY_RESEARCH_QUEUE_URL"),
    conversion: read("SPEC_FACTORY_CONVERSION_QUEUE_URL"),
    draft: read("SPEC_FACTORY_DRAFT_QUEUE_URL"),
    events: read("SPEC_FACTORY_EVENTS_QUEUE_URL"),
  };
}

export function agentTaskWorkerEnabled(
  raw = process.env.SPEC_FACTORY_AGENT_TASK_WORKER_ENABLED ??
    process.env.SPEC_FACTORY_AGENT_TASKS,
): boolean {
  return booleanEnv(raw);
}

export function llmGatewayEnabled(
  raw = process.env.SPEC_FACTORY_LLM_GATEWAY,
): boolean {
  return booleanEnv(raw);
}

export function chatCoordinatorEnabled(
  raw = process.env.SPEC_FACTORY_CHAT_COORDINATOR,
): boolean {
  return booleanEnv(raw);
}

export function contextDistillationEnabled(
  raw = process.env.SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION,
): boolean {
  return booleanEnv(raw);
}

export function contextMergeEnabled(
  raw = process.env.SPEC_FACTORY_ENABLE_CONTEXT_MERGE,
): boolean {
  return booleanEnv(raw);
}

export function contextDistillationLlmEnabled(
  raw = process.env.SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM,
): boolean {
  return booleanEnv(raw);
}

export function contextMergeLlmEnabled(
  raw = process.env.SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM,
): boolean {
  return booleanEnv(raw);
}

export function criticEnabled(
  raw = process.env.SPEC_FACTORY_ENABLE_CRITIC,
): boolean {
  return booleanEnv(raw);
}

export function handoffBuildTaskEnabled(
  raw = process.env.SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED,
): boolean {
  return booleanEnv(raw);
}

export function handoffLlmSynthesisEnabled(
  raw = process.env.SPEC_FACTORY_HANDOFF_LLM_SYNTHESIS,
): boolean {
  return booleanEnv(raw);
}

export function workspaceManagerEnabled(
  raw = process.env.SPEC_FACTORY_WORKSPACE_MANAGER,
): boolean {
  return booleanEnv(raw);
}

export function workerHeartbeatEnabled(
  runtime: Pick<SpecFactoryRuntimeConfig, "mode">,
  raw = process.env.SPEC_FACTORY_WORKER_HEARTBEAT_ENABLED,
): boolean {
  return runtime.mode !== "all-local" || booleanEnv(raw);
}

export function resolveSpecFactoryWorkerId(
  mode: SpecFactoryRuntimeMode,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fallbackIdentity = env.HOSTNAME?.trim() || String(process.pid);
  return truncateWorkerId(
    env.SPEC_FACTORY_WORKER_ID?.trim() ||
      `spec-factory-${mode}-${fallbackIdentity}`,
  );
}

interface RetentionIntervalHandle {
  unref?(): void;
}

type RegisterRetentionInterval = (
  handler: () => void,
  intervalMs: number,
) => RetentionIntervalHandle;

export function scheduleSpecFactoryRetentionSweeps(input: {
  runRetentionSweep: () => void;
  retentionIntervalMs: number;
  runSourceDeletionSweep: () => void;
  sourceDeletionSweepMs: number;
  registerInterval?: RegisterRetentionInterval;
}): void {
  const registerInterval =
    input.registerInterval ??
    ((handler, intervalMs) => setInterval(handler, intervalMs));
  registerInterval(
    input.runRetentionSweep,
    input.retentionIntervalMs,
  ).unref?.();
  registerInterval(
    input.runSourceDeletionSweep,
    input.sourceDeletionSweepMs,
  ).unref?.();
  input.runRetentionSweep();
  input.runSourceDeletionSweep();
}

export function resolveComposeTurnWorkerId(
  mode: SpecFactoryRuntimeMode,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return truncateWorkerId(
    env.SPEC_FACTORY_TURN_WORKER_ID?.trim() ||
      workerIdWithSuffix(resolveSpecFactoryWorkerId(mode, env), ":turn"),
  );
}

export function resolveComposeAgentTaskWorkerId(
  mode: SpecFactoryRuntimeMode,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return truncateWorkerId(
    env.SPEC_FACTORY_AGENT_TASK_WORKER_ID?.trim() ||
      workerIdWithSuffix(resolveSpecFactoryWorkerId(mode, env), ":agent-task"),
  );
}

function workerIdWithSuffix(base: string, suffix: string): string {
  const maxBaseLength = Math.max(
    1,
    MAX_ACTIVE_WORKER_ID_LENGTH - suffix.length,
  );
  return `${base.slice(0, maxBaseLength)}${suffix}`;
}

function truncateWorkerId(workerId: string): string {
  return workerId.slice(0, MAX_ACTIVE_WORKER_ID_LENGTH);
}

function queueForRuntime(
  mode: SpecFactoryRuntimeMode,
): SpecFactoryQueueName | null {
  if (mode === "turn-worker") return "turn";
  if (mode === "context-worker") return "context";
  if (mode === "research-worker") return "research";
  if (mode === "conversion-worker") return "conversion";
  if (mode === "draft-worker") return "draft";
  if (mode === "relay-worker") return "events";
  return null;
}

export function resolveRuntimeHeartbeatCapabilities(
  runtime: SpecFactoryRuntimeConfig,
  agentTaskCapabilities: string[] = [],
): string[] {
  const capabilities = new Set<string>();
  if (runtime.httpApi) capabilities.add("http_api");
  if (runtime.sseHeartbeat) capabilities.add("sse");
  if (runtime.specProcessing) capabilities.add("spec_processing");
  if (runtime.composeConversion) capabilities.add("source_conversion");
  if (runtime.composeTurnWorker) capabilities.add("durable_turn_worker");
  if (runtime.outboxRelay) capabilities.add("outbox_relay");
  if (runtime.retentionCleanup) capabilities.add("retention_cleanup");
  if (runtime.composeAgentTaskWorker) {
    for (const capability of agentTaskCapabilities) {
      capabilities.add(`agent_task:${capability}`);
    }
  }
  return [...capabilities].sort();
}

export function createSpecFactoryChatCoordinator(
  input: CreateSpecFactoryChatCoordinatorInput = {},
): ChatCoordinator | null {
  const env = input.env ?? process.env;
  if (
    !llmGatewayEnabled(env.SPEC_FACTORY_LLM_GATEWAY) ||
    !chatCoordinatorEnabled(env.SPEC_FACTORY_CHAT_COORDINATOR)
  ) {
    return null;
  }
  const llmGateway =
    input.createLlmGateway?.() ?? createSpecFactoryLlmGateway({ env });
  return new ChatCoordinator(llmGateway, {
    maxResearchTasks: resolveCoordinatorMaxTasksPerTurn(
      env.SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN,
    ),
    maxCostUsd: resolveCoordinatorMaxCostUsd(env),
  });
}

export function resolveAgentTaskWorkerCapabilities(
  raw = process.env.SPEC_FACTORY_AGENT_TASK_WORKER_CAPABILITIES,
): string[] {
  const capabilities = raw
    ?.split(",")
    .map((capability) => capability.trim())
    .filter(Boolean);
  if (capabilities && capabilities.length > 0) return capabilities;
  const defaults = ["source_distillation"];
  if (contextMergeEnabled()) {
    defaults.push("context_merge");
  }
  if (resolveResearchExecutorMode() === "claude_agent_sdk") {
    defaults.push("code_research", "config_research", "devops_research");
  }
  if (criticEnabled() && llmGatewayEnabled()) {
    defaults.push("critic_review");
  }
  if (handoffBuildTaskEnabled()) {
    defaults.push("handoff_build");
  }
  return defaults;
}

export function assertAgentTaskCapabilitiesHaveExecutors(
  capabilities: string[],
  registry: { has(executorType: string): boolean },
): void {
  const definitions = defaultCapabilityRegistry();
  const missing = [...new Set(capabilities)]
    .map((capability) => ({
      capability,
      executorType: definitions.get(capability).executorType,
    }))
    .filter(({ executorType }) => !registry.has(executorType));
  if (missing.length > 0) {
    throw new Error(
      `agent_task_capability_missing_executor:${missing
        .map(({ capability, executorType }) => `${capability}->${executorType}`)
        .join(",")}`,
    );
  }
}

export function resolveSpecFactoryRuntime(
  input: {
    mode?: string;
    splitRuntimeAllowed?: string;
    workspaceManager?: string;
    durableTurns?: string;
    agentTaskWorker?: string;
    retentionCleanup?: string;
  } = {},
): SpecFactoryRuntimeConfig {
  const mode = parseSpecFactoryMode(
    input.mode ?? process.env.SPEC_FACTORY_MODE,
  );
  const splitRuntimeAllowed = booleanEnv(
    input.splitRuntimeAllowed ?? process.env.SPEC_FACTORY_ALLOW_SPLIT_RUNTIME,
  );
  const workspaceManager = workspaceManagerEnabled(
    input.workspaceManager ?? process.env.SPEC_FACTORY_WORKSPACE_MANAGER,
  );
  if (mode !== "all-local" && !workspaceManager && !splitRuntimeAllowed) {
    throw new Error(
      `SPEC_FACTORY_MODE=${mode} requires SPEC_FACTORY_WORKSPACE_MANAGER=true or SPEC_FACTORY_ALLOW_SPLIT_RUNTIME=true`,
    );
  }

  const durableTurnWorker = durableTurnWorkerEnabled(
    input.durableTurns ?? process.env.SPEC_FACTORY_DURABLE_TURNS,
  );
  const agentTaskWorker = agentTaskWorkerEnabled(
    input.agentTaskWorker ??
      process.env.SPEC_FACTORY_AGENT_TASK_WORKER_ENABLED ??
      process.env.SPEC_FACTORY_AGENT_TASKS,
  );
  const retentionCleanup = booleanEnv(
    input.retentionCleanup ?? process.env.COMPOSE_RETENTION_CLEANUP_ENABLED,
  );

  if (mode === "api") {
    return {
      mode,
      httpApi: true,
      sseHeartbeat: true,
      specProcessing: false,
      composeConversion: false,
      composeTurnWorker: false,
      composeAgentTaskWorker: false,
      outboxRelay: false,
      retentionCleanup: false,
    };
  }
  if (mode === "worker") {
    return {
      mode,
      httpApi: false,
      sseHeartbeat: false,
      specProcessing: true,
      composeConversion: false,
      composeTurnWorker: durableTurnWorker,
      composeAgentTaskWorker: agentTaskWorker,
      outboxRelay: false,
      retentionCleanup,
    };
  }
  if (mode === "turn-worker") {
    return {
      mode,
      httpApi: false,
      sseHeartbeat: false,
      specProcessing: false,
      composeConversion: false,
      composeTurnWorker: durableTurnWorker,
      composeAgentTaskWorker: false,
      outboxRelay: false,
      retentionCleanup: false,
    };
  }
  if (mode === "context-worker") {
    return {
      mode,
      httpApi: false,
      sseHeartbeat: false,
      specProcessing: false,
      composeConversion: false,
      composeTurnWorker: false,
      composeAgentTaskWorker: agentTaskWorker,
      outboxRelay: false,
      retentionCleanup: false,
    };
  }
  if (mode === "draft-worker") {
    return {
      mode,
      httpApi: false,
      sseHeartbeat: false,
      specProcessing: true,
      composeConversion: false,
      composeTurnWorker: false,
      composeAgentTaskWorker: false,
      outboxRelay: false,
      retentionCleanup: false,
    };
  }
  if (mode === "conversion-worker") {
    return {
      mode,
      httpApi: false,
      sseHeartbeat: false,
      specProcessing: false,
      composeConversion: true,
      composeTurnWorker: false,
      composeAgentTaskWorker: false,
      outboxRelay: false,
      retentionCleanup: false,
    };
  }
  if (mode === "research-worker") {
    return {
      mode,
      httpApi: false,
      sseHeartbeat: false,
      specProcessing: false,
      composeConversion: false,
      composeTurnWorker: false,
      composeAgentTaskWorker: agentTaskWorker,
      outboxRelay: false,
      retentionCleanup: false,
    };
  }
  if (mode === "relay-worker") {
    return {
      mode,
      httpApi: false,
      sseHeartbeat: false,
      specProcessing: false,
      composeConversion: false,
      composeTurnWorker: false,
      composeAgentTaskWorker: false,
      outboxRelay: true,
      retentionCleanup: false,
    };
  }
  if (mode === "retention-worker") {
    return {
      mode,
      httpApi: false,
      sseHeartbeat: false,
      specProcessing: false,
      composeConversion: false,
      composeTurnWorker: false,
      composeAgentTaskWorker: false,
      outboxRelay: false,
      retentionCleanup,
    };
  }
  return {
    mode,
    httpApi: true,
    sseHeartbeat: true,
    specProcessing: true,
    composeConversion: true,
    composeTurnWorker: durableTurnWorker,
    composeAgentTaskWorker: agentTaskWorker,
    outboxRelay: false,
    retentionCleanup,
  };
}

export function createSpecFactoryAgentTaskExecutorRegistry(input: {
  repository: Parameters<typeof createContextExecutorRegistry>[0] &
    Parameters<typeof createResearchExecutorRegistry>[0] &
    Parameters<typeof createHandoffExecutorRegistry>[0];
  specRepository?: Parameters<typeof createHandoffExecutorRegistry>[1];
  workspace: Parameters<typeof createContextExecutorRegistry>[1] &
    Parameters<typeof createResearchExecutorRegistry>[1] &
    Parameters<typeof createHandoffExecutorRegistry>[2];
  draftRequester?: Parameters<typeof createHandoffExecutorRegistry>[3];
  researchExecutorMode?: ResearchExecutorMode;
  researchRunner?: CodeResearchRunner;
  researchRepoGrounding?: NonNullable<
    Parameters<typeof createResearchExecutorRegistry>[3]
  >["repoGrounding"];
  llmGateway?: Pick<LlmGateway, "generateObject">;
  agentTaskCapabilities?: string[];
  env?: SpecFactoryAgentTaskExecutorEnvironment;
}) {
  const env = input.env ?? process.env;
  const enableLlmDistillation = contextDistillationLlmEnabled(
    env.SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM,
  );
  if (
    enableLlmDistillation &&
    !llmGatewayEnabled(env.SPEC_FACTORY_LLM_GATEWAY)
  ) {
    throw new Error("context_distillation_llm_requires_llm_gateway");
  }
  const enableLlmContextMerge = contextMergeLlmEnabled(
    env.SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM,
  );
  if (
    enableLlmContextMerge &&
    !llmGatewayEnabled(env.SPEC_FACTORY_LLM_GATEWAY)
  ) {
    throw new Error("context_merge_llm_requires_llm_gateway");
  }
  const contextLlmGateway = enableLlmDistillation
    ? (input.llmGateway ?? createSpecFactoryLlmGateway({ env }))
    : undefined;
  const contextMergeGateway = enableLlmContextMerge
    ? (input.llmGateway ?? createSpecFactoryLlmGateway({ env }))
    : undefined;
  const registry = createContextExecutorRegistry(
    input.repository,
    input.workspace,
    {
      sourceDistillationLlmGateway: contextLlmGateway,
      sourceDistillationMaxCostUsd: optionalPositiveNumber(
        env.SPEC_FACTORY_CONTEXT_DISTILLATION_MAX_COST_USD,
      ),
      sourceDistillationTimeoutMs: optionalPositiveNumber(
        env.SPEC_FACTORY_CONTEXT_DISTILLATION_TIMEOUT_MS,
      ),
      contextMergeLlmGateway: contextMergeGateway,
      contextMergeMaxCostUsd: optionalPositiveNumber(
        env.SPEC_FACTORY_CONTEXT_MERGE_MAX_COST_USD,
      ),
      contextMergeTimeoutMs: optionalPositiveNumber(
        env.SPEC_FACTORY_CONTEXT_MERGE_TIMEOUT_MS,
      ),
    },
  );
  const researchExecutorMode =
    input.researchExecutorMode ??
    resolveResearchExecutorMode(env.SPEC_FACTORY_RESEARCH_EXECUTOR);
  if (researchExecutorMode !== "none") {
    const researchMaxRuntimeSeconds =
      optionalPositiveNumber(env.SPEC_FACTORY_RESEARCH_MAX_RUNTIME_SECONDS) ??
      DEFAULT_RESEARCH_MAX_RUNTIME_SECONDS;
    assertResearchRuntimeWithinAgentTaskLease(
      researchMaxRuntimeSeconds,
      env.SPEC_FACTORY_AGENT_TASK_LEASE_MS,
    );

    const researchRegistry = createResearchExecutorRegistry(
      input.repository,
      input.workspace,
      input.researchRunner ?? new ClaudeAgentSdkResearchRunner(),
      {
        mode: researchExecutorMode,
        enqueueDistillation: researchDistillationEnabled(
          env.SPEC_FACTORY_RESEARCH_DISTILLATION_ENABLED,
        ),
        allowedTools: resolveResearchAllowedTools(
          env.SPEC_FACTORY_RESEARCH_ALLOWED_TOOLS,
        ),
        allowedBashCommandPatterns: resolveResearchAllowedBashCommandPatterns(
          env.SPEC_FACTORY_RESEARCH_ALLOWED_BASH_PATTERNS,
        ),
        maxTurns: optionalPositiveNumber(env.SPEC_FACTORY_RESEARCH_MAX_TURNS),
        maxRuntimeSeconds: researchMaxRuntimeSeconds,
        maxCostUsd: resolveResearchMaxCostUsd(
          env.SPEC_FACTORY_RESEARCH_MAX_COST_USD,
        ),
        toolBudget: optionalPositiveNumber(
          env.SPEC_FACTORY_RESEARCH_TOOL_BUDGET,
        ),
        repoGrounding: input.researchRepoGrounding,
      },
    );
    for (const executorType of researchRegistry.listExecutorTypes()) {
      registry.register(researchRegistry.get(executorType));
    }
  }

  const criticExecutorRequired =
    criticEnabled(env.SPEC_FACTORY_ENABLE_CRITIC) ||
    input.agentTaskCapabilities?.includes("critic_review") === true;
  if (criticExecutorRequired) {
    if (!llmGatewayEnabled(env.SPEC_FACTORY_LLM_GATEWAY)) {
      throw new Error("critic_requires_llm_gateway");
    }
    const criticGateway =
      input.llmGateway ?? createSpecFactoryLlmGateway({ env });
    const criticRegistry = createCriticExecutorRegistry(criticGateway, {
      maxCostUsd: optionalPositiveNumber(env.SPEC_FACTORY_CRITIC_MAX_COST_USD),
      timeoutMs: optionalPositiveNumber(env.SPEC_FACTORY_CRITIC_TIMEOUT_MS),
    });
    for (const executorType of criticRegistry.listExecutorTypes()) {
      registry.register(criticRegistry.get(executorType));
    }
  }

  const handoffExecutorRequired =
    handoffBuildTaskEnabled(env.SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED) ||
    input.agentTaskCapabilities?.includes("handoff_build") === true;
  if (handoffExecutorRequired) {
    if (!input.specRepository || !input.draftRequester) {
      throw new Error("handoff_build_requires_dependencies");
    }
    const enableHandoffLlmNarrative = handoffLlmSynthesisEnabled(
      env.SPEC_FACTORY_HANDOFF_LLM_SYNTHESIS,
    );
    if (
      enableHandoffLlmNarrative &&
      !llmGatewayEnabled(env.SPEC_FACTORY_LLM_GATEWAY)
    ) {
      throw new Error("handoff_synthesis_requires_llm_gateway");
    }
    const handoffGateway = enableHandoffLlmNarrative
      ? (input.llmGateway ?? createSpecFactoryLlmGateway({ env }))
      : undefined;
    const handoffRegistry = createHandoffExecutorRegistry(
      input.repository,
      input.specRepository,
      input.workspace,
      input.draftRequester,
      {
        llmGateway: handoffGateway,
        enableLlmNarrative: enableHandoffLlmNarrative,
        maxCostUsd: optionalPositiveNumber(
          env.SPEC_FACTORY_HANDOFF_SYNTHESIS_MAX_COST_USD,
        ),
        timeoutMs: optionalPositiveNumber(
          env.SPEC_FACTORY_HANDOFF_SYNTHESIS_TIMEOUT_MS,
        ),
      },
    );
    for (const executorType of handoffRegistry.listExecutorTypes()) {
      registry.register(handoffRegistry.get(executorType));
    }
  }
  return registry;
}

function assertResearchRuntimeWithinAgentTaskLease(
  researchMaxRuntimeSeconds: number,
  rawAgentTaskLeaseMs = process.env.SPEC_FACTORY_AGENT_TASK_LEASE_MS,
): void {
  const agentTaskLeaseMs =
    optionalPositiveNumber(rawAgentTaskLeaseMs) ?? DEFAULT_AGENT_TASK_LEASE_MS;
  const researchMaxRuntimeMs = researchMaxRuntimeSeconds * 1000;
  if (agentTaskLeaseMs < researchMaxRuntimeMs) {
    throw new Error(
      `research_runtime_exceeds_agent_task_lease:leaseMs=${agentTaskLeaseMs}:maxRuntimeSeconds=${researchMaxRuntimeSeconds}`,
    );
  }
}

function jiraUsername(): string {
  return process.env.JIRA_USERNAME?.trim() || requiredEnv("JIRA_EMAIL");
}

export function runtimeRequiresJira(
  runtime: SpecFactoryRuntimeConfig,
): boolean {
  return ["all-local", "api", "worker", "draft-worker"].includes(runtime.mode);
}

function unavailableJiraClient(runtime: SpecFactoryRuntimeConfig): JiraClient {
  return new Proxy({} as JiraClient, {
    get: (_target, property) => {
      if (property === "then") return undefined;
      return () => {
        throw new Error(`jira_capability_unavailable:${runtime.mode}`);
      };
    },
  });
}

function escapeJqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function createFindChildIssueByParentAndSummary(
  jiraClient: Pick<JiraClient, "searchIssues">,
): FindChildIssueByParentAndSummary {
  return async ({ projectKey, parentEpicKey, summary }) => {
    const escapedProjectKey = escapeJqlString(projectKey);
    const escapedParentEpicKey = escapeJqlString(parentEpicKey);
    const escapedSummary = escapeJqlString(summary);
    const result = await jiraClient.searchIssues(
      `project = "${escapedProjectKey}" AND parent = "${escapedParentEpicKey}" AND summary ~ "${escapedSummary}"`,
      "key,summary,parent,status",
      25,
    );
    const exact = result.issues.find(
      (issue) => issue.fields?.summary === summary,
    );
    return exact ? { key: exact.key, summary } : null;
  };
}

export function buildSpecFactoryApp(): express.Express {
  const runtime = resolveSpecFactoryRuntime();
  assertSpecFactoryLegacyRemovalGates(runtime);
  const taskProtection = createSpecFactoryEcsTaskProtection();
  const primaryQueueConsumer =
    runtime.mode !== "all-local" &&
    outboxRelayEnabled() &&
    resolveQueueDispatchMode() === "primary" &&
    queueForRuntime(runtime.mode) !== null;
  const app = express();
  app.use(specFactoryTelemetryMiddleware());
  app.use(express.json({ limit: "2mb" }));
  const composeWorkspaceBase =
    process.env.COMPOSE_WORKSPACE_BASE?.trim() ||
    "/mnt/efs/specter-repo/spec-factory/compose";
  const workspaceRuntime = ![
    "api",
    "relay-worker",
    "retention-worker",
  ].includes(runtime.mode);
  if (
    workspaceRuntime &&
    (runtime.mode !== "all-local" ||
      booleanEnv(process.env.COMPOSE_WORKSPACE_VALIDATE_ON_STARTUP))
  ) {
    assertComposeWorkspaceBaseReady(composeWorkspaceBase);
  }
  if (
    booleanEnv(process.env.SPEC_FACTORY_REPO_DEEP_DIVE_ENABLED) &&
    !["conversion-worker", "relay-worker", "retention-worker"].includes(
      runtime.mode,
    )
  ) {
    assertSpecFactoryRepoCacheReady(
      process.env.SPEC_FACTORY_REPO_CACHE_BASE?.trim() ||
        "/mnt/efs/specter-repo/spec-factory/repo-cache",
    );
  }

  const jiraEnabled = runtimeRequiresJira(runtime);
  const jiraBaseUrl = jiraEnabled
    ? requiredEnv("JIRA_BASE_URL")
    : process.env.JIRA_BASE_URL?.trim() || "https://jira-disabled.invalid";
  const jiraClient = jiraEnabled
    ? new JiraClient({
        baseUrl: jiraBaseUrl,
        token: requiredEnv("JIRA_TOKEN"),
        username: jiraUsername(),
      })
    : unavailableJiraClient(runtime);

  const pool = getDatabase().getPool();
  const repository = new SpecFactoryRepository(pool);
  const composeRepository = new ComposeRepository(pool);
  const immutableArtifactStorage = resolveImmutableArtifactStorageConfig();
  const immutableArtifactStore = immutableArtifactStorage
    ? new ImmutableS3ArtifactStore(
        new S3Client({ region: process.env.AWS_REGION }),
        immutableArtifactStorage.bucket,
        process.env.SPEC_FACTORY_ARTIFACT_PREFIX?.trim() || "spec-factory",
      )
    : undefined;
  const composeEvidenceProvider = new ComposeEvidenceProvider(
    composeRepository,
    repository,
  );
  const composeUploads = new ComposeUploads();
  const markitdownClient = new MarkitdownClient(
    process.env.COMPOSE_MARKITDOWN_URL?.trim() || "http://localhost:8080",
  );
  const composeAudioClient = new ComposeAudioClient(
    process.env.COMPOSE_MARKITDOWN_URL?.trim() || "http://localhost:8080",
  );
  const composeVoxtral = new ComposeVoxtral({
    modelId: process.env.COMPOSE_VOXTRAL_MODEL_ID?.trim() || undefined,
  });
  const composeConversionWorker = new ComposeConversionWorker(
    composeRepository,
    composeUploads,
    markitdownClient,
    {
      audio: composeAudioClient,
      voxtral: composeVoxtral,
      ...optionalPositiveIntMs(
        "convertTimeoutMs",
        process.env.COMPOSE_CONVERT_TIMEOUT_MS,
      ),
      ...optionalPositiveIntMs(
        "extractAudioTimeoutMs",
        process.env.COMPOSE_EXTRACT_AUDIO_TIMEOUT_MS,
      ),
      ...optionalPositiveIntMs(
        "transcribeSegmentTimeoutMs",
        process.env.COMPOSE_TRANSCRIBE_SEGMENT_TIMEOUT_MS,
      ),
      ...optionalPositiveIntMs(
        "conversionLeaseMs",
        process.env.COMPOSE_CONVERSION_LEASE_MS,
      ),
      enqueueDistillation: contextDistillationEnabled(),
      eventPublisher: composeRepository,
      artifactStore: immutableArtifactStore,
    },
  );
  const lookupRepositories = async (): Promise<CodeRepository[]> => {
    const [rows] = await pool.query<CodeRepositoryRow[]>(
      `SELECT id, repo_name, repo_url, COALESCE(description, '') AS description,
              default_branch, created_at
       FROM code_repositories
       ORDER BY repo_name ASC`,
    );
    return rows;
  };
  const attachmentArchiver = new SpecFactoryAttachmentArchiver(
    jiraClient,
    repository,
  );
  const evidenceCollector = new SpecFactoryEvidenceCollector(
    jiraClient,
    repository,
    attachmentArchiver,
    lookupRepositories,
  );
  const ingestor = new CandidateIngestor(jiraClient, repository, undefined);
  const workspaceManager = new SpecFactoryRepoWorkspaceManager();
  const repoContextCollector = new SpecFactoryRepoContextCollector({
    lookupRepositories,
    workspaceManager,
  });
  let liveComposeService: Pick<
    ComposeService,
    "getLegacyTurnQueueHealth"
  > | null = null;
  const composeHealthProvider = {
    getConversionQueueHealth: () =>
      composeRepository.getConversionQueueHealth(),
    getControlPlaneHealth: async () =>
      mergeComposeRuntimeHealth(
        await composeRepository.getControlPlaneHealth(),
        {
          ...(liveComposeService?.getLegacyTurnQueueHealth() ?? {
            legacyInflight: 0,
            legacyQueued: 0,
          }),
          sse: composeSseHub.getRuntimeHealth(),
        },
      ),
  };
  const service = new SpecFactoryService(
    repository,
    ingestor,
    evidenceCollector,
    repoContextCollector,
    new DraftGenerator(),
    new JiraPublisher(
      jiraClient,
      {
        projectKey: process.env.SPEC_FACTORY_JIRA_PROJECT_KEY,
        epicIssueType: process.env.SPEC_FACTORY_JIRA_EPIC_ISSUE_TYPE,
        childIssueType: process.env.SPEC_FACTORY_JIRA_CHILD_ISSUE_TYPE,
      },
      {
        findChildIssueByParentAndSummary:
          createFindChildIssueByParentAndSummary(jiraClient),
      },
    ),
    new OneShotSubmitter(jiraClient),
    new SpecFactoryTaskWorkspaceManager(),
    {
      composeEvidenceProvider,
      composeHealthProvider,
      draftArtifactStore: immutableArtifactStore,
    },
  );
  if (runtime.specProcessing && !primaryQueueConsumer) {
    service.startProcessingLoop();
  }

  const composeChatAgent = new ComposeChatAgent();
  const composeWorkspaceManager = new ComposeWorkspaceManager(undefined, {
    manifestStore: composeRepository,
    artifactStore: immutableArtifactStore,
  });
  const composeSseHub = new ComposeSseHub({
    eventStore: composeRepository,
    durableEventsRequired: durableEventsRequired(),
  });
  const valkeyUrl = process.env.SPEC_FACTORY_VALKEY_URL?.trim() || "";
  const eventFanout = valkeyUrl
    ? new ValkeySessionEventFanout({
        url: valkeyUrl,
        channelPrefix:
          process.env.SPEC_FACTORY_VALKEY_EVENT_CHANNEL_PREFIX?.trim() ||
          "spec-factory:session-events",
      })
    : null;
  if (runtime.httpApi && eventFanout) {
    const subscribeToLiveEvents = (): void => {
      void eventFanout
        .subscribe((event) => composeSseHub.publishCanonical(event))
        .catch((error) => {
          console.warn(
            `[spec-factory] Valkey event subscription failed; retrying while durable polling remains active: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          setTimeout(subscribeToLiveEvents, 5_000).unref?.();
        });
    };
    subscribeToLiveEvents();
  }
  if (runtime.sseHeartbeat) {
    composeSseHub.startHeartbeat();
  }
  composeSseHub.startDurableEventPolling(
    Number(process.env.SPEC_FACTORY_SSE_DURABLE_POLL_MS) || 1000,
  );
  const chatCoordinator = createSpecFactoryChatCoordinator();

  const composeRepoGrounding = new ComposeRepoGrounding({
    lookupRepositories,
    workspaceManager,
  });
  const composeService = new ComposeService(
    composeRepository,
    repository,
    service,
    composeUploads,
    runtime.composeConversion
      ? composeConversionWorker
      : { drain: async () => undefined },
    composeChatAgent,
    composeWorkspaceManager,
    composeSseHub,
    {
      workspaceBase: composeWorkspaceBase,
      s3Prefix: process.env.COMPOSE_S3_PREFIX?.trim() || "compose",
    },
    {
      jiraSourceFetcher: new ComposeJiraSourceFetcher(jiraClient, jiraBaseUrl),
      lookupRepositories,
      repoGrounding: composeRepoGrounding,
      chatCoordinator,
    },
  );
  liveComposeService = composeService;
  const composeTurnWorker = new ComposeTurnWorker(
    composeRepository,
    composeService,
    {
      workerId: resolveComposeTurnWorkerId(runtime.mode),
      leaseMs: optionalPositiveNumber(process.env.SPEC_FACTORY_TURN_LEASE_MS),
      maxTurnsPerDrain: optionalPositiveNumber(
        process.env.SPEC_FACTORY_TURN_WORKER_BATCH_SIZE,
      ),
      maxConcurrentTurns: optionalPositiveNumber(
        process.env.SPEC_FACTORY_TURN_WORKER_CONCURRENCY,
      ),
      recoveryLimit: optionalPositiveNumber(
        process.env.SPEC_FACTORY_TURN_LEASE_RECOVERY_LIMIT,
      ),
      clarificationExpiryLimit: optionalPositiveNumber(
        process.env.SPEC_FACTORY_TURN_CLARIFICATION_EXPIRY_LIMIT,
      ),
      eventPublisher: composeRepository,
      livePublisher: composeSseHub,
    },
  );
  const agentTaskCapabilities = resolveAgentTaskWorkerCapabilities();
  const agentTaskExecutorRegistry = createSpecFactoryAgentTaskExecutorRegistry({
    repository: composeRepository,
    specRepository: repository,
    workspace: composeWorkspaceManager,
    draftRequester: service,
    researchRepoGrounding: composeRepoGrounding,
    agentTaskCapabilities,
  });
  assertAgentTaskCapabilitiesHaveExecutors(
    agentTaskCapabilities,
    agentTaskExecutorRegistry,
  );
  const composeAgentTaskWorker = new ComposeAgentTaskWorker(
    composeRepository,
    agentTaskExecutorRegistry,
    {
      workerId: resolveComposeAgentTaskWorkerId(runtime.mode),
      leaseMs: optionalPositiveNumber(
        process.env.SPEC_FACTORY_AGENT_TASK_LEASE_MS,
      ),
      maxTasksPerDrain: optionalPositiveNumber(
        process.env.SPEC_FACTORY_AGENT_TASK_WORKER_BATCH_SIZE,
      ),
      recoveryLimit: optionalPositiveNumber(
        process.env.SPEC_FACTORY_AGENT_TASK_LEASE_RECOVERY_LIMIT,
      ),
      capabilities: agentTaskCapabilities,
      eventPublisher: composeRepository,
    },
  );

  if (runtime.outboxRelay && outboxRelayEnabled()) {
    const queueUrls = resolveSpecFactoryQueueUrls();
    const sqs = new SQSClient({ region: process.env.AWS_REGION });
    const relay = new SpecFactoryOutboxRelay(
      new SpecFactoryOutboxRepository(),
      new SpecFactorySqsPublisher(sqs, queueUrls, resolveQueueDispatchMode()),
      {
        workerId: workerIdWithSuffix(
          resolveSpecFactoryWorkerId(runtime.mode),
          ":outbox",
        ),
        batchSize: optionalPositiveNumber(
          process.env.SPEC_FACTORY_OUTBOX_BATCH_SIZE,
        ),
        concurrency: optionalPositiveNumber(
          process.env.SPEC_FACTORY_OUTBOX_CONCURRENCY,
        ),
      },
    );
    const relayMaintenance = new SpecFactoryControlPlaneMaintenance();
    const drainOutbox = (): void => {
      void relay.drainOnce().catch((error) => {
        console.warn(
          `[spec-factory] outbox relay drain failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    };
    setInterval(
      drainOutbox,
      optionalPositiveNumber(process.env.SPEC_FACTORY_OUTBOX_POLL_MS) ?? 250,
    ).unref?.();
    drainOutbox();
    const repairDispatches = (): void => {
      const policy = resolveSpecFactoryRetentionPolicy();
      void relayMaintenance
        .run({
          limit: policy.cleanupLimit,
          outboxRetentionDays: policy.outboxRetentionDays,
          receiptRetentionDays: policy.queueReceiptRetentionDays,
          strandedDispatchSeconds: policy.strandedDispatchSeconds,
        })
        .then((result) => {
          if (
            result.recoveredOutboxRows > 0 ||
            result.requeuedStrandedDispatches > 0 ||
            result.recoveredQueueReceipts > 0
          ) {
            console.log(
              `[spec-factory] control-plane repair: ${JSON.stringify(result)}`,
            );
          }
        })
        .catch((error) => {
          console.warn(
            `[spec-factory] control-plane repair failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    };
    setInterval(
      repairDispatches,
      optionalPositiveNumber(
        process.env.SPEC_FACTORY_CONTROL_PLANE_MAINTENANCE_MS,
      ) ?? 60_000,
    ).unref?.();
    repairDispatches();
  }

  if (runtime.mode !== "all-local" && outboxRelayEnabled()) {
    const queue = queueForRuntime(runtime.mode);
    if (queue) {
      const queueUrls = resolveSpecFactoryQueueUrls();
      const sqs = new SQSClient({ region: process.env.AWS_REGION });
      const receipts = new SpecFactoryQueueReceiptRepository();
      const consumer = new SpecFactorySqsConsumer(
        sqs,
        queueUrls[queue],
        `${resolveSpecFactoryWorkerId(runtime.mode)}:${queue}`,
        receipts,
        async (envelope) => {
          if (queue === "events") {
            if (!eventFanout) {
              return { durableOnly: true, reason: "valkey_not_configured" };
            }
            const payload =
              envelope.payload && typeof envelope.payload === "object"
                ? (envelope.payload as Record<string, unknown>)
                : {};
            const event = CanonicalSessionEventSchema.parse(
              payload.canonicalEvent,
            );
            await eventFanout.publish(event);
            return { published: true, eventId: event.id };
          }
          if (queue === "draft") {
            const agentTasks = runtime.composeAgentTaskWorker
              ? await composeAgentTaskWorker.drain()
              : 0;
            if (runtime.specProcessing) {
              await service.drainProcessingOnce();
            }
            return { agentTasks, draftStagesDrained: runtime.specProcessing };
          }
          if (runtime.composeTurnWorker) {
            return { drained: await composeTurnWorker.drain() };
          }
          if (runtime.composeAgentTaskWorker) {
            return { drained: await composeAgentTaskWorker.drain() };
          }
          if (runtime.composeConversion) {
            await composeConversionWorker.drain();
            return { drained: true };
          }
          if (runtime.specProcessing) {
            await service.drainProcessingOnce();
            return { drained: true };
          }
          return { ignored: true };
        },
        {
          visibilityTimeoutSeconds: optionalPositiveNumber(
            process.env.SPEC_FACTORY_SQS_VISIBILITY_TIMEOUT_SECONDS,
          ),
          heartbeatSeconds: optionalPositiveNumber(
            process.env.SPEC_FACTORY_SQS_HEARTBEAT_SECONDS,
          ),
          receiptLeaseMs: optionalPositiveNumber(
            process.env.SPEC_FACTORY_QUEUE_RECEIPT_LEASE_MS,
          ),
          quarantineQueueUrl:
            process.env.SPEC_FACTORY_QUARANTINE_QUEUE_URL?.trim() || undefined,
          expectedQueue: queue,
          workScope: taskProtection,
        },
      );
      const poll = (): void => {
        void consumer
          .pollOnce()
          .catch((error) => {
            console.warn(
              `[spec-factory] ${queue} SQS poll failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          })
          .finally(() => setTimeout(poll, 100).unref?.());
      };
      poll();
    }
  }

  if (workerHeartbeatEnabled(runtime)) {
    const heartbeatRepository = new SpecFactoryWorkerHeartbeatRepository();
    const startedAt = new Date();
    const recordHeartbeat = (): void => {
      void heartbeatRepository
        .recordHeartbeat({
          workerId: resolveSpecFactoryWorkerId(runtime.mode),
          mode: runtime.mode,
          capabilities: resolveRuntimeHeartbeatCapabilities(
            runtime,
            agentTaskCapabilities,
          ),
          startedAt,
          heartbeatAt: new Date(),
        })
        .catch((error) => {
          console.warn(
            `[spec-factory] worker heartbeat failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    };
    setInterval(
      recordHeartbeat,
      optionalPositiveNumber(process.env.SPEC_FACTORY_WORKER_HEARTBEAT_MS) ??
        DEFAULT_WORKER_HEARTBEAT_MS,
    ).unref?.();
    recordHeartbeat();
  }

  if (runtime.composeConversion && !primaryQueueConsumer) {
    setInterval(
      () => {
        void composeConversionWorker.drain().catch((error) => {
          console.warn(
            `[spec-factory] compose conversion drain failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      },
      Number(process.env.COMPOSE_CONVERSION_POLL_MS || 5000),
    );
  }

  if (runtime.composeTurnWorker && !primaryQueueConsumer) {
    const drainDurableTurns = (): void => {
      void composeTurnWorker.drain().catch((error) => {
        console.warn(
          `[spec-factory] compose durable turn drain failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    };
    setInterval(
      drainDurableTurns,
      Number(process.env.SPEC_FACTORY_TURN_WORKER_POLL_MS || 1000),
    ).unref?.();
    drainDurableTurns();
  }

  if (runtime.composeAgentTaskWorker && !primaryQueueConsumer) {
    const drainAgentTasks = (): void => {
      void composeAgentTaskWorker.drain().catch((error) => {
        console.warn(
          `[spec-factory] compose agent task drain failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    };
    setInterval(
      drainAgentTasks,
      Number(process.env.SPEC_FACTORY_AGENT_TASK_WORKER_POLL_MS || 1000),
    ).unref?.();
    drainAgentTasks();
  }

  // Scheduled retention sweep: purge EFS workspaces + S3 raw uploads for
  // sessions archived past the retention window. Opt-in (default off) so it is
  // enabled only after a dry-run validation; honors COMPOSE_CLEANUP_DRY_RUN.
  if (runtime.retentionCleanup) {
    const controlPlaneMaintenance = new SpecFactoryControlPlaneMaintenance();
    const contextV4Repair = new ContextV4Backfill();
    const immutableArtifactGc = immutableArtifactStorage
      ? {
          cleaner: new ImmutableArtifactReachabilityGc(
            composeRepository,
            new ComposeUploads({ bucket: immutableArtifactStorage.bucket }),
          ),
          rootPrefix: immutableArtifactStorage.rootPrefix,
        }
      : null;
    const retentionCleaner = new ComposeRetentionCleaner(
      composeRepository,
      undefined,
      composeUploads,
    );
    const artifactGc = new ComposeArtifactGc(composeWorkspaceBase);
    const sourceDeletionCleaner = new ComposeSourceDeletionCleaner(
      composeRepository,
      composeUploads,
    );
    const llmAuditArtifactCleaner =
      process.env.SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE?.trim()
        ? new LlmAuditArtifactRetentionCleaner(
            new SpecFactoryLlmCallAuditRepository(),
            process.env.SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE.trim(),
          )
        : null;
    const retentionIntervalMs =
      resolveSpecFactoryRetentionPolicy().sweepIntervalMs;
    const runSourceDeletionSweep = (): void => {
      void (async () => {
        const policy = resolveSpecFactoryRetentionPolicy();
        if (policy.cleanupDryRun) return;
        const result =
          await sourceDeletionCleaner.cleanupExpiredSourceDeletions({
            limit: policy.sourceDeletionPurgeLimit,
          });
        if (result.inspected > 0 || result.failed > 0) {
          console.log(
            `[spec-factory] source deletion sweep: ${JSON.stringify(result)}`,
          );
        }
      })().catch((error) => {
        console.warn(
          `[spec-factory] source deletion sweep failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    };
    let retentionSweepRunning = false;
    const runRetentionSweep = (): void => {
      if (retentionSweepRunning) return;
      retentionSweepRunning = true;
      void (async () => {
        const retentionPolicy = resolveSpecFactoryRetentionPolicy();
        const retentionResult =
          await retentionCleaner.cleanupArchivedWorkspaces({
            olderThanDays: retentionPolicy.workspaceRetentionDays,
            limit: retentionPolicy.cleanupLimit,
            dryRun: retentionPolicy.cleanupDryRun,
            workerHeartbeatRetentionDays:
              retentionPolicy.workerHeartbeatRetentionDays,
            workerHeartbeatLimit: retentionPolicy.workerHeartbeatLimit,
          });
        const artifactResult = await artifactGc.cleanupTemporaryArtifacts({
          olderThanHours: retentionPolicy.tempArtifactRetentionHours,
          limit: retentionPolicy.tempArtifactLimit,
          maxDepth: retentionPolicy.tempArtifactMaxDepth,
          dryRun: retentionPolicy.cleanupDryRun,
        });
        const llmAuditArtifactResult = llmAuditArtifactCleaner
          ? await llmAuditArtifactCleaner.cleanupAuditArtifacts({
              olderThanDays: retentionPolicy.llmAuditArtifactRetentionDays,
              limit: retentionPolicy.llmAuditArtifactLimit,
              dryRun: retentionPolicy.cleanupDryRun,
            })
          : null;
        const controlPlaneResult = await controlPlaneMaintenance.run({
          limit: retentionPolicy.cleanupLimit,
          outboxRetentionDays: retentionPolicy.outboxRetentionDays,
          receiptRetentionDays: retentionPolicy.queueReceiptRetentionDays,
          strandedDispatchSeconds: retentionPolicy.strandedDispatchSeconds,
        });
        const strandedContextResult =
          await composeRepository.recoverStrandedContextMerges({
            limit: retentionPolicy.repairReconcileLimit,
          });
        const repairResult = await contextV4Repair.reconcile({
          limit: retentionPolicy.repairReconcileLimit,
        });
        const immutableArtifactResult = immutableArtifactGc
          ? await immutableArtifactGc.cleaner.cleanup({
              rootPrefix: immutableArtifactGc.rootPrefix,
              olderThanHours: retentionPolicy.immutableArtifactRetentionHours,
              limit: retentionPolicy.immutableArtifactGcLimit,
              dryRun: retentionPolicy.cleanupDryRun,
            })
          : null;

        if (
          retentionResult.cleaned > 0 ||
          retentionResult.failed > 0 ||
          retentionResult.wouldClean > 0 ||
          retentionResult.purgedStreamTokens > 0 ||
          retentionResult.purgedWorkerHeartbeats > 0 ||
          artifactResult.deletedArtifacts > 0 ||
          artifactResult.wouldDeleteArtifacts > 0 ||
          artifactResult.failed > 0 ||
          (llmAuditArtifactResult?.cleaned ?? 0) > 0 ||
          (llmAuditArtifactResult?.wouldClean ?? 0) > 0 ||
          (llmAuditArtifactResult?.failed ?? 0) > 0 ||
          controlPlaneResult.recoveredOutboxRows > 0 ||
          controlPlaneResult.requeuedStrandedDispatches > 0 ||
          controlPlaneResult.recoveredDraftStages > 0 ||
          controlPlaneResult.terminalDraftStages > 0 ||
          controlPlaneResult.recoveredQueueReceipts > 0 ||
          controlPlaneResult.purgedQueueReceipts > 0 ||
          controlPlaneResult.purgedOutboxRows > 0 ||
          strandedContextResult.inspected > 0 ||
          repairResult.inspected > 0 ||
          (immutableArtifactResult?.orphaned ?? 0) > 0 ||
          immutableArtifactResult?.referenceScanTruncated ||
          immutableArtifactResult?.truncated
        ) {
          console.log(
            `[spec-factory] compose retention sweep: ${JSON.stringify({
              dryRun: retentionResult.dryRun,
              inspected: retentionResult.inspected,
              cleaned: retentionResult.cleaned,
              wouldClean: retentionResult.wouldClean,
              failed: retentionResult.failed,
              deletedFiles: retentionResult.deletedFiles,
              deletedObjects: retentionResult.deletedObjects,
              purgedStreamTokens: retentionResult.purgedStreamTokens,
              purgedWorkerHeartbeats: retentionResult.purgedWorkerHeartbeats,
              tempArtifacts: {
                inspectedTmpDirs: artifactResult.inspectedTmpDirs,
                deletedArtifacts: artifactResult.deletedArtifacts,
                wouldDeleteArtifacts: artifactResult.wouldDeleteArtifacts,
                deletedBytes: artifactResult.deletedBytes,
                wouldDeleteBytes: artifactResult.wouldDeleteBytes,
                failed: artifactResult.failed,
              },
              llmAuditArtifacts: llmAuditArtifactResult
                ? {
                    inspected: llmAuditArtifactResult.inspected,
                    cleaned: llmAuditArtifactResult.cleaned,
                    wouldClean: llmAuditArtifactResult.wouldClean,
                    deletedArtifacts: llmAuditArtifactResult.deletedArtifacts,
                    failed: llmAuditArtifactResult.failed,
                    skippedUnsupported:
                      llmAuditArtifactResult.skippedUnsupported,
                  }
                : null,
              controlPlane: controlPlaneResult,
              strandedContextMerges: strandedContextResult,
              contextV4Repair: repairResult,
              immutableArtifacts: immutableArtifactResult,
            })}`,
          );
        }
      })()
        .catch((error) => {
          console.warn(
            `[spec-factory] compose retention sweep failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        })
        .finally(() => {
          retentionSweepRunning = false;
        });
    };
    const sourceDeletionSweepMs =
      resolveSpecFactoryRetentionPolicy().sourceDeletionSweepMs;
    scheduleSpecFactoryRetentionSweeps({
      runRetentionSweep,
      retentionIntervalMs,
      runSourceDeletionSweep,
      sourceDeletionSweepMs,
    });
  }

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  if (runtime.httpApi) {
    app.use("/api/spec-factory", createSpecFactoryRouter(service));
    app.use(
      "/api/spec-factory/compose",
      createComposeRouter(composeService, composeSseHub, {
        eventStore: composeRepository,
      }),
    );
  }

  return app;
}

export function assertSpecFactoryLegacyRemovalGates(
  runtime: SpecFactoryRuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.SPEC_FACTORY_LEGACY_RUNTIME?.trim().toLowerCase() !== "disabled") {
    return;
  }
  const failures: string[] = [];
  if (runtime.mode === "all-local" || runtime.mode === "worker") {
    failures.push("split_runtime_required");
  }
  if (!["on", "drain"].includes(env.SPEC_FACTORY_DURABLE_TURNS ?? "off")) {
    failures.push("durable_turns_required");
  }
  if (!booleanEnv(env.SPEC_FACTORY_OUTBOX_ENABLED)) {
    failures.push("outbox_required");
  }
  if (!booleanEnv(env.SPEC_FACTORY_DURABLE_EVENTS)) {
    failures.push("strict_durable_events_required");
  }
  if (env.SPEC_FACTORY_QUEUE_DISPATCH_MODE !== "primary") {
    failures.push("primary_sqs_dispatch_required");
  }
  if (env.SPEC_FACTORY_ARTIFACT_STORE !== "s3") {
    failures.push("immutable_s3_required");
  }
  if (!booleanEnv(env.SPEC_FACTORY_WORKSPACE_MANAGER)) {
    failures.push("workspace_manager_required");
  }
  for (const name of [
    "COMPOSE_WORKSPACE_BASE",
    "SPEC_FACTORY_TASK_WORKSPACE_BASE",
    "SPEC_FACTORY_EVIDENCE_WORKSPACE_BASE",
    "SPEC_FACTORY_WORKSPACE_BASE",
    "SPEC_FACTORY_WORKTREE_BASE",
    "SPEC_FACTORY_REPO_CACHE_BASE",
  ]) {
    const value = env[name]?.trim() ?? "";
    if (!value || value.startsWith("/mnt/efs/")) {
      failures.push(`${name.toLowerCase()}_must_be_task_local`);
    }
  }
  if (!env.SPEC_FACTORY_VALKEY_URL?.trim()) {
    failures.push("valkey_fanout_required");
  }
  if (!booleanEnv(env.SPEC_FACTORY_DRAFT_WORKFLOW_V2_ENABLED)) {
    failures.push("durable_draft_workflow_required");
  }
  if (!booleanEnv(env.SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED)) {
    failures.push("durable_handoff_required");
  }
  if (!booleanEnv(env.SPEC_FACTORY_IMAGE_PINNED)) {
    failures.push("immutable_image_digest_required");
  }
  if (!booleanEnv(env.SPEC_FACTORY_LLM_GATEWAY)) {
    failures.push("llm_gateway_required");
  }
  if (!booleanEnv(env.SPEC_FACTORY_CHAT_COORDINATOR)) {
    failures.push("chat_coordinator_required");
  }
  if (!booleanEnv(env.SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION)) {
    failures.push("context_distillation_required");
  }
  if (!booleanEnv(env.SPEC_FACTORY_ENABLE_CONTEXT_MERGE)) {
    failures.push("context_merge_required");
  }
  if (!/^sfv4-[a-f0-9]{64}$/.test(env.SPEC_FACTORY_CERTIFICATION_ID ?? "")) {
    failures.push("accepted_v4_certification_required");
  }
  if (!positiveEnv(env.SPEC_FACTORY_CONTEXT_V4_REPAIR_RUN_ID)) {
    failures.push("accepted_context_v4_repair_required");
  }
  if (!booleanEnv(env.COMPOSE_RETENTION_CLEANUP_ENABLED)) {
    failures.push("retention_worker_required");
  }
  if (booleanEnv(env.COMPOSE_CLEANUP_DRY_RUN)) {
    failures.push("retention_apply_mode_required");
  }
  if (!positiveEnv(env.SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD)) {
    failures.push("llm_session_budget_required");
  }
  if (!positiveEnv(env.SPEC_FACTORY_RESEARCH_COST_CEILING_USD)) {
    failures.push("research_session_budget_required");
  }
  for (const name of [
    "SPEC_FACTORY_TURN_QUEUE_URL",
    "SPEC_FACTORY_CONTEXT_QUEUE_URL",
    "SPEC_FACTORY_RESEARCH_QUEUE_URL",
    "SPEC_FACTORY_CONVERSION_QUEUE_URL",
    "SPEC_FACTORY_DRAFT_QUEUE_URL",
    "SPEC_FACTORY_EVENTS_QUEUE_URL",
  ]) {
    if (!env[name]?.trim()) failures.push(`${name.toLowerCase()}_required`);
  }
  if (failures.length > 0) {
    throw new Error(
      `legacy_runtime_removal_gates_failed:${failures.join(",")}`,
    );
  }
}

export async function assertSpecFactoryLegacyRemovalDatabaseGates(
  pool: Pick<mysql.Pool, "query">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (env.SPEC_FACTORY_LEGACY_RUNTIME?.trim().toLowerCase() !== "disabled") {
    return;
  }
  const repairRunId = Number(env.SPEC_FACTORY_CONTEXT_V4_REPAIR_RUN_ID);
  const [rows] = await pool.query<
    Array<
      mysql.RowDataPacket & {
        repair_accepted: number | string;
        unready_active_sessions: number | string;
        active_non_immutable_manifests: number | string;
        archived_workspaces_pending_cleanup: number | string;
      }
    >
  >(
    `SELECT
       EXISTS(
         SELECT 1
         FROM spec_factory_repair_runs
         WHERE id = ?
           AND repair_type = 'context_rebuild_v4'
           AND dry_run = FALSE
           AND status = 'completed'
           AND failed_count = 0
           AND accepted_at IS NOT NULL
       ) AS repair_accepted,
       (
         SELECT COUNT(*)
         FROM compose_sessions session
         WHERE session.status <> 'archived'
           AND (
             session.context_status <> 'clean'
             OR NOT EXISTS (
               SELECT 1
               FROM compose_context_versions context
               WHERE context.session_id = session.id
                 AND context.version = session.latest_context_version
                 AND context.schema_version = 4
                 AND context.status = 'committed'
             )
           )
       ) AS unready_active_sessions,
       (
         SELECT COUNT(*)
         FROM compose_sessions session
         LEFT JOIN compose_workspace_manifests manifest
           ON manifest.session_id = session.id
         WHERE session.status <> 'archived'
           AND (
             manifest.id IS NULL
             OR COALESCE(
               JSON_UNQUOTE(JSON_EXTRACT(manifest.manifest_json, '$.manifestVersion')),
               ''
             ) <> '2'
             OR COALESCE(
               JSON_TYPE(JSON_EXTRACT(manifest.manifest_json, '$.files')),
               ''
             ) <> 'ARRAY'
             OR EXISTS (
               SELECT 1
               FROM JSON_TABLE(
                 COALESCE(
                   JSON_EXTRACT(manifest.manifest_json, '$.files'),
                   JSON_ARRAY()
                 ),
                 '$[*]' COLUMNS(
                   artifact_uri TEXT PATH '$.artifactUri' NULL ON EMPTY
                 )
               ) manifest_file
               WHERE NULLIF(TRIM(manifest_file.artifact_uri), '') IS NULL
             )
           )
       ) AS active_non_immutable_manifests,
       (
         SELECT COUNT(*)
         FROM compose_sessions session
         WHERE session.status = 'archived'
           AND session.workspace_cleaned_at IS NULL
       ) AS archived_workspaces_pending_cleanup`,
    [repairRunId],
  );
  const repairAccepted = Number(rows[0]?.repair_accepted ?? 0) === 1;
  const unreadyActiveSessions = Number(
    rows[0]?.unready_active_sessions ?? Number.NaN,
  );
  const activeNonImmutableManifests = Number(
    rows[0]?.active_non_immutable_manifests ?? Number.NaN,
  );
  const archivedWorkspacesPendingCleanup = Number(
    rows[0]?.archived_workspaces_pending_cleanup ?? Number.NaN,
  );
  const failures: string[] = [];
  if (!repairAccepted) failures.push("context_v4_repair_not_accepted");
  if (!Number.isFinite(unreadyActiveSessions) || unreadyActiveSessions > 0) {
    failures.push(
      `active_contexts_not_v4:${Number.isFinite(unreadyActiveSessions) ? unreadyActiveSessions : "unknown"}`,
    );
  }
  if (
    !Number.isFinite(activeNonImmutableManifests) ||
    activeNonImmutableManifests > 0
  ) {
    failures.push(
      `active_artifact_manifests_not_immutable:${
        Number.isFinite(activeNonImmutableManifests)
          ? activeNonImmutableManifests
          : "unknown"
      }`,
    );
  }
  if (
    !Number.isFinite(archivedWorkspacesPendingCleanup) ||
    archivedWorkspacesPendingCleanup > 0
  ) {
    failures.push(
      `archived_workspaces_pending_cleanup:${
        Number.isFinite(archivedWorkspacesPendingCleanup)
          ? archivedWorkspacesPendingCleanup
          : "unknown"
      }`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `legacy_runtime_database_gates_failed:${failures.join(",")}`,
    );
  }
}

function positiveEnv(value: string | undefined): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}
