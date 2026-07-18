import { describe, expect, it, vi } from "vitest";
import {
  createJiraStory,
  postTriageAnalysisComment,
  postTriageSummaryComment,
} from "./jira-writer.js";
import type { JiraClient } from "../JiraClient.js";
import type { TriagePathDisposition, TriageStory } from "./types.js";

function story(overrides: Partial<TriageStory> = {}): TriageStory {
  return {
    source: "sonar",
    title: "[SonarQube] java:S1234 — module — repo",
    description: "body",
    team: "A",
    severity: "Critical",
    slaTier: "P3",
    cveIds: ["AYx1"],
    findingKeys: ["AYx1"],
    ruleIds: ["java:S1234"],
    issueTypes: ["CODE_SMELL"],
    packageName: "java:S1234",
    targetVersion: "fix SonarQube rule violation",
    repoName: "cp-medhok-monorepo",
    applicationRoot: "module-a",
    pathDisposition: "active-code-managed",
    whereToUpdate: "• src/main/java/Foo.java",
    findingCount: 1,
    assetCount: 1,
    isPfos: false,
    ...overrides,
  };
}

const emptySuppressed: Record<TriagePathDisposition | "non-maven", number> = {
  "active-code-managed": 0,
  "backup-archive": 0,
  "runtime-tooling": 0,
  "third-party-runtime": 0,
  "infra-os": 0,
  "needs-review": 0,
  "non-maven": 0,
};

function fakeJira(
  overrides: Partial<Record<keyof JiraClient, unknown>> = {},
): JiraClient & {
  addComment: ReturnType<typeof vi.fn>;
  attachFileToIssue: ReturnType<typeof vi.fn>;
  createIssue: ReturnType<typeof vi.fn>;
} {
  return {
    addComment: vi.fn().mockResolvedValue({ id: "1" }),
    attachFileToIssue: vi.fn().mockResolvedValue({ status: "attached" }),
    createIssue: vi.fn().mockResolvedValue({
      key: "CPDEV-101",
      summary: "TRIAGE story",
    }),
    ...overrides,
  } as unknown as JiraClient & {
    addComment: ReturnType<typeof vi.fn>;
    attachFileToIssue: ReturnType<typeof vi.fn>;
    createIssue: ReturnType<typeof vi.fn>;
  };
}

