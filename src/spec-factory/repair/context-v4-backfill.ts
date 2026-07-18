import { createHash } from "node:crypto";
import type mysql from "mysql2/promise";
import { getDatabase } from "../../orchestrator/database.js";
import {
  ComposeRepository,
  type CreateAgentTaskInput,
} from "../compose-database.js";
import type { ComposeSessionSourceSummary } from "../compose-types.js";
import { legacyPatchToV4 } from "../context/context-model.js";

type RepairPool = Pick<mysql.Pool, "query">;

interface BackfillCandidate extends mysql.RowDataPacket {
  id: number | string;
  source_id: number | string | null;
  latest_context_version: number | string | null;
}

interface RepairItemRow extends mysql.RowDataPacket {
  id: number | string;
  repair_run_id: number | string;
  session_id: number | string;
  source_id: number | string | null;
  prior_context_version: number | string | null;
  handoff_id: number | string | null;
  session_status: string;
  context_status: string;
  latest_context_version: number | string | null;
}

interface RepairTaskStateRow extends mysql.RowDataPacket {
  pending_repair_sources: number | string;
  failed_repair_sources: number | string;
  pending_context_merges: number | string;
}

interface HandoffStateRow extends mysql.RowDataPacket {
  status: string;
  error_code: string | null;
  error_message: string | null;
}

interface FinalRepairRunRow extends mysql.RowDataPacket {
  id: number | string;
  repair_type: string;
  status: string;
  dry_run: number | string | boolean;
  cursor_session_id: number | string | null;
  inspected_count: number | string;
  queued_count: number | string;
  succeeded_count: number | string;
  failed_count: number | string;
}

interface FinalRepairItemRow extends mysql.RowDataPacket {
  id: number | string;
  session_id: number | string | null;
  source_id: number | string | null;
  status: string;
  prior_context_version: number | string | null;
  target_context_version: number | string | null;
  agent_task_id: number | string | null;
  handoff_id: number | string | null;
  details_json: string | unknown | null;
  error_code: string | null;
  error_message: string | null;
}

export interface ContextV4BackfillOptions {
  dryRun?: boolean;
  requestedBy?: string | null;
  batchSize?: number;
  afterSessionId?: number;
}

export interface ContextV4BackfillReport {
  repairRunId: number;
  dryRun: boolean;
  inspected: number;
  queued: number;
  failed: number;
  lastSessionId: number | null;
  failures: Array<{ sessionId: number; error: string }>;
  reportSha256: string;
}

export interface ContextV4ReconcileReport {
  inspected: number;
  waiting: number;
  handoffsQueued: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

export class ContextV4Backfill {
  constructor(
    private readonly pool: RepairPool = getDatabase().getPool(),
    private readonly composeRepository: Pick<
      ComposeRepository,
      | "listSessionSources"
      | "createAgentTask"
      | "listMessages"
      | "getContextProjection"
      | "createReadyContextPatch"
      | "completeSourceConversion"
      | "enqueueContextMergeTaskIfNeeded"
      | "createHandoffBuildTask"
    > = new ComposeRepository(),
  ) {}

