import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useOneShotRuns } from "../hooks/useOneShotRuns.js";
import { useOneShotStatistics } from "../hooks/useOneShotStatistics.js";
import { About, type AboutPanel } from "../oneshot/About.js";
import { CommandPalette } from "../oneshot/CommandPalette.js";
import { DetailModal } from "../oneshot/DetailModal.js";
import { AgentsView } from "../oneshot/AgentsView.js";
import { Costs } from "../oneshot/Costs.js";
import { Overview } from "../oneshot/Overview.js";
import { QueueBoard } from "../oneshot/QueueBoard.js";
import { RunsView } from "../oneshot/RunsView.js";
import { Sidebar } from "../oneshot/Sidebar.js";
import { Statistics } from "../oneshot/Statistics.js";
import {
  SidebarMorph,
  type SidebarMorphSnapshot,
} from "../oneshot/SidebarMorph.js";
import { Throughput } from "../oneshot/Throughput.js";
import {
  WordmarkMorph,
  type MorphRects,
  type WordmarkMorphColors,
} from "../oneshot/WordmarkMorph.js";
import {
  DEFAULT_ANALYTICS_RANGE,
  normalizeOneShotAnalyticsRange,
} from "../oneshot/AnalyticsRangeControl.js";
import { submitCreateRun } from "../oneshot/newRunApi.js";
import type {
  OneShotAnalyticsRange,
  OneShotCreateRunMode,
  OneShotDashboardRow,
  OneShotRunRequestDetail,
  OneShotRunRequestValidation,
} from "../oneshot/types.js";
import {
  COLORS,
  FONTS,
  KEYFRAMES_CSS,
  RADII,
} from "../oneshot/pipelineStyles.js";
import {
  DEFAULT_UI_TAB,
  isViewMode,
  normalizeUiTab,
  type UiTab,
  type ViewMode,
} from "../oneshot/viewTabDefs.js";
import "../oneshot/liquid-glass.css";
import "../oneshot/streamPipeline.css";
import "../oneshot/sidebar-shell.css";

type SelfFixTicketResult = {
  candidateId: string;
  ticketKey: string;
  jiraUrl: string | null;
  runRequestId?: number;
  status: string;
};

const RUN_REQUEST_POLL_MS = 3_000;
const RUN_REQUEST_TRACK_MS = 5 * 60_000;

function isAnalyticsTab(tab: UiTab): boolean {
  return tab === "throughput" || tab === "costs" || tab === "statistics";
}

function normalizeAboutPanel(value: string | null): AboutPanel {
  // Legacy aliases: ?panel=specs → tech-spec. ?panel=overview /
  // ?panel=get-started belonged to a removed editorial layout — they map
  // to the entry tab "features". ?panel=guide was a temporary slug for the
  // spec-sheet tab; it now canonicalizes to "how-to". writeRouteStateToUrl
  // rewrites legacy values on next URL write.
  if (value === "specs" || value === "tech-spec") return "tech-spec";
  if (value === "changelog") return "changelog";
  if (value === "how-to" || value === "guide") return "how-to";
  return "features";
}

function readRouteStateFromUrl(): {
  uiTab: UiTab;
  runsViewMode: ViewMode | null;
  analyticsRange: OneShotAnalyticsRange;
  aboutPanel: AboutPanel;
} {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view");
  if (isViewMode(view)) {
    return {
      uiTab: "runs",
      runsViewMode: view,
      analyticsRange: DEFAULT_ANALYTICS_RANGE,
      aboutPanel: "features",
    };
  }
  const uiTab = normalizeUiTab(view) ?? DEFAULT_UI_TAB;
  const analyticsRange = isAnalyticsTab(uiTab)
    ? normalizeOneShotAnalyticsRange(params.get("range"))
    : DEFAULT_ANALYTICS_RANGE;
  return {
    uiTab,
    runsViewMode: null,
    analyticsRange,
    aboutPanel:
      uiTab === "about" ? normalizeAboutPanel(params.get("panel")) : "features",
  };
}

function writeRouteStateToUrl(
  tab: UiTab,
  analyticsRange: OneShotAnalyticsRange,
  runsViewMode: ViewMode | null = null,
  aboutPanel: AboutPanel = "features",
): void {
  const params = new URLSearchParams(window.location.search);
  if (runsViewMode) {
    params.set("view", runsViewMode);
  } else if (tab === DEFAULT_UI_TAB) {
    params.delete("view");
  } else {
    params.set("view", tab);
  }

  if (isAnalyticsTab(tab)) {
    params.set("range", analyticsRange);
  } else {
    params.delete("range");
  }

  if (tab === "about" && aboutPanel !== "features") {
    params.set("panel", aboutPanel);
  } else {
    params.delete("panel");
  }

  const query = params.toString();
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}`,
  );
}

function replaceUrlParams(params: URLSearchParams): void {
  const query = params.toString();
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}`,
  );
}

