import { pathToFileURL } from "node:url";
import { getDatabase, initDatabase } from "../../orchestrator/database.js";
import {
  ContextV4Backfill,
  type ContextV4BackfillReport,
  type ContextV4ReconcileReport,
} from "./context-v4-backfill.js";

type Writer = Pick<NodeJS.WriteStream, "write">;
type BackfillRunner = Pick<
  ContextV4Backfill,
  "run" | "reconcile" | "acceptRun"
>;
type BackfillResult = ContextV4BackfillReport | ContextV4ReconcileReport | void;

export async function runContextV4BackfillCli(
  argv: string[],
  deps: {
    connect?: () => Promise<void>;
    disconnect?: () => Promise<void>;
    createBackfill?: () => BackfillRunner;
    stdout?: Writer;
    stderr?: Writer;
    user?: string;
  } = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const connect = deps.connect ?? (async () => void (await initDatabase()));
  const disconnect =
    deps.disconnect ?? (async () => getDatabase().disconnect());
  const createBackfill = deps.createBackfill ?? (() => new ContextV4Backfill());

  try {
    await connect();
    const backfill = createBackfill();
    const dryRun = !argv.includes("--apply");
    const reconcile = argv.includes("--reconcile");
    const acceptArg = argv.find((value) => value.startsWith("--accept="));
    const noteArg = argv.find((value) => value.startsWith("--note="));
    const afterArg = argv.find((value) => value.startsWith("--after="));
    const batchArg = argv.find((value) => value.startsWith("--batch="));
    const user = deps.user ?? process.env.USER ?? "operator";

    const report: BackfillResult = acceptArg
      ? await backfill.acceptRun({
          repairRunId: Number(acceptArg.split("=")[1]),
          acceptedBy: user,
          note: noteArg?.slice("--note=".length) ?? null,
        })
      : reconcile
        ? await backfill.reconcile({
            limit: batchArg ? Number(batchArg.split("=")[1]) : undefined,
          })
        : await backfill.run({
            dryRun,
            requestedBy: user,
            afterSessionId: afterArg
              ? Number(afterArg.split("=")[1])
              : undefined,
            batchSize: batchArg ? Number(batchArg.split("=")[1]) : undefined,
          });

    stdout.write(`${JSON.stringify(report ?? { accepted: true }, null, 2)}\n`);
    return report && "failed" in report && Number(report.failed) > 0 ? 2 : 0;
  } catch (error) {
    stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return 1;
  } finally {
    try {
      await disconnect();
    } catch (error) {
      stderr.write(
        `Failed to disconnect database: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  runContextV4BackfillCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
