import type {
  ComposeContextProjection,
  ComposeReadiness,
} from "./composeTypes.js";
import {
  clarificationText,
  isUserFacingClarification,
} from "./clarificationPolicy.js";

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function projectionQuestion(value: unknown): string | null {
  return clarificationText(value);
}

function firstFactText(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const direct = text(value);
      if (direct) return direct;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    const candidate = text(obj.text) ?? text(obj.summary);
    if (candidate) return candidate;
  }
  return null;
}

export function contextProjectionToReadiness(
  projection: ComposeContextProjection | null,
): ComposeReadiness | null {
  if (!projection) return null;
  const summary = projection.summary;
  const problem =
    text(summary?.problemStatement) ??
    text(summary?.objective) ??
    firstFactText(projection.facts);
  const actions = Array.isArray(summary?.recommendedNextActions)
    ? summary.recommendedNextActions
        .map(text)
        .filter((value): value is string => value !== null)
    : [];
  const openQuestions = projection.openQuestions
    .filter(isUserFacingClarification)
    .map(projectionQuestion)
    .filter((value): value is string => value !== null);
  return {
    ready: openQuestions.length === 0,
    openQuestions,
    summary: problem ?? `Working context v${projection.version}`,
    problem: problem ?? undefined,
    ideating: summary?.solution ?? (actions.join("\n") || undefined),
    solution: summary?.solution ?? undefined,
    businessRequirements: summary?.businessRequirements ?? [],
    functionalRequirements: summary?.functionalRequirements ?? [],
    challenges: summary?.challenges ?? [],
    stories: summary?.stories ?? [],
  };
}

export function mergeContextReadiness(
  current: ComposeReadiness | null,
  projection: ComposeContextProjection | null,
): ComposeReadiness | null {
  const projected = contextProjectionToReadiness(projection);
  if (!projected) return current;
  if (current && !projection?.summary) return current;
  return current ? { ...current, ...projected } : projected;
}
