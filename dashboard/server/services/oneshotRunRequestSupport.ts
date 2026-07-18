const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/i;

export class OneShotRunRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OneShotRunRequestError";
  }
}

export function normalizeJiraKey(value: string): string {
  return value.trim().toUpperCase();
}

export function assertValidJiraKey(jiraKey: string): string {
  const normalized = normalizeJiraKey(jiraKey);
  if (!JIRA_KEY_PATTERN.test(normalized)) {
    throw new OneShotRunRequestError("jiraKey must look like ABC-123", 400);
  }
  return normalized;
}
