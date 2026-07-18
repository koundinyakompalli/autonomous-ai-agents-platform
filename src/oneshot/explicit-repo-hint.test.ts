import { describe, expect, it } from "vitest";
import type { CodeRepository } from "../orchestrator/database.js";
import { detectExplicitRepoHint } from "./explicit-repo-hint.js";

const reactRepo: CodeRepository = {
  id: 5,
  repo_name: "React-based-new-ui",
  repo_url: "https://github.com/mhk-repos/cp-mhk-smart-prominence.git",
  description: "React UI",
  default_branch: "master",
  created_at: new Date(),
} as CodeRepository;

const batchRepo: CodeRepository = {
  id: 3,
  repo_name: "batch-jobs",
  repo_url: "https://github.com/mhk-repos/cp-batch-monorepo.git",
  description: "Batch",
  default_branch: "master",
  created_at: new Date(),
} as CodeRepository;

describe("detectExplicitRepoHint", () => {
  it("detects labeled repo fields before other mentions", () => {
    const hint = detectExplicitRepoHint(
      [
        "Repo: cp-mhk-smart-prominence",
        "The implementation may touch batch jobs later.",
      ].join("\n"),
      [reactRepo, batchRepo],
    );

    expect(hint).toEqual({
      value: "cp-mhk-smart-prominence",
      source: "labeled_field",
    });
  });

  it("detects GitHub repository URLs", () => {
    const hint = detectExplicitRepoHint(
      "Please update https://github.com/mhk-repos/cp-mhk-smart-prominence for this story.",
      [reactRepo, batchRepo],
    );

    expect(hint).toEqual({
      value: "mhk-repos/cp-mhk-smart-prominence",
      source: "github_url",
    });
  });

  it("dedupes repeated GitHub repository URLs", () => {
    const hint = detectExplicitRepoHint(
      [
        "Please update https://github.com/mhk-repos/cp-mhk-smart-prominence.",
        "Context link: https://github.com/mhk-repos/cp-mhk-smart-prominence/pull/123",
      ].join("\n"),
      [reactRepo, batchRepo],
    );

    expect(hint).toEqual({
      value: "mhk-repos/cp-mhk-smart-prominence",
      source: "github_url",
    });
  });

  it("does not pick the first GitHub URL when multiple repos are linked", () => {
    const hint = detectExplicitRepoHint(
      [
        "Compare https://github.com/mhk-repos/cp-mhk-smart-prominence",
        "with https://github.com/mhk-repos/cp-batch-monorepo before deciding.",
      ].join("\n"),
      [reactRepo, batchRepo],
    );

    expect(hint).toBeNull();
  });

  it("detects owner/repo references for known owners", () => {
    const hint = detectExplicitRepoHint(
      "Target repository is mhk-repos/cp-batch-monorepo.",
      [reactRepo, batchRepo],
    );

    expect(hint).toEqual({
      value: "mhk-repos/cp-batch-monorepo",
      source: "owner_repo",
    });
  });

  it("detects exact registered repo names when one repo matches", () => {
    const hint = detectExplicitRepoHint(
      "This ticket should run against React-based-new-ui only.",
      [reactRepo, batchRepo],
    );

    expect(hint).toEqual({
      value: "React-based-new-ui",
      source: "registered_repo_name",
    });
  });

  it("does not pick a registered repo when multiple repos are explicitly mentioned", () => {
    const hint = detectExplicitRepoHint(
      "Compare React-based-new-ui and batch-jobs behavior before deciding.",
      [reactRepo, batchRepo],
    );

    expect(hint).toBeNull();
  });
});
