import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getTrustedOperatorIdentityMock,
  listBlockedClientsMock,
  upsertBlockedClientMock,
  deactivateBlockedClientMock,
  reactivateBlockedClientMock,
  OperatorIdentityErrorMock,
  OneShotBlockedClientPolicyErrorMock,
} = vi.hoisted(() => {
  class OperatorIdentityError extends Error {
    readonly statusCode: number;

    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "OperatorIdentityError";
      this.statusCode = statusCode;
    }
  }

  class OneShotBlockedClientPolicyError extends Error {
    readonly statusCode: number;
    readonly code: string;
    readonly details?: unknown;

    constructor(
      message: string,
      statusCode: number,
      code: string,
      details?: unknown,
    ) {
      super(message);
      this.name = "OneShotBlockedClientPolicyError";
      this.statusCode = statusCode;
      this.code = code;
      this.details = details;
    }
  }

  return {
    getTrustedOperatorIdentityMock: vi.fn(),
    listBlockedClientsMock: vi.fn(),
    upsertBlockedClientMock: vi.fn(),
    deactivateBlockedClientMock: vi.fn(),
    reactivateBlockedClientMock: vi.fn(),
    OperatorIdentityErrorMock: OperatorIdentityError,
    OneShotBlockedClientPolicyErrorMock: OneShotBlockedClientPolicyError,
  };
});

vi.mock("../auth/operatorIdentity.js", () => ({
  getTrustedOperatorIdentity: getTrustedOperatorIdentityMock,
  OperatorIdentityError: OperatorIdentityErrorMock,
}));

vi.mock("../services/oneshotBlockedClients.js", () => ({
  listBlockedClients: listBlockedClientsMock,
  upsertBlockedClient: upsertBlockedClientMock,
  deactivateBlockedClient: deactivateBlockedClientMock,
  reactivateBlockedClient: reactivateBlockedClientMock,
  OneShotBlockedClientPolicyError: OneShotBlockedClientPolicyErrorMock,
}));

