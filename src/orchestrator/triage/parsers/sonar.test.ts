import { describe, expect, it } from "vitest";
import { isSonarCsv, parseSonarCsv } from "./sonar.js";

describe("parseSonarCsv", () => {
  it("parses open SonarQube issues and skips closed issues", () => {
    const csv = [
      "Key,Type,Severity,Status,Message,Component,Line,Rule,Author,Created Date,Project",
      [
        "issue-1",
        "VULNERABILITY",
        "BLOCKER",
        "OPEN",
        '"Disable access to external entities in XML parsing."',
        "medhok-web-services/src/main/java/com/medhok/mm/ws/util/AppUtils.java",
        "674",
        "java:S2755",
        "",
        "2026-05-11",
        "cp-medhok-monorepo",
      ].join(","),
      [
        "issue-2",
        "CODE_SMELL",
        "CRITICAL",
        "CLOSED",
        '"Define a constant instead of duplicating this literal."',
        "MedicalMgmt/src/main/java/com/medhok/mm/shared/utils/ConstantVars.java",
        "327",
        "java:S1192",
        "",
        "2026-05-11",
        "cp-medhok-monorepo",
      ].join(","),
    ].join("\n");

    expect(isSonarCsv(csv)).toBe(true);

    const parsed = parseSonarCsv(csv);

    expect(parsed.totalRows).toBe(2);
    expect(parsed.skippedRows).toBe(1);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      source: "sonar",
      findingKey: "issue-1",
      issueType: "VULNERABILITY",
      severity: "Blocker",
      ruleId: "java:S2755",
      component:
        "medhok-web-services/src/main/java/com/medhok/mm/ws/util/AppUtils.java",
      line: "674",
      detectionMethod: "SonarQube",
      hasExploit: false,
    });
  });

  it("does not detect a generic issue CSV as SonarQube without identifying headers", () => {
    const csv = [
      "Key,Type,Severity,Status,Message,Component,Rule,Project",
      "issue-1,BUG,CRITICAL,OPEN,Something happened,core,rule-1,project-a",
    ].join("\n");

    expect(isSonarCsv(csv)).toBe(false);
  });
});
