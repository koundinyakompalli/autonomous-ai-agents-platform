// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./compose/ComposeWorkspace.js", () => ({
  ComposeWorkspace: ({
    onViewEpic,
  }: {
    onViewEpic?: (sourceId: number) => void | Promise<void>;
  }) => (
    <button type="button" onClick={() => void onViewEpic?.(1671)}>
      View Epic fixture
    </button>
  ),
}));

import { SpecFactoryPage } from "./SpecFactoryPage.js";

function response(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

const publishedSource = {
  id: 1671,
  sourceJiraKey: "COMPOSE-63",
  sourceSummary: "PCU New Fields for 4.3",
  sourceStatus: "Done",
  loeHours: 140,
  state: "oneshot_submitted",
  origin: "compose",
  approvedEpicKey: "CPDEV-26321",
  qualificationReasons: [],
  errorMessage: null,
  updatedAt: "2026-07-14T13:52:15.310Z",
};

const publishedDraft = {
  id: 162,
  sourceId: 1671,
  version: 2,
  evidenceSnapshotId: 34,
  status: "approved",
  draft: {
    sourceJiraKey: "COMPOSE-63",
    loeHours: 140,
    epic: {
      summary: "PCU New Fields for 4.3 - Humana",
      description: "Add the approved PCU case-tracking fields.",
      businessContext: [],
      acceptanceCriteria: ["All approved fields are available."],
      assumptions: [],
      dependencies: [],
    },
    childTickets: [],
    evidenceSummary: [],
    warnings: [],
  },
  renderedMarkdown: null,
  evidenceManifest: {},
  childTickets: [],
  errorMessage: null,
  createdAt: "2026-07-14T13:40:00.000Z",
  updatedAt: "2026-07-14T13:52:15.310Z",
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/spec-factory/status") {
        return Promise.resolve(response({}));
      }
      if (url === "/api/spec-factory/sources/refresh") {
        return Promise.resolve(response({ sources: [] }));
      }
      if (url === "/api/spec-factory/sources") {
        return Promise.resolve(response([]));
      }
      if (url === "/api/spec-factory/sources/1671") {
        return Promise.resolve(response(publishedSource));
      }
      if (url === "/api/spec-factory/sources/1671/drafts/latest") {
        return Promise.resolve(response(publishedDraft));
      }
      if (
        url === "/api/spec-factory/sources/1671/events" ||
        url === "/api/spec-factory/sources/1671/attachments"
      ) {
        return Promise.resolve(response([]));
      }
      return Promise.resolve(
        response({ error: "Unexpected request" }, false, 404),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Compose published Epic navigation", () => {
  it("opens an Epic that is not present in the capped board response", async () => {
    render(<SpecFactoryPage />);

    fireEvent.click(
      await screen.findByRole("button", { name: "View Epic fixture" }),
    );

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith("/api/spec-factory/sources/1671", {
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: "PCU New Fields for 4.3 - Humana",
      }),
    ).toBeTruthy();
    expect(screen.getByText("CPDEV-26321")).toBeTruthy();
  });
});
