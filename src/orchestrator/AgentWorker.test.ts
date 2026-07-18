import type { EventEmitter } from "events";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import {
  AgentWorker,
  AGENTS_ALLOWED_TO_PUSH,
  shouldRetryTransientAgentFailure,
  type ProcessResult,
  shouldUsePushAuth,
  stripCredentialsFromUrl,
} from "./AgentWorker.js";
import { TaskDescriptionGenerator } from "./TaskDescriptionGenerator.js";

class TestAgentWorker extends AgentWorker {
  protected async process(
    _jiraNumber: string,
    _taskId: number,
    _taskDescription: string,
    _additionalContext: string,
    _repositoryPath: string,
    _eventEmitter?: EventEmitter,
  ): Promise<ProcessResult> {
    return { success: true, output: "ok" };
  }
}

class TimeoutAgentWorker extends AgentWorker {
  protected async process(): Promise<ProcessResult> {
    throw new Error("SDK timeout after 600000ms");
  }
}

class ParkingAgentWorker extends AgentWorker {
  protected async process(): Promise<ProcessResult> {
    return {
      success: true,
      output: "parked",
      taskManagementStatus: "waiting_repo_confirmation",
    };
  }
}

class TransientFailureAgentWorker extends AgentWorker {
  protected async process(): Promise<ProcessResult> {
    return {
      success: false,
      output: "",
      error: "SDK timeout after 1800000ms",
      metrics: {
        durationMs: 1_800_000,
        iterations: 126,
      },
    };
  }
}

class FetchFailureAgentWorker extends AgentWorker {
  protected async process(): Promise<ProcessResult> {
    throw new TypeError("fetch failed");
  }
}