  async run(
    options: ContextV4BackfillOptions = {},
  ): Promise<ContextV4BackfillReport> {
    const dryRun = options.dryRun !== false;
    const batchSize = Math.max(1, Math.min(1_000, options.batchSize ?? 100));
    const [runResult] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO spec_factory_repair_runs
       (repair_type, status, dry_run, requested_by, cursor_session_id)
       VALUES ('context_rebuild_v4', 'running', ?, ?, ?)`,
      [dryRun, options.requestedBy ?? null, options.afterSessionId ?? null],
    );
    const repairRunId = runResult.insertId;
    let cursor = options.afterSessionId ?? 0;
    let inspected = 0;
    let queued = 0;
    const failures: Array<{ sessionId: number; error: string }> = [];

    while (true) {
      const [candidates] = await this.pool.query<BackfillCandidate[]>(
        `SELECT session.id, session.source_id, session.latest_context_version
         FROM compose_sessions session
         WHERE session.id > ?
           AND session.status <> 'archived'
           AND (
             session.context_status <> 'clean'
             OR NOT EXISTS (
               SELECT 1
               FROM compose_context_versions context
               WHERE context.session_id = session.id
                 AND context.version = session.latest_context_version
                 AND context.status = 'committed'
                 AND context.schema_version = 4
             )
           )
         ORDER BY session.id ASC
         LIMIT ?`,
        [cursor, batchSize],
      );
      if (candidates.length === 0) break;
      for (const candidate of candidates) {
        const sessionId = Number(candidate.id);
        cursor = sessionId;
        inspected += 1;
        try {
          const details = dryRun
            ? await this.planSession(sessionId)
            : await this.enqueueSession({
                sessionId,
                sourceId:
                  candidate.source_id === null
                    ? null
                    : Number(candidate.source_id),
                latestContextVersion:
                  candidate.latest_context_version === null
                    ? null
                    : Number(candidate.latest_context_version),
              });
          if (!dryRun) queued += 1;
          await this.pool.query(
            `INSERT INTO spec_factory_repair_items
             (repair_run_id, session_id, source_id, status,
              prior_context_version, agent_task_id, handoff_id, details_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
            [
              repairRunId,
              sessionId,
              candidate.source_id,
              dryRun ? "planned" : "queued",
              candidate.latest_context_version,
              details.primaryAgentTaskId,
              details.handoffId,
              JSON.stringify(details),
            ],
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          failures.push({ sessionId, error: message });
          await this.pool.query(
            `INSERT INTO spec_factory_repair_items
             (repair_run_id, session_id, source_id, status,
              prior_context_version, error_code, error_message)
             VALUES (?, ?, ?, 'failed', ?, 'context_rebuild_v4_failed', ?)`,
            [
              repairRunId,
              sessionId,
              candidate.source_id,
              candidate.latest_context_version,
              message.slice(0, 8000),
            ],
          );
        }
      }
      await this.pool.query(
        `UPDATE spec_factory_repair_runs
         SET cursor_session_id = ?, inspected_count = ?, queued_count = ?,
             failed_count = ?
         WHERE id = ?`,
        [cursor, inspected, queued, failures.length, repairRunId],
      );
      if (candidates.length < batchSize) break;
    }
    const reportBase = {
      repairRunId,
      dryRun,
      inspected,
      queued,
      failed: failures.length,
      lastSessionId: cursor || null,
      failures,
    };
    const reportSha256 = createHash("sha256")
      .update(JSON.stringify(reportBase))
      .digest("hex");
    const report: ContextV4BackfillReport = { ...reportBase, reportSha256 };
    const runStatus = dryRun
      ? failures.length > 0
        ? "completed_with_errors"
        : "completed"
      : queued > 0
        ? "running"
        : failures.length > 0
          ? "completed_with_errors"
          : "completed";
    await this.pool.query(
      `UPDATE spec_factory_repair_runs
       SET status = ?, inspected_count = ?, queued_count = ?, failed_count = ?,
           report_sha256 = ?,
           completed_at = CASE WHEN ? = 'running' THEN NULL ELSE CURRENT_TIMESTAMP(3) END
       WHERE id = ?`,
      [
        runStatus,
        inspected,
        queued,
        failures.length,
        reportSha256,
        runStatus,
        repairRunId,
      ],
    );
    return report;
  }

  async reconcile(
    options: { limit?: number } = {},
  ): Promise<ContextV4ReconcileReport> {
    const limit = Math.max(1, Math.min(1_000, options.limit ?? 100));
    const [items] = await this.pool.query<RepairItemRow[]>(
      `SELECT item.id, item.repair_run_id, item.session_id, item.source_id,
              item.prior_context_version, item.handoff_id,
              session.status AS session_status, session.context_status,
              session.latest_context_version
       FROM spec_factory_repair_items item
       JOIN spec_factory_repair_runs repair_run
         ON repair_run.id = item.repair_run_id
        AND repair_run.repair_type = 'context_rebuild_v4'
        AND repair_run.dry_run = FALSE
        AND repair_run.status = 'running'
       JOIN compose_sessions session
         ON session.id = item.session_id
       WHERE item.status = 'queued'
       ORDER BY item.id ASC
       LIMIT ?`,
      [limit],
    );
    const report: ContextV4ReconcileReport = {
      inspected: items.length,
      waiting: 0,
      handoffsQueued: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
    };
    const touchedRuns = new Set<number>();
    for (const item of items) {
      const itemId = Number(item.id);
      const repairRunId = Number(item.repair_run_id);
      const sessionId = Number(item.session_id);
      touchedRuns.add(repairRunId);
      if (item.session_status === "archived") {
        await this.skipRepairItem(
          itemId,
          "session_archived_during_repair",
          "Session was archived after the repair run was created",
        );
        report.skipped += 1;
        continue;
      }
      if (item.handoff_id !== null) {
        const state = await this.handoffState(Number(item.handoff_id));
        if (!state || !handoffTerminal(state.status)) {
          report.waiting += 1;
          continue;
        }
        if (state.status === "failed" || state.status === "cancelled") {
          await this.failRepairItem(
            itemId,
            state.error_code ?? `handoff_${state.status}`,
            state.error_message ?? `Handoff ${state.status}`,
          );
          report.failed += 1;
        } else {
          await this.succeedRepairItem(itemId, item.latest_context_version);
          report.succeeded += 1;
        }
        continue;
      }

      const taskState = await this.repairTaskState(sessionId);
      if (Number(taskState.failed_repair_sources) > 0) {
        await this.failRepairItem(
          itemId,
          "context_rebuild_source_failed",
          "At least one repair source-distillation task failed",
        );
        report.failed += 1;
        continue;
      }
      if (
        Number(taskState.pending_repair_sources) > 0 ||
        Number(taskState.pending_context_merges) > 0 ||
        item.context_status !== "clean"
      ) {
        report.waiting += 1;
        continue;
      }
      const latestContextVersion =
        item.latest_context_version === null
          ? null
          : Number(item.latest_context_version);
      if (
        latestContextVersion === null ||
        !(await this.isCommittedV4Context(sessionId, latestContextVersion))
      ) {
        await this.composeRepository.enqueueContextMergeTaskIfNeeded({
          sessionId,
        });
        report.waiting += 1;
        continue;
      }
      if (item.source_id === null) {
        await this.succeedRepairItem(itemId, latestContextVersion);
        report.succeeded += 1;
        continue;
      }
      const handoff = await this.composeRepository.createHandoffBuildTask({
        sessionId,
        sourceId: Number(item.source_id),
        idempotencyKey: `context-rebuild-v4:${sessionId}:${latestContextVersion}`,
        requestedBy: "context-v4-backfill",
        reusedExistingSource: true,
      });
      await this.pool.query(
        `UPDATE spec_factory_repair_items
         SET handoff_id = ?, target_context_version = ?,
             details_json = JSON_SET(COALESCE(details_json, JSON_OBJECT()),
               '$.handoffId', ?, '$.targetContextVersion', ?),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?
           AND status = 'queued'`,
        [
          handoff.handoffId,
          latestContextVersion,
          handoff.handoffId,
          latestContextVersion,
          itemId,
        ],
      );
      report.handoffsQueued += 1;
    }
    for (const repairRunId of touchedRuns) {
      await this.refreshRepairRun(repairRunId);
    }
    return report;
  }

  async acceptRun(input: {
    repairRunId: number;
    acceptedBy: string;
    note?: string | null;
  }): Promise<void> {
    if (!Number.isInteger(input.repairRunId) || input.repairRunId <= 0) {
      throw new Error("context_rebuild_acceptance_run_invalid");
    }
    if (!input.acceptedBy.trim()) {
      throw new Error("context_rebuild_acceptance_actor_required");
    }
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_repair_runs
       SET accepted_by = ?, acceptance_note = ?,
           accepted_at = CURRENT_TIMESTAMP(3),
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?
         AND repair_type = 'context_rebuild_v4'
         AND dry_run = FALSE
         AND status = 'completed'
         AND failed_count = 0
         AND report_sha256 IS NOT NULL
         AND accepted_at IS NULL`,
      [
        input.acceptedBy.trim().slice(0, 128),
        input.note?.trim().slice(0, 8000) || null,
        input.repairRunId,
      ],
    );
    if (result.affectedRows !== 1) {
      throw new Error("context_rebuild_acceptance_preconditions_failed");
    }
  }

  private async repairTaskState(
    sessionId: number,
  ): Promise<RepairTaskStateRow> {
    const [rows] = await this.pool.query<RepairTaskStateRow[]>(
      `SELECT
         COALESCE(SUM(
           capability = 'source_distillation'
           AND JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.repair')) = 'context_rebuild_v4'
           AND status IN ('queued','running')
         ), 0) AS pending_repair_sources,
         COALESCE(SUM(
           capability = 'source_distillation'
           AND JSON_UNQUOTE(JSON_EXTRACT(input_json, '$.repair')) = 'context_rebuild_v4'
           AND status IN ('failed','cancelled','abandoned')
         ), 0) AS failed_repair_sources,
         COALESCE(SUM(
           capability = 'context_merge'
           AND status IN ('queued','running')
         ), 0) AS pending_context_merges
       FROM compose_agent_tasks
       WHERE session_id = ?`,
      [sessionId],
    );
    if (!rows[0]) {
      throw new Error(`context_rebuild_task_state_missing:${sessionId}`);
    }
    return rows[0];
  }

  private async isCommittedV4Context(
    sessionId: number,
    version: number,
  ): Promise<boolean> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT id
       FROM compose_context_versions
       WHERE session_id = ?
         AND version = ?
         AND schema_version = 4
         AND status = 'committed'
       LIMIT 1`,
      [sessionId, version],
    );
    return rows.length > 0;
  }

  private async handoffState(
    handoffId: number,
  ): Promise<HandoffStateRow | null> {
    const [rows] = await this.pool.query<HandoffStateRow[]>(
      `SELECT status, error_code, error_message
       FROM compose_handoffs
       WHERE id = ?
       LIMIT 1`,
      [handoffId],
    );
    return rows[0] ?? null;
  }

  private async succeedRepairItem(
    itemId: number,
    targetContextVersion: number | string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_repair_items
       SET status = 'succeeded', target_context_version = ?,
           error_code = NULL, error_message = NULL,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?
         AND status = 'queued'`,
      [targetContextVersion, itemId],
    );
  }

  private async failRepairItem(
    itemId: number,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_repair_items
       SET status = 'failed', error_code = ?, error_message = ?,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?
         AND status = 'queued'`,
      [errorCode.slice(0, 128), errorMessage.slice(0, 8000), itemId],
    );
  }

  private async skipRepairItem(
    itemId: number,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_repair_items
       SET status = 'skipped', error_code = ?, error_message = ?,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?
         AND status = 'queued'`,
      [errorCode.slice(0, 128), errorMessage.slice(0, 8000), itemId],
    );
  }

  private async refreshRepairRun(repairRunId: number): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_repair_runs repair_run
       SET repair_run.succeeded_count = (
             SELECT COUNT(*) FROM spec_factory_repair_items item
             WHERE item.repair_run_id = repair_run.id
               AND item.status = 'succeeded'
           ),
           repair_run.failed_count = (
             SELECT COUNT(*) FROM spec_factory_repair_items item
             WHERE item.repair_run_id = repair_run.id
               AND item.status = 'failed'
           ),
           repair_run.status = CASE
             WHEN EXISTS (
               SELECT 1 FROM spec_factory_repair_items item
               WHERE item.repair_run_id = repair_run.id
                 AND item.status = 'queued'
             ) THEN 'running'
             WHEN EXISTS (
               SELECT 1 FROM spec_factory_repair_items item
               WHERE item.repair_run_id = repair_run.id
                 AND item.status = 'failed'
             ) THEN 'completed_with_errors'
             ELSE 'completed'
           END,
           repair_run.completed_at = CASE
             WHEN EXISTS (
               SELECT 1 FROM spec_factory_repair_items item
               WHERE item.repair_run_id = repair_run.id
                 AND item.status = 'queued'
             ) THEN NULL
             ELSE CURRENT_TIMESTAMP(3)
           END
       WHERE repair_run.id = ?`,
      [repairRunId],
    );
    await this.finalizeRepairReportHash(repairRunId);
  }

  private async finalizeRepairReportHash(repairRunId: number): Promise<void> {
    const [runRows] = await this.pool.query<FinalRepairRunRow[]>(
      `SELECT id, repair_type, status, dry_run, cursor_session_id,
              inspected_count, queued_count, succeeded_count, failed_count
       FROM spec_factory_repair_runs
       WHERE id = ?
       LIMIT 1`,
      [repairRunId],
    );
    const run = runRows[0];
    if (!run || run.status === "running") return;
    const [itemRows] = await this.pool.query<FinalRepairItemRow[]>(
      `SELECT id, session_id, source_id, status, prior_context_version,
              target_context_version, agent_task_id, handoff_id, details_json,
              error_code, error_message
       FROM spec_factory_repair_items
       WHERE repair_run_id = ?
       ORDER BY session_id ASC, id ASC`,
      [repairRunId],
    );
    const report = {
      schemaVersion: 1,
      repairRunId: Number(run.id),
      repairType: run.repair_type,
      status: run.status,
      dryRun: Boolean(Number(run.dry_run)),
      cursorSessionId: nullableNumber(run.cursor_session_id),
      inspectedCount: Number(run.inspected_count),
      queuedCount: Number(run.queued_count),
      succeededCount: Number(run.succeeded_count),
      failedCount: Number(run.failed_count),
      items: itemRows.map((item) => ({
        id: Number(item.id),
        sessionId: nullableNumber(item.session_id),
        sourceId: nullableNumber(item.source_id),
        status: item.status,
        priorContextVersion: nullableNumber(item.prior_context_version),
        targetContextVersion: nullableNumber(item.target_context_version),
        agentTaskId: nullableNumber(item.agent_task_id),
        handoffId: nullableNumber(item.handoff_id),
        details: jsonValue(item.details_json),
        errorCode: item.error_code,
        errorMessage: item.error_message,
      })),
    };
    const reportSha256 = createHash("sha256")
      .update(canonicalJson(report))
      .digest("hex");
    await this.pool.query(
      `UPDATE spec_factory_repair_runs
       SET report_sha256 = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?
         AND status <> 'running'`,
      [reportSha256, repairRunId],
    );
  }

  private async planSession(sessionId: number) {
    const [sources, messages] = await Promise.all([
      this.composeRepository.listSessionSources(sessionId),
      this.composeRepository.listMessages(sessionId),
    ]);
    const convertedSources = sources.filter(
      (source) => source.conversionStatus === "converted",
    );
    const convertedSourcesWithoutContent = convertedSources.filter(
      (source) => !source.markdownContent?.trim(),
    );
    const visualMetadataFallbackSourceIds = convertedSourcesWithoutContent
      .filter(isLegacyVisualSource)
      .map((source) => source.id);
    const unrecoverableSourceIds = convertedSourcesWithoutContent
      .filter((source) => !isLegacyVisualSource(source))
      .map((source) => source.id);
    if (unrecoverableSourceIds.length > 0) {
      throw new Error(
        `context_rebuild_source_content_missing:${unrecoverableSourceIds.join(",")}`,
      );
    }
    return {
      sourceCount: convertedSources.length,
      revisionsToBackfill: convertedSources.filter(
        (source) => source.currentRevisionId === null,
      ).length,
      convertedSourcesWithoutContent: convertedSourcesWithoutContent.map(
        (source) => source.id,
      ),
      visualMetadataFallbackSourceIds,
      unrecoverableSourceIds,
      messageCount: messages.length,
      primaryAgentTaskId: null,
      handoffId: null,
    };
  }

  private async enqueueSession(input: {
    sessionId: number;
    sourceId: number | null;
    latestContextVersion: number | null;
  }) {
    const [sources, messages, parent] = await Promise.all([
      this.composeRepository.listSessionSources(input.sessionId),
      this.composeRepository.listMessages(input.sessionId),
      input.latestContextVersion === null
        ? Promise.resolve(null)
        : this.composeRepository.getContextProjection(
            input.sessionId,
            input.latestContextVersion,
          ),
    ]);
    const revisionSources: Array<{
      sourceId: number;
      sourceRevisionId: number;
    }> = [];
    for (const source of sources.filter(
      (candidate) => candidate.conversionStatus === "converted",
    )) {
      let sourceRevisionId = source.currentRevisionId ?? null;
      if (sourceRevisionId === null) {
        let markdown = source.markdownContent?.trim() ?? "";
        let markdownPath = source.markdownPath;
        if (!markdown) {
          if (!isLegacyVisualSource(source)) {
            throw new Error(
              `context_rebuild_source_content_missing:${source.id}`,
            );
          }
          markdown = legacyVisualSourceMetadata(source);
          // The legacy .md file is empty. Keep the synthesized immutable
          // revision in the DB instead of claiming that stale path contains it.
          markdownPath = null;
        }
        const rebuilt = await this.composeRepository.completeSourceConversion({
          sourceId: source.id,
          markdownPath,
          markdownContent: markdown,
        });
        sourceRevisionId = rebuilt.sourceRevisionId ?? null;
      }
      if (sourceRevisionId === null) {
        throw new Error(`context_rebuild_source_revision_missing:${source.id}`);
      }
      revisionSources.push({ sourceId: source.id, sourceRevisionId });
    }
    const taskInputs: CreateAgentTaskInput[] = revisionSources.map(
      (source) => ({
        sessionId: input.sessionId,
        capability: "source_distillation",
        executorType: "source_distillation",
        priority: 85,
        maxAttempts: 3,
        input: {
          sourceId: source.sourceId,
          sourceRevisionId: source.sourceRevisionId,
          baseContextVersion: parent?.version ?? null,
          repair: "context_rebuild_v4",
        },
      }),
    );
    const taskIds: number[] = [];
    for (const taskInput of taskInputs) {
      taskIds.push(await this.composeRepository.createAgentTask(taskInput));
    }
    await this.composeRepository.createReadyContextPatch({
      sessionId: input.sessionId,
      baseContextVersion: parent?.version ?? null,
      schemaVersion: 4,
      patchKind: "repair",
      idempotencyKey: `context-rebuild-v4:baseline:${input.sessionId}:${parent?.version ?? 0}`,
      messageIds: [],
      patch: legacyPatchToV4({ patch: {}, kind: "repair" }),
    });
    const messageIds = messages.map((message) => message.id);
    if (messageIds.length > 0) {
      const userMessages = messages.filter(
        (message) => message.role === "user",
      );
      const patch = legacyPatchToV4({
        kind: "repair",
        messageIds,
        patch: {
          requirements: userMessages.map((message) => ({
            text: message.content,
            kind: "historical_user_message",
            authority: "user",
            provenance: { messageIds: [message.id] },
          })),
        },
      });
      await this.composeRepository.createReadyContextPatch({
        sessionId: input.sessionId,
        baseContextVersion: parent?.version ?? null,
        schemaVersion: 4,
        patchKind: "repair",
        idempotencyKey: `context-rebuild-v4:conversation:${input.sessionId}:${Math.max(...messageIds)}`,
        messageIds,
        patch,
      });
    }
    const mergeTaskId =
      await this.composeRepository.enqueueContextMergeTaskIfNeeded({
        sessionId: input.sessionId,
      });
    return {
      sourceCount: taskInputs.length,
      messageCount: messages.length,
      taskIds,
      mergeTaskId,
      primaryAgentTaskId: taskIds[0] ?? null,
      handoffId: null,
    };
  }
}

