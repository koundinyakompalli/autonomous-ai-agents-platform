import { describe, expect, it } from "vitest";
import {
  buildImplementationBranchName,
  buildRunImplementationBranchName,
  resolveRunBranchName,
} from "./implementation-branch.js";

describe("OneShot implementation branch naming", () => {
  it("keeps the legacy per-run branch for non-Epic runs", () => {
    expect(buildImplementationBranchName("CPDEV-20686", 84)).toBe(
      "oneshot/cpdev-20686-run-84",
    );
    expect(
      buildRunImplementationBranchName({
        jiraKey: "CPDEV-20686",
        runId: 84,
        targetBranchName: "master",
      }),
    ).toBe("oneshot/cpdev-20686-run-84");
  });

  it("uses the per-run branch even when an Epic key is present", () => {
    expect(
      buildRunImplementationBranchName({
        jiraKey: "CPDEV-20686",
        runId: 84,
        epicKey: "CPDEV-20000",
        targetBranchName: "master",
      }),
    ).toBe("oneshot/cpdev-20686-run-84");
  });

  it("honors a persisted run branch name before deriving a fallback", () => {
    expect(
      resolveRunBranchName({
        id: 84,
        jira_key: "CPDEV-20686",
        epic_key: "CPDEV-20000",
        branch_name: "master",
        run_branch_name: "oneshot/custom-branch",
      }),
    ).toBe("oneshot/custom-branch");
  });
});
