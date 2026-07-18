import { describe, expect, it } from "vitest";
import {
  canReuseTaskManagementRow,
  getDocumentationDocumentTypeLabels,
  getQualifierMode,
  isPfosReplanEligibleRun,
  isDocumentationIntakeTicket,
  isFactoryBuilderTicket,
  isOneShotIntakeTicket,
  parseOneShotQueueMessage,
  shouldSkipAgentForPfos,
  validateDocumentationIntakeLabels,
} from "./contracts.js";

describe("OneShot contracts", () => {
  it("routes PFOS tickets exclusively to QUALIFIER", () => {
    expect(shouldSkipAgentForPfos("DARCI", ["PFOS"])).toBe(true);
    expect(shouldSkipAgentForPfos("QUALIFIER", ["PFOS"])).toBe(false);
    expect(shouldSkipAgentForPfos("DARCI", ["SONAR-AUTOFIX"])).toBe(true);
    expect(shouldSkipAgentForPfos("QUALIFIER", ["SONAR-AUTOFIX"])).toBe(false);
    expect(shouldSkipAgentForPfos("QUALIFIER", [])).toBe(true);
    expect(shouldSkipAgentForPfos("QUALIFIER", ["DARCI"])).toBe(true);
    expect(shouldSkipAgentForPfos("DARCI", ["DARCI"])).toBe(false);
  });

  it("detects fresh, force-approve, and replan qualifier modes", () => {
    expect(getQualifierMode(["PFOS"], null)).toBe("fresh");
    expect(getQualifierMode(["PFOS", "PFOS-NOT-QUALIFIED"], null)).toBeNull();
    expect(
      getQualifierMode(["PFOS", "PFOS-FORCE-APPROVE"], { state: "escalated" }),
    ).toBe("force_approve");
    expect(
      getQualifierMode(["PFOS", "PFOS-REPLAN"], { state: "replan_required" }),
    ).toBe("replan");
    expect(getQualifierMode(["PFOS"], { state: "failed" })).toBeNull();
    expect(getQualifierMode(["PFOS"], { state: "blocked" })).toBeNull();
    expect(getQualifierMode(["PFOS", "PFOS-REPLAN"], { state: "failed" })).toBe(
      "replan",
    );
    expect(
      getQualifierMode(["PFOS", "PFOS-REPLAN"], { state: "blocked" }),
    ).toBe("replan");
    expect(
      getQualifierMode(["PFOS", "PFOS-NOT-QUALIFIED", "PFOS-REPLAN"], {
        state: "failed",
      }),
    ).toBe("replan");
    expect(getQualifierMode(["PFOS", "PFOS-REPLAN"], null)).toBeNull();
    expect(
      getQualifierMode(["PFOS", "PFOS-REPLAN"], {
        state: "pr_open",
        current_pr_url: "https://github.com/org/repo/pull/1",
      }),
    ).toBeNull();
    expect(
      getQualifierMode(["PFOS", "PFOS-REPLAN"], { state: "completed" }),
    ).toBeNull();
    expect(
      getQualifierMode(["PFOS"], { state: "queued_for_planning" }),
    ).toBeNull();
    expect(getQualifierMode(["SONAR-AUTOFIX"], null)).toBe("fresh");
    expect(
      getQualifierMode(["SONAR-AUTOFIX", "SONAR-NOT-QUALIFIED"], null),
    ).toBeNull();
  });

  it("classifies PFOS-REPLAN eligibility without treating PR or completed runs as actionable", () => {
    expect(isPfosReplanEligibleRun(null)).toBe(false);
    expect(isPfosReplanEligibleRun({ state: "failed" })).toBe(true);
    expect(isPfosReplanEligibleRun({ state: "blocked" })).toBe(true);
    expect(isPfosReplanEligibleRun({ state: "queued_for_planning" })).toBe(true);
    expect(isPfosReplanEligibleRun({ state: "pr_open" })).toBe(false);
    expect(isPfosReplanEligibleRun({ state: "completed" })).toBe(false);
    expect(
      isPfosReplanEligibleRun({
        state: "testing",
        current_pr_url: "https://github.com/org/repo/pull/7",
      }),
    ).toBe(false);
  });

  it("only allows safe task_management row reuse states", () => {
    expect(canReuseTaskManagementRow({ status: "posted_to_jira" })).toBe(true);
    expect(canReuseTaskManagementRow({ status: "failed" })).toBe(true);
    expect(canReuseTaskManagementRow({ status: "completed" })).toBe(false);
    expect(canReuseTaskManagementRow({ status: "assigned" })).toBe(false);
  });

  it("validates documentation intake labels without routing through PFOS/Sonar", () => {
    expect(isDocumentationIntakeTicket(["DOCS-GENERATE"])).toBe(true);
    expect(
      validateDocumentationIntakeLabels([
        "DOCS-GENERATE",
        "DOC-TYPE-FUNCTIONALITY",
      ]),
    ).toMatchObject({
      qualified: true,
      documentTypeLabel: "DOC-TYPE-FUNCTIONALITY",
    });
    expect(shouldSkipAgentForPfos("QUALIFIER", ["DOCS-GENERATE"])).toBe(true);
  });

  it("gates oneshot-factory-builder behind PFOS", () => {
    expect(isFactoryBuilderTicket(["PFOS", "oneshot-factory-builder"])).toBe(
      true,
    );
    expect(isFactoryBuilderTicket(["oneshot-factory-builder"])).toBe(false);
    expect(isFactoryBuilderTicket(["PFOS"])).toBe(false);
    expect(
      isFactoryBuilderTicket(["SONAR-AUTOFIX", "oneshot-factory-builder"]),
    ).toBe(false);
    expect(
      isFactoryBuilderTicket([
        "PFOS",
        "SONAR-AUTOFIX",
        "oneshot-factory-builder",
      ]),
    ).toBe(false);
    expect(isOneShotIntakeTicket(["oneshot-factory-builder"])).toBe(false);
  });

  it("normalizes supported documentation legacy aliases", () => {
    expect(getDocumentationDocumentTypeLabels(["DOC-TYPE-CLIENT-KB"])).toEqual([
      "DOC-TYPE-FUNCTIONALITY",
    ]);
    expect(getDocumentationDocumentTypeLabels(["DOC-TYPE-DEPLOYMENT"])).toEqual(
      ["DOC-TYPE-DEPLOYMENT-RUNBOOK"],
    );
  });

  it("rejects missing, multiple, terminal, and ambiguous documentation labels", () => {
    expect(validateDocumentationIntakeLabels(["DOC-TYPE-CONFIG"])).toMatchObject(
      { qualified: false, reasonCode: "docs_generate_missing" },
    );
    expect(validateDocumentationIntakeLabels(["DOCS-GENERATE"])).toMatchObject({
      qualified: false,
      reasonCode: "document_type_missing",
    });
    expect(
      validateDocumentationIntakeLabels([
        "DOCS-GENERATE",
        "DOC-TYPE-CONFIG",
        "DOC-TYPE-API",
      ]),
    ).toMatchObject({
      qualified: false,
      reasonCode: "multiple_document_types",
    });
    expect(
      validateDocumentationIntakeLabels([
        "DOCS-GENERATE",
        "DOC-TYPE-CONFIG",
        "DOCS-GENERATED",
      ]),
    ).toMatchObject({
      qualified: false,
      reasonCode: "terminal_label_present",
      terminalLabel: "DOCS-GENERATED",
    });
    expect(
      validateDocumentationIntakeLabels([
        "DOCS-GENERATE",
        "DOC-TYPE-SUPPORT-INTERNAL",
      ]),
    ).toMatchObject({
      qualified: false,
      reasonCode: "ambiguous_legacy_document_type",
    });
  });

  it("parses queue messages with and without expected implementation SHA", () => {
    const legacy = parseOneShotQueueMessage({
      run_id: 84,
      stage: "code_review",
      version: 2,
      expected_state: "queued_for_code_review",
      revision: false,
      emitted_at: "2026-05-05T12:00:00.000Z",
    });
    expect(legacy.expected_implementation_commit_sha).toBeUndefined();

    const pinned = parseOneShotQueueMessage({
      ...legacy,
      expected_implementation_commit_sha:
        "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      expected_implementation_version: 2,
    });
    expect(pinned.expected_implementation_commit_sha).toBe(
      "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
    expect(pinned.expected_implementation_version).toBe(2);
  });

  it("rejects empty expected implementation SHA values", () => {
    expect(() =>
      parseOneShotQueueMessage({
        run_id: 84,
        stage: "testing",
        version: 3,
        expected_state: "queued_for_testing",
        revision: false,
        emitted_at: "2026-05-05T12:00:00.000Z",
        expected_implementation_commit_sha: "",
      }),
    ).toThrow();
  });

  it("rejects non-positive expected implementation versions", () => {
    expect(() =>
      parseOneShotQueueMessage({
        run_id: 84,
        stage: "testing",
        version: 3,
        expected_state: "queued_for_testing",
        revision: false,
        emitted_at: "2026-05-05T12:00:00.000Z",
        expected_implementation_commit_sha:
          "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        expected_implementation_version: 0,
      }),
    ).toThrow();
  });
});
