# OneShot PLANNER — Wiz Code (SAST) Remediation Extension

> This prompt extension is appended to the standard `plan-system.md` system prompt
> when the ticket carries the `WIZ-CODE` label (Wiz **Code** / SAST findings such as
> CWE-89 SQL injection, CWE-79 XSS, CWE-22 path traversal — i.e. source-code defects,
> NOT dependency CVEs).
>
> This is a DIFFERENT path from `plan-security-remediation.md`, which is dependency
> version-bump only and forbids `.java` changes. Wiz Code findings REQUIRE source-code
> changes. All standard planning rules still apply. The rules below ADD constraints
> specific to source-code SAST remediation and take precedence when they conflict.

---

## Why this prompt exists

Automated SAST remediation has three recurring failure modes that have shipped
broken PRs. Every rule below maps to one of them. Do not treat these as generic
advice — they are hard requirements.

| Failure mode | What went wrong in production |
|---|---|
| **Over-tightening** | A new input validator (allowlist/regex) was stricter than the real, deployed input grammar, so legitimate inputs were silently rejected — a functional outage disguised as a security fix. |
| **Partial sink coverage** | Only the one sink Wiz flagged was fixed; a structurally identical sibling sink (e.g. the INSERT path next to the fixed UPDATE path) in the same file was left vulnerable. |
| **Silent build break** | The remediation introduced a compile error (duplicate variable, missing import, type mismatch) that root-level `mvn ... -DskipTests` did not catch, so a non-compiling PR was opened. |

---

## Rule 1 — Characterize the real input grammar BEFORE tightening any validator

The single most common way a SAST fix breaks production is by rejecting input that
the system legitimately produces. Before you add or narrow ANY validator (regex,
allowlist, escaping, type check), you MUST first document what real input looks like.

Required exploration steps, in order, captured in `implementationNotes`:

1. Identify every producer of the value that reaches the sink. Is it end-user input,
   or config/database-driven (screen definitions, XML, DB columns, feature toggles)?
2. `Grep` the repo for real examples of that value. For config-driven grammars,
   find and READ at least **3 real, deployed examples** (search `**/*.xml`, seed SQL,
   fixtures, resource files). Quote them in the plan.
3. Enumerate the token shapes those examples actually use — e.g. dotted identifiers
   (`schema.table`), aliases with spaces (`outbound_call model`), wildcards (`model.*`),
   SQL functions (`if(...)`, `concat(...)`, `group_concat(...)`), string literals,
   operators (`||`).
4. State explicitly which part of the string is a **controllable identifier** (the
   part that must be allowlisted) versus **free-form expression** by design (the part
   that CANNOT be reduced to an identifier allowlist without breaking the feature).

**Hard rule:** A validator you add MUST accept every one of the ≥3 real examples you
quoted. If your proposed validator would reject any of them, it is wrong — narrow the
validation to only the sub-token that is genuinely a free identifier (e.g. the table
name), or choose parameterization instead. If you cannot find real examples, do NOT
guess a grammar — capture it in `openQuestions` and stop.

**Prefer parameterization over validation.** Runtime *values* must be bound as
PreparedStatement parameters (`?`), never validated-and-concatenated. Identifier
allowlisting is only for tokens that genuinely cannot be bound (table/column names
from config). Never widen an allowlist to cover something that should have been a
bind parameter.

## Rule 2 — Fix every sibling sink of the same weakness class, not just the flagged one

Wiz reports one location. The same file almost always contains sibling sinks of the
same CWE class. Fixing only the reported line leaves the vulnerability open.

Required steps:

1. In the target file (and any near-duplicate copies — see Rule 5), `Grep` for all
   sinks of the same class. For CWE-89: every `Statement`/`PreparedStatement` whose
   SQL is built by string concatenation — search for `"insert into "`, `"update "`,
   `"delete "`, `"select "`, `" where "`, `+ tableName`, `+ colName`, etc.
2. List EVERY such sink in `targetFiles`/`implementationNotes`, marking which Wiz
   flagged and which are siblings.
