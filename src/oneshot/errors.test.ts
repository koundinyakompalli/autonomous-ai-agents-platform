import { describe, expect, it } from "vitest";
import {
  classifyError,
  classifyHandoffError,
  isHandoffRetryableError,
} from "./errors.js";

const RUN_380_WORKFLOW_TIMEOUT =
  "Command failed: git push --force-with-lease=\"refs/heads/oneshot/cpdev-23753-run-380:\" \"https://x-access-token:secret@github.com/mhk-repos/cp-medhok-monorepo.git\" \"46e7d6f3015719fe1254c0ca8626d0c154ec9fd0:refs/heads/oneshot/cpdev-23753-run-380\"\n" +
  "To https://github.com/mhk-repos/cp-medhok-monorepo.git\n" +
  " ! [remote rejected]         46e7d6f3015719fe1254c0ca8626d0c154ec9fd0 -> oneshot/cpdev-23753-run-380 (Unable to determine if workflow can be created or updated due to timeout; `workflows` scope may be required.)\n" +
  "error: failed to push some refs to 'https://github.com/mhk-repos/cp-medhok-monorepo.git'";

describe("classifyError", () => {
  it("classifies git/worktree failures as retryable git_operation errors", () => {
    const classified = classifyError(
      "git worktree add failed because index.lock already exists",
    );

    expect(classified.category).toBe("git_operation");
    expect(classified.retryable).toBe(true);
  });

  it("classifies checkout timeout sentinels as retryable workspace errors", () => {
    const classified = classifyError(
      "workspace_checkout_timeout: git worktree add failed or timed out",
    );

    expect(classified.category).toBe("workspace");
    expect(classified.retryable).toBe(true);
  });

  it("treats GitHub API rate limiting as retryable github_api errors", () => {
    const classified = classifyError(
      "GitHub API rate limit exceeded while creating pull request",
    );

    expect(classified.category).toBe("github_api");
    expect(classified.retryable).toBe(true);
  });

  it("classifies local SDK planner timeouts as OneShot agent logic instead of provider outage", () => {
    const classified = classifyError(
      "SDK_IDLE_TIMEOUT: no stream event for 120000ms, toolCalls=0, output=0",
    );

    expect(classified.category).toBe("agent_logic");
    expect(classified.retryable).toBe(true);
  });

  it("does not classify unrelated budget substrings as budget errors", () => {
    const classified = classifyError(
      "Failed to resolve upstream budget-service endpoint",
    );

    expect(classified.category).toBe("unknown");
  });

  it("falls back to unknown when no pattern matches", () => {
    const classified = classifyError("completely novel failure mode");

    expect(classified.category).toBe("unknown");
    expect(classified.retryable).toBe(false);
  });

  it('classifies "Declared runnable test commands were skipped" as test_runner_skipped', () => {
    const classified = classifyError(
      "Declared runnable test command(s) were skipped: mvn -f MedicalMgmt/pom.xml test -Dtest=BffMedicalAppealsServiceTest",
    );

    expect(classified.category).toBe("test_runner_skipped");
    expect(classified.retryable).toBe(false);
    expect(classified.suggestion).toMatch(/declared test commands/i);
  });

  it('classifies "GitHub CI is pending" as ci_failure', () => {
    const classified = classifyError(
      "GitHub CI is pending across commit and pull request checks (0 status check(s), 6 check run(s)).",
    );

    expect(classified.category).toBe("ci_failure");
    expect(classified.retryable).toBe(false);
  });

  it('classifies "GitHub CI is failing" as ci_failure (not github_api)', () => {
    const classified = classifyError(
      "GitHub CI is failing across commit and pull request checks",
    );

    expect(classified.category).toBe("ci_failure");
  });

  it("preserves token sanitization when classifying test_runner_skipped", () => {
    const classified = classifyError(
      "Declared runnable test were skipped: Bearer abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );

    expect(classified.category).toBe("test_runner_skipped");
    expect(classified.message).toMatch(/Bearer \*\*\*/);
  });

  it('does not match "test_runner_skipped" on benign mentions of "test"', () => {
    const classified = classifyError("test suite ran successfully");

    expect(classified.category).toBe("unknown");
  });

  it('does not match "ci_failure" on unrelated CI words', () => {
    const classified = classifyError("CI/CD setup is being reviewed");

    expect(classified.category).toBe("unknown");
  });
});

describe("isHandoffRetryableError", () => {
  it("returns false for missing queue env variable errors (non-retryable config)", () => {
    expect(
      isHandoffRetryableError(
        new Error("Missing required OneShot queue environment variable: ONESHOT_PLANNING_QUEUE_URL"),
      ),
    ).toBe(false);
  });

  it("returns false for access denied errors", () => {
    expect(
      isHandoffRetryableError(new Error("access denied for SQS queue")),
    ).toBe(false);
    expect(
      isHandoffRetryableError(new Error("AccessDenied on SendMessage")),
    ).toBe(false);
  });

  it("returns false for AuthorizationError", () => {
    expect(
      isHandoffRetryableError(new Error("AuthorizationError: insufficient permissions")),
    ).toBe(false);
  });

  it("returns false for branch mismatch errors", () => {
    expect(
      isHandoffRetryableError(new Error("branch mismatch: expected main got feature/x")),
    ).toBe(false);
  });

  it("returns false for workflow-scope rejection errors", () => {
    expect(
      isHandoffRetryableError(new Error("workflow-scope rejection: ticket out of scope")),
    ).toBe(false);
  });

  it("returns true for the run-380 GitHub workflow-impact timeout", () => {
    const classified = classifyHandoffError(new Error(RUN_380_WORKFLOW_TIMEOUT));

    expect(classified.retryable).toBe(true);
    expect(classified.category).toBe("git_operation");
    expect(classified.message).toContain("x-access-token:***@github.com");
  });

  it("returns true for equivalent workflow-impact timeout wording", () => {
    expect(
      isHandoffRetryableError(
        new Error(
          "Unable to determine if workflow can be created or updated due to timeout; workflows scope may be required",
        ),
      ),
    ).toBe(true);
  });

  it("returns false for clear workflow permission failures without timeout wording", () => {
    expect(
      isHandoffRetryableError(
        new Error("GitHub workflow-scope permission denied for branch creation"),
      ),
    ).toBe(false);
  });

  it("returns true for network timeout errors (retryable SQS)", () => {
    expect(
      isHandoffRetryableError(new Error("ETIMEDOUT connecting to SQS endpoint")),
    ).toBe(true);
  });

  it("returns true for ECONNRESET errors", () => {
    expect(
      isHandoffRetryableError(new Error("ECONNRESET during SQS send")),
    ).toBe(true);
  });

  it("returns true for SQS throttling exceptions", () => {
    expect(
      isHandoffRetryableError(new Error("ThrottlingException: Rate exceeded for SQS")),
    ).toBe(true);
  });

  it("returns true for workspace lease timeout errors", () => {
    expect(
      isHandoffRetryableError(
        new Error("Timed out acquiring OneShot workspace lease repo-cache: /repos/my-repo"),
      ),
    ).toBe(true);
  });

  it("returns true for git operation errors (retryable)", () => {
    expect(
      isHandoffRetryableError(new Error("git clone failed: connection reset")),
    ).toBe(true);
  });
});
