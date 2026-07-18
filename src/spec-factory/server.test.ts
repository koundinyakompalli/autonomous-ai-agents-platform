import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentTaskWorkerEnabled,
  assertAgentTaskCapabilitiesHaveExecutors,
  assertSpecFactoryLegacyRemovalGates,
  assertSpecFactoryLegacyRemovalDatabaseGates,
  chatCoordinatorEnabled,
  contextDistillationEnabled,
  contextMergeEnabled,
  createFindChildIssueByParentAndSummary,
  createSpecFactoryChatCoordinator,
  createSpecFactoryAgentTaskExecutorRegistry,
  durableEventsRequired,
  durableTurnWorkerEnabled,
  llmGatewayEnabled,
  mergeComposeRuntimeHealth,
  resolveComposeAgentTaskWorkerId,
  resolveComposeTurnWorkerId,
  resolveAgentTaskWorkerCapabilities,
  resolveImmutableArtifactStorageConfig,
  resolveRuntimeHeartbeatCapabilities,
  resolveSpecFactoryWorkerId,
  resolveSpecFactoryRuntime,
  runtimeRequiresJira,
  scheduleSpecFactoryRetentionSweeps,
  workerHeartbeatEnabled,
  workspaceManagerEnabled,
} from "./server.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("scheduleSpecFactoryRetentionSweeps", () => {
  it("runs both sweep classes at startup and registers their cadences", () => {
    const runRetentionSweep = vi.fn();
    const runSourceDeletionSweep = vi.fn();
    const unrefRetention = vi.fn();
    const unrefSourceDeletion = vi.fn();
    const registerInterval = vi
      .fn()
      .mockReturnValueOnce({ unref: unrefRetention })
      .mockReturnValueOnce({ unref: unrefSourceDeletion });

    scheduleSpecFactoryRetentionSweeps({
      runRetentionSweep,
      retentionIntervalMs: 21_600_000,
      runSourceDeletionSweep,
      sourceDeletionSweepMs: 60_000,
      registerInterval,
    });

    expect(registerInterval).toHaveBeenNthCalledWith(
      1,
      runRetentionSweep,
      21_600_000,
    );
    expect(registerInterval).toHaveBeenNthCalledWith(
      2,
      runSourceDeletionSweep,
      60_000,
    );
    expect(unrefRetention).toHaveBeenCalledOnce();
    expect(unrefSourceDeletion).toHaveBeenCalledOnce();
    expect(runRetentionSweep).toHaveBeenCalledOnce();
    expect(runSourceDeletionSweep).toHaveBeenCalledOnce();
  });
});

describe("resolveImmutableArtifactStorageConfig", () => {
  it("disables immutable S3 cleanup when EFS is canonical", () => {
    expect(
      resolveImmutableArtifactStorageConfig({
        SPEC_FACTORY_ARTIFACT_STORE: "efs",
        SPEC_FACTORY_ARTIFACT_PREFIX: "spec-factory",
      }),
    ).toBeNull();
  });

  it("scopes S3 cleanup to the immutable workspace subtree", () => {
    expect(
      resolveImmutableArtifactStorageConfig({
        SPEC_FACTORY_ARTIFACT_STORE: "S3",
        SPEC_FACTORY_ARTIFACT_BUCKET: "artifacts",
        SPEC_FACTORY_ARTIFACT_PREFIX: "spec-factory",
      }),
    ).toEqual({
      bucket: "artifacts",
      rootPrefix: "spec-factory/workspaces/",
    });
  });

  it("fails startup when S3 mode has no artifact bucket", () => {
    expect(() =>
      resolveImmutableArtifactStorageConfig({
        SPEC_FACTORY_ARTIFACT_STORE: "s3",
      }),
    ).toThrow("SPEC_FACTORY_ARTIFACT_BUCKET is required for Spec Factory");
  });
});

describe("durableTurnWorkerEnabled", () => {
  it("enables the durable turn worker only in drain and on modes", () => {
    expect(durableTurnWorkerEnabled("off")).toBe(false);
    expect(durableTurnWorkerEnabled("shadow")).toBe(false);
    expect(durableTurnWorkerEnabled("drain")).toBe(true);
    expect(durableTurnWorkerEnabled("on")).toBe(true);
    expect(durableTurnWorkerEnabled(undefined)).toBe(false);
  });
});

