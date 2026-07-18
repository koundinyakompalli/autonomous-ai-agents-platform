// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvestigationPage } from "./InvestigationPage.js";
import type { InvestigationHealth, InvestigationRun } from "../investigation/api.js";

const run: InvestigationRun = {
  id: "inv-test",
  jiraKey: "CPSUP-55555",
  title: "Render smoke test",
  client: "Wellcare",
  environment: "PROD-REPLICA",
  status: "running",
  mode: "mixed",
  confidence: 0.71,
  accent: "cyan",
  updatedAt: "just now",
  summary: "Investigation render smoke test.",
  recommendation: "Review bounded evidence.",
  analyzers: [
    { key: "llm", label: "RCA Planner", status: "complete", pulse: "warm", detail: "Causal planning completed." },
    { key: "data", label: "Data", status: "waiting", pulse: "cool", detail: "Waiting for Meridian SQL." },
  ],
  findings: [],
  evidence: [],
  events: [
    { id: "event-1", sequence: 1, at: "now", title: "Run created", body: "Test run opened.", analyzer: "system" },
  ],
  approvalText: "Manual review required.",
  jiraDraft: {
    clientSummary: "Client summary.",
    internalAnalysis: "Internal analysis.",
    proposedRemediation: {
      validationNotes: "Validation notes.",
    },
  },
  audit: ["now - render smoke test"],
};

const health: InvestigationHealth = {
  status: "ready",
  mode: "brokered",
  scopePolicy: "lower_env_first",
  queue: {
    queueDepth: 0,
    activeWorkers: 0,
    workerConcurrency: 2,
    throttleStore: "memory",
  },
  adapters: {
    data: { status: "pilot", detail: "Readonly data diagnostics." },
  },
};

const meridianRun: InvestigationRun = {
  ...run,
  id: "inv-meridian",
  jiraKey: "CPSUP-52676",
  title: "Backend case edit",
  client: "Cigna",
  environment: "PROD-REPLICA",
  status: "completed",
  recommendation: "Review Meridian SQL file before DBA execution.",
  evidence: [
    {
      id: "meridian-evidence",
      analyzer: "data",
      title: "Meridian SQL generation",
      detail: "Spreadsheet attachment downloaded and SQL generated for DBA review.",
      meta: ["source:MERIDIAN", "sql-attached"],
      trace: [],
    },
    {
      id: "host-batch-script-probe",
      analyzer: "host",
      title: "SSH batch script probe",
      detail: "Searched approved batch script paths; no candidate lines were found.",
      meta: ["application/json"],
      trace: [],
    },
  ],
  ticketContext: {
    source: "jira",
    jiraKey: "CPSUP-52676",
    fetchStatus: "fetched",
    title: "Backend case edit",
    statusName: "In Progress",
    labels: [],
    attachments: [
      {
        id: "attachment-1",
        filename: "Back End Ticket.xlsx",
        extractionStatus: "metadata_only",
      },
    ],
    comments: [],
    identifiers: [],
    extractedTerms: ["Backend", "case", "edit"],
  },
};

const streamingRun: InvestigationRun = {
  ...run,
  findings: [{
    id: "finding-streamed",
    analyzer: "aws",
    severity: "medium",
    title: "AWS evidence retained",
    summary: "A bounded finding was streamed before the run completed.",
    confidence: 0.7,
  }],
  evidence: [{
    id: "evidence-streamed",
    analyzer: "aws",
    title: "AWS evidence",
    detail: "A bounded artifact was streamed before the run completed.",
    meta: ["application/json"],
    trace: [],
  }],
};

class MockEventSource {
  onerror: (() => void) | null = null;

  addEventListener() {
    return undefined;
  }

  close() {
    return undefined;
  }
}

