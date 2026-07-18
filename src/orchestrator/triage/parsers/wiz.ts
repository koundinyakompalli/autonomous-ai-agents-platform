/**
 * Wiz CSV parser for TRIAGE
 *
 * Parses the Wiz vulnerability export CSV and returns deduplicated findings.
 * The Wiz export has one row per finding instance. We deduplicate by
 * CVE ID + package name + version to get unique vulnerability types.
 */

import * as XLSX from "xlsx";
import { createLogger } from "../../../utils/logger.js";
import type { TriageFinding, TriagePathBucket } from "../types.js";
import { classifyLocationPath } from "../path-disposition.js";

const logger = createLogger("triage-wiz-parser");

/** Detect if a CSV buffer looks like a Wiz export */
export function isWizCsv(content: string): boolean {
  const firstLine = content.split("\n")[0] ?? "";
  return (
    firstLine.includes("WizURL") ||
    firstLine.includes("CVSSSeverity") ||
    firstLine.includes("HasCisaKevExploit") ||
    (firstLine.includes("CVE") && firstLine.includes("LocationPath"))
  );
}

/**
 * Parse one CSV record into fields.
 *
 * Wiz exports can include large quoted CVE descriptions with commas, quotes,
 * and embedded newlines. Quotes inside a quoted field are treated as literal
 * unless they are escaped (`""`) or followed by a delimiter/end of record.
 */
