import { describe, it, expect } from "vitest";
import {
  isWizCodeCsv,
  parseWizCodeCsv,
  parseResourceName,
  extractPrimaryWeakness,
  extractPrimaryLanguage,
} from "./wiz-code.js";
import { isWizCsv } from "./wiz.js";
import { isSonarCsv } from "./sonar.js";
import {
  groupWizCodeStories,
  detectSourceFromFilename,
  detectSource,
} from "../engine.js";

const HEADER =
  "name,resource.name,filePath,startLine,severity,origin,codeLibraryLanguage,weaknesses,status";

const ROW_SQLI =
  'SQL Injection via Unsanitized User Input in Java,mhk-repos/cp-provider-portal/master,ProviderPortal/src/main/java/com/medhok/providerPortal/service/GetCareTeam.java,87,HIGH,WIZ,"[""JAVA""]","[{""id"":""CWE-89""}]",OPEN';

const ROW_XXE =
  'Disabling XML External Entity Attacks in Java,mhk-repos/cp-provider-portal/master,CMOffline/CMOfflineServices/src/main/java/com/medhok/cmoffline/service/GetPageData.java,132,HIGH,WIZ,"[""JAVA""]","[{""id"":""CWE-611""}]",OPEN';

const ROW_CLOSED =
  'SQL Injection,mhk-repos/cp-provider-portal/master,ProviderPortal/src/main/java/Foo.java,10,HIGH,WIZ,"[""JAVA""]","[{""id"":""CWE-89""}]",RESOLVED';

describe("isWizCodeCsv", () => {
  it("detects the Wiz Code (SAST) header", () => {
    expect(isWizCodeCsv(HEADER + "\n" + ROW_SQLI)).toBe(true);
  });

  it("does not collide with the Wiz dependency-CVE parser", () => {
    // The SAST header must NOT be mistaken for a dependency-CVE Wiz export.
    expect(isWizCsv(HEADER)).toBe(false);
  });

  it("does not collide with the SonarQube parser", () => {
    expect(isSonarCsv(HEADER)).toBe(false);
  });
});

describe("parseWizCodeCsv", () => {
  it("parses OPEN findings and maps fields", () => {
    const { findings, totalRows, skippedRows } = parseWizCodeCsv(
      [HEADER, ROW_SQLI, ROW_XXE].join("\n"),
    );
    expect(totalRows).toBe(2);
    expect(skippedRows).toBe(0);
    expect(findings).toHaveLength(2);

    const sqli = findings[0];
    expect(sqli.source).toBe("wiz-code");
    expect(sqli.issueType).toBe("VULNERABILITY");
    expect(sqli.ruleId).toBe("CWE-89");
    expect(sqli.severity).toBe("High");
    expect(sqli.line).toBe("87");
    expect(sqli.project).toBe("cp-provider-portal");
    expect(sqli.component).toContain("GetCareTeam.java");
    expect(sqli.findingKey).toContain("CWE-89");
  });

  it("filters out non-OPEN findings", () => {
    const { findings, skippedRows } = parseWizCodeCsv(
      [HEADER, ROW_CLOSED].join("\n"),
    );
    expect(findings).toHaveLength(0);
    expect(skippedRows).toBe(1);
  });
});

describe("source detection", () => {
  it("routes wiz-code / SAST filenames to wiz-code before the broad wiz prefix", () => {
    expect(detectSourceFromFilename("wiz-code-report.csv")).toBe("wiz-code");
    expect(detectSourceFromFilename("wiz_code_2026.csv")).toBe("wiz-code");
    expect(detectSourceFromFilename("Wiz Code Findings.csv")).toBe("wiz-code");
    expect(detectSourceFromFilename("cp-sast-scan.csv")).toBe("wiz-code");
  });

  it("still routes plain wiz dependency exports to wiz", () => {
    expect(detectSourceFromFilename("wiz-vulnerabilities.csv")).toBe("wiz");
    expect(detectSourceFromFilename("all_cp_vuln_2026.csv")).toBe("wiz");
  });

  it("falls back to header sniffing for generic filenames", () => {
    // A generic report name must be classified by its header, not assumed wiz.
    expect(detectSource(HEADER + "\n" + ROW_SQLI, "Report_Jul_10.csv")).toBe(
      "wiz-code",
    );
  });
});

