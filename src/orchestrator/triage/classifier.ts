/**
 * TRIAGE classifier — routes findings to Team A/B/C/D
 *
 * V1 scope: Team A = Maven pom.xml only.
 * pip/Gradle get PFOS-NOT-QUALIFIED until v2.
 */

import type {
  TriageFinding,
  TriagePathDisposition,
  TriageTeam,
} from "./types.js";
import { classifyLocationPath } from "./path-disposition.js";

export interface ClassificationResult {
  team: TriageTeam;
  reason: string;
  isPfos: boolean;
  pfosNotQualified: boolean;
  shouldCreateTicket: boolean;
  pathDisposition: TriagePathDisposition;
}

/** Maven package types that qualify for OneShot pipeline in v1 */
const MAVEN_DETECTION_METHODS = new Set(["Library", "FilePath"]);

/** OS/infra detection methods that are always Team C/D */
const INFRA_DETECTION_METHODS = new Set(["OS", "Package", "InstalledProgram"]);

/** Known OS-level package patterns — Team C */
const OS_PACKAGE_PATTERNS = [
  /^kernel/i,
  /^linux-kernel/i,
  /^jdk/i,
  /^jre/i,
  /^curl/i,
  /^libcurl/i,
  /^openssl/i,
  /^libssl/i,
  /^java-\d+/i,
  /^oracle.jre/i,
  /^amazon.corretto/i,
];

/** EOL OS patterns — Team B */
const EOL_OS_PATTERNS = [
  /amazon.linux.1/i,
  /windows.server.200[89]/i,
  /windows.server.2012/i,
  /centos/i,
  /fedora/i,
  /ubuntu.*12\./i,
  /ubuntu.*14\./i,
  /ubuntu.*16\./i,
  /red.hat.*6\./i,
  /red.hat.*7\./i,
];

/** Python OS packages — Team D */
const PYTHON_OS_PATTERNS = [
  /^python3/i,
  /^python-/i,
  /^libxml2-python/i,
  /^python27/i,
  /pillow/i,
  /python-pillow/i,
];