function makeSidebarOffscreenRect(rect: DOMRect): DOMRect {
  return new DOMRect(-rect.width - 180, rect.top, rect.width, rect.height);
}

function readWordmarkColors(
  wordmarkEl: HTMLElement | null,
  fallback?: WordmarkMorphColors,
): WordmarkMorphColors {
  const baseColor = wordmarkEl
    ? window.getComputedStyle(wordmarkEl).color
    : "rgb(255, 255, 255)";
  const readPartColor = (selector: string, fallbackColor: string): string => {
    const part = wordmarkEl?.querySelector<HTMLElement>(selector);
    const target = part ?? wordmarkEl;
    return target
      ? window.getComputedStyle(target).color || fallbackColor
      : fallbackColor;
  };

  return {
    one: readPartColor(".wm-one", fallback?.one ?? baseColor),
    shot: readPartColor(".wm-shot", fallback?.shot ?? baseColor),
    period: readPartColor(".wm-period", fallback?.period ?? baseColor),
  };
}

export function buildOneShotRunAuthStartUrl(
  pathname = window.location.pathname,
  search = window.location.search,
): string {
  const returnParams = new URLSearchParams(search);
  returnParams.delete("newRun");
  const query = returnParams.toString();
  const returnTo = `${pathname}${query ? `?${query}` : ""}`;
  return `/auth/oneshot-run/start?${new URLSearchParams({ returnTo }).toString()}`;
}

function SkeletonBlock({ width, height }: { width: string; height: number }) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: RADII.md,
        background: COLORS.surfaceContainerLow,
        opacity: 0.6,
      }}
    />
  );
}

function LoadingSkeleton({ uiTab }: { uiTab: UiTab }) {
  const rows = uiTab === "queue" ? 3 : uiTab === "agents" ? 7 : 8;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <SkeletonBlock width="40%" height={22} />
      <SkeletonBlock width="60%" height={14} />
      <div
        style={{
          marginTop: 8,
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        {Array.from({ length: rows }, (_, i) => (
          <SkeletonBlock
            key={i}
            width="100%"
            height={uiTab === "queue" ? 88 : 44}
          />
        ))}
      </div>
    </div>
  );
}

type Theme = "light" | "dark";
const THEME_STORAGE_KEY = "oneshot.theme";

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // localStorage unavailable
  }
  // First visit — honor OS preference, default dark.
  if (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches
  ) {
    return "light";
  }
  return "dark";
}

