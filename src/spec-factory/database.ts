import { createHash } from "node:crypto";
import type mysql from "mysql2/promise";
import { getDatabase } from "../orchestrator/database.js";
import type {
  ChildTicketState,
  DraftStatus,
  QualificationReason,
  SpecFactoryAttachmentSummary,
  SpecFactoryChildTicketSummary,
  SpecFactoryDraftBundle,
  SpecFactoryDraftDetail,
  SpecFactoryEvidenceSnapshot,
  SpecFactoryEventSummary,
  SpecFactoryProcessingJobHealth,
  SpecFactorySourceSummary,
} from "./types.js";
import {
  ChildTicketStateSchema,
  DraftStatusSchema,
  QualificationReasonSchema,
  SpecFactoryDraftBundleSchema,
} from "./types.js";
import { renderChildTicketDescription } from "./renderers.js";
import type { UpsertAttachmentArchiveInput } from "./attachment-archive.js";
import type { EvidenceManifest } from "./evidence.js";
import { currentSpecFactoryCorrelation } from "./telemetry/correlation.js";
import { specFactoryMetrics } from "./telemetry/metrics.js";
import { appendSpecFactoryOutboxEvent } from "./control-plane/outbox.js";
import {
  DRAFT_WORKFLOW_STAGES,
  type ClaimedDraftStageRun,
  type DraftStageExecutionOutput,
  type DraftWorkflowStage,
} from "./draft-workflow-types.js";

type PoolLike = Pick<mysql.Pool, "query" | "getConnection">;
type TransactionConnection = Pick<
  mysql.PoolConnection,
  "query" | "beginTransaction" | "commit" | "rollback" | "release"
>;

interface SourceRow extends mysql.RowDataPacket {
  id: number;
  source_jira_key: string;
  source_summary: string;
  source_status: string | null;
  loe_hours: string | number | null;
  state: SpecFactorySourceSummary["state"];
  origin: SpecFactorySourceSummary["origin"];
  approved_epic_key: string | null;
  qualification_reasons_json: string | unknown[] | null;
  error_message: string | null;
  updated_at: Date | string;
}

interface SourceWithNextDraftVersionRow extends SourceRow {
  next_draft_version: number | string | null;
}

