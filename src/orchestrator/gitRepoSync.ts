function quoteGitArg(value: string): string {
  if (/^(?:origin\/)?[A-Za-z0-9._-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function remoteBranchFromRef(remoteRef: string): string {
  if (!remoteRef.startsWith("origin/")) {
    throw new Error(`Only origin remote refs are supported: ${remoteRef}`);
  }
  return remoteRef.slice("origin/".length);
}

export function buildDefaultBranchRefreshCommands(
  defaultBranch: string,
): string[] {
  const branch = quoteGitArg(defaultBranch);
  const remoteRef = quoteGitArg(`origin/${defaultBranch}`);
  return [
    `git fetch --prune origin ${branch}`,
    "git reset --hard HEAD",
    "git clean -ffd",
    `git checkout -B ${branch} ${remoteRef}`,
    `git reset --hard ${remoteRef}`,
    "git clean -ffd",
  ];
}

export function buildRemoteRefRefreshCommands(remoteRef: string): string[] {
  const remoteBranch = quoteGitArg(remoteBranchFromRef(remoteRef));
  const quotedRemoteRef = quoteGitArg(remoteRef);
  return [
    `git fetch --prune origin ${remoteBranch}`,
    `git reset --hard ${quotedRemoteRef}`,
    "git clean -ffd",
  ];
}

export function buildWorktreeCreateCommands(
  localBranch: string,
  worktreePath: string,
  remoteRef: string,
): string[] {
  const branch = quoteGitArg(localBranch);
  const ref = quoteShellArg(`refs/heads/${localBranch}`);
  const quotedWorktreePath = quoteShellArg(worktreePath);
  const quotedRemoteRef = quoteGitArg(remoteRef);

  return [
    "git worktree prune --expire now",
    `if git show-ref --verify --quiet ${ref}; then git branch --force ${branch} ${quotedRemoteRef}; git branch --set-upstream-to=${quotedRemoteRef} ${branch}; git worktree add ${quotedWorktreePath} ${branch}; else git worktree add -b ${branch} ${quotedWorktreePath} ${quotedRemoteRef}; git branch --set-upstream-to=${quotedRemoteRef} ${branch}; fi`,
  ];
}

export function isExpectedWorktreeUpstream(
  upstream: string,
  branchCandidates: string[],
): boolean {
  return branchCandidates.some((candidate) => upstream === `origin/${candidate}`);
}
