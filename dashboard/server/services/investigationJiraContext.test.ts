import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  augmentInvestigationTicketContext,
  deriveTicketTimeWindow,
  extractCaseIdentifiersFromTicketText,
  extractMemberIdentifierFromAttachmentFilename,
  extractMemberIdentifiersFromJson,
  extractMemberIdentifiersFromTicketText,
  fetchInvestigationJiraContext,
  isInvestigationJiraContextConfigured,
} from "./investigationJiraContext.js";

const originalEnv = { ...process.env };

function adf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

describe("investigation Jira context", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      JIRA_BASE_URL: "https://jira.example.com",
      JIRA_USERNAME: "jira-user@example.com",
      JIRA_TOKEN: "jira-token",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetches ticket description/comments and derives bounded investigation scope inputs", async () => {
    vi.stubEnv("INVESTIGATION_JIRA_IMAGE_OCR_ENABLED", "false");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/comment?")) {
        return new Response(JSON.stringify({
          startAt: 0,
          maxResults: 100,
          total: 1,
          comments: [
            {
              id: "10001",
              created: "2026-05-26T14:00:00.000-0400",
              updated: "2026-05-26T14:05:00.000-0400",
              body: adf("CloudWatch shows EAppealService exception for provider_appeals_mgmt_id 777."),
            },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({
        key: "CPSUP-48576",
        id: "48576",
        self: "https://jira.example.com/rest/api/3/issue/48576",
        fields: {
          summary: "PerformRx eAppeal investigation",
          status: { name: "Open" },
          environment: "WELLCARE---CP-PROD1",
          labels: ["investigation-cockpit", "client-performrx", "env-uat-3.18"],
          created: "2026-05-26T09:30:00.000-0400",
          updated: "2026-05-26T14:10:00.000-0400",
          description: adf("On 2026-05-26 EAppealService failed.\nCase #\n12345678901, 12345678902, 12345678903\nMember ID #\n99999999999\nmemberId=12345 password=plain-text"),
          attachment: [
            {
              id: "att-1",
              filename: "performrx-eappeal-error.log",
              mimeType: "text/plain",
              size: 1234,
              created: "2026-05-26T14:00:00.000-0400",
            },
            {
              id: "att-2",
              filename: "latest-screenshot.png",
              mimeType: "image/png",
              size: 43321,
              content: "https://jira.example.com/rest/api/3/attachment/content/att-2",
              created: "2026-05-26T14:01:00.000-0400",
            },
          ],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const context = await fetchInvestigationJiraContext("CPSUP-48576");

    expect(context).toMatchObject({
      source: "jira",
      jiraKey: "CPSUP-48576",
      fetchStatus: "fetched",
      title: "PerformRx eAppeal investigation",
      statusName: "Open",
      environmentName: "WELLCARE---CP-PROD1",
      labels: ["investigation-cockpit", "client-performrx", "env-uat-3.18"],
    });
    expect(context?.descriptionPresent).toBe(true);
    expect(context?.commentCount).toBe(1);
    expect(context?.description).toBeUndefined();
    expect(context?.comments).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain("plain-text");
    expect(context?.attachments).toHaveLength(2);
    expect(context?.attachments?.[0]).toMatchObject({
      filename: "performrx-eappeal-error.log",
      extractionStatus: "skipped",
    });
    expect(context?.attachments?.[1]).toMatchObject({
      filename: "latest-screenshot.png",
      extractionStatus: "metadata_only",
    });
    expect(context?.identifiers).toEqual([
      { kind: "case_number", source: "description", value: "12345678901", sensitive: true },
      { kind: "case_number", source: "description", value: "12345678902", sensitive: true },
      { kind: "case_number", source: "description", value: "12345678903", sensitive: true },
      { kind: "member_identifier", source: "description", value: "99999999999", sensitive: true },
      { kind: "member_identifier", source: "description", value: "12345", sensitive: true },
    ]);
    expect(context?.evidenceAnchors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "member_identifier",
        value: "99999999999",
        sensitive: true,
      }),
    ]));
    expect(context?.extractedTerms).toEqual(expect.arrayContaining(["EAppealService", "provider_appeals_mgmt_id"]));
    expect(deriveTicketTimeWindow(context)).toEqual({
      startTs: "2026-05-26T00:00:00.000Z",
      endTs: "2026-05-28T00:00:00.000Z",
    });
  });

  it("includes compact attachment dates and rotation grace in the bounded log window", () => {
    expect(deriveTicketTimeWindow({
      source: "jira",
      jiraKey: "CPSUP-1",
      fetchStatus: "fetched",
      createdAt: "2026-07-13T17:00:00.000Z",
      updatedAt: "2026-07-14T15:00:00.000Z",
      attachments: [{
        id: "att-1",
        filename: "image-20260710-123456.png",
        created: "2026-07-13T18:00:00.000Z",
        extractionStatus: "metadata_only",
      }],
    })).toEqual({
      startTs: "2026-07-10T00:00:00.000Z",
      endTs: "2026-07-16T00:00:00.000Z",
    });
  });

  it("derives a timezone-aware start from yesterday at an explicit local time", () => {
    expect(deriveTicketTimeWindow({
      source: "jira",
      jiraKey: "SUP-200",
      fetchStatus: "fetched",
      createdAt: "2026-07-16T09:58:27.689-0400",
      updatedAt: "2026-07-16T11:33:03.762-0400",
      description: "The issue started yesterday. Review logs starting at 9:20 am UTC.",
    })).toEqual({
      startTs: "2026-07-15T09:20:00.000Z",
      endTs: "2026-07-18T00:00:00.000Z",
    });
  });

  it("uses a bounded operator hint to add search terms and a time window without retaining the text", () => {
    const augmented = augmentInvestigationTicketContext({
      source: "jira",
      jiraKey: "SUP-200",
      fetchStatus: "fetched",
      title: "Northwind outbound notifications requests stopped",
      createdAt: "2026-07-16T09:58:27.689-0400",
      updatedAt: "2026-07-16T11:33:03.762-0400",
      extractedTerms: ["outbound notifications"],
    }, "Investigate behavior from yesterday after a password rotation. Review from 9:20 am UTC. password=do-not-retain");

    expect(augmented?.extractedTerms).toEqual(expect.arrayContaining(["outbound notifications", "password"]));
    expect(augmented?.timeWindow).toEqual({
      startTs: "2026-07-15T09:20:00.000Z",
      endTs: "2026-07-18T00:00:00.000Z",
    });
    expect(augmented?.description).toBeUndefined();
    expect(augmented?.comments).toBeUndefined();
    expect(JSON.stringify(augmented)).not.toContain("do-not-retain");
  });

  it("extracts release version from Jira Release Version custom fields", async () => {
    vi.stubEnv("INVESTIGATION_JIRA_IMAGE_OCR_ENABLED", "false");
    vi.stubEnv("INVESTIGATION_JIRA_FIELD_METADATA_CACHE_TTL_MS", "0");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/rest/api/3/field")) {
        return new Response(JSON.stringify([
          { id: "customfield_10136", name: "Release Version", custom: true },
          { id: "customfield_11964", name: "Release", custom: true },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/comment?")) {
        return new Response(JSON.stringify({
          startAt: 0,
          maxResults: 100,
          total: 0,
          comments: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({
        key: "CPSUP-99999",
        id: "99999",
        self: "https://jira.example.com/rest/api/3/issue/99999",
        fields: {
          summary: "Humana PROD investigation",
          status: { name: "Open" },
          environment: "HUMANA---CP-PROD2",
          labels: [],
          customfield_10136: { id: "12141", value: "3.18" },
          customfield_11964: "3.18",
          created: "2026-07-09T09:30:00.000-0400",
          updated: "2026-07-09T14:10:00.000-0400",
          description: adf("Portlet issue in PROD."),
          attachment: [],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const context = await fetchInvestigationJiraContext("CPSUP-99999");

    expect(context).toMatchObject({
      source: "jira",
      jiraKey: "CPSUP-99999",
      fetchStatus: "fetched",
      releaseVersion: "3.18",
      labels: [],
    });
    const issueUrl = fetchMock.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes("/rest/api/3/issue/CPSUP-99999?"));
    expect(issueUrl).toBeDefined();
    expect(new URL(issueUrl || "").searchParams.get("fields")).toContain("customfield_10136");
  });

  it("extracts Jira Environment from a custom field when the built-in field is empty", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/rest/api/3/field")) {
        return new Response(JSON.stringify([
          { id: "customfield_12345", name: "Environment", custom: true },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/comment?")) {
        return new Response(JSON.stringify({
          startAt: 0,
          maxResults: 100,
          total: 0,
          comments: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      expect(url).toContain("customfield_12345");
      return new Response(JSON.stringify({
        key: "CPSUP-50343",
        id: "50343",
        self: "https://jira.example.com/rest/api/3/issue/50343",
        fields: {
          summary: "Centene MedPharm Letter Template Update",
          status: { name: "Open" },
          customfield_12345: { value: "WELLCARE---CP-PROD1" },
          labels: ["CCIU_TOOL"],
          created: "2026-06-09T13:17:10.952-0400",
          updated: "2026-06-25T15:05:04.840-0400",
          description: adf("Issue with Tool."),
          attachment: [],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const context = await fetchInvestigationJiraContext("CPSUP-50343");

    expect(context).toMatchObject({
      source: "jira",
      jiraKey: "CPSUP-50343",
      fetchStatus: "fetched",
      environmentName: "WELLCARE---CP-PROD1",
    });
  });

  it("uses configured Jira Environment field IDs without fetching Jira field metadata", async () => {
    vi.stubEnv("INVESTIGATION_JIRA_ENVIRONMENT_FIELD_IDS", "customfield_67890");
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).not.toContain("/rest/api/3/field");
      if (url.includes("/comment?")) {
        return new Response(JSON.stringify({
          startAt: 0,
          maxResults: 100,
          total: 0,
          comments: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      expect(url).toContain("customfield_67890");
      return new Response(JSON.stringify({
        key: "CPSUP-50343",
        id: "50343",
        self: "https://jira.example.com/rest/api/3/issue/50343",
        fields: {
          summary: "Centene MedPharm Letter Template Update",
          status: { name: "Open" },
          customfield_67890: [{ value: "WELLCARE---CP-PROD1" }],
          labels: ["CCIU_TOOL"],
          created: "2026-06-09T13:17:10.952-0400",
          updated: "2026-06-25T15:05:04.840-0400",
          description: adf("Issue with Tool."),
          attachment: [],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const context = await fetchInvestigationJiraContext("CPSUP-50343");

    expect(context).toMatchObject({
      source: "jira",
      jiraKey: "CPSUP-50343",
      fetchStatus: "fetched",
      environmentName: "WELLCARE---CP-PROD1",
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/rest/api/3/field"),
      expect.anything(),
    );
  });

  it("resolves Jira Assets Environment objects to their labels", async () => {
    vi.stubEnv("INVESTIGATION_JIRA_ENVIRONMENT_FIELD_IDS", "customfield_11931");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/jsm/assets/workspace/workspace-1/v1/object/40904")) {
        return new Response(JSON.stringify({
          label: "WELLCARE---CP-PROD1",
          objectKey: "ENV-40904",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/comment?")) {
        return new Response(JSON.stringify({
          startAt: 0,
          maxResults: 100,
          total: 0,
          comments: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }

      return new Response(JSON.stringify({
        key: "CPSUP-50343",
        id: "50343",
        self: "https://jira.example.com/rest/api/3/issue/50343",
        fields: {
          summary: "Centene MedPharm Letter Template Update",
          status: { name: "Open" },
          customfield_11931: [{
            workspaceId: "workspace-1",
            id: "workspace-1:40904",
            objectId: "40904",
          }],
          labels: ["CCIU_TOOL"],
          created: "2026-06-09T13:17:10.952-0400",
          updated: "2026-06-25T15:05:04.840-0400",
          description: adf("Issue with Tool."),
          attachment: [],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const context = await fetchInvestigationJiraContext("CPSUP-50343");

    expect(context).toMatchObject({
      source: "jira",
      jiraKey: "CPSUP-50343",
      fetchStatus: "fetched",
      environmentName: "WELLCARE---CP-PROD1",
    });
  });

  it("extracts bounded OCR text from screenshot attachments by default without persisting image bytes or URLs", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "jira-ocr-test-"));
    const ocrScriptPath = path.join(tempDir, "ocr-fixture.cjs");
    await writeFile(
      ocrScriptPath,
      "process.stdout.write('Skybot Job: CenteneLetterTemplateBatch\\nCommand Path: /opt/software/medhok/jobs/letters.sh\\n');\n",
    );
    vi.stubEnv("INVESTIGATION_JIRA_IMAGE_OCR_COMMAND", process.execPath);
    vi.stubEnv("INVESTIGATION_JIRA_IMAGE_OCR_ARGS", `${ocrScriptPath} {input}`);

    try {
      const fetchMock = vi.fn(async (url: string) => {
        if (url === "https://jira.example.com/rest/api/3/attachment/content/att-png") {
          return new Response(new Uint8Array([137, 80, 78, 71]), {
            status: 200,
            headers: { "Content-Type": "image/png" },
          });
        }
        if (url.includes("/comment?")) {
          return new Response(JSON.stringify({
            startAt: 0,
            maxResults: 100,
            total: 0,
            comments: [],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({
          key: "CPSUP-50343",
          id: "50343",
          self: "https://jira.example.com/rest/api/3/issue/50343",
          fields: {
            summary: "Centene batch job screenshot",
            status: { name: "Open" },
            created: "2026-06-09T13:17:10.952-0400",
            updated: "2026-06-25T15:05:04.840-0400",
            description: adf("Review screenshot for job name."),
            attachment: [
              {
                id: "att-png",
                filename: "batch-job.png",
                mimeType: "image/png",
                size: 4,
                content: "https://jira.example.com/rest/api/3/attachment/content/att-png",
                created: "2026-06-09T13:17:12.465-0400",
              },
            ],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      });
      vi.stubGlobal("fetch", fetchMock);

      const context = await fetchInvestigationJiraContext("CPSUP-50343");
      const attachment = context?.attachments?.[0];
      const serialized = JSON.stringify(context);

      expect(attachment).toMatchObject({
        filename: "batch-job.png",
        extractionStatus: "text_extracted",
        contentRef: expect.stringMatching(/^jira-attachment:att-png:sha256:/),
      });
      expect(attachment?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(attachment?.textExcerpt).toContain("CenteneLetterTemplateBatch");
      expect(attachment?.textExcerpt).toContain("/opt/software/medhok/jobs/letters.sh");
      expect(context?.extractedTerms).toContain("CenteneLetterTemplateBatch");
      expect(serialized).not.toContain("https://jira.example.com/rest/api/3/attachment/content/att-png");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("skips screenshot OCR text when PHI-like content is detected", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "jira-ocr-test-"));
    const ocrScriptPath = path.join(tempDir, "ocr-fixture.cjs");
    await writeFile(
      ocrScriptPath,
      "process.stdout.write('Skybot Job: CenteneLetterTemplateBatch\\nMember ID: 12345678901\\nPatient DOB: 1970-01-01\\n');\n",
    );
    vi.stubEnv("INVESTIGATION_JIRA_IMAGE_OCR_ENABLED", "true");
    vi.stubEnv("INVESTIGATION_JIRA_IMAGE_OCR_COMMAND", process.execPath);
    vi.stubEnv("INVESTIGATION_JIRA_IMAGE_OCR_ARGS", `${ocrScriptPath} {input}`);

    try {
      const fetchMock = vi.fn(async (url: string) => {
        if (url === "https://jira.example.com/rest/api/3/attachment/content/att-phi-png") {
          return new Response(new Uint8Array([137, 80, 78, 71]), {
            status: 200,
            headers: { "Content-Type": "image/png" },
          });
        }
        if (url.includes("/comment?")) {
          return new Response(JSON.stringify({
            startAt: 0,
            maxResults: 100,
            total: 0,
            comments: [],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({
          key: "CPSUP-50343",
          id: "50343",
          self: "https://jira.example.com/rest/api/3/issue/50343",
          fields: {
            summary: "Centene batch job screenshot",
            status: { name: "Open" },
            created: "2026-06-09T13:17:10.952-0400",
            updated: "2026-06-25T15:05:04.840-0400",
            description: adf("Review screenshot for job name."),
            attachment: [
              {
                id: "att-phi-png",
                filename: "batch-job-with-phi.png",
                mimeType: "image/png",
                size: 4,
                content: "https://jira.example.com/rest/api/3/attachment/content/att-phi-png",
                created: "2026-06-09T13:17:12.465-0400",
              },
            ],
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      });
      vi.stubGlobal("fetch", fetchMock);

      const context = await fetchInvestigationJiraContext("CPSUP-50343");
      const attachment = context?.attachments?.[0];
      const serialized = JSON.stringify(context);

      expect(attachment).toMatchObject({
        filename: "batch-job-with-phi.png",
        extractionStatus: "skipped",
        contentRef: expect.stringMatching(/^jira-attachment:att-phi-png:sha256:/),
      });
      expect(attachment?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(attachment?.textExcerpt).toBeUndefined();
      expect(attachment?.extractedTerms).toBeUndefined();
      expect(context?.extractedTerms).not.toContain("CenteneLetterTemplateBatch");
      expect(serialized).not.toContain("Member ID");
      expect(serialized).not.toContain("12345678901");
      expect(serialized).not.toContain("1970-01-01");
      expect(serialized).not.toContain("https://jira.example.com/rest/api/3/attachment/content/att-phi-png");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("downloads supported text attachments with redaction, truncation, hashes, and no raw content URL persistence", async () => {
    vi.stubEnv("INVESTIGATION_JIRA_ATTACHMENT_TEXT_MAX_CHARS", "1000");
    const longAttachmentText = [
      "Case Number:",
      "5555511111",
      "SqlGenerationAdapter failed with memberId=abc123 password=plain-text",
      "x".repeat(1400),
    ].join("\n");
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://jira.example.com/rest/api/3/attachment/content/att-log") {
        return new Response(longAttachmentText, { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      if (url.includes("/comment?")) {
        return new Response(JSON.stringify({
          startAt: 0,
          maxResults: 100,
          total: 0,
          comments: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        key: "CPSUP-48576",
        id: "48576",
        self: "https://jira.example.com/rest/api/3/issue/48576",
        fields: {
          summary: "Attachment extraction investigation",
          status: { name: "Open" },
          created: "2026-05-26T09:30:00.000-0400",
          updated: "2026-05-26T14:10:00.000-0400",
          description: adf("Review attached log."),
          attachment: [
            {
              id: "att-log",
              filename: "cockpit-context.log",
              mimeType: "text/plain",
              size: 600,
              content: "https://jira.example.com/rest/api/3/attachment/content/att-log",
              created: "2026-05-26T14:00:00.000-0400",
            },
          ],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const context = await fetchInvestigationJiraContext("CPSUP-48576");
    const attachment = context?.attachments?.[0];

    expect(attachment).toMatchObject({
      filename: "cockpit-context.log",
      extractionStatus: "text_extracted",
      contentRef: expect.stringMatching(/^jira-attachment:att-log:sha256:/),
    });
    expect(attachment?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(attachment?.textExcerpt).toContain("memberId=[REDACTED]");
    expect(attachment?.textExcerpt).toContain("password=[REDACTED]");
    expect(attachment?.textExcerpt).toContain("[TRUNCATED]");
    expect(attachment?.textExcerpt).not.toContain("abc123");
    expect(context?.identifiers).toContainEqual({ kind: "case_number", source: "attachment", value: "5555511111", sensitive: true });
    expect(context?.extractedTerms).toContain("SqlGenerationAdapter");
    expect(JSON.stringify(context)).not.toContain("https://jira.example.com/rest/api/3/attachment/content/att-log");
    expect(JSON.stringify(context)).not.toContain("plain-text");
  });

  it("does not text-extract Office workbook attachments whose MIME contains openxml", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://jira.example.com/rest/api/3/attachment/content/att-xlsx") {
        return new Response("PK\u0003\u0004raw workbook bytes", {
          status: 200,
          headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        });
      }
      if (url.includes("/comment?")) {
        return new Response(JSON.stringify({
          startAt: 0,
          maxResults: 100,
          total: 0,
          comments: [],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        key: "CPSUP-50343",
        id: "50343",
        self: "https://jira.example.com/rest/api/3/issue/50343",
        fields: {
          summary: "Workbook attachment investigation",
          status: { name: "Open" },
          created: "2026-06-09T13:17:10.952-0400",
          updated: "2026-06-25T15:05:04.840-0400",
          description: adf("Review spreadsheet attachment.\nCase #: 26146476701"),
          attachment: [
            {
              id: "att-xlsx",
              filename: "10722.xlsx",
              mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              size: 21331,
              content: "https://jira.example.com/rest/api/3/attachment/content/att-xlsx",
              created: "2026-06-09T13:17:12.465-0400",
            },
          ],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const context = await fetchInvestigationJiraContext("CPSUP-50343");
    const attachment = context?.attachments?.[0];

    expect(attachment).toMatchObject({
      filename: "10722.xlsx",
      extractionStatus: "metadata_only",
    });
    expect(attachment?.textExcerpt).toBeUndefined();
    expect(attachment?.sha256).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "https://jira.example.com/rest/api/3/attachment/content/att-xlsx",
      expect.anything(),
    );
    expect(JSON.stringify(context)).not.toContain("PK\u0003\u0004");
    expect(JSON.stringify(context)).not.toContain("https://jira.example.com/rest/api/3/attachment/content/att-xlsx");
  });

  it("returns unavailable without fetching when Jira context credentials are missing", async () => {
    delete process.env.JIRA_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(isInvestigationJiraContextConfigured()).toBe(false);
    await expect(fetchInvestigationJiraContext("CPSUP-48576")).resolves.toMatchObject({
      source: "jira",
      jiraKey: "CPSUP-48576",
      fetchStatus: "unavailable",
      failureReason: "Jira ticket context is not configured: JIRA_TOKEN missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an unavailable context without leaking secret-like values", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("password=bad-token", { status: 401, statusText: "Unauthorized" }),
    ));

    const context = await fetchInvestigationJiraContext("CPSUP-48576");

    expect(context).toMatchObject({
      source: "jira",
      jiraKey: "CPSUP-48576",
      fetchStatus: "unavailable",
    });
    expect(context?.failureReason).toContain("401 Unauthorized");
    expect(context?.failureReason).not.toContain("bad-token");
  });

  it("extracts case-number identifiers without treating member identifiers as case scope", () => {
    expect(extractCaseIdentifiersFromTicketText([
      "Case Number:",
      "22345678901, 22345678902",
      "Member ID #",
      "88776655443",
    ].join("\n"), "description")).toEqual([
      { kind: "case_number", source: "description", value: "22345678901", sensitive: true },
      { kind: "case_number", source: "description", value: "22345678902", sensitive: true },
    ]);
  });

  it("extracts labeled member identifiers with optional person suffixes", () => {
    expect(extractMemberIdentifiersFromTicketText([
      "Affected member(s):",
      "M120034567/01, M120034568/02",
      "Reported member: M120034569/03",
      "Case Number: 22345678901",
    ].join("\n"), "description")).toEqual([
      { kind: "member_identifier", source: "description", value: "M120034567/01", sensitive: true },
      { kind: "member_identifier", source: "description", value: "M120034568/02", sensitive: true },
      { kind: "member_identifier", source: "description", value: "M120034569/03", sensitive: true },
    ]);
  });

  it("extracts a member identifier when name and DOB precede the ID on one line", () => {
    expect(extractMemberIdentifiersFromTicketText(
      "Member Example Person dob 01/02/2000 ID M120034572/06 Case 12345",
      "description",
    )).toEqual([
      { kind: "member_identifier", source: "description", value: "M120034572/06", sensitive: true },
    ]);
  });

  it("extracts member identifiers from structured JSON fields", () => {
    expect(extractMemberIdentifiersFromJson(JSON.stringify({
      memberEligibility: [{ memberId: "M120034570", subscriberId: "M120034570/04" }],
      unrelated: { transactionId: "T998877" },
    }), "attachment")).toEqual([
      { kind: "member_identifier", source: "attachment", value: "M120034570", sensitive: true },
      { kind: "member_identifier", source: "attachment", value: "M120034570/04", sensitive: true },
    ]);
  });

  it("uses a standalone attachment basename as a member identifier", () => {
    expect(extractMemberIdentifierFromAttachmentFilename("M120034571-05.json")).toEqual([
      { kind: "member_identifier", source: "attachment", value: "M120034571-05", sensitive: true },
    ]);
    expect(extractMemberIdentifierFromAttachmentFilename("member-response.json")).toEqual([]);
  });
});
