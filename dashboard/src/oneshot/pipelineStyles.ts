import type { OneShotDisplayState, OneShotProgressStage } from "./types.js";
import {
  BLOCKED_DISPLAY_STATES as SHARED_BLOCKED_DISPLAY_STATES,
  ERROR_DISPLAY_STATES as SHARED_ERROR_DISPLAY_STATES,
  EXECUTING_STATES as SHARED_EXECUTING_STATES,
  HISTORY_STATE_OPTIONS as SHARED_HISTORY_STATE_OPTIONS,
  QUEUED_STATES as SHARED_QUEUED_STATES,
  STATE_LABELS as SHARED_STATE_LABELS,
  TERMINAL_STATES as SHARED_TERMINAL_STATES,
  WAITING_STATES as SHARED_WAITING_STATES,
} from "../../server/shared/oneshotStateModel.js";

// ── Surface hierarchy (Linear/Stripe-inspired) ───────────────────
// These are JS-side wrappers over the CSS custom properties defined
// in `liquid-glass.css`. Reading `COLORS.secondary` at a call site emits
// `var(--ok)` at runtime, so changing the token in CSS cascades to every
// component. See `liquid-glass.css:26-49` for the source of truth.
export const COLORS = {
  background: "#000000", // Pure black page (outside .liquid-glass-scope)
  surface: "var(--surface-1)",
  surfaceContainerLowest: "var(--surface-1)",
  surfaceContainerLow: "var(--surface-2)",
  surfaceContainer: "var(--surface-3)",
  surfaceContainerHigh: "var(--surface-3)",
  surfaceContainerHighest: "var(--surface-3)",
  surfaceVariant: "var(--surface-3)",

  // functional — semantic tokens pointing at CSS vars
  primary: "var(--primary)",
  onPrimary: "var(--text)",
  primaryContainer: "var(--accent-soft)",
  secondary: "var(--ok)",
  onSecondary: "var(--pill-on-completed)",
  tertiary: "var(--warn)",
  onTertiary: "var(--pill-on-completed)",
  error: "var(--bad)",
  onError: "var(--text)",

  // Brand accent (liquid-glass warm orange)
  brand: "var(--accent)",
  brandMuted: "var(--accent-soft)",
  brandGlow: "var(--accent-soft)",

  // text
  onSurface: "var(--text)",
  onSurfaceVariant: "var(--muted)",
  outline: "var(--dim)",

  // pipeline stage fills (flat, purposeful)
  stageCompleted: "var(--ok)",
  stageActive: "var(--primary)",
  stageWaiting: "transparent",
  stageError: "var(--bad)",
  stageBlocked: "var(--warn)",

  // border (the defining design element)
  borderSubtle: "var(--glass-stroke)",
  borderLight: "var(--glass-stroke-2)",

  // solid surface (no glassmorphism)
  glass: "var(--surface-1)",
  glassBorder: "var(--glass-stroke)",

  // Modal
  modalOverlay: "var(--modal-overlay)",
  modalSurface: "var(--surface-2)",
} as const;

// ── Fonts ──────────────────────────────────────────────────────────
export const FONTS = {
  headline: "'Space Grotesk', sans-serif",
  mono: "'JetBrains Mono', monospace",
  body: "'Inter', sans-serif",
  // Reserved for the brand wordmark only — do not generalize to other headings.
  display: "'Fraunces', 'Space Grotesk', serif",
  sfPro: "'Space Grotesk', sans-serif",
  sfProText: "'Inter', sans-serif",
} as const;

// ── Border radius scale ────────────────────────────────────────────
// Anchor = md (6px), the primary card surface. Everything smaller is a
// subordinate detail; everything larger is a containing surface. Keep
// the scale small — adding tiers invites new inconsistency.
// `xs` (2px) is also used in CSS `:focus-visible` / postmark rules below.
export const RADII = {
  xs: 2,
  sm: 4,
  md: 6,
  lg: 10,
  xl: 16,
  pill: 9999,
  circle: "50%",
} as const;

// ── Interactive element heights ────────────────────────────────────
// Anchor = control (44px), WCAG 2.5.5 minimum touch target. Every
// primary-interactive element (inputs, tabs, nav pills, CTAs, pager
// buttons) shares this rail so they line up pixel-perfect when placed
// in the same row. `compact` is the dense-toolbar tier (Floor edit
// mode) where 44 would be too tall. `pill` is for overlay badges that
// must not compete with primary controls for visual weight.
export const HEIGHTS = {
  control: 44,
  compact: 32,
  pill: 24,
} as const;

// ── Pipeline stages (ordered) ──────────────────────────────────────
export const PIPELINE_STAGES: OneShotProgressStage[] = [
  "qualification",
  "planning",
  "review",
  "implementation",
  "code_review",
  "testing",
  "pr_complete",
];

export const STAGE_LABELS: Record<OneShotProgressStage, string> = {
  qualification: "Qualify",
  planning: "Plan",
  review: "Validate",
  implementation: "Build",
  code_review: "Review",
  testing: "Test",
  pr_complete: "Ship",
};

