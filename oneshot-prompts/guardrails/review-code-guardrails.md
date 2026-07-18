# Code Review Guardrails

**Version:** 2.0.0
**Purpose:** Quality gate for the CODE REVIEWER stage

---

## Overview

The CODE REVIEWER uses these guardrails when evaluating implementation code against the approved plan. These define the quality bar for what passes code review.

---

## Review Standards

### Objectivity
- Base evaluations on concrete evidence, not opinion
- Cite specific files, lines, patterns when raising issues
- Acknowledge good practices alongside issues

### Completeness
- Cover all review dimensions — execute ALL 10 passes
- Don't skip passes in the 10-pass code review
- Check every acceptance criterion

### Actionability
- Every finding must include a specific suggestion for resolution
- Suggestions should be implementable without further clarification
- Reference existing patterns in the codebase when possible

---

## Code Review Quality Gate

### Minimum Score: 75/100

Code scoring below 75 is sent back for fixes. The IMPLEMENTER receives specific findings and applies targeted fixes.

### Critical Blockers (automatic fail)
- SQL injection or other injection vulnerabilities
- Hardcoded secrets or credentials
- PHI/PII exposure in logs or error messages
- Data loss risk from missing transactions
- Breaking changes to public APIs

### High Priority (significant deduction)
- N+1 query patterns
- Missing test coverage for new code
- Swallowed exceptions
- Thread safety issues
- Missing input validation

---

## 10-Pass Code Review Checklist

The CODE REVIEWER must execute all 10 passes:

1. **Plan Compliance** — Changes match the approved plan
2. **Correctness** — Code does what it should, handles edge cases
3. **Security** — No vulnerabilities, proper auth, input validation
4. **Performance** — No N+1, proper pagination, efficient algorithms
5. **Error Handling** — Specific exceptions, meaningful messages, no swallowing
6. **Test Quality** — Tests exist, are meaningful, cover edge cases
7. **Code Quality** — DRY, single responsibility, good naming
8. **Backward Compatibility** — No breaking changes, proper deprecation
9. **Thread Safety** — Synchronized access, atomic operations
10. **Healthcare/Domain Compliance** — PHI protection, FHIR compliance, audit trails

---

## SAGE Scoring Methodology

### Dimensions and Weights

| Dimension | Weight | What It Measures |
|-----------|--------|-----------------|
| Correctness | 0.25 | Code correctly implements the plan's requirements |
| Security | 0.20 | No vulnerabilities or HIPAA compliance issues |
| Test Quality | 0.15 | Tests present, meaningful, covering edge cases |
| Code Quality | 0.15 | Follows conventions, maintainable |
| Performance | 0.15 | No performance issues or resource concerns |
| Completeness | 0.10 | All acceptance criteria implemented |

### Deduction Scale

| Severity | Per-Issue Deduction |
|----------|-------------------|
| CRITICAL | -20 points |
| HIGH | -10 points |
| MEDIUM | -5 points |
| LOW | -2 points |

### Score Interpretation

| Range | Meaning | Action |
|-------|---------|--------|
| 90-100 | Excellent | APPROVED — ship it |
| 80-89 | Good | APPROVED — minor notes |
| 75-79 | Acceptable | APPROVED — with suggestions |
| 60-74 | Needs work | NEEDS_CHANGES — send back for fixes |
| <60 | Major issues | BLOCKED — consider re-implementation |

---

## Refinement Loop Rules

### Maximum Iterations
- CODE REVIEWER -> IMPLEMENTER fix: max 3 retries (4 total attempts)

### Escalation
If maximum retries are exceeded, the pipeline fails with a detailed error including all review iterations and unresolved findings.

### Iteration Focus
Each fix iteration should focus ONLY on the findings raised in the previous review. The IMPLEMENTER should not introduce new features or refactor unrelated code during a fix iteration.
