import { describe, expect, it } from "vitest";
import {
  buildReportSummary,
  detectQueuedWithoutMessage,
  findMultiRepoFeatureEnvFailures,
  findWorkspaceV2EnvFailures,
  parseArgs,
  validateExecutionMode,
  validateRequiredEnvironment,
} from "./run-cpdev-local-smoke.mjs";
import {
  inspectMavenSmokeEnvironment,
  validateMavenSettingsExpansion,
  validateMavenSmokeEnvironment,
} from "./maven-smoke-preflight.mjs";

const COMPLETE_DELIVERY_ENV = {
  JIRA_BASE_URL: "https://jira.example.test",
  JIRA_USERNAME: "jira-user",
  JIRA_TOKEN: "jira-token",
  GITHUB_REPO_TOKEN: "repo-token",
  GITHUB_WRITE_TOKEN: "write-token",
  DASHBOARD_OPERATOR_ID_HEADER: "x-operator-id",
  DASHBOARD_OPERATOR_NAME_HEADER: "x-operator-name",
  OPENAI_API_KEY: "openai-token",
  AWS_PROFILE: "local-profile",
  ARTIFACTORY_HOST: "artifactory.example.test",
  MAVEN_USER: "maven-user",
  MAVEN_PASSWORD: "maven-password",
};