describe("assertSpecFactoryLegacyRemovalGates", () => {
  const certifiedEnv = {
    SPEC_FACTORY_LEGACY_RUNTIME: "disabled",
    SPEC_FACTORY_DURABLE_TURNS: "on",
    SPEC_FACTORY_OUTBOX_ENABLED: "true",
    SPEC_FACTORY_DURABLE_EVENTS: "true",
    SPEC_FACTORY_QUEUE_DISPATCH_MODE: "primary",
    SPEC_FACTORY_ARTIFACT_STORE: "s3",
    SPEC_FACTORY_WORKSPACE_MANAGER: "true",
    COMPOSE_WORKSPACE_BASE: "/var/lib/spec-factory/compose",
    SPEC_FACTORY_TASK_WORKSPACE_BASE: "/var/lib/spec-factory/tasks",
    SPEC_FACTORY_EVIDENCE_WORKSPACE_BASE:
      "/var/lib/spec-factory/evidence-workspaces",
    SPEC_FACTORY_WORKSPACE_BASE: "/var/lib/spec-factory/repo-workspaces",
    SPEC_FACTORY_WORKTREE_BASE: "/var/lib/spec-factory/worktrees",
    SPEC_FACTORY_REPO_CACHE_BASE: "/var/lib/spec-factory/repo-cache",
    SPEC_FACTORY_VALKEY_URL: "rediss://valkey:6379",
    SPEC_FACTORY_DRAFT_WORKFLOW_V2_ENABLED: "true",
    SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED: "true",
    SPEC_FACTORY_IMAGE_PINNED: "true",
    SPEC_FACTORY_LLM_GATEWAY: "true",
    SPEC_FACTORY_CHAT_COORDINATOR: "true",
    SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION: "true",
    SPEC_FACTORY_ENABLE_CONTEXT_MERGE: "true",
    SPEC_FACTORY_CERTIFICATION_ID: `sfv4-${"a".repeat(64)}`,
    SPEC_FACTORY_CONTEXT_V4_REPAIR_RUN_ID: "9",
    COMPOSE_RETENTION_CLEANUP_ENABLED: "true",
    COMPOSE_CLEANUP_DRY_RUN: "false",
    SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD: "10",
    SPEC_FACTORY_RESEARCH_COST_CEILING_USD: "25",
    SPEC_FACTORY_TURN_QUEUE_URL: "https://sqs/turn",
    SPEC_FACTORY_CONTEXT_QUEUE_URL: "https://sqs/context",
    SPEC_FACTORY_RESEARCH_QUEUE_URL: "https://sqs/research",
    SPEC_FACTORY_CONVERSION_QUEUE_URL: "https://sqs/conversion",
    SPEC_FACTORY_DRAFT_QUEUE_URL: "https://sqs/draft",
    SPEC_FACTORY_EVENTS_QUEUE_URL: "https://sqs/events",
  } as NodeJS.ProcessEnv;

  it("accepts only a certified, durable, budgeted split runtime", () => {
    const runtime = resolveSpecFactoryRuntime({
      mode: "api",
      splitRuntimeAllowed: "true",
    });
    expect(() =>
      assertSpecFactoryLegacyRemovalGates(runtime, certifiedEnv),
    ).not.toThrow();
  });

  it("fails closed when certification or strict durable events are absent", () => {
    const runtime = resolveSpecFactoryRuntime({
      mode: "api",
      splitRuntimeAllowed: "true",
    });
    expect(() =>
      assertSpecFactoryLegacyRemovalGates(runtime, {
        ...certifiedEnv,
        SPEC_FACTORY_CERTIFICATION_ID: "",
        SPEC_FACTORY_DURABLE_EVENTS: "false",
      }),
    ).toThrow(
      "legacy_runtime_removal_gates_failed:strict_durable_events_required,accepted_v4_certification_required",
    );
  });

  it("verifies the accepted repair row and every active context in MySQL", async () => {
    const query = vi.fn().mockResolvedValue([
      [
        {
          repair_accepted: 1,
          unready_active_sessions: 0,
          active_non_immutable_manifests: 0,
          archived_workspaces_pending_cleanup: 0,
        },
      ],
    ]);
    await expect(
      assertSpecFactoryLegacyRemovalDatabaseGates(
        { query } as never,
        certifiedEnv,
      ),
    ).resolves.toBeUndefined();
    expect(query.mock.calls[0][1]).toEqual([9]);

    query.mockResolvedValueOnce([
      [
        {
          repair_accepted: 0,
          unready_active_sessions: 2,
          active_non_immutable_manifests: 3,
          archived_workspaces_pending_cleanup: 4,
        },
      ],
    ]);
    await expect(
      assertSpecFactoryLegacyRemovalDatabaseGates(
        { query } as never,
        certifiedEnv,
      ),
    ).rejects.toThrow(
      "legacy_runtime_database_gates_failed:context_v4_repair_not_accepted,active_contexts_not_v4:2,active_artifact_manifests_not_immutable:3,archived_workspaces_pending_cleanup:4",
    );
  });
});

describe("durableEventsRequired", () => {
  it("requires durable event ids only for explicit truthy values", () => {
    expect(durableEventsRequired("true")).toBe(true);
    expect(durableEventsRequired("1")).toBe(true);
    expect(durableEventsRequired("yes")).toBe(true);
    expect(durableEventsRequired("false")).toBe(false);
    expect(durableEventsRequired(undefined)).toBe(false);
  });
});

describe("agentTaskWorkerEnabled", () => {
  it("enables the agent task worker only for explicit truthy values", () => {
    expect(agentTaskWorkerEnabled("true")).toBe(true);
    expect(agentTaskWorkerEnabled("1")).toBe(true);
    expect(agentTaskWorkerEnabled("yes")).toBe(true);
    expect(agentTaskWorkerEnabled("false")).toBe(false);
    expect(agentTaskWorkerEnabled(undefined)).toBe(false);
  });

  it("honors the documented SPEC_FACTORY_AGENT_TASKS alias", () => {
    vi.stubEnv("SPEC_FACTORY_AGENT_TASKS", "true");

    expect(agentTaskWorkerEnabled()).toBe(true);
  });
});

describe("workspaceManagerEnabled", () => {
  it("enables workspace-managed runtime split only for truthy values", () => {
    expect(workspaceManagerEnabled("true")).toBe(true);
    expect(workspaceManagerEnabled("1")).toBe(true);
    expect(workspaceManagerEnabled("yes")).toBe(true);
    expect(workspaceManagerEnabled("false")).toBe(false);
    expect(workspaceManagerEnabled(undefined)).toBe(false);
  });
});

