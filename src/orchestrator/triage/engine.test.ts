import { afterEach, describe, expect, it, vi } from "vitest";

const uploadTaskDescriptionMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    bucket: "specter-tasks",
    key: "tasks/mock.md",
  }),
);
const generateTaskDescriptionMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue("generated task description"),
);

vi.mock("../storage.js", () => ({
  getStorage: () => ({
    uploadTaskDescription: uploadTaskDescriptionMock,
  }),
}));

vi.mock("../TaskDescriptionGenerator.js", () => ({
  TaskDescriptionGenerator: vi.fn().mockImplementation(function () {
    return {
      generateTaskDescription: generateTaskDescriptionMock,
    };
  }),
}));

import {
  resolveRelatedCodeForStory,
  runTriage,
  shouldQueueLog4j1ForOneShot,
} from "./engine.js";
import type { JiraClient } from "../JiraClient.js";
import type { Database } from "../database.js";
import type { TriageStory } from "./types.js";

const SONAR_CSV = [
  "Key,Type,Severity,Status,Message,Component,Line,Rule,Author,Created Date,Project",
  [
    "issue-1",
    "CODE_SMELL",
    "CRITICAL",
    "OPEN",
    '"Define a constant instead of duplicating this literal."',
    "medhok-web-services/src/main/java/com/medhok/mm/Foo.java",
    "10",
    "java:S1192",
    "",
    "2026-05-11",
    "cp-medhok-monorepo",
  ].join(","),
].join("\n");

function csvResponse(): Response {
  // downloadAttachmentStream returns a fetch Response; the parser reads body.
  return new Response(SONAR_CSV);
}

const SONAR_HUMAN_REVIEW_CSV = [
  "Key,Type,Severity,Status,Message,Component,Line,Rule,Author,Created Date,Project",
  [
    "issue-1",
    "VULNERABILITY",
    "CRITICAL",
    "OPEN",
    '"Enable server certificate validation."',
    "medhok-web-services/src/main/java/com/medhok/mm/Tls.java",
    "10",
    "java:S4830",
    "",
    "2026-05-11",
    "cp-medhok-monorepo",
  ].join(","),
  [
    "issue-2",
    "BUG",
    "BLOCKER",
    "OPEN",
    '"Fix transactional self invocation."',
    "MedicalMgmt/src/main/java/com/medhok/mm/RcaService.java",
    "22",
    "java:S2229",
    "",
    "2026-05-11",
    "cp-medhok-monorepo",
  ].join(","),
].join("\n");

const SONAR_APPLY_CSV = [
  "Key,Type,Severity,Status,Message,Component,Line,Rule,Author,Created Date,Project",
  [
    "issue-apply-1",
    "VULNERABILITY",
    "CRITICAL",
    "OPEN",
    '"Fix command injection risk."',
    "module-a/src/main/java/com/medhok/A.java",
    "10",
    "java:S2076",
    "",
    "2026-05-11",
    "cp-medhok-monorepo",
  ].join(","),
  [
    "issue-apply-2",
    "VULNERABILITY",
    "CRITICAL",
    "OPEN",
    '"Fix SSRF risk."',
    "module-b/src/main/java/com/medhok/B.java",
    "20",
    "java:S5144",
    "",
    "2026-05-11",
    "cp-medhok-monorepo",
  ].join(","),
].join("\n");

const APPLY_TITLE_ONE =
  "[SonarQube] java:S2076 — module-a — core-app (Epic: CPDEV-9999)";
const APPLY_TITLE_TWO =
  "[SonarQube] java:S5144 — module-b — core-app (Epic: CPDEV-9999)";

function fakeEpic() {
  return {
    key: "CPDEV-9999",
    fields: {
      summary: "SonarQube Critical/Blocker issues",
      attachment: [
        {
          id: "att-1",
          filename: "sonarqube_cp-medhok-monorepo.csv",
          mimeType: "text/csv",
        },
      ],
    },
  };
}

// A Wiz Code (SAST) export attached under a GENERIC filename, so the source can
// only be determined by header sniffing at runtime (not by filename).
const WIZ_CODE_CSV = [
  "name,resource.name,filePath,startLine,severity,origin,codeLibraryLanguage,weaknesses,status",
  [
    "SQL Injection via Unsanitized User Input in Java",
    "mhk-repos/cp-provider-portal/master",
    "ProviderPortal/src/main/java/com/medhok/providerPortal/service/GetCareTeam.java",
    "87",
    "HIGH",
    "WIZ",
    '"[""JAVA""]"',
    '"[{""id"":""CWE-89""}]"',
    "OPEN",
  ].join(","),
].join("\n");

