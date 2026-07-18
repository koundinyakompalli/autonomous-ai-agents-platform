#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const zeroRef = /^0{40}$/;

const governancePaths = [
  "meridian/backend",
  "src/investigation",
  "src/orchestrator/workers/MERIDIANWorker.ts",
  "dashboard/server/services",
  "dashboard/server/routes",
  "db/migrations",
  "AI_GOVERNANCE_COMPLIANCE.md",
  "docs/01-GETTING-STARTED.md",
  "docs/MERIDIAN_INVESTIGATION_COCKPIT_ARCHITECTURE.md",
  "scripts/governance-controls.test.ts",
  "scripts/governance-diff.mjs",
  ".github/workflows/governance-controls.yml",
  ".github/workflows/governance-promotion-check.yml",
];

function usage() {
  console.error("Usage: node scripts/governance-diff.mjs <last-approved-ref> <candidate-ref>");
  console.error("Set GOVERNANCE_DIFF_REQUIRE_EMPTY=true to fail when governed paths changed.");
}

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout || "";
}

function tryGit(args) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0 ? (result.stdout || "").trim() : undefined;
}

function resolveBaselineRef(lastApprovedRef, candidateRef) {
  if (!zeroRef.test(lastApprovedRef)) {
    return lastApprovedRef;
  }

  const parent = tryGit(["rev-parse", "--verify", `${candidateRef}^1^{commit}`]);
  if (parent) {
    console.log(`Branch creation detected; comparing candidate with first parent ${parent}.`);
    return parent;
  }

  const emptyTree = runGit(["hash-object", "-t", "tree", "/dev/null"]).trim();
  console.log(`Root branch creation detected; comparing candidate with empty tree ${emptyTree}.`);
  return emptyTree;
}

const [, , lastApprovedRef, candidateRef] = process.argv;
if (!lastApprovedRef || !candidateRef) {
  usage();
  process.exit(2);
}

try {
  runGit(["rev-parse", "--verify", `${candidateRef}^{commit}`]);
  const baselineRef = resolveBaselineRef(lastApprovedRef, candidateRef);
  if (!zeroRef.test(lastApprovedRef)) {
    runGit(["rev-parse", "--verify", `${baselineRef}^{commit}`]);
  }

  const args = [
    "diff",
    "--name-status",
    "--find-renames",
    `${baselineRef}..${candidateRef}`,
    "--",
    ...governancePaths,
  ];
  const diff = runGit(args).trim();
  if (!diff) {
    console.log(`No governance-scoped changes between ${baselineRef} and ${candidateRef}.`);
    process.exit(0);
  }

  console.log(`Governance-scoped changes between ${baselineRef} and ${candidateRef}:`);
  console.log(diff);
  console.log("");
  console.log("Governance review required before promoting onto a release branch.");

  if (/^(1|true|yes|on)$/i.test(process.env.GOVERNANCE_DIFF_REQUIRE_EMPTY || "")) {
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
