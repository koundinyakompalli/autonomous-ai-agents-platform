import {
  SONAR_AUTOFIX_LABEL,
  WIZCODE_LABEL,
  normalizeJiraLabels,
} from "./contracts.js";

export type OneShotProcessingMode =
  | "security_wiz"
  | "wiz_code"
  | "sonar_autofix"
  | "standard";

export interface OneShotProcessingModeSource {
  processingMode?: unknown;
  jiraLabels?: unknown;
  ticketSummary?: unknown;
}

const PROCESSING_MODES: ReadonlySet<OneShotProcessingMode> = new Set([
  "security_wiz",
  "wiz_code",
  "sonar_autofix",
  "standard",
]);

function isOneShotProcessingMode(
  value: unknown,
): value is OneShotProcessingMode {
  return (
    typeof value === "string" &&
    PROCESSING_MODES.has(value as OneShotProcessingMode)
  );
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string");
}

export function resolveOneShotProcessingModeFromIntake(
  jiraLabels?: string[] | null,
): OneShotProcessingMode {
  const labels = normalizeJiraLabels(jiraLabels ?? undefined);
  if (labels.has(SONAR_AUTOFIX_LABEL)) {
    return "sonar_autofix";
  }
  if (labels.has(WIZCODE_LABEL)) {
    return "wiz_code";
  }
  return "standard";
}

export function resolveOneShotProcessingMode(
  source?: OneShotProcessingModeSource | null,
): OneShotProcessingMode {
  if (isOneShotProcessingMode(source?.processingMode)) {
    return source.processingMode;
  }

  const intakeMode = resolveOneShotProcessingModeFromIntake(
    coerceStringArray(source?.jiraLabels),
  );
  if (intakeMode !== "standard") {
    return intakeMode;
  }

  const ticketSummary =
    typeof source?.ticketSummary === "string" ? source.ticketSummary : "";
  if (ticketSummary.includes("Wiz remediation")) {
    return "security_wiz";
  }

  return "standard";
}
