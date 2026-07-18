import type {
  ComposeSourceEntities,
  ComposeSourceKind,
  ComposeSourceUsefulness,
} from "./compose-types.js";

export interface ComposeSourceIntelligenceInput {
  kind: ComposeSourceKind;
  filename: string | null;
  markdown: string;
}

export interface ComposeSourceIntelligence {
  summary: string;
  entities: ComposeSourceEntities;
  usefulness: ComposeSourceUsefulness;
  contribution: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

const MAX_ENTITY_SCAN_CHARS = 80_000;
const MAX_ENTITY_LINE_CHARS = 1_000;

function boundedLines(text: string): string[] {
  return text
    .slice(0, MAX_ENTITY_SCAN_CHARS)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(0, MAX_ENTITY_LINE_CHARS));
}

function cleanFieldLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .trim();
}

function stripTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0) {
    const char = value[end - 1];
    if (char !== "." && char !== ";" && char !== ",") break;
    end -= 1;
  }
  return value.slice(0, end).trim();
}

function fieldValue(line: string, labels: string[]): string | null {
  const cleaned = cleanFieldLine(line);
  const lower = cleaned.toLowerCase();
  for (const label of labels) {
    if (!lower.startsWith(label)) continue;
    const afterLabel = cleaned.slice(label.length).trimStart();
    if (!afterLabel.startsWith(":") && !afterLabel.startsWith("=")) continue;
    return stripTrailingPunctuation(afterLabel.slice(1).trim());
  }
  return null;
}

function tokenPrefix(
  value: string,
  allowed: (char: string) => boolean,
): string {
  let end = 0;
  while (end < value.length && allowed(value[end])) {
    end += 1;
  }
  return value.slice(0, end);
}

function fieldTokens(lines: string[], labels: string[]): string[] {
  return unique(
    lines
      .map((line) => fieldValue(line, labels))
      .filter((value): value is string => Boolean(value))
      .map((value) =>
        tokenPrefix(value, (char) => /[A-Za-z0-9_.-]/.test(char)),
      ),
  );
}

function findWord(lower: string, word: string): number {
  let index = lower.indexOf(word);
  while (index >= 0) {
    const before = index === 0 ? "" : lower[index - 1];
    const after = lower[index + word.length] ?? "";
    const beforeOk = !before || !/[a-z0-9_]/.test(before);
    const afterOk = !after || !/[a-z0-9_]/.test(after);
    if (beforeOk && afterOk) return index;
    index = lower.indexOf(word, index + 1);
  }
  return -1;
}

function readFirstNumber(text: string): string | null {
  for (let index = 0; index < text.length; index += 1) {
    if (!/\d/.test(text[index])) continue;
    let end = index + 1;
    while (end < text.length && /[\d.]/.test(text[end])) end += 1;
    return text.slice(index, end);
  }
  return null;
}

function extractLoeHours(lines: string[]): number[] {
  const values: number[] = [];
  for (const line of lines) {
    const lower = cleanFieldLine(line).toLowerCase();
    const loeIndex = findWord(lower, "loe");
    const estimateIndex = findWord(lower, "estimate");
    const labelIndex =
      loeIndex >= 0 && estimateIndex >= 0
        ? Math.min(loeIndex, estimateIndex)
        : Math.max(loeIndex, estimateIndex);
    if (labelIndex < 0) continue;
    const remainder = lower.slice(labelIndex);
    const hasHourUnit =
      remainder.includes("hour") ||
      findWord(remainder, "h") >= 0 ||
      findWord(remainder, "hr") >= 0 ||
      findWord(remainder, "hrs") >= 0;
    if (!hasHourUnit) {
      continue;
    }
    const numberText = readFirstNumber(remainder);
    if (!numberText) continue;
    const value = Number(numberText);
    if (Number.isFinite(value)) values.push(value);
  }
  return [...new Set(values)];
}

function summarize(markdown: string, filename: string | null): string {
  const lines = markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*]\s+/, "")
        .trim(),
    )
    .filter((line) => line.length > 0 && !/^```/.test(line));
  const picked =
    lines.find((line) => /[A-Za-z0-9]/.test(line)) ?? filename ?? "";
  return picked.length > 180 ? `${picked.slice(0, 177).trim()}...` : picked;
}

function extractEntities(
  markdown: string,
  filename: string | null,
): ComposeSourceEntities {
  const text = `${filename ?? ""}\n${markdown}`;
  const lines = boundedLines(text);
  const scanText = lines.join("\n");
  const jiraKeys = unique(scanText.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? []);
  const repositories = unique([
    ...fieldTokens(lines, ["repo", "repository"]),
    ...(scanText.match(/\bcp-[a-z0-9-]+\b/gi) ?? []),
    ...(scanText.match(
      /\b(?:core-app|interop|provider-portal|medhok-monorepo)\b/gi,
    ) ?? []),
  ]);
  const files = unique(
    scanText.match(
      /\b[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|java|kt|py|sql|xml|yml|yaml|json|md)\b/g,
    ) ?? [],
  );
  const clients = fieldTokens(lines, ["client"]);
  const loeHours = extractLoeHours(lines);
  const dates = unique(scanText.match(/\b20\d{2}-\d{2}-\d{2}\b/g) ?? []);
  const assumptions = unique(
    lines
      .map((line) => fieldValue(line, ["assumption", "assumptions"]))
      .filter((value): value is string => Boolean(value)),
  );
  return {
    jiraKeys,
    repositories,
    files,
    clients,
    loeHours,
    dates,
    assumptions,
  };
}

function scoreUsefulness(
  markdown: string,
  entities: ComposeSourceEntities,
): ComposeSourceUsefulness {
  const lower = markdown.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean).length;
  const hasAcceptance =
    /acceptance criteria|given\b|when\b|then\b|done when|test plan/.test(lower);
  if (words < 12) return "weak_requirement_detail";
  if (/tbd|unknown|need clarification|open question|\?\s*$/.test(lower)) {
    return "needs_clarification";
  }
  if (entities.repositories.length === 0 && entities.files.length === 0) {
    return "missing_repo_context";
  }
  if (
    hasAcceptance ||
    entities.jiraKeys.length > 0 ||
    entities.loeHours.length > 0
  ) {
    return "high_signal";
  }
  return "unknown";
}

function contribution(
  usefulness: ComposeSourceUsefulness,
  entities: ComposeSourceEntities,
): string {
  if (usefulness === "high_signal") {
    const pieces = [
      entities.jiraKeys.length ? "Jira scope" : null,
      entities.repositories.length ? "repository context" : null,
      entities.files.length ? "file hints" : null,
      entities.loeHours.length ? "LOE" : null,
    ].filter(Boolean);
    return `High-signal source${pieces.length ? `: ${pieces.join(", ")}.` : "."}`;
  }
  if (usefulness === "missing_repo_context") {
    return "Requirement detail is present, but repository ownership is unresolved.";
  }
  if (usefulness === "needs_clarification") {
    return "Contains unresolved decisions that should be clarified before drafting.";
  }
  if (usefulness === "weak_requirement_detail") {
    return "Too little detail to materially shape the draft.";
  }
  return "Useful as supporting context.";
}

export function deriveComposeSourceIntelligence(
  input: ComposeSourceIntelligenceInput,
): ComposeSourceIntelligence {
  const summary = summarize(input.markdown, input.filename);
  const entities = extractEntities(input.markdown, input.filename);
  const usefulness = scoreUsefulness(input.markdown, entities);
  return {
    summary,
    entities,
    usefulness,
    contribution: contribution(usefulness, entities),
  };
}
