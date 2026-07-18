import { describe, expect, it } from "vitest";
import {
  buildDefaultBranchRefreshCommands,
  buildRemoteRefRefreshCommands,
  buildWorktreeCreateCommands,
  isExpectedWorktreeUpstream,
} from "./gitRepoSync.js";

describe("git repo sync command plans", () => {
  it("refreshes default-branch repos with fetch, hard reset, and clean instead of pull", () => {
    const commands = buildDefaultBranchRefreshCommands("master");

    expect(commands.join("\n")).not.toContain("git pull");
    expect(commands).toEqual([
      "git fetch --prune origin master",
      "git reset --hard HEAD",
      "git clean -ffd",
      "git checkout -B master origin/master",
      "git reset --hard origin/master",
      "git clean -ffd",
    ]);
  });

  it("quotes branch names while resetting an existing worktree to its upstream", () => {
    const commands = buildRemoteRefRefreshCommands("origin/release/3.20");

    expect(commands.join("\n")).not.toContain("git pull");
    expect(commands).toEqual([
      "git fetch --prune origin 'release/3.20'",
      "git reset --hard 'origin/release/3.20'",
      "git clean -ffd",
    ]);
  });

  it("reuses an existing local branch when creating a missing worktree", () => {
    const commands = buildWorktreeCreateCommands(
      "medhok-monorepo-3.16",
      "3.16",
      "origin/medhok-monorepo-3.16",
    );

    expect(commands).toEqual([
      "git worktree prune --expire now",
      "if git show-ref --verify --quiet 'refs/heads/medhok-monorepo-3.16'; then git branch --force medhok-monorepo-3.16 origin/medhok-monorepo-3.16; git branch --set-upstream-to=origin/medhok-monorepo-3.16 medhok-monorepo-3.16; git worktree add '3.16' medhok-monorepo-3.16; else git worktree add -b medhok-monorepo-3.16 '3.16' origin/medhok-monorepo-3.16; git branch --set-upstream-to=origin/medhok-monorepo-3.16 medhok-monorepo-3.16; fi",
    ]);
  });

  it("rejects stale upstreams that do not match the versioned branch candidates", () => {
    expect(
      isExpectedWorktreeUpstream("origin/medhok-monorepo-3.18", [
        "medhok-monorepo-3.18",
        "cp-medhok-monorepo-3.18",
        "3.18",
      ]),
    ).toBe(true);
    expect(
      isExpectedWorktreeUpstream("origin/master", [
        "medhok-monorepo-3.18",
        "cp-medhok-monorepo-3.18",
        "3.18",
      ]),
    ).toBe(false);
  });
});
