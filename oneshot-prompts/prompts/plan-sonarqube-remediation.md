# SonarQube Remediation Planning Extension

This extension applies when the ticket carries the `SONAR-AUTOFIX` label.

Plan a minimal, source-level remediation for the SonarQube findings listed in the Jira ticket. The ticket text is authoritative for:

- SonarQube rule id(s)
- issue key(s)
- component file path(s)
- reported line number(s)
- issue type and severity

Hard requirements:

1. Scope the plan only to the listed SonarQube rule(s), issue key(s), and component files.
2. Do not perform broad cleanup for neighboring Sonar findings.
3. Do not refactor unrelated code to improve general style, complexity, naming, or duplication.
4. Preserve existing behavior unless the Sonar rule explicitly identifies a behavior bug.
5. Include a targeted validation command for the affected module when one can be inferred.
6. If the reported fix requires product behavior, data model, API contract, or workflow decisions beyond the local rule violation, treat it as manual-review-required. Because the planner output schema is a plan object, encode this as a schema-valid no-code-change plan: summary begins `MANUAL REVIEW REQUIRED`, the spec objective is `Do not implement autonomously`, implementation notes say no files should be edited, and `openQuestions` / `risks` explain the missing decision.

Hard escalation — produce the manual-review-required no-code-change plan above when the only way to satisfy the Sonar rule requires any of the following. These are the change classes that have produced merge-blocking regressions; they require manual functional review, not autonomous remediation:

1. Changing the signature of an existing public or protected method (name, parameter list, return type) — e.g. altering `triggerRCA` / `triggerRCAProcess` return types. Callers and contracts are out of scope for a local Sonar fix.
2. Changing transactional boundaries — adding, removing, or moving `@Transactional`, or relocating work across `copyCorrespondance` / `retriggerCorrespondence`-style commit boundaries. Transaction scope is a functional decision.
3. Changing security semantics — anything that flips authentication, certificate validation, hostname verification, crypto, or trust behavior. If a rule such as `java:S4830` requires changing production TLS/trust behavior, require manual review unless the ticket explicitly says the code is test-only or names an existing approved repository abstraction. Never ship code whose behavior contradicts its own class/Javadoc description.
4. Introducing a new dependency-injection or proxy pattern to silence a smell — e.g. `@Lazy` self-injection, new `@Autowired` self references, or AOP proxies. These are null in direct unit tests and change wiring semantics.

Behavior + test co-evolution (prevents the "fix compiles but existing test fails" class):

- When the fix changes runtime behavior (e.g. `&` → `&&` to fix an NPE), the plan MUST identify every existing test that encodes the OLD behavior and update it in the same change. An existing test that asserts the old behavior is a signal the change is behavior-altering — if you cannot safely update it, use the manual-review-required no-code-change plan.
- The plan MUST only reference test APIs and libraries already on the affected module's test classpath. Do not introduce `org.springframework.test.util.ReflectionTestUtils` (or any test dependency) unless `spring-test` / that artifact is already a test-scope dependency of that module. Do not write overloaded calls such as `findById(any(), any())` without confirming the exact method arity on the class under test.

Rule-specific guidance:

- XML parser hardening rules such as `java:S2755`: disable external entity resolution and unsafe DTD/schema features at the local parser construction point.
- TLS validation rules such as `java:S4830`: production trust/hostname behavior changes require manual review unless the ticket explicitly states this is test-only code or names an existing approved repository abstraction. If the fix validates certificates but still skips hostname verification, the class name, Javadoc, and comments MUST be updated to match; otherwise use the manual-review-required no-code-change plan.
- Password encoder rules such as `java:S5344`: prefer an existing secure encoder pattern in the repository; do not invent a migration scheme without evidence.
- Transactional rules such as `java:S2229`: require manual review if the fix adds, removes, or moves `@Transactional`, changes propagation/isolation/readOnly settings, or changes save/flush/commit/call-order behavior.
- Resource cleanup rules such as `java:S2095`: use try-with-resources or explicit close in the narrowest local scope.
- Boolean operator rules such as `java:S2178`: use `&&` or `||` only when short-circuit semantics preserve the intended behavior; otherwise block for human review.

Verification requirements:

- The plan MUST include a validation command that BOTH compiles the test sources and runs the affected module's tests, scoped to that module — not a repo-root build. For Maven multi-module repos use the reactor form, e.g. `mvn -pl MedicalMgmt -am -B test` (which runs `test-compile` + `test` for that module and its upstream deps). A plan whose validation command cannot fail on a broken test compile is insufficient.
- The plan MUST include a whitespace/format gate: `git diff --check` must pass (no trailing whitespace or conflict markers) before the change is considered done.

The output plan must make it easy to verify that each listed issue key is addressed.
