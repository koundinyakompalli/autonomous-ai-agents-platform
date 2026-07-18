import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getTrustedOperatorIdentityMock,
  resolveRepoRouterConfirmationMock,
  OperatorIdentityErrorMock,
  RepoRouterDashboardErrorMock,
} = vi.hoisted(() => {
  class OperatorIdentityError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "OperatorIdentityError";
      this.statusCode = statusCode;
    }
  }

  class RepoRouterDashboardError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "RepoRouterDashboardError";
      this.statusCode = statusCode;
    }
  }

  return {
    getTrustedOperatorIdentityMock: vi.fn(),
    resolveRepoRouterConfirmationMock: vi.fn(),
    OperatorIdentityErrorMock: OperatorIdentityError,
    RepoRouterDashboardErrorMock: RepoRouterDashboardError,
  };
});

vi.mock("../auth/operatorIdentity.js", () => ({
  getTrustedOperatorIdentity: getTrustedOperatorIdentityMock,
  OperatorIdentityError: OperatorIdentityErrorMock,
}));

vi.mock("../services/repoRouter.js", () => ({
  getPendingRepoRouterConfirmations: vi.fn(),
  getRecentRepoRouterDecisions: vi.fn(),
  resolveRepoRouterConfirmation: resolveRepoRouterConfirmationMock,
  RepoRouterDashboardError: RepoRouterDashboardErrorMock,
}));

async function loadModule() {
  vi.resetModules();
  return import("./repoRouter.js");
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

describe("repo router confirmation route", () => {
  beforeEach(() => {
    getTrustedOperatorIdentityMock.mockReset();
    resolveRepoRouterConfirmationMock.mockReset();
  });

  it("requires trusted operator identity headers", async () => {
    getTrustedOperatorIdentityMock.mockImplementation(() => {
      throw new OperatorIdentityErrorMock(
        "Trusted operator identity headers are missing",
        403,
      );
    });

    const { postRepoRouterConfirmation } = await loadModule();
    const response = createResponseRecorder();

    await postRepoRouterConfirmation(
      {
        params: { confirmationId: "18" },
        body: { repoId: 1 },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      error: "Trusted operator identity headers are missing",
    });
    expect(resolveRepoRouterConfirmationMock).not.toHaveBeenCalled();
  });

  it("resolves a confirmation with the trusted operator identity", async () => {
    const operator = { id: "rmadhukar", display: "R Madhukar" };
    const resolved = {
      id: 18,
      ticketId: "CPDEV-22245",
      taskManagementId: 2429,
      resolvedBy: "R Madhukar",
    };
    getTrustedOperatorIdentityMock.mockReturnValue(operator);
    resolveRepoRouterConfirmationMock.mockResolvedValue(resolved);

    const { postRepoRouterConfirmation } = await loadModule();
    const response = createResponseRecorder();

    await postRepoRouterConfirmation(
      {
        params: { confirmationId: "18" },
        body: { repoId: 1 },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(resolved);
    expect(resolveRepoRouterConfirmationMock).toHaveBeenCalledWith({
      confirmationId: 18,
      repoId: 1,
      operator,
    });
  });
});
