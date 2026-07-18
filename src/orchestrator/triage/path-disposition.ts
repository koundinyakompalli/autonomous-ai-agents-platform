import type { TriagePathDisposition } from "./types.js";
import { resolveRepoFromProjectCatalog } from "./repo-catalog.js";

export interface LocationProfile {
  disposition: TriagePathDisposition;
  normalizedPath: string;
  applicationRoot: string;
  repoName?: string;
  repoFullName?: string;
  repoProjectName?: string;
  repoProjectPath?: string;
  repoDefaultBranch?: string;
  repoConfidence: "high" | "medium" | "none";
  repoEvidence?: string[];
  reason: string;
}

const BACKUP_PATH_PATTERNS = [
  /(?:^|\/)(?:backup|backups|bckp|bkp|bak|archive|archived|old)(?:\/|$)/i,
  /(?:^|\/)[^/]*(?:backup|bckp|bkp|bkup|bak|archive|dnu|do[_-]?not[_-]?use|deprecated|unused|old)[^/]*(?:\/|$)/i,
  /(?:^|\/)lib[_.-]?(?:backup|bckp|bkp|bkup|bak|old|\d{6,8})(?:\/|$)/i,
  /(?:^|\/)\d{8}(?:_\d{4})?(?:\/|$)/i,
  /(?:^|\/)releases?(?:\/|$)/i,
  /releasenotes?/i,
];

const RUNTIME_TOOLING_PATTERNS = [
  /(?:^|\/)software\/xray(?:\/|$)/i,
  /aws-opentelemetry-agent/i,
  /opentelemetry/i,
  /jmx_prometheus_javaagent/i,
  /prometheus_javaagent/i,
  /newrelic/i,
  /datadog/i,
];

const THIRD_PARTY_RUNTIME_PATTERNS = [
  /(?:^|\/)(?:opt\/)?software\/knowage(?:\/|$)/i,
  /(?:^|\/)(?:opt\/)?software\/spago(?:[-/]|$)/i,
  /(?:^|\/)(?:opt\/)?software\/spago-\d/i,
];

const USER_WORKSPACE_PATTERNS = [
  /^\/home\/users(?:\/|$)/i,
  /^\/Users(?:\/|$)/,
  /^\/tmp(?:\/|$)/i,
  /^\/var\/tmp(?:\/|$)/i,
];

const ACTIVE_LIB_PATTERNS = [
  /(?:^|\/)opt\/repo\/[^/]+\/lib(?:\/|$)/i,
  /(?:^|\/)(?:opt\/)?software\/medhok\/[^/]+(?:\/[^/]+)*\/(?:bin|lib)(?:\/|$)/i,
  /(?:^|\/)(?:opt\/)?software\/medhok\/[^/]+(?:\/[^/]+)*\/[^/]+\.jar(?:\s*->|$)/i,
  /(?:^|\/)(?:opt\/)?software\/[^/]+\/lib(?:\/|$)/i,
  /(?:^|\/)WEB-INF\/lib(?:\/|$)/i,
  /META-INF\/maven\//i,
];

const REPO_PATH_PATTERNS: Array<{ pattern: RegExp; repoName: string }> = [
  {
    pattern: /\/cp-hedis|\/opt\/repo\/(Hybrid|Measures|HedisRulesModels)/i,
    repoName: "cp-hedis-monorepo",
  },
  {
    pattern:
      /\/batch-correspondence|\/medhok\/mm-batch|\/faxintake|\/emailintake|\/workflow-watcher|\/medhok\/notification|\/medhok\/medispan|\/medhok\/fullfill|\/medhok\/cms-processor|\/medhok\/flyway/i,
    repoName: "cp-batch-monorepo",
  },
  {
    pattern:
      /\/software\/(cms-processor|batch-workflow-watcher|correspondence-watcher|correspondence-watcher-translation|CorrespondenceUtility)\b/i,
    repoName: "cp-batch-monorepo",
  },
  {
    pattern:
      /\/(?:opt\/)?software\/medhok\/(?:AssessmentQA|CaseUpdateBatchProcessor|Extract_Exporter|ProductivityAudit|batch-workflow-watcher|cms-processor|correspondence-watcher|correspondence-watcher-translation|dbscripts|fdb-ndc-loader|medhok-loader_cp|outbound-corr-feed)\b/i,
    repoName: "cp-batch-monorepo",
  },
  {
    pattern:
      /\/medhok-web-services|\/MedicalMgmt|\/medhok-vendor|\/mm-rxclaim|\/medhok\/medhok|\/medhok\/server/i,
    repoName: "cp-medhok-monorepo",
  },
];

