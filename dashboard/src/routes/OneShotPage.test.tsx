// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Ref, RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OneShotAnalyticsRange,
  OneShotDashboardRow,
  OneShotRunsResponse,
  OneShotStatisticsResponse,
} from "../oneshot/types.js";

const {
  useOneShotRunsMock,
  useOneShotStatisticsMock,
  wordmarkMorphMock,
  sidebarMorphMock,
} = vi.hoisted(() => ({
  useOneShotRunsMock: vi.fn(),
  useOneShotStatisticsMock: vi.fn(),
  wordmarkMorphMock: vi.fn(),
  sidebarMorphMock: vi.fn(),
}));

vi.mock("../hooks/useOneShotRuns.js", () => ({
  useOneShotRuns: useOneShotRunsMock,
}));
vi.mock("../hooks/useOneShotStatistics.js", () => ({
  useOneShotStatistics: useOneShotStatisticsMock,
}));

vi.mock("../oneshot/Overview.js", () => ({
  Overview: ({ onNewRun }: { onNewRun?: () => void }) => (
    <button type="button" onClick={onNewRun}>
      open new run
    </button>
  ),
}));

vi.mock("../oneshot/AgentsView.js", () => ({ AgentsView: () => null }));
vi.mock("../oneshot/Costs.js", () => ({
  Costs: ({
    range,
    onRangeChange,
  }: {
    range: OneShotAnalyticsRange;
    onRangeChange: (next: OneShotAnalyticsRange) => void;
  }) => (
    <button
      type="button"
      onClick={() => onRangeChange(range === "24h" ? "30d" : "24h")}
    >
      costs range: {range}
    </button>
  ),
}));
vi.mock("../oneshot/Statistics.js", () => ({
  Statistics: ({
    range,
    onRangeChange,
  }: {
    range: OneShotAnalyticsRange;
    onRangeChange: (next: OneShotAnalyticsRange) => void;
  }) => (
    <button
      type="button"
      onClick={() => onRangeChange(range === "24h" ? "30d" : "24h")}
    >
      statistics range: {range}
    </button>
  ),
}));
vi.mock("../oneshot/QueueBoard.js", () => ({ QueueBoard: () => null }));
vi.mock("../oneshot/RunsView.js", () => ({ RunsView: () => null }));
vi.mock("../oneshot/Sidebar.js", () => ({
  Sidebar: ({
    onSelect,
    shellRef,
    wordmarkRef,
  }: {
    onSelect: (next: "about") => void;
    shellRef?: Ref<HTMLElement>;
    wordmarkRef?: Ref<HTMLHeadingElement>;
  }) => (
    <aside ref={shellRef}>
      <h1 ref={wordmarkRef} className="oneshot-wordmark">
        <span className="wm-one">One</span>
        <span className="wm-shot">Shot</span>
        <span className="wm-period">.</span>
      </h1>
      <button type="button" onClick={() => onSelect("about")}>
        Guide
      </button>
    </aside>
  ),
}));
vi.mock("../oneshot/Throughput.js", () => ({
  Throughput: ({
    range,
    onRangeChange,
  }: {
    range: OneShotAnalyticsRange;
    onRangeChange: (next: OneShotAnalyticsRange) => void;
  }) => (
    <button
      type="button"
      onClick={() => onRangeChange(range === "24h" ? "30d" : "24h")}
    >
      range: {range}
    </button>
  ),
}));
// Mirror the real ProductLocalNav click contract: anchor with the canonical
// href, preventDefault on plain click, fall through to default browser nav on
// modifier-clicked / non-left-button events. Lets the routing tests catch a
// regression where preventDefault is dropped or the modifier escape hatch is
// removed.
vi.mock("../oneshot/About.js", () => {
  const PANELS = ["features", "how-to", "tech-spec", "changelog"] as const;
  const hrefFor = (panel: string) =>
    panel === "features" ? "?view=about" : `?view=about&panel=${panel}`;
  return {
    About: ({
      panel,
      wordmarkDestRef,
      onPanelChange,
    }: {
      panel: string;
      wordmarkDestRef?: RefObject<HTMLHeadingElement>;
      onPanelChange?: (next: string) => void;
    }) => (
      <div>
        <h1
          ref={wordmarkDestRef}
          className="oneshot-wordmark about-wordmark-slot"
        >
          <span className="wm-one">One</span>
          <span className="wm-shot">Shot</span>
          <span className="wm-period">.</span>
        </h1>
        <span data-testid="about-panel">{panel}</span>
        {PANELS.map((p) => (
          <a
            key={p}
            href={hrefFor(p)}
            role="button"
            aria-label={`about: ${p}`}
            data-testid={`about-tab-${p}`}
            onClick={(event) => {
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              event.preventDefault();
              onPanelChange?.(p);
            }}
          >
            about: {p}
          </a>
        ))}
      </div>
    ),
  };
});

