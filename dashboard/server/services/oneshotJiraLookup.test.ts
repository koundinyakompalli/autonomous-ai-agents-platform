import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOneShotJiraValidationConfigured,
  validateOneShotRunRequestJiraKey,
} from "./oneshotJiraLookup.js";

const queryMock = vi.fn();

vi.mock("../db.js", () => ({
  getPool: () => ({
    query: queryMock,
  }),
}));

const originalEnv = { ...process.env };
const CLIENT_ASSETS_EXPAND =
  "names,customfield_10769.cmdb.label,customfield_10769.cmdb.attributes";

describe("validateOneShotRunRequestJiraKey", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      JIRA_BASE_URL: "https://jira.example.com",
      JIRA_USERNAME: "jira-user@example.com",
      JIRA_TOKEN: "jira-token",
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    queryMock.mockRejectedValue(new Error("policy store should not be queried by dashboard validation"));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    queryMock.mockReset();
  });

  it("returns the normalized Jira key, title, and status for an existing ticket", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          fields: {
            summary: "Fix the run queue",
            description: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Queue fails on runtime service." }] }],
            },
            comment: {
              comments: [
                {
                  body: {
                    type: "doc",
                    content: [{ type: "paragraph", content: [{ type: "text", text: "Operator saw HTTP 500." }] }],
                  },
                },
              ],
            },
            status: { name: "In Progress" },
            labels: ["Client:Wellcare", "prod-replica"],
            fixVersions: [{ name: "3.19" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateOneShotRunRequestJiraKey({ jiraKey: "cpdev-123" }),
    ).resolves.toEqual({
      jiraKey: "CPDEV-123",
      title: "Fix the run queue",
      statusName: "In Progress",
      labels: ["Client:Wellcare", "prod-replica"],
      clientName: "Wellcare",
      environment: "PROD-REPLICA",
      codeVersion: "3.19",
      descriptionText: "Queue fails on runtime service.",
      commentText: "Operator saw HTTP 500.",
    });

    const [url, request] = fetchMock.mock.calls[0];
    const parsedUrl = new URL(String(url));
    expect(parsedUrl.searchParams.get("expand")).toBe(CLIENT_ASSETS_EXPAND);
    expect(parsedUrl.searchParams.get("fields")).toBe("*all");
    expect(request).toEqual(
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: expect.stringMatching(/^Basic /),
        }),
      }),
    );
  });

  it("extracts plain PROD from Jira environment fields and ticket text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          fields: {
            summary: "ACME PROD | Extract correction",
            description: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Environment: PROD" }] }],
            },
            status: { name: "Waiting for support" },
            labels: [],
            environment: "PROD",
            customfield_10047: { value: "ACME CP" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateOneShotRunRequestJiraKey({ jiraKey: "cpsup-55574" }),
    ).resolves.toMatchObject({
      jiraKey: "CPSUP-55574",
      title: "ACME PROD | Extract correction",
      statusName: "Waiting for support",
      clientName: "ACME CP",
      environment: "PROD",
      descriptionText: "Environment: PROD",
    });
  });

  it("supports the local JIRA_USER alias and default Jira base URL", async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_USERNAME;
    process.env.JIRA_USER = "local-jira-user@example.com";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          fields: {
            summary: "Local env Jira lookup",
            status: { name: "Open" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateOneShotRunRequestJiraKey({ jiraKey: "cpclient-55570" }),
    ).resolves.toMatchObject({
      jiraKey: "CPCLIENT-55570",
      title: "Local env Jira lookup",
      statusName: "Open",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://mhkjira.atlassian.net/rest/api/3/issue/CPCLIENT-55570"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringMatching(/^Basic /),
        }),
      }),
    );
  });

  it("rejects malformed Jira keys before reaching Jira", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateOneShotRunRequestJiraKey({ jiraKey: "not-a-ticket" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "jiraKey must look like ABC-123",
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 when Jira does not have the ticket", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 })),
    );

    await expect(
      validateOneShotRunRequestJiraKey({ jiraKey: "CPDEV-404" }),
    ).rejects.toMatchObject({
      statusCode: 404,
      message: "Jira issue CPDEV-404 not found",
    });
  });

  it("returns 503 when dashboard Jira validation is not configured", async () => {
    delete process.env.JIRA_TOKEN;

    expect(isOneShotJiraValidationConfigured()).toBe(false);
    await expect(
      validateOneShotRunRequestJiraKey({ jiraKey: "CPDEV-123" }),
    ).rejects.toMatchObject({
      statusCode: 503,
      message:
        "OneShot Jira validation is not configured: JIRA_TOKEN is missing",
    });
  });

  it("returns 502 when Jira returns a non-404 upstream failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
      ),
    );

    await expect(
      validateOneShotRunRequestJiraKey({ jiraKey: "CPDEV-401" }),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: "Failed to validate Jira issue CPDEV-401",
    });
  });

  it("returns Jira metadata for blocked-client-shaped tickets without querying policy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          fields: {
            summary: "Add member search filter",
            status: { name: "In Progress" },
            labels: [],
            customfield_10002: "Blocked Corp",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateOneShotRunRequestJiraKey({ jiraKey: "CPDEV-500" }),
    ).resolves.toMatchObject({
      jiraKey: "CPDEV-500",
      clientName: "Blocked Corp",
    });

    expect(queryMock).not.toHaveBeenCalled();
  });

  it("does not depend on blocked-client policy availability during dashboard validation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          fields: {
            summary: "Add member search filter",
            status: { name: "In Progress" },
            labels: [],
            Client: "Blocked Corp",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    queryMock.mockRejectedValueOnce(
      Object.assign(new Error("No table"), { code: "ER_NO_SUCH_TABLE" }),
    );

    await expect(
      validateOneShotRunRequestJiraKey({ jiraKey: "CPDEV-501" }),
    ).resolves.toMatchObject({
      jiraKey: "CPDEV-501",
      clientName: "Blocked Corp",
    });

    expect(queryMock).not.toHaveBeenCalled();
  });

  it("extracts allowed clients without checking the blocked list", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          fields: {
            summary: "Add member search filter",
            status: { name: "In Progress" },
            labels: [],
            customfield_10002: "Allowed Client",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateOneShotRunRequestJiraKey({ jiraKey: "CPDEV-600" }),
    ).resolves.toMatchObject({
      jiraKey: "CPDEV-600",
      clientName: "Allowed Client",
    });

    expect(queryMock).not.toHaveBeenCalled();
  });

  it("extracts client from Jira names-expanded custom fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          names: {
            customfield_12345: "Client",
          },
          fields: {
            summary: "Add member search filter",
            status: { name: "In Progress" },
            labels: [],
            customfield_12345: { value: "Named Client" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateOneShotRunRequestJiraKey({ jiraKey: "CPDEV-601" }),
    ).resolves.toMatchObject({
      jiraKey: "CPDEV-601",
      clientName: "Named Client",
    });

    expect(queryMock).not.toHaveBeenCalled();
  });

  it("uses Jira Assets Client before legacy Customer fields for dashboard metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          names: {
            customfield_10769: "Client",
            customfield_10047: "Customer",
            customfield_10100: "Solution/Feature",
          },
          fields: {
            summary: "Update Compounds from NDC 0000000000 to NDC 9999999999",
            status: { name: "Done" },
            labels: ["PFOS"],
            customfield_10769: [
              {
                label: "Centene CP",
                objectKey: "CA-39933",
                attributes: [
                  {
                    objectTypeAttribute: { name: "Preferred Name" },
                    objectAttributeValues: [
                      { value: "Centene CP", displayValue: "Centene CP" },
                    ],
                  },
                ],
              },
            ],
            customfield_10047: [{ value: "Centene (WellCare) CP" }],
            customfield_10100: [{ value: "RX - Pharmacy" }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateOneShotRunRequestJiraKey({ jiraKey: "CPDEV-23724" }),
    ).resolves.toMatchObject({
      jiraKey: "CPDEV-23724",
      clientName: "Centene CP",
    });

    expect(queryMock).not.toHaveBeenCalled();
  });

  it("passes through without checking blocked list when no client can be extracted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          fields: {
            summary: "Generic ticket with no client",
            status: { name: "Open" },
            labels: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      validateOneShotRunRequestJiraKey({ jiraKey: "CPDEV-700" }),
    ).resolves.toMatchObject({
      jiraKey: "CPDEV-700",
      clientName: null,
    });

    // The blocked-client query should NOT be called when no client is extracted
    expect(queryMock).not.toHaveBeenCalled();
  });
});