interface DraftRow extends mysql.RowDataPacket {
  id: number;
  source_id: number;
  version: number;
  evidence_snapshot_id: number | null;
  status: string;
  draft_json: string | unknown | null;
  rendered_markdown: string | null;
  evidence_manifest_json: string | unknown | null;
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AttachmentRow extends mysql.RowDataPacket {
  id: number;
  source_id: number;
  jira_attachment_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: string | number | null;
  artifact_kind: string;
  is_priority: number | boolean;
  s3_bucket: string | null;
  s3_key: string | null;
  sha256: string | null;
  extracted_text: string | null;
  extraction_status: SpecFactoryAttachmentSummary["extractionStatus"];
  error_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EvidenceSnapshotRow extends mysql.RowDataPacket {
  id: number;
  source_id: number;
  source_jira_key: string;
  source_summary: string;
  source_status: string | null;
  source_labels_json: string | unknown[] | null;
  description_markdown: string | null;
  comments_json: string | unknown[] | null;
  loe_hours: string | number | null;
  loe_source: string | null;
  artifacts_json: string | unknown[] | null;
  repo_references_json: string | unknown | null;
  warnings_json: string | unknown[] | null;
  created_at: Date | string;
}

interface ProcessingJobRow extends mysql.RowDataPacket {
  id: number;
  source_id: number;
  request_id: string | null;
  created_at: Date | string;
}

interface ProcessingJobHealthRow extends mysql.RowDataPacket {
  status: keyof SpecFactoryProcessingJobHealth["byStatus"];
  count: number | string;
  oldest_created_at: Date | string | null;
  oldest_started_at: Date | string | null;
  stale_running_count: number | string | null;
}

interface EventRow extends mysql.RowDataPacket {
  id: number | string;
  source_id: number | string;
  event_type: string;
  actor: string | null;
  request_id: string | null;
  metadata_json: string | unknown | null;
  created_at: Date | string;
}

interface ChildRow extends mysql.RowDataPacket {
  id: number;
  source_id?: number;
  repo_name: string;
  summary: string;
  description: string | null;
  loe_hours: string | number | null;
  jira_key: string | null;
  state: string;
  oneshot_request_id: number | null;
  oneshot_run_id: number | null;
  error_message: string | null;
}

interface LatestFetchRow extends mysql.RowDataPacket {
  latest_fetch_at: Date | string | null;
}

interface LatestIntakeRefreshRow extends mysql.RowDataPacket {
  latest_refresh_at: Date | string | null;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function numberOrNull(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseQualificationReasons(
  value: string | unknown[] | null | undefined,
): QualificationReason[] {
  if (value === null || value === undefined) return [];
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is QualificationReason => {
    const parsed = QualificationReasonSchema.safeParse(item);
    return parsed.success;
  });
}

function mapSource(row: SourceRow): SpecFactorySourceSummary {
  return {
    id: row.id,
    sourceJiraKey: row.source_jira_key,
    sourceSummary: row.source_summary,
    sourceStatus: row.source_status,
    loeHours: numberOrNull(row.loe_hours),
    state: row.state,
    origin: row.origin === "compose" ? "compose" : "louise",
    approvedEpicKey: row.approved_epic_key,
    qualificationReasons: parseQualificationReasons(
      row.qualification_reasons_json,
    ),
    errorMessage: row.error_message ?? null,
    updatedAt: toIso(row.updated_at),
  };
}

function mapAttachment(row: AttachmentRow): SpecFactoryAttachmentSummary {
  return {
    id: row.id,
    sourceId: row.source_id,
    jiraAttachmentId: row.jira_attachment_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: numberOrNull(row.size_bytes),
    artifactKind: row.artifact_kind,
    isPriority: Boolean(row.is_priority),
    s3Bucket: row.s3_bucket,
    s3Key: row.s3_key,
    sha256: row.sha256,
    extractedText: row.extracted_text,
    extractionStatus: row.extraction_status,
    errorMessage: row.error_message,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapEvent(row: EventRow): SpecFactoryEventSummary {
  const parsedMetadata = safeParseJson<unknown>(row.metadata_json);
  return {
    id: Number(row.id),
    sourceId: Number(row.source_id),
    eventType: row.event_type,
    actor: row.actor,
    requestId: row.request_id,
    metadata: parsedMetadata.malformed ? null : parsedMetadata.value,
    createdAt: toIso(row.created_at),
  };
}

function safeParseJson<T>(value: string | T | null | undefined): {
  value: T | null;
  malformed: boolean;
} {
  if (value === null || value === undefined) {
    return { value: null, malformed: false };
  }
  if (typeof value !== "string") {
    return { value, malformed: false };
  }
  try {
    return { value: JSON.parse(value) as T, malformed: false };
  } catch {
    return { value: null, malformed: true };
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

function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ER_DUP_ENTRY"
  );
}

function parseDraftBundle(value: string | unknown | null): {
  draft: SpecFactoryDraftBundle | null;
  invalid: boolean;
} {
  const parsedJson = safeParseJson<unknown>(value);
  if (parsedJson.malformed) {
    return { draft: null, invalid: true };
  }
  const parsedBundle = SpecFactoryDraftBundleSchema.safeParse(parsedJson.value);
  return {
    draft: parsedBundle.success ? parsedBundle.data : null,
    invalid: !parsedBundle.success,
  };
}

function parseDraftStatus(value: string): {
  status: DraftStatus;
  invalid: boolean;
} {
  const parsed = DraftStatusSchema.safeParse(value);
  return parsed.success
    ? { status: parsed.data, invalid: false }
    : { status: "failed", invalid: true };
}

function mapChildRows(rows: ChildRow[]): {
  childTickets: SpecFactoryDraftDetail["childTickets"];
  invalid: boolean;
} {
  let invalid = false;
  const childTickets: SpecFactoryDraftDetail["childTickets"] = [];

  rows.forEach((child) => {
    const parsedState = ChildTicketStateSchema.safeParse(child.state);
    if (!parsedState.success) {
      invalid = true;
      return;
    }

    childTickets.push({
      id: child.id,
      repoName: child.repo_name,
      summary: child.summary,
      description: child.description,
      loeHours: numberOrNull(child.loe_hours),
      jiraKey: child.jira_key,
      state: parsedState.data as ChildTicketState,
      oneshotRequestId: child.oneshot_request_id,
      oneshotRunId: child.oneshot_run_id,
      errorMessage: child.error_message,
    });
  });

  return { childTickets, invalid };
}

function mapSourceWithNextDraftVersion(
  row: SourceWithNextDraftVersionRow,
): SpecFactorySourceWithNextDraftVersion {
  return {
    ...mapSource(row),
    nextDraftVersion: Number(row.next_draft_version || 1),
  };
}

export interface UpsertSourceInput {
  sourceJiraKey: string;
  sourceSummary: string;
  sourceStatus: string | null;
  sourceLabels: string[];
  loeHours: number | null;
}

export interface UpsertSourceResult {
  id: number;
  inserted: boolean;
}

export interface SpecFactorySourceWithNextDraftVersion extends SpecFactorySourceSummary {
  nextDraftVersion: number;
}

export interface SpecFactoryOneShotSubmissionSummary {
  source: SpecFactorySourceSummary;
  childTickets: SpecFactoryChildTicketSummary[];
}

function mapEvidenceSnapshot(
  row: EvidenceSnapshotRow,
): SpecFactoryEvidenceSnapshot {
  const sourceLabels =
    safeParseJson<unknown[]>(row.source_labels_json).value ?? [];
  const comments = safeParseJson<unknown[]>(row.comments_json).value ?? [];
  const artifacts = safeParseJson<unknown[]>(row.artifacts_json).value ?? [];
  const repoReferences = safeParseJson<unknown>(row.repo_references_json).value;
  const warnings = safeParseJson<unknown[]>(row.warnings_json).value ?? [];

  return {
    id: row.id,
    sourceId: row.source_id,
    sourceJiraKey: row.source_jira_key,
    sourceSummary: row.source_summary,
    sourceStatus: row.source_status,
    sourceLabels: sourceLabels.filter(
      (label): label is string => typeof label === "string",
    ),
    descriptionMarkdown: row.description_markdown ?? "",
    comments,
    loeHours: numberOrNull(row.loe_hours),
    loeSource: row.loe_source,
    artifacts,
    repoReferences,
    warnings: warnings.filter(
      (warning): warning is string => typeof warning === "string",
    ),
    createdAt: toIso(row.created_at),
  };
}

export class SpecFactoryRepository {
  constructor(private readonly pool: PoolLike = getDatabase().getPool()) {}

  async upsertSource(input: UpsertSourceInput): Promise<UpsertSourceResult> {
    const [existingRows] = await this.pool.query<
      Array<mysql.RowDataPacket & { id: number }>
    >(`SELECT id FROM spec_factory_sources WHERE source_jira_key = ? LIMIT 1`, [
      input.sourceJiraKey,
    ]);
    const existingId = existingRows[0]?.id;
    if (existingId) {
      return { id: existingId, inserted: false };
    }

    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT IGNORE INTO spec_factory_sources
       (source_jira_key, source_summary, source_status, source_labels_json, loe_hours, state, last_seen_at)
       VALUES (?, ?, ?, CAST(? AS JSON), ?, 'candidate', CURRENT_TIMESTAMP(3))`,
      [
        input.sourceJiraKey,
        input.sourceSummary,
        input.sourceStatus,
        JSON.stringify(input.sourceLabels),
        input.loeHours,
      ],
    );

    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { id: number }>
    >(`SELECT id FROM spec_factory_sources WHERE source_jira_key = ? LIMIT 1`, [
      input.sourceJiraKey,
    ]);
    const id = rows[0]?.id;
    if (!id) {
      throw new Error(
        `Failed to resolve Spec Factory source ${input.sourceJiraKey}`,
      );
    }
    return { id, inserted: result.affectedRows > 0 };
  }

  async createComposeSource(input: {
    sourceJiraKey: string;
    sourceSummary: string;
  }): Promise<number> {
    try {
      const [result] = await this.pool.query<mysql.ResultSetHeader>(
        `INSERT INTO spec_factory_sources
         (source_jira_key, source_summary, source_status, source_labels_json,
          loe_hours, state, origin, last_seen_at)
         VALUES (?, ?, NULL, CAST('[]' AS JSON), NULL, 'drafting', 'compose', CURRENT_TIMESTAMP(3))`,
        [input.sourceJiraKey, input.sourceSummary],
      );

      if (result.insertId) return result.insertId;
    } catch (error) {
      if (!isDuplicateEntry(error)) throw error;
    }

    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { id: number }>
    >(`SELECT id FROM spec_factory_sources WHERE source_jira_key = ? LIMIT 1`, [
      input.sourceJiraKey,
    ]);
    const id = rows[0]?.id;
    if (!id) {
      throw new Error(
        `Failed to resolve compose source ${input.sourceJiraKey}`,
      );
    }
    return id;
  }

  async getSourceOrigin(sourceId: number): Promise<"louise" | "compose"> {
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { origin: string }>
    >(`SELECT origin FROM spec_factory_sources WHERE id = ? LIMIT 1`, [
      sourceId,
    ]);
    return rows[0]?.origin === "compose" ? "compose" : "louise";
  }

  async upsertAttachment(
    input: UpsertAttachmentArchiveInput,
  ): Promise<SpecFactoryAttachmentSummary> {
    await this.pool.query(
      `INSERT INTO spec_factory_attachments
       (source_id, jira_attachment_id, filename, mime_type, size_bytes,
        artifact_kind, is_priority, s3_bucket, s3_key, sha256, extracted_text,
        extraction_status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         filename = VALUES(filename),
         mime_type = VALUES(mime_type),
         size_bytes = VALUES(size_bytes),
         artifact_kind = VALUES(artifact_kind),
         is_priority = VALUES(is_priority),
         s3_bucket = VALUES(s3_bucket),
         s3_key = VALUES(s3_key),
         sha256 = VALUES(sha256),
         extracted_text = VALUES(extracted_text),
         extraction_status = VALUES(extraction_status),
         error_message = VALUES(error_message)`,
      [
        input.sourceId,
        input.jiraAttachmentId,
        input.filename,
        input.mimeType,
        input.sizeBytes,
        input.artifactKind,
        input.isPriority,
        input.s3Bucket,
        input.s3Key,
        input.sha256,
        input.extractedText,
        input.extractionStatus,
        input.errorMessage,
      ],
    );

    const [rows] = await this.pool.query<AttachmentRow[]>(
      `SELECT id, source_id, jira_attachment_id, filename, mime_type, size_bytes,
              artifact_kind, is_priority, s3_bucket, s3_key, sha256,
              extracted_text, extraction_status, error_message, created_at, updated_at
       FROM spec_factory_attachments
       WHERE source_id = ? AND jira_attachment_id = ?
       LIMIT 1`,
      [input.sourceId, input.jiraAttachmentId],
    );
    if (!rows[0]) {
      throw new Error(
        `Failed to persist Spec Factory attachment ${input.jiraAttachmentId}`,
      );
    }
    return mapAttachment(rows[0]);
  }

  async listSourceAttachments(
    sourceId: number,
  ): Promise<SpecFactoryAttachmentSummary[]> {
    const [rows] = await this.pool.query<AttachmentRow[]>(
      `SELECT id, source_id, jira_attachment_id, filename, mime_type, size_bytes,
              artifact_kind, is_priority, s3_bucket, s3_key, sha256,
              extracted_text, extraction_status, error_message, created_at, updated_at
       FROM spec_factory_attachments
       WHERE source_id = ?
       ORDER BY is_priority DESC, artifact_kind ASC, filename ASC, id ASC`,
      [sourceId],
    );
    return rows.map(mapAttachment);
  }

  async createEvidenceSnapshot(input: {
    sourceId: number;
    manifest: EvidenceManifest;
  }): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO spec_factory_evidence_snapshots
       (source_id, source_jira_key, source_summary, source_status,
        source_labels_json, description_markdown, comments_json, loe_hours,
        loe_source, artifacts_json, repo_references_json, warnings_json)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, CAST(? AS JSON), ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON))`,
      [
        input.sourceId,
        input.manifest.sourceJiraKey,
        input.manifest.sourceSummary,
        input.manifest.sourceStatus,
        JSON.stringify(input.manifest.sourceLabels),
        input.manifest.descriptionMarkdown,
        JSON.stringify(input.manifest.comments),
        input.manifest.loeHours,
        input.manifest.loeSource,
        JSON.stringify(input.manifest.artifacts),
        JSON.stringify(input.manifest.repoReferences ?? null),
        JSON.stringify(input.manifest.warnings),
      ],
    );

    if (input.manifest.loeHours !== null) {
      await this.pool.query(
        `UPDATE spec_factory_sources
         SET loe_hours = ?
         WHERE id = ?`,
        [input.manifest.loeHours, input.sourceId],
      );
    }

    return result.insertId;
  }

  async getLatestEvidenceSnapshot(
    sourceId: number,
  ): Promise<SpecFactoryEvidenceSnapshot | null> {
    const [rows] = await this.pool.query<EvidenceSnapshotRow[]>(
      `SELECT id, source_id, source_jira_key, source_summary, source_status,
              source_labels_json, description_markdown, comments_json, loe_hours,
              loe_source, artifacts_json, repo_references_json, warnings_json, created_at
       FROM spec_factory_evidence_snapshots
       WHERE source_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [sourceId],
    );
    return rows[0] ? mapEvidenceSnapshot(rows[0]) : null;
  }

  async listLouiseBoardSources(): Promise<SpecFactorySourceSummary[]> {
    const [rows] = await this.pool.query<SourceRow[]>(
      `SELECT id, source_jira_key, source_summary, source_status, loe_hours,
              state, origin, approved_epic_key, qualification_reasons_json,
              error_message, updated_at
       FROM spec_factory_sources
       WHERE state NOT IN ('oneshot_submitted', 'archived')
       ORDER BY updated_at DESC, id DESC
       LIMIT 200`,
    );

    return rows.map(mapSource);
  }

  async getLatestSourceFetchAt(): Promise<string | null> {
    const [rows] = await this.pool.query<LatestFetchRow[]>(
      `SELECT MAX(last_seen_at) AS latest_fetch_at
       FROM spec_factory_sources`,
    );
    const latestFetchAt = rows[0]?.latest_fetch_at;
    return latestFetchAt ? toIso(latestFetchAt) : null;
  }

  async getLatestIntakeRefreshAt(source = "louise"): Promise<string | null> {
    const [rows] = await this.pool.query<LatestIntakeRefreshRow[]>(
      `SELECT MAX(finished_at) AS latest_refresh_at
       FROM spec_factory_intake_runs
       WHERE intake_source = ?
         AND status = 'succeeded'`,
      [source],
    );
    const latestRefreshAt = rows[0]?.latest_refresh_at;
    return latestRefreshAt ? toIso(latestRefreshAt) : null;
  }

  async recordIntakeRefresh(input: {
    source?: string;
    status: "succeeded" | "failed";
    scanned?: number;
    inserted?: number;
    matched?: number;
    claimed?: number;
    claimFailures?: number;
    autoQueued?: number;
    errorMessage?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO spec_factory_intake_runs
       (intake_source, status, scanned, inserted_count, matched, claimed,
        claim_failures, auto_queued, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.source ?? "louise",
        input.status,
        input.scanned ?? 0,
        input.inserted ?? 0,
        input.matched ?? 0,
        input.claimed ?? 0,
        input.claimFailures ?? 0,
        input.autoQueued ?? 0,
        input.errorMessage ?? null,
      ],
    );
  }

  async getSourceById(
    sourceId: number,
  ): Promise<SpecFactorySourceWithNextDraftVersion | null> {
    const [rows] = await this.pool.query<SourceWithNextDraftVersionRow[]>(
      `SELECT s.id, s.source_jira_key, s.source_summary, s.source_status,
              s.loe_hours, s.state, s.origin, s.approved_epic_key, s.updated_at,
              s.qualification_reasons_json, s.error_message,
              (
                SELECT COALESCE(MAX(d.version), 0) + 1
                FROM spec_factory_drafts d
                WHERE d.source_id = s.id
              ) AS next_draft_version
       FROM spec_factory_sources s
       WHERE s.id = ?
       LIMIT 1`,
      [sourceId],
    );

    return rows[0] ? mapSourceWithNextDraftVersion(rows[0]) : null;
  }

  async createDraft(input: {
    sourceId: number;
    workflowId?: number | null;
    version: number;
    evidenceSnapshotId?: number | null;
    bundle: SpecFactoryDraftBundle;
    renderedMarkdown: string;
    evidenceManifest: unknown;
    modelMetadata: unknown;
  }): Promise<number> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;

    try {
      await connection.beginTransaction();

      const [result] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO spec_factory_drafts
         (source_id, workflow_id, version, evidence_snapshot_id, status,
          draft_json, rendered_markdown, evidence_manifest_json, model_metadata_json)
         VALUES (?, ?, ?, ?, 'ready', CAST(? AS JSON), ?, CAST(? AS JSON), CAST(? AS JSON))`,
        [
          input.sourceId,
          input.workflowId ?? null,
          input.version,
          input.evidenceSnapshotId ?? null,
          JSON.stringify(input.bundle),
          input.renderedMarkdown,
          JSON.stringify(input.evidenceManifest),
          JSON.stringify(input.modelMetadata),
        ],
      );

      const draftId = result.insertId;
      for (const child of input.bundle.childTickets) {
        await connection.query(
          `INSERT INTO spec_factory_child_tickets
           (source_id, draft_id, repo_id, repo_name, summary, description, loe_hours, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
          [
            input.sourceId,
            draftId,
            child.repoId ?? null,
            child.repoName,
            child.summary,
            renderChildTicketDescription(child),
            child.loeHours ?? null,
          ],
        );
      }

      await connection.query(
        `UPDATE spec_factory_sources
         SET state = 'draft_ready',
             qualification_reasons_json = NULL,
             error_message = NULL
         WHERE id = ?`,
        [input.sourceId],
      );

      await connection.commit();
      return draftId;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async reviseDraft(input: {
    sourceId: number;
    previousDraftId: number;
    version: number;
    evidenceSnapshotId?: number | null;
    bundle: SpecFactoryDraftBundle;
    renderedMarkdown: string;
    evidenceManifest: unknown;
    modelMetadata: unknown;
  }): Promise<number> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;

    try {
      await connection.beginTransaction();

      await connection.query(
        `UPDATE spec_factory_drafts
         SET status = 'superseded',
             error_message = NULL
         WHERE id = ?
           AND source_id = ?`,
        [input.previousDraftId, input.sourceId],
      );

      const [result] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO spec_factory_drafts
         (source_id, version, evidence_snapshot_id, status, draft_json, rendered_markdown, evidence_manifest_json, model_metadata_json)
         VALUES (?, ?, ?, 'ready', CAST(? AS JSON), ?, CAST(? AS JSON), CAST(? AS JSON))`,
        [
          input.sourceId,
          input.version,
          input.evidenceSnapshotId ?? null,
          JSON.stringify(input.bundle),
          input.renderedMarkdown,
          JSON.stringify(input.evidenceManifest),
          JSON.stringify(input.modelMetadata),
        ],
      );

      const draftId = result.insertId;
      for (const child of input.bundle.childTickets) {
        await connection.query(
          `INSERT INTO spec_factory_child_tickets
           (source_id, draft_id, repo_id, repo_name, summary, description, loe_hours, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'draft')`,
          [
            input.sourceId,
            draftId,
            child.repoId ?? null,
            child.repoName,
            child.summary,
            renderChildTicketDescription(child),
            child.loeHours ?? null,
          ],
        );
      }

      await connection.query(
        `UPDATE spec_factory_sources
         SET state = 'draft_ready',
             qualification_reasons_json = NULL,
             error_message = NULL
         WHERE id = ?`,
        [input.sourceId],
      );

      await connection.commit();
      return draftId;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async markSourceDrafting(sourceId: number): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_sources
       SET state = 'drafting',
           qualification_reasons_json = NULL,
           error_message = NULL
       WHERE id = ?`,
      [sourceId],
    );
  }

  async getLatestDraft(
    sourceId: number,
  ): Promise<SpecFactoryDraftDetail | null> {
    const [draftRows] = await this.pool.query<DraftRow[]>(
      `SELECT id, source_id, version, evidence_snapshot_id, status, draft_json, rendered_markdown,
              evidence_manifest_json, error_message, created_at, updated_at
       FROM spec_factory_drafts
       WHERE source_id = ?
       ORDER BY version DESC
       LIMIT 1`,
      [sourceId],
    );
    const draft = draftRows[0];
    if (!draft) return null;

    const [childRows] = await this.pool.query<ChildRow[]>(
      `SELECT id, repo_name, summary, description, loe_hours, jira_key, state,
              oneshot_request_id, oneshot_run_id, error_message
       FROM spec_factory_child_tickets
       WHERE draft_id = ?
       ORDER BY id ASC`,
      [draft.id],
    );
    const parsedStatus = parseDraftStatus(draft.status);
    const parsedDraft = parseDraftBundle(draft.draft_json);
    const parsedEvidenceManifest = safeParseJson<unknown>(
      draft.evidence_manifest_json,
    );
    const mappedChildren = mapChildRows(childRows);
    const invalidReadModel =
      parsedStatus.invalid ||
      parsedDraft.invalid ||
      parsedEvidenceManifest.malformed ||
      mappedChildren.invalid;

    return {
      id: draft.id,
      sourceId: draft.source_id,
      version: draft.version,
      evidenceSnapshotId: draft.evidence_snapshot_id,
      status: parsedStatus.status,
      draft: invalidReadModel ? null : parsedDraft.draft,
      renderedMarkdown: draft.rendered_markdown,
      evidenceManifest: parsedEvidenceManifest.value,
      childTickets: mappedChildren.childTickets,
      errorMessage: draft.error_message,
      createdAt: toIso(draft.created_at),
      updatedAt: toIso(draft.updated_at),
    };
  }

  async markDraftApproved(draftId: number, actor: string): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_drafts
       SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP(3),
           error_message = NULL
       WHERE id = ?`,
      [actor, draftId],
    );
  }

  async updateSourceApproved(sourceId: number, epicKey: string): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_sources
       SET state = 'approved',
           approved_epic_key = ?,
           qualification_reasons_json = NULL,
           error_message = NULL
       WHERE id = ?`,
      [epicKey, sourceId],
    );
  }

  async updateChildCreated(childId: number, jiraKey: string): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_child_tickets
       SET jira_key = ?,
           state = 'created',
           error_message = NULL
       WHERE id = ?`,
      [jiraKey, childId],
    );
  }

  async listApprovedChildren(
    sourceId: number,
  ): Promise<SpecFactoryChildTicketSummary[]> {
    const [rows] = await this.pool.query<ChildRow[]>(
      `SELECT c.id, c.repo_name, c.summary, c.description, c.loe_hours,
              c.jira_key, c.state, c.oneshot_request_id, c.oneshot_run_id,
              c.error_message
       FROM spec_factory_child_tickets c
       INNER JOIN spec_factory_drafts d ON d.id = c.draft_id
       WHERE c.source_id = ?
         AND d.status = 'approved'
         AND d.version = (
           SELECT MAX(latest.version)
           FROM spec_factory_drafts latest
           WHERE latest.source_id = c.source_id
             AND latest.status = 'approved'
         )
         AND c.state = 'created'
         AND c.jira_key IS NOT NULL
       ORDER BY d.version DESC, c.id ASC`,
      [sourceId],
    );

    return mapChildRows(rows).childTickets;
  }

  async updateChildSubmitted(
    childId: number,
    requestId: number | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_child_tickets
       SET state = ?,
           oneshot_request_id = COALESCE(oneshot_request_id, ?),
           error_message = NULL
       WHERE id = ?
         AND state = 'created'
         AND oneshot_request_id IS NULL`,
      [
        requestId === null ? "pfos_labeled" : "oneshot_requested",
        requestId,
        childId,
      ],
    );
  }

  async markSourceOneShotSubmitted(sourceId: number): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_sources
       SET state = 'oneshot_submitted', submitted_at = CURRENT_TIMESTAMP(3),
           qualification_reasons_json = NULL,
           error_message = NULL
       WHERE id = ?`,
      [sourceId],
    );
  }

  async markSourceNotQualified(
    sourceId: number,
    reasons: QualificationReason[],
    errorMessage: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_sources
       SET state = 'not_qualified',
           qualification_reasons_json = CAST(? AS JSON),
           error_message = ?
       WHERE id = ?`,
      [JSON.stringify(reasons), errorMessage, sourceId],
    );
  }

  async markSourceNeedsAttention(
    sourceId: number,
    errorMessage: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_sources
       SET state = 'needs_attention',
           qualification_reasons_json = CAST(? AS JSON),
           error_message = ?
       WHERE id = ?`,
      [JSON.stringify(["generation_failed"]), errorMessage, sourceId],
    );
  }

  async markDraftGenerationFailed(input: {
    sourceId: number;
    stateWithoutReadyDraft: "needs_attention" | "not_qualified";
    reasons: QualificationReason[];
    errorMessage: string;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_sources s
       SET state = CASE
             WHEN s.state IN ('approved', 'oneshot_submitted') THEN s.state
             WHEN s.approved_epic_key IS NOT NULL OR EXISTS (
               SELECT 1
               FROM spec_factory_drafts d
               WHERE d.source_id = s.id
                 AND d.status = 'approved'
             ) THEN 'approved'
             WHEN EXISTS (
               SELECT 1
               FROM spec_factory_drafts d
               WHERE d.source_id = s.id
                 AND d.status = 'ready'
             ) THEN 'draft_ready'
             ELSE ?
           END,
           qualification_reasons_json = CASE
             WHEN s.approved_epic_key IS NOT NULL OR EXISTS (
               SELECT 1
               FROM spec_factory_drafts d
               WHERE d.source_id = s.id
                 AND d.status IN ('ready', 'approved')
             ) THEN NULL
             ELSE CAST(? AS JSON)
           END,
           error_message = CASE
             WHEN s.approved_epic_key IS NOT NULL OR EXISTS (
               SELECT 1
               FROM spec_factory_drafts d
               WHERE d.source_id = s.id
                 AND d.status IN ('ready', 'approved')
             ) THEN NULL
             ELSE ?
           END
       WHERE s.id = ?`,
      [
        input.stateWithoutReadyDraft,
        JSON.stringify(input.reasons),
        input.errorMessage,
        input.sourceId,
      ],
    );
  }

  async archiveSource(sourceId: number): Promise<void> {
    await this.pool.query(
      `UPDATE spec_factory_sources
       SET state = 'archived'
       WHERE id = ?`,
      [sourceId],
    );
  }

  async restoreArchivedSource(sourceId: number): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_sources
       SET state = CASE
             WHEN approved_epic_key IS NOT NULL THEN 'approved'
             WHEN EXISTS (
               SELECT 1
               FROM spec_factory_drafts d
               WHERE d.source_id = spec_factory_sources.id
                 AND d.status = 'ready'
             ) THEN 'draft_ready'
             ELSE 'candidate'
           END,
           qualification_reasons_json = CAST('[]' AS JSON),
           error_message = NULL
       WHERE id = ?
         AND state = 'archived'`,
      [sourceId],
    );
    return result.affectedRows === 1;
  }

  async createProcessingJob(input: {
    sourceId: number;
    jobType: string;
    requestedBy: string | null;
    requestId?: string | null;
  }): Promise<number> {
    const [existingRows] = await this.pool.query<ProcessingJobRow[]>(
      `SELECT id, source_id
       FROM spec_factory_processing_jobs
       WHERE source_id = ?
         AND job_type = ?
         AND status IN ('queued', 'running')
       ORDER BY id DESC
       LIMIT 1`,
      [input.sourceId, input.jobType],
    );
    if (existingRows[0]) return existingRows[0].id;

    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO spec_factory_processing_jobs
       (source_id, job_type, status, requested_by, request_id)
       VALUES (?, ?, 'queued', ?, ?)`,
      [
        input.sourceId,
        input.jobType,
        input.requestedBy,
        input.requestId ?? currentSpecFactoryCorrelation().requestId ?? null,
      ],
    );
    specFactoryMetrics.recordWorkAccepted({
      workType: "draft",
      subtype: input.jobType,
    });
    return result.insertId;
  }

  async expireStaleProcessingJobs(input: {
    jobType: string;
    staleStartedBefore: Date;
    errorMessage: string;
  }): Promise<number> {
    const [rows] = await this.pool.query<ProcessingJobRow[]>(
      `SELECT id, source_id
       FROM spec_factory_processing_jobs
       WHERE job_type = ?
         AND status = 'running'
         AND started_at < ?
       ORDER BY started_at ASC, id ASC`,
      [input.jobType, input.staleStartedBefore],
    );
    if (rows.length === 0) return 0;

    const jobIds = rows.map((row) => row.id);
    const sourceIds = [...new Set(rows.map((row) => row.source_id))];
    const jobPlaceholders = jobIds.map(() => "?").join(", ");
    const sourcePlaceholders = sourceIds.map(() => "?").join(", ");

    await this.pool.query(
      `UPDATE spec_factory_processing_jobs
       SET status = 'failed',
           finished_at = CURRENT_TIMESTAMP(3),
           error_message = ?
       WHERE id IN (${jobPlaceholders})
         AND status = 'running'`,
      [input.errorMessage, ...jobIds],
    );

    await this.pool.query(
      `UPDATE spec_factory_sources s
       SET state = 'draft_ready',
           qualification_reasons_json = NULL,
           error_message = NULL
       WHERE s.id IN (${sourcePlaceholders})
         AND s.state = 'drafting'
         AND EXISTS (
           SELECT 1
           FROM spec_factory_drafts d
           WHERE d.source_id = s.id
             AND d.status = 'ready'
         )`,
      sourceIds,
    );

    await this.pool.query(
      `UPDATE spec_factory_sources s
       SET state = 'needs_attention',
           qualification_reasons_json = CAST(? AS JSON),
           error_message = ?
       WHERE s.id IN (${sourcePlaceholders})
         AND s.state = 'drafting'
         AND NOT EXISTS (
           SELECT 1
           FROM spec_factory_drafts d
           WHERE d.source_id = s.id
             AND d.status = 'ready'
         )`,
      [JSON.stringify(["generation_failed"]), input.errorMessage, ...sourceIds],
    );

    return rows.length;
  }

  /**
   * Age out 'queued' jobs whose worker likely died before claiming them
   * (e.g. a single-replica restart while a job sat in the queue) — together
   * with the 'drafting' source those queued jobs leave behind. Mirrors
   * expireStaleProcessingJobs (which only handles 'running' jobs): repair
   * the source to draft_ready when a ready draft already exists, otherwise
   * needs_attention. Returns the count of jobs that were aged out.
   */
  async expireStaleQueuedProcessingJobs(input: {
    jobType: string;
    queuedBefore: Date;
    errorMessage: string;
  }): Promise<number> {
    const [rows] = await this.pool.query<ProcessingJobRow[]>(
      `SELECT id, source_id
       FROM spec_factory_processing_jobs
       WHERE job_type = ?
         AND status = 'queued'
         AND created_at < ?
       ORDER BY created_at ASC, id ASC`,
      [input.jobType, input.queuedBefore],
    );
    if (rows.length === 0) return 0;

    const jobIds = rows.map((row) => row.id);
    const sourceIds = [...new Set(rows.map((row) => row.source_id))];
    const jobPlaceholders = jobIds.map(() => "?").join(", ");
    const sourcePlaceholders = sourceIds.map(() => "?").join(", ");

    await this.pool.query(
      `UPDATE spec_factory_processing_jobs
       SET status = 'failed',
           finished_at = CURRENT_TIMESTAMP(3),
           error_message = ?
       WHERE id IN (${jobPlaceholders})
         AND status = 'queued'`,
      [input.errorMessage, ...jobIds],
    );

    await this.pool.query(
      `UPDATE spec_factory_sources s
       SET state = 'draft_ready',
           qualification_reasons_json = NULL,
           error_message = NULL
       WHERE s.id IN (${sourcePlaceholders})
         AND s.state = 'drafting'
         AND EXISTS (
           SELECT 1
           FROM spec_factory_drafts d
           WHERE d.source_id = s.id
             AND d.status = 'ready'
         )`,
      sourceIds,
    );

    await this.pool.query(
      `UPDATE spec_factory_sources s
       SET state = 'needs_attention',
           qualification_reasons_json = CAST(? AS JSON),
           error_message = ?
       WHERE s.id IN (${sourcePlaceholders})
         AND s.state = 'drafting'
         AND NOT EXISTS (
           SELECT 1
           FROM spec_factory_drafts d
           WHERE d.source_id = s.id
             AND d.status = 'ready'
         )`,
      [JSON.stringify(["generation_failed"]), input.errorMessage, ...sourceIds],
    );

    return rows.length;
  }

  async createDraftWorkflow(input: {
    sourceId: number;
    idempotencyKey: string;
    requestedBy?: string | null;
    handoffSnapshotId?: number | null;
    immutableInput?: unknown;
  }): Promise<{ workflowId: number; deduplicated: boolean }> {
    const immutableInput = input.immutableInput ?? {
      sourceId: input.sourceId,
      handoffSnapshotId: input.handoffSnapshotId ?? null,
    };
    const inputSha256 = sha256Json(immutableInput);
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [sourceRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number | string }>
      >(
        `SELECT id
         FROM spec_factory_sources
         WHERE id = ?
           AND state <> 'archived'
         LIMIT 1
         FOR UPDATE`,
        [input.sourceId],
      );
      if (!sourceRows[0]) {
        throw new Error(`Spec Factory source ${input.sourceId} was not found`);
      }
      const [existingRows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            id: number | string;
            input_sha256: string;
          }
        >
      >(
        `SELECT id, input_sha256
         FROM spec_factory_draft_workflows
         WHERE source_id = ?
           AND idempotency_key = ?
         LIMIT 1
         FOR UPDATE`,
        [input.sourceId, input.idempotencyKey],
      );
      const existing = existingRows[0];
      if (existing) {
        if (existing.input_sha256 !== inputSha256) {
          throw new Error("idempotency_key_reused");
        }
        await connection.commit();
        return { workflowId: Number(existing.id), deduplicated: true };
      }
      const [activeRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number | string }>
      >(
        `SELECT id
         FROM spec_factory_draft_workflows
         WHERE source_id = ?
           AND status IN ('queued','running','publishing')
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE`,
        [input.sourceId],
      );
      if (activeRows[0]) {
        throw new Error(`draft_workflow_active:${activeRows[0].id}`);
      }
      const [workflowResult] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO spec_factory_draft_workflows
         (source_id, handoff_snapshot_id, idempotency_key, input_sha256,
          requested_by, status, current_stage)
         VALUES (?, ?, ?, ?, ?, 'queued', 'evidence_snapshot')`,
        [
          input.sourceId,
          input.handoffSnapshotId ?? null,
          input.idempotencyKey,
          inputSha256,
          input.requestedBy ?? null,
        ],
      );
      const workflowId = workflowResult.insertId;
      for (const [stageOrder, stageName] of DRAFT_WORKFLOW_STAGES.entries()) {
        await connection.query(
          `INSERT INTO spec_factory_draft_stage_runs
           (workflow_id, source_id, stage_name, stage_order, status,
            input_json, input_sha256, max_attempts)
           VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)`,
          [
            workflowId,
            input.sourceId,
            stageName,
            stageOrder,
            stageOrder === 0 ? "queued" : "blocked",
            JSON.stringify(stageOrder === 0 ? immutableInput : null),
            stageOrder === 0 ? inputSha256 : sha256Json(null),
            stageName === "jira_publish" || stageName === "oneshot_submit"
              ? 5
              : 3,
          ],
        );
      }
      await connection.query(
        `UPDATE spec_factory_sources
         SET state = 'drafting', error_message = NULL
         WHERE id = ?`,
        [input.sourceId],
      );
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "draft_workflow",
        aggregateId: workflowId,
        eventType: "draft.workflow.queued",
        dedupeKey: `draft-workflow:${workflowId}:queued`,
        payload: {
          workflowId,
          sourceId: input.sourceId,
          handoffSnapshotId: input.handoffSnapshotId ?? null,
          stage: "evidence_snapshot",
        },
      });
      await connection.commit();
      specFactoryMetrics.recordWorkAccepted({
        workType: "draft",
        subtype: "draft_workflow",
      });
      return { workflowId, deduplicated: false };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async claimNextDraftStage(input: {
    workerId: string;
    leaseMs?: number;
  }): Promise<ClaimedDraftStageRun | null> {
    const leaseSeconds = Math.max(
      30,
      Math.ceil((input.leaseMs ?? 15 * 60_000) / 1000),
    );
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            id: number | string;
            workflow_id: number | string;
            source_id: number | string;
            handoff_snapshot_id: number | string | null;
            stage_name: DraftWorkflowStage;
            stage_order: number | string;
            attempt_count: number | string;
            lease_generation: number | string;
            input_json: string | unknown | null;
          }
        >
      >(
        `SELECT stage.id, stage.workflow_id, stage.source_id,
                workflow.handoff_snapshot_id, stage.stage_name,
                stage.stage_order, stage.attempt_count,
                stage.lease_generation, stage.input_json
         FROM spec_factory_draft_stage_runs stage
         JOIN spec_factory_draft_workflows workflow ON workflow.id = stage.workflow_id
         JOIN spec_factory_sources source ON source.id = stage.source_id
         WHERE workflow.status IN ('queued','running','publishing')
           AND source.state <> 'archived'
           AND (
             stage.status = 'queued'
             OR (stage.status = 'running'
                 AND stage.lease_until < CURRENT_TIMESTAMP(3))
           )
           AND stage.attempt_count < stage.max_attempts
         ORDER BY stage.created_at ASC, stage.stage_order ASC, stage.id ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      const row = rows[0];
      if (!row) {
        await connection.commit();
        return null;
      }
      const leaseGeneration = Number(row.lease_generation) + 1;
      await connection.query(
        `UPDATE spec_factory_draft_stage_runs
         SET status = 'running',
             attempt_count = attempt_count + 1,
             lease_generation = ?,
             active_worker_id = ?,
             lease_until = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND),
             started_at = CURRENT_TIMESTAMP(3),
             completed_at = NULL,
             error_code = NULL,
             error_message = NULL
         WHERE id = ?`,
        [leaseGeneration, input.workerId, leaseSeconds, row.id],
      );
      await connection.query(
        `UPDATE spec_factory_draft_workflows
         SET status = CASE
               WHEN ? IN ('jira_publish','oneshot_submit') THEN 'publishing'
               ELSE 'running'
             END,
             current_stage = ?
         WHERE id = ?`,
        [row.stage_name, row.stage_name, row.workflow_id],
      );
      const [outputRows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            stage_name: DraftWorkflowStage;
            output_json: string | unknown | null;
          }
        >
      >(
        `SELECT stage_name, output_json
         FROM spec_factory_draft_stage_runs
         WHERE workflow_id = ?
           AND status = 'completed'
           AND stage_order < ?
         ORDER BY stage_order ASC`,
        [row.workflow_id, row.stage_order],
      );
      await connection.commit();
      const priorOutputs: Partial<Record<DraftWorkflowStage, unknown>> = {};
      for (const outputRow of outputRows) {
        priorOutputs[outputRow.stage_name] = safeParseJson(
          outputRow.output_json,
        ).value;
      }
      return {
        id: Number(row.id),
        workflowId: Number(row.workflow_id),
        sourceId: Number(row.source_id),
        handoffSnapshotId:
          row.handoff_snapshot_id === null
            ? null
            : Number(row.handoff_snapshot_id),
        stageName: row.stage_name,
        stageOrder: Number(row.stage_order),
        attemptCount: Number(row.attempt_count) + 1,
        leaseGeneration,
        workerId: input.workerId,
        input: safeParseJson(row.input_json).value,
        priorOutputs,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async queueDraftWorkflowApproval(input: {
    sourceId: number;
    draftId: number;
    actor: string;
  }): Promise<{ workflowId: number; deduplicated: boolean } | null> {
    const approval = {
      draftId: input.draftId,
      actor: input.actor,
      approvedAt: new Date().toISOString(),
    };
    const approvalSha256 = sha256Json(approval);
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<
        Array<
          mysql.RowDataPacket & {
            id: number | string;
            status: string;
            current_stage: string;
          }
        >
      >(
        `SELECT workflow.id, workflow.status, workflow.current_stage
         FROM spec_factory_draft_workflows workflow
         JOIN spec_factory_drafts draft ON draft.workflow_id = workflow.id
         JOIN spec_factory_sources source ON source.id = workflow.source_id
         WHERE workflow.source_id = ?
           AND draft.id = ?
           AND source.state <> 'archived'
         ORDER BY workflow.id DESC
         LIMIT 1
         FOR UPDATE`,
        [input.sourceId, input.draftId],
      );
      const workflow = rows[0];
      if (!workflow) {
        await connection.commit();
        return null;
      }
      const workflowId = Number(workflow.id);
      if (
        ["publishing", "published"].includes(workflow.status) ||
        ["jira_publish", "oneshot_submit"].includes(workflow.current_stage)
      ) {
        await connection.commit();
        return { workflowId, deduplicated: true };
      }
      if (
        workflow.status !== "approval_wait" ||
        workflow.current_stage !== "approval_wait"
      ) {
        throw new Error(`draft_workflow_not_awaiting_approval:${workflowId}`);
      }
      const approvalJson = JSON.stringify(approval);
      const [approvalResult] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE spec_factory_draft_stage_runs
           SET status = 'completed', output_json = CAST(? AS JSON),
               output_sha256 = ?, output_bytes = ?, completed_at = CURRENT_TIMESTAMP(3),
               error_code = NULL, error_message = NULL
           WHERE workflow_id = ?
             AND stage_name = 'approval_wait'
             AND status = 'waiting'`,
        [
          approvalJson,
          approvalSha256,
          Buffer.byteLength(approvalJson, "utf8"),
          workflowId,
        ],
      );
      if (approvalResult.affectedRows !== 1) {
        throw new Error(`draft_approval_fence_rejected:${workflowId}`);
      }
      await connection.query(
        `UPDATE spec_factory_draft_stage_runs
         SET status = 'queued', input_json = CAST(? AS JSON),
             input_sha256 = ?, error_code = NULL, error_message = NULL
         WHERE workflow_id = ?
           AND stage_name = 'jira_publish'
           AND status = 'blocked'`,
        [approvalJson, approvalSha256, workflowId],
      );
      await connection.query(
        `UPDATE spec_factory_draft_workflows
         SET status = 'publishing', current_stage = 'jira_publish',
             error_code = NULL, error_message = NULL
         WHERE id = ?`,
        [workflowId],
      );
      await connection.query(
        `UPDATE compose_handoffs
         SET status = 'publishing'
         WHERE draft_workflow_id = ?
           AND status NOT IN ('published','cancelled')`,
        [workflowId],
      );
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "draft_workflow",
        aggregateId: workflowId,
        eventType: "draft.workflow.approved",
        dedupeKey: `draft-workflow:${workflowId}:approved`,
        payload: {
          workflowId,
          sourceId: input.sourceId,
          draftId: input.draftId,
          stage: "jira_publish",
        },
      });
      await connection.commit();
      return { workflowId, deduplicated: false };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async completeDraftStage(input: {
    stageRun: ClaimedDraftStageRun;
    result: DraftStageExecutionOutput;
    durationMs: number;
  }): Promise<boolean> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number | string }>
      >(
        `SELECT stage.id
         FROM spec_factory_draft_stage_runs stage
         JOIN spec_factory_draft_workflows workflow ON workflow.id = stage.workflow_id
         JOIN spec_factory_sources source ON source.id = stage.source_id
         WHERE stage.id = ?
           AND stage.workflow_id = ?
           AND stage.status = 'running'
           AND stage.active_worker_id = ?
           AND stage.lease_generation = ?
           AND stage.lease_until >= CURRENT_TIMESTAMP(3)
           AND workflow.status IN ('running','publishing')
           AND source.state <> 'archived'
         LIMIT 1
         FOR UPDATE`,
        [
          input.stageRun.id,
          input.stageRun.workflowId,
          input.stageRun.workerId,
          input.stageRun.leaseGeneration,
        ],
      );
      if (!rows[0]) {
        await connection.commit();
        return false;
      }
      const outputSha256 =
        input.result.outputSha256 ?? sha256Json(input.result.output);
      const outputBytes =
        input.result.outputBytes ??
        Buffer.byteLength(canonicalJson(input.result.output), "utf8");
      await connection.query(
        `UPDATE spec_factory_draft_stage_runs
         SET status = 'completed', output_json = CAST(? AS JSON),
             output_artifact_uri = ?, output_sha256 = ?, output_bytes = ?,
             provider = ?, model = ?, prompt_version = ?, input_tokens = ?,
             output_tokens = ?, estimated_cost_usd = ?, duration_ms = ?,
             active_worker_id = NULL, lease_until = NULL,
             completed_at = CURRENT_TIMESTAMP(3), retryable = NULL
         WHERE id = ?`,
        [
          JSON.stringify(
            input.result.databaseOutput ?? input.result.output ?? null,
          ),
          input.result.outputArtifactUri ?? null,
          outputSha256,
          outputBytes,
          input.result.provider ?? null,
          input.result.model ?? null,
          input.result.promptVersion ?? null,
          input.result.inputTokens ?? null,
          input.result.outputTokens ?? null,
          input.result.estimatedCostUsd ?? null,
          input.durationMs,
          input.stageRun.id,
        ],
      );
      const nextStageOrder = input.stageRun.stageOrder + 1;
      const nextStage = DRAFT_WORKFLOW_STAGES[nextStageOrder];
      if (input.stageRun.stageName === "persist_draft") {
        await connection.query(
          `UPDATE spec_factory_draft_stage_runs
           SET status = 'waiting', input_json = CAST(? AS JSON),
               input_sha256 = ?
           WHERE workflow_id = ? AND stage_name = 'approval_wait'`,
          [
            JSON.stringify({
              priorStageRunId: input.stageRun.id,
              artifactUri: input.result.outputArtifactUri ?? null,
              priorOutputSha256: outputSha256,
              priorOutputBytes: outputBytes,
            }),
            outputSha256,
            input.stageRun.workflowId,
          ],
        );
        await connection.query(
          `UPDATE spec_factory_draft_workflows
           SET status = 'approval_wait', current_stage = 'approval_wait',
               evidence_snapshot_id = COALESCE(?, evidence_snapshot_id),
               draft_id = COALESCE(?, draft_id), error_code = NULL,
               error_message = NULL
           WHERE id = ?`,
          [
            input.result.evidenceSnapshotId ?? null,
            input.result.draftId ?? null,
            input.stageRun.workflowId,
          ],
        );
        await connection.query(
          `UPDATE compose_handoffs
           SET status = 'draft_ready'
           WHERE draft_workflow_id = ?
             AND status NOT IN ('published','cancelled')`,
          [input.stageRun.workflowId],
        );
      } else if (input.stageRun.stageName === "oneshot_submit") {
        await connection.query(
          `UPDATE spec_factory_draft_workflows
           SET status = 'published', current_stage = 'oneshot_submit',
               error_code = NULL, error_message = NULL,
               completed_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?`,
          [input.stageRun.workflowId],
        );
        await connection.query(
          `UPDATE compose_handoffs
           SET status = 'published', completed_at = CURRENT_TIMESTAMP(3),
               error_code = NULL, error_message = NULL
           WHERE draft_workflow_id = ?
             AND status <> 'cancelled'`,
          [input.stageRun.workflowId],
        );
      } else if (nextStage) {
        const nextInput = {
          priorStageRunId: input.stageRun.id,
          artifactUri: input.result.outputArtifactUri ?? null,
          priorOutputSha256: outputSha256,
          priorOutputBytes: outputBytes,
        };
        await connection.query(
          `UPDATE spec_factory_draft_stage_runs
           SET status = 'queued', input_json = CAST(? AS JSON),
               input_sha256 = ?
           WHERE workflow_id = ?
             AND stage_name = ?
             AND status = 'blocked'`,
          [
            JSON.stringify(nextInput),
            outputSha256,
            input.stageRun.workflowId,
            nextStage,
          ],
        );
        await connection.query(
          `UPDATE spec_factory_draft_workflows
           SET status = ?, current_stage = ?,
               evidence_snapshot_id = COALESCE(?, evidence_snapshot_id),
               draft_id = COALESCE(?, draft_id), error_code = NULL,
               error_message = NULL
           WHERE id = ?`,
          [
            input.stageRun.stageName === "jira_publish"
              ? "publishing"
              : "queued",
            nextStage,
            input.result.evidenceSnapshotId ?? null,
            input.result.draftId ?? null,
            input.stageRun.workflowId,
          ],
        );
        if (input.stageRun.stageName === "jira_publish") {
          await connection.query(
            `UPDATE compose_handoffs
             SET status = 'approved'
             WHERE draft_workflow_id = ?
               AND status NOT IN ('published','cancelled')`,
            [input.stageRun.workflowId],
          );
        }
      }
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "draft_workflow",
        aggregateId: input.stageRun.workflowId,
        eventType:
          input.stageRun.stageName === "persist_draft"
            ? "draft.workflow.approval_wait"
            : input.stageRun.stageName === "oneshot_submit"
              ? "draft.workflow.published"
              : "draft.stage.completed",
        dedupeKey: `draft-workflow:${input.stageRun.workflowId}:stage:${input.stageRun.stageName}:completed`,
        payload: {
          workflowId: input.stageRun.workflowId,
          sourceId: input.stageRun.sourceId,
          stageRunId: input.stageRun.id,
          stage: input.stageRun.stageName,
          nextStage:
            input.stageRun.stageName === "persist_draft"
              ? "approval_wait"
              : (nextStage ?? null),
          outputSha256,
        },
      });
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async failDraftStage(input: {
    stageRun: ClaimedDraftStageRun;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    durationMs: number;
  }): Promise<boolean> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<
        Array<
          mysql.RowDataPacket & { attempt_count: number; max_attempts: number }
        >
      >(
        `SELECT stage.attempt_count, stage.max_attempts
         FROM spec_factory_draft_stage_runs stage
         JOIN spec_factory_draft_workflows workflow
           ON workflow.id = stage.workflow_id
         JOIN spec_factory_sources source ON source.id = stage.source_id
         WHERE stage.id = ? AND stage.workflow_id = ?
           AND stage.status = 'running'
           AND stage.active_worker_id = ? AND stage.lease_generation = ?
           AND stage.lease_until >= CURRENT_TIMESTAMP(3)
           AND workflow.status IN ('running','publishing')
           AND source.state <> 'archived'
         LIMIT 1 FOR UPDATE`,
        [
          input.stageRun.id,
          input.stageRun.workflowId,
          input.stageRun.workerId,
          input.stageRun.leaseGeneration,
        ],
      );
      const row = rows[0];
      if (!row) {
        await connection.commit();
        return false;
      }
      const retry =
        input.retryable && Number(row.attempt_count) < Number(row.max_attempts);
      await connection.query(
        `UPDATE spec_factory_draft_stage_runs
         SET status = ?, active_worker_id = NULL, lease_until = NULL,
             error_code = ?, error_message = ?, retryable = ?, duration_ms = ?,
             completed_at = CASE WHEN ? THEN NULL ELSE CURRENT_TIMESTAMP(3) END
         WHERE id = ?`,
        [
          retry ? "queued" : "failed",
          input.errorCode.slice(0, 128),
          input.errorMessage.slice(0, 8000),
          input.retryable,
          input.durationMs,
          retry,
          input.stageRun.id,
        ],
      );
      if (!retry) {
        await connection.query(
          `UPDATE compose_handoffs
           SET status = 'failed', error_code = ?, error_message = ?
           WHERE draft_workflow_id = ?
             AND status NOT IN ('published','cancelled')`,
          [
            input.errorCode.slice(0, 128),
            input.errorMessage.slice(0, 8000),
            input.stageRun.workflowId,
          ],
        );
      }
      await connection.query(
        `UPDATE spec_factory_draft_workflows
         SET status = ?, error_code = ?, error_message = ?
         WHERE id = ?`,
        [
          retry &&
          ["jira_publish", "oneshot_submit"].includes(input.stageRun.stageName)
            ? "publishing"
            : retry
              ? "queued"
              : "failed",
          input.errorCode.slice(0, 128),
          input.errorMessage.slice(0, 8000),
          input.stageRun.workflowId,
        ],
      );
      await appendSpecFactoryOutboxEvent(connection, {
        aggregateType: "draft_workflow",
        aggregateId: input.stageRun.workflowId,
        eventType: retry ? "draft.stage.retry_queued" : "draft.stage.failed",
        dedupeKey: `draft-workflow:${input.stageRun.workflowId}:stage:${input.stageRun.stageName}:attempt:${input.stageRun.attemptCount}:failed`,
        payload: {
          workflowId: input.stageRun.workflowId,
          sourceId: input.stageRun.sourceId,
          stageRunId: input.stageRun.id,
          stage: input.stageRun.stageName,
          attempt: input.stageRun.attemptCount,
          retryable: retry,
          errorCode: input.errorCode,
        },
      });
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async claimNextProcessingJob(input: {
    jobType: string;
    workerId: string;
  }): Promise<{
    id: number;
    sourceId: number;
    requestId: string | null;
    queuedAt: string;
  } | null> {
    const connection =
      (await this.pool.getConnection()) as TransactionConnection;

    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<ProcessingJobRow[]>(
        `SELECT id, source_id, request_id, created_at
         FROM spec_factory_processing_jobs
         WHERE status = 'queued'
           AND job_type = ?
         ORDER BY created_at ASC, id ASC
         LIMIT 1
         FOR UPDATE`,
        [input.jobType],
      );
      const row = rows[0];
      if (!row) {
        await connection.commit();
        return null;
      }

      await connection.query(
        `UPDATE spec_factory_processing_jobs
         SET status = 'running',
             worker_id = ?,
             started_at = CURRENT_TIMESTAMP(3),
             error_message = NULL
         WHERE id = ?`,
        [input.workerId, row.id],
      );
      await connection.commit();
      return {
        id: row.id,
        sourceId: row.source_id,
        requestId: row.request_id,
        queuedAt: toIso(row.created_at),
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Mark a job succeeded ONLY if it is still running. Guards against the race
   * where expireStaleProcessingJobs already failed a slow-but-live job: without
   * `AND status = 'running'` a late-finishing worker would silently resurrect
   * the expired job to 'succeeded'. Returns false when the update did not land
   * (job already terminal) so the caller can log the lost race.
   */
  async completeProcessingJob(jobId: number): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_processing_jobs
       SET status = 'succeeded',
           finished_at = CURRENT_TIMESTAMP(3),
           error_message = NULL
       WHERE id = ?
         AND status = 'running'`,
      [jobId],
    );
    return result.affectedRows === 1;
  }

  /** Mark a job failed ONLY if still running (see completeProcessingJob). */
  async failProcessingJob(
    jobId: number,
    errorMessage: string,
  ): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_processing_jobs
       SET status = 'failed',
           finished_at = CURRENT_TIMESTAMP(3),
           error_message = ?
       WHERE id = ?
         AND status = 'running'`,
      [errorMessage, jobId],
    );
    return result.affectedRows === 1;
  }

  async getProcessingJobHealth(input: {
    staleStartedBefore: Date;
  }): Promise<SpecFactoryProcessingJobHealth> {
    const [rows] = await this.pool.query<ProcessingJobHealthRow[]>(
      `SELECT status,
              COUNT(*) AS count,
              MIN(created_at) AS oldest_created_at,
              MIN(started_at) AS oldest_started_at,
              SUM(CASE
                    WHEN status = 'running' AND started_at < ? THEN 1
                    ELSE 0
                  END) AS stale_running_count
       FROM spec_factory_processing_jobs
       GROUP BY status`,
      [input.staleStartedBefore],
    );
    const byStatus: SpecFactoryProcessingJobHealth["byStatus"] = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
    };
    let staleRunning = 0;
    let oldestQueuedAt: string | null = null;
    let oldestRunningAt: string | null = null;

    for (const row of rows) {
      const count = Number(row.count);
      byStatus[row.status] = Number.isFinite(count) ? count : 0;
      if (row.status === "queued" && row.oldest_created_at) {
        oldestQueuedAt = toIso(row.oldest_created_at);
      }
      if (row.status === "running") {
        staleRunning = Number(row.stale_running_count ?? 0) || 0;
        oldestRunningAt = row.oldest_started_at
          ? toIso(row.oldest_started_at)
          : row.oldest_created_at
            ? toIso(row.oldest_created_at)
            : null;
      }
    }

    return { byStatus, staleRunning, oldestQueuedAt, oldestRunningAt };
  }

  async recordEvent(
    sourceId: number,
    eventType: string,
    actor: string | null,
    metadata: unknown,
  ): Promise<void> {
    const requestId = currentSpecFactoryCorrelation().requestId ?? null;
    await this.pool.query(
      `INSERT INTO spec_factory_events
       (source_id, event_type, actor, request_id, metadata_json)
       VALUES (?, ?, ?, ?, CAST(? AS JSON))`,
      [sourceId, eventType, actor, requestId, JSON.stringify(metadata ?? null)],
    );
  }

  async listSourceEvents(
    sourceId: number,
    limit = 50,
  ): Promise<SpecFactoryEventSummary[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const [rows] = await this.pool.query<EventRow[]>(
      `SELECT id, source_id, event_type, actor, request_id, metadata_json, created_at
       FROM spec_factory_events
       WHERE source_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [sourceId, safeLimit],
    );
    return rows.map(mapEvent);
  }

  async listOneShotSubmissions(): Promise<
    SpecFactoryOneShotSubmissionSummary[]
  > {
    const [sourceRows] = await this.pool.query<SourceRow[]>(
      `SELECT id, source_jira_key, source_summary, source_status, loe_hours,
              state, origin, approved_epic_key, qualification_reasons_json,
              error_message, updated_at
       FROM spec_factory_sources
       WHERE state = 'oneshot_submitted'
       ORDER BY submitted_at DESC, updated_at DESC, id DESC
       LIMIT 200`,
    );
    if (sourceRows.length === 0) return [];

    const sourceIds = sourceRows.map((source) => source.id);
    const placeholders = sourceIds.map(() => "?").join(", ");
    const [childRows] = await this.pool.query<ChildRow[]>(
      `SELECT c.id, c.source_id, c.repo_name, c.summary, c.description,
              c.loe_hours, c.jira_key, c.state, c.oneshot_request_id,
              c.oneshot_run_id, c.error_message
       FROM spec_factory_child_tickets c
       INNER JOIN spec_factory_drafts d ON d.id = c.draft_id
       WHERE c.source_id IN (${placeholders})
         AND d.status = 'approved'
         AND d.version = (
           SELECT MAX(latest.version)
           FROM spec_factory_drafts latest
           WHERE latest.source_id = c.source_id
             AND latest.status = 'approved'
         )
       ORDER BY c.source_id ASC, c.id ASC`,
      sourceIds,
    );

    const childrenBySourceId = new Map<number, ChildRow[]>();
    for (const child of childRows) {
      const sourceId = child.source_id;
      if (sourceId === undefined) continue;
      childrenBySourceId.set(sourceId, [
        ...(childrenBySourceId.get(sourceId) ?? []),
        child,
      ]);
    }

    return sourceRows.map((source) => ({
      source: mapSource(source),
      childTickets: mapChildRows(childrenBySourceId.get(source.id) ?? [])
        .childTickets,
    }));
  }

  async listArchivedSources(): Promise<SpecFactorySourceSummary[]> {
    const [rows] = await this.pool.query<SourceRow[]>(
      `SELECT id, source_jira_key, source_summary, source_status, loe_hours,
              state, origin, approved_epic_key, qualification_reasons_json,
              error_message, updated_at
       FROM spec_factory_sources
       WHERE state = 'archived'
       ORDER BY updated_at DESC, id DESC
       LIMIT 200`,
    );

    return rows.map(mapSource);
  }
}
