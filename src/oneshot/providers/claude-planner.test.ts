import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { PromptComposer } from "../prompt-composer.js";
import { PlannerRetrofitAlreadyAppliedError } from "../retrofit-context.js";
import { ONE_SHOT_PLAN_OUTPUT_SCHEMA } from "../schema/plan.js";
import {
  ClaudePlannerProvider,
  PlannerStallError,
  validatePlannerToolPolicy,
} from "./claude-planner.js";

const { runAgentMock, registerRepoFromPathMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  registerRepoFromPathMock: vi.fn(() => "workspace"),
}));

vi.mock("../claude-sdk.js", async () => {
  const actual = await vi.importActual<
    typeof import("../claude-sdk.js")
  >("../claude-sdk.js");

  return {
    ...actual,
    runAgent: runAgentMock,
    registerRepoFromPath: registerRepoFromPathMock,
  };
});

describe("ClaudePlannerProvider", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
    registerRepoFromPathMock.mockClear();
  });

  function buildPlan(targetFiles: string[]) {
    return {
      jiraKey: "CPDEV-22054",
      repoName: "batch-jobs",
      branchName: "feature/CPDEV-22054-upgrade-logback-1.4.14",
      baseCommitSha: "40b812a1ab602c6ba494677bb3340f4d32ef18b6",
      summary: "Upgrade logback and SLF4J versions in batch modules.",
      specs: [
        {
          id: "spec-1-property-updates",
          objective: "Update version properties in the affected modules.",
          acceptanceCriteria: [
            "Affected module POMs use logback 1.4.14 and SLF4J 1.7.36 where declared.",
          ],
          targetFiles,
          implementationNotes: [
            "Update the version properties supported by inspected POM evidence.",
          ],
          validationSteps: ["mvn -pl affected-modules compile -DskipTests"],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };
  }

  function buildBatchGrounding() {
    return {
      generatedAt: "2026-05-07T12:00:00.000Z",
      jiraKey: "CPDEV-22054",
      repoName: "batch-jobs",
      confidence: "strong" as const,
      terms: [{ value: "logback", kind: "word" as const, weight: 10 }],
      routeCards: [],
      candidateFiles: [
        {
          path: "EventProcessing/pom.xml",
          score: 60,
          reasons: ["content match"],
          matchedTerms: ["logback"],
          exists: true,
        },
      ],
      snippets: [
        {
          file: "EventProcessing/pom.xml",
          line: 12,
          term: "logback.version",
          text: "<logback.version>1.0.1</logback.version>",
        },
      ],
      sourceTestPairs: [],
      riskFiles: ["EventProcessing/pom.xml"],
      warnings: [],
    };
  }

  async function writeWorkspaceFiles(
    workspacePath: string,
    files: Record<string, string>,
  ) {
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(workspacePath, file)), {
        recursive: true,
      });
      await fs.writeFile(path.join(workspacePath, file), content, "utf8");
    }
  }

  it("does not fall back to raw prose when SDK structured output is unrecoverable", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: `Preliminary scratch output:

{"summary":"missing required plan fields"}

Final answer:
\`\`\`json
{
  "jiraKey": "CPDEV-20686",
  "repoName": "core-app",
  "branchName": "master",
  "baseCommitSha": "0123456789abcdef0123456789abcdef01234567",
  "summary": "Implement the approved PFOS change.",
  "specs": [
    {
      "id": "spec-1",
      "objective": "Add the OneShot planner fix.",
      "acceptanceCriteria": ["Planner returns a valid structured plan."],
      "targetFiles": ["src/oneshot/providers/claude-planner.ts"],
      "implementationNotes": ["Use the schema-aware JSON fallback."],
      "validationSteps": ["pnpm vitest src/oneshot/providers/claude-planner.test.ts"]
    }
  ],
  "assumptions": [],
  "openQuestions": [],
  "outOfScope": [],
  "risks": []
}
\`\`\``,
      structuredOutput: {
        summary: "missing required plan fields",
      },
      metrics: {
        durationMs: 123,
        toolCalls: 1,
      },
    });

    await expect(
      provider.generatePlan({
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        workspacePath: "/tmp/workspace",
        ticketSummary: "Fix OneShot planner parsing",
        taskDescription:
          "Ensure invalid intermediate JSON does not fail planning.",
        qualificationSummary: {
          requirementsSummary: ["Planner must return a valid plan artifact."],
          acceptanceCriteriaPresent: true,
          nonBlockingWarnings: [],
        },
        revision: false,
      }),
    ).rejects.toMatchObject({
      failureKind: "schema_invalid_after_success",
    });

    expect(registerRepoFromPathMock).toHaveBeenCalledWith(
      "/tmp/workspace",
      "oneshot-run-CPDEV-20686-planner",
    );
  });

  it("does not treat null structured output as absent", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary:
          "Valid raw text should not be used after null structured output.",
        specs: [
          {
            id: "spec-1",
            objective: "Keep structured output authoritative.",
            acceptanceCriteria: [
              "Null structured output fails deterministically.",
            ],
            targetFiles: ["src/oneshot/providers/claude-planner.ts"],
            implementationNotes: [
              "Do not parse raw prose after SDK structured success.",
            ],
            validationSteps: [
              "pnpm vitest src/oneshot/providers/claude-planner.test.ts",
            ],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      }),
      structuredOutput: null,
      metrics: {
        durationMs: 123,
        toolCalls: 1,
      },
    });

    await expect(
      provider.generatePlan({
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        workspacePath: "/tmp/workspace",
        ticketSummary: "Fix OneShot planner parsing",
        taskDescription: "Ensure null structured output is not ignored.",
        qualificationSummary: {
          requirementsSummary: ["Planner must return a valid plan artifact."],
          acceptanceCriteriaPresent: true,
          nonBlockingWarnings: [],
        },
        revision: false,
      }),
    ).rejects.toMatchObject({
      failureKind: "schema_invalid_after_success",
    });
  });

  it("surfaces missing retrofit contracts with the precise normalization failure kind", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
      loadRetrofitWorkflowPrompt: vi
        .fn()
        .mockResolvedValue("CANONICAL RETROFIT WORKFLOW"),
    } as unknown as PromptComposer);
    const plan = {
      ...buildPlan(["src/oneshot/providers/claude-planner.ts"]),
      jiraKey: "CPDEV-25656",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(plan),
      structuredOutput: plan,
      metrics: {
        durationMs: 123,
        toolCalls: 1,
      },
    });

    await expect(
      provider.generatePlan({
        jiraKey: "CPDEV-25656",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        workspacePath: "/tmp/workspace",
        ticketSummary: "Centene retrofit",
        taskDescription:
          "Retrofit: CPDEV-25644\nFrom: medhok-monorepo-3.19\nTarget: master",
        qualificationSummary: {
          requirementsSummary: ["Retrofit CPDEV-25644 into master."],
          acceptanceCriteriaPresent: true,
          nonBlockingWarnings: [],
        },
        revision: false,
        retrofitContext: {
          sourceJiraKey: "CPDEV-25644",
          sourceBranch: "medhok-monorepo-3.19",
          targetBranch: "master",
        },
      }),
    ).rejects.toMatchObject({
      failureKind: "retrofit_contract_missing_after_normalization",
      details: expect.objectContaining({
        schemaValidationStage: "repair_parse",
        retrofitPlanNormalization: expect.objectContaining({
          missingAfterNormalization: true,
        }),
      }),
    });
  });

  it("includes plan-contract violation recovery guidance in revision prompts", async () => {
    const composePrompt = vi
      .fn()
      .mockImplementation(
        (_stage: string, variables: Record<string, unknown>) =>
          Promise.resolve(`base prompt\n${variables.revisionSection ?? ""}`),
      );
    const provider = new ClaudePlannerProvider({
      composePrompt,
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
    } as unknown as PromptComposer);
    const plan = buildPlan(["src/oneshot/consumers/tester.ts"]);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(plan),
      structuredOutput: plan,
      metrics: {
        durationMs: 123,
        toolCalls: 1,
      },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-20686",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Recover plan contract violation",
      taskDescription: "Implementation touched an off-contract tester file.",
      qualificationSummary: {
        requirementsSummary: ["Replan the approved file contract."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: true,
      revisionContext: {
        contractViolationContext: {
          implementationVersion: 6,
          revision: true,
          currentPlanVersion: 1,
          nextPlanVersion: 2,
          editableFiles: ["src/oneshot/consumers/implementer.ts"],
          changedFiles: [
            "src/oneshot/consumers/implementer.ts",
            "src/oneshot/consumers/tester.ts",
          ],
          violatingFiles: ["src/oneshot/consumers/tester.ts"],
          autoReplanAttempt: 1,
          autoReplanMaxAttempts: 2,
        },
      },
    });

    const revisionSection = composePrompt.mock.calls[0]?.[1]?.revisionSection;
    expect(revisionSection).toContain("Plan Contract Violation Recovery");
    expect(revisionSection).toContain("src/oneshot/consumers/tester.ts");
    expect(runAgentMock.mock.calls[0][0].taskPrompt).toContain(
      "Plan Contract Violation Recovery",
    );
    expect(runAgentMock.mock.calls[0][0].taskPrompt).toContain(
      "src/oneshot/consumers/tester.ts",
    );
  });

  it("passes schema-aware retry overrides and streaming observability options to runAgent", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Implement the approved PFOS change.",
        specs: [
          {
            id: "spec-1",
            objective: "Thread retry overrides through the planner provider.",
            acceptanceCriteria: [
              "runAgent receives the expected override set.",
            ],
            targetFiles: ["src/oneshot/providers/claude-planner.ts"],
            implementationNotes: [
              "Pass monitoring and retry options through unchanged.",
            ],
            validationSteps: [
              "pnpm vitest src/oneshot/providers/claude-planner.test.ts",
            ],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      }),
      structuredOutput: {
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Implement the approved PFOS change.",
        specs: [
          {
            id: "spec-1",
            objective: "Thread retry overrides through the planner provider.",
            acceptanceCriteria: [
              "runAgent receives the expected override set.",
            ],
            targetFiles: ["src/oneshot/providers/claude-planner.ts"],
            implementationNotes: [
              "Pass monitoring and retry options through unchanged.",
            ],
            validationSteps: [
              "pnpm vitest src/oneshot/providers/claude-planner.test.ts",
            ],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      },
      metrics: {
        durationMs: 123,
        toolCalls: 1,
      },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-20686",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Fix OneShot planner parsing",
      taskDescription: "Ensure retry overrides are threaded through.",
      qualificationSummary: {
        requirementsSummary: ["Planner must propagate runner overrides."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      attemptOverrides: {
        useOutputSchema: true,
        timeoutMs: 300_000,
        idleTimeoutMs: 60_000,
        maxTurns: 40,
        bedrockConfig: {
          model: "us.anthropic.claude-sonnet-fallback-v1:0",
        },
        permissionMode: "bypassPermissions",
        toolVisibility: "legacyAllowedToolsOnly",
        toolGuard: "enabled",
        postToolIdleTimeoutMs: 30_000,
        toolBudgetGuard: {
          enabled: true,
          tools: ["Read", "Glob", "Grep"],
          maxCalls: 12,
          message: "Emit the structured OneShot plan JSON now.",
        },
        sdkTraceMode: "failure",
      },
    });

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outputSchema: ONE_SHOT_PLAN_OUTPUT_SCHEMA,
        timeoutMs: 300_000,
        maxTurns: 40,
        toolSprawlGuard: { enabled: true },
        bedrockConfig: {
          model: "us.anthropic.claude-sonnet-fallback-v1:0",
        },
        permissionMode: "bypassPermissions",
        toolVisibility: "legacyAllowedToolsOnly",
        toolGuard: "enabled",
        postToolIdleTimeoutMs: 30_000,
        toolBudgetGuard: {
          enabled: true,
          tools: ["Read", "Glob", "Grep"],
          maxCalls: 12,
          message: "Emit the structured OneShot plan JSON now.",
        },
        sdkTraceMode: "failure",
        includePartialMessages: true,
        idleTimeoutMs: 60_000,
        compactionGraceMs: 120_000,
        systemAppend: "SYSTEM_RULES",
      }),
    );
  });

  it("passes budget and strong-grounding instructions into the active planning prompt", async () => {
    const composePrompt = vi.fn().mockResolvedValue("prompt");
    const provider = new ClaudePlannerProvider({
      composePrompt,
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Implement the approved PFOS change.",
        specs: [
          {
            id: "spec-1",
            objective: "Use grounded files without rediscovery.",
            acceptanceCriteria: ["Planner uses the grounded file list."],
            targetFiles: ["src/member/MemberSearchForm.ts"],
            implementationNotes: ["Read the smallest necessary snippet."],
            validationSteps: ["npm test"],
          },
        ],
      }),
      structuredOutput: {
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Implement the approved PFOS change.",
        specs: [
          {
            id: "spec-1",
            objective: "Use grounded files without rediscovery.",
            acceptanceCriteria: ["Planner uses the grounded file list."],
            targetFiles: ["src/member/MemberSearchForm.ts"],
            implementationNotes: ["Read the smallest necessary snippet."],
            validationSteps: ["npm test"],
          },
        ],
      },
      metrics: {
        durationMs: 10,
        toolCalls: 1,
      },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-20686",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Fix planner exploration.",
      taskDescription: "Use the deterministic grounding packet.",
      qualificationSummary: {
        requirementsSummary: ["Planner must stay focused."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      plannerSubagentsEnabled: false,
      groundingContext: {
        generatedAt: "2026-04-17T12:00:00.000Z",
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        confidence: "strong",
        terms: [{ value: "MemberSearchForm", kind: "identifier", weight: 10 }],
        routeCards: [],
        candidateFiles: [
          {
            path: "src/member/MemberSearchForm.ts",
            score: 30,
            reasons: ["content match"],
            matchedTerms: ["MemberSearchForm"],
            exists: true,
          },
        ],
        snippets: [
          {
            file: "src/member/MemberSearchForm.ts",
            line: 1,
            term: "MemberSearchForm",
            text: "export function getMemberSearchDefaults()",
          },
        ],
        sourceTestPairs: [],
        riskFiles: [],
        warnings: [],
      },
    });

    const variables = composePrompt.mock.calls[0][1];
    expect(variables.plannerFirstActionInstruction).toContain(
      "Exploration budget: about 2 minutes",
    );
    expect(variables.plannerFirstActionInstruction).toContain(
      "roughly 50 Read/Glob/Grep calls",
    );
    expect(variables.plannerFirstActionInstruction).toContain(
      "Grounding is strong",
    );
    expect(variables.plannerFirstActionInstruction).toContain(
      "Read only the smallest necessary snippets",
    );
    expect(variables.plannerFirstActionInstruction).toContain(
      "Start now with one focused Glob repository tool call",
    );
  });

  it("passes ticket-explicit new source grounding guidance into the planner prompt", async () => {
    const composePrompt = vi.fn().mockResolvedValue("prompt");
    const provider = new ClaudePlannerProvider({
      composePrompt,
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    const structuredOutput = {
      jiraKey: "CPDEV-25292",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create code classifier event support.",
      specs: [
        {
          id: "code-classifier-events",
          objective: "Use grounded service evidence for planning.",
          acceptanceCriteria: ["Planner receives ticket-explicit guidance."],
          targetFiles: [
            "MedicalMgmt/src/main/java/com/medhok/mm/server/service/CodesMasterService.java",
          ],
          implementationNotes: ["Read focused snippets."],
          validationSteps: ["mvn test"],
        },
      ],
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(structuredOutput),
      structuredOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
      },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-25292",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Create code classifier event classes.",
      taskDescription: "Use the deterministic grounding packet.",
      qualificationSummary: {
        requirementsSummary: ["Create code classifier event classes."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      plannerSubagentsEnabled: false,
      groundingContext: {
        generatedAt: "2026-07-01T12:00:00.000Z",
        jiraKey: "CPDEV-25292",
        repoName: "core-app",
        confidence: "strong",
        terms: [
          {
            value: "CodesMasterService",
            kind: "identifier",
            weight: 10,
          },
        ],
        routeCards: [],
        candidateFiles: [
          {
            path: "MedicalMgmt/src/main/java/com/medhok/mm/server/service/CodesMasterService.java",
            score: 30,
            reasons: ["content match"],
            matchedTerms: ["CodesMasterService"],
            exists: true,
          },
        ],
        snippets: [
          {
            file: "MedicalMgmt/src/main/java/com/medhok/mm/server/service/CodesMasterService.java",
            line: 42,
            term: "CodesMasterService",
            text: "class CodesMasterService",
          },
        ],
        sourceTestPairs: [],
        riskFiles: [],
        warnings: [],
      },
      groundingSummary: [
        "## Deterministic Planner Grounding",
        "",
        "**Ticket-Explicit New Java Sources**:",
        "- `CodeClassifierConfigChangedEvent.java`; package: com.medhok.mm.server.event; sources: ticket_description",
        "Only plan a ticket-explicit new Java source target when the ticket names the exact class/file, any ticket package/path evidence matches the target, and fileChangeContract cites both ticket evidence and repo-backed module evidence.",
      ].join("\n"),
    });

    const prompt = runAgentMock.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("**Ticket-Explicit New Java Sources**");
    expect(prompt).toContain("CodeClassifierConfigChangedEvent.java");
    expect(prompt).toContain(
      "fileChangeContract cites both ticket evidence and repo-backed module evidence",
    );
  });

  it("requires a native grounding scout as the first action when planner subagents are enabled", async () => {
    const composePrompt = vi.fn().mockResolvedValue("prompt");
    const provider = new ClaudePlannerProvider({
      composePrompt,
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    const structuredOutput = {
      jiraKey: "CPDEV-20686",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Implement the grounded UI change.",
      specs: [
        {
          id: "spec-1",
          objective: "Use grounded files with a narrow scout verification.",
          acceptanceCriteria: ["Planner attempts the native scout first."],
          targetFiles: ["src/member/MemberSearchForm.ts"],
          implementationNotes: ["Read focused snippets after the scout."],
          validationSteps: ["npm test"],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(structuredOutput),
      structuredOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
        toolCallProfiles: [
          {
            tool: "Agent",
            durationMs: 2,
            inputBytes: 10,
            outputBytes: 20,
            success: true,
          },
        ],
      },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-20686",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Fix planner exploration.",
      taskDescription: "Use the deterministic grounding packet.",
      qualificationSummary: {
        requirementsSummary: ["Planner must stay focused."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      plannerSubagentsEnabled: true,
      groundingContext: {
        generatedAt: "2026-04-17T12:00:00.000Z",
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        confidence: "strong",
        terms: [{ value: "MemberSearchForm", kind: "identifier", weight: 10 }],
        routeCards: [],
        candidateFiles: [
          {
            path: "src/member/MemberSearchForm.ts",
            score: 30,
            reasons: ["content match"],
            matchedTerms: ["MemberSearchForm"],
            exists: true,
          },
        ],
        snippets: [
          {
            file: "src/member/MemberSearchForm.ts",
            line: 1,
            term: "MemberSearchForm",
            text: "export function getMemberSearchDefaults()",
          },
        ],
        sourceTestPairs: [],
        riskFiles: [],
        warnings: [],
      },
    });

    const variables = composePrompt.mock.calls[0][1];
    expect(variables.plannerFirstActionInstruction).toContain(
      "Your first action must be one Agent scout call to `oneshot-grounding-scout`",
    );
    expect(variables.plannerFirstActionInstruction).toContain(
      "ask the scout to verify one narrow grounded detail",
    );
    expect(variables.plannerFirstActionInstruction).toContain(
      "After that Agent scout returns",
    );
    expect(variables.plannerFirstActionInstruction).not.toContain(
      "Start now with one focused Glob repository tool call",
    );
    expect(variables.plannerFirstActionInstruction).not.toContain(
      "do not rediscover files",
    );
  });

  it("sanitizes verbose planner discoveries and records telemetry", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);
    const oversizedPattern = "x".repeat(1500);
    const structuredOutput = {
      jiraKey: "CPDEV-20686",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Implement the approved PFOS change.",
      specs: [
        {
          id: "spec-1",
          objective: "Keep planner discoveries compact.",
          acceptanceCriteria: ["Verbose discovery strings are sanitized."],
          targetFiles: ["src/oneshot/schema/plan.ts"],
          implementationNotes: ["Sanitize before schema validation."],
          validationSteps: ["npm test"],
        },
      ],
      plannerDiscoveries: {
        relevantPatterns: Array.from({ length: 12 }, (_, index) =>
          index === 0 ? oversizedPattern : `pattern-${index}`,
        ),
      },
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(structuredOutput),
      structuredOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
      },
    });

    const response = await provider.generatePlan({
      jiraKey: "CPDEV-20686",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Fix planner discoveries.",
      taskDescription: "Keep plannerDiscoveries inside schema caps.",
      qualificationSummary: {
        requirementsSummary: ["Planner output remains schema-valid."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
    });

    expect(response.plan.plannerDiscoveries?.relevantPatterns).toHaveLength(10);
    expect(response.metrics).toMatchObject({
      plannerOutputSanitized: true,
      plannerOutputTruncatedChars: 500,
    });
    expect(
      response.metrics.plannerOutputSanitization?.truncatedFields[0],
    ).toMatchObject({
      path: "plannerDiscoveries.relevantPatterns[0]",
      originalLength: 1500,
      cap: 1000,
    });
    expect(runAgentMock.mock.calls[0][0].allowedTools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Skill",
      "Agent",
    ]);
    expect(
      runAgentMock.mock.calls[0][0].allowedBashCommandPatterns,
    ).toBeUndefined();
    expect(response.metrics.warnings).toContain(
      "planner_output_sanitized:500:truncated_chars",
    );
  });

  it("enables planner Skills and native subagents when requested", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
    } as unknown as PromptComposer);
    const structuredOutput = {
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Improve cancel button styling.",
      specs: [
        {
          id: "spec-1",
          objective: "Plan the grounded UI style change.",
          acceptanceCriteria: ["Plan cites inspected files."],
          targetFiles: ["MedicalMgmt/src/main/webapp/Medhok3.css"],
          implementationNotes: ["Use existing button styles."],
          validationSteps: ["Review affected styles."],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(structuredOutput),
      structuredOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
      },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      additionalDirectories: ["/tmp/planner-state/planner/ticket-evidence"],
      ticketSummary: "Improve cancel button styling.",
      taskDescription: "Make cancel button styling consistent.",
      qualificationSummary: {
        requirementsSummary: ["Cancel button styling is updated."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      plannerSkillsEnabled: true,
      plannerSubagentsEnabled: true,
      plannerPluginPath: "/app/oneshot-prompts/plugins/oneshot-planner",
      plannerSubagentModelId: "us.anthropic.claude-haiku-test-v1:0",
      plannerSubagentMaxTurns: 24,
    });

    const call = runAgentMock.mock.calls[0][0];
    expect(call.allowedTools).toEqual(["Read", "Glob", "Grep", "Skill", "Agent"]);
    expect(call.taskPrompt).toContain(
      "Your first Agent scout attempt is required when native subagents are enabled",
    );
    expect(call.taskPrompt).toContain(
      "If an Agent scout errors, exhausts its turn budget, times out, or returns incomplete evidence",
    );
    expect(call.taskPrompt).toContain("## Planner Skill Checklist");
    expect(call.taskPrompt).toContain("planner-grounding");
    expect(call.taskPrompt).toContain("logical-decomposition");
    expect(call.taskPrompt).toContain("medhok-domain-planning");
    expect(call.taskPrompt).toContain("test-first-validation-planning");
    expect(call.taskPrompt).toContain("root-cause-investigation-planning");
    expect(call.plugins).toEqual([
      { type: "local", path: "/app/oneshot-prompts/plugins/oneshot-planner" },
    ]);
    expect(call.skills).toEqual([
      "oneshot-planner:planner-grounding",
      "oneshot-planner:logical-decomposition",
      "oneshot-planner:medhok-domain-planning",
      "oneshot-planner:planner-scouting",
      "oneshot-planner:plan-quality-gate",
      "oneshot-planner:test-first-validation-planning",
      "oneshot-planner:root-cause-investigation-planning",
    ]);
    expect(call.settingSources).toEqual([]);
    expect(call.agents).toEqual({
      "oneshot-grounding-scout": expect.objectContaining({
        model: "us.anthropic.claude-haiku-test-v1:0",
        tools: ["Read", "Glob", "Grep"],
        disallowedTools: ["Agent", "Task"],
        maxTurns: 24,
      }),
      "oneshot-decomposition-scout": expect.objectContaining({
        model: "us.anthropic.claude-haiku-test-v1:0",
        tools: ["Read", "Glob", "Grep"],
        disallowedTools: ["Agent", "Task"],
        maxTurns: 24,
      }),
      "oneshot-domain-scout": expect.objectContaining({
        model: "us.anthropic.claude-haiku-test-v1:0",
        tools: ["Read", "Glob", "Grep"],
        disallowedTools: ["Agent", "Task"],
        maxTurns: 24,
      }),
    });
  });

  it("defaults planner Skills and native subagents on when feature flags are omitted", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
    } as unknown as PromptComposer);
    const structuredOutput = {
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Improve cancel button styling.",
      specs: [
        {
          id: "spec-1",
          objective: "Plan the grounded UI style change.",
          acceptanceCriteria: ["Plan cites inspected files."],
          targetFiles: ["MedicalMgmt/src/main/webapp/Medhok3.css"],
          implementationNotes: ["Use existing button styles."],
          validationSteps: ["Review affected styles."],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(structuredOutput),
      structuredOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
        toolCallProfiles: [
          {
            tool: "Read",
            durationMs: 2,
            inputBytes: 10,
            outputBytes: 20,
            success: true,
            filePath:
              "/tmp/workspace/MedicalMgmt/src/main/webapp/Medhok3.css",
          },
        ],
      },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      additionalDirectories: ["/tmp/planner-state/planner/ticket-evidence"],
      ticketSummary: "Improve cancel button styling.",
      taskDescription: "Make cancel button styling consistent.",
      qualificationSummary: {
        requirementsSummary: ["Cancel button styling is updated."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
    });

    const call = runAgentMock.mock.calls[0][0];
    expect(call.additionalDirectories).toEqual([
      "/tmp/planner-state/planner/ticket-evidence",
    ]);
    expect(call.allowedTools).toEqual(["Read", "Glob", "Grep", "Skill", "Agent"]);
    expect(call.plugins).toEqual([
      {
        type: "local",
        path: path.resolve(
          process.cwd(),
          "oneshot-prompts/plugins/oneshot-planner",
        ),
      },
    ]);
    expect(call.skills).toEqual([
      "oneshot-planner:planner-grounding",
      "oneshot-planner:logical-decomposition",
      "oneshot-planner:medhok-domain-planning",
      "oneshot-planner:planner-scouting",
      "oneshot-planner:plan-quality-gate",
      "oneshot-planner:test-first-validation-planning",
      "oneshot-planner:root-cause-investigation-planning",
    ]);
    expect(call.settingSources).toEqual([]);
    expect(call.agents).toEqual(
      expect.objectContaining({
        "oneshot-grounding-scout": expect.objectContaining({
          disallowedTools: ["Agent", "Task"],
        }),
      }),
    );
  });

  it("does not count Agent-only tool profiles as repository progress before discovery fallback", async () => {
    const previousFallback = process.env.ONESHOT_PLANNER_SDK_DISCOVERY_FALLBACK;
    process.env.ONESHOT_PLANNER_SDK_DISCOVERY_FALLBACK = "true";
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
    } as unknown as PromptComposer);
    const structuredOutput = {
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Improve cancel button styling.",
      specs: [
        {
          id: "spec-1",
          objective: "Plan the grounded UI style change.",
          acceptanceCriteria: ["Plan cites inspected files."],
          targetFiles: ["MedicalMgmt/src/main/webapp/Medhok3.css"],
          implementationNotes: ["Use existing button styles."],
          validationSteps: ["Review affected styles."],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };

    try {
      runAgentMock
        .mockResolvedValueOnce({
          success: true,
          output: JSON.stringify(structuredOutput),
          structuredOutput,
          metrics: {
            durationMs: 10,
            toolCalls: 1,
            toolCallProfiles: [
              {
                tool: "Agent",
                durationMs: 2,
                inputBytes: 10,
                outputBytes: 20,
                success: true,
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          success: true,
          output:
            "- Read MedicalMgmt/src/main/webapp/Medhok3.css for cancel button styles.",
          metrics: {
            durationMs: 8,
            toolCalls: 2,
            toolCallProfiles: [
              {
                tool: "Glob",
                durationMs: 2,
                inputBytes: 5,
                outputBytes: 25,
                success: true,
                pattern: "**/Medhok3.css",
              },
              {
                tool: "Read",
                durationMs: 3,
                inputBytes: 10,
                outputBytes: 20,
                success: true,
                filePath:
                  "/tmp/workspace/MedicalMgmt/src/main/webapp/Medhok3.css",
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          success: true,
          output: JSON.stringify(structuredOutput),
          structuredOutput,
          metrics: {
            durationMs: 10,
            toolCalls: 1,
            toolCallProfiles: [
              {
                tool: "Read",
                durationMs: 2,
                inputBytes: 10,
                outputBytes: 20,
                success: true,
                filePath:
                  "/tmp/workspace/MedicalMgmt/src/main/webapp/Medhok3.css",
              },
            ],
          },
        });

      const response = await provider.generatePlan({
        jiraKey: "CPDEV-23734",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        workspacePath: "/tmp/workspace",
        additionalDirectories: ["/tmp/planner-state/planner/ticket-evidence"],
        ticketSummary: "Improve cancel button styling.",
        taskDescription: "Make cancel button styling consistent.",
        qualificationSummary: {
          requirementsSummary: ["Cancel button styling is updated."],
          acceptanceCriteriaPresent: true,
          nonBlockingWarnings: [],
        },
        revision: false,
        plannerSubagentsEnabled: true,
      });

      expect(runAgentMock).toHaveBeenCalledTimes(3);
      expect(runAgentMock.mock.calls[0][0].additionalDirectories).toEqual([
        "/tmp/planner-state/planner/ticket-evidence",
      ]);
      expect(runAgentMock.mock.calls[1][0]).toMatchObject({
        additionalDirectories: ["/tmp/planner-state/planner/ticket-evidence"],
        allowedTools: ["Read", "Glob", "Grep"],
        settingSources: [],
      });
      expect(runAgentMock.mock.calls[2][0].additionalDirectories).toEqual([
        "/tmp/planner-state/planner/ticket-evidence",
      ]);
      expect(response.metrics.toolCalls).toBe(3);
      expect(response.metrics.groundingSource).toBe("llm_tools");
    } finally {
      if (previousFallback === undefined) {
        delete process.env.ONESHOT_PLANNER_SDK_DISCOVERY_FALLBACK;
      } else {
        process.env.ONESHOT_PLANNER_SDK_DISCOVERY_FALLBACK = previousFallback;
      }
    }
  });

  it("does not derive llm_tools grounding from Agent-only profiles", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);
    const structuredOutput = {
      jiraKey: "LOCAL-E2E-1",
      repoName: "local-core-app-fixture",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Enable active-only member search defaults.",
      specs: [
        {
          id: "member-search-active-default",
          objective: "Default member search to active members only.",
          acceptanceCriteria: ["Member search defaults set activeOnly to true."],
          targetFiles: ["src/member/MemberSearchForm.ts"],
          implementationNotes: ["Keep the helper return shape unchanged."],
          validationSteps: ["npm test"],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(structuredOutput),
      structuredOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
        toolCallProfiles: [
          {
            tool: "Agent",
            durationMs: 2,
            inputBytes: 10,
            outputBytes: 20,
            success: true,
          },
        ],
      },
    });

    const response = await provider.generatePlan({
      jiraKey: "LOCAL-E2E-1",
      repoName: "local-core-app-fixture",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Enable active-only default for member search.",
      taskDescription:
        "Change MemberSearchForm so activeOnly defaults to true.",
      qualificationSummary: {
        requirementsSummary: ["Member search defaults set activeOnly to true."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      groundingContext: {
        generatedAt: "2026-04-17T12:00:00.000Z",
        jiraKey: "LOCAL-E2E-1",
        repoName: "local-core-app-fixture",
        confidence: "strong",
        terms: [{ value: "MemberSearchForm", kind: "identifier", weight: 10 }],
        routeCards: [],
        candidateFiles: [
          {
            path: "src/member/MemberSearchForm.ts",
            score: 30,
            reasons: ["file path match", "content match"],
            matchedTerms: ["MemberSearchForm"],
            exists: true,
          },
        ],
        snippets: [
          {
            file: "src/member/MemberSearchForm.ts",
            line: 1,
            term: "MemberSearchForm",
            text: "export function getMemberSearchDefaults()",
          },
        ],
        sourceTestPairs: [],
        testCommand: "npm test",
        testPattern: "*.test.ts",
        riskFiles: [],
        warnings: [],
      },
      groundingSummary: "## Deterministic Planner Grounding",
      plannerSubagentsEnabled: true,
    });

    expect(response.metrics).toMatchObject({
      toolCalls: 1,
      groundingSource: "deterministic",
      plannerSubagentAttempted: true,
      plannerSubagentAttemptMissing: false,
      plannerSubagentOutcome: "attempted_succeeded",
    });
    expect(response.metrics.warnings).toContain(
      "planner_grounded_without_llm_tools",
    );
  });

  it("uses successful Glob filenames as UI asset existence evidence without requiring asset reads", async () => {
    const targetFile =
      "src/core/design-system/icons/assets/action/fullscreen.svg";
    const supportFile =
      "src/core/design-system/icons/assets/action/expand-all.svg";
    const iconMapFile = "src/core/design-system/icons/icon-map.ts";
    const structuredOutput = {
      jiraKey: "CPDEV-20089",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Add fullscreen icon asset.",
      specs: [
        {
          id: "fullscreen-icon",
          objective: "Add a design-system fullscreen icon asset.",
          acceptanceCriteria: [
            "Fullscreen controls use a source-backed design-system icon.",
          ],
          targetFiles: [targetFile],
          implementationNotes: ["Create the adjacent icon asset."],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: [
        {
          path: targetFile,
          role: "config_required",
          editable: true,
          rationale:
            "New fullscreen icon belongs beside the discovered action icon assets.",
          supportingEvidence: [
            `Glob discovered ${supportFile} as an adjacent action icon asset.`,
          ],
          allowedChanges: ["Create the fullscreen SVG asset."],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(structuredOutput),
      structuredOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 2,
        toolCallProfiles: [
          {
            tool: "Read",
            durationMs: 2,
            inputBytes: 10,
            outputBytes: 20,
            success: true,
            filePath: `/tmp/workspace/${iconMapFile}`,
          },
          {
            tool: "Glob",
            durationMs: 2,
            inputBytes: 10,
            outputBytes: 20,
            success: true,
            directory: "src/core/design-system/icons/assets/action",
            pattern: "*.svg",
            filenames: [supportFile],
          },
        ],
      },
    });

    const response = await provider.generatePlan({
      jiraKey: "CPDEV-20089",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Add fullscreen icon asset.",
      taskDescription: "Add fullscreen icon asset beside action icons.",
      qualificationSummary: {
        requirementsSummary: ["Add a fullscreen icon asset."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      groundingContext: {
        generatedAt: "2026-06-24T00:00:00.000Z",
        jiraKey: "CPDEV-20089",
        repoName: "core-app",
        confidence: "strong",
        terms: [{ value: "fullscreen", kind: "identifier", weight: 10 }],
        routeCards: [],
        candidateFiles: [
          {
            path: iconMapFile,
            score: 60,
            reasons: ["content match", "design-system asset pattern"],
            matchedTerms: ["fullscreen"],
            exists: true,
          },
        ],
        snippets: [
          {
            file: iconMapFile,
            line: 1,
            term: "fullscreen",
            text: "expand-all and collapse-all icons are registered",
          },
        ],
        sourceTestPairs: [],
        riskFiles: [iconMapFile],
        warnings: [],
      },
      groundingSummary: "## Deterministic Planner Grounding",
      attemptOverrides: { useOutputSchema: true },
    });

    expect(response.plan.specs[0]?.targetFiles).toEqual([targetFile]);
    expect(response.metrics.toolCalls).toBe(2);
  });

  it("does not derive repository progress from ticket evidence sidecar reads", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);
    const structuredOutput = {
      jiraKey: "LOCAL-E2E-1",
      repoName: "local-core-app-fixture",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Enable active-only member search defaults.",
      specs: [
        {
          id: "member-search-active-default",
          objective: "Default member search to active members only.",
          acceptanceCriteria: ["Member search defaults set activeOnly to true."],
          targetFiles: ["src/member/MemberSearchForm.ts"],
          implementationNotes: ["Keep the helper return shape unchanged."],
          validationSteps: ["npm test"],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(structuredOutput),
      structuredOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 3,
        toolCallProfiles: [
          {
            tool: "Read",
            durationMs: 2,
            inputBytes: 10,
            outputBytes: 20,
            success: true,
            filePath: "/tmp/planner-state/planner/ticket-evidence/index.md",
          },
          {
            tool: "Grep",
            durationMs: 2,
            inputBytes: 10,
            outputBytes: 20,
            success: true,
            searchPath: "/tmp/planner-state/planner/ticket-evidence",
          },
          {
            tool: "Glob",
            durationMs: 2,
            inputBytes: 10,
            outputBytes: 20,
            success: true,
            directory: "/tmp/planner-state/planner/ticket-evidence",
          },
        ],
      },
    });

    const response = await provider.generatePlan({
      jiraKey: "LOCAL-E2E-1",
      repoName: "local-core-app-fixture",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Enable active-only default for member search.",
      taskDescription:
        "Change MemberSearchForm so activeOnly defaults to true.",
      qualificationSummary: {
        requirementsSummary: ["Member search defaults set activeOnly to true."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      groundingContext: {
        generatedAt: "2026-04-17T12:00:00.000Z",
        jiraKey: "LOCAL-E2E-1",
        repoName: "local-core-app-fixture",
        confidence: "strong",
        terms: [{ value: "MemberSearchForm", kind: "identifier", weight: 10 }],
        routeCards: [],
        candidateFiles: [
          {
            path: "src/member/MemberSearchForm.ts",
            score: 30,
            reasons: ["file path match", "content match"],
            matchedTerms: ["MemberSearchForm"],
            exists: true,
          },
        ],
        snippets: [
          {
            file: "src/member/MemberSearchForm.ts",
            line: 1,
            term: "MemberSearchForm",
            text: "export function getMemberSearchDefaults()",
          },
        ],
        sourceTestPairs: [],
        testCommand: "npm test",
        testPattern: "*.test.ts",
        riskFiles: [],
        warnings: [],
      },
      groundingSummary: "## Deterministic Planner Grounding",
    });

    expect(response.metrics).toMatchObject({
      toolCalls: 3,
      groundingSource: "deterministic",
    });
    expect(response.metrics.warnings).toContain(
      "planner_grounded_without_llm_tools",
    );
  });

  it("records a non-fatal metric when native subagents are enabled but no Agent scout was attempted", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);
    const structuredOutput = {
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Improve cancel button styling.",
      specs: [
        {
          id: "spec-1",
          objective: "Plan the grounded UI style change.",
          acceptanceCriteria: ["Plan cites inspected files."],
          targetFiles: ["MedicalMgmt/src/main/webapp/Medhok3.css"],
          implementationNotes: ["Use existing button styles."],
          validationSteps: ["Review affected styles."],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(structuredOutput),
      structuredOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
        toolCallProfiles: [
          {
            tool: "Read",
            durationMs: 2,
            inputBytes: 10,
            outputBytes: 20,
            success: true,
            filePath:
              "/tmp/workspace/MedicalMgmt/src/main/webapp/Medhok3.css",
          },
        ],
      },
    });

    const response = await provider.generatePlan({
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Improve cancel button styling.",
      taskDescription: "Make cancel button styling consistent.",
      qualificationSummary: {
        requirementsSummary: ["Cancel button styling is updated."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      plannerSubagentsEnabled: true,
    });

    expect(response.plan.summary).toBe("Improve cancel button styling.");
    expect(response.metrics.plannerSubagentAttempted).toBe(false);
    expect(response.metrics.plannerSubagentAttemptMissing).toBe(true);
    expect(response.metrics.plannerSubagentOutcome).toBe(
      "configured_not_attempted",
    );
    expect(response.metrics.warnings).toContain(
      "planner_subagent_attempt_missing",
    );
  });

  it("records a non-blocking failed native subagent outcome when Agent was attempted but did not start", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);
    const structuredOutput = {
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Improve cancel button styling.",
      specs: [
        {
          id: "spec-1",
          objective: "Plan the grounded UI style change.",
          acceptanceCriteria: ["Plan cites inspected files."],
          targetFiles: ["MedicalMgmt/src/main/webapp/Medhok3.css"],
          implementationNotes: ["Use existing button styles."],
          validationSteps: ["Review affected styles."],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(structuredOutput),
      structuredOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
        sdkLifecycleSummary: {
          permissionDenials: [
            {
              tool_name: "Agent",
              tool_use_id: "tool-agent-hook-denied",
              source: "pre_tool_use_policy",
              reason: "Agent tool input must include allowed subagent_type.",
            },
          ],
        },
        toolCallProfiles: [
          {
            tool: "Read",
            durationMs: 2,
            inputBytes: 10,
            outputBytes: 20,
            success: true,
            filePath:
              "/tmp/workspace/MedicalMgmt/src/main/webapp/Medhok3.css",
          },
        ],
      },
    });

    const response = await provider.generatePlan({
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Improve cancel button styling.",
      taskDescription: "Make cancel button styling consistent.",
      qualificationSummary: {
        requirementsSummary: ["Cancel button styling is updated."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      plannerSubagentsEnabled: true,
    });

    expect(response.plan.summary).toBe("Improve cancel button styling.");
    expect(response.metrics.plannerSubagentAttempted).toBe(true);
    expect(response.metrics.plannerSubagentAttemptMissing).toBe(false);
    expect(response.metrics.plannerSubagentOutcome).toBe(
      "attempted_failed_or_denied",
    );
    expect(response.metrics.warnings).not.toContain(
      "planner_subagent_attempt_missing",
    );
  });

  it("does not record missing subagent-attempt telemetry when native subagents are disabled", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);
    const structuredOutput = {
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Improve cancel button styling.",
      specs: [
        {
          id: "spec-1",
          objective: "Plan the grounded UI style change.",
          acceptanceCriteria: ["Plan cites inspected files."],
          targetFiles: ["MedicalMgmt/src/main/webapp/Medhok3.css"],
          implementationNotes: ["Use existing button styles."],
          validationSteps: ["Review affected styles."],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(structuredOutput),
      structuredOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
        toolCallProfiles: [
          {
            tool: "Read",
            durationMs: 2,
            inputBytes: 10,
            outputBytes: 20,
            success: true,
            filePath:
              "/tmp/workspace/MedicalMgmt/src/main/webapp/Medhok3.css",
          },
        ],
      },
    });

    const response = await provider.generatePlan({
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Improve cancel button styling.",
      taskDescription: "Make cancel button styling consistent.",
      qualificationSummary: {
        requirementsSummary: ["Cancel button styling is updated."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      plannerSubagentsEnabled: false,
    });

    expect(response.metrics.plannerSubagentAttempted).toBeUndefined();
    expect(response.metrics.plannerSubagentAttemptMissing).toBeUndefined();
    expect(response.metrics.warnings).not.toContain(
      "planner_subagent_attempt_missing",
    );
  });

  it("does not expose Agent or planner plugin assets when disabled", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);
    const structuredOutput = {
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Improve cancel button styling.",
      specs: [
        {
          id: "spec-1",
          objective: "Plan the grounded UI style change.",
          acceptanceCriteria: ["Plan cites inspected files."],
          targetFiles: ["MedicalMgmt/src/main/webapp/Medhok3.css"],
          implementationNotes: ["Use existing button styles."],
          validationSteps: ["Review affected styles."],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(structuredOutput),
      structuredOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
      },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Improve cancel button styling.",
      taskDescription: "Make cancel button styling consistent.",
      qualificationSummary: {
        requirementsSummary: ["Cancel button styling is updated."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      plannerSkillsEnabled: false,
      plannerSubagentsEnabled: false,
      plannerPluginPath: "/missing/plugin",
      plannerSubagentModelId: "us.anthropic.claude-haiku-test-v1:0",
    });

    const call = runAgentMock.mock.calls[0][0];
    expect(call.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(call.plugins).toBeUndefined();
    expect(call.skills).toBeUndefined();
    expect(call.agents).toBeUndefined();
    expect(call.taskPrompt).not.toContain("## Planner Skill Checklist");
  });

  it("sanitizes planner discoveries after grounding enrichment", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);
    const structuredOutput = {
      jiraKey: "CPDEV-20626",
      repoName: "interop",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Implement questionnaire package support.",
      specs: [
        {
          id: "spec-1",
          objective: "Update DTR service.",
          acceptanceCriteria: [
            "Questionnaire package includes internal assessments.",
          ],
          targetFiles: [
            "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/DTRService.java",
          ],
          implementationNotes: ["Use existing DTR service patterns."],
          validationSteps: ["mvn test"],
        },
      ],
      plannerDiscoveries: {
        relevantPatterns: Array.from(
          { length: 6 },
          (_, index) => `pattern-${index}`,
        ),
      },
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(structuredOutput),
      structuredOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
      },
    });

    const response = await provider.generatePlan({
      jiraKey: "CPDEV-20626",
      repoName: "interop",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Fix questionnaire package.",
      taskDescription: "Support internal assessments.",
      qualificationSummary: {
        requirementsSummary: [
          "Internal assessment questionnaires are returned.",
        ],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      groundingContext: {
        generatedAt: "2026-05-01T00:00:00.000Z",
        jiraKey: "CPDEV-20626",
        repoName: "interop",
        confidence: "strong",
        terms: [{ value: "DTRService", kind: "identifier", weight: 10 }],
        routeCards: [],
        candidateFiles: [
          {
            path: "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/DTRService.java",
            score: 30,
            reasons: ["content match"],
            matchedTerms: ["DTRService"],
            exists: true,
          },
        ],
        snippets: [
          {
            file: "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/DTRService.java",
            line: 1,
            term: "DTRService",
            text: "class DTRService",
          },
        ],
        sourceTestPairs: Array.from({ length: 40 }, (_, index) => ({
          sourceFile: `mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/service/VeryLongSourceName${index}.java`,
          testFiles: [
            `mhk-interopt-fhirhelper/src/test/java/com/mhkinterop/fhir/service/VeryLongSourceName${index}Test.java`,
            `mhk-interopt-fhirhelper/src/test/java/com/mhkinterop/fhir/service/VeryLongSourceName${index}ScenarioTest.java`,
          ],
        })),
        riskFiles: [],
        warnings: [],
      },
    });

    expect(
      response.plan.plannerDiscoveries?.relevantPatterns?.[7]?.length,
    ).toBeLessThanOrEqual(1000);
    expect(response.plan.plannerDiscoveries?.relevantPatterns?.[7]).toContain(
      "Grounded source/test pairs:",
    );
    expect(response.metrics.plannerOutputSanitized).toBeUndefined();
  });

  it("prepends route-card context ahead of broad planner prompt context", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("base prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Implement the approved PFOS change.",
        specs: [
          {
            id: "spec-1",
            objective: "Use route cards before exploration.",
            acceptanceCriteria: ["Route card context is in the prompt."],
            targetFiles: ["src/example.ts"],
            implementationNotes: ["Plan against discovered paths."],
            validationSteps: ["npm test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      }),
      structuredOutput: {
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Implement the approved PFOS change.",
        specs: [
          {
            id: "spec-1",
            objective: "Use route cards before exploration.",
            acceptanceCriteria: ["Route card context is in the prompt."],
            targetFiles: ["src/example.ts"],
            implementationNotes: ["Plan against discovered paths."],
            validationSteps: ["npm test"],
          },
        ],
      },
      metrics: { durationMs: 10, toolCalls: 1 },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-20686",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Fix OneShot planner parsing",
      taskDescription: "Ensure route-card context is sent.",
      qualificationSummary: {
        requirementsSummary: ["Planner must see route-card context."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      repoScanSummary: "## Repo Scan",
      routeCardContext: "## Repo Route Cards\nMemberSearchForm",
    });

    expect(runAgentMock.mock.calls[0][0].taskPrompt).toMatch(
      /^## Repo Route Cards\nMemberSearchForm\n\n---\n\n## Repo Scan/,
    );
    // NOTE: the "Output Contract Addendum" (containing targetFileRationales[]
    // and "not hidden chain-of-thought" phrasing) was removed from the task
    // prompt. Those constraints now live in the system prompt
    // (oneshot-prompts/prompts/plan-system.md, Planning Methodology #3) so
    // the model receives them once rather than duplicated across system +
    // task prompts. This test now only validates the prepend order.
  });

  it("includes ticket-backed frontend grounding candidates in the active planning prompt", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("base prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "CPDEV-24554",
        repoName: "React-based-new-ui",
        branchName: "main",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Plan Policy Library upload work.",
        specs: [
          {
            id: "spec-1",
            objective: "Use ticket-backed frontend grounding.",
            acceptanceCriteria: ["Prompt includes the frontend candidates."],
            targetFiles: ["src/policy-library/policy-library-page.tsx"],
            implementationNotes: ["Use inspected repo template evidence."],
            validationSteps: ["npm test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      }),
      structuredOutput: {
        jiraKey: "CPDEV-24554",
        repoName: "React-based-new-ui",
        branchName: "main",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Plan Policy Library upload work.",
        specs: [
          {
            id: "spec-1",
            objective: "Use ticket-backed frontend grounding.",
            acceptanceCriteria: ["Prompt includes the frontend candidates."],
            targetFiles: ["src/policy-library/policy-library-page.tsx"],
            implementationNotes: ["Use inspected repo template evidence."],
            validationSteps: ["npm test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      },
      metrics: { durationMs: 10, toolCalls: 1 },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-24554",
      repoName: "React-based-new-ui",
      branchName: "main",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Policy Library Upload",
      taskDescription: "Create the Policy Library upload UI.",
      qualificationSummary: {
        requirementsSummary: ["Planner must see frontend grounding."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      groundingSummary:
        "## Deterministic Planner Grounding\n\n**Ticket-backed frontend feature candidates**:\n- Policy Library (slug: `policy-library`; API/backend intent: yes; sources: ticket summary)\n\nNew frontend UI/API files are allowed only when their feature slug is ticket-backed here and the fileChangeContract cites both ticket intent and inspected repo template evidence.",
    });

    expect(runAgentMock.mock.calls[0][0].taskPrompt).toContain(
      "**Ticket-backed frontend feature candidates**:",
    );
    expect(runAgentMock.mock.calls[0][0].taskPrompt).toContain(
      "slug: `policy-library`",
    );
    expect(runAgentMock.mock.calls[0][0].taskPrompt).toContain(
      "New frontend UI/API files are allowed only",
    );
  });

  it("classifies zero-tool timeout with no structured output as no_progress", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: false,
      output: "",
      structuredOutput: null,
      failureKind: "wall_timeout",
      error: "SDK timeout after 300000ms",
      metrics: {
        durationMs: 300_000,
        toolCalls: 0,
      },
    });

    await expect(
      provider.generatePlan({
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        workspacePath: "/tmp/workspace",
        ticketSummary: "Fix OneShot planner parsing",
        taskDescription: "Ensure no-progress timeout is classified.",
        qualificationSummary: {
          requirementsSummary: ["Planner must expose no-progress failures."],
          acceptanceCriteriaPresent: true,
          nonBlockingWarnings: [],
        },
        revision: false,
      }),
    ).rejects.toMatchObject({
      name: "PlannerStallError",
      failureKind: "no_progress",
    } satisfies Partial<PlannerStallError>);
  });

  it("passes advisory project guidance from the repo scan into the active planning prompt", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("base prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Plan using advisory repo guidance.",
        specs: [
          {
            id: "spec-1",
            objective: "Follow relevant soft project guidance.",
            acceptanceCriteria: ["Planner treats guidance as advisory."],
            targetFiles: ["src/example.ts"],
            implementationNotes: [
              "Use direct code evidence over stale project guidance.",
            ],
            validationSteps: ["npm test"],
          },
        ],
      }),
      metrics: { durationMs: 10, toolCalls: 1 },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-20686",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Use repo guidance.",
      taskDescription: "Treat guidance files as advisory.",
      qualificationSummary: {
        requirementsSummary: ["Guidance files are soft checks."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      repoScanSummary: [
        "## Codebase Intelligence (pre-scanned)",
        "",
        "## Project Guidance (Advisory)",
        "",
        "The following repo-local guidance files are soft conventions and navigation hints, not mandatory validation gates.",
      ].join("\n"),
    });

    expect(runAgentMock.mock.calls[0][0].taskPrompt).toContain(
      "## Project Guidance (Advisory)",
    );
    expect(runAgentMock.mock.calls[0][0].taskPrompt).toContain(
      "not mandatory validation gates",
    );
    expect(runAgentMock.mock.calls[0][0].taskPrompt).toMatch(
      /^## Codebase Intelligence \(pre-scanned\)/,
    );
  });

  it("documents generated/cache candidate-diff exclusions in plan guardrails", async () => {
    const guardrailAsset = await fs.readFile(
      new URL(
        "../../../oneshot-prompts/guardrails/plan-guardrails.md",
        import.meta.url,
      ),
      "utf8",
    );

    expect(guardrailAsset).toContain("Generated/Cache Artifact Exclusion");
    expect(guardrailAsset).toContain("forbidden candidate-diff paths");
    expect(guardrailAsset).toContain("**/.m2/repository/**");
    expect(guardrailAsset).toContain(
      "Maven may create local repository output during validation",
    );
    expect(guardrailAsset).toContain(".m2/settings.xml");
  });

  it("instructs the planner not to fabricate documentation deliverables", async () => {
    const planSystemPrompt = await fs.readFile(
      new URL(
        "../../../oneshot-prompts/prompts/plan-system.md",
        import.meta.url,
      ),
      "utf8",
    );

    expect(planSystemPrompt).toContain(
      "Do not invent documentation deliverables",
    );
    expect(planSystemPrompt).toContain("No fabricated documentation targets");
  });

  it("documents PRISM-style contracts, code sketches, and guardrail reports in the planner system prompt", async () => {
    const planSystemPrompt = await fs.readFile(
      new URL(
        "../../../oneshot-prompts/prompts/plan-system.md",
        import.meta.url,
      ),
      "utf8",
    );

    expect(planSystemPrompt).toContain("fileChangeContract");
    expect(planSystemPrompt).toContain("plannedCodeChanges");
    expect(planSystemPrompt).toContain("guardrailReport");
    expect(planSystemPrompt).toContain("testingStrategy");
    expect(planSystemPrompt).toContain("plannedAutomatedTests");
    expect(planSystemPrompt).toContain("test_first");
    expect(planSystemPrompt).toContain("write or update the failing test");
    expect(planSystemPrompt).toContain("implementerGuardrails");
    expect(planSystemPrompt).toContain("runtime_required");
    expect(planSystemPrompt).toContain("read_only_evidence");
    expect(planSystemPrompt).toContain("source_parity");
    expect(planSystemPrompt).toContain("Code sketches are design intent");
    expect(planSystemPrompt).toContain(
      "PFOS/security remediation applies only when ticket evidence proves CVE/package remediation",
    );
    expect(planSystemPrompt).toContain(
      "the only additional first-action tool is `Agent` to the configured read-only grounding scout",
    );
  });

  it("documents root schema keys and banned wrapper fields in the planner system prompt", async () => {
    const planSystemPrompt = await fs.readFile(
      new URL(
        "../../../oneshot-prompts/prompts/plan-system.md",
        import.meta.url,
      ),
      "utf8",
    );

    for (const key of [
      "jiraKey",
      "repoName",
      "branchName",
      "baseCommitSha",
      "summary",
      "implementationMode",
      "specs",
      "fileChangeContract",
      "plannedCodeChanges",
      "guardrailReport",
      "testingStrategy",
      "implementerGuardrails",
    ]) {
      expect(planSystemPrompt).toContain(key);
    }
    for (const key of [
      "metadata",
      "planVersion",
      "title",
      "status",
      "schemaVersion",
      "diagnostics",
    ]) {
      expect(planSystemPrompt).toContain(key);
    }
  });

  it("rejects schema-valid planner output when no repository tools were used", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Ungrounded plan.",
        specs: [
          {
            id: "spec-1",
            objective: "Return a plan without exploring.",
            acceptanceCriteria: ["This should be rejected."],
            targetFiles: ["src/example.ts"],
            implementationNotes: ["No inspection happened."],
            validationSteps: ["npm test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      }),
      structuredOutput: {
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Ungrounded plan.",
        specs: [
          {
            id: "spec-1",
            objective: "Return a plan without exploring.",
            acceptanceCriteria: ["This should be rejected."],
            targetFiles: ["src/example.ts"],
            implementationNotes: ["No inspection happened."],
            validationSteps: ["npm test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      },
      metrics: {
        durationMs: 10,
        toolCalls: 0,
        tokensUsed: {
          input: 100,
          output: 200,
        },
        costUsd: 0.01,
        modelUsed: "us.anthropic.claude-opus-4-6-v1",
      },
    });

    await expect(
      provider.generatePlan({
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        workspacePath: "/tmp/workspace",
        ticketSummary: "Reject ungrounded plans",
        taskDescription: "A schema-valid plan with no tool calls should fail.",
        qualificationSummary: {
          requirementsSummary: ["Planner must inspect repository files."],
          acceptanceCriteriaPresent: true,
          nonBlockingWarnings: [],
        },
        revision: false,
      }),
    ).rejects.toMatchObject({
      name: "PlannerStallError",
      failureKind: "no_progress",
      details: expect.objectContaining({
        hasStructuredOutput: true,
        modelUsed: "us.anthropic.claude-opus-4-6-v1",
        outputPreview: expect.any(String),
        metrics: expect.objectContaining({
          costUsd: 0.01,
          tokensUsed: {
            input: 100,
            output: 200,
          },
        }),
      }),
    } satisfies Partial<PlannerStallError>);
  });

  it("accepts zero-tool planner output when deterministic grounding is strong", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "LOCAL-E2E-1",
        repoName: "local-core-app-fixture",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Enable active-only member search defaults.",
        specs: [
          {
            id: "member-search-active-default",
            objective: "Default member search to active members only.",
            acceptanceCriteria: [
              "Member search defaults set activeOnly to true.",
            ],
            targetFiles: ["src/member/MemberSearchForm.ts"],
            implementationNotes: ["Keep the helper return shape unchanged."],
            validationSteps: ["npm test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      }),
      structuredOutput: {
        jiraKey: "LOCAL-E2E-1",
        repoName: "local-core-app-fixture",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Enable active-only member search defaults.",
        specs: [
          {
            id: "member-search-active-default",
            objective: "Default member search to active members only.",
            acceptanceCriteria: [
              "Member search defaults set activeOnly to true.",
            ],
            targetFiles: ["src/member/MemberSearchForm.ts"],
            implementationNotes: ["Keep the helper return shape unchanged."],
            validationSteps: ["npm test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      },
      metrics: {
        durationMs: 10,
        toolCalls: 0,
      },
    });

    const response = await provider.generatePlan({
      jiraKey: "LOCAL-E2E-1",
      repoName: "local-core-app-fixture",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Enable active-only default for member search.",
      taskDescription:
        "Change MemberSearchForm so activeOnly defaults to true.",
      qualificationSummary: {
        requirementsSummary: ["Member search defaults set activeOnly to true."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      groundingContext: {
        generatedAt: "2026-04-17T12:00:00.000Z",
        jiraKey: "LOCAL-E2E-1",
        repoName: "local-core-app-fixture",
        confidence: "strong",
        terms: [{ value: "MemberSearchForm", kind: "identifier", weight: 10 }],
        routeCards: [],
        candidateFiles: [
          {
            path: "src/member/MemberSearchForm.ts",
            score: 30,
            reasons: ["file path match", "content match"],
            matchedTerms: ["MemberSearchForm"],
            exists: true,
          },
        ],
        snippets: [
          {
            file: "src/member/MemberSearchForm.ts",
            line: 1,
            term: "MemberSearchForm",
            text: "export function getMemberSearchDefaults()",
          },
        ],
        sourceTestPairs: [],
        testCommand: "npm test",
        testPattern: "*.test.ts",
        riskFiles: [],
        warnings: [],
      },
      groundingSummary: "## Deterministic Planner Grounding",
    });

    expect(response.metrics).toMatchObject({
      toolCalls: 0,
      llmToolCalls: 0,
      groundingCandidateFiles: 1,
      groundingConfidence: "strong",
      groundingSource: "deterministic",
    });
    expect(response.metrics.warnings).toContain(
      "planner_grounded_without_llm_tools",
    );
    expect(response.plan.plannerDiscoveries?.entryPoints).toContain(
      "src/member/MemberSearchForm.ts",
    );
    expect(response.plan.plannerDiscoveries?.testCommand).toBe("npm test");
  });

  it("accepts zero-tool planner output when qualification inspection evidence is trusted", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "CPDEV-20908",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Style Member Search cancel button.",
        specs: [
          {
            id: "style-cancel",
            objective: "Apply the qualified cancel button style.",
            acceptanceCriteria: ["Cancel button is red."],
            targetFiles: [
              "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
            ],
            implementationNotes: ["Use qualification inspection evidence."],
            validationSteps: ["mvn test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      }),
      structuredOutput: {
        jiraKey: "CPDEV-20908",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Style Member Search cancel button.",
        specs: [
          {
            id: "style-cancel",
            objective: "Apply the qualified cancel button style.",
            acceptanceCriteria: ["Cancel button is red."],
            targetFiles: [
              "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
            ],
            implementationNotes: ["Use qualification inspection evidence."],
            validationSteps: ["mvn test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      },
      metrics: {
        durationMs: 10,
        toolCalls: 0,
      },
    });

    const response = await provider.generatePlan({
      jiraKey: "CPDEV-20908",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Member Search: Style cancel button",
      taskDescription: "Style the cancel button.",
      qualificationSummary: {
        requirementsSummary: ["Style the cancel button red."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      groundingContext: {
        generatedAt: "2026-04-17T12:00:00.000Z",
        jiraKey: "CPDEV-20908",
        repoName: "core-app",
        confidence: "strong",
        terms: [],
        routeCards: [],
        candidateFiles: [],
        snippets: [],
        sourceTestPairs: [],
        qualificationEvidence: {
          trusted: true,
          verifiedInspectedFiles: [
            "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
          ],
          inspectionSummary: "Confirmed file and line numbers.",
          reasons: [],
        },
        riskFiles: [],
        warnings: [],
      },
      groundingSummary: "## Deterministic Planner Grounding",
    });

    expect(response.metrics).toMatchObject({
      toolCalls: 0,
      groundingConfidence: "strong",
      groundingSource: "deterministic",
    });
    expect(response.plan.plannerDiscoveries?.entryPoints).toContain(
      "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
    );
  });

  it("accepts zero-tool planner output when scout evidence is strong", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "CPDEV-20908",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Fix approval queue routing.",
        specs: [
          {
            id: "queue-routing",
            objective: "Fix approval queue routing.",
            acceptanceCriteria: ["Approvals route to the expected queue."],
            targetFiles: ["src/ApprovalQueue.ts"],
            implementationNotes: ["Use scout evidence."],
            validationSteps: ["npm test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      }),
      structuredOutput: {
        jiraKey: "CPDEV-20908",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Fix approval queue routing.",
        specs: [
          {
            id: "queue-routing",
            objective: "Fix approval queue routing.",
            acceptanceCriteria: ["Approvals route to the expected queue."],
            targetFiles: ["src/ApprovalQueue.ts"],
            implementationNotes: ["Use scout evidence."],
            validationSteps: ["npm test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      },
      metrics: {
        durationMs: 10,
        toolCalls: 0,
      },
    });

    const response = await provider.generatePlan({
      jiraKey: "CPDEV-20908",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Approval routing",
      taskDescription: "Fix approval queue routing.",
      qualificationSummary: {
        requirementsSummary: ["Fix approval queue routing."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      groundingContext: {
        generatedAt: "2026-04-17T12:00:00.000Z",
        jiraKey: "CPDEV-20908",
        repoName: "core-app",
        confidence: "weak",
        terms: [],
        routeCards: [],
        candidateFiles: [],
        snippets: [],
        sourceTestPairs: [],
        riskFiles: [],
        warnings: [],
      },
      evidenceContext: {
        generatedAt: "2026-04-17T12:00:00.000Z",
        jiraKey: "CPDEV-20908",
        repoName: "core-app",
        confidence: "strong",
        scoutStatus: "scouts_supported_plan",
        scoutReports: [
          {
            workItemId: "scout-1",
            objective: "Fix approval queue routing.",
            status: "valid",
            inspectedFiles: ["src/ApprovalQueue.ts"],
            verifiedInspectedFiles: ["src/ApprovalQueue.ts"],
            snippets: [{
              file: "src/ApprovalQueue.ts",
              line: 7,
              term: "ApprovalQueue",
              text: "export class ApprovalQueue",
            }],
            symbols: ["ApprovalQueue", "routeApproval"],
            testFiles: ["src/ApprovalQueue.test.ts"],
            commands: ["npm test"],
            confidence: "strong",
            blockers: ["verify queue reassignment regression"],
            toolCalls: 2,
            durationMs: 1000,
          },
        ],
        scoutInvocationFailed: false,
        scoutReturnedNothing: false,
        failedScoutCount: 0,
        warnings: [],
      },
    });

    const plannerPrompt = runAgentMock.mock.calls[0][0].taskPrompt;
    expect(plannerPrompt).toContain("symbols: ApprovalQueue, routeApproval");
    expect(plannerPrompt).toContain("tests: `src/ApprovalQueue.test.ts`");
    expect(plannerPrompt).toContain("advisory validation commands: advisory: npm test");
    expect(plannerPrompt).toContain("risks/gaps: verify queue reassignment regression");
    expect(response.metrics).toMatchObject({
      toolCalls: 0,
      groundingConfidence: "strong",
      groundingSource: "scouts",
      plannerScoutStatus: "scouts_supported_plan",
    });
    expect(response.plan.plannerDiscoveries?.entryPoints).toContain(
      "src/ApprovalQueue.ts",
    );
  });

  it("includes rich scout evidence in grounding failure diagnostics", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);
    const badPlan = {
      jiraKey: "CPDEV-20908",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Bad target plan.",
      specs: [
        {
          id: "queue-routing",
          objective: "Fix approval queue routing.",
          acceptanceCriteria: ["Approvals route to the expected queue."],
          targetFiles: ["src/unrelated/Other.ts"],
          implementationNotes: ["Incorrect target."],
          validationSteps: ["npm test"],
        },
      ],
    };
    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(badPlan),
      structuredOutput: badPlan,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
        tokensUsed: { input: 10, output: 20 },
        costUsd: 0.01,
      },
    });

    await expect(
      provider.generatePlan({
        jiraKey: "CPDEV-20908",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        workspacePath: "/tmp/workspace",
        ticketSummary: "Approval routing",
        taskDescription: "Fix approval queue routing.",
        qualificationSummary: {
          requirementsSummary: ["Fix approval queue routing."],
          acceptanceCriteriaPresent: true,
          nonBlockingWarnings: [],
        },
        revision: false,
        evidenceContext: {
          generatedAt: "2026-04-17T12:00:00.000Z",
          jiraKey: "CPDEV-20908",
          repoName: "core-app",
          confidence: "strong",
          scoutStatus: "scouts_supported_plan",
          scoutReports: [
            {
              workItemId: "scout-1",
              objective: "Fix approval queue routing.",
              status: "valid",
              inspectedFiles: ["src/ApprovalQueue.ts"],
              verifiedInspectedFiles: ["src/ApprovalQueue.ts"],
              snippets: [],
              symbols: ["ApprovalQueue"],
              testFiles: ["src/ApprovalQueue.test.ts"],
              commands: ["npm test"],
              confidence: "strong",
              blockers: ["verify queue reassignment regression"],
              toolCalls: 2,
              durationMs: 1000,
            },
          ],
          scoutInvocationFailed: false,
          scoutReturnedNothing: false,
          failedScoutCount: 0,
          warnings: [],
        },
      }),
    ).rejects.toMatchObject({
      plannerAttemptDetails: expect.objectContaining({
        groundingEvidence: expect.objectContaining({
          scoutReports: [
            expect.objectContaining({
              workItemId: "scout-1",
              symbols: ["ApprovalQueue"],
              testFiles: ["src/ApprovalQueue.test.ts"],
              commands: ["npm test"],
              blockers: ["verify queue reassignment regression"],
            }),
          ],
        }),
      }),
    });
  });

  it("rejects plans whose target files are not backed by strong grounding", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "LOCAL-E2E-1",
        repoName: "local-core-app-fixture",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Bad plan.",
        specs: [
          {
            id: "unrelated-change",
            objective: "Edit an unrelated file.",
            acceptanceCriteria: ["The unsupported target should be rejected."],
            targetFiles: ["src/unrelated/Other.ts"],
            implementationNotes: ["This file has no evidence."],
            validationSteps: ["npm test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      }),
      structuredOutput: {
        jiraKey: "LOCAL-E2E-1",
        repoName: "local-core-app-fixture",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Bad plan.",
        specs: [
          {
            id: "unrelated-change",
            objective: "Edit an unrelated file.",
            acceptanceCriteria: ["The unsupported target should be rejected."],
            targetFiles: ["src/unrelated/Other.ts"],
            implementationNotes: ["This file has no evidence."],
            validationSteps: ["npm test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      },
      metrics: {
        durationMs: 10,
        toolCalls: 1,
      },
    });

    await expect(
      provider.generatePlan({
        jiraKey: "LOCAL-E2E-1",
        repoName: "local-core-app-fixture",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        workspacePath: "/tmp/workspace",
        ticketSummary: "Enable active-only default for member search.",
        taskDescription:
          "Change MemberSearchForm so activeOnly defaults to true.",
        qualificationSummary: {
          requirementsSummary: [
            "Member search defaults set activeOnly to true.",
          ],
          acceptanceCriteriaPresent: true,
          nonBlockingWarnings: [],
        },
        revision: false,
        groundingContext: {
          generatedAt: "2026-04-17T12:00:00.000Z",
          jiraKey: "LOCAL-E2E-1",
          repoName: "local-core-app-fixture",
          confidence: "strong",
          terms: [
            { value: "MemberSearchForm", kind: "identifier", weight: 10 },
          ],
          routeCards: [],
          candidateFiles: [
            {
              path: "src/member/MemberSearchForm.ts",
              score: 30,
              reasons: ["file path match", "content match"],
              matchedTerms: ["MemberSearchForm"],
              exists: true,
            },
          ],
          snippets: [
            {
              file: "src/member/MemberSearchForm.ts",
              line: 1,
              term: "MemberSearchForm",
              text: "export function getMemberSearchDefaults()",
            },
          ],
          sourceTestPairs: [],
          riskFiles: [],
          warnings: [],
        },
        groundingSummary: "## Deterministic Planner Grounding",
      }),
    ).rejects.toMatchObject({
      name: "PlannerGroundingValidationError",
      plannerAttemptDetails: expect.objectContaining({
        metrics: expect.objectContaining({
          durationMs: 10,
          toolCalls: 1,
        }),
        hasStructuredOutput: true,
        groundingConfidence: "strong",
        rawOutput: expect.stringContaining('"summary":"Bad plan."'),
        structuredOutput: expect.objectContaining({
          summary: "Bad plan.",
        }),
        draftPlan: expect.objectContaining({
          summary: "Bad plan.",
        }),
        groundingValidation: expect.objectContaining({
          ok: false,
          errors: expect.arrayContaining([
            expect.stringContaining("src/unrelated/Other.ts"),
          ]),
          decisions: expect.arrayContaining([
            expect.objectContaining({
              targetFile: "src/unrelated/Other.ts",
              ok: false,
            }),
          ]),
        }),
      }),
    });
  });

  it("repairs run-140-style ungrounded POM targets by supplying exact file snippets", async () => {
    const workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "oneshot-planner-grounding-repair-"),
    );
    const rejectedTargets = [
      "MHKVendorBatchProcessor/pom.xml",
      "Outbound-File-Feed/pom.xml",
      "emailIntakeService/pom.xml",
    ];
    const initialPlan = buildPlan([
      "EventProcessing/pom.xml",
      ...rejectedTargets,
    ]);
    const repairPatch = {
      rationale: "Use exact POM snippets read during grounding repair.",
      patches: rejectedTargets.map((targetFile) => ({
        targetFile,
        rationale: `Read ${targetFile} and confirmed logback/slf4j version properties are present.`,
        supportingEvidence: [
          `Read ${targetFile} during grounding repair; snippet contains logback/slf4j version properties.`,
        ],
        allowedChanges: [
          "Update only the inspected dependency version properties.",
        ],
      })),
    };

    await writeWorkspaceFiles(workspacePath, {
      "MHKVendorBatchProcessor/pom.xml":
        "<project><properties><slf4j.version>1.7.30</slf4j.version><logback.version>1.1.7</logback.version></properties></project>",
      "Outbound-File-Feed/pom.xml":
        "<project><properties><slf4j.version>1.7.21</slf4j.version><logback.version>1.1.7</logback.version></properties></project>",
      "emailIntakeService/pom.xml":
        "<project><properties><logback.version>1.0.11</logback.version></properties></project>",
    });

    try {
      const provider = new ClaudePlannerProvider({
        composePrompt: vi.fn().mockResolvedValue("prompt"),
        composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
      } as unknown as PromptComposer);

      runAgentMock
        .mockResolvedValueOnce({
          success: true,
          output: JSON.stringify(initialPlan),
          structuredOutput: initialPlan,
          metrics: {
            durationMs: 100,
            toolCalls: 1,
            toolCallProfiles: [
              {
                tool: "Glob",
                durationMs: 10,
                inputBytes: 20,
                outputBytes: 100,
                success: true,
                pattern:
                  "{MHKVendorBatchProcessor,Outbound-File-Feed,emailIntakeService}/pom.xml",
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          success: true,
          output: JSON.stringify(repairPatch),
          structuredOutput: repairPatch,
          metrics: {
            durationMs: 50,
            toolCalls: 0,
            tokensUsed: { input: 10, output: 20 },
            costUsd: 0.01,
          },
        });

      const response = await provider.generatePlan({
        jiraKey: "CPDEV-22054",
        repoName: "batch-jobs",
        branchName: "feature/CPDEV-22054-upgrade-logback-1.4.14",
        baseCommitSha: "40b812a1ab602c6ba494677bb3340f4d32ef18b6",
        workspacePath,
        ticketSummary: "Upgrade logback-core and logback-classic.",
        taskDescription: "Upgrade logback across batch modules.",
        qualificationSummary: {
          requirementsSummary: ["Upgrade vulnerable logback modules."],
          acceptanceCriteriaPresent: true,
          nonBlockingWarnings: [],
        },
        revision: false,
        groundingContext: buildBatchGrounding(),
        groundingSummary: "## Deterministic Planner Grounding",
        attemptOverrides: { useOutputSchema: true },
      });

      expect(runAgentMock).toHaveBeenCalledTimes(2);
      expect(runAgentMock.mock.calls[1][0]).toMatchObject({
        allowedTools: ["Read"],
        systemAppend: "SYSTEM_RULES",
        settingSources: [],
      });
      expect(runAgentMock.mock.calls[1][0].outputSchema).toMatchObject({
        properties: expect.objectContaining({
          patches: expect.any(Object),
        }),
      });
      expect(runAgentMock.mock.calls[1][0].taskPrompt).toContain(
        "MHKVendorBatchProcessor/pom.xml",
      );
      expect(runAgentMock.mock.calls[1][0].taskPrompt).toContain(
        "<logback.version>1.1.7</logback.version>",
      );
      expect(response.plan.specs[0].targetFiles).toEqual([
        "EventProcessing/pom.xml",
        ...rejectedTargets,
      ]);
      expect(response.metrics).toMatchObject({
        plannerGroundingRepairAttempted: true,
        plannerGroundingRepairAccepted: true,
        plannerGroundingRepairRejected: false,
        plannerGroundingRepairMode: "patch",
        plannerGroundingRepairRejectedTargetCount: 3,
        plannerGroundingRepairTargetFiles: rejectedTargets,
        plannerGroundingRepairReadFiles: rejectedTargets,
      });
      expect(response.metrics.warnings).toContain(
        "planner_grounding_repair:patch:accepted:3:files",
      );
    } finally {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("repairs missing adjacent new-file targets by reading validator supporting files", async () => {
    const workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "oneshot-planner-grounding-repair-support-"),
    );
    const targetFile =
      "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csCancelButton.scss";
    const supportFile =
      "MedicalMgmt/src/main/webapp/themes/Medhok3_Source/sass/custom/_csSecondaryButton.scss";
    const initialPlan = {
      jiraKey: "CPDEV-23734",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Create cancel button style.",
      specs: [
        {
          id: "cancel-button-style",
          objective: "Create the adjacent cancel button Sass partial.",
          acceptanceCriteria: ["Cancel button style has source parity."],
          targetFiles: [targetFile],
          implementationNotes: ["Create the adjacent Sass partial."],
          validationSteps: ["compass compile"],
        },
      ],
      assumptions: [],
      openQuestions: [],
      outOfScope: [],
      risks: [],
    };
    const repairPatch = {
      rationale:
        "New source-parity Sass partial is grounded in the inspected sibling button style.",
      patches: [
        {
          targetFile,
          role: "source_parity",
          rationale:
            "New source-parity Sass partial modeled on the inspected sibling button style.",
          supportingEvidence: [
            `Read ${supportFile} as the same-directory button style template.`,
          ],
          allowedChanges: ["Create the new Sass partial."],
        },
      ],
    };

    await writeWorkspaceFiles(workspacePath, {
      [supportFile]:
        "/* cs-secondary-button::START */\n.cs-secondary-button { font-size: $button_font_size; }\n/* cs-secondary-button::END */\n",
    });

    try {
      const provider = new ClaudePlannerProvider({
        composePrompt: vi.fn().mockResolvedValue("prompt"),
        composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
      } as unknown as PromptComposer);

      runAgentMock
        .mockResolvedValueOnce({
          success: true,
          output: JSON.stringify(initialPlan),
          structuredOutput: initialPlan,
          metrics: {
            durationMs: 100,
            toolCalls: 1,
            toolCallProfiles: [
              {
                tool: "Grep",
                durationMs: 10,
                inputBytes: 20,
                outputBytes: 100,
                success: true,
                searchPath: supportFile,
                pattern: "cs-secondary-button",
              },
            ],
          },
        })
        .mockResolvedValueOnce({
          success: true,
          output: JSON.stringify(repairPatch),
          structuredOutput: repairPatch,
          metrics: {
            durationMs: 50,
            toolCalls: 0,
            tokensUsed: { input: 10, output: 20 },
            costUsd: 0.01,
          },
        });

      const response = await provider.generatePlan({
        jiraKey: "CPDEV-23734",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        workspacePath,
        ticketSummary: "Style the Member Search Cancel button.",
        taskDescription: "Create cancelButtonRed Sass source parity.",
        qualificationSummary: {
          requirementsSummary: ["Create cancelButtonRed source parity."],
          acceptanceCriteriaPresent: true,
          nonBlockingWarnings: [],
        },
        revision: false,
        groundingContext: {
          generatedAt: "2026-06-19T00:00:00.000Z",
          jiraKey: "CPDEV-23734",
          repoName: "core-app",
          confidence: "strong",
          terms: [
            { value: "cancelButtonRed", kind: "identifier", weight: 10 },
          ],
          routeCards: [],
          candidateFiles: [
            {
              path: supportFile,
              score: 60,
              reasons: ["content match", "style pattern"],
              matchedTerms: ["cancelButtonRed"],
              exists: true,
            },
          ],
          snippets: [
            {
              file: supportFile,
              line: 1,
              term: "cancelButtonRed",
              text: "cs-secondary-button source Sass template",
            },
          ],
          sourceTestPairs: [],
          riskFiles: [supportFile],
          warnings: [],
        },
        groundingSummary: "## Deterministic Planner Grounding",
        attemptOverrides: { useOutputSchema: true },
      });

      expect(runAgentMock).toHaveBeenCalledTimes(2);
      expect(runAgentMock.mock.calls[1][0].taskPrompt).toContain(supportFile);
      expect(runAgentMock.mock.calls[1][0].taskPrompt).toContain(
        "$button_font_size",
      );
      expect(runAgentMock.mock.calls[1][0].taskPrompt).not.toContain(
        `### ${targetFile}\nbytes=`,
      );
      expect(response.metrics).toMatchObject({
        plannerGroundingRepairAttempted: true,
        plannerGroundingRepairAccepted: true,
        plannerGroundingRepairRejected: false,
        plannerGroundingRepairMode: "patch",
        plannerGroundingRepairRejectedTargetCount: 1,
        plannerGroundingRepairTargetFiles: [supportFile],
        plannerGroundingRepairReadFiles: [supportFile],
      });
      expect(response.plan.fileChangeContract?.[0]).toMatchObject({
        path: targetFile,
        role: "source_parity",
      });
    } finally {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("preserves grounding failure when rejected targets are missing or unsafe", async () => {
    const workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "oneshot-planner-grounding-missing-"),
    );
    const initialPlan = buildPlan(["missing-module/pom.xml"]);

    try {
      const provider = new ClaudePlannerProvider({
        composePrompt: vi.fn().mockResolvedValue("prompt"),
        composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
      } as unknown as PromptComposer);

      runAgentMock.mockResolvedValue({
        success: true,
        output: JSON.stringify(initialPlan),
        structuredOutput: initialPlan,
        metrics: {
          durationMs: 100,
          toolCalls: 1,
        },
      });

      await expect(
        provider.generatePlan({
          jiraKey: "CPDEV-22054",
          repoName: "batch-jobs",
          branchName: "feature/CPDEV-22054-upgrade-logback-1.4.14",
          baseCommitSha: "40b812a1ab602c6ba494677bb3340f4d32ef18b6",
          workspacePath,
          ticketSummary: "Upgrade logback-core and logback-classic.",
          taskDescription: "Upgrade logback across batch modules.",
          qualificationSummary: {
            requirementsSummary: ["Upgrade vulnerable logback modules."],
            acceptanceCriteriaPresent: true,
            nonBlockingWarnings: [],
          },
          revision: false,
          groundingContext: buildBatchGrounding(),
        }),
      ).rejects.toMatchObject({
        name: "PlannerGroundingValidationError",
        plannerAttemptDetails: expect.objectContaining({
          groundingValidation: expect.objectContaining({
            errors: expect.arrayContaining([
              expect.stringContaining("missing-module/pom.xml"),
            ]),
          }),
        }),
      });
      expect(runAgentMock).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("preserves grounding failure when the repair plan is still unsupported", async () => {
    const workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "oneshot-planner-grounding-repair-fail-"),
    );
    const initialPlan = buildPlan(["MHKVendorBatchProcessor/pom.xml"]);
    const unsupportedRepairPlan = buildPlan(["another-module/pom.xml"]);

    await writeWorkspaceFiles(workspacePath, {
      "MHKVendorBatchProcessor/pom.xml":
        "<project><properties><logback.version>1.1.7</logback.version></properties></project>",
    });

    try {
      const provider = new ClaudePlannerProvider({
        composePrompt: vi.fn().mockResolvedValue("prompt"),
        composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
      } as unknown as PromptComposer);

      runAgentMock
        .mockResolvedValueOnce({
          success: true,
          output: JSON.stringify(initialPlan),
          structuredOutput: initialPlan,
          metrics: {
            durationMs: 100,
            toolCalls: 1,
          },
        })
        .mockResolvedValueOnce({
          success: false,
          output: "",
          error: "patch repair timed out",
          metrics: {
            durationMs: 25,
            toolCalls: 0,
          },
        })
        .mockResolvedValueOnce({
          success: true,
          output: JSON.stringify(unsupportedRepairPlan),
          structuredOutput: unsupportedRepairPlan,
          metrics: {
            durationMs: 25,
            toolCalls: 0,
          },
        });

      await expect(
        provider.generatePlan({
          jiraKey: "CPDEV-22054",
          repoName: "batch-jobs",
          branchName: "feature/CPDEV-22054-upgrade-logback-1.4.14",
          baseCommitSha: "40b812a1ab602c6ba494677bb3340f4d32ef18b6",
          workspacePath,
          ticketSummary: "Upgrade logback-core and logback-classic.",
          taskDescription: "Upgrade logback across batch modules.",
          qualificationSummary: {
            requirementsSummary: ["Upgrade vulnerable logback modules."],
            acceptanceCriteriaPresent: true,
            nonBlockingWarnings: [],
          },
          revision: false,
          groundingContext: buildBatchGrounding(),
        }),
      ).rejects.toMatchObject({
        name: "PlannerGroundingValidationError",
        plannerAttemptDetails: expect.objectContaining({
          metrics: expect.objectContaining({
            plannerGroundingRepairAttempted: true,
            plannerGroundingRepairAccepted: false,
            plannerGroundingRepairRejected: true,
            plannerGroundingRepairMode: "full_plan_fallback",
            plannerGroundingRepairRejectedTargetCount: 1,
            plannerGroundingRepairTargetFiles: [
              "MHKVendorBatchProcessor/pom.xml",
            ],
          }),
          groundingValidation: expect.objectContaining({
            errors: expect.arrayContaining([
              expect.stringContaining("MHKVendorBatchProcessor/pom.xml"),
            ]),
          }),
        }),
      });
      expect(runAgentMock).toHaveBeenCalledTimes(3);
      expect(runAgentMock.mock.calls[1][0].outputSchema).toMatchObject({
        properties: expect.objectContaining({
          patches: expect.any(Object),
        }),
      });
      expect(runAgentMock.mock.calls[2][0]).toMatchObject({
        outputSchema: ONE_SHOT_PLAN_OUTPUT_SCHEMA,
      });
    } finally {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("soft-accepts adjacent source targets after validating source rationale evidence", async () => {
    const workspacePath = await fs.mkdtemp(
      path.join(os.tmpdir(), "oneshot-planner-recovery-"),
    );
    const targetFile =
      "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/WSUMQuestionSetRequest.java";
    const adjacentEvidence =
      "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/davinci/crd/enums/CrdAdditionalDocEnum.java";
    const rationaleSupport =
      "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/fhir/model/DtrDocumentationRequest.java";
    await fs.mkdir(path.dirname(path.join(workspacePath, rationaleSupport)), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspacePath, rationaleSupport),
      "package com.mhkinterop.fhir.model;\npublic class DtrDocumentationRequest {}\n",
      "utf8",
    );

    try {
      const provider = new ClaudePlannerProvider({
        composePrompt: vi.fn().mockResolvedValue("prompt"),
        composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
      } as unknown as PromptComposer);
      const structuredOutput = {
        jiraKey: "CPDEV-21561",
        repoName: "interop",
        branchName: "main",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Create request model.",
        specs: [
          {
            id: "request-model",
            objective: "Create request model for getUmQuestionSet.",
            acceptanceCriteria: [
              "Request model captures UM question-set input.",
            ],
            targetFiles: [targetFile],
            targetFileRationales: [
              {
                targetFile,
                rationale:
                  "DtrDocumentationRequest is the inspected same-package DTO pattern.",
                supportingFiles: [
                  rationaleSupport,
                  "mhk-interopt-fhirhelper/medhokqa-swagger-api-docs.json",
                ],
              },
            ],
            implementationNotes: ["Follow same-package DTO patterns."],
            validationSteps: ["mvn test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      };

      runAgentMock.mockResolvedValue({
        success: true,
        output: JSON.stringify(structuredOutput),
        structuredOutput,
        metrics: {
          durationMs: 123,
          toolCalls: 1,
        },
      });

      const response = await provider.generatePlan({
        jiraKey: "CPDEV-21561",
        repoName: "interop",
        branchName: "main",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        workspacePath,
        ticketSummary: "Create request model.",
        taskDescription: "Create internal request model for getUmQuestionSet.",
        qualificationSummary: {
          requirementsSummary: ["Question-set request model is represented."],
          acceptanceCriteriaPresent: true,
          nonBlockingWarnings: [],
        },
        revision: false,
        groundingContext: {
          generatedAt: "2026-05-01T00:00:00.000Z",
          jiraKey: "CPDEV-21561",
          repoName: "interop",
          confidence: "strong",
          terms: [
            { value: "CrdAdditionalDocEnum", kind: "identifier", weight: 10 },
          ],
          routeCards: [],
          candidateFiles: [
            {
              path: adjacentEvidence,
              score: 30,
              reasons: ["content match"],
              matchedTerms: ["CrdAdditionalDocEnum"],
              exists: true,
            },
          ],
          snippets: [
            {
              file: adjacentEvidence,
              line: 1,
              term: "CrdAdditionalDocEnum",
              text: "enum CrdAdditionalDocEnum",
            },
          ],
          sourceTestPairs: [],
          riskFiles: [],
          warnings: [],
        },
        groundingSummary: "## Deterministic Planner Grounding",
      });

      expect(response.metrics.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "accepted as an adjacent source or mapping target",
          ),
        ]),
      );
    } finally {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("accepts final-planner read files as validation evidence", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "CPDEV-18975",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Update existing Hibernate mapping.",
        specs: [
          {
            id: "mapping",
            objective: "Update the Hibernate mapping read during planning.",
            acceptanceCriteria: ["Mapping reflects task lifecycle linkage."],
            targetFiles: [
              "MedicalMgmtModels/src/main/resources/applicationHibernateMapping.xml",
            ],
            implementationNotes: ["Planner inspected this file directly."],
            validationSteps: ["mvn test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      }),
      metrics: {
        durationMs: 123,
        toolCalls: 2,
        toolCallProfiles: [
          {
            tool: "Read",
            durationMs: 20,
            inputBytes: 20,
            outputBytes: 200,
            success: true,
            filePath:
              "/private/tmp/workspace/MedicalMgmtModels/src/main/resources/applicationHibernateMapping.xml",
          },
        ],
      },
    });

    await expect(
      provider.generatePlan({
        jiraKey: "CPDEV-18975",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        workspacePath: "/tmp/workspace",
        ticketSummary: "Track task lifecycle.",
        taskDescription: "Track task lifecycle from user sessions.",
        qualificationSummary: {
          requirementsSummary: ["Task lifecycle linkage is persisted."],
          acceptanceCriteriaPresent: true,
          nonBlockingWarnings: [],
        },
        revision: false,
        groundingContext: {
          generatedAt: "2026-04-17T12:00:00.000Z",
          jiraKey: "CPDEV-18975",
          repoName: "core-app",
          confidence: "strong",
          terms: [
            { value: "UserSessionAction", kind: "identifier", weight: 10 },
          ],
          routeCards: [],
          candidateFiles: [
            {
              path: "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/UserSessionAction.java",
              score: 30,
              reasons: ["content match"],
              matchedTerms: ["UserSessionAction"],
              exists: true,
            },
          ],
          snippets: [
            {
              file: "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/UserSessionAction.java",
              line: 20,
              term: "UserSessionAction",
              text: "class UserSessionAction tracks session actions",
            },
          ],
          sourceTestPairs: [],
          riskFiles: [],
          warnings: [],
        },
        groundingSummary: "## Deterministic Planner Grounding",
      }),
    ).resolves.toMatchObject({
      plan: {
        specs: [
          {
            targetFiles: [
              "MedicalMgmtModels/src/main/resources/applicationHibernateMapping.xml",
            ],
          },
        ],
      },
    });
  });

  it("accepts new adjacent targets backed by final-planner reads", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "CPDEV-18975",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Create task lifecycle tracking.",
        specs: [
          {
            id: "task-lifecycle",
            objective: "Create adjacent lifecycle files.",
            acceptanceCriteria: ["Lifecycle events are persisted."],
            targetFiles: [
              "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/TaskLifecycleEvent.java",
              "MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/TaskLifecycleEvent.hbm.xml",
              "MedicalMgmt/src/main/java/com/medhok/mm/server/bff/model/tasklifecycle/TaskLifecycleEventRequest.java",
              "MedicalMgmt/src/main/java/com/medhok/mm/server/bff/controllers/TaskLifecycleController.java",
              "mm-shared-services/src/main/java/com/medhok/mm/server/businessservice/TaskLifecycleService.java",
              "mm-shared-services/src/test/java/com/medhok/mm/server/businessservice/TaskLifecycleServiceTest.java",
              "flyway/sql/V1.2026-04-27-01__task_lifecycle_event.sql",
            ],
            targetFileRationales: [
              {
                targetFile:
                  "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/TaskLifecycleEvent.java",
                rationale:
                  "Existing UserSessionAction model establishes the adjacent lifecycle model pattern.",
                supportingFiles: [
                  "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/UserSessionAction.java",
                ],
              },
              {
                targetFile:
                  "MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/TaskLifecycleEvent.hbm.xml",
                rationale:
                  "Existing UserSessionAction mapping establishes the adjacent mapping pattern.",
                supportingFiles: [
                  "MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/UserSessionAction.hbm.xml",
                ],
              },
              {
                targetFile:
                  "MedicalMgmt/src/main/java/com/medhok/mm/server/bff/model/tasklifecycle/TaskLifecycleEventRequest.java",
                rationale:
                  "Existing BFF controller evidence anchors the adjacent BFF module.",
                supportingFiles: [
                  "MedicalMgmt/src/main/java/com/medhok/mm/server/bff/controllers/UserActivityController.java",
                ],
              },
              {
                targetFile:
                  "MedicalMgmt/src/main/java/com/medhok/mm/server/bff/controllers/TaskLifecycleController.java",
                rationale:
                  "Existing UserActivityController establishes the controller pattern.",
                supportingFiles: [
                  "MedicalMgmt/src/main/java/com/medhok/mm/server/bff/controllers/UserActivityController.java",
                ],
              },
              {
                targetFile:
                  "mm-shared-services/src/main/java/com/medhok/mm/server/businessservice/TaskLifecycleService.java",
                rationale:
                  "Existing WorkflowBusinessService establishes the shared-service pattern.",
                supportingFiles: [
                  "mm-shared-services/src/main/java/com/medhok/mm/server/businessservice/WorkflowBusinessService.java",
                ],
              },
              {
                targetFile:
                  "flyway/sql/V1.2026-04-27-01__task_lifecycle_event.sql",
                rationale:
                  "Existing Flyway migration establishes the adjacent migration directory and filename pattern.",
                supportingFiles: [
                  "flyway/sql/V1.2025-02-25-72__user_session.sql",
                ],
              },
            ],
            implementationNotes: [
              "Use adjacent files inspected during planning.",
            ],
            validationSteps: ["mvn test"],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      }),
      metrics: {
        durationMs: 123,
        toolCalls: 5,
        toolCallProfiles: [
          {
            tool: "Read",
            durationMs: 20,
            inputBytes: 20,
            outputBytes: 200,
            success: true,
            filePath:
              "/tmp/workspace/MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/UserSessionAction.java",
          },
          {
            tool: "Read",
            durationMs: 20,
            inputBytes: 20,
            outputBytes: 200,
            success: true,
            filePath:
              "/tmp/workspace/MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/UserSessionAction.hbm.xml",
          },
          {
            tool: "Read",
            durationMs: 20,
            inputBytes: 20,
            outputBytes: 200,
            success: true,
            filePath:
              "/tmp/workspace/MedicalMgmt/src/main/java/com/medhok/mm/server/bff/controllers/UserActivityController.java",
          },
          {
            tool: "Read",
            durationMs: 20,
            inputBytes: 20,
            outputBytes: 200,
            success: true,
            filePath:
              "/tmp/workspace/mm-shared-services/src/main/java/com/medhok/mm/server/businessservice/WorkflowBusinessService.java",
          },
          {
            tool: "Read",
            durationMs: 20,
            inputBytes: 20,
            outputBytes: 200,
            success: true,
            filePath:
              "/tmp/workspace/flyway/sql/V1.2025-02-25-72__user_session.sql",
          },
        ],
      },
    });

    await expect(
      provider.generatePlan({
        jiraKey: "CPDEV-18975",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        workspacePath: "/tmp/workspace",
        ticketSummary: "Track task lifecycle.",
        taskDescription: "Track task lifecycle from user sessions.",
        qualificationSummary: {
          requirementsSummary: ["Task lifecycle linkage is persisted."],
          acceptanceCriteriaPresent: true,
          nonBlockingWarnings: [],
        },
        revision: false,
        groundingContext: {
          generatedAt: "2026-04-17T12:00:00.000Z",
          jiraKey: "CPDEV-18975",
          repoName: "core-app",
          confidence: "strong",
          terms: [
            { value: "UserSessionAction", kind: "identifier", weight: 10 },
          ],
          routeCards: [],
          candidateFiles: [
            {
              path: "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/UserSessionAction.java",
              score: 30,
              reasons: ["content match"],
              matchedTerms: ["UserSessionAction"],
              exists: true,
            },
          ],
          snippets: [
            {
              file: "MedicalMgmtModels/src/main/java/com/medhok/mm/server/models/UserSessionAction.java",
              line: 20,
              term: "UserSessionAction",
              text: "class UserSessionAction tracks session actions",
            },
          ],
          sourceTestPairs: [],
          riskFiles: [],
          warnings: [],
        },
        groundingSummary: "## Deterministic Planner Grounding",
      }),
    ).resolves.toMatchObject({
      plan: {
        specs: [
          {
            id: "task-lifecycle",
          },
        ],
      },
    });
  });

  it("scopes retrofit planner Bash to read-only Git inspection commands", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
      loadRetrofitWorkflowPrompt: vi
        .fn()
        .mockResolvedValue(
          "CANONICAL RETROFIT WORKFLOW\nConsider all matching commits oldest-to-newest.",
        ),
    } as unknown as PromptComposer);

    const plan = {
      ...buildPlan(["mm-member-merge/src/main/resources/jbpm.cfg.xml"]),
      jiraKey: "CPDEV-9999",
      repoName: "cp-batch-monorepo",
      branchName: "batch-monorepo-3.18",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      plannerDiscoveries: {
        retrofitEvidence: {
          sourceJiraKey: "CPDEV-1234",
          sourceBranch: "batch-monorepo-master",
          targetBranch: "batch-monorepo-3.18",
          selectedCommits: [
            {
              sha: "abc1234",
              subject: "CPDEV-1234 Add jbpm config",
              files: ["mm-member-merge/src/main/resources/jbpm.cfg.xml"],
              alreadyApplied: false,
            },
          ],
          touchedFiles: ["mm-member-merge/src/main/resources/jbpm.cfg.xml"],
          alreadyApplied: false,
          evidenceSummary: "Source change is missing from target.",
        },
      },
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(plan),
      structuredOutput: plan,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
      },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-9999",
      repoName: "cp-batch-monorepo",
      branchName: "batch-monorepo-3.18",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Retrofit CPDEV-1234",
      taskDescription:
        "Retrofit: CPDEV-1234\nFrom: batch-monorepo-master\nTarget: batch-monorepo-3.18",
      qualificationSummary: {
        requirementsSummary: ["Retrofit CPDEV-1234 into batch-monorepo-3.18."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      retrofitContext: {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "batch-monorepo-master",
        targetBranch: "batch-monorepo-3.18",
      },
    });

    const call = runAgentMock.mock.calls[0][0];
    expect(call.allowedTools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Bash",
      "Skill",
      "Agent",
    ]);
    const patterns = call.allowedBashCommandPatterns as string[];
    const allows = (command: string) =>
      patterns.some((pattern) => new RegExp(pattern).test(command));

    expect(
      allows(
        "git log --format=fuller --regexp-ignore-case --extended-regexp --reverse --no-merges --grep='(^|[^A-Z0-9])CPDEV-1234([^A-Z0-9]|$)' origin/batch-monorepo-3.18..origin/batch-monorepo-master",
      ),
    ).toBe(true);
    expect(call.taskPrompt).toContain(
      "--grep='(^|[^A-Z0-9])CPDEV-1234([^A-Z0-9]|$)'",
    );
    expect(call.taskPrompt).toContain("oldest-to-newest");
    expect(
      allows(
        "git cherry -v origin/batch-monorepo-3.18 origin/batch-monorepo-master",
      ),
    ).toBe(true);
    expect(
      allows(
        "git diff --name-status --stat --patch origin/batch-monorepo-3.18...origin/batch-monorepo-master -- mm-member-merge/src/main/resources/jbpm.cfg.xml",
      ),
    ).toBe(true);
    expect(
      allows(
        "git diff --output=/tmp/history.txt origin/batch-monorepo-3.18...origin/batch-monorepo-master",
      ),
    ).toBe(false);
    expect(allows("git checkout batch-monorepo-master")).toBe(false);
  });

  it("injects deterministic retrofit source evidence and forbids semantic fallback", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
      loadRetrofitWorkflowPrompt: vi.fn().mockResolvedValue(
        [
          "CANONICAL RETROFIT WORKFLOW",
          "Do not infer an alternate semantic fix from Jira text or adjacent behavior.",
          "verification_only is allowed only when this exact source patch is already present or patch-equivalent on the target branch.",
        ].join("\n"),
      ),
    } as unknown as PromptComposer);

    const plan = {
      ...buildPlan([
        "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
      ]),
      jiraKey: "CPDEV-25013",
      repoName: "core-app",
      branchName: "medhok-monorepo-4.2",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      plannerDiscoveries: {
        retrofitEvidence: {
          sourceJiraKey: "CPDEV-24856",
          sourceBranch: "master",
          targetBranch: "medhok-monorepo-4.2",
          selectedCommits: [
            {
              sha: "de882e2",
              subject: "CPDEV-24856 Tufts | Fix Dropdown Sort Issue",
              files: [
                "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
              ],
              alreadyApplied: false,
            },
          ],
          touchedFiles: [
            "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
          ],
          alreadyApplied: false,
          evidenceSummary:
            "Source patch adds setSortField after setDisplayField.",
        },
      },
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(plan),
      structuredOutput: plan,
      metrics: { durationMs: 10, toolCalls: 1 },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-25013",
      repoName: "core-app",
      branchName: "medhok-monorepo-4.2",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Tufts | Multi-branch Retrofit",
      taskDescription:
        "Retrofit: CPDEV-24856\nFrom: master\nTarget: medhok-monorepo-4.2",
      qualificationSummary: {
        requirementsSummary: ["Retrofit CPDEV-24856 into 4.2."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      retrofitContext: {
        sourceJiraKey: "CPDEV-24856",
        sourceBranch: "master",
        targetBranch: "medhok-monorepo-4.2",
      },
      retrofitSourceEvidence: {
        sourceJiraKey: "CPDEV-24856",
        sourceBranch: "master",
        targetBranch: "medhok-monorepo-4.2",
        sourceRepoName: "core-app",
        sourceRepoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
        selectedCommits: [
          {
            sha: "de882e2",
            subject: "CPDEV-24856 Tufts | Fix Dropdown Sort Issue",
            files: [
              "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
            ],
            patchSummary:
              '+fieldValues.setSortField("uiComponentValuesDisplay");',
          },
        ],
        touchedFiles: [
          "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
        ],
        evidenceSummary:
          "Source patch adds setSortField after setDisplayField.",
      },
    });

    const prompt = runAgentMock.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("## Required Retrofit Workflow");
    expect(prompt).toContain("CANONICAL RETROFIT WORKFLOW");
    expect(prompt).toContain("## Retrofit Source Evidence");
    expect(prompt).toContain("CPDEV-24856");
    expect(prompt).toContain(
      "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
    );
    expect(prompt).toContain(
      '+fieldValues.setSortField("uiComponentValuesDisplay");',
    );
    expect(prompt).toContain("Do not infer an alternate semantic fix");
    expect(prompt).toContain(
      "verification_only is allowed only when this exact source patch is already present or patch-equivalent",
    );
  });

  it("seeds retrofit evidence and execution contract from qualification evidence when the model omits them", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
      loadRetrofitWorkflowPrompt: vi
        .fn()
        .mockResolvedValue("CANONICAL RETROFIT WORKFLOW"),
    } as unknown as PromptComposer);

    const plan = {
      ...buildPlan([
        "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
      ]),
      jiraKey: "CPDEV-25656",
      repoName: "core-app",
      branchName: "medhok-monorepo-3.20",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(plan),
      structuredOutput: plan,
      metrics: { durationMs: 10, toolCalls: 1 },
    });

    const result = await provider.generatePlan({
      jiraKey: "CPDEV-25656",
      repoName: "core-app",
      branchName: "medhok-monorepo-3.20",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Centene retrofit",
      taskDescription:
        "Retrofit: CPDEV-25644\nFrom: medhok-monorepo-3.19\nTarget: medhok-monorepo-3.20",
      qualificationSummary: {
        requirementsSummary: ["Retrofit CPDEV-25644 into 3.20."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      retrofitContext: {
        sourceJiraKey: "CPDEV-25644",
        sourceBranch: "medhok-monorepo-3.19",
        targetBranch: "medhok-monorepo-3.20",
      },
      retrofitSourceEvidence: {
        sourceJiraKey: "CPDEV-25644",
        sourceBranch: "medhok-monorepo-3.19",
        targetBranch: "medhok-monorepo-3.20",
        sourceRepoName: "core-app",
        sourceRepoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
        commitSelectionMethod: "commit_pr_expansion",
        sourceCommitSelectionComplete: true,
        selectedCommits: [
          {
            sha: "3df02e6dba78bee989116b3e709be6bc2e6a7ef1",
            subject: "CPDEV-25644 Log legacy auto assignment claims",
            files: [
              "MedicalMgmt/src/com/medhok/mm/server/service/MedicalMgmtService.java",
            ],
            patchSummary:
              '+log.info("LEGACY_AUTO_ASSIGN_CLAIM pid={}", gwtcm.getPid());',
          },
        ],
        touchedFiles: [
          "MedicalMgmt/src/com/medhok/mm/server/service/MedicalMgmtService.java",
        ],
        evidenceSummary:
          "Source commit adds LEGACY_AUTO_ASSIGN_CLAIM logging.",
      },
    });

    expect(
      result.plan.plannerDiscoveries?.retrofitEvidence?.sourceJiraKey,
    ).toBe("CPDEV-25644");
    expect(
      result.plan.plannerDiscoveries?.retrofitExecutionContract?.version,
    ).toBe("retrofit_execution_contract.v1");
    expect(
      result.plan.plannerDiscoveries?.retrofitExecutionContract
        ?.selectedCommits[0].sha,
    ).toBe("3df02e6dba78bee989116b3e709be6bc2e6a7ef1");
    expect(result.metrics.warnings).toContain("retrofit_contract_seeded");
  });

  it("merges model-provided retrofit contract proof into the seeded platform contract", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
      loadRetrofitWorkflowPrompt: vi
        .fn()
        .mockResolvedValue("CANONICAL RETROFIT WORKFLOW"),
    } as unknown as PromptComposer);

    const plan = {
      ...buildPlan([
        "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
      ]),
      jiraKey: "CPDEV-25656",
      repoName: "core-app",
      branchName: "medhok-monorepo-3.20",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      plannerDiscoveries: {
        retrofitExecutionContract: {
          version: "retrofit_execution_contract.v1",
          sourceJiraKey: "CPDEV-25644",
          sourceBranch: "medhok-monorepo-3.19",
          targetBranch: "medhok-monorepo-3.20",
          sourcePrUrl: "",
          commitSelectionMethod: "subject_grep_only",
          sourceCommitSelectionComplete: false,
          selectedCommits: [
            {
              sha: "3df02e6dba78bee989116b3e709be6bc2e6a7ef1",
              subject: "CPDEV-25644 Log legacy auto assignment claims",
              status: "adapted",
              sourceFiles: [
                "MedicalMgmt/src/com/medhok/mm/server/service/MedicalMgmtService.java",
              ],
              targetFiles: [
                "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
              ],
              adaptationFiles: [
                "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
              ],
              rationale: "Target branch uses src/main/java layout.",
              proofSnippets: ["Insert log after updateCMWorkflow."],
              validationEvidence: ["Compile MedicalMgmt."],
            },
          ],
          allowedFileMappings: [
            {
              sourceSha: "3df02e6dba78bee989116b3e709be6bc2e6a7ef1",
              sourceFiles: [
                "MedicalMgmt/src/com/medhok/mm/server/service/MedicalMgmtService.java",
              ],
              targetFiles: [
                "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
              ],
              adaptationFiles: [
                "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
              ],
              rationale: "Source file maps to target Maven layout.",
              evidence: ["Read target file."],
            },
          ],
        },
      },
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(plan),
      structuredOutput: plan,
      metrics: { durationMs: 10, toolCalls: 1 },
    });

    const result = await provider.generatePlan({
      jiraKey: "CPDEV-25656",
      repoName: "core-app",
      branchName: "medhok-monorepo-3.20",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Centene retrofit",
      taskDescription:
        "Retrofit: CPDEV-25644\nFrom: medhok-monorepo-3.19\nTarget: medhok-monorepo-3.20",
      qualificationSummary: {
        requirementsSummary: ["Retrofit CPDEV-25644 into 3.20."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      retrofitContext: {
        sourceJiraKey: "CPDEV-25644",
        sourceBranch: "medhok-monorepo-3.19",
        targetBranch: "medhok-monorepo-3.20",
      },
      retrofitSourceEvidence: {
        sourceJiraKey: "CPDEV-25644",
        sourceBranch: "medhok-monorepo-3.19",
        targetBranch: "medhok-monorepo-3.20",
        sourceRepoName: "core-app",
        sourceRepoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
        commitSelectionMethod: "commit_pr_expansion",
        sourceCommitSelectionComplete: true,
        selectedCommits: [
          {
            sha: "3df02e6dba78bee989116b3e709be6bc2e6a7ef1",
            subject: "CPDEV-25644 Log legacy auto assignment claims",
            files: [
              "MedicalMgmt/src/com/medhok/mm/server/service/MedicalMgmtService.java",
            ],
            patchSummary:
              '+log.info("LEGACY_AUTO_ASSIGN_CLAIM pid={}", gwtcm.getPid());',
          },
        ],
        touchedFiles: [
          "MedicalMgmt/src/com/medhok/mm/server/service/MedicalMgmtService.java",
        ],
        evidenceSummary:
          "Source commit adds LEGACY_AUTO_ASSIGN_CLAIM logging.",
      },
    });

    const contract =
      result.plan.plannerDiscoveries?.retrofitExecutionContract;
    expect(result.plan.plannerDiscoveries?.retrofitEvidence).toBeTruthy();
    expect(contract?.sourcePrUrl).toBeUndefined();
    expect(contract?.sourceRepoName).toBe("core-app");
    expect(contract?.sourceRepoUrl).toBe(
      "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    );
    expect(contract?.commitSelectionMethod).toBe("commit_pr_expansion");
    expect(contract?.sourceCommitSelectionComplete).toBe(true);
    expect(contract?.selectedCommits[0]).toMatchObject({
      status: "adapted",
      targetFiles: [
        "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
      ],
      proofSnippets: ["Insert log after updateCMWorkflow."],
    });
    expect(contract?.allowedFileMappings[0].targetFiles).toEqual([
      "MedicalMgmt/src/main/java/com/medhok/mm/server/service/MedicalMgmtService.java",
    ]);
    expect(result.metrics.warnings).toContain("retrofit_contract_merged");
  });

  it("rejects planner Bash tool policy without a matching allowlist", () => {
    expect(() =>
      validatePlannerToolPolicy({
        retrofitContextPresent: false,
        allowedTools: ["Read", "Bash"],
      }),
    ).toThrow(
      /planner_bash_allowlist_missing: Non-retrofit planner requests must not enable Bash/,
    );

    expect(() =>
      validatePlannerToolPolicy({
        retrofitContextPresent: true,
        allowedTools: ["Read", "Bash"],
        allowedBashCommandPatterns: [],
      }),
    ).toThrow(
      /planner_bash_allowlist_missing: Retrofit planner Bash requires an explicit command allowlist/,
    );

    expect(() =>
      validatePlannerToolPolicy({
        retrofitContextPresent: true,
        allowedTools: ["Read", "Bash"],
        allowedBashCommandPatterns: ["^git\\s+log\\s+"],
      }),
    ).not.toThrow();
  });

  it("surfaces already-applied retrofit output before schema validation", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
      loadRetrofitWorkflowPrompt: vi
        .fn()
        .mockResolvedValue("CANONICAL RETROFIT WORKFLOW"),
    } as unknown as PromptComposer);
    const alreadyAppliedOutput = {
      jiraKey: "CPDEV-9999",
      repoName: "cp-batch-monorepo",
      branchName: "batch-monorepo-3.18",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      summary: "Retrofit source change is already present on target.",
      specs: [],
      plannerDiscoveries: {
        retrofitEvidence: {
          sourceJiraKey: "CPDEV-1234",
          sourceBranch: "batch-monorepo-master",
          targetBranch: "batch-monorepo-3.18",
          selectedCommits: [
            {
              sha: "abcdef1234567890",
              subject: "CPDEV-1234 Add jbpm config",
              files: ["mm-member-merge/src/main/resources/jbpm.cfg.xml"],
              alreadyApplied: true,
            },
          ],
          touchedFiles: ["mm-member-merge/src/main/resources/jbpm.cfg.xml"],
          alreadyApplied: true,
          evidenceSummary: "Source change is already patch-equivalent.",
        },
      },
    };

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(alreadyAppliedOutput),
      structuredOutput: alreadyAppliedOutput,
      metrics: {
        durationMs: 10,
        toolCalls: 1,
      },
    });

    const promise = provider.generatePlan({
      jiraKey: "CPDEV-9999",
      repoName: "cp-batch-monorepo",
      branchName: "batch-monorepo-3.18",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Retrofit CPDEV-1234",
      taskDescription:
        "Retrofit: CPDEV-1234\nFrom: batch-monorepo-master\nTarget: batch-monorepo-3.18",
      qualificationSummary: {
        requirementsSummary: ["Retrofit CPDEV-1234 into batch-monorepo-3.18."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
      retrofitContext: {
        sourceJiraKey: "CPDEV-1234",
        sourceBranch: "batch-monorepo-master",
        targetBranch: "batch-monorepo-3.18",
      },
    });

    await expect(promise).rejects.toBeInstanceOf(
      PlannerRetrofitAlreadyAppliedError,
    );
    await expect(promise).rejects.toThrow(
      "already_applied: Retrofit source change CPDEV-1234 from batch-monorepo-master is already patch-equivalent on batch-monorepo-3.18; no missing retrofit changes to plan.",
    );
  });

  it("omits systemAppend when composeSystemPrompt returns undefined", async () => {
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        jiraKey: "CPDEV-20686",
        repoName: "core-app",
        branchName: "master",
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
        summary: "Implement the approved PFOS change.",
        specs: [
          {
            id: "spec-1",
            objective: "Ensure systemAppend is omitted when undefined.",
            acceptanceCriteria: ["runAgent is not passed a systemAppend key."],
            targetFiles: ["src/oneshot/providers/claude-planner.ts"],
            implementationNotes: ["Spread pattern drops undefined cleanly."],
            validationSteps: [
              "pnpm vitest src/oneshot/providers/claude-planner.test.ts",
            ],
          },
        ],
        assumptions: [],
        openQuestions: [],
        outOfScope: [],
        risks: [],
      }),
      metrics: {
        durationMs: 10,
        toolCalls: 1,
      },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-20686",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "Fix OneShot planner parsing",
      taskDescription: "Ensure optional system prompt is backward-compatible.",
      qualificationSummary: {
        requirementsSummary: ["Planner must not break when no system prompt."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
    });

    const call = runAgentMock.mock.calls[0][0];
    expect(call).not.toHaveProperty("systemAppend");
  });

  it("loads only the Sonar planning extension from processingMode", async () => {
    const sonarExtension = "SONAR_EXTENSION";
    const securityExtension = vi.fn().mockResolvedValue("SECURITY_EXTENSION");
    const loadSonarPlanningExtension = vi
      .fn()
      .mockResolvedValue(sonarExtension);
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
      loadSecurityPlanningExtension: securityExtension,
      loadSonarPlanningExtension,
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(buildPlan(["src/sonar-fix.ts"])),
      metrics: {
        durationMs: 10,
        toolCalls: 1,
      },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-23411",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "[Security] vulnerability flavored Sonar story",
      taskDescription: "Misleading text mentioning PFOS but no intake label.",
      processingMode: "sonar_autofix",
      qualificationSummary: {
        requirementsSummary: ["Fix the Sonar findings in source code."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
    });

    expect(loadSonarPlanningExtension).toHaveBeenCalledTimes(1);
    expect(securityExtension).not.toHaveBeenCalled();
    expect(runAgentMock.mock.calls[0]?.[0].systemAppend).toContain(
      sonarExtension,
    );
    expect(runAgentMock.mock.calls[0]?.[0].systemAppend).not.toContain(
      "SECURITY_EXTENSION",
    );
  });

  it("loads only the security planning extension from processingMode", async () => {
    const securityExtension = "SECURITY_EXTENSION";
    const loadSecurityPlanningExtension = vi
      .fn()
      .mockResolvedValue(securityExtension);
    const sonarExtension = vi.fn().mockResolvedValue("SONAR_EXTENSION");
    const provider = new ClaudePlannerProvider({
      composePrompt: vi.fn().mockResolvedValue("prompt"),
      composeSystemPrompt: vi.fn().mockResolvedValue("SYSTEM_RULES"),
      loadSecurityPlanningExtension,
      loadSonarPlanningExtension: sonarExtension,
    } as unknown as PromptComposer);

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(buildPlan(["pom.xml"])),
      metrics: {
        durationMs: 10,
        toolCalls: 1,
      },
    });

    await provider.generatePlan({
      jiraKey: "CPDEV-23412",
      repoName: "core-app",
      branchName: "master",
      baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      workspacePath: "/tmp/workspace",
      ticketSummary: "[SonarQube] misleading title for a PFOS ticket",
      taskDescription: "Task body mentions [SonarQube] but intake is PFOS.",
      processingMode: "security_wiz",
      qualificationSummary: {
        requirementsSummary: ["Update the approved dependency files only."],
        acceptanceCriteriaPresent: true,
        nonBlockingWarnings: [],
      },
      revision: false,
    });

    expect(loadSecurityPlanningExtension).toHaveBeenCalledTimes(1);
    expect(sonarExtension).not.toHaveBeenCalled();
    expect(runAgentMock.mock.calls[0]?.[0].systemAppend).toContain(
      securityExtension,
    );
    expect(runAgentMock.mock.calls[0]?.[0].systemAppend).not.toContain(
      "SONAR_EXTENSION",
    );
  });
});