function fakeGenericFilenameEpic() {
  return {
    key: "CPDEV-9999",
    fields: {
      summary: "Wiz Code SAST scan",
      attachment: [
        {
          id: "att-1",
          filename: "Report_Jul_10_2026.csv",
          mimeType: "text/csv",
        },
      ],
    },
  };
}

// A Wiz Code (SAST) export attached under a "wiz"-family filename. The
// filename-only detector returns "wiz" (dependency) for anything starting with
// wiz/all_cp_vuln/mhk, so without header sniffing on the "wiz" branch this SAST
// scan would be force-parsed as a dependency CVE (CPDEV-26167 root cause).
function fakeWizNamedSastEpic() {
  return {
    key: "CPDEV-9999",
    fields: {
      summary: "Wiz scan (SAST content, wiz-family filename)",
      attachment: [
        {
          id: "att-1",
          filename: "wiz_findings_2026_07_10.csv",
          mimeType: "text/csv",
        },
      ],
    },
  };
}

function fakeChildIssue(key: string) {
  return {
    key,
    fields: {
      summary: key,
      description: "child description",
      attachment: [],
      labels: [],
    },
  };
}

function fakeApplyDb(overrides: Partial<Record<keyof Database, unknown>> = {}) {
  const query = vi.fn().mockResolvedValue([[{ id: 1 }]]);
  return {
    getAgentByName: vi.fn().mockResolvedValue({ id: 11, name: "QUALIFIER" }),
    getPool: vi.fn().mockReturnValue({ query }),
    createTaskManagement: vi.fn().mockResolvedValue(101),
    upsertOneShotArtifactRun: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Database & {
    createTaskManagement: ReturnType<typeof vi.fn>;
    upsertOneShotArtifactRun: ReturnType<typeof vi.fn>;
  };
}

describe("runTriage analyze path — comment failures are non-fatal", () => {
  afterEach(() => {
    uploadTaskDescriptionMock.mockClear();
    generateTaskDescriptionMock.mockClear();
  });

  it("advances the label and records the artifact run even when the comment fails", async () => {
    const updateIssueLabels = vi.fn().mockResolvedValue(undefined);
    const upsertOneShotArtifactRun = vi.fn().mockResolvedValue(undefined);

    const jira = {
      fetchIssue: vi.fn().mockResolvedValue(fakeEpic()),
      downloadAttachmentStream: vi.fn().mockResolvedValue(csvResponse()),
      // Simulate Jira rejecting the analysis comment (e.g. CONTENT_LIMIT_EXCEEDED).
      addComment: vi
        .fn()
        .mockRejectedValue(
          new Error("400 Bad Request - CONTENT_LIMIT_EXCEEDED"),
        ),
      attachFileToIssue: vi.fn().mockResolvedValue(undefined),
      updateIssueLabels,
    } as unknown as JiraClient;

    const db = {
      upsertOneShotArtifactRun,
    } as unknown as Database;

    const result = await runTriage(jira, db, {
      epicKey: "CPDEV-9999",
      mode: "analyze",
      dryRun: false,
      force: false,
      sourceOverride: "sonar",
    });

    // The run completed instead of throwing.
    expect(result.mode).toBe("analyze");
    expect(result.source).toBe("sonar");

    // Label advanced PENDING -> REVIEW-READY despite the comment failure.
    expect(updateIssueLabels).toHaveBeenCalledWith("CPDEV-9999", {
      remove: ["SONAR-SCAN-PENDING"],
      add: ["SONAR-SCAN-REVIEW-READY"],
    });

    // Dashboard artifact run still recorded.
    expect(upsertOneShotArtifactRun).toHaveBeenCalledTimes(1);
    expect(upsertOneShotArtifactRun.mock.calls[0][0]).toMatchObject({
      sourceKey: "CPDEV-9999",
      status: "review_ready",
    });
  });

  it("routes a generically-named Wiz Code CSV via header sniffing (not the Wiz dep parser)", async () => {
    const updateIssueLabels = vi.fn().mockResolvedValue(undefined);
    const jira = {
      fetchIssue: vi.fn().mockResolvedValue(fakeGenericFilenameEpic()),
      downloadAttachmentStream: vi
        .fn()
        .mockResolvedValue(new Response(WIZ_CODE_CSV)),
      addComment: vi.fn().mockResolvedValue(undefined),
      attachFileToIssue: vi.fn().mockResolvedValue(undefined),
      updateIssueLabels,
    } as unknown as JiraClient;

    const db = {
      upsertOneShotArtifactRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as Database;

    // No sourceOverride: the source must be discovered from the header, and the
    // Wiz dependency parser (which needs a Name column) must NOT be used.
    const result = await runTriage(jira, db, {
      epicKey: "CPDEV-9999",
      mode: "analyze",
      dryRun: true,
      force: false,
    });

    expect(result.source).toBe("wiz-code");
    expect(result.teamAStoryCandidates).toBeGreaterThan(0);
  });

  it("routes a wiz-family-named CSV with a SAST header to wiz-code, not the Wiz dep parser (CPDEV-26167 regression)", async () => {
    const jira = {
      fetchIssue: vi.fn().mockResolvedValue(fakeWizNamedSastEpic()),
      downloadAttachmentStream: vi
        .fn()
        .mockResolvedValue(new Response(WIZ_CODE_CSV)),
      addComment: vi.fn().mockResolvedValue(undefined),
      attachFileToIssue: vi.fn().mockResolvedValue(undefined),
      updateIssueLabels: vi.fn().mockResolvedValue(undefined),
    } as unknown as JiraClient;

    const db = {
      upsertOneShotArtifactRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as Database;

    // Filename "wiz_findings_*.csv" resolves to "wiz" by name, but the header is
    // SAST. Header sniffing on the wiz branch must promote it to wiz-code so it
    // is not parsed as a dependency CVE (which corrupts the story into CWE-in-
    // package-field + contradictory dependency-bump acceptance criteria).
    const result = await runTriage(jira, db, {
      epicKey: "CPDEV-9999",
      mode: "analyze",
      dryRun: true,
      force: false,
    });

    expect(result.source).toBe("wiz-code");
    expect(result.teamAStoryCandidates).toBeGreaterThan(0);
  });

  it("records the artifact run with mode 'wiz_sast', not 'sonar', so the dashboard does not mislabel SAST scans as SonarQube", async () => {
    const upsertOneShotArtifactRun = vi.fn().mockResolvedValue(undefined);
    const jira = {
      fetchIssue: vi.fn().mockResolvedValue(fakeGenericFilenameEpic()),
      downloadAttachmentStream: vi
        .fn()
        .mockResolvedValue(new Response(WIZ_CODE_CSV)),
      addComment: vi.fn().mockResolvedValue(undefined),
      attachFileToIssue: vi.fn().mockResolvedValue(undefined),
      updateIssueLabels: vi.fn().mockResolvedValue(undefined),
    } as unknown as JiraClient;

    const db = {
      upsertOneShotArtifactRun,
    } as unknown as Database;

    // analyze (non-dry) so the artifact run is recorded to the dashboard.
    const result = await runTriage(jira, db, {
      epicKey: "CPDEV-9999",
      mode: "analyze",
      dryRun: false,
      force: false,
    });

    expect(result.source).toBe("wiz-code");
    expect(upsertOneShotArtifactRun).toHaveBeenCalledTimes(1);
    // Wiz Code reuses the Sonar pipeline internally but MUST surface as its own
    // dashboard mode — reverting artifactModeForSource to "sonar" fails here.
    expect(upsertOneShotArtifactRun.mock.calls[0][0]).toMatchObject({
      sourceKey: "CPDEV-9999",
      mode: "wiz_sast",
    });
  });

  it("holds high-risk Sonar TLS and transaction rules for human review", async () => {
    const jira = {
      fetchIssue: vi.fn().mockResolvedValue(fakeEpic()),
      downloadAttachmentStream: vi
        .fn()
        .mockResolvedValue(new Response(SONAR_HUMAN_REVIEW_CSV)),
      addComment: vi.fn().mockResolvedValue(undefined),
      attachFileToIssue: vi.fn().mockResolvedValue(undefined),
      updateIssueLabels: vi.fn().mockResolvedValue(undefined),
    } as unknown as JiraClient;

    const db = {
      upsertOneShotArtifactRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as Database;

    const result = await runTriage(jira, db, {
      epicKey: "CPDEV-9999",
      mode: "analyze",
      dryRun: true,
      force: false,
      sourceOverride: "sonar",
    });

    expect(result.source).toBe("sonar");
    expect(result.teamAStoryCandidates).toBe(0);
    expect(result.reviewNeededStoryCandidates).toBeGreaterThan(0);
    expect(result.needsReviewFindings).toBe(2);
  });
});

describe("runTriage apply path — resume and partial failure", () => {
  afterEach(() => {
    uploadTaskDescriptionMock.mockClear();
    generateTaskDescriptionMock.mockClear();
  });

  it("reuses existing child stories and only creates missing candidates", async () => {
    const createIssue = vi.fn().mockImplementation((payload) =>
      Promise.resolve({
        key: "CPDEV-NEW",
        summary: payload.summary,
      }),
    );
    const jira = {
      fetchIssue: vi
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(
            key === "CPDEV-9999" ? fakeEpic() : fakeChildIssue(key),
          ),
        ),
      downloadAttachmentStream: vi
        .fn()
        .mockResolvedValue(new Response(SONAR_APPLY_CSV)),
      searchIssues: vi.fn().mockResolvedValue({
        total: 1,
        issues: [
          {
            key: "CPDEV-EXISTING",
            fields: { summary: APPLY_TITLE_ONE, labels: ["SONAR-AUTOFIX"] },
          },
        ],
      }),
      createIssue,
      addComment: vi.fn().mockResolvedValue(undefined),
      attachFileToIssue: vi.fn().mockResolvedValue(undefined),
      updateIssueLabels: vi.fn().mockResolvedValue(undefined),
    } as unknown as JiraClient;
    const db = fakeApplyDb();

    const result = await runTriage(jira, db, {
      epicKey: "CPDEV-9999",
      mode: "apply",
      dryRun: false,
      force: false,
      sourceOverride: "sonar",
    });

    expect(result.teamAStories).toEqual(["CPDEV-EXISTING", "CPDEV-NEW"]);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue.mock.calls[0][0].summary).toBe(APPLY_TITLE_TWO);
    expect(db.createTaskManagement).toHaveBeenCalledTimes(2);

    const artifact = db.upsertOneShotArtifactRun.mock.calls[0][0];
    expect(artifact.generatedTickets).toEqual([
      expect.objectContaining({
        key: "CPDEV-EXISTING",
        title: APPLY_TITLE_ONE,
        status: "reused",
      }),
      expect.objectContaining({
        key: "CPDEV-NEW",
        title: APPLY_TITLE_TWO,
        status: "created",
      }),
    ]);
    expect(artifact.jiraSummary).toContain("2 ticket(s) created/reused");
  });

  it("continues apply when one child create fails", async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValueOnce(new Error("description too long"))
      .mockImplementation((payload) =>
        Promise.resolve({
          key: "CPDEV-OK",
          summary: payload.summary,
        }),
      );
    const jira = {
      fetchIssue: vi
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(
            key === "CPDEV-9999" ? fakeEpic() : fakeChildIssue(key),
          ),
        ),
      downloadAttachmentStream: vi
        .fn()
        .mockResolvedValue(new Response(SONAR_APPLY_CSV)),
      searchIssues: vi.fn().mockResolvedValue({ total: 0, issues: [] }),
      createIssue,
      addComment: vi.fn().mockResolvedValue(undefined),
      attachFileToIssue: vi.fn().mockResolvedValue(undefined),
      updateIssueLabels: vi.fn().mockResolvedValue(undefined),
    } as unknown as JiraClient;
    const db = fakeApplyDb();

    const result = await runTriage(jira, db, {
      epicKey: "CPDEV-9999",
      mode: "apply",
      dryRun: false,
      force: false,
      sourceOverride: "sonar",
    });

    expect(createIssue).toHaveBeenCalledTimes(2);
    expect(result.teamAStories).toEqual(["CPDEV-OK"]);
    expect(result.reviewNeededStories).toHaveLength(1);
    expect(result.reviewNeededStories[0]).toContain(APPLY_TITLE_ONE);
    expect(result.reviewNeededStories[0]).toContain("description too long");
    expect(db.createTaskManagement).toHaveBeenCalledTimes(1);

    const artifact = db.upsertOneShotArtifactRun.mock.calls[0][0];
    expect(artifact.generatedTickets).toHaveLength(1);
    expect(artifact.evidence.storyFailures).toBe(1);
    expect(artifact.jiraSummary).toContain("1 failed");
  });
});

