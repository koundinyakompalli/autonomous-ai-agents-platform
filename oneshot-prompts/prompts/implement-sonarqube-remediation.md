# SonarQube Remediation Implementation Extension

This extension applies only when the run is in `sonar_autofix` mode.

Implement the approved plan as a narrow SonarQube fix. The Jira ticket and approved plan are the allowed scope: listed rule id(s), issue key(s), component file(s), and reported line number(s). Do not use a Sonar task to perform general cleanup.

Hard stop conditions:

1. Do not change the signature of an existing public or protected method, including method name, parameter list, or return type. Examples such as `triggerRCA` / `triggerRCAProcess` must stay contract-compatible.
2. Do not add, remove, move, or repurpose transactional boundaries. Changes involving `@Transactional`, explicit flush/commit behavior, or `copyCorrespondance` / `retriggerCorrespondence`-style transaction flow require human review.
3. Do not change security semantics unless the Sonar rule explicitly requires that exact semantic change. Certificate validation, hostname verification, authentication, crypto, and trust behavior must remain internally consistent with class names, Javadocs, and comments.
4. Do not introduce new dependency-injection or proxy patterns to silence a smell. `@Lazy` self-injection, self-`@Autowired`, and AOP proxy lookups are not acceptable Sonar shortcuts unless the codebase already uses that exact pattern in the same class and direct unit tests prove the fallback path.

Regression blockers seen in prior Sonar runs:

- If an existing test asserts the old behavior, update that test in the same change or stop. For example, changing `&` to `&&` to avoid an NPE is behavior-changing when tests expected the old NPE.
- Do not reference test APIs absent from the module classpath. Do not use `org.springframework.test.util.ReflectionTestUtils` unless `spring-test` is already a test dependency for that module.
- Avoid ambiguous Mockito calls such as `findById(any(), any())`; verify the exact overload and use typed matchers or direct values.
- Keep `git diff --check` clean: no trailing whitespace, conflict markers, or accidental line-ending churn.

Validation requirements:

- Use a module-scoped command that compiles test sources and runs tests for the affected module. For Maven multi-module repos, prefer reactor form such as `mvn -pl <module> -am -B test`.
- If the module cannot compile because of an unrelated pre-existing failure, report the exact compiler failure as residual risk and still run the narrowest available static/structural validation.
- Include `git diff --check` in reported validation evidence before returning.

If the approved plan conflicts with any hard stop condition, do not force a risky implementation. Return the safest partial result with `deviationsFromPlan`, `residualRisks`, and `openFollowUps` that make the human-review need explicit.