export function classifyFinding(finding: TriageFinding): ClassificationResult {
  const { detectionMethod, packageName, locationPath, cveId } = finding;
  const pathSummary = summarizePathDisposition(finding);

  // Team B — EOL OS (AMI replacement, no automated fix)
  for (const pattern of EOL_OS_PATTERNS) {
    if (pattern.test(packageName) || pattern.test(locationPath)) {
      return {
        team: "B",
        reason: `EOL OS pattern matched: ${packageName}`,
        isPfos: false,
        pfosNotQualified: false,
        shouldCreateTicket: true,
        pathDisposition: "infra-os",
      };
    }
  }

  // Team C — OS patching (kernel, JDK, curl, openssl)
  if (INFRA_DETECTION_METHODS.has(detectionMethod)) {
    for (const pattern of OS_PACKAGE_PATTERNS) {
      if (pattern.test(packageName)) {
        return {
          team: "C",
          reason: `OS package: ${packageName} (${detectionMethod})`,
          isPfos: false,
          pfosNotQualified: false,
          shouldCreateTicket: true,
          pathDisposition: "infra-os",
        };
      }
    }
    // Generic OS/infra detection method
    return {
      team: "C",
      reason: `Infrastructure scope: detectionMethod=${detectionMethod}`,
      isPfos: false,
      pfosNotQualified: false,
      shouldCreateTicket: true,
      pathDisposition: "infra-os",
    };
  }

  if (pathSummary.onlyBackupArchive) {
    return {
      team: "UNKNOWN",
      reason: "Suppressed backup/archive finding",
      isPfos: false,
      pfosNotQualified: false,
      shouldCreateTicket: false,
      pathDisposition: "backup-archive",
    };
  }

  if (pathSummary.primaryDisposition === "runtime-tooling") {
    return {
      team: "C",
      reason: "Runtime/tooling agent finding requires platform handling",
      isPfos: false,
      pfosNotQualified: false,
      shouldCreateTicket: true,
      pathDisposition: "runtime-tooling",
    };
  }

  if (pathSummary.primaryDisposition === "third-party-runtime") {
    return {
      team: "C",
      reason: "Third-party runtime/platform finding requires manual handling",
      isPfos: false,
      pfosNotQualified: false,
      shouldCreateTicket: true,
      pathDisposition: "third-party-runtime",
    };
  }

  // Team D — Python OS packages
  for (const pattern of PYTHON_OS_PATTERNS) {
    if (pattern.test(packageName)) {
      return {
        team: "D",
        reason: `Python OS package: ${packageName}`,
        isPfos: false,
        pfosNotQualified: false,
        shouldCreateTicket: true,
        pathDisposition: pathSummary.primaryDisposition,
      };
    }
  }

  // Team A candidates — Library/FilePath detection (Maven JARs)
  if (MAVEN_DETECTION_METHODS.has(detectionMethod)) {
    // Verify it's a Maven-managed JAR (has pom.xml metadata or is a .jar)
    const isMavenJar =
      locationPath.includes("META-INF/maven") ||
      locationPath.endsWith(".jar") ||
      locationPath.includes("/lib/") ||
      locationPath.includes(".jar ->");

    if (isMavenJar) {
      if (!pathSummary.hasActiveCodeManagedPath) {
        return {
          team: "UNKNOWN",
          reason: "JAR finding is not on a recognized active code-managed path",
          isPfos: false,
          pfosNotQualified: false,
          shouldCreateTicket: false,
          pathDisposition: pathSummary.primaryDisposition,
        };
      }

      if (!pathSummary.hasConfidentRepoMapping) {
        if (isLog4jFinding(finding)) {
          return {
            team: "A",
            reason:
              "Log4j active runtime JAR requires source remediation; repo mapping can be confirmed by OneShot",
            isPfos: true,
            pfosNotQualified: false,
            shouldCreateTicket: true,
            pathDisposition: "active-code-managed",
          };
        }

        return {
          team: "UNKNOWN",
          reason: "Active JAR finding has no confident source repo mapping",
          isPfos: false,
          pfosNotQualified: false,
          shouldCreateTicket: false,
          pathDisposition: "needs-review",
        };
      }

      const automationBlocker = getAutomationBlocker(finding);
      if (automationBlocker) {
        return {
          team: "UNKNOWN",
          reason: automationBlocker,
          isPfos: false,
          pfosNotQualified: false,
          shouldCreateTicket: false,
          pathDisposition: "needs-review",
        };
      }

      return {
        team: "A",
        reason: `Maven JAR: ${packageName} (${detectionMethod})`,
        isPfos: true,
        pfosNotQualified: false,
        shouldCreateTicket: true,
        pathDisposition: "active-code-managed",
      };
    }

    // pip package detected as Library — v1 not supported, PFOS-NOT-QUALIFIED
    if (
      locationPath.includes("site-packages") ||
      locationPath.includes(".dist-info") ||
      locationPath.endsWith(".py")
    ) {
      return {
        team: "A",
        reason: `pip package (v1 not supported): ${packageName}`,
        isPfos: false,
        pfosNotQualified: true,
        shouldCreateTicket: false,
        pathDisposition: pathSummary.primaryDisposition,
      };
    }

    if (!pathSummary.hasActiveCodeManagedPath) {
      return {
        team: "UNKNOWN",
        reason: `Library finding is not on an actionable active code path: ${packageName}`,
        isPfos: false,
        pfosNotQualified: false,
        shouldCreateTicket: false,
        pathDisposition: pathSummary.primaryDisposition,
      };
    }

    if (!pathSummary.hasConfidentRepoMapping) {
      if (isLog4jFinding(finding)) {
        return {
          team: "A",
          reason:
            "Log4j active runtime library requires source remediation; repo mapping can be confirmed by OneShot",
          isPfos: true,
          pfosNotQualified: false,
          shouldCreateTicket: true,
          pathDisposition: "active-code-managed",
        };
      }

      return {
        team: "UNKNOWN",
        reason: `Library finding has no confident source repo mapping: ${packageName}`,
        isPfos: false,
        pfosNotQualified: false,
        shouldCreateTicket: false,
        pathDisposition: "needs-review",
      };
    }

    const automationBlocker = getAutomationBlocker(finding);
    if (automationBlocker) {
      return {
        team: "UNKNOWN",
        reason: automationBlocker,
        isPfos: false,
        pfosNotQualified: false,
        shouldCreateTicket: false,
        pathDisposition: "needs-review",
      };
    }

    return {
      team: "A",
      reason: `Library finding: ${packageName} (${detectionMethod})`,
      isPfos: true,
      pfosNotQualified: false,
      shouldCreateTicket: true,
      pathDisposition: "active-code-managed",
    };
  }

  // Unknown — flag for manual review
  return {
    team: "UNKNOWN",
    reason: `Unknown detectionMethod: ${detectionMethod} for ${cveId}`,
    isPfos: false,
    pfosNotQualified: false,
    shouldCreateTicket: false,
    pathDisposition: pathSummary.primaryDisposition,
  };
}