describe("createJiraStory Team A queue approval", () => {
  it("creates Log4j Team A stories in OneShot format without PFOS when queueing is blocked", async () => {
    const createIssue = vi.fn().mockResolvedValue({
      key: "CPDEV-101",
      summary: "Log4j remediation",
    });
    const jira = {
      createIssue,
    } as unknown as JiraClient;

    await createJiraStory(
      jira,
      "CPDEV-1",
      story({
        source: "wiz",
        title: "[Security] log4j",
        team: "A",
        packageName: "log4j",
        targetVersion: "2.3.2 or later",
        repoName: "cp-batch-monorepo",
        repoFullName: "mhk-repos/cp-batch-monorepo",
        repoProjectPath: "CaseUpdateBatchProcessor",
        repoDefaultBranch: "master",
        repoConfidence: "high",
        repoEvidence: ["Catalog project matched runtime project"],
        applicationRoot: "/opt/software/medhok",
        isPfos: false,
        queueForOneShot: false,
        queueBlockedReason:
          "Log4j 1.x migration requires explicit approval before OneShot queueing",
      }),
    );

    expect(createIssue).toHaveBeenCalledTimes(1);
    const payload = createIssue.mock.calls[0][0];
    expect(payload.labels).toContain("TEAM-A");
    expect(payload.labels).toContain("ONESHOT-APPROVAL-REQUIRED");
    expect(payload.labels).not.toContain("PFOS");
    expect(payload.description).toContain("Summary\n");
    expect(payload.description).toContain("Acceptance Criteria\n");
    expect(payload.description).toContain("Technical Details\n");
    expect(payload.description).toContain("Repo: cp-batch-monorepo");
    expect(payload.description).toContain(
      "Project path: CaseUpdateBatchProcessor",
    );
    expect(payload.description).toContain(
      "OneShot queue status: not auto-queued",
    );
  });

  it("creates provisional Log4j Team A stories for repo confirmation without an explicit Repo directive", async () => {
    const createIssue = vi.fn().mockResolvedValue({
      key: "CPDEV-102",
      summary: "Log4j remediation",
    });
    const jira = {
      createIssue,
    } as unknown as JiraClient;

    await createJiraStory(
      jira,
      "CPDEV-1",
      story({
        source: "wiz",
        title: "[Security] log4j",
        team: "A",
        packageName: "log4j",
        targetVersion: "2.3.2 or later",
        repoName: "",
        repoConfidence: "none",
        applicationRoot: "/opt/software/medhok",
        whereToUpdate:
          "Affected paths (sample):\n  - /opt/software/medhok/case_monitor/lib/log4j-1.2.13.jar",
        isPfos: true,
        queueForOneShot: true,
      }),
    );

    expect(createIssue).toHaveBeenCalledTimes(1);
    const payload = createIssue.mock.calls[0][0];
    expect(payload.labels).toContain("PFOS");
    expect(payload.labels).toContain("REPO-MAPPING-NEEDED");
    expect(payload.description).toContain(
      "Repo mapping: needs confirmation before implementation",
    );
    expect(payload.description).toContain("Repo mapping confidence: none");
    expect(payload.description).not.toContain("Repo: repo-mapping-needed");
    expect(payload.description).not.toContain("Repo: \n");
  });

  it("creates Wiz Code (SAST) stories with PFOS + WIZ-CODE labels and the SAST body", async () => {
    const createIssue = vi.fn().mockResolvedValue({
      key: "CPDEV-201",
      summary: "Wiz Code remediation",
    });
    const jira = { createIssue } as unknown as JiraClient;

    const sastDescription = [
      "Summary",
      "Fix CWE-89 (SQL Injection via Unsanitized User Input in Java) in ProviderPortal — cp-provider-portal.",
      "",
      "Technical Details",
      "Source: Wiz Code Analysis (SAST)",
      "Repo: cp-provider-portal",
      "Branch: master",
      "Weakness (CWE): CWE-89",
      "Language: JAVA",
    ].join("\n");

    await createJiraStory(
      jira,
      "CPDEV-1",
      story({
        source: "wiz-code",
        title: "[Wiz Code] CWE-89 — ProviderPortal — cp-provider-portal",
        description: sastDescription,
        team: "A",
        packageName: "CWE-89",
        ruleIds: ["CWE-89"],
        issueTypes: ["VULNERABILITY"],
        repoName: "cp-provider-portal",
        applicationRoot: "ProviderPortal",
        // Pushed into OneShot via PFOS, same as CVE stories.
        isPfos: true,
        queueForOneShot: true,
      }),
    );

    expect(createIssue).toHaveBeenCalledTimes(1);
    const payload = createIssue.mock.calls[0][0];

    // PFOS pushes into OneShot; WIZ-CODE / SAST keep the source visible.
    expect(payload.labels).toContain("WIZ-CODE");
    expect(payload.labels).toContain("SAST");
    expect(payload.labels).toContain("PFOS");
    expect(payload.labels).not.toContain("ONESHOT-APPROVAL-REQUIRED");

    // Uses the engine-built SAST body, NOT the Wiz dependency-CVE body.
    expect(payload.description).toContain("Source: Wiz Code Analysis (SAST)");
    expect(payload.description).toContain("Weakness (CWE): CWE-89");
    expect(payload.description).toContain("Branch: master");
    expect(payload.description).not.toContain("Target version");
    expect(payload.description).not.toContain("mvn dependency:tree");
  });

  it("does not emit dependency-upgrade acceptance criteria for a mis-routed CWE code weakness (CPDEV-26167 regression)", async () => {
    const createIssue = vi.fn().mockResolvedValue({
      key: "CPDEV-26167",
      summary: "CWE-89 CMOffline",
    });
    const jira = fakeJira({ createIssue });

    // Reproduces the CPDEV-26167 shape: a Wiz Code (SAST) CWE-89 finding that
    // fell through to the dependency ("wiz") path — CWE id stuffed into the
    // package field, a non-version targetVersion, Team A. It must NOT produce
    // the contradictory "upgrade pom.xml / no .java changes" criteria.
    await createJiraStory(
      jira,
      "CPDEV-26139",
      story({
        source: "wiz",
        title: "[Wiz Code] CWE-89 — CMOffline — cp-provider-portal",
        description: "body",
        team: "A",
        packageName: "CWE-89",
        targetVersion: "fix code weakness (no dependency change)",
        repoName: "cp-provider-portal",
        applicationRoot: "CMOffline",
        isPfos: true,
      }),
    );

    expect(createIssue).toHaveBeenCalledTimes(1);
    const description: string = createIssue.mock.calls[0][0].description;

    // The self-contradictory dependency-bump criteria must be gone.
    expect(description).not.toContain("All affected pom.xml files upgraded");
    expect(description).not.toContain("No source code (.java) files changed");
    expect(description).not.toContain("mvn dependency:tree -Dincludes");

    // Code-level (SAST) criteria are used instead.
    expect(description).toContain("remediated at the code level");
    expect(description).toContain("mvn -pl <module> -am -B test");

    // Guard against the CMOffline regression: the criteria must steer the
    // implementer away from validating a whole compound identifier token as a
    // single identifier (which rejected legitimate "table alias" values and
    // silently broke the feature).
    expect(description).toContain(
      "NEVER validate a whole compound token as one identifier",
    );
    expect(description).toContain("decompose compound tokens");
  });

  it("caps oversized child story descriptions and attaches the full detail", async () => {
    const jira = fakeJira({
      createIssue: vi.fn().mockResolvedValue({
        key: "CPDEV-103",
        summary: "Oversized Log4j remediation",
      }),
    });
    const largeWhereToUpdate = Array.from(
      { length: 1800 },
      (_, i) =>
        `- /opt/software/medhok/service-${i}/lib/log4j-1.2.14.jar -> META-INF/maven/log4j/log4j`,
    ).join("\n");

    await createJiraStory(
      jira,
      "CPDEV-1",
      story({
        source: "wiz",
        title: "[Security] log4j oversized",
        team: "A",
        packageName: "log4j",
        targetVersion: "2.3.2 or later",
        repoName: "cp-batch-monorepo",
        repoFullName: "mhk-repos/cp-batch-monorepo",
        repoProjectPath: "batch-service",
        repoDefaultBranch: "master",
        repoConfidence: "high",
        applicationRoot: "/opt/software/medhok",
        whereToUpdate: largeWhereToUpdate,
        findingCount: 1800,
        assetCount: 1800,
        isPfos: true,
      }),
    );

    expect(jira.createIssue).toHaveBeenCalledTimes(1);
    const payload = jira.createIssue.mock.calls[0][0];
    expect(payload.description.length).toBeLessThanOrEqual(30000);
    expect(payload.description).toContain(
      "Full TRIAGE detail exceeded Jira's description limit",
    );
    expect(payload.description).not.toContain("is attached as");

    expect(jira.attachFileToIssue).toHaveBeenCalledTimes(1);
    const [issueKey, filename, content, contentType] =
      jira.attachFileToIssue.mock.calls[0];
    expect(issueKey).toBe("CPDEV-103");
    expect(filename).toBe("TRIAGE-story-detail-CPDEV-1-log4j.md");
    expect(contentType).toBe("text/markdown");
    expect(content.length).toBeGreaterThan(30000);

    expect(jira.addComment).toHaveBeenCalledTimes(1);
    const [, comment] = jira.addComment.mock.calls[0];
    expect(comment).toContain(
      "attached as TRIAGE-story-detail-CPDEV-1-log4j.md",
    );
  });

  it("does not claim an oversized child story attachment landed when Jira mutations are disabled", async () => {
    const jira = fakeJira({
      attachFileToIssue: vi.fn().mockResolvedValue({
        status: "skipped",
        reason: "mutations_disabled",
      }),
      createIssue: vi.fn().mockResolvedValue({
        key: "CPDEV-104",
        summary: "Oversized Log4j remediation",
      }),
    });
    const largeWhereToUpdate = Array.from(
      { length: 1800 },
      (_, i) =>
        `- /opt/software/medhok/service-${i}/lib/log4j-1.2.14.jar -> META-INF/maven/log4j/log4j`,
    ).join("\n");

    await createJiraStory(
      jira,
      "CPDEV-1",
      story({
        source: "wiz",
        title: "[Security] log4j oversized",
        team: "A",
        packageName: "log4j",
        targetVersion: "2.3.2 or later",
        repoName: "cp-batch-monorepo",
        repoFullName: "mhk-repos/cp-batch-monorepo",
        repoProjectPath: "batch-service",
        repoDefaultBranch: "master",
        repoConfidence: "high",
        applicationRoot: "/opt/software/medhok",
        whereToUpdate: largeWhereToUpdate,
        findingCount: 1800,
        assetCount: 1800,
        isPfos: true,
      }),
    );

    const payload = jira.createIssue.mock.calls[0][0];
    expect(payload.description).not.toContain("is attached as");
    expect(jira.attachFileToIssue).toHaveBeenCalledTimes(1);
    expect(jira.addComment).toHaveBeenCalledTimes(1);
    const [, comment] = jira.addComment.mock.calls[0];
    expect(comment).toContain(
      "was not attached because Jira mutations are disabled",
    );
    expect(comment).not.toContain("is attached as");
  });
});

