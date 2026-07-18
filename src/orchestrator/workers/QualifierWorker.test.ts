import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QualifierWorker,
  buildRawQualificationText,
  classifyQualifierNoActionReason,
  extractAcceptanceCriteriaText,
  extractEpicKey,
  extractParentEpicTitle,
  normalizeAttachmentGapOnlyQualificationRejection,
  stringifyJiraFieldValue,
  type QualifierJiraIssue,
} from "./QualifierWorker.js";
import { OneShotService } from "../../oneshot/service.js";
import { resolveBranchForQualification } from "../../oneshot/branch-resolution.js";
import { resolveExplicitRepoHint } from "../../oneshot/explicit-repo-resolution.js";
import { getProfiledRepoSummariesForLlm } from "../../oneshot/qualifier-repo-context.js";
import {
  RetrofitSourceEvidenceLookupError,
  resolveRetrofitRepoMatches,
} from "../../oneshot/retrofit-repo-resolution.js";
import { extractOneShotQualifierComment } from "../../oneshot/jira-comments.js";
import type { CodeRepository } from "../database.js";
import type { QualificationAssessment } from "../../oneshot/schema/qualification.js";

vi.mock("../../oneshot/branch-resolution.js", () => ({
  resolveBranchForQualification: vi.fn(),
}));
vi.mock("../../oneshot/explicit-repo-resolution.js", () => ({
  resolveExplicitRepoHint: vi.fn(),
}));
vi.mock("../../oneshot/retrofit-repo-resolution.js", () => ({
  extractGitHubPullRequestUrlsFromText: (text: string) =>
    Array.from(
      text.matchAll(
        /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g,
      ),
      (match) => match[0],
    ),
  RetrofitSourceEvidenceLookupError: class RetrofitSourceEvidenceLookupError extends Error {
    readonly retryable = true;
    constructor(message: string, readonly causeDescription?: string) {
      super(message);
      this.name = "RetrofitSourceEvidenceLookupError";
    }
  },
  resolveRetrofitRepoMatches: vi.fn(),
}));
vi.mock("../../oneshot/qualifier-repo-context.js", () => ({
  getProfiledRepoSummariesForLlm: vi.fn().mockResolvedValue([]),
  formatProfiledRepoSummariesForPrompt: vi.fn().mockReturnValue("(none)"),
}));