export const AGENT_STAGES = PIPELINE_STAGES.filter(
  (stage): stage is Exclude<OneShotProgressStage, "pr_complete"> =>
    stage !== "pr_complete",
);

// States where a stage consumer is actively processing the ticket.
// These are capped by ECS desired_count per stage (1 each = 6 total max).
export const EXECUTING_STATES: OneShotDisplayState[] = [
  ...SHARED_EXECUTING_STATES,
] as OneShotDisplayState[];

// States where the ticket is sitting in SQS waiting for a consumer to pick it up.
export const QUEUED_STATES: OneShotDisplayState[] = [
  ...SHARED_QUEUED_STATES,
] as OneShotDisplayState[];

// States where the ticket is parked pending external action (human, replan, force-approve, merge).
export const WAITING_STATES: OneShotDisplayState[] = [
  ...SHARED_WAITING_STATES,
] as OneShotDisplayState[];

export const TERMINAL_STATES: OneShotDisplayState[] = [
  ...SHARED_TERMINAL_STATES,
] as OneShotDisplayState[];

export const ERROR_DISPLAY_STATES: OneShotDisplayState[] = [
  ...SHARED_ERROR_DISPLAY_STATES,
] as OneShotDisplayState[];

export const BLOCKED_DISPLAY_STATES: OneShotDisplayState[] = [
  ...SHARED_BLOCKED_DISPLAY_STATES,
] as OneShotDisplayState[];

// ── State filter options per view mode ─────────────────────────────
export const HISTORY_STATE_OPTIONS = [...SHARED_HISTORY_STATE_OPTIONS] as const;

// Human-readable labels for every display state — used by per-tab
// state dropdowns (see viewTabDefs.ts) to build bucket-scoped option lists.
export const STATE_LABELS: Record<OneShotDisplayState, string> = {
  ...SHARED_STATE_LABELS,
};

// ── Keyframes CSS (minimal — enterprise style) ────────────────────
export const KEYFRAMES_CSS = `
@keyframes oneshot-pulse-glow {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
@keyframes card-enter {
  from { opacity: 0; transform: translateY(18px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes oneshot-stage-sweep {
  0%   { transform: translateX(-100%); opacity: 0; }
  8%   { opacity: 1; }
  55%  { transform: translateX(280%);  opacity: 0; }
  100% { transform: translateX(280%);  opacity: 0; }
}
@keyframes modal-overlay-enter {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes modal-content-enter {
  from { opacity: 0; transform: translateY(20px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}
@keyframes oneshot-stat-flash {
  0%   { transform: scale(1);    filter: brightness(1); }
  35%  { transform: scale(1.08); filter: brightness(1.4); }
  100% { transform: scale(1);    filter: brightness(1); }
}
@keyframes oneshot-content-fade {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
@keyframes oneshot-mini-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.5; }
}

/* ─── OneShot wordmark (Bicameral) ─────────────────────────────────────────
   Typography-only brand. Fraunces's variable axes carry the emphasis:
   "One" sits at wght 400 / SOFT 30, "Shot" at wght 900 / SOFT 30, and an
   orange period acts as the impact tick. On container hover, "One" breathes
   toward 500 / SOFT 50 and brightens, and the period scales up slightly —
   a quiet confirmation rather than a choreographed replay. */
.oneshot-brand {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  cursor: default;
}
.oneshot-wordmark {
  margin: 0;
  font-family: 'Fraunces', serif;
  font-size: 38px;
  line-height: 1;
  letter-spacing: -0.02em;
  color: var(--text);
  display: inline-flex;
  align-items: baseline;
  font-variation-settings: 'opsz' 144;
  -webkit-font-smoothing: antialiased;
}
.oneshot-wordmark .wm-one {
  font-variation-settings: 'opsz' 144, 'wght' 400, 'SOFT' 30;
  color: color-mix(in srgb, var(--text) 70%, transparent);
  transition:
    font-variation-settings 0.5s cubic-bezier(0.22, 1, 0.36, 1),
    color 0.35s ease;
}
.oneshot-wordmark .wm-shot {
  font-variation-settings: 'opsz' 144, 'wght' 900, 'SOFT' 30;
  color: var(--text);
}
.oneshot-wordmark .wm-period {
  color: var(--accent);
  font-variation-settings: 'opsz' 144, 'wght' 900, 'SOFT' 30;
  display: inline-block;
  transform-origin: 50% 80%;
  transition: transform 0.35s cubic-bezier(0.22, 1, 0.36, 1);
}
.oneshot-brand:hover .wm-one {
  font-variation-settings: 'opsz' 144, 'wght' 500, 'SOFT' 50;
  color: var(--text);
}
.oneshot-brand:hover .wm-period {
  transform: scale(1.2);
}
.oneshot-tagline {
  margin: 0;
  font-family: 'Inter', sans-serif;
  font-size: 8px;
  font-weight: 500;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
*:focus { outline: none; }
*:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 2px;
}

.oneshot-modal-scroll {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.oneshot-modal-scroll::-webkit-scrollbar {
  display: none;
}

`;