vi.mock("../oneshot/WordmarkMorph.js", () => ({
  WordmarkMorph: (props: {
    rects: unknown;
    theme?: "light" | "dark";
    onDone: () => void;
  }) => {
    wordmarkMorphMock(props);
    return props.rects ? (
      <span data-testid="wordmark-morph-theme">{props.theme}</span>
    ) : null;
  },
}));

vi.mock("../oneshot/SidebarMorph.js", () => ({
  SidebarMorph: (props: {
    snapshot: unknown;
    theme?: "light" | "dark";
  }) => {
    sidebarMorphMock(props);
    return props.snapshot ? (
      <span data-testid="sidebar-morph-theme">{props.theme}</span>
    ) : null;
  },
}));

vi.mock("../oneshot/DetailModal.js", () => ({
  DetailModal: ({ row }: { row: OneShotDashboardRow }) => (
    <div>
      <span>detail: {row.dashboardId}</span>
      <button type="button">Preview Deployment</button>
    </div>
  ),
}));

import { buildOneShotRunAuthStartUrl, OneShotPage } from "./OneShotPage.js";

const oneshotCssRoot = existsSync("dashboard/src/oneshot")
  ? "dashboard/src/oneshot"
  : "src/oneshot";

function buildRow(
  overrides: Partial<OneShotDashboardRow> = {},
): OneShotDashboardRow {
  return {
    dashboardId: "run-9001",
    jiraKey: "CPDEV-123",
    title: "Mock run for CPDEV-123",
    sourceTaskManagementId: 3001,
    oneshotRunId: 9001,
    customerName: null,
    displayState: "qualification_pending",
    progressStage: "qualification",
    progressPercent: 4,
    repoName: "product-factory",
    repoUrl: "https://github.com/example/product-factory",
    baseBranch: "main",
    baseCommitSha: "abc123",
    implementationBranch: null,
    implementationCommitSha: null,
    reviewLoopCount: 0,
    maxReviewLoops: 3,
    currentPrUrl: null,
    qualificationSummary: "QUALIFIER is still assessing the ticket.",
    lastError: null,
    lastErrorSummary: null,
    retry: null,
    deployment: {
      eligible: false,
      ready: false,
      light: "grey",
      status: "not_eligible",
      active: false,
      previewUrl: null,
      workflowUrl: null,
      imageUri: null,
      deployedCommitSha: null,
    },
    createdAt: "2026-04-21T00:00:00.000Z",
    lastManualRestartAt: null,
    updatedAt: "2026-04-21T00:00:00.000Z",
    totalTokensUsed: 0,
    estimatedCostUsd: 0,
    costSource: "estimated",
    ...overrides,
  };
}

