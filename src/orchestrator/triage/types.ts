/**
 * TRIAGE agent types — Wiz scan CSV → grouped analysis → approved tickets
 */

/** Source type detected from the attachment filename/headers */
export type TriageSource = "wiz" | "wiz-code" | "snyk" | "sonar" | "custom";

/** Team routing classification */
export type TriageTeam = "A" | "B" | "C" | "D" | "UNKNOWN";

/** TRIAGE execution mode */
export type TriageMode = "analyze" | "apply";

/** Runtime/path disposition before Team A/B/C/D routing */
export type TriagePathDisposition =
  | "active-code-managed"
  | "backup-archive"
  | "runtime-tooling"
  | "third-party-runtime"
  | "infra-os"
  | "needs-review";

export interface TriagePathBucket {
  disposition: TriagePathDisposition;
  count: number;
  examples: string[];
}

/** A single deduplicated finding from the scan */
export interface TriageFinding {
  source: TriageSource;
  cveId: string;
  findingKey?: string;
  packageName: string;
  packageVersion: string;
  fixedVersion: string;
  severity: "Critical" | "High" | "Medium" | "Low" | string;
  status?: string;
  issueType?: string;
  ruleId?: string;
  component?: string;
  line?: string;
  project?: string;
  author?: string;
  hasCisaKevExploit: boolean;
  hasExploit: boolean;
  detectionMethod: string;
  locationPath: string;
  locationPaths: string[];
  pathBuckets: TriagePathBucket[];
  remediation: string;
  firstDetected: string;
  assetCount: number;
  rawCount: number;
}

/** A grouped remediation story — one per CVE×repo combination */
export interface TriageStory {
  source: TriageSource;
  title: string;
  description: string;
  team: TriageTeam;
  severity: string;
  slaTier: "P1-CISA-KEV" | "P1-HIGH-EXPLOIT" | "P2-30-DAY" | "P3";
  cveIds: string[];
  findingKeys?: string[];
  ruleIds?: string[];
  issueTypes?: string[];
  packageName: string;
  targetVersion: string;
  repoName: string;
  repoFullName?: string;
  repoProjectName?: string;
  repoProjectPath?: string;
  repoDefaultBranch?: string;
  repoConfidence?: "high" | "medium" | "none";
  repoEvidence?: string[];
  applicationRoot?: string;
  pathDisposition?: TriagePathDisposition;
  whereToUpdate: string;
  findingCount: number;
  assetCount: number;
  isPfos: boolean;
  queueForOneShot?: boolean;
  queueBlockedReason?: string;
}

/** Result of a TRIAGE run */
export interface TriageResult {
  epicKey: string;
  source: TriageSource;
  mode: TriageMode;
  storiesCreated: number;
  teamAStories: string[]; // Jira keys
  teamBCDStories: string[]; // Jira keys
  backupCleanupStories: string[]; // Jira keys
  reviewNeededStories: string[]; // Jira keys or held review candidates
  teamAStoryCandidates: number;
  teamBCDStoryCandidates: number;
  backupCleanupStoryCandidates: number;
  reviewNeededStoryCandidates: number;
  suppressedFindings: number;
  needsReviewFindings: number;
  skippedNonMaven: number;
  dryRun: boolean;
}

/** Options for running TRIAGE */
export interface TriageOptions {
  epicKey: string;
  mode?: TriageMode;
  dryRun?: boolean;
  force?: boolean;
  sourceOverride?: TriageSource;
}