describe("workerHeartbeatEnabled", () => {
  it("enables heartbeat for split modes and keeps all-local opt-in", () => {
    expect(workerHeartbeatEnabled({ mode: "worker" }, undefined)).toBe(true);
    expect(workerHeartbeatEnabled({ mode: "api" }, "false")).toBe(true);
    expect(workerHeartbeatEnabled({ mode: "all-local" }, undefined)).toBe(
      false,
    );
    expect(workerHeartbeatEnabled({ mode: "all-local" }, "true")).toBe(true);
  });
});

describe("runtimeRequiresJira", () => {
  it("keeps Jira credentials out of capability workers that never publish", () => {
    const runtime = (
      mode: Parameters<typeof resolveSpecFactoryRuntime>[0]["mode"],
    ) =>
      resolveSpecFactoryRuntime({
        mode,
        splitRuntimeAllowed: "true",
        workspaceManager: "true",
      });
    expect(runtimeRequiresJira(runtime("api"))).toBe(true);
    expect(runtimeRequiresJira(runtime("draft-worker"))).toBe(true);
    expect(runtimeRequiresJira(runtime("context-worker"))).toBe(false);
    expect(runtimeRequiresJira(runtime("research-worker"))).toBe(false);
    expect(runtimeRequiresJira(runtime("conversion-worker"))).toBe(false);
    expect(runtimeRequiresJira(runtime("relay-worker"))).toBe(false);
    expect(runtimeRequiresJira(runtime("retention-worker"))).toBe(false);
  });
});

describe("resolveSpecFactoryWorkerId", () => {
  it("uses the configured worker id or a stable process fallback", () => {
    expect(
      resolveSpecFactoryWorkerId("worker", {
        SPEC_FACTORY_WORKER_ID: "worker-a",
      } as NodeJS.ProcessEnv),
    ).toBe("worker-a");
    expect(resolveSpecFactoryWorkerId("research-worker", {})).toMatch(
      /^spec-factory-research-worker-\d+$/,
    );
  });
});

describe("compose worker id resolution", () => {
  it("derives turn and agent-task worker ids from the hostname-aware runtime worker id", () => {
    const env = {
      HOSTNAME: "ecs-task-abc",
    } as NodeJS.ProcessEnv;

    expect(resolveComposeTurnWorkerId("worker", env)).toBe(
      "spec-factory-worker-ecs-task-abc:turn",
    );
    expect(resolveComposeAgentTaskWorkerId("research-worker", env)).toBe(
      "spec-factory-research-worker-ecs-task-abc:agent-task",
    );
  });

  it("keeps explicit turn and agent-task worker id overrides", () => {
    const env = {
      SPEC_FACTORY_TURN_WORKER_ID: "turn-worker-a",
      SPEC_FACTORY_AGENT_TASK_WORKER_ID: "agent-worker-a",
      HOSTNAME: "ecs-task-abc",
    } as NodeJS.ProcessEnv;

    expect(resolveComposeTurnWorkerId("worker", env)).toBe("turn-worker-a");
    expect(resolveComposeAgentTaskWorkerId("worker", env)).toBe(
      "agent-worker-a",
    );
  });

  it("caps explicit turn and agent-task worker ids to the DB column width", () => {
    const longId = "x".repeat(200);
    const env = {
      SPEC_FACTORY_TURN_WORKER_ID: longId,
      SPEC_FACTORY_AGENT_TASK_WORKER_ID: longId,
    } as NodeJS.ProcessEnv;

    expect(resolveComposeTurnWorkerId("worker", env)).toHaveLength(128);
    expect(resolveComposeAgentTaskWorkerId("worker", env)).toHaveLength(128);
  });
});

describe("llmGatewayEnabled", () => {
  it("enables the LLM gateway only for explicit truthy values", () => {
    expect(llmGatewayEnabled("true")).toBe(true);
    expect(llmGatewayEnabled("1")).toBe(true);
    expect(llmGatewayEnabled("yes")).toBe(true);
    expect(llmGatewayEnabled("false")).toBe(false);
    expect(llmGatewayEnabled(undefined)).toBe(false);
  });
});

describe("chatCoordinatorEnabled", () => {
  it("enables the chat coordinator only for explicit truthy values", () => {
    expect(chatCoordinatorEnabled("true")).toBe(true);
    expect(chatCoordinatorEnabled("1")).toBe(true);
    expect(chatCoordinatorEnabled("yes")).toBe(true);
    expect(chatCoordinatorEnabled("false")).toBe(false);
    expect(chatCoordinatorEnabled(undefined)).toBe(false);
  });
});

