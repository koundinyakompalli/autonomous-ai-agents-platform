import type { JiraClient, JiraTicketData } from "../orchestrator/JiraClient.js";

export interface ComposeJiraSourceMarkdown {
  issueKey: string;
  title: string;
  sourceUrl: string;
  markdownContent: string;
}

function bullet(label: string, value: string | null | undefined): string {
  return `- ${label}: ${value?.trim() || "Unassigned"}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "unknown date";
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : value;
}

function formatJiraTicketMarkdown(
  ticketData: JiraTicketData,
  sourceUrl: string,
): string {
  const issue = ticketData.issue;
  const summary = issue.fields.summary?.trim() || issue.key;
  const lines: string[] = [
    `# ${issue.key} ${summary}`,
    "",
    bullet("Source", sourceUrl),
    bullet("Status", issue.fields.status?.name),
    bullet("Issue type", issue.fields.issuetype?.name),
    bullet("Priority", issue.fields.priority?.name),
    bullet("Assignee", issue.fields.assignee?.displayName),
    bullet("Reporter", issue.fields.reporter?.displayName),
    bullet("Labels", issue.fields.labels?.join(", ") || null),
    "",
    "## Description",
    "",
    ticketData.descriptionMarkdown?.trim() || "_No description supplied._",
  ];

  if (ticketData.comments.length > 0) {
    lines.push("", "## Comments", "");
    for (const comment of ticketData.comments) {
      lines.push(
        `### ${comment.author || "Unknown"} - ${formatDate(comment.created)}`,
        "",
        comment.bodyMarkdown.trim() || "_No comment body._",
        "",
      );
    }
  }

  const attachments = ticketData.attachments ?? [];
  if (attachments.length > 0) {
    lines.push("", "## Attachments", "");
    for (const attachment of attachments) {
      const size =
        typeof attachment.size === "number" ? ` (${attachment.size} bytes)` : "";
      lines.push(`- ${attachment.filename}${size}`);
    }
  }

  const textAttachments = ticketData.textAttachments ?? [];
  if (textAttachments.length > 0) {
    lines.push("", "## Text Attachments", "");
    for (const attachment of textAttachments) {
      lines.push(
        `### ${attachment.filename}`,
        "",
        "```text",
        attachment.content,
        "```",
        "",
      );
    }
  }

  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trim() + "\n";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingOrUnauthorizedJiraError(message: string): boolean {
  return (
    /\b404\b/.test(message) ||
    /does not exist|not found|permission|unauthorized|forbidden|没有查看|权限|不存在/i.test(
      message,
    )
  );
}

export class ComposeJiraSourceFetcher {
  private readonly baseUrl: string;

  constructor(
    private readonly jiraClient: Pick<JiraClient, "fetchTicketData">,
    baseUrl: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async fetchMarkdown(jiraKey: string): Promise<ComposeJiraSourceMarkdown> {
    let ticketData: JiraTicketData;
    try {
      ticketData = await this.jiraClient.fetchTicketData(jiraKey);
    } catch (error) {
      const message = errorMessage(error);
      if (isMissingOrUnauthorizedJiraError(message)) {
        throw new Error(
          `Jira issue ${jiraKey} was not found or is not visible to Spec Factory. Check the issue key and Jira permissions.`,
        );
      }
      throw new Error(`Failed to fetch Jira issue ${jiraKey}: ${message}`);
    }
    const issueKey = ticketData.issue.key;
    const summary = ticketData.issue.fields.summary?.trim() || issueKey;
    const sourceUrl = `${this.baseUrl}/browse/${encodeURIComponent(issueKey)}`;
    return {
      issueKey,
      title: `${issueKey} ${summary}`,
      sourceUrl,
      markdownContent: formatJiraTicketMarkdown(ticketData, sourceUrl),
    };
  }
}
