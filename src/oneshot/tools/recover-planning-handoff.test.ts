import { describe, expect, it, vi } from "vitest";
import {
  parseRecoverPlanningHandoffCliArgs,
  runRecoverPlanningHandoffCli,
} from "./recover-planning-handoff.js";

function writer() {
  return {
    text: "",
    write(chunk: string) {
      this.text += chunk;
    },
  };
}

describe("parseRecoverPlanningHandoffCliArgs", () => {
  it("parses run dashboard ids", () => {
    expect(
      parseRecoverPlanningHandoffCliArgs([
        "--dashboard-id",
        "run-380",
        "--operator-id",
        "op-1",
        "--operator-name",
        "Operator One",
        "--reason",
        "retry live handoff",
      ]),
    ).toEqual({
      kind: "run",
      runId: 380,
      dashboardId: "run-380",
      operatorId: "op-1",
      operatorName: "Operator One",
      reason: "retry live handoff",
    });
  });

  it("rejects qualifier-task rows", () => {
    expect(() =>
      parseRecoverPlanningHandoffCliArgs([
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

describe("runRecoverPlanningHandoffCli", () => {
  it("recovers handoff runs through the injected recovery function", async () => {
    const stdout = writer();
    const stderr = writer();
    const recover = vi.fn().mockResolvedValue({
      oneshotRunId: 380,
      stage: "planning",
      state: "queued_for_planning",
      version: 1,
    });

    const code = await runRecoverPlanningHandoffCli(
      [
        "--dashboard-id",
        "run-380",
        "--operator-id",
        "op-1",
        "--operator-name",
        "Operator One",
      ],
      { recover, stdout, stderr },
    );

    expect(code).toBe(0);
    expect(recover).toHaveBeenCalledWith({
      runId: 380,
      operatorId: "op-1",
      operatorName: "Operator One",
      reason: undefined,
    });
    expect(stdout.text).toContain("OneShot planning handoff recovery queued");
    expect(stderr.text).toBe("");
  });

  it("returns non-zero on residual recovery failure", async () => {
    const stdout = writer();
    const stderr = writer();
    const recover = vi.fn().mockRejectedValue(new Error("SQS still unavailable"));

    const code = await runRecoverPlanningHandoffCli(
      [
        "--run",
        "380",
        "--operator-id",
        "op-1",
        "--operator-name",
        "Operator One",
      ],
      { recover, stdout, stderr },
    );

    expect(code).toBe(1);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("SQS still unavailable");
  });
});
