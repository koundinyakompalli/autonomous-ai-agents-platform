/**
 * Wiz Code Analysis (SAST) CSV parser for TRIAGE.
 *
 * This is DISTINCT from the Wiz dependency/CVE export (parsers/wiz.ts):
 *   - wiz.ts    → dependency findings (bump a library version in pom.xml)
 *   - wiz-code.ts → SAST findings (fix a code-logic weakness, e.g. CWE-89 SQLi)
 *
 * The export is issue-centric like SonarQube — one row per file:line weakness —
 * so parsed findings feed the shared issue-centric engine path, NOT the
 * dependency-CVE grouping.
 *
 * Header (observed):
 *   name,resource.name,filePath,startLine,severity,origin,
 *   codeLibraryLanguage,weaknesses,status
 */

import { createLogger } from "../../../utils/logger.js";
import type { TriageFinding, TriagePathBucket } from "../types.js";

const logger = createLogger("triage-wiz-code-parser");

const WIZ_CODE_REQUIRED_HEADERS = [
  "name",
  "resource.name",
  "filePath",
  "startLine",
  "severity",
  "weaknesses",
  "status",
];

export interface WizCodeParseResult {
  findings: TriageFinding[];
  totalRows: number;
  skippedRows: number;
}

/**
 * Detect a Wiz Code (SAST) export from its header line. The filename is
 * generic (e.g. `Report_Jul_10_2026.csv`) so header sniffing is the only
 * reliable signal.
 */
export function isWizCodeCsv(content: string): boolean {
  const firstLine = content.split("\n")[0] ?? "";
  const headers = new Set(parseCsvLine(firstLine).map(cleanCell));
  // `weaknesses` + `filePath` + `resource.name` uniquely identifies the SAST
  // export and never co-occurs with the dependency-CVE or Sonar schemas.
  return (
    headers.has("weaknesses") &&
    headers.has("filePath") &&
    headers.has("resource.name")
  );
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

export async function parseWizCodeCsvStream(
  response: Response,
): Promise<WizCodeParseResult> {
  const decoder = new TextDecoder("utf-8");
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return parseWizCodeCsv(text);
  }

  let remainder = "";
  let headers: string[] | null = null;
  let col: Record<string, number> | null = null;
  const findings: TriageFinding[] = [];
  let totalRows = 0;
  let skippedRows = 0;

  const processLine = (line: string): void => {
    if (!line.trim()) return;

    if (headers === null) {
      headers = parseCsvLine(line).map(cleanCell);
      col = buildColumnIndex(headers);
      validateHeaders(headers, col);
      return;
    }

    totalRows++;
    const parsed = parseWizCodeRow(parseCsvLine(line), col!);
    if (!parsed) {
      skippedRows++;
      return;
    }
    findings.push(parsed);
  };

  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    done = d;
    if (value) {
      const chunk = decoder.decode(value, { stream: !done });
      const combined = remainder + chunk;
      const lines = combined.split("\n");
      remainder = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    }
  }
  if (remainder.trim()) processLine(remainder);

  logger.info(
    { totalRows, openFindings: findings.length, skippedRows },
    "Wiz Code (SAST) CSV parsed (streaming)",
  );
  return { findings, totalRows, skippedRows };
}

export function parseWizCodeCsv(content: string): WizCodeParseResult {
  const lines = content.split("\n").filter((line) => line.trim());
  if (lines.length === 0) {
    return { findings: [], totalRows: 0, skippedRows: 0 };
  }

  const headers = parseCsvLine(lines[0]).map(cleanCell);
  const col = buildColumnIndex(headers);
  validateHeaders(headers, col);

  const findings: TriageFinding[] = [];
  let skippedRows = 0;

  for (const line of lines.slice(1)) {
    const parsed = parseWizCodeRow(parseCsvLine(line), col);
    if (!parsed) {
      skippedRows++;
      continue;
    }
    findings.push(parsed);
  }

  logger.info(
    { totalRows: lines.length - 1, openFindings: findings.length, skippedRows },
    "Wiz Code (SAST) CSV parsed",
  );
  return { findings, totalRows: lines.length - 1, skippedRows };
}

function buildColumnIndex(headers: string[]): Record<string, number> {
  const idx = (name: string): number => headers.indexOf(name);
  return {
    name: idx("name"),
    resourceName: idx("resource.name"),
    filePath: idx("filePath"),
    startLine: idx("startLine"),
    severity: idx("severity"),
    origin: idx("origin"),
    language: idx("codeLibraryLanguage"),
    weaknesses: idx("weaknesses"),
    status: idx("status"),
  };
}

function validateHeaders(headers: string[], col: Record<string, number>): void {
  const missing = WIZ_CODE_REQUIRED_HEADERS.filter((name) => {
    const key =
      name === "resource.name"
        ? "resourceName"
        : name === "startLine"
          ? "startLine"
          : name;
    return col[key] === -1;
  });
  if (missing.length > 0) {
    throw new Error(
      `Wiz Code CSV missing required columns (${missing.join(", ")}). ` +
        `Found headers: ${headers.slice(0, 12).join(", ")}`,
    );
  }
}

