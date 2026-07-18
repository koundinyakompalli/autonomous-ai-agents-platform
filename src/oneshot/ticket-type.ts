import {
  DOCS_GENERATE_LABEL,
  SONAR_AUTOFIX_LABEL,
  SONAR_LABEL,
  normalizeJiraLabels,
} from "./contracts.js";

export const ONE_SHOT_TICKET_TYPES = [
  "story",
  "defect",
  "sonar",
  "security",
  "retrofit",
  "documentation",
  "other",
  "unknown",
] as const;

export type OneShotTicketType = (typeof ONE_SHOT_TICKET_TYPES)[number];

export interface ResolveOneShotTicketTypeInput {
  jiraIssueType?: string | null;
  jiraLabels?: string[] | null;
  ticketSummary?: string | null;
  taskDescription?: string | null;
}

export interface ResolvedOneShotTicketType {
  jiraIssueType: string | null;
  ticketType: OneShotTicketType;
  ticketTypeSource: string;
}

const TICKET_TYPE_SET = new Set<string>(ONE_SHOT_TICKET_TYPES);

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeOneShotTicketType(
  value: unknown,
): OneShotTicketType | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return TICKET_TYPE_SET.has(normalized)
    ? (normalized as OneShotTicketType)
    : null;
}

export function resolveOneShotTicketType(
  input: ResolveOneShotTicketTypeInput,
): ResolvedOneShotTicketType {
  const jiraIssueType = clean(input.jiraIssueType);
  const issueTypeKey = jiraIssueType?.toLowerCase() ?? "";
  const labels = normalizeJiraLabels(input.jiraLabels ?? undefined);
  const summaryText = (input.ticketSummary ?? "").toLowerCase();
  const labelList = [...labels];

  if (
    labels.has(SONAR_AUTOFIX_LABEL) ||
    labels.has(SONAR_LABEL) ||
    labelList.some((label) => label.startsWith("SONAR-")) ||
    /\bsonarqube\b|\bsonar\b/.test(summaryText)
  ) {
    return {
      jiraIssueType,
      ticketType: "sonar",
      ticketTypeSource: "inferred_sonar",
    };
  }

  if (
    labels.has("SECURITY") ||
    labelList.some((label) => label.startsWith("WIZ-SCAN-")) ||
    /\bwiz\b|\bsecurity\b/.test(summaryText)
  ) {
    return {
      jiraIssueType,
      ticketType: "security",
      ticketTypeSource: "inferred_security",
    };
  }

  if (
    /\bretro(?:fit)?\b|\bforward[- ]?port\b|\bback[- ]?port\b/.test(
      summaryText,
    )
  ) {
    return {
      jiraIssueType,
      ticketType: "retrofit",
      ticketTypeSource: "inferred_retrofit",
    };
  }

  if (issueTypeKey === "defect" || issueTypeKey === "bug") {
    return {
      jiraIssueType,
      ticketType: "defect",
      ticketTypeSource: "jira_issue_type",
    };
  }

  if (issueTypeKey === "story") {
    return {
      jiraIssueType,
      ticketType: "story",
      ticketTypeSource: "jira_issue_type",
    };
  }

  if (labels.has(DOCS_GENERATE_LABEL)) {
    return {
      jiraIssueType,
      ticketType: "documentation",
      ticketTypeSource: "inferred_documentation",
    };
  }

  if (jiraIssueType) {
    return {
      jiraIssueType,
      ticketType: "other",
      ticketTypeSource: "jira_issue_type",
    };
  }

  return {
    jiraIssueType,
    ticketType: "unknown",
    ticketTypeSource: "unknown",
  };
}
