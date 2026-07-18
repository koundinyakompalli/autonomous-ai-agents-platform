import { describe, expect, it, vi } from "vitest";
import { CandidateIngestor } from "./candidate-ingestor.js";

describe("CandidateIngestor", () => {
  it("refreshes Louise candidates into the Spec Factory source repository", async () => {
    const searchIssues = vi.fn().mockResolvedValue({
      total: 1,
      issues: [
        {
          key: "CPDEV-22410",
          fields: {
            summary: "Enrollment sync rules",
            status: { name: "In Progress" },
            labels: ["louise-estimated"],
          },
        },
      ],
    });
    const upsertSource = vi.fn().mockResolvedValue({ id: 12, inserted: true });
    const updateIssueLabels = vi.fn().mockResolvedValue(undefined);

    const result = await new CandidateIngestor(
      { searchIssues, updateIssueLabels },
      { upsertSource },
    ).refresh();

    expect(searchIssues).toHaveBeenCalledWith(
      'labels = "louise-estimated" AND labels not in ("SPEC-FACTORY-STARTED") ORDER BY updated DESC',
      "key,summary,status,labels,updated",
      50,
    );
    expect(upsertSource).toHaveBeenCalledWith({
      sourceJiraKey: "CPDEV-22410",
      sourceSummary: "Enrollment sync rules",
      sourceStatus: "In Progress",
      sourceLabels: ["louise-estimated"],
      loeHours: null,
    });
    expect(updateIssueLabels).toHaveBeenCalledWith("CPDEV-22410", {
      add: ["SPEC-FACTORY-STARTED"],
    });
    expect(result).toEqual({
      scanned: 1,
      upserted: 1,
      matched: 1,
      truncated: false,
      claimed: 1,
      claimFailures: 0,
      newSources: [{ id: 12, key: "CPDEV-22410" }],
    });
  });

  it("reports truncation when Jira matches more candidates than the returned page", async () => {
    const searchIssues = vi.fn().mockResolvedValue({
      total: 2,
      issues: [{ key: "CPDEV-22410", fields: { labels: [] } }],
    });
    const upsertSource = vi.fn().mockResolvedValue({ id: 12, inserted: true });
    const updateIssueLabels = vi.fn().mockResolvedValue(undefined);

    const result = await new CandidateIngestor(
      { searchIssues, updateIssueLabels },
      { upsertSource },
    ).refresh();

    expect(upsertSource).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      scanned: 1,
      upserted: 1,
      matched: 2,
      truncated: true,
      claimed: 1,
      claimFailures: 0,
      newSources: [{ id: 12, key: "CPDEV-22410" }],
    });
  });

  it("does not re-download ticket evidence during board refresh", async () => {
    const searchIssues = vi.fn().mockResolvedValue({
      total: 1,
      issues: [{ key: "CPDEV-22410", fields: { labels: [] } }],
    });
    const fetchTicketData = vi.fn();
    const upsertSource = vi.fn().mockResolvedValue({ id: 12, inserted: true });
    const updateIssueLabels = vi.fn().mockResolvedValue(undefined);

    await new CandidateIngestor(
      { searchIssues, updateIssueLabels, fetchTicketData } as any,
      { upsertSource },
    ).refresh();

    expect(fetchTicketData).not.toHaveBeenCalled();
  });

  it("does not add the started label when Jira already has it", async () => {
    const searchIssues = vi.fn().mockResolvedValue({
      total: 1,
      issues: [
        {
          key: "CPDEV-22410",
          fields: { labels: ["louise-estimated", "SPEC-FACTORY-STARTED"] },
        },
      ],
    });
    const upsertSource = vi.fn().mockResolvedValue({ id: 12, inserted: true });
    const updateIssueLabels = vi.fn().mockResolvedValue(undefined);

    const result = await new CandidateIngestor(
      { searchIssues, updateIssueLabels },
      { upsertSource },
    ).refresh();

    expect(updateIssueLabels).not.toHaveBeenCalled();
    expect(result.claimed).toBe(0);
    expect(result.newSources).toEqual([{ id: 12, key: "CPDEV-22410" }]);
  });

  it("claims tickets already intaken into Spec Factory without queueing them", async () => {
    const searchIssues = vi.fn().mockResolvedValue({
      total: 1,
      issues: [
        {
          key: "CPDEV-22410",
          fields: { labels: ["louise-estimated"] },
        },
      ],
    });
    const upsertSource = vi.fn().mockResolvedValue({
      id: 12,
      inserted: false,
    });
    const updateIssueLabels = vi.fn().mockResolvedValue(undefined);

    const result = await new CandidateIngestor(
      { searchIssues, updateIssueLabels },
      { upsertSource },
    ).refresh();

    expect(updateIssueLabels).toHaveBeenCalledWith("CPDEV-22410", {
      add: ["SPEC-FACTORY-STARTED"],
    });
    expect(result).toEqual({
      scanned: 1,
      upserted: 0,
      matched: 1,
      truncated: false,
      claimed: 1,
      claimFailures: 0,
      newSources: [],
    });
  });

  it("does not relabel tickets already intaken when Jira already has the started label", async () => {
    const searchIssues = vi.fn().mockResolvedValue({
      total: 1,
      issues: [
        {
          key: "CPDEV-22410",
          fields: { labels: ["louise-estimated", "SPEC-FACTORY-STARTED"] },
        },
      ],
    });
    const upsertSource = vi.fn().mockResolvedValue({
      id: 12,
      inserted: false,
    });
    const updateIssueLabels = vi.fn().mockResolvedValue(undefined);

    const result = await new CandidateIngestor(
      { searchIssues, updateIssueLabels },
      { upsertSource },
    ).refresh();

    expect(updateIssueLabels).not.toHaveBeenCalled();
    expect(result).toEqual({
      scanned: 1,
      upserted: 0,
      matched: 1,
      truncated: false,
      claimed: 0,
      claimFailures: 0,
      newSources: [],
    });
  });
});
