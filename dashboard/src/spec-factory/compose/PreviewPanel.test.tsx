// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { PreviewPanel } from "./PreviewPanel.js";

const cssPath = existsSync("dashboard/src/spec-factory/SpecFactoryPage.css")
  ? "dashboard/src/spec-factory/SpecFactoryPage.css"
  : "src/spec-factory/SpecFactoryPage.css";

describe("PreviewPanel", () => {
  afterEach(cleanup);

  it("shows readiness and delivery details together in the summary", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: ["Which roles need access?", "What is in scope?"],
          summary: "Need more info.",
          details: {
            module: "Platform",
            repositories: ["core-app", "interop"],
            difficulty: "M",
            loeHours: 24,
            storyPoints: 5,
          },
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    const summary = screen.getByLabelText(/Readiness summary/i);
    expect(summary).toBeTruthy();

    const details = within(summary).getByLabelText("Delivery profile");
    expect(within(details).getByText("Platform")).toBeTruthy();
    expect(within(details).getByText("M")).toBeTruthy();
    expect(within(details).getByText("24h")).toBeTruthy();
    expect(within(details).getByText("5")).toBeTruthy();
    expect(within(details).getByText("core-app, interop")).toBeTruthy();

    const checklist = screen.getByRole("list", { name: /Questions for you/i });
    expect(
      within(checklist).getByText("Which roles need access?"),
    ).toBeTruthy();
    expect(within(checklist).getByText("What is in scope?")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /Activity/i }));
    const activity = screen.getByRole("article", { name: "Activity" });
    expect(within(activity).queryByLabelText("Delivery profile")).toBeNull();
  });

  it("keeps the compose preview body single-column instead of inheriting modal layout", () => {
    const css = readFileSync(cssPath, "utf8");
    expect(css).not.toMatch(
      /(?:^|\n)\.sf-preview-body\s*\{[^}]*grid-template-columns/s,
    );
    expect(css).toMatch(
      /\.sf-preview-modal\s+\.sf-preview-body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+330px/s,
    );
  });

  it("labels the button from authoritative draft and Epic workflow state", () => {
    const { rerender } = render(
      <PreviewPanel
        readiness={{ ready: false, openQuestions: ["q"], summary: "s" }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Draft anyway/i })).toBeTruthy();
    rerender(
      <PreviewPanel
        readiness={{ ready: true, openQuestions: [], summary: "Ready." }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Generate Draft" })).toBeTruthy();
    rerender(
      <PreviewPanel
        readiness={{ ready: true, openQuestions: [], summary: "Ready." }}
        handingOff={false}
        generatedSourceId={88}
        draftReady
        onGenerate={vi.fn()}
        onViewEpic={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Review draft/i })).toBeTruthy();
    rerender(
      <PreviewPanel
        readiness={{ ready: true, openQuestions: [], summary: "Ready." }}
        handingOff={false}
        generatedSourceId={88}
        epicKey="CPDEV-123"
        onGenerate={vi.fn()}
        onViewEpic={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /View Epic/i })).toBeTruthy();
  });

  it("treats any open questions as not ready even if the readiness flag is true", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: true,
          openQuestions: ["Which roles need access?"],
          summary: "Mostly ready.",
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/Readiness summary/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Draft anyway/i })).toBeTruthy();
    expect(
      screen.getByRole("list", { name: /Questions for you/i }),
    ).toBeTruthy();
  });

  it("calls onGenerate when clicked and keeps Draft anyway as a normal action button", () => {
    const onGenerate = vi.fn();
    const { rerender } = render(
      <PreviewPanel
        readiness={{ ready: true, openQuestions: [], summary: "Ready." }}
        handingOff={false}
        onGenerate={onGenerate}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Generate Draft/i }));
    expect(onGenerate).toHaveBeenCalled();

    const css = readFileSync(cssPath, "utf8");
    expect(css).toMatch(
      /\.sf-preview-panel\s*\.sf-button-primary\s*\{[^}]*align-self:\s*end/s,
    );
    expect(css).toMatch(
      /\.sf-preview-panel\s*\.sf-button-primary\s*\{[^}]*min-height:\s*44px/s,
    );

    rerender(
      <PreviewPanel
        readiness={{ ready: true, openQuestions: [], summary: "Ready." }}
        handingOff={true}
        onGenerate={onGenerate}
      />,
    );
    expect(
      (
        screen.getByRole("button", {
          name: /Preparing draft/i,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("calls onViewEpic instead of onGenerate once the Epic exists", () => {
    const onGenerate = vi.fn();
    const onViewEpic = vi.fn();
    render(
      <PreviewPanel
        readiness={{ ready: true, openQuestions: [], summary: "Ready." }}
        handingOff={false}
        generatedSourceId={88}
        epicKey="CPDEV-123"
        onGenerate={onGenerate}
        onViewEpic={onViewEpic}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /View Epic/i }));

    expect(onViewEpic).toHaveBeenCalledOnce();
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("disables Generate when source blockers remain", () => {
    const onGenerate = vi.fn();
    render(
      <PreviewPanel
        readiness={{ ready: true, openQuestions: [], summary: "Ready." }}
        handingOff={false}
        handoffBlockedReason="Resolve failed source conversion before generating."
        onGenerate={onGenerate}
      />,
    );
    const button = screen.getByRole("button", {
      name: /Generate Draft/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Resolve failed source conversion/i)).toBeTruthy();
    fireEvent.click(button);
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("adds source blockers to the pending checklist", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: [],
          summary: "Sources blocked.",
        }}
        handingOff={false}
        handoffBlockedReason="Resolve failed source conversion before generating."
        onGenerate={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Resolve failed source conversion before generating."),
    ).toBeTruthy();
  });

  it("renders confetti only when ready", () => {
    const { rerender, container } = render(
      <PreviewPanel
        readiness={{ ready: false, openQuestions: [], summary: "" }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    expect(container.querySelector(".sf-confetti")).toBeNull();
    rerender(
      <PreviewPanel
        readiness={{ ready: true, openQuestions: [], summary: "ok" }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    expect(container.querySelector(".sf-confetti")).not.toBeNull();
  });

  it("shows an empty state when readiness is null", () => {
    render(
      <PreviewPanel readiness={null} handingOff={false} onGenerate={vi.fn()} />,
    );
    expect(screen.getByText(/brief will take shape here/i)).toBeTruthy();
  });

  it("keeps committed requirements visible while readiness is refreshing", () => {
    render(
      <PreviewPanel
        readiness={null}
        contextProjection={{
          sessionId: 7,
          version: 4,
          artifactUri: null,
          structuredArtifactUri: null,
          summary: {
            objective: "Reduce billing review time",
            problemStatement: "Auditors cannot export billing records.",
            solution: "Provide a governed export workflow.",
            businessRequirements: ["Auditors complete reviews on time."],
            functionalRequirements: ["Authorized users request an export."],
            challenges: ["Exports must preserve audit history."],
            stories: [],
            recommendedNextActions: [],
          },
          facts: [],
          openQuestions: [],
          conflicts: [],
          decisions: [],
          sourceIds: [1],
          patchIds: [2],
          committedAt: "2026-07-13T13:21:00.000Z",
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Auditors cannot export billing records."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Requirements/i }));
    expect(screen.getByText("Auditors complete reviews on time.")).toBeTruthy();
    expect(
      screen.getByText("Authorized users request an export."),
    ).toBeTruthy();
  });

  it("surfaces Gherkin acceptance criteria with product stories", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: [],
          summary: "Requirements are taking shape.",
          stories: [
            {
              id: "story-1",
              title: "Export billing records",
              summary: "Auditors export a governed billing file.",
              acceptanceCriteria: [
                "Given an authorized auditor, When they request an export, Then the system creates an auditable file.",
              ],
            },
          ],
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /Requirements/i }));
    const criteria = screen.getByRole("list", {
      name: /Acceptance criteria for Export billing records/i,
    });
    expect(
      within(criteria).getByText(/Given an authorized auditor/).tagName,
    ).toBe("CODE");
  });

  it("renders product readiness fields without implementation diagnostics", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: ["Which roles need access?"],
          summary: "s",
          confidence: {
            score: 0.68,
            rationale: "Repository is known, but acceptance criteria are thin.",
          },
          risks: ["Workflow ownership may span two modules."],
          assumptions: ["Existing queue can be reused."],
          missingEvidence: ["Final SLAs for appeals intake."],
          nextStep: "Confirm queue ownership.",
          validatorWarnings: [
            {
              code: "missing_acceptance_criteria",
              message: "Acceptance criteria are incomplete.",
              severity: "warning",
            },
          ],
          repoEvidence: [
            {
              repoName: "core-app",
              headSha: "abc1234",
              techStack: "Java",
              inspectedPaths: ["App.java"],
              keyMatches: [],
              warnings: [],
            },
          ],
          codeInvestigation: { filesRead: 3, toolCalls: 9 },
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    const overview = screen.getByLabelText(/Readiness summary/i);
    expect(within(overview).getByText("68%")).toBeTruthy();
    expect(within(overview).queryByText(/Repository is known/i)).toBeNull();
    expect(screen.queryByRole("article", { name: /Repo context/i })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Evidence/i }));
    const signals = screen.getByRole("article", {
      name: /Readiness signals/i,
    });
    expect(
      within(signals).getByText("Final SLAs for appeals intake."),
    ).toBeTruthy();
    expect(
      within(signals).getByText("Workflow ownership may span two modules."),
    ).toBeTruthy();
    expect(
      within(signals).queryByText("Existing queue can be reused."),
    ).toBeNull();
    expect(within(signals).getByText(/Acceptance criteria/)).toBeTruthy();
    expect(within(signals).queryByText("Confirm queue ownership.")).toBeNull();
  });

  it("does not render an Ideating/Problem/Summary block in the preview", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: ["Which roles need access?"],
          summary: "prose summary",
          ideating: "shaping",
          problem: "the problem",
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    expect(screen.queryByRole("article", { name: /Ideating/i })).toBeNull();
    expect(screen.queryByRole("article", { name: /Problem/i })).toBeNull();
    expect(screen.queryByLabelText(/Session summary/i)).toBeNull();
  });

  it("renders question tiles and calls onSelectQuestion on click", () => {
    const onSelectQuestion = vi.fn();
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: ["legacy"],
          summary: "s",
          questions: [
            {
              id: "q-1",
              question: "Which member roles may export?",
              options: ["Billing auditors", "All finance users"],
              questionType: "business",
            },
            {
              id: "q-2",
              question: "Should exports include inactive members?",
              answered: true,
              answer: "No",
              questionType: "functional",
            },
          ],
        }}
        handingOff={false}
        onGenerate={vi.fn()}
        onSelectQuestion={onSelectQuestion}
      />,
    );
    const tiles = screen.getByRole("group", { name: /Questions for you/i });
    const firstTile = within(tiles).getByRole("button", {
      name: /Which member roles may export/i,
    });
    fireEvent.click(firstTile);
    expect(onSelectQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ id: "q-1" }),
    );
    // answered questions are filtered out of the side panel
    expect(within(tiles).queryByText(/inactive members/i)).toBeNull();
  });

  it("hides answered questions from the Open Questions tiles", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: [],
          summary: "s",
          questions: [
            {
              id: "q-1",
              question: "Which roles need access?",
              answered: false,
              questionType: "business",
            },
            {
              id: "q-2",
              question: "Should exports include inactive members?",
              answered: true,
              answer: "No",
              questionType: "functional",
            },
            {
              id: "q-3",
              question: "Should exports include audit history?",
              questionType: "functional",
            },
          ],
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    const tiles = screen.getByRole("group", { name: /Questions for you/i });
    expect(within(tiles).getByText("Which roles need access?")).toBeTruthy();
    expect(
      within(tiles).getByText("Should exports include audit history?"),
    ).toBeTruthy();
    expect(within(tiles).queryByText(/inactive members/i)).toBeNull();
  });

  it("shows handoff blocked reason alongside question tiles", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: [],
          summary: "s",
          questions: [
            {
              id: "q-1",
              question: "Which roles need access?",
              options: ["Billing auditors", "All finance users"],
              questionType: "business",
            },
          ],
        }}
        handingOff={false}
        handoffBlockedReason="Resolve source status before generating: foo.pdf (failed)"
        onGenerate={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/Resolve source status before generating/i),
    ).toBeTruthy();
  });

  it("shows a progress bar reflecting answered/total questions", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: [],
          summary: "s",
          questions: [
            { id: "q-1", question: "A?", answered: true, answer: "x" },
            { id: "q-2", question: "B?", answered: false },
            { id: "q-3", question: "C?", answered: false },
            { id: "q-4", question: "D?", answered: false },
          ],
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: /progress/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText("25%")).toBeTruthy();
  });

  it("shows 'Just getting started' at zero answered", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: false,
          openQuestions: [],
          summary: "s",
          questions: [
            { id: "q-1", question: "A?" },
            { id: "q-2", question: "B?" },
          ],
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: /progress/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByText("0%")).toBeTruthy();
  });

  it("shows 'Ready to draft' at 100% when ready", () => {
    render(
      <PreviewPanel
        readiness={{
          ready: true,
          openQuestions: [],
          summary: "s",
          questions: [
            { id: "q-1", question: "A?", answered: true, answer: "x" },
          ],
        }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: /progress/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText("100%")).toBeTruthy();
  });

  it("shows an initial completeness estimate before questions exist", () => {
    render(
      <PreviewPanel
        readiness={{ ready: false, openQuestions: [], summary: "s" }}
        handingOff={false}
        onGenerate={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("progressbar", { name: /progress/i })
        .getAttribute("aria-valuenow"),
    ).toBe("35");
  });
});
