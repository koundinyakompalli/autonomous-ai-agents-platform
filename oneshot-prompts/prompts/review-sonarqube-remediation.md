# SonarQube Remediation Review Extension

This extension applies when the ticket carries the `SONAR-AUTOFIX` label.

Review the plan as a narrow SonarQube remediation, not as a general cleanup task.

Additional blocking conditions:

1. The plan changes files outside the listed SonarQube components without a direct test-only reason.
2. The plan addresses unrelated Sonar rules or broad style cleanup.
3. The plan cannot map each listed issue key to a concrete implementation step.
4. The plan changes application behavior where the Sonar rule does not require behavior change.
5. The plan omits validation for the affected module when a reasonable compile or unit-test command is available.

DENY (escalate to human, do not approve) when the change does any of the following — these require manual functional review regardless of whether CI is green:

6. Changes the signature of an existing public/protected method (name, params, or return type).
7. Adds, removes, or moves a transactional boundary (`@Transactional` or a relocated commit/flush point).
8. Changes security semantics (auth, certificate validation, hostname verification, crypto, trust behavior) — OR leaves a class name/Javadoc/comment describing behavior the implementation no longer has (e.g. "skip SSL verification" on code that now validates certs).
9. Introduces a new DI/proxy pattern to satisfy a rule (`@Lazy` self-injection, self-`@Autowired`, new AOP proxy).

Verification the review MUST confirm before APPROVE:

10. The validation command compiles test sources AND runs the affected module's tests scoped to that module (reactor form for multi-module Maven, e.g. `mvn -pl <module> -am -B test`) — not a bare repo-root build that can skip the module.
11. Behavior changes are accompanied by updates to any existing test that encoded the old behavior; no existing test is left asserting the pre-fix behavior.
12. New test code references only APIs/libraries already on that module's test classpath (no newly-assumed `spring-test`/`ReflectionTestUtils`, no unverified method overloads).
13. `git diff --check` passes — no trailing whitespace or conflict markers.

Approve only when the plan is locally scoped, maps clearly to the reported rule(s), introduces no change in the DENY list above, and includes enough verification to prove the listed issue keys are resolved.
