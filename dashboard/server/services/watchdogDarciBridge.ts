import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type mysql from "mysql2/promise";
import { getPool, query } from "../db.js";
import type { WatchdogInvestigationScope } from "../types/watchdog.js";
import {
  appendWatchdogEvent,
  getWatchdogDarciMappingDiagnostics,
  getWatchdogSession,
  WatchdogServiceError,
} from "./watchdog.js";

type JsonColumn = string | Record<string, unknown> | unknown[] | null;

type HandoffRow = mysql.RowDataPacket & {
  id: string;
  session_id: string;
  run_attempt_id: string;
  finding_ids: JsonColumn;
  status: string;
  task_management_id: number | null;
  task_id: number | null;
  task_s3_bucket: string | null;
  task_s3_key: string | null;
  result_s3_bucket: string | null;
  result_s3_key: string | null;
  error_message: string | null;
};

type HandoffTaskStatusRow = mysql.RowDataPacket & {
  handoff_id: string;
  handoff_status: string;
  run_attempt_id: string;
  task_management_id: number;
  handoff_task_id: number | null;
  handoff_result_s3_bucket: string | null;
  handoff_result_s3_key: string | null;
  tm_status: string;
  tm_task_id: number | null;
  tm_error_message: string | null;
  task_status: string | null;
  task_result_s3_bucket: string | null;
  task_result_s3_key: string | null;
  task_error_message: string | null;
};

type FindingRow = mysql.RowDataPacket & {
  id: string;
  kind: string;
  severity: string;
  title: string;
  summary: string;
  details: string | null;
  evidence_ids: JsonColumn;
};

type EvidenceRow = mysql.RowDataPacket & {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  source_tool: string;
  source_ref_json: JsonColumn;
  time_window: JsonColumn;
};

type HandoffResultRow = mysql.RowDataPacket & {
  id: string;
  session_id: string;
  status: string;
  task_management_id: number | null;
  task_id: number | null;
  result_s3_bucket: string | null;
  result_s3_key: string | null;
};

function parseJson<T>(value: JsonColumn): T | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }
  return value as T;
}

function taskBucket() {
  const configured =
    process.env.WATCHDOG_DARCI_TASK_BUCKET ||
    process.env.S3_TASK_BUCKET ||
    process.env.TASK_BUCKET;
  if (configured?.trim()) {
    return configured.split(/\s+#/)[0].trim();
  }
  return `${process.env.S3_BUCKET_PREFIX || "specter"}-tasks`;
}

function taskRegion() {
  return (
    process.env.WATCHDOG_DARCI_TASK_REGION ||
    process.env.S3_TASK_REGION ||
    process.env.S3_REGION ||
    process.env.AWS_REGION ||
    "us-east-2"
  );
}

function taskReference(handoffId: string) {
  return `WATCHDOG-${handoffId.replace(/^wdg_darci_/, "").slice(0, 12).toUpperCase()}`;
}

function taskKey(reference: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `tasks/${reference}/${timestamp}.md`;
}

function formatJsonBlock(value: unknown) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function buildDarciTaskDescription(input: {
  handoffId: string;
  sessionId: string;
  runAttemptId: string;
  correlationId: string;
  scope?: WatchdogInvestigationScope;
  findings: FindingRow[];
  evidence: EvidenceRow[];
}) {
  return [
    `# Watchdog DARCI Handoff`,
    ``,
    `Analyze the code-level causes that could explain the Watchdog log findings below. Do not re-query CloudWatch. Use the provided redacted evidence metadata and inspect the mapped repositories for likely root cause, ownership, and candidate fixes.`,
    ``,
    `## Investigation`,
    ``,
    `- Watchdog session: \`${input.sessionId}\``,
    `- Run attempt: \`${input.runAttemptId}\``,
    `- Handoff: \`${input.handoffId}\``,
    `- Correlation id: \`${input.correlationId}\``,
    ``,
    `## Approved Scope`,
    ``,
    formatJsonBlock(input.scope || {}),
    ``,
    `## Findings`,
    ``,
    ...input.findings.flatMap((finding, index) => [
      `### ${index + 1}. ${finding.title}`,
      ``,
      `- Finding id: \`${finding.id}\``,
      `- Kind: \`${finding.kind}\``,
      `- Severity: \`${finding.severity}\``,
      ``,
      finding.summary,
      ``,
      finding.details ? formatJsonBlock(safeParse(finding.details)) : "",
      ``,
    ]),
    `## Evidence Metadata`,
    ``,
    ...input.evidence.flatMap((artifact, index) => [
      `### ${index + 1}. ${artifact.title}`,
      ``,
      `- Evidence id: \`${artifact.id}\``,
      `- Kind: \`${artifact.kind}\``,
      `- Source tool: \`${artifact.source_tool}\``,
      artifact.summary ? `- Summary: ${artifact.summary}` : "",
      ``,
      formatJsonBlock({
        sourceRef: parseJson(artifact.source_ref_json) || {},
        timeWindow: parseJson(artifact.time_window) || {},
      }),
      ``,
    ]),
    `## DARCI Output Expectations`,
    ``,
    `Return a concise root-cause analysis with: likely code areas, evidence-to-code reasoning, risk, and recommended next actions. Cite Watchdog finding/evidence ids when making claims.`,
    ``,
  ].filter((line) => line !== "").join("\n");
}

function safeParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function uploadTaskDescription(reference: string, content: string) {
  const bucket = taskBucket();
  const key = taskKey(reference);
  const client = new S3Client({
    region: taskRegion(),
  });
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: content,
    ContentType: "text/markdown",
    Metadata: {
      jiraNumber: reference,
      uploadedAt: new Date().toISOString(),
      type: "watchdog_darci_task",
    },
  }));
  return { bucket, key };
}

