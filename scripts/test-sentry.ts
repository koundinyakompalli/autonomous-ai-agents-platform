#!/usr/bin/env npx tsx
/**
 * Test script for SENTRY - Safety & Execution eNtry Risk analYzer
 *
 * Usage:
 *   npx tsx scripts/test-sentry.ts --jira <JIRA-KEY> --repo <REPO-PATH>
 *   npx tsx scripts/test-sentry.ts --sql "UPDATE ..." --repo <REPO-PATH>
 *
 * Options:
 *   --jira <KEY>    Fetch ticket from JIRA and run full review
 *   --sql  <SQL>    Run review against inline SQL (no JIRA needed)
 *   --repo <PATH>   Path to repository (default: REPOSITORY_PATH env var)
 *   --hints <TEXT>  Optional repo hints for HBM model lookup
 *
 * Environment variables:
 *   REPOSITORY_PATH       - Default repository path (core-app)
 *   CLAUDE_CODE_USE_BEDROCK=1
 *   AWS_REGION            - AWS region for Bedrock
 *   ANTHROPIC_MODEL       - Claude model ID
 *   JIRA_BASE_URL         - Required for --jira mode
 *   JIRA_USERNAME         - Required for --jira mode
 *   JIRA_TOKEN            - Required for --jira mode
 *
 * Examples:
 *   npx tsx scripts/test-sentry.ts --jira CPSUP-36678 --repo /path/to/core-app
 *   npx tsx scripts/test-sentry.ts --sql "UPDATE member_eligibility SET termdate='2026-01-01' WHERE id='5346141'" --repo /path/to/core-app
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { SENTRYAgent } from "../src/agents/sentry/index.js";
import { createJiraClient } from "../src/orchestrator/JiraClient.js";
import { TaskDescriptionGenerator } from "../src/orchestrator/TaskDescriptionGenerator.js";

// =============================================================================
// Helpers
// =============================================================================

function getArg(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

// =============================================================================
// Test Suite
// =============================================================================

interface TestCase {
  name: string;
  sql: string;
  expected: {
    valid_syntax: boolean;
    decision: string;
    risk_level?: string;
    has_where_clause?: boolean;
  };
}

const TEST_CASES: TestCase[] = [
  {
    name: "Malformed WHERE - only value in parentheses (CPSUP-37622 regression)",
    sql: "UPDATE medhok.member_eligibility SET termdate = '2026-01-01' WHERE ('5346141');",
    expected: {
      valid_syntax: false,
      decision: "DO NOT EXECUTE",
      risk_level: "CRITICAL",
      has_where_clause: false,
    },
  },
  {
    name: "Malformed WHERE - value without column (numeric)",
    sql: "UPDATE member_eligibility SET status = 'closed' WHERE (12345);",
    expected: {
      valid_syntax: false,
      decision: "DO NOT EXECUTE",
      risk_level: "CRITICAL",
      has_where_clause: false,
    },
  },
  {
    name: "Malformed WHERE - only column name, no operator",
    sql: "DELETE FROM cases WHERE status;",
    expected: {
      valid_syntax: false,
      decision: "DO NOT EXECUTE",
      risk_level: "CRITICAL",
    },
  },
  {
    name: "Valid WHERE - column with operator and value",
    sql: "UPDATE member_eligibility SET termdate = '2026-01-01' WHERE id = '5346141';",
    expected: {
      valid_syntax: true,
      has_where_clause: true,
      decision: "SAFE TO EXECUTE", // or EXECUTE WITH CONDITIONS depending on other checks
    },
  },
  {
    name: "Valid WHERE - IN clause with multiple values",
    sql: "UPDATE cases SET status = 'closed' WHERE id IN ('123', '456', '789');",
    expected: {
      valid_syntax: true,
      has_where_clause: true,
      decision: "SAFE TO EXECUTE",
    },
  },
  {
    name: "Valid WHERE - parentheses around valid expression",
    sql: "UPDATE cases SET status = 'active' WHERE (id = '123' AND status = 'pending');",
    expected: {
      valid_syntax: true,
      has_where_clause: true,
      decision: "SAFE TO EXECUTE",
    },
  },
  {
    name: "Invalid SQL - unbalanced quotes",
    sql: "UPDATE member_eligibility SET termdate = '2026-01-01 WHERE id = '5346141';",
    expected: {
      valid_syntax: false,
      decision: "DO NOT EXECUTE",
      risk_level: "CRITICAL",
    },
  },
  {
    name: "Invalid SQL - missing table name",
    sql: "UPDATE SET termdate = '2026-01-01' WHERE id = '5346141';",
    expected: {
      valid_syntax: false,
      decision: "DO NOT EXECUTE",
      risk_level: "CRITICAL",
    },
  },
  {
    name: "Invalid SQL - typo in keyword",
    sql: "UPDTE member_eligibility SET termdate = '2026-01-01' WHERE id = '5346141';",
    expected: {
      valid_syntax: false,
      decision: "DO NOT EXECUTE",
      risk_level: "CRITICAL",
    },
  },
  {
    name: "Valid WHERE - IS NULL check",
    sql: "UPDATE cases SET status = 'closed' WHERE termdate IS NULL;",
    expected: {
      valid_syntax: true,
      has_where_clause: true,
      decision: "SAFE TO EXECUTE",
    },
  },
];

async function runTestSuite(repoPath: string) {
  console.log("\n🧪 Running SENTRY SQL Syntax Validation Test Suite\n");
  console.log("=".repeat(70));

  let passed = 0;
  let failed = 0;
  const failures: { test: string; reason: string }[] = [];

  for (const testCase of TEST_CASES) {
    console.log(`\n📋 Test: ${testCase.name}`);
    console.log(`   SQL: ${testCase.sql.substring(0, 80)}...`);

    const agent = new SENTRYAgent({
      repositoryPath: repoPath,
      onProgress: () => {}, // Silent during tests
    });

    // Build minimal ticket text
    const ticketText = [
      "# Test Ticket",
      "",
      "## SQL to Execute",
      "```sql",
      testCase.sql,
      "```",
      "",
      "## Justification",
      "Automated test case",
    ].join("\n");

    try {
      const result = await agent.review(ticketText);

      if (!result.success || !result.structured) {
        console.log("   ❌ FAIL: Review failed or no structured output");
        failed++;
        failures.push({ test: testCase.name, reason: "Review failed" });
        continue;
      }

      const syntax = result.structured.mysql_syntax;
      const decision = result.structured.risk_decision;
      const safetyGates = result.structured.safety_gates;

      // Check valid_syntax
      if (syntax?.valid_syntax !== testCase.expected.valid_syntax) {
        console.log(
          `   ❌ FAIL: Expected valid_syntax=${testCase.expected.valid_syntax}, got ${syntax?.valid_syntax}`,
        );
        failed++;
        failures.push({
          test: testCase.name,
          reason: `valid_syntax mismatch: expected ${testCase.expected.valid_syntax}, got ${syntax?.valid_syntax}`,
        });
        continue;
      }

      // Check decision
      if (decision?.decision !== testCase.expected.decision) {
        // For valid syntax cases, accept either SAFE TO EXECUTE or EXECUTE WITH CONDITIONS
        const isValidDecision =
          testCase.expected.valid_syntax &&
          (decision?.decision === "SAFE TO EXECUTE" ||
            decision?.decision === "EXECUTE WITH CONDITIONS");

        if (!isValidDecision) {
          console.log(
            `   ❌ FAIL: Expected decision="${testCase.expected.decision}", got "${decision?.decision}"`,
          );
          failed++;
          failures.push({
            test: testCase.name,
            reason: `decision mismatch: expected ${testCase.expected.decision}, got ${decision?.decision}`,
          });
          continue;
        }
      }

      // Check risk_level if specified
      if (
        testCase.expected.risk_level &&
        decision?.risk_level !== testCase.expected.risk_level
      ) {
        console.log(
          `   ❌ FAIL: Expected risk_level="${testCase.expected.risk_level}", got "${decision?.risk_level}"`,
        );
        failed++;
        failures.push({
          test: testCase.name,
          reason: `risk_level mismatch: expected ${testCase.expected.risk_level}, got ${decision?.risk_level}`,
        });
        continue;
      }

      // Check has_where_clause if specified
      if (
        testCase.expected.has_where_clause !== undefined &&
        safetyGates?.has_where_clause !== testCase.expected.has_where_clause
      ) {
        console.log(
          `   ❌ FAIL: Expected has_where_clause=${testCase.expected.has_where_clause}, got ${safetyGates?.has_where_clause}`,
        );
        failed++;
        failures.push({
          test: testCase.name,
          reason: `has_where_clause mismatch: expected ${testCase.expected.has_where_clause}, got ${safetyGates?.has_where_clause}`,
        });
        continue;
      }

      console.log("   ✅ PASS");
      passed++;
    } catch (err) {
      console.log(
        `   ❌ FAIL: Exception - ${err instanceof Error ? err.message : "Unknown error"}`,
      );
      failed++;
      failures.push({ test: testCase.name, reason: `Exception: ${err}` });
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log(
    `\n📊 Test Results: ${passed}/${TEST_CASES.length} passed, ${failed} failed`,
  );

  if (failures.length > 0) {
    console.log("\n❌ Failed tests:");
    failures.forEach((f) => console.log(`   - ${f.test}: ${f.reason}`));
    process.exit(1);
  } else {
    console.log("\n✅ All tests passed!");
    process.exit(0);
  }
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || hasFlag("--help") || hasFlag("-h")) {
    console.log(`
Usage: npx tsx scripts/test-sentry.ts [options]

Options:
  --run-tests     Run the full WHERE clause validation test suite
  --jira <KEY>    Fetch ticket from JIRA and run full review
  --sql  <SQL>    Run review against inline SQL (wraps in a minimal ticket)
  --repo <PATH>   Path to repository with HBM models (default: REPOSITORY_PATH env)
  --hints <TEXT>  Optional hints for HBM model lookup (e.g. "PatientCase")

Environment variables required:
  CLAUDE_CODE_USE_BEDROCK=1
  AWS_REGION
  ANTHROPIC_MODEL
  REPOSITORY_PATH  (or use --repo)

For --jira mode also requires:
  JIRA_BASE_URL, JIRA_USERNAME, JIRA_TOKEN

Examples:
  npx tsx scripts/test-sentry.ts --run-tests --repo /path/to/core-app
  npx tsx scripts/test-sentry.ts --jira CPSUP-36678 --repo /path/to/core-app
  npx tsx scripts/test-sentry.ts --sql "UPDATE member_eligibility SET termdate='2026-01-01' WHERE id='5346141'" --repo /path/to/core-app
`);
    process.exit(0);
  }

  const runTests = hasFlag("--run-tests");
  const jiraKey = getArg("--jira");
  const inlineSql = getArg("--sql");
  const repoPath = getArg("--repo") ?? process.env.REPOSITORY_PATH;
  const hints = getArg("--hints");

  // If running test suite, execute it and exit
  if (runTests) {
    if (!repoPath) {
      console.error("❌ Provide --repo <PATH> or set REPOSITORY_PATH env var");
      process.exit(1);
    }
    if (!fs.existsSync(repoPath)) {
      console.error(`❌ Repository path does not exist: ${repoPath}`);
      process.exit(1);
    }
    await runTestSuite(repoPath);
    return;
  }

  if (!jiraKey && !inlineSql) {
    console.error('❌ Provide either --jira <KEY> or --sql "<SQL>"');
    process.exit(1);
  }

  if (!repoPath) {
    console.error("❌ Provide --repo <PATH> or set REPOSITORY_PATH env var");
    process.exit(1);
  }

  if (!fs.existsSync(repoPath)) {
    console.error(`❌ Repository path does not exist: ${repoPath}`);
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // Build ticket text
  // ------------------------------------------------------------------
  let ticketText: string;
  let label: string;

  if (jiraKey) {
    console.log(`\n🎫 Fetching JIRA ticket: ${jiraKey}`);
    const jiraBaseUrl = requireEnv("JIRA_BASE_URL");
    const jiraUsername = requireEnv("JIRA_USERNAME");
    const jiraToken = requireEnv("JIRA_TOKEN");

    const generator = new TaskDescriptionGenerator({
      jiraBaseUrl,
      jiraUsername,
      jiraToken,
      awsRegion: process.env.AWS_REGION ?? "us-east-1",
    });

    try {
      ticketText = await generator.generateFromTicketKey(jiraKey, jiraToken);
      console.log(`✅ Ticket fetched (${ticketText.length} chars)\n`);
    } catch (err) {
      // Fallback: fetch raw description without LLM
      console.warn(
        `⚠️  LLM generation failed, falling back to raw ticket data\n`,
      );
      const client = createJiraClient({
        baseUrl: jiraBaseUrl,
        username: jiraUsername,
        token: jiraToken,
      });
      const data = await client.fetchTicketData(jiraKey);
      ticketText = [
        `# ${jiraKey}: ${data.issue.fields.summary}`,
        "",
        data.descriptionMarkdown ?? "(No description)",
        "",
        ...data.textAttachments
          .filter((t) => t.filename.toLowerCase().endsWith(".sql"))
          .map((t) => `## SQL Attachments\n\`\`\`sql\n${t.content}\n\`\`\``),
      ].join("\n");
    }

    label = jiraKey;
  } else {
    // Wrap inline SQL in a minimal ticket template SENTRY understands
    ticketText = [
      "# MySQL Execution Ticket (inline test)",
      "",
      "## SQL to Execute",
      "```sql",
      inlineSql,
      "```",
      "",
      "## Rollback SQL",
      "(not provided)",
      "",
      "## Expected Rows Affected",
      "(not provided)",
      "",
      "## Justification",
      "Manual test via test-sentry.ts script",
      "",
      "## Verification Queries",
      "(not provided)",
    ].join("\n");

    label = "inline-sql";
    console.log(`\n🧪 Running inline SQL test\n`);
  }

  // ------------------------------------------------------------------
  // Run SENTRY review
  // ------------------------------------------------------------------
  console.log(`🛡️  Starting SENTRY review...`);
  console.log(`📁 Repository: ${repoPath}`);
  if (hints) console.log(`💡 Hints: ${hints}`);
  console.log("");

  const agent = new SENTRYAgent({
    repositoryPath: repoPath,
    onProgress: (msg) => process.stdout.write(`   ⏳ ${msg}\n`),
  });

  const startTime = Date.now();
  const result = await agent.review(ticketText, hints);
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

  // ------------------------------------------------------------------
  // Print results
  // ------------------------------------------------------------------
  console.log("\n" + "─".repeat(60));

  if (!result.success) {
    console.error(`\n❌ Review failed: ${result.error}`);
    process.exit(1);
  }

  const decision =
    result.structured?.risk_decision?.decision ?? "NOT DETERMINED";
  const riskLevel = result.structured?.risk_decision?.risk_level ?? "?";
  const checkItems =
    result.structured?.checklist?.flatMap((c) => c.items) ?? [];
  const passCount = checkItems.filter((i) => i.status === "PASS").length;
  const failCount = checkItems.filter((i) => i.status === "FAIL").length;

  console.log(`\n✅ Review complete in ${durationSec}s`);
  console.log(`   Decision  : ${decision}`);
  console.log(`   Risk      : ${riskLevel}`);
  console.log(`   Checks    : ${passCount} passed, ${failCount} failed`);
  console.log(`   Tool calls: ${result.metrics.toolCalls}`);
  if (result.metrics.costUsd)
    console.log(`   Cost      : $${result.metrics.costUsd.toFixed(4)}`);
  console.log("");

  // Full formatted report
  console.log("─".repeat(60));
  console.log(result.review);
  console.log("─".repeat(60));

  // Structured JSON (useful for debugging)
  if (result.structured) {
    console.log("\n📊 Structured Output (JSON):");
    console.log(JSON.stringify(result.structured, null, 2));
  } else {
    console.warn("\n⚠️  structured output was undefined — JSON parsing failed");
  }

  // Write output file
  const outDir = path.resolve(process.cwd(), "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `sentry-${label}-${Date.now()}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify({ ticketText, result }, null, 2),
    "utf8",
  );
  console.log(`\n💾 Full result saved to: ${outFile}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