function analysisSummary(reviewNeeded: TriageStory[]) {
  return {
    source: "sonar",
    totalRows: 10000,
    uniqueFindings: 9769,
    teamAStories: [] as TriageStory[],
    teamBCDStories: [] as TriageStory[],
    backupCleanupStories: [] as TriageStory[],
    reviewNeededStories: reviewNeeded,
    suppressedByDisposition: emptySuppressed,
    needsReviewFindings: reviewNeeded.length,
    dryRun: false,
  };
}

describe("postTriageAnalysisComment overflow handling", () => {
  it("posts a single inline comment when the report fits", async () => {
    const jira = fakeJira();

    await postTriageAnalysisComment(
      jira,
      "CPDEV-1",
      analysisSummary([story()]),
    );

    expect(jira.attachFileToIssue).not.toHaveBeenCalled();
    expect(jira.addComment).toHaveBeenCalledTimes(1);
    const [, body] = jira.addComment.mock.calls[0];
    expect(body).toContain("[TRIAGE] Analysis complete: SONAR");
    expect(body).toContain("Team A candidates for human review:");
  });

  it("attaches the full report and posts a pointer comment when oversized", async () => {
    const jira = fakeJira();
    // 2,000 grouped candidates blows past the 30k-char comment limit.
    const many = Array.from({ length: 2000 }, (_, i) =>
      story({ title: `[SonarQube] java:S${i} — module-${i} — repo` }),
    );

    await postTriageAnalysisComment(jira, "CPDEV-2", analysisSummary(many));

    expect(jira.attachFileToIssue).toHaveBeenCalledTimes(1);
    const [issueKey, filename, content, contentType] =
      jira.attachFileToIssue.mock.calls[0];
    expect(issueKey).toBe("CPDEV-2");
    expect(filename).toBe("TRIAGE-analysis-SONAR-CPDEV-2.md");
    expect(contentType).toBe("text/markdown");
    expect(content.length).toBeGreaterThan(30000);

    expect(jira.addComment).toHaveBeenCalledTimes(1);
    const [, body] = jira.addComment.mock.calls[0];
    expect(body).toContain("is attached as TRIAGE-analysis-SONAR-CPDEV-2.md");
    // Pointer comment is small enough to inline.
    expect(body.length).toBeLessThanOrEqual(30000);
  });

  it("falls back to a header-only comment when the attachment upload fails", async () => {
    const jira = fakeJira({
      attachFileToIssue: vi.fn().mockRejectedValue(new Error("upload boom")),
    });
    const many = Array.from({ length: 2000 }, (_, i) =>
      story({ title: `[SonarQube] java:S${i} — module-${i} — repo` }),
    );

    await postTriageAnalysisComment(jira, "CPDEV-3", analysisSummary(many));

    expect(jira.attachFileToIssue).toHaveBeenCalledTimes(1);
    expect(jira.addComment).toHaveBeenCalledTimes(1);
    const [, body] = jira.addComment.mock.calls[0];
    expect(body).toContain("Full breakdown could not be attached");
    // Must NOT claim it was attached.
    expect(body).not.toContain("is attached as");
  });

  it("does not claim the overflow report attached when Jira mutations are disabled", async () => {
    const jira = fakeJira({
      attachFileToIssue: vi.fn().mockResolvedValue({
        status: "skipped",
        reason: "mutations_disabled",
      }),
    });
    const many = Array.from({ length: 2000 }, (_, i) =>
      story({ title: `[SonarQube] java:S${i} — module-${i} — repo` }),
    );

    await postTriageAnalysisComment(jira, "CPDEV-7", analysisSummary(many));

    expect(jira.attachFileToIssue).toHaveBeenCalledTimes(1);
    expect(jira.addComment).toHaveBeenCalledTimes(1);
    const [, body] = jira.addComment.mock.calls[0];
    expect(body).toContain(
      "was not attached because Jira mutations are disabled",
    );
    expect(body).not.toContain("is attached as");
  });

  it("reports the attachment as successful when only the pointer comment fails", async () => {
    // Upload succeeds; the follow-up comment throws. The breadcrumb must still
    // reflect that the file landed (no inaccurate 'could not be attached').
    const jira = fakeJira({
      addComment: vi.fn().mockRejectedValue(new Error("comment boom")),
    });
    const many = Array.from({ length: 2000 }, (_, i) =>
      story({ title: `[SonarQube] java:S${i} — module-${i} — repo` }),
    );

    await expect(
      postTriageAnalysisComment(jira, "CPDEV-4", analysisSummary(many)),
    ).rejects.toThrow("comment boom");

    expect(jira.attachFileToIssue).toHaveBeenCalledTimes(1);
    const [, body] = jira.addComment.mock.calls[0];
    expect(body).toContain("is attached as TRIAGE-analysis-SONAR-CPDEV-4.md");
  });
});