function buildRunsResponse(
  runs: OneShotDashboardRow[],
  createRunMode: "request" | "mock" = "mock",
  capabilityOverrides: Partial<OneShotRunsResponse["capabilities"]> = {},
): OneShotRunsResponse {
  const window24h = {
    range: "24h" as const,
    label: "Last 24h",
    shortLabel: "24h",
    bucketLabel: "48 x 30-min buckets",
    isAllTime: false,
  };
  return {
    runs,
    pagination: {
      limit: 100,
      offset: 0,
      hasMore: false,
      total: runs.length,
    },
    stats: {
      inProgress: 0,
      failed: 0,
      blocked: 0,
      deployReady: 0,
      byView: {
        running: 0,
        queued: 0,
        waiting: 0,
        history: 0,
      },
    },
    capabilities: {
      createRun: true,
      createRunMode,
      deployPreviewAvailable: false,
      deployPreview: false,
      ...capabilityOverrides,
    },
    analytics: {
      overview24h: {
        runs24h: runs.length,
        completed: 0,
        failed: 0,
        running: 0,
        queued: 0,
        waiting: 0,
        passRate: 0,
        avgTimeToPrMs: 0,
        medianTimeToPrMs: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        costSource: "estimated",
        attemptFailures24h: 0,
        throughputBuckets: [],
      },
      agents: [],
      queue: {
        queued: 0,
        running: 0,
        waiting: 0,
        recentlyFinished: 0,
        workerCapacity: 0,
      },
      throughput: {
        window: window24h,
        buckets: [],
        totalRuns: 0,
        trend: {
          priorValue: 0,
          pctChange: 0,
        },
        p50TimeToPrMs: 0,
        p90TimeToPrMs: 0,
        stageCompletion: [],
      },
      costs: {
        window: window24h,
        totalUsd: 0,
        totalTokens: 0,
        costSource: "estimated",
        trend: {
          priorValue: 0,
          pctChange: 0,
        },
        byStage: [],
        byModel: [],
        topRuns: [],
      },
      failures: {
        window: window24h,
        totalFailures: 0,
        clusters: [],
      },
    },
  };
}

function buildStatisticsResponse(
  range: OneShotAnalyticsRange = "24h",
): OneShotStatisticsResponse {
  const window = {
    range,
    label: range === "all" ? "All time" : "Last 24h",
    shortLabel: range === "all" ? "All" : range,
    bucketLabel: "statistics",
    isAllTime: range === "all",
  };
  return {
    status: "ready",
    range,
    window,
    summary: "Statistics are ready.",
    scorecard: {
      intake: 0,
      qualifiedRuns: 0,
      completed: 0,
      failed: 0,
      noAction: 0,
      passRate: 0,
      totalTokens: 0,
      totalUsd: 0,
      p50TimeToPrMs: 0,
      p90TimeToPrMs: 0,
      deltas: {
        intake: null,
        passRate: null,
        completed: null,
        failed: null,
        totalUsd: null,
        totalTokens: null,
        p50TimeToPrMs: null,
      },
    },
    buckets: [],
    workingWell: [],
    needsImprovement: [],
    businessMetrics: [],
    ticketQuality: {
      rubric: {
        rubricVersion: "v1.0",
        detectionPatternsVersion: "v1.0",
        weights: {
          acceptance_criteria: 35,
          substantive_description: 20,
          expected_behavior_scope: 15,
          repo_file_service_hints: 15,
          testing_notes: 10,
          out_of_scope_constraints: 5,
        },
        tierCutoffs: { strong: 80, adequate: 60, weak: 30 },
        thresholds: {
          bucketClaimMinN: 10,
          missingSignalCohortMinN: 10,
          weakRecommendationMinShare: 0.2,
          dataHygieneMissingDescriptionMinShare: 0.15,
          dataHygieneMinN: 10,
          stratifiedCoverageMinShare: 0.6,
        },
      },
      disclaimer:
        "Score reflects ticket text captured at OneShot intake, not current Jira text.",
      totalIntake: 0,
      averageScore: 0,
      readinessDistribution: [],
      passRateByTier: [],
      templateFit: [],
      missingSignalImpact: [],
      dataHygieneCallout: null,
      stratifiedReadinessGap: {
        weak: {
          sampleSize: 0,
          terminalCount: 0,
          completed: 0,
          failed: 0,
          noAction: 0,
          passRate: 0,
          wilson95: null,
        },
        nonWeak: {
          sampleSize: 0,
          terminalCount: 0,
          completed: 0,
          failed: 0,
          noAction: 0,
          passRate: 0,
          wilson95: null,
        },
        significantOverall: false,
        eligibleWeakCoverageShare: 0,
        significantWeakCoverageShare: 0,
        qualifiesForRecommendation: false,
        dominantStrata: [],
        recommendationSummary: null,
      },
    },
    repoStatus: {
      range,
      generatedAt: "2026-05-14T12:00:00.000Z",
      statusVersion: 1,
      rows: [],
    },
    operationalBottlenecks: {
      range,
      generatedAt: "2026-05-14T12:00:00.000Z",
      bottleneckVersion: 1,
      rows: [],
    },
    recommendedActions: [],
    selfFixCandidates: [],
    selfFixConfig: {
      minSampleSize: 5,
      autoCreateEnabled: false,
      autoRunEnabled: false,
      targetEpicKey: "CPDEV-23232",
      targetRepo: "mhk-repos/cp-autonomous-ai-agents-platform",
      targetBranch: "main",
    },
    minSampleSize: 5,
    modelInfo: {
      provider: null,
      model: null,
      generatedAt: null,
      expiresAt: null,
      nextRefreshAt: null,
      dataFingerprint: "mock",
      refreshing: false,
      lastError: null,
    },
  };
}