describe("shouldUsePushAuth", () => {
  it("returns true for agents in the push allowlist", () => {
    for (const name of AGENTS_ALLOWED_TO_PUSH) {
      expect(shouldUsePushAuth(name)).toBe(true);
    }
  });

  it("includes ANVIL (the current push-capable agent)", () => {
    expect(AGENTS_ALLOWED_TO_PUSH.has("ANVIL")).toBe(true);
    expect(shouldUsePushAuth("ANVIL")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(shouldUsePushAuth("anvil")).toBe(true);
    expect(shouldUsePushAuth("Anvil")).toBe(true);
  });

  it("returns false for read-only agents", () => {
    const readOnlyAgents = [
      "HERMES",
      "DARCI",
      "SCRIBE",
      "PRISM",
      "SENTRY",
      "BEACON",
      "VERITAS",
      "SRLOG",
      "NOTARY",
      "FORGE",
      "QUALIFIER",
      "BC-INTAKE",
      "BCAT-PLANNER",
      "BCAT-EXECUTOR",
    ];
    for (const name of readOnlyAgents) {
      expect(shouldUsePushAuth(name)).toBe(false);
    }
  });

  it("returns false for undefined/null/empty agent names", () => {
    expect(shouldUsePushAuth(undefined)).toBe(false);
    expect(shouldUsePushAuth(null)).toBe(false);
    expect(shouldUsePushAuth("")).toBe(false);
  });

  it("returns false for unknown agent names (deny-by-default)", () => {
    expect(shouldUsePushAuth("UNKNOWN-AGENT")).toBe(false);
    expect(shouldUsePushAuth("NEW_EXPERIMENTAL")).toBe(false);
  });
});

describe("AgentWorker task payload evidence handoff", () => {
  it("persists the task payload pointer when ticket evidence upload fails", async () => {
    const generatePayload = vi
      .spyOn(TaskDescriptionGenerator.prototype, "generateTaskPayloadFromTicketKey")
      .mockResolvedValue({
        taskDescription: "Generated task description",
        ticketEvidence: {
          schemaVersion: "ticket-evidence.v1",
          jiraKey: "CPDEV-30004",
          stats: {
            commentCount: 0,
            attachmentCount: 0,
            extractedAttachmentCount: 0,
            imageAttachmentCount: 0,
            warningCount: 0,
          },
        },
      } as any);
    const worker = new TestAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.storage = {
      uploadTaskDescription: vi.fn().mockResolvedValue({
        bucket: "tasks",
        key: "tasks/CPDEV-30004/2026-06-17.md",
      }),
      uploadTicketEvidence: vi.fn().mockRejectedValue(new Error("s3 throttle")),
    };
    worker.db = {
      updateTaskManagementTaskPayload: vi.fn().mockResolvedValue(undefined),
    };

    await expect(
      worker.generateAndPersistTaskDescription(
        {
          id: 100,
          jira_number: "CPDEV-30004",
        },
        { jira: "CPDEV-30004" },
      ),
    ).resolves.toEqual({
      bucket: "tasks",
      key: "tasks/CPDEV-30004/2026-06-17.md",
    });

    expect(generatePayload).toHaveBeenCalledWith("CPDEV-30004", "");
    expect(worker.storage.uploadTicketEvidence).toHaveBeenCalled();
    expect(worker.db.updateTaskManagementTaskPayload).toHaveBeenCalledWith(
      100,
      "tasks",
      "tasks/CPDEV-30004/2026-06-17.md",
    );
    generatePayload.mockRestore();
  });
});

describe("shouldRetryTransientAgentFailure", () => {
  it("retries agent transient Claude failures within the retry limit", () => {
    expect(
      shouldRetryTransientAgentFailure(
        "DARCI",
        "SDK timeout after 1800000ms",
        0,
      ),
    ).toBe(true);
    expect(
      shouldRetryTransientAgentFailure(
        "HERMES",
        "Turn limit exceeded (max: 100)",
        1,
      ),
    ).toBe(true);
    expect(
      shouldRetryTransientAgentFailure(
        "DARCI",
        "SDK_POST_TOOL_IDLE_TIMEOUT: no stream event for 90000ms after repository tools, toolCalls=44, output=111",
        0,
      ),
    ).toBe(true);
    expect(
      shouldRetryTransientAgentFailure(
        "SCRIBE",
        "SDK timeout after 600000ms",
        0,
      ),
    ).toBe(true);
    expect(
      shouldRetryTransientAgentFailure(
        "VERITAS",
        "SDK_IDLE_TIMEOUT: no stream event for 180000ms, toolCalls=3, output=0",
        0,
      ),
    ).toBe(true);
    expect(
      shouldRetryTransientAgentFailure(
        "QUALIFIER",
        "fetch failed",
        0,
      ),
    ).toBe(true);
    expect(
      shouldRetryTransientAgentFailure(
        "QUALIFIER",
        "SDK timeout after 600000ms",
        0,
      ),
    ).toBe(false);
    expect(
      shouldRetryTransientAgentFailure(
        "VERITAS",
        "SDK timeout after 1200000ms",
        0,
      ),
    ).toBe(true);
  });

  it("does not retry deterministic or unsupported failures", () => {
    expect(
      shouldRetryTransientAgentFailure(
        "DARCI",
        "Claude Code returned an error result: API Error: Claude's response exceeded the 4096 output token maximum.",
        0,
      ),
    ).toBe(false);
    expect(
      shouldRetryTransientAgentFailure(
        "DARCI",
        "Cannot read properties of undefined (reading 'toLowerCase')",
        0,
      ),
    ).toBe(false);
    expect(
      shouldRetryTransientAgentFailure(
        "BEACON",
        "SDK timeout after 1800000ms",
        0,
      ),
    ).toBe(false);
    expect(
      shouldRetryTransientAgentFailure(
        "DARCI",
        "SDK timeout after 1800000ms",
        2,
      ),
    ).toBe(false);
  });
});

describe("stripCredentialsFromUrl", () => {
  it("removes x-access-token credentials from a GitHub HTTPS URL", () => {
    const authed =
      "https://x-access-token:ghs_abcDEF123@github.com/org/repo.git";
    expect(stripCredentialsFromUrl(authed)).toBe(
      "https://github.com/org/repo.git",
    );
  });

  it("removes URL-encoded credentials", () => {
    const authed =
      "https://x-access-token:ghs_abc%2FDEF@github.com/org/repo.git";
    expect(stripCredentialsFromUrl(authed)).toBe(
      "https://github.com/org/repo.git",
    );
  });

  it("is a no-op for URLs without embedded credentials", () => {
    const plain = "https://github.com/org/repo.git";
    expect(stripCredentialsFromUrl(plain)).toBe(plain);
  });

  it("does not rewrite the path portion even if it contains @", () => {
    // Path contains @ but no userinfo before the host.
    const withAtInPath = "https://github.com/org/repo@branch.git";
    expect(stripCredentialsFromUrl(withAtInPath)).toBe(withAtInPath);
  });

  it("handles user:token@host syntax with arbitrary credentials", () => {
    const authed = "https://someone:somepassword@github.com/org/repo.git";
    expect(stripCredentialsFromUrl(authed)).toBe(
      "https://github.com/org/repo.git",
    );
  });
});

describe("worktree path validation", () => {
  it("rejects partial branch directories that are not real git worktrees", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "specter-worktree-"),
    );
    const branchPath = path.join(tempRoot, "core-app", "3.18");
    await fs.mkdir(branchPath, { recursive: true });

    try {
      const worker = new TestAgentWorker({
        agentName: "DARCI",
        repositoryPath: "/tmp/repo",
      }) as any;

      await expect(
        worker.isUsableWorktreePath(branchPath, { repo: "core-app" }),
      ).resolves.toBe(false);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("QUALIFIER unsupported payload handling", () => {
  it("skips missing task-payload generation when RepoRouter outcome is unsupported", async () => {
    const worker = new TestAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      getLatestRouterDecisionForTicket: vi.fn().mockResolvedValue({
        id: 42,
        outcome: "unsupported",
      }),
    };

    await expect(
      worker.shouldSkipMissingQualifierPayloadGeneration(
        { jira_number: "CPDEV-999" },
        { jira: "CPDEV-999" },
      ),
    ).resolves.toBe(true);
    expect(worker.db.getLatestRouterDecisionForTicket).toHaveBeenCalledWith(
      "CPDEV-999",
    );
  });

  it("does not skip missing task-payload generation for non-unsupported outcomes", async () => {
    const worker = new TestAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      getLatestRouterDecisionForTicket: vi.fn().mockResolvedValue({
        id: 43,
        outcome: "auto",
      }),
    };

    await expect(
      worker.shouldSkipMissingQualifierPayloadGeneration(
        { jira_number: "CPDEV-21311" },
        { jira: "CPDEV-21311" },
      ),
    ).resolves.toBe(false);
  });
});

describe("QUALIFIER timeout parking", () => {
  // Stub fetchJiraIssueForRouting on every test so the worker can build a
  // confirmation plan without hitting the Jira API. The actual ticket
  // shape doesn't matter for these tests — we only assert what the
  // worker passes into db.parkQualifierForRepoConfirmation.
  function stubJiraFetch(worker: any) {
    worker.fetchJiraIssueForRouting = vi.fn().mockResolvedValue({
      key: "CPDEV-21428",
      fields: { summary: "X", description: "Y" },
    });
  }

  it("atomically parks a 10-minute SDK timeout with all enabled repos as candidates", async () => {
    const worker = new TestAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    // Mirror current src/oneshot/repo-metadata.ts: Document-ai is
    // OneShot-enabled, so it appears in the candidate list alongside
    // interop and core-app.
    const repos = [
      {
        id: 1,
        repo_name: "core-app",
        repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
      },
      {
        id: 2,
        repo_name: "interop",
        repo_url:
          "https://github.com/mhk-repos/cp-interoperability-monorepo.git",
      },
      {
        id: 99,
        repo_name: "Document-ai",
        repo_url: "https://github.com/mhk-repos/document-ai.git",
      },
    ];
    worker.db = {
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
      getLatestRouterDecisionForTicket: vi.fn().mockResolvedValue({
        id: 42,
        outcome: "auto",
        selected_repo_ids_json: JSON.stringify([2]),
        scores_json: JSON.stringify([
          {
            repoId: 2,
            repoName: "interop",
            score: 11,
            evidence: [{ id: "e1" }],
          },
          { repoId: 1, repoName: "core-app", score: 4, evidence: [] },
        ]),
        snapshot_hash: "snapshot-42",
      }),
      getAllRepositories: vi.fn().mockResolvedValue(repos),
      parkQualifierForRepoConfirmation: vi
        .fn()
        .mockResolvedValue({ routerDecisionId: 99, routerConfirmationId: 7 }),
    };
    stubJiraFetch(worker);

    const parked = await worker.parkQualifierTimeoutForRepoConfirmation(
      {
        id: 100,
        jira_number: "CPDEV-21428",
        related_code: "2",
      },
      "SDK timeout after 600000ms",
      { jira: "CPDEV-21428" },
      55,
    );

    expect(parked).toBe(true);
    // The atomic helper does the status + decision + confirmation
    // inserts in one transaction.
    const parkCall =
      worker.db.parkQualifierForRepoConfirmation.mock.calls[0][0];
    expect(parkCall.taskManagementId).toBe(100);
    expect(parkCall.candidates.map((c: any) => c.repoName).sort()).toEqual(
      ["Document-ai", "core-app", "interop"].sort(),
    );
    // task_id and error_message are applied AFTER the atomic park as a
    // follow-up update (atomic helper doesn't own those columns).
    expect(worker.db.updateTaskManagementStatus).toHaveBeenCalledWith(
      100,
      "waiting_repo_confirmation",
      expect.objectContaining({
        task_id: 55,
        error_message: expect.stringContaining("SDK timeout after 600000ms"),
      }),
    );
  });

  it("returns false (no parking) when the atomic helper throws — AgentWorker hits failure path", async () => {
    const worker = new TestAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
      getLatestRouterDecisionForTicket: vi.fn().mockResolvedValue(null),
      getAllRepositories: vi.fn().mockResolvedValue([
        {
          id: 2,
          repo_name: "interop",
          repo_url:
            "https://github.com/mhk-repos/cp-interoperability-monorepo.git",
        },
      ]),
      parkQualifierForRepoConfirmation: vi
        .fn()
        .mockRejectedValue(new Error("DB transaction aborted")),
    };
    stubJiraFetch(worker);

    const parked = await worker.parkQualifierTimeoutForRepoConfirmation(
      { id: 100, jira_number: "CPDEV-21428", related_code: "2" },
      "SDK timeout after 600000ms",
      { jira: "CPDEV-21428" },
      55,
    );

    // Critical: must NOT silently re-park (the prior bug). Atomic helper
    // rolled back, status is whatever it was before the call.
    expect(parked).toBe(false);
    expect(worker.db.updateTaskManagementStatus).not.toHaveBeenCalledWith(
      100,
      "waiting_repo_confirmation",
      expect.any(Object),
    );
  });

  it("returns false (no parking) when zero OneShot-enabled repos exist — refuses unresolvable parking row", async () => {
    const worker = new TestAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
      getLatestRouterDecisionForTicket: vi.fn().mockResolvedValue(null),
      // Repos exist but NONE are OneShot-enabled (real-world: env flag
      // misconfiguration, every repo's metadata flips off).
      getAllRepositories: vi.fn().mockResolvedValue([
        {
          id: 2,
          repo_name: "mp-web",
          repo_url: "https://github.com/mhk-repos/mp-web.git",
        },
      ]),
      parkQualifierForRepoConfirmation: vi.fn(),
    };
    stubJiraFetch(worker);

    const parked = await worker.parkQualifierTimeoutForRepoConfirmation(
      { id: 100, jira_number: "CPDEV-21428", related_code: "2" },
      "SDK timeout after 600000ms",
      { jira: "CPDEV-21428" },
      55,
    );

    expect(parked).toBe(false);
    expect(worker.db.parkQualifierForRepoConfirmation).not.toHaveBeenCalled();
  });

  it("processTask atomic-parks a thrown QUALIFIER timeout end-to-end", async () => {
    const worker = new TimeoutAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      claimTaskForProcessing: vi.fn().mockResolvedValue(true),
      createTask: vi.fn().mockResolvedValue(88),
      updateTaskStatus: vi.fn().mockResolvedValue(undefined),
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
      getTaskManagementById: vi.fn().mockResolvedValue({
        id: 100,
        status: "waiting_repo_confirmation",
      }),
      getLatestRouterDecisionForTicket: vi.fn().mockResolvedValue(null),
      getAllRepositories: vi.fn().mockResolvedValue([
        {
          id: 2,
          repo_name: "interop",
          repo_url:
            "https://github.com/mhk-repos/cp-interoperability-monorepo.git",
        },
      ]),
      parkQualifierForRepoConfirmation: vi
        .fn()
        .mockResolvedValue({ routerDecisionId: 99, routerConfirmationId: 7 }),
    };
    worker.storage = {
      downloadResult: vi.fn().mockResolvedValue("task description"),
    };
    worker.cloneRepositories = vi.fn().mockResolvedValue("/tmp/repo");
    worker.buildAdditionalContext = vi.fn().mockResolvedValue("");
    worker.cleanupTaskWorkspace = vi.fn().mockResolvedValue(undefined);
    stubJiraFetch(worker);

    await worker.processTask({
      id: 100,
      jira_number: "CPDEV-21428",
      customer_id: 1,
      related_code: "",
      task_s3_bucket: "bucket",
      task_s3_key: "key",
    });

    // tasks row marked failed (the inner task entity).
    expect(worker.db.updateTaskStatus).toHaveBeenCalledWith(
      88,
      "failed",
      expect.objectContaining({
        error_message: "SDK timeout after 600000ms",
      }),
    );
    // task_management transitions to waiting_repo_confirmation through
    // the atomic helper + the follow-up status write for task_id/error.
    expect(worker.db.parkQualifierForRepoConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({ taskManagementId: 100 }),
    );
    expect(worker.db.updateTaskManagementStatus).toHaveBeenCalledWith(
      100,
      "waiting_repo_confirmation",
      expect.objectContaining({
        task_id: 88,
        error_message: expect.stringContaining("SDK timeout after 600000ms"),
      }),
    );
    // markTaskManagementFailedUnlessParked sees status=waiting_repo_confirmation
    // and refuses to overwrite with 'failed'.
    expect(worker.db.updateTaskManagementStatus).not.toHaveBeenCalledWith(
      100,
      "failed",
      expect.any(Object),
    );
  });

  it("when atomic park throws during processTask, task_management ends up 'failed' (not silently parked)", async () => {
    const worker = new TimeoutAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      claimTaskForProcessing: vi.fn().mockResolvedValue(true),
      createTask: vi.fn().mockResolvedValue(88),
      updateTaskStatus: vi.fn().mockResolvedValue(undefined),
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
      // Status read by markTaskManagementFailedUnlessParked. Since the
      // atomic helper rolled back, the row is still in_progress.
      getTaskManagementById: vi
        .fn()
        .mockResolvedValue({ id: 100, status: "in_progress" }),
      getLatestRouterDecisionForTicket: vi.fn().mockResolvedValue(null),
      getAllRepositories: vi.fn().mockResolvedValue([
        {
          id: 2,
          repo_name: "interop",
          repo_url:
            "https://github.com/mhk-repos/cp-interoperability-monorepo.git",
        },
      ]),
      parkQualifierForRepoConfirmation: vi
        .fn()
        .mockRejectedValue(new Error("simulated atomic park failure")),
    };
    worker.storage = {
      downloadResult: vi.fn().mockResolvedValue("task description"),
    };
    worker.cloneRepositories = vi.fn().mockResolvedValue("/tmp/repo");
    worker.buildAdditionalContext = vi.fn().mockResolvedValue("");
    worker.cleanupTaskWorkspace = vi.fn().mockResolvedValue(undefined);
    stubJiraFetch(worker);

    await worker.processTask({
      id: 100,
      jira_number: "CPDEV-21428",
      customer_id: 1,
      related_code: "2",
      task_s3_bucket: "bucket",
      task_s3_key: "key",
    });

    // No silent re-park: parking returned false, AgentWorker took the
    // failure path which marks both rows failed.
    expect(worker.db.updateTaskStatus).toHaveBeenCalledWith(
      88,
      "failed",
      expect.objectContaining({
        error_message: "SDK timeout after 600000ms",
      }),
    );
    expect(worker.db.updateTaskManagementStatus).toHaveBeenCalledWith(
      100,
      "failed",
      expect.objectContaining({
        error_message: "SDK timeout after 600000ms",
      }),
    );
    expect(worker.db.updateTaskManagementStatus).not.toHaveBeenCalledWith(
      100,
      "waiting_repo_confirmation",
      expect.any(Object),
    );
  });

  it("does not park non-timeout QUALIFIER failures", async () => {
    const worker = new TestAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      updateTaskManagementStatus: vi.fn(),
    };

    const parked = await worker.parkQualifierTimeoutForRepoConfirmation(
      { id: 100, jira_number: "CPDEV-21428", related_code: "2" },
      "Ticket did not qualify",
      { jira: "CPDEV-21428" },
    );

    expect(parked).toBe(false);
    expect(worker.db.updateTaskManagementStatus).not.toHaveBeenCalled();
  });
});

