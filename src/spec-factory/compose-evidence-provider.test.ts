import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { ComposeEvidenceProvider } from "./compose-evidence-provider.js";

describe("ComposeEvidenceProvider", () => {
  it("builds an EvidenceManifest from the session's sources", async () => {
    const composeRepository = {
      findSessionBySourceId: vi.fn().mockResolvedValue({
        id: 5,
        name: "Billing export",
        sourceId: 41,
      }),
      listSessionSourceContents: vi.fn().mockResolvedValue([
        { filename: "chat.md", content: "We need CSV export for billing-service." },
      ]),
    };
    const specRepository = {
      getSourceById: vi.fn().mockResolvedValue({
        id: 41,
        sourceJiraKey: "COMPOSE-5",
        sourceSummary: "Billing export",
      }),
    };

    const provider = new ComposeEvidenceProvider(
      composeRepository as never,
      specRepository as never,
    );

    const manifest = await provider.collect(41);

    expect(manifest.sourceJiraKey).toBe("COMPOSE-5");
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0].content).toContain("CSV export");
    expect(composeRepository.findSessionBySourceId).toHaveBeenCalledWith(41);
  });

  it("throws when no compose session is linked to the source", async () => {
    const composeRepository = {
      findSessionBySourceId: vi.fn().mockResolvedValue(null),
      listSessionSourceContents: vi.fn(),
    };
    const specRepository = { getSourceById: vi.fn() };
    const provider = new ComposeEvidenceProvider(
      composeRepository as never,
      specRepository as never,
    );

    await expect(provider.collect(999)).rejects.toThrow(/compose session/i);
  });

  it("includes workspace context, source index, chat, and converted source bodies", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "compose-evidence-"));
    await fs.writeFile(path.join(workspacePath, "context.md"), "# Context\n\nReady summary.", "utf8");
    await fs.writeFile(path.join(workspacePath, "sources-index.md"), "# Sources\n\n- 21-requirements.docx.md", "utf8");
    await fs.writeFile(path.join(workspacePath, "chat.md"), "# Conversation\n\n**user**: billing-service\n\n**assistant**: Ready.", "utf8");

    const composeRepository = {
      findSessionBySourceId: vi.fn().mockResolvedValue({
        id: 5,
        name: "Billing export",
        sourceId: 41,
        workspacePath,
      }),
      listSessionSourceContents: vi.fn().mockResolvedValue([
        {
          sourceId: 21,
          filename: "requirements.docx",
          content: "Build CSV export for billing-service.",
        },
      ]),
    };
    const specRepository = {
      getSourceById: vi.fn().mockResolvedValue({
        id: 41,
        sourceJiraKey: "COMPOSE-5",
        sourceSummary: "Billing export",
      }),
    };
    const provider = new ComposeEvidenceProvider(
      composeRepository as never,
      specRepository as never,
    );

    const manifest = await provider.collect(41);

    expect(manifest.artifacts.map((a) => a.filename)).toEqual([
      "context.md",
      "sources-index.md",
      "chat.md",
      "requirements.docx",
    ]);
    expect(manifest.descriptionMarkdown).toContain("Ready summary");
    expect(manifest.descriptionMarkdown).toContain("billing-service");
    expect(manifest.descriptionMarkdown).toContain("Build CSV export");

    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  it("carries the session's readiness.stories onto the evidence manifest", async () => {
    const composeRepo = {
      findSessionBySourceId: vi.fn().mockResolvedValue({
        id: 5,
        workspacePath: null,
        readiness: {
          ready: false,
          openQuestions: [],
          summary: "s",
          stories: [
            { id: "story-1", title: "A", summary: "a", sequence: 1 },
            { id: "story-2", title: "B", summary: "b", sequence: 2 },
          ],
        },
      }),
      listSessionSourceContents: vi
        .fn()
        .mockResolvedValue([
          { sourceId: 1, filename: "note.md", content: "hello" },
        ]),
    };
    const specRepo = {
      getSourceById: vi.fn().mockResolvedValue({
        sourceJiraKey: "COMPOSE-5",
        sourceSummary: "Guided QA",
      }),
    };
    const provider = new ComposeEvidenceProvider(
      composeRepo as never,
      specRepo as never,
    );

    const manifest = await provider.collect(42);

    expect(manifest.composeStories).toHaveLength(2);
    expect(manifest.composeStories?.[0]).toMatchObject({
      id: "story-1",
      title: "A",
    });
  });
});
