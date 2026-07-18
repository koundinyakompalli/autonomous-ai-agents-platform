import { describe, expect, it, vi } from "vitest";
import {
  ComposeHardDeleteService,
  type ComposeHardDeleteRepository,
} from "./compose-hard-delete.js";

function repository(): ComposeHardDeleteRepository {
  return {
    getHardDeletePlan: vi.fn().mockResolvedValue({
      sessionId: 7,
      status: "archived",
      archivedAt: "2026-07-01T00:00:00.000Z",
      linkedSourceId: 55,
      s3Prefix: "compose/7/",
      workspacePath: "/workspaces/compose/7",
      rowCounts: {
        compose_session_events: 1,
        compose_stream_tokens: 1,
        compose_turn_jobs: 1,
        compose_turn_outputs: 1,
        compose_agent_tasks: 1,
        compose_context_patches: 1,
        compose_context_versions: 1,
        compose_session_messages: 1,
        compose_session_sources: 1,
        spec_factory_llm_calls: 1,
        compose_sessions: 1,
      },
      artifactUris: [
        "s3://bucket/compose/7/generated/research.md",
        "file:///workspaces/compose/7/context/v1.md",
      ],
    }),
    hardDeleteArchivedSession: vi.fn().mockResolvedValue({
      sessionId: 7,
      deletedRows: { compose_sessions: 1 },
    }),
  };
}

