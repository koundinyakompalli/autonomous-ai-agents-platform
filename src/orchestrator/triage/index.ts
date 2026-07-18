/**
 * TRIAGE agent entry point
 *
 * Exports the Harvey command handler and the core engine.
 * The Harvey /triage command is registered in TeamsBot.ts.
 */

export { runTriage } from "./engine.js";
export type { TriageOptions, TriageResult } from "./types.js";

import { createLogger } from "../../utils/logger.js";
import type { JiraClient } from "../JiraClient.js";
import type { Database } from "../database.js";
import { runTriage } from "./engine.js";
import type { TriageOptions } from "./types.js";

const logger = createLogger("triage");

/**
 * Handle the Harvey /triage command.
 *
 * Syntax:
 *   /triage CPDEV-XXXXX
 *   /triage CPDEV-XXXXX --apply
 *   /triage CPDEV-XXXXX --dry-run
 *   /triage CPDEV-XXXXX --force
 *   /triage CPDEV-XXXXX --source wiz
 *
 * Returns a summary string to send back in Teams.
 */
export async function handleTriageCommand(
  text: string,
  jiraClient: JiraClient,
  db: Database,
): Promise<string> {
  const parts = text.trim().split(/\s+/);

  // Extract epic key (must be a Jira key like CPDEV-12345)
  const epicKey = parts.find((p) => /^[A-Z]+-\d+$/.test(p));
  if (!epicKey) {
    return (
      "Usage: `/triage CPDEV-XXXXX` — provide a valid Jira EPIC key.\n\n" +
      "Options:\n" +
      "  `--apply`   — create approved grouped tickets\n" +
      "  `--dry-run` — preview grouped tickets without creating them\n" +
      "  `--force`   — re-triage even if PFOS stories already exist\n" +
      "  `--source wiz|snyk|sonar` — override auto-detection"
    );
  }

  const dryRun = parts.includes("--dry-run");
  const mode: TriageOptions["mode"] =
    parts.includes("--apply") || parts.includes("--create-tickets")
      ? "apply"
      : "analyze";
  const force = parts.includes("--force");
  const sourceIdx = parts.indexOf("--source");
  const sourceOverride =
    sourceIdx >= 0 && parts[sourceIdx + 1]
      ? (parts[sourceIdx + 1] as TriageOptions["sourceOverride"])
      : undefined;

  const options: TriageOptions = {
    epicKey,
    mode,
    dryRun,
    force,
    sourceOverride,
  };

  logger.info(
    { epicKey, mode, dryRun, force, sourceOverride },
    "Harvey /triage command received",
  );

  try {
    const result = await runTriage(jiraClient, db, options);

    const lines = [
      dryRun
        ? "**[DRY RUN] TRIAGE analysis complete** — no Jira mutations made."
        : result.mode === "analyze"
          ? "**TRIAGE analysis complete** — no stories created."
          : "✅ **TRIAGE apply complete**",
      "",
      `**Epic:** ${epicKey}`,
      `**Source:** ${result.source.toUpperCase()}`,
      `**Team A candidates** (OneShot pipeline): ${result.teamAStoryCandidates}`,
      result.mode === "apply"
        ? `**Team A stories created:** ${result.teamAStories.length}`
        : "",
      result.teamAStories.length > 0
        ? result.teamAStories.map((k) => `  • ${k}`).join("\n")
        : "",
      `**Team B/C/D candidates** (human execution): ${result.teamBCDStoryCandidates}`,
      result.mode === "apply"
        ? `**Team B/C/D stories created:** ${result.teamBCDStories.length}`
        : "",
      `**Backup/archive cleanup candidates** (DevOps): ${result.backupCleanupStoryCandidates}`,
      result.mode === "apply"
        ? `**Backup/archive cleanup stories created:** ${result.backupCleanupStories.length}`
        : "",
      `**Held for human review** (no tickets): ${result.reviewNeededStoryCandidates}`,
      result.suppressedFindings > 0
        ? `**Suppressed findings:** ${result.suppressedFindings}`
        : "",
      result.needsReviewFindings > 0
        ? `**Needs review findings:** ${result.needsReviewFindings}`
        : "",
      result.skippedNonMaven > 0
        ? `**Skipped** (pip/Gradle, v1 not supported): ${result.skippedNonMaven}`
        : "",
      "",
      dryRun
        ? "Dry run completed; no Jira comments, labels, stories, or task rows were created."
        : result.mode === "analyze"
          ? `Full grouped analysis posted on the EPIC. Add \`${result.source.toUpperCase()}-SCAN-APPROVED\` to create tickets.`
          : "Full summary posted as comment on the EPIC.",
    ]
      .filter((l) => l !== "")
      .join("\n");

    return lines;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ epicKey, error: msg }, "TRIAGE command failed");
    return `❌ **TRIAGE failed for ${epicKey}**\n\n${msg}\n\nSee the EPIC comment for details.`;
  }
}