describe("mergeComposeRuntimeHealth", () => {
  it("overlays per-replica legacy queue state without mutating durable DB health", () => {
    const base = {
      turns: {
        byStatus: {
          queued: 4,
          running: 2,
          waiting_on_research: 0,
          awaiting_user_input: 0,
          synthesizing: 0,
          completed: 10,
          failed: 0,
          cancelled: 0,
          abandoned: 1,
        },
        durableQueued: 4,
        durableRunning: 2,
        durableAbandoned: 1,
        legacyInflight: 0,
        legacyQueued: 0,
        leaseExpired: 0,
        leaseFenceRejected: 0,
        oldestQueuedAt: "2026-06-08T13:44:00.000Z",
        oldestRunningAt: "2026-06-08T13:41:00.000Z",
      },
      agentTasks: {
        byStatus: {
          queued: 0,
          running: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          abandoned: 0,
        },
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        abandoned: 0,
        leaseExpired: 0,
        leaseFenceRejected: 0,
        oldestQueuedAt: null,
        oldestRunningAt: null,
      },
      llm: {
        callsToday: 3,
        failedToday: 1,
        inputTokensToday: 100,
        outputTokensToday: 50,
        estimatedCostUsdToday: 0.25,
        latestCallAt: "2026-06-08T13:49:00.000Z",
      },
      workers: {
        total: 1,
        live: 1,
        stale: 0,
        byMode: {
          "all-local": {
            total: 0,
            live: 0,
            stale: 0,
            latestHeartbeatAt: null,
          },
          api: { total: 0, live: 0, stale: 0, latestHeartbeatAt: null },
          worker: {
            total: 1,
            live: 1,
            stale: 0,
            latestHeartbeatAt: "2026-06-08T13:48:00.000Z",
          },
          "research-worker": {
            total: 0,
            live: 0,
            stale: 0,
            latestHeartbeatAt: null,
          },
          "conversion-worker": {
            total: 0,
            live: 0,
            stale: 0,
            latestHeartbeatAt: null,
          },
        },
      },
      events: {
        durablePublishedToday: 10,
        durablePersistFailuresToday: 0,
        payloadTooLargeToday: 0,
        liveDeliveredByThisReplica: 0,
        replayedByThisReplica: 0,
        latestPublishedAt: "2026-06-08T13:50:00.000Z",
        latestDurableErrorAt: null,
      },
      streams: {
        activeSubscribers: 0,
        activeSessions: 0,
        connectedByThisReplica: 0,
        disconnectedByThisReplica: 0,
      },
    };

    const merged = mergeComposeRuntimeHealth(base, {
      legacyInflight: 2,
      legacyQueued: 1,
      sse: {
        liveDeliveredByThisReplica: 8,
        replayedByThisReplica: 3,
        activeSubscribers: 4,
        activeSessions: 2,
        connectedByThisReplica: 9,
        disconnectedByThisReplica: 5,
      },
    });

    expect(merged.turns).toMatchObject({
      durableQueued: 4,
      durableRunning: 2,
      legacyInflight: 2,
      legacyQueued: 1,
    });
    expect(merged.llm).toEqual(base.llm);
    expect(merged.workers).toEqual(base.workers);
    expect(merged.events).toMatchObject({
      durablePublishedToday: 10,
      liveDeliveredByThisReplica: 8,
      replayedByThisReplica: 3,
    });
    expect(merged.streams).toEqual({
      activeSubscribers: 4,
      activeSessions: 2,
      connectedByThisReplica: 9,
      disconnectedByThisReplica: 5,
    });
    expect(base.turns.legacyInflight).toBe(0);
    expect(base.turns.legacyQueued).toBe(0);
    expect(base.events.liveDeliveredByThisReplica).toBe(0);
    expect(base.streams.activeSubscribers).toBe(0);
  });
});

describe("resolveAgentTaskWorkerCapabilities", () => {
  it("keeps context merge out of default worker capabilities until enabled", () => {
    expect(resolveAgentTaskWorkerCapabilities(undefined)).toEqual([
      "source_distillation",
    ]);
  });

  it("includes context merge by default when enabled", () => {
    vi.stubEnv("SPEC_FACTORY_ENABLE_CONTEXT_MERGE", "true");

    expect(resolveAgentTaskWorkerCapabilities(undefined)).toEqual([
      "source_distillation",
      "context_merge",
    ]);
  });

  it("parses comma-separated capability overrides", () => {
    expect(
      resolveAgentTaskWorkerCapabilities("source_distillation, context_merge "),
    ).toEqual(["source_distillation", "context_merge"]);
  });

  it("includes all research capabilities by default when the research executor is enabled", () => {
    vi.stubEnv("SPEC_FACTORY_RESEARCH_EXECUTOR", "claude_agent_sdk");

    expect(resolveAgentTaskWorkerCapabilities(undefined)).toEqual([
      "source_distillation",
      "code_research",
      "config_research",
      "devops_research",
    ]);
  });
});

describe("contextDistillationEnabled", () => {
  it("enables source conversion distillation only for explicit truthy values", () => {
    expect(contextDistillationEnabled("true")).toBe(true);
    expect(contextDistillationEnabled("1")).toBe(true);
    expect(contextDistillationEnabled("yes")).toBe(true);
    expect(contextDistillationEnabled("false")).toBe(false);
    expect(contextDistillationEnabled(undefined)).toBe(false);
  });
});

describe("contextMergeEnabled", () => {
  it("enables context merge only for explicit truthy values", () => {
    expect(contextMergeEnabled("true")).toBe(true);
    expect(contextMergeEnabled("1")).toBe(true);
    expect(contextMergeEnabled("yes")).toBe(true);
    expect(contextMergeEnabled("false")).toBe(false);
    expect(contextMergeEnabled(undefined)).toBe(false);
  });
});