describe("ComposeHardDeleteService", () => {
  it("dry-runs by default without deleting artifacts or rows", async () => {
    const repo = repository();
    const objectStore = { deletePrefix: vi.fn() };
    const fs = { rm: vi.fn() };
    const service = new ComposeHardDeleteService(repo, fs, objectStore);

    const result = await service.hardDeleteSession({ sessionId: 7 });

    expect(result.dryRun).toBe(true);
    expect(result.plan.sessionId).toBe(7);
    expect(objectStore.deletePrefix).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
    expect(repo.hardDeleteArchivedSession).not.toHaveBeenCalled();
  });

  it("requires an exact confirmation token for destructive deletion", async () => {
    const repo = repository();
    const service = new ComposeHardDeleteService(repo, { rm: vi.fn() });

    await expect(
      service.hardDeleteSession({
        sessionId: 7,
        dryRun: false,
        confirm: "delete-session:8",
      }),
    ).rejects.toThrow("compose_hard_delete_confirmation_required");
  });

  it("deletes S3 prefix and workspace before deleting archived rows", async () => {
    const repo = repository();
    const objectStore = { deletePrefix: vi.fn().mockResolvedValue(3) };
    const fs = { rm: vi.fn().mockResolvedValue(undefined) };
    const service = new ComposeHardDeleteService(repo, fs, objectStore);

    const result = await service.hardDeleteSession({
      sessionId: 7,
      dryRun: false,
      confirm: "delete-session:7",
    });

    expect(objectStore.deletePrefix).toHaveBeenCalledWith("compose/7/");
    expect(fs.rm).toHaveBeenCalledWith("/workspaces/compose/7", {
      recursive: true,
      force: true,
    });
    expect(repo.hardDeleteArchivedSession).toHaveBeenCalledWith(7);
    expect(result).toMatchObject({
      dryRun: false,
      deletedObjects: 3,
      workspaceDeleted: true,
      db: { sessionId: 7 },
    });
  });

  it("allows configured LLM audit artifacts and deletes their files", async () => {
    const repo = repository();
    vi.mocked(repo.getHardDeletePlan).mockResolvedValueOnce({
      ...(await repo.getHardDeletePlan(7)),
      artifactUris: [
        "file:///workspaces/compose/7/context/v1.md",
        "file:///var/spec-factory/llm-audit/session-7/prompt.json",
        "file:///var/spec-factory/llm-audit/session-7/response.json",
      ],
    });
    const objectStore = { deletePrefix: vi.fn().mockResolvedValue(0) };
    const fs = { rm: vi.fn().mockResolvedValue(undefined) };
    const service = new ComposeHardDeleteService(repo, fs, objectStore);

    const result = await service.hardDeleteSession({
      sessionId: 7,
      dryRun: false,
      confirm: "delete-session:7",
      auditArtifactBasePath: "/var/spec-factory/llm-audit",
    });

    expect(result.uncoveredArtifactUris).toEqual([]);
    expect(fs.rm).toHaveBeenCalledWith(
      "/var/spec-factory/llm-audit/session-7/prompt.json",
      { recursive: false, force: true },
    );
    expect(fs.rm).toHaveBeenCalledWith(
      "/var/spec-factory/llm-audit/session-7/response.json",
      { recursive: false, force: true },
    );
    expect(fs.rm).toHaveBeenCalledWith("/workspaces/compose/7", {
      recursive: true,
      force: true,
    });
    expect(repo.hardDeleteArchivedSession).toHaveBeenCalledWith(7);
  });

  it("ignores validated source-purge tombstones during hard deletion", async () => {
    const repo = repository();
    vi.mocked(repo.getHardDeletePlan).mockResolvedValueOnce({
      ...(await repo.getHardDeletePlan(7)),
      artifactUris: [
        "purged://source-deletion/42/revision/101",
        "purged://source-deletion/42/chunk/202",
      ],
    });
    const objectStore = { deletePrefix: vi.fn().mockResolvedValue(0) };
    const fs = { rm: vi.fn().mockResolvedValue(undefined) };
    const service = new ComposeHardDeleteService(repo, fs, objectStore);

    const result = await service.hardDeleteSession({
      sessionId: 7,
      dryRun: false,
      confirm: "delete-session:7",
    });

    expect(result.uncoveredArtifactUris).toEqual([]);
    expect(repo.hardDeleteArchivedSession).toHaveBeenCalledWith(7);
  });

  it("rejects malformed source-purge tombstones", async () => {
    const repo = repository();
    vi.mocked(repo.getHardDeletePlan).mockResolvedValueOnce({
      ...(await repo.getHardDeletePlan(7)),
      artifactUris: ["purged://source-deletion/not-a-valid-tombstone"],
    });
    const service = new ComposeHardDeleteService(repo, { rm: vi.fn() });

    await expect(
      service.hardDeleteSession({
        sessionId: 7,
        dryRun: false,
        confirm: "delete-session:7",
      }),
    ).rejects.toThrow("compose_hard_delete_uncovered_artifact_uri");

    expect(repo.hardDeleteArchivedSession).not.toHaveBeenCalled();
  });

  it("deletes content-addressed S3 artifacts recorded outside the upload prefix", async () => {
    const repo = repository();
    vi.mocked(repo.getHardDeletePlan).mockResolvedValueOnce({
      ...(await repo.getHardDeletePlan(7)),
      artifactUris: [
        "s3://bucket/compose/7/raw/source.pdf",
        "s3://bucket/spec-factory/workspaces/abc/sha256/12/artifact.json",
      ],
    });
    const objectStore = {
      deletePrefix: vi.fn().mockResolvedValue(2),
      deleteArtifactUris: vi.fn().mockResolvedValue(1),
    };
    const service = new ComposeHardDeleteService(
      repo,
      { rm: vi.fn().mockResolvedValue(undefined) },
      objectStore,
    );

    const result = await service.hardDeleteSession({
      sessionId: 7,
      dryRun: false,
      confirm: "delete-session:7",
    });

    expect(objectStore.deleteArtifactUris).toHaveBeenCalledWith([
      "s3://bucket/spec-factory/workspaces/abc/sha256/12/artifact.json",
    ]);
    expect(result.deletedObjects).toBe(3);
  });

  it("fails closed when an artifact URI is outside the session roots", async () => {
    const repo = repository();
    vi.mocked(repo.getHardDeletePlan).mockResolvedValueOnce({
      ...(await repo.getHardDeletePlan(7)),
      artifactUris: ["s3://bucket/other-session/leak.md"],
    });
    const service = new ComposeHardDeleteService(repo, { rm: vi.fn() });

    await expect(
      service.hardDeleteSession({
        sessionId: 7,
        dryRun: false,
        confirm: "delete-session:7",
      }),
    ).rejects.toThrow("compose_hard_delete_uncovered_artifact_uri");

    expect(repo.hardDeleteArchivedSession).not.toHaveBeenCalled();
  });

  it("refuses unsafe workspace roots before destructive deletion", async () => {
    const repo = repository();
    vi.mocked(repo.getHardDeletePlan).mockResolvedValueOnce({
      ...(await repo.getHardDeletePlan(7)),
      workspacePath: "/",
      artifactUris: [],
    });
    const objectStore = { deletePrefix: vi.fn() };
    const service = new ComposeHardDeleteService(
      repo,
      { rm: vi.fn() },
      objectStore,
    );

    await expect(
      service.hardDeleteSession({
        sessionId: 7,
        dryRun: false,
        confirm: "delete-session:7",
      }),
    ).rejects.toThrow("compose_hard_delete_unsafe_workspace_path");

    expect(objectStore.deletePrefix).not.toHaveBeenCalled();
    expect(repo.hardDeleteArchivedSession).not.toHaveBeenCalled();
  });
});
