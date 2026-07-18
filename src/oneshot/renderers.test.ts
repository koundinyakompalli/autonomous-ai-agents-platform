import { describe, expect, it } from "vitest";
import {
  renderOneShotImplementationMarkdown,
  renderOneShotPlanMarkdown,
} from "./renderers.js";

describe("oneshot renderers", () => {
  const plan = {
    jiraKey: "CPDEV-1",
    repoName: "core-app",
    branchName: "master",
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    summary: "Implement the approved PFOS change.",
    specs: [
      {
        id: "SPEC-1",
        objective: "Update the queue consumer wiring",
        acceptanceCriteria: ["Queue consumer starts successfully"],
        targetFiles: ["src/oneshot/main.ts"],
        implementationNotes: ["Follow existing startup patterns"],
        validationSteps: ["npm run build"],
      },
    ],
    assumptions: ["Single repository change"],
    openQuestions: [],
    outOfScope: [],
    risks: ["Deployment drift is possible if task definitions are stale"],
  };

  it("renders plan markdown from the structured spec packet", () => {
    const markdown = renderOneShotPlanMarkdown({
      ...plan,
      fileChangeContract: [
        {
          path: "src/oneshot/main.ts",
          role: "runtime_required",
          editable: true,
          rationale: "Queue startup code owns the behavior.",
          supportingEvidence: ["Read src/oneshot/main.ts."],
          allowedChanges: ["Update the startup wiring."],
        },
        {
          path: "src/oneshot/main.test.ts",
          role: "test_required",
          editable: true,
          rationale: "Unit test should cover the startup contract.",
          supportingEvidence: ["Read adjacent test patterns."],
        },
      ],
      plannedCodeChanges: [
        {
          targetFile: "src/oneshot/main.ts",
          symbolOrRegion: "queue startup registration",
          changeType: "update",
          beforeSnippet: "startQueue();",
          afterSketch: "await startQueue({ durable: true });",
          rationale: "Make startup explicit and testable.",
          supportingEvidence: ["Existing startup helper accepts options."],
          confidence: "high",
        },
      ],
      guardrailReport: {
        coreChecks: [
          {
            id: "scope-discipline",
            severity: "high",
            status: "passed",
            applicabilityReason: "Core guardrail applies to every plan.",
            evidence: ["File contract limits edits to startup files."],
            requiredAction: "Stay within the contract.",
          },
        ],
        domainChecks: [],
        implementerChecks: [
          {
            id: "editable-file-contract",
            severity: "high",
            status: "passed",
            applicabilityReason: "Editable files are named explicitly.",
            evidence: ["fileChangeContract contains editable entries."],
            requiredAction: "Only edit editable files.",
          },
        ],
      },
      implementerGuardrails: [
        {
          id: "startup-file-scope",
          instruction: "Do not edit files outside the startup contract.",
          appliesToFiles: ["src/oneshot/main.ts", "src/oneshot/main.test.ts"],
          required: true,
        },
      ],
    });

    expect(markdown).toContain("# OneShot Plan for CPDEV-1");
    expect(markdown).toContain("### SPEC-1: Update the queue consumer wiring");
    expect(markdown).toContain("`src/oneshot/main.ts`");
    expect(markdown).toContain("## File Change Contract");
    expect(markdown).toContain("runtime_required");
    expect(markdown).toContain("## Planned Code Changes");
    expect(markdown).toContain("queue startup registration");
    expect(markdown).toContain("## Guardrail Report");
    expect(markdown).toContain("scope-discipline");
    expect(markdown).toContain("## Implementer Guardrails");
  });

  it("renders implementation markdown from structured outputs", () => {
    const markdown = renderOneShotImplementationMarkdown(plan, {
      summary: "Wired the queue consumer and verified startup.",
      completedSpecIds: ["SPEC-1"],
      changedFiles: ["src/oneshot/main.ts"],
      testCommands: ["npm run build"],
      validationCommands: ['grep -n "queue consumer" src/oneshot/main.ts'],
      manualVerificationSteps: [
        "Verify the queue consumer status chip updates in the browser.",
      ],
      testResults: [
        {
          command: "npm run build",
          status: "passed",
          summary: "TypeScript build succeeded.",
        },
      ],
      deviationsFromPlan: [],
      residualRisks: [],
      openFollowUps: [],
    });

    expect(markdown).toContain("# OneShot Implementation for CPDEV-1");
    expect(markdown).toContain(
      "Wired the queue consumer and verified startup.",
    );
    expect(markdown).toContain("`src/oneshot/main.ts`");
    expect(markdown).toContain("## Automated Test Commands");
    expect(markdown).toContain("## Advisory Validation Commands (not gated)");
    expect(markdown).toContain("## Manual Verification");
    expect(markdown).toContain(
      "Verify the queue consumer status chip updates in the browser.",
    );
  });
});
