/**
 * Standalone dry-run for the Wiz Code (SAST) parser.
 *
 * Parses a Wiz SAST CSV, routes every finding to Team A (pushed into OneShot
 * via PFOS), and prints the grouped story preview. NO Jira / DB / S3 mutations.
 *
 * Usage: tsx src/orchestrator/triage/parsers/wiz-code.dryrun.ts <path-to-csv> [EPIC-KEY]
 */

import { readFileSync } from "node:fs";
import { parseWizCodeCsv, isWizCodeCsv } from "./wiz-code.js";
import { groupWizCodeStories } from "../engine.js";

const csvPath = process.argv[2];
const epicKey = process.argv[3] ?? "CPDEV-XXXXX";
if (!csvPath) {
  console.error("Usage: tsx wiz-code.dryrun.ts <path-to-csv> [EPIC-KEY]");
  process.exit(1);
}

const content = readFileSync(csvPath, "utf-8");

console.log("=".repeat(72));
console.log("  Wiz Code (SAST) TRIAGE — DRY RUN (no Jira/DB mutations)");
console.log("=".repeat(72));
console.log(`CSV: ${csvPath}`);
console.log(`Detected as Wiz-Code SAST export: ${isWizCodeCsv(content)}`);

const { findings, totalRows, skippedRows } = parseWizCodeCsv(content);
console.log(
  `Parsed: ${totalRows} data rows → ${findings.length} OPEN findings (${skippedRows} skipped)\n`,
);

// Every SAST finding is a code issue → Team A (pushed into OneShot via PFOS). Build the real
// OneShot-format stories via the engine so the preview matches production.
const stories = groupWizCodeStories(findings, epicKey);

console.log("─".repeat(72));
console.log(`TEAM A STORY CANDIDATES (PFOS → OneShot): ${stories.length}`);
console.log("─".repeat(72));

stories
  .sort((a, b) => b.findingCount - a.findingCount)
  .forEach((story, i) => {
    console.log(`\n${"━".repeat(72)}`);
    console.log(`STORY ${i + 1}: ${story.title}`);
    console.log(
      `severity: ${story.severity} | findings: ${story.findingCount} | queueForOneShot: ${story.queueForOneShot}`,
    );
    console.log(`${"─".repeat(72)}\n`);
    console.log(story.description);
  });

console.log("\n" + "=".repeat(72));
console.log("  SUMMARY");
console.log("=".repeat(72));
console.log(`  Team A stories (PFOS → OneShot):  ${stories.length}`);
console.log(`  Findings routed to Team A:        ${findings.length}`);
console.log(`  Total OPEN findings:              ${findings.length}`);
console.log(
  "\n  Dry run only — no Jira/DB mutations. On apply, these are created with PFOS and queued into OneShot.",
);