function parseCsvRecord(record: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  let atFieldStart = true;

  for (let i = 0; i < record.length; i++) {
    const char = record[i];
    if (char === '"') {
      if (inQuotes) {
        const next = record[i + 1];
        if (next === '"') {
          current += '"';
          i++;
        } else if (
          next === "," ||
          next === undefined ||
          next === "\r" ||
          next === "\n"
        ) {
          inQuotes = false;
        } else {
          current += char;
        }
      } else if (atFieldStart) {
        inQuotes = true;
        atFieldStart = false;
      } else {
        current += char;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
      atFieldStart = true;
    } else {
      current += char;
      if (char !== " " && char !== "\t") {
        atFieldStart = false;
      }
    }
  }
  result.push(current.trim());
  return result;
}

function appendCsvPhysicalLine(pending: string, line: string): string {
  const normalizedLine = line.replace(/\r$/, "");
  return pending ? `${pending}\n${normalizedLine}` : normalizedLine;
}

function parseCsvRecords(content: string): string[] {
  const records: string[] = [];
  let pending = "";
  let expectedColumnCount: number | null = null;

  for (const line of content.split("\n")) {
    if (!line.trim() && !pending) {
      continue;
    }

    pending = appendCsvPhysicalLine(pending, line);
    const columnCount = parseCsvRecord(pending).length;
    if (expectedColumnCount === null) {
      expectedColumnCount = columnCount;
      records.push(pending);
      pending = "";
      continue;
    }

    if (columnCount >= expectedColumnCount) {
      records.push(pending);
      pending = "";
    }
  }

  if (pending.trim()) {
    records.push(pending);
  }

  return records;
}

export interface WizParseResult {
  findings: TriageFinding[];
  totalRows: number;
  skippedRows: number;
}

/**
 * Stream-parse a Wiz CSV from a fetch Response without loading the full
 * ~1 GB file into memory. Processes line-by-line using a TextDecoder and a
 * rolling line buffer, deduplicating findings on the fly.
 */
export async function parseWizCsvStream(
  response: Response,
): Promise<WizParseResult> {
  const decoder = new TextDecoder("utf-8");
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback: load into memory (small files / test environments)
    const text = await response.text();
    return parseWizCsv(text);
  }

  let remainder = "";
  let headers: string[] | null = null;
  let COL: Record<string, number> | null = null;
  const dedup = new Map<
    string,
    { finding: TriageFinding; assets: Set<string>; rawCount: number }
  >();
  let totalRows = 0;
  let skippedRows = 0;
  let pendingRecord = "";

  const processRecord = (record: string): void => {
    if (!record.trim()) return;

    if (headers === null) {
      headers = parseCsvRecord(record).map((h) => h.replace(/^"|"$/g, ""));
      const idx = (name: string): number => headers!.indexOf(name);
      COL = {
        name: idx("Name"),
        severity: idx("CVSSSeverity"),
        hasExploit: idx("HasExploit"),
        hasCisaKev: idx("HasCisaKevExploit"),
        detectionMethod: idx("DetectionMethod"),
        locationPath: idx("LocationPath"),
        version: idx("Version"),
        fixedVersion: idx("FixedVersion"),
        remediation: idx("Remediation"),
        firstDetected: idx("FirstDetected"),
        assetId: idx("AssetID"),
        // Advisory/filtered exports may have DetailedName + AssetName
        // instead of LocationPath — used as fallback
        detailedName: idx("DetailedName"),
        assetName: idx("AssetName"),
      };
      if (COL.name === -1) {
        throw new Error(
          "Wiz CSV missing required column (Name). " +
            `Found headers: ${headers.slice(0, 10).join(", ")}`,
        );
      }
      return;
    }

    totalRows++;
    const cols = parseCsvRecord(record);
    const c = COL!;
    const cveId = cols[c.name]?.replace(/^"|"$/g, "") ?? "";
    const rawLocationPath = cols[c.locationPath]?.replace(/^"|"$/g, "") ?? "";
    const version = cols[c.version]?.replace(/^"|"$/g, "") ?? "";
    const assetId = c.assetId >= 0 ? (cols[c.assetId] ?? "") : "";

    if (!cveId) {
      skippedRows++;
      return;
    }

    // Advisory/filtered exports have empty LocationPath but populate
    // DetailedName (e.g. "kernel") and AssetName — construct a synthetic
    // path so these findings are classified and not silently skipped.
    const detailedName =
      c.detailedName >= 0
        ? (cols[c.detailedName]?.replace(/^"|"$/g, "") ?? "")
        : "";
    const assetName =
      c.assetName >= 0 ? (cols[c.assetName]?.replace(/^"|"$/g, "") ?? "") : "";
    const locationPath =
      rawLocationPath ||
      (detailedName
        ? `/advisory/${detailedName}${assetName ? `@${assetName}` : ""}`
        : "");

    if (!locationPath) {
      skippedRows++;
      return;
    }

    const packageName = extractPackageName(locationPath, cveId);
    const profile = classifyLocationPath(locationPath);
    const dedupeKey = [
      cveId,
      packageName,
      version,
      profile.disposition,
      profile.applicationRoot,
    ].join("::");
    const existing = dedup.get(dedupeKey);
    if (existing) {
      existing.rawCount++;
      if (assetId) existing.assets.add(assetId);
      mergeFindingPath(existing.finding, locationPath);
    } else {
      dedup.set(dedupeKey, {
        finding: {
          source: "wiz",
          cveId,
          packageName,
          packageVersion: version,
          fixedVersion: cols[c.fixedVersion]?.replace(/^"|"$/g, "") ?? "",
          severity: cols[c.severity]?.replace(/^"|"$/g, "") ?? "Unknown",
          hasCisaKevExploit:
            (cols[c.hasCisaKev] ?? "").toUpperCase() === "TRUE",
          hasExploit: (cols[c.hasExploit] ?? "").toUpperCase() === "TRUE",
          detectionMethod: cols[c.detectionMethod]?.replace(/^"|"$/g, "") ?? "",
          locationPath,
          locationPaths: [locationPath],
          pathBuckets: createPathBuckets(locationPath),
          remediation: cols[c.remediation]?.replace(/^"|"$/g, "") ?? "",
          firstDetected: cols[c.firstDetected]?.replace(/^"|"$/g, "") ?? "",
          assetCount: assetId ? 1 : 0,
          rawCount: 1,
        },
        assets: new Set(assetId ? [assetId] : []),
        rawCount: 1,
      });
    }
  };

  const processPhysicalLine = (line: string): void => {
    if (!line.trim() && !pendingRecord) {
      return;
    }

    pendingRecord = appendCsvPhysicalLine(pendingRecord, line);
    const expectedColumnCount = headers?.length;
    const columnCount = parseCsvRecord(pendingRecord).length;
    if (
      headers === null ||
      (expectedColumnCount && columnCount >= expectedColumnCount)
    ) {
      processRecord(pendingRecord);
      pendingRecord = "";
    }
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
      for (const line of lines) {
        processPhysicalLine(line);
      }
    }
  }
  if (remainder.trim()) {
    processPhysicalLine(remainder);
  }
  if (pendingRecord.trim()) {
    processRecord(pendingRecord);
  }

  const findings: TriageFinding[] = [];
  for (const { finding, assets, rawCount } of dedup.values()) {
    findings.push({ ...finding, assetCount: assets.size, rawCount });
  }

  logger.info(
    { totalRows, uniqueFindings: findings.length, skippedRows },
    "Wiz CSV parsed (streaming)",
  );
  return { findings, totalRows, skippedRows };
}

