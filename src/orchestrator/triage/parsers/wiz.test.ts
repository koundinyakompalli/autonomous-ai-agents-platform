import { describe, expect, it } from "vitest";
import { parseWizCsv, parseWizCsvStream } from "./wiz.js";

describe("parseWizCsv", () => {
  it("parses quoted multiline Wiz fields as one logical record", () => {
    const header = [
      "Name",
      "CVEDescription",
      "CVSSSeverity",
      "HasExploit",
      "HasCisaKevExploit",
      "DetectionMethod",
      "LocationPath",
      "DetailedName",
      "Version",
      "FixedVersion",
      "Remediation",
      "FirstDetected",
      "AssetID",
      "AssetName",
    ].join(",");
    const csv = [
      header,
      [
        "CVE-2022-23305",
        '"Line one\nLine two, with comma and ""quoted"" text"',
        "Critical",
        "TRUE",
        "FALSE",
        "FilePath",
        "/opt/software/medhok/medhok-web-services/WEB-INF/lib/log4j-1.2.14.jar",
        "log4j",
        "1.2.14",
        "2.17.2",
        '"Upgrade Log4j\nVerify appenders"',
        "2026-06-15",
        "asset-1",
        "MedHOK QA 1",
      ].join(","),
      [
        "CVE-2022-23305",
        "Single line description",
        "Critical",
        "TRUE",
        "FALSE",
        "FilePath",
        "/opt/software/medhok/medhok-web-services/WEB-INF/lib/log4j-1.2.14.jar",
        "log4j",
        "1.2.14",
        "2.17.2",
        "Upgrade Log4j",
        "2026-06-15",
        "asset-2",
        "MEDHOK CP RUD1",
      ].join(","),
    ].join("\n");

    const parsed = parseWizCsv(csv);

    expect(parsed.totalRows).toBe(2);
    expect(parsed.skippedRows).toBe(0);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.cveId).toBe("CVE-2022-23305");
    expect(parsed.findings[0]?.packageName).toBe("log4j");
    expect(parsed.findings[0]?.rawCount).toBe(2);
    expect(parsed.findings[0]?.assetCount).toBe(2);
    expect(parsed.findings[0]?.locationPath).toBe(
      "/opt/software/medhok/medhok-web-services/WEB-INF/lib/log4j-1.2.14.jar",
    );
  });

  it("stream-parses quoted multiline Wiz fields as one logical record", async () => {
    const csv = [
      [
        "Name",
        "CVEDescription",
        "CVSSSeverity",
        "HasExploit",
        "HasCisaKevExploit",
        "DetectionMethod",
        "LocationPath",
        "Version",
        "FixedVersion",
        "Remediation",
        "FirstDetected",
        "AssetID",
      ].join(","),
      [
        "CVE-2025-66516",
        '"Line one\nLine two, with comma"',
        "Critical",
        "TRUE",
        "FALSE",
        "FilePath",
        "/opt/software/medhok/MedicalMgmt/WEB-INF/lib/tika-core-1.18.jar",
        "1.18",
        "3.2.3",
        '"Upgrade Apache Tika\nRetest XML parsing"',
        "2026-06-15",
        "asset-1",
      ].join(","),
    ].join("\n");

    const parsed = await parseWizCsvStream(new Response(csv));

    expect(parsed.totalRows).toBe(1);
    expect(parsed.skippedRows).toBe(0);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.cveId).toBe("CVE-2025-66516");
    expect(parsed.findings[0]?.packageName).toBe("tika-core");
  });

  it("keeps advisory rows with DetailedName when LocationPath is empty", () => {
    const csv = [
      [
        "Name",
        "CVSSSeverity",
        "HasExploit",
        "HasCisaKevExploit",
        "DetectionMethod",
        "LocationPath",
        "DetailedName",
        "Version",
        "FixedVersion",
        "Remediation",
        "FirstDetected",
        "AssetID",
        "AssetName",
      ].join(","),
      [
        "CVE-2025-40909",
        "High",
        "FALSE",
        "FALSE",
        "Package",
        "",
        "kernel",
        "5.10",
        "",
        "Upgrade kernel packages",
        "2026-06-15",
        "asset-1",
        "MedHOK QA 1",
      ].join(","),
    ].join("\n");

    const parsed = parseWizCsv(csv);

    expect(parsed.totalRows).toBe(1);
    expect(parsed.skippedRows).toBe(0);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]?.locationPath).toBe(
      "/advisory/kernel@MedHOK QA 1",
    );
  });

  it("segregates active and backup paths before team grouping", () => {
    const csv = [
      [
        "Name",
        "CVSSSeverity",
        "HasExploit",
        "HasCisaKevExploit",
        "DetectionMethod",
        "LocationPath",
        "Version",
        "FixedVersion",
        "Remediation",
        "FirstDetected",
        "AssetID",
      ].join(","),
      [
        "CVE-2025-30474",
        "High",
        "FALSE",
        "FALSE",
        "FilePath",
        "/software/cms-processor/lib_bckp/commons-vfs2-2.2.jar",
        "2.2",
        "2.10.0",
        "Upgrade package",
        "2026-05-18",
        "asset-1",
      ].join(","),
      [
        "CVE-2025-30474",
        "High",
        "FALSE",
        "FALSE",
        "FilePath",
        "/software/cms-processor/lib/commons-vfs2-2.2.jar",
        "2.2",
        "2.10.0",
        "Upgrade package",
        "2026-05-18",
        "asset-1",
      ].join(","),
    ].join("\n");

    const parsed = parseWizCsv(csv);

    expect(parsed.findings).toHaveLength(2);

    const backup = parsed.findings.find(
      (finding) => finding.pathBuckets[0]?.disposition === "backup-archive",
    );
    const active = parsed.findings.find(
      (finding) =>
        finding.pathBuckets[0]?.disposition === "active-code-managed",
    );

    expect(backup?.rawCount).toBe(1);
    expect(backup?.locationPath).toBe(
      "/software/cms-processor/lib_bckp/commons-vfs2-2.2.jar",
    );
    expect(active?.rawCount).toBe(1);
    expect(active?.locationPath).toBe(
      "/software/cms-processor/lib/commons-vfs2-2.2.jar",
    );
  });
});