async function streamToString(body: unknown) {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  const stream = body as AsyncIterable<Uint8Array>;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function downloadMarkdown(bucket: string, key: string) {
  const client = new S3Client({ region: taskRegion() });
  const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return streamToString(response.Body);
}

export async function createDarciTaskForWatchdogHandoff(sessionId: string, handoffId: string) {
  const session = await getWatchdogSession(sessionId);
  if (!session?.latestRunAttempt) {
    throw new WatchdogServiceError("Watchdog session or run attempt not found", 404, "session_not_found");
  }
  const handoffRows = await query<HandoffRow>(
    "SELECT * FROM watchdog_darci_handoffs WHERE id = ? AND session_id = ? LIMIT 1",
    [handoffId, sessionId],
  );
  const handoff = handoffRows[0];
  if (!handoff) {
    throw new WatchdogServiceError("DARCI handoff not found", 404, "handoff_not_found");
  }
  if (handoff.task_management_id) {
    throw new WatchdogServiceError("DARCI task already exists for this handoff", 409, "handoff_task_exists");
  }
  if (handoff.status !== "queued" && handoff.status !== "failed") {
    throw new WatchdogServiceError("DARCI handoff is not task-creatable from its current state", 409, "handoff_not_queued");
  }

  const mapping = await getWatchdogDarciMappingDiagnostics(sessionId, { createMissingCustomer: true });
  if (!mapping.proposed.ready || !mapping.proposed.agentId || !mapping.proposed.customerId || !mapping.proposed.relatedCode) {
    throw new WatchdogServiceError(
      `DARCI mapping is not ready: ${mapping.proposed.blockers.join("; ") || "unknown mapping blocker"}`,
      409,
      "darci_mapping_not_ready",
    );
  }

  const findingIds = parseJson<string[]>(handoff.finding_ids) || [];
  const findings = findingIds.length > 0
    ? await query<FindingRow>(
      `SELECT * FROM watchdog_findings WHERE session_id = ? AND id IN (${findingIds.map(() => "?").join(",")})`,
      [sessionId, ...findingIds],
    )
    : [];
  const evidenceIds = Array.from(new Set(
    findings.flatMap((finding) => parseJson<string[]>(finding.evidence_ids) || []),
  ));
  const evidence = evidenceIds.length > 0
    ? await query<EvidenceRow>(
      `SELECT * FROM watchdog_evidence_artifacts WHERE session_id = ? AND id IN (${evidenceIds.map(() => "?").join(",")})`,
      [sessionId, ...evidenceIds],
    )
    : [];

  const reference = taskReference(handoffId);
  const description = buildDarciTaskDescription({
    handoffId,
    sessionId,
    runAttemptId: session.latestRunAttempt.id,
    correlationId: session.latestRunAttempt.correlationId,
    scope: session.latestRunAttempt.approvedScope || session.approvedScope,
    findings,
    evidence,
  });

  try {
    const uploaded = await uploadTaskDescription(reference, description);
    const [insertResult] = await getPool().execute<mysql.ResultSetHeader>(
      `
        INSERT INTO task_management (
          jira_number, customer_id, agent_id, related_code, task_type,
          task_s3_bucket, task_s3_key, source, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'api', 'assigned')
      `,
      [
        reference,
        mapping.proposed.customerId,
        mapping.proposed.agentId,
        mapping.proposed.relatedCode,
        mapping.proposed.taskType || "defect_analysis",
        uploaded.bucket,
        uploaded.key,
      ],
    );
    await getPool().execute(
      `
        UPDATE watchdog_darci_handoffs
        SET status = 'task_created',
            task_management_id = ?,
            task_s3_bucket = ?,
            task_s3_key = ?,
            error_message = NULL,
            updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = ?
      `,
      [insertResult.insertId, uploaded.bucket, uploaded.key, handoffId],
    );
    await appendWatchdogEvent({
      sessionId,
      runAttemptId: session.latestRunAttempt.id,
      correlationId: session.latestRunAttempt.correlationId,
      eventType: "darci_handoff.updated",
      payload: {
        handoffId,
        status: "task_created",
        taskManagementId: insertResult.insertId,
        taskS3Bucket: uploaded.bucket,
        taskS3Key: uploaded.key,
      },
    });
    return {
      handoffId,
      status: "task_created",
      taskManagementId: insertResult.insertId,
      taskS3Bucket: uploaded.bucket,
      taskS3Key: uploaded.key,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await getPool().execute(
      `
        UPDATE watchdog_darci_handoffs
        SET status = 'failed',
            error_message = ?,
            updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = ?
      `,
      [message, handoffId],
    );
    await appendWatchdogEvent({
      sessionId,
      runAttemptId: session.latestRunAttempt.id,
      correlationId: session.latestRunAttempt.correlationId,
      eventType: "darci_handoff.updated",
      payload: { handoffId, status: "failed", errorMessage: message },
    });
    throw new WatchdogServiceError(`DARCI task bridge failed: ${message}`, 502, "darci_task_bridge_failed");
  }
}

function watchdogStatusFromTask(row: HandoffTaskStatusRow) {
  if (row.tm_status === "failed" || row.task_status === "failed") return "failed";
  if (row.tm_status === "completed" || row.tm_status === "posted_to_jira" || row.tm_status === "posting_to_jira") {
    return row.task_result_s3_bucket && row.task_result_s3_key ? "delivered" : "delivering";
  }
  if (row.tm_status === "in_progress" || row.task_status === "in_progress") return "running";
  return "task_created";
}

export async function syncDarciTaskForWatchdogHandoff(sessionId: string, handoffId: string) {
  const session = await getWatchdogSession(sessionId);
  if (!session?.latestRunAttempt) {
    throw new WatchdogServiceError("Watchdog session or run attempt not found", 404, "session_not_found");
  }

  const rows = await query<HandoffTaskStatusRow>(
    `
      SELECT
        h.id AS handoff_id,
        h.status AS handoff_status,
        h.run_attempt_id,
        h.task_management_id,
        h.task_id AS handoff_task_id,
        h.result_s3_bucket AS handoff_result_s3_bucket,
        h.result_s3_key AS handoff_result_s3_key,
        tm.status AS tm_status,
        tm.task_id AS tm_task_id,
        tm.error_message AS tm_error_message,
        t.status AS task_status,
        t.result_s3_bucket AS task_result_s3_bucket,
        t.result_s3_key AS task_result_s3_key,
        t.error_message AS task_error_message
      FROM watchdog_darci_handoffs h
      LEFT JOIN task_management tm ON tm.id = h.task_management_id
      LEFT JOIN tasks t ON t.id = tm.task_id
      WHERE h.id = ? AND h.session_id = ?
      LIMIT 1
    `,
    [handoffId, sessionId],
  );
  const row = rows[0];
  if (!row) {
    throw new WatchdogServiceError("DARCI handoff not found", 404, "handoff_not_found");
  }
  if (!row.task_management_id) {
    throw new WatchdogServiceError("DARCI task has not been created for this handoff", 409, "handoff_task_missing");
  }

  const nextStatus = watchdogStatusFromTask(row);
  const nextTaskId = row.tm_task_id || row.handoff_task_id || null;
  const nextResultBucket = row.task_result_s3_bucket || row.handoff_result_s3_bucket || null;
  const nextResultKey = row.task_result_s3_key || row.handoff_result_s3_key || null;
  const nextError = row.task_error_message || row.tm_error_message || null;
  const finished = nextStatus === "delivered" || nextStatus === "failed";

  const changed =
    row.handoff_status !== nextStatus ||
    row.handoff_task_id !== nextTaskId ||
    row.handoff_result_s3_bucket !== nextResultBucket ||
    row.handoff_result_s3_key !== nextResultKey;

  if (changed) {
    await getPool().execute(
      `
        UPDATE watchdog_darci_handoffs
        SET status = ?,
            task_id = ?,
            result_s3_bucket = ?,
            result_s3_key = ?,
            error_message = ?,
            finished_at = CASE WHEN ? THEN CURRENT_TIMESTAMP(3) ELSE finished_at END,
            updated_at = CURRENT_TIMESTAMP(3)
        WHERE id = ?
      `,
      [nextStatus, nextTaskId, nextResultBucket, nextResultKey, nextError, finished, handoffId],
    );
    await appendWatchdogEvent({
      sessionId,
      runAttemptId: row.run_attempt_id,
      correlationId: session.latestRunAttempt.correlationId,
      eventType: "darci_handoff.updated",
      payload: {
        handoffId,
        status: nextStatus,
        taskManagementId: row.task_management_id,
        taskId: nextTaskId || undefined,
        resultS3Bucket: nextResultBucket || undefined,
        resultS3Key: nextResultKey || undefined,
        errorMessage: nextError || undefined,
      },
    });
  }

  return {
    handoffId,
    status: nextStatus,
    taskManagementId: row.task_management_id,
    taskId: nextTaskId || undefined,
    resultS3Bucket: nextResultBucket || undefined,
    resultS3Key: nextResultKey || undefined,
    errorMessage: nextError || undefined,
    changed,
  };
}

export async function getDarciResultForWatchdogHandoff(sessionId: string, handoffId: string) {
  await syncDarciTaskForWatchdogHandoff(sessionId, handoffId).catch(() => undefined);
  const rows = await query<HandoffResultRow>(
    `
      SELECT
        id, session_id, status, task_management_id, task_id, result_s3_bucket, result_s3_key
      FROM watchdog_darci_handoffs
      WHERE id = ? AND session_id = ?
      LIMIT 1
    `,
    [handoffId, sessionId],
  );
  const handoff = rows[0];
  if (!handoff) {
    throw new WatchdogServiceError("DARCI handoff not found", 404, "handoff_not_found");
  }
  if (!handoff.result_s3_bucket || !handoff.result_s3_key) {
    throw new WatchdogServiceError("DARCI result is not available yet", 409, "darci_result_not_ready");
  }

  const markdown = await downloadMarkdown(handoff.result_s3_bucket, handoff.result_s3_key);
  return {
    handoffId,
    sessionId,
    status: handoff.status,
    taskManagementId: handoff.task_management_id ?? undefined,
    taskId: handoff.task_id ?? undefined,
    resultS3Bucket: handoff.result_s3_bucket,
    resultS3Key: handoff.result_s3_key,
    contentType: "text/markdown",
    markdown,
  };
}