function getAutomationBlocker(finding: TriageFinding): string | undefined {
  if (hasEmbeddedMavenMetadataMismatch(finding)) {
    return "Embedded/shaded Maven metadata points to a different artifact; remediation must be reviewed manually";
  }

  if (
    /^spring(?:-|$)/i.test(finding.packageName) ||
    /^spring$/i.test(finding.packageName)
  ) {
    const currentMajor = parseMajorVersion(finding.packageVersion);
    const targetMajor = parseMajorVersion(finding.fixedVersion);
    if (
      currentMajor !== undefined &&
      targetMajor !== undefined &&
      targetMajor > currentMajor
    ) {
      return "Spring major-version upgrade requires human review before automation";
    }
  }

  return undefined;
}

function isLog4jFinding(finding: TriageFinding): boolean {
  if (/^log4j(?:-core)?$/i.test(finding.packageName)) {
    return true;
  }

  const paths =
    finding.locationPaths && finding.locationPaths.length > 0
      ? finding.locationPaths
      : [finding.locationPath];

  return paths.some((path) =>
    /(?:^|\/|->\s*)log4j(?:-core)?-\d[^/\s]*\.jar\b/i.test(path),
  );
}

function hasEmbeddedMavenMetadataMismatch(finding: TriageFinding): boolean {
  const paths =
    finding.locationPaths && finding.locationPaths.length > 0
      ? finding.locationPaths
      : [finding.locationPath];
  const packageName = normalizeArtifactName(finding.packageName);

  return paths.some((path) => {
    const match = path.match(/->\s*META-INF\/maven\/[^/]+\/([^/\s]+)/i);
    if (!match?.[1]) return false;
    return normalizeArtifactName(match[1]) !== packageName;
  });
}

function normalizeArtifactName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, "");
}

function parseMajorVersion(version: string): number | undefined {
  const match = version.match(/^(\d+)/);
  return match?.[1] ? Number(match[1]) : undefined;
}

/** Assign SLA tier based on CISA KEV status and exploit availability */
export function assignSlaTier(
  finding: TriageFinding,
): "P1-CISA-KEV" | "P1-HIGH-EXPLOIT" | "P2-30-DAY" | "P3" {
  const severity = finding.severity.toLowerCase();
  if (finding.hasCisaKevExploit) return "P1-CISA-KEV";
  if (finding.hasExploit && (severity === "critical" || severity === "blocker"))
    return "P1-HIGH-EXPLOIT";
  if (
    finding.hasExploit ||
    severity === "critical" ||
    severity === "blocker" ||
    severity === "high"
  )
    return "P2-30-DAY";
  return "P3";
}

function summarizePathDisposition(finding: TriageFinding): {
  primaryDisposition: TriagePathDisposition;
  onlyBackupArchive: boolean;
  hasActiveCodeManagedPath: boolean;
  hasConfidentRepoMapping: boolean;
} {
  const paths =
    finding.locationPaths && finding.locationPaths.length > 0
      ? finding.locationPaths
      : [finding.locationPath];
  const profiles = paths.map((path) => classifyLocationPath(path));
  const dispositions = profiles.map((profile) => profile.disposition);

  const primaryDisposition =
    dispositions.find((d) => d === "active-code-managed") ??
    dispositions.find((d) => d === "runtime-tooling") ??
    dispositions.find((d) => d === "third-party-runtime") ??
    dispositions[0] ??
    "needs-review";

  return {
    primaryDisposition,
    onlyBackupArchive:
      dispositions.length > 0 &&
      dispositions.every((disposition) => disposition === "backup-archive"),
    hasActiveCodeManagedPath: dispositions.includes("active-code-managed"),
    hasConfidentRepoMapping: profiles.some(
      (profile) =>
        profile.disposition === "active-code-managed" &&
        profile.repoConfidence === "high",
    ),
  };
}