describe("resolveRelatedCodeForStory", () => {
  it("maps a high-confidence GitHub catalog repo slug to the registered OneShot repo id", async () => {
    const db = {
      getAllRepositories: vi.fn().mockResolvedValue([
        {
          id: 7,
          repo_name: "batch-jobs",
          repo_url: "https://github.com/mhk-repos/cp-batch-monorepo.git",
          description: "",
          default_branch: "master",
        },
      ]),
      upsertCodeRepository: vi.fn(),
    } as unknown as Pick<
      Database,
      "getAllRepositories" | "upsertCodeRepository"
    >;

    const story = {
      team: "A",
      repoName: "cp-batch-monorepo",
      repoFullName: "mhk-repos/cp-batch-monorepo",
      repoConfidence: "high",
    } as TriageStory;

    await expect(resolveRelatedCodeForStory(db, story)).resolves.toBe("7");
  });

  it("registers high-confidence catalog repos that are not yet in code_repositories", async () => {
    const db = {
      getAllRepositories: vi.fn().mockResolvedValue([]),
      upsertCodeRepository: vi.fn().mockResolvedValue({
        id: 42,
        repo_name: "cp-medhok-data-import-monorepo",
        repo_url:
          "https://github.com/mhk-repos/cp-medhok-data-import-monorepo.git",
      }),
    } as unknown as Pick<
      Database,
      "getAllRepositories" | "upsertCodeRepository"
    >;

    const story = {
      team: "A",
      repoName: "cp-medhok-data-import-monorepo",
      repoFullName: "mhk-repos/cp-medhok-data-import-monorepo",
      repoProjectPath: "document-loader",
      repoDefaultBranch: "master",
      repoConfidence: "high",
    } as TriageStory;

    await expect(resolveRelatedCodeForStory(db, story)).resolves.toBe("42");
    expect(db.upsertCodeRepository).toHaveBeenCalledWith({
      repoName: "cp-medhok-data-import-monorepo",
      repoUrl:
        "https://github.com/mhk-repos/cp-medhok-data-import-monorepo.git",
      description:
        "Discovered by TRIAGE GitHub project catalog for project document-loader security remediation",
      defaultBranch: "master",
    });
  });

  it("leaves related_code empty for medium-confidence mappings", async () => {
    const db = {
      getAllRepositories: vi.fn(),
    } as unknown as Pick<Database, "getAllRepositories">;

    const story = {
      team: "A",
      repoName: "cp-batch-monorepo",
      repoConfidence: "medium",
    } as TriageStory;

    await expect(resolveRelatedCodeForStory(db, story)).resolves.toBe("");
    expect(db.getAllRepositories).not.toHaveBeenCalled();
  });

  it("leaves related_code empty when a Team A story requires queue approval", async () => {
    const db = {
      getAllRepositories: vi.fn(),
    } as unknown as Pick<Database, "getAllRepositories">;

    const story = {
      team: "A",
      repoName: "cp-batch-monorepo",
      repoFullName: "mhk-repos/cp-batch-monorepo",
      repoConfidence: "high",
      queueForOneShot: false,
      queueBlockedReason: "Log4j 1.x migration requires approval",
    } as TriageStory;

    await expect(resolveRelatedCodeForStory(db, story)).resolves.toBe("");
    expect(db.getAllRepositories).not.toHaveBeenCalled();
  });
});

describe("shouldQueueLog4j1ForOneShot", () => {
  const originalFlag = process.env.TRIAGE_LOG4J1_ONESHOT_QUEUE_ENABLED;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.TRIAGE_LOG4J1_ONESHOT_QUEUE_ENABLED;
    } else {
      process.env.TRIAGE_LOG4J1_ONESHOT_QUEUE_ENABLED = originalFlag;
    }
  });

  it("queues Log4j 1.x stories by default", () => {
    delete process.env.TRIAGE_LOG4J1_ONESHOT_QUEUE_ENABLED;

    expect(shouldQueueLog4j1ForOneShot()).toBe(true);
  });

  it("holds Log4j 1.x stories only when explicitly disabled", () => {
    process.env.TRIAGE_LOG4J1_ONESHOT_QUEUE_ENABLED = "false";

    expect(shouldQueueLog4j1ForOneShot()).toBe(false);
  });
});
