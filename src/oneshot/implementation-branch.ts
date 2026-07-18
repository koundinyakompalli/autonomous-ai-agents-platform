export function buildImplementationBranchName(
  jiraKey: string,
  runId: number,
): string {
  const normalizedKey = jiraKey.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `oneshot/${normalizedKey}-run-${runId}`;
}

function normalizeBranchToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * @deprecated Shared Epic branch execution is disabled; keep this only for
 * legacy branch detection and future redesign work.
 */
export function buildEpicImplementationBranchName(
  epicKey: string,
  targetBranchName?: string | null,
): string {
  const normalizedEpicKey = normalizeBranchToken(epicKey);
  const normalizedTargetBranch = targetBranchName
    ? normalizeBranchToken(targetBranchName)
    : "";
  return normalizedTargetBranch
    ? `oneshot/epic/${normalizedEpicKey}/${normalizedTargetBranch}`
    : `oneshot/epic/${normalizedEpicKey}`;
}

export function isSharedEpicImplementationBranchName(
  branchName?: string | null,
): boolean {
  return branchName?.startsWith("oneshot/epic/") ?? false;
}

export function buildRunImplementationBranchName(input: {
  jiraKey: string;
  runId: number;
  epicKey?: string | null;
  targetBranchName?: string | null;
}): string {
  return buildImplementationBranchName(input.jiraKey, input.runId);
}

export function resolveRunBranchName(input: {
  id: number;
  jira_key: string;
  epic_key?: string | null;
  branch_name?: string | null;
  run_branch_name?: string | null;
}): string {
  return (
    input.run_branch_name ??
    buildRunImplementationBranchName({
      jiraKey: input.jira_key,
      runId: input.id,
      epicKey: input.epic_key,
      targetBranchName: input.branch_name,
    })
  );
}

export function resolveRunBranchBaseSha(input: {
  base_commit_sha: string;
  run_branch_base_sha?: string | null;
}): string {
  return input.run_branch_base_sha ?? input.base_commit_sha;
}
