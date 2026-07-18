import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { extractRawTextMock } = vi.hoisted(() => ({
  extractRawTextMock: vi.fn(),
}));

vi.mock("mammoth", () => ({
  default: {
    extractRawText: extractRawTextMock,
  },
}));

import { JiraClient } from "./JiraClient.js";

describe("JiraClient", () => {
  beforeEach(() => {
    extractRawTextMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("preserves Jira attachment id when DOCX extraction fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.from("not really a docx"), {
        status: 200,
      }),
    );
    extractRawTextMock.mockRejectedValue(new Error("corrupt docx"));

    const client = new JiraClient({
      baseUrl: "https://jira.example.test",
      username: "oneshot@example.test",
      token: "token",
    });

    const result = await client.fetchDocxAttachmentEvidence([
      {
        id: "att-7",
        filename: "requirements.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 128,
        content: "/secure/attachment/7",
      },
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        id: "att-7",
        filename: "requirements.docx",
        extractionStatus: "failed",
        warning: expect.stringContaining("DOCX extraction failed: corrupt docx"),
      }),
    ]);
  });

  it("extracts supported DOCX attachments", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.from("fake docx bytes"), {
        status: 200,
      }),
    );
    extractRawTextMock.mockResolvedValue({
      value: "DOCX requirement text",
      messages: [{ message: "minor style warning" }],
    });

    const client = new JiraClient({
      baseUrl: "https://jira.example.test",
      username: "oneshot@example.test",
      token: "token",
    });

    const result = await client.fetchDocxAttachmentEvidence([
      {
        id: "att-8",
        filename: "requirements.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 128,
        content: "/secure/attachment/8",
      },
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        id: "att-8",
        filename: "requirements.docx",
        extractionStatus: "included",
        content: "DOCX requirement text",
        warning: "minor style warning",
      }),
    ]);
  });

  it("reports DOCX attachments that cannot be reviewed", async () => {
    const client = new JiraClient({
      baseUrl: "https://jira.example.test",
      username: "oneshot@example.test",
      token: "token",
      maxAttachmentBytes: 100,
    });

    const result = await client.fetchDocxAttachmentEvidence([
      {
        id: "att-large",
        filename: "large.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 101,
        content: "/secure/attachment/large",
      },
      {
        id: "att-missing",
        filename: "missing-url.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 99,
      },
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        id: "att-large",
        filename: "large.docx",
        extractionStatus: "failed",
        warning: "DOCX attachment exceeds 100 byte extraction limit",
      }),
      expect.objectContaining({
        id: "att-missing",
        filename: "missing-url.docx",
        extractionStatus: "failed",
        warning: "DOCX attachment has no download URL",
      }),
    ]);
  });

  it("does not download Office binaries as generic XML text attachments", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const client = new JiraClient({
      baseUrl: "https://jira.example.test",
      username: "oneshot@example.test",
      token: "token",
    });

    const result = await client.fetchTextAttachments([
      {
        id: "xlsx-1",
        filename: "report.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 128,
        content: "/secure/attachment/xlsx",
      },
      {
        id: "xls-1",
        filename: "legacy.xls",
        mimeType: "application/vnd.ms-excel",
        size: 128,
        content: "/secure/attachment/xls",
      },
      {
        id: "docx-1",
        filename: "requirements.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 128,
        content: "/secure/attachment/docx",
      },
    ]);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("continues to download supported text attachments", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("a,b\n1,2", {
        status: 200,
      }),
    );
    const client = new JiraClient({
      baseUrl: "https://jira.example.test",
      username: "oneshot@example.test",
      token: "token",
    });

    await expect(
      client.fetchTextAttachments([
        {
          id: "csv-1",
          filename: "reviewed.csv",
          mimeType: "text/csv",
          size: 7,
          content: "/secure/attachment/csv",
        },
      ]),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "csv-1",
        filename: "reviewed.csv",
        content: "a,b\n1,2",
      }),
    ]);
  });

  it("returns skipped instead of pretending to attach when Jira mutations are disabled", async () => {
    vi.stubEnv("ONESHOT_DISABLE_JIRA_MUTATIONS", "true");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const client = new JiraClient({
      baseUrl: "https://jira.example.test",
      username: "oneshot@example.test",
      token: "token",
    });

    await expect(
      client.attachFileToIssue(
        "CPDEV-1",
        "implementation-plan-CPDEV-1.md",
        "# plan",
        "text/markdown",
      ),
    ).resolves.toEqual({
      status: "skipped",
      reason: "mutations_disabled",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
