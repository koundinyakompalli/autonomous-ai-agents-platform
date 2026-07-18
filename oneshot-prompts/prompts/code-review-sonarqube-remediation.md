# SonarQube Remediation Code Review Extension

This extension applies only when the run is in `sonar_autofix` mode.

Review the implementation as a narrow SonarQube remediation. APPROVE only if the diff is limited to the listed issue key(s), rule id(s), and component file(s), and the implementation does not introduce a broader behavioral change.

Return `NEEDS_CHANGES` or `BLOCKED` when the diff does any of the following:

1. Changes an existing public or protected method signature, including name, parameter list, or return type. Known risky examples include `triggerRCA` / `triggerRCAProcess`.
2. Adds, removes, moves, or changes transactional behavior involving `@Transactional`, explicit flush/commit flow, or `copyCorrespondance` / `retriggerCorrespondence`.
3. Changes security semantics in a way that is not fully required by the Sonar rule, including certificate validation, hostname verification, auth, crypto, or trust behavior. Also reject mismatches where class names, Javadocs, or comments still say "skip SSL verification" while implementation now validates certificates or vice versa.
4. Introduces `@Lazy` self-injection, self-`@Autowired`, or another DI/proxy pattern to satisfy a rule without direct unit-test coverage for both injected-self and direct-construction paths.
5. Leaves existing tests asserting the pre-fix behavior, such as old NPE expectations after an `&` to `&&` change.
6. Adds test code that depends on unavailable libraries such as `org.springframework.test.util.ReflectionTestUtils` without that module already depending on `spring-test`.
7. Uses ambiguous Mockito calls such as `findById(any(), any())` without matching the exact overload.
8. Leaves `git diff --check` failures: trailing whitespace, conflict markers, or unintended line-ending churn.

Verification the review must require:

- A module-scoped test command that compiles test sources and runs affected tests, for example `mvn -pl <module> -am -B test` in Maven multi-module repositories.
- Evidence that every changed behavior has updated tests and that no old behavior assertion remains.
- `git diff --check` passed on the candidate diff.

When any item above cannot be verified from the provided diff/context, be conservative: return `NEEDS_CHANGES` with a concrete required change instead of APPROVED.