describe("QualifierWorker Jira field helpers", () => {
  it("extracts acceptance criteria from Jira custom fields discovered through expand=names", () => {
    const issue: QualifierJiraIssue = {
      key: "CPDEV-1",
      names: { customfield_12345: "Acceptance Criteria" },
      fields: {
        summary: "Add member search filter",
        customfield_12345: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Given a member search," },
                { type: "text", text: " when a filter is selected," },
                { type: "text", text: " then the results should update." },
              ],
            },
          ],
        },
      },
    };

    expect(extractAcceptanceCriteriaText(issue)).toContain(
      "Given a member search",
    );
  });

  it("includes parent epic title in raw qualification text", () => {
    const issue: QualifierJiraIssue = {
      key: "CPDEV-2",
      fields: {
        summary: "Add reporting dashboard filters",
        description: "Implement filters for the report.",
        parent: {
          key: "CPDEV-1",
          fields: { summary: "[DV] Reporting dashboard epic" },
        },
      },
    };

    expect(extractParentEpicTitle(issue)).toBe("[DV] Reporting dashboard epic");
    expect(buildRawQualificationText(issue)).toContain(
      "[DV] Reporting dashboard epic",
    );
  });

  it("extracts the Epic key from Epics and direct child stories", () => {
    expect(
      extractEpicKey({
        key: "CPDEV-1",
        fields: {
          summary: "Reporting dashboard epic",
          issuetype: { name: "Epic" },
        },
      }),
    ).toBe("CPDEV-1");

    expect(
      extractEpicKey({
        key: "CPDEV-2",
        fields: {
          summary: "Add reporting dashboard filters",
          issuetype: { name: "Story" },
          parent: {
            key: "CPDEV-1",
            fields: { summary: "Reporting dashboard epic" },
          },
        },
      }),
    ).toBe("CPDEV-1");
  });

  it("does not assign a shared Epic branch to subtasks", () => {
    expect(
      extractEpicKey({
        key: "CPDEV-3",
        fields: {
          summary: "Wire dashboard filter field",
          issuetype: { name: "Sub-task", subtask: true } as never,
          parent: {
            key: "CPDEV-2",
            fields: { summary: "Add reporting dashboard filters" },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("stringifies Atlassian document format fields into plain text", () => {
    const text = stringifyJiraFieldValue({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Line one" }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Line two" }],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(text).toContain("Line one");
    expect(text).toContain("Line two");
  });

  it("classifies already-queued qualifier tasks with missing PFOS as no-action", () => {
    expect(classifyQualifierNoActionReason([], null).reasonCode).toBe(
      "pfos_label_missing_at_processing",
    );
  });

  it("classifies stale PFOS-NOT-QUALIFIED labels as no-action for fresh tickets", () => {
    expect(
      classifyQualifierNoActionReason(["PFOS", "PFOS-NOT-QUALIFIED"], null)
        .reasonCode,
    ).toBe("pfos_not_qualified_label_present");
  });

  it("classifies non-actionable existing run states as no-action", () => {
    expect(
      classifyQualifierNoActionReason(["PFOS"], "completed").reasonCode,
    ).toBe("existing_run_not_actionable");
  });
});

const reactRepo: CodeRepository = {
  id: 5,
  repo_name: "React-based-new-ui",
  repo_url: "https://github.com/mhk-repos/cp-mhk-smart-prominence.git",
  description: "React UI",
  default_branch: "master",
  created_at: new Date(),
} as any;

const batchRepo: CodeRepository = {
  id: 3,
  repo_name: "batch-jobs",
  repo_url: "https://github.com/mhk-repos/cp-batch-monorepo.git",
  description: "Batch",
  default_branch: "master",
  created_at: new Date(),
} as any;

const coreAppRepo: CodeRepository = {
  id: 1,
  repo_name: "core-app",
  repo_url: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
  description: "Core application UI and services",
  default_branch: "master",
  created_at: new Date(),
} as any;

const interopRepo: CodeRepository = {
  id: 6,
  repo_name: "interop",
  repo_url: "https://github.com/mhk-repos/cp-interoperability-monorepo.git",
  description: "Interop",
  default_branch: "master",
  created_at: new Date(),
} as any;

const quickSightRepo: CodeRepository = {
  id: 77,
  repo_name: "cp-quicksightassets",
  repo_url: "https://github.com/mhk-repos/cp-quicksightassets.git",
  description: "QuickSight assets",
  default_branch: "main",
  created_at: new Date(),
} as any;

const aiAgentsRepo: CodeRepository = {
  id: 9,
  repo_name: "Ai-agents",
  repo_url: "https://github.com/mhk-repos/enterprise-ai-agent-platform.git",
  description: "AI agents",
  default_branch: "main",
  created_at: new Date(),
} as any;

const customerBranch = {
  id: 25,
  customer: "Default",
  branch: "master",
} as any;

function emptyRetrofitRepoResolution() {
  return {
    matches: [],
    profileMatches: [],
    evidenceMatches: [],
    resolutionSource: "none",
    profileAmbiguityWarnings: [],
    warnings: [],
    commitEvidenceInspectedRepoNames: [],
  } as any;
}

function sourceEvidenceFor(
  repo: CodeRepository,
  context: {
    sourceJiraKey: string;
    sourceBranch: string;
    targetBranch: string;
  },
  files = [
    "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
  ],
) {
  return {
    sourceJiraKey: context.sourceJiraKey,
    sourceBranch: context.sourceBranch,
    targetBranch: context.targetBranch,
    sourceRepoName: repo.repo_name,
    sourceRepoUrl: repo.repo_url,
    selectedCommits: [
      {
        sha: "de882e2",
        subject: `${context.sourceJiraKey} source change`,
        files,
        patchSummary: `diff --git a/${files[0]} b/${files[0]}\n+fieldValues.setSortField("uiComponentValuesDisplay");`,
      },
    ],
    touchedFiles: files,
    evidenceSummary: `Resolved source evidence for ${context.sourceJiraKey} in ${repo.repo_name}.`,
  };
}

function retrofitResolutionFor(
  repo: CodeRepository,
  context: {
    sourceJiraKey: string;
    sourceBranch: string;
    targetBranch: string;
  },
) {
  const sourceEvidence = sourceEvidenceFor(repo, context);
  return {
    matches: [
      {
        repo,
        source: "commit_evidence",
        matchingCommits: sourceEvidence.selectedCommits,
        profileMatch: null,
        sourceEvidence,
      },
    ],
    profileMatches: [],
    evidenceMatches: [],
    resolutionSource: "commit_evidence",
    profileAmbiguityWarnings: [],
    warnings: [],
    commitEvidenceInspectedRepoNames: [repo.repo_name],
  } as any;
}

function buildAssessment(
  overrides: Partial<QualificationAssessment> = {},
): QualificationAssessment {
  return {
    qualified: true,
    templateMatched: "cpdev_template",
    requirementsSummary: ["Implement the change."],
    acceptanceCriteriaPresent: true,
    blockingReasons: [],
    nonBlockingWarnings: [],
    qualificationReasoning: "Ticket is bounded.",
    repoSelection: {
      type: "profiled_repo",
      selectedRepoIds: [reactRepo.id],
      candidateSummaries: [],
      repoReasoning: "Matches React UI summary.",
    },
    repoInspectionPerformed: false,
    inspectedFiles: [],
    inspectionSummary: undefined,
    repoId: undefined,
    branchName: undefined,
    baseCommitSha: undefined,
    retrofitContext: undefined,
    ...overrides,
  } as QualificationAssessment;
}

interface DispatcherHarnessOptions {
  assessment: QualificationAssessment;
  availableRepos?: CodeRepository[];
  taskManagement?: {
    id: number;
    customer_id: number;
    related_code: string | null;
    task_s3_bucket?: string | null;
    task_s3_key?: string | null;
  };
}

function buildDispatcherHarness(options: DispatcherHarnessOptions) {
  const taskManagement = options.taskManagement ?? {
    id: 2489,
    customer_id: customerBranch.id,
    related_code: "",
  };
  const availableRepos = options.availableRepos ?? [reactRepo, batchRepo];

  const worker = new QualifierWorker("/tmp", false) as any;
  worker.db = {
    getAllRepositories: vi.fn().mockResolvedValue(availableRepos),
    getRepositoryById: vi
      .fn()
      .mockImplementation(
        async (id: number) =>
          availableRepos.find((repo) => repo.id === id) ?? null,
      ),
    updateTaskManagementStatus: vi.fn().mockResolvedValue(undefined),
    parkQualifierForRepoConfirmation: vi
      .fn()
      .mockResolvedValue({ routerDecisionId: 99, routerConfirmationId: 7 }),
  };
  worker.storage = {
    downloadResult: vi.fn().mockResolvedValue(
      JSON.stringify({
        schemaVersion: "ticket-evidence.v1",
        jiraKey: "CPDEV-22348",
        stats: {
          commentCount: 3,
          attachmentCount: 2,
          extractedAttachmentCount: 1,
          imageAttachmentCount: 1,
          warningCount: 1,
        },
      }),
    ),
  };

  const assessQualification = vi
    .fn()
    .mockResolvedValue({ assessment: options.assessment, metrics: undefined });
  vi.spyOn(worker, "getQualifierAgent").mockReturnValue({
    assessQualification,
  });

  vi.mocked(resolveBranchForQualification).mockResolvedValue({
    branchName: "master",
    baseCommitSha: "abc123def456",
    blockingReasons: [],
    branchCandidates: [],
    resolutionSource: "default",
    selectedBranchHint: undefined,
    positiveBranchHints: [],
    ignoredNegatedBranchHints: [],
    branchConflicts: [],
    retrofitContext: undefined,
  } as any);

  const ensureNotQualifiedLabel = vi
    .spyOn(worker, "ensureNotQualifiedLabel")
    .mockResolvedValue(undefined);

  const createQualifiedRun = vi
    .fn()
    .mockResolvedValue({ runId: 87, publishError: null });
  const oneShotService = { createQualifiedRun } as any;

  return {
    worker,
    assessQualification,
    createQualifiedRun,
    ensureNotQualifiedLabel,
    oneShotService,
    taskManagement,
  };
}

async function runDispatcher(
  worker: any,
  jiraIssue: QualifierJiraIssue,
  taskManagement: {
    id: number;
    customer_id: number;
    related_code: string | null;
    task_s3_bucket?: string | null;
    task_s3_key?: string | null;
  },
  oneShotService: any,
  options: { taskDescription?: string } = {},
) {
  return worker.handleFreshQualification(
    {
      jiraIssue,
      taskDescription:
        options.taskDescription ??
        stringifyJiraFieldValue(jiraIssue.fields.description),
      additionalContext: "",
      taskRoutingPath: "/tmp/qualifier-routing",
      taskManagement,
      customerBranch,
    },
    oneShotService,
    null,
    Date.now(),
  );
}

describe("normalizeAttachmentGapOnlyQualificationRejection", () => {
  it("demotes attachment format and column gaps when the ticket is otherwise concrete", () => {
    const assessment = buildAssessment({
      qualified: false,
      blockingReasons: [
        "file_format_unspecified: output file format XLS/XLSX/CSV unconfirmed",
        "column_list_unavailable: final column structure defined only in binary attachment",
      ],
      nonBlockingWarnings: ["Existing warning"],
    });

    const normalized =
      normalizeAttachmentGapOnlyQualificationRejection(assessment);

    expect(normalized.qualified).toBe(true);
    expect(normalized.blockingReasons).toEqual([]);
    expect(normalized.nonBlockingWarnings).toEqual(
      expect.arrayContaining([
        "Existing warning",
        expect.stringContaining("file_format_unspecified"),
        expect.stringContaining("column_list_unavailable"),
      ]),
    );
  });

  it("does not demote real readiness blockers", () => {
    const assessment = buildAssessment({
      qualified: false,
      acceptanceCriteriaPresent: false,
      blockingReasons: [
        "acceptance_criteria_missing",
        "file_format_unspecified",
      ],
    });

    expect(normalizeAttachmentGapOnlyQualificationRejection(assessment)).toBe(
      assessment,
    );
  });
});

describe("QualifierWorker dispatcher", () => {
  beforeEach(() => {
    vi.mocked(resolveExplicitRepoHint).mockReset();
    vi.mocked(resolveRetrofitRepoMatches).mockReset();
    vi.mocked(resolveRetrofitRepoMatches).mockResolvedValue(
      emptyRetrofitRepoResolution(),
    );
    vi.mocked(resolveBranchForQualification).mockReset();
    vi.mocked(getProfiledRepoSummariesForLlm).mockReset();
    vi.mocked(getProfiledRepoSummariesForLlm).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes a routing workspace to the QUALIFIER LLM when related_code is empty", async () => {
    const assessment = buildAssessment({
      qualified: false,
      repoSelection: {
        type: "no_match",
        selectedRepoIds: [],
        candidateSummaries: [],
        repoReasoning: "No profiled repo matched.",
      },
      blockingReasons: ["Ticket is not ready."],
    });
    const harness = buildDispatcherHarness({ assessment });

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-22347",
        fields: {
          summary: "Require notes field on React screen",
          description: "Require the notes field on the React screen.",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.assessQualification).toHaveBeenCalledWith(
      expect.objectContaining({
        taskRoutingPath: "/tmp/qualifier-routing",
        staleRelatedCodeRepoNames: [],
        customerContext: expect.stringContaining("customer branch setting"),
      }),
    );
    const llmInput = harness.assessQualification.mock.calls[0][0];
    expect(llmInput.customerContext).not.toContain("default branch");
  });

  it("demotes attachment-only blockers and still creates a qualified run", async () => {
    const assessment = buildAssessment({
      qualified: false,
      blockingReasons: [
        "file_format_unspecified: output file format XLS/XLSX/CSV unconfirmed",
        "column_list_unavailable: final column structure defined only in binary attachment AULTC Report Format.xlsx",
      ],
      nonBlockingWarnings: ["SFTP details need planner validation."],
    });
    const harness = buildDispatcherHarness({ assessment });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPSUP-43828",
        fields: {
          summary: "Auto-Generated Approved/Denied KPI Report",
          description:
            "Acceptance Criteria: Generate Approved/Denied KPI report.",
          issuetype: { name: "Story" },
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
      {
        taskDescription:
          "## Attachment Review Reference\n\n### Reviewed Attachments\n- `requirements.docx`: DOCX text extracted\n\n### Not Reviewed / Metadata Only\n- `AULTC Report Format.xlsx`: unsupported spreadsheet attachment; metadata only",
      },
    );

    expect(result.success).toBe(true);
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    expect(harness.createQualifiedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jiraKey: "CPSUP-43828",
        qualification: expect.objectContaining({
          qualified: true,
          blockingReasons: [],
          nonBlockingWarnings: expect.arrayContaining([
            "SFTP details need planner validation.",
            expect.stringContaining("file_format_unspecified"),
            expect.stringContaining("column_list_unavailable"),
          ]),
        }),
      }),
    );
  });

  it("explicit_github: resolves through GitHub and creates a qualified run", async () => {
    vi.mocked(resolveExplicitRepoHint).mockResolvedValue({
      repo: reactRepo,
      profileStatus: "github_resolved",
      selectedReason: "explicit_github_repo",
      explicitRepoHint: "cp-mhk-smart-prominence",
      registeredCandidates: [],
      githubCandidates: ["mhk-repos/cp-mhk-smart-prominence"],
      blockingReasons: [],
    });
    const assessment = buildAssessment({
      repoSelection: {
        type: "explicit_github",
        explicitRepoRef: "cp-mhk-smart-prominence",
        selectedRepoIds: [],
        candidateSummaries: [],
        repoReasoning: "Ticket explicitly names the repo.",
      },
    });
    const harness = buildDispatcherHarness({ assessment });
    vi.mocked(resolveBranchForQualification).mockResolvedValue({
      branchName: "master",
      baseCommitSha: "abc123def456",
      blockingReasons: [],
      branchCandidates: [],
      resolutionSource: "default",
      selectedBranchHint: undefined,
      positiveBranchHints: [],
      ignoredNegatedBranchHints: [],
      branchConflicts: [],
      retrofitContext: undefined,
    } as any);

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-22347",
        fields: {
          summary: "Medical Appeals date field",
          description: "Repo: cp-mhk-smart-prominence",
          issuetype: { name: "Story" },
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(true);
    expect(harness.createQualifiedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jiraKey: "CPDEV-22347",
        repo: reactRepo,
        branchName: "master",
        baseCommitSha: "abc123def456",
        jiraIssueType: "Story",
        qualificationProvider: "qualifier_llm",
      }),
    );
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
  });

  it("passes generated task description and ticket evidence ref into OneShot run creation", async () => {
    const harness = buildDispatcherHarness({
      assessment: buildAssessment(),
      taskManagement: {
        id: 2489,
        customer_id: customerBranch.id,
        related_code: "",
        task_s3_bucket: "specter-tasks",
        task_s3_key: "tasks/CPDEV-22348/2026-06-17.md",
      },
    } as any);

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-22348",
        fields: {
          summary: "Medical Appeals date field",
          description: "Raw Jira description",
          issuetype: { name: "Story" },
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
      { taskDescription: "Generated task summary with comments and attachments" },
    );

    expect(result.success).toBe(true);
    const call = harness.createQualifiedRun.mock.calls[0][0];
    expect(call.taskDescription).toBe(
      "Generated task summary with comments and attachments",
    );
    expect(call.taskDescription).not.toBe("Raw Jira description");
    expect(call.ticketEvidenceRef).toEqual({
      schemaVersion: "ticket-evidence.v1",
      bucket: "specter-tasks",
      key: "tasks/CPDEV-22348/2026-06-17.ticket-evidence.v1.json",
      stats: {
        commentCount: 3,
        attachmentCount: 2,
        extractedAttachmentCount: 1,
        imageAttachmentCount: 1,
        warningCount: 1,
      },
    });
  });

  it("does not use generated OneShot comments as deterministic explicit repo hints", async () => {
    const harness = buildDispatcherHarness({
      assessment: buildAssessment({
        repoSelection: {
          type: "profiled_repo",
          selectedRepoIds: [reactRepo.id],
          candidateSummaries: [],
          repoReasoning: "The original ticket maps to the React UI repo.",
        },
      }),
      availableRepos: [reactRepo, coreAppRepo],
    });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-23734",
        fields: {
          summary: "Member Search: Style Cancel button",
          description:
            "Style the Member Search Cancel button. No explicit repository field is present.",
          issuetype: { name: "Story" },
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
      {
        taskDescription:
          "## OneShot | Implementation Plan Ready\n" +
          "**Repo:** `core-app` | **Current Draft PR**: [#2427](https://github.com/mhk-repos/cp-medhok-monorepo/pull/2427)\n",
      },
    );

    expect(result.success).toBe(true);
    expect(resolveExplicitRepoHint).not.toHaveBeenCalled();
    expect(harness.createQualifiedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: reactRepo,
      }),
    );
  });

  it("omits ticket evidence ref when the derived evidence artifact cannot be verified", async () => {
    const harness = buildDispatcherHarness({
      assessment: buildAssessment(),
      taskManagement: {
        id: 2489,
        customer_id: customerBranch.id,
        related_code: "",
        task_s3_bucket: "specter-tasks",
        task_s3_key: "tasks/CPDEV-22348/2026-06-17.md",
      },
    } as any);
    harness.worker.storage.downloadResult.mockRejectedValueOnce(
      new Error("NoSuchKey"),
    );

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-22348",
        fields: {
          summary: "Medical Appeals date field",
          description: "Raw Jira description",
          issuetype: { name: "Story" },
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
      { taskDescription: "Generated task summary with comments and attachments" },
    );

    expect(result.success).toBe(true);
    const call = harness.createQualifiedRun.mock.calls[0][0];
    expect(call.ticketEvidenceRef).toBeUndefined();
  });

  it("omits ticket evidence ref when the evidence stats are malformed", async () => {
    const harness = buildDispatcherHarness({
      assessment: buildAssessment(),
      taskManagement: {
        id: 2489,
        customer_id: customerBranch.id,
        related_code: "",
        task_s3_bucket: "specter-tasks",
        task_s3_key: "tasks/CPDEV-22348/2026-06-17.md",
      },
    } as any);
    harness.worker.storage.downloadResult.mockResolvedValueOnce(
      JSON.stringify({
        schemaVersion: "ticket-evidence.v1",
        jiraKey: "CPDEV-22348",
        stats: {
          commentCount: 3,
        },
      }),
    );

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-22348",
        fields: {
          summary: "Medical Appeals date field",
          description: "Raw Jira description",
          issuetype: { name: "Story" },
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
      { taskDescription: "Generated task summary with comments and attachments" },
    );

    expect(result.success).toBe(true);
    const call = harness.createQualifiedRun.mock.calls[0][0];
    expect(call.ticketEvidenceRef).toBeUndefined();
  });

  it("calls the LLM before repo binding and creates a CPDEV-25097-style multi-repo group", async () => {
    const cpdev25097Assessment = buildAssessment({
      requirementsSummary: [
        "Add member merge guards to UI/server flows and database configuration.",
        "Add the batch MemberMergeDAO guard/property work.",
      ],
      qualificationReasoning:
        "The ticket names two repos with independently scoped UI/server/Flyway and batch DAO slices.",
      repoSelection: {
        type: "multi_repo",
        selectedRepoIds: [coreAppRepo.id, batchRepo.id],
        candidateSummaries: [],
        repoReasoning:
          "core-app binds cp-medhok-monorepo; batch-jobs binds cp-batch-monorepo.",
      },
      multiRepoPlan: [
        {
          repoRef: "cp-medhok-monorepo",
          objective:
            "Update UI, server guard, system-variable, and Flyway behavior for member merge status.",
          acceptanceCriteria: [
            "UI/server flows respect the new member merge guard.",
            "System variable and Flyway migration are present in core-app.",
          ],
          mergeOrder: 1,
        },
        {
          repoRef: "cp-batch-monorepo",
          objective:
            "Update batch MemberMergeDAO guard/property handling for member merge status.",
          acceptanceCriteria: [
            "Batch MemberMergeDAO only applies the guarded behavior for the configured property.",
          ],
          mergeOrder: 2,
        },
      ],
    } as any);
    const harness = buildDispatcherHarness({
      assessment: cpdev25097Assessment,
      availableRepos: [coreAppRepo, batchRepo],
    });
    const createQualifiedRunGroup = vi.fn().mockResolvedValue({
      runGroupId: 25097,
      runIds: [250971, 250972],
      publishError: null,
    });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-25097",
        fields: {
          summary: "Member merge status guard",
          description: [
            "Repo: cp-medhok-monorepo, cp-batch-monorepo",
            "",
            "cp-medhok-monorepo owns UI, server, system-variable, and Flyway work.",
            "cp-batch-monorepo owns batch MemberMergeDAO guard/property work.",
          ].join("\n"),
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      { createQualifiedRunGroup } as any,
    );

    expect(result.success).toBe(true);
    expect(harness.assessQualification).toHaveBeenCalledWith(
      expect.objectContaining({
        ticketText: expect.stringContaining(
          "Repo: cp-medhok-monorepo, cp-batch-monorepo",
        ),
      }),
    );
    expect(resolveExplicitRepoHint).not.toHaveBeenCalled();
    expect(createQualifiedRunGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        jiraKey: "CPDEV-25097",
        groupMetadata: {
          mergeOrder: {
            "cp-medhok-monorepo": 1,
            "cp-batch-monorepo": 2,
          },
        },
        runs: expect.arrayContaining([
          expect.objectContaining({
            repo: coreAppRepo,
            repoSelectionMetadata: expect.objectContaining({
              multiRepoBrief: expect.objectContaining({
                repoRef: "cp-medhok-monorepo",
                objective: expect.stringContaining("UI"),
                acceptanceCriteria: expect.arrayContaining([
                  expect.stringContaining("Flyway"),
                ]),
              }),
            }),
          }),
          expect.objectContaining({
            repo: batchRepo,
            repoSelectionMetadata: expect.objectContaining({
              multiRepoBrief: expect.objectContaining({
                repoRef: "cp-batch-monorepo",
                objective: expect.stringContaining("MemberMergeDAO"),
                acceptanceCriteria: expect.arrayContaining([
                  expect.stringContaining("MemberMergeDAO"),
                ]),
              }),
            }),
          }),
        ]),
      }),
    );
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    expect(
      harness.worker.db.parkQualifierForRepoConfirmation,
    ).not.toHaveBeenCalled();
  });

  it("explicit repo text is LLM evidence and binds only after a valid explicit_github decision", async () => {
    vi.mocked(resolveExplicitRepoHint).mockResolvedValue({
      repo: reactRepo,
      profileStatus: "github_resolved",
      selectedReason: "explicit_github_repo",
      explicitRepoHint: "cp-mhk-smart-prominence",
      registeredCandidates: [],
      githubCandidates: ["mhk-repos/cp-mhk-smart-prominence"],
      blockingReasons: [],
    });
    const assessment = buildAssessment({
      repoSelection: {
        type: "explicit_github",
        explicitRepoRef: "cp-mhk-smart-prominence",
        selectedRepoIds: [],
        candidateSummaries: [],
        repoReasoning: "The ticket names cp-mhk-smart-prominence.",
      },
    });
    const harness = buildDispatcherHarness({ assessment });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-22348",
        fields: {
          summary: "Medical Appeals date field",
          description:
            "Repo: cp-mhk-smart-prominence\n\nAcceptance Criteria: update the Medical Appeals date field.",
          issuetype: { name: "Story" },
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(true);
    expect(getProfiledRepoSummariesForLlm).toHaveBeenCalledWith(
      expect.arrayContaining([reactRepo, batchRepo]),
    );
    expect(harness.assessQualification).toHaveBeenCalledWith(
      expect.not.objectContaining({
        repoSelectionLocked: true,
        explicitRepoHint: "cp-mhk-smart-prominence",
        resolvedRepoName: reactRepo.repo_name,
      }),
    );
    expect(resolveExplicitRepoHint).toHaveBeenCalledWith(
      expect.anything(),
      "cp-mhk-smart-prominence",
      expect.arrayContaining([reactRepo, batchRepo]),
    );
    const creationInput = harness.createQualifiedRun.mock.calls[0][0];
    expect(creationInput.repo).toBe(reactRepo);
    expect(creationInput.qualification.repoSelection).toMatchObject({
      type: "explicit_github",
      explicitRepoRef: "cp-mhk-smart-prominence",
      selectedRepoIds: [],
    });
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
  });

  it("explicit_github: parks ambiguous post-LLM repo binding", async () => {
    vi.mocked(resolveExplicitRepoHint).mockResolvedValue({
      repo: null,
      profileStatus: null,
      selectedReason: "explicit_repo_unresolved",
      explicitRepoHint: "common-name",
      registeredCandidates: ["React-based-new-ui", "batch-jobs"],
      githubCandidates: [
        "mhk-repos/cp-mhk-smart-prominence",
        "mhk-repos/cp-batch-monorepo",
      ],
      blockingReasons: ["multiple matches"],
    });
    const assessment = buildAssessment({
      repoSelection: {
        type: "explicit_github",
        explicitRepoRef: "common-name",
        selectedRepoIds: [],
        candidateSummaries: [],
        repoReasoning: "The ticket names common-name.",
      },
    });
    const harness = buildDispatcherHarness({ assessment });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-22349",
        fields: {
          summary: "Ambiguous explicit repo",
          description: "Repo: common-name",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(true);
    expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
    expect(getProfiledRepoSummariesForLlm).toHaveBeenCalled();
    expect(harness.assessQualification).toHaveBeenCalled();
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(
      harness.worker.db.parkQualifierForRepoConfirmation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: expect.arrayContaining([
          expect.objectContaining({ repoId: reactRepo.id }),
          expect.objectContaining({ repoId: batchRepo.id }),
        ]),
      }),
    );
  });

  it("explicit_github: parks unresolved post-LLM repo binding without adding PFOS-NOT-QUALIFIED", async () => {
    vi.mocked(resolveExplicitRepoHint).mockResolvedValue({
      repo: null,
      profileStatus: null,
      selectedReason: "explicit_repo_unresolved",
      explicitRepoHint: "missing-repo",
      registeredCandidates: [],
      githubCandidates: [],
      blockingReasons: [
        "explicit_repo_unresolved: Explicit Repo missing-repo could not be resolved.",
      ],
    });
    const assessment = buildAssessment({
      repoSelection: {
        type: "explicit_github",
        explicitRepoRef: "missing-repo",
        selectedRepoIds: [],
        candidateSummaries: [],
        repoReasoning: "The ticket names missing-repo.",
      },
    });
    const harness = buildDispatcherHarness({ assessment });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-22351",
        fields: {
          summary: "Missing explicit repo",
          description: "Repo: missing-repo",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(true);
    expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
    expect(getProfiledRepoSummariesForLlm).toHaveBeenCalled();
    expect(harness.assessQualification).toHaveBeenCalled();
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    const outcome = (result.metrics as any).qualifierOutcome;
    expect(outcome.reasonCode).toBe("needs_confirmation");
    const extracted = extractOneShotQualifierComment(result.output);
    expect(extracted.body).toContain("explicit_repo_unresolved");
  });

  it("explicit repo text still allows the LLM to reject ticket readiness before repo binding", async () => {
    const assessment = buildAssessment({
      qualified: false,
      repoSelection: {
        type: "explicit_github",
        explicitRepoRef: "cp-mhk-smart-prominence",
        selectedRepoIds: [],
        candidateSummaries: [],
        repoReasoning: "Repo is explicit.",
      },
      requirementsSummary: [],
      blockingReasons: ["acceptance_criteria_missing"],
      qualificationReasoning: "Acceptance criteria are missing.",
    });
    const harness = buildDispatcherHarness({ assessment });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-22350",
        fields: {
          summary: "Incomplete ticket",
          description: "Repo: cp-mhk-smart-prominence",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(true);
    expect(getProfiledRepoSummariesForLlm).toHaveBeenCalled();
    expect(resolveExplicitRepoHint).not.toHaveBeenCalled();
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(harness.ensureNotQualifiedLabel).toHaveBeenCalled();
    const extracted = extractOneShotQualifierComment(result.output);
    expect(extracted.body).toContain("acceptance_criteria_missing");
  });

  it("explicit_github: creates a qualified run for an unprofiled GitHub-resolved repo", async () => {
    vi.mocked(resolveExplicitRepoHint).mockResolvedValue({
      repo: quickSightRepo,
      profileStatus: "github_resolved",
      selectedReason: "explicit_github_repo",
      explicitRepoHint: "cp-quicksightassets",
      registeredCandidates: [],
      githubCandidates: ["mhk-repos/cp-quicksightassets"],
      blockingReasons: [],
    });
    const assessment = buildAssessment({
      repoSelection: {
        type: "explicit_github",
        explicitRepoRef: "cp-quicksightassets",
        selectedRepoIds: [],
        candidateSummaries: [],
        repoReasoning: "Ticket explicitly names the repo.",
      },
    });
    const harness = buildDispatcherHarness({ assessment });
    vi.mocked(resolveBranchForQualification).mockResolvedValue({
      branchName: "main",
      baseCommitSha: "c0a4d421841f24c6541d92c9d0076ad493915d69",
      blockingReasons: [],
      branchCandidates: ["main"],
      resolutionSource: "default_branch",
      selectedBranchHint: undefined,
      positiveBranchHints: [],
      ignoredNegatedBranchHints: [],
      branchConflicts: [],
      retrofitContext: undefined,
    } as any);

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-39999",
        fields: {
          summary: "Update QuickSight asset",
          description: "Repo: cp-quicksightassets",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(true);
    expect(harness.createQualifiedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        jiraKey: "CPDEV-39999",
        repo: quickSightRepo,
        branchName: "main",
        baseCommitSha: "c0a4d421841f24c6541d92c9d0076ad493915d69",
        qualificationProvider: "qualifier_llm",
      }),
    );
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
  });

  it("explicit_github: GitHub returns no match → parks for confirmation without PFOS-NOT-QUALIFIED", async () => {
    vi.mocked(resolveExplicitRepoHint).mockResolvedValue({
      repo: null,
      profileStatus: null,
      selectedReason: "explicit_repo_unresolved",
      explicitRepoHint: "nonexistent-repo",
      registeredCandidates: [],
      githubCandidates: [],
      blockingReasons: ["GitHub returned no match"],
    });
    const assessment = buildAssessment({
      repoSelection: {
        type: "explicit_github",
        explicitRepoRef: "nonexistent-repo",
        selectedRepoIds: [],
        candidateSummaries: [],
        repoReasoning: "Ticket explicitly names a repo.",
      },
    });
    const harness = buildDispatcherHarness({ assessment });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30002",
        fields: {
          summary: "Add",
          description: "Repo: nonexistent-repo",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(true);
    expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    expect(
      harness.worker.db.parkQualifierForRepoConfirmation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        taskManagementId: harness.taskManagement.id,
        candidates: expect.arrayContaining([
          expect.objectContaining({ repoId: reactRepo.id }),
          expect.objectContaining({ repoId: batchRepo.id }),
        ]),
      }),
    );
  });

  it("explicit_github: GitHub multi-match WITH registered candidates → parks waiting_repo_confirmation", async () => {
    vi.mocked(resolveExplicitRepoHint).mockResolvedValue({
      repo: null,
      profileStatus: null,
      selectedReason: "explicit_repo_unresolved",
      explicitRepoHint: "common-name",
      // Both candidates exist as registered repos (they match
      // reactRepo/batchRepo from the harness fixture).
      registeredCandidates: ["React-based-new-ui", "batch-jobs"],
      githubCandidates: [
        "mhk-repos/cp-mhk-smart-prominence",
        "mhk-repos/cp-batch-monorepo",
      ],
      blockingReasons: ["multiple matches"],
    });
    const assessment = buildAssessment({
      repoSelection: {
        type: "explicit_github",
        explicitRepoRef: "common-name",
        selectedRepoIds: [],
        candidateSummaries: [],
        repoReasoning: "ambiguous",
      },
    });
    const harness = buildDispatcherHarness({ assessment });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30003",
        fields: {
          summary: "Add",
          description: "Repo: common-name",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(true);
    expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(
      harness.worker.db.parkQualifierForRepoConfirmation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        taskManagementId: harness.taskManagement.id,
        candidates: expect.arrayContaining([
          expect.objectContaining({ repoId: reactRepo.id }),
          expect.objectContaining({ repoId: batchRepo.id }),
        ]),
      }),
    );
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
  });

  it("explicit_github: GitHub multi-match with zero registered candidates still parks for operator selection", async () => {
    vi.mocked(resolveExplicitRepoHint).mockResolvedValue({
      repo: null,
      profileStatus: null,
      selectedReason: "explicit_repo_unresolved",
      explicitRepoHint: "ambiguous-name",
      registeredCandidates: [],
      githubCandidates: ["mhk-repos/foo", "mhk-repos/bar"],
      blockingReasons: ["multiple matches"],
    });
    const assessment = buildAssessment({
      repoSelection: {
        type: "explicit_github",
        explicitRepoRef: "ambiguous-name",
        selectedRepoIds: [],
        candidateSummaries: [],
        repoReasoning: "ambiguous",
      },
    });
    const harness = buildDispatcherHarness({ assessment });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30015",
        fields: {
          summary: "Add",
          description: "Repo: ambiguous-name",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(true);
    expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(
      harness.worker.db.parkQualifierForRepoConfirmation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        taskManagementId: harness.taskManagement.id,
        candidates: expect.arrayContaining([
          expect.objectContaining({ repoId: reactRepo.id }),
          expect.objectContaining({ repoId: batchRepo.id }),
        ]),
      }),
    );
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    const extracted = extractOneShotQualifierComment(result.output);
    expect(extracted.body).toContain("multiple GitHub repositories");
  });

  it("profiled_repo: single id → creates a qualified run on that repo", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "profiled_repo",
        selectedRepoIds: [reactRepo.id],
        candidateSummaries: [],
        repoReasoning: "matches react ui",
      },
    });
    const harness = buildDispatcherHarness({ assessment });
    vi.mocked(resolveBranchForQualification).mockResolvedValue({
      branchName: "master",
      baseCommitSha: "abc123def456",
      blockingReasons: [],
      branchCandidates: [],
      resolutionSource: "default",
      selectedBranchHint: undefined,
      positiveBranchHints: [],
      ignoredNegatedBranchHints: [],
      branchConflicts: [],
      retrofitContext: undefined,
    } as any);

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30004",
        fields: {
          summary: "Add cancel button to React UI",
          description: "Add a cancel button to the React UI",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.createQualifiedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: reactRepo,
        qualificationProvider: "qualifier_llm",
      }),
    );
  });

  it("profiled_repo: branch lookup failure is retryable infrastructure and does not add PFOS-NOT-QUALIFIED", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "profiled_repo",
        selectedRepoIds: [reactRepo.id],
        candidateSummaries: [],
        repoReasoning: "matches react ui",
      },
    });
    const harness = buildDispatcherHarness({ assessment });
    vi.mocked(resolveBranchForQualification).mockResolvedValue({
      branchName: null,
      baseCommitSha: null,
      blockingReasons: [
        "GitHub branch lookup failed while resolving React-based-new-ui: auth failure while checking master.",
      ],
      nonBlockingWarnings: [],
      branchCandidates: ["4.3", "master"],
      resolutionSource: "none",
      selectedBranchHint: undefined,
      positiveBranchHints: [],
      ignoredNegatedBranchHints: [],
      branchConflicts: [],
      retrofitContext: undefined,
      failureKind: "branch_lookup_failed",
      failureDiagnostics: {
        status: "lookup_failed",
        failedBranchName: "master",
        failureCategory: "auth",
        sanitizedError: "fatal: Authentication failed",
      },
    } as any);

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-22945",
        fields: {
          summary: "Add Effective and Term Date functionality",
          description: "FixVersion: 4.3",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("GitHub branch lookup failed");
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
  });

  it("passes Jira description and FixVersion to branch resolution and persists fallback metadata", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "profiled_repo",
        selectedRepoIds: [reactRepo.id],
        candidateSummaries: [],
        repoReasoning: "matches react ui",
      },
    });
    const harness = buildDispatcherHarness({ assessment });
    const fallbackHint = {
      kind: "version",
      label: "Fix version",
      value: "4.0",
      line: "Fix version: 4.0",
      lineNumber: 2,
    };
    const fallbackWarning =
      "Branch hint Fix version=4.0 did not resolve on React-based-new-ui; falling back to default branch master. Tried: 4.0, master.";
    vi.mocked(resolveBranchForQualification).mockResolvedValue({
      branchName: "master",
      baseCommitSha: "abc123def456",
      blockingReasons: [],
      nonBlockingWarnings: [fallbackWarning],
      branchCandidates: ["4.0", "master"],
      resolutionSource: "default_branch",
      selectedBranchHint: fallbackHint,
      fallbackBranchHint: fallbackHint,
      positiveBranchHints: [fallbackHint],
      ignoredNegatedBranchHints: [],
      branchConflicts: [],
      retrofitContext: undefined,
    } as any);

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30016",
        fields: {
          summary: "Add cancel button to React UI",
          description: "Add a cancel button to the React UI",
          fixVersions: [{ name: "4.0" }],
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    const branchText = vi.mocked(resolveBranchForQualification).mock
      .calls[0][3];
    expect(branchText).toContain("Add a cancel button to the React UI");
    expect(branchText).toContain("Fix version: 4.0");

    const call = harness.createQualifiedRun.mock.calls[0][0];
    expect(call.qualification.nonBlockingWarnings).toEqual(
      expect.arrayContaining([fallbackWarning]),
    );
    expect(call.repoSelectionMetadata.branchResolution).toEqual(
      expect.objectContaining({
        selectedBranch: "master",
        selectedReason: "default_branch",
        selectedBranchHint: fallbackHint,
        fallbackBranchHint: fallbackHint,
        nonBlockingWarnings: [fallbackWarning],
      }),
    );
  });

  it("LLM picks profiled repo opposite to stale related_code → run uses LLM pick (non-authoritative history)", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "profiled_repo",
        selectedRepoIds: [reactRepo.id],
        candidateSummaries: [],
        repoReasoning: "ignores stale history",
      },
    });
    const harness = buildDispatcherHarness({
      assessment,
      taskManagement: {
        id: 2489,
        customer_id: customerBranch.id,
        related_code: String(batchRepo.id),
      },
    });
    vi.mocked(resolveBranchForQualification).mockResolvedValue({
      branchName: "master",
      baseCommitSha: "abc123def456",
      blockingReasons: [],
      branchCandidates: [],
      resolutionSource: "default",
      selectedBranchHint: undefined,
      positiveBranchHints: [],
      ignoredNegatedBranchHints: [],
      branchConflicts: [],
      retrofitContext: undefined,
    } as any);

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-22347",
        fields: {
          summary: "x",
          description: "x",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.createQualifiedRun).toHaveBeenCalledWith(
      expect.objectContaining({ repo: reactRepo }),
    );
  });

  it("needs_confirmation: parks task and posts candidate summaries in Jira comment", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "needs_confirmation",
        selectedRepoIds: [reactRepo.id, batchRepo.id],
        candidateSummaries: [
          "React-based-new-ui matches if the change is in the SPA.",
          "batch-jobs matches if the change is in nightly batch.",
        ],
        repoReasoning: "Two repos remain plausible.",
      },
    });
    const harness = buildDispatcherHarness({ assessment });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30005",
        fields: {
          summary: "Cross-cutting",
          description: "across SPA and batch",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
    expect(
      harness.worker.db.parkQualifierForRepoConfirmation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        taskManagementId: harness.taskManagement.id,
        candidates: expect.arrayContaining([
          expect.objectContaining({ repoId: reactRepo.id }),
          expect.objectContaining({ repoId: batchRepo.id }),
        ]),
      }),
    );
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    const extracted = extractOneShotQualifierComment(result.output);
    expect(extracted.body).toContain("Repository Confirmation Needed");
    expect(extracted.body).toContain(
      "React-based-new-ui matches if the change is in the SPA.",
    );
    expect(extracted.body).toContain(
      "batch-jobs matches if the change is in nightly batch.",
    );
  });

  it("no_match: returns PFOS-NOT-QUALIFIED with the LLM's reasoning", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "no_match",
        selectedRepoIds: [],
        candidateSummaries: [],
        repoReasoning: "No profiled repo matches and no explicit repo named.",
      },
    });
    const harness = buildDispatcherHarness({ assessment });

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30006",
        fields: {
          summary: "vague",
          description: "vague",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.ensureNotQualifiedLabel).toHaveBeenCalled();
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
  });

  it("factory builder: needs_confirmation is overridden to Ai-agents", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "needs_confirmation",
        selectedRepoIds: [reactRepo.id, batchRepo.id],
        candidateSummaries: ["a", "b"],
        repoReasoning: "two repos",
      },
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, batchRepo, aiAgentsRepo],
    });

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30010",
        fields: {
          summary: "Factory Builder ticket",
          description: "Build a factory",
          labels: ["PFOS", "oneshot-factory-builder"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.createQualifiedRun).toHaveBeenCalledWith(
      expect.objectContaining({ repo: aiAgentsRepo }),
    );
    const runInput = harness.createQualifiedRun.mock.calls[0][0];
    expect(runInput.repoSelectionMetadata).toMatchObject({
      decisionSource: "factory_builder_label",
      factoryBuilder: {
        targetRepoName: "Ai-agents",
        targetGithubSlug: "enterprise-ai-agent-platform",
        originalRepoSelection: {
          type: "needs_confirmation",
          selectedRepoIds: [reactRepo.id, batchRepo.id],
        },
      },
    });
    expect(harness.worker.db.parkQualifierForRepoConfirmation).not.toHaveBeenCalled();
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
  });

  it("factory builder: malformed repo confirmation output is still normalized to Ai-agents", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "needs_confirmation",
        selectedRepoIds: [reactRepo.id],
        candidateSummaries: ["react"],
        repoReasoning: "Model returned an incomplete repo confirmation shape.",
      },
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, batchRepo, aiAgentsRepo],
    });

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30021",
        fields: {
          summary: "Factory Builder malformed repo output",
          description: "Build a factory",
          labels: ["PFOS", "oneshot-factory-builder"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.createQualifiedRun).toHaveBeenCalledWith(
      expect.objectContaining({ repo: aiAgentsRepo }),
    );
    expect(harness.worker.db.parkQualifierForRepoConfirmation).not.toHaveBeenCalled();
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
  });

  it("factory builder: no_match is overridden to Ai-agents", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "no_match",
        selectedRepoIds: [],
        candidateSummaries: [],
        repoReasoning: "No profiled repo matched.",
      },
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, batchRepo, aiAgentsRepo],
    });

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30011",
        fields: {
          summary: "Factory Builder no_match ticket",
          description: "Build another factory",
          labels: ["PFOS", "oneshot-factory-builder"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.createQualifiedRun).toHaveBeenCalledWith(
      expect.objectContaining({ repo: aiAgentsRepo }),
    );
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
  });

  it("factory builder: non-FB qualified ticket with needs_confirmation still parks (existing behavior unchanged)", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "needs_confirmation",
        selectedRepoIds: [reactRepo.id, batchRepo.id],
        candidateSummaries: [
          "React-based-new-ui matches if the change is in the SPA.",
          "batch-jobs matches if the change is in nightly batch.",
        ],
        repoReasoning: "Two repos remain plausible.",
      },
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, batchRepo, aiAgentsRepo],
    });

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30012",
        fields: {
          summary: "PFOS-only needs_confirmation",
          description: "cross-cutting",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.worker.db.parkQualifierForRepoConfirmation).toHaveBeenCalled();
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
  });

  it("factory builder: not-qualified Factory Builder ticket does not create a run", async () => {
    const assessment = buildAssessment({
      qualified: false,
      blockingReasons: ["acceptance_criteria_missing"],
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, batchRepo, aiAgentsRepo],
    });

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30013",
        fields: {
          summary: "Factory Builder not qualified",
          description: "missing AC",
          labels: ["PFOS", "oneshot-factory-builder"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(harness.ensureNotQualifiedLabel).toHaveBeenCalled();
  });

  it("factory builder: repo-only rejection is normalized and routed to Ai-agents", async () => {
    const assessment = buildAssessment({
      qualified: false,
      repoSelection: {
        type: "no_match",
        selectedRepoIds: [],
        candidateSummaries: [],
        repoReasoning: "No profiled repo matched.",
      },
      blockingReasons: ["repo_no_match"],
      nonBlockingWarnings: ["planner should confirm generated files"],
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, batchRepo, aiAgentsRepo],
    });

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30018",
        fields: {
          summary: "Factory Builder repo-only blocker",
          description: "Build another factory",
          labels: ["PFOS", "oneshot-factory-builder"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.createQualifiedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: aiAgentsRepo,
        qualification: expect.objectContaining({
          qualified: true,
          blockingReasons: [],
          nonBlockingWarnings: expect.arrayContaining([
            "planner should confirm generated files",
            "Factory Builder repo routing override demoted repo-only blocker: repo_no_match",
          ]),
        }),
      }),
    );
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
  });

  it("factory builder: repo-only rejection without explicit blockers is normalized when ready otherwise", async () => {
    const assessment = buildAssessment({
      qualified: false,
      repoSelection: {
        type: "needs_confirmation",
        selectedRepoIds: [reactRepo.id, batchRepo.id],
        candidateSummaries: ["react", "batch"],
        repoReasoning: "Only repository ambiguity remains.",
      },
      blockingReasons: [],
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, batchRepo, aiAgentsRepo],
    });

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30022",
        fields: {
          summary: "Factory Builder repo-only rejection without blockers",
          description: "Build another factory",
          labels: ["PFOS", "oneshot-factory-builder"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.createQualifiedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: aiAgentsRepo,
        qualification: expect.objectContaining({
          qualified: true,
          blockingReasons: [],
          nonBlockingWarnings: expect.arrayContaining([
            "Factory Builder repo routing override demoted repo-only blocker: repo_selection_only: needs_confirmation was overridden by Factory Builder routing.",
          ]),
        }),
      }),
    );
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
  });

  it("factory builder: Ai-agents absent from availableRepos fails as repo_unsupported", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "needs_confirmation",
        selectedRepoIds: [reactRepo.id, batchRepo.id],
        candidateSummaries: [
          "React-based-new-ui matches if the change is in the SPA.",
          "batch-jobs matches if the change is in nightly batch.",
        ],
        repoReasoning: "Two repos remain plausible.",
      },
    });
    // availableRepos intentionally does NOT include aiAgentsRepo
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, batchRepo],
    });

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30014",
        fields: {
          summary: "Factory Builder but no Ai-agents in DB",
          description: "override cannot fire without the repo",
          labels: ["PFOS", "oneshot-factory-builder"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.worker.db.parkQualifierForRepoConfirmation).not.toHaveBeenCalled();
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(harness.ensureNotQualifiedLabel).toHaveBeenCalled();
  });

  it("factory builder: mixed Sonar labels keep existing non-factory confirmation flow", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "needs_confirmation",
        selectedRepoIds: [reactRepo.id, batchRepo.id],
        candidateSummaries: ["react", "batch"],
        repoReasoning: "Two repos remain plausible.",
      },
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, batchRepo, aiAgentsRepo],
    });

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30019",
        fields: {
          summary: "Factory Builder mixed labels",
          description: "ambiguous",
          labels: ["PFOS", "SONAR-AUTOFIX", "oneshot-factory-builder"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.worker.db.parkQualifierForRepoConfirmation).toHaveBeenCalled();
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
  });

  it("factory builder: retrofit output is rejected as V1 unsupported", async () => {
    const assessment = buildAssessment({
      templateMatched: "retrofit_template",
      repoSelection: {
        type: "profiled_repo",
        selectedRepoIds: [reactRepo.id],
        candidateSummaries: [],
        repoReasoning: "React owns the retrofit.",
      },
      retrofitContext: {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "master",
        targetBranch: "release-3.17",
      },
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, aiAgentsRepo],
    });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30020",
        fields: {
          summary: "Factory Builder retrofit",
          description: "Retrofit: CPDEV-1234",
          labels: ["PFOS", "oneshot-factory-builder"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(harness.ensureNotQualifiedLabel).toHaveBeenCalled();
    expect(result.output).toContain("factory_builder_retrofit_not_supported");
  });

  it("qualified=false: lists missing template fields in Jira comment", async () => {
    const assessment = buildAssessment({
      qualified: false,
      templateMatched: "cpdev_template",
      blockingReasons: ["acceptance_criteria_missing"],
      requirementsSummary: [],
      qualificationReasoning: "AC missing.",
    });
    const harness = buildDispatcherHarness({ assessment });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30007",
        fields: {
          summary: "Incomplete",
          description: "missing AC",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.ensureNotQualifiedLabel).toHaveBeenCalled();
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    const extracted = extractOneShotQualifierComment(result.output);
    expect(extracted.body).toContain("acceptance_criteria_missing");
  });

  it("retrofit: LLM pick agrees with source evidence → run created", async () => {
    const retrofitContext = {
      sourceJiraKey: "CPDEV-18876",
      sourceBranch: "medhok-monorepo-4.1",
      targetBranch: "medhok-monorepo-3.17",
    };
    const assessment = buildAssessment({
      repoSelection: {
        type: "profiled_repo",
        selectedRepoIds: [interopRepo.id],
        candidateSummaries: [],
        repoReasoning: "Retrofit target inferred",
      },
      retrofitContext,
      templateMatched: "retrofit_template",
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, interopRepo],
    });
    vi.mocked(resolveRetrofitRepoMatches).mockResolvedValue(
      retrofitResolutionFor(interopRepo, retrofitContext),
    );
    vi.mocked(resolveBranchForQualification).mockResolvedValue({
      branchName: "medhok-monorepo-3.17",
      baseCommitSha: "def789012345",
      blockingReasons: [],
      branchCandidates: [],
      resolutionSource: "retrofit",
      selectedBranchHint: undefined,
      positiveBranchHints: [],
      ignoredNegatedBranchHints: [],
      branchConflicts: [],
      retrofitContext: undefined,
    } as any);

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-19884",
        fields: {
          summary: "Retrofit",
          description: "Retrofit: CPDEV-18876\nFrom: ...\nTarget: ...",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(harness.createQualifiedRun).toHaveBeenCalledWith(
      expect.objectContaining({ repo: interopRepo }),
    );
  });

  it("retrofit: source evidence overrides LLM pick → warning recorded", async () => {
    const retrofitContext = {
      sourceJiraKey: "CPDEV-18876",
      sourceBranch: "medhok-monorepo-4.1",
      targetBranch: "medhok-monorepo-3.17",
    };
    const assessment = buildAssessment({
      repoSelection: {
        type: "profiled_repo",
        selectedRepoIds: [reactRepo.id],
        candidateSummaries: [],
        repoReasoning: "Wrong pick",
      },
      retrofitContext,
      templateMatched: "retrofit_template",
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, interopRepo],
    });
    vi.mocked(resolveRetrofitRepoMatches).mockResolvedValue(
      retrofitResolutionFor(interopRepo, retrofitContext),
    );
    vi.mocked(resolveBranchForQualification).mockResolvedValue({
      branchName: "medhok-monorepo-3.17",
      baseCommitSha: "def789012345",
      blockingReasons: [],
      branchCandidates: [],
      resolutionSource: "retrofit",
      selectedBranchHint: undefined,
      positiveBranchHints: [],
      ignoredNegatedBranchHints: [],
      branchConflicts: [],
      retrofitContext: undefined,
    } as any);

    await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-19884",
        fields: {
          summary: "Retrofit",
          description: "Retrofit: CPDEV-18876\nFrom: ...\nTarget: ...",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    const call = harness.createQualifiedRun.mock.calls[0][0];
    expect(call.repo).toBe(interopRepo);
    expect(call.qualification.nonBlockingWarnings.join(" ")).toContain(
      "Retrofit commit evidence selected interop",
    );
  });

  it("retrofit: multiple source-evidence repos create a grouped retrofit", async () => {
    const retrofitContext = {
      sourceJiraKey: "CPDEV-18876",
      sourceBranch: "medhok-monorepo-4.1",
      targetBranch: "medhok-monorepo-3.17",
    };
    const assessment = buildAssessment({
      repoSelection: {
        type: "profiled_repo",
        selectedRepoIds: [interopRepo.id],
        candidateSummaries: [],
        repoReasoning: "Retrofit",
      },
      retrofitContext,
      templateMatched: "retrofit_template",
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, interopRepo],
    });
    const reactEvidence = sourceEvidenceFor(reactRepo, retrofitContext, [
      "src/App.tsx",
    ]);
    const interopEvidence = sourceEvidenceFor(interopRepo, retrofitContext, [
      "interop/src/main/java/Bridge.java",
    ]);
    vi.mocked(resolveRetrofitRepoMatches).mockResolvedValue({
      matches: [
        {
          repo: reactRepo,
          source: "commit_evidence",
          matchingCommits: reactEvidence.selectedCommits,
          profileMatch: null,
          sourceEvidence: reactEvidence,
        },
        {
          repo: interopRepo,
          source: "commit_evidence",
          matchingCommits: interopEvidence.selectedCommits,
          profileMatch: null,
          sourceEvidence: interopEvidence,
        },
      ],
      profileMatches: [],
      resolutionSource: "commit_evidence",
      profileAmbiguityWarnings: [],
      warnings: [],
      commitEvidenceInspectedRepoNames: [],
    } as any);
    vi.mocked(resolveBranchForQualification).mockResolvedValue({
      branchName: retrofitContext.targetBranch,
      baseCommitSha: "def789012345",
      blockingReasons: [],
      branchCandidates: [],
      resolutionSource: "retrofit",
      selectedBranchHint: undefined,
      positiveBranchHints: [],
      ignoredNegatedBranchHints: [],
      branchConflicts: [],
      retrofitContext: undefined,
    } as any);
    const createQualifiedRunGroup = vi.fn().mockResolvedValue({
      runGroupId: 18876,
      runIds: [701, 702],
      publishError: null,
    });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-19884",
        fields: {
          summary: "Retrofit",
          description: "Retrofit: CPDEV-18876\nFrom: ...\nTarget: ...",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      { createQualifiedRunGroup } as any,
    );

    expect(result.success).toBe(true);
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(assessment.repoSelection.selectedRepoIds).toEqual([interopRepo.id]);
    expect(createQualifiedRunGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        jiraKey: "CPDEV-19884",
        groupMetadata: expect.objectContaining({
          modeDetail: "retrofit_source_evidence",
          sourceEvidenceRepos: expect.arrayContaining([
            expect.objectContaining({ repo_name: reactRepo.repo_name }),
            expect.objectContaining({ repo_name: interopRepo.repo_name }),
          ]),
        }),
        runs: expect.arrayContaining([
          expect.objectContaining({
            repo: reactRepo,
            repoSelectionMetadata: expect.objectContaining({
              retrofitSourceEvidence: expect.objectContaining({
                touchedFiles: ["src/App.tsx"],
              }),
            }),
          }),
          expect.objectContaining({
            repo: interopRepo,
            repoSelectionMetadata: expect.objectContaining({
              retrofitSourceEvidence: expect.objectContaining({
                touchedFiles: ["interop/src/main/java/Bridge.java"],
              }),
            }),
          }),
        ]),
      }),
    );
  });

  it("retrofit: source-evidence branch lookup failure is retryable and does not add PFOS-NOT-QUALIFIED", async () => {
    const retrofitContext = {
      sourceJiraKey: "CPDEV-18876",
      sourceBranch: "medhok-monorepo-4.1",
      targetBranch: "medhok-monorepo-3.17",
    };
    const assessment = buildAssessment({
      repoSelection: {
        type: "profiled_repo",
        selectedRepoIds: [interopRepo.id],
        candidateSummaries: [],
        repoReasoning: "Retrofit",
      },
      retrofitContext,
      templateMatched: "retrofit_template",
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, interopRepo],
    });
    const reactEvidence = sourceEvidenceFor(reactRepo, retrofitContext, [
      "src/App.tsx",
    ]);
    const interopEvidence = sourceEvidenceFor(interopRepo, retrofitContext, [
      "interop/src/main/java/Bridge.java",
    ]);
    vi.mocked(resolveRetrofitRepoMatches).mockResolvedValue({
      matches: [
        {
          repo: reactRepo,
          source: "commit_evidence",
          matchingCommits: reactEvidence.selectedCommits,
          profileMatch: null,
          sourceEvidence: reactEvidence,
        },
        {
          repo: interopRepo,
          source: "commit_evidence",
          matchingCommits: interopEvidence.selectedCommits,
          profileMatch: null,
          sourceEvidence: interopEvidence,
        },
      ],
      profileMatches: [],
      resolutionSource: "commit_evidence",
      profileAmbiguityWarnings: [],
      warnings: [],
      commitEvidenceInspectedRepoNames: [],
    } as any);
    vi.mocked(resolveBranchForQualification).mockResolvedValue({
      branchName: null,
      baseCommitSha: null,
      blockingReasons: [
        "GitHub branch lookup failed while resolving interop: timeout while checking medhok-monorepo-3.17.",
      ],
      branchCandidates: ["medhok-monorepo-3.17"],
      resolutionSource: "none",
      selectedBranchHint: undefined,
      positiveBranchHints: [],
      ignoredNegatedBranchHints: [],
      branchConflicts: [],
      retrofitContext: undefined,
      failureKind: "branch_lookup_failed",
    } as any);
    const createQualifiedRunGroup = vi.fn();

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-19884",
        fields: {
          summary: "Retrofit",
          description: "Retrofit: CPDEV-18876\nFrom: ...\nTarget: ...",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      { createQualifiedRunGroup } as any,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("GitHub branch lookup failed");
    expect(createQualifiedRunGroup).not.toHaveBeenCalled();
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
  });

  it("LLM call failure parks for human review and never applies PFOS-NOT-QUALIFIED", async () => {
    const assessment = buildAssessment();
    const harness = buildDispatcherHarness({ assessment });
    harness.assessQualification.mockRejectedValueOnce(
      new Error("Bedrock unavailable"),
    );

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30009",
        fields: {
          summary: "x",
          description: "x",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(true);
    expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(
      harness.worker.db.parkQualifierForRepoConfirmation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        taskManagementId: harness.taskManagement.id,
      }),
    );
  });

  it("non-explicit repo path still parks when profile catalog loading fails", async () => {
    vi.mocked(getProfiledRepoSummariesForLlm).mockRejectedValue(
      new Error("Missing RepoRouter profile for enabled repo core-app"),
    );
    const harness = buildDispatcherHarness({ assessment: buildAssessment() });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30017",
        fields: {
          summary: "Add a new intake field",
          description: "Add a new field to the intake workflow.",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(true);
    expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
    expect(getProfiledRepoSummariesForLlm).toHaveBeenCalled();
    expect(harness.assessQualification).not.toHaveBeenCalled();
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    const outcome = (result.metrics as any).qualifierOutcome;
    expect(outcome.reasonCode).toBe("llm_error_parked");
    const extracted = extractOneShotQualifierComment(result.output);
    expect(extracted.body).toContain("profile catalog is unavailable");
  });

  it("LLM schema parse failure parks with reasonCode=llm_schema_invalid (not llm_error_parked)", async () => {
    const assessment = buildAssessment();
    const harness = buildDispatcherHarness({ assessment });
    // Simulate Zod parse error (constructor name + .issues array — what
    // QualifierAgent.parseResult would surface).
    const zodLikeError = Object.assign(new Error("Invalid input"), {
      name: "ZodError",
      issues: [{ path: ["repoSelection"], message: "Required" }],
    });
    harness.assessQualification.mockRejectedValueOnce(zodLikeError);

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30011",
        fields: { summary: "x", description: "x", labels: ["PFOS"] },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
    const outcome = (result.metrics as any).qualifierOutcome;
    expect(outcome.reasonCode).toBe("llm_schema_invalid");
    expect(outcome.disposition).toBe("needs_confirmation");
    const extracted = extractOneShotQualifierComment(result.output);
    expect(extracted.body).toContain("invalid response");
  });

  it("LLM Bedrock infra failure parks with reasonCode=llm_error_parked", async () => {
    const assessment = buildAssessment();
    const harness = buildDispatcherHarness({ assessment });
    harness.assessQualification.mockRejectedValueOnce(
      new Error("Bedrock 503 ServiceUnavailable"),
    );

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30012",
        fields: { summary: "x", description: "x", labels: ["PFOS"] },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
    const outcome = (result.metrics as any).qualifierOutcome;
    expect(outcome.reasonCode).toBe("llm_error_parked");
    const extracted = extractOneShotQualifierComment(result.output);
    expect(extracted.body).toContain("LLM was unavailable");
  });

  it("LLM returns needs_confirmation with <2 ids → routed through llm_schema_invalid path", async () => {
    // Schema lets the LLM emit an empty selectedRepoIds, but a parking row
    // with zero candidates is unresolvable. Treat as schema invariant
    // violation; still parks but logs as schema error and uses ALL enabled
    // repos as candidates so the human has something to pick.
    const assessment = buildAssessment({
      repoSelection: {
        type: "needs_confirmation",
        selectedRepoIds: [reactRepo.id], // only one — must be 2+
        candidateSummaries: [],
        repoReasoning: "actually I'm not sure",
      },
    });
    const harness = buildDispatcherHarness({ assessment });

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30013",
        fields: { summary: "x", description: "x", labels: ["PFOS"] },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
    const outcome = (result.metrics as any).qualifierOutcome;
    expect(outcome.reasonCode).toBe("llm_schema_invalid");
    // Candidate IDs come from the enabled-repos fallback, not the LLM's bogus 1-id list.
    const parkCall = (
      harness.worker.db.parkQualifierForRepoConfirmation as ReturnType<
        typeof vi.fn
      >
    ).mock.calls[0][0];
    expect(parkCall.candidates.map((c: any) => c.repoId).sort()).toEqual(
      [reactRepo.id, batchRepo.id].sort(),
    );
  });

  it("LLM failure with no enabled repos → not_qualified (not park-forever with empty candidates)", async () => {
    const assessment = buildAssessment();
    // Repos exist but NONE are OneShot-enabled — pass an empty list to
    // simulate a fleet-config drift where the worker wakes up with no
    // valid park targets.
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [],
    });
    harness.assessQualification.mockRejectedValueOnce(
      new Error("Bedrock down"),
    );

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30014",
        fields: { summary: "x", description: "x", labels: ["PFOS"] },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(true);
    expect(result.taskManagementStatus).toBeUndefined();
    expect(harness.ensureNotQualifiedLabel).toHaveBeenCalled();
    expect(
      harness.worker.db.parkQualifierForRepoConfirmation,
    ).not.toHaveBeenCalled();
    const outcome = (result.metrics as any).qualifierOutcome;
    expect(outcome.disposition).toBe("not_qualified");
    expect(outcome.reasonCode).toBe("repo_unsupported");
  });

  it("retrofit source-evidence resolver throws → rejects explicit retrofit", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "profiled_repo",
        selectedRepoIds: [interopRepo.id],
        candidateSummaries: [],
        repoReasoning: "Retrofit target inferred",
      },
      retrofitContext: {
        sourceJiraKey: "CPDEV-18876",
        sourceBranch: "medhok-monorepo-4.1",
        targetBranch: "medhok-monorepo-3.17",
      },
      templateMatched: "retrofit_template",
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, interopRepo],
    });
    vi.mocked(resolveRetrofitRepoMatches).mockRejectedValueOnce(
      new Error("ENOSPC: no space left on device"),
    );
    vi.mocked(resolveBranchForQualification).mockResolvedValue({
      branchName: "medhok-monorepo-3.17",
      baseCommitSha: "def789012345",
      blockingReasons: [],
      branchCandidates: [],
        resolutionSource: "retrofit",
        selectedBranchHint: undefined,
        positiveBranchHints: [],
      ignoredNegatedBranchHints: [],
      branchConflicts: [],
      retrofitContext: undefined,
      } as any);

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-19884",
        fields: {
          summary: "Retrofit",
          description: "Retrofit: CPDEV-18876\nFrom: ...\nTarget: ...",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(true);
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(harness.ensureNotQualifiedLabel).toHaveBeenCalled();
    expect(result.output).toContain(
      "retrofit_source_evidence_unavailable",
    );
  });

  it("retrofit source-evidence lookup failure is retryable and does not add PFOS-NOT-QUALIFIED", async () => {
    const assessment = buildAssessment({
      repoSelection: {
        type: "profiled_repo",
        selectedRepoIds: [interopRepo.id],
        candidateSummaries: [],
        repoReasoning: "Retrofit target inferred",
      },
      retrofitContext: {
        sourceJiraKey: "CPDEV-18876",
        sourceBranch: "medhok-monorepo-4.1",
        targetBranch: "medhok-monorepo-3.17",
      },
      templateMatched: "retrofit_template",
    });
    const harness = buildDispatcherHarness({
      assessment,
      availableRepos: [reactRepo, interopRepo],
    });
    vi.mocked(resolveRetrofitRepoMatches).mockRejectedValueOnce(
      new RetrofitSourceEvidenceLookupError(
        "retrofit_source_lookup_failed: GitHub token expired.",
        "401 Bad credentials",
      ),
    );

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-19884",
        fields: {
          summary: "Retrofit",
          description: "Retrofit: CPDEV-18876\nFrom: ...\nTarget: ...",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("retrofit_source_lookup_failed");
    expect(result.error).toContain("401 Bad credentials");
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
  });

  it("atomic parking failure surfaces success:false (so AgentWorker hits failure path)", async () => {
    // The atomic helper throws — we should NOT silently mark success:true
    // with a parked status. AgentWorker will then call
    // markTaskManagementFailedUnlessParked, which preserves any pre-existing
    // waiting_repo_confirmation but otherwise marks failed.
    const assessment = buildAssessment({
      repoSelection: {
        type: "needs_confirmation",
        selectedRepoIds: [reactRepo.id, batchRepo.id],
        candidateSummaries: ["a", "b"],
        repoReasoning: "two plausible",
      },
    });
    const harness = buildDispatcherHarness({ assessment });
    (
      harness.worker.db.parkQualifierForRepoConfirmation as ReturnType<
        typeof vi.fn
      >
    ).mockRejectedValueOnce(new Error("DB transaction aborted"));

    const result = await runDispatcher(
      harness.worker,
      {
        key: "CPDEV-30010",
        fields: {
          summary: "x",
          description: "x",
          labels: ["PFOS"],
        },
      },
      harness.taskManagement,
      harness.oneShotService,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("DB transaction aborted");
    expect(result.taskManagementStatus).toBeUndefined();
    expect(harness.createQualifiedRun).not.toHaveBeenCalled();
  });

  // ── Multi-repo run group tests ───────────────────────────────────────────

  describe("multi_repo: run group routing", () => {
    const multiRepoAssessment = buildAssessment({
      repoSelection: {
        type: "multi_repo",
        selectedRepoIds: [reactRepo.id, batchRepo.id],
        candidateSummaries: [],
        repoReasoning: "Changes span two independent repos.",
      },
      multiRepoPlan: [
        {
          repoRef: reactRepo.repo_name,
          objective: "Add UI panel in React.",
          acceptanceCriteria: ["Panel renders correctly."],
          mergeOrder: 1,
        },
        {
          repoRef: batchRepo.repo_name,
          objective: "Add batch consumer.",
          acceptanceCriteria: ["Consumer processes jobs."],
          mergeOrder: 2,
        },
      ],
    } as any);

    afterEach(() => {
      delete process.env.ONESHOT_MULTI_REPO_ENABLED;
    });

    it("routes to a multi-repo run group when ONESHOT_MULTI_REPO_ENABLED is unset", async () => {
      delete process.env.ONESHOT_MULTI_REPO_ENABLED;
      const harness = buildDispatcherHarness({
        assessment: multiRepoAssessment,
      });
      const createQualifiedRunGroup = vi.fn().mockResolvedValue({
        runGroupId: 40001,
        runIds: [400011, 400012],
        publishError: null,
      });

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-40001",
          fields: {
            summary: "Multi-repo feature",
            description: "Requires changes in two repos.",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        { createQualifiedRunGroup } as any,
      );

      expect(result.success).toBe(true);
      const metrics = result.metrics as any;
      expect(metrics.qualifierOutcome.disposition).toBe("qualified");
      expect(metrics.qualifierOutcome.reasonCode).toBe("llm_qualified");
      expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
      expect(createQualifiedRunGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ repo: reactRepo }),
            expect.objectContaining({ repo: batchRepo }),
          ]),
        }),
      );
    });

    it("routes to a multi-repo run group when ONESHOT_MULTI_REPO_ENABLED='false'", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "false";
      const harness = buildDispatcherHarness({
        assessment: multiRepoAssessment,
      });
      const createQualifiedRunGroup = vi.fn().mockResolvedValue({
        runGroupId: 40002,
        runIds: [400021, 400022],
        publishError: null,
      });

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-40002",
          fields: {
            summary: "Multi-repo feature",
            description: "Requires changes in two repos.",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        { createQualifiedRunGroup } as any,
      );

      expect(result.success).toBe(true);
      expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
      expect(createQualifiedRunGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          runs: expect.arrayContaining([
            expect.objectContaining({ repo: reactRepo }),
            expect.objectContaining({ repo: batchRepo }),
          ]),
        }),
      );
    });

    it("routes to multi-repo run group when ONESHOT_MULTI_REPO_ENABLED='true'", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const harness = buildDispatcherHarness({
        assessment: multiRepoAssessment,
        availableRepos: [reactRepo, batchRepo],
      });
      vi.mocked(resolveBranchForQualification).mockResolvedValue({
        branchName: "master",
        baseCommitSha: "abc123def456",
        blockingReasons: [],
        nonBlockingWarnings: [],
        branchCandidates: [],
        resolutionSource: "default_branch",
        selectedBranchHint: undefined,
        positiveBranchHints: [],
        ignoredNegatedBranchHints: [],
        branchConflicts: [],
        retrofitContext: undefined,
      } as any);

      const createQualifiedRunGroup = vi.fn().mockResolvedValue({
        runGroupId: 11,
        runIds: [20, 21],
        publishError: null,
      });
      const multiOneShotService = { createQualifiedRunGroup } as any;

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-40003",
          fields: {
            summary: "Multi-repo feature",
            description: "Requires changes in two repos.",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        multiOneShotService,
      );

      expect(result.success).toBe(true);
      expect(createQualifiedRunGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          jiraKey: "CPDEV-40003",
          groupMetadata: expect.objectContaining({
            mergeOrder: expect.objectContaining({
              [reactRepo.repo_name]: 1,
              [batchRepo.repo_name]: 2,
            }),
          }),
          runs: expect.arrayContaining([
            expect.objectContaining({
              repo: reactRepo,
              repoSelectionMetadata: expect.objectContaining({
                multiRepoBrief: expect.objectContaining({
                  repoRef: reactRepo.repo_name,
                  mergeOrder: 1,
                }),
                branchResolution: expect.objectContaining({
                  selectedReason: "default_branch",
                  nonBlockingWarnings: [],
                }),
              }),
            }),
            expect.objectContaining({
              repo: batchRepo,
              repoSelectionMetadata: expect.objectContaining({
                multiRepoBrief: expect.objectContaining({
                  repoRef: batchRepo.repo_name,
                  mergeOrder: 2,
                }),
                branchResolution: expect.objectContaining({
                  selectedReason: "default_branch",
                  nonBlockingWarnings: [],
                }),
              }),
            }),
          ]),
        }),
      );
      expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    });

    it("treats multi-repo branch lookup failure as retryable infrastructure", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const harness = buildDispatcherHarness({
        assessment: multiRepoAssessment,
        availableRepos: [reactRepo, batchRepo],
      });
      vi.mocked(resolveBranchForQualification).mockResolvedValue({
        branchName: null,
        baseCommitSha: null,
        blockingReasons: [
          "GitHub branch lookup failed while resolving React-based-new-ui: network failure while checking master.",
        ],
        nonBlockingWarnings: [],
        branchCandidates: ["master"],
        resolutionSource: "none",
        selectedBranchHint: undefined,
        positiveBranchHints: [],
        ignoredNegatedBranchHints: [],
        branchConflicts: [],
        retrofitContext: undefined,
        failureKind: "branch_lookup_failed",
      } as any);
      const createQualifiedRunGroup = vi.fn();

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-40011",
          fields: {
            summary: "Multi-repo feature",
            description: "Requires changes in two repos.",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        { createQualifiedRunGroup } as any,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("GitHub branch lookup failed");
      expect(createQualifiedRunGroup).not.toHaveBeenCalled();
      expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    });

    it("routes CPDEV-19674-style ePA ingestion and UI search work as a multi-repo group", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const epaAssessment = buildAssessment({
        requirementsSummary: [
          "Capture PA Reference ID on inbound CoverMyMeds/ePA transactions.",
          "Make the ePA Transaction UI searchable by PA Reference ID.",
        ],
        qualificationReasoning:
          "The ticket has separable ePA ingestion and UI search workstreams.",
        repoSelection: {
          type: "multi_repo",
          selectedRepoIds: [batchRepo.id, coreAppRepo.id],
          candidateSummaries: [],
          repoReasoning:
            "batch-jobs owns ePA scheduler ingestion while core-app owns ePA Transaction UI search and grids.",
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
      } as any);
      const harness = buildDispatcherHarness({
        assessment: epaAssessment,
        availableRepos: [batchRepo, coreAppRepo],
      });
      const createQualifiedRunGroup = vi.fn().mockResolvedValue({
        runGroupId: 19674,
        runIds: [401, 402],
        publishError: null,
      });
      const multiOneShotService = { createQualifiedRunGroup } as any;

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-19674",
          fields: {
            summary: "[PerformRX] Ability to search ePA Cases in UI search",
            description:
              "Capture PA Reference ID on inbound CoverMyMeds transactions and make the ePA Transaction UI searchable by that ID.",
            labels: ["PFOS", "TS_Small"],
          },
        },
        harness.taskManagement,
        multiOneShotService,
      );

      expect(result.success).toBe(true);
      expect(
        harness.worker.db.parkQualifierForRepoConfirmation,
      ).not.toHaveBeenCalled();
      expect(createQualifiedRunGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          jiraKey: "CPDEV-19674",
          groupMetadata: expect.objectContaining({
            mergeOrder: {
              "batch-jobs": 1,
              "core-app": 2,
            },
          }),
          runs: expect.arrayContaining([
            expect.objectContaining({
              repo: batchRepo,
              repoSelectionMetadata: expect.objectContaining({
                multiRepoBrief: expect.objectContaining({
                  repoRef: "batch-jobs",
                  objective:
                    "Capture and persist PA Reference ID for inbound CoverMyMeds/ePA transactions.",
                  acceptanceCriteria: [
                    "Inbound ePA transactions retain PA Reference ID even when no MHK case is created.",
                  ],
                  mergeOrder: 1,
                }),
              }),
            }),
            expect.objectContaining({
              repo: coreAppRepo,
              repoSelectionMetadata: expect.objectContaining({
                multiRepoBrief: expect.objectContaining({
                  repoRef: "core-app",
                  objective:
                    "Search and display PA Reference ID in the ePA Transaction UI.",
                  acceptanceCriteria: [
                    "Users can search ePA transactions by PA Reference ID and see the value in results.",
                  ],
                  mergeOrder: 2,
                }),
              }),
            }),
          ]),
        }),
      );
      expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    });

    it("routes multi-target retrofit tickets as a same-repo run group", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const targetBranches = [
        "medhok-monorepo-3.17",
        "medhok-monorepo-3.18",
        "medhok-monorepo-3.19",
      ];
      const retrofitAssessment = buildAssessment({
        templateMatched: "retrofit_template",
        requirementsSummary: [
          "Retrofit CPDEV-1234 from master to multiple medhok release branches.",
        ],
        qualificationReasoning:
          "The ticket has one repo and three independently runnable retrofit targets.",
        repoSelection: {
          type: "explicit_github",
          explicitRepoRef: "medhok-monorepo",
          selectedRepoIds: [],
          candidateSummaries: [],
          repoReasoning: "core-app matches medhok-monorepo.",
        },
        multiBranchRetrofitPlan: {
          sourceJiraKey: "CPDEV-1234",
          repoRef: "core-app",
          sourceBranch: "master",
          targetBranches,
          skippedTargetBranches: [],
        },
      } as any);
      const harness = buildDispatcherHarness({
        assessment: retrofitAssessment,
        availableRepos: [coreAppRepo],
      });
      vi.mocked(resolveExplicitRepoHint).mockResolvedValue({
        repo: coreAppRepo,
        candidates: [
          {
            repo: coreAppRepo,
            reason: "exact repo name",
          },
        ],
        reason: "matched explicit repo",
      } as any);
      vi.mocked(resolveBranchForQualification).mockImplementation(
        async (_db, _repo, _customerBranch, ticketText: string) => {
          const target =
            targetBranches.find((branch) => ticketText.includes(branch)) ??
            "master";
          return {
            branchName: target,
            baseCommitSha: `${target.replace(/[^a-z0-9]/gi, "").slice(0, 12)}abc123`,
            blockingReasons: [],
            nonBlockingWarnings: [],
            branchCandidates: [target],
            resolutionSource: "explicit",
            selectedBranchHint: undefined,
            positiveBranchHints: [],
            ignoredNegatedBranchHints: [],
            branchConflicts: [],
            retrofitContext: {
              sourceJiraKey: "CPDEV-1234",
              sourceBranch: "master",
              targetBranch: target,
            },
          } as any;
        },
      );
      vi.mocked(resolveRetrofitRepoMatches).mockImplementation(
        async (context) =>
          retrofitResolutionFor(coreAppRepo, context as any),
      );
      const createQualifiedRunGroup = vi.fn().mockResolvedValue({
        runGroupId: 23958,
        runIds: [501, 502, 503],
        publishError: null,
      });
      const multiOneShotService = { createQualifiedRunGroup } as any;

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-23958",
          fields: {
            summary: "Multi-branch retrofit",
            description:
              "Retrofit: CPDEV-1234\nRepo: medhok-monorepo\nFrom: master\nTarget: medhok-monorepo-3.17, medhok-monorepo-3.18, medhok-monorepo-3.19",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        multiOneShotService,
      );

      expect(result.success).toBe(true);
      expect(createQualifiedRunGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          jiraKey: "CPDEV-23958",
          groupMode: "multi_branch_retrofit",
          groupMetadata: expect.objectContaining({
            sourceJiraKey: "CPDEV-1234",
            repo: expect.objectContaining({
              repo_id: coreAppRepo.id,
              repo_name: coreAppRepo.repo_name,
            }),
            sourceBranch: "master",
            targetBranches: targetBranches.map((branch, index) => ({
              targetBranch: branch,
              targetOrder: index + 1,
            })),
            skippedTargetBranches: [],
          }),
          runs: targetBranches.map((branch, index) =>
            expect.objectContaining({
              repo: coreAppRepo,
              branchName: branch,
              qualification: expect.objectContaining({
                retrofitContext: {
                  sourceJiraKey: "CPDEV-1234",
                  sourceBranch: "master",
                  targetBranch: branch,
                },
                multiBranchRetrofitBrief: expect.objectContaining({
                  repoRef: "core-app",
                  targetBranch: branch,
                  targetOrder: index + 1,
                  totalTargets: 3,
                }),
              }),
              repoSelectionMetadata: expect.objectContaining({
                multiBranchRetrofitBrief: expect.objectContaining({
                  targetBranch: branch,
                  targetOrder: index + 1,
                }),
                retrofitSourceEvidence: expect.objectContaining({
                  targetBranch: branch,
                }),
              }),
            }),
          ),
        }),
      );
      expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
      expect(result.output).toContain("medhok-monorepo-3.17");
      expect(result.output).toContain("medhok-monorepo-3.19");
    });

    it("enriches multi-target retrofit source evidence with the source ticket's prior OneShot PR", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const targetBranches = ["medhok-monorepo-4.1", "medhok-monorepo-4.0"];
      const sourcePrUrl =
        "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2575";
      const retrofitAssessment = buildAssessment({
        templateMatched: "retrofit_template",
        requirementsSummary: [
          "Retrofit CPDEV-25448 from master to multiple medhok release branches.",
        ],
        repoSelection: {
          type: "profiled_repo",
          selectedRepoIds: [coreAppRepo.id],
          candidateSummaries: [],
          repoReasoning: "core-app matches medhok-monorepo.",
        },
        multiBranchRetrofitPlan: {
          sourceJiraKey: "CPDEV-25448",
          repoRef: "core-app",
          sourceBranch: "master",
          targetBranches,
          skippedTargetBranches: [],
        },
      } as any);
      const harness = buildDispatcherHarness({
        assessment: retrofitAssessment,
        availableRepos: [coreAppRepo],
      });
      vi.mocked(resolveExplicitRepoHint).mockResolvedValue({
        repo: coreAppRepo,
        profileStatus: "profiled",
        selectedReason: "explicit_repo",
        explicitRepoHint: "medhok-monorepo",
        registeredCandidates: [coreAppRepo.repo_name],
        githubCandidates: [],
        blockingReasons: [],
      } as any);
      vi.mocked(resolveBranchForQualification).mockImplementation(
        async (_db, _repo, _customerBranch, ticketText: string) => {
          const target =
            targetBranches.find((branch) => ticketText.includes(branch)) ??
            "master";
          return {
            branchName: target,
            baseCommitSha: `${target.replace(/[^a-z0-9]/gi, "").slice(0, 12)}abc123`,
            blockingReasons: [],
            nonBlockingWarnings: [],
            branchCandidates: [target],
            resolutionSource: "explicit",
            selectedBranchHint: undefined,
            positiveBranchHints: [],
            ignoredNegatedBranchHints: [],
            branchConflicts: [],
            retrofitContext: undefined,
          } as any;
        },
      );
      vi.mocked(resolveRetrofitRepoMatches).mockImplementation(
        async (context) =>
          retrofitResolutionFor(coreAppRepo, context as any),
      );
      const createQualifiedRunGroup = vi.fn().mockResolvedValue({
        runGroupId: 25799,
        runIds: [6501, 6502],
        publishError: null,
      });
      const getLatestRunWithPrByJiraKey = vi.fn().mockResolvedValue({
        id: 562,
        jira_key: "CPDEV-25448",
        repo_id: coreAppRepo.id,
        current_pr_url: sourcePrUrl,
      });
      const getLatestRunByJiraKey = vi.fn().mockResolvedValue({
        id: 563,
        jira_key: "CPDEV-25448",
        repo_id: coreAppRepo.id,
        current_pr_url: null,
      });

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-25799",
          fields: {
            summary: "Retrofit CPDEV-25448",
            description:
              "Retrofit: CPDEV-25448\nFrom: master\nTarget: medhok-monorepo-4.1, medhok-monorepo-4.0\nRepo: cp-medhok-monorepo",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        {
          createQualifiedRunGroup,
          getLatestRunWithPrByJiraKey,
          getLatestRunByJiraKey,
        } as any,
      );

      expect(result.success).toBe(true);
      expect(getLatestRunWithPrByJiraKey).toHaveBeenCalledWith("CPDEV-25448");
      expect(getLatestRunByJiraKey).not.toHaveBeenCalled();
      expect(resolveRetrofitRepoMatches).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceJiraKey: "CPDEV-25448",
          sourceBranch: "master",
          sourcePrUrl,
        }),
        expect.any(Array),
        expect.objectContaining({
          sourcePullRequestCandidates: [
            expect.objectContaining({
              prUrl: sourcePrUrl,
              method: "source_run_pr",
            }),
          ],
        }),
      );
      const firstResolverDependencies =
        vi.mocked(resolveRetrofitRepoMatches).mock.calls[0]?.[2];
      const secondResolverDependencies =
        vi.mocked(resolveRetrofitRepoMatches).mock.calls[1]?.[2];
      expect(
        firstResolverDependencies?.sourcePullRequestSelectionCache,
      ).toBeInstanceOf(Map);
      expect(
        secondResolverDependencies?.sourcePullRequestSelectionCache,
      ).toBe(firstResolverDependencies?.sourcePullRequestSelectionCache);
      expect(
        firstResolverDependencies?.sourceEvidenceBundleCache,
      ).toBeInstanceOf(Map);
      expect(secondResolverDependencies?.sourceEvidenceBundleCache).toBe(
        firstResolverDependencies?.sourceEvidenceBundleCache,
      );
      expect(createQualifiedRunGroup).toHaveBeenCalled();
      expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    });

    it("uses explicit source PR URLs from the retrofit ticket before source-run fallback", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const targetBranches = ["medhok-monorepo-4.1", "medhok-monorepo-4.0"];
      const sourcePrUrl =
        "https://github.com/mhk-repos/cp-medhok-monorepo/pull/2575";
      const retrofitAssessment = buildAssessment({
        templateMatched: "retrofit_template",
        repoSelection: {
          type: "profiled_repo",
          selectedRepoIds: [coreAppRepo.id],
          candidateSummaries: [],
          repoReasoning: "core-app matches medhok-monorepo.",
        },
        multiBranchRetrofitPlan: {
          sourceJiraKey: "CPDEV-25448",
          repoRef: "core-app",
          sourceBranch: "master",
          targetBranches,
          skippedTargetBranches: [],
        },
      } as any);
      const harness = buildDispatcherHarness({
        assessment: retrofitAssessment,
        availableRepos: [coreAppRepo],
      });
      vi.mocked(resolveBranchForQualification).mockImplementation(
        async (_db, _repo, _customerBranch, ticketText: string) => {
          const target =
            targetBranches.find((branch) => ticketText.includes(branch)) ??
            "master";
          return {
            branchName: target,
            baseCommitSha: `${target.replace(/[^a-z0-9]/gi, "").slice(0, 12)}abc123`,
            blockingReasons: [],
            nonBlockingWarnings: [],
            branchCandidates: [target],
            resolutionSource: "explicit",
            selectedBranchHint: undefined,
            positiveBranchHints: [],
            ignoredNegatedBranchHints: [],
            branchConflicts: [],
            retrofitContext: undefined,
          } as any;
        },
      );
      vi.mocked(resolveRetrofitRepoMatches).mockImplementation(
        async (context) =>
          retrofitResolutionFor(coreAppRepo, context as any),
      );
      const createQualifiedRunGroup = vi.fn().mockResolvedValue({
        runGroupId: 25799,
        runIds: [6501, 6502],
        publishError: null,
      });
      const getLatestRunByJiraKey = vi
        .fn()
        .mockRejectedValue(new Error("should not be called"));

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-25799",
          fields: {
            summary: "Retrofit CPDEV-25448",
            description:
              `Retrofit: CPDEV-25448\nSource PR: ${sourcePrUrl}\nFrom: master\nTarget: medhok-monorepo-4.1, medhok-monorepo-4.0\nRepo: cp-medhok-monorepo`,
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        { createQualifiedRunGroup, getLatestRunByJiraKey } as any,
      );

      expect(result.success).toBe(true);
      expect(getLatestRunByJiraKey).not.toHaveBeenCalled();
      expect(resolveRetrofitRepoMatches).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceJiraKey: "CPDEV-25448",
          sourceBranch: "master",
          sourcePrUrl,
        }),
        expect.any(Array),
        expect.objectContaining({
          sourcePullRequestCandidates: [
            expect.objectContaining({
              prUrl: sourcePrUrl,
              method: "source_pr",
            }),
          ],
        }),
      );
      expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    });

    it("treats prior source-run PR lookup failures as retryable without PFOS-NOT-QUALIFIED", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const retrofitAssessment = buildAssessment({
        templateMatched: "retrofit_template",
        repoSelection: {
          type: "profiled_repo",
          selectedRepoIds: [coreAppRepo.id],
          candidateSummaries: [],
          repoReasoning: "core-app matches medhok-monorepo.",
        },
        multiBranchRetrofitPlan: {
          sourceJiraKey: "CPDEV-25448",
          repoRef: "core-app",
          sourceBranch: "master",
          targetBranches: ["medhok-monorepo-4.1", "medhok-monorepo-4.0"],
          skippedTargetBranches: [],
        },
      } as any);
      const harness = buildDispatcherHarness({
        assessment: retrofitAssessment,
        availableRepos: [coreAppRepo],
      });
      const createQualifiedRunGroup = vi.fn();
      const getLatestRunByJiraKey = vi
        .fn()
        .mockRejectedValue(new Error("GitHub token expired"));

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-25799",
          fields: {
            summary: "Retrofit CPDEV-25448",
            description:
              "Retrofit: CPDEV-25448\nFrom: master\nTarget: medhok-monorepo-4.1, medhok-monorepo-4.0\nRepo: cp-medhok-monorepo",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        { createQualifiedRunGroup, getLatestRunByJiraKey } as any,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("source_pr_lookup_failed");
      expect(result.error).toContain("GitHub token expired");
      expect(resolveRetrofitRepoMatches).not.toHaveBeenCalled();
      expect(createQualifiedRunGroup).not.toHaveBeenCalled();
      expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    });

    it("treats multi-target retrofit source lookup failures as retryable without PFOS-NOT-QUALIFIED", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const retrofitAssessment = buildAssessment({
        templateMatched: "retrofit_template",
        repoSelection: {
          type: "profiled_repo",
          selectedRepoIds: [coreAppRepo.id],
          candidateSummaries: [],
          repoReasoning: "core-app matches medhok-monorepo.",
        },
        multiBranchRetrofitPlan: {
          sourceJiraKey: "CPDEV-25448",
          repoRef: "core-app",
          sourceBranch: "master",
          targetBranches: ["medhok-monorepo-4.1", "medhok-monorepo-4.0"],
          skippedTargetBranches: [],
        },
      } as any);
      const harness = buildDispatcherHarness({
        assessment: retrofitAssessment,
        availableRepos: [coreAppRepo],
      });
      vi.mocked(resolveRetrofitRepoMatches).mockRejectedValueOnce(
        new RetrofitSourceEvidenceLookupError(
          "source_pr_lookup_failed: Could not list source PR commits.",
          "GitHub API timed out",
        ),
      );
      const createQualifiedRunGroup = vi.fn();

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-25799",
          fields: {
            summary: "Retrofit CPDEV-25448",
            description:
              "Retrofit: CPDEV-25448\nFrom: master\nTarget: medhok-monorepo-4.1, medhok-monorepo-4.0\nRepo: cp-medhok-monorepo",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        { createQualifiedRunGroup } as any,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("source_pr_lookup_failed");
      expect(result.error).toContain("GitHub API timed out");
      expect(createQualifiedRunGroup).not.toHaveBeenCalled();
      expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    });

    it("creates only the first seven multi-target retrofit runs and warns about skipped targets", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const selectedTargets = [
        "medhok-monorepo-3.17",
        "medhok-monorepo-3.18",
        "medhok-monorepo-3.19",
        "medhok-monorepo-3.20",
        "medhok-monorepo-4.0",
        "medhok-monorepo-4.1",
        "medhok-monorepo-4.2",
      ];
      const skippedTargets = ["medhok-monorepo-4.3", "medhok-monorepo-4.4"];
      const retrofitAssessment = buildAssessment({
        templateMatched: "retrofit_template",
        requirementsSummary: [
          "Retrofit CPDEV-1234 from master to many medhok release branches.",
        ],
        repoSelection: {
          type: "profiled_repo",
          selectedRepoIds: [coreAppRepo.id],
          candidateSummaries: [],
          repoReasoning: "core-app matches medhok-monorepo.",
        },
        multiBranchRetrofitPlan: {
          sourceJiraKey: "CPDEV-1234",
          repoRef: "core-app",
          sourceBranch: "master",
          targetBranches: selectedTargets,
          skippedTargetBranches: skippedTargets,
        },
      } as any);
      const harness = buildDispatcherHarness({
        assessment: retrofitAssessment,
        availableRepos: [coreAppRepo],
      });
      vi.mocked(resolveExplicitRepoHint).mockResolvedValue({
        repo: coreAppRepo,
        profileStatus: "profiled",
        selectedReason: "explicit_repo",
        explicitRepoHint: "medhok-monorepo",
        registeredCandidates: [coreAppRepo.repo_name],
        githubCandidates: [],
        blockingReasons: [],
      } as any);
      vi.mocked(resolveBranchForQualification).mockImplementation(
        async (_db, _repo, _customerBranch, ticketText: string) => {
          const target =
            selectedTargets.find((branch) => ticketText.includes(branch)) ??
            "master";
          return {
            branchName: target,
            baseCommitSha: `${target.replace(/[^a-z0-9]/gi, "").slice(0, 12)}abc123`,
            blockingReasons: [],
            nonBlockingWarnings: [],
            branchCandidates: [target],
            resolutionSource: "explicit",
            selectedBranchHint: undefined,
            positiveBranchHints: [],
            ignoredNegatedBranchHints: [],
            branchConflicts: [],
            retrofitContext: undefined,
          } as any;
        },
      );
      vi.mocked(resolveRetrofitRepoMatches).mockImplementation(
        async (context) =>
          retrofitResolutionFor(coreAppRepo, context as any),
      );
      const createQualifiedRunGroup = vi.fn().mockResolvedValue({
        runGroupId: 23959,
        runIds: [601, 602, 603, 604, 605, 606, 607],
        publishError: null,
      });

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-23959",
          fields: {
            summary: "Overflow multi-branch retrofit",
            description: "Retrofit with nine targets.",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        { createQualifiedRunGroup } as any,
      );

      expect(result.success).toBe(true);
      const callArgs = createQualifiedRunGroup.mock.calls[0][0];
      expect(callArgs.runs).toHaveLength(7);
      expect(callArgs.groupMetadata.skippedTargetBranches).toEqual(
        skippedTargets,
      );
      expect(result.output).toContain("Only the first 7 target branches");
      expect(result.output).toContain("medhok-monorepo-4.3");
      expect(result.output).toContain("need another ticket");
    });

    it("rejects multi-target retrofit when the explicit repository is disabled", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const disabledRepo = {
        id: 88,
        repo_name: "mp-web",
        repo_url: "https://github.com/mhk-repos/mp-web.git",
        description: "Disabled MP UI",
        default_branch: "master",
        created_at: new Date(),
      } as any;
      const retrofitAssessment = buildAssessment({
        templateMatched: "retrofit_template",
        repoSelection: {
          type: "explicit_github",
          explicitRepoRef: "mp-web",
          selectedRepoIds: [],
          candidateSummaries: [],
          repoReasoning: "The ticket names mp-web.",
        },
        multiBranchRetrofitPlan: {
          sourceJiraKey: "CPDEV-1234",
          repoRef: "mp-web",
          sourceBranch: "master",
          targetBranches: ["mp-web-3.17", "mp-web-3.18"],
          skippedTargetBranches: [],
        },
      } as any);
      const harness = buildDispatcherHarness({
        assessment: retrofitAssessment,
        availableRepos: [disabledRepo],
      });
      vi.mocked(resolveExplicitRepoHint).mockResolvedValue({
        repo: disabledRepo,
        profileStatus: "unprofiled",
        selectedReason: "explicit_repo",
        explicitRepoHint: "mp-web",
        registeredCandidates: ["mp-web"],
        githubCandidates: [],
        blockingReasons: [],
      } as any);
      const createQualifiedRunGroup = vi.fn();

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-23960",
          fields: {
            summary: "Disabled repo multi-branch retrofit",
            description:
              "Retrofit: CPDEV-1234\nRepo: mp-web\nFrom: master\nTarget: mp-web-3.17, mp-web-3.18",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        { createQualifiedRunGroup } as any,
      );

      expect(result.success).toBe(true);
      expect(createQualifiedRunGroup).not.toHaveBeenCalled();
      expect(harness.ensureNotQualifiedLabel).toHaveBeenCalled();
      expect(result.output).toContain(
        "Selected repository mp-web is not enabled for OneShot.",
      );
    });

    it("creates no partial multi-target retrofit group when a selected branch cannot resolve", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const targetBranches = [
        "medhok-monorepo-3.17",
        "medhok-monorepo-3.18",
      ];
      const retrofitAssessment = buildAssessment({
        templateMatched: "retrofit_template",
        repoSelection: {
          type: "profiled_repo",
          selectedRepoIds: [coreAppRepo.id],
          candidateSummaries: [],
          repoReasoning: "core-app matches medhok-monorepo.",
        },
        multiBranchRetrofitPlan: {
          sourceJiraKey: "CPDEV-1234",
          repoRef: "core-app",
          sourceBranch: "master",
          targetBranches,
          skippedTargetBranches: [],
        },
      } as any);
      const harness = buildDispatcherHarness({
        assessment: retrofitAssessment,
        availableRepos: [coreAppRepo],
      });
      vi.mocked(resolveExplicitRepoHint).mockResolvedValue({
        repo: coreAppRepo,
        profileStatus: "profiled",
        selectedReason: "explicit_repo",
        explicitRepoHint: "medhok-monorepo",
        registeredCandidates: [coreAppRepo.repo_name],
        githubCandidates: [],
        blockingReasons: [],
      } as any);
      vi.mocked(resolveBranchForQualification).mockImplementation(
        async (_db, _repo, _customerBranch, ticketText: string) => {
          if (ticketText.includes("medhok-monorepo-3.18")) {
            return {
              branchName: null,
              baseCommitSha: null,
              blockingReasons: [
                "branch_not_found: medhok-monorepo-3.18 could not be resolved.",
              ],
              nonBlockingWarnings: [],
              branchCandidates: [],
              resolutionSource: "unresolved",
              selectedBranchHint: undefined,
              positiveBranchHints: [],
              ignoredNegatedBranchHints: [],
              branchConflicts: [],
              retrofitContext: undefined,
            } as any;
          }
          return {
            branchName: "medhok-monorepo-3.17",
            baseCommitSha: "branch317abc123",
            blockingReasons: [],
            nonBlockingWarnings: [],
            branchCandidates: ["medhok-monorepo-3.17"],
            resolutionSource: "explicit",
            selectedBranchHint: undefined,
            positiveBranchHints: [],
            ignoredNegatedBranchHints: [],
            branchConflicts: [],
            retrofitContext: undefined,
          } as any;
        },
      );
      vi.mocked(resolveRetrofitRepoMatches).mockImplementation(
        async (context) =>
          retrofitResolutionFor(coreAppRepo, context as any),
      );
      const createQualifiedRunGroup = vi.fn();

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-23961",
          fields: {
            summary: "Unresolved target branch retrofit",
            description:
              "Retrofit: CPDEV-1234\nRepo: medhok-monorepo\nFrom: master\nTarget: medhok-monorepo-3.17, medhok-monorepo-3.18",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        { createQualifiedRunGroup } as any,
      );

      expect(result.success).toBe(true);
      expect(createQualifiedRunGroup).not.toHaveBeenCalled();
      expect(harness.ensureNotQualifiedLabel).toHaveBeenCalled();
      expect(result.output).toContain(
        "branch_not_found: medhok-monorepo-3.18 could not be resolved.",
      );
    });

    it("rejects multi_repo with missing multiRepoPlan (semantic validation)", async () => {
      const badAssessment = buildAssessment({
        repoSelection: {
          type: "multi_repo",
          selectedRepoIds: [reactRepo.id, batchRepo.id],
          candidateSummaries: [],
          repoReasoning: "spans two repos",
        },
        // multiRepoPlan intentionally omitted
      } as any);
      const harness = buildDispatcherHarness({ assessment: badAssessment });

      // Should be caught by semantic validation → LLM parked (schema failure)
      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-40004",
          fields: {
            summary: "Multi-repo feature",
            description: "two repos",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        harness.oneShotService,
      );

      // Semantic failure is treated as a schema failure — parked for repo confirmation
      expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    });

    it("rejects multi_repo with only 1 plan slice (semantic validation)", async () => {
      const badAssessment = buildAssessment({
        repoSelection: {
          type: "multi_repo",
          selectedRepoIds: [reactRepo.id],
          candidateSummaries: [],
          repoReasoning: "only one repo",
        },
        multiRepoPlan: [
          {
            repoRef: reactRepo.repo_name,
            objective: "Add UI.",
            acceptanceCriteria: ["Panel renders."],
            mergeOrder: 1,
          },
        ],
      } as any);
      const harness = buildDispatcherHarness({ assessment: badAssessment });

      await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-40005",
          fields: {
            summary: "Single-repo but tagged multi",
            description: "only one repo",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        harness.oneShotService,
      );

      // Caught by semantic validation — no run created
      expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    });

    it("rejects multi_repo with duplicate repoRef (semantic validation)", async () => {
      const badAssessment = buildAssessment({
        repoSelection: {
          type: "multi_repo",
          selectedRepoIds: [reactRepo.id, reactRepo.id],
          candidateSummaries: [],
          repoReasoning: "duplicate",
        },
        multiRepoPlan: [
          {
            repoRef: reactRepo.repo_name,
            objective: "AC1",
            acceptanceCriteria: ["AC1"],
            mergeOrder: 1,
          },
          {
            repoRef: reactRepo.repo_name,
            objective: "AC2",
            acceptanceCriteria: ["AC2"],
            mergeOrder: 2,
          },
        ],
      } as any);
      const harness = buildDispatcherHarness({ assessment: badAssessment });

      await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-40006",
          fields: {
            summary: "Duplicate refs",
            description: "dup",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        harness.oneShotService,
      );

      expect(harness.createQualifiedRun).not.toHaveBeenCalled();
    });

    it("rejects multi-branch retrofit plans with duplicate target branches", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const badAssessment = buildAssessment({
        templateMatched: "retrofit_template",
        repoSelection: {
          type: "profiled_repo",
          selectedRepoIds: [reactRepo.id],
          candidateSummaries: [],
          repoReasoning: "react-ui owns this retrofit.",
        },
        multiBranchRetrofitPlan: {
          sourceJiraKey: "CPDEV-1234",
          repoRef: reactRepo.repo_name,
          sourceBranch: "master",
          targetBranches: ["release-3.17", "release-3.17"],
          skippedTargetBranches: [],
        },
      } as any);
      const harness = buildDispatcherHarness({ assessment: badAssessment });
      const createQualifiedRunGroup = vi.fn();

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-40007",
          fields: {
            summary: "Duplicate retrofit targets",
            description: "Duplicate target branches from the QUALIFIER plan.",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        { createQualifiedRunGroup } as any,
      );

      expect(result.success).toBe(true);
      expect(createQualifiedRunGroup).not.toHaveBeenCalled();
      expect(harness.createQualifiedRun).not.toHaveBeenCalled();
      expect(result.output).toContain(
        "multiBranchRetrofitPlan contains duplicate targetBranch: release-3.17",
      );
    });

    it("parks for confirmation when a slice repoRef cannot be resolved", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const badAssessment = buildAssessment({
        repoSelection: {
          type: "multi_repo",
          selectedRepoIds: [reactRepo.id, 9999],
          candidateSummaries: [],
          repoReasoning: "one unknown repo",
        },
        multiRepoPlan: [
          {
            repoRef: reactRepo.repo_name,
            objective: "UI",
            acceptanceCriteria: ["Renders"],
            mergeOrder: 1,
          },
          {
            repoRef: "nonexistent-repo",
            objective: "Backend",
            acceptanceCriteria: ["Works"],
            mergeOrder: 2,
          },
        ],
      } as any);
      const harness = buildDispatcherHarness({
        assessment: badAssessment,
        availableRepos: [reactRepo, batchRepo],
      });
      vi.mocked(resolveBranchForQualification).mockResolvedValue({
        branchName: "master",
        baseCommitSha: "abc123def456",
        blockingReasons: [],
        branchCandidates: [],
        resolutionSource: "default",
        selectedBranchHint: undefined,
        positiveBranchHints: [],
        ignoredNegatedBranchHints: [],
        branchConflicts: [],
        retrofitContext: undefined,
      } as any);
      const createQualifiedRunGroup = vi.fn();
      const multiOneShotService = { createQualifiedRunGroup } as any;

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-40007",
          fields: {
            summary: "Bad multi-repo",
            description: "one valid, one invalid",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        multiOneShotService,
      );

      expect(result.success).toBe(true);
      const metrics = result.metrics as any;
      expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
      expect(metrics.qualifierOutcome.reasonCode).toBe("needs_confirmation");
      expect(createQualifiedRunGroup).not.toHaveBeenCalled();
      expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
      expect(
        harness.worker.db.parkQualifierForRepoConfirmation,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          taskManagementId: harness.taskManagement.id,
          candidates: expect.arrayContaining([
            expect.objectContaining({ repoId: reactRepo.id }),
            expect.objectContaining({ repoId: batchRepo.id }),
          ]),
        }),
      );
    });

    it("passes mergeOrder in groupMetadata but not repos key", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const harness = buildDispatcherHarness({
        assessment: multiRepoAssessment,
        availableRepos: [reactRepo, batchRepo],
      });
      vi.mocked(resolveBranchForQualification).mockResolvedValue({
        branchName: "master",
        baseCommitSha: "abc123def456",
        blockingReasons: [],
        branchCandidates: [],
        resolutionSource: "default",
        selectedBranchHint: undefined,
        positiveBranchHints: [],
        ignoredNegatedBranchHints: [],
        branchConflicts: [],
        retrofitContext: undefined,
      } as any);
      const createQualifiedRunGroup = vi.fn().mockResolvedValue({
        runGroupId: 12,
        runIds: [30, 31],
        publishError: null,
      });
      const multiOneShotService = { createQualifiedRunGroup } as any;

      await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-40008",
          fields: {
            summary: "Multi-repo feature",
            description: "Two repos",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        multiOneShotService,
      );

      const callArgs = createQualifiedRunGroup.mock.calls[0][0];
      expect(callArgs.groupMetadata).toHaveProperty("mergeOrder");
      expect(callArgs.groupMetadata).not.toHaveProperty("repos");
    });

    it("parks for confirmation when a repoRef matches multiple registered repos (multi-match)", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      // Two repos that both have repo_name "batch-jobs" (different ids) or the
      // same slug in their URL, making the repoRef ambiguous.
      const batchJobsAlt: CodeRepository = {
        id: 99,
        repo_name: "batch-jobs",
        repo_url: "https://github.com/mhk-repos/cp-batch-jobs-v2.git",
        description: "Batch v2",
        default_branch: "master",
        created_at: new Date(),
      } as any;
      const ambiguousAssessment = buildAssessment({
        repoSelection: {
          type: "multi_repo",
          selectedRepoIds: [reactRepo.id, batchRepo.id],
          candidateSummaries: [],
          repoReasoning: "Two repos",
        },
        multiRepoPlan: [
          {
            repoRef: reactRepo.repo_name,
            objective: "UI change",
            acceptanceCriteria: ["Renders"],
            mergeOrder: 1,
          },
          {
            // "batch-jobs" matches both batchRepo and batchJobsAlt by repo_name
            repoRef: "batch-jobs",
            objective: "Batch change",
            acceptanceCriteria: ["Processes"],
            mergeOrder: 2,
          },
        ],
      } as any);
      const harness = buildDispatcherHarness({
        assessment: ambiguousAssessment,
        availableRepos: [reactRepo, batchRepo, batchJobsAlt],
      });
      vi.mocked(resolveBranchForQualification).mockResolvedValue({
        branchName: "master",
        baseCommitSha: "abc123def456",
        blockingReasons: [],
        branchCandidates: [],
        resolutionSource: "default",
        selectedBranchHint: undefined,
        positiveBranchHints: [],
        ignoredNegatedBranchHints: [],
        branchConflicts: [],
        retrofitContext: undefined,
      } as any);
      const createQualifiedRunGroup = vi.fn();
      const multiOneShotService = { createQualifiedRunGroup } as any;

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-40009",
          fields: {
            summary: "Multi-repo ambiguous",
            description: "Two repos, one ambiguous",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        multiOneShotService,
      );

      // Should park for confirmation rather than silently picking the first match
      expect(result.success).toBe(true);
      expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
      expect(createQualifiedRunGroup).not.toHaveBeenCalled();
    });

    it("parks a repoRef that is a bare owner prefix (org/) via strict matching", async () => {
      process.env.ONESHOT_MULTI_REPO_ENABLED = "true";
      const orgSlashAssessment = buildAssessment({
        repoSelection: {
          type: "multi_repo",
          selectedRepoIds: [reactRepo.id, batchRepo.id],
          candidateSummaries: [],
          repoReasoning: "Two repos",
        },
        multiRepoPlan: [
          {
            repoRef: reactRepo.repo_name,
            objective: "UI change",
            acceptanceCriteria: ["Renders"],
            mergeOrder: 1,
          },
          {
            // "mhk-repos/" (trailing slash) — the old code would match the
            // first repo unconditionally via includes(''); the new code rejects.
            repoRef: "mhk-repos/",
            objective: "Some change",
            acceptanceCriteria: ["Works"],
            mergeOrder: 2,
          },
        ],
      } as any);
      const harness = buildDispatcherHarness({
        assessment: orgSlashAssessment,
        availableRepos: [reactRepo, batchRepo],
      });
      vi.mocked(resolveBranchForQualification).mockResolvedValue({
        branchName: "master",
        baseCommitSha: "abc123def456",
        blockingReasons: [],
        branchCandidates: [],
        resolutionSource: "default",
        selectedBranchHint: undefined,
        positiveBranchHints: [],
        ignoredNegatedBranchHints: [],
        branchConflicts: [],
        retrofitContext: undefined,
      } as any);
      const createQualifiedRunGroup = vi.fn();
      const multiOneShotService = { createQualifiedRunGroup } as any;

      const result = await runDispatcher(
        harness.worker,
        {
          key: "CPDEV-40010",
          fields: {
            summary: "Multi-repo trailing slash",
            description: "Bad repoRef",
            labels: ["PFOS"],
          },
        },
        harness.taskManagement,
        multiOneShotService,
      );

      expect(result.success).toBe(true);
      const metrics = result.metrics as any;
      expect(result.taskManagementStatus).toBe("waiting_repo_confirmation");
      expect(metrics.qualifierOutcome.reasonCode).toBe("needs_confirmation");
      expect(createQualifiedRunGroup).not.toHaveBeenCalled();
      expect(harness.ensureNotQualifiedLabel).not.toHaveBeenCalled();
    });
  });
});