export function OneShotPage() {
  const [uiTab, setUiTab] = useState<UiTab>(
    () => readRouteStateFromUrl().uiTab,
  );
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // localStorage unavailable
    }
  }, [theme]);

  // index.html paints html/body/#root with a hardcoded dark background.
  // Override while OneShot is mounted so the page surround follows theme
  // (otherwise short viewports show a black band beyond the scope).
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById("root");
    const prev = {
      colorScheme: html.style.colorScheme,
      htmlBg: html.style.background,
      bodyBg: body.style.background,
      rootBg: root ? root.style.background : "",
    };
    const lightBg = "#ffffff";
    const darkBg = "#0b0c0e";
    const bg = theme === "light" ? lightBg : darkBg;
    html.style.colorScheme = theme;
    html.style.background = bg;
    body.style.background = bg;
    if (root) root.style.background = bg;
    return () => {
      html.style.colorScheme = prev.colorScheme;
      html.style.background = prev.htmlBg;
      body.style.background = prev.bodyBg;
      if (root) root.style.background = prev.rootBg;
    };
  }, [theme]);
  const [runsViewMode, setRunsViewMode] = useState<ViewMode | null>(
    () => readRouteStateFromUrl().runsViewMode,
  );
  const [analyticsRange, setAnalyticsRange] = useState<OneShotAnalyticsRange>(
    () => readRouteStateFromUrl().analyticsRange,
  );
  const [aboutPanel, setAboutPanel] = useState<AboutPanel>(
    () => readRouteStateFromUrl().aboutPanel,
  );
  const [refreshToken, setRefreshToken] = useState(0);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [detailRow, setDetailRow] = useState<OneShotDashboardRow | null>(null);
  const [requestedDashboardId, setRequestedDashboardId] = useState<
    string | null
  >(() => new URLSearchParams(window.location.search).get("run"));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [isCreatingRun, setIsCreatingRun] = useState(false);
  const [createRunError, setCreateRunError] = useState<string | null>(null);
  const [trackedRunRequest, setTrackedRunRequest] = useState<{
    requestId: number;
    jiraKey: string;
    startedAtMs: number;
    lastDashboardId: string | null;
  } | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [runsSearchFocusToken, setRunsSearchFocusToken] = useState(0);
  const handledNewRunParamRef = useRef(false);

  type LogoMorphPhase =
    | "idle"
    | "preparing-enter"
    | "entering"
    | "preparing-exit"
    | "exiting";
  type PendingLogoMorph = {
    direction: "enter" | "exit";
    from: DOMRect;
    fromFontSizePx: number;
    sidebar?: {
      from: DOMRect;
      html: string;
    };
    fromColors: WordmarkMorphColors;
    targetTab?: UiTab;
  };

  // About logo transition orchestration. The page layout snaps behind a
  // hidden endpoint first, then a single fixed-position clone owns the motion.
  const [logoMorphPhase, setLogoMorphPhase] = useState<LogoMorphPhase>("idle");
  // Controls whether the sidebar is in its "slid-out" visual state. Applied
  // before measuring the About destination so the clone targets final layout.
  const [sidebarImmersive, setSidebarImmersive] = useState<boolean>(
    () => uiTab === "about",
  );
  const [morphRects, setMorphRects] = useState<MorphRects | null>(null);
  const [sidebarMorphSnapshot, setSidebarMorphSnapshot] =
    useState<SidebarMorphSnapshot | null>(null);
  const previousUiTabRef = useRef<UiTab>(uiTab);
  const sidebarShellRef = useRef<HTMLElement | null>(null);
  const sidebarWordmarkRef = useRef<HTMLHeadingElement | null>(null);
  const aboutWordmarkRef = useRef<HTMLHeadingElement | null>(null);
  const pendingLogoMorphRef = useRef<PendingLogoMorph | null>(null);
  // Remember the sidebar wordmark's "home" rect. Captured once the sidebar
  // is fully settled so we can use it as the origin on forward transitions
  // and as the landing point on reverse transitions, even when the sidebar
  // is mid-animation. Re-captured on window resize to stay accurate.
  const sidebarHomeRectRef = useRef<DOMRect | null>(null);
  const sidebarShellHomeRectRef = useRef<DOMRect | null>(null);

  useLayoutEffect(() => {
    const capture = () => {
      // Only meaningful when the sidebar is in its home position.
      if (sidebarImmersive) return;
      const wordmarkEl = sidebarWordmarkRef.current;
      if (wordmarkEl) {
        sidebarHomeRectRef.current = wordmarkEl.getBoundingClientRect();
      }
      const shellEl = sidebarShellRef.current;
      if (shellEl) {
        sidebarShellHomeRectRef.current = shellEl.getBoundingClientRect();
      }
    };
    capture();
    window.addEventListener("resize", capture);
    return () => window.removeEventListener("resize", capture);
  }, [sidebarImmersive]);

  useLayoutEffect(() => {
    const pending = pendingLogoMorphRef.current;
    if (!pending) return;

    if (
      logoMorphPhase !== "preparing-enter" &&
      logoMorphPhase !== "preparing-exit"
    ) {
      return;
    }

    const destEl =
      pending.direction === "enter"
        ? aboutWordmarkRef.current
        : sidebarWordmarkRef.current;
    const fallbackToRect =
      pending.direction === "exit" ? sidebarHomeRectRef.current : null;
    const toRect = destEl?.getBoundingClientRect() ?? fallbackToRect;

    if (!toRect) {
      pendingLogoMorphRef.current = null;
      setMorphRects(null);
      setSidebarMorphSnapshot(null);
      setLogoMorphPhase("idle");
      return;
    }

    const fallbackFontSize = pending.direction === "enter" ? 72 : 32;
    const toFontSizePx = destEl
      ? parseFloat(window.getComputedStyle(destEl).fontSize) || fallbackFontSize
      : fallbackFontSize;

    if (pending.direction === "enter") {
      setSidebarMorphSnapshot(
        pending.sidebar
          ? {
              direction: "enter",
              from: pending.sidebar.from,
              to: makeSidebarOffscreenRect(pending.sidebar.from),
              html: pending.sidebar.html,
            }
          : null,
      );
    } else {
      const sidebarShellEl = sidebarShellRef.current;
      const sidebarToRect =
        sidebarShellEl?.getBoundingClientRect() ??
        sidebarShellHomeRectRef.current;
      const sidebarHtml = sidebarShellEl?.innerHTML ?? "";
      setSidebarMorphSnapshot(
        sidebarToRect && sidebarHtml
          ? {
              direction: "exit",
              from: makeSidebarOffscreenRect(sidebarToRect),
              to: sidebarToRect,
              html: sidebarHtml,
            }
          : null,
      );
    }

    setMorphRects({
      from: pending.from,
      to: toRect,
      fromFontSizePx: pending.fromFontSizePx,
      toFontSizePx,
      colors: {
        from: pending.fromColors,
        to: readWordmarkColors(destEl, pending.fromColors),
      },
    });
    setLogoMorphPhase(pending.direction === "enter" ? "entering" : "exiting");
  }, [logoMorphPhase, uiTab, sidebarImmersive]);

  useEffect(() => {
    const { uiTab, runsViewMode, analyticsRange, aboutPanel } =
      readRouteStateFromUrl();
    writeRouteStateToUrl(uiTab, analyticsRange, runsViewMode, aboutPanel);
  }, []);

  const replaceRunParam = useCallback((dashboardId: string | null) => {
    const params = new URLSearchParams(window.location.search);
    if (dashboardId) params.set("run", dashboardId);
    else params.delete("run");
    const query = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
    setRequestedDashboardId(dashboardId);
  }, []);

  const beginEnterAbout = useCallback(
    (current: UiTab) => {
      if (logoMorphPhase !== "idle") return;

      previousUiTabRef.current = current;
      // Snapshot the sidebar wordmark's rect NOW, before any state update
      // triggers the CSS transition that would move it off-screen.
      const sidebarEl = sidebarWordmarkRef.current;
      const fromRect =
        sidebarEl?.getBoundingClientRect() ?? sidebarHomeRectRef.current;
      if (!fromRect) return; // No measurement possible; skip the morph.
      const fromFontSizePx = sidebarEl
        ? parseFloat(window.getComputedStyle(sidebarEl).fontSize) || 32
        : 32;
      const sidebarShellEl = sidebarShellRef.current;
      const sidebarSnapshot = sidebarShellEl
        ? {
            from: sidebarShellEl.getBoundingClientRect(),
            html: sidebarShellEl.innerHTML,
          }
        : null;

      pendingLogoMorphRef.current = {
        direction: "enter",
        from: fromRect,
        fromFontSizePx,
        sidebar: sidebarSnapshot ?? undefined,
        fromColors: readWordmarkColors(sidebarEl),
      };
      setMorphRects(null);
      setSidebarMorphSnapshot(null);
      setLogoMorphPhase("preparing-enter");
      setAboutPanel("features");
      setUiTab("about");
      setRunsViewMode(null);
      setSidebarImmersive(true);
    },
    [logoMorphPhase],
  );

  const beginExitAbout = useCallback(
    (target: UiTab) => {
      if (logoMorphPhase !== "idle") return;

      // Snapshot the About slot as the morph "from" (we're shrinking back).
      const destEl = aboutWordmarkRef.current;
      const fromRect = destEl?.getBoundingClientRect() ?? null;
      if (!destEl || !fromRect) {
        // Can't measure — just snap back.
        pendingLogoMorphRef.current = null;
        setLogoMorphPhase("idle");
        setSidebarImmersive(false);
        setMorphRects(null);
        setSidebarMorphSnapshot(null);
        setAboutPanel("features");
        setUiTab(target);
        setRunsViewMode(null);
        return;
      }
      const fromFontSizePx =
        parseFloat(window.getComputedStyle(destEl).fontSize) || 72;

      pendingLogoMorphRef.current = {
        direction: "exit",
        from: fromRect,
        fromFontSizePx,
        fromColors: readWordmarkColors(destEl),
        targetTab: target,
      };
      setMorphRects(null);
      setSidebarMorphSnapshot(null);
      setLogoMorphPhase("preparing-exit");
      setSidebarImmersive(false);
      setAboutPanel("features");
      setUiTab(target);
      setRunsViewMode(null);
    },
    [logoMorphPhase],
  );

  const setUiTabAndUrl = useCallback(
    (next: UiTab) => {
      if (logoMorphPhase !== "idle") return;

      const current = uiTab;
      if (next === "about" && current !== "about") {
        beginEnterAbout(current);
      } else if (current === "about" && next !== "about") {
        beginExitAbout(next);
      } else {
        if (next !== "about") {
          setAboutPanel("features");
        }
        setUiTab(next);
        setRunsViewMode(null);
      }
      writeRouteStateToUrl(next, analyticsRange, null, "features");
    },
    [analyticsRange, uiTab, logoMorphPhase, beginEnterAbout, beginExitAbout],
  );

  const handleAboutPanelChange = useCallback(
    (nextPanel: AboutPanel) => {
      if (logoMorphPhase !== "idle" || uiTab !== "about") return;
      setAboutPanel(nextPanel);
      setRunsViewMode(null);
      writeRouteStateToUrl("about", analyticsRange, null, nextPanel);
      window.scrollTo({
        top: 0,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    },
    [analyticsRange, logoMorphPhase, uiTab],
  );

  // Back link on the About page. Triggers the reverse animation and returns
  // to the tab the user was on before entering About (defaults to overview).
  const handleAboutExit = useCallback(() => {
    if (logoMorphPhase !== "idle") return;

    const target: UiTab =
      previousUiTabRef.current === "about"
        ? DEFAULT_UI_TAB
        : previousUiTabRef.current;
    beginExitAbout(target);
    setAboutPanel("features");
    writeRouteStateToUrl(target, analyticsRange);
  }, [analyticsRange, logoMorphPhase, beginExitAbout]);

  const handleMorphDone = useCallback(() => {
    const pending = pendingLogoMorphRef.current;
    pendingLogoMorphRef.current = null;
    setMorphRects(null);
    setSidebarMorphSnapshot(null);
    if (pending?.direction === "exit") {
      setAboutPanel("features");
      setUiTab(pending.targetTab ?? DEFAULT_UI_TAB);
      setRunsViewMode(null);
    }
    setLogoMorphPhase("idle");
  }, []);

  const handleAnalyticsRangeChange = useCallback(
    (next: OneShotAnalyticsRange) => {
      setAnalyticsRange(next);
      writeRouteStateToUrl(uiTab, next, null, aboutPanel);
    },
    [aboutPanel, uiTab],
  );

  const handleSearch = useCallback(() => {
    setUiTabAndUrl("runs");
    setRunsSearchFocusToken((token) => token + 1);
  }, [setUiTabAndUrl]);

  const openDetail = useCallback(
    (row: OneShotDashboardRow) => {
      setDetailRow(row);
      replaceRunParam(row.dashboardId);
    },
    [replaceRunParam],
  );

  const closeDetail = useCallback(() => {
    setDetailRow(null);
    replaceRunParam(null);
  }, [replaceRunParam]);

  useEffect(() => {
    const onPopState = () => {
      const {
        uiTab: nextUiTab,
        runsViewMode: nextRunsViewMode,
        analyticsRange: nextAnalyticsRange,
        aboutPanel: nextAboutPanel,
      } = readRouteStateFromUrl();
      setUiTab(nextUiTab);
      setRunsViewMode(nextRunsViewMode);
      setAnalyticsRange(nextAnalyticsRange);
      setAboutPanel(nextAboutPanel);
      setRequestedDashboardId(
        new URLSearchParams(window.location.search).get("run"),
      );
      writeRouteStateToUrl(
        nextUiTab,
        nextAnalyticsRange,
        nextRunsViewMode,
        nextAboutPanel,
      );
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        handleSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSearch]);

  useEffect(() => {
    if (!toastMessage) return;
    const timeout = window.setTimeout(() => setToastMessage(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [toastMessage]);

  useEffect(() => {
    if (!paletteOpen) {
      setCreateRunError(null);
    }
  }, [paletteOpen]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const deployAfter = params.get("deployAfter");

    if (!deployAfter) return;

    const oneshotRunId = Number(deployAfter);
    if (!Number.isInteger(oneshotRunId) || oneshotRunId <= 0) {
      params.delete("deployAfter");
      params.delete("deployAuth");
      const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
      window.history.replaceState({}, "", nextUrl);
      return;
    }

    let cancelled = false;

    async function requestDeploy() {
      try {
        const res = await fetch("/api/oneshot/deploy-requests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oneshotRunId }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(
            typeof payload.error === "string"
              ? payload.error
              : `Deploy failed: ${res.status}`,
          );
        }
        if (!cancelled) setRefreshToken((token) => token + 1);
      } finally {
        if (!cancelled) {
          params.delete("deployAfter");
          params.delete("deployAuth");
          const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
          window.history.replaceState({}, "", nextUrl);
        }
      }
    }

    void requestDeploy().catch((error: unknown) => {
      if (cancelled) return;
      setDeployError(error instanceof Error ? error.message : String(error));
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const {
    data,
    isInitialLoading,
    error,
    revalidationToken,
    retry,
  } = useOneShotRuns({
      limit: 100,
      offset: 0,
      search: "",
      state: "all",
      deployment: "all",
      ticketType: "all",
      view: "all",
      range: analyticsRange,
      refreshToken,
      snapshot: "dashboard",
    });
  const {
    data: statistics,
    isLoading: statisticsLoading,
    error: statisticsError,
  } = useOneShotStatistics({
    range: analyticsRange,
    enabled: uiTab === "statistics",
    refreshToken,
  });

  const canCreateRun = data?.capabilities.createRun ?? false;
  const createRunMode: OneShotCreateRunMode =
    data?.capabilities.createRunMode ?? "request";
  const canDeployPreview =
    data?.capabilities.deployPreviewAvailable ??
    data?.capabilities.deployPreview ??
    false;

  const handleOpenNewRun = useCallback(() => {
    if (!canCreateRun) {
      setToastMessage("New run is not available in this environment.");
      return;
    }

    if (createRunMode !== "mock") {
      window.location.assign(buildOneShotRunAuthStartUrl());
      return;
    }

    setCreateRunError(null);
    setPaletteOpen(true);
  }, [canCreateRun, createRunMode]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("newRun") !== "1" || handledNewRunParamRef.current) {
      return;
    }

    if (!data) {
      return;
    }

    handledNewRunParamRef.current = true;
    params.delete("newRun");
    replaceUrlParams(params);

    if (!canCreateRun) {
      setToastMessage("New run is not available in this environment.");
      return;
    }

    setCreateRunError(null);
    setPaletteOpen(true);
  }, [canCreateRun, data]);

  useEffect(() => {
    if (paletteOpen && !canCreateRun) {
      setPaletteOpen(false);
      setCreateRunError(null);
    }
  }, [canCreateRun, paletteOpen]);

  const rowLookupGenerationRef = useRef(0);
  useEffect(() => {
    const lookupGeneration = rowLookupGenerationRef.current + 1;
    rowLookupGenerationRef.current = lookupGeneration;

    if (!requestedDashboardId) {
      setDetailRow(null);
      return;
    }
    const dashboardId = requestedDashboardId;

    const fresh = data?.runs.find((row) => row.dashboardId === dashboardId);
    if (fresh) {
      setDetailRow(fresh);
      return;
    }

    const controller = new AbortController();

    async function fetchRow() {
      try {
        const response = await fetch(
          `/api/oneshot/runs/${encodeURIComponent(dashboardId)}`,
          { signal: controller.signal },
        );
        if (rowLookupGenerationRef.current !== lookupGeneration) return;

        if (response.status === 404) {
          setDetailRow(null);
          replaceRunParam(null);
          return;
        }

        if (!response.ok) return;

        const row = (await response.json()) as OneShotDashboardRow;
        if (rowLookupGenerationRef.current === lookupGeneration) {
          setDetailRow(row);
        }
      } catch (fetchError) {
        if (
          fetchError instanceof DOMException &&
          fetchError.name === "AbortError"
        ) {
          return;
        }
      }
    }

    void fetchRow();
    return () => controller.abort();
  }, [data, replaceRunParam, requestedDashboardId, revalidationToken]);

  function handleDeploy(row: OneShotDashboardRow) {
    if (!row.oneshotRunId) return;
    setDeployError(null);
    const params = new URLSearchParams({
      oneshotRunId: String(row.oneshotRunId),
      returnTo: "/oneshot",
    });
    window.location.assign(`/auth/deploy/start?${params.toString()}`);
  }

  const handleDetailChanged = useCallback(
    (
      message = "Repo confirmed; QUALIFIER will resume.",
      updatedRow?: OneShotDashboardRow,
    ) => {
      if (updatedRow) {
        setDetailRow(updatedRow);
      }
      setToastMessage(message);
      setRefreshToken((token) => token + 1);
    },
    [],
  );

  const handleCreateRun = useCallback(
    async (validation: OneShotRunRequestValidation) => {
      if (isCreatingRun) return;
      setIsCreatingRun(true);
      setCreateRunError(null);
      try {
        const result = await submitCreateRun(createRunMode, validation.jiraKey);
        if (result.kind === "mock") {
          setPaletteOpen(false);
          setUiTabAndUrl("overview");
          setTrackedRunRequest(null);
          setRefreshToken((token) => token + 1);
          openDetail(result.row);
          setToastMessage(`${result.row.jiraKey} · ${result.row.dashboardId}`);
          return;
        }

        const request = result.request;
        setPaletteOpen(false);
        setUiTabAndUrl("overview");
        setTrackedRunRequest({
          requestId: request.id,
          jiraKey: request.jiraKey,
          startedAtMs: Date.now(),
          lastDashboardId: null,
        });
        setToastMessage(`queued ${request.jiraKey} · request #${request.id}`);
      } catch (error) {
        setCreateRunError(
          error instanceof Error ? error.message : "Run request failed",
        );
      } finally {
        setIsCreatingRun(false);
      }
    },
    [createRunMode, isCreatingRun, openDetail, setUiTabAndUrl],
  );

  const handleSelfFixTicketCreated = useCallback(
    (result: SelfFixTicketResult) => {
      setRefreshToken((token) => token + 1);
      if (result.runRequestId) {
        setTrackedRunRequest({
          requestId: result.runRequestId,
          jiraKey: result.ticketKey,
          startedAtMs: Date.now(),
          lastDashboardId: null,
        });
        setToastMessage(
          `queued ${result.ticketKey} · request #${result.runRequestId}`,
        );
        return;
      }
      setToastMessage(`${result.status.replace(/_/g, " ")} ${result.ticketKey}`);
    },
    [],
  );

  useEffect(() => {
    if (!trackedRunRequest) {
      return;
    }
    const request = trackedRunRequest;

    let cancelled = false;
    let timerId: number | undefined;

    async function pollRequestStatus(): Promise<void> {
      try {
        const response = await fetch(
          `/api/oneshot/run-requests/${request.requestId}`,
        );

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(
            typeof payload.error === "string"
              ? payload.error
              : `Run request status failed: ${response.status}`,
          );
        }

        const detail = (await response.json()) as OneShotRunRequestDetail;
        if (cancelled) {
          return;
        }

        if (detail.status === "failed") {
          setToastMessage(detail.error ?? `Failed to queue ${request.jiraKey}`);
          setTrackedRunRequest(null);
          return;
        }

        if (
          detail.dashboardId &&
          detail.dashboardId !== request.lastDashboardId
        ) {
          setRefreshToken((token) => token + 1);
          setUiTabAndUrl("overview");
          replaceRunParam(detail.dashboardId);
          setToastMessage(`${detail.jiraKey} · ${detail.dashboardId}`);

          if (detail.dashboardId.startsWith("run-")) {
            setTrackedRunRequest(null);
            return;
          }

          setTrackedRunRequest((current) =>
            current && current.requestId === request.requestId
              ? {
                  ...current,
                  lastDashboardId: detail.dashboardId,
                }
              : current,
          );
        }

        if (Date.now() - request.startedAtMs >= RUN_REQUEST_TRACK_MS) {
          setTrackedRunRequest(null);
          return;
        }
      } catch (pollError) {
        if (!cancelled) {
          setToastMessage(
            pollError instanceof Error
              ? pollError.message
              : "Failed to track run request",
          );
          setTrackedRunRequest(null);
        }
        return;
      }

      if (!cancelled) {
        timerId = window.setTimeout(() => {
          void pollRequestStatus();
        }, RUN_REQUEST_POLL_MS);
      }
    }

    void pollRequestStatus();

    return () => {
      cancelled = true;
      if (timerId) {
        window.clearTimeout(timerId);
      }
    };
  }, [replaceRunParam, setUiTabAndUrl, trackedRunRequest]);

  return (
    <>
      <style>{KEYFRAMES_CSS}</style>
      <div
        className={[
          "liquid-glass-scope",
          "app",
          `ui-${uiTab}`,
          sidebarImmersive ? "is-immersive" : "",
          logoMorphPhase !== "idle" ? "is-logo-morphing" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-theme={theme}
        data-oneshot-scope="true"
        style={{
          color: COLORS.onSurface,
          fontFamily: FONTS.body,
          boxSizing: "border-box",
        }}
      >
        <Sidebar
          uiTab={uiTab}
          onSelect={setUiTabAndUrl}
          shellRef={sidebarShellRef}
          wordmarkRef={sidebarWordmarkRef}
        />

        <main className="main" aria-label="OneShot dashboard">
          {deployError && (
            <div
              role="alert"
              style={{
                padding: "14px 16px",
                borderRadius: RADII.lg,
                background: "var(--bad-dim)",
                border: "1px solid var(--bad-border)",
                color: COLORS.error,
                fontFamily: FONTS.body,
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <span>Deploy request failed: {deployError}</span>
              <button
                type="button"
                onClick={() => setDeployError(null)}
                aria-label="Dismiss deploy error"
                style={{
                  background: "transparent",
                  border: "none",
                  color: COLORS.error,
                  cursor: "pointer",
                  fontFamily: FONTS.mono,
                  fontSize: 12,
                  padding: "4px 8px",
                  borderRadius: RADII.sm,
                }}
              >
                Dismiss
              </button>
            </div>
          )}

          {error && (
            <div
              style={{
                padding: "14px 16px",
                borderRadius: RADII.lg,
                background: "var(--bad-dim)",
                border: "1px solid var(--bad-border)",
                color: COLORS.error,
                fontFamily: FONTS.body,
                fontSize: 13,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span style={{ flex: 1 }}>Couldn't load runs: {error}</span>
              <button
                type="button"
                onClick={retry}
                style={{
                  background: "var(--bad-border)",
                  border: "none",
                  color: COLORS.error,
                  cursor: "pointer",
                  fontFamily: FONTS.mono,
                  fontSize: 12,
                  padding: "4px 10px",
                  borderRadius: RADII.sm,
                }}
              >
                Retry
              </button>
            </div>
          )}

          {isInitialLoading && <LoadingSkeleton uiTab={uiTab} />}

          {data && uiTab === "overview" && (
            <Overview
              rows={data.runs}
              analytics={data.analytics.overview24h}
              agentAnalytics={data.analytics.agents}
              onOpenDetail={openDetail}
              onSearch={handleSearch}
              onNewRun={canCreateRun ? handleOpenNewRun : undefined}
              theme={theme}
              onThemeChange={setTheme}
            />
          )}

          {data && uiTab === "runs" && (
            <RunsView
              rows={data.runs}
              artifactRuns={data.artifactRuns ?? []}
              onOpenDetail={openDetail}
              searchFocusToken={runsSearchFocusToken}
              bucketFilter={runsViewMode}
              onSearch={handleSearch}
              onNewRun={canCreateRun ? handleOpenNewRun : undefined}
              theme={theme}
              onThemeChange={setTheme}
            />
          )}

          {data && uiTab === "agents" && (
            <AgentsView
              analytics={data.analytics.agents}
              onSearch={handleSearch}
              onNewRun={canCreateRun ? handleOpenNewRun : undefined}
              theme={theme}
              onThemeChange={setTheme}
            />
          )}

          {data && uiTab === "queue" && (
            <QueueBoard
              rows={data.runs}
              analytics={data.analytics.queue}
              onOpenDetail={openDetail}
              onSearch={handleSearch}
              onNewRun={canCreateRun ? handleOpenNewRun : undefined}
              theme={theme}
              onThemeChange={setTheme}
            />
          )}

          {data && uiTab === "throughput" && (
            <Throughput
              analytics={data.analytics.throughput}
              range={analyticsRange}
              onRangeChange={handleAnalyticsRangeChange}
              onSearch={handleSearch}
              onNewRun={canCreateRun ? handleOpenNewRun : undefined}
              theme={theme}
              onThemeChange={setTheme}
            />
          )}

          {data && uiTab === "costs" && (
            <Costs
              analytics={data.analytics.costs}
              rows={data.runs}
              range={analyticsRange}
              onRangeChange={handleAnalyticsRangeChange}
              onOpenDetail={openDetail}
              onSearch={handleSearch}
              onNewRun={canCreateRun ? handleOpenNewRun : undefined}
              theme={theme}
              onThemeChange={setTheme}
            />
          )}

          {data && uiTab === "statistics" && (
            <Statistics
              statistics={statistics}
              rows={data.runs}
              range={analyticsRange}
              isLoading={statisticsLoading}
              error={statisticsError}
              onRangeChange={handleAnalyticsRangeChange}
              onOpenDetail={openDetail}
              onSearch={handleSearch}
              onNewRun={canCreateRun ? handleOpenNewRun : undefined}
              onSelfFixTicketCreated={handleSelfFixTicketCreated}
              theme={theme}
              onThemeChange={setTheme}
            />
          )}

          {uiTab === "about" && (
            <About
              panel={aboutPanel}
              wordmarkDestRef={aboutWordmarkRef}
              onPanelChange={handleAboutPanelChange}
              onExit={handleAboutExit}
            />
          )}

          {detailRow && (
            <DetailModal
              row={detailRow}
              onClose={closeDetail}
              onDeploy={canDeployPreview ? handleDeploy : undefined}
              onChanged={handleDetailChanged}
            />
          )}
        </main>

        <CommandPalette
          open={paletteOpen}
          mode={createRunMode}
          isBusy={isCreatingRun}
          errorMessage={createRunError}
          onResetError={() => setCreateRunError(null)}
          onClose={() => setPaletteOpen(false)}
          onCreateRun={handleCreateRun}
        />

        {toastMessage && (
          <div className="lg-toast" role="status" aria-live="polite">
            <span className="lg-toast-dot" aria-hidden="true" />
            <span>{toastMessage}</span>
          </div>
        )}

        <WordmarkMorph
          rects={morphRects}
          theme={theme}
          onDone={handleMorphDone}
        />
        <SidebarMorph snapshot={sidebarMorphSnapshot} theme={theme} />
      </div>
    </>
  );
}
