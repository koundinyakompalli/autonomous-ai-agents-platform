import type { OneShotDashboardRow, OneShotDisplayState } from "./types.js";
import {
  EXECUTING_STATES,
  HISTORY_STATE_OPTIONS,
  QUEUED_STATES,
  STATE_LABELS,
  TERMINAL_STATES,
  WAITING_STATES,
} from "./pipelineStyles.js";

type StateOption = { readonly value: string; readonly label: string };

// Build a per-tab dropdown from the tab's state set so the user can only
// pick a value the tab will actually accept. Without this, e.g. choosing
// `planning` while on Queued sends state=planning to the server — then
// the client-side tab filter (QUEUED_STATES) rejects every row and the
// board looks empty.
function mkOptions(
  states: readonly OneShotDisplayState[],
): ReadonlyArray<StateOption> {
  return [
    { value: "all", label: "All states" },
    ...states.map((value) => ({ value, label: STATE_LABELS[value] })),
  ];
}

export type ViewMode = "running" | "queued" | "waiting" | "history";

export type TabGroup = "live" | "archive";

export interface TabDef {
  id: ViewMode;
  label: string;
  group: TabGroup;
  /** Predicate for rows that belong to this tab. */
  filter: (row: OneShotDashboardRow) => boolean;
  /** Distinguishes live tabs from the history tab for compatibility code paths. */
  cardViewMode: "active" | "history";
  /** Whether this tab participates in server-side pagination. */
  paginated: boolean;
  /** Empty-state hint shown when the tab has zero rows. */
  emptyHint: string;
  /** State filter dropdown options — derived from the tab's state set so
   *  the dropdown cannot produce a filter the tab will reject. */
  stateOptions: ReadonlyArray<StateOption>;
}

export const TAB_DEFS: readonly TabDef[] = [
  {
    id: "running",
    label: "Running",
    group: "live",
    filter: (r) => EXECUTING_STATES.includes(r.displayState),
    cardViewMode: "active",
    paginated: false,
    emptyHint: "All stage consumers are idle.",
    stateOptions: mkOptions(EXECUTING_STATES),
  },
  {
    id: "queued",
    label: "Queued",
    group: "live",
    filter: (r) => QUEUED_STATES.includes(r.displayState),
    cardViewMode: "active",
    paginated: false,
    emptyHint: "No tickets waiting for a stage consumer.",
    stateOptions: mkOptions(QUEUED_STATES),
  },
  {
    id: "waiting",
    label: "Waiting",
    group: "live",
    filter: (r) => WAITING_STATES.includes(r.displayState),
    cardViewMode: "active",
    paginated: false,
    emptyHint:
      "Nothing parked on human review, replan, force-approve, or PR merge.",
    stateOptions: mkOptions(WAITING_STATES),
  },
  {
    id: "history",
    label: "History",
    group: "archive",
    filter: (r) => TERMINAL_STATES.includes(r.displayState),
    cardViewMode: "history",
    paginated: true,
    emptyHint: "No completed or terminal runs yet.",
    stateOptions: HISTORY_STATE_OPTIONS,
  },
] as const;

export const DEFAULT_VIEW: ViewMode = "running";

const VIEW_IDS = new Set<string>(TAB_DEFS.map((t) => t.id));

export function isViewMode(value: string | null): value is ViewMode {
  return value !== null && VIEW_IDS.has(value);
}

export function getTab(id: ViewMode): TabDef {
  const match = TAB_DEFS.find((t) => t.id === id);
  if (!match) throw new Error(`Unknown view mode: ${id}`);
  return match;
}

// ── UI tab vs. server view ─────────────────────────────────────
// The new Liquid Glass sidebar exposes tabs that don't have a direct
// 1:1 mapping to the server's `view` query parameter (see
// `server/routes/oneshot.ts:VALID_VIEWS`). Overview/Agents/Queue are
// client-side compositions derived from the full row set, so they
// must send `view=all` to the server.
//
// Keep `ViewMode` (tab ids for Running/Queued/Waiting/History) as the
// server contract, and introduce `UiTab` as the sidebar selection type.
//
// The visible Liquid Glass shell now follows the prototype IA:
// Overview / Runs / Agents / Queue plus analytics tabs
// Throughput / Costs / Statistics. Legacy `running|queued|waiting|history`
// URL params are still supported by the page route, but they are treated as
// hidden compatibility targets and surfaced through the unified `Runs` UI.
export type UiTab =
  | ViewMode
  | "overview"
  | "runs"
  | "agents"
  | "queue"
  | "throughput"
  | "costs"
  | "statistics"
  | "about";

export const DEFAULT_UI_TAB: UiTab = "overview";

const UI_TAB_IDS = new Set<string>([
  "overview",
  "runs",
  "running",
  "queued",
  "waiting",
  "history",
  "agents",
  "queue",
  "throughput",
  "costs",
  "statistics",
  "about",
]);

export function normalizeLegacyUiTab(value: string | null): string | null {
  return value === "failures" ? "statistics" : value;
}

export function isUiTab(value: string | null): value is UiTab {
  return value !== null && UI_TAB_IDS.has(value);
}

export function normalizeUiTab(value: string | null): UiTab | null {
  const normalized = normalizeLegacyUiTab(value);
  return isUiTab(normalized) ? normalized : null;
}

/** Convert sidebar selection to the server-accepted `view` param. */
export function uiTabToViewMode(tab: UiTab): ViewMode | "all" {
  if (
    tab === "overview" ||
    tab === "runs" ||
    tab === "agents" ||
    tab === "queue" ||
    tab === "throughput" ||
    tab === "costs" ||
    tab === "statistics" ||
    tab === "about"
  ) {
    return "all";
  }
  return tab;
}
