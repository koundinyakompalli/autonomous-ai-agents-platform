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

export function isImplementationDetail(text: string): boolean {
  return (
    EXPLICIT_IMPLEMENTATION_PATTERN.test(text) ||
    TECHNICAL_OWNERSHIP_PATTERN.test(text) ||
    (CODE_ACTION_PATTERN.test(text) && CODE_CONSTRUCT_PATTERN.test(text))
  );
}

export function clarificationText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["question", "text", "title", "summary"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

export function isUserFacingClarification(value: unknown): boolean {
  const question = clarificationText(value);
  if (!question) return false;
  if (RESEARCH_CONSENT_PATTERN.test(question)) return true;
  if (isImplementationDetail(question)) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const questionType = (value as Record<string, unknown>).questionType;
    if (questionType === "implementation") return false;
    if (
      questionType === "business" ||
      questionType === "functional" ||
      questionType === "research_consent"
    ) {
      return true;
    }
  }
  return true;
}
