import { pathToFileURL } from "node:url";
import {
  getDatabase,
  initDatabase,
} from "../../orchestrator/database.js";
import {
  OneShotService,
  type RecoverPlanningHandoffResult,
} from "../service.js";

type RecoverFn = (input: {
  runId: number;
  operatorId: string;
  operatorName: string;
  reason?: string;
}) => Promise<RecoverPlanningHandoffResult>;

type Writer = {
  write(text: string): void;
};

type ParsedArgs =
  | { kind: "help" }
  | {
      kind: "run";
      runId: number;
      dashboardId: string;
      operatorId: string;
      operatorName: string;
      reason?: string;
    };

function usageText(): string {
  return [
    "Usage:",
    '  npm run oneshot:recover-planning-handoff -- --dashboard-id run-380 --operator-id <id> --operator-name "<name>" [--reason "..."]',
    '  npm run oneshot:recover-planning-handoff -- --run 380 --operator-id <id> --operator-name "<name>" [--reason "..."]',
    "",
    "Notes:",
    "  - Accepts only run-* rows that failed during qualification-to-planning handoff.",
    "  - qualifier-task-* rows and ticket-quality/no-action outcomes are not recoverable here.",
  ].join("\n");
}

function parseRunId(value: string): { runId: number; dashboardId: string } {
  const trimmed = value.trim();
  const numericMatch = /^(\d+)$/.exec(trimmed);
  const runMatch = /^run-(\d+)$/.exec(trimmed);
  if (/^qualifier-task-/i.test(trimmed)) {
    throw new Error("Only run-* rows can be recovered; qualifier-task-* rows are not supported");
  }

  const id = Number(numericMatch?.[1] ?? runMatch?.[1] ?? 0);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error("Missing or invalid --dashboard-id/--run value; expected run-<id>");
  }
  return { runId: id, dashboardId: `run-${id}` };
}

export function parseRecoverPlanningHandoffCliArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      return { kind: "help" };
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }
    values.set(token, value);
    index += 1;
  }

  const runValue = values.get("--dashboard-id") ?? values.get("--run");
  if (!runValue) {
    throw new Error("Missing required --dashboard-id or --run");
  }
  const { runId, dashboardId } = parseRunId(runValue);

  const operatorId = values.get("--operator-id")?.trim();
  if (!operatorId) {
    throw new Error("Missing required --operator-id");
  }
  const operatorName = values.get("--operator-name")?.trim();
  if (!operatorName) {
    throw new Error("Missing required --operator-name");
  }

  return {
    kind: "run",
    runId,
    dashboardId,
    operatorId,
    operatorName,
    reason: values.get("--reason")?.trim() || undefined,
  };
}

async function recoverWithOneShotService(input: {
  runId: number;
  operatorId: string;
  operatorName: string;
  reason?: string;
}): Promise<RecoverPlanningHandoffResult> {
  const db = await initDatabase();
  try {
    const service = new OneShotService(db);
    return await service.recoverPlanningHandoff(input);
  } finally {
    await getDatabase().disconnect();
  }
}

function formatResult(parsed: Extract<ParsedArgs, { kind: "run" }>, result: RecoverPlanningHandoffResult): string {
  return [
    "OneShot planning handoff recovery queued.",
    `Dashboard run: ${parsed.dashboardId}`,
    `Run ID: ${result.oneshotRunId}`,
    `Stage: ${result.stage}`,
    `Queued state: ${result.state}`,
    `Version: ${result.version}`,
    "Dispatch: safe_fifo",
    "",
  ].join("\n");
}

export async function runRecoverPlanningHandoffCli(
  argv: string[],
  deps: {
    recover?: RecoverFn;
    stdout?: Writer;
    stderr?: Writer;
  } = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  let parsed: ParsedArgs;

  try {
    parsed = parseRecoverPlanningHandoffCliArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usageText()}\n`);
    return 1;
  }

  if (parsed.kind === "help") {
    stdout.write(`${usageText()}\n`);
    return 0;
  }

  try {
    const recover = deps.recover ?? recoverWithOneShotService;
    const result = await recover({
      runId: parsed.runId,
      operatorId: parsed.operatorId,
      operatorName: parsed.operatorName,
      reason: parsed.reason,
    });
    stdout.write(formatResult(parsed, result));
    return 0;
  } catch (error) {
    stderr.write(
      `Failed to recover OneShot planning handoff: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    stderr.write(`${usageText()}\n`);
    return 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runRecoverPlanningHandoffCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