function parseWizCodeRow(
  cols: string[],
  col: Record<string, number>,
): TriageFinding | null {
  const status = cell(cols, col.status).toUpperCase();
  if (status && status !== "OPEN") return null;

  const name = cell(cols, col.name);
  const resourceName = cell(cols, col.resourceName);
  const filePath = cell(cols, col.filePath);
  if (!name || !filePath) return null;

  const line = cell(cols, col.startLine);
  const severity = normalizeSeverity(cell(cols, col.severity));
  const cwe = extractPrimaryWeakness(cell(cols, col.weaknesses));
  const language = extractPrimaryLanguage(cell(cols, col.language));
  const { repoName, project, branch } = parseResourceName(resourceName);

  // Synthesize a stable key — the SAST export has no key/id column.
  const findingKey = `${repoName || project}:${filePath}:${line}:${cwe}`;
  const component = filePath;
  const locationPath = line ? `${filePath}:${line}` : filePath;

  return {
    source: "wiz-code",
    cveId: cwe || findingKey,
    findingKey,
    packageName: cwe || "SAST",
    packageVersion: "",
    fixedVersion: "",
    severity,
    status: status || "OPEN",
    // Wiz SAST findings are code-logic weaknesses. We tag them VULNERABILITY so
    // the shared issue-centric classifier treats them as Team A candidates;
    // engine-side routing decides human-gating and vendored suppression.
    issueType: "VULNERABILITY",
    ruleId: cwe || "SAST",
    component,
    line,
    project: repoName || project,
    author: "",
    hasCisaKevExploit: false,
    hasExploit: false,
    detectionMethod: "WizCode",
    locationPath,
    locationPaths: [locationPath],
    pathBuckets: createSourcePathBuckets(component, repoName || project),
    remediation: name,
    firstDetected: "",
    assetCount: 1,
    rawCount: 1,
    // Extra fields for engine-side routing (typed loosely via index).
    ...({ language, repoBranch: branch, repoOrgPath: project } as object),
  };
}

/**
 * `mhk-repos/cp-provider-portal/master` → repo, org path, branch.
 *
 * Structure is `<org>/<repo>/<branch...>` where the branch itself may contain
 * slashes (e.g. `feature/security-fix`). The org and repo are always single
 * segments, so the repo is the second segment and the branch is everything
 * after it — joined back with "/" so slashed branch names survive.
 */
export function parseResourceName(resourceName: string): {
  repoName: string;
  project: string;
  branch: string;
} {
  const parts = resourceName.split("/").filter(Boolean);
  if (parts.length === 0) {
    return { repoName: "", project: resourceName, branch: "" };
  }
  if (parts.length === 1) {
    return { repoName: parts[0], project: resourceName, branch: "" };
  }
  if (parts.length === 2) {
    // Bare `<repo>/<branch>` with no org prefix.
    return { repoName: parts[0], project: resourceName, branch: parts[1] };
  }
  // `<org>/<repo>/<branch...>` — org and repo are single segments; the branch
  // may contain slashes (e.g. feature/security-fix), so keep everything after
  // the repo joined with "/".
  const repoName = parts[1];
  const branch = parts.slice(2).join("/");
  return { repoName, project: resourceName, branch };
}

/** `[{"id":"CWE-89"}]` → `CWE-89`. Tolerant of malformed JSON. */
export function extractPrimaryWeakness(raw: string): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const first = parsed[0];
      if (first && typeof first.id === "string") return first.id;
    }
  } catch {
    // Fall through to regex.
  }
  const match = raw.match(/CWE-\d+/i);
  return match ? match[0].toUpperCase() : "";
}

/** `["JAVA"]` → `JAVA`. */
export function extractPrimaryLanguage(raw: string): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return String(parsed[0] ?? "").toUpperCase();
    }
  } catch {
    // Fall through.
  }
  return (
    raw
      .replace(/[[\]"]/g, "")
      .split(",")[0]
      ?.trim()
      .toUpperCase() ?? ""
  );
}

function createSourcePathBuckets(
  component: string,
  project: string,
): TriagePathBucket[] {
  return [
    {
      disposition: "active-code-managed",
      count: 1,
      examples: [project ? `${project}:${component}` : component],
    },
  ];
}

function normalizeSeverity(value: string): string {
  const upper = value.toUpperCase();
  if (upper === "CRITICAL") return "Critical";
  if (upper === "HIGH") return "High";
  if (upper === "MEDIUM") return "Medium";
  if (upper === "LOW") return "Low";
  return value || "Unknown";
}

function cell(cols: string[], idx: number): string {
  return idx >= 0 ? cleanCell(cols[idx] ?? "") : "";
}

function cleanCell(value: string): string {
  return value.replace(/^﻿/, "").replace(/^"|"$/g, "").trim();
}