function isLegacyVisualSource(source: ComposeSessionSourceSummary): boolean {
  if (source.mimeType?.trim().toLowerCase().startsWith("image/")) return true;
  const filename = source.originalFilename?.trim() ?? "";
  return /\.(?:png|jpe?g|gif|webp|tiff?|bmp)$/i.test(filename);
}

function legacyVisualSourceMetadata(
  source: ComposeSessionSourceSummary,
): string {
  const values = [
    ["Source ID", String(source.id)],
    ["Filename", source.originalFilename],
    ["Media type", source.mimeType],
    ["Size bytes", source.sizeBytes === null ? null : String(source.sizeBytes)],
    ["Original object key", source.s3KeyRaw],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()));
  return [
    "# Visual source metadata",
    "",
    ...values.map(([label, value]) => `- ${label}: ${value}`),
    "",
    "Text extraction was unavailable for this legacy visual source.",
    "The original uploaded image remains the authoritative evidence.",
    "Do not infer requirements or behavior from the filename alone; inspect the original image before relying on it.",
  ].join("\n");
}

function handoffTerminal(status: string): boolean {
  return [
    "snapshot_ready",
    "draft_queued",
    "drafting",
    "draft_ready",
    "approved",
    "publishing",
    "published",
    "failed",
    "cancelled",
  ].includes(status);
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function jsonValue(value: string | unknown | null): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
