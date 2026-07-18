import type { StatusTone } from "./statusTone.js";

interface StatusPillProps {
  tone: StatusTone;
  /** Visible text. Omit for dot-only pills (useful in dense table rows). */
  label?: string;
  /** Dot-only pill — no label, no padding beyond the dot. */
  compact?: boolean;
}

/**
 * Shared status-pill renderer. Wraps the existing `.status-pill` / `.row-status`
 * CSS from `liquid-glass.css:717-882` so tone colors stay token-driven.
 *
 * - Use `<StatusPill tone={...} label="running" />` for full pills (queue cards, modal header).
 * - Use `<StatusPill tone={...} compact />` for dot-only indicators (runs table rows).
 */
export function StatusPill({ tone, label, compact }: StatusPillProps) {
  if (compact) {
    return (
      <span className={`row-status status-${tone}`} aria-label={label ?? tone}>
        <span className="dot" />
      </span>
    );
  }
  return (
    <span className={`status-pill status-${tone}`}>
      <span className="dot" />
      {label ?? tone}
    </span>
  );
}
