import { describe, expect, it, vi } from "vitest";
import { JiraPublisher } from "./jira-publisher.js";
import type { SpecFactoryDraftDetail } from "./types.js";

function validBundle() {
  return {
    sourceJiraKey: "CPDEV-22410",
    loeHours: 38,
    epic: {
      summary: "Automate enrollment sync validation",
      description: "Client A needs repeatable validation.",
      businessContext: ["Louise estimated this as a cross-repo item."],
      acceptanceCriteria: ["Generated stories cover each repo change."],
      assumptions: [],
      dependencies: [],
    },
    childTickets: [
      {
        repoName: "core-app",
        repoId: 7,
        summary: "[core-app] Add validation",
        overview: "Implement backend validation.",
        acceptanceCriteria: ["Reject invalid payloads.", "Preserve other clients."],
        technicalDetails: {
          repo: "core-app",
          branch: "master",
          targetFiles: ["service/Validator.java"],
          implementationNotes: ["Use the existing validator."],
        },
        outOfScope: [],
        testingNotes: ["Run unit tests."],
        loeHours: 20,
        sourceEvidenceRefs: ["attachment:loe.md"],
      },
    ],
    evidenceSummary: ["Louise estimated 38 hours."],
    warnings: [],
  };
}

function draftDetail(
  overrides: Partial<SpecFactoryDraftDetail> = {},
): SpecFactoryDraftDetail {
  return {
    id: 44,
    sourceId: 12,
    version: 3,
    evidenceSnapshotId: null,
    status: "ready",
    draft: validBundle(),
    renderedMarkdown: "# Draft",
    evidenceManifest: { refs: ["jira:CPDEV-22410"] },
    childTickets: [
      {
        id: 99,
        repoName: "core-app",
        summary: "[core-app] Add validation",
        description: "Persisted child description",
        loeHours: 20,
        jiraKey: null,
        state: "draft",
        oneshotRequestId: null,
        oneshotRunId: null,
        errorMessage: null,
      },
      {
        id: 100,
        repoName: "service-api",
        summary: "[service-api] Add validation",
        description: "Persisted child description",
        loeHours: 12,
        jiraKey: null,
        state: "draft",
        oneshotRequestId: null,
        oneshotRunId: null,
        errorMessage: null,
      },
    ],
    errorMessage: null,
    createdAt: "2026-05-27T12:00:00.000Z",
    updatedAt: "2026-05-27T12:05:00.000Z",
    ...overrides,
  };
}

describe("JiraPublisher idempotent retry safety", () => {
  it("does NOT recreate a child whose Jira issue already exists under the Epic (pre-check by summary+parent)", async () => {
    // Simulates the partial-failure window: createIssue succeeded for child #99
    // in Jira on the previous attempt, but the persistence callback failed
    // before storing its jira_key, so on retry the draft still has jiraKey=null
    // for that child.
    const createIssue = vi
      .fn()
      .mockResolvedValueOnce({ key: "CPDEV-NEW-2" }); // for child #100 only
    const findChildIssueByParentAndSummary = vi
      .fn()
      .mockResolvedValueOnce({
        key: "CPDEV-EXISTS-1",
        summary: "[core-app] Add validation",
      })
      .mockResolvedValueOnce(null); // child #100 not yet created in Jira

    const publisher = new JiraPublisher(
      { createIssue },
      {},
      { findChildIssueByParentAndSummary },
    );

    const onChildCreated = vi.fn();
    await expect(
      publisher.approveDraft(draftDetail(), {
        existingEpicKey: "CPDEV-22411",
        onChildCreated,
      }),
    ).resolves.toEqual({
      epicKey: "CPDEV-22411",
      children: [
        { childId: 99, jiraKey: "CPDEV-EXISTS-1" },
        { childId: 100, jiraKey: "CPDEV-NEW-2" },
      ],
    });

    // Only one createIssue call — the second child was de-duped by the lookup.
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "[service-api] Add validation",
        parentKey: "CPDEV-22411",
      }),
    );
    // Both children are reported via onChildCreated so the persistence layer
    // updates jira_key for both, including the recovered one.
    expect(onChildCreated).toHaveBeenCalledTimes(2);
    expect(onChildCreated).toHaveBeenCalledWith({
      childId: 99,
      jiraKey: "CPDEV-EXISTS-1",
    });
    expect(onChildCreated).toHaveBeenCalledWith({
      childId: 100,
      jiraKey: "CPDEV-NEW-2",
    });
  });

  it("surfaces a partial-failure error that names the failed child and what was created so far", async () => {
    const createIssue = vi
      .fn()
      .mockResolvedValueOnce({ key: "CPDEV-22411" }) // epic
      .mockResolvedValueOnce({ key: "CPDEV-NEW-1" }) // child #99
      .mockRejectedValueOnce(new Error("Jira 503"));
    const publisher = new JiraPublisher({ createIssue });

    const onChildCreated = vi.fn();
    await expect(
      publisher.approveDraft(draftDetail(), { onChildCreated }),
    ).rejects.toThrow(/Jira 503/);

    // The first child callback should still have fired so the persistence
    // layer can mark child #99 created — making a retry idempotent.
    expect(onChildCreated).toHaveBeenCalledTimes(1);
    expect(onChildCreated).toHaveBeenCalledWith({
      childId: 99,
      jiraKey: "CPDEV-NEW-1",
    });
  });

  it("requires no extra config — falls back to no-op lookup if not provided (back-compat)", async () => {
    const createIssue = vi
      .fn()
      .mockResolvedValueOnce({ key: "CPDEV-22411" })
      .mockResolvedValueOnce({ key: "CPDEV-NEW-1" })
      .mockResolvedValueOnce({ key: "CPDEV-NEW-2" });
    const publisher = new JiraPublisher({ createIssue });

    await expect(publisher.approveDraft(draftDetail())).resolves.toMatchObject({
      epicKey: "CPDEV-22411",
      children: [
        { childId: 99, jiraKey: "CPDEV-NEW-1" },
        { childId: 100, jiraKey: "CPDEV-NEW-2" },
      ],
    });
    expect(createIssue).toHaveBeenCalledTimes(3);
  });
});