describe("createSpecFactoryChatCoordinator", () => {
  it("keeps the coordinator dormant by default", () => {
    const createLlmGateway = vi.fn();

    expect(
      createSpecFactoryChatCoordinator({
        env: {},
        createLlmGateway,
      }),
    ).toBeNull();
    expect(createLlmGateway).not.toHaveBeenCalled();
  });

  it("requires both the LLM gateway and coordinator flags", () => {
    const createLlmGateway = vi.fn();

    expect(
      createSpecFactoryChatCoordinator({
        env: {
          SPEC_FACTORY_LLM_GATEWAY: "true",
          SPEC_FACTORY_CHAT_COORDINATOR: "false",
        },
        createLlmGateway,
      }),
    ).toBeNull();
    expect(
      createSpecFactoryChatCoordinator({
        env: {
          SPEC_FACTORY_LLM_GATEWAY: "false",
          SPEC_FACTORY_CHAT_COORDINATOR: "true",
        },
        createLlmGateway,
      }),
    ).toBeNull();
    expect(createLlmGateway).not.toHaveBeenCalled();
  });

  it("creates a coordinator with the configured fanout cap when both flags are on", async () => {
    const llmGateway = {
      generateObject: vi.fn().mockResolvedValue({
        action: "dispatch_research",
        userVisibleStatus: "Checking implementation details",
        synthesisInstructions: "Return file-backed evidence.",
        researchTasks: [
          {
            capability: "code_research",
            question: "Where is retry implemented?",
            requiredEvidence: true,
            maxCostUsd: 1,
          },
          {
            capability: "config_research",
            question: "Which flag enables it?",
            requiredEvidence: true,
            maxCostUsd: 1,
          },
        ],
      }),
    };
    const createLlmGateway = vi.fn(() => llmGateway);

    const coordinator = createSpecFactoryChatCoordinator({
      env: {
        SPEC_FACTORY_LLM_GATEWAY: "true",
        SPEC_FACTORY_CHAT_COORDINATOR: "true",
        SPEC_FACTORY_COORDINATOR_MAX_TASKS_PER_TURN: "1",
        SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD: "10.00",
      },
      createLlmGateway,
    });

    expect(coordinator).not.toBeNull();
    expect(createLlmGateway).toHaveBeenCalledTimes(1);
    await expect(
      coordinator!.decide({
        sessionId: 7,
        userMessage: "Where is retry implemented?",
        requestedContextVersion: 4,
        contextVersionUsed: 4,
        recentMessages: [],
        sourceStatus: {
          total: 0,
          byKind: {},
          byConversionStatus: {},
          convertedSourceIds: [],
          failedSourceIds: [],
          generatedResearchSourceIds: [],
        },
        pendingTasks: [],
        capabilities: [],
      }),
    ).rejects.toThrow("coordinator_decision_rejected:max_research_tasks");
    const coordinatorRequest = llmGateway.generateObject.mock.calls[0]?.[0];
    expect(coordinatorRequest?.maxCostUsd).toBe(0.25);
  });
});

