// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ComposeWorkspace, workflowErrorMessage } from "./ComposeWorkspace.js";

const experienceCssPath = existsSync(
  "dashboard/src/spec-factory/compose/ComposeExperience.css",
)
  ? "dashboard/src/spec-factory/compose/ComposeExperience.css"
  : "src/spec-factory/compose/ComposeExperience.css";

function clickAddSource() {
  const sourcesPanel = screen.getByRole("region", { name: "Sources" });
  fireEvent.click(
    within(sourcesPanel).getByRole("button", { name: /^Add source$/i }),
  );
}

describe("workflow error messages", () => {
  it("does not expose repository credential configuration names", () => {
    const message = workflowErrorMessage(
      "draft_stage_failed",
      "GITHUB_REPO_TOKEN or GITHUB_APP_CREDENTIALS is required",
    );

    expect(message).toContain("Repository access is temporarily unavailable");
    expect(message).not.toContain("GITHUB_REPO_TOKEN");
  });
});

function ok(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, (ev: { data: string }) => void> = {};
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(t: string, cb: (ev: { data: string }) => void) {
    this.listeners[t] = cb;
  }
  removeEventListener() {}
  emitOpen() {
    this.onopen?.(new Event("open"));
  }
  emitError() {
    this.onerror?.(new Event("error"));
  }
  close() {}
}

let noteAdded = false;
let sourceStatus: string | null = null;
let uploadConfirmed = false;
let jiraAdded = false;
let confluenceAdded = false;
let sourceDeleted = false;
let failedSourcesRetried = false;
let createdSessionName = "Idea";
let createdSessionUserName: string | null = null;
let createdSessionLatestContextVersion: number | null = null;
let createdSessionContextStatus: "dirty" | "building" | "clean" | null = null;
let contextProjection: unknown = null;
let handoffRequested = false;
let handoffRequestCount = 0;
let handoffEpicKeyOnRequest: string | null = null;
let workflowTurnStatus: string | null = null;
let workflowTurnErrorCode: string | null = null;
let workflowTurnErrorMessage: string | null = null;
let sessionReadiness: unknown = null;
let cancelledTurnId: number | null = null;
let lastResearchBody: unknown = null;

