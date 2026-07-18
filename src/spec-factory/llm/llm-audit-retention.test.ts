import { describe, expect, it, vi } from "vitest";
import { LlmAuditArtifactRetentionCleaner } from "./llm-audit-retention.js";

function buildCleaner() {
  const repository = {
    listAuditArtifactsForRetention: vi.fn().mockResolvedValue([
      {
        id: 7,
        redactedPromptUri: "file:///audit/llm/7/prompt.txt",
        redactedResponseUri: "file:///audit/llm/7/response.txt",
      },
    ]),
    clearAuditArtifactUris: vi.fn().mockResolvedValue(1),
  };
  const fs = {
    rm: vi.fn().mockResolvedValue(undefined),
  };
  return {
    cleaner: new LlmAuditArtifactRetentionCleaner(
      repository,
      "/audit/llm",
      fs,
    ),
    repository,
    fs,
  };
}

describe("LlmAuditArtifactRetentionCleaner", () => {
  it("dry-runs old audit artifacts without deleting or clearing DB URIs", async () => {
    const { cleaner, repository, fs } = buildCleaner();

    const result = await cleaner.cleanupAuditArtifacts({
      olderThanDays: 14,
      limit: 20,
      dryRun: true,
      now: new Date("2026-07-06T00:00:00.000Z"),
    });

    expect(repository.listAuditArtifactsForRetention).toHaveBeenCalledWith({
      createdBefore: new Date("2026-06-22T00:00:00.000Z"),
      limit: 20,
    });
    expect(fs.rm).not.toHaveBeenCalled();
    expect(repository.clearAuditArtifactUris).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      inspected: 1,
      cleaned: 0,
      wouldClean: 1,
      deletedArtifacts: 0,
      failed: 0,
      skippedUnsupported: 0,
    });
  });

  it("deletes configured-root file artifacts and clears the audit row", async () => {
    const { cleaner, repository, fs } = buildCleaner();

    const result = await cleaner.cleanupAuditArtifacts({
      now: new Date("2026-07-06T00:00:00.000Z"),
    });

    expect(fs.rm).toHaveBeenCalledWith("/audit/llm/7/prompt.txt", {
      force: true,
    });
    expect(fs.rm).toHaveBeenCalledWith("/audit/llm/7/response.txt", {
      force: true,
    });
    expect(repository.clearAuditArtifactUris).toHaveBeenCalledWith(7);
    expect(result.cleaned).toBe(1);
    expect(result.deletedArtifacts).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("does not clear DB URIs when a file artifact is outside the configured root", async () => {
    const { cleaner, repository, fs } = buildCleaner();
    repository.listAuditArtifactsForRetention.mockResolvedValueOnce([
      {
        id: 8,
        redactedPromptUri: "file:///audit/llm/8/prompt.txt",
        redactedResponseUri: "file:///etc/passwd",
      },
    ]);

    const result = await cleaner.cleanupAuditArtifacts();

    expect(fs.rm).not.toHaveBeenCalled();
    expect(repository.clearAuditArtifactUris).not.toHaveBeenCalled();
    expect(result.cleaned).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.failures[0]).toMatchObject({
      auditCallId: 8,
      errorMessage: expect.stringContaining("outside audit artifact base"),
    });
  });

  it("skips non-file artifact URIs without clearing them", async () => {
    const { cleaner, repository, fs } = buildCleaner();
    repository.listAuditArtifactsForRetention.mockResolvedValueOnce([
      {
        id: 9,
        redactedPromptUri: "s3://bucket/audit/9/prompt.txt",
        redactedResponseUri: null,
      },
    ]);

    const result = await cleaner.cleanupAuditArtifacts();

    expect(fs.rm).not.toHaveBeenCalled();
    expect(repository.clearAuditArtifactUris).not.toHaveBeenCalled();
    expect(result.skippedUnsupported).toBe(1);
    expect(result.cleaned).toBe(0);
  });
});