describe("resolveSpecFactoryRuntime", () => {
  it("resolves a stable worker id from explicit env or container hostname", () => {
    expect(
      resolveSpecFactoryWorkerId("worker", {
        SPEC_FACTORY_WORKER_ID: "ecs-task-123",
        HOSTNAME: "container-a",
      } as NodeJS.ProcessEnv),
    ).toBe("ecs-task-123");
    expect(
      resolveSpecFactoryWorkerId("research-worker", {
        HOSTNAME: "container-a",
      } as NodeJS.ProcessEnv),
    ).toBe("spec-factory-research-worker-container-a");
  });

  it("defaults to all-local with local processors enabled", () => {
    expect(
      resolveSpecFactoryRuntime({
        durableTurns: "drain",
        retentionCleanup: "true",
        agentTaskWorker: "false",
      }),
    ).toEqual({
      mode: "all-local",
      httpApi: true,
      sseHeartbeat: true,
      specProcessing: true,
      composeConversion: true,
      composeTurnWorker: true,
      composeAgentTaskWorker: false,
      outboxRelay: false,
      retentionCleanup: true,
    });
  });

  it("enables the all-local agent task worker only behind its flag", () => {
    expect(
      resolveSpecFactoryRuntime({
        agentTaskWorker: "true",
      }),
    ).toMatchObject({
      mode: "all-local",
      composeAgentTaskWorker: true,
    });
  });

  it("uses SPEC_FACTORY_AGENT_TASKS as the worker enablement alias", () => {
    vi.stubEnv("SPEC_FACTORY_AGENT_TASKS", "true");

    expect(resolveSpecFactoryRuntime()).toMatchObject({
      mode: "all-local",
      composeAgentTaskWorker: true,
    });
  });

  it("rejects split runtime modes until workspace manager or compatibility override is enabled", () => {
    expect(() =>
      resolveSpecFactoryRuntime({
        mode: "worker",
        splitRuntimeAllowed: "false",
        workspaceManager: "false",
      }),
    ).toThrow(/SPEC_FACTORY_WORKSPACE_MANAGER=true/);
  });

  it("runs API mode without local processors when workspace manager is enabled", () => {
    expect(
      resolveSpecFactoryRuntime({
        mode: "api",
        workspaceManager: "true",
        durableTurns: "on",
        retentionCleanup: "true",
        agentTaskWorker: "true",
      }),
    ).toEqual({
      mode: "api",
      httpApi: true,
      sseHeartbeat: true,
      specProcessing: false,
      composeConversion: false,
      composeTurnWorker: false,
      composeAgentTaskWorker: false,
      outboxRelay: false,
      retentionCleanup: false,
    });
  });

  it("still accepts the legacy split-runtime compatibility override", () => {
    expect(
      resolveSpecFactoryRuntime({
        mode: "api",
        splitRuntimeAllowed: "true",
        workspaceManager: "false",
      }),
    ).toMatchObject({
      mode: "api",
      httpApi: true,
      composeTurnWorker: false,
    });
  });

  it("runs worker mode with durable turn, agent task, and retention processors", () => {
    expect(
      resolveSpecFactoryRuntime({
        mode: "worker",
        workspaceManager: "true",
        durableTurns: "on",
        retentionCleanup: "true",
        agentTaskWorker: "true",
      }),
    ).toEqual({
      mode: "worker",
      httpApi: false,
      sseHeartbeat: false,
      specProcessing: true,
      composeConversion: false,
      composeTurnWorker: true,
      composeAgentTaskWorker: true,
      outboxRelay: false,
      retentionCleanup: true,
    });
  });

  it("runs conversion-worker mode with only conversion processing", () => {
    expect(
      resolveSpecFactoryRuntime({
        mode: "conversion-worker",
        workspaceManager: "true",
        durableTurns: "on",
        retentionCleanup: "true",
        agentTaskWorker: "true",
      }),
    ).toEqual({
      mode: "conversion-worker",
      httpApi: false,
      sseHeartbeat: false,
      specProcessing: false,
      composeConversion: true,
      composeTurnWorker: false,
      composeAgentTaskWorker: false,
      outboxRelay: false,
      retentionCleanup: false,
    });
  });

  it("runs research-worker mode with the agent task worker when enabled", () => {
    expect(
      resolveSpecFactoryRuntime({
        mode: "research-worker",
        workspaceManager: "true",
        agentTaskWorker: "true",
      }),
    ).toEqual({
      mode: "research-worker",
      httpApi: false,
      sseHeartbeat: false,
      specProcessing: false,
      composeConversion: false,
      composeTurnWorker: false,
      composeAgentTaskWorker: true,
      outboxRelay: false,
      retentionCleanup: false,
    });
  });

  it("keeps context agent tasks separate from durable draft stages", () => {
    expect(
      resolveSpecFactoryRuntime({
        mode: "context-worker",
        workspaceManager: "true",
        agentTaskWorker: "true",
      }),
    ).toMatchObject({
      specProcessing: false,
      composeAgentTaskWorker: true,
    });
    expect(
      resolveSpecFactoryRuntime({
        mode: "draft-worker",
        workspaceManager: "true",
        agentTaskWorker: "true",
      }),
    ).toMatchObject({
      specProcessing: true,
      composeAgentTaskWorker: false,
    });
  });

  it("isolates turn and relay execution into dedicated runtime modes", () => {
    expect(
      resolveSpecFactoryRuntime({
        mode: "turn-worker",
        workspaceManager: "true",
        durableTurns: "on",
      }),
    ).toMatchObject({
      httpApi: false,
      composeTurnWorker: true,
      composeAgentTaskWorker: false,
      outboxRelay: false,
    });
    expect(
      resolveSpecFactoryRuntime({
        mode: "relay-worker",
        workspaceManager: "true",
      }),
    ).toMatchObject({
      httpApi: false,
      composeTurnWorker: false,
      composeAgentTaskWorker: false,
      outboxRelay: true,
    });
  });

  it("describes runtime heartbeat capabilities from enabled processors", () => {
    const runtime = resolveSpecFactoryRuntime({
      mode: "worker",
      workspaceManager: "true",
      durableTurns: "on",
      retentionCleanup: "true",
      agentTaskWorker: "true",
    });

    expect(
      resolveRuntimeHeartbeatCapabilities(runtime, [
        "source_distillation",
        "context_merge",
      ]),
    ).toEqual([
      "agent_task:context_merge",
      "agent_task:source_distillation",
      "durable_turn_worker",
      "retention_cleanup",
      "spec_processing",
    ]);
  });
});

