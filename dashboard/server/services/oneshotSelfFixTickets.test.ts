import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OneShotStatisticsResponse } from "../types/oneshot.js";

const {
  createOneShotRunRequestMock,
  ensureSelfFixTicketTableExistsMock,
  findActiveSelfFixTicketByCandidateKeyMock,
  getOneShotStatisticsMock,
  insertSelfFixTicketMock,
  updateSelfFixTicketRunRequestMock,
} = vi.hoisted(() => ({
  createOneShotRunRequestMock: vi.fn(),
  ensureSelfFixTicketTableExistsMock: vi.fn(),
  findActiveSelfFixTicketByCandidateKeyMock: vi.fn(),
  getOneShotStatisticsMock: vi.fn(),
  insertSelfFixTicketMock: vi.fn(),
  updateSelfFixTicketRunRequestMock: vi.fn(),
}));

vi.mock("./oneshotRunRequests.js", () => ({
  createOneShotRunRequest: createOneShotRunRequestMock,
}));

vi.mock("./oneshotStatistics.js", () => ({
  getOneShotStatistics: getOneShotStatisticsMock,
}));

vi.mock("./oneshotSelfFixTicketStore.js", () => ({
  ensureSelfFixTicketTableExists: ensureSelfFixTicketTableExistsMock,
  findActiveSelfFixTicketByCandidateKey:
    findActiveSelfFixTicketByCandidateKeyMock,
  insertSelfFixTicket: insertSelfFixTicketMock,
  updateSelfFixTicketRunRequest: updateSelfFixTicketRunRequestMock,
  OneShotSelfFixTicketStoreError: class OneShotSelfFixTicketStoreError extends Error {
    constructor(
      message: string,
      readonly statusCode = 500,
    ) {
      super(message);
    }
  },
}));

const ORIGINAL_ENV = { ...process.env };

function statistics(): OneShotStatisticsResponse {
  return {
    selfFixCandidates: [
      {
        id: "oneshot-self-fix-agent_logic-oneshot",
        category: "agent_logic",
        attribution: "oneshot",
        sampleSize: 5,
        significant: true,
        wilson95: { low: 0, high: 0.43 },
        passRateBaseline: 0.57,
        range: "7d",
        examples: [
          {
            jiraKey: "CPDEV-1",
            dashboardId: "run-1",
            title: "example",
            jiraUrl: null,
          },
        ],
        status: "eligible",
      },
    ],
    selfFixConfig: {
      minSampleSize: 5,
      autoCreateEnabled: false,
      autoRunEnabled: false,
      targetEpicKey: "CPDEV-23232",
      targetRepo: "mhk-repos/cp-autonomous-ai-agents-platform",
      targetBranch: "main",
    },
    modelInfo: {
      dataFingerprint: "abc123abc123abc123abc123abc123abc123abc1",
    },
  } as OneShotStatisticsResponse;
}

async function loadModule() {
  return import("./oneshotSelfFixTickets.js");
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.JIRA_BASE_URL = "https://jira.example.com";
  process.env.JIRA_USERNAME = "jira-user";
  process.env.JIRA_TOKEN = "jira-token";
  vi.stubGlobal("fetch", vi.fn());
  createOneShotRunRequestMock.mockReset();
  ensureSelfFixTicketTableExistsMock.mockReset();
  findActiveSelfFixTicketByCandidateKeyMock.mockReset();
  getOneShotStatisticsMock.mockReset();
  insertSelfFixTicketMock.mockReset();
  updateSelfFixTicketRunRequestMock.mockReset();
  ensureSelfFixTicketTableExistsMock.mockResolvedValue(undefined);
  findActiveSelfFixTicketByCandidateKeyMock.mockResolvedValue(null);
  getOneShotStatisticsMock.mockResolvedValue(statistics());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env = { ...ORIGINAL_ENV };
});

