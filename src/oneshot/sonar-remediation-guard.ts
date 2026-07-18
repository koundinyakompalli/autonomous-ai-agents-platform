import type { CodeReviewContext } from "./code-review-context.js";
import type {
  CodeReviewFinding,
  OneShotCodeReview,
} from "./schema/code-review.js";

interface DiffLine {
  file: string;
  sign: "+" | "-";
  text: string;
}

interface MethodSignature {
  file: string;
  name: string;
  signature: string;
}

export interface SonarRemediationGuardResult {
  compliant: boolean;
  findings: CodeReviewFinding[];
  blockingFindings: string[];
  requiredChanges: string[];
}

const SECURITY_SEMANTICS_PATTERN =
  /\b(TrustAll|X509TrustManager|checkServerTrusted|getAcceptedIssuers|HostnameVerifier|NoopHostnameVerifier|setHostnameVerifier|SSLContext|SSLSocketFactory)\b/;

const TRANSACTION_BOUNDARY_PATTERN =
  /(@Transactional\b|Propagation\.|Isolation\.|TransactionTemplate\b|\.flush\s*\(|\.commit\s*\(|\.rollback\s*\(|saveAndFlush\s*\()/;

const SELF_INJECTION_PATTERN =
  /(@Lazy\b|@(Autowired|Inject|Resource)\b|ObjectProvider\s*<|ApplicationContext\s*\.\s*getBean\s*\(|AopContext\s*\.\s*currentProxy\s*\(|exposeProxy\s*=)/;

const RAW_FIND_BY_ID_ANY_PATTERN =
  /\bfindById\s*\(\s*any\s*\(\s*\)\s*,\s*any\s*\(\s*\)\s*\)/;

const REFLECTION_TEST_UTILS_PATTERN =
  /\borg\.springframework\.test\.util\.ReflectionTestUtils\b/;

const NPE_ASSERTION_PATTERN =
  /(assertThrows\s*\(\s*NullPointerException\.class|expected\s*=\s*NullPointerException\.class)/;

const PUBLIC_METHOD_SIGNATURE_PATTERN =
  /^\s*(public|protected)\s+(?:static\s+|final\s+|synchronized\s+|abstract\s+|native\s+)*[\w$<>\[\],.? extends super]+\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[^{;]+)?(?:\{|;)?\s*$/;

const METHOD_INVOCATION_PATTERN = /\b([A-Za-z_$][\w$]*)\s*\(/g;

// Java/control/library idioms that often move during safe local Sonar
// cleanups. Keep domain workflow verbs out so production call swaps fail safe.
const NON_BUSINESS_INVOCATION_NAMES = new Set([
  "append",
  "assert",
  "assertEquals",
  "assertFalse",
  "assertNotNull",
  "assertNull",
  "assertThat",
  "assertThrows",
  "assertTrue",
  "catch",
  "class",
  "close",
  "collect",
  "contains",
  "entrySet",
  "equals",
  "filter",
  "flatMap",
  "for",
  "forEach",
  "format",
  "formatted",
  "get",
  "getKey",
  "getValue",
  "hashCode",
  "if",
  "isEmpty",
  "isPresent",
  "iterator",
  "keySet",
  "map",
  "new",
  "of",
  "orElse",
  "orElseGet",
  "orElseThrow",
  "put",
  "read",
  "remove",
  "return",
  "set",
  "size",
  "stream",
  "super",
  "switch",
  "this",
  "toString",
  "try",
  "valueOf",
  "values",
  "while",
  "write",
]);

function collectDiffLines(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let currentFile = "unknown";

  for (const rawLine of diff.split(/\r?\n/)) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(rawLine);
    if (fileMatch) {
      currentFile = fileMatch[2];
      continue;
    }

    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) {
      continue;
    }

    if (rawLine.startsWith("+") || rawLine.startsWith("-")) {
      lines.push({
        file: currentFile,
        sign: rawLine[0] as "+" | "-",
        text: rawLine.slice(1),
      });
    }
  }

  return lines;
}

function addFinding(
  findings: CodeReviewFinding[],
  input: {
    file: string;
    category: string;
    description: string;
    suggestion: string;
    severity?: CodeReviewFinding["severity"];
  },
) {
  findings.push({
    severity: input.severity ?? "high",
    category: input.category,
    file: input.file,
    description: input.description,
    suggestion: input.suggestion,
  });
}

function collectMethodSignatures(
  lines: DiffLine[],
  sign: "+" | "-",
): MethodSignature[] {
  return lines
    .filter((line) => line.sign === sign)
    .map((line) => {
      const match = PUBLIC_METHOD_SIGNATURE_PATTERN.exec(line.text);
      if (!match) {
        return null;
      }
      return {
        file: line.file,
        name: match[2],
        signature: line.text.replace(/\s+/g, " ").trim(),
      };
    })
    .filter((entry): entry is MethodSignature => entry !== null);
}

function addSignatureFindings(
  findings: CodeReviewFinding[],
  lines: DiffLine[],
) {
  const removed = collectMethodSignatures(lines, "-");
  const added = collectMethodSignatures(lines, "+");

  for (const removedSignature of removed) {
    const changed = added.find(
      (candidate) =>
        candidate.file === removedSignature.file &&
        candidate.name === removedSignature.name &&
        candidate.signature !== removedSignature.signature,
    );
    if (!changed) {
      continue;
    }

    addFinding(findings, {
      file: removedSignature.file,
      category: "sonar_public_contract",
      description:
        `Sonar remediation changed public/protected method signature ` +
        `${removedSignature.name}.`,
      suggestion:
        "Keep public/protected method signatures contract-compatible or route the ticket for manual review.",
    });
  }
}

function addedOrRemovedMatching(lines: DiffLine[], pattern: RegExp): DiffLine[] {
  return lines.filter((line) => pattern.test(line.text));
}

function isTestFile(file: string): boolean {
  return /(^|\/)(test|tests|__tests__)\/|Test\.(java|ts|tsx|js|jsx)$|\.test\./i.test(
    file,
  );
}

function extractBusinessInvocationNames(text: string): string[] {
  if (
    /^\s*(import|package)\b/.test(text) ||
    /^\s*(public|protected|private)\b/.test(text)
  ) {
    return [];
  }

  const names = new Set<string>();
  for (const match of text.matchAll(METHOD_INVOCATION_PATTERN)) {
    const name = match[1];
    if (!NON_BUSINESS_INVOCATION_NAMES.has(name)) {
      names.add(name);
    }
  }
  return [...names];
}

function addBusinessInvocationReplacementFindings(
  findings: CodeReviewFinding[],
  lines: DiffLine[],
) {
  const files = new Set(lines.map((line) => line.file));
  for (const file of files) {
    if (isTestFile(file)) {
      continue;
    }

    const removed = new Set(
      lines
        .filter((line) => line.file === file && line.sign === "-")
        .flatMap((line) => extractBusinessInvocationNames(line.text)),
    );
    const added = new Set(
      lines
        .filter((line) => line.file === file && line.sign === "+")
        .flatMap((line) => extractBusinessInvocationNames(line.text)),
    );

    const removedOnly = [...removed].filter((name) => !added.has(name));
    const addedOnly = [...added].filter((name) => !removed.has(name));
    if (removedOnly.length === 0 || addedOnly.length === 0) {
      continue;
    }

    addFinding(findings, {
      file,
      category: "sonar_business_flow_change",
      description:
        "Sonar remediation replaced production business-method invocation(s).",
      suggestion:
        `Route business flow changes for manual review. Removed: ${removedOnly
          .slice(0, 5)
          .join(", ")}; added: ${addedOnly.slice(0, 5).join(", ")}.`,
    });
  }
}

function hasBooleanShortCircuitChange(lines: DiffLine[]): boolean {
  const removedBitwise = lines.some(
    (line) =>
      line.sign === "-" &&
      (line.text.includes(" & ") || line.text.includes(" | ")),
  );
  const addedShortCircuit = lines.some(
    (line) =>
      line.sign === "+" &&
      (line.text.includes(" && ") || line.text.includes(" || ")),
  );
  return removedBitwise && addedShortCircuit;
}

function allReviewedText(context: CodeReviewContext): string {
  return [
    context.diff,
    ...context.changedFiles
      .map((file) => file.content ?? "")
      .filter((content) => content.length > 0),
  ].join("\n");
}

export function evaluateSonarRemediationGuard(
  context: CodeReviewContext,
): SonarRemediationGuardResult {
  const findings: CodeReviewFinding[] = [];
  const lines = collectDiffLines(context.diff);

  if (context.diffTruncated || context.truncated) {
    addFinding(findings, {
      file: "diff",
      category: "sonar_review_context",
      description:
        "Sonar remediation diff/context was truncated, so deterministic safety checks cannot verify the full candidate.",
      suggestion:
        "Produce a smaller diff or provide complete code-review context before approval.",
    });
  }

  addSignatureFindings(findings, lines);

  const changedSecurityLines = addedOrRemovedMatching(
    lines,
    SECURITY_SEMANTICS_PATTERN,
  );
  for (const line of changedSecurityLines) {
    addFinding(findings, {
      file: line.file,
      category: "sonar_security_semantics",
      description:
        "Sonar remediation changed TLS/auth/crypto/trust-related code.",
      suggestion:
        "Route security semantic changes for manual review unless the approved ticket explicitly covers this behavior.",
    });
  }

  const changedTransactionLines = addedOrRemovedMatching(
    lines,
    TRANSACTION_BOUNDARY_PATTERN,
  );
  for (const line of changedTransactionLines) {
    addFinding(findings, {
      file: line.file,
      category: "sonar_transaction_boundary",
      description:
        "Sonar remediation changed transaction boundary or commit/flush behavior.",
      suggestion:
        "Keep transaction behavior unchanged or route the ticket for manual functional review.",
    });
  }

  addBusinessInvocationReplacementFindings(findings, lines);

  for (const line of addedOrRemovedMatching(lines, SELF_INJECTION_PATTERN)) {
    addFinding(findings, {
      file: line.file,
      category: "sonar_di_proxy_pattern",
      description:
        "Sonar remediation introduced or changed dependency-injection/proxy wiring.",
      suggestion:
        "Do not use self-injection, @Lazy, or proxy lookups as autonomous Sonar shortcuts without explicit review.",
    });
  }

  for (const line of addedOrRemovedMatching(lines, REFLECTION_TEST_UTILS_PATTERN)) {
    addFinding(findings, {
      file: line.file,
      category: "sonar_test_classpath",
      description:
        "Sonar remediation test code references ReflectionTestUtils, which may not be on the module test classpath.",
      suggestion:
        "Use dependencies already present in the affected module or add explicit dependency evidence.",
    });
  }

  for (const line of addedOrRemovedMatching(lines, RAW_FIND_BY_ID_ANY_PATTERN)) {
    addFinding(findings, {
      file: line.file,
      category: "sonar_mockito_overload",
      description:
        "Sonar remediation added an ambiguous Mockito findById(any(), any()) call.",
      suggestion:
        "Use typed matchers or exact argument values that match the real overload.",
    });
  }

  const addedWhitespaceFailures = lines.filter(
    (line) =>
      line.sign === "+" &&
      (/[ \t]$/.test(line.text) ||
        line.text.startsWith("<<<<<<<") ||
        line.text.startsWith("=======") ||
        line.text.startsWith(">>>>>>>")),
  );
  for (const line of addedWhitespaceFailures) {
    addFinding(findings, {
      file: line.file,
      category: "sonar_diff_check",
      description:
        "Sonar remediation candidate contains trailing whitespace or conflict-marker text.",
      suggestion: "Run git diff --check and clean the candidate diff.",
      severity: "medium",
    });
  }

  if (hasBooleanShortCircuitChange(lines) && NPE_ASSERTION_PATTERN.test(allReviewedText(context))) {
    addFinding(findings, {
      file: "diff",
      category: "sonar_stale_behavior_test",
      description:
        "Sonar remediation changed boolean short-circuit behavior while reviewed tests still contain NullPointerException expectations.",
      suggestion:
        "Update tests that asserted the old NPE behavior or route the behavior change for manual review.",
    });
  }

  const blockingFindings = findings.map(
    (finding) => `${finding.category}: ${finding.description}`,
  );
  const requiredChanges = findings.map(
    (finding) => finding.suggestion ?? finding.description,
  );

  return {
    compliant: findings.length === 0,
    findings,
    blockingFindings,
    requiredChanges,
  };
}

export function applySonarRemediationGuard(
  review: OneShotCodeReview,
  context: CodeReviewContext,
): OneShotCodeReview {
  const guard = evaluateSonarRemediationGuard(context);
  if (guard.compliant) {
    return review;
  }

  return {
    ...review,
    decision: "BLOCKED",
    score: Math.min(review.score, 60),
    findings: [...review.findings, ...guard.findings],
    blockingFindings: [
      ...review.blockingFindings,
      ...guard.blockingFindings,
    ],
    requiredChanges: [...review.requiredChanges, ...guard.requiredChanges],
    confidence: "high",
    summary:
      `Deterministic Sonar remediation guard blocked this candidate: ` +
      `${guard.blockingFindings.slice(0, 3).join("; ")}. ` +
      review.summary,
  };
}