describe("createSpecFactoryAgentTaskExecutorRegistry", () => {
  it("keeps research executors out of the registry by default", () => {
    const registry = createSpecFactoryAgentTaskExecutorRegistry({
      repository: {} as never,
      workspace: {} as never,
      researchExecutorMode: "none",
      researchRunner: { run: vi.fn() },
    });

    expect(registry.listExecutorTypes()).toEqual([
      "source_distillation",
      "context_merge",
    ]);
  });

  it("honors the injected env when enabling research executors", () => {
    const registry = createSpecFactoryAgentTaskExecutorRegistry({
      repository: {} as never,
      workspace: {} as never,
      researchRunner: { run: vi.fn() },
      env: {
        SPEC_FACTORY_RESEARCH_EXECUTOR: "claude_agent_sdk",
        SPEC_FACTORY_RESEARCH_ALLOWED_TOOLS: "Read,rg,Glob",
      },
    });

    expect(registry.listExecutorTypes()).toEqual([
      "source_distillation",
      "context_merge",
      "code_research",
    ]);
  });

  it("keeps aggregate research cost ceilings separate from per-task executor budgets", async () => {
    const repository = {
      getSession: vi.fn().mockResolvedValue({
        id: 7,
        workspacePath: "/workspace/session-7",
        status: "draft",
        latestContextVersion: 4,
      }),
      confirmAgentTaskLease: vi.fn().mockResolvedValue(true),
      getGeneratedResearchSourceByTaskId: vi.fn().mockResolvedValue(null),
      createGeneratedResearchSource: vi.fn().mockResolvedValue(42),
      createAgentTask: vi.fn().mockResolvedValue(88),
      appendSessionEvent: vi.fn().mockResolvedValue({ id: 9001 }),
    };
    const workspace = {
      writeArtifact: vi.fn().mockResolvedValue({
        artifactUri: "file:///workspace/session-7/generated/research/task.md",
        relativePath: "generated/research/task.md",
        bytes: 128,
        sha256: "a".repeat(64),
      }),
    };
    const researchRunner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n\nRetry handling lives in compose-database.ts.",
        evidence: [],
        confidence: "high",
      }),
    };
    const registry = createSpecFactoryAgentTaskExecutorRegistry({
      repository: repository as never,
      workspace: workspace as never,
      researchRunner,
      env: {
        SPEC_FACTORY_RESEARCH_EXECUTOR: "claude_agent_sdk",
        SPEC_FACTORY_RESEARCH_COST_CEILING_USD: "25",
      },
    });

    await registry.get("code_research").execute({
      id: 501,
      sessionId: 7,
      turnJobId: 101,
      capability: "code_research",
      executorType: "code_research",
      status: "running",
      input: {
        question: "Where is retry implemented?",
        contextVersionUsed: 4,
      },
      leaseGeneration: 2,
      activeWorkerId: "agent-worker-a",
    });

    expect(researchRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        maxCostUsd: 3,
      }),
    );
  });

  it("adds code_research only when the research executor is enabled", () => {
    const registry = createSpecFactoryAgentTaskExecutorRegistry({
      repository: {} as never,
      workspace: {} as never,
      researchExecutorMode: "claude_agent_sdk",
      researchRunner: { run: vi.fn() },
    });

    expect(registry.listExecutorTypes()).toEqual([
      "source_distillation",
      "context_merge",
      "code_research",
    ]);
  });

  it("adds critic_review when critic scheduling and LLM gateway are enabled", () => {
    const registry = createSpecFactoryAgentTaskExecutorRegistry({
      repository: {} as never,
      workspace: {} as never,
      researchExecutorMode: "none",
      llmGateway: { generateObject: vi.fn() },
      env: {
        SPEC_FACTORY_ENABLE_CRITIC: "true",
        SPEC_FACTORY_LLM_GATEWAY: "true",
      },
    });

    expect(registry.listExecutorTypes()).toEqual([
      "source_distillation",
      "context_merge",
      "critic_review",
    ]);
  });

  it("adds critic_review when the worker claims its capability", () => {
    const registry = createSpecFactoryAgentTaskExecutorRegistry({
      repository: {} as never,
      workspace: {} as never,
      researchExecutorMode: "none",
      llmGateway: { generateObject: vi.fn() },
      agentTaskCapabilities: ["source_distillation", "critic_review"],
      env: {
        SPEC_FACTORY_ENABLE_CRITIC: "false",
        SPEC_FACTORY_LLM_GATEWAY: "true",
      },
    });

    expect(registry.listExecutorTypes()).toEqual([
      "source_distillation",
      "context_merge",
      "critic_review",
    ]);
  });

  it("passes the LLM gateway to source distillation when LLM distillation is enabled", () => {
    const llmGateway = { generateObject: vi.fn() };
    const registry = createSpecFactoryAgentTaskExecutorRegistry({
      repository: {} as never,
      workspace: {} as never,
      researchExecutorMode: "none",
      llmGateway,
      env: {
        SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM: "true",
        SPEC_FACTORY_LLM_GATEWAY: "true",
      },
    });

    expect(registry.listExecutorTypes()).toEqual([
      "source_distillation",
      "context_merge",
    ]);
    expect(registry.get("source_distillation")).toMatchObject({
      executorType: "source_distillation",
    });
  });

  it("rejects LLM source distillation when the LLM gateway flag is off", () => {
    expect(() =>
      createSpecFactoryAgentTaskExecutorRegistry({
        repository: {} as never,
        workspace: {} as never,
        researchExecutorMode: "none",
        llmGateway: { generateObject: vi.fn() },
        env: {
          SPEC_FACTORY_ENABLE_CONTEXT_DISTILLATION_LLM: "true",
          SPEC_FACTORY_LLM_GATEWAY: "false",
        },
      }),
    ).toThrow("context_distillation_llm_requires_llm_gateway");
  });

  it("rejects LLM context merge when the LLM gateway flag is off", () => {
    expect(() =>
      createSpecFactoryAgentTaskExecutorRegistry({
        repository: {} as never,
        workspace: {} as never,
        researchExecutorMode: "none",
        llmGateway: { generateObject: vi.fn() },
        env: {
          SPEC_FACTORY_ENABLE_CONTEXT_MERGE_LLM: "true",
          SPEC_FACTORY_LLM_GATEWAY: "false",
        },
      }),
    ).toThrow("context_merge_llm_requires_llm_gateway");
  });

  it("adds handoff_build when queued handoff routing is enabled", () => {
    const registry = createSpecFactoryAgentTaskExecutorRegistry({
      repository: {} as never,
      workspace: {} as never,
      researchExecutorMode: "none",
      specRepository: {} as never,
      draftRequester: {} as never,
      env: {
        SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED: "true",
      },
    });

    expect(registry.listExecutorTypes()).toEqual([
      "source_distillation",
      "context_merge",
      "handoff_build",
    ]);
  });

  it("adds handoff_build when the worker claims its capability", () => {
    const registry = createSpecFactoryAgentTaskExecutorRegistry({
      repository: {} as never,
      workspace: {} as never,
      researchExecutorMode: "none",
      specRepository: {} as never,
      draftRequester: {} as never,
      agentTaskCapabilities: ["source_distillation", "handoff_build"],
      env: {
        SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED: "false",
      },
    });

    expect(registry.listExecutorTypes()).toEqual([
      "source_distillation",
      "context_merge",
      "handoff_build",
    ]);
  });

  it("fails startup validation when a claimed capability has no executor", () => {
    const registry = createSpecFactoryAgentTaskExecutorRegistry({
      repository: {} as never,
      workspace: {} as never,
      researchExecutorMode: "none",
    });

    expect(() =>
      assertAgentTaskCapabilitiesHaveExecutors(
        ["source_distillation", "handoff_build"],
        registry,
      ),
    ).toThrow(
      "agent_task_capability_missing_executor:handoff_build->handoff_build",
    );
  });

  it("maps research capabilities to their shared code_research executor", () => {
    const registry = createSpecFactoryAgentTaskExecutorRegistry({
      repository: {} as never,
      workspace: {} as never,
      researchExecutorMode: "claude_agent_sdk",
      researchRunner: { run: vi.fn() },
    });

    expect(() =>
      assertAgentTaskCapabilitiesHaveExecutors(
        ["code_research", "config_research", "devops_research"],
        registry,
      ),
    ).not.toThrow();
  });

  it("rejects queued handoff registry config without handoff dependencies", () => {
    expect(() =>
      createSpecFactoryAgentTaskExecutorRegistry({
        repository: {} as never,
        workspace: {} as never,
        researchExecutorMode: "none",
        env: {
          SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED: "true",
        },
      }),
    ).toThrow("handoff_build_requires_dependencies");
  });

  it("rejects handoff LLM synthesis when the LLM gateway flag is off", () => {
    expect(() =>
      createSpecFactoryAgentTaskExecutorRegistry({
        repository: {} as never,
        workspace: {} as never,
        researchExecutorMode: "none",
        specRepository: {} as never,
        draftRequester: {} as never,
        llmGateway: { generateObject: vi.fn() },
        env: {
          SPEC_FACTORY_HANDOFF_BUILD_TASK_ENABLED: "true",
          SPEC_FACTORY_HANDOFF_LLM_SYNTHESIS: "true",
          SPEC_FACTORY_LLM_GATEWAY: "false",
        },
      }),
    ).toThrow("handoff_synthesis_requires_llm_gateway");
  });

  it("rejects critic registry config without the LLM gateway flag", () => {
    expect(() =>
      createSpecFactoryAgentTaskExecutorRegistry({
        repository: {} as never,
        workspace: {} as never,
        researchExecutorMode: "none",
        llmGateway: { generateObject: vi.fn() },
        env: {
          SPEC_FACTORY_ENABLE_CRITIC: "true",
          SPEC_FACTORY_LLM_GATEWAY: "false",
        },
      }),
    ).toThrow("critic_requires_llm_gateway");
  });

  it("rejects research executor config when the agent task lease is shorter than max runtime", () => {
    expect(() =>
      createSpecFactoryAgentTaskExecutorRegistry({
        repository: {} as never,
        workspace: {} as never,
        researchExecutorMode: "claude_agent_sdk",
        researchRunner: { run: vi.fn() },
        env: {
          SPEC_FACTORY_AGENT_TASK_LEASE_MS: "300000",
          SPEC_FACTORY_RESEARCH_MAX_RUNTIME_SECONDS: "600",
        },
      }),
    ).toThrow("research_runtime_exceeds_agent_task_lease");
  });
});