describe("groupWizCodeStories — OneShot format", () => {
  const { findings } = parseWizCodeCsv([HEADER, ROW_SQLI, ROW_XXE].join("\n"));
  const stories = groupWizCodeStories(findings, "CPDEV-26139");

  it("routes all findings to Team A stories pushed into OneShot via PFOS", () => {
    expect(stories.length).toBeGreaterThan(0);
    for (const story of stories) {
      expect(story.team).toBe("A");
      expect(story.source).toBe("wiz-code");
      expect(story.isPfos).toBe(true);
      expect(story.queueForOneShot).toBe(true);
      expect(story.title).toContain("[Wiz Code]");
    }
  });

  it("emits the OneShot CPDEV template sections", () => {
    const desc = stories[0].description;
    expect(desc).toContain("Summary");
    expect(desc).toContain("Overview");
    expect(desc).toContain("Acceptance Criteria");
    expect(desc).toContain("Technical Details");
    expect(desc).toContain("Repo:");
    expect(desc).toContain("Branch:");
    expect(desc).toContain("Where to Update");
    expect(desc).toContain("Out of Scope");
    expect(desc).toContain("Testing Notes");
    // Must not leak the SonarQube source label into Wiz Code stories.
    expect(desc).not.toContain("Source: SonarQube");
  });

  it("splits the same CWE/module across different branches into separate stories", () => {
    // Same finding (CWE-89, GetCareTeam.java) on two branches.
    const masterRow = ROW_SQLI; // resource.name .../master
    const featureRow = ROW_SQLI.replace(
      "mhk-repos/cp-provider-portal/master",
      "mhk-repos/cp-provider-portal/feature/security-fix",
    );
    const { findings: multi } = parseWizCodeCsv(
      [HEADER, masterRow, featureRow].join("\n"),
    );
    const grouped = groupWizCodeStories(multi, "CPDEV-26139");

    // Two distinct branches → two distinct stories, not one merged story.
    expect(grouped).toHaveLength(2);

    const master = grouped.find((s) => s.repoDefaultBranch === "master");
    const feature = grouped.find(
      (s) => s.repoDefaultBranch === "feature/security-fix",
    );
    expect(master).toBeDefined();
    expect(feature).toBeDefined();

    // Each story body carries its own branch; the non-default branch is
    // surfaced in the title for disambiguation.
    expect(master!.description).toContain("Branch: master");
    expect(feature!.description).toContain("Branch: feature/security-fix");
    expect(feature!.title).toContain("feature/security-fix");
    expect(master!.title).not.toContain("feature/security-fix");
  });
});

describe("field extractors", () => {
  it("parses resource.name into repo and branch", () => {
    expect(parseResourceName("mhk-repos/cp-provider-portal/master")).toEqual({
      repoName: "cp-provider-portal",
      project: "mhk-repos/cp-provider-portal/master",
      branch: "master",
    });
  });

  it("keeps branches that contain slashes intact", () => {
    expect(
      parseResourceName("mhk-repos/cp-provider-portal/feature/security-fix"),
    ).toEqual({
      repoName: "cp-provider-portal",
      project: "mhk-repos/cp-provider-portal/feature/security-fix",
      branch: "feature/security-fix",
    });
  });

  it("handles a bare repo/branch with no org prefix", () => {
    expect(parseResourceName("cp-provider-portal/master")).toEqual({
      repoName: "cp-provider-portal",
      project: "cp-provider-portal/master",
      branch: "master",
    });
  });

  it("extracts the primary CWE weakness", () => {
    expect(extractPrimaryWeakness('[{"id":"CWE-89"}]')).toBe("CWE-89");
    expect(extractPrimaryWeakness("CWE-611")).toBe("CWE-611");
    expect(extractPrimaryWeakness("")).toBe("");
  });

  it("extracts the primary language", () => {
    expect(extractPrimaryLanguage('["JAVA"]')).toBe("JAVA");
    expect(extractPrimaryLanguage('["PHP"]')).toBe("PHP");
  });
});
