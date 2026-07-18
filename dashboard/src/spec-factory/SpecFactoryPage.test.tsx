// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  SpecFactoryPage,
  decodeEscapedFormattedText,
} from "./SpecFactoryPage.js";

const cssPath = existsSync("dashboard/src/spec-factory/SpecFactoryPage.css")
  ? "dashboard/src/spec-factory/SpecFactoryPage.css"
  : "src/spec-factory/SpecFactoryPage.css";

describe("formatted text normalization", () => {
  it("decodes repeated model-escaped line breaks and quotes", () => {
    expect(
      decodeEscapedFormattedText(
        'Partly.\\n\\nWhat it answers:\\n1. PBP \\"determines\\" ownership.',
      ),
    ).toBe('Partly.\n\nWhat it answers:\n1. PBP "determines" ownership.');
  });

  it("preserves isolated escaped text that may be code", () => {
    expect(decodeEscapedFormattedText('const newline = "\\n";')).toBe(
      'const newline = "\\n";',
    );
  });
});

const candidatePayload = [
  {
    id: 1,
    sourceJiraKey: "CPDEV-22410",
    sourceSummary: "Enrollment sync rules",
    sourceStatus: "In Progress",
    loeHours: 38,
    state: "draft_ready",
    origin: "louise",
    approvedEpicKey: null,
    qualificationReasons: [],
    errorMessage: null,
    updatedAt: "2026-05-27T12:00:00.000Z",
  },
  {
    id: 2,
    sourceJiraKey: "COMPOSE-7",
    sourceSummary: "Compose onboarding flow",
    sourceStatus: "Ready",
    loeHours: 12,
    state: "draft_ready",
    origin: "compose",
    approvedEpicKey: null,
    qualificationReasons: [],
    errorMessage: null,
    updatedAt: "2026-05-27T13:00:00.000Z",
  },
];