describe("createFindChildIssueByParentAndSummary", () => {
  it("searches Jira by project and parent, then filters exact summary matches", async () => {
    const searchIssues = vi.fn().mockResolvedValue({
      issues: [
        {
          key: "CPDEV-2",
          fields: { summary: "[core-app] Different validation" },
        },
        {
          key: "CPDEV-1",
          fields: { summary: '[core-app] Add "quoted" validation' },
        },
      ],
    });
    const findChildIssueByParentAndSummary =
      createFindChildIssueByParentAndSummary({
        searchIssues,
      } as never);

    await expect(
      findChildIssueByParentAndSummary({
        projectKey: "CPDEV",
        parentEpicKey: "CPDEV-22411",
        summary: '[core-app] Add "quoted" validation',
      }),
    ).resolves.toEqual({
      key: "CPDEV-1",
      summary: '[core-app] Add "quoted" validation',
    });

    expect(searchIssues).toHaveBeenCalledWith(
      'project = "CPDEV" AND parent = "CPDEV-22411" AND summary ~ "[core-app] Add \\"quoted\\" validation"',
      "key,summary,parent,status",
      25,
    );
  });

  it("returns null when Jira search finds only fuzzy summary misses", async () => {
    const searchIssues = vi.fn().mockResolvedValue({
      issues: [
        { key: "CPDEV-2", fields: { summary: "[core-app] Add validation v2" } },
      ],
    });
    const findChildIssueByParentAndSummary =
      createFindChildIssueByParentAndSummary({
        searchIssues,
      } as never);

    await expect(
      findChildIssueByParentAndSummary({
        projectKey: "CPDEV",
        parentEpicKey: "CPDEV-22411",
        summary: "[core-app] Add validation",
      }),
    ).resolves.toBeNull();
  });
});