describe("ProcessResult.taskManagementStatus override", () => {
  it("honors taskManagementStatus instead of stomping to 'completed' on success", async () => {
    const worker = new ParkingAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      claimTaskForProcessing: vi.fn().mockResolvedValue(true),
      createTask: vi.fn().mockResolvedValue(101),
      updateTaskStatus: vi.fn().mockResolvedValue(undefined),
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
    };
    worker.storage = {
      downloadResult: vi.fn().mockResolvedValue("task description"),
      uploadResult: vi.fn().mockResolvedValue({
        bucket: "results",
        key: "results/CPDEV-30000.md",
      }),
    };
    worker.cloneRepositories = vi.fn().mockResolvedValue("/tmp/repo");
    worker.buildAdditionalContext = vi.fn().mockResolvedValue("");
    worker.cleanupTaskWorkspace = vi.fn().mockResolvedValue(undefined);

    await worker.processTask({
      id: 200,
      jira_number: "CPDEV-30000",
      customer_id: 1,
      related_code: "",
      task_s3_bucket: "bucket",
      task_s3_key: "key",
    });

    expect(worker.db.updateTaskStatus).toHaveBeenCalledWith(
      101,
      "completed",
      expect.any(Object),
    );
    // Critical: task_management.status must be the override, NOT 'completed'.
    expect(worker.db.updateTaskManagementStatus).toHaveBeenCalledWith(
      200,
      "waiting_repo_confirmation",
    );
    expect(worker.db.updateTaskManagementStatus).not.toHaveBeenCalledWith(
      200,
      "completed",
    );
  });

  it("defaults to 'completed' when taskManagementStatus is not set", async () => {
    const worker = new TestAgentWorker({
      agentName: "TEST",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      claimTaskForProcessing: vi.fn().mockResolvedValue(true),
      createTask: vi.fn().mockResolvedValue(102),
      updateTaskStatus: vi.fn().mockResolvedValue(undefined),
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
    };
    worker.storage = {
      downloadResult: vi.fn().mockResolvedValue("task description"),
      uploadResult: vi.fn().mockResolvedValue({
        bucket: "results",
        key: "results/CPDEV-30001.md",
      }),
    };
    worker.cloneRepositories = vi.fn().mockResolvedValue("/tmp/repo");
    worker.buildAdditionalContext = vi.fn().mockResolvedValue("");
    worker.cleanupTaskWorkspace = vi.fn().mockResolvedValue(undefined);

    await worker.processTask({
      id: 201,
      jira_number: "CPDEV-30001",
      customer_id: 1,
      related_code: "",
      task_s3_bucket: "bucket",
      task_s3_key: "key",
    });

    expect(worker.db.updateTaskManagementStatus).toHaveBeenCalledWith(
      201,
      "completed",
    );
  });
});

