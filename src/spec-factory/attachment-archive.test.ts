import { describe, expect, it, vi } from "vitest";
import {
  SpecFactoryAttachmentArchiver,
  type UpsertAttachmentArchiveInput,
} from "./attachment-archive.js";
import type { JiraTicketData } from "../orchestrator/JiraClient.js";
import type { SpecFactoryAttachmentSummary } from "./types.js";

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
    descriptionMarkdown: "",
    comments: [],
    attachments: [
      {
        id: "att-1",
        filename: "LOE-CPDEV-22410.md",
        mimeType: "text/markdown",
        size: 24,
      },
      {
        id: "att-2",
        filename: "mockup.png",
        mimeType: "image/png",
        size: 10,
      },
      {
        id: "att-3",
        filename: "archive.zip",
        mimeType: "application/zip",
        size: 10,
      },
    ],
    textAttachments: [],
    imageAttachments: [],
  };
}

function row(input: UpsertAttachmentArchiveInput): SpecFactoryAttachmentSummary {
  return {
    id: Number(input.jiraAttachmentId.replace(/\D/g, "")) || 1,
    sourceId: input.sourceId,
    jiraAttachmentId: input.jiraAttachmentId,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    artifactKind: input.artifactKind,
    isPriority: input.isPriority,
    s3Bucket: input.s3Bucket,
    s3Key: input.s3Key,
    sha256: input.sha256,
    extractedText: input.extractedText,
    extractionStatus: input.extractionStatus,
    errorMessage: input.errorMessage,
    createdAt: "2026-05-27T12:00:00.000Z",
    updatedAt: "2026-05-27T12:00:00.000Z",
  };
}

function response(body: string): Response {
  return {
    headers: {
      get: vi.fn((name: string) =>
        name.toLowerCase() === "content-type" ? "text/markdown" : null,
      ),
    },
    arrayBuffer: vi.fn(async () => Buffer.from(body, "utf8")),
  } as unknown as Response;
}

describe("SpecFactoryAttachmentArchiver", () => {
  it("archives text and image attachments to S3 and persists extracted text metadata", async () => {
    const downloadAttachmentStream = vi.fn(async (id: string) =>
      response(id === "att-1" ? "Total LOE: 44 hours" : "png-bytes"),
    );
    const upsertAttachment = vi.fn(async (input) => row(input));
    const s3Client = { send: vi.fn(async () => ({})) };
    const archiver = new SpecFactoryAttachmentArchiver(
      { downloadAttachmentStream },
      { upsertAttachment },
      s3Client as never,
      { bucket: "specter-results" },
    );

    const result = await archiver.archiveTicketAttachments({
      sourceId: 12,
      ticketData: ticketData(),
    });

    expect(downloadAttachmentStream).toHaveBeenCalledTimes(2);
    expect(downloadAttachmentStream).toHaveBeenCalledWith("att-1");
    expect(downloadAttachmentStream).toHaveBeenCalledWith("att-2");
    expect(s3Client.send).toHaveBeenCalledTimes(2);
    expect(upsertAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        jiraAttachmentId: "att-1",
        filename: "LOE-CPDEV-22410.md",
        artifactKind: "loe_estimate",
        isPriority: true,
        s3Bucket: "specter-results",
        s3Key: "spec-factory/CPDEV-22410/attachments/att-1-LOE-CPDEV-22410.md",
        extractedText: "Total LOE: 44 hours",
        extractionStatus: "extracted",
      }),
    );
    expect(upsertAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        jiraAttachmentId: "att-2",
        filename: "mockup.png",
        extractedText: null,
        extractionStatus: "stored",
      }),
    );
    expect(result.archived).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("skips oversized attachments while retaining a persisted archive row", async () => {
    const data = ticketData();
    data.attachments = [
      {
        id: "att-1",
        filename: "Development-Plan-CPDEV-22410.md",
        mimeType: "text/markdown",
        size: 11,
      },
    ];
    const downloadAttachmentStream = vi.fn();
    const upsertAttachment = vi.fn(async (input) => row(input));
    const archiver = new SpecFactoryAttachmentArchiver(
      { downloadAttachmentStream },
      { upsertAttachment },
      { send: vi.fn() } as never,
      { bucket: "specter-results", maxTextBytes: 10 },
    );

    const result = await archiver.archiveTicketAttachments({
      sourceId: 12,
      ticketData: data,
    });

    expect(downloadAttachmentStream).not.toHaveBeenCalled();
    expect(result.archived[0]).toMatchObject({
      filename: "Development-Plan-CPDEV-22410.md",
      extractionStatus: "skipped",
    });
    expect(result.warnings[0]).toContain("exceeds 10 bytes");
  });
});
