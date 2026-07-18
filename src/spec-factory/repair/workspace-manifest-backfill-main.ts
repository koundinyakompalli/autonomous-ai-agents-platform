import { pathToFileURL } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { getDatabase, initDatabase } from "../../orchestrator/database.js";
import { ComposeRepository } from "../compose-database.js";
import { ComposeWorkspaceManager } from "../compose-workspace.js";
import { ImmutableS3ArtifactStore } from "../storage/immutable-s3-artifact-store.js";
import {
  WorkspaceManifestBackfill,
  type WorkspaceManifestBackfillReport,
} from "./workspace-manifest-backfill.js";

type Writer = Pick<NodeJS.WriteStream, "write">;
type BackfillRunner = Pick<WorkspaceManifestBackfill, "run">;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for artifact backfill`);
  return value;
}

function createWorkspaceManifestBackfill(): WorkspaceManifestBackfill {
  const pool = getDatabase().getPool();
  const repository = new ComposeRepository(pool);
  const artifactStore = new ImmutableS3ArtifactStore(
    new S3Client({ region: process.env.AWS_REGION }),
    requiredEnv("SPEC_FACTORY_ARTIFACT_BUCKET"),
    process.env.SPEC_FACTORY_ARTIFACT_PREFIX?.trim() || "spec-factory",
  );
  const workspace = new ComposeWorkspaceManager(undefined, {
    manifestStore: repository,
    artifactStore,
  });
  return new WorkspaceManifestBackfill(pool, workspace);
}

export async function runWorkspaceManifestBackfillCli(
  argv: string[],
  deps: {
    connect?: () => Promise<void>;
    disconnect?: () => Promise<void>;
    createBackfill?: () => BackfillRunner;
    stdout?: Writer;
    stderr?: Writer;
  } = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const connect = deps.connect ?? (async () => void (await initDatabase()));
  const disconnect =
    deps.disconnect ?? (async () => getDatabase().disconnect());
  const createBackfill = deps.createBackfill ?? createWorkspaceManifestBackfill;
  try {
    await connect();
    const apply = argv.includes("--apply");
    const includeArchived = argv.includes("--include-archived");
    if (apply && includeArchived) {
      throw new Error(
        "archived_workspace_manifest_backfill_is_inventory_only; clean archived workspaces before removing EFS",
      );
    }
    const afterArg = argv.find((value) => value.startsWith("--after="));
    const batchArg = argv.find((value) => value.startsWith("--batch="));
    const report: WorkspaceManifestBackfillReport = await createBackfill().run({
      dryRun: !apply,
      afterSessionId: afterArg ? Number(afterArg.split("=")[1]) : undefined,
      batchSize: batchArg ? Number(batchArg.split("=")[1]) : undefined,
      includeArchived,
    });
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.failed > 0 ? 2 : 0;
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
  runWorkspaceManifestBackfillCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
