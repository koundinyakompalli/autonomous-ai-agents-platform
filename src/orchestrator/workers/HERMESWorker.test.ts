import { describe, expect, it } from "vitest";
import { HERMESWorker } from "./HERMESWorker.js";

describe("HERMESWorker output rendering", () => {
  it("renders structured evidence and related configs into the Jira output", () => {
    const worker = new HERMESWorker("/tmp/repos");

    const output = (worker as any).formatOutput("CPSUP-1", {
      success: true,
      configuration: "Configuration summary",
      structured: {
        resolution_status: "found",
        configuration: {
          name: "CLAIM_AUTO_CLOSE_ENABLED",
        },
        evidence: [
          {
            source_path: "config/system_variables.md",
            finding: "Documents the claim auto-close flag.",
            precedence: "config documentation",
          },
        ],
        related_configurations: [
          {
            name: "CLAIM_AUTO_CLOSE_DAYS",
            relationship: "Controls the age threshold.",
          },
        ],
      },
      metrics: {
        durationMs: 1000,
        toolCalls: 3,
      },
    });

    expect(output).toContain("### Resolution Status");
    expect(output).toContain("found");
    expect(output).toContain("### Evidence");
    expect(output).toContain("config/system_variables.md");
    expect(output).toContain("Documents the claim auto-close flag.");
    expect(output).toContain("### Related Configurations");
    expect(output).toContain("CLAIM_AUTO_CLOSE_DAYS");
  });
});