describe("QualifierWorker ensureNotQualifiedLabel stale label removal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.JIRA_BASE_URL = "https://jira.example";
  });

  afterEach(() => {
    delete process.env.JIRA_BASE_URL;
  });

  it("removes PFOS-DONE, PFOS-FAILED, PFOS-BLOCKED when adding PFOS-NOT-QUALIFIED", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 204, statusText: "No Content" });
    global.fetch = fetchMock;

    const worker = new QualifierWorker("/tmp", false) as any;
    worker.agentJiraUsername = "agent";
    worker.agentJiraToken = "token";

    await worker.ensureNotQualifiedLabel({
      key: "CPDEV-40001",
      fields: { labels: ["PFOS"], summary: "Test", description: null },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("CPDEV-40001");
    const body = JSON.parse(options.body);
    const labelOps: Array<Record<string, string>> = body.update.labels;
    expect(labelOps).toContainEqual({ add: "PFOS-NOT-QUALIFIED" });
    expect(labelOps).toContainEqual({ remove: "PFOS-DONE" });
    expect(labelOps).toContainEqual({ remove: "PFOS-FAILED" });
    expect(labelOps).toContainEqual({ remove: "PFOS-BLOCKED" });
  });

  it("does not remove PFOS outcome labels when adding SONAR-NOT-QUALIFIED", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 204, statusText: "No Content" });
    global.fetch = fetchMock;

    const worker = new QualifierWorker("/tmp", false) as any;
    worker.agentJiraUsername = "agent";
    worker.agentJiraToken = "token";

    await worker.ensureNotQualifiedLabel({
      key: "CPDEV-40002",
      fields: { labels: ["SONAR-AUTOFIX"], summary: "Test", description: null },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    const labelOps: Array<Record<string, string>> = body.update.labels;
    expect(labelOps).toContainEqual({ add: "SONAR-NOT-QUALIFIED" });
    expect(labelOps).not.toContainEqual({ remove: "PFOS-DONE" });
    expect(labelOps).not.toContainEqual({ remove: "PFOS-FAILED" });
    expect(labelOps).not.toContainEqual({ remove: "PFOS-BLOCKED" });
  });
});

