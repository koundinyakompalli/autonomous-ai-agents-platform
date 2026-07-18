# Governance Security Scanning Checklist

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the repo-owned security scanning and disclosure gaps identified in `/Users/kkompalli/Downloads/governance-fixes.md`.

**Architecture:** Add central, additive GitHub Actions security workflows instead of changing the existing build/deploy workflows. Keep GitHub repository settings changes separate because they require admin/API action and can affect branch behavior for the team.

**Tech Stack:** GitHub Actions, CodeQL, Trivy, Checkov, Dependabot, Dependency Review, TypeScript, Python, Terraform, Docker.

---

## Verified Findings From Current Checkout

- [x] Downloaded assessment reviewed: `/Users/kkompalli/Downloads/governance-fixes.md`.
- [x] Initial branch checked: `codex/spec-factory-jira-links` contained unrelated Spec Factory commits, so the PR branch was moved to clean `codex/governance-security-scanning` from `origin/main`.
- [x] Current repo files checked: no central CodeQL workflow/config, Checkov workflow, Dependabot config, dependency-review workflow, `SECURITY.md`, or `.trivyignore` existed before this plan.
- [x] Stale assessment nuance captured: many per-service build workflows already run non-gating `npm audit` and Trivy image scans, but they do not upload SARIF and are not a central repo security control.

## Repo-Owned Fixes

- [x] Add `.github/codeql/codeql-config.yml` for TypeScript/Python scanning and repo-specific ignore paths.
- [x] Add `.github/workflows/codeql.yml` with a `javascript-typescript` and `python` matrix, `security-and-quality` queries, scheduled runs, PR runs, and SARIF upload through CodeQL.
- [x] Add `.github/workflows/security-scanning.yml` with Trivy filesystem vulnerability scanning and Checkov Terraform/Dockerfile/secrets scanning.
- [x] Upload Trivy and Checkov SARIF results using `github/codeql-action/upload-sarif@v4`.
- [x] Add `.github/workflows/dependency-review.yml` to fail PR dependency changes with critical vulnerabilities.
- [x] Add `.github/dependabot.yml` for root npm, dashboard npm, four pip requirement locations, GitHub Actions, and Docker dependency updates.
- [x] Add `.trivyignore` as the tracked accepted-risk file for future Trivy suppressions.
- [x] Add `SECURITY.md` with private-reporting guidance, supported branches, severity triage targets, and handling requirements.

## Out-of-Repo Admin Follow-Up

- [x] Live settings checked on 2026-06-23 with `gh api`: default branch is `main`; Code Security, secret scanning, push protection, Dependabot vulnerability alerts, and Dependabot security updates are enabled.
- [x] Enable GitHub Code Security / code scanning for this private repository so CodeQL, Trivy, and Checkov SARIF uploads appear in the Security tab.
- [x] Enable secret scanning and secret scanning push protection.
- [x] Enable Dependabot vulnerability alerts and Dependabot security updates.
- [ ] Add required status checks to the active default-branch ruleset after the new checks have one clean baseline run.
- [ ] Decide which checks should be required immediately versus report-only during the first baseline burn-in.
- [ ] Review the 6 current secret-scanning alerts and rotate exposed credentials if any are real active secrets.
  - 2026-06-24 disposition: GitLab token can be retired; GitHub PAT usage should move to GitHub App auth and the active PAT should be revoked/dismissed after cutover; Atlassian tokens are dedicated factory tokens, but plaintext occurrences must not remain in tracked files.
  - 2026-06-24 cleanup branch removes current plaintext Jira API tokens from `test-agent-jql.sh` and `scripts/python-automation/*`, and changes `resources/setup-repos.sh` to require a GitHub App installation token instead of PAT language.

## Verification Checklist

- [x] Re-run the governance-file presence check and confirm the previously missing files now exist.
- [x] Run Prettier over the new YAML and Markdown files.
- [x] Inspect `.trivyignore` separately because Prettier does not infer a parser for it.
- [x] Parse the new YAML files to catch syntax errors.
- [x] Verify referenced GitHub Action tags resolve, including current Trivy and Dependency Review tags.
- [x] Run `git diff --check`.
- [x] Review the final diff for scope and confirm no existing build/deploy workflows were changed.