beforeEach(() => {
  noteAdded = false;
  sourceStatus = null;
  uploadConfirmed = false;
  jiraAdded = false;
  confluenceAdded = false;
  sourceDeleted = false;
  failedSourcesRetried = false;
  createdSessionName = "Idea";
  createdSessionUserName = null;
  createdSessionLatestContextVersion = null;
  createdSessionContextStatus = null;
  contextProjection = null;
  handoffRequested = false;
  handoffRequestCount = 0;
  handoffEpicKeyOnRequest = null;
  workflowTurnStatus = null;
  workflowTurnErrorCode = null;
  workflowTurnErrorMessage = null;
  sessionReadiness = null;
  cancelledTurnId = null;
  lastResearchBody = null;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource as never);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/compose/sessions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as {
          name?: string;
          userName?: string;
        };
        createdSessionName = body.name ?? "Idea";
        createdSessionUserName = body.userName ?? null;
        return Promise.resolve(
          ok({
            id: 7,
            name: createdSessionName,
            createdBy: createdSessionUserName,
            createdByDisplay: createdSessionUserName,
            status: "draft",
            sourceId: null,
            readiness: sessionReadiness,
            sourceCount: 0,
            passwordProtected: false,
            latestContextVersion: createdSessionLatestContextVersion,
            contextStatus: createdSessionContextStatus,
            createdAt: "t",
            updatedAt: "t",
          }),
        );
      }
      if (url.endsWith("/compose/repositories")) {
        return Promise.resolve(
          ok([
            {
              id: 3,
              repoName: "medhok-monorepo",
              repoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
              defaultBranch: "master",
              description: "Core app",
            },
          ]),
        );
      }
      if (url.endsWith("/compose/sessions")) return Promise.resolve(ok([]));
      if (url.endsWith("/sessions/7/resume"))
        return Promise.resolve(
          ok({
            id: 7,
            name: createdSessionName,
            createdBy: createdSessionUserName,
            createdByDisplay: createdSessionUserName,
            status: "draft",
            sourceId: null,
            readiness: sessionReadiness,
            sourceCount: 0,
            passwordProtected: false,
            latestContextVersion: createdSessionLatestContextVersion,
            contextStatus: createdSessionContextStatus,
            createdAt: "t",
            updatedAt: "t",
          }),
        );
      if (
        url.endsWith("/sessions/7") &&
        (!init?.method || init.method === "GET")
      ) {
        return Promise.resolve(
          ok({
            id: 7,
            name: createdSessionName,
            createdBy: createdSessionUserName,
            createdByDisplay: createdSessionUserName,
            status: "draft",
            sourceId: null,
            readiness: sessionReadiness,
            sourceCount: 0,
            passwordProtected: false,
            latestContextVersion: createdSessionLatestContextVersion,
            contextStatus: createdSessionContextStatus,
            createdAt: "t",
            updatedAt: "t",
          }),
        );
      }
      if (url.endsWith("/sessions/7/sources")) {
        if (sourceDeleted) return Promise.resolve(ok([]));
        if (sourceStatus) {
          return Promise.resolve(
            ok([
              {
                id: 1,
                sessionId: 7,
                kind: "file",
                originalFilename: "uploading.pdf",
                conversionStatus: sourceStatus,
                errorMessage: null,
                markdownContent: null,
              },
            ]),
          );
        }
        const rows = [];
        if (!failedSourcesRetried)
          rows.push({
            id: 3,
            sessionId: 7,
            kind: "youtube",
            originalFilename: "https://youtu.be/x",
            conversionStatus: "failed",
            conversionAttempts: 1,
            errorMessage: "SDK timeout after 30000ms",
            markdownContent: null,
          });
        if (uploadConfirmed)
          rows.push({
            id: 9,
            sessionId: 7,
            kind: "file",
            originalFilename: "spec.pdf",
            conversionStatus: "converted",
            errorMessage: null,
            markdownContent: "# Spec",
          });
        if (jiraAdded)
          rows.push({
            id: 11,
            sessionId: 7,
            kind: "jira",
            originalFilename: "CPDEV-123",
            conversionStatus: "converted",
            errorMessage: null,
            markdownContent: "# CPDEV-123",
          });
        if (confluenceAdded)
          rows.push({
            id: 12,
            sessionId: 7,
            kind: "confluence",
            originalFilename: "https://wiki.example.com/x",
            conversionStatus: "pending",
            errorMessage: null,
            markdownContent: null,
          });
        if (noteAdded)
          rows.push({
            id: 1,
            sessionId: 7,
            kind: "note",
            originalFilename: "note-1",
            conversionStatus: "converted",
            errorMessage: null,
            markdownContent: "Repo is billing-service",
          });
        return Promise.resolve(ok(rows));
      }
      if (url.endsWith("/sessions/7/source-deletions")) {
        return Promise.resolve(
          ok(
            sourceDeleted
              ? [
                  {
                    id: 801,
                    sessionId: 7,
                    sourceId: 1,
                    sourceTitle: "note-1",
                    status: "undoable",
                    undoUntil: "2099-07-11T12:10:00.000Z",
                    invalidatedSourceIds: [1],
                    invalidatedHandoffIds: [],
                    dependentSourceCount: 0,
                    createdAt: "2026-07-11T12:00:00.000Z",
                  },
                ]
              : [],
          ),
        );
      }
      if (url.endsWith("/sessions/7/context")) {
        return Promise.resolve(ok(contextProjection));
      }
      if (url.endsWith("/sessions/7/workflow-state")) {
        return Promise.resolve(
          ok({
            sessionId: 7,
            generatedAt: "2026-07-10T06:00:00.000Z",
            turn: workflowTurnStatus
              ? {
                  id: 101,
                  kind: "chat",
                  status: workflowTurnStatus,
                  attemptCount: 1,
                  maxAttempts: 3,
                  queuePosition: null,
                  requestedContextVersion: 4,
                  contextVersionUsed: 4,
                  queuedAt: "2026-07-10T05:59:00.000Z",
                  startedAt: "2026-07-10T05:59:01.000Z",
                  completedAt:
                    workflowTurnStatus === "completed"
                      ? "2026-07-10T06:00:00.000Z"
                      : null,
                  clarificationExpiresAt: null,
                  errorCode:
                    workflowTurnErrorCode ??
                    (workflowTurnErrorMessage
                      ? "legacy_executor_failed"
                      : null),
                  errorMessage: workflowTurnErrorMessage,
                }
              : null,
            handoff:
              handoffRequested && handoffEpicKeyOnRequest
                ? {
                    id: 701,
                    sourceId: 88,
                    status: "published",
                    contextVersionUsed: 4,
                    messageHighWatermarkId: 99,
                    snapshotId: 901,
                    draftWorkflowId: 1001,
                    workflowStatus: "completed",
                    workflowStage: "oneshot_submit",
                    draftId: 1101,
                    epicKey: handoffEpicKeyOnRequest,
                    errorCode: null,
                    errorMessage: null,
                    updatedAt: "2026-07-10T06:00:00.000Z",
                  }
                : null,
            agents: [
              {
                key: "sources",
                label: "Sources",
                status: "idle",
                detail: "Sources are current",
              },
              {
                key: "requirements",
                label: "Requirements",
                status: "idle",
                detail: "Working context is current",
              },
              {
                key: "research",
                label: "Research",
                status: "idle",
                detail: "No research is running",
              },
              {
                key: "draft",
                label: "Draft",
                status: "idle",
                detail: "No handoff is running",
              },
            ],
          }),
        );
      }
      if (url.endsWith("/sessions/7/turns/101/cancel")) {
        cancelledTurnId = 101;
        workflowTurnStatus = "cancelled";
        return Promise.resolve(
          ok(
            {
              cancelled: true,
              turnJobId: 101,
              cancelledAgentTaskIds: [],
              status: "cancelled",
            },
            202,
          ),
        );
      }
      if (url.endsWith("/sessions/7/messages")) return Promise.resolve(ok([]));
      if (url.endsWith("/sessions/7/notes")) {
        noteAdded = true;
        return Promise.resolve(
          ok({
            id: 7,
            name: "Idea",
            status: "draft",
            sourceId: null,
            readiness: null,
            sourceCount: 1,
            passwordProtected: false,
            createdAt: "t",
            updatedAt: "t",
          }),
        );
      }
      if (url.endsWith("/sessions/7/jira")) {
        jiraAdded = true;
        return Promise.resolve(ok({ accepted: true }, 202));
      }
      if (url.endsWith("/sessions/7/confluence")) {
        confluenceAdded = true;
        return Promise.resolve(ok({ accepted: true }, 202));
      }
      if (url.endsWith("/sessions/7/sources/1") && init?.method === "DELETE") {
        sourceDeleted = true;
        return Promise.resolve(
          ok(
            {
              id: 801,
              sessionId: 7,
              sourceId: 1,
              sourceTitle: "note-1",
              status: "undoable",
              undoUntil: "2099-07-11T12:10:00.000Z",
              invalidatedSourceIds: [1],
              invalidatedHandoffIds: [],
              dependentSourceCount: 0,
              createdAt: "2026-07-11T12:00:00.000Z",
            },
            202,
          ),
        );
      }
      if (
        url.endsWith("/sessions/7/sources/1/restore") &&
        init?.method === "POST"
      ) {
        sourceDeleted = false;
        return Promise.resolve(
          ok(
            {
              id: 801,
              sessionId: 7,
              sourceId: 1,
              sourceTitle: "note-1",
              status: "restored",
              undoUntil: "2099-07-11T12:10:00.000Z",
              invalidatedSourceIds: [1],
              invalidatedHandoffIds: [],
              dependentSourceCount: 0,
              createdAt: "2026-07-11T12:00:00.000Z",
            },
            202,
          ),
        );
      }
      if (url.endsWith("/sessions/7/sources/reconvert-failed")) {
        failedSourcesRetried = true;
        return Promise.resolve(ok({ queued: 1 }, 202));
      }
      if (url.endsWith("/sessions/7/research/code")) {
        lastResearchBody = JSON.parse(String(init?.body ?? "{}"));
        return Promise.resolve(
          ok(
            {
              accepted: true,
              agentTaskId: 501,
              capability: "code_research",
              status: "queued",
            },
            202,
          ),
        );
      }
      if (url.endsWith("/sessions/7/uploads"))
        return Promise.resolve(
          ok(
            {
              sourceId: 9,
              uploadUrl: "https://s3/put",
              s3KeyRaw: "k",
              expiresInSeconds: 900,
            },
            201,
          ),
        );
      if (url === "https://s3/put") return Promise.resolve(ok({}, 200));
      if (url.endsWith("/sessions/7/sources/9/uploaded")) {
        uploadConfirmed = true;
        return Promise.resolve(ok({ accepted: true }, 202));
      }
      if (url.endsWith("/sessions/7/handoff")) {
        handoffRequested = true;
        handoffRequestCount += 1;
        return Promise.resolve(
          ok(
            {
              sourceId: 88,
              session: {
                id: 7,
                name: createdSessionName,
                createdBy: createdSessionUserName,
                createdByDisplay: createdSessionUserName,
                status: "handed_off",
                sourceId: 88,
                readiness: {
                  ready: false,
                  openQuestions: ["Which user roles need access?"],
                  summary: "Need affected users.",
                },
                sourceCount: 1,
                passwordProtected: false,
                createdAt: "t",
                updatedAt: "t",
              },
            },
            202,
          ),
        );
      }
      return Promise.resolve(ok({}));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ComposeWorkspace", () => {
  it("creates a session from the modal then shows the three panels", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));

    await screen.findByRole("region", { name: "Sources" });
    expect(
      screen.getByRole("region", { name: "Clarification chat" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Requirements brief" }),
    ).toBeTruthy();
  });

  it("shows the active session name and user in the workspace toolbar", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Member Intake" },
    });
    fireEvent.change(screen.getByLabelText(/Your name/i), {
      target: { value: "Koundinya" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));

    const activeSession = await screen.findByLabelText("Active session");
    expect(within(activeSession).getByText("Member Intake")).toBeTruthy();
    expect(within(activeSession).getByText("Session #7")).toBeTruthy();
    expect(within(activeSession).queryByText("Koundinya")).toBeNull();

    const owner = screen.getByLabelText("Session owner");
    expect(within(owner).getByText("Koundinya")).toBeTruthy();
  });

  it("shows the active session context version and status", async () => {
    createdSessionLatestContextVersion = 4;
    createdSessionContextStatus = "clean";
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Member Intake" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));

    const activeSession = await screen.findByLabelText("Active session");
    expect(within(activeSession).getByText("Context v4")).toBeTruthy();
    expect(within(activeSession).getByText("Clean")).toBeTruthy();
  });

  it("uses the latest context projection when session readiness is empty", async () => {
    createdSessionLatestContextVersion = 4;
    createdSessionContextStatus = "clean";
    contextProjection = {
      sessionId: 7,
      version: 4,
      artifactUri: "s3://bucket/compose/7/context/working-context-v4.md",
      structuredArtifactUri:
        "s3://bucket/compose/7/context/working-context-v4.json",
      summary: {
        objective: "Build invoice export",
        problemStatement: "Users need exports for billing audits.",
        solution: "Provide a governed billing export.",
        businessRequirements: ["Auditors can complete billing reviews."],
        functionalRequirements: ["Authorized users can request an export."],
        challenges: [],
        stories: [],
        recommendedNextActions: ["Inspect billing-service export flow"],
      },
      facts: [{ text: "Billing service owns invoice exports." }],
      openQuestions: [{ question: "Which date range should exports support?" }],
      conflicts: [],
      decisions: [],
      sourceIds: [61],
      patchIds: [701],
      committedAt: "2026-07-05T10:30:00.000Z",
    };
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Member Intake" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));

    await screen.findByRole("region", { name: "Sources" });
    fireEvent.click(screen.getByRole("tab", { name: /Artifacts/i }));
    const artifact = await screen.findByRole("button", {
      name: /Problem statement/i,
    });
    fireEvent.click(artifact);
    expect(
      within(
        screen.getByRole("dialog", { name: /Problem statement/i }),
      ).getByText("Users need exports for billing audits."),
    ).toBeTruthy();
    expect(
      (await screen.findAllByText("Which date range should exports support?"))
        .length,
    ).toBeGreaterThan(0);
  });

  it("shows background agents and requires consent before code research", async () => {
    failedSourcesRetried = true;
    createdSessionLatestContextVersion = 4;
    createdSessionContextStatus = "clean";
    contextProjection = {
      sessionId: 7,
      version: 4,
      artifactUri: null,
      structuredArtifactUri: null,
      summary: {
        objective: "Improve billing review",
        problemStatement: "Auditors cannot export billing records.",
        solution: "Provide a governed export workflow.",
        businessRequirements: ["Auditors can complete reviews on time."],
        functionalRequirements: ["Authorized users can request an export."],
        challenges: [],
        stories: [],
        recommendedNextActions: [],
      },
      facts: [],
      openQuestions: [],
      conflicts: [],
      decisions: [],
      sourceIds: [],
      patchIds: [],
      committedAt: "2026-07-10T10:00:00.000Z",
    };

    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Billing export" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));

    const agents = await screen.findByLabelText("Agent activity");
    expect(within(agents).getByText("Sources")).toBeTruthy();
    expect(within(agents).getByText("Requirements")).toBeTruthy();
    expect(within(agents).getByText("Research")).toBeTruthy();
    expect(within(agents).getByText("Draft")).toBeTruthy();

    fireEvent.click(
      await screen.findByRole("button", { name: /Start code research/i }),
    );
    await waitFor(() =>
      expect(lastResearchBody).toMatchObject({
        contextVersionUsed: 4,
        parentSourceIds: [],
        question: expect.stringContaining(
          "Auditors cannot export billing records.",
        ),
      }),
    );
  });

  it("uses a balanced top bar with a readable owner control", () => {
    const css = readFileSync(experienceCssPath, "utf8");
    expect(css).toMatch(
      /\.sf-compose-workspace-toolbar\s*\{[^}]*grid-template-columns:\s*auto\s+minmax\(180px,\s*1fr\)\s+auto\s+auto\s+auto/s,
    );
    expect(css).toMatch(/\.sf-compose-active-session\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(
      /\.sf-compose-active-session\s+\.sf-compose-session-number\s*\{[^}]*background:\s*var\(--sfx-purple-soft\)[^}]*color:\s*#4f35d2/s,
    );
    expect(css).toMatch(/\.sf-compose-session-identity\s*\{[^}]*gap:\s*12px/s);
    expect(css).toMatch(
      /\.sf-compose-session-identity\s*\{[^}]*justify-content:\s*center[^}]*justify-self:\s*center/s,
    );
    expect(css).toMatch(
      /\.sf-compose-session-owner\s*\{[^}]*color:\s*var\(--sfx-text\)/s,
    );
  });

  it("keeps every workspace panel reachable on tablet and mobile", () => {
    const css = readFileSync(experienceCssPath, "utf8");
    expect(css).toMatch(
      /@media \(max-width: 1080px\)[\s\S]*?\.sf-mobile-workspace-tabs\s*\{[^}]*display:\s*grid;/,
    );
    expect(css).toContain(
      '.sf-compose[data-mobile-panel="chat"] .sf-chat-panel',
    );
    expect(css).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.sf-side-nav\s*\{[^}]*display:\s*none;/,
    );
  });

  it("keeps the Spec Factory session-picker logo visible on white", () => {
    const css = readFileSync(experienceCssPath, "utf8");

    expect(css).toMatch(
      /\.sf-compose-session-modal\s+\.sf-compose-modal-sf-logo\s*\{[^}]*filter:\s*invert/s,
    );
    expect(css).toMatch(
      /\.sf-compose-session-modal\s+\.sf-compose-modal-new\s+label[^{]*\{[^}]*color:\s*var\(--sfx-muted\)/s,
    );
    expect(css).toMatch(
      /\.sf-compose-session-modal\s+\.sf-compose-modal-new\s+input[^{]*\{[^}]*border:\s*1px\s+solid\s+var\(--sfx-line-strong\)[^}]*color:\s*var\(--sfx-text\)/s,
    );
    expect(css).toMatch(
      /\.sf-compose-session-modal\s+\.sf-compose-modal-info\s+ul\s*\{[^}]*color:\s*var\(--sfx-muted\)/s,
    );
    expect(css).toMatch(
      /\.sf-compose-session-modal\s+\.sf-compose-session-list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 760px\)[\s\S]*?\.sf-compose-session-modal\s+\.sf-compose-session-list\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
    );
  });

  it("returns from an active session directly to the saved-session list", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Sources" });

    fireEvent.click(screen.getByRole("button", { name: /^Sessions$/i }));

    expect(
      await screen.findByRole("heading", { name: /Resume a session/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Resume Idea/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New Session/i })).toBeNull();
  });

  it("surfaces automatically produced functional clarifications", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Sources" });

    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );
    act(() => {
      FakeEventSource.instances[0].listeners.readiness({
        data: JSON.stringify({
          type: "readiness",
          readiness: {
            ready: false,
            openQuestions: ["Which user roles need access?"],
            summary: "Need the affected users.",
            problem: "Auditors cannot export billing records.",
          },
        }),
      });
    });
    await waitFor(() =>
      expect(
        screen.getByRole("article", { name: /Mendel question/i }),
      ).toBeTruthy(),
    );
    expect(
      within(
        screen.getByRole("article", { name: /Mendel question/i }),
      ).getByText("Which user roles need access?"),
    ).toBeTruthy();
    expect(
      within(
        screen.getByRole("list", { name: /Questions for you/i }),
      ).getByText("Which user roles need access?"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Analyze Sources/i }),
    ).toBeNull();
  });

  it("injects the picked open question into the chat as an agent turn", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Sources" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );
    act(() => {
      FakeEventSource.instances[0].listeners.readiness({
        data: JSON.stringify({
          type: "readiness",
          readiness: {
            ready: false,
            openQuestions: ["Which member roles need this change?"],
            summary: "",
            ideating: "Shaping it.",
            questions: [
              {
                id: "q-1",
                question: "Which member roles need this change?",
                options: ["Operations", "Auditors"],
                questionType: "business",
              },
            ],
          },
        }),
      });
    });
    // Click the user-facing question tile in the Preview.
    const tile = await screen.findByRole("button", {
      name: /Which member roles need this change/i,
    });
    fireEvent.click(tile);
    // the question now appears as an agent turn in the chat window
    const convo = document.querySelector(".sf-chat-window") as HTMLElement;
    await waitFor(() => {
      const questionTurn = within(convo).getByRole("article", {
        name: /question/i,
      });
      expect(
        within(questionTurn).getByText(/Which member roles need this change/i),
      ).toBeTruthy();
    });
  });

  it("notifies the parent after Draft anyway hands off the session", async () => {
    failedSourcesRetried = true;
    noteAdded = true;
    const onHandoff = vi.fn();

    render(<ComposeWorkspace onHandoff={onHandoff} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Requirements brief" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    act(() => {
      FakeEventSource.instances[0].listeners.readiness({
        data: JSON.stringify({
          type: "readiness",
          readiness: {
            ready: false,
            openQuestions: ["Which user roles need access?"],
            summary: "Need affected users.",
          },
        }),
      });
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /Draft anyway/i }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Draft without resolving/i,
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: /Draft anyway/i }),
    );

    await waitFor(() => expect(handoffRequested).toBe(true));
    expect(onHandoff).toHaveBeenCalledWith({
      sourceId: 88,
      session: expect.objectContaining({
        id: 7,
        status: "handed_off",
        sourceId: 88,
      }),
    });
  });

  it("notifies the parent after Generate Draft hands off a ready session", async () => {
    failedSourcesRetried = true;
    noteAdded = true;
    const onHandoff = vi.fn();

    render(<ComposeWorkspace onHandoff={onHandoff} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Requirements brief" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    act(() => {
      FakeEventSource.instances[0].listeners.readiness({
        data: JSON.stringify({
          type: "readiness",
          readiness: {
            ready: true,
            openQuestions: [],
            summary: "Ready to draft.",
          },
        }),
      });
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /Generate Draft/i }),
    );

    await waitFor(() => expect(handoffRequested).toBe(true));
    expect(onHandoff).toHaveBeenCalledWith({
      sourceId: 88,
      session: expect.objectContaining({
        id: 7,
        status: "handed_off",
        sourceId: 88,
      }),
    });
  });

  it("switches to View Epic after handoff and does not hand off again", async () => {
    failedSourcesRetried = true;
    noteAdded = true;
    handoffEpicKeyOnRequest = "CPDEV-123";
    const onHandoff = vi.fn();
    const onViewEpic = vi.fn();

    render(<ComposeWorkspace onHandoff={onHandoff} onViewEpic={onViewEpic} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Requirements brief" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    act(() => {
      FakeEventSource.instances[0].listeners.readiness({
        data: JSON.stringify({
          type: "readiness",
          readiness: {
            ready: true,
            openQuestions: [],
            summary: "Ready to draft.",
          },
        }),
      });
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /Generate Draft/i }),
    );

    await waitFor(() => expect(onHandoff).toHaveBeenCalled());
    expect(handoffRequestCount).toBe(1);

    fireEvent.click(await screen.findByRole("button", { name: /View Epic/i }));

    expect(onViewEpic).toHaveBeenCalledWith(88);
    expect(handoffRequestCount).toBe(1);
  });

  it("renders chat turns optimistically while the backend response is pending", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Clarification chat" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    fireEvent.change(screen.getByLabelText(/Message/i), {
      target: { value: "Use defaults" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send/i }));

    const userReply = await screen.findByRole("article", {
      name: /User reply/i,
    });
    expect(within(userReply).getByText("Use defaults")).toBeTruthy();
    expect(screen.getAllByText("Thinking...").length).toBeGreaterThan(0);

    act(() => {
      FakeEventSource.instances[0].listeners.message({
        data: JSON.stringify({
          type: "message",
          role: "assistant",
          content: "Got it — drafting with defaults.",
        }),
      });
    });

    await waitFor(() =>
      expect(screen.getByText("Got it — drafting with defaults.")).toBeTruthy(),
    );
  });

  it("shows streamed progress text while a turn is running", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Clarification chat" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    act(() => {
      FakeEventSource.instances[0].listeners.status({
        data: JSON.stringify({
          type: "status",
          status: "thinking",
          message: "Checking repositories",
        }),
      });
    });

    expect(
      (await screen.findAllByText("Checking repositories")).length,
    ).toBeGreaterThan(0);

    act(() => {
      FakeEventSource.instances[0].listeners.status({
        data: JSON.stringify({ type: "status", status: "idle" }),
      });
    });

    await waitFor(() =>
      expect(screen.queryAllByText("Checking repositories")).toHaveLength(0),
    );
  });

  it("shows an inline chat affordance when clarification expires", async () => {
    workflowTurnStatus = "awaiting_user_input";
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Clarification chat" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );
    expect(
      (await screen.findAllByText("Waiting for your answer")).length,
    ).toBeGreaterThan(0);

    workflowTurnStatus = "abandoned";
    workflowTurnErrorCode = "clarification_expired";
    workflowTurnErrorMessage = "Clarification expired before the user answered";

    act(() => {
      FakeEventSource.instances[0].listeners.status({
        data: JSON.stringify({
          type: "status",
          status: "error",
          code: "clarification_expired",
          message:
            "Clarification expired. Send a new message to continue with fresh context.",
        }),
      });
    });

    const alerts = await screen.findAllByRole("alert");
    expect(
      alerts.some((alert) =>
        alert.textContent?.includes("continue with fresh context"),
      ),
    ).toBe(true);
  });

  it("ignores an uncorrelated clarification expiry when the current turn is active", async () => {
    workflowTurnStatus = "awaiting_user_input";
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Clarification chat" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );
    expect(
      (await screen.findAllByText("Waiting for your answer")).length,
    ).toBeGreaterThan(0);

    const callsBefore = vi.mocked(fetch).mock.calls.length;
    act(() => {
      FakeEventSource.instances[0].listeners.status({
        data: JSON.stringify({
          type: "status",
          status: "error",
          code: "clarification_expired",
          message:
            "Clarification expired. Send a new message to continue with fresh context.",
        }),
      });
    });

    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.slice(callsBefore)
          .some((call) =>
            String(call[0]).endsWith("/sessions/7/workflow-state"),
          ),
      ).toBe(true),
    );
    expect(screen.queryByText("continue with fresh context")).toBeNull();
  });

  it("does not show the sources analysis state for ordinary chat progress", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Clarification chat" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    act(() => {
      FakeEventSource.instances[0].listeners.status({
        data: JSON.stringify({
          type: "status",
          status: "thinking",
          mode: "chat",
          message: "Preparing next question",
        }),
      });
    });

    expect(await screen.findByText("Preparing next question")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Analyzing/i })).toBeNull();
  });

  it("keeps polling while a source is awaiting upload", async () => {
    sourceStatus = "awaiting_upload";
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue(1 as never);
    vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);

    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));

    await screen.findByText("Uploading");
    await waitFor(() => expect(setIntervalSpy).toHaveBeenCalled());
  });

  it("uploads a file, closes the modal, and refreshes sources", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Sources" });

    clickAddSource();
    const file = new File(["hello"], "spec.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/Upload files/i), {
      target: { files: [file] },
    });

    await screen.findByRole("button", { name: /Expand source spec\.pdf/i });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Add sources/i })).toBeNull(),
    );
  });

  it("creates a source directly from clipboard text", async () => {
    const readText = vi
      .fn()
      .mockResolvedValue("Members need a governed billing export.");
    vi.stubGlobal("navigator", { clipboard: { readText } });

    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));

    const sourcesPanel = await screen.findByRole("region", { name: "Sources" });
    fireEvent.click(
      within(sourcesPanel).getByRole("button", {
        name: /Paste clipboard as a source/i,
      }),
    );

    await screen.findByRole("button", { name: /Expand source note-1/i });
    expect(readText).toHaveBeenCalledOnce();
    const noteCall = vi
      .mocked(fetch)
      .mock.calls.find((call) => String(call[0]).endsWith("/sessions/7/notes"));
    expect(JSON.parse(String(noteCall?.[1]?.body))).toEqual({
      content: "Members need a governed billing export.",
    });
  });

  it("adds Jira and Confluence sources from the add-source modal", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Sources" });

    clickAddSource();
    fireEvent.click(screen.getByRole("button", { name: /^Jira$/i }));
    fireEvent.change(screen.getByLabelText(/Jira issue key/i), {
      target: { value: "CPDEV-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add Jira/i }));
    await screen.findByText(/CPDEV-123:/);

    clickAddSource();
    fireEvent.click(screen.getByRole("button", { name: /^Confluence$/i }));
    fireEvent.change(screen.getByLabelText(/Confluence page URL/i), {
      target: { value: "https://wiki.example.com/x" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add Confluence/i }));
    await screen.findByRole("button", {
      name: /Expand source https:\/\/wiki\.example\.com\/x/i,
    });
  });

  it("deletes a source only after confirmation and clears stale readiness", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Sources" });

    clickAddSource();
    fireEvent.click(screen.getByRole("button", { name: /Sketch Pad/i }));
    fireEvent.change(screen.getByLabelText("Sketch pad / manual notes"), {
      target: { value: "Repo is billing-service" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Add note$/i }));
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );
    act(() => {
      FakeEventSource.instances[0].listeners.readiness({
        data: JSON.stringify({
          type: "readiness",
          readiness: {
            ready: false,
            openQuestions: ["Which user roles need access?"],
            summary: "Need the affected users.",
          },
        }),
      });
    });
    await screen.findByRole("list", { name: /Questions for you/i });

    fireEvent.click(
      screen.getByRole("button", { name: /Expand source note-1/i }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Delete source note-1/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Delete source$/i }));

    await waitFor(() =>
      expect(
        screen.queryByRole("list", { name: /Questions for you/i }),
      ).toBeNull(),
    );
    const recentlyRemoved = await screen.findByRole("region", {
      name: /Recently removed/i,
    });
    fireEvent.click(
      within(recentlyRemoved).getByRole("button", { name: /Undo/i }),
    );
    await waitFor(() => expect(sourceDeleted).toBe(false));
    await screen.findByRole("button", { name: /Collapse source note-1/i });
  });

  it("renders a retrying status with attempt count and countdown", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Clarification chat" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    act(() => {
      FakeEventSource.instances[0].listeners.status({
        data: JSON.stringify({
          type: "status",
          status: "retrying",
          attempt: 2,
          maxAttempts: 5,
          nextRetryInSeconds: 4,
          message: "Bedrock throttle",
        }),
      });
    });

    const indicator = await screen.findByRole("status", { name: /Retrying/i });
    expect(indicator.textContent).toMatch(/attempt\s*2\s*of\s*5/i);
    expect(indicator.textContent).toMatch(/in\s*4s/i);
  });

  it("reconciles state when the SSE stream re-opens after a disconnect", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Clarification chat" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    // Start a thinking turn.
    act(() => {
      FakeEventSource.instances[0].listeners.status({
        data: JSON.stringify({
          type: "status",
          status: "thinking",
          message: "Checking repositories",
        }),
      });
    });
    expect(
      (await screen.findAllByText("Checking repositories")).length,
    ).toBeGreaterThan(0);

    const fetchMock = vi.mocked(fetch);
    const callsBefore = fetchMock.mock.calls.length;

    // Stream errors then re-opens — without a new event we should clear
    // the stale thinking flag and trigger a refetch.
    act(() => {
      FakeEventSource.instances[0].emitError();
      FakeEventSource.instances[0].emitOpen();
    });

    await waitFor(() =>
      expect(screen.queryAllByText("Checking repositories")).toHaveLength(0),
    );
    const newCalls = fetchMock.mock.calls
      .slice(callsBefore)
      .map((call) => String(call[0]));
    expect(newCalls.some((url) => url.endsWith("/sessions/7/messages"))).toBe(
      true,
    );
    expect(newCalls.some((url) => url.endsWith("/sessions/7/resume"))).toBe(
      true,
    );
  });

  it("keeps a turn active until authoritative workflow state becomes terminal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<ComposeWorkspace />);
      fireEvent.click(
        await screen.findByRole("button", { name: /New Session/i }),
      );
      fireEvent.change(screen.getByLabelText(/Session name/i), {
        target: { value: "Idea" },
      });
      fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
      await screen.findByRole("region", { name: "Clarification chat" });
      await waitFor(() =>
        expect(FakeEventSource.instances.length).toBeGreaterThan(0),
      );

      act(() => {
        FakeEventSource.instances[0].listeners.status({
          data: JSON.stringify({
            type: "status",
            status: "thinking",
            message: "Long running",
          }),
        });
      });
      expect(
        (await screen.findAllByText("Long running")).length,
      ).toBeGreaterThan(0);

      await act(async () => {
        vi.advanceTimersByTime(91_000);
      });

      expect(screen.getAllByText("Long running").length).toBeGreaterThan(0);

      workflowTurnStatus = "completed";
      act(() => {
        FakeEventSource.instances[0].emitError();
        FakeEventSource.instances[0].emitOpen();
      });

      await waitFor(() =>
        expect(screen.queryAllByText("Long running")).toHaveLength(0),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not surface a historical failed turn when a session opens", async () => {
    workflowTurnStatus = "failed";
    workflowTurnErrorMessage = "SDK timeout after 300000ms";

    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));

    await screen.findByRole("region", { name: "Clarification chat" });
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some((call) =>
            String(call[0]).endsWith("/sessions/7/workflow-state"),
          ),
      ).toBe(true),
    );
    expect(screen.queryByText("SDK timeout after 300000ms")).toBeNull();
  });

  it("surfaces a turn failure that becomes current while the session is open", async () => {
    workflowTurnStatus = "running";

    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Clarification chat" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    workflowTurnStatus = "failed";
    workflowTurnErrorMessage = "Current turn failed";
    act(() => {
      FakeEventSource.instances[0].listeners.canonical({
        data: JSON.stringify({
          schemaVersion: 1,
          id: 901,
          eventType: "turn.failed",
          occurredAt: "2026-07-13T12:00:00.000Z",
          sessionId: 7,
          correlation: {},
          data: { turnJobId: 101 },
        }),
      });
    });

    expect(await screen.findByText("Current turn failed")).toBeTruthy();
  });

  it("reloads authoritative readiness after an invalidation event", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Clarification chat" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );

    sessionReadiness = {
      ready: false,
      openQuestions: ["Which regions are included?"],
      summary: "Regional scope is required.",
    };
    act(() => {
      FakeEventSource.instances[0].listeners.invalidate({
        data: JSON.stringify({
          type: "invalidate",
          resource: "readiness",
        }),
      });
    });

    expect(
      (await screen.findAllByText("Which regions are included?")).length,
    ).toBeGreaterThan(0);
  });

  it("reconciles state without surfacing recoverable SSE transport errors", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Clarification chat" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );
    const callsBefore = vi.mocked(fetch).mock.calls.length;

    act(() => {
      FakeEventSource.instances[0].listeners.status({
        data: JSON.stringify({
          type: "status",
          status: "error",
          code: "payload_too_large",
          message: "SSE event payload exceeds 16384 bytes",
        }),
      });
    });

    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.slice(callsBefore)
          .some((call) => String(call[0]).endsWith("/sessions/7")),
      ).toBe(true),
    );
    expect(
      screen.queryByText("SSE event payload exceeds 16384 bytes"),
    ).toBeNull();
  });

  it("cancels the authoritative active turn from the workspace toolbar", async () => {
    workflowTurnStatus = "running";
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));

    fireEvent.click(
      await screen.findByRole("button", { name: "Stop current response" }),
    );

    await waitFor(() => expect(cancelledTurnId).toBe(101));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Stop current response" }),
      ).toBeNull(),
    );
  });

  it("requires a confirm step before draft-anyway hands off", async () => {
    failedSourcesRetried = true;
    noteAdded = true;
    const onHandoff = vi.fn();

    render(<ComposeWorkspace onHandoff={onHandoff} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Requirements brief" });
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );
    act(() => {
      FakeEventSource.instances[0].listeners.readiness({
        data: JSON.stringify({
          type: "readiness",
          readiness: {
            ready: false,
            openQuestions: ["Which user roles need access?"],
            summary: "Need affected users.",
          },
        }),
      });
    });

    fireEvent.click(
      await screen.findByRole("button", { name: /Draft anyway/i }),
    );

    // Cancel first; nothing should be sent.
    const dialog = await screen.findByRole("dialog", {
      name: /Draft without resolving/i,
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancel/i }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /Draft without resolving/i }),
      ).toBeNull(),
    );
    expect(handoffRequested).toBe(false);

    // Now reopen and confirm.
    fireEvent.click(
      await screen.findByRole("button", { name: /Draft anyway/i }),
    );
    const dialog2 = await screen.findByRole("dialog", {
      name: /Draft without resolving/i,
    });
    fireEvent.click(
      within(dialog2).getByRole("button", { name: /Draft anyway/i }),
    );

    await waitFor(() => expect(handoffRequested).toBe(true));
    expect(onHandoff).toHaveBeenCalled();
  });

  it("retries failed sources in bulk and refreshes the source list", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));

    await screen.findByRole("button", {
      name: /Expand source https:\/\/youtu\.be\/x/i,
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Retry failed \(1\)/i }),
    );

    await waitFor(() => {
      expect(failedSourcesRetried).toBe(true);
      expect(
        screen.queryByRole("button", {
          name: /Expand source https:\/\/youtu\.be\/x/i,
        }),
      ).toBeNull();
    });
  });

  it("opens a full-screen overlay when the chat pop-out is toggled", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Clarification chat" });

    const popOut = await screen.findByRole("button", { name: /Pop out/i });
    fireEvent.click(popOut);
    expect(
      screen.getByRole("dialog", { name: /Compose chat full screen/i }),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /Compose chat full screen/i }),
      ).toBeNull(),
    );
  });

  it("does not expose manual analysis or reset controls", async () => {
    render(<ComposeWorkspace />);
    fireEvent.click(
      await screen.findByRole("button", { name: /New Session/i }),
    );
    fireEvent.change(screen.getByLabelText(/Session name/i), {
      target: { value: "Idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/i }));
    await screen.findByRole("region", { name: "Sources" });
    expect(
      screen.queryByRole("button", { name: /Analyze Sources/i }),
    ).toBeNull();
    expect(screen.queryByText(/Code repositories/i)).toBeNull();
  });
});
