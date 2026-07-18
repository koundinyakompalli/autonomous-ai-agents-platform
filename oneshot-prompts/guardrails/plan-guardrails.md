# Plan Guardrails

**Version:** 2.0.0
**Purpose:** Guidelines that the PLANNER validates before finalizing implementation plans

---

## Overview

The PLANNER reads these guardrails during implementation planning to validate proposed code changes before the plan is finalized. Critical issues block the plan; lower severity issues are included as recommendations.

**Domain Extensions:**
- Healthcare projects: Also load `healthcare-rules.md`

---

## Severity Levels

| Level | Action Required | Description |
|-------|-----------------|-------------|
| **CRITICAL** | Block plan until resolved | Security vulnerabilities, compliance violations, data integrity risks |
| **HIGH** | Address before implementation | Performance issues, missing safety checks, architectural concerns |
| **MEDIUM** | Recommend fixing | Best practices, maintainability, code quality |
| **LOW** | Informational | Style suggestions, minor optimizations |

### Plan Readiness

| Severity Mix | Plan Status |
|--------------|-------------|
| Any CRITICAL | NOT READY - Must revise plan |
| HIGH only | CONDITIONAL - Address in implementation |
| MEDIUM/LOW only | READY - Proceed with recommendations |
| No issues | READY - Clean plan |

---

## Guardrail Categories

### 0. Repo-Local Guidance Files

#### Treat Project Guidance As Advisory
**Severity:** LOW
**Description:** `.clinerules`, `CLAUDE.md`, and `.claude` markdown files can describe useful project conventions, but they are not hard OneShot gates.

**What to Check:**
- Use guidance files as style, testing, and navigation hints when they align with inspected code.
- Do not block or reject a plan solely because guidance is missing, stale, incomplete, or in tension with stronger evidence.
- Ticket acceptance criteria, deterministic grounding, security/compliance guardrails, and directly inspected code evidence take precedence.

### 0.5. Generated/Cache Artifact Exclusion

#### Exclude Build Outputs From Candidate Diffs
**Severity:** HIGH
**Description:** Generated files, dependency caches, and build outputs are allowed to exist while tools run, but they must never be planned as implementation candidate files.

**What to Check:**
- Do not include generated/cache/build output paths in `targetFiles`, `targetFileRationales`, evidence files, planned test targets, or implementation notes.
- Treat `**/.m2/repository/**`, `**/target/**`, `**/node_modules/**`, `**/.gradle/**`, `**/.cache/**`, `**/coverage/**`, and `**/.nyc_output/**` as forbidden candidate-diff paths.
- Maven may create local repository output during validation; that output is disposable scratch data, not source code or test code.
- Repo-local Maven settings such as `.m2/settings.xml` are configuration and may be referenced when relevant.

### 1. Database Query Optimization

#### Avoid N+1 Queries in Planned Code
**Severity:** HIGH
**Description:** Detect N+1 query patterns in proposed code changes.

**What to Check:**
- Loops that will execute database queries
- `findById()` or single-record queries inside loops
- Missing `JOIN` operations or batch loading
- Lazy-loaded relationships accessed in loops

---

### 2. Security Best Practices

#### Validate Security in Planned Changes
**Severity:** CRITICAL
**Description:** Ensure planned code follows security best practices.

**What to Check:**
- SQL Injection: Plans should use parameterized queries
- XSS: Plans should sanitize user input
- Authentication: Plans should include permission checks
- Input Validation: Plans should validate user inputs
- Secrets: Plans should not hardcode credentials
- PHI/PII Logging: For healthcare data flows, plans must identify logger/audit call sites on the touched path and explicitly avoid raw PHI/PII in logs or errors

---

### 3. Feature Toggle Requirement

#### New Features Must Include Toggles
**Severity:** MEDIUM
**Description:** All new features in plans must include a feature toggle for safe rollout.

**What to Check:**
- New endpoints should have toggle configuration
- New business logic should be behind a feature flag
- Default state should be OFF for new features

---

### 4. Backward Compatibility

#### Plans Must Maintain Compatibility
**Severity:** HIGH
**Description:** Validate that planned changes don't break existing functionality.

**What to Check:**
- No removal of public methods without deprecation
- Database schema changes use migrations
- API changes maintain backward compatibility
- Configuration changes provide defaults

---

### 5. Performance Considerations

#### Validate Performance in Plans
**Severity:** HIGH
**Description:** Ensure planned code won't cause performance issues.

**What to Check:**
- No O(n^2) algorithms when O(n) exists
- Large result sets should use pagination
- Resource-intensive operations should consider caching
- Database queries should use indexed columns

---

### 6. Error Handling

#### Plans Must Include Proper Error Handling
**Severity:** MEDIUM
**Description:** Validate that planned code handles errors appropriately.

**What to Check:**
- Specific exception handling (not generic Exception)
- Meaningful error messages with context
- No swallowed exceptions
- Resource cleanup in finally blocks

---

### 7. Code Quality

#### Validate Code Quality in Plans
**Severity:** LOW
**Description:** Ensure planned code follows quality standards.

**What to Check:**
- DRY principle (no duplicate code blocks)
- Single responsibility (methods do one thing)
- Clear naming conventions
- Constants instead of magic numbers

---

### 8. Testing Requirements

#### Unit Test Coverage
**Severity:** MEDIUM
**Description:** Plans must include appropriate test coverage.

**What to Check:**
- New public methods should have corresponding unit tests planned
- New API endpoints should have integration tests planned
- Edge cases and error scenarios should be covered
- Minimum 80% line coverage target for new code
- PAS/CDS/FHIR `processBundle` tests should prefer existing fixtures/builders. If building bundles programmatically, explicitly include required resources such as `Patient` and `Coverage` whenever the service path resolves member/coverage details from the bundle.

---

### 9. Dependency Security

#### Vulnerable Dependency Check
**Severity:** CRITICAL
**Description:** Flag dependencies with known security vulnerabilities.

**What to Check:**
- New dependencies against CVE databases
- Outdated dependencies with known vulnerabilities
- Transitive dependencies with security issues

---

### 10. Concurrency and Thread Safety

#### Thread-Safe Patterns
**Severity:** HIGH
**Description:** Validate that planned code handles concurrency safely.

**What to Check:**
- Shared mutable state without synchronization
- Race conditions (check-then-act patterns)
- Improper use of non-thread-safe collections
- Missing volatile keywords for shared variables

---

### 11. Cross-Service Impact Analysis

#### Contract Changes
**Severity:** HIGH
**Description:** Identify changes that affect other services or consumers.

**What to Check:**
- API contract changes (request/response structure)
- Event schema changes
- Database schema changes affecting shared tables
- Shared library changes

---

## Plan Quality Score

### Scoring Formula

```
Base Score = 100

Deductions:
- Each CRITICAL issue: -25 points
- Each HIGH issue: -10 points
- Each MEDIUM issue: -5 points
- Each LOW issue: -2 points
- Missing test plan: -10 points

Final Score = max(0, Base Score - Deductions)
```

### Grade Scale

| Score | Grade | Status |
|-------|-------|--------|
| 90-100 | A | Ready to implement |
| 80-89 | B | Minor improvements suggested |
| 70-79 | C | Address recommendations |
| 60-69 | D | Significant revisions needed |
| <60 | F | Must revise plan |
