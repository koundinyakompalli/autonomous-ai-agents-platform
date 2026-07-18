import { describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  ComposeWorkspaceManager,
  assertComposeWorkspaceBaseReady,
} from "./compose-workspace.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "compose-ws-"));
}

describe("ComposeWorkspaceManager", () => {
  it("assertComposeWorkspaceBaseReady accepts an existing writable directory", async () => {
    const ws = await tmpDir();

    expect(() => assertComposeWorkspaceBaseReady(ws)).not.toThrow();

    await fs.rm(ws, { recursive: true, force: true });
  });

  it("assertComposeWorkspaceBaseReady rejects blank, missing, and file paths", async () => {
    const ws = await tmpDir();
    const filePath = path.join(ws, "not-a-dir");
    await fs.writeFile(filePath, "x", "utf8");

    expect(() => assertComposeWorkspaceBaseReady(" ")).toThrow(
      /COMPOSE_WORKSPACE_BASE is required/,
    );
    expect(() =>
      assertComposeWorkspaceBaseReady(path.join(ws, "missing")),
    ).toThrow(/must already exist/);
    expect(() => assertComposeWorkspaceBaseReady(filePath)).toThrow(
      /must be a directory/,
    );

    await fs.rm(ws, { recursive: true, force: true });
  });

  it("writes chat.md from messages and registers the workspace repo", async () => {
    const ws = await tmpDir();
    const register = vi.fn().mockReturnValue("compose_abc123");
    const mgr = new ComposeWorkspaceManager(register);

    const repoId = await mgr.prepare({
      workspacePath: ws,
      messages: [
        { role: "assistant", content: "Which repo?" },
        { role: "user", content: "billing-service" },
      ],
      contextMarkdown: "# Context\n\nBilling export.",
    });

    expect(repoId).toBe("compose_abc123");
    expect(register).toHaveBeenCalledWith(ws);

    const chat = await fs.readFile(path.join(ws, "chat.md"), "utf8");
    expect(chat).toContain("**assistant**: Which repo?");
    expect(chat).toContain("**user**: billing-service");

    const context = await fs.readFile(path.join(ws, "context.md"), "utf8");
    expect(context).toContain("Billing export.");
    const organizationalContext = await fs.readFile(
      path.join(ws, "mhk-organizational-context.md"),
      "utf8",
    );
    expect(organizationalContext).toContain("# MHK Organizational Context");

    await fs.rm(ws, { recursive: true, force: true });
  });

  it("does not write context.md when contextMarkdown is omitted", async () => {
    const ws = await tmpDir();
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"));
    await mgr.prepare({
      workspacePath: ws,
      messages: [],
      contextMarkdown: undefined,
    });
    await expect(
      fs.readFile(path.join(ws, "context.md"), "utf8"),
    ).rejects.toThrow();
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("writes selected repository context when provided", async () => {
    const ws = await tmpDir();
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"));

    await mgr.prepare({
      workspacePath: ws,
      messages: [],
      repositoryContextMarkdown:
        "# Selected code repositories\n\n- medhok-monorepo",
    });

    const repos = await fs.readFile(path.join(ws, "repositories.md"), "utf8");
    expect(repos).toContain("medhok-monorepo");

    await fs.rm(ws, { recursive: true, force: true });
  });

  it("materializes converted sources into sources files and a sources index", async () => {
    const ws = await tmpDir();
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"));

    await mgr.prepare({
      workspacePath: ws,
      messages: [],
      sources: [
        {
          sourceId: 12,
          filename: "billing notes.md",
          content: "Repo is billing-service.",
        },
        {
          sourceId: 13,
          filename: "workflow.docx",
          content: "Export invoice adjustments as CSV.",
        },
      ],
    });

    const first = await fs.readFile(
      path.join(ws, "sources", "12-billing_notes.md"),
      "utf8",
    );
    expect(first).toContain("billing-service");

    const second = await fs.readFile(
      path.join(ws, "sources", "13-workflow.docx.md"),
      "utf8",
    );
    expect(second).toContain("invoice adjustments");

    const index = await fs.readFile(path.join(ws, "sources-index.md"), "utf8");
    expect(index).toContain("12-billing_notes.md");
    expect(index).toContain("13-workflow.docx.md");

    await fs.rm(ws, { recursive: true, force: true });
  });

  it("writes a derived session manifest for the prepared workspace", async () => {
    const ws = await tmpDir();
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"));

    await mgr.prepare({
      sessionId: 123,
      workspacePath: ws,
      messages: [{ role: "user", content: "billing export" }],
      contextMarkdown: "# Context\n\nBilling.",
      repositoryContextMarkdown: "# Repositories\n\n- medhok-monorepo",
      sources: [
        {
          sourceId: 12,
          filename: "billing notes.md",
          content: "Repo is billing-service.",
        },
      ],
    });

    const manifest = JSON.parse(
      await fs.readFile(path.join(ws, "session-manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      sessionId: 123,
      workspacePath: ws,
      files: expect.arrayContaining([
        expect.objectContaining({
          path: "chat.md",
          kind: "chat",
          bytes: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          path: "context.md",
          kind: "context",
        }),
        expect.objectContaining({
          path: "repositories.md",
          kind: "repositories",
        }),
      ]),
      sourceInventory: [
        expect.objectContaining({
          sourceId: 12,
          filename: "12-billing_notes.md",
          path: "sources/12-billing_notes.md",
          bytes: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ],
      updatedAt: expect.any(String),
    });

    await fs.rm(ws, { recursive: true, force: true });
  });

  it("persists the derived session manifest through the optional durable sink", async () => {
    const ws = await tmpDir();
    const manifestStore = {
      upsertWorkspaceManifest: vi.fn().mockResolvedValue(undefined),
    };
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"), {
      manifestStore,
    });

    await mgr.prepare({
      sessionId: 123,
      workspacePath: ws,
      messages: [{ role: "user", content: "billing export" }],
      contextMarkdown: "# Context\n\nBilling.",
    });

    expect(manifestStore.upsertWorkspaceManifest).toHaveBeenCalledOnce();
    expect(manifestStore.upsertWorkspaceManifest).toHaveBeenCalledWith({
      sessionId: 123,
      workspacePath: ws,
      manifestJson: expect.objectContaining({
        manifestVersion: 1,
        sessionId: 123,
        workspacePath: ws,
      }),
      manifestBytes: expect.any(Number),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    await fs.rm(ws, { recursive: true, force: true });
  });

  it("backfills a version-1 workspace manifest into verified immutable artifacts", async () => {
    const ws = await tmpDir();
    const content = Buffer.from("# Conversation\n\nHello\n", "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    await fs.writeFile(path.join(ws, "chat.md"), content);
    const manifestStore = {
      getWorkspaceManifest: vi.fn().mockResolvedValue({
        manifestVersion: 1,
        sessionId: 123,
        workspacePath: ws,
        files: [
          {
            path: "chat.md",
            kind: "chat",
            bytes: content.byteLength,
            sha256,
          },
        ],
        sourceInventory: [],
        updatedAt: "2026-07-13T00:00:00.000Z",
      }),
      upsertWorkspaceManifest: vi.fn().mockResolvedValue(undefined),
    };
    const artifactStore = {
      write: vi.fn().mockResolvedValue({
        artifactUri: `s3://artifacts/${sha256}/chat.md`,
        bytes: content.byteLength,
        sha256,
      }),
      read: vi.fn(),
    };
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"), {
      manifestStore,
      artifactStore,
    });

    const result = await mgr.backfillImmutableManifest({
      sessionId: 123,
      workspacePath: ws,
    });

    expect(result).toMatchObject({
      sessionId: 123,
      manifestVersion: 2,
      fileCount: 1,
      migratedFileCount: 1,
      reusedFileCount: 0,
    });
    expect(artifactStore.write).toHaveBeenCalledWith({
      workspacePath: ws,
      relativePath: "chat.md",
      content,
    });
    expect(manifestStore.upsertWorkspaceManifest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 123,
        workspacePath: ws,
        manifestJson: expect.objectContaining({
          manifestVersion: 2,
          files: [
            expect.objectContaining({
              path: "chat.md",
              artifactUri: `s3://artifacts/${sha256}/chat.md`,
            }),
          ],
        }),
      }),
    );
    const localManifest = JSON.parse(
      await fs.readFile(path.join(ws, "session-manifest.json"), "utf8"),
    );
    expect(localManifest.manifestVersion).toBe(2);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("hydrates a complete immutable manifest without touching the durable path", async () => {
    const base = await tmpDir();
    const durable = path.join(base, "missing-durable-workspace");
    const scratch = await tmpDir();
    const content = Buffer.from("# Context\n\nImmutable.\n", "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const artifactUri = `s3://artifacts/${sha256}/context.md`;
    const manifestStore = {
      getWorkspaceManifest: vi.fn().mockResolvedValue({
        manifestVersion: 2,
        sessionId: 7,
        workspacePath: durable,
        files: [
          {
            path: "context.md",
            kind: "context",
            bytes: content.byteLength,
            sha256,
            artifactUri,
          },
        ],
        sourceInventory: [],
        updatedAt: "2026-07-13T00:00:00.000Z",
      }),
      upsertWorkspaceManifest: vi.fn(),
    };
    const artifactStore = {
      write: vi.fn(),
      read: vi.fn().mockResolvedValue(content),
    };
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"), {
      scratchBase: scratch,
      manifestStore,
      artifactStore,
    });

    const attached = await mgr.attach({
      sessionId: 7,
      durableWorkspacePath: durable,
      purpose: "code_research",
      taskId: 91,
    });

    await expect(fs.stat(durable)).rejects.toThrow();
    await expect(
      fs.readFile(path.join(attached.localWorkspacePath, "context.md"), "utf8"),
    ).resolves.toBe(content.toString("utf8"));
    expect(artifactStore.read).toHaveBeenCalledWith(artifactUri);
    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it("rejects a backfill when the durable file no longer matches its manifest", async () => {
    const ws = await tmpDir();
    await fs.writeFile(path.join(ws, "chat.md"), "changed", "utf8");
    const manifestStore = {
      getWorkspaceManifest: vi.fn().mockResolvedValue({
        manifestVersion: 1,
        sessionId: 9,
        workspacePath: ws,
        files: [
          {
            path: "chat.md",
            kind: "chat",
            bytes: 8,
            sha256: "a".repeat(64),
          },
        ],
        sourceInventory: [],
        updatedAt: "2026-07-13T00:00:00.000Z",
      }),
      upsertWorkspaceManifest: vi.fn(),
    };
    const artifactStore = { write: vi.fn(), read: vi.fn() };
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"), {
      manifestStore,
      artifactStore,
    });

    await expect(
      mgr.backfillImmutableManifest({ sessionId: 9, workspacePath: ws }),
    ).rejects.toThrow("workspace_manifest_verification_failed:chat.md");
    expect(artifactStore.write).not.toHaveBeenCalled();
    expect(manifestStore.upsertWorkspaceManifest).not.toHaveBeenCalled();
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("rejects unsafe workspace roots before reading local files", async () => {
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"), {
      manifestStore: {
        getWorkspaceManifest: vi.fn(),
        upsertWorkspaceManifest: vi.fn(),
      },
      artifactStore: { write: vi.fn(), read: vi.fn() },
    });

    await expect(
      mgr.backfillImmutableManifest({ sessionId: 9, workspacePath: "." }),
    ).rejects.toThrow("workspace_manifest_backfill_unsafe_workspace_path");
  });

  it("attaches a durable workspace into local scratch and detaches it", async () => {
    const durable = await tmpDir();
    const scratch = await tmpDir();
    await fs.mkdir(path.join(durable, "sources"), { recursive: true });
    await fs.writeFile(path.join(durable, "chat.md"), "# Chat\n", "utf8");
    await fs.writeFile(
      path.join(durable, "sources", "12-notes.md"),
      "Billing notes",
      "utf8",
    );
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"), {
      scratchBase: scratch,
    });

    const attached = await mgr.attach({
      sessionId: 7,
      durableWorkspacePath: durable,
      purpose: "context merge",
      taskId: 501,
    });

    expect(attached).toMatchObject({
      sessionId: 7,
      durableWorkspacePath: durable,
      purpose: "context merge",
      taskId: 501,
    });
    await expect(
      fs.readFile(
        path.join(attached.localWorkspacePath, "mhk-organizational-context.md"),
        "utf8",
      ),
    ).resolves.toContain("# MHK Organizational Context");
    expect(attached.localWorkspacePath).toContain(
      path.join(scratch, "7", "context_merge-501-"),
    );
    await expect(
      fs.readFile(path.join(attached.localWorkspacePath, "chat.md"), "utf8"),
    ).resolves.toContain("# Chat");
    await expect(
      fs.readFile(
        path.join(attached.localWorkspacePath, "sources", "12-notes.md"),
        "utf8",
      ),
    ).resolves.toContain("Billing notes");
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(attached.localWorkspacePath, ".workspace-attach.json"),
        "utf8",
      ),
    );
    expect(metadata).toMatchObject({
      sessionId: 7,
      durableWorkspacePath: durable,
      localWorkspacePath: attached.localWorkspacePath,
      purpose: "context merge",
      taskId: 501,
      attachedAt: expect.any(String),
    });

    await mgr.detach(attached);
    await expect(fs.stat(attached.localWorkspacePath)).rejects.toThrow();
    await fs.rm(durable, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it("attaches grounded repositories to research scratch with a manifest", async () => {
    const scratch = await tmpDir();
    const repository = await tmpDir();
    await fs.writeFile(path.join(repository, "package.json"), "{}", "utf8");
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"));

    await mgr.attachRepositories({
      workspacePath: scratch,
      repositories: [
        {
          repoName: "billing-service",
          workspacePath: repository,
          headSha: "abc123",
        },
      ],
    });

    const link = path.join(scratch, "repos", "billing-service");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(link)).toBe(await fs.realpath(repository));
    await expect(
      fs.readFile(path.join(link, "package.json"), "utf8"),
    ).resolves.toBe("{}");
    await expect(
      fs.readFile(path.join(scratch, "research-repositories.json"), "utf8"),
    ).resolves.toContain('"headSha": "abc123"');

    await fs.rm(scratch, { recursive: true, force: true });
    await fs.rm(repository, { recursive: true, force: true });
  });

  it("attaches an empty local workspace when missing durable storage is explicitly allowed", async () => {
    const base = await tmpDir();
    const durable = path.join(base, "missing-session");
    const scratch = await tmpDir();
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"), {
      scratchBase: scratch,
    });

    const attached = await mgr.attach({
      sessionId: 72,
      durableWorkspacePath: durable,
      purpose: "code_research",
      taskId: 2,
      allowMissingDurableWorkspace: true,
    });

    expect(attached.localWorkspacePath).toContain(
      path.join(scratch, "72", "code_research-2-"),
    );
    const durableStats = await fs.stat(durable);
    expect(durableStats.isDirectory()).toBe(true);
    await expect(fs.readdir(attached.localWorkspacePath)).resolves.toEqual([
      ".workspace-attach.json",
      "mhk-organizational-context.md",
    ]);
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(attached.localWorkspacePath, ".workspace-attach.json"),
        "utf8",
      ),
    );
    expect(metadata).toMatchObject({
      sessionId: 72,
      durableWorkspacePath: durable,
      localWorkspacePath: attached.localWorkspacePath,
      purpose: "code_research",
      taskId: 2,
    });

    await fs.rm(base, { recursive: true, force: true });
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it("cleanupLocal removes only the selected session scratch directory", async () => {
    const scratch = await tmpDir();
    await fs.mkdir(path.join(scratch, "7", "task-a"), { recursive: true });
    await fs.mkdir(path.join(scratch, "8", "task-b"), { recursive: true });
    await fs.writeFile(path.join(scratch, "7", "task-a", "x"), "x", "utf8");
    await fs.writeFile(path.join(scratch, "8", "task-b", "y"), "y", "utf8");
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"), {
      scratchBase: scratch,
    });

    await mgr.cleanupLocal(7);

    await expect(fs.stat(path.join(scratch, "7"))).rejects.toThrow();
    await expect(
      fs.readFile(path.join(scratch, "8", "task-b", "y"), "utf8"),
    ).resolves.toBe("y");
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it("writeArtifact writes through a temp file and returns verified metadata", async () => {
    const ws = await tmpDir();
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"));

    const artifact = await mgr.writeArtifact({
      workspacePath: ws,
      relativePath: "artifacts/research-501.md",
      content: "# Research\n\nBilling rules.",
    });

    expect(artifact).toEqual({
      artifactUri: `file://${path.join(ws, "artifacts", "research-501.md")}`,
      relativePath: "artifacts/research-501.md",
      bytes: Buffer.byteLength("# Research\n\nBilling rules.", "utf8"),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(
      fs.readFile(path.join(ws, "artifacts", "research-501.md"), "utf8"),
    ).resolves.toBe("# Research\n\nBilling rules.");
    await expect(fs.readdir(path.join(ws, ".tmp"))).resolves.toEqual([]);

    await fs.rm(ws, { recursive: true, force: true });
  });

  it("writeArtifact rejects paths outside the workspace", async () => {
    const ws = await tmpDir();
    const mgr = new ComposeWorkspaceManager(vi.fn().mockReturnValue("r"));

    await expect(
      mgr.writeArtifact({
        workspacePath: ws,
        relativePath: "../escape.md",
        content: "bad",
      }),
    ).rejects.toThrow(/relativePath must stay inside the workspace/);

    await fs.rm(ws, { recursive: true, force: true });
  });
});
