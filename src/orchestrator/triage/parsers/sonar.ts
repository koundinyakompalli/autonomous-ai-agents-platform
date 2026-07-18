/**
 * SonarQube CSV parser for TRIAGE.
 *
 * Sonar exports are issue-centric, not CVE-centric. We map each OPEN issue to
 * TriageFinding so the shared TRIAGE engine can group and report candidates.
 */

import { createLogger } from "../../../utils/logger.js";
import type { TriageFinding, TriagePathBucket } from "../types.js";

const logger = createLogger("triage-sonar-parser");

const SONAR_REQUIRED_HEADERS = [
  "Key",
  "Type",
  "Severity",
  "Status",
  "Message",
  "Component",
  "Rule",
  "Project",
];

const SONAR_IDENTIFYING_HEADERS = ["Line", "Author", "Created Date"];

export interface SonarParseResult {
  findings: TriageFinding[];
  totalRows: number;
  skippedRows: number;
}

export function isSonarCsv(content: string): boolean {
  const firstLine = content.split("\n")[0] ?? "";
  const headers = new Set(parseCsvLine(firstLine).map(cleanCell));
  return (
    SONAR_REQUIRED_HEADERS.every((header) => headers.has(header)) &&
    SONAR_IDENTIFYING_HEADERS.filter((header) => headers.has(header)).length >=
      2
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

export async function parseSonarCsvStream(
  response: Response,
): Promise<SonarParseResult> {
  const decoder = new TextDecoder("utf-8");
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return parseSonarCsv(text);
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
    const parsed = parseSonarRow(parseCsvLine(line), col!);
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
    "SonarQube CSV parsed",
  );
  return { findings, totalRows, skippedRows };
}

export function parseSonarCsv(content: string): SonarParseResult {
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
    const parsed = parseSonarRow(parseCsvLine(line), col);
    if (!parsed) {
      skippedRows++;
      continue;
    }
    findings.push(parsed);
  }

  return {
    findings,
    totalRows: lines.length - 1,
    skippedRows,
  };
}

function buildColumnIndex(headers: string[]): Record<string, number> {
  const idx = (name: string): number => headers.indexOf(name);
  return {
    key: idx("Key"),
    type: idx("Type"),
    severity: idx("Severity"),
    status: idx("Status"),
    message: idx("Message"),
    component: idx("Component"),
    line: idx("Line"),
    rule: idx("Rule"),
    author: idx("Author"),
    createdDate: idx("Created Date"),
    project: idx("Project"),
  };
}

function validateHeaders(headers: string[], col: Record<string, number>): void {
  const missing = [
    "key",
    "type",
    "severity",
    "status",
    "message",
    "component",
    "rule",
    "project",
  ].filter((key) => col[key] === -1);
  if (missing.length > 0) {
    throw new Error(
      `SonarQube CSV missing required columns (${missing.join(", ")}). ` +
        `Found headers: ${headers.slice(0, 12).join(", ")}`,
    );
  }
}

function parseSonarRow(
  cols: string[],
  col: Record<string, number>,
): TriageFinding | null {
  const status = cell(cols, col.status).toUpperCase();
  if (status !== "OPEN") return null;

  const key = cell(cols, col.key);
  const ruleId = cell(cols, col.rule);
  const component = cell(cols, col.component);
  if (!key || !ruleId || !component) return null;

  const severity = normalizeSeverity(cell(cols, col.severity));
  const issueType = cell(cols, col.type).toUpperCase();
  const message = cell(cols, col.message);
  const line = cell(cols, col.line);
  const project = cell(cols, col.project);
  const locationPath = line ? `${component}:${line}` : component;

  return {
    source: "sonar",
    cveId: key,
    findingKey: key,
    packageName: ruleId,
    packageVersion: "",
    fixedVersion: "",
    severity,
    status,
    issueType,
    ruleId,
    component,
    line,
    project,
    author: cell(cols, col.author),
    hasCisaKevExploit: false,
    hasExploit: false,
    detectionMethod: "SonarQube",
    locationPath,
    locationPaths: [locationPath],
    pathBuckets: createSourcePathBuckets(component, project),
    remediation: message,
    firstDetected: cell(cols, col.createdDate),
    assetCount: 1,
    rawCount: 1,
  };
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
  if (upper === "BLOCKER") return "Blocker";
  if (upper === "CRITICAL") return "Critical";
  if (upper === "MAJOR") return "High";
  if (upper === "MINOR") return "Medium";
  if (upper === "INFO") return "Low";
  return value || "Unknown";
}

function cell(cols: string[], idx: number): string {
  return idx >= 0 ? cleanCell(cols[idx] ?? "") : "";
}

function cleanCell(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/^"|"$/g, "")
    .trim();
}
