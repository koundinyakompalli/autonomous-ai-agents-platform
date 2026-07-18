# Plan Review Guardrails

**Version:** 2.0.0
**Purpose:** Quality gate for the PLAN REVIEWER stage

---

## Overview

The PLAN REVIEWER uses these guardrails when evaluating implementation plans. These define the quality bar for what passes plan review.

---

## Review Standards

### Objectivity
- Base evaluations on concrete evidence, not opinion
- Cite specific files, patterns when raising issues
- Acknowledge good practices alongside issues

### Completeness
- Cover all review dimensions (security, performance, correctness, etc.)
- Check every acceptance criterion against the AC Coverage mapping

### Actionability
- Every issue must include a specific suggestion for resolution
- Suggestions should be implementable without further clarification
- Reference existing patterns in the codebase when possible

---

## Plan Review Quality Gate

### Minimum Score: 80/100

Plans scoring below 80 are sent back for revision. The PLANNER receives the specific issues and addresses them in a lighter revision pass.

### Critical Blockers (automatic fail)
- Missing coverage of any acceptance criterion
- Security vulnerabilities in the design
- Breaking changes without migration strategy
- No test strategy

### High Priority (score deduction, not auto-fail)
- N+1 query patterns in proposed code
- Missing error handling strategy
- Missing backward compatibility plan
- Performance concerns not addressed

---

## SAGE Scoring Methodology

### Dimensions and Weights

| Dimension | Weight | What It Measures |
|-----------|--------|-----------------|
| Completeness | 0.25 | All acceptance criteria covered, all impacted files identified |
| Architecture | 0.20 | Changes are architecturally sound, follow existing patterns |
| Edge Cases | 0.15 | Error conditions, boundary values, and failure modes handled |
| Security | 0.15 | No vulnerabilities, input validation, no hardcoded secrets |
| Test Coverage | 0.15 | Concrete test strategy, coverage for critical paths |
| Risk Assessment | 0.10 | Risks identified, rollback considerations addressed |

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
| 90-100 | Excellent | APPROVED — proceed to implementation |
| 80-89 | Good | APPROVED — minor suggestions noted |
| 70-79 | Needs work | NEEDS_CHANGES — send back for revision |
| 60-69 | Significant issues | NEEDS_CHANGES — major revision needed |
| <60 | Major issues | BLOCKED — consider re-qualification |

---

## Refinement Loop Rules

### Maximum Iterations
- PLAN REVIEWER -> PLANNER revision: max 2 retries (3 total attempts)

### Escalation
If maximum retries are exceeded, the pipeline escalates with a detailed error including all review iterations and unresolved issues.

### Iteration Focus
Each revision should focus ONLY on the issues raised in the previous review. The PLANNER should not introduce new scope during a revision pass.
