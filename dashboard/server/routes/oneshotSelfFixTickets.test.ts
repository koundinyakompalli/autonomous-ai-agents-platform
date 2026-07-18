import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createOneShotSelfFixTicketMock, getTrustedOperatorIdentityMock } =
  vi.hoisted(() => ({
    createOneShotSelfFixTicketMock: vi.fn(),
    getTrustedOperatorIdentityMock: vi.fn(),
  }));

vi.mock("../auth/operatorIdentity.js", async () => {
  const actual =
    await vi.importActual<typeof import("../auth/operatorIdentity.js")>(
      "../auth/operatorIdentity.js",
    );
  return {
    ...actual,
    getTrustedOperatorIdentity: getTrustedOperatorIdentityMock,
  };
});

vi.mock("../services/oneshotSelfFixTickets.js", () => ({
  createOneShotSelfFixTicket: createOneShotSelfFixTicketMock,
  normalizeSelfFixTicketError: (error: unknown) =>
    error && typeof error === "object" && "statusCode" in error
      ? {
          statusCode: Number((error as { statusCode: number }).statusCode),
          message: String((error as { message?: string }).message),
        }
      : { statusCode: 500, message: "failed" },
}));

function mockResponse() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
  };
}

describe("postOneShotSelfFixTicket", () => {
  beforeEach(() => {
    createOneShotSelfFixTicketMock.mockReset();
    getTrustedOperatorIdentityMock.mockReset();
    getTrustedOperatorIdentityMock.mockReturnValue({
      id: "user-1",
      display: "User One",
    });
  });

  it("creates a self-fix ticket for the requested candidate", async () => {
    createOneShotSelfFixTicketMock.mockResolvedValue({
      candidateId: "oneshot-self-fix-agent_logic-oneshot",
      ticketKey: "CPDEV-300",
      jiraUrl: "https://jira.example.com/browse/CPDEV-300",
      status: "ticket_created",
    });
    const { postOneShotSelfFixTicket } = await import("./oneshot.js");
    const res = mockResponse();

    await postOneShotSelfFixTicket(
      {
        body: {
          range: "7d",
          candidateId: "oneshot-self-fix-agent_logic-oneshot",
          autoRun: true,
        },
      } as Request,
      res,
    );

    expect(createOneShotSelfFixTicketMock).toHaveBeenCalledWith({
      range: "7d",
      candidateId: "oneshot-self-fix-agent_logic-oneshot",
      autoRun: true,
      operator: { id: "user-1", display: "User One" },
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ticketKey: "CPDEV-300" }),
    );
  });

  it("rejects requests without a candidate id", async () => {
    const { postOneShotSelfFixTicket } = await import("./oneshot.js");
    const res = mockResponse();

    await postOneShotSelfFixTicket({ body: { range: "7d" } } as Request, res);

    expect(createOneShotSelfFixTicketMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "candidateId is required" });
  });
});