describe("InvestigationPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders without the removed header action buttons", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: MockEventSource,
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/investigation/runs")) {
        return new Response(JSON.stringify({ runs: [streamingRun] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/investigation/health")) {
        return new Response(JSON.stringify(health), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/investigation/runs/inv-test")) {
        return new Response(JSON.stringify(streamingRun), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    render(<InvestigationPage />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Investigation Cockpit" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /watchdog/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /live feed/i })).toBeNull();
    expect(screen.queryByText(/Cockpit derives scope from Jira/i)).toBeNull();
    expect(screen.getByText("RCA Planner")).toBeTruthy();
    const hottestRun = screen.getByText("Hottest run").closest("article");
    expect(hottestRun).not.toBeNull();
    expect(within(hottestRun!).getByText("Wellcare · PROD-REPLICA · running")).toBeTruthy();
    expect(within(hottestRun!).queryByText(run.recommendation)).toBeNull();
  });

  it("uses session authentication and separates active and recent investigations", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: MockEventSource,
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/investigation/runs")) {
        return new Response(JSON.stringify({ runs: [run, meridianRun] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/investigation/health")) {
        return new Response(JSON.stringify({
          ...health,
          queue: {
            ...health.queue,
            outstandingRuns: 1,
            outstandingCapacity: 10,
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/investigation/runs/inv-test")) {
        return new Response(JSON.stringify(run), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    render(<InvestigationPage />);

    await waitFor(() => expect(screen.getByText("1/10 active")).toBeTruthy());
    expect(screen.getByRole("heading", { name: "Flight Queue" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Recent Investigations" })).toBeTruthy();
    expect(screen.getByText("Session authentication")).toBeTruthy();
    expect(screen.queryByLabelText("Operator LDAP SSH password")).toBeNull();
    expect(screen.getByText("CPSUP-55555")).toBeTruthy();
    expect(screen.getByText("CPSUP-52676")).toBeTruthy();
  });

  it("reconciles a terminal detail response when the run list is stale", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: MockEventSource,
    });
    const escalatedRun: InvestigationRun = {
      ...run,
      status: "escalated",
      recommendation: "Review the incomplete causal evidence.",
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/investigation/runs")) {
        return new Response(JSON.stringify({ runs: [run] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/investigation/health")) {
        return new Response(JSON.stringify(health), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/investigation/runs/inv-test")) {
        return new Response(JSON.stringify(escalatedRun), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    render(<InvestigationPage />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Recent Investigations" })).toBeTruthy());
    await waitFor(() => expect(screen.getByText("escalated", { selector: "strong" })).toBeTruthy());
    expect(screen.queryByText("Wellcare · PROD-REPLICA · running")).toBeNull();
  });

  it("clears the Jira field after queueing another ticket", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: MockEventSource,
    });
    const queuedRun: InvestigationRun = {
      ...run,
      id: "inv-second",
      jiraKey: "CPSUP-55569",
      title: "Second queued investigation",
      status: "queued",
    };
    let submitted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/investigation/runs") && init?.method === "POST") {
        submitted = true;
        return new Response(JSON.stringify(queuedRun), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/investigation/runs")) {
        return new Response(JSON.stringify({ runs: submitted ? [queuedRun, run] : [run] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/investigation/health")) {
        return new Response(JSON.stringify(health), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/investigation/runs/inv-test")) {
        return new Response(JSON.stringify(run), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    render(<InvestigationPage />);
    const jiraInput = await screen.findByLabelText("Jira ticket") as HTMLInputElement;
    fireEvent.change(jiraInput, { target: { value: "cpsup-55569" } });
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));

    await waitFor(() => expect(jiraInput.value).toBe(""));
    expect(await screen.findByText("CPSUP-55569")).toBeTruthy();
    expect(screen.getByText("CPSUP-55555")).toBeTruthy();
  });

  it("does not show generic failure lenses or L1-L3 Jira draft language", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: MockEventSource,
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/investigation/runs")) {
        return new Response(JSON.stringify({ runs: [run] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/investigation/health")) {
        return new Response(JSON.stringify(health), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/investigation/runs/inv-test")) {
        return new Response(JSON.stringify(run), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    render(<InvestigationPage />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Investigation Cockpit" })).toBeTruthy());

    fireEvent.click(screen.getByRole("tab", { name: /failure lens/i }));
    expect(await screen.findByText("No ticket-specific failure lens yet")).toBeTruthy();
    expect(screen.queryByText(/Large page sizes can amplify vendor API failures/i)).toBeNull();
    expect(screen.queryByText("Scope Lens")).toBeNull();
    expect(screen.queryByText("queue scoped")).toBeNull();
    expect(screen.queryByText("Configurable Engine Plan")).toBeNull();
    expect(screen.queryByText(/demo now \/ YAML later/i)).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /^jira$/i }));
    expect(await screen.findByText("operator notes")).toBeTruthy();
    expect(screen.queryByText("L1-L3")).toBeNull();
  });

  it("does not show generic Volume or Stage lenses for Meridian ticket evidence", async () => {
    vi.stubGlobal("EventSource", MockEventSource);
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: MockEventSource,
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/investigation/runs")) {
        return new Response(JSON.stringify({ runs: [meridianRun] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/investigation/health")) {
        return new Response(JSON.stringify(health), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/investigation/runs/inv-meridian")) {
        return new Response(JSON.stringify(meridianRun), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }));

    render(<InvestigationPage />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Investigation Cockpit" })).toBeTruthy());

    fireEvent.click(screen.getByRole("tab", { name: /failure lens/i }));
    expect(await screen.findByText("No ticket-specific failure lens yet")).toBeTruthy();
    expect(screen.queryByText("Volume Lens")).toBeNull();
    expect(screen.queryByText("Stage Lens")).toBeNull();
    expect(screen.queryByText(/Large page sizes can amplify vendor API failures/i)).toBeNull();
    expect(screen.queryByText(/Separate query, download, process, and archive failures/i)).toBeNull();
  });
});