export function parseWizCsv(content: string): WizParseResult {
  const records = parseCsvRecords(content);
  if (records.length === 0) {
    return { findings: [], totalRows: 0, skippedRows: 0 };
  }

  const headers = parseCsvRecord(records[0]).map((h) =>
    h.replace(/^"|"$/g, ""),
  );

  const idx = (name: string): number => headers.indexOf(name);
  const COL = {
    name: idx("Name"),
    severity: idx("CVSSSeverity"),
    hasExploit: idx("HasExploit"),
    hasCisaKev: idx("HasCisaKevExploit"),
    detectionMethod: idx("DetectionMethod"),
    locationPath: idx("LocationPath"),
    version: idx("Version"),
    fixedVersion: idx("FixedVersion"),
    remediation: idx("Remediation"),
    firstDetected: idx("FirstDetected"),
    assetId: idx("AssetID"),
    detailedName: idx("DetailedName"),
    assetName: idx("AssetName"),
  };

  // Validate required columns
  if (COL.name === -1) {
    throw new Error(
      "Wiz CSV missing required column (Name). " +
        `Found headers: ${headers.slice(0, 10).join(", ")}`,
    );
  }

  const dedup = new Map<
    string,
    {
      finding: TriageFinding;
      assets: Set<string>;
      rawCount: number;
    }
  >();

  let skippedRows = 0;
  const dataRows = records.slice(1);

  for (const line of dataRows) {
    if (!line.trim()) continue;

    const cols = parseCsvRecord(line);
    const cveId = cols[COL.name]?.replace(/^"|"$/g, "") ?? "";
    const rawLocationPath =
      COL.locationPath >= 0
        ? (cols[COL.locationPath]?.replace(/^"|"$/g, "") ?? "")
        : "";
    const version = cols[COL.version]?.replace(/^"|"$/g, "") ?? "";
    const assetId = COL.assetId >= 0 ? (cols[COL.assetId] ?? "") : "";

    if (!cveId) {
      skippedRows++;
      continue;
    }

    const detailedName =
      COL.detailedName >= 0
        ? (cols[COL.detailedName]?.replace(/^"|"$/g, "") ?? "")
        : "";
    const assetName =
      COL.assetName >= 0
        ? (cols[COL.assetName]?.replace(/^"|"$/g, "") ?? "")
        : "";
    const locationPath =
      rawLocationPath ||
      (detailedName
        ? `/advisory/${detailedName}${assetName ? `@${assetName}` : ""}`
        : "");

    if (!locationPath) {
      skippedRows++;
      continue;
    }

    // Extract package name from locationPath (e.g. jackson-databind from jar path)
    const packageName = extractPackageName(locationPath, cveId);
    const profile = classifyLocationPath(locationPath);
    const dedupeKey = [
      cveId,
      packageName,
      version,
      profile.disposition,
      profile.applicationRoot,
    ].join("::");

    const existing = dedup.get(dedupeKey);
    if (existing) {
      existing.rawCount++;
      if (assetId) existing.assets.add(assetId);
      mergeFindingPath(existing.finding, locationPath);
    } else {
      dedup.set(dedupeKey, {
        finding: {
          source: "wiz",
          cveId,
          packageName,
          packageVersion: version,
          fixedVersion: cols[COL.fixedVersion]?.replace(/^"|"$/g, "") ?? "",
          severity: cols[COL.severity]?.replace(/^"|"$/g, "") ?? "Unknown",
          hasCisaKevExploit:
            (cols[COL.hasCisaKev] ?? "").toUpperCase() === "TRUE",
          hasExploit: (cols[COL.hasExploit] ?? "").toUpperCase() === "TRUE",
          detectionMethod:
            cols[COL.detectionMethod]?.replace(/^"|"$/g, "") ?? "",
          locationPath,
          locationPaths: [locationPath],
          pathBuckets: createPathBuckets(locationPath),
          remediation: cols[COL.remediation]?.replace(/^"|"$/g, "") ?? "",
          firstDetected: cols[COL.firstDetected]?.replace(/^"|"$/g, "") ?? "",
          assetCount: assetId ? 1 : 0,
          rawCount: 1,
        },
        assets: new Set(assetId ? [assetId] : []),
        rawCount: 1,
      });
    }
  }

  const findings: TriageFinding[] = [];
  for (const { finding, assets, rawCount } of dedup.values()) {
    findings.push({
      ...finding,
      assetCount: assets.size,
      rawCount,
    });
  }

  logger.info(
    {
      totalRows: dataRows.length,
      uniqueFindings: findings.length,
      skippedRows,
    },
    "Wiz CSV parsed",
  );

  return { findings, totalRows: dataRows.length, skippedRows };
}

