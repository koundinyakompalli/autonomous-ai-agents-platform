import { describe, expect, it } from "vitest";
import {
  buildEvidenceManifest,
  buildComposeEvidenceManifest,
  extractLoeHours,
} from "./evidence.js";
import type { JiraTicketData } from "../orchestrator/JiraClient.js";

function ticketData(overrides: Partial<JiraTicketData> = {}): JiraTicketData {
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
    descriptionMarkdown: "Raw requirement body",
    comments: [
      {
        id: "20010",
        author: "Louise",
        created: "2026-05-27T12:00:00.000Z",
        bodyMarkdown: "Total LOE: 38 hours",
      },
    ],
    attachments: [],
    textAttachments: [
      {
        filename: "code-changes.md",
        mimeType: "text/markdown",
        content: "Update EnrollmentSyncValidator.java",
        size: 36,
      },
    ],
    imageAttachments: [],
    ...overrides,
  };
}

describe("extractLoeHours", () => {
  it("extracts total LOE hours", () => {
    expect(extractLoeHours("Total LOE: 38 hours")).toBe(38);
  });

  it("extracts estimated effort hours", () => {
    expect(extractLoeHours("Estimated effort - 21.5h")).toBe(21.5);
  });

  it("extracts the high-end total from Louise LOE table rows", () => {
    expect(
      extractLoeHours("| **Total Hours** | 99 hours | 144 hours |"),
    ).toBe(144);
    expect(extractLoeHours("| **TOTAL** | **99** | **144** |")).toBe(144);
  });
});

describe("buildEvidenceManifest", () => {
  it("builds source evidence from Jira ticket data", () => {
    const manifest = buildEvidenceManifest(ticketData());

    expect(manifest.sourceJiraKey).toBe("CPDEV-22410");
    expect(manifest.sourceSummary).toBe("Enrollment sync rules");
    expect(manifest.sourceStatus).toBe("In Progress");
    expect(manifest.sourceLabels).toEqual(["louise-estimated"]);
    expect(manifest.descriptionMarkdown).toBe("Raw requirement body");
    expect(manifest.loeHours).toBe(38);
    expect(manifest.artifacts).toContainEqual(
      expect.objectContaining({
        kind: "code_changes",
        filename: "code-changes.md",
        content: "Update EnrollmentSyncValidator.java",
      }),
    );
  });

  it("prefers LOE estimate attachments over stale description and comments", () => {
    const manifest = buildEvidenceManifest(
      ticketData({
        descriptionMarkdown: "Old requirement text. Total LOE: 12 hours",
        comments: [
          {
            id: "20010",
            author: "Louise",
            created: "2026-05-27T12:00:00.000Z",
            bodyMarkdown: "Total LOE: 38 hours",
          },
        ],
        textAttachments: [
          {
            filename: "loe-estimate.md",
            mimeType: "text/markdown",
            content: "Estimated effort - 44h",
            size: 24,
          },
        ],
      }),
    );

    expect(manifest.loeHours).toBe(44);
  });

  it("prefers the newest Louise-authored comment over stale description LOE", () => {
    const manifest = buildEvidenceManifest(
      ticketData({
        descriptionMarkdown: "Old requirement text. Total LOE: 12 hours",
        comments: [
          {
            id: "20010",
            author: "Louise",
            created: "2026-05-27T12:00:00.000Z",
            bodyMarkdown: "Total LOE: 38 hours",
          },
          {
            id: "20011",
            author: "Louise",
            created: "2026-05-28T12:00:00.000Z",
            bodyMarkdown: "Total LOE: 41 hours",
          },
        ],
        textAttachments: [],
      }),
    );

    expect(manifest.loeHours).toBe(41);
  });

  it("defaults optional normalized Jira content when unexpectedly partial", () => {
    const manifest = buildEvidenceManifest({
      issue: ticketData().issue,
      descriptionMarkdown: null,
      comments: null,
      textAttachments: null,
      attachments: [],
      imageAttachments: [],
    } as unknown as JiraTicketData);

    expect(manifest.descriptionMarkdown).toBe("");
    expect(manifest.comments).toEqual([]);
    expect(manifest.artifacts).toEqual([]);
    expect(manifest.loeHours).toBeNull();
  });
});

describe("buildComposeEvidenceManifest", () => {
  it("builds a manifest from compose note sources", () => {
    const manifest = buildComposeEvidenceManifest({
      sourceJiraKey: "COMPOSE-9",
      sourceSummary: "Add export to billing",
      sources: [
        { filename: "chat.md", content: "We want CSV export for invoices." },
        { filename: "notes-1.md", content: "Repo is billing-service." },
      ],
    });

    expect(manifest.sourceJiraKey).toBe("COMPOSE-9");
    expect(manifest.sourceSummary).toBe("Add export to billing");
    expect(manifest.sourceStatus).toBeNull();
    expect(manifest.artifacts).toHaveLength(2);
    expect(manifest.artifacts[0].filename).toBe("chat.md");
    expect(manifest.artifacts[0].content).toContain("CSV export");
    expect(manifest.comments).toEqual([]);
    expect(Array.isArray(manifest.warnings)).toBe(true);
  });
});