describe("DARCI/HERMES transient failure retry", () => {
  it("marks the failed task row and requeues DARCI task_management instead of terminally failing it", async () => {
    const worker = new TransientFailureAgentWorker({
      agentName: "DARCI",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      claimTaskForProcessing: vi.fn().mockResolvedValue(true),
      createTask: vi.fn().mockResolvedValue(301),
      updateTaskStatus: vi.fn().mockResolvedValue(undefined),
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
      requeueTaskManagementAfterTransientFailure: vi
        .fn()
        .mockResolvedValue(undefined),
    };
    worker.storage = {
      downloadResult: vi.fn().mockResolvedValue("task description"),
    };
    worker.cloneRepositories = vi.fn().mockResolvedValue("/tmp/repo");
    worker.buildAdditionalContext = vi.fn().mockResolvedValue("");
    worker.cleanupTaskWorkspace = vi.fn().mockResolvedValue(undefined);

    await worker.processTask({
      id: 300,
      jira_number: "CPDEV-30002",
      customer_id: 1,
      related_code: "1",
      task_s3_bucket: "bucket",
      task_s3_key: "key",
      retry_count: 0,
    });

    expect(worker.db.updateTaskStatus).toHaveBeenCalledWith(
      301,
      "failed",
      expect.objectContaining({
        error_message: "SDK timeout after 1800000ms",
        metrics_json: expect.objectContaining({
          durationMs: 1_800_000,
          iterations: 126,
          failureTaxonomy: expect.objectContaining({
            category: "sdk_timeout",
            retryable: true,
          }),
          retry: expect.objectContaining({
            retryable: true,
            nextRetryCount: 1,
          }),
        }),
      }),
    );
    expect(worker.cleanupTaskWorkspace).toHaveBeenCalledWith(
      300,
      expect.any(Object),
    );
    expect(
      worker.db.requeueTaskManagementAfterTransientFailure,
    ).toHaveBeenCalledWith(
      300,
      expect.stringContaining("SDK timeout after 1800000ms"),
    );
    expect(worker.db.updateTaskManagementStatus).not.toHaveBeenCalledWith(
      300,
      "failed",
      expect.any(Object),
    );
  });

  it("requeues QUALIFIER task_management after a transient Jira fetch failure", async () => {
    const worker = new FetchFailureAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      claimTaskForProcessing: vi.fn().mockResolvedValue(true),
      createTask: vi.fn().mockResolvedValue(302),
      updateTaskStatus: vi.fn().mockResolvedValue(undefined),
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
      requeueTaskManagementAfterTransientFailure: vi
        .fn()
        .mockResolvedValue(undefined),
    };
    worker.storage = {
      downloadResult: vi.fn().mockResolvedValue("task description"),
    };
    worker.cloneRepositories = vi.fn().mockResolvedValue("/tmp/repo");
    worker.buildAdditionalContext = vi.fn().mockResolvedValue("");
    worker.cleanupTaskWorkspace = vi.fn().mockResolvedValue(undefined);

    await worker.processTask({
      id: 301,
      jira_number: "CPDEV-30003",
      customer_id: 1,
      related_code: "",
      task_s3_bucket: "bucket",
      task_s3_key: "key",
      retry_count: 0,
    });

    expect(worker.db.updateTaskStatus).toHaveBeenCalledWith(
      302,
      "failed",
      expect.objectContaining({
        error_message: "fetch failed",
        metrics_json: expect.objectContaining({
          failureTaxonomy: expect.objectContaining({
            category: "provider_transient",
            retryable: true,
          }),
          retry: expect.objectContaining({
            retryable: true,
            nextRetryCount: 1,
            agent: "QUALIFIER",
          }),
        }),
      }),
    );
    expect(
      worker.db.requeueTaskManagementAfterTransientFailure,
    ).toHaveBeenCalledWith(301, "fetch failed");
    expect(worker.db.updateTaskManagementStatus).not.toHaveBeenCalledWith(
      301,
      "failed",
      expect.any(Object),
    );
  });
});

