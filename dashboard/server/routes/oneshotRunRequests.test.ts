import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getTrustedOperatorIdentityMock,
  validateOneShotRunRequestJiraKeyMock,
  createOneShotRunRequestMock,
  getOneShotRunRequestByIdMock,
  OperatorIdentityErrorMock,
  OneShotRunRequestErrorMock,
} = vi.hoisted(() => {
  class OperatorIdentityError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "OperatorIdentityError";
      this.statusCode = statusCode;
    }
  }

  class OneShotRunRequestError extends Error {
    readonly statusCode: number;
    readonly code?: string;
    readonly details?: unknown;

    constructor(
      message: string,
      statusCode: number,
      code?: string,
      details?: unknown,
    ) {
      super(message);
      this.name = "OneShotRunRequestError";
      this.statusCode = statusCode;
      this.code = code;
      this.details = details;
    }
  }

  return {
    getTrustedOperatorIdentityMock: vi.fn(),
    validateOneShotRunRequestJiraKeyMock: vi.fn(),
    createOneShotRunRequestMock: vi.fn(),
    getOneShotRunRequestByIdMock: vi.fn(),
    OperatorIdentityErrorMock: OperatorIdentityError,
    OneShotRunRequestErrorMock: OneShotRunRequestError,
  };
});

vi.mock("../auth/operatorIdentity.js", () => ({
  getTrustedOperatorIdentity: getTrustedOperatorIdentityMock,
  OperatorIdentityError: OperatorIdentityErrorMock,
}));

vi.mock("../services/oneshotJiraLookup.js", () => ({
  validateOneShotRunRequestJiraKey: validateOneShotRunRequestJiraKeyMock,
}));

vi.mock("../services/oneshotRunRequests.js", () => ({
  createOneShotRunRequest: createOneShotRunRequestMock,
  getOneShotRunRequestById: getOneShotRunRequestByIdMock,
}));

vi.mock("../services/oneshotRunRequestSupport.js", () => ({
  OneShotRunRequestError: OneShotRunRequestErrorMock,
}));

