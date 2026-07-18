import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getTrustedOperatorIdentityMock,
  getOneShotRowByDashboardIdMock,
  retryOneShotRunStageMock,
  OperatorIdentityErrorMock,
  OneShotRunRetryErrorMock,
} = vi.hoisted(() => {
  class OperatorIdentityError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "OperatorIdentityError";
      this.statusCode = statusCode;
    }
  }

  class OneShotRunRetryError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "OneShotRunRetryError";
      this.statusCode = statusCode;
    }
  }

  return {
    getTrustedOperatorIdentityMock: vi.fn(),
    getOneShotRowByDashboardIdMock: vi.fn(),
    retryOneShotRunStageMock: vi.fn(),
    OperatorIdentityErrorMock: OperatorIdentityError,
    OneShotRunRetryErrorMock: OneShotRunRetryError,
  };
});

vi.mock("../auth/operatorIdentity.js", () => ({
  getTrustedOperatorIdentity: getTrustedOperatorIdentityMock,
  hasTrustedOperatorIdentity: vi.fn(() => true),
  OperatorIdentityError: OperatorIdentityErrorMock,
}));

vi.mock("../services/oneshot.js", () => ({
  getOneShotRuns: vi.fn(),
  getOneShotRowByDashboardId: getOneShotRowByDashboardIdMock,
}));

vi.mock("../services/oneshotRunRetries.js", () => ({
  retryOneShotRunStage: retryOneShotRunStageMock,
  OneShotRunRetryError: OneShotRunRetryErrorMock,
}));

vi.mock("../services/oneshotAnalytics.js", () => ({
  normalizeOneShotAnalyticsRange: vi.fn(() => "24h"),
}));
vi.mock("../services/oneshotDeployments.js", () => ({
  isOneShotDeploymentRequestSupported: vi.fn(),
}));
vi.mock("../services/oneshotMockData.js", () => ({
  createMockRun: vi.fn(),
  getMockData: vi.fn(),
  getMockRow: vi.fn(),
}));
vi.mock("../services/oneshotRunRequests.js", () => ({
  isOneShotRunRequestSupported: vi.fn(),
  isQualifierAgentAvailable: vi.fn(),
}));
vi.mock("../services/oneshotJiraLookup.js", () => ({
  isOneShotJiraValidationConfigured: vi.fn(),
}));
vi.mock("../services/oneshotRowHelpers.js", () => ({
  bucketForView: vi.fn(),
}));
vi.mock("../services/oneshotTimeline.js", () => ({
  buildFallbackTimeline: vi.fn(),
  getOneShotRunTimeline: vi.fn(),
}));

async function loadModule() {
  vi.resetModules();
  return import("./oneshot.js");
}

function createResponseRecorder() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader: vi.fn(),
  };

  return response;
}

describe("oneshot retry route", () => {
  beforeEach(() => {
    getTrustedOperatorIdentityMock.mockReset();
    getOneShotRowByDashboardIdMock.mockReset();
    retryOneShotRunStageMock.mockReset();
  });

  it("requires trusted operator identity headers", async () => {
    getTrustedOperatorIdentityMock.mockImplementation(() => {
      throw new OperatorIdentityErrorMock(
        "Trusted operator identity headers are missing",
        403,
      );
    });

    const { postOneShotRunRetry } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunRetry(
      {
        params: { dashboardId: "run-86" },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      error: "Trusted operator identity headers are missing",
    });
    expect(retryOneShotRunStageMock).not.toHaveBeenCalled();
  });

  it("returns 409 service errors", async () => {
    getTrustedOperatorIdentityMock.mockReturnValue({
      id: "rmadhukar",
      display: "R Madhukar",
    });
    retryOneShotRunStageMock.mockRejectedValue(
      new OneShotRunRetryErrorMock("Retry limit reached for implementation.", 409),
    );

    const { postOneShotRunRetry } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunRetry(
      {
        params: { dashboardId: "run-86" },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: "Retry limit reached for implementation.",
    });
  });

  it("returns the updated row and publish warning on success", async () => {
    const row = {
      dashboardId: "run-86",
      displayState: "queued_for_implementation",
    };
    getTrustedOperatorIdentityMock.mockReturnValue({
      id: "rmadhukar",
      display: "R Madhukar",
    });
    retryOneShotRunStageMock.mockResolvedValue({
      oneshotRunId: 86,
      stage: "implementation",
      state: "queued_for_implementation",
      version: 2,
      attemptsUsed: 1,
      attemptsRemaining: 1,
      publishError: "sqs unavailable",
    });
    getOneShotRowByDashboardIdMock.mockResolvedValue(row);

    const { postOneShotRunRetry } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunRetry(
      {
        params: { dashboardId: "run-86" },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      row,
      retry: {
        oneshotRunId: 86,
        stage: "implementation",
        state: "queued_for_implementation",
        version: 2,
        attemptsUsed: 1,
        attemptsRemaining: 1,
        publishError: "sqs unavailable",
      },
      publishError: "sqs unavailable",
    });
    expect(retryOneShotRunStageMock).toHaveBeenCalledWith({
      dashboardId: "run-86",
      operator: {
        id: "rmadhukar",
        display: "R Madhukar",
      },
    });
  });
});
