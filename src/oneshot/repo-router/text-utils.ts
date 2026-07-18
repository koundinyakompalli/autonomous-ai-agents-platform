export const ACTION_VERBS = [
  "add",
  "change",
  "configure",
  "create",
  "fix",
  "implement",
  "migrate",
  "modify",
  "remove",
  "support",
  "update",
] as const;

export const CONTEXTUAL_VERBS = [
  "reference",
  "see",
  "uses",
  "called by",
  "from",
  "consumes",
  "integrates with",
] as const;

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function containsWholeToken(haystack: string, needle: string): boolean {
  const token = normalizeText(needle);
  if (!token) return false;
  return new RegExp(
    `(^|[^a-z0-9])${escapeRegex(token)}([^a-z0-9]|$)`,
    "i",
  ).test(normalizeText(haystack));
}

export function containsPhrase(haystack: string, phrase: string): boolean {
  const normalizedPhrase = phrase
    .toLowerCase()
    .trim()
    .split(/[\s-]+/)
    .map(escapeRegex)
    .join("[-\\s]+");
  if (!normalizedPhrase) return false;
  return new RegExp(`(^|[^a-z0-9])${normalizedPhrase}([^a-z0-9]|$)`, "i").test(
    haystack,
  );
}

export function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?\n;])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function hasActionVerb(sentence: string): boolean {
  return ACTION_VERBS.some((verb) => containsWholeToken(sentence, verb));
}

export function hasContextualVerb(sentence: string): boolean {
  const normalized = normalizeText(sentence);
  return CONTEXTUAL_VERBS.some((verb) => normalized.includes(verb));
}

/**
 * A sentence is contextual (i.e. a reference, not actionable work) ONLY when
 * it lacks an action verb entirely. A sentence like "Remove X from interop"
 * contains the contextual verb `from` but is still actionable because `Remove`
 * is an action verb directed at interop; such sentences must NOT be treated
 * as contextual.
 *
 * Pre-v3.5, this returned true whenever any contextual verb appeared,
 * which zeroed out actionable repo aliases in sentences that happened to use
 * "from", "reference", or similar filler words.
 */
export function isContextualMention(sentence: string): boolean {
  if (hasActionVerb(sentence)) return false;
  return hasContextualVerb(sentence);
}

export function flattenFieldValue(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenFieldValue(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["text", "value", "name", "displayName", "key"]) {
      const fieldValue = record[key];
      if (typeof fieldValue === "string" && fieldValue.trim()) {
        parts.push(fieldValue.trim());
      }
    }
    if (Array.isArray(record.content)) {
      parts.push(...record.content.flatMap((item) => flattenFieldValue(item)));
    }
    return parts;
  }
  return [];
}

export function stringifyFieldValue(value: unknown): string {
  return flattenFieldValue(value).join("\n").trim();
}

export function extractFilePaths(text: string): string[] {
  const matches =
    text.match(/\b[\w.-]+(?:\/[\w.@-]+)+(?:\.[A-Za-z0-9]+)?\b/g) ?? [];
  return Array.from(new Set(matches));
}

export function extractEndpoints(text: string): string[] {
  const matches =
    text.match(/(?:GET|POST|PUT|PATCH|DELETE)?\s*(\/[A-Za-z0-9_./{}:-]+)/g) ??
    [];
  return Array.from(
    new Set(
      matches.map((match) =>
        match.trim().replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/i, ""),
      ),
    ),
  );
}

export function extractIdentifiers(text: string): string[] {
  const matches: string[] =
    text.match(
      /\b[A-Z][A-Za-z0-9_]*(?:Service|Controller|Repository|Request|Response|Mapper|Handler|Job|Task|Dao|DAO)?\b/g,
    ) ?? [];
  return Array.from(new Set(matches.filter((match) => match.length >= 4)));
}

export function extractTables(text: string): string[] {
  const matches =
    text.match(
      /\b[a-z][a-z0-9_]{2,}\.[a-z][a-z0-9_]{2,}\b|\b[a-z][a-z0-9_]{3,}_[a-z0-9_]+\b/g,
    ) ?? [];
  return Array.from(new Set(matches));
}