describe("QualifierWorker Jira issue fetch", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      JIRA_BASE_URL: "https://jira.example",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("requests names and Jira Assets Client expansions for eligibility extraction", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        key: "CPDEV-23724",
        names: { customfield_10769: "Client" },
        fields: {
          summary: "Update Compounds from NDC 0000000000 to NDC 9999999999",
          labels: ["PFOS"],
        },
      }),
    });
    global.fetch = fetchMock;

    const worker = new QualifierWorker("/tmp", false) as any;
    worker.agentJiraUsername = "agent";
    worker.agentJiraToken = "token";

    await worker.getJiraIssue("CPDEV-23724");

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("expand")).toBe(
      "names,customfield_10769.cmdb.label,customfield_10769.cmdb.attributes",
    );
    expect(url.searchParams.get("fields")).toBe("*all");
  });
});

describe("QualifierWorker blocked-client eligibility gate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Builds a worker harness that exercises process() up to the blocked-client
   * check. OneShotService.getLatestRunByJiraKey is spied via vi.spyOn on the
   * prototype after construction. handleFreshQualification is spied so we can
   * assert it was or was not called without running the full LLM pipeline.
   */
  function buildProcessHarness(options: {
    labels: string[];
    clientName: string | null;
    blockedRows: unknown[];
  }) {
    const jiraIssue = {
      key: "CPDEV-9999",
      fields: {
        summary: "Test ticket",
        description: null,
        labels: options.labels,
        ...(options.clientName ? { customfield_10002: options.clientName } : {}),
      },
    };

    const getPoolQueryMock = vi.fn().mockResolvedValue([options.blockedRows]);

    const worker = new QualifierWorker("/tmp", false) as any;
    worker.db = {
      getTaskManagementByTaskId: vi.fn().mockResolvedValue({
        id: 100,
        customer_id: 25,
        related_code: "",
      }),
      getCustomerBranchById: vi.fn().mockResolvedValue({
        id: 25,
        customer: "Default",
        branch: "master",
      }),
      getAllRepositories: vi.fn().mockResolvedValue([]),
      getPool: vi.fn().mockReturnValue({
        query: getPoolQueryMock,
      }),
    };

    vi.spyOn(worker, "getJiraIssue").mockResolvedValue(jiraIssue);

    // Intercept OneShotService.getLatestRunByJiraKey on the prototype so
    // the instance created inside process() returns null (fresh ticket).
    vi.spyOn(OneShotService.prototype, "getLatestRunByJiraKey").mockResolvedValue(null);

    const ensureNotQualifiedLabel = vi
      .spyOn(worker, "ensureNotQualifiedLabel")
      .mockResolvedValue(undefined);

    const handleFreshQualification = vi
      .spyOn(worker, "handleFreshQualification")
      .mockResolvedValue({ success: true, output: "qualified", metrics: {} });

    return {
      worker,
      ensureNotQualifiedLabel,
      handleFreshQualification,
      getPoolQueryMock,
    };
  }

  it("rejects a fresh PFOS ticket for a blocked client before calling handleFreshQualification", async () => {
    const { worker, ensureNotQualifiedLabel, handleFreshQualification } =
      buildProcessHarness({
        labels: ["PFOS"],
        clientName: "Blocked Corp",
        blockedRows: [{
          client_key: "blocked corp",
          display_name: "Blocked Corp",
          reason: "Contract exclusion",
        }],
      });

    const result = await worker.process(
      "CPDEV-9999",
      100,
      "task description",
      "",
      "/tmp",
    );

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.metrics)).toContain("client_ineligible");
    expect(result.output).toContain("client_ineligible");
    expect(result.output).toContain("Blocked Corp");
    expect(result.output).toContain(
      "Contact the OneShot team if you believe this client should be eligible.",
    );
    expect(ensureNotQualifiedLabel).toHaveBeenCalled();
    // LLM path must NOT have been invoked
    expect(handleFreshQualification).not.toHaveBeenCalled();
  });

  it("rejects a fresh SONAR-AUTOFIX ticket for a blocked client before calling handleFreshQualification", async () => {
    const { worker, ensureNotQualifiedLabel, handleFreshQualification } =
      buildProcessHarness({
        labels: ["SONAR-AUTOFIX"],
        clientName: "Blocked Corp",
        blockedRows: [{
          client_key: "blocked corp",
          display_name: "Blocked Corp",
          reason: "Contract exclusion",
        }],
      });

    const result = await worker.process(
      "CPDEV-9999",
      100,
      "task description",
      "",
      "/tmp",
    );

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.metrics)).toContain("client_ineligible");
    expect(result.output).toContain("client_ineligible");
    expect(result.output).toContain("Blocked Corp");
    expect(result.output).toContain(
      "Contact the OneShot team if you believe this client should be eligible.",
    );
    expect(ensureNotQualifiedLabel).toHaveBeenCalled();
    expect(handleFreshQualification).not.toHaveBeenCalled();
  });

  it("allows a fresh ticket to proceed when the client is not blocked", async () => {
    const { worker, handleFreshQualification } = buildProcessHarness({
      labels: ["PFOS"],
      clientName: "Allowed Client",
      blockedRows: [],
    });

    await worker.process("CPDEV-9999", 100, "task description", "", "/tmp");

    expect(handleFreshQualification).toHaveBeenCalled();
  });

  it("allows a fresh ticket to proceed when the blocked-client policy store is unavailable", async () => {
    const { worker, handleFreshQualification, getPoolQueryMock } =
      buildProcessHarness({
        labels: ["PFOS"],
        clientName: "Blocked Corp",
        blockedRows: [],
      });
    getPoolQueryMock.mockRejectedValueOnce(
      Object.assign(new Error("No table"), { code: "ER_NO_SUCH_TABLE" }),
    );

    await worker.process("CPDEV-9999", 100, "task description", "", "/tmp");

    expect(handleFreshQualification).toHaveBeenCalled();
  });

  it("does not query the blocked-client table when no client can be extracted", async () => {
    const { worker, handleFreshQualification, getPoolQueryMock } =
      buildProcessHarness({
        labels: ["PFOS"],
        clientName: null,
        blockedRows: [],
      });

    await worker.process("CPDEV-9999", 100, "task description", "", "/tmp");

    expect(getPoolQueryMock).not.toHaveBeenCalled();
    expect(handleFreshQualification).toHaveBeenCalled();
  });
});

