# Build Guardrails

**Version:** 2.0.0
**Purpose:** Guidelines that the IMPLEMENTER validates before and during code implementation

---

## Overview

The IMPLEMENTER reads these guardrails during implementation to validate code changes against coding standards. Critical issues block implementation; lower severity issues are flagged in the output.

---

## Severity Levels

| Level | Action Required | Description |
|-------|-----------------|-------------|
| **CRITICAL** | Stop implementation until resolved | Security vulnerabilities, data loss risks |
| **HIGH** | Strongly recommend fixing before proceeding | Performance issues, maintainability concerns |
| **MEDIUM** | Recommend addressing | Best practices, code quality |
| **LOW** | Informational | Style suggestions, minor improvements |

---

## Guardrail Categories

### 0. Generated/Cache Artifact Exclusion

#### Keep Build Outputs Out Of Candidate Diffs
**Severity:** HIGH
**Description:** Build tools may create generated files, dependency caches, and reports while validation runs, but those files must not become implementation output.

**What to Check:**
- Do not intentionally create, edit, report, stage, commit, or preserve generated/cache/build artifacts as changed implementation files.
- Treat `**/.m2/repository/**`, `**/target/**`, `**/node_modules/**`, `**/.gradle/**`, `**/.cache/**`, `**/coverage/**`, and `**/.nyc_output/**` as forbidden candidate-diff paths.
- Maven local repository output is disposable scratch data even when Maven uses `-Dmaven.repo.local=.m2/repository`.
- Repo-local Maven settings such as `.m2/settings.xml` are configuration and may be used or preserved when they already belong to the repo.

---

### 1. Database Query Optimization

#### Avoid N+1 Queries
**Severity:** HIGH
**Description:** Prevent N+1 query patterns that cause performance issues.

**What to Check:**
- Loops that execute database queries
- findById() or single-record queries inside loops
- Missing JOIN operations or batch loading
- Lazy-loaded relationships accessed in loops

---

### 2. Security Best Practices

#### Ensure Security
**Severity:** CRITICAL
**Description:** Prevent common security vulnerabilities during implementation.

**What to Check:**
- SQL Injection: Use parameterized queries, avoid string concatenation
- XSS: Sanitize user input, escape output
- Authentication: Verify user permissions before operations
- Input Validation: Validate all user inputs
- Sensitive Data: No passwords, API keys, or secrets in code

---

### 3. Performance Considerations

#### Ensure Performance
**Severity:** HIGH
**Description:** Maintain application performance standards.

**What to Check:**
- Efficient Algorithms: No O(n^2) or worse when better options exist
- Resource Management: Proper closing of connections, streams, files
- Caching: Consider caching for expensive operations
- Pagination: Large result sets should be paginated
- Indexing: Database queries should use indexed columns

---

### 4. Backward Compatibility

#### Maintain Backward Compatibility
**Severity:** HIGH
**Description:** Ensure changes don't break existing functionality.

**What to Check:**
- API Changes: No removal of public methods or endpoints
- Database Schema: Use migrations, don't drop columns directly
- Configuration: Provide defaults for new config properties
- Deprecation: Use @Deprecated before removal

---

### 5. Feature Toggle Implementation

#### Include Toggle Switch
**Severity:** MEDIUM
**Description:** All new features must have a toggle for safe rollout.

**What to Check:**
- Toggle Presence: New features should have a system variable toggle
- Toggle Location: Use application.properties or system config
- Default State: Specify default value (usually OFF for new features)
- Toggle Check: Code should check toggle before executing feature logic

---

### 6. Error Handling

#### Proper Exception Handling
**Severity:** MEDIUM
**Description:** Ensure robust error handling in implemented code.

**What to Check:**
- Catch Specific Exceptions: Avoid catching generic Exception
- Meaningful Messages: Include context in exception messages
- No Swallowing: Don't catch without handling or rethrowing
- Resource Cleanup: Use try-with-resources or finally blocks
- Logging: Log errors with appropriate level and context

---

### 7. Code Quality

#### Maintain Code Quality
**Severity:** MEDIUM
**Description:** Follow coding standards and best practices.

**What to Check:**
- DRY: Don't Repeat Yourself - extract common code
- Single Responsibility: Methods/classes should do one thing
- Naming: Use clear, descriptive names
- Magic Numbers: Use constants for repeated values
- Comments: Code should be self-documenting; comment "why" not "what"

---

### 8. Test Coverage Requirements

#### Ensure Test Coverage
**Severity:** MEDIUM
**Description:** New and modified code should have appropriate test coverage.

**Coverage Expectations:**

| Code Type | Minimum Coverage |
|-----------|-----------------|
| Business Logic | 80% |
| Utility Methods | 90% |
| Controllers/APIs | 70% (integration tests) |
| Data Access | 60% |

---

### 9. Logging Standards

#### Follow Logging Best Practices
**Severity:** MEDIUM
**Description:** Implement consistent, useful logging throughout the codebase.

**What to Check:**
- Structured Logging: Use key-value pairs for searchability
- Appropriate Levels: Use correct log levels (DEBUG/INFO/WARN/ERROR)
- No Sensitive Data: Never log passwords, tokens, PII, or PHI
- Context: Include enough context to understand the log entry

#### Block PHI/PII Logging
**Severity:** CRITICAL
**Description:** PHI/PII in logs, exception text, audit-free traces, or outbound diagnostic payloads is a release blocker.

**What to Check:**
- Do not log questionnaire answers, patient/member identifiers, claim payloads, tokens, or credentials at any level.
- When routing healthcare data across service boundaries, inspect existing logger/audit calls on that path before adding fields.
- Prefer opaque IDs, counts, statuses, and debug-safe booleans over raw healthcare payload values.

---

### 10. Null Safety

#### Implement Null Safety
**Severity:** MEDIUM
**Description:** Prevent NullPointerExceptions through proper null handling.

**What to Check:**
- Null Checks: Validate parameters before use
- Optional Usage: Use Optional for methods that may not return a value
- Default Values: Provide sensible defaults where appropriate
- Early Returns: Fail fast with clear error messages

---

### 11. Thread Safety

#### Ensure Thread Safety
**Severity:** HIGH
**Description:** Prevent race conditions and ensure thread-safe operations.

**What to Check:**
- Shared Mutable State: Properly synchronized or use immutable objects
- Thread-Safe Collections: Use ConcurrentHashMap, CopyOnWriteArrayList, etc.
- Atomic Operations: Use AtomicInteger, AtomicReference for counters/references
- Synchronization: Use synchronized blocks/methods where needed

---

### 12. TDD Compliance

#### Follow TDD Cycle
**Severity:** HIGH
**Description:** Implementation must follow Test-Driven Development.

**What to Check:**
- Test Written Before Implementation: Test file committed before source
- Test Fails First: Red phase verified before green phase
- Minimum Code: Only write code needed to pass the test
- All Tests Pass: Build succeeds after each task
- Regular Commits: Commit after each complete TDD cycle
