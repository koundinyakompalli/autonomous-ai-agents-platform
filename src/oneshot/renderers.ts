import type { OneShotImplementation } from "./schema/implementation.js";
import type { OneShotPlan } from "./schema/plan.js";
import { getPlanImpactedFiles, getPlanValidationSteps } from "./schema/plan.js";

export function renderOneShotPlanMarkdown(plan: OneShotPlan): string {
  const impactedFiles = getPlanImpactedFiles(plan);
  const validationSteps = getPlanValidationSteps(plan);

  const lines = [
    `# OneShot Plan for ${plan.jiraKey}`,
    "",
    `- Repo: ${plan.repoName}`,
    `- Branch: ${plan.branchName}`,
    `- Base commit: ${plan.baseCommitSha}`,
    "",
    "## Summary",
    plan.summary,
  ];

  if (plan.specs.length > 0) {
    lines.push("", "## Specs");
    for (const spec of plan.specs) {
      lines.push(
        "",
        `### ${spec.id}: ${spec.objective}`,
        "",
        "Acceptance Criteria:",
        ...spec.acceptanceCriteria.map((item) => `- ${item}`),
        "",
        "Target Files:",
        ...spec.targetFiles.map((file) => `- \`${file}\``),
        "",
        "Implementation Notes:",
        ...spec.implementationNotes.map((item) => `- ${item}`),
        "",
        "Validation Steps:",
        ...spec.validationSteps.map((item) => `- ${item}`),
      );
    }
  }

  if (impactedFiles.length > 0) {
    lines.push(
      "",
      "## Impacted Files",
      ...impactedFiles.map((file) => `- \`${file}\``),
    );
  }

  if ((plan.fileChangeContract ?? []).length > 0) {
    lines.push("", "## File Change Contract");
    for (const entry of plan.fileChangeContract ?? []) {
      lines.push(
        `- \`${entry.path}\` - ${entry.role}${entry.editable ? " (editable)" : " (read-only)"}`,
        `  - Rationale: ${entry.rationale}`,
      );
      if ((entry.supportingEvidence ?? []).length > 0) {
        lines.push(
          `  - Evidence: ${(entry.supportingEvidence ?? []).join("; ")}`,
        );
      }
      if ((entry.allowedChanges ?? []).length > 0) {
        lines.push(
          `  - Allowed changes: ${(entry.allowedChanges ?? []).join("; ")}`,
        );
      }
    }
  }

  if ((plan.plannedCodeChanges ?? []).length > 0) {
    lines.push("", "## Planned Code Changes");
    for (const change of plan.plannedCodeChanges ?? []) {
      lines.push(
        "",
        `### ${change.targetFile} - ${change.symbolOrRegion}`,
        "",
        `- Change type: ${change.changeType}`,
        `- Confidence: ${change.confidence}`,
        `- Rationale: ${change.rationale}`,
        `- Evidence: ${change.supportingEvidence.join("; ")}`,
      );
      if (change.beforeSnippet) {
        lines.push("", "Before snippet:", "```", change.beforeSnippet, "```");
      }
      lines.push("", "After sketch:", "```", change.afterSketch, "```");
    }
  } else if (plan.plannedCodeChangeRationale) {
    lines.push(
      "",
      "## Planned Code Changes",
      plan.plannedCodeChangeRationale,
    );
  }

  if (plan.testingStrategy) {
    const strategy = plan.testingStrategy;
    lines.push("", "## Testing Strategy", "", `- Mode: ${strategy.mode}`);
    if (strategy.existingTestEvidence.length > 0) {
      lines.push("", "Existing test evidence:");
      for (const evidence of strategy.existingTestEvidence) {
        const location = evidence.path ?? evidence.command ?? evidence.kind;
        lines.push(`- ${evidence.id} (${evidence.kind}): ${location}`);
        lines.push(`  - ${evidence.summary}`);
        if (evidence.supportingEvidence.length > 0) {
          lines.push(
            `  - Evidence: ${evidence.supportingEvidence.join("; ")}`,
          );
        }
      }
    }
    if (strategy.plannedAutomatedTests.length > 0) {
      lines.push("", "Planned automated tests:");
      for (const test of strategy.plannedAutomatedTests) {
        lines.push(
          `- ${test.id}: ${test.scenario}`,
          `  - File: \`${test.testFile}\``,
          `  - Type: ${test.testType}; fail-first: ${test.failFirst ? "yes" : "no"}`,
          `  - Command: \`${test.command}\``,
          `  - Assertions: ${test.assertions.join("; ")}`,
        );
      }
    }
    if (strategy.validationCommands.length > 0) {
      lines.push("", "Validation commands:");
      for (const command of strategy.validationCommands) {
        lines.push(
          `- \`${command.command}\``,
          `  - Scope: ${command.scope}`,
          `  - Expected: ${command.expectedResult}`,
        );
      }
    }
    if (strategy.manualChecks.length > 0) {
      lines.push("", "Manual checks:");
      for (const check of strategy.manualChecks) {
        lines.push(
          `- ${check.id ? `${check.id}: ` : ""}${check.scenario}`,
          `  - Expected: ${check.expectedResult}`,
          `  - Not automated because: ${check.reasonNotAutomated}`,
        );
      }
    }
    if (strategy.traceGuidance.length > 0) {
      lines.push("", "TRACE guidance:");
      for (const guidance of strategy.traceGuidance) {
        lines.push(
          `- ${guidance.id} [Section ${guidance.section}/${guidance.testType}/${guidance.priority}]: ${guidance.scenario}`,
        );
      }
    }
    if (strategy.coverageGaps.length > 0) {
      lines.push("", "Coverage gaps:");
      for (const gap of strategy.coverageGaps) {
        lines.push(
          `- ${gap.id}: ${gap.gap}`,
          `  - Reason: ${gap.reason}`,
          `  - Risk: ${gap.risk}`,
          `  - Follow-up: ${gap.followUp}`,
        );
      }
    }
  }

  if (plan.guardrailReport) {
    lines.push("", "## Guardrail Report");
    const renderChecks = (
      title: string,
      checks: NonNullable<typeof plan.guardrailReport>["coreChecks"],
    ) => {
      if (checks.length === 0) {
        return;
      }
      lines.push("", `### ${title}`);
      for (const check of checks) {
        lines.push(
          `- ${check.id} [${check.severity}/${check.status}]: ${check.requiredAction}`,
          `  - Applicability: ${check.applicabilityReason}`,
        );
        if (check.evidence.length > 0) {
          lines.push(`  - Evidence: ${check.evidence.join("; ")}`);
        }
      }
    };
    renderChecks("Core Checks", plan.guardrailReport.coreChecks);
    renderChecks("Domain Checks", plan.guardrailReport.domainChecks);
    renderChecks("Implementer Checks", plan.guardrailReport.implementerChecks);
  }

  if ((plan.implementerGuardrails ?? []).length > 0) {
    lines.push("", "## Implementer Guardrails");
    for (const guardrail of plan.implementerGuardrails ?? []) {
      const files =
        guardrail.appliesToFiles.length > 0
          ? guardrail.appliesToFiles.map((file) => `\`${file}\``).join(", ")
          : "All editable files";
      lines.push(
        `- ${guardrail.id}${guardrail.required ? " (required)" : ""}: ${guardrail.instruction}`,
        `  - Applies to: ${files}`,
      );
    }
  }

  if (plan.assumptions.length > 0) {
    lines.push(
      "",
      "## Assumptions",
      ...plan.assumptions.map((item) => `- ${item}`),
    );
  }

  if (plan.openQuestions.length > 0) {
    lines.push(
      "",
      "## Open Questions",
      ...plan.openQuestions.map((item) => `- ${item}`),
    );
  }

  if (plan.outOfScope.length > 0) {
    lines.push(
      "",
      "## Out of Scope",
      ...plan.outOfScope.map((item) => `- ${item}`),
    );
  }

  if (plan.risks.length > 0) {
    lines.push("", "## Risks", ...plan.risks.map((item) => `- ${item}`));
  }

  if (validationSteps.length > 0) {
    lines.push(
      "",
      "## Validation Summary",
      ...validationSteps.map((item) => `- ${item}`),
    );
  }

  return lines.join("\n");
}

