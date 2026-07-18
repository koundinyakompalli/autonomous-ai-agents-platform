import type { CSSProperties } from "react";

export function glassPlaceStyle(delayMs: number): CSSProperties {
  return {
    "--glass-place-delay": `${delayMs}ms`,
  } as CSSProperties;
}

export function dataRevealStyle({
  widthPct,
  heightPct,
  delayMs = 0,
}: {
  widthPct?: number;
  heightPct?: number;
  delayMs?: number;
}): CSSProperties {
  const style: Record<string, string> = {
    "--data-reveal-delay": `${Math.max(0, delayMs)}ms`,
  };
  if (widthPct != null) {
    style["--data-reveal-width"] = `${clampPercent(widthPct)}%`;
  }
  if (heightPct != null) {
    style["--data-reveal-height"] = `${clampPercent(heightPct)}%`;
  }
  return style as CSSProperties;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(value, 100));
}
