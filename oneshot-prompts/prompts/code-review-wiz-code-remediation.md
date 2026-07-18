# Wiz Code (SAST) Remediation Code Review Extension

This extension applies only when the run is in `wiz_code` mode (Wiz **Code** /
SAST source-code findings — CWE-89 SQL injection, XSS, path traversal, etc.).

Review the **implemented diff** (not the plan) as a narrow SAST remediation. The
fix must neutralize the reported CWE **without** changing behavior for legitimate
input. These are the exact failure modes that have shipped broken SAST PRs — treat
each as a blocking gate, and inspect the actual diff/context, not just the summary.

Return `NEEDS_CHANGES` or `BLOCKED` when the diff does any of the following:

1. **Over-tightened validator.** Adds or narrows an input validator (allowlist,
   regex, escaping, type check) without evidence that it accepts the real, deployed
   input grammar. If the diff introduces an allowlist/regex, the review MUST confirm
   from the context that legitimate inputs still pass — dotted identifiers
   (`schema.table`), aliases with spaces, wildcards (`model.*`), SQL functions
   (`if(...)`, `concat(...)`), string literals. If that cannot be confirmed, do not
   APPROVE. A validator that silently defaults or returns empty on previously-valid
   input is a functional outage, not a fix.
2. **Partial sink coverage.** Fixes the flagged sink but leaves a structurally
   identical sibling sink of the same CWE in the changed file(s) unremediated —
   e.g. guards the `UPDATE` string-concatenation but not the adjacent `INSERT`, or
   validates one column-name interpolation but not another in the same method. Scan
   the diff for every remaining string-concatenated SQL/output sink.
3. **Value concatenated instead of bound.** Uses validate-and-concatenate for a
   runtime *value* that could be a parameterized placeholder (`?`). Runtime values
   must be bound; allowlisting is only acceptable for identifiers that genuinely
   cannot be bound (table/column names from config).
4. **Wrong source preserved.** Adds a guard/allowlist but reads the value from the
   wrong column or source so the guard never matches real data (e.g. reading a
   display-text column against an allowlist of physical column codes), silently
   defaulting every real user to a fallback.
5. **Missing regression test.** No test proves that legitimate input still produces
   the expected result. Attack-blocked-only coverage is insufficient — the
   regression test is what catches over-tightening.
6. **Missing attack test.** No test proves the injection payload for the reported
   CWE is neutralized (query not executed, or value bound as a literal).
7. **Behavior change for valid input.** Alters results, public/protected method
   signatures, return types, or transaction boundaries for input that is not proven
   attack-only.
8. **`git diff --check` failures:** trailing whitespace, conflict markers, or
   unintended line-ending / reformatting churn obscuring the security change.

Verification the review must require:

- A module-scoped test command that compiles test sources AND runs the affected
  module's tests — e.g. `mvn -pl <module> -am -B test` — NOT a root-level
  `-DskipTests` build (which cannot catch a submodule compile break or regression).
- Evidence of both an attack test and a legitimate-input regression test for the
  remediated sink(s).
- If the target class is duplicated in other modules, evidence that the duplicates
  are remediated or captured as a tracked follow-up.
- `git diff --check` passed on the candidate diff.

When any item above cannot be verified from the provided diff/context, be
conservative: return `NEEDS_CHANGES` with a concrete required change instead of
APPROVED.