export function renderOneShotImplementationMarkdown(
  plan: Pick<OneShotPlan, "jiraKey" | "summary" | "specs">,
  implementation: Pick<
    OneShotImplementation,
    | "summary"
    | "completedSpecIds"
    | "changedFiles"
    | "testCommands"
    | "validationCommands"
    | "validationChecks"
    | "manualVerificationSteps"
    | "testResults"
    | "deviationsFromPlan"
    | "residualRisks"
    | "openFollowUps"
  > &
    Partial<Pick<OneShotImplementation, "implementedTraceTestIds">>,
): string {
  const implementedSpecs = plan.specs.filter((spec) =>
    implementation.completedSpecIds.includes(spec.id),
  );
  const validationChecks = implementation.validationChecks ?? [];

  const lines = [
    `# OneShot Implementation for ${plan.jiraKey}`,
    "",
    "## Plan Summary",
    plan.summary,
    "",
    "## Implementation Summary",
    implementation.summary,
  ];

  if (implementedSpecs.length > 0) {
    lines.push("", "## Completed Specs");
    for (const spec of implementedSpecs) {
      lines.push(`- ${spec.id}: ${spec.objective}`);
    }
  }

  const implementedTraceTestIds = implementation.implementedTraceTestIds ?? [];
  if (implementedTraceTestIds.length > 0) {
    lines.push(
      "",
      "## Implemented TRACE Test IDs",
      ...implementedTraceTestIds.map((id) => `- ${id}`),
    );
  }

  lines.push(
    "",
    "## Changed Files",
    ...(implementation.changedFiles.length > 0
      ? implementation.changedFiles.map((file) => `- \`${file}\``)
      : ["- No tracked file changes were reported."]),
  );

  lines.push(
    "",
    "## Automated Test Commands",
    ...(implementation.testCommands.length > 0
      ? implementation.testCommands.map((command) => `- \`${command}\``)
      : ["- No automated test commands were reported."]),
  );

  lines.push(
    "",
    "## Advisory Validation Commands (not gated)",
    ...(implementation.validationCommands.length > 0
      ? implementation.validationCommands.map((command) => `- \`${command}\``)
      : ["- No structural validation commands were reported."]),
  );

  lines.push(
    "",
    "## Structured Validation Checks",
    ...(validationChecks.length > 0
      ? validationChecks.map(
          (check) =>
            `- ${check.kind}${check.scope && check.scope !== "file" ? ` (${check.scope})` : ""}: \`${check.pattern}\` in ${check.paths.map((entry) => `\`${entry}\``).join(", ")}`,
        )
      : ["- No structured validation checks were reported."]),
  );

  lines.push(
    "",
    "## Validation Results",
    ...(implementation.testResults.length > 0
      ? implementation.testResults.map(
          (result) =>
            `- \`${result.command}\` - ${result.status}: ${result.summary}`,
        )
      : ["- No validation results were reported."]),
  );

  if (implementation.manualVerificationSteps.length > 0) {
    lines.push(
      "",
      "## Manual Verification",
      ...implementation.manualVerificationSteps.map((step) => `- ${step}`),
    );
  }

  if (implementation.deviationsFromPlan.length > 0) {
    lines.push(
      "",
      "## Deviations From Plan",
      ...implementation.deviationsFromPlan.map((item) => `- ${item}`),
    );
  }

  if (implementation.residualRisks.length > 0) {
    lines.push(
      "",
      "## Residual Risks",
      ...implementation.residualRisks.map((item) => `- ${item}`),
    );
  }

  if (implementation.openFollowUps.length > 0) {
    lines.push(
      "",
      "## Follow-ups",
      ...implementation.openFollowUps.map((item) => `- ${item}`),
    );
  }

  return lines.join("\n");
}
