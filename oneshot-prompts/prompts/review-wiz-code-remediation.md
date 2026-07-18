# OneShot PLAN REVIEWER — Wiz Code (SAST) Remediation Extension

> This extension is appended to the standard `review-plan.md` system prompt when the
> ticket carries the `WIZ-CODE` label (Wiz **Code** / SAST source-code findings — CWE
> classes such as SQL injection, XSS, path traversal). All standard SAGE scoring rules
> apply. The rules below ADD source-code-remediation review criteria.
>
> This is DISTINCT from `review-security-remediation.md` (dependency version bumps,
> which BLOCK on `.java` changes). Wiz Code fixes REQUIRE `.java` changes — do not
> block them for touching source. Instead, hold them to the correctness bar below.

---

## Why this extension exists

Three failure modes have shipped broken SAST-remediation PRs. Each maps to a
blocking condition below. A plan that is "green in CI" can still exhibit all three,
so several conditions require reasoning about the plan, not just trusting CI.

1. **Over-tightening** — a new validator rejects legitimate, deployed input →
   silent functional outage.
2. **Partial sink coverage** — only the flagged sink is fixed; a sibling sink of the
   same CWE in the same file stays vulnerable.
3. **Silent build break** — a compile error slips past a root-level `-DskipTests`
   build.

---

## Additional SAGE scoring criteria for WIZ-CODE tickets

**Completeness (0.25 weight) — additional checks:**
- Does the plan characterize the real input grammar with ≥3 quoted, deployed examples?
- Does it enumerate all sibling sinks of the same CWE class in the target file?
- Does it include a module-scoped build+test validation step (not `-DskipTests`)?
- Are the CWE ID(s) and affected paths from the ticket captured?

**Architecture (0.20 weight) — additional checks:**
- Is the change minimal and scoped to the CWE (no opportunistic refactor)?
- Does the fix prefer parameterization for runtime values over validate-and-concatenate?

**Security (0.15 weight) — additional checks:**
- Does the fix actually neutralize the reported CWE at the sink?
- Are ALL sibling sinks of the same class remediated with the same technique?

**Risk Assessment (0.10 weight) — additional checks:**
- Is there a regression test proving legitimate input still works?
- Are known duplicate copies of the class addressed or captured as follow-up?

---

## Hard BLOCKED conditions for WIZ-CODE tickets

Issue BLOCKED (not NEEDS_CHANGES) if ANY of the following is true:

1. **Over-tightening risk unaddressed.** The plan adds or narrows a validator
   (allowlist/regex/escaping) but does NOT quote ≥3 real deployed examples of the
   input, OR the proposed validator would reject any quoted example. (This is the
   single highest-frequency defect — scrutinize it hardest. A validator that rejects
   `model.*`, dotted identifiers, aliases-with-spaces, or SQL functions that appear in
   real config is wrong.)
2. **Partial sink coverage.** The target file contains a sibling sink of the same CWE
   class (e.g. an INSERT built by concatenation next to the fixed UPDATE) that the
   plan does not remediate and does not justify in `openQuestions`.
3. **No regression test.** The plan adds no test proving that legitimate input still
   produces the expected result (attack-blocked-only coverage is insufficient).
4. **Build not proven to compile with tests.** `validationSteps` lacks a module-scoped
   `mvn -pl <module> -am -B test` (or equivalent), or uses `-DskipTests`. A root-level
   skip-tests build does NOT satisfy this — it cannot catch a submodule compile error.
5. **Runtime value concatenated instead of bound.** The plan validates-and-concatenates
   a value that could and should be a PreparedStatement bind parameter.

## DENY (escalate to human — do not approve) when the change:

6. Changes the signature of an existing public/protected method (name, params, return).
7. Adds, removes, or relocates a transactional boundary.
8. Changes security semantics elsewhere, or leaves a class name / Javadoc / comment
   describing behavior the implementation no longer has.
9. Changes application behavior for input that is NOT proven attack-only — i.e. the
   fix alters results for input that appears in the real grammar.

## Verification the review MUST confirm before APPROVE:

10. The validation command compiles test sources AND runs the affected module's tests
    scoped to that module (reactor form, e.g. `mvn -pl <module> -am -B test`) — not a
    bare repo-root or skip-tests build.
11. A regression test asserts each quoted real example still works, AND an attack test
    asserts the payload is neutralized.
12. New test code references only APIs/libraries already on that module's test classpath.
13. `git diff --check` passes — no trailing whitespace or conflict markers.
14. Any known duplicate copy of the target class is either remediated or captured as a
    follow-up in `openQuestions`.

---

## Wiz Code Review Output Requirements

In addition to standard review output, include in `reviewNotes`:

```
Wiz Code remediation check:
- CWE(s) addressed: [list from ticket]
- Sink coverage: [flagged sink + N sibling sinks, all remediated | GAP: sink X unremediated]
- Input grammar: [N real examples quoted; validator accepts all: yes/no | not applicable]
- Parameterization: [runtime values bound as ? : yes/no]
- Behavior preserved: [yes | changed for attack-only input: justified | REGRESSION RISK]
- Tests: [attack-blocked: yes/no] [legit-input regression: yes/no]
- Duplicates: [none | class also in <path>: remediated / follow-up ticket]
- Validation: [module-scoped build+test present: yes/no] [git diff --check: yes/no]
```

Approve only when the fix neutralizes the CWE at every sibling sink, provably preserves
behavior for real input, carries both attack and regression tests, and includes a
module-scoped build+test that compiles and passes.
