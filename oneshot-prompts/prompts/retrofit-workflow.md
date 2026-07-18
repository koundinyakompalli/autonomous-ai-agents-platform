# OneShot Retrofit Workflow Fragment

Use this workflow whenever the ticket, qualification, plan, implementation metadata, or revision context marks the run as a retrofit.

## Canonical Contract

- Use the selected source commits and source patch evidence as the authority for what must move to the target branch.
- Do not semantically rediscover, recreate, or substitute a different Jira fix when source commits are available.
- Classify every selected source SHA exactly once in the source commit proof ledger.
- Accepted terminal statuses are only `already_applied`, `clean_applied`, `adapted`, or `excluded` with durable rationale.
- `failed`, `conflicted`, missing status, and missing proof are not acceptable terminal proof states.
- If a source patch conflicts, adapt only the provided source patch and explain the target-branch difference.
- If adaptation needs extra target files, those files must appear in `fileChangeContract` with rationale and source-patch mapping.
- Deterministic code gates remain authoritative. Do not argue around file-scope, plan-contract, patch-equivalence, or source-proof validation.

## Planner Responsibilities

- Identify selected source commits from the source Jira key, source branch, and target branch.
- Prefer non-merge commits first, use merge commits only as fallback, and ignore obvious revert commits unless they are the only relevant evidence.
- Compare selected source commits against the target branch before planning code changes.
- Populate `plannerDiscoveries.retrofitEvidence` with source Jira key, source branch, target branch, selected commits, touched files, already-applied status, and evidence summary.
- Populate `plannerDiscoveries.retrofitExecutionContract` with version `retrofit_execution_contract.v1`.
- If the source PR URL is unknown, omit `sourcePrUrl`; never emit an empty string or whitespace placeholder.
- The execution contract must list every selected source SHA exactly once, oldest-to-newest, and map each source commit to target files, adaptation files, or an explicit exclusion rationale.
- Adaptation files are allowed only when they cite source SHA, source Jira, or concrete source file evidence in `fileChangeContract.supportingEvidence`, `allowedChanges`, or rationale.
- Mark `commitSelectionMethod` as `source_pr`, `commit_pr_expansion`, or `subject_grep_only`; when evidence came from a complete source PR, set `sourceCommitSelectionComplete=true`.
- Use `verification_only` only when every selected source patch is already present or patch-equivalent on the target branch.
- Seed `fileChangeContract` from source touched files plus explicitly justified target/adaptation files.

## Validate / Plan Review Responsibilities

- Reject retrofit plans that omit selected source SHAs or source touched files.
- Reject retrofit plans that omit `plannerDiscoveries.retrofitExecutionContract`.
- Reject retrofit plans that do not map source files to target/adaptation files when direct paths differ.
- Reject adaptation files that lack editable `fileChangeContract` entries and rationale.
- Reject adaptation files that rely only on generic rationale and do not cite source SHA, source Jira, or source file evidence.
- Reject plans that ignore patch-conflict or proof-regression context.
- Reject plans that treat `failed` or `conflicted` source commits as acceptable terminal proof.

## Implementer Responsibilities

- Apply clean source patches mechanically when the platform has already done so or explicitly tells you they are clean.
- For conflicts, adapt only the provided source patch and conflict diagnostics.
- Stay inside the approved source/adaptation file scope unless returning a structured deviation requesting replanning.
- Emit `retrofitSourceCommitStatuses` with one entry per selected source SHA.
- Emit `retrofitAdaptationCoverage` when branch-specific adaptation maps source hunks into target files.
- Each proof entry must cite target files, adaptation files when used, proof snippets, validation evidence, and rationale when needed.

## Revision Implementer Responsibilities

- Preserve prior accepted retrofit proof across implementation revisions.
- Do not re-run source patch application against an already-adapted workspace.
- Make only the code-review or test-requested revision edits.
- If you touch a previously proven target/adaptation file, update the proof for the affected source SHA or confirm that the prior proof still exists.
- Never downgrade an accepted source SHA to `failed` solely because the source patch now conflicts on an already-adapted candidate.

## Code Review Responsibilities

- Review retrofit proof, not only generic code quality.
- Verify the final diff stays within source/adaptation scope approved by the plan.
- Verify every selected source SHA has an accepted proof status.
- Check that proof snippets correspond to actual changed files or preserved target behavior.
- Treat missing proof, off-scope adaptation, and prior proof regression as blocking findings.

## Exclusion Rules

- `excluded` is allowed only when the source commit is intentionally not applicable to the target branch.
- The rationale must name the source SHA, source behavior, target-branch condition, and why no code should be copied or adapted.
- Exclusion cannot be used as a shortcut for patch conflicts, missing evidence, or unverified implementation.
