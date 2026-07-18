export type ClarificationType =
  | "business"
  | "functional"
  | "implementation"
  | "research_consent";

const EXPLICIT_IMPLEMENTATION_PATTERN =
  /\b(?:package|framework|library|repository|repo|branch|source file|code file|folder|controller|database|table|column|schema|migration|endpoint|api|architecture|design pattern|cache|queue|event bus|sync|async|synchronous|asynchronous|webhook|polling|terraform|ecs|aws|bedrock|runtime|deployment|container|lambda|topic|implementation approach|technical approach)\b/i;
const CODE_ACTION_PATTERN =
  /\b(?:reuse|refactor|call|invoke|extend|modify|implement|create|extract|rename|inherit|persist|deploy)\b/i;
const CODE_CONSTRUCT_PATTERN =
  /\b(?:method|function|class|interface|service|model)\b|\w+\s*\([^)]*\)/i;
const TECHNICAL_OWNERSHIP_PATTERN =
  /\b(?:which|what)\s+(?:backend\s+)?(?:service|module|component)\s+(?:owns?|handles?|implements?|processes?)\b|\b(?:service|module|component)\s+(?:class|method|function|repository)\b/i;
const RESEARCH_CONSENT_PATTERN =
  /\b(?:research|inspect|investigate|review|look (?:at|through)|search)\b[\s\S]{0,80}\b(?:code|codebase|repo|repository|implementation)\b/i;
const RESEARCH_NEGATION_PATTERN =
  /\b(?:do not|don't|not yet|no|without)\b[\s\S]{0,40}\b(?:research|inspect|investigate|review|search)\b/i;

function textField(
  record: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function clarificationText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return textField(value as Record<string, unknown>, [
    "question",
    "text",
    "openQuestion",
    "open_question",
    "prompt",
    "title",
    "summary",
  ]);
}

function looksLikeImplementationDecision(text: string): boolean {
  return (
    EXPLICIT_IMPLEMENTATION_PATTERN.test(text) ||
    TECHNICAL_OWNERSHIP_PATTERN.test(text) ||
    (CODE_ACTION_PATTERN.test(text) && CODE_CONSTRUCT_PATTERN.test(text))
  );
}

export function clarificationType(value: unknown): ClarificationType {
  const text = clarificationText(value) ?? "";
  if (RESEARCH_CONSENT_PATTERN.test(text)) return "research_consent";
  if (looksLikeImplementationDecision(text)) return "implementation";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const declared = textField(record, [
      "questionType",
      "question_type",
      "category",
    ])?.toLowerCase();
    if (
      declared === "business" ||
      declared === "functional" ||
      declared === "implementation" ||
      declared === "research_consent"
    ) {
      return declared;
    }
  }
  return /\b(?:revenue|customer|member|provider|business|policy|compliance|market|contract|sla|priority|outcome|value)\b/i.test(
    text,
  )
    ? "business"
    : "functional";
}

export function isUserFacingClarification(value: unknown): boolean {
  const type = clarificationType(value);
  return (
    type === "business" ||
    type === "functional" ||
    type === "research_consent"
  );
}

export function hasExplicitResearchConsent(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text || RESEARCH_NEGATION_PATTERN.test(text)) return false;
  if (!RESEARCH_CONSENT_PATTERN.test(text)) return false;
  return /\b(?:yes|please|start|proceed|go ahead|you can|do it|research|inspect|investigate|review|search)\b/i.test(
    text,
  );
}

export const RESEARCH_CONSENT_QUESTION =
  "I have a clear problem statement. May I ask the development agent to research the codebase now?";

export function researchConsentExpiresAt(now = new Date()): string {
  return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
}