/**
 * Parse a Wiz xlsx attachment from a Buffer.
 * Converts the first sheet to CSV text then delegates to parseWizCsv()
 * so all dedup/classification logic is shared.
 */
export function parseWizXlsx(buffer: Buffer): WizParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return { findings: [], totalRows: 0, skippedRows: 0 };
  }
  const sheet = workbook.Sheets[sheetName];
  // Convert sheet to CSV — reuses existing CSV parser for all field logic
  const csv = XLSX.utils.sheet_to_csv(sheet, { FS: ",", RS: "\n" });
  logger.info(
    { sheetName, rows: csv.split("\n").length },
    "Wiz xlsx converted to CSV for parsing",
  );
  return parseWizCsv(csv);
}

/**
 * Stream-parse a Wiz xlsx from a fetch Response.
 * Buffers the full response (xlsx files are typically <10MB) then delegates
 * to parseWizXlsx(). Not streaming in the true sense but named consistently.
 */
export async function parseWizXlsxStream(
  response: Response,
): Promise<WizParseResult> {
  const arrayBuffer = await response.arrayBuffer();
  return parseWizXlsx(Buffer.from(arrayBuffer));
}

function extractPackageName(locationPath: string, cveId: string): string {
  // Try to extract from path like: .../jackson-databind-2.9.9.jar
  const jarMatch = locationPath.match(/\/([a-z0-9._-]+)-\d+[\d.]*\.jar/i);
  if (jarMatch) return jarMatch[1];

  // Try Maven path: META-INF/maven/groupId/artifactId
  const mavenMatch = locationPath.match(/META-INF\/maven\/[^/]+\/([^/]+)\s*$/);
  if (mavenMatch) return mavenMatch[1];

  // Try package path segment before version
  const segments = locationPath.split("/");
  const last = segments[segments.length - 1] ?? "";
  if (last.endsWith(".jar")) return last.replace(/\.jar$/, "").split("-")[0];

  // Fall back to CVE ID
  return cveId;
}

function createPathBuckets(locationPath: string): TriagePathBucket[] {
  const profile = classifyLocationPath(locationPath);
  return [
    {
      disposition: profile.disposition,
      count: 1,
      examples: [locationPath],
    },
  ];
}

function mergeFindingPath(finding: TriageFinding, locationPath: string): void {
  if (!finding.locationPaths.includes(locationPath)) {
    finding.locationPaths.push(locationPath);
  }

  const profile = classifyLocationPath(locationPath);
  const existingBucket = finding.pathBuckets.find(
    (bucket) => bucket.disposition === profile.disposition,
  );

  if (existingBucket) {
    existingBucket.count++;
    if (
      existingBucket.examples.length < 5 &&
      !existingBucket.examples.includes(locationPath)
    ) {
      existingBucket.examples.push(locationPath);
    }
  } else {
    finding.pathBuckets.push({
      disposition: profile.disposition,
      count: 1,
      examples: [locationPath],
    });
  }

  if (shouldPreferPath(locationPath, finding.locationPath)) {
    finding.locationPath = locationPath;
  }
}

function shouldPreferPath(candidate: string, current: string): boolean {
  const candidateDisposition = classifyLocationPath(candidate).disposition;
  const currentDisposition = classifyLocationPath(current).disposition;
  if (
    candidateDisposition === "active-code-managed" &&
    currentDisposition !== "active-code-managed"
  ) {
    return true;
  }
  if (
    currentDisposition === "backup-archive" &&
    candidateDisposition !== "backup-archive"
  ) {
    return true;
  }
  return false;
}
