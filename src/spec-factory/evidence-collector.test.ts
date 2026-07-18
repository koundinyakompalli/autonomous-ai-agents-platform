import { describe, expect, it, vi } from "vitest";
import type { JiraTicketData } from "../orchestrator/JiraClient.js";
import type { CodeRepository } from "../orchestrator/database.js";
import { SpecFactoryEvidenceCollector } from "./evidence-collector.js";

function ticketData(): JiraTicketData {
  return {
    issue: {
      key: "CPDEV-22410",
      id: "10010",
      self: "https://jira.example.com/rest/api/3/issue/10010",
      fields: {
        summary: "Enrollment sync rules",
        status: { name: "In Progress" },
        labels: ["louise-estimated"],
        attachment: [],
      },
    },
    descriptionMarkdown: "repo: core-app",
    comments: [
      {
        id: "20010",
        author: "Louise",
        created: "2026-05-27T12:00:00.000Z",
        bodyMarkdown: "Total LOE: 38 hours",
      },
    ],
    attachments: [],
    textAttachments: [],
    imageAttachments: [],
  };
}

function repositories(): CodeRepository[] {
  return [
    {
      id: 7,
      repo_name: "core-app",
      repo_url: "https://github.com/mhk-repos/core-app.git",
      description: "Core app",
      default_branch: "master",
      created_at: new Date("2026-05-27T12:00:00.000Z"),
    },
  ];
}

describe("SpecFactoryEvidenceCollector", () => {
  it("archives attachments, cross-checks repos, stores a snapshot, and records an event", async () => {
    const data = ticketData();
    const getSourceById = vi.fn();
    const createEvidenceSnapshot = vi.fn(async ({ manifest }) => {
      expect(manifest.loeHours).toBe(44);
      expect(manifest.loeSource).toBe("attachment:LOE-CPDEV-22410.md");
      expect(manifest.repoReferences?.matchedRepos).toEqual([
        {
          repoId: 7,
          repoName: "core-app",
          repoUrl: "https://github.com/mhk-repos/core-app.git",
          defaultBranch: "master",
          evidenceRefs: [
            "description",
            "attachment:Development-Plan-CPDEV-22410.md",
          ],
        },
      ]);
      return 501;
    });
    const recordEvent = vi.fn();
    const archiveTicketAttachments = vi.fn(async () => ({
      archived: [
        {
          jiraAttachmentId: "att-1",
          filename: "LOE-CPDEV-22410.md",
          mimeType: "text/markdown",
          sizeBytes: 24,
          s3Bucket: "specter-results",
          s3Key: "spec-factory/CPDEV-22410/attachments/att-1-LOE-CPDEV-22410.md",
          sha256: "a".repeat(64),
          extractedText: "Estimated effort - 44h",
          extractionStatus: "extracted" as const,
          errorMessage: null,
        },
        {
          jiraAttachmentId: "att-2",
          filename: "Development-Plan-CPDEV-22410.md",
          mimeType: "text/markdown",
          sizeBytes: 48,
          s3Bucket: "specter-results",
          s3Key: "spec-factory/CPDEV-22410/attachments/att-2-Development-Plan-CPDEV-22410.md",
          sha256: "b".repeat(64),
          extractedText: "Implement core-app/src/Validator.java.",
          extractionStatus: "extracted" as const,
          errorMessage: null,
        },
      ],
      warnings: ["attachment warning"],
    }));
    const collector = new SpecFactoryEvidenceCollector(
      { fetchTicketData: vi.fn() },
      { getSourceById, createEvidenceSnapshot, recordEvent },
      { archiveTicketAttachments },
      vi.fn(async () => repositories()),
    );

    const manifest = await collector.collectTicketData(12, data);

    expect(archiveTicketAttachments).toHaveBeenCalledWith({
      sourceId: 12,
      ticketData: data,
    });
    expect(manifest.snapshotId).toBe(501);
    expect(manifest.warnings).toContain("attachment warning");
    expect(recordEvent).toHaveBeenCalledWith(
      12,
      "evidence_snapshot_created",
      null,
      {
        snapshotId: 501,
        attachmentCount: 2,
        repoCount: 1,
        warningCount: manifest.warnings.length,
      },
    );
  });
});
