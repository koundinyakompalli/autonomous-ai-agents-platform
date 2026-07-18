import { describe, expect, it } from "vitest";
import { classifyFinding } from "./classifier.js";
import { classifyLocationPath } from "./path-disposition.js";
import type { TriageFinding } from "./types.js";

function finding(
  locationPath: string,
  overrides: Partial<TriageFinding> = {},
): TriageFinding {
  const profile = classifyLocationPath(locationPath);
  return {
    source: "wiz",
    cveId: "CVE-2025-30474",
    packageName: "commons-vfs2",
    packageVersion: "2.2",
    fixedVersion: "2.10.0",
    severity: "High",
    hasCisaKevExploit: false,
    hasExploit: false,
    detectionMethod: "FilePath",
    locationPath,
    locationPaths: [locationPath],
    pathBuckets: [
      {
        disposition: profile.disposition,
        count: 1,
        examples: [locationPath],
      },
    ],
    remediation: "Upgrade package",
    firstDetected: "2026-05-18",
    assetCount: 1,
    rawCount: 1,
    ...overrides,
  };
}

describe("classifyFinding", () => {
  it("suppresses backup/archive jars instead of routing them to Team A", () => {
    const result = classifyFinding(
      finding(
        "/[Partition=0ef23364]/software/correspondence-watcher-translation/lib_092424/commons-vfs2-2.2.jar",
      ),
    );

    expect(result.team).toBe("UNKNOWN");
    expect(result.pathDisposition).toBe("backup-archive");
    expect(result.shouldCreateTicket).toBe(false);
    expect(result.isPfos).toBe(false);
  });

  it("treats DNU, bkp, and bkup folders as backup/archive cleanup scope", () => {
    const result = classifyFinding(
      finding("/opt/software/medhok/DNU_flyway/bin/log4j-1.2.16.jar"),
    );

    expect(result.team).toBe("UNKNOWN");
    expect(result.pathDisposition).toBe("backup-archive");
    expect(result.shouldCreateTicket).toBe(false);

    const bkup = classifyFinding(
      finding(
        "/opt/software/medhok/auto-tasking-process_bkup20170811/auto-tasking-process-deploy_new/lib/log4j-1.2.14.jar",
      ),
    );
    expect(bkup.team).toBe("UNKNOWN");
    expect(bkup.pathDisposition).toBe("backup-archive");
    expect(bkup.shouldCreateTicket).toBe(false);
  });

  it("routes active mapped runtime library jars to Team A", () => {
    const result = classifyFinding(
      finding("/software/cms-processor/lib/commons-vfs2-2.2.jar"),
    );

    expect(result.team).toBe("A");
    expect(result.pathDisposition).toBe("active-code-managed");
    expect(result.shouldCreateTicket).toBe(true);
    expect(result.isPfos).toBe(true);
  });

  it("maps /opt/software/medhok batch app libs to the batch monorepo", () => {
    const profile = classifyLocationPath(
      "/opt/software/medhok/CaseUpdateBatchProcessor/lib/commons-vfs2-2.2.jar",
    );

    expect(profile.disposition).toBe("active-code-managed");
    expect(profile.repoName).toBe("cp-batch-monorepo");
    expect(profile.repoConfidence).toBe("high");
  });

  it("routes known /opt/software/medhok batch app jars to Team A", () => {
    const result = classifyFinding(
      finding(
        "/opt/software/medhok/CaseUpdateBatchProcessor/lib/commons-vfs2-2.2.jar",
      ),
    );

    expect(result.team).toBe("A");
    expect(result.pathDisposition).toBe("active-code-managed");
    expect(result.shouldCreateTicket).toBe(true);
    expect(result.isPfos).toBe(true);
  });

  it("routes /opt/repo project library jars to Team A when catalog mapped", () => {
    const result = classifyFinding(
      finding("/opt/repo/Hybrid/lib/commons-vfs2-2.2.jar"),
    );

    expect(result.team).toBe("A");
    expect(result.pathDisposition).toBe("active-code-managed");
    expect(result.shouldCreateTicket).toBe(true);
    expect(result.isPfos).toBe(true);
  });

  it("routes repo-mapped Log4j 1.x migrations to Team A", () => {
    const result = classifyFinding(
      finding("/software/cms-processor/lib/log4j-1.2.14.jar", {
        cveId: "CVE-2022-23305",
        packageName: "log4j",
        packageVersion: "1.2.14",
        fixedVersion: "2.3.2",
      }),
    );

    expect(result.team).toBe("A");
    expect(result.pathDisposition).toBe("active-code-managed");
    expect(result.shouldCreateTicket).toBe(true);
  });

  it("routes active Log4j 1.x migrations without repo confidence to Team A", () => {
    const result = classifyFinding(
      finding("/software/unknown-app/lib/log4j-1.2.14.jar", {
        cveId: "CVE-2022-23305",
        packageName: "log4j",
        packageVersion: "1.2.14",
        fixedVersion: "2.3.2",
      }),
    );

    expect(result.team).toBe("A");
    expect(result.pathDisposition).toBe("active-code-managed");
    expect(result.shouldCreateTicket).toBe(true);
  });

  it("routes unmapped MedHOK runtime Log4j libs to Team A for repo confirmation", () => {
    const result = classifyFinding(
      finding("/opt/software/medhok/case_monitor/lib/log4j-1.2.13.jar", {
        cveId: "CVE-2022-23305",
        packageName: "log4j",
        packageVersion: "1.2.13",
        fixedVersion: "2.3.2",
      }),
    );

    expect(result.team).toBe("A");
    expect(result.pathDisposition).toBe("active-code-managed");
    expect(result.shouldCreateTicket).toBe(true);
  });

  it("routes nested MedHOK bin Log4j libs to Team A", () => {
    const result = classifyFinding(
      finding(
        "/opt/software/medhok/dbscripts/becu-flyways/bin/log4j-1.2.16.jar",
        {
          cveId: "CVE-2022-23305",
          packageName: "log4j",
          packageVersion: "1.2.16",
          fixedVersion: "2.3.2",
        },
      ),
    );

    expect(result.team).toBe("A");
    expect(result.pathDisposition).toBe("active-code-managed");
    expect(result.shouldCreateTicket).toBe(true);
  });

  it("holds embedded Maven metadata mismatches for human review", () => {
    const path =
      "/opt/software/medhok/medhok-loader_cp/lib/activemq-all-5.6.0.jar -> META-INF/maven/log4j/log4j";
    const result = classifyFinding(
      finding(path, {
        cveId: "CVE-2022-23302",
        packageName: "activemq-all",
        packageVersion: "5.6.0",
        fixedVersion: "2.3.2",
        locationPaths: [path],
      }),
    );

    expect(result.team).toBe("UNKNOWN");
    expect(result.pathDisposition).toBe("needs-review");
    expect(result.shouldCreateTicket).toBe(false);
  });

  it("holds Spring major-version upgrades for human review", () => {
    const result = classifyFinding(
      finding("/software/CorrespondenceUtility/lib/spring-core-5.2.1.jar", {
        cveId: "End-of-Life Version of Technology",
        packageName: "spring",
        packageVersion: "5.2.1",
        fixedVersion: "6.2.17",
      }),
    );

    expect(result.team).toBe("UNKNOWN");
    expect(result.pathDisposition).toBe("needs-review");
    expect(result.shouldCreateTicket).toBe(false);
  });

  it("routes runtime tooling agents to manual platform handling", () => {
    const result = classifyFinding(
      finding("/software/xray/aws-opentelemetry-agent-1326.jar"),
    );

    expect(result.team).toBe("C");
    expect(result.pathDisposition).toBe("runtime-tooling");
    expect(result.shouldCreateTicket).toBe(true);
    expect(result.isPfos).toBe(false);
  });

  it("does not create Team A tickets for active libs without repo confidence", () => {
    const result = classifyFinding(
      finding("/software/unknown-app/lib/commons-vfs2-2.2.jar"),
    );

    expect(result.team).toBe("UNKNOWN");
    expect(result.pathDisposition).toBe("needs-review");
    expect(result.shouldCreateTicket).toBe(false);
  });

  it("does not route user workspace jars to Team A", () => {
    const result = classifyFinding(
      finding("/home/users/lchaudhari/measures/lib/log4j-1.2.16.jar"),
    );

    expect(result.team).toBe("UNKNOWN");
    expect(result.pathDisposition).toBe("needs-review");
    expect(result.shouldCreateTicket).toBe(false);
  });
});