describe("postTriageSummaryComment overflow handling", () => {
  it("posts inline when the created-key list fits", async () => {
    const jira = fakeJira();

    await postTriageSummaryComment(jira, "CPDEV-5", {
      source: "sonar",
      totalRows: 100,
      uniqueFindings: 90,
      teamAStories: ["CPDEV-100", "CPDEV-101"],
      teamBCDStories: [],
      backupCleanupStories: [],
      reviewNeededStories: [],
      skippedNonMaven: 0,
      dryRun: false,
    });

    expect(jira.attachFileToIssue).not.toHaveBeenCalled();
    expect(jira.addComment).toHaveBeenCalledTimes(1);
    const [, body] = jira.addComment.mock.calls[0];
    expect(body).toContain("CPDEV-100");
  });

  it("attaches when thousands of created keys overflow the comment", async () => {
    const jira = fakeJira();
    const keys = Array.from({ length: 5000 }, (_, i) => `CPDEV-${i}`);

    await postTriageSummaryComment(jira, "CPDEV-6", {
      source: "sonar",
      totalRows: 100000,
      uniqueFindings: 90000,
      teamAStories: keys,
      teamBCDStories: [],
      backupCleanupStories: [],
      reviewNeededStories: [],
      skippedNonMaven: 0,
      dryRun: false,
    });

    expect(jira.attachFileToIssue).toHaveBeenCalledTimes(1);
    const [, filename] = jira.attachFileToIssue.mock.calls[0];
    expect(filename).toBe("TRIAGE-summary-SONAR-CPDEV-6.md");
    expect(jira.addComment).toHaveBeenCalledTimes(1);
  });
});
