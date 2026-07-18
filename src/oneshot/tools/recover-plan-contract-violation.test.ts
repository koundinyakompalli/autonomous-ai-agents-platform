import { describe, expect, it, vi } from "vitest";
import {
  parseRecoverPlanContractViolationCliArgs,
  runRecoverPlanContractViolationCli,
} from "./recover-plan-contract-violation.js";

function writer() {
  return {
    text: "",
    write(chunk: string) {
      this.text += chunk;
    },
  };
}

describe("parseRecoverPlanContractViolationCliArgs", () => {
  it("parses run dashboard ids", () => {
    expect(
      parseRecoverPlanContractViolationCliArgs([
        "--dashboard-id",
        "run-546",
        "--operator-id",
        "op-1",
        "--operator-name",
        "Operator One",
        "--reason",
        "recover plan contract violation",
      ]),
    ).toEqual({
      kind: "run",
      runId: 546,
      dashboardId: "run-546",
      operatorId: "op-1",
      operatorName: "Operator One",
      reason: "recover plan contract violation",
    });
  });

  it("rejects qualifier-task rows", () => {
    expect(() =>
      parseRecoverPlanContractViolationCliArgs([
        "--run",
        "qualifier-task-3321",
        "--operator-id",
        "op-1",
        "--operator-name",
        "Operator One",
      ]),
    ).toThrow("Only run-* rows can be recovered");
  });
});

describe("runRecoverPlanContractViolationCli", () => {
  it("recovers plan-contract blocked runs through the injected recovery function", async () => {
    const stdout = writer();
    const stderr = writer();
    const recover = vi.fn().mockResolvedValue({
      oneshotRunId: 546,
      stage: "planning",
      state: "queued_for_planning",
      version: 8,
    });

    const code = await runRecoverPlanContractViolationCli(
      [
        "--dashboard-id",
        "run-546",
        "--operator-id",
        "op-1",
        "--operator-name",
        "Operator One",
      ],
      { recover, stdout, stderr },
    );

    expect(code).toBe(0);
    expect(recover).toHaveBeenCalledWith({
      runId: 546,
      operatorId: "op-1",
      operatorName: "Operator One",
      reason: undefined,
    });
    expect(stdout.text).toContain("OneShot plan-contract recovery queued");
    expect(stderr.text).toBe("");
  });

  it("returns non-zero on recovery failure", async () => {
    const stdout = writer();
    const stderr = writer();
    const recover = vi.fn().mockRejectedValue(new Error("not a blocked plan-contract violation"));

    const code = await runRecoverPlanContractViolationCli(
      [
        "--run",
        "546",
        "--operator-id",
        "op-1",
        "--operator-name",
        "Operator One",
      ],
      { recover, stdout, stderr },
    );

    expect(code).toBe(1);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("not a blocked plan-contract violation");
  });
});
