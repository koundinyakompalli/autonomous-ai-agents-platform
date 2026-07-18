import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getTrustedOperatorIdentityMock,
  terminateOneShotRunMock,
  getOneShotRowByDashboardIdMock,
  OperatorIdentityErrorMock,
  OneShotRunTerminationErrorMock,
} = vi.hoisted(() => {
  class OperatorIdentityError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "OperatorIdentityError";
      this.statusCode = statusCode;
    }
  }

  class OneShotRunTerminationError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "OneShotRunTerminationError";
      this.statusCode = statusCode;
    }
  }

  return {
    getTrustedOperatorIdentityMock: vi.fn(),
    terminateOneShotRunMock: vi.fn(),
    getOneShotRowByDashboardIdMock: vi.fn(),
    OperatorIdentityErrorMock: OperatorIdentityError,
    OneShotRunTerminationErrorMock: OneShotRunTerminationError,
  };
});

vi.mock("../auth/operatorIdentity.js", () => ({
  getTrustedOperatorIdentity: getTrustedOperatorIdentityMock,
  OperatorIdentityError: OperatorIdentityErrorMock,
}));

vi.mock("../services/oneshotRunTerminations.js", () => ({
  terminateOneShotRun: terminateOneShotRunMock,
  OneShotRunTerminationError: OneShotRunTerminationErrorMock,
}));

vi.mock("../services/oneshot.js", () => ({
  getOneShotRowByDashboardId: getOneShotRowByDashboardIdMock,
}));

async function loadModule() {
  vi.resetModules();
  return import("./oneshotRunTerminations.js");
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
  };

  return response;
}

describe("oneshotRunTerminations route", () => {
  beforeEach(() => {
    getTrustedOperatorIdentityMock.mockReset();
    terminateOneShotRunMock.mockReset();
    getOneShotRowByDashboardIdMock.mockReset();
  });

  it("requires trusted operator identity headers", async () => {
    getTrustedOperatorIdentityMock.mockImplementation(() => {
      throw new OperatorIdentityErrorMock(
        "Trusted operator identity headers are missing",
        403,
      );
    });

    const { postOneShotRunTermination } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunTermination(
      {
        body: { oneshotRunId: 91 },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      error: "Trusted operator identity headers are missing",
    });
    expect(terminateOneShotRunMock).not.toHaveBeenCalled();
  });

  it("rejects invalid oneshotRunId values", async () => {
    getTrustedOperatorIdentityMock.mockReturnValue({
      id: "rmadhukar",
      display: "R Madhukar",
    });

    const { postOneShotRunTermination } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunTermination(
      {
        body: { oneshotRunId: 0 },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: "oneshotRunId must be a positive integer",
    });
    expect(terminateOneShotRunMock).not.toHaveBeenCalled();
  });

  it("returns 409 when the run is already terminal", async () => {
    getTrustedOperatorIdentityMock.mockReturnValue({
      id: "rmadhukar",
      display: "R Madhukar",
    });
    terminateOneShotRunMock.mockRejectedValue(
      new OneShotRunTerminationErrorMock(
        "OneShot run 91 is already terminal",
        409,
      ),
    );

    const { postOneShotRunTermination } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunTermination(
      {
        body: { oneshotRunId: 91 },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: "OneShot run 91 is already terminal",
    });
  });

  it("returns the updated dashboard row and cleanup status on success", async () => {
    const row = {
      dashboardId: "run-91",
      jiraKey: "CPDEV-91",
      title: "Test row",
      sourceTaskManagementId: 11,
      oneshotRunId: 91,
      customerName: "Customer",
      displayState: "failed",
      progressStage: "review",
      progressPercent: 38,
      repoName: "core-app",
      repoUrl: "https://example.com/core-app",
      baseBranch: "main",
      baseCommitSha: "abc123",
      implementationBranch: null,
      implementationCommitSha: null,
      reviewLoopCount: 0,
      maxReviewLoops: 3,
      currentPrUrl: null,
      qualificationSummary: null,
      lastError: "OneShot run terminated by R Madhukar (rmadhukar). Reason: free the slot",
      lastErrorSummary: "OneShot run terminated by R Madhukar (rmadhukar). Reason: free the slot",
      retry: null,
      deployment: {
        eligible: false,
        ready: false,
        light: "grey",
        status: "not_eligible",
        active: false,
        previewUrl: null,
        workflowUrl: null,
        imageUri: null,
        deployedCommitSha: null,
      },
      createdAt: "2026-04-20T00:00:00.000Z",
      lastManualRestartAt: null,
      updatedAt: "2026-04-20T00:05:00.000Z",
      totalTokensUsed: 0,
      estimatedCostUsd: 0,
      costSource: "estimated",
    };

    getTrustedOperatorIdentityMock.mockReturnValue({
      id: "rmadhukar",
      display: "R Madhukar",
    });
    terminateOneShotRunMock.mockResolvedValue({
      oneshotRunId: 91,
      workspaceCleanupStatus: "requested",
      workspaceCleanupSucceeded: true,
    });
    getOneShotRowByDashboardIdMock.mockResolvedValue(row);

    const { postOneShotRunTermination } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunTermination(
      {
        body: {
          oneshotRunId: 91,
          reason: "free the slot",
        },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      row,
      workspaceCleanupStatus: "requested",
      workspaceCleanupSucceeded: true,
    });
    expect(terminateOneShotRunMock).toHaveBeenCalledWith({
      oneshotRunId: 91,
      operator: {
        id: "rmadhukar",
        display: "R Madhukar",
      },
      reason: "free the slot",
    });
    expect(getOneShotRowByDashboardIdMock).toHaveBeenCalledWith("run-91");
  });
});