function installMemoryLocalStorage(): PropertyDescriptor | undefined {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "localStorage",
  );
  const entries = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return entries.size;
      },
      getItem: vi.fn((key: string) => entries.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        entries.set(key, String(value));
      }),
      removeItem: vi.fn((key: string) => {
        entries.delete(key);
      }),
      clear: vi.fn(() => {
        entries.clear();
      }),
      key: vi.fn((index: number) => Array.from(entries.keys())[index] ?? null),
    } satisfies Storage,
  });
  return originalDescriptor;
}

function restoreLocalStorage(
  originalDescriptor: PropertyDescriptor | undefined,
): void {
  if (originalDescriptor) {
    Object.defineProperty(window, "localStorage", originalDescriptor);
  } else {
    Reflect.deleteProperty(window, "localStorage");
  }
}

describe("OneShotPage create-run flow", () => {
  let currentResponse: OneShotRunsResponse;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    currentResponse = buildRunsResponse([]);
    useOneShotRunsMock.mockImplementation(() => ({
      data: currentResponse,
      isInitialLoading: false,
      error: null,
      revalidationToken: 0,
      retry: vi.fn(),
    }));
    useOneShotStatisticsMock.mockImplementation(
      ({ range }: { range: OneShotAnalyticsRange }) => ({
        data: buildStatisticsResponse(range),
        isLoading: false,
        error: null,
      }),
    );
    window.history.replaceState({}, "", "/oneshot");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a mock run without polling run-request status endpoints", async () => {
    const createdRow = buildRow();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/oneshot/mock-runs") {
        currentResponse = buildRunsResponse([createdRow]);
        return new Response(JSON.stringify(createdRow), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<OneShotPage />);

    await user.click(screen.getByRole("button", { name: "open new run" }));
    await user.type(screen.getByRole("textbox"), "cpdev-123");
    await user.click(screen.getByRole("button", { name: "validate" }));
    await screen.findByText("Confirm local mock run creation.");
    await user.click(screen.getByRole("button", { name: "create mock run" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/oneshot/mock-runs",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            jiraKey: "CPDEV-123",
            title: "Mock run for CPDEV-123",
          }),
        }),
      );
    });

    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).startsWith("/api/oneshot/run-requests/"),
      ),
    ).toBe(false);
    expect(screen.getByText("detail: run-9001")).toBeTruthy();
  });

  it("marks the app shell as the OneShot theme transition scope", () => {
    render(<OneShotPage />);

    expect(document.querySelector("[data-oneshot-scope='true']")).toBeTruthy();
  });

  it("builds the request-mode new-run auth start URL from the current route", () => {
    expect(
      buildOneShotRunAuthStartUrl("/oneshot", "?view=runs&range=all&newRun=1"),
    ).toBe(
      "/auth/oneshot-run/start?returnTo=%2Foneshot%3Fview%3Druns%26range%3Dall",
    );
  });

  it("routes request-mode new-run clicks through auth instead of opening locally", async () => {
    currentResponse = buildRunsResponse([], "request");
    const user = userEvent.setup();

    render(<OneShotPage />);
    await user.click(screen.getByRole("button", { name: "open new run" }));

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.queryByText("New run is not available in this environment."),
    ).toBeNull();
  });

  it("opens the command palette after returning from new-run auth", async () => {
    currentResponse = buildRunsResponse([], "request");
    window.history.replaceState({}, "", "/oneshot?view=runs&newRun=1");

    render(<OneShotPage />);

    expect(await screen.findByRole("textbox")).toBeTruthy();
    expect(window.location.search).toBe("?view=runs");
  });

  it("strips the new-run auth marker and shows a toast when creation is unavailable", async () => {
    currentResponse = buildRunsResponse([], "request", { createRun: false });
    window.history.replaceState({}, "", "/oneshot?view=runs&newRun=1");

    render(<OneShotPage />);

    expect(
      await screen.findByText("New run is not available in this environment."),
    ).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(window.location.search).toBe("?view=runs");
  });

  it("initializes the analytics range from the URL", () => {
    window.history.replaceState({}, "", "/oneshot?view=costs&range=30d");

    render(<OneShotPage />);

    expect(useOneShotRunsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ range: "30d" }),
    );
  });

  it("persists an explicit default range on analytics tabs", async () => {
    window.history.replaceState({}, "", "/oneshot?view=throughput");

    render(<OneShotPage />);

    expect(useOneShotRunsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ range: "24h" }),
    );
    await waitFor(() => {
      expect(window.location.search).toBe("?view=throughput&range=24h");
    });
  });

  it("falls back to the default analytics range for invalid URL values", async () => {
    window.history.replaceState({}, "", "/oneshot?view=costs&range=forever");

    render(<OneShotPage />);

    expect(useOneShotRunsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ range: "24h" }),
    );
    await waitFor(() => {
      expect(window.location.search).toBe("?view=costs&range=24h");
    });
  });

  it("updates the URL and data query when the analytics range changes", async () => {
    window.history.replaceState({}, "", "/oneshot?view=throughput");
    const user = userEvent.setup();

    render(<OneShotPage />);
    await user.click(screen.getByRole("button", { name: "range: 24h" }));

    await waitFor(() => {
      expect(useOneShotRunsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ range: "30d" }),
      );
    });
    expect(window.location.search).toBe("?view=throughput&range=30d");
  });

  it.each([
    {
      view: "throughput",
      buttonName: "range: all",
    },
    {
      view: "costs",
      buttonName: "costs range: all",
    },
    {
      view: "statistics",
      buttonName: "statistics range: all",
    },
  ])(
    "keeps $view data and URL in sync when changing all time back to 24h",
    async ({ view, buttonName }) => {
      window.history.replaceState({}, "", `/oneshot?view=${view}&range=all`);
      const user = userEvent.setup();

      render(<OneShotPage />);
      await user.click(screen.getByRole("button", { name: buttonName }));

      await waitFor(() => {
        expect(useOneShotRunsMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ range: "24h" }),
        );
      });
      expect(window.location.search).toBe(`?view=${view}&range=24h`);
    },
  );

  it("normalizes legacy failures URLs to statistics", async () => {
    window.history.replaceState({}, "", "/oneshot?view=failures&range=all");
    const user = userEvent.setup();

    render(<OneShotPage />);
    await user.click(
      screen.getByRole("button", { name: "statistics range: all" }),
    );

    await waitFor(() => {
      expect(useOneShotRunsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ range: "24h" }),
      );
    });
    expect(window.location.search).toBe("?view=statistics&range=24h");
  });

  it("strips analytics range from non-analytics tabs", async () => {
    window.history.replaceState({}, "", "/oneshot?view=queue&range=all");

    render(<OneShotPage />);

    expect(useOneShotRunsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ range: "24h" }),
    );
    await waitFor(() => {
      expect(window.location.search).toBe("?view=queue");
    });
  });

  it("shows deploy controls for deployment-ready runs when preview deployment is available", async () => {
    const deployReadyRow = buildRow({
      dashboardId: "run-74",
      oneshotRunId: 74,
      displayState: "completed",
      progressStage: "pr_complete",
      repoName: "core-app",
      implementationBranch: "oneshot/cpdev-21090-run-74",
      implementationCommitSha: "f7dd0ec1f9ff5020bfb02823c61d243ab746078f",
      deployment: {
        eligible: true,
        ready: true,
        light: "red",
        status: "ready",
        active: false,
        previewUrl: null,
        workflowUrl: null,
        imageUri: null,
        deployedCommitSha: null,
      },
    });
    currentResponse = buildRunsResponse([deployReadyRow], "request", {
      deployPreviewAvailable: true,
      deployPreview: false,
    });
    window.history.replaceState({}, "", "/oneshot?view=runs&run=run-74");

    render(<OneShotPage />);

    expect(await screen.findByText("detail: run-74")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Preview Deployment" }),
    ).toBeTruthy();
  });
});