const statusPayload = {
  generatedAt: "2026-06-08T14:00:00.000Z",
  board: {
    activeSourceCount: 2,
    latestRefreshAt: "2026-06-08T13:55:00.000Z",
    byState: {
      candidate: 0,
      drafting: 0,
      draft_ready: 2,
      approved: 0,
      oneshot_submitted: 0,
      needs_attention: 0,
      not_qualified: 0,
      archived: 0,
    },
    byOrigin: { louise: 1, compose: 1 },
  },
  processing: {
    byStatus: { queued: 3, running: 1, succeeded: 8, failed: 1 },
    staleRunning: 1,
    oldestQueuedAt: "2026-06-08T13:45:00.000Z",
    oldestRunningAt: "2026-06-08T13:40:00.000Z",
  },
  composeConversion: {
    byStatus: {
      awaiting_upload: 0,
      pending: 2,
      converting: 1,
      converted: 5,
      unsupported: 1,
      failed: 1,
    },
    inFlight: 3,
    retryable: 2,
    oldestPendingAt: "2026-06-08T13:50:00.000Z",
    oldestConvertingAt: "2026-06-08T13:52:00.000Z",
  },
  composeControlPlane: {
    turns: {
      byStatus: {
        queued: 4,
        running: 2,
        waiting_on_research: 1,
        awaiting_user_input: 0,
        synthesizing: 0,
        completed: 20,
        failed: 1,
        abandoned: 3,
        cancelled: 0,
      },
      durableQueued: 4,
      durableRunning: 3,
      durableAbandoned: 3,
      legacyInflight: 2,
      legacyQueued: 1,
      duplicateSuppressedToday: 6,
      leaseExpired: 2,
      leaseFenceRejected: 5,
      outcomesByContextVersionToday: [
        {
          contextVersionUsed: 4,
          completed: 8,
          failed: 1,
          cancelled: 0,
          abandoned: 0,
          total: 9,
        },
        {
          contextVersionUsed: null,
          completed: 2,
          failed: 0,
          cancelled: 1,
          abandoned: 0,
          total: 3,
        },
      ],
      oldestQueuedAt: "2026-06-08T13:44:00.000Z",
      oldestRunningAt: "2026-06-08T13:41:00.000Z",
    },
    agentTasks: {
      byStatus: {
        queued: 5,
        running: 2,
        completed: 13,
        failed: 1,
        cancelled: 0,
        abandoned: 2,
      },
      queued: 5,
      running: 2,
      completed: 13,
      failed: 1,
      abandoned: 2,
      leaseExpired: 1,
      leaseFenceRejected: 4,
      byCapability: {
        code_research: {
          queued: 3,
          running: 1,
          completed: 5,
          failed: 1,
          cancelled: 0,
          abandoned: 0,
          total: 10,
          leaseExpired: 1,
          oldestQueuedAt: "2026-06-08T13:46:00.000Z",
          oldestRunningAt: "2026-06-08T13:47:00.000Z",
        },
        critic_review: {
          queued: 0,
          running: 0,
          completed: 8,
          failed: 0,
          cancelled: 0,
          abandoned: 1,
          total: 9,
          leaseExpired: 0,
          oldestQueuedAt: null,
          oldestRunningAt: null,
        },
      },
      oldestQueuedAt: "2026-06-08T13:47:00.000Z",
      oldestRunningAt: "2026-06-08T13:48:00.000Z",
    },
    llm: {
      callsToday: 9,
      failedToday: 2,
      inputTokensToday: 1500,
      outputTokensToday: 700,
      estimatedCostUsdToday: 1.75,
      latestCallAt: "2026-06-08T13:49:00.000Z",
      byPurposeToday: {
        chat_coordinator_fast: {
          callsToday: 5,
          failedToday: 1,
          inputTokensToday: 900,
          outputTokensToday: 420,
          estimatedCostUsdToday: 1.2,
          latestCallAt: "2026-06-08T13:53:00.000Z",
        },
        critic_review: {
          callsToday: 4,
          failedToday: 1,
          inputTokensToday: 600,
          outputTokensToday: 280,
          estimatedCostUsdToday: 0.55,
          latestCallAt: "2026-06-08T13:54:00.000Z",
        },
      },
    },
    workers: {
      total: 3,
      live: 2,
      stale: 1,
      byMode: {
        "all-local": {
          total: 0,
          live: 0,
          stale: 0,
          latestHeartbeatAt: null,
        },
        api: {
          total: 1,
          live: 1,
          stale: 0,
          latestHeartbeatAt: "2026-06-08T13:49:00.000Z",
        },
        worker: {
          total: 1,
          live: 0,
          stale: 1,
          latestHeartbeatAt: "2026-06-08T13:47:00.000Z",
        },
        "research-worker": {
          total: 1,
          live: 1,
          stale: 0,
          latestHeartbeatAt: "2026-06-08T13:48:00.000Z",
        },
        "conversion-worker": {
          total: 0,
          live: 0,
          stale: 0,
          latestHeartbeatAt: null,
        },
      },
    },
    coordinator: {
      decisionsToday: {
        answer: 6,
        dispatchResearch: 2,
        askClarification: 1,
        escalate: 1,
        rejected: 3,
      },
      latestDecisionAt: "2026-06-08T13:54:00.000Z",
    },
    retention: {
      pendingWorkspaceCleanup: 6,
      failedWorkspaceCleanup: 2,
      oldestPendingArchivedAt: "2026-05-01T00:00:00.000Z",
      latestCleanupErrorAt: "2026-06-01T00:00:00.000Z",
      pendingLlmAuditArtifacts: 4,
      oldestPendingLlmAuditArtifactAt: "2026-05-02T00:00:00.000Z",
    },
    events: {
      durablePublishedToday: 44,
      durablePersistFailuresToday: 1,
      payloadTooLargeToday: 2,
      liveDeliveredByThisReplica: 8,
      replayedByThisReplica: 3,
      latestPublishedAt: "2026-06-08T13:58:00.000Z",
      latestDurableErrorAt: "2026-06-08T13:55:00.000Z",
    },
    streams: {
      activeSubscribers: 4,
      activeSessions: 2,
      connectedByThisReplica: 9,
      disconnectedByThisReplica: 5,
    },
    streamTokens: {
      activeTokens: 6,
      expiredUnrevokedTokens: 2,
      createdToday: 9,
      revokedToday: 3,
      latestCreatedAt: "2026-06-08T13:59:00.000Z",
      latestRevokedAt: "2026-06-08T14:00:00.000Z",
    },
    research: {
      runningTasks: 2,
      completedToday: 7,
      failedToday: 1,
      avgRuntimeSecondsToday: 42.5,
      maxRuntimeSecondsToday: 120,
      oldestRunningStartedAt: "2026-06-08T13:59:00.000Z",
      latestTerminalAt: "2026-06-08T14:00:00.000Z",
    },
    context: {
      patchesReady: 4,
      patchesBuilding: 1,
      patchesFailed: 2,
      oldestReadyPatchAt: "2026-06-08T13:56:00.000Z",
      versionsCommittedToday: 6,
      versionsFailedToday: 1,
      versionsBuilding: 1,
      latestCommittedVersionAt: "2026-06-08T13:57:00.000Z",
      latestFailedVersionAt: "2026-06-08T13:58:00.000Z",
    },
  },
};

const draftPayload = {
  id: 44,
  sourceId: 1,
  version: 1,
  evidenceSnapshotId: null,
  status: "ready",
  draft: {
    sourceJiraKey: "CPDEV-22410",
    epic: {
      summary: "Deliver enrollment sync rules",
      description: "Convert raw Louise requirements into repo-scoped work.",
      businessContext: ["Louise estimated the raw requirement."],
      acceptanceCriteria: ["Epic can be approved.", "Children can be OneShot."],
      assumptions: [],
      dependencies: [],
    },
    childTickets: [
      {
        repoName: "core-app",
        summary: "Implement sync rule service changes",
        overview: "Add service handling.",
        acceptanceCriteria: ["Rules apply.", "Existing flows keep working."],
        technicalDetails: {
          repo: "core-app",
          targetFiles: ["src/rules.ts"],
          implementationNotes: ["Inspect current master branch."],
        },
        outOfScope: [],
        testingNotes: [],
        sourceEvidenceRefs: [],
      },
    ],
    evidenceSummary: ["LOE attachment and repo grounding reviewed."],
    warnings: [],
  },
  renderedMarkdown: "# Deliver enrollment sync rules",
  evidenceManifest: {},
  childTickets: [
    {
      id: 99,
      repoName: "core-app",
      summary: "Implement sync rule service changes",
      description: null,
      loeHours: 18,
      jiraKey: null,
      state: "draft",
      oneshotRequestId: null,
      oneshotRunId: null,
      errorMessage: null,
    },
  ],
  errorMessage: null,
  createdAt: "2026-05-27T12:00:00.000Z",
  updatedAt: "2026-05-27T12:00:00.000Z",
};