describe("markTaskManagementFailedUnlessParked", () => {
  it("preserves waiting_repo_confirmation when worker errors after parking", async () => {
    const worker = new TestAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      getTaskManagementById: vi.fn().mockResolvedValue({
        id: 300,
        status: "waiting_repo_confirmation",
      }),
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
    };

    await worker.markTaskManagementFailedUnlessParked(
      300,
      "post-parking explosion",
      { jira: "CPDEV-30100" },
    );

    expect(worker.db.getTaskManagementById).toHaveBeenCalledWith(300);
    expect(worker.db.updateTaskManagementStatus).not.toHaveBeenCalled();
  });

  it("marks failed when status is not parked", async () => {
    const worker = new TestAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      getTaskManagementById: vi.fn().mockResolvedValue({
        id: 301,
        status: "in_progress",
      }),
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
    };

    await worker.markTaskManagementFailedUnlessParked(301, "real failure", {
      jira: "CPDEV-30101",
    });

    expect(worker.db.updateTaskManagementStatus).toHaveBeenCalledWith(
      301,
      "failed",
      { error_message: "real failure", increment_retry_count: true },
    );
  });

  it("marks retries exhausted and adds the agent failed label when the next failure reaches the cap", async () => {
    const originalFetch = global.fetch;
    const originalJiraBaseUrl = process.env.JIRA_BASE_URL;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      text: vi.fn().mockResolvedValue(""),
    } as unknown as Response);
    global.fetch = fetchMock;
    process.env.JIRA_BASE_URL = "https://jira.example";

    const worker = new TestAgentWorker({
      agentName: "DARCI",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.agentJiraUsername = "agent@example.com";
    worker.agentJiraToken = "agent-token";
    worker.db = {
      getTaskManagementById: vi.fn().mockResolvedValue({
        id: 303,
        status: "in_progress",
        retry_count: 2,
      }),
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
    };

    try {
      await worker.markTaskManagementFailedUnlessParked(
        303,
        "real failure",
        { jira: "CPDEV-30103" },
        { jira_number: "CPDEV-30103", source: "jira" },
      );
    } finally {
      global.fetch = originalFetch;
      if (originalJiraBaseUrl === undefined) {
        delete process.env.JIRA_BASE_URL;
      } else {
        process.env.JIRA_BASE_URL = originalJiraBaseUrl;
      }
    }

    expect(worker.db.updateTaskManagementStatus).toHaveBeenCalledWith(
      303,
      "failed_retries_exhausted",
      { error_message: "real failure", increment_retry_count: true },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://jira.example/rest/api/3/issue/CPDEV-30103",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          update: {
            labels: [{ add: "DARCI_FAILED" }],
          },
        }),
      }),
    );
  });

  it("falls through to fail-mark if status lookup itself fails (degraded but never silent)", async () => {
    const worker = new TestAgentWorker({
      agentName: "QUALIFIER",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      getTaskManagementById: vi
        .fn()
        .mockRejectedValue(new Error("DB unreachable")),
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
    };

    await worker.markTaskManagementFailedUnlessParked(302, "real failure", {
      jira: "CPDEV-30102",
    });

    expect(worker.db.updateTaskManagementStatus).toHaveBeenCalledWith(
      302,
      "failed",
      { error_message: "real failure", increment_retry_count: true },
    );
  });

  it("uses the claimed row retry count when status lookup fails", async () => {
    const worker = new TestAgentWorker({
      agentName: "DARCI",
      repositoryPath: "/tmp/repo",
    }) as any;
    worker.db = {
      getTaskManagementById: vi
        .fn()
        .mockRejectedValue(new Error("DB unreachable")),
      updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
    };

    await worker.markTaskManagementFailedUnlessParked(
      304,
      "real failure",
      { jira: "CPDEV-30104" },
      { jira_number: "CPDEV-30104", retry_count: 2, source: "api" },
    );

    expect(worker.db.updateTaskManagementStatus).toHaveBeenCalledWith(
      304,
      "failed_retries_exhausted",
      { error_message: "real failure", increment_retry_count: true },
    );
  });
});
