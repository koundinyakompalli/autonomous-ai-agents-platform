import { describe, expect, it } from "vitest";
import {
  currentSpecFactoryCorrelation,
  runWithSpecFactoryCorrelation,
  specFactoryCorrelationLogFields,
  updateSpecFactoryCorrelation,
} from "./correlation.js";

describe("Spec Factory correlation context", () => {
  it("propagates and enriches correlation across asynchronous work", async () => {
    await runWithSpecFactoryCorrelation(
      { requestId: "req-7", sessionId: 81 },
      async () => {
        await Promise.resolve();
        updateSpecFactoryCorrelation({ actorId: "codex", turnJobId: 42 });

        expect(currentSpecFactoryCorrelation()).toEqual({
          requestId: "req-7",
          actorId: "codex",
          sessionId: 81,
          turnJobId: 42,
        });
        expect(specFactoryCorrelationLogFields()).toEqual({
          request_id: "req-7",
          actor_id: "codex",
          session_id: 81,
          turn_job_id: 42,
        });
      },
    );
  });

  it("merges nested worker correlation without leaking it outside the scope", () => {
    runWithSpecFactoryCorrelation({ requestId: "req-8" }, () => {
      runWithSpecFactoryCorrelation(
        { agentTaskId: 9, workerId: "research-1" },
        () => {
          expect(currentSpecFactoryCorrelation()).toEqual({
            requestId: "req-8",
            agentTaskId: 9,
            workerId: "research-1",
          });
        },
      );
      expect(currentSpecFactoryCorrelation()).toEqual({ requestId: "req-8" });
    });
    expect(currentSpecFactoryCorrelation()).toEqual({});
  });
});
