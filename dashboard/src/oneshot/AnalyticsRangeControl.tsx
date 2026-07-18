import type { OneShotAnalyticsRange } from "./types.js";

export const ANALYTICS_RANGE_OPTIONS: ReadonlyArray<{
  value: OneShotAnalyticsRange;
  label: string;
}> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

const VALID_ANALYTICS_RANGE_VALUES = new Set<string>(
  ANALYTICS_RANGE_OPTIONS.map((option) => option.value),
);

export const DEFAULT_ANALYTICS_RANGE: OneShotAnalyticsRange = "24h";

export function isOneShotAnalyticsRange(
  value: string | null,
): value is OneShotAnalyticsRange {
  return value !== null && VALID_ANALYTICS_RANGE_VALUES.has(value);
}

export function normalizeOneShotAnalyticsRange(
  value: string | null,
): OneShotAnalyticsRange {
  return isOneShotAnalyticsRange(value) ? value : DEFAULT_ANALYTICS_RANGE;
}

export function AnalyticsRangeControl({
  value,
  onChange,
}: {
  value: OneShotAnalyticsRange;
  onChange: (next: OneShotAnalyticsRange) => void;
}) {
  return (
    <div
      className="analytics-range-control"
      role="radiogroup"
      aria-label="Analytics range"
    >
      {ANALYTICS_RANGE_OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={`analytics-range-option${active ? " active" : ""}`}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