interface PathRepoResolution {
  repoName: string;
  repoFullName?: string;
  repoProjectName?: string;
  repoProjectPath?: string;
  repoDefaultBranch?: string;
  repoConfidence: "high" | "medium";
  repoEvidence: string[];
}

export function classifyLocationPath(locationPath: string): LocationProfile {
  const normalizedPath = normalizeLocationPath(locationPath);
  const applicationRoot = inferApplicationRoot(normalizedPath);

  if (matchesAny(normalizedPath, BACKUP_PATH_PATTERNS)) {
    return {
      disposition: "backup-archive",
      normalizedPath,
      applicationRoot,
      repoConfidence: "none",
      reason: "Path matches backup/archive/release pattern",
    };
  }

  if (matchesAny(normalizedPath, RUNTIME_TOOLING_PATTERNS)) {
    return {
      disposition: "runtime-tooling",
      normalizedPath,
      applicationRoot,
      repoConfidence: "none",
      reason: "Path is runtime/tooling agent scope",
    };
  }

  if (matchesAny(normalizedPath, THIRD_PARTY_RUNTIME_PATTERNS)) {
    return {
      disposition: "third-party-runtime",
      normalizedPath,
      applicationRoot,
      repoConfidence: "none",
      reason: "Path is third-party runtime/platform scope",
    };
  }

  if (matchesAny(normalizedPath, USER_WORKSPACE_PATTERNS)) {
    return {
      disposition: "needs-review",
      normalizedPath,
      applicationRoot,
      repoConfidence: "none",
      reason: "Path is a user workspace or temporary filesystem scope",
    };
  }

  const repoResolution = inferRepoResolutionFromLocationPath(normalizedPath);
  if (matchesAny(normalizedPath, ACTIVE_LIB_PATTERNS)) {
    return {
      disposition: "active-code-managed",
      normalizedPath,
      applicationRoot,
      ...repoResolution,
      repoConfidence: repoResolution?.repoConfidence ?? "none",
      reason: repoResolution
        ? "Active runtime library path with known repo mapping"
        : "Active runtime library path without known repo mapping",
    };
  }

  return {
    disposition: "needs-review",
    normalizedPath,
    applicationRoot,
    ...repoResolution,
    repoConfidence: repoResolution?.repoConfidence ?? "none",
    reason: repoResolution
      ? "Known repo mapping, but path is not a recognized active library"
      : "No reliable path disposition or repo mapping",
  };
}

export function inferRepoFromLocationPath(
  locationPath: string,
): string | undefined {
  return inferRepoResolutionFromLocationPath(locationPath)?.repoName;
}

export function inferRepoResolutionFromLocationPath(
  locationPath: string,
): PathRepoResolution | undefined {
  const normalizedPath = normalizeLocationPath(locationPath);
  const catalogResolution = resolveRepoFromProjectCatalog(normalizedPath);
  if (catalogResolution?.confidence === "high") {
    return {
      repoName: catalogResolution.repoName,
      repoFullName: catalogResolution.repoFullName,
      repoProjectName: catalogResolution.projectName,
      repoProjectPath: catalogResolution.projectPath,
      repoDefaultBranch: catalogResolution.defaultBranch,
      repoConfidence: catalogResolution.confidence,
      repoEvidence: catalogResolution.evidence,
    };
  }

  for (const { pattern, repoName } of REPO_PATH_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      return {
        repoName,
        repoConfidence: "high",
        repoEvidence: ["Matched curated TRIAGE path pattern"],
      };
    }
  }
  if (catalogResolution) {
    return {
      repoName: catalogResolution.repoName,
      repoFullName: catalogResolution.repoFullName,
      repoProjectName: catalogResolution.projectName,
      repoProjectPath: catalogResolution.projectPath,
      repoDefaultBranch: catalogResolution.defaultBranch,
      repoConfidence: catalogResolution.confidence,
      repoEvidence: catalogResolution.evidence,
    };
  }
  return undefined;
}

export function normalizeLocationPath(locationPath: string): string {
  return locationPath.replace(/^\/\[Partition=[^\]]+\]/i, "");
}

function inferApplicationRoot(locationPath: string): string {
  const optSoftware = locationPath.match(/^\/opt\/software\/([^/]+)/i);
  if (optSoftware?.[1]) return `/opt/software/${optSoftware[1]}`;

  const software = locationPath.match(/^\/software\/([^/]+)/i);
  if (software?.[1]) return `/software/${software[1]}`;

  const releases = locationPath.match(/^\/releases\/([^/]+)/i);
  if (releases?.[1]) return `/releases/${releases[1]}`;

  const parts = locationPath.split("/").filter(Boolean);
  return parts.length > 0 ? `/${parts.slice(0, 2).join("/")}` : "";
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}
