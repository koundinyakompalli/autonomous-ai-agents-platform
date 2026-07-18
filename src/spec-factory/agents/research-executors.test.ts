import { describe, expect, it, vi } from "vitest";
import type { ClaimedAgentTask } from "../compose-database.js";
import {
  ClaudeAgentSdkResearchRunner,
  CodeResearchExecutor,
  createResearchExecutorRegistry,
  researchDistillationEnabled,
  resolveResearchAllowedBashCommandPatterns,
  resolveResearchAllowedTools,
  resolveResearchExecutorMode,
} from "./research-executors.js";

const task: ClaimedAgentTask = {
  id: 501,
  sessionId: 7,
  turnJobId: 101,
  capability: "code_research",
  executorType: "code_research",
  status: "running",
  input: {
    question: "Where is retry logic implemented?",
    parentSourceIds: [11, 12],
    contextVersionUsed: 4,
    maxCostUsd: 1.25,
  },
  leaseGeneration: 2,
  activeWorkerId: "agent-worker-a",
};

function repositoryFixture() {
  return {
    getSession: vi.fn().mockResolvedValue({
      id: 7,
      workspacePath: "/workspace/session-7",
      status: "draft",
      latestContextVersion: 6,
    }),
    listSessionSources: vi.fn().mockResolvedValue([]),
    confirmAgentTaskLease: vi.fn().mockResolvedValue(true),
    getGeneratedResearchSourceByTaskId: vi.fn().mockResolvedValue(null),
    createGeneratedResearchSource: vi.fn().mockResolvedValue(42),
    createAgentTask: vi.fn().mockResolvedValue(88),
    appendSessionEvent: vi.fn().mockResolvedValue({ id: 9001 }),
  };
}

function workspaceFixture() {
  return {
    writeArtifact: vi.fn().mockResolvedValue({
      artifactUri: "file:///workspace/session-7/generated/research/task-501.md",
      relativePath: "generated/research/task-501.md",
      bytes: 123,
      sha256: "a".repeat(64),
    }),
  };
}

describe("research executor configuration", () => {
  it("defaults research execution to disabled", () => {
    expect(resolveResearchExecutorMode(undefined)).toBe("none");
    expect(resolveResearchExecutorMode("none")).toBe("none");
    expect(resolveResearchExecutorMode("claude_agent_sdk")).toBe(
      "claude_agent_sdk",
    );
  });

  it("parses read-only tool policy env values", () => {
    expect(resolveResearchAllowedTools(undefined)).toEqual([
      "Read",
      "Grep",
      "Glob",
    ]);
    expect(resolveResearchAllowedTools("Read, Grep, Bash ")).toEqual([
      "Read",
      "Grep",
      "Bash",
    ]);
    expect(resolveResearchAllowedTools("Read, rg, RG, Grep, Glob")).toEqual([
      "Read",
      "Grep",
      "Glob",
    ]);
    expect(resolveResearchAllowedBashCommandPatterns(undefined)).toEqual([]);
    expect(
      resolveResearchAllowedBashCommandPatterns(
        "^git status$, ^rg --line-number --no-heading retry$",
      ),
    ).toEqual(["^git status$", "^rg --line-number --no-heading retry$"]);
    expect(() => resolveResearchAllowedBashCommandPatterns("^rg ")).toThrow(
      "invalid_research_bash_allowlist_pattern",
    );
    expect(() => resolveResearchAllowedBashCommandPatterns("^rg .*$")).toThrow(
      "invalid_research_bash_allowlist_pattern",
    );
    expect(() =>
      resolveResearchAllowedBashCommandPatterns("^rg retry; curl https://x$"),
    ).toThrow("invalid_research_bash_allowlist_pattern");
  });

  it("keeps generated-source distillation disabled by default", () => {
    expect(researchDistillationEnabled(undefined)).toBe(false);
    expect(researchDistillationEnabled("true")).toBe(true);
  });
});

