import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getTrustedOperatorIdentityMock,
  getOneShotRowByDashboardIdMock,
  hardDeleteOneShotRunMock,
  restartOneShotRunStageMock,
  stopOneShotRunMock,
  OperatorIdentityErrorMock,
  OneShotRunControlErrorMock,
} = vi.hoisted(() => {
  class OperatorIdentityError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "OperatorIdentityError";
      this.statusCode = statusCode;
    }
  }

  class OneShotRunControlError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "OneShotRunControlError";
      this.statusCode = statusCode;
    }
  }

  return {
    getTrustedOperatorIdentityMock: vi.fn(),
    getOneShotRowByDashboardIdMock: vi.fn(),
    hardDeleteOneShotRunMock: vi.fn(),
    restartOneShotRunStageMock: vi.fn(),
    stopOneShotRunMock: vi.fn(),
    OperatorIdentityErrorMock: OperatorIdentityError,
    OneShotRunControlErrorMock: OneShotRunControlError,
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

vi.mock("../services/oneshotRunControls.js", () => ({
  hardDeleteOneShotRun: hardDeleteOneShotRunMock,
  restartOneShotRunStage: restartOneShotRunStageMock,
  stopOneShotRun: stopOneShotRunMock,
  OneShotRunControlError: OneShotRunControlErrorMock,
}));

vi.mock("../services/oneshotRunRetries.js", () => ({
  retryOneShotRunStage: vi.fn(),
  OneShotRunRetryError: class OneShotRunRetryError extends Error {
    readonly statusCode = 409;
  },
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

const operator = {
  id: "rmadhukar",
  display: "R Madhukar",
};

describe("oneshot run controls routes", () => {
  beforeEach(() => {
    getTrustedOperatorIdentityMock.mockReset();
    getOneShotRowByDashboardIdMock.mockReset();
    hardDeleteOneShotRunMock.mockReset();
    restartOneShotRunStageMock.mockReset();
    stopOneShotRunMock.mockReset();
  });

  it("stops a run and returns the refreshed row", async () => {
    const row = { dashboardId: "run-86", displayState: "failed" };
    getTrustedOperatorIdentityMock.mockReturnValue(operator);
    stopOneShotRunMock.mockResolvedValue({
      oneshotRunId: 86,
      workspaceCleanupSucceeded: true,
    });
    getOneShotRowByDashboardIdMock.mockResolvedValue(row);

    const { postOneShotRunStop } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunStop(
      {
        params: { dashboardId: "run-86" },
        body: { reason: "free slot" },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      row,
      stop: {
        oneshotRunId: 86,
        workspaceCleanupSucceeded: true,
      },
      workspaceCleanupSucceeded: true,
    });
    expect(stopOneShotRunMock).toHaveBeenCalledWith({
      dashboardId: "run-86",
      operator,
      reason: "free slot",
    });
  });

  it("restarts a selected stage and returns publish warnings", async () => {
    const row = {
      dashboardId: "run-86",
      displayState: "queued_for_implementation",
    };
    getTrustedOperatorIdentityMock.mockReturnValue(operator);
    restartOneShotRunStageMock.mockResolvedValue({
      oneshotRunId: 86,
      stage: "implementation",
      state: "queued_for_implementation",
      version: 3,
      publishError: "sqs unavailable",
    });
    getOneShotRowByDashboardIdMock.mockResolvedValue(row);

    const { postOneShotRunRestartStage } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunRestartStage(
      {
        params: { dashboardId: "run-86" },
        body: { stage: "implementation", reason: "timeout retry" },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      row,
      restart: {
        oneshotRunId: 86,
        stage: "implementation",
        state: "queued_for_implementation",
        version: 3,
        publishError: "sqs unavailable",
      },
      publishError: "sqs unavailable",
    });
    expect(restartOneShotRunStageMock).toHaveBeenCalledWith({
      dashboardId: "run-86",
      stage: "implementation",
      operator,
      reason: "timeout retry",
    });
  });

  it("maps restart validation errors to the service status code", async () => {
    getTrustedOperatorIdentityMock.mockReturnValue(operator);
    restartOneShotRunStageMock.mockRejectedValue(
      new OneShotRunControlErrorMock("stage must be valid", 400),
    );

    const { postOneShotRunRestartStage } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunRestartStage(
      {
        params: { dashboardId: "run-86" },
        body: { stage: "ship" },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: "stage must be valid" });
  });

  it("hard deletes without trying to reload the deleted row", async () => {
    getTrustedOperatorIdentityMock.mockReturnValue(operator);
    hardDeleteOneShotRunMock.mockResolvedValue({
      deleted: true,
      affectedRunIds: [86, 87],
      sourceTaskManagementIds: [501],
      deletedCounts: { oneshot_runs: 2 },
      s3DeletedObjects: 4,
    });

    const { postOneShotRunHardDelete } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunHardDelete(
      {
        params: { dashboardId: "run-86" },
        body: {
          confirmDashboardId: "run-86",
          reason: "cleanup failed experiment",
        },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      deleted: true,
      affectedRunIds: [86, 87],
      sourceTaskManagementIds: [501],
      deletedCounts: { oneshot_runs: 2 },
      s3DeletedObjects: 4,
    });
    expect(getOneShotRowByDashboardIdMock).not.toHaveBeenCalled();
    expect(hardDeleteOneShotRunMock).toHaveBeenCalledWith({
      dashboardId: "run-86",
      confirmDashboardId: "run-86",
      operator,
      reason: "cleanup failed experiment",
    });
  });
});
