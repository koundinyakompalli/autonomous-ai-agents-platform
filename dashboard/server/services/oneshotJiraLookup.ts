import type { OneShotRunRequestValidation } from "../types/oneshot.js";
import {
  assertValidJiraKey,
  OneShotRunRequestError,
} from "./oneshotRunRequestSupport.js";
import {
  CLIENT_ELIGIBILITY_JIRA_EXPAND,
  extractClientNameFromJiraIssue,
} from "../../../src/oneshot/client-eligibility.js";

type JiraLookupResponse = {
  names?: Record<string, string>;
  fields?: {
    summary?: unknown;
    description?: unknown;
    comment?: unknown;
    created?: unknown;
    updated?: unknown;
    status?: {
      name?: unknown;
    };
    labels?: unknown;
    environment?: unknown;
    fixVersions?: unknown;
    versions?: unknown;
    customfield_10002?: unknown;
    customfield_10047?: unknown;
    customfield_10100?: unknown;
    [key: string]: unknown;
  };
};

const REQUIRED_JIRA_ENV = [
  "JIRA_TOKEN",
] as const;

type JiraEnvName = (typeof REQUIRED_JIRA_ENV)[number];

export function isOneShotJiraValidationConfigured(): boolean {
  return Boolean(getJiraBaseUrl()) && Boolean(getJiraUsername()) && REQUIRED_JIRA_ENV.every((name) => Boolean(process.env[name]?.trim()));
}

function getRequiredEnv(name: JiraEnvName): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new OneShotRunRequestError(
      `OneShot Jira validation is not configured: ${name} is missing`,
      503,
    );
  }
  return value;
}

function getJiraBaseUrl(): string {
  return (
    process.env.JIRA_BASE_URL?.trim()
    || process.env.ATLASSIAN_BASE_URL?.trim()
    || "https://mhkjira.atlassian.net"
  ).replace(/\/$/, "");
}

function getJiraUsername(): string | null {
  return process.env.JIRA_USERNAME?.trim() || process.env.JIRA_USER?.trim() || null;
}

