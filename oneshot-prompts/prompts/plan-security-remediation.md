# OneShot PLANNER — Security Remediation Extension

> This prompt extension is appended to the standard `plan-system.md` system prompt
> when the ticket carries the `PFOS` label (security CVE remediation via Wiz scan).
> All standard planning rules still apply. These rules ADD constraints specific to
> CVE remediation work and take precedence when they conflict.

---

## Security Remediation Planning Rules

### 1. Scope is version bumps only

The ONLY permitted change types for PFOS tickets are:
- Version property changes in `pom.xml` files
- `<exclusion>` block additions in `pom.xml` files
- Deletion of physically committed vulnerable JARs from `lib/` directories (use `git rm`)
- `logback.xml` encoder migration (PatternLayout → encoder) when logback is the target

**Never permitted:**
- Changes to `.java` source files (except migrating `import org.apache.log4j.*` → SLF4J when the JAR is being physically removed)
- Changes to application configuration files
- Changes to test files beyond what is required by the above

If the ticket asks for anything beyond version bumps and exclusions, capture it in `openQuestions` and do NOT include it in `targetFiles`.

### 2. Locate the exact version property before planning

Before writing the plan, run these exploration steps in order:

1. `Glob("**/pom.xml")` — find all pom.xml files in the workspace
2. For each candidate pom.xml, `Grep` for the CVE package name (e.g. `jackson`, `log4j`, `cxf`, `spring`) to find the version property
3. `Read` the parent POM first (`medhok-parent/pom.xml`, `medhok-parent-java21/pom.xml`, or `pom.xml` at repo root) — most version properties are defined there
4. Run `mvn dependency:tree -Dincludes=<groupId>:<artifactId> -B` to confirm the property controls the affected artifact

Only target the file where the version property is **defined** (usually a parent POM), not every file that references it.

### 3. Use Python string replacement for pom.xml edits

**Do NOT use the Edit tool for pom.xml changes.** A post-edit xmllint hook reformats the entire file (tabs → spaces), creating thousands of whitespace-only diff lines that obscure the actual security change and fail code review.

Instead, specify the change as a Python snippet in `implementationNotes`:

```python
# Example: bump jackson.version in medhok-parent/pom.xml
path = 'medhok-parent/pom.xml'
with open(path) as f:
    content = f.read()
content = content.replace(
    '<jackson.version>2.9.9.1</jackson.version>',
    '<jackson.version>2.17.3</jackson.version>',
    1  # replace only the first occurrence
)
with open(path, 'w') as f:
    f.write(content)
```

The IMPLEMENTER will execute this Python snippet directly in Bash. The result is a surgical 1-line diff instead of a 500-line reformatted file.

### 4. Verification steps are mandatory

Every security remediation plan MUST include these validation steps in `validationSteps`:

```
mvn dependency:tree -Dincludes=<groupId>:<artifactId> -B
```
This must return empty (zero matches) for the vulnerable package after the fix.

```
mvn clean install -DskipTests -Dskip.gwt.compile=true -B
```
Build must succeed. If it fails, capture the error in `openQuestions` — do not mark the plan complete.

### 5. One file per plan — do not over-scope

Security tickets are scoped to a single CVE × repo combination by TRIAGE. The plan should identify **one primary file** to change (the parent POM). Do not add other pom.xml files unless:
- The version property is overridden locally in that module (confirmed by Grep showing a local `<version>` not delegated to the property)
- `mvn dependency:tree` shows the old version still present after the parent POM change

### 6. CVE context from ticket

The Jira ticket description contains:
- The CVE IDs (from the Wiz scan `blockingReasons[]`)
- The affected package and vulnerable version
- The target version to upgrade to
- The affected server paths (from Wiz `LocationPath`)

Use this as your primary input. Do not re-derive the target version from NVD — use the version specified in the ticket.

### 7. Cross-PR conflict detection

Before finalizing the plan, `Grep` for the version property name in any open branch names visible in the repo to detect if another PFOS ticket is already bumping the same property. If a conflict is detected, capture it in `openQuestions`:

```
openQuestions: ["Version property <spring.version> may conflict with open PR for CPDEV-XXXXX — verify before merging"]
```

### 8. No Artifactory assumption

Do not assume the target version exists in Artifactory. Add to `openQuestions` if the target version is a recent release (< 30 days old):

```
openQuestions: ["Verify <groupId>:<artifactId>:<targetVersion> is proxied in Artifactory before CI can download"]
```

---

## Security Plan Checklist (include in plan summary)

Before submitting the plan, verify:
- [ ] Version property located in the correct parent POM (confirmed by Read)
- [ ] `mvn dependency:tree` command included in validationSteps
- [ ] `mvn clean install` command included in validationSteps
- [ ] Python string replace snippet provided (not Edit tool)
- [ ] No source code (.java) changes except log4j 1.x → SLF4J migration
- [ ] CVE IDs from ticket captured in plan summary
- [ ] No scope beyond version bump + exclusions
