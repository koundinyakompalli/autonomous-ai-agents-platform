import { describe, expect, it } from "vitest";
import {
  isUiTab,
  normalizeUiTab,
  uiTabToViewMode,
  type UiTab,
  type ViewMode,
} from "./viewTabDefs.js";

/**
 * Smoke coverage for the `UiTab → ViewMode` boundary. This is the only
 * mapping that separates sidebar state from what actually reaches the
 * server on `/api/oneshot/runs?view=...`. If this ever silently widens
 * to emit `overview` / `agents` / `queue` downstream, the server would
 * 400 and the dashboard would go blank — so pin the contract here.
 */
describe("uiTabToViewMode", () => {
  const PASSTHROUGH: ReadonlyArray<ViewMode> = [
    "running",
    "queued",
    "waiting",
    "history",
  ];

  it.each(PASSTHROUGH)("passes server-valid view %s through", (mode) => {
    expect(uiTabToViewMode(mode)).toBe(mode);
  });

  it.each([
    "overview",
    "agents",
    "queue",
    "throughput",
    "costs",
    "statistics",
  ] as const)(
    "folds client-only tab %s down to 'all'",
    (tab) => {
      expect(uiTabToViewMode(tab)).toBe("all");
    },
  );

  it("never emits a value outside server-accepted set", () => {
    const ALLOWED = new Set(["running", "queued", "waiting", "history", "all"]);
    const TABS: ReadonlyArray<UiTab> = [
      "overview",
      "running",
      "queued",
      "waiting",
      "history",
      "agents",
      "queue",
      "throughput",
      "costs",
      "statistics",
    ];
    for (const tab of TABS) {
      expect(ALLOWED.has(uiTabToViewMode(tab))).toBe(true);
    }
  });
});

describe("isUiTab", () => {
  it("accepts all known tab ids", () => {
    for (const tab of [
      "overview",
      "running",
      "queued",
      "waiting",
      "history",
      "agents",
      "queue",
      "throughput",
      "costs",
      "statistics",
    ]) {
      expect(isUiTab(tab)).toBe(true);
    }
  });

  it("normalizes legacy failures links to statistics", () => {
    expect(normalizeUiTab("failures")).toBe("statistics");
  });

  it("rejects garbage and null", () => {
    expect(isUiTab(null)).toBe(false);
    expect(isUiTab("")).toBe(false);
    expect(isUiTab("all")).toBe(false);
    expect(isUiTab("Overview")).toBe(false);
  });
});
