import * as path from "path";
import { createJiraClient } from "../../orchestrator/JiraClient.js";
import {
  DOCS_BLOCKED_LABEL,
  DOCS_FAILED_LABEL,
  DOCS_GENERATED_LABEL,
  DOCS_GENERATE_LABEL,
  DOCS_NOT_QUALIFIED_LABEL,
  DOCUMENTATION_DOCUMENT_TYPE_LABELS,
} from "../contracts.js";
import { getJiraConfig, runDocumentationArtifactForIssue } from "./generate.js";

interface DocumentationRunCliArgs {
  issueKeys: string[];
  runAll: boolean;
  limit: number;
  outputDir?: string;
  addJiraComment: boolean;
}

function parseArgs(argv: string[]): DocumentationRunCliArgs {
  const issueKeys: string[] = [];
  let runAll = false;
  let limit = 25;
  let outputDir: string | undefined;
  let addJiraComment = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]?.trim();
    if (!arg) continue;

    if (arg === "--all") {
      runAll = true;
      continue;
    }
    if (arg === "--limit") {
      const rawLimit = argv[index + 1]?.trim();
      index += 1;
      const parsed = Number.parseInt(rawLimit ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--limit must be a positive integer.");
      }
      limit = parsed;
      continue;
    }
    if (arg === "--out") {
      outputDir = path.resolve(argv[index + 1]?.trim() ?? "");
      index += 1;
      continue;
    }
    if (arg === "--no-jira-comment") {
      addJiraComment = false;
      continue;
    }
    if (!arg.startsWith("--")) {
      issueKeys.push(arg.toUpperCase());
    }
  }

  if (!runAll && issueKeys.length === 0) {
    throw new Error(
      [
        "Usage:",
        "  npm run oneshot:docs:run -- JIRA-123 [JIRA-456] [--out /path/to/output] [--no-jira-comment]",
        "  npm run oneshot:docs:run-all -- [--limit 25] [--out /path/to/output] [--no-jira-comment]",
      ].join("\n"),
    );
  }

  return {
    issueKeys,
    runAll,
    limit,
    outputDir,
    addJiraComment,
  };
}

async function findQueuedDocumentationIssues(limit: number): Promise<string[]> {
  const jiraConfig = getJiraConfig();
  const jiraClient = createJiraClient({
    ...jiraConfig,
    downloadImages: false,
  });
  const terminalLabels = [
    DOCS_GENERATED_LABEL,
    DOCS_NOT_QUALIFIED_LABEL,
    DOCS_BLOCKED_LABEL,
    DOCS_FAILED_LABEL,
  ];
  const jql =
    `labels = "${DOCS_GENERATE_LABEL}" ` +
    `AND labels in (${DOCUMENTATION_DOCUMENT_TYPE_LABELS.map((label) => `"${label}"`).join(", ")}) ` +
    `AND labels not in (${terminalLabels.map((label) => `"${label}"`).join(", ")}) ` +
    "ORDER BY updated ASC";
  const result = await jiraClient.searchIssues(
    jql,
    "key,summary,labels",
    limit,
  );
  return result.issues.slice(0, limit).map((issue) => issue.key);
}

function outputDirForIssue(
  baseOutputDir: string | undefined,
  issueKey: string,
  issueCount: number,
): string | undefined {
  if (!baseOutputDir) {
    return undefined;
  }
  return issueCount === 1 ? baseOutputDir : path.join(baseOutputDir, issueKey);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const issueKeys = args.runAll
    ? await findQueuedDocumentationIssues(args.limit)
    : args.issueKeys;

  if (issueKeys.length === 0) {
    console.log("No queued documentation artifact tickets found.");
    return;
  }

  console.log(
    `Running OneShot documentation artifacts for ${issueKeys.length} ticket(s).`,
  );

  let failed = 0;
  for (const issueKey of issueKeys) {
    try {
      const result = await runDocumentationArtifactForIssue({
        issueKey,
        outputDir: outputDirForIssue(
          args.outputDir,
          issueKey,
          issueKeys.length,
        ),
        attachToJira: true,
        addJiraComment: args.addJiraComment,
      });

      const attachmentStatus = result.attachmentResult?.mutationsDisabled
        ? "mutation guard skipped Jira writes"
        : `attached ${result.attachmentResult?.filenames.length ?? 0} file(s)`;
      console.log(
        `${issueKey}: ${result.documentTypeLabel}; ${attachmentStatus}; markdown ${result.markdownPath}`,
      );
    } catch (error) {
      failed += 1;
      console.error(
        `${issueKey}: failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failed > 0) {
    throw new Error(
      `OneShot documentation run failed for ${failed} ticket(s).`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