const eventPayload = [
  {
    id: 701,
    sourceId: 1,
    eventType: "draft_generation_queued",
    actor: "kkompalli",
    metadata: { jobId: 44 },
    createdAt: "2026-06-08T13:58:00.000Z",
  },
];

const attachmentPayload = [
  {
    id: 301,
    sourceId: 1,
    jiraAttachmentId: "att-1",
    filename: "Development-Plan.md",
    mimeType: "text/markdown",
    sizeBytes: 2400,
    artifactKind: "code-change",
    isPriority: true,
    s3Bucket: "specter-results",
    s3Key: "spec-factory/CPDEV-22410/attachments/att-1-Development-Plan.md",
    sha256: "a".repeat(64),
    extractedText: "Implement API validation.",
    extractionStatus: "extracted",
    errorMessage: null,
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:01:00.000Z",
  },
  {
    id: 302,
    sourceId: 1,
    jiraAttachmentId: "att-2",
    filename: "Architecture.png",
    mimeType: "image/png",
    sizeBytes: 9000,
    artifactKind: "screenshot",
    isPriority: false,
    s3Bucket: null,
    s3Key: null,
    sha256: null,
    extractedText: null,
    extractionStatus: "failed",
    errorMessage: "Jira attachment download failed",
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:01:00.000Z",
  },
];

const retriedAttachmentPayload = [
  attachmentPayload[0],
  {
    ...attachmentPayload[1],
    s3Bucket: "specter-results",
    s3Key: "spec-factory/CPDEV-22410/attachments/att-2-Architecture.png",
    extractionStatus: "stored",
    errorMessage: null,
  },
];

const priorityFailedAttachmentPayload = [
  {
    ...attachmentPayload[0],
    s3Bucket: null,
    s3Key: null,
    sha256: null,
    extractedText: null,
    extractionStatus: "failed",
    errorMessage: "Priority attachment download failed",
  },
];

const approvedCandidatePayload = [
  {
    ...candidatePayload[0],
    state: "approved",
    approvedEpicKey: "CPDEV-22411",
  },
];

const archivedCandidatePayload = [
  {
    ...candidatePayload[0],
    state: "archived",
    qualificationReasons: ["config_only"],
    errorMessage: "Configuration-only work was discarded from the board.",
  },
];

const approvedDraftPayload = {
  ...draftPayload,
  status: "approved",
  childTickets: [
    {
      ...draftPayload.childTickets[0],
      jiraKey: "CPDEV-22412",
      state: "created",
    },
  ],
};

const twoChildDraftPayload = {
  ...draftPayload,
  draft: {
    ...draftPayload.draft,
    childTickets: [
      draftPayload.draft.childTickets[0],
      {
        ...draftPayload.draft.childTickets[0],
        repoName: "service-api",
        summary: "Implement API validation",
      },
    ],
  },
  childTickets: [
    draftPayload.childTickets[0],
    {
      ...draftPayload.childTickets[0],
      id: 100,
      repoName: "service-api",
      summary: "Implement API validation",
      jiraKey: null,
    },
  ],
};

const partialPublishDraftPayload = {
  ...twoChildDraftPayload,
  status: "ready",
  childTickets: [
    {
      ...twoChildDraftPayload.childTickets[0],
      jiraKey: "CPDEV-22412",
      state: "created",
    },
    twoChildDraftPayload.childTickets[1],
  ],
};