describe("run-cpdev-local-smoke harness helpers", () => {
  it("defaults to preflight-only CPDEV-21980", () => {
    const args = parseArgs([]);

    expect(args.jiraKey).toBe("CPDEV-21980");
    expect(args.execute).toBe(false);
    expect(args.fullDelivery).toBe(false);
    expect(validateExecutionMode(args)).toEqual([]);
  });

  it("requires full-delivery when execute is requested", () => {
    const args = parseArgs(["--jira", "cpdev-21980", "--execute"]);

    expect(args.jiraKey).toBe("CPDEV-21980");
    expect(validateExecutionMode(args)).toEqual([
      "--execute requires --full-delivery for this CPDEV local smoke so external side effects are explicit.",
    ]);
  });

  it("accepts the explicit full-delivery smoke shape", () => {
    const args = parseArgs([
      "--jira",
      "CPDEV-21980",
      "--execute",
      "--full-delivery",
      "--timeout-minutes",
      "180",
    ]);

    expect(args.execute).toBe(true);
    expect(args.fullDelivery).toBe(true);
    expect(args.timeoutMinutes).toBe(180);
    expect(validateExecutionMode(args)).toEqual([]);
  });

  it("parses the Maven diagnostics mode and skip escape hatch", () => {
    expect(parseArgs(["--diagnose-maven-env"]).diagnoseMavenEnv).toBe(true);
    expect(parseArgs(["--jira", "CPDEV-1", "--skip-maven-preflight"]).skipMavenPreflight).toBe(true);
  });

  it("does not allow skipping Maven preflight for CPDEV-21980", () => {
    const args = parseArgs([
      "--jira",
      "CPDEV-21980",
      "--execute",
      "--full-delivery",
      "--skip-maven-preflight",
    ]);

    expect(validateExecutionMode(args)).toEqual([
      "--skip-maven-preflight is not allowed for CPDEV-21980 because it is a Maven full-delivery smoke.",
    ]);
  });

  it("fails preflight when required local delivery credentials are missing", () => {
    const args = parseArgs(["--jira", "CPDEV-21980"]);
    const result = validateRequiredEnvironment(
      {
        ONESHOT_REVIEWER_PROVIDER: "openai",
        ONESHOT_CODE_REVIEWER_PROVIDER: "openai",
      },
      args,
    );

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(
      expect.arrayContaining([
        "JIRA_BASE_URL",
        "JIRA_USERNAME",
        "JIRA_TOKEN",
        "GITHUB_REPO_TOKEN",
        "GITHUB_WRITE_TOKEN",
        "DASHBOARD_OPERATOR_ID_HEADER",
        "DASHBOARD_OPERATOR_NAME_HEADER",
        "OPENAI_API_KEY",
        "AWS_ACCESS_KEY_ID or AWS_PROFILE",
      ]),
    );
  });

  it("hard-fails full-delivery preflight when Maven env is missing", () => {
    const args = parseArgs([
      "--jira",
      "CPDEV-21980",
      "--execute",
      "--full-delivery",
    ]);
    const env = {
      ...COMPLETE_DELIVERY_ENV,
      ARTIFACTORY_HOST: "",
      MAVEN_USER: "",
      MAVEN_PASSWORD: "",
    };

    const result = validateRequiredEnvironment(env, args, {
      mavenSettingsXmlContents: [
        "<url>https://${env.ARTIFACTORY_HOST}/artifactory/libs-release</url>",
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.maven.errors).toEqual(
      expect.arrayContaining([
        "ARTIFACTORY_HOST is required for --execute --full-delivery Maven smoke runs.",
        "MAVEN_USER is required for --execute --full-delivery Maven smoke runs.",
        "MAVEN_PASSWORD is required for --execute --full-delivery Maven smoke runs.",
        "Repo-local Maven settings reference ${env.ARTIFACTORY_HOST}; without ARTIFACTORY_HOST they expand to https:///artifactory.",
      ]),
    );
  });

  it("does not require Artifactory env when Maven builds are disabled", () => {
    const args = parseArgs([
      "--jira",
      "CPDEV-21980",
      "--execute",
      "--full-delivery",
    ]);
    const env = {
      ...COMPLETE_DELIVERY_ENV,
      ONESHOT_MAVEN_BUILDS_ENABLED: "false",
      ARTIFACTORY_HOST: "",
      MAVEN_USER: "",
      MAVEN_PASSWORD: "",
    };

    const result = validateRequiredEnvironment(env, args, {
      mavenSettingsXmlContents: [
        "<url>https://${env.ARTIFACTORY_HOST}/artifactory/libs-release</url>",
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.maven).toMatchObject({
      ok: true,
      errors: [],
      warnings: [],
      skipped: true,
      skipReason: "maven_builds_disabled",
    });
    expect(result.maven.diagnostics.mavenBuildsEnabled).toBe(false);
  });

  it.each([
    "https://artifactory.example.test",
    "artifactory.example.test/artifactory",
    "artifactory.example.test/libs-release",
    " artifactory.example.test ",
  ])("rejects malformed ARTIFACTORY_HOST value %s", (host) => {
    const result = validateMavenSmokeEnvironment(
      {
        ...COMPLETE_DELIVERY_ENV,
        ARTIFACTORY_HOST: host,
      },
      { fullDelivery: true },
    );

    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("ARTIFACTORY_HOST must be host-only");
  });

  it("passes full-delivery Maven preflight with host-only Artifactory env", () => {
    const result = validateMavenSmokeEnvironment(COMPLETE_DELIVERY_ENV, {
      fullDelivery: true,
      settingsXmlContents: [
        "<url>https://${env.ARTIFACTORY_HOST}/artifactory/libs-release</url>",
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.diagnostics.ARTIFACTORY_HOST).toMatchObject({
      present: true,
      hostOnly: true,
    });
    expect(result.diagnostics.settings).toMatchObject({
      checked: 1,
      referencesArtifactoryHost: true,
    });
  });

  it("keeps Maven env as warnings outside full-delivery mode", () => {
    const result = validateRequiredEnvironment(
      {
        ...COMPLETE_DELIVERY_ENV,
        ARTIFACTORY_HOST: "",
        MAVEN_USER: "",
        MAVEN_PASSWORD: "",
      },
      parseArgs(["--jira", "CPDEV-21980"]),
    );

    expect(result.maven.ok).toBe(true);
    expect(result.maven.errors).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "ARTIFACTORY_HOST is not set; MedHOK Maven/test validation may fail during full delivery.",
        "MAVEN_USER is not set; MedHOK Maven/test validation may fail during full delivery.",
        "MAVEN_PASSWORD is not set; MedHOK Maven/test validation may fail during full delivery.",
      ]),
    );
  });

  it("does not leak Maven secret values in diagnostics or validation errors", () => {
    const result = validateMavenSmokeEnvironment(
      {
        ...COMPLETE_DELIVERY_ENV,
        ARTIFACTORY_HOST: "https://bad.example.test/artifactory",
        MAVEN_USER: "very-secret-user",
        MAVEN_PASSWORD: "very-secret-password",
      },
      { fullDelivery: true },
    );
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("very-secret-user");
    expect(serialized).not.toContain("very-secret-password");
    expect(result.diagnostics.MAVEN_USER).toEqual({ present: true });
    expect(result.diagnostics.MAVEN_PASSWORD).toEqual({ present: true });
  });

  it("detects settings that would expand to an empty Artifactory host", () => {
    expect(
      validateMavenSettingsExpansion(
        "<url>https://${env.ARTIFACTORY_HOST}/artifactory/libs-release</url>",
        { ARTIFACTORY_HOST: "" },
      ).errors,
    ).toEqual([
      "Repo-local Maven settings reference ${env.ARTIFACTORY_HOST}; without ARTIFACTORY_HOST they expand to https:///artifactory.",
    ]);
  });

  it("reports only Maven env presence and shape in diagnostics", () => {
    expect(
      inspectMavenSmokeEnvironment({
        ARTIFACTORY_HOST: "artifactory.example.test",
        MAVEN_USER: "secret-user",
        MAVEN_PASSWORD: "secret-password",
      }),
    ).toEqual({
      ARTIFACTORY_HOST: {
        present: true,
        hostOnly: true,
        malformedHostReasons: [],
      },
      MAVEN_USER: { present: true },
      MAVEN_PASSWORD: { present: true },
    });
  });

  it("detects a queued run with no matching queue pressure as stranded", () => {
    const stranded = detectQueuedWithoutMessage(
      { state: "queued_for_code_review", updated_at: "2026-06-02T00:00:00.000Z" },
      {
        code_review: { visible: 0, notVisible: 0, delayed: 0 },
      },
      { now: new Date("2026-06-02T00:20:00.000Z") },
    );

    expect(stranded).toEqual({
      stage: "code_review",
      reason:
        "Run is queued_for_code_review, but code_review queue has no visible, in-flight, or delayed messages.",
    });
  });

  it("allows a recent queued run to wait for delayed workspace setup before declaring it stranded", () => {
    expect(
      detectQueuedWithoutMessage(
        { state: "queued_for_planning", updated_at: "2026-06-02T00:08:37.000Z" },
        {
          planning: { visible: 0, notVisible: 0, delayed: 0 },
        },
        { now: new Date("2026-06-02T00:08:39.000Z") },
      ),
    ).toBeNull();
  });

  it("does not flag queued state when the target queue has a visible or in-flight message", () => {
    expect(
      detectQueuedWithoutMessage(
        { state: "queued_for_testing" },
        { testing: { visible: 1, notVisible: 0, delayed: 0 } },
      ),
    ).toBeNull();
    expect(
      detectQueuedWithoutMessage(
        { state: "queued_for_testing" },
        { testing: { visible: 0, notVisible: 1, delayed: 0 } },
      ),
    ).toBeNull();
  });

  it("summarizes delivery evidence for the final report", () => {
    const summary = buildReportSummary({
      args: { jiraKey: "CPDEV-21980" },
      jira: { jiraKey: "CPDEV-21980" },
      status: "delivery_started",
      run: {
        id: 42,
        state: "pr_open",
        workspace_mode: "v2",
        current_pr_url: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/123",
        current_implementation_branch: "oneshot/cpdev-21980-run-42",
        current_implementation_commit_sha: "abc123",
        total_tokens_used: 12345,
      },
      candidate: {
        candidate_version: 2,
        candidate_commit_sha: "abc123",
      },
      artifacts: [{ stage: "implementation" }, { stage: "test_result" }],
      events: [{ event_type: "state_transition" }],
      strandedQueue: null,
    });

    expect(summary).toMatchObject({
      jiraKey: "CPDEV-21980",
      status: "delivery_started",
      runId: 42,
      runState: "pr_open",
      workspaceMode: "v2",
      currentPrUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/123",
      candidateVersion: 2,
      candidateSha: "abc123",
      artifactCount: 2,
      eventCount: 1,
      strandedQueue: null,
    });
  });

  it("fails preflight when local worker containers are missing workspace lease settings", () => {
    const failures = findWorkspaceV2EnvFailures({
      "specter-oneshot-orchestrator": {
        ONESHOT_WORKSPACE_LEASE_TTL_SECONDS: "2700",
        ONESHOT_WORKSPACE_LEASE_HEARTBEAT_SECONDS: "30",
        ONESHOT_REPO_CACHE_FRESHNESS_TTL_MS: "300000",
      },
      "specter-oneshot-qualifier": {
        ONESHOT_WORKSPACE_LEASE_TTL_SECONDS: "0",
        ONESHOT_WORKSPACE_LEASE_HEARTBEAT_SECONDS: "30",
        ONESHOT_REPO_CACHE_FRESHNESS_TTL_MS: "300000",
      },
    });

    expect(failures).toEqual(
      expect.arrayContaining([
        "specter-oneshot-qualifier has invalid ONESHOT_WORKSPACE_LEASE_TTL_SECONDS=0",
        "specter-oneshot-planner workspace v2 env was not inspected",
      ]),
    );
  });

  it("requires the qualifier multi-repo feature flag for CPDEV-23958 full delivery", () => {
    const args = parseArgs([
      "--jira",
      "CPDEV-23958",
      "--execute",
      "--full-delivery",
    ]);

    expect(
      findMultiRepoFeatureEnvFailures(
        {
          "specter-oneshot-qualifier": {
            ONESHOT_MULTI_REPO_ENABLED: "false",
          },
        },
        args,
      ),
    ).toEqual([
      "specter-oneshot-qualifier requires ONESHOT_MULTI_REPO_ENABLED=true for CPDEV-23958 full delivery",
    ]);

    expect(
      findMultiRepoFeatureEnvFailures(
        {
          "specter-oneshot-qualifier": {
            ONESHOT_MULTI_REPO_ENABLED: "true",
          },
        },
        args,
      ),
    ).toEqual([]);
  });

  it("does not require multi-repo feature env for single-repo full delivery", () => {
    const args = parseArgs([
      "--jira",
      "CPDEV-21980",
      "--execute",
      "--full-delivery",
    ]);

    expect(findMultiRepoFeatureEnvFailures({}, args)).toEqual([]);
  });
});
