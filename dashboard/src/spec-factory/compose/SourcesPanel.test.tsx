// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SourcesPanel } from "./SourcesPanel.js";
import type { ComposeSourceSummary } from "./composeTypes.js";

const cssPath = existsSync("dashboard/src/spec-factory/SpecFactoryPage.css")
  ? "dashboard/src/spec-factory/SpecFactoryPage.css"
  : "src/spec-factory/SpecFactoryPage.css";

const sources: ComposeSourceSummary[] = [
  {
    id: 1,
    sessionId: 7,
    kind: "file",
    originalFilename: "spec.pdf",
    conversionStatus: "converted",
    errorMessage: null,
    markdownContent: "# Spec\n\nBuild the export.",
  },
  {
    id: 2,
    sessionId: 7,
    kind: "file",
    originalFilename: "big.zip",
    conversionStatus: "converting",
    errorMessage: null,
    markdownContent: null,
  },
  {
    id: 3,
    sessionId: 7,
    kind: "youtube",
    originalFilename: "https://youtu.be/x",
    conversionStatus: "failed",
    errorMessage: "boom",
    markdownContent: null,
  },
];
const convertedSources: ComposeSourceSummary[] = [
  {
    id: 1,
    sessionId: 7,
    kind: "file",
    originalFilename: "spec.pdf",
    conversionStatus: "converted",
    errorMessage: null,
    markdownContent: "# Spec\n\nBuild the export.",
  },
];
function noop() {}