const approvedTwoChildDraftPayload = {
  ...twoChildDraftPayload,
  status: "approved",
  childTickets: [
    {
      ...twoChildDraftPayload.childTickets[0],
      jiraKey: "CPDEV-22412",
      state: "created",
    },
    {
      ...twoChildDraftPayload.childTickets[1],
      jiraKey: "CPDEV-22413",
      state: "created",
    },
  ],
};

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/spec-factory/status") {
        return Promise.resolve(response(statusPayload));
      }
      if (url.endsWith("/sources/refresh")) {
        return Promise.resolve(
          response({
            refresh: { scanned: 1, upserted: 1 },
            sources: candidatePayload,
          }),
        );
      }
      if (url === "/api/spec-factory/sources") {
        return Promise.resolve(response(candidatePayload));
      }
      if (url.endsWith("/sources/1/drafts")) {
        return Promise.resolve(
          response({
            queued: true,
            source: candidatePayload[0],
            draft: draftPayload,
          }),
        );
      }
      if (url.endsWith("/drafts/44/approve")) {
        return Promise.resolve(
          response({ ...draftPayload, status: "approved" }),
        );
      }
      if (url.endsWith("/drafts/44") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return Promise.resolve(
          response({
            ...draftPayload,
            id: 45,
            version: 2,
            draft: body.draft,
          }),
        );
      }
      if (url.endsWith("/drafts/latest"))
        return Promise.resolve(response(draftPayload));
      if (url.endsWith("/sources/1/events"))
        return Promise.resolve(response(eventPayload));
      if (url.endsWith("/sources/1/attachments"))
        return Promise.resolve(response(attachmentPayload));
      if (url.endsWith("/sources/1/attachments/retry")) {
        return Promise.resolve(
          response(
            {
              source: candidatePayload[0],
              attachments: retriedAttachmentPayload,
              retriedCount: 1,
              beforeAttentionCount: 1,
              afterAttentionCount: 0,
            },
            true,
            202,
          ),
        );
      }
      if (url.endsWith("/oneshot/submissions")) {
        return Promise.resolve(
          response([{ source: candidatePayload[0], childTickets: [] }]),
        );
      }
      if (url.endsWith("/archive/sources")) {
        return Promise.resolve(response(archivedCandidatePayload));
      }
      if (url.endsWith("/sources/1/discard")) {
        return Promise.resolve(response(archivedCandidatePayload[0]));
      }
      if (url.endsWith("/sources/1/restore")) {
        return Promise.resolve(
          response({ ...candidatePayload[0], state: "draft_ready" }),
        );
      }
      if (url.endsWith("/compose/sessions")) {
        return Promise.resolve(response([]));
      }
      return Promise.resolve(response(candidatePayload));
    }),
  );
  class FakeEventSource {
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  vi.stubGlobal("EventSource", FakeEventSource as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SpecFactoryPage", () => {
  it("uses a compact Spec Factory brand mark in the navigation rail", async () => {
    render(<SpecFactoryPage />);

    await screen.findByRole("dialog", { name: /Compose session/i });

    const nav = screen.getByRole("navigation", {
      name: "Spec Factory sections",
    });
    const logos = within(nav).getAllByRole("img");

    expect(logos.map((logo) => logo.getAttribute("alt"))).toEqual([
      "Spec Factory",
    ]);
    expect(logos[0].getAttribute("src")).toBe("/spec-factory/mhk-logo.png");
  });

  it("refreshes board sources when the page loads", async () => {
    render(<SpecFactoryPage />);

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/spec-factory/sources/refresh",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("renders source sticky notes with LOE hours and origin", async () => {
    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Spec Board" }));

    expect(
      await screen.findByRole("button", {
        name: "CPDEV-22410 Enrollment sync rules",
      }),
    ).toBeTruthy();
    expect(screen.getAllByText("38h").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Louise").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Compose").length).toBeGreaterThan(0);
    expect(screen.getByText("Enrollment sync rules")).toBeTruthy();
  });

  it("renders Spec Factory health from the status endpoint", async () => {
    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Spec Board" }));

    expect(
      await screen.findByRole("region", { name: "Spec Factory health" }),
    ).toBeTruthy();
    expect(screen.getByText("2 active")).toBeTruthy();
    expect(screen.getByText("3 queued / 1 running")).toBeTruthy();
    expect(screen.getByText("1 stale worker")).toBeTruthy();
    expect(screen.getByText("2 retryable failures")).toBeTruthy();
    expect(screen.getByText("Compose turns")).toBeTruthy();
    expect(screen.getByText("4 queued / 3 running")).toBeTruthy();
    expect(screen.getByText("2 legacy active / 1 legacy queued")).toBeTruthy();
    expect(screen.getByText("3 abandoned / 2 lease expired")).toBeTruthy();
    expect(screen.getByText("6 duplicates suppressed")).toBeTruthy();
    expect(screen.getByText("5 fence rejected")).toBeTruthy();
    expect(screen.getByText("v4: 8 completed / 1 failed")).toBeTruthy();
    expect(screen.getByText("Agent tasks")).toBeTruthy();
    expect(screen.getByText("5 queued / 2 running")).toBeTruthy();
    expect(screen.getByText("2 abandoned / 1 lease expired")).toBeTruthy();
    expect(screen.getByText("4 fence rejected")).toBeTruthy();
    expect(
      screen.getByText("code_research: 3 queued / 1 running"),
    ).toBeTruthy();
    expect(screen.getByText("LLM spend")).toBeTruthy();
    expect(screen.getByText("$1.75 today")).toBeTruthy();
    expect(screen.getByText("9 calls / 2 failed")).toBeTruthy();
    expect(screen.getByText("chat_coordinator_fast: $1.20")).toBeTruthy();
    expect(screen.getByText("Workers")).toBeTruthy();
    expect(screen.getByText("2 live / 1 stale")).toBeTruthy();
    expect(screen.getByText("Coordinator")).toBeTruthy();
    expect(screen.getByText("6 answer / 2 research")).toBeTruthy();
    expect(
      screen.getByText("1 clarify / 1 escalate / 3 rejected"),
    ).toBeTruthy();
    expect(screen.getByText("Retention")).toBeTruthy();
    expect(
      screen.getByText("6 cleanup pending / 4 audit artifacts"),
    ).toBeTruthy();
    expect(screen.getByText("2 cleanup errors")).toBeTruthy();
    expect(screen.getByText(/Oldest audit artifact/)).toBeTruthy();
    expect(screen.getByText("Events")).toBeTruthy();
    expect(screen.getByText("44 durable today")).toBeTruthy();
    expect(screen.getByText("8 live / 3 replayed")).toBeTruthy();
    expect(screen.getByText("1 persist failed")).toBeTruthy();
    expect(screen.getByText("2 payload too large")).toBeTruthy();
    expect(screen.getByText("Streams")).toBeTruthy();
    expect(screen.getByText("4 active subscribers")).toBeTruthy();
    expect(screen.getByText("2 active sessions")).toBeTruthy();
    expect(screen.getByText("9 connected / 5 disconnected")).toBeTruthy();
    expect(screen.getByText("Stream tokens")).toBeTruthy();
    expect(screen.getByText("6 active tokens")).toBeTruthy();
    expect(screen.getByText("9 minted / 3 revoked")).toBeTruthy();
    expect(screen.getByText("2 expired unrevoked")).toBeTruthy();
    expect(screen.getByText("Research")).toBeTruthy();
    expect(screen.getByText("2 running tasks")).toBeTruthy();
    expect(screen.getByText("7 completed / 1 failed")).toBeTruthy();
    expect(screen.getByText("42.5s avg / 120s max")).toBeTruthy();
    expect(screen.getByText("Context")).toBeTruthy();
    expect(screen.getByText("4 patches ready")).toBeTruthy();
    expect(screen.getByText("1 building / 2 failed")).toBeTruthy();
    expect(screen.getByText("6 versions today / 1 failed")).toBeTruthy();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => url === "/api/spec-factory/status"),
    ).toBe(true);
  });

  it("filters the Spec Board by source origin", async () => {
    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Spec Board" }));

    expect(await screen.findByText("Enrollment sync rules")).toBeTruthy();
    expect(screen.getByText("Compose onboarding flow")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Compose 1/i }));

    expect(screen.getByText("Compose onboarding flow")).toBeTruthy();
    expect(screen.queryByText("Enrollment sync rules")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /All 2/i }));

    expect(screen.getByText("Enrollment sync rules")).toBeTruthy();
    expect(screen.getByText("Compose onboarding flow")).toBeTruthy();
  });

  it("falls back to cached board sources when auto-refresh fails", async () => {
    vi.mocked(fetch).mockImplementation((url: string) => {
      if (url === "/api/spec-factory/status") {
        return Promise.resolve(response(statusPayload));
      }
      if (url.endsWith("/sources/refresh")) {
        return Promise.resolve(
          response({ error: { message: "Jira unavailable" } }, false, 500),
        );
      }
      if (url === "/api/spec-factory/sources") {
        return Promise.resolve(response(candidatePayload));
      }
      if (url.endsWith("/drafts/latest")) {
        return Promise.resolve(response(draftPayload));
      }
      if (url.endsWith("/sources/1/events")) {
        return Promise.resolve(response(eventPayload));
      }
      return Promise.resolve(response(candidatePayload));
    });

    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Spec Board" }));

    expect(
      await screen.findByRole("button", {
        name: "CPDEV-22410 Enrollment sync rules",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Jira unavailable")).toBeTruthy();
  });

  it("clamps long Spec Board card titles so metadata cannot overlap", () => {
    const specFactoryCss = readFileSync(cssPath, "utf8");

    expect(specFactoryCss).toMatch(
      /\.sf-card-title\s*\{[^}]*-webkit-line-clamp:\s*3/s,
    );
    expect(specFactoryCss).toMatch(
      /\.sf-card-title\s*\{[^}]*overflow:\s*hidden/s,
    );
    expect(specFactoryCss).toMatch(
      /\.sf-card-title\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    );
  });

  it("keeps preview controls scrollable so rail actions stay reachable", () => {
    const specFactoryCss = readFileSync(cssPath, "utf8");

    expect(specFactoryCss).toMatch(
      /\.sf-preview-rail\s*\{[^}]*overflow-y:\s*auto/s,
    );
    expect(specFactoryCss).toMatch(
      /\.sf-preview-rail\s+\.sf-modal-actions\s*\{[^}]*position:\s*sticky/s,
    );
    expect(specFactoryCss).toMatch(
      /\.sf-preview-rail\s+\.sf-modal-actions\s*\{[^}]*bottom:\s*0/s,
    );
  });

  it("opens the Epic preview modal for a selected source ticket", async () => {
    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Spec Board" }));
    fireEvent.click(await screen.findByRole("button", { name: /CPDEV-22410/ }));

    expect(
      await screen.findByRole("dialog", {
        name: /Deliver enrollment sync rules/,
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText("Deliver enrollment sync rules")).toBeTruthy(),
    );
    expect(screen.getByText("Approve Epic")).toBeTruthy();
    expect(screen.getByText("OneShot Now")).toBeTruthy();
    expect(await screen.findByText("Draft Queued")).toBeTruthy();
    expect(screen.getByText(/kkompalli/)).toBeTruthy();
    expect(
      await screen.findByText("2 total / 1 processed / 1 attention"),
    ).toBeTruthy();
    expect(screen.getByText("Development-Plan.md")).toBeTruthy();
    expect(screen.getByText("Architecture.png")).toBeTruthy();
    expect(screen.getByText("Jira attachment download failed")).toBeTruthy();
    expect(
      screen.getByText(/Draft generation can continue with 1 non-priority/i),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Generate / Refresh Draft",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Retry Attachments" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/spec-factory/sources/1/attachments/retry",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(
      await screen.findByText("2 total / 2 processed / 0 attention"),
    ).toBeTruthy();
    expect(screen.queryByText("Jira attachment download failed")).toBeNull();
  });

  it("blocks draft generation until priority attachment attention is resolved", async () => {
    vi.mocked(fetch).mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/spec-factory/status") {
        return Promise.resolve(response(statusPayload));
      }
      if (url.endsWith("/sources/refresh")) {
        return Promise.resolve(
          response({
            refresh: { scanned: 1, upserted: 1 },
            sources: candidatePayload,
          }),
        );
      }
      if (url === "/api/spec-factory/sources") {
        return Promise.resolve(response(candidatePayload));
      }
      if (url.endsWith("/drafts/latest")) {
        return Promise.resolve(response(draftPayload));
      }
      if (url.endsWith("/sources/1/events")) {
        return Promise.resolve(response(eventPayload));
      }
      if (url.endsWith("/sources/1/attachments")) {
        return Promise.resolve(response(priorityFailedAttachmentPayload));
      }
      if (url.endsWith("/sources/1/attachments/retry")) {
        return Promise.resolve(
          response(
            {
              source: candidatePayload[0],
              attachments: [attachmentPayload[0]],
              retriedCount: 1,
              beforeAttentionCount: 1,
              afterAttentionCount: 0,
            },
            true,
            202,
          ),
        );
      }
      if (url.endsWith("/sources/1/drafts")) {
        return Promise.resolve(
          response({
            queued: true,
            source: candidatePayload[0],
            draft: draftPayload,
          }),
        );
      }
      if (url.endsWith("/compose/sessions")) {
        return Promise.resolve(response([]));
      }
      return Promise.resolve(response(candidatePayload));
    });

    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Spec Board" }));
    fireEvent.click(await screen.findByRole("button", { name: /CPDEV-22410/ }));

    expect(
      await screen.findByText(/Draft generation is blocked by 1 priority/i),
    ).toBeTruthy();
    const generateButton = screen.getByRole("button", {
      name: "Generate / Refresh Draft",
    }) as HTMLButtonElement;
    expect(generateButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Retry Attachments" }));

    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Generate / Refresh Draft",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Generate / Refresh Draft" }),
    );

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/spec-factory/sources/1/drafts",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("shows published Epic details after Jira approval", async () => {
    vi.mocked(fetch).mockImplementation((url: string) => {
      if (url === "/api/spec-factory/status") {
        return Promise.resolve(response(statusPayload));
      }
      if (url.endsWith("/sources/refresh")) {
        return Promise.resolve(
          response({
            refresh: { scanned: 0, upserted: 0 },
            sources: approvedCandidatePayload,
          }),
        );
      }
      if (url === "/api/spec-factory/sources") {
        return Promise.resolve(response(approvedCandidatePayload));
      }
      if (url.endsWith("/drafts/latest")) {
        return Promise.resolve(response(approvedDraftPayload));
      }
      if (url.endsWith("/sources/1/events")) {
        return Promise.resolve(response(eventPayload));
      }
      return Promise.resolve(response(approvedCandidatePayload));
    });

    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Spec Board" }));
    fireEvent.click(await screen.findByRole("button", { name: /CPDEV-22410/ }));

    expect(
      await screen.findByRole("region", { name: "Published Epic" }),
    ).toBeTruthy();
    expect(screen.getAllByText("CPDEV-22411").length).toBeGreaterThan(0);
    expect(screen.getByText("CPDEV-22412")).toBeTruthy();
    const publishedEpicLink = screen.getByRole("link", {
      name: "CPDEV-22411",
    });
    expect(publishedEpicLink.getAttribute("href")).toBe(
      "https://mhkjira.atlassian.net/browse/CPDEV-22411",
    );
    expect(publishedEpicLink.getAttribute("target")).toBe("_blank");
    expect(
      screen.getByRole("link", { name: "CPDEV-22410" }).getAttribute("href"),
    ).toBe("https://mhkjira.atlassian.net/browse/CPDEV-22410");
    expect(
      screen.getByRole("link", { name: "CPDEV-22412" }).getAttribute("href"),
    ).toBe("https://mhkjira.atlassian.net/browse/CPDEV-22412");
    expect(
      screen.getAllByText("Implement sync rule service changes").length,
    ).toBeGreaterThan(0);
  });

  it("shows the Compose session modal on the compose tab", async () => {
    render(<SpecFactoryPage />);
    // compose is the default tab
    expect(
      await screen.findByRole("dialog", { name: /Compose session/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /New Session/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Load Session/i })).toBeTruthy();
  });

  it("renders cross-product Specter navigation links", async () => {
    render(<SpecFactoryPage />);

    await screen.findByRole("dialog", { name: /Compose session/i });

    const compose = screen.getByRole("button", { name: "Compose" });
    expect(
      compose
        .closest(".sf-nav-group")
        ?.classList.contains("sf-nav-group-specter"),
    ).toBe(false);
    const floor = screen.getByRole("button", { name: "Floor" });
    expect(
      floor
        .closest(".sf-nav-group")
        ?.classList.contains("sf-nav-group-specter"),
    ).toBe(true);
    expect(floor).toBeTruthy();
    expect(screen.getByRole("button", { name: "OneShot" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Watchdog" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Production Support" }),
    ).toBeTruthy();
  });

  it("generates a draft from the preview modal", async () => {
    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Spec Board" }));
    fireEvent.click(await screen.findByRole("button", { name: /CPDEV-22410/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Generate / Refresh Draft" }),
    );

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/spec-factory/sources/1/drafts",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("saves an edited draft as a new revision from the preview modal", async () => {
    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Spec Board" }));
    fireEvent.click(await screen.findByRole("button", { name: /CPDEV-22410/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Draft" }));
    fireEvent.change(await screen.findByLabelText("Epic summary"), {
      target: { value: "Edited enrollment sync rules" },
    });
    fireEvent.change(screen.getByLabelText("Epic acceptance criteria"), {
      target: {
        value:
          "Epic can be approved.\nChildren can be OneShot.\nEdited criteria survives.",
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save Draft Revision" }),
    );

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/spec-factory/drafts/44",
        expect.objectContaining({ method: "PUT" }),
      ),
    );
    const updateCall = vi
      .mocked(fetch)
      .mock.calls.find(
        ([url, init]) =>
          url === "/api/spec-factory/drafts/44" && init?.method === "PUT",
      );
    expect(updateCall).toBeTruthy();
    const body = JSON.parse(String(updateCall?.[1]?.body));
    expect(body.sourceId).toBe(1);
    expect(body.draft.epic.summary).toBe("Edited enrollment sync rules");
    expect(body.draft.epic.acceptanceCriteria).toContain(
      "Edited criteria survives.",
    );
    expect(
      await screen.findByRole("heading", {
        name: "Edited enrollment sync rules",
      }),
    ).toBeTruthy();
  });

  it("approves a ready ticket when dropped into the Approved lane", async () => {
    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Spec Board" }));
    const card = await screen.findByRole("button", {
      name: "CPDEV-22410 Enrollment sync rules",
    });

    const dataTransfer = {
      effectAllowed: "",
      dropEffect: "",
      setData: vi.fn(),
      getData: vi.fn(() => "1"),
    };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.drop(screen.getByRole("region", { name: "Approved" }), {
      dataTransfer,
    });

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/spec-factory/drafts/44/approve",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("shows partial Jira publish state after an approval failure", async () => {
    let publishFailed = false;
    vi.mocked(fetch).mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/spec-factory/status") {
        return Promise.resolve(response(statusPayload));
      }
      if (url.endsWith("/sources/refresh")) {
        const sources = publishFailed
          ? [
              {
                ...candidatePayload[0],
                state: "approved",
                approvedEpicKey: "CPDEV-22411",
              },
            ]
          : candidatePayload;
        return Promise.resolve(
          response({
            refresh: { scanned: 0, upserted: 0 },
            sources,
          }),
        );
      }
      if (url === "/api/spec-factory/sources") {
        return Promise.resolve(
          response(
            publishFailed
              ? [
                  {
                    ...candidatePayload[0],
                    state: "approved",
                    approvedEpicKey: "CPDEV-22411",
                  },
                ]
              : candidatePayload,
          ),
        );
      }
      if (url.endsWith("/drafts/latest")) {
        return Promise.resolve(
          response(
            publishFailed ? partialPublishDraftPayload : twoChildDraftPayload,
          ),
        );
      }
      if (url.endsWith("/drafts/44/approve") && init?.method === "POST") {
        publishFailed = true;
        return Promise.resolve(
          response(
            { error: { message: "second child create failed" } },
            false,
            500,
          ),
        );
      }
      if (url.endsWith("/sources/1/events")) {
        return Promise.resolve(
          response(
            publishFailed
              ? [
                  {
                    id: 702,
                    sourceId: 1,
                    eventType: "draft_publish_failed",
                    actor: "kkompalli",
                    metadata: {
                      failedStep: "child",
                      failedChild: {
                        childId: 100,
                        repoName: "service-api",
                        summary: "Implement API validation",
                      },
                      createdChildren: [
                        { childId: 99, jiraKey: "CPDEV-22412" },
                      ],
                      error: "second child create failed",
                    },
                    createdAt: "2026-06-08T14:01:00.000Z",
                  },
                ]
              : eventPayload,
          ),
        );
      }
      if (url.endsWith("/oneshot/submissions")) {
        return Promise.resolve(response([]));
      }
      if (url.endsWith("/archive/sources")) {
        return Promise.resolve(response([]));
      }
      if (url.endsWith("/compose/sessions")) {
        return Promise.resolve(response([]));
      }
      return Promise.resolve(response(candidatePayload));
    });

    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Spec Board" }));
    fireEvent.click(await screen.findByRole("button", { name: /CPDEV-22410/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve Epic" }),
    );

    expect(
      (await screen.findAllByRole("alert")).some((alert) =>
        alert.textContent?.includes("second child create failed"),
      ),
    ).toBe(true);
    expect(await screen.findByText("Partial publish")).toBeTruthy();
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getByText("CPDEV-22412")).toBeTruthy();
    expect(
      screen.getByText(/Failed child: Implement API validation/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Created before failure: CPDEV-22412/i),
    ).toBeTruthy();
    expect(screen.getByText(/Error: second child create failed/i)).toBeTruthy();
    expect(screen.getByText(/use Retry Publish/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry Publish" })).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "OneShot Now",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("Draft Publish Failed")).toBeTruthy();
  });

  it("shows OneShot submission failure details after a partial submission", async () => {
    let oneshotFailed = false;
    vi.mocked(fetch).mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/spec-factory/status") {
        return Promise.resolve(response(statusPayload));
      }
      if (url.endsWith("/sources/refresh")) {
        return Promise.resolve(
          response({
            refresh: { scanned: 0, upserted: 0 },
            sources: approvedCandidatePayload,
          }),
        );
      }
      if (url === "/api/spec-factory/sources") {
        return Promise.resolve(response(approvedCandidatePayload));
      }
      if (url.endsWith("/drafts/latest")) {
        return Promise.resolve(response(approvedTwoChildDraftPayload));
      }
      if (url.endsWith("/sources/1/oneshot") && init?.method === "POST") {
        oneshotFailed = true;
        return Promise.resolve(
          response(
            { error: { message: "second child submit failed" } },
            false,
            500,
          ),
        );
      }
      if (url.endsWith("/sources/1/events")) {
        return Promise.resolve(
          response(
            oneshotFailed
              ? [
                  {
                    id: 703,
                    sourceId: 1,
                    eventType: "oneshot_submission_failed",
                    actor: "kkompalli",
                    metadata: {
                      submittedResults: [{ childId: 99, requestId: 701 }],
                      failedChild: {
                        childId: 100,
                        repoName: "service-api",
                        summary: "Implement API validation",
                        jiraKey: "CPDEV-22413",
                      },
                      error: "second child submit failed",
                    },
                    createdAt: "2026-06-08T14:02:00.000Z",
                  },
                ]
              : eventPayload,
          ),
        );
      }
      if (url.endsWith("/oneshot/submissions")) {
        return Promise.resolve(response([]));
      }
      if (url.endsWith("/archive/sources")) {
        return Promise.resolve(response([]));
      }
      if (url.endsWith("/compose/sessions")) {
        return Promise.resolve(response([]));
      }
      return Promise.resolve(response(approvedCandidatePayload));
    });

    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Spec Board" }));
    fireEvent.click(await screen.findByRole("button", { name: /CPDEV-22410/ }));
    expect(
      await screen.findByRole("region", { name: "Published Epic" }),
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "OneShot Now" }));

    expect(
      (await screen.findAllByRole("alert")).some((alert) =>
        alert.textContent?.includes("second child submit failed"),
      ),
    ).toBe(true);
    expect(await screen.findByText("Oneshot Submission Failed")).toBeTruthy();
    expect(screen.getByText(/Failed child: CPDEV-22413/i)).toBeTruthy();
    expect(
      screen.getByText(/Submitted before failure: Child #99 request #701/i),
    ).toBeTruthy();
    expect(screen.getByText(/Error: second child submit failed/i)).toBeTruthy();
  });

  it("switches to submitted Development work", async () => {
    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Development" }));

    expect(
      await screen.findByRole("heading", { name: "Development" }),
    ).toBeTruthy();
    expect(screen.getByText("CPDEV-22410")).toBeTruthy();
  });

  it("switches to archived Spec Factory work", async () => {
    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(
      await screen.findByRole("heading", { name: "Archive" }),
    ).toBeTruthy();
    expect(screen.getByText("Config Only")).toBeTruthy();
    expect(screen.getByText("CPDEV-22410")).toBeTruthy();
  });

  it("restores an archived source from the preview modal", async () => {
    render(<SpecFactoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: /CPDEV-22410 Enrollment sync rules/,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Restore To Board/i }),
    );

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/spec-factory/sources/1/restore",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});