describe("QualifierWorker PFOS-REPLAN control label handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.JIRA_BASE_URL = "https://jira.example";
  });

  afterEach(() => {
    delete process.env.JIRA_BASE_URL;
    vi.restoreAllMocks();
  });

  function buildReplanProcessHarness(options: {
    labels: string[];
    latestRun: Record<string, unknown> | null;
  }) {
    const jiraIssue = {
      key: "CPDEV-22946",
      fields: {
        summary: "Epic duplicate ticket",
        description: null,
        labels: options.labels,
      },
    };

    const worker = new QualifierWorker("/tmp", false) as any;
    worker.agentJiraUsername = "agent";
    worker.agentJiraToken = "token";
    worker.db = {
      getTaskManagementByTaskId: vi.fn().mockResolvedValue({
        id: 100,
        customer_id: 25,
        related_code: "",
      }),
      getCustomerBranchById: vi.fn().mockResolvedValue({
        id: 25,
        customer: "Default",
        branch: "master",
      }),
      getAllRepositories: vi.fn().mockResolvedValue([]),
      getPool: vi.fn().mockReturnValue({
        query: vi.fn().mockResolvedValue([[]]),
      }),
    };

    vi.spyOn(worker, "getJiraIssue").mockResolvedValue(jiraIssue);
    vi.spyOn(OneShotService.prototype, "getLatestRunByJiraKey").mockResolvedValue(
      options.latestRun as any,
    );
    const handleFreshQualification = vi
      .spyOn(worker, "handleFreshQualification")
      .mockResolvedValue({ success: true, output: "fresh", metrics: {} });
    const handleReplan = vi
      .spyOn(worker, "handleReplan")
      .mockResolvedValue({ success: true, output: "replan", metrics: {} });
    const recordControlReplanNoop = vi
      .spyOn(OneShotService.prototype, "recordControlReplanNoop")
      .mockResolvedValue(undefined);

    return {
      worker,
      handleFreshQualification,
      handleReplan,
      recordControlReplanNoop,
      jiraIssue,
    };
  }

  it("routes PFOS-REPLAN on failed runs to same-run replan instead of fresh qualification", async () => {
    const harness = buildReplanProcessHarness({
      labels: ["PFOS", "PFOS-REPLAN"],
      latestRun: {
        id: 642,
        state: "failed",
        current_pr_url: null,
      },
    });

    const result = await harness.worker.process(
      "CPDEV-22946",
      100,
      "task description",
      "",
      "/tmp",
    );

    expect(result.output).toBe("replan");
    expect(harness.handleReplan).toHaveBeenCalled();
    expect(harness.handleFreshQualification).not.toHaveBeenCalled();
  });

  it("consumes PFOS-REPLAN without fresh qualification when no existing run exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 204, statusText: "No Content" });
    global.fetch = fetchMock;
    const harness = buildReplanProcessHarness({
      labels: ["PFOS", "PFOS-REPLAN"],
      latestRun: null,
    });

    const result = await harness.worker.process(
      "CPDEV-22946",
      100,
      "task description",
      "",
      "/tmp",
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("requires an existing same-run replan target");
    expect(harness.handleFreshQualification).not.toHaveBeenCalled();
    expect(harness.handleReplan).not.toHaveBeenCalled();
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      update: { labels: [{ remove: "PFOS-REPLAN" }] },
    });
  });

  it("consumes PFOS-REPLAN and records no-op for PR-open runs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 204, statusText: "No Content" });
    global.fetch = fetchMock;
    const latestRun = {
      id: 650,
      jira_key: "CPDEV-22946",
      state: "pr_open",
      current_pr_url: "https://github.com/org/repo/pull/12",
    };
    const harness = buildReplanProcessHarness({
      labels: ["PFOS", "PFOS-REPLAN"],
      latestRun,
    });

    await harness.worker.process(
      "CPDEV-22946",
      100,
      "task description",
      "",
      "/tmp",
    );

    expect(harness.handleFreshQualification).not.toHaveBeenCalled();
    expect(harness.handleReplan).not.toHaveBeenCalled();
    expect(harness.recordControlReplanNoop).toHaveBeenCalledWith(
      expect.objectContaining({ id: 650, state: "pr_open" }),
      "replan_not_eligible",
      expect.objectContaining({
        currentPrUrl: "https://github.com/org/repo/pull/12",
      }),
    );
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      update: { labels: [{ remove: "PFOS-REPLAN" }] },
    });
  });

  it("removes PFOS-REPLAN after successful same-run replan publish", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 204, statusText: "No Content" });
    global.fetch = fetchMock;
    vi.mocked(resolveBranchForQualification).mockResolvedValue({
      branchName: "master",
      baseCommitSha: "new-base-sha",
      blockingReasons: [],
      nonBlockingWarnings: [],
      candidateBranches: ["master"],
      branchResolution: {
        targetBranch: "master",
        requestedBranches: ["master"],
        resolvedBranch: "master",
        fallbackUsed: false,
        warnings: [],
      },
      ignoredNegatedBranchHints: [],
      branchConflicts: [],
      retrofitContext: undefined,
    } as any);
    const worker = new QualifierWorker("/tmp", false) as any;
    worker.agentJiraUsername = "agent";
    worker.agentJiraToken = "token";
    worker.db = {
      getRepositoryById: vi.fn().mockResolvedValue({
        id: 1,
        repo_name: "core-app",
        repo_url: "https://github.com/org/repo.git",
        default_branch: "master",
      }),
      getCustomerBranchById: vi.fn().mockResolvedValue({
        id: 25,
        branch: "master",
      }),
    };
    const oneShotService = {
      queueReplanRun: vi.fn().mockResolvedValue({
        state: "queued_for_planning",
        nextPlanVersion: 4,
      }),
      recordReplanLabelCleanupFailed: vi.fn(),
    };

    await worker.handleReplan(
      {
        id: 651,
        jira_key: "CPDEV-22946",
        state: "failed",
        customer_id: 25,
        repo_id: 1,
        branch_name: "master",
        base_commit_sha: "old-base-sha",
        current_pr_url: null,
      },
      oneShotService,
      Date.now(),
    );

    expect(oneShotService.queueReplanRun).toHaveBeenCalled();
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      update: { labels: [{ remove: "PFOS-REPLAN" }] },
    });
  });

  it("does not resolve the branch again when PFOS-REPLAN targets an in-flight planning run", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 204, statusText: "No Content" });
    global.fetch = fetchMock;
    vi.mocked(resolveBranchForQualification).mockClear();
    const worker = new QualifierWorker("/tmp", false) as any;
    worker.agentJiraUsername = "agent";
    worker.agentJiraToken = "token";
    worker.db = {
      getRepositoryById: vi.fn().mockResolvedValue({
        id: 1,
        repo_name: "core-app",
        repo_url: "https://github.com/org/repo.git",
        default_branch: "master",
      }),
      getCustomerBranchById: vi.fn().mockResolvedValue({
        id: 25,
        branch: "master",
      }),
    };
    const oneShotService = {
      queueReplanRun: vi.fn().mockResolvedValue({
        state: "queued_for_planning",
        nextPlanVersion: 4,
        skipped: true,
        noActionReason: "replan_already_in_flight",
      }),
      recordReplanLabelCleanupFailed: vi.fn(),
    };

    await worker.handleReplan(
      {
        id: 652,
        jira_key: "CPDEV-22946",
        state: "queued_for_planning",
        customer_id: 25,
        repo_id: 1,
        branch_name: "master",
        base_commit_sha: "existing-base-sha",
        current_pr_url: null,
      },
      oneShotService,
      Date.now(),
    );

    expect(resolveBranchForQualification).not.toHaveBeenCalled();
    expect(oneShotService.queueReplanRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 652, state: "queued_for_planning" }),
      "existing-base-sha",
    );
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({
      update: { labels: [{ remove: "PFOS-REPLAN" }] },
    });
  });
});
