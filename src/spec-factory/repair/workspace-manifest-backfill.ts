import { createHash } from "node:crypto";
import type mysql from "mysql2/promise";
import type { WorkspaceManifest } from "../compose-workspace.js";

type BackfillPool = Pick<mysql.Pool, "query">;

interface WorkspaceManifestCandidateRow extends mysql.RowDataPacket {
  id: number | string;
  status: string;
  workspace_path: string;
  manifest_json: string | unknown | null;
}

export interface WorkspaceManifestBackfillTarget {
  backfillImmutableManifest(input: {
    sessionId: number;
    workspacePath: string;
  }): Promise<{
    fileCount: number;
    migratedFileCount: number;
    reusedFileCount: number;
  }>;
}

export interface WorkspaceManifestBackfillOptions {
  dryRun?: boolean;
  batchSize?: number;
  afterSessionId?: number;
  includeArchived?: boolean;
}

export interface WorkspaceManifestBackfillReport {
  dryRun: boolean;
  inspected: number;
  candidates: number;
  migrated: number;
  alreadyImmutable: number;
  filesMigrated: number;
  filesReused: number;
  failed: number;
  lastSessionId: number | null;
  failures: Array<{ sessionId: number; error: string }>;
  reportSha256: string;
}

function jsonValue(value: string | unknown | null): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function immutableManifestComplete(value: unknown): boolean {
  const parsed = jsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const manifest = parsed as Partial<WorkspaceManifest>;
  return Boolean(
    manifest.manifestVersion === 2 &&
    Array.isArray(manifest.files) &&
    manifest.files.every((file) => Boolean(file.artifactUri?.trim())),
  );
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return Number.isFinite(value) && (value as number) > 0
    ? Math.min(maximum, Math.max(1, Math.trunc(value as number)))
    : fallback;
}

export class WorkspaceManifestBackfill {
  constructor(
    private readonly pool: BackfillPool,
    private readonly target: WorkspaceManifestBackfillTarget,
  ) {}

  async run(
    options: WorkspaceManifestBackfillOptions = {},
  ): Promise<WorkspaceManifestBackfillReport> {
    const dryRun = options.dryRun !== false;
    const batchSize = boundedInteger(options.batchSize, 100, 1_000);
    let cursor = Number.isFinite(options.afterSessionId)
      ? Math.max(0, Math.trunc(options.afterSessionId as number))
      : 0;
    let inspected = 0;
    let candidates = 0;
    let migrated = 0;
    let alreadyImmutable = 0;
    let filesMigrated = 0;
    let filesReused = 0;
    const failures: Array<{ sessionId: number; error: string }> = [];

    while (true) {
      const [rows] = await this.pool.query<WorkspaceManifestCandidateRow[]>(
        `SELECT session.id, session.status, session.workspace_path,
                manifest.manifest_json
         FROM compose_sessions session
         LEFT JOIN compose_workspace_manifests manifest
           ON manifest.session_id = session.id
         WHERE session.id > ?
           ${options.includeArchived ? "" : "AND session.status <> 'archived'"}
         ORDER BY session.id ASC
         LIMIT ?`,
        [cursor, batchSize],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const sessionId = Number(row.id);
        cursor = sessionId;
        inspected += 1;
        if (immutableManifestComplete(row.manifest_json)) {
          alreadyImmutable += 1;
          continue;
        }
        candidates += 1;
        if (dryRun) continue;
        try {
          const result = await this.target.backfillImmutableManifest({
            sessionId,
            workspacePath: row.workspace_path,
          });
          migrated += 1;
          filesMigrated += result.migratedFileCount;
          filesReused += result.reusedFileCount;
        } catch (error) {
          failures.push({
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (rows.length < batchSize) break;
    }

    const reportBase = {
      dryRun,
      inspected,
      candidates,
      migrated,
      alreadyImmutable,
      filesMigrated,
      filesReused,
      failed: failures.length,
      lastSessionId: cursor || null,
      failures,
    };
    return {
      ...reportBase,
      reportSha256: createHash("sha256")
        .update(JSON.stringify(reportBase))
        .digest("hex"),
    };
  }
}
