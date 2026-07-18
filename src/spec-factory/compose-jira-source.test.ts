import { describe, expect, it, vi } from "vitest";
import { ComposeJiraSourceFetcher } from "./compose-jira-source.js";

describe("ComposeJiraSourceFetcher", () => {
  it("turns existing Jira ticket data into a markdown source", async () => {
    const jiraClient = {
      fetchTicketData: vi.fn().mockResolvedValue({
        issue: {
          key: "CPDEV-123",
          fields: {
            summary: "Add CSV export",
            status: { name: "In Progress" },
            issuetype: { name: "Story" },
            priority: { name: "High" },
            assignee: { displayName: "Koundinya" },
            reporter: { displayName: "Louise" },
            labels: ["compose"],
            attachment: [{ filename: "notes.md", size: 12 }],
          },
        },
        descriptionMarkdown: "Build CSV export for billing.",
        comments: [
          {
            id: "10001",
            author: "Louise",
            created: "2026-06-03T12:00:00.000Z",
            bodyMarkdown: "Acceptance criteria are attached.",
          },
        ],
        attachments: [{ filename: "notes.md", size: 12 }],
        textAttachments: [
          {
            filename: "notes.md",
            mimeType: "text/markdown",
            size: 12,
            content: "Use billing-service.",
          },
        ],
        imageAttachments: [],
      }),
    };
    const fetcher = new ComposeJiraSourceFetcher(
      jiraClient as never,
      "https://jira.example.com/",
    );

    const result = await fetcher.fetchMarkdown("CPDEV-123");

    expect(jiraClient.fetchTicketData).toHaveBeenCalledWith("CPDEV-123");
    expect(result).toMatchObject({
      issueKey: "CPDEV-123",
      title: "CPDEV-123 Add CSV export",
      sourceUrl: "https://jira.example.com/browse/CPDEV-123",
    });
    expect(result.markdownContent).toContain("# CPDEV-123 Add CSV export");
    expect(result.markdownContent).toContain("Build CSV export for billing.");
    expect(result.markdownContent).toContain(
      "Acceptance criteria are attached.",
    );
    expect(result.markdownContent).toContain("Use billing-service.");
  });

  it("translates missing or unauthorized Jira issue errors into an operator-readable message", async () => {
    const jiraClient = {
      fetchTicketData: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'JIRA API error: 404 - {"errorMessages":["事务不存在或者您没有查看的权限。"],"errors":{}}',
          ),
        ),
    };
    const fetcher = new ComposeJiraSourceFetcher(
      jiraClient as never,
      "https://jira.example.com/",
    );

    await expect(fetcher.fetchMarkdown("BCBSRI-123")).rejects.toThrow(
      "Jira issue BCBSRI-123 was not found or is not visible to Spec Factory. Check the issue key and Jira permissions.",
    );
  });
});