describe("OneShotPage theme background constants", () => {
  let originalLocalStorageDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    originalLocalStorageDescriptor = installMemoryLocalStorage();
    useOneShotRunsMock.mockImplementation(() => ({
      data: buildRunsResponse([]),
      isInitialLoading: false,
      error: null,
      revalidationToken: 0,
      retry: vi.fn(),
    }));
    useOneShotStatisticsMock.mockImplementation(
      ({ range }: { range: OneShotAnalyticsRange }) => ({
        data: buildStatisticsResponse(range),
        isLoading: false,
        error: null,
      }),
    );
    window.history.replaceState({}, "", "/oneshot");
  });

  afterEach(() => {
    restoreLocalStorage(originalLocalStorageDescriptor);
    vi.restoreAllMocks();
  });

  it("applies white (#ffffff) background in light theme", () => {
    window.localStorage.setItem("oneshot.theme", "light");
    render(<OneShotPage />);
    // jsdom serializes hex to rgb; assert the white channel values
    expect(document.body.style.background).toMatch(/255,\s*255,\s*255|#ffffff/i);
  });

  it("applies dark (#0b0c0e) background in dark theme", () => {
    window.localStorage.setItem("oneshot.theme", "dark");
    render(<OneShotPage />);
    expect(document.body.style.background).toMatch(/11,\s*12,\s*14|#0b0c0e/i);
  });

  it("keeps the light sidebar as a solid purple rail without aurora glow", () => {
    const liquidGlassCss = readFileSync(
      `${oneshotCssRoot}/liquid-glass.css`,
      "utf8",
    );
    const sidebarCss = readFileSync(
      `${oneshotCssRoot}/sidebar-shell.css`,
      "utf8",
    );
    const lightThemeBlock =
      liquidGlassCss
        .match(/\.liquid-glass-scope\[data-theme="light"\]\s*\{[\s\S]*?\n\}/g)
        ?.find((block) => block.includes("--sidebar-shell-bg")) ?? "";
    const lightSidebarRule =
      sidebarCss.match(
        /\.liquid-glass-scope\[data-theme="light"\]\s+\.sidebar\s*\{(?<body>[\s\S]*?)\n\}/,
      )?.groups?.body ?? "";

    expect(lightThemeBlock).toMatch(/--sidebar-shell-bg:\s*#3b2697;/);
    expect(lightThemeBlock).not.toMatch(/--sidebar-shell-bg:[^;]*--aurora/s);
    expect(lightSidebarRule).not.toMatch(/--aurora-/);
    expect(sidebarCss).toMatch(
      /\.liquid-glass-scope\[data-theme="light"\]\s+\.sidebar::before\s*\{[^}]*background:\s*none/s,
    );
    expect(sidebarCss).toMatch(
      /\.liquid-glass-scope\[data-theme="light"\]\s+\.sidebar::after\s*\{[^}]*display:\s*none/s,
    );
    expect(sidebarCss).toMatch(
      /\.liquid-glass-scope\[data-theme="light"\]\s+\.nav-item:hover,\s*\n\.liquid-glass-scope\[data-theme="light"\]\s+\.nav-item\.active\s*\{[^}]*color:\s*var\(--sidebar-nav-text\)/s,
    );
  });
});

describe("OneShotPage About panel routing", () => {
  let originalLocalStorageDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    originalLocalStorageDescriptor = installMemoryLocalStorage();
    wordmarkMorphMock.mockClear();
    sidebarMorphMock.mockClear();
    // jsdom doesn't ship matchMedia, but handleAboutPanelChange uses it to
    // decide scroll-behavior. Stub a permissive default so panel-change
    // clicks don't throw.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    window.scrollTo = vi.fn() as typeof window.scrollTo;
    useOneShotRunsMock.mockImplementation(() => ({
      data: buildRunsResponse([]),
      isInitialLoading: false,
      error: null,
      revalidationToken: 0,
      retry: vi.fn(),
    }));
    useOneShotStatisticsMock.mockImplementation(
      ({ range }: { range: OneShotAnalyticsRange }) => ({
        data: buildStatisticsResponse(range),
        isLoading: false,
        error: null,
      }),
    );
    window.history.replaceState({}, "", "/oneshot");
  });

  afterEach(() => {
    restoreLocalStorage(originalLocalStorageDescriptor);
    vi.restoreAllMocks();
  });

  it("defaults About to features when no panel is in the URL", () => {
    window.history.replaceState({}, "", "/oneshot?view=about");
    render(<OneShotPage />);
    expect(screen.getByTestId("about-panel").textContent).toBe("features");
  });

  it.each([
    { param: "how-to", expected: "how-to" },
    { param: "tech-spec", expected: "tech-spec" },
    { param: "changelog", expected: "changelog" },
  ])("hydrates About from ?panel=$param", ({ param, expected }) => {
    window.history.replaceState({}, "", `/oneshot?view=about&panel=${param}`);
    render(<OneShotPage />);
    expect(screen.getByTestId("about-panel").textContent).toBe(expected);
  });

  it("maps the legacy ?panel=specs to tech-spec", () => {
    window.history.replaceState({}, "", "/oneshot?view=about&panel=specs");
    render(<OneShotPage />);
    expect(screen.getByTestId("about-panel").textContent).toBe("tech-spec");
  });

  it("maps the legacy ?panel=guide to how-to", () => {
    window.history.replaceState({}, "", "/oneshot?view=about&panel=guide");
    render(<OneShotPage />);
    expect(screen.getByTestId("about-panel").textContent).toBe("how-to");
  });

  it.each(["overview", "get-started"])(
    "folds the retired ?panel=%s into features",
    (legacy) => {
      window.history.replaceState(
        {},
        "",
        `/oneshot?view=about&panel=${legacy}`,
      );
      render(<OneShotPage />);
      expect(screen.getByTestId("about-panel").textContent).toBe("features");
    },
  );

  it("falls back to features for unknown panel values", () => {
    window.history.replaceState({}, "", "/oneshot?view=about&panel=foo");
    render(<OneShotPage />);
    expect(screen.getByTestId("about-panel").textContent).toBe("features");
  });

  it("canonicalizes ?panel=specs to ?panel=tech-spec on the next URL write", async () => {
    window.history.replaceState({}, "", "/oneshot?view=about&panel=specs");
    const user = userEvent.setup();
    render(<OneShotPage />);

    expect(screen.getByTestId("about-panel").textContent).toBe("tech-spec");

    await user.click(screen.getByRole("button", { name: "about: tech-spec" }));

    await waitFor(() => {
      expect(window.location.search).toBe("?view=about&panel=tech-spec");
    });
  });

  it("renders the deep-linked panel directly without invoking the wordmark morph", () => {
    // ?panel=changelog lands on a non-default panel. Confirm the page renders
    // without errors — the morph only runs on in-app tab clicks
    // (beginEnterAbout / beginExitAbout), not on initial mount.
    window.history.replaceState({}, "", "/oneshot?view=about&panel=changelog");
    render(<OneShotPage />);
    expect(screen.getByTestId("about-panel").textContent).toBe("changelog");
  });

  it("passes the active light theme into the Guide transition morphs", async () => {
    window.localStorage.setItem("oneshot.theme", "light");
    window.history.replaceState({}, "", "/oneshot?view=runs");
    const user = userEvent.setup();

    render(<OneShotPage />);

    await user.click(screen.getByRole("button", { name: "Guide" }));

    await waitFor(() => {
      expect(screen.getByTestId("wordmark-morph-theme").textContent).toBe(
        "light",
      );
      expect(screen.getByTestId("sidebar-morph-theme").textContent).toBe(
        "light",
      );
    });
    expect(wordmarkMorphMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rects: expect.any(Object),
        theme: "light",
      }),
    );
    expect(sidebarMorphMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        snapshot: expect.any(Object),
        theme: "light",
      }),
    );
  });

  it("strips a stray ?panel=tech-spec from non-About URLs on mount", async () => {
    window.history.replaceState({}, "", "/oneshot?view=runs&panel=tech-spec");
    render(<OneShotPage />);
    await waitFor(() => {
      expect(window.location.search).not.toContain("panel=");
    });
  });

  it("writes ?panel=tech-spec when switching tabs and clears it on features", async () => {
    window.history.replaceState({}, "", "/oneshot?view=about");
    const user = userEvent.setup();
    render(<OneShotPage />);

    await user.click(screen.getByRole("button", { name: "about: tech-spec" }));
    await waitFor(() => {
      expect(window.location.search).toBe("?view=about&panel=tech-spec");
    });

    await user.click(screen.getByRole("button", { name: "about: features" }));
    await waitFor(() => {
      expect(window.location.search).toBe("?view=about");
    });
  });
});