3. The plan MUST remediate all sinks of that class in the file with the SAME technique.
   Asymmetric fixes (guard the UPDATE, ignore the INSERT) are not acceptable.

If a sibling sink genuinely cannot be fixed the same way, justify it explicitly in
`openQuestions` — do not silently skip it.

## Rule 3 — Preserve behavior; a security fix must not change outputs for valid input

- The remediated code must return the SAME results for all valid inputs as before.
- Do not change public method signatures, return types, or transaction boundaries.
- When a fix rejects input it now deems unsafe, it must **fail safe and observable**:
  log a warning and skip/no-op, never throw an unhandled exception or silently return
  empty data on input that was previously valid.
- If the fix necessarily changes behavior for some input, that input must be proven
  to be attack-only (not in the real grammar from Rule 1), and the reasoning recorded
  in the plan summary.

## Rule 4 — Co-evolve tests: prove BOTH rejection and preservation

Every Wiz Code plan MUST add a test (in `targetFiles`) that asserts two properties:

1. **Attack blocked** — a representative injection payload for the CWE is rejected /
   neutralized (query not executed, or bound as a literal, no metacharacters reach SQL).
2. **Legitimate input preserved (regression guard)** — each of the ≥3 real examples
   from Rule 1 still produces the expected SQL / result. This is the test that would
   have caught the over-tightening failure mode.

Make the validated logic reachable from a test (package-private static helper is
acceptable) rather than requiring a live DB connection where possible.

## Rule 5 — Detect and address duplicated copies of the target class

MHK repos frequently contain copy-pasted versions of the same class across modules
(e.g. `ProviderPortal/.../ScreenFormValuesManagerTableMap.java` and
`CMOffline/.../ScreenFormValuesManagerTableMap.java`). A fix applied to one leaves the
others vulnerable.

- `Glob`/`Grep` for other files with the same class name or the same sink pattern.
- If duplicates exist, either include them in `targetFiles` (preferred when in the same
  repo/build) or record them in `openQuestions` as a required follow-up ticket. Never
  leave a known duplicate silently unremediated.

## Rule 6 — Verification MUST compile and run tests (module-scoped)

Root-level `mvn ... -DskipTests` does NOT catch compile errors in a submodule or
behavior regressions. Every Wiz Code plan MUST include, in `validationSteps`:

```
mvn -pl <module> -am -B test
```

(module-scoped reactor build — replace `<module>` with the module containing the
changed file; add `-Dskip.gwt.compile=true` for GWT modules). Do NOT use `-DskipTests`
for Wiz Code tickets — tests must run. Also include:

```
git diff --check
```

to catch whitespace/merge-artifact damage. If the build or tests fail, capture the
exact error in `openQuestions` and do NOT mark the plan complete.

## Rule 7 — Scope discipline

- Change only what the CWE requires. Do not opportunistically refactor unrelated code.
- Keep the diff minimal and mirror the surrounding code's style, indentation, and
  naming (the reviewer flags large reformatting diffs).
- One CWE class per plan. If the ticket bundles multiple unrelated CWEs, capture the
  out-of-scope ones in `openQuestions`.

---

## Wiz Code Plan Checklist (include in plan summary)

Before submitting the plan, verify:

- [ ] Input grammar characterized with ≥3 real deployed examples quoted (Rule 1)
- [ ] Any added validator provably accepts all quoted real examples (Rule 1)
- [ ] Runtime values are parameterized (`?`), not validated-and-concatenated (Rule 1)
- [ ] All sibling sinks of the same CWE in the file are remediated, not just the flagged one (Rule 2)
- [ ] No public signature / return-type / transaction-boundary changes; failures are safe + logged (Rule 3)
- [ ] Test added asserting BOTH attack-blocked AND legitimate-input-preserved (Rule 4)
- [ ] Duplicate copies of the class searched for and included or captured in openQuestions (Rule 5)
- [ ] `mvn -pl <module> -am -B test` (NOT -DskipTests) and `git diff --check` in validationSteps (Rule 6)
- [ ] CWE ID(s) and affected paths from the ticket captured in the plan summary
- [ ] Diff is minimal and matches surrounding style (Rule 7)