describe("createOneShotSelfFixTicket", () => {
  it("creates a CPDEV Defect using the OneShot ticket format", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ issues: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ key: "CPDEV-300" }), { status: 201 }),
      );
    const { createOneShotSelfFixTicket } = await loadModule();

    const result = await createOneShotSelfFixTicket({
      range: "7d",
      candidateId: "oneshot-self-fix-agent_logic-oneshot",
    });

    expect(result).toMatchObject({
      candidateId: "oneshot-self-fix-agent_logic-oneshot",
      ticketKey: "CPDEV-300",
      jiraUrl: "https://jira.example.com/browse/CPDEV-300",
      status: "ticket_created",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const createBody = JSON.parse(
      String(fetchMock.mock.calls[1][1]?.body),
    ) as {
      fields: {
        issuetype: { name: string };
        parent: { key: string };
        labels: string[];
        description: { content: Array<{ content: Array<{ text: string }> }> };
      };
    };
    expect(createBody.fields.issuetype.name).toBe("Defect");
    expect(createBody.fields.parent.key).toBe("CPDEV-23232");
    expect(createBody.fields.labels).toEqual(
      expect.arrayContaining([
        "PFOS",
        "oneshot-self-fix",
        "oneshot-statistics",
        "auto-fix",
      ]),
    );
    const description = JSON.stringify(createBody.fields.description);
    for (const section of [
      "Summary",
      "Overview",
      "Acceptance Criteria",
      "Technical Details",
      "Out of Scope",
      "Testing Notes",
      "Repo: mhk-repos/cp-autonomous-ai-agents-platform",
      "Target Branch: main",
    ]) {
      expect(description).toContain(section);
    }
    expect(insertSelfFixTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jiraKey: "CPDEV-300",
        status: "ticket_created",
      }),
    );
  });

  it("returns an existing active mapping and can enqueue a run", async () => {
    findActiveSelfFixTicketByCandidateKeyMock.mockResolvedValue({
      candidate_key: "oneshot-self-fix-agent_logic-oneshot",
      jira_key: "CPDEV-301",
      jira_url: "https://jira.example.com/browse/CPDEV-301",
      run_request_id: null,
      status: "ticket_created",
    });
    createOneShotRunRequestMock.mockResolvedValue({
      id: 44,
      jiraKey: "CPDEV-301",
    });
    const { createOneShotSelfFixTicket } = await loadModule();

    const result = await createOneShotSelfFixTicket({
      range: "7d",
      candidateId: "oneshot-self-fix-agent_logic-oneshot",
      autoRun: true,
    });

    expect(result).toMatchObject({
      ticketKey: "CPDEV-301",
      runRequestId: 44,
      status: "run_requested",
    });
    expect(createOneShotRunRequestMock).toHaveBeenCalledWith({
      jiraKey: "CPDEV-301",
      operator: {
        id: "oneshot-statistics",
        display: "OneShot Statistics",
      },
    });
    expect(updateSelfFixTicketRunRequestMock).toHaveBeenCalledWith({
      candidateKey: "oneshot-self-fix-agent_logic-oneshot",
      runRequestId: 44,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("records an open duplicate instead of creating another Jira defect", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          issues: [
            {
              key: "CPDEV-302",
              fields: {
                description: "oneshot-self-fix-agent_logic-oneshot",
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const { createOneShotSelfFixTicket } = await loadModule();

    const result = await createOneShotSelfFixTicket({
      range: "7d",
      candidateId: "oneshot-self-fix-agent_logic-oneshot",
    });

    expect(result).toMatchObject({
      ticketKey: "CPDEV-302",
      status: "duplicate",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(insertSelfFixTicketMock).toHaveBeenCalledWith(
      expect.objectContaining({
        jiraKey: "CPDEV-302",
        status: "duplicate",
      }),
    );
  });

  it("does not create Jira defects when mutation guard is enabled", async () => {
    process.env.ONESHOT_DISABLE_JIRA_MUTATIONS = "true";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ issues: [] }), { status: 200 }),
    );
    const { createOneShotSelfFixTicket } = await loadModule();

    await expect(
      createOneShotSelfFixTicket({
        range: "7d",
        candidateId: "oneshot-self-fix-agent_logic-oneshot",
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      message: "OneShot self-fix Jira mutations are disabled",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(insertSelfFixTicketMock).not.toHaveBeenCalled();
  });
});
