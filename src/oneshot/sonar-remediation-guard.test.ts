import { describe, expect, it } from "vitest";
import type { CodeReviewContext } from "./code-review-context.js";
import {
  applySonarRemediationGuard,
  evaluateSonarRemediationGuard,
} from "./sonar-remediation-guard.js";
import type { OneShotCodeReview } from "./schema/code-review.js";

function buildContext(diff: string, content = ""): CodeReviewContext {
  return {
    diff,
    diffTruncated: false,
    changedFiles: [
      {
        path: "MedicalMgmt/src/test/java/FooTest.java",
        included: true,
        truncated: false,
        sizeBytes: content.length,
        content,
      },
    ],
    totalBytesIncluded: content.length,
    truncated: false,
  };
}

function approvedReview(): OneShotCodeReview {
  return {
    decision: "APPROVED",
    score: 94,
    sageDimensions: [],
    findings: [],
    blockingFindings: [],
    requiredChanges: [],
    nonBlockingSuggestions: [],
    confidence: "high",
    summary: "Looks good.",
    implementationVersion: 1,
  };
}

describe("sonar remediation guard", () => {
  it("blocks security semantic changes even when provider approved", () => {
    const context = buildContext(`diff --git a/src/Foo.java b/src/Foo.java
+import javax.net.ssl.HostnameVerifier;
+sslConnection.setHostnameVerifier((host, session) -> true);
`);

    const guarded = applySonarRemediationGuard(approvedReview(), context);

    expect(guarded.decision).toBe("BLOCKED");
    expect(guarded.blockingFindings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sonar_security_semantics"),
      ]),
    );
  });

  it("detects transaction boundary and self-injection changes", () => {
    const context = buildContext(`diff --git a/src/Foo.java b/src/Foo.java
+@Transactional(propagation = Propagation.REQUIRES_NEW)
+@Lazy
+@Autowired
+private FooService self;
`);

    const result = evaluateSonarRemediationGuard(context);

    expect(result.compliant).toBe(false);
    expect(result.blockingFindings.join("\n")).toContain(
      "sonar_transaction_boundary",
    );
    expect(result.blockingFindings.join("\n")).toContain(
      "sonar_di_proxy_pattern",
    );
  });

  it("detects production business-method invocation replacements", () => {
    const context = buildContext(`diff --git a/src/WorkflowService.java b/src/WorkflowService.java
-submitCurrentStep(source, target);
+restartWorkflow(target);
`);

    const result = evaluateSonarRemediationGuard(context);

    expect(result.compliant).toBe(false);
    expect(result.blockingFindings.join("\n")).toContain(
      "sonar_business_flow_change",
    );
  });

  it("does not block collection or string library call reshapes", () => {
    const context = buildContext(`diff --git a/src/Foo.java b/src/Foo.java
-for (String key : values.keySet()) {
-  target.put(key, String.format("%s", values.get(key)));
-}
+for (Map.Entry<String, String> entry : values.entrySet()) {
+  target.put(entry.getKey(), "%s".formatted(entry.getValue()));
+}
`);

    expect(evaluateSonarRemediationGuard(context).compliant).toBe(true);
  });

  it("does not block operator-only boolean remediation", () => {
    const context = buildContext(`diff --git a/src/Foo.java b/src/Foo.java
-return left.isReady() & right.isReady();
+return left.isReady() && right.isReady();
`);

    expect(evaluateSonarRemediationGuard(context).compliant).toBe(true);
  });

  it("detects stale NPE tests after boolean short-circuit changes", () => {
    const context = buildContext(
      `diff --git a/src/Foo.java b/src/Foo.java
-return left & right.isReady();
+return left && right.isReady();
`,
      "assertThrows(NullPointerException.class, () -> service.call());",
    );

    const result = evaluateSonarRemediationGuard(context);

    expect(result.compliant).toBe(false);
    expect(result.blockingFindings.join("\n")).toContain(
      "sonar_stale_behavior_test",
    );
  });

  it("detects public method signature drift", () => {
    const context = buildContext(`diff --git a/src/RcaService.java b/src/RcaService.java
-public void triggerRCA(String key) {
+public boolean triggerRCA(String key) {
`);

    const result = evaluateSonarRemediationGuard(context);

    expect(result.compliant).toBe(false);
    expect(result.blockingFindings.join("\n")).toContain(
      "sonar_public_contract",
    );
  });

  it("passes a local source-only remediation without risky patterns", () => {
    const context = buildContext(`diff --git a/src/Foo.java b/src/Foo.java
-try {
-  stream.read();
-}
+try (InputStream in = stream) {
+  in.read();
+}
`);

    expect(evaluateSonarRemediationGuard(context).compliant).toBe(true);
  });
});