describe("CodeResearchExecutor", () => {
  it("stores research output as a generated source and queues distillation when enabled", async () => {
    const repository = repositoryFixture();
    const workspace = workspaceFixture();
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n\nRetry handling lives in compose-database.ts.",
        evidence: [{ file: "src/spec-factory/compose-database.ts" }],
        confidence: "high",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner, {
      enqueueDistillation: true,
      allowedTools: ["Read", "Grep"],
      allowedBashCommandPatterns: ["^git status$"],
      maxTurns: 8,
      toolBudget: 20,
      maxCostUsd: 3,
    });

    await expect(executor.execute(task)).resolves.toEqual({
      output: {
        sourceId: 42,
        artifactUri:
          "file:///workspace/session-7/generated/research/task-501.md",
        distillationTaskId: 88,
        confidence: "high",
      },
      contextVersionUsed: 4,
      outputSourceId: 42,
      runtime: {
        provider: null,
        model: null,
        traceUri: null,
        outputArtifactUri:
          "file:///workspace/session-7/generated/research/task-501.md",
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
      },
    });

    expect(runner.run).toHaveBeenCalledWith({
      sessionId: 7,
      taskId: 501,
      capability: "code_research",
      question: "Where is retry logic implemented?",
      workspacePath: "/workspace/session-7",
      contextVersionUsed: 4,
      parentSourceIds: [11, 12],
      allowedTools: ["Read", "Grep"],
      allowedBashCommandPatterns: ["^git status$"],
      maxTurns: 8,
      maxRuntimeSeconds: 600,
      maxCostUsd: 1.25,
      toolBudget: 20,
    });
    expect(workspace.writeArtifact).toHaveBeenCalledWith({
      workspacePath: "/workspace/session-7",
      relativePath: "generated/research/code-research-task-501.md",
      content: "# Research\n\nRetry handling lives in compose-database.ts.",
    });
    expect(repository.createGeneratedResearchSource).toHaveBeenCalledWith({
      sessionId: 7,
      generatedByTaskId: 501,
      originalFilename: "code-research-task-501.md",
      markdownContent:
        "# Research\n\nRetry handling lives in compose-database.ts.",
      artifactUri: "file:///workspace/session-7/generated/research/task-501.md",
      artifactSha256: "a".repeat(64),
      artifactBytes: 123,
      parentSourceIds: [11, 12],
      contextVersionUsed: 4,
      evidence: [{ file: "src/spec-factory/compose-database.ts" }],
      confidence: "high",
    });
    expect(repository.createAgentTask).toHaveBeenCalledWith({
      sessionId: 7,
      turnJobId: 101,
      capability: "source_distillation",
      executorType: "source_distillation",
      input: { sourceId: 42, baseContextVersion: 4 },
      priority: 80,
      outputSourceId: null,
    });
    expect(repository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "source.added",
      payload: {
        sourceId: 42,
        kind: "generated_research",
        sourceOrigin: "agent",
        artifactUri:
          "file:///workspace/session-7/generated/research/task-501.md",
      },
      actorType: "system",
      actorId: "code_research",
      turnJobId: 101,
      agentTaskId: 501,
    });
    expect(repository.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "task.queued",
      payload: {
        capability: "source_distillation",
        executorType: "source_distillation",
        sourceId: 42,
        baseContextVersion: 4,
      },
      actorType: "system",
      actorId: "code_research",
      turnJobId: 101,
      agentTaskId: 88,
      contextVersion: 4,
    });
  });

  it("allows manual research tasks to run without a context version", async () => {
    const repository = repositoryFixture();
    repository.getSession.mockResolvedValue({
      id: 7,
      workspacePath: "/workspace/session-7",
      status: "draft",
      latestContextVersion: null,
    });
    const workspace = workspaceFixture();
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n\nNo committed context version exists yet.",
        evidence: [],
        confidence: "low",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner, {
      allowedTools: ["Read", "Grep"],
      maxCostUsd: 3,
    });

    const nullContextTask: ClaimedAgentTask = {
      ...task,
      input: {
        question:
          "Inspect the available workspace and report whether any context exists.",
        parentSourceIds: [],
        contextVersionUsed: null,
        maxCostUsd: 1.25,
      },
    };

    await expect(executor.execute(nullContextTask)).resolves.toEqual({
      output: {
        sourceId: 42,
        artifactUri:
          "file:///workspace/session-7/generated/research/task-501.md",
        confidence: "low",
      },
      contextVersionUsed: null,
      outputSourceId: 42,
      runtime: {
        provider: null,
        model: null,
        traceUri: null,
        outputArtifactUri:
          "file:///workspace/session-7/generated/research/task-501.md",
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
      },
    });

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        contextVersionUsed: null,
        parentSourceIds: [],
      }),
    );
    expect(repository.createGeneratedResearchSource).toHaveBeenCalledWith(
      expect.objectContaining({
        contextVersionUsed: null,
        parentSourceIds: [],
      }),
    );
  });

  it("does not queue distillation unless explicitly enabled", async () => {
    const repository = repositoryFixture();
    const workspace = workspaceFixture();
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n",
        evidence: [],
        confidence: "medium",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner);

    await executor.execute(task);

    expect(repository.createAgentTask).not.toHaveBeenCalled();
  });

  it("runs research from an attached local scratch workspace and writes artifacts to durable storage", async () => {
    const repository = repositoryFixture();
    const workspace = {
      ...workspaceFixture(),
      attach: vi.fn().mockResolvedValue({
        sessionId: 7,
        durableWorkspacePath: "/workspace/session-7",
        localWorkspacePath: "/local/scratch/session-7/research-501",
        purpose: "code_research",
        taskId: 501,
        attachedAt: "2026-06-02T00:00:00.000Z",
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n\nScratch path was used.",
        evidence: [],
        confidence: "high",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner, {
      allowedTools: ["Read", "Grep"],
    });

    await executor.execute(task);

    expect(workspace.attach).toHaveBeenCalledWith({
      sessionId: 7,
      durableWorkspacePath: "/workspace/session-7",
      purpose: "code_research",
      taskId: 501,
      allowMissingDurableWorkspace: true,
    });
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/local/scratch/session-7/research-501",
      }),
    );
    expect(workspace.writeArtifact).toHaveBeenCalledWith({
      workspacePath: "/workspace/session-7",
      relativePath: "generated/research/code-research-task-501.md",
      content: "# Research\n\nScratch path was used.",
    });
    expect(workspace.detach).toHaveBeenCalledWith({
      localWorkspacePath: "/local/scratch/session-7/research-501",
    });
  });

  it("grounds repositories inside the research worker and attaches them to local scratch", async () => {
    const repository = repositoryFixture();
    repository.listSessionSources.mockResolvedValue([
      {
        id: 11,
        kind: "note",
        conversionStatus: "converted",
        originalFilename: "billing-requirements.md",
        markdownContent: "The billing service owns invoice exports.",
      },
      {
        id: 12,
        kind: "generated_research",
        conversionStatus: "converted",
        originalFilename: "old-research.md",
        markdownContent: "Generated content must not select repositories.",
      },
    ]);
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const repoGrounding = {
      groundRepos: vi.fn().mockResolvedValue({
        repositoriesMarkdown: "# Repositories\n- billing-service",
        manifest: [
          {
            repoName: "billing-service",
            headSha: "abc123",
            inspectedPaths: ["src/export.ts"],
            keyMatches: [],
            warnings: [],
          },
        ],
        workspaces: [
          {
            repoName: "billing-service",
            workspacePath: "/repo-cache/billing-service/main",
            headSha: "abc123",
            cleanup,
          },
        ],
      }),
    };
    const workspace = {
      ...workspaceFixture(),
      attach: vi.fn().mockResolvedValue({
        localWorkspacePath: "/local/scratch/session-7/research-501",
      }),
      attachRepositories: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n\nThe export handler is evidence-backed.",
        evidence: [{ file: "repos/billing-service/src/export.ts" }],
        confidence: "high",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner, {
      repoGrounding,
      allowedTools: ["Read", "Grep", "Glob"],
    });

    await executor.execute(task);

    expect(repoGrounding.groundRepos).toHaveBeenCalledWith({
      selectedRepositoryIds: [],
      sources: [
        {
          filename: "billing-requirements.md",
          content: "The billing service owns invoice exports.",
        },
      ],
    });
    expect(workspace.attachRepositories).toHaveBeenCalledWith({
      workspacePath: "/local/scratch/session-7/research-501",
      repositories: [
        {
          repoName: "billing-service",
          workspacePath: "/repo-cache/billing-service/main",
          headSha: "abc123",
        },
      ],
    });
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/local/scratch/session-7/research-501",
      }),
    );
    expect(repository.createGeneratedResearchSource).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: [
          { file: "repos/billing-service/src/export.ts" },
          expect.objectContaining({
            kind: "repository_grounding",
            repoName: "billing-service",
            headSha: "abc123",
          }),
        ],
      }),
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("detaches the local scratch workspace when research execution fails", async () => {
    const repository = repositoryFixture();
    const workspace = {
      ...workspaceFixture(),
      attach: vi.fn().mockResolvedValue({
        sessionId: 7,
        durableWorkspacePath: "/workspace/session-7",
        localWorkspacePath: "/local/scratch/session-7/research-501",
        purpose: "code_research",
        taskId: 501,
        attachedAt: "2026-06-02T00:00:00.000Z",
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const runner = {
      run: vi.fn().mockRejectedValue(new Error("sdk failed")),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner, {
      allowedTools: ["Read", "Grep"],
    });

    await expect(executor.execute(task)).rejects.toThrow("sdk failed");

    expect(workspace.detach).toHaveBeenCalledWith({
      localWorkspacePath: "/local/scratch/session-7/research-501",
    });
    expect(workspace.writeArtifact).not.toHaveBeenCalled();
  });

  it("does not fail completed research when lifecycle event writes fail", async () => {
    const repository = repositoryFixture();
    repository.appendSessionEvent.mockRejectedValue(new Error("event db down"));
    const workspace = workspaceFixture();
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n",
        evidence: [],
        confidence: "medium",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner, {
      enqueueDistillation: true,
    });

    await expect(executor.execute(task)).resolves.toMatchObject({
      output: {
        sourceId: 42,
        distillationTaskId: 88,
        artifactUri:
          "file:///workspace/session-7/generated/research/task-501.md",
      },
      outputSourceId: 42,
      contextVersionUsed: 4,
    });
    expect(repository.createAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "source_distillation",
        executorType: "source_distillation",
      }),
    );
  });

  it("uses specialist research capability names for generated artifacts and events", async () => {
    const repository = repositoryFixture();
    const workspace = workspaceFixture();
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Config Research\n",
        evidence: [{ file: "src/spec-factory/server.ts" }],
        confidence: "medium",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner);

    await executor.execute({
      ...task,
      capability: "config_research",
      executorType: "code_research",
    });

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "config_research" }),
    );
    expect(workspace.writeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: "generated/research/config-research-task-501.md",
      }),
    );
    expect(repository.createGeneratedResearchSource).toHaveBeenCalledWith(
      expect.objectContaining({
        originalFilename: "config-research-task-501.md",
      }),
    );
    expect(repository.appendSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "config_research",
      }),
    );
  });

  it("rejects Bash research tools without an explicit scoped allowlist", () => {
    expect(
      () =>
        new CodeResearchExecutor(
          repositoryFixture(),
          workspaceFixture(),
          {
            run: vi.fn(),
          },
          {
            allowedTools: ["Read", "Bash"],
          },
        ),
    ).toThrow("research_bash_requires_allowlist");
  });

  it("normalizes the safe rg alias before invoking the research runner", async () => {
    const repository = repositoryFixture();
    const workspace = workspaceFixture();
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n",
        evidence: [],
        confidence: "medium",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner, {
      allowedTools: ["Read", "rg", "Grep", "Glob"],
    });

    await executor.execute(task);

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: ["Read", "Grep", "Glob"],
        allowedBashCommandPatterns: [],
      }),
    );
  });

  it("uses the session latest context version when the task input omits one", async () => {
    const repository = repositoryFixture();
    repository.getSession.mockResolvedValue({
      id: 7,
      workspacePath: "/workspace/session-7",
      status: "draft",
      latestContextVersion: 9,
    });
    const workspace = workspaceFixture();
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n",
        evidence: [],
        confidence: "medium",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner);
    const taskWithoutContext: ClaimedAgentTask = {
      ...task,
      input: { question: "Find retry behavior" },
    };

    await expect(executor.execute(taskWithoutContext)).resolves.toEqual(
      expect.objectContaining({
        contextVersionUsed: 9,
      }),
    );

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ contextVersionUsed: 9 }),
    );
    expect(repository.createGeneratedResearchSource).toHaveBeenCalledWith(
      expect.objectContaining({ contextVersionUsed: 9 }),
    );
  });

  it("allows code research to run when no context version is available", async () => {
    const repository = repositoryFixture();
    repository.getSession.mockResolvedValue({
      id: 7,
      workspacePath: "/workspace/session-7",
      status: "draft",
      latestContextVersion: null,
    });
    const workspace = workspaceFixture();
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n\nNo context version is available yet.",
        evidence: [],
        confidence: "low",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner);
    const taskWithoutContext: ClaimedAgentTask = {
      ...task,
      input: { question: "Find retry behavior" },
    };

    await expect(executor.execute(taskWithoutContext)).resolves.toEqual({
      output: {
        sourceId: 42,
        artifactUri:
          "file:///workspace/session-7/generated/research/task-501.md",
        confidence: "low",
      },
      contextVersionUsed: null,
      outputSourceId: 42,
      runtime: {
        provider: null,
        model: null,
        traceUri: null,
        outputArtifactUri:
          "file:///workspace/session-7/generated/research/task-501.md",
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
      },
    });

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ contextVersionUsed: null }),
    );
    expect(repository.createGeneratedResearchSource).toHaveBeenCalledWith(
      expect.objectContaining({ contextVersionUsed: null }),
    );
  });

  it("does not execute code research for archived sessions", async () => {
    const repository = repositoryFixture();
    repository.getSession.mockResolvedValue({
      id: 7,
      workspacePath: "/workspace/session-7",
      status: "archived",
      latestContextVersion: 9,
    });
    const workspace = workspaceFixture();
    const runner = { run: vi.fn() };
    const executor = new CodeResearchExecutor(repository, workspace, runner);

    await expect(executor.execute(task)).rejects.toThrow(
      "Compose session 7 was not found",
    );

    expect(repository.confirmAgentTaskLease).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    expect(workspace.writeArtifact).not.toHaveBeenCalled();
  });

  it("passes a task runtime cap to the research runner", async () => {
    const repository = repositoryFixture();
    const workspace = workspaceFixture();
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n",
        evidence: [],
        confidence: "medium",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner);
    const shortTask: ClaimedAgentTask = {
      ...task,
      input: { ...task.input, maxRuntimeSeconds: 45 },
    };

    await executor.execute(shortTask);

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({ maxRuntimeSeconds: 45 }),
    );
  });

  it("redacts generated research before writing artifacts or source rows", async () => {
    const repository = repositoryFixture();
    const workspace = workspaceFixture();
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n\nJIRA_TOKEN=abc123",
        evidence: [{ output: "password: hunter2" }],
        confidence: "postgres://user:pass@db.example.com/app",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner);

    await executor.execute(task);

    expect(workspace.writeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "# Research\n\nJIRA_TOKEN=[REDACTED]",
      }),
    );
    expect(repository.createGeneratedResearchSource).toHaveBeenCalledWith(
      expect.objectContaining({
        markdownContent: "# Research\n\nJIRA_TOKEN=[REDACTED]",
        evidence: [{ output: "password: [REDACTED]" }],
        confidence: "[REDACTED]",
      }),
    );
  });

  it("confirms the task lease before durable side effects", async () => {
    const repository = repositoryFixture();
    repository.confirmAgentTaskLease.mockResolvedValueOnce(true);
    repository.confirmAgentTaskLease.mockResolvedValueOnce(false);
    const workspace = workspaceFixture();
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n",
        evidence: [],
        confidence: "medium",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner);

    await expect(executor.execute(task)).rejects.toThrow(
      "agent_task_lease_lost",
    );

    expect(repository.confirmAgentTaskLease).toHaveBeenCalledWith({
      agentTaskId: 501,
      workerId: "agent-worker-a",
      leaseGeneration: 2,
    });
    expect(workspace.writeArtifact).not.toHaveBeenCalled();
    expect(repository.createGeneratedResearchSource).not.toHaveBeenCalled();
    expect(repository.createAgentTask).not.toHaveBeenCalled();
  });

  it("reuses an existing generated research source for the same task", async () => {
    const repository = repositoryFixture();
    repository.getGeneratedResearchSourceByTaskId.mockResolvedValue({
      id: 77,
      artifactUri: "file:///workspace/session-7/generated/research/existing.md",
      contextVersionUsed: 4,
    });
    const workspace = workspaceFixture();
    const runner = {
      run: vi.fn().mockResolvedValue({
        markdown: "# Research\n",
        evidence: [],
        confidence: "medium",
      }),
    };
    const executor = new CodeResearchExecutor(repository, workspace, runner, {
      enqueueDistillation: true,
    });

    await expect(executor.execute(task)).resolves.toEqual({
      output: {
        sourceId: 77,
        artifactUri:
          "file:///workspace/session-7/generated/research/existing.md",
        deduplicated: true,
      },
      contextVersionUsed: 4,
      outputSourceId: 77,
    });

    expect(runner.run).not.toHaveBeenCalled();
    expect(workspace.writeArtifact).not.toHaveBeenCalled();
    expect(repository.createGeneratedResearchSource).not.toHaveBeenCalled();
    expect(repository.createAgentTask).not.toHaveBeenCalled();
  });

  it("fails cleanly when the session no longer exists", async () => {
    const repository = repositoryFixture();
    repository.getSession.mockResolvedValue(null);
    const workspace = workspaceFixture();
    const runner = { run: vi.fn() };
    const executor = new CodeResearchExecutor(repository, workspace, runner);

    await expect(executor.execute(task)).rejects.toThrow(
      "Compose session 7 was not found",
    );
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe("ClaudeAgentSdkResearchRunner", () => {
  it("runs the SDK with read-only tools and scoped bash allowlist", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      structuredOutput: {
        markdown: "# Research\n\nFound it.",
        evidence: [{ file: "src/spec-factory/compose-service.ts" }],
        confidence: "medium",
      },
      output: "",
      metrics: { durationMs: 1, toolCalls: 2 },
    });
    const registerRepo = vi.fn().mockReturnValue("compose-research-7-501");
    const runner = new ClaudeAgentSdkResearchRunner(
      runAgent,
      registerRepo,
      "us.anthropic.test-model",
      1234,
    );

    await expect(
      runner.run({
        sessionId: 7,
        taskId: 501,
        capability: "code_research",
        question: "Find retry behavior",
        workspacePath: "/workspace/session-7",
        contextVersionUsed: 4,
        parentSourceIds: [],
        allowedTools: ["Read", "Grep", "Bash"],
        allowedBashCommandPatterns: ["^git status$"],
        maxTurns: 6,
        maxRuntimeSeconds: 6,
        maxCostUsd: 2,
        toolBudget: 30,
      }),
    ).resolves.toEqual({
      markdown: "# Research\n\nFound it.",
      evidence: [{ file: "src/spec-factory/compose-service.ts" }],
      confidence: "medium",
      runtime: {
        provider: "bedrock",
        model: "us.anthropic.test-model",
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
      },
    });

    expect(registerRepo).toHaveBeenCalledWith(
      "/workspace/session-7",
      "compose-research-7-501",
    );
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "compose-research-7-501",
        repoIds: ["compose-research-7-501"],
        agentType: "custom",
        sdkStage: "compose_code_research",
        permissionLevel: "read_only",
        allowWrite: false,
        timeoutMs: 1234,
        maxTurns: 6,
        maxBudgetUsd: 2,
        allowedTools: ["Read", "Grep", "Bash"],
        allowedBashCommandPatterns: ["^git status$"],
        toolGuard: "enabled",
        sdkTraceMode: "failure",
        toolBudgetGuard: { enabled: true, maxCalls: 30 },
      }),
    );
    const call = runAgent.mock.calls[0][0] as { systemAppend: string };
    expect(call.systemAppend).toContain("safe rg");
    expect(call.systemAppend).toContain("Grep");
  });

  it("uses capability-specific SDK stage and guidance for config research", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      structuredOutput: {
        markdown: "# Config Research\n\nFound deployment settings.",
        evidence: [{ file: "terraform/spec-factory-ecs.tf" }],
        confidence: "medium",
      },
      output: "",
      metrics: { durationMs: 1 },
    });
    const runner = new ClaudeAgentSdkResearchRunner(
      runAgent,
      vi.fn().mockReturnValue("compose-research-7-501"),
      "us.anthropic.test-model",
      1234,
    );

    await runner.run({
      sessionId: 7,
      taskId: 501,
      capability: "config_research",
      question: "Find deployed timeout configuration",
      workspacePath: "/workspace/session-7",
      contextVersionUsed: 4,
      parentSourceIds: [],
      allowedTools: ["Read", "Grep"],
      allowedBashCommandPatterns: [],
      maxTurns: 6,
      maxRuntimeSeconds: 6,
      maxCostUsd: 2,
      toolBudget: 30,
    });

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ sdkStage: "compose_config_research" }),
    );
    const call = runAgent.mock.calls[0][0] as { systemAppend: string };
    expect(call.systemAppend).toContain("configuration");
    expect(call.systemAppend).toContain("deployment");
  });

  it("caps the SDK timeout by the task max runtime", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      structuredOutput: {
        markdown: "# Research\n",
        evidence: [],
        confidence: "medium",
      },
      output: "",
    });
    const registerRepo = vi.fn().mockReturnValue("compose-research-7-501");
    const runner = new ClaudeAgentSdkResearchRunner(
      runAgent,
      registerRepo,
      "us.anthropic.test-model",
      30_000,
    );

    await runner.run({
      sessionId: 7,
      taskId: 501,
      capability: "code_research",
      question: "Find retry behavior",
      workspacePath: "/workspace/session-7",
      contextVersionUsed: 4,
      parentSourceIds: [],
      allowedTools: ["Read"],
      allowedBashCommandPatterns: [],
      maxTurns: 6,
      maxRuntimeSeconds: 2,
      maxCostUsd: 2,
      toolBudget: 30,
    });

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 2_000 }),
    );
  });

  it("returns structured partial research output when the SDK stops on a budget", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: false,
      error: "max budget exceeded",
      structuredOutput: {
        markdown: "# Research\n\nFound retry handling before stopping.",
        evidence: [{ file: "src/spec-factory/compose-service.ts" }],
        confidence: "partial",
      },
      output: "",
      metrics: {
        modelUsed: "us.anthropic.test-model",
        tokensUsed: { input: 100, output: 50 },
        costUsd: 2,
      },
    });
    const runner = new ClaudeAgentSdkResearchRunner(
      runAgent,
      vi.fn().mockReturnValue("compose-research-7-501"),
      "us.anthropic.test-model",
      30_000,
    );

    await expect(
      runner.run({
        sessionId: 7,
        taskId: 501,
        capability: "code_research",
        question: "Find retry behavior",
        workspacePath: "/workspace/session-7",
        contextVersionUsed: 4,
        parentSourceIds: [],
        allowedTools: ["Read"],
        allowedBashCommandPatterns: [],
        maxTurns: 6,
        maxRuntimeSeconds: 2,
        maxCostUsd: 2,
        toolBudget: 30,
      }),
    ).resolves.toEqual({
      markdown:
        "# Research\n\nFound retry handling before stopping.\n\n## Open questions\n\n- Research stopped before completion: max budget exceeded.",
      evidence: [{ file: "src/spec-factory/compose-service.ts" }],
      confidence: "partial",
      runtime: {
        provider: "bedrock",
        model: "us.anthropic.test-model",
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostUsd: 2,
      },
    });
  });

  it("registers the research executor only when enabled", () => {
    const repository = repositoryFixture();
    const workspace = workspaceFixture();
    const runner = { run: vi.fn() };

    expect(
      createResearchExecutorRegistry(repository, workspace, runner, {
        mode: "none",
      }).listExecutorTypes(),
    ).toEqual([]);
    expect(
      createResearchExecutorRegistry(repository, workspace, runner, {
        mode: "claude_agent_sdk",
      }).listExecutorTypes(),
    ).toEqual(["code_research"]);
  });
});
