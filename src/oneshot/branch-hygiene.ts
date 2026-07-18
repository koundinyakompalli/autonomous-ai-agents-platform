import fs from "fs/promises";
import path from "path";
import {
  listChangedFiles,
  parseGitNameStatusPaths,
  runGitCommand,
} from "./git.js";

const BLOCKED_SEGMENTS = new Set([
  "target",
  "node_modules",
  ".gradle",
  ".cache",
  "coverage",
  ".nyc_output",
]);

const MAX_SAMPLE = 50;

export interface BranchHygieneSummary {
  removedFiles: string[];
  removedFilesSample: string[];
  removedFilesCount: number;
  preservedFiles: string[];
  preservedFilesSample: string[];
  preservedFilesCount: number;
  blockedFiles: string[];
  blockedFilesSample: string[];
  blockedFilesCount: number;
}

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isBlockedGeneratedPath(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment, index) =>
        segment === ".m2" && segments[index + 1] === "repository",
    )
  ) {
    return true;
  }

  return segments.some((segment) => BLOCKED_SEGMENTS.has(segment));
}

function sample(paths: readonly string[]): string[] {
  return paths.slice(0, MAX_SAMPLE);
}

async function pathExistsAtRef(
  workspacePath: string,
  ref: string,
  filePath: string,
): Promise<boolean> {
  try {
    await runGitCommand(
      `git cat-file -e ${JSON.stringify(`${ref}:${filePath}`)}`,
      workspacePath,
    );
    return true;
  } catch {
    return false;
  }
}

async function restorePathFromRef(
  workspacePath: string,
  ref: string,
  filePath: string,
): Promise<void> {
  await runGitCommand(
    `git checkout ${JSON.stringify(ref)} -- ${JSON.stringify(filePath)}`,
    workspacePath,
  );
}

async function removePathFromCandidate(
  workspacePath: string,
  filePath: string,
): Promise<void> {
  await runGitCommand(
    `git rm -r --cached --ignore-unmatch -- ${JSON.stringify(filePath)}`,
    workspacePath,
  ).catch(() => undefined);

  const absolutePath = path.resolve(workspacePath, filePath);
  const workspaceRoot = path.resolve(workspacePath);
  if (!absolutePath.startsWith(workspaceRoot + path.sep)) {
    throw new Error(`Refusing to clean path outside workspace: ${filePath}`);
  }
  await fs.rm(absolutePath, { recursive: true, force: true });
}

async function listNetChangedFilesFromBase(
  workspacePath: string,
  baseRef: string,
): Promise<string[]> {
  const { stdout } = await runGitCommand(
    `git diff --name-status --find-renames ${JSON.stringify(baseRef)}`,
    workspacePath,
  );
  return parseGitNameStatusPaths(stdout);
}

export async function cleanGeneratedBranchChanges(input: {
  workspacePath: string;
  baseRef: string;
  currentHead: string;
}): Promise<BranchHygieneSummary> {
  const committedChanges = await listChangedFiles(
    input.workspacePath,
    input.baseRef,
    input.currentHead,
  );
  const dirtyChanges = await listChangedFiles(input.workspacePath);
  const generatedChanges = Array.from(
    new Set(
      [...committedChanges, ...dirtyChanges].filter(isBlockedGeneratedPath),
    ),
  ).sort((left, right) => left.localeCompare(right));

  const removedFiles: string[] = [];
  const preservedFiles: string[] = [];

  for (const filePath of generatedChanges) {
    if (await pathExistsAtRef(input.workspacePath, input.baseRef, filePath)) {
      await restorePathFromRef(input.workspacePath, input.baseRef, filePath);
      preservedFiles.push(filePath);
    } else {
      await removePathFromCandidate(input.workspacePath, filePath);
      removedFiles.push(filePath);
    }
  }

  const remainingNetChanges = await listNetChangedFilesFromBase(
    input.workspacePath,
    input.baseRef,
  );
  const blockedFiles = Array.from(
    new Set(remainingNetChanges.filter(isBlockedGeneratedPath)),
  ).sort((left, right) => left.localeCompare(right));

  return {
    removedFiles,
    removedFilesSample: sample(removedFiles),
    removedFilesCount: removedFiles.length,
    preservedFiles,
    preservedFilesSample: sample(preservedFiles),
    preservedFilesCount: preservedFiles.length,
    blockedFiles,
    blockedFilesSample: sample(blockedFiles),
    blockedFilesCount: blockedFiles.length,
  };
}

// ---------------------------------------------------------------------------
// PFOS Security Remediation Scope Guard
// ---------------------------------------------------------------------------
// For tickets labeled PFOS (CVE remediation via Wiz scan), the only permitted
// changed files are pom.xml files and security-baseline.properties.
// Callers can use this helper for runtime observability and policy decisions
// when they need to understand whether a Wiz remediation run stayed inside the
// narrow dependency-update file scope.
//
// Called by the IMPLEMENTER consumer after applyBranchHygiene() when the run
// carries the PFOS label. Non-PFOS runs never call this function.

export interface SecurityRemediationScopeViolation {
  file: string;
  reason: string;
}

export interface SecurityRemediationScopeResult {
  compliant: boolean;
  violations: SecurityRemediationScopeViolation[];
  allowedFiles: string[];
  violatingFiles: string[];
}

const SECURITY_REMEDIATION_ALLOWED_PATTERNS = [
  /^(.*\/)?pom\.xml$/,
  /^(.*\/)?security-baseline\.properties$/,
];

function isAllowedSecurityRemediationPath(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  return SECURITY_REMEDIATION_ALLOWED_PATTERNS.some((pattern) =>
    pattern.test(normalized),
  );
}

export function checkSecurityRemediationScope(
  changedFiles: string[],
): SecurityRemediationScopeResult {
  const allowedFiles: string[] = [];
  const violations: SecurityRemediationScopeViolation[] = [];

  for (const file of changedFiles) {
    if (isAllowedSecurityRemediationPath(file)) {
      allowedFiles.push(file);
    } else {
      violations.push({
        file,
        reason:
          `PFOS security remediation tickets may only change pom.xml or ` +
          `security-baseline.properties. Unexpected file: ${file}`,
      });
    }
  }

  return {
    compliant: violations.length === 0,
    violations,
    allowedFiles,
    violatingFiles: violations.map((v) => v.file),
  };
}
