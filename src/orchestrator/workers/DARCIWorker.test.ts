import { describe, expect, it } from "vitest";
import { DARCIWorker } from "./DARCIWorker.js";

describe("DARCIWorker output rendering", () => {
  it("renders structured evidence and rejected hypotheses into the Jira output", () => {
    const worker = new DARCIWorker("/tmp/repos");

    const output = (worker as any).formatOutput("CPDEV-1", {
      success: true,
      analysis: "Root cause summary",
      structured: {
        resolution_status: "root_cause_found",
        evidence: [
          {
            file_path: "core-app/src/AuthService.java",
            line_numbers: "42-47",
            finding: "Token expiry check rejects valid reset tokens.",
          },
        ],
        hypotheses_rejected: [
          {
            hypothesis: "Database outage",
            reason: "No DB errors were present in the ticket evidence.",
          },
        ],
      },
      metrics: {
        durationMs: 1000,
        toolCalls: 4,
      },
    });

    expect(output).toContain("### Evidence");
    expect(output).toContain("core-app/src/AuthService.java:42-47");
    expect(output).toContain("Token expiry check rejects valid reset tokens.");
    expect(output).toContain("### Hypotheses Rejected");
    expect(output).toContain("Database outage");
  });
});
