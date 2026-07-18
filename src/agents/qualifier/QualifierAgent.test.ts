import { beforeEach, describe, expect, it, vi } from "vitest";
import { QualifierAgent } from "./QualifierAgent.js";

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock("../../claude-sdk/index.js", () => ({
  parseJsonFromTextWithRepair: vi.fn((output: string) => ({
    value: JSON.parse(output),
  })),
  registerCustomerWorkspace: vi.fn(() => ({
    workspaceId: "workspace",
    repoIds: ["workspace"],
  })),
  registerRepoFromPath: vi.fn(() => "repo-from-path"),
  runAgent: runAgentMock,
}));

function successfulQualification() {
  return {
    success: true,
    output: "{}",
    structuredOutput: {
      qualified: true,
      templateMatched: "cpdev_template",
      requirementsSummary: ["Capture and search PA Reference ID."],
      acceptanceCriteriaPresent: true,
      blockingReasons: [],
      nonBlockingWarnings: [],
      qualificationReasoning: "The ticket is bounded and has AC.",
      repoSelection: {
        type: "multi_repo",
        selectedRepoIds: [3, 1],
        candidateSummaries: [],
        repoReasoning:
          "batch-jobs owns ePA ingestion and core-app owns the ePA Transaction UI.",
      },
      multiRepoPlan: [
        {
          repoRef: "batch-jobs",
          objective:
            "Capture and persist PA Reference ID for inbound CoverMyMeds/ePA transactions.",
          acceptanceCriteria: [
            "Inbound ePA transactions retain PA Reference ID even when no MHK case is created.",
          ],
          mergeOrder: 1,
        },
        {
          repoRef: "core-app",
          objective:
            "Search and display PA Reference ID in the ePA Transaction UI.",
          acceptanceCriteria: [
            "Users can search ePA transactions by PA Reference ID and see the value in results.",
          ],
          mergeOrder: 2,
        },
      ],
    },
    metrics: {
      durationMs: 10,
      toolCalls: 1,
    },
  };
}