function buildAuthHeader(username: string, token: string): string {
  return `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = stringValue(item);
      if (extracted) {
        return extracted;
      }
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return stringValue(record.value)
      || stringValue(record.name)
      || stringValue(record.displayName)
      || stringValue(record.label);
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => stringValue(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function plainText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(plainText).filter(Boolean).join(" ").trim();
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const ownText = typeof record.text === "string" ? record.text : "";
    const contentText = plainText(record.content);
    return [ownText, contentText].filter(Boolean).join(" ").trim();
  }
  return "";
}

function extractCommentText(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const comments = Array.isArray((value as Record<string, unknown>).comments)
    ? (value as Record<string, unknown>).comments as Array<Record<string, unknown>>
    : [];
  return comments
    .map((comment) => plainText(comment.body))
    .filter(Boolean)
    .join("\n")
    .slice(0, 12_000);
}

function normalizeEnvironmentSignal(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase().replace(/[_\s]+/g, "-");
  if (!normalized) {
    return null;
  }
  if (/\bPROD[-_]?REPLICA\b/.test(normalized) || /\bPROD[-_]?REPL\b/.test(normalized)) {
    return "PROD-REPLICA";
  }
  if (/^(?:PROD|PROD1|PRODUCTION)$/.test(normalized) || /\bCPPROD\b/.test(normalized)) {
    return "PROD";
  }
  if (/^STAGE\d*$/.test(normalized)) {
    return "STAGE";
  }
  if (/^UAT\d*$/.test(normalized)) {
    return "UAT";
  }
  if (/^INT\d*$/.test(normalized)) {
    return "INT";
  }
  if (/^DEV\d*$/.test(normalized)) {
    return "DEV";
  }
  return null;
}

function extractEnvironment(input: {
  labels: string[];
  fields?: JiraLookupResponse["fields"];
  title?: string;
  descriptionText?: string | null;
  commentText?: string | null;
}): string | null {
  const explicitField = stringValue(input.fields?.environment)
    || plainText(input.fields?.environment);
  const explicit = normalizeEnvironmentSignal(explicitField);
  if (explicit) {
    return explicit;
  }

  const normalized = input.labels.map((label) => label.trim().toLowerCase());
  if (normalized.includes("prod-replica") || normalized.includes("prod_replica")) {
    return "PROD-REPLICA";
  }
  if (normalized.includes("prod") || normalized.includes("production")) {
    return "PROD";
  }
  if (normalized.includes("stage")) {
    return "STAGE";
  }
  if (normalized.includes("uat")) {
    return "UAT";
  }
  if (normalized.includes("int")) {
    return "INT";
  }
  if (normalized.includes("dev")) {
    return "DEV";
  }

  const ticketText = [
    input.title || "",
    input.descriptionText || "",
    input.commentText || "",
  ].join("\n");
  if (/\bPROD[-_ ]?REPLICA\b/i.test(ticketText)) {
    return "PROD-REPLICA";
  }
  if (/\b(?:PROD1|PROD|PRODUCTION)\b/i.test(ticketText) || /\bCPPROD\b/i.test(ticketText)) {
    return "PROD";
  }
  if (/\bSTAGE\d*\b/i.test(ticketText)) {
    return "STAGE";
  }
  if (/\bUAT\d*\b/i.test(ticketText)) {
    return "UAT";
  }
  if (/\bINT\d*\b/i.test(ticketText)) {
    return "INT";
  }
  if (/\bDEV\d*\b/i.test(ticketText)) {
    return "DEV";
  }
  return null;
}

export async function validateOneShotRunRequestJiraKey(input: {
  jiraKey: string;
}): Promise<OneShotRunRequestValidation> {
  const jiraKey = assertValidJiraKey(input.jiraKey);
  const jiraBaseUrl = getJiraBaseUrl();
  const jiraUsername = getJiraUsername();
  if (!jiraUsername) {
    throw new OneShotRunRequestError(
      "OneShot Jira validation is not configured: JIRA_USERNAME or JIRA_USER is missing",
      503,
    );
  }
  const jiraToken = getRequiredEnv("JIRA_TOKEN");
  const params = new URLSearchParams({
    expand: CLIENT_ELIGIBILITY_JIRA_EXPAND,
    fields: "*all",
  });
  const url = `${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(jiraKey)}?${params.toString()}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: buildAuthHeader(jiraUsername, jiraToken),
        Accept: "application/json",
      },
    });
  } catch (error) {
    console.error("[oneshot-jira-lookup] failed to reach Jira:", error);
    throw new OneShotRunRequestError(
      `Failed to validate Jira issue ${jiraKey}`,
      502,
    );
  }

  if (response.status === 404) {
    throw new OneShotRunRequestError(`Jira issue ${jiraKey} not found`, 404);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    console.error("[oneshot-jira-lookup] Jira validation failed:", {
      jiraKey,
      status: response.status,
      statusText: response.statusText,
      error: errorText,
    });
    throw new OneShotRunRequestError(
      `Failed to validate Jira issue ${jiraKey}`,
      502,
    );
  }

  const payload = (await response.json()) as JiraLookupResponse;
  const title =
    typeof payload.fields?.summary === "string"
      ? payload.fields.summary.trim()
      : "";
  const statusName =
    typeof payload.fields?.status?.name === "string"
      ? payload.fields.status.name.trim()
      : "";
  const labels = stringArray(payload.fields?.labels);
  const codeVersion = stringValue(payload.fields?.fixVersions)
    || stringValue(payload.fields?.versions);
  const descriptionText = plainText(payload.fields?.description).slice(0, 8_000) || null;
  const commentText = extractCommentText(payload.fields?.comment) || null;
  const createdAt = stringValue(payload.fields?.created);
  const updatedAt = stringValue(payload.fields?.updated);

  if (!title) {
    throw new OneShotRunRequestError(
      `Jira issue ${jiraKey} is missing a title`,
      502,
    );
  }

  const clientName = extractClientNameFromJiraIssue({
    key: jiraKey,
    names: payload.names,
    fields: payload.fields,
  });

  return {
    jiraKey,
    title,
    statusName: statusName || "Unknown",
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    labels,
    clientName,
    environment: extractEnvironment({
      labels,
      fields: payload.fields,
      title,
      descriptionText,
      commentText,
    }),
    codeVersion,
    descriptionText,
    commentText,
  };
}
