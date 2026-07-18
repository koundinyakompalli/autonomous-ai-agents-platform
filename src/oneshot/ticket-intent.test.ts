import { describe, expect, it } from "vitest";
import {
  normalizeTicketIntentDescription,
  parseTicketIntent,
} from "./ticket-intent.js";

describe("parseTicketIntent", () => {
  it("parses explicit repo for non-retrofit tickets", () => {
    const intent = parseTicketIntent(
      "Repo: cp-provider-portal\r\nTarget Branch: master",
    );

    expect(intent.repoHint).toMatchObject({
      kind: "repo",
      value: "cp-provider-portal",
    });
    expect(intent.retrofit.present).toBe(false);
    expect(intent.positiveBranchHints[0]).toMatchObject({
      kind: "target_branch",
      value: "master",
    });
  });

  it("parses GitHub repo, retrofit source key, source branch, and target branch", () => {
    const intent = parseTicketIntent(
      [
        "GitHub Repo: `mhk-repos/cp-batch-monorepo`",
        "Retrofit: CPDEV-1234",
        "From: batch-monorepo-master",
        "Target: batch-monorepo-3.18",
      ].join("\n"),
    );

    expect(intent.repoHint).toMatchObject({
      kind: "github_repo",
      value: "mhk-repos/cp-batch-monorepo",
    });
    expect(intent.retrofit).toMatchObject({
      present: true,
      complete: true,
      context: {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "batch-monorepo-master",
        targetBranch: "batch-monorepo-3.18",
      },
    });
    expect(intent.positiveBranchHints[0]).toMatchObject({
      kind: "retrofit_target",
      value: "batch-monorepo-3.18",
    });
    expect(intent.retrofit.targetBranches).toEqual(["batch-monorepo-3.18"]);
    expect(intent.retrofit.skippedTargetBranches).toEqual([]);
  });

  it("parses comma-separated retrofit target branches in ticket order", () => {
    const intent = parseTicketIntent(
      [
        "Repo: medhok-monorepo",
        "Retrofit: CPDEV-1234",
        "From: master",
        "Target: medhok-monorepo-3.17, medhok-monorepo-3.18, medhok-monorepo-3.19",
      ].join("\n"),
    );

    expect(intent.retrofit).toMatchObject({
      present: true,
      complete: true,
      context: {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "master",
        targetBranch: "medhok-monorepo-3.17",
      },
      targetBranches: [
        "medhok-monorepo-3.17",
        "medhok-monorepo-3.18",
        "medhok-monorepo-3.19",
      ],
      skippedTargetBranches: [],
    });
    expect(intent.positiveBranchHints.map((hint) => hint.value)).toEqual([
      "medhok-monorepo-3.17",
      "medhok-monorepo-3.18",
      "medhok-monorepo-3.19",
    ]);
  });

  it("parses repeated retrofit target lines, dedupes, and caps selected targets at seven", () => {
    const intent = parseTicketIntent(
      [
        "Repo: medhok-monorepo",
        "Retrofit: CPDEV-1234",
        "From: master",
        "Target: medhok-monorepo-3.17, medhok-monorepo-3.18",
        "Target: medhok-monorepo-3.18, medhok-monorepo-3.19",
        "Target: medhok-monorepo-3.20",
        "Target: medhok-monorepo-4.0",
        "Target: medhok-monorepo-4.1",
        "Target: medhok-monorepo-4.2",
        "Target: medhok-monorepo-4.3",
      ].join("\n"),
    );

    expect(intent.retrofit.targetBranches).toEqual([
      "medhok-monorepo-3.17",
      "medhok-monorepo-3.18",
      "medhok-monorepo-3.19",
      "medhok-monorepo-3.20",
      "medhok-monorepo-4.0",
      "medhok-monorepo-4.1",
      "medhok-monorepo-4.2",
    ]);
    expect(intent.retrofit.skippedTargetBranches).toEqual([
      "medhok-monorepo-4.3",
    ]);
  });

  it("parses split field/value lines from Jira ADF formatting", () => {
    const intent = parseTicketIntent(
      [
        "Repo:",
        "cp-batch-monorepo",
        "Retrofit:",
        "CPDEV-1234",
        "From:",
        "batch-monorepo-master",
        "Target:",
        "batch-monorepo-3.18",
      ].join("\n"),
    );

    expect(intent.repoHint).toMatchObject({
      kind: "repo",
      value: "cp-batch-monorepo",
    });
    expect(intent.retrofit).toMatchObject({
      present: true,
      complete: true,
      context: {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "batch-monorepo-master",
        targetBranch: "batch-monorepo-3.18",
      },
    });
    expect(intent.positiveBranchHints[0]).toMatchObject({
      kind: "retrofit_target",
      value: "batch-monorepo-3.18",
    });
  });

  it("normalizes ADF descriptions before ticket-intent parsing", () => {
    const intent = parseTicketIntent(
      normalizeTicketIntentDescription({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Repo:" }],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "cp-batch-monorepo" }],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "Target:" }],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "batch-monorepo-3.18" }],
          },
        ],
      }),
    );

    expect(intent.repoHint).toMatchObject({
      kind: "repo",
      value: "cp-batch-monorepo",
    });
    expect(intent.positiveBranchHints[0]).toMatchObject({
      kind: "retrofit_target",
      value: "batch-monorepo-3.18",
    });
  });

  it("normalizes Jira smart-link retrofit keys before parsing", () => {
    const intent = parseTicketIntent(
      normalizeTicketIntentDescription({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Retrofit: " },
              {
                type: "inlineCard",
                attrs: {
                  url: "https://mhkjira.atlassian.net/browse/CPDEV-18876",
                },
              },
            ],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "From: medhok-monorepo-4.1" }],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "Target: medhok-monorepo-3.17" }],
          },
        ],
      }),
    );

    expect(intent.retrofit).toMatchObject({
      present: true,
      complete: true,
      context: {
        sourceJiraKey: "CPDEV-18876",
        sourceBranch: "medhok-monorepo-4.1",
        targetBranch: "medhok-monorepo-3.17",
      },
    });
  });

  it("parses markdown-bold field labels and trims punctuation", () => {
    const intent = parseTicketIntent(
      "**Repo:** `cp-batch-monorepo`,\n**Target Branch:** batch-monorepo-3.18.",
    );

    expect(intent.repoHint).toMatchObject({
      kind: "repo",
      value: "cp-batch-monorepo",
    });
    expect(intent.positiveBranchHints[0]).toMatchObject({
      kind: "target_branch",
      value: "batch-monorepo-3.18",
    });
  });

  it("marks partial retrofit blocks as malformed", () => {
    const intent = parseTicketIntent("Retrofit: CPDEV-1234\nTarget: release-1");

    expect(intent.retrofit.present).toBe(true);
    expect(intent.retrofit.complete).toBe(false);
    expect(intent.retrofit.missingFields).toEqual(["from"]);
  });

  it("does not treat a lone From field as a retrofit block", () => {
    const intent = parseTicketIntent(
      "From: old-approach\nUpdate processing to use the new approach.",
    );

    expect(intent.retrofit.present).toBe(false);
    expect(intent.retrofit.complete).toBe(false);
    expect(intent.retrofit.missingFields).toEqual([]);
  });

  it("marks From plus Target without Retrofit as malformed retrofit", () => {
    const intent = parseTicketIntent(
      "From: batch-monorepo-master\nTarget: batch-monorepo-3.18",
    );

    expect(intent.retrofit.present).toBe(true);
    expect(intent.retrofit.complete).toBe(false);
    expect(intent.retrofit.missingFields).toEqual(["retrofit"]);
  });

  it("records negated branch hints instead of selecting them", () => {
    const intent = parseTicketIntent(
      "Target Branch: batch-monorepo-3.11\nDo not use fix/mm-member-merge-jbpm-log4j.",
    );

    expect(intent.positiveBranchHints).toEqual([
      expect.objectContaining({
        kind: "target_branch",
        value: "batch-monorepo-3.11",
      }),
    ]);
    expect(intent.ignoredNegatedBranchHints).toEqual([
      expect.objectContaining({
        value: "fix/mm-member-merge-jbpm-log4j",
        negationPhrase: "do not use",
      }),
    ]);
  });

  it("deduplicates negated branch diagnostics on field-like lines", () => {
    const intent = parseTicketIntent("Do not use branch: fix/foo.");

    expect(intent.ignoredNegatedBranchHints).toEqual([
      expect.objectContaining({
        value: "fix/foo",
        negationPhrase: "do not use",
      }),
    ]);
  });

  it("records multiple negated branches without noisy prose tokens", () => {
    const intent = parseTicketIntent(
      "Do not use fix/foo or hotfix/bar; avoid a-b and foo.bar.",
    );

    expect(intent.ignoredNegatedBranchHints.map((hint) => hint.value)).toEqual([
      "fix/foo",
      "hotfix/bar",
    ]);
  });

  it("detects retrofit target conflicts with separate branch fields", () => {
    const intent = parseTicketIntent(
      [
        "Retrofit: CPDEV-1234",
        "From: batch-monorepo-master",
        "Target: batch-monorepo-3.18",
        "Target Branch: batch-monorepo-3.11",
      ].join("\n"),
    );

    expect(intent.branchConflicts).toEqual([
      expect.objectContaining({
        reason: "target_conflict",
        values: ["batch-monorepo-3.18", "batch-monorepo-3.11"],
      }),
    ]);
  });
});