function renderPanel(
  overrides: Partial<Parameters<typeof SourcesPanel>[0]> = {},
) {
  return render(
    <SourcesPanel
      sources={sources}
      sourceDeletions={[]}
      onReconvert={noop}
      onReconvertFailed={noop}
      onDeleteSource={noop}
      onRestoreSource={noop}
      onOpenAddSources={noop}
      contextProjection={null}
      readiness={null}
      contextUpdating={false}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SourcesPanel", () => {
  it("renders source statuses while keeping the ready badge icon-only", () => {
    const { container } = renderPanel();
    expect(screen.getByText("PDF")).toBeTruthy();
    expect(screen.getByText("spec")).toBeTruthy();
    expect(screen.getByText("ZIP")).toBeTruthy();
    expect(screen.getByText("YT")).toBeTruthy();
    expect(screen.getByLabelText("Document: PDF")).toBeTruthy();
    expect(screen.getByLabelText("Video: YT")).toBeTruthy();
    expect(screen.queryByText(/^Ready$/i)).toBeNull();
    expect(
      container
        .querySelector(".sf-compose-source-state.is-converted")
        ?.getAttribute("aria-label"),
    ).toBe("Ready: Converted to markdown");
    expect(screen.getByText(/Processing/i)).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
  });

  it("uses one compact, labeled attention filter below source search", () => {
    renderPanel();

    expect(screen.getByRole("searchbox", { name: /Search sources/i })).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /Needs attention/i }),
    ).toHaveLength(1);
  });

  it("shows compact category and short description while collapsed", () => {
    renderPanel({
      sources: [
        {
          id: 1,
          sessionId: 7,
          kind: "jira",
          originalFilename:
            "CPSR-1048 FHIR + Core API | Use Case to persist review level decision rationale and mapping in FHIR.",
          conversionStatus: "converted",
          errorMessage: null,
          markdownContent: "# Jira",
        },
        {
          id: 2,
          sessionId: 7,
          kind: "file",
          originalFilename: "design-review-recording.m4a",
          conversionStatus: "converted",
          errorMessage: null,
          markdownContent: "# Audio",
        },
      ],
    });

    expect(screen.getByText("CPSR-1048: FHIR + Core API")).toBeTruthy();
    expect(screen.getByLabelText("JIRA: Jira")).toBeTruthy();
    expect(screen.queryByText("JIRA")).toBeNull();
    expect(screen.getByText("M4A")).toBeTruthy();
    expect(screen.getByText("design-review-recording")).toBeTruthy();
    expect(screen.queryByText(/Use Case to persist review level/i)).toBeNull();
  });

  it("distinguishes uploading, processing, and ready source card states", () => {
    const { container } = renderPanel({
      sources: [
        {
          id: 1,
          sessionId: 7,
          kind: "file",
          originalFilename: "uploading.docx",
          conversionStatus: "awaiting_upload",
          errorMessage: null,
          markdownContent: null,
        },
        {
          id: 2,
          sessionId: 7,
          kind: "confluence",
          originalFilename: "https://wiki.example.com/page",
          conversionStatus: "pending",
          errorMessage: null,
          markdownContent: null,
        },
        {
          id: 3,
          sessionId: 7,
          kind: "jira",
          originalFilename: "CPDEV-123",
          conversionStatus: "converted",
          errorMessage: null,
          markdownContent: "# Jira",
        },
      ],
    });

    expect(screen.getByText("Uploading")).toBeTruthy();
    expect(screen.getByText("Processing")).toBeTruthy();
    expect(screen.queryByText(/^Ready$/i)).toBeNull();
    expect(
      container
        .querySelector(".sf-compose-source-state.is-converted")
        ?.getAttribute("aria-label"),
    ).toBe("Ready: Converted to markdown");
  });

  it("shows Retry only on failed/unsupported sources and calls onReconvert", () => {
    const onReconvert = vi.fn();
    renderPanel({ onReconvert });
    fireEvent.click(
      screen.getByRole("button", {
        name: /Expand source https:\/\/youtu.be\/x/i,
      }),
    );
    const retry = screen.getByRole("button", { name: /Retry source/i });
    fireEvent.click(retry);
    expect(onReconvert).toHaveBeenCalledWith(3);
  });

  it("keeps source rows lean until the operator expands one", () => {
    renderPanel({ sources: convertedSources });

    expect(
      screen.queryByRole("button", {
        name: /Open markdown preview for spec.pdf/i,
      }),
    ).toBeNull();

    const row = screen.getByRole("button", { name: /Expand source spec.pdf/i });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);

    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(
      screen.getByRole("button", {
        name: /Open markdown preview for spec.pdf/i,
      }),
    ).toBeTruthy();
  });

  it("renders per-source intelligence only in expanded rows", () => {
    renderPanel({
      sources: [
        {
          id: 10,
          sessionId: 7,
          kind: "jira",
          originalFilename: "CPDEV-123 Medical Appeals",
          conversionStatus: "converted",
          errorMessage: null,
          markdownContent: "# CPDEV-123",
          sourceSummary: "Medical Appeals Case Creation",
          sourceUsefulness: "high_signal",
          sourceContribution:
            "High-signal source: Jira scope, repository context, file hints.",
          sourceEntities: {
            jiraKeys: ["CPDEV-123"],
            repositories: ["core-app"],
            files: ["AppealsController.java"],
            clients: ["BCBSRI"],
            loeHours: [24],
            dates: ["2026-06-30"],
            assumptions: ["Queue exists"],
          },
        },
      ],
    });

    expect(screen.getByText("Medical Appeals Case Creation")).toBeTruthy();
    expect(screen.queryByText("Source intelligence")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Expand source CPDEV-123 Medical Appeals/i,
      }),
    );
    const intelligence = screen.getByLabelText(
      /Source intelligence for CPDEV-123 Medical Appeals/i,
    );
    expect(within(intelligence).getByText("High signal")).toBeTruthy();
    expect(within(intelligence).getByText(/High-signal source/i)).toBeTruthy();
    const entities = within(intelligence).getByLabelText("Extracted entities");
    expect(within(entities).getByText("CPDEV-123")).toBeTruthy();
    expect(within(entities).getByText("core-app")).toBeTruthy();
    expect(within(entities).getByText("AppealsController.java")).toBeTruthy();
  });

  it("shows retry-all and conversion attempt detail for failed sources", () => {
    const onReconvertFailed = vi.fn();
    renderPanel({
      onReconvertFailed,
      sources: [
        {
          id: 3,
          sessionId: 7,
          kind: "youtube",
          originalFilename: "https://youtu.be/x",
          conversionStatus: "failed",
          conversionAttempts: 2,
          errorMessage: "SDK timeout after 30000ms",
          markdownContent: null,
        },
      ],
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: /Expand source https:\/\/youtu.be\/x/i,
      }),
    );
    expect(screen.getByText("youtube · Attempt 2")).toBeTruthy();
    expect(screen.getByText("Timed out")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /Retry failed \(1\)/i }),
    );
    expect(onReconvertFailed).toHaveBeenCalled();
  });

  it("opens a markdown preview modal and supports copy/download actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const createObjectURL = vi.fn().mockReturnValue("blob:markdown");
    const revokeObjectURL = vi.fn();
    const clickAnchor = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    });
    renderPanel({
      sources: [
        {
          id: 1,
          sessionId: 7,
          kind: "file",
          originalFilename: "spec.pdf",
          conversionStatus: "converted",
          errorMessage: null,
          markdownContent:
            "# Spec\n\n| Field | Value |\n| --- | --- |\n| Scope | **Build** the export. |",
        },
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Expand source spec.pdf/i }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /Open markdown preview for spec.pdf/i,
      }),
    );
    const dialog = screen.getByRole("dialog", { name: /Source Summary/i });
    expect(within(dialog).getByText("spec.pdf")).toBeTruthy();
    const table = within(dialog).getByRole("table");
    expect(
      within(table).getByRole("columnheader", { name: "Field" }),
    ).toBeTruthy();
    expect(
      within(table).getByRole("cell", { name: /Build the export/i }),
    ).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: /Copy markdown for spec.pdf/i,
      }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "# Spec\n\n| Field | Value |\n| --- | --- |\n| Scope | **Build** the export. |",
      ),
    );
    expect(within(dialog).getByText("Copied")).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: /Download markdown for spec.pdf/i,
      }),
    );
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(clickAnchor).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:markdown");
  });

  it("opens an image preview for uploaded PNG sources without markdown", async () => {
    const onGetSourcePreview = vi.fn().mockResolvedValue({
      url: "https://s3/get-screen.png",
      mimeType: "image/png",
      filename: "screen.png",
    });
    renderPanel({
      onGetSourcePreview,
      sources: [
        {
          id: 9,
          sessionId: 7,
          kind: "file",
          originalFilename: "screen.png",
          mimeType: "image/png",
          conversionStatus: "unsupported",
          errorMessage: null,
          markdownContent: null,
        },
      ],
    });

    fireEvent.click(
      screen.getByRole("button", { name: /Expand source screen.png/i }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /Open image preview for screen.png/i,
      }),
    );

    const dialog = screen.getByRole("dialog", { name: /Source Preview/i });
    const image = await within(dialog).findByAltText("screen.png");
    expect(image.getAttribute("src")).toBe("https://s3/get-screen.png");
    expect(onGetSourcePreview).toHaveBeenCalledWith(9);
  });

  it("confirms before deleting a source and explains recoverability", () => {
    const onDeleteSource = vi.fn();
    renderPanel({ onDeleteSource });

    fireEvent.click(
      screen.getByRole("button", { name: /Expand source spec.pdf/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Delete source spec.pdf/i }),
    );

    const dialog = screen.getByRole("dialog", { name: /Delete source/i });
    expect(
      within(dialog).getByText(/undo this action for a short time/i),
    ).toBeTruthy();

    fireEvent.click(
      within(dialog).getByRole("button", { name: /^Delete source$/i }),
    );
    expect(onDeleteSource).toHaveBeenCalledWith(1);
  });

  it("shows recently removed sources and restores the original on Undo", () => {
    const onRestoreSource = vi.fn();
    renderPanel({
      sourceDeletions: [
        {
          id: 801,
          sessionId: 7,
          sourceId: 21,
          sourceTitle: "requirements.md",
          status: "undoable",
          undoUntil: "2099-07-11T12:10:00.000Z",
          invalidatedSourceIds: [21, 22],
          invalidatedHandoffIds: [91],
          dependentSourceCount: 1,
          createdAt: "2026-07-11T12:00:00.000Z",
        },
      ],
      onRestoreSource,
    });

    const region = screen.getByRole("region", { name: /Recently removed/i });
    expect(within(region).getByText("requirements.md")).toBeTruthy();
    expect(
      within(region).getByText(/1 derived artifact removed/i),
    ).toBeTruthy();
    fireEvent.click(within(region).getByRole("button", { name: /Undo/i }));
    expect(onRestoreSource).toHaveBeenCalledWith(21);
  });

  it("does not show markdown preview actions for unconverted sources", () => {
    renderPanel();
    expect(
      screen.queryByRole("button", {
        name: /Open markdown preview for big.zip/i,
      }),
    ).toBeNull();
  });

  it("asks the workspace to open the Add sources overlay", () => {
    const onOpenAddSources = vi.fn();
    renderPanel({ sources: [], onOpenAddSources });
    fireEvent.click(screen.getByRole("button", { name: /Add source/i }));
    expect(onOpenAddSources).toHaveBeenCalled();
  });

  it("adds clipboard content as a source", () => {
    const onPasteSource = vi.fn();
    renderPanel({ sources: [], onPasteSource });
    fireEvent.click(
      screen.getByRole("button", { name: /Paste clipboard as a source/i }),
    );
    expect(onPasteSource).toHaveBeenCalledOnce();
  });

  it("shows empty state when no sources", () => {
    renderPanel({ sources: [] });
    expect(screen.getByText(/Saved sources will appear here/i)).toBeTruthy();
  });

  it("uses automatic analysis and does not expose implementation controls", () => {
    renderPanel({ sources: convertedSources });
    expect(
      screen.queryByRole("button", { name: /Analyze Sources/i }),
    ).toBeNull();
    expect(screen.queryByText("Code repositories")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Artifacts/i }));
    expect(screen.getByRole("region", { name: "Artifacts" })).toBeTruthy();
  });

  it("shows generated research and current requirements as artifacts", () => {
    renderPanel({
      sources: [
        ...convertedSources,
        {
          id: 22,
          sessionId: 7,
          kind: "generated_research",
          originalFilename: "code-research.md",
          conversionStatus: "converted",
          errorMessage: null,
          markdownContent: "# Research\n\nThe export flow exists.",
          contextVersionUsed: 3,
        },
      ],
      contextProjection: {
        sessionId: 7,
        version: 3,
        artifactUri: null,
        structuredArtifactUri: null,
        summary: {
          objective: "Improve exports",
          problemStatement: "Auditors cannot export billing records.",
          solution: "Provide a governed billing export.",
          businessRequirements: ["Auditors can complete billing reviews."],
          functionalRequirements: ["Authorized users can request an export."],
          challenges: [],
          stories: [],
          recommendedNextActions: [],
        },
        facts: [],
        openQuestions: [],
        conflicts: [],
        decisions: [],
        sourceIds: [1, 22],
        patchIds: [],
        committedAt: "t",
      },
    });
    fireEvent.click(screen.getByRole("tab", { name: /Artifacts/i }));
    expect(screen.getByText("Problem statement")).toBeTruthy();
    expect(screen.getByText("Business requirements")).toBeTruthy();
    expect(screen.getByText("code-research.md")).toBeTruthy();
  });

  it("keeps context artifacts visible when the session has no user sources", () => {
    renderPanel({
      sources: [],
      contextProjection: {
        sessionId: 7,
        version: 2,
        artifactUri: null,
        structuredArtifactUri: null,
        summary: {
          objective: "Clarify export policy",
          problemStatement: "Auditors cannot complete reviews without exports.",
          recommendedNextActions: [],
        },
        facts: [],
        openQuestions: [],
        conflicts: [],
        decisions: [],
        sourceIds: [],
        patchIds: [],
        committedAt: "t",
      },
    });

    expect(screen.getByText(/Saved sources will appear here/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Artifacts/i }));
    expect(screen.getByText("Problem statement")).toBeTruthy();
  });

  it("renders historical context artifacts from readiness and structured context", () => {
    renderPanel({
      sources: [],
      readiness: {
        ready: false,
        openQuestions: [],
        summary: "Make billing reviews self-service.",
        problem: "Auditors cannot obtain billing records without support.",
        ideating: "Provide a governed self-service export.",
      },
      contextProjection: {
        sessionId: 7,
        version: 8,
        artifactUri: "file:///context/working-context-v8.md",
        structuredArtifactUri: "file:///context/working-context-v8.json",
        summary: null,
        facts: [{ fact: "Billing exports are currently prepared manually." }],
        requirements: [
          { requirement: "Authorized auditors can request billing exports." },
        ],
        openQuestions: [],
        conflicts: [],
        decisions: [],
        sourceIds: [],
        patchIds: [],
        committedAt: "t",
      },
    });

    fireEvent.click(screen.getByRole("tab", { name: /Artifacts/i }));
    expect(screen.getByText("Problem statement")).toBeTruthy();
    expect(screen.getByText("Solution")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Working context v8/i }),
    );
    const dialog = screen.getByRole("dialog", {
      name: /Working context v8/i,
    });
    expect(
      within(dialog).getByText(
        "Auditors cannot obtain billing records without support.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Authorized auditors can request billing exports.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Billing exports are currently prepared manually.",
      ),
    ).toBeTruthy();
  });

  it("keeps collapsed source rows compact and roomy", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).toMatch(
      /\.sf-compose\s*\{[^}]*grid-template-columns:\s*minmax\(320px,\s*1\.05fr\)/s,
    );
    expect(css).toMatch(
      /\.sf-compose-source-row\s*\{[^}]*grid-template-columns:\s*max-content\s+minmax\(0,\s*1fr\)\s+24px\s+12px/s,
    );
    expect(css).toMatch(
      /\.sf-compose-source-kind\s*\{[^}]*max-width:\s*128px/s,
    );
    expect(css).toMatch(
      /\.sf-compose-source-state\.is-converted\s*\{[^}]*width:\s*24px/s,
    );
    expect(css).toMatch(/\.sf-compose-source-name\s*\{[^}]*font-size:\s*12px/s);
  });
});