async function loadModule() {
  vi.resetModules();
  return import("./oneshotRunRequests.js");
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

describe("oneshotRunRequests route", () => {
  beforeEach(() => {
    getTrustedOperatorIdentityMock.mockReset();
    validateOneShotRunRequestJiraKeyMock.mockReset();
    createOneShotRunRequestMock.mockReset();
    getOneShotRunRequestByIdMock.mockReset();
  });

  it("validates Jira before creating a durable queue request", async () => {
    const operator = {
      id: "rmadhukar",
      display: "R Madhukar",
    };
    getTrustedOperatorIdentityMock.mockReturnValue(operator);
    validateOneShotRunRequestJiraKeyMock.mockResolvedValue({
      jiraKey: "CPDEV-123",
      title: "Fix the run queue",
      statusName: "In Progress",
    });
    createOneShotRunRequestMock.mockResolvedValue({
      id: 42,
      jiraKey: "CPDEV-123",
      status: "queued",
      submittedAt: "2026-04-24T12:00:00.000Z",
    });

    const { postOneShotRunRequest } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunRequest(
      { body: { jiraKey: "cpdev-123" } } as any,
      response as any,
    );

    expect(response.statusCode).toBe(202);
    expect(response.body).toEqual({
      id: 42,
      jiraKey: "CPDEV-123",
      status: "queued",
      submittedAt: "2026-04-24T12:00:00.000Z",
    });
    expect(validateOneShotRunRequestJiraKeyMock).toHaveBeenCalledWith({
      jiraKey: "cpdev-123",
    });
    expect(createOneShotRunRequestMock).toHaveBeenCalledWith({
      jiraKey: "CPDEV-123",
      operator,
    });
  });

  it("does not create a queue request when Jira validation fails", async () => {
    getTrustedOperatorIdentityMock.mockReturnValue({
      id: "rmadhukar",
      display: "R Madhukar",
    });
    validateOneShotRunRequestJiraKeyMock.mockRejectedValue(
      new OneShotRunRequestErrorMock("Jira issue CPDEV-404 not found", 404),
    );

    const { postOneShotRunRequest } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunRequest(
      { body: { jiraKey: "CPDEV-404" } } as any,
      response as any,
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      error: "Jira issue CPDEV-404 not found",
    });
    expect(createOneShotRunRequestMock).not.toHaveBeenCalled();
  });

  it("creates a queue request for blocked-client-shaped validation metadata so QUALIFIER can reject", async () => {
    const operator = {
      id: "rmadhukar",
      display: "R Madhukar",
    };
    getTrustedOperatorIdentityMock.mockReturnValue(operator);
    validateOneShotRunRequestJiraKeyMock.mockResolvedValue({
      jiraKey: "CPDEV-500",
      title: "Add member search filter",
      statusName: "In Progress",
      clientName: "Blocked Corp",
    });
    createOneShotRunRequestMock.mockResolvedValue({
      id: 43,
      jiraKey: "CPDEV-500",
      status: "queued",
      submittedAt: "2026-04-24T12:30:00.000Z",
    });

    const { postOneShotRunRequest } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunRequest(
      { body: { jiraKey: "cpdev-500" } } as any,
      response as any,
    );

    expect(response.statusCode).toBe(202);
    expect(response.body).toEqual({
      id: 43,
      jiraKey: "CPDEV-500",
      status: "queued",
      submittedAt: "2026-04-24T12:30:00.000Z",
    });
    expect(createOneShotRunRequestMock).toHaveBeenCalledWith({
      jiraKey: "CPDEV-500",
      operator,
    });
  });

  it("returns the validated Jira title and status", async () => {
    getTrustedOperatorIdentityMock.mockReturnValue({
      id: "rmadhukar",
      display: "R Madhukar",
    });
    validateOneShotRunRequestJiraKeyMock.mockResolvedValue({
      jiraKey: "CPDEV-123",
      title: "Fix the run queue",
      statusName: "In Progress",
    });

    const { postOneShotRunRequestValidation } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunRequestValidation(
      { body: { jiraKey: "cpdev-123" } } as any,
      response as any,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      jiraKey: "CPDEV-123",
      title: "Fix the run queue",
      statusName: "In Progress",
    });
    expect(validateOneShotRunRequestJiraKeyMock).toHaveBeenCalledWith({
      jiraKey: "cpdev-123",
    });
  });

  it("requires trusted operator identity headers for validation", async () => {
    getTrustedOperatorIdentityMock.mockImplementation(() => {
      throw new OperatorIdentityErrorMock(
        "Trusted operator identity headers are missing",
        403,
      );
    });

    const { postOneShotRunRequestValidation } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunRequestValidation(
      { body: { jiraKey: "CPDEV-123" } } as any,
      response as any,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      error: "Trusted operator identity headers are missing",
    });
    expect(validateOneShotRunRequestJiraKeyMock).not.toHaveBeenCalled();
  });

  it("requires trusted operator identity headers for creating queue requests", async () => {
    getTrustedOperatorIdentityMock.mockImplementation(() => {
      throw new OperatorIdentityErrorMock(
        "Trusted operator identity headers are missing",
        403,
      );
    });

    const { postOneShotRunRequest } = await loadModule();
    const response = createResponseRecorder();

    await postOneShotRunRequest(
      { body: { jiraKey: "CPDEV-123" } } as any,
      response as any,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      error: "Trusted operator identity headers are missing",
    });
    expect(validateOneShotRunRequestJiraKeyMock).not.toHaveBeenCalled();
    expect(createOneShotRunRequestMock).not.toHaveBeenCalled();
  });

  it("requires trusted operator identity headers for queued request status", async () => {
    getTrustedOperatorIdentityMock.mockImplementation(() => {
      throw new OperatorIdentityErrorMock(
        "Trusted operator identity headers are missing",
        403,
      );
    });

    const { getOneShotRunRequest } = await loadModule();
    const response = createResponseRecorder();

    await getOneShotRunRequest(
      { params: { requestId: "42" } } as any,
      response as any,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      error: "Trusted operator identity headers are missing",
    });
    expect(getOneShotRunRequestByIdMock).not.toHaveBeenCalled();
  });
});