describe("QualifierAgent prompt contract", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
    runAgentMock.mockResolvedValue(successfulQualification());
  });

  it("instructs inferred distinct repo-owned workstreams to use multi_repo", async () => {
    const agent = new QualifierAgent({ modelId: "test-model" });

    await agent.assessQualification({
      jiraKey: "CPDEV-19674",
      summary: "[PerformRX] Ability to search ePA Cases in UI search",
      ticketText:
        "Capture PA Reference ID on inbound CoverMyMeds transactions and make the ePA Transaction UI searchable by that ID.",
      profiledRepoCatalog: [
        "id=3 name=batch-jobs domains: epa-schedulers, CoverMyMeds ingestion",
        "id=1 name=core-app domains: ePA Transaction UI, SmartGWT search grids",
      ].join("\n"),
    });

    const prompt = runAgentMock.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toMatch(
      /Use multi_repo when ticket requirements map cleanly to distinct\s+repo-owned slices inferred from the profiled repo catalog/,
    );
    expect(prompt).toMatch(
      /needs_confirmation is for same-slice ambiguity, not for distinct\s+repo-owned slices/,
    );
    expect(prompt).toMatch(
      /batch-jobs owns\s+scheduler\/CoverMyMeds ingestion and PA Reference ID persistence/,
    );
    expect(prompt).toContain("core-app");
    expect(prompt).toContain("owns ePA Transaction UI search");
    expect(prompt).toContain("result-grid display");
    expect(prompt).toContain("repo-scoped objective");
    expect(prompt).toContain("repo-scoped acceptanceCriteria");
    expect(prompt).toContain("mergeOrder");
  });

  it("treats explicit multi-repo mentions as evidence for multi_repo instead of a lock", async () => {
    const agent = new QualifierAgent({ modelId: "test-model" });

    await agent.assessQualification({
      jiraKey: "CPDEV-25097",
      summary: "Member merge status guard and UI controls",
      ticketText: [
        "Repo: cp-medhok-monorepo, cp-batch-monorepo",
        "cp-medhok-monorepo owns the UI guard, server guard, system variable, and Flyway migration.",
        "cp-batch-monorepo owns the batch MemberMergeDAO guard/property work.",
      ].join("\n"),
      profiledRepoCatalog: [
        "id=1 name=core-app aliases: cp-medhok-monorepo domains: primary-ui, api, flyway",
        "id=3 name=batch-jobs aliases: cp-batch-monorepo domains: batch, MemberMergeDAO",
      ].join("\n"),
    });

    const prompt = runAgentMock.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("Repo mentions are evidence, not authority");
    expect(prompt).toContain("explicit repo mentions do not lock repo selection");
    expect(prompt).toContain("CPDEV-25097");
    expect(prompt).toContain("cp-medhok-monorepo");
    expect(prompt).toContain("cp-batch-monorepo");
    expect(prompt).toContain("MemberMergeDAO");
    expect(prompt).toContain("multi_repo");
    expect(prompt).not.toContain("REPO SELECTION IS LOCKED");
    expect(prompt).not.toContain(
      'If the ticket explicitly names a repo, output "explicit_github" and STOP',
    );
  });

  it("instructs multi-target retrofit tickets to use multiBranchRetrofitPlan", async () => {
    const agent = new QualifierAgent({ modelId: "test-model" });

    await agent.assessQualification({
      jiraKey: "CPDEV-23958",
      summary: "Retrofit CPDEV-1234 to multiple medhok branches",
      ticketText: [
        "Retrofit: CPDEV-1234",
        "Repo: medhok-monorepo",
        "From: master",
        "Target: medhok-monorepo-3.17, medhok-monorepo-3.18, medhok-monorepo-3.19",
      ].join("\n"),
      profiledRepoCatalog:
        "id=1 name=core-app repo=medhok-monorepo domains: core medhok monorepo",
    });

    const prompt = runAgentMock.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("multiBranchRetrofitPlan");
    expect(prompt).toContain("single-target retrofit");
    expect(prompt).toContain("retrofitContext");
    expect(prompt).toContain("first 7 target branches");
    expect(prompt).toContain("skippedTargetBranches");
    expect(prompt).toContain("need another ticket");
  });

  it("does not accept locked repo-selection inputs", async () => {
    const agent = new QualifierAgent({ modelId: "test-model" });

    await agent.assessQualification({
      jiraKey: "CPDEV-22348",
      summary: "Medical Appeals date field",
      ticketText:
        "Repo: cp-mhk-smart-prominence\nAcceptance Criteria: update the field.",
      profiledRepoCatalog:
        "(repo selection locked to React-based-new-ui from explicit ticket hint cp-mhk-smart-prominence)",
      repoSelectionLocked: true,
      explicitRepoHint: "cp-mhk-smart-prominence",
      resolvedRepoName: "React-based-new-ui",
    } as any);

    const prompt = runAgentMock.mock.calls[0][0].taskPrompt as string;
    expect(prompt).not.toContain("REPO SELECTION IS LOCKED");
    expect(prompt).toContain("cp-mhk-smart-prominence");
    expect(prompt).toContain("Repo mentions are evidence, not authority");
    expect(prompt).toContain("Walk every profiled repo");
    expect(prompt).not.toContain("Your remaining job is readiness");
  });

  it("treats unsupported attachment formats as non-blocking evidence gaps", async () => {
    const agent = new QualifierAgent({ modelId: "test-model" });

    await agent.assessQualification({
      jiraKey: "CPSUP-43828",
      summary: "Auto-Generated Approved/Denied KPI Report",
      ticketText:
        "Attachment Review Reference\nReviewed Attachments\n- `requirements.docx`: DOCX text extracted\nNot Reviewed / Metadata Only\n- `AULTC Report Format.xlsx`: unsupported spreadsheet attachment; metadata only",
      profiledRepoCatalog: "id=3 name=batch-jobs domains: reporting",
    });

    const prompt = runAgentMock.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("Attachment evidence policy");
    expect(prompt).toContain(
      "Treat unsupported/skipped attachments, unsupported spreadsheets",
    );
    expect(prompt).toContain("non-blocking evidence gaps");
    expect(prompt).toContain("file_format_unspecified");
    expect(prompt).toContain("column_list_unavailable");
    expect(prompt).toContain("Still reject for real intake blockers");
  });

  it("includes factory builder repo override while preserving readiness rejection", async () => {
    const agent = new QualifierAgent({ modelId: "test-model" });

    await agent.assessQualification({
      jiraKey: "CPDEV-25479",
      summary: "OneShot Factory Builder task",
      ticketText:
        "Build a new factory implementation. Acceptance Criteria: factory tasks route to Enterprise AI Agent Platform.",
      profiledRepoCatalog:
        "id=9 name=Ai-agents aliases: enterprise-ai-agent-platform domains: controller agents, processing agents",
      repoRoutingOverride: {
        targetRepoId: 9,
        targetRepoName: "Ai-agents",
        targetGithubSlug: "enterprise-ai-agent-platform",
        reason: "oneshot-factory-builder label is present with PFOS.",
      },
    });

    const prompt = runAgentMock.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("HARD REPO ROUTING OVERRIDE");
    expect(prompt).toContain("repoSelection.type=\"profiled_repo\"");
    expect(prompt).toContain("selectedRepoIds=[9]");
    expect(prompt).toContain("Ai-agents");
    expect(prompt).toContain("enterprise-ai-agent-platform");
    expect(prompt).toContain("Still reject");
    expect(prompt).toContain("acceptance criteria");
  });
});
