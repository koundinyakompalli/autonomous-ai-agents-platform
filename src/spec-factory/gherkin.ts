export function isCompleteGherkinScenario(value: string): boolean {
  return (
    /^Scenario:\s+\S/im.test(value) &&
    /^Given\s+\S/im.test(value) &&
    /^When\s+\S/im.test(value) &&
    /^Then\s+\S/im.test(value)
  );
}
export function normalizeGherkinCriterion(
  criterion: string,
  title: string,
  index: number,
): string {
  const trimmed = criterion.trim();
  if (isCompleteGherkinScenario(trimmed)) return trimmed;
  const outcome = trimmed.replace(/^(then\s+|[-*]\s*)/i, "").trim();
  return [
    `Scenario: ${title} - outcome ${index + 1}`,
    "Given the stated business prerequisites are satisfied",
    "When the user completes the described workflow",
    `Then ${outcome || "the expected functional outcome is observable"}`,
  ].join("\n");
}

export function normalizeGherkinCriteria(
  criteria: string[],
  title: string,
  fallbackOutcome: string,
): string[] {
  const source = criteria.length > 0 ? criteria : [fallbackOutcome];
  return source.map((criterion, index) =>
    normalizeGherkinCriterion(criterion, title, index),
  );
}