async function loadModule() {
  vi.resetModules();
  return import("./oneshotBlockedClients.js");
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

describe("oneshotBlockedClients route", () => {
  beforeEach(() => {
    getTrustedOperatorIdentityMock.mockReset();
    listBlockedClientsMock.mockReset();
    upsertBlockedClientMock.mockReset();
    deactivateBlockedClientMock.mockReset();
    reactivateBlockedClientMock.mockReset();
  });

  it("lists blocked clients for trusted operators", async () => {
    getTrustedOperatorIdentityMock.mockReturnValue({
      id: "rmadhukar",
      display: "R Madhukar",
    });
    listBlockedClientsMock.mockResolvedValue([
      {
        clientKey: "blocked corp",
        displayName: "Blocked Corp",
        reason: "Contract exclusion",
        isActive: true,
      },
    ]);

    const { getBlockedClients } = await loadModule();
    const response = createResponseRecorder();

    await getBlockedClients(
      { query: { includeInactive: "true" } } as any,
      response as any,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      clients: [
        expect.objectContaining({
          clientKey: "blocked corp",
          displayName: "Blocked Corp",
        }),
      ],
    });
    expect(listBlockedClientsMock).toHaveBeenCalledWith({
      includeInactive: true,
    });
  });

  it("creates or updates blocked clients with operator identity", async () => {
    const operator = { id: "rmadhukar", display: "R Madhukar" };
    getTrustedOperatorIdentityMock.mockReturnValue(operator);
    upsertBlockedClientMock.mockResolvedValue({
      action: "created",
      client: { clientKey: "blocked corp", displayName: "Blocked Corp" },
    });

    const { postBlockedClient } = await loadModule();
    const response = createResponseRecorder();

    await postBlockedClient(
      {
        body: {
          displayName: "Blocked Corp",
          reason: "Contract exclusion",
        },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      action: "created",
      client: { clientKey: "blocked corp", displayName: "Blocked Corp" },
    });
    expect(upsertBlockedClientMock).toHaveBeenCalledWith({
      displayName: "Blocked Corp",
      reason: "Contract exclusion",
      operator,
    });
  });

  it("deactivates and reactivates blocked clients", async () => {
    const operator = { id: "rmadhukar", display: "R Madhukar" };
    getTrustedOperatorIdentityMock.mockReturnValue(operator);
    deactivateBlockedClientMock.mockResolvedValue({
      action: "deactivated",
      client: { clientKey: "blocked corp", displayName: "Blocked Corp" },
    });
    reactivateBlockedClientMock.mockResolvedValue({
      action: "reactivated",
      client: { clientKey: "blocked corp", displayName: "Blocked Corp" },
    });

    const { postBlockedClientDeactivate, postBlockedClientReactivate } =
      await loadModule();

    const deactivateResponse = createResponseRecorder();
    await postBlockedClientDeactivate(
      {
        params: { clientKey: "blocked corp" },
        body: { reason: "No longer excluded" },
      } as any,
      deactivateResponse as any,
    );

    expect(deactivateResponse.body).toEqual({
      action: "deactivated",
      client: { clientKey: "blocked corp", displayName: "Blocked Corp" },
    });
    expect(deactivateBlockedClientMock).toHaveBeenCalledWith({
      clientKey: "blocked corp",
      reason: "No longer excluded",
      operator,
    });

    const reactivateResponse = createResponseRecorder();
    await postBlockedClientReactivate(
      {
        params: { clientKey: "blocked corp" },
        body: { reason: "Excluded again" },
      } as any,
      reactivateResponse as any,
    );

    expect(reactivateResponse.body).toEqual({
      action: "reactivated",
      client: { clientKey: "blocked corp", displayName: "Blocked Corp" },
    });
    expect(reactivateBlockedClientMock).toHaveBeenCalledWith({
      clientKey: "blocked corp",
      reason: "Excluded again",
      operator,
    });
  });

  it("requires trusted operator identity", async () => {
    getTrustedOperatorIdentityMock.mockImplementation(() => {
      throw new OperatorIdentityErrorMock(
        "Trusted operator identity headers are missing",
        403,
      );
    });

    const { postBlockedClient } = await loadModule();
    const response = createResponseRecorder();

    await postBlockedClient(
      { body: { displayName: "Blocked Corp", reason: "Contract" } } as any,
      response as any,
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      error: "Trusted operator identity headers are missing",
    });
    expect(upsertBlockedClientMock).not.toHaveBeenCalled();
  });

  it("passes already-decoded client keys containing percent characters to the service", async () => {
    const operator = { id: "rmadhukar", display: "R Madhukar" };
    getTrustedOperatorIdentityMock.mockReturnValue(operator);
    deactivateBlockedClientMock.mockResolvedValue({
      action: "deactivated",
      client: { clientKey: "a%b client", displayName: "A%B Client" },
    });

    const { postBlockedClientDeactivate } = await loadModule();
    const response = createResponseRecorder();

    await postBlockedClientDeactivate(
      {
        params: { clientKey: "a%b client" },
        body: { reason: "No longer excluded" },
      } as any,
      response as any,
    );

    expect(response.statusCode).toBe(200);
    expect(deactivateBlockedClientMock).toHaveBeenCalledWith({
      clientKey: "a%b client",
      reason: "No longer excluded",
      operator,
    });
  });

  it("returns structured policy-store errors", async () => {
    getTrustedOperatorIdentityMock.mockReturnValue({
      id: "rmadhukar",
      display: "R Madhukar",
    });
    listBlockedClientsMock.mockRejectedValue(
      new OneShotBlockedClientPolicyErrorMock(
        "Blocked-client policy store is unavailable",
        503,
        "policy_store_unavailable",
        { cause: "ER_NO_SUCH_TABLE: table missing" },
      ),
    );

    const { getBlockedClients } = await loadModule();
    const response = createResponseRecorder();

    await getBlockedClients({ query: {} } as any, response as any);

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({
      error: "Blocked-client policy store is unavailable",
      code: "policy_store_unavailable",
    });
  });
});
