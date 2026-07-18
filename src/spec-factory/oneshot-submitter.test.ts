import { describe, expect, it, vi } from "vitest";
import { OneShotSubmitter } from "./oneshot-submitter.js";
import type { SpecFactoryChildTicketSummary } from "./types.js";

function child(
  overrides: Partial<SpecFactoryChildTicketSummary> = {},
): SpecFactoryChildTicketSummary {
  return {
    id: 99,
    repoName: "core-app",
    summary: "Implement sync rule service changes",
    description: "Persisted child description",
    loeHours: 18,
    jiraKey: "CPDEV-22412",
    state: "created",
    oneshotRequestId: null,
    oneshotRunId: null,
    errorMessage: null,
    ...overrides,
  };
}

describe("OneShotSubmitter", () => {
  it("emits each submitted child after run request creation and PFOS labeling", async () => {
    const jiraClient = {
      updateIssueLabels: vi.fn().mockResolvedValue(undefined),
    };
    const createRunRequest = vi.fn().mockResolvedValue(701);
    const onChildSubmitted = vi.fn().mockResolvedValue(undefined);
    const submitter = new OneShotSubmitter(jiraClient, createRunRequest);

    await expect(
      submitter.submitChildren({
        children: [child()],
        actor: { id: "kkompalli", display: "K Kompalli" },
        onChildSubmitted,
      }),
    ).resolves.toEqual([{ childId: 99, requestId: 701 }]);

    expect(jiraClient.updateIssueLabels).toHaveBeenCalledWith("CPDEV-22412", {
      add: ["PFOS"],
    });
    expect(createRunRequest).toHaveBeenCalledWith("CPDEV-22412", {
      id: "kkompalli",
      display: "K Kompalli",
    });
    expect(onChildSubmitted).toHaveBeenCalledWith({
      childId: 99,
      requestId: 701,
    });
  });

  it("creates the OneShot run request BEFORE applying PFOS so a PFOS failure does not orphan", async () => {
    const order: string[] = [];
    const jiraClient = {
      updateIssueLabels: vi.fn(async () => {
        order.push("pfos");
      }),
    };
    const createRunRequest = vi.fn(async () => {
      order.push("runRequest");
      return 701;
    });
    const submitter = new OneShotSubmitter(jiraClient, createRunRequest);

    await submitter.submitChildren({
      children: [child()],
      actor: { id: "kkompalli", display: "K Kompalli" },
    });

    expect(order).toEqual(["runRequest", "pfos"]);
  });

  it("does NOT apply PFOS when the run request creation fails (no orphan label)", async () => {
    const jiraClient = {
      updateIssueLabels: vi.fn().mockResolvedValue(undefined),
    };
    const createRunRequest = vi.fn().mockRejectedValueOnce(new Error("db down"));
    const submitter = new OneShotSubmitter(jiraClient, createRunRequest);

    await expect(
      submitter.submitChildren({
        children: [child()],
        actor: { id: "kkompalli", display: "K Kompalli" },
      }),
    ).rejects.toThrow("db down");

    expect(jiraClient.updateIssueLabels).not.toHaveBeenCalled();
  });

  it("keeps already submitted child callbacks when a later child PFOS fails", async () => {
    // After reordering, child 1 succeeds end-to-end (run request + PFOS).
    // Child 2's run request is created first; PFOS then fails — but the
    // run request itself is dedupe-safe via findExistingRunRequestId so a
    // retry will not duplicate it.
    const jiraClient = {
      updateIssueLabels: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("jira labels failed")),
    };
    const createRunRequest = vi
      .fn()
      .mockResolvedValueOnce(701)
      .mockResolvedValueOnce(702);
    const onChildSubmitted = vi.fn().mockResolvedValue(undefined);
    const submitter = new OneShotSubmitter(jiraClient, createRunRequest);

    await expect(
      submitter.submitChildren({
        children: [
          child(),
          child({ id: 100, repoName: "service-api", jiraKey: "CPDEV-22413" }),
        ],
        actor: { id: "kkompalli", display: "K Kompalli" },
        onChildSubmitted,
      }),
    ).rejects.toThrow("jira labels failed");

    expect(onChildSubmitted).toHaveBeenCalledTimes(1);
    expect(onChildSubmitted).toHaveBeenCalledWith({
      childId: 99,
      requestId: 701,
    });
  });
});
