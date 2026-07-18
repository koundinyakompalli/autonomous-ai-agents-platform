import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type mysql from "mysql2/promise";
import { getPool } from "../db.js";
import type { OperatorIdentity } from "../types/oneshotDeployments.js";
import type { OneShotProgressStage } from "../types/oneshot.js";
import { parseDashboardId } from "./oneshotRowHelpers.js";
import {
  terminateOneShotRun,
} from "./oneshotRunTerminations.js";

type RestartStage = Exclude<
  OneShotProgressStage,
  "qualification" | "pr_complete"
>;

type QueuedRestartState =
  | "queued_for_planning"
  | "queued_for_review"
  | "queued_for_implementation"
  | "queued_for_code_review"
  | "queued_for_testing";

type RunControlRow = mysql.RowDataPacket & {
  id: number;
  jira_key: string;
  state: string;
  run_group_id: number | null;
  source_task_management_id: number;
  final_disposition: string | null;
  last_error: string | null;
  current_plan_version: number | null;
  current_review_version: number | null;
  current_implementation_version: number | null;
  current_implementation_branch: string | null;
  current_implementation_commit_sha: string | null;
  current_code_review_version: number | null;
  current_test_version: number | null;
};

type BundleRunRow = mysql.RowDataPacket & {
  id: number;
  jira_key: string;
  run_group_id: number | null;
  source_task_management_id: number;
};

type BundleGroupRow = mysql.RowDataPacket & {
  id: number;
  source_task_management_id: number;
};

type ArtifactRow = mysql.RowDataPacket & {
  oneshot_run_id: number;
  s3_bucket: string;
  s3_key: string;
};

type TaskRow = mysql.RowDataPacket & {
  id: number;
  task_id: number | null;
  task_s3_bucket: string | null;
  task_s3_key: string | null;
};

type TaskArtifactRow = mysql.RowDataPacket & {
  id: number;
  result_s3_bucket: string | null;
  result_s3_key: string | null;
};

type IdRow = mysql.RowDataPacket & {
  id: number;
};

type RestartPlan = {
  stage: RestartStage;
  queuedState: QueuedRestartState;
  version: number;
  revision: boolean;
  expectedImplementationCommitSha?: string | null;
  expectedImplementationVersion?: number | null;
  invalidatedPointers: InvalidatedPointer[];
  updates: Record<string, number | string | null>;
};

type VersionPointerColumn =
  | "current_plan_version"
  | "current_review_version"
  | "current_implementation_version"
  | "current_code_review_version"
  | "current_test_version";

type InvalidatedPointer = {
  column: VersionPointerColumn;
  from: number;
  to: number;
};

type S3ObjectRef = {
  bucket: string;
  key: string;
};

type S3PrefixRef = {
  bucket: string;
  prefix: string;
};

type S3PurgeTargets = {
  objects: S3ObjectRef[];
  prefixes: S3PrefixRef[];
};

type S3PurgeResult = {
  deletedObjects: number;
  objects: S3ObjectRef[];
  prefixes: S3PrefixRef[];
};

export class OneShotRunControlError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "OneShotRunControlError";
  }
}

function normalizeRestartStage(stage: unknown): RestartStage | null {
  switch (stage) {
    case "planning":
    case "review":
    case "implementation":
    case "code_review":
    case "testing":
      return stage;
    default:
      return null;
  }
}

function queuedStateForStage(stage: RestartStage): QueuedRestartState {
  switch (stage) {
    case "planning":
      return "queued_for_planning";
    case "review":
      return "queued_for_review";
    case "implementation":
      return "queued_for_implementation";
    case "code_review":
      return "queued_for_code_review";
    case "testing":
      return "queued_for_testing";
  }
}

function queueEnvForStage(stage: RestartStage): string {
  switch (stage) {
    case "planning":
      return "ONESHOT_PLANNING_QUEUE_URL";
    case "review":
      return "ONESHOT_REVIEW_QUEUE_URL";
    case "implementation":
      return "ONESHOT_IMPLEMENTATION_QUEUE_URL";
    case "code_review":
      return "ONESHOT_CODE_REVIEW_QUEUE_URL";
    case "testing":
      return "ONESHOT_TESTING_QUEUE_URL";
  }
}

function parseRunDashboardId(dashboardId: string): number {
  const lookup = parseDashboardId(dashboardId);
  if (!lookup || lookup.kind !== "run") {
    throw new OneShotRunControlError(
      "Only OneShot run rows support this operator action.",
      409,
    );
  }
  return lookup.id;
}

function buildPlaceholders(values: readonly unknown[]): string {
  if (values.length === 0) {
    throw new Error("Cannot build SQL placeholders for an empty value list");
  }
  return values.map(() => "?").join(", ");
}

function uniqueNumbers(values: Array<number | null | undefined>): number[] {
  return [...new Set(values.filter((value): value is number =>
    typeof value === "number" && Number.isInteger(value) && value > 0,
  ))];
}

function bumpVersionPointer(
  updates: Record<string, number | string | null>,
  invalidatedPointers: InvalidatedPointer[],
  column: VersionPointerColumn,
  currentValue: number | null,
): number | null {
  if (currentValue === null) {
    return null;
  }

  const nextValue = currentValue + 1;
  updates[column] = nextValue;
  invalidatedPointers.push({
    column,
    from: currentValue,
    to: nextValue,
  });
  return nextValue;
}

function advanceVersionPointer(
  updates: Record<string, number | string | null>,
  invalidatedPointers: InvalidatedPointer[],
  column: VersionPointerColumn,
  currentValue: number | null,
): number {
  const nextValue = (currentValue ?? 0) + 1;
  updates[column] = nextValue;
  if (currentValue !== null) {
    invalidatedPointers.push({
      column,
      from: currentValue,
      to: nextValue,
    });
  }
  return nextValue;
}

function buildRestartPlan(run: RunControlRow, stage: RestartStage): RestartPlan {
  const queuedState = queuedStateForStage(stage);
  switch (stage) {
    case "planning": {
      const updates: RestartPlan["updates"] = {
        planning_attempt_count: 0,
        review_loop_count: 0,
        implementation_attempt_count: 0,
        code_review_attempt_count: 0,
        verification_loop_count: 0,
        current_implementation_commit_sha: null,
      };
      const invalidatedPointers: InvalidatedPointer[] = [];
      bumpVersionPointer(
        updates,
        invalidatedPointers,
        "current_review_version",
        run.current_review_version,
      );
      bumpVersionPointer(
        updates,
        invalidatedPointers,
        "current_implementation_version",
        run.current_implementation_version,
      );
      bumpVersionPointer(
        updates,
        invalidatedPointers,
        "current_code_review_version",
        run.current_code_review_version,
      );
      bumpVersionPointer(
        updates,
        invalidatedPointers,
        "current_test_version",
        run.current_test_version,
      );
      return {
        stage,
        queuedState,
        version: (run.current_plan_version ?? 0) + 1,
        revision:
          run.current_plan_version !== null &&
          run.final_disposition !== "replan_requested",
        invalidatedPointers,
        updates,
      };
    }
    case "review": {
      if (!run.current_plan_version) {
        throw new OneShotRunControlError(
          "Cannot restart review without an approved plan version.",
          409,
        );
      }
      const updates: RestartPlan["updates"] = {
        review_loop_count: 0,
        implementation_attempt_count: 0,
        code_review_attempt_count: 0,
        verification_loop_count: 0,
        current_implementation_commit_sha: null,
      };
      const invalidatedPointers: InvalidatedPointer[] = [];
      bumpVersionPointer(
        updates,
        invalidatedPointers,
        "current_review_version",
        run.current_review_version,
      );
      bumpVersionPointer(
        updates,
        invalidatedPointers,
        "current_implementation_version",
        run.current_implementation_version,
      );
      bumpVersionPointer(
        updates,
        invalidatedPointers,
        "current_code_review_version",
        run.current_code_review_version,
      );
      bumpVersionPointer(
        updates,
        invalidatedPointers,
        "current_test_version",
        run.current_test_version,
      );
      return {
        stage,
        queuedState,
        version: run.current_plan_version,
        revision: false,
        invalidatedPointers,
        updates,
      };
    }
    case "implementation": {
      const updates: RestartPlan["updates"] = {};
      const invalidatedPointers: InvalidatedPointer[] = [];
      const implementationVersion = advanceVersionPointer(
        updates,
        invalidatedPointers,
        "current_implementation_version",
        run.current_implementation_version,
      );
      Object.assign(updates, {
        implementation_attempt_count: 0,
        code_review_attempt_count: 0,
        verification_loop_count: 0,
        current_implementation_commit_sha: null,
      });
      bumpVersionPointer(
        updates,
        invalidatedPointers,
        "current_code_review_version",
        run.current_code_review_version,
      );
      bumpVersionPointer(
        updates,
        invalidatedPointers,
        "current_test_version",
        run.current_test_version,
      );
      return {
        stage,
        queuedState,
        version: implementationVersion,
        revision: Boolean(
          run.current_implementation_branch &&
            run.current_implementation_commit_sha,
        ),
        invalidatedPointers,
        updates,
      };
    }
    case "code_review":
      if (!run.current_implementation_version) {
        throw new OneShotRunControlError(
          "Cannot restart code review without an implementation version.",
          409,
        );
      }
      if (!run.current_implementation_branch || !run.current_implementation_commit_sha) {
        throw new OneShotRunControlError(
          "Cannot restart code review without an implementation branch and commit.",
          409,
        );
      }
      const codeReviewUpdates: RestartPlan["updates"] = {};
      const codeReviewInvalidatedPointers: InvalidatedPointer[] = [];
      const codeReviewVersion = advanceVersionPointer(
        codeReviewUpdates,
        codeReviewInvalidatedPointers,
        "current_code_review_version",
        run.current_code_review_version,
      );
      Object.assign(codeReviewUpdates, {
        code_review_attempt_count: 0,
        verification_loop_count: 0,
      });
      bumpVersionPointer(
        codeReviewUpdates,
        codeReviewInvalidatedPointers,
        "current_test_version",
        run.current_test_version,
      );
      return {
        stage,
        queuedState,
        version: codeReviewVersion,
        revision: false,
        expectedImplementationCommitSha: run.current_implementation_commit_sha,
        expectedImplementationVersion: run.current_implementation_version,
        invalidatedPointers: codeReviewInvalidatedPointers,
        updates: codeReviewUpdates,
      };
    case "testing":
      if (!run.current_implementation_version) {
        throw new OneShotRunControlError(
          "Cannot restart testing without an implementation version.",
          409,
        );
      }
      if (!run.current_implementation_branch || !run.current_implementation_commit_sha) {
        throw new OneShotRunControlError(
          "Cannot restart testing without an implementation branch and commit.",
          409,
        );
      }
      const testingUpdates: RestartPlan["updates"] = {};
      const testingInvalidatedPointers: InvalidatedPointer[] = [];
      const testVersion = advanceVersionPointer(
        testingUpdates,
        testingInvalidatedPointers,
        "current_test_version",
        run.current_test_version,
      );
      testingUpdates.verification_loop_count = 0;
      return {
        stage,
        queuedState,
        version: testVersion,
        revision: false,
        expectedImplementationCommitSha: run.current_implementation_commit_sha,
        expectedImplementationVersion: run.current_implementation_version,
        invalidatedPointers: testingInvalidatedPointers,
        updates: testingUpdates,
      };
  }
}

function buildRestartUpdate(plan: RestartPlan): {
  sql: string;
  values: Array<number | string | null>;
} {
  const setClauses = [
    "state = ?",
    "last_error = NULL",
    "final_disposition = NULL",
    "current_pr_url = NULL",
    "updated_at = NOW()",
  ];
  const values: Array<number | string | null> = [plan.queuedState];

  for (const [column, value] of Object.entries(plan.updates)) {
    setClauses.push(`${column} = ?`);
    values.push(value);
  }

  return {
    sql: `UPDATE oneshot_runs SET ${setClauses.join(", ")} WHERE id = ? AND state = ?`,
    values,
  };
}

async function publishRestartMessage(
  runId: number,
  plan: RestartPlan,
  dedupeToken: string,
  sqsClient = new SQSClient({ region: process.env.AWS_REGION || "us-east-2" }),
): Promise<void> {
  const queueUrl = process.env[queueEnvForStage(plan.stage)];
  if (!queueUrl) {
    throw new Error(
      `Missing required OneShot queue environment variable: ${queueEnvForStage(plan.stage)}`,
    );
  }

  const message = {
    run_id: runId,
    stage: plan.stage,
    version: plan.version,
    expected_state: plan.queuedState,
    revision: plan.revision,
    emitted_at: new Date().toISOString(),
    ...(plan.expectedImplementationCommitSha
      ? { expected_implementation_commit_sha: plan.expectedImplementationCommitSha }
      : {}),
    ...(plan.expectedImplementationVersion
      ? { expected_implementation_version: plan.expectedImplementationVersion }
      : {}),
  };
  const dedupeKind = plan.revision ? "revision" : "base";

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: String(runId),
      MessageDeduplicationId:
        `${runId}:${plan.stage}:${plan.version}:${dedupeKind}:${dedupeToken}`,
    }),
  );
}

function truncateMetadataText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
}

export async function stopOneShotRun(
  input: {
    dashboardId: string;
    operator: OperatorIdentity;
    reason?: string;
  },
): Promise<{ oneshotRunId: number; workspaceCleanupSucceeded: boolean }> {
  const oneshotRunId = parseRunDashboardId(input.dashboardId);
  try {
    return await terminateOneShotRun({
      oneshotRunId,
      operator: input.operator,
      reason: input.reason,
    });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === "number") {
      throw new OneShotRunControlError(
        error instanceof Error ? error.message : String(error),
        statusCode,
      );
    }
    throw error;
  }
}

export async function restartOneShotRunStage(
  input: {
    dashboardId: string;
    stage: unknown;
    operator: OperatorIdentity;
    reason?: string;
  },
  deps: {
    publish?: (
      runId: number,
      plan: RestartPlan,
      dedupeToken: string,
    ) => Promise<void>;
  } = {},
): Promise<{
  oneshotRunId: number;
  stage: RestartStage;
  state: QueuedRestartState;
  version: number;
  publishError?: string;
}> {
  const runId = parseRunDashboardId(input.dashboardId);
  const stage = normalizeRestartStage(input.stage);
  if (!stage) {
    throw new OneShotRunControlError(
      "stage must be one of planning, review, implementation, code_review, testing.",
      400,
    );
  }

  const connection = await getPool().getConnection();
  let plan: RestartPlan | null = null;
  let eventId = 0;

  try {
    await connection.beginTransaction();

    const [rows] = await connection.query<RunControlRow[]>(
      `SELECT
         id,
         jira_key,
         state,
         run_group_id,
         source_task_management_id,
         final_disposition,
         last_error,
         current_plan_version,
         current_review_version,
         current_implementation_version,
         current_implementation_branch,
         current_implementation_commit_sha,
         current_code_review_version,
         current_test_version
       FROM oneshot_runs
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [runId],
    );
    const run = rows[0] ?? null;
    if (!run) {
      throw new OneShotRunControlError("OneShot run not found.", 404);
    }

    plan = buildRestartPlan(run, stage);
    const update = buildRestartUpdate(plan);
    const [updateResult] = await connection.query<mysql.ResultSetHeader>(
      update.sql,
      [...update.values, run.id, run.state],
    );
    if (updateResult.affectedRows !== 1) {
      throw new OneShotRunControlError(
        `OneShot run ${run.id} changed state before restart could be queued.`,
        409,
      );
    }

    const [eventResult] = await connection.query<mysql.ResultSetHeader>(
      `INSERT INTO oneshot_run_events
         (oneshot_run_id, event_type, from_state, to_state, stage, metadata_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        run.id,
        "state_transition",
        run.state,
        plan.queuedState,
        plan.stage,
        JSON.stringify({
          reason: "manual_stage_restart",
          operatorId: input.operator.id,
          operatorDisplay: input.operator.display,
          operatorReason: input.reason?.trim() || undefined,
          version: plan.version,
          revision: plan.revision,
          previousFinalDisposition: run.final_disposition,
          previousLastError: truncateMetadataText(run.last_error),
          invalidatedPointers: plan.invalidatedPointers,
          dispatchMode: "safe_fifo",
        }),
      ],
    );
    eventId = Number(eventResult.insertId);

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  if (!plan) {
    throw new OneShotRunControlError("Restart plan was not created.", 500);
  }

  const dedupeToken = Number.isFinite(eventId) && eventId > 0
    ? `manual-restart:${eventId}`
    : `manual-restart:${Date.now()}`;
  let publishError: string | undefined;
  try {
    await (deps.publish ?? publishRestartMessage)(runId, plan, dedupeToken);
  } catch (error) {
    publishError = error instanceof Error ? error.message : String(error);
  }

  return {
    oneshotRunId: runId,
    stage: plan.stage,
    state: plan.queuedState,
    version: plan.version,
    publishError,
  };
}

function makeObjectKey(bucket: string, key: string): string {
  return `${bucket}\n${key}`;
}

function makePrefixKey(bucket: string, prefix: string): string {
  return `${bucket}\n${prefix}`;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function configuredArtifactBucket(): string | null {
  return nonEmptyString(process.env.ONESHOT_ARTIFACT_BUCKET);
}

function configuredArtifactPrefix(): string {
  return (
    nonEmptyString(process.env.ONESHOT_ARTIFACT_PREFIX)
      ?.replace(/^\/+/, "")
      .replace(/\/+$/, "") || "oneshot"
  );
}

function deriveRunPrefix(key: string, runId: number): string | null {
  const marker = `run-${runId}/`;
  const index = key.indexOf(marker);
  if (index < 0) {
    return null;
  }
  return key.slice(0, index + marker.length);
}

function addS3Object(
  objects: S3ObjectRef[],
  objectKeys: Set<string>,
  bucket: string | null,
  key: string | null,
): void {
  if (!bucket || !key) {
    return;
  }
  const objectKey = makeObjectKey(bucket, key);
  if (!objectKeys.has(objectKey)) {
    objectKeys.add(objectKey);
    objects.push({ bucket, key });
  }
}

function addS3Prefix(
  prefixes: S3PrefixRef[],
  prefixKeys: Set<string>,
  bucket: string | null,
  prefix: string | null,
): void {
  if (!bucket || !prefix) {
    return;
  }
  const prefixKey = makePrefixKey(bucket, prefix);
  if (!prefixKeys.has(prefixKey)) {
    prefixKeys.add(prefixKey);
    prefixes.push({ bucket, prefix });
  }
}

function buildS3PurgeTargets(
  artifacts: ArtifactRow[],
  runs: readonly BundleRunRow[],
  taskRows: readonly TaskRow[],
  taskArtifactRows: readonly TaskArtifactRow[],
): S3PurgeTargets {
  const objectKeys = new Set<string>();
  const prefixKeys = new Set<string>();
  const objects: S3ObjectRef[] = [];
  const prefixes: S3PrefixRef[] = [];
  const runIds = runs.map((run) => run.id);

  for (const artifact of artifacts) {
    addS3Object(objects, objectKeys, artifact.s3_bucket, artifact.s3_key);

    for (const runId of runIds) {
      const prefix = deriveRunPrefix(artifact.s3_key, runId);
      addS3Prefix(prefixes, prefixKeys, artifact.s3_bucket, prefix);
    }
  }

  const artifactBucket = configuredArtifactBucket();
  const artifactPrefix = configuredArtifactPrefix();
  for (const run of runs) {
    addS3Prefix(
      prefixes,
      prefixKeys,
      artifactBucket,
      `${artifactPrefix}/${run.jira_key}/run-${run.id}/`,
    );
  }

  for (const taskRow of taskRows) {
    addS3Object(
      objects,
      objectKeys,
      nonEmptyString(taskRow.task_s3_bucket),
      nonEmptyString(taskRow.task_s3_key),
    );
  }

  for (const taskArtifactRow of taskArtifactRows) {
    addS3Object(
      objects,
      objectKeys,
      nonEmptyString(taskArtifactRow.result_s3_bucket),
      nonEmptyString(taskArtifactRow.result_s3_key),
    );
  }

  return { objects, prefixes };
}

async function listPrefixObjects(
  s3Client: S3Client,
  bucket: string,
  prefix: string,
): Promise<S3ObjectRef[]> {
  const objects: S3ObjectRef[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const item of response.Contents ?? []) {
      if (item.Key) {
        objects.push({ bucket, key: item.Key });
      }
    }
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return objects;
}

async function defaultPurgeS3Targets(
  targets: S3PurgeTargets,
  s3Client = new S3Client({ region: process.env.AWS_REGION || "us-east-2" }),
): Promise<S3PurgeResult> {
  const objectsByKey = new Map<string, S3ObjectRef>();
  for (const object of targets.objects) {
    objectsByKey.set(makeObjectKey(object.bucket, object.key), object);
  }
  for (const prefix of targets.prefixes) {
    for (const object of await listPrefixObjects(s3Client, prefix.bucket, prefix.prefix)) {
      objectsByKey.set(makeObjectKey(object.bucket, object.key), object);
    }
  }

  const objectsByBucket = new Map<string, string[]>();
  for (const object of objectsByKey.values()) {
    const bucketObjects = objectsByBucket.get(object.bucket) ?? [];
    bucketObjects.push(object.key);
    objectsByBucket.set(object.bucket, bucketObjects);
  }

  let deletedObjects = 0;
  for (const [bucket, keys] of objectsByBucket) {
    for (let index = 0; index < keys.length; index += 1000) {
      const batch = keys.slice(index, index + 1000);
      const response = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
            Quiet: false,
          },
        }),
      );
      if (response.Errors?.length) {
        throw new Error(
          `Failed to delete ${response.Errors.length} S3 object(s) from ${bucket}`,
        );
      }
      deletedObjects += response.Deleted?.length ?? batch.length;
    }
  }

  return {
    deletedObjects,
    objects: [...objectsByKey.values()],
    prefixes: targets.prefixes,
  };
}

async function fetchBundleForRun(
  runId: number,
	): Promise<{
	  runs: BundleRunRow[];
	  runIds: number[];
	  taskManagementIds: number[];
	  runGroupIds: number[];
	  taskIds: number[];
	  artifacts: ArtifactRow[];
	  taskRows: TaskRow[];
	  taskArtifactRows: TaskArtifactRow[];
	  deploymentIds: number[];
	}> {
  const [selectedRows] = await getPool().query<BundleRunRow[]>(
    `SELECT id, jira_key, run_group_id, source_task_management_id
     FROM oneshot_runs
     WHERE id = ?
     LIMIT 1`,
    [runId],
  );
  const selected = selectedRows[0] ?? null;
  if (!selected) {
    throw new OneShotRunControlError("OneShot run not found.", 404);
  }

  const siblingParams: Array<number | null> = [
    selected.source_task_management_id,
    selected.run_group_id,
  ];
  const [runs] = await getPool().query<BundleRunRow[]>(
    `SELECT id, jira_key, run_group_id, source_task_management_id
     FROM oneshot_runs
     WHERE source_task_management_id = ?
        OR (? IS NOT NULL AND run_group_id = ?)
     ORDER BY id`,
    [siblingParams[0], siblingParams[1], siblingParams[1]],
  );
  const runIds = uniqueNumbers(runs.map((run) => run.id));
  const runGroupIds = uniqueNumbers(runs.map((run) => run.run_group_id));
  const taskManagementIds = new Set(
    uniqueNumbers(runs.map((run) => run.source_task_management_id)),
  );

  if (runGroupIds.length > 0 || taskManagementIds.size > 0) {
    const groupWhere: string[] = [];
    const groupParams: number[] = [];
    if (runGroupIds.length > 0) {
      groupWhere.push(`id IN (${buildPlaceholders(runGroupIds)})`);
      groupParams.push(...runGroupIds);
    }
    const currentTaskIds = [...taskManagementIds];
    if (currentTaskIds.length > 0) {
      groupWhere.push(
        `source_task_management_id IN (${buildPlaceholders(currentTaskIds)})`,
      );
      groupParams.push(...currentTaskIds);
    }
    const [groups] = await getPool().query<BundleGroupRow[]>(
      `SELECT id, source_task_management_id
       FROM oneshot_run_groups
       WHERE ${groupWhere.join(" OR ")}`,
      groupParams,
    );
    for (const group of groups) {
      taskManagementIds.add(group.source_task_management_id);
    }
  }

  const [artifacts] = runIds.length > 0
    ? await getPool().query<ArtifactRow[]>(
        `SELECT oneshot_run_id, s3_bucket, s3_key
         FROM oneshot_artifacts
         WHERE oneshot_run_id IN (${buildPlaceholders(runIds)})`,
        runIds,
      )
    : [[] as ArtifactRow[]];

	  const taskIdList = [...taskManagementIds];
	  const [taskRows] = taskIdList.length > 0
	    ? await getPool().query<TaskRow[]>(
	        `SELECT id, task_id, task_s3_bucket, task_s3_key
	         FROM task_management
	         WHERE id IN (${buildPlaceholders(taskIdList)})`,
	        taskIdList,
	      )
	    : [[] as TaskRow[]];
	  const taskIds = uniqueNumbers(taskRows.map((row) => row.task_id));

	  const [taskArtifactRows] = taskIds.length > 0
	    ? await getPool().query<TaskArtifactRow[]>(
	        `SELECT id, result_s3_bucket, result_s3_key
	         FROM tasks
	         WHERE id IN (${buildPlaceholders(taskIds)})`,
	        taskIds,
	      )
	    : [[] as TaskArtifactRow[]];

  const [deploymentRows] = runIds.length > 0
    ? await getPool().query<IdRow[]>(
        `SELECT id
         FROM oneshot_deployments
         WHERE oneshot_run_id IN (${buildPlaceholders(runIds)})`,
        runIds,
      )
    : [[] as IdRow[]];

	  return {
	    runs,
	    runIds,
	    taskManagementIds: taskIdList,
	    runGroupIds,
	    taskIds,
	    artifacts,
	    taskRows,
	    taskArtifactRows,
	    deploymentIds: uniqueNumbers(deploymentRows.map((row) => row.id)),
	  };
	}

async function executeOptionalMutation(
  connection: mysql.Connection,
  sql: string,
  params: unknown[],
): Promise<number> {
  try {
    const [result] = await connection.query<mysql.ResultSetHeader>(sql, params);
    return result.affectedRows ?? 0;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ER_NO_SUCH_TABLE") {
      return 0;
    }
    throw error;
  }
}

async function deleteWhereIn(
  connection: mysql.Connection,
  table: string,
  column: string,
  ids: readonly number[],
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  const [result] = await connection.query<mysql.ResultSetHeader>(
    `DELETE FROM ${table} WHERE ${column} IN (${buildPlaceholders(ids)})`,
    [...ids],
  );
  return result.affectedRows ?? 0;
}

async function deleteWhereInOptional(
  connection: mysql.Connection,
  table: string,
  column: string,
  ids: readonly number[],
): Promise<number> {
  try {
    return await deleteWhereIn(connection, table, column, ids);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ER_NO_SUCH_TABLE") {
      return 0;
    }
    throw error;
  }
}

async function clearWatchdogDarciHandoffRefs(
  connection: mysql.Connection,
  input: {
    taskManagementIds: readonly number[];
    taskIds: readonly number[];
  },
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (input.taskManagementIds.length > 0) {
    counts.watchdog_darci_handoffs_task_management_cleared =
      await executeOptionalMutation(
        connection,
        `UPDATE watchdog_darci_handoffs
         SET task_management_id = NULL, updated_at = NOW()
         WHERE task_management_id IN (${buildPlaceholders(input.taskManagementIds)})`,
        [...input.taskManagementIds],
      );
  }
  if (input.taskIds.length > 0) {
    counts.watchdog_darci_handoffs_task_id_cleared =
      await executeOptionalMutation(
        connection,
        `UPDATE watchdog_darci_handoffs
         SET task_id = NULL, updated_at = NOW()
         WHERE task_id IN (${buildPlaceholders(input.taskIds)})`,
        [...input.taskIds],
      );
  }
  return counts;
}

export async function hardDeleteOneShotRun(
  input: {
    dashboardId: string;
    confirmDashboardId: string;
    operator: OperatorIdentity;
    reason?: string;
  },
  deps: {
    purgeS3?: (targets: S3PurgeTargets) => Promise<S3PurgeResult>;
  } = {},
): Promise<{
  deleted: true;
  affectedRunIds: number[];
  sourceTaskManagementIds: number[];
  deletedCounts: Record<string, number>;
  s3DeletedObjects: number;
}> {
  const runId = parseRunDashboardId(input.dashboardId);
  if (input.confirmDashboardId !== input.dashboardId) {
    throw new OneShotRunControlError(
      "confirmDashboardId must match dashboardId for hard delete.",
      400,
    );
  }

	  const bundle = await fetchBundleForRun(runId);
	  const purgeTargets = buildS3PurgeTargets(
	    bundle.artifacts,
	    bundle.runs,
	    bundle.taskRows,
	    bundle.taskArtifactRows,
	  );
  let s3Result: S3PurgeResult;
  try {
    s3Result = await (deps.purgeS3 ?? defaultPurgeS3Targets)(purgeTargets);
  } catch (error) {
    throw new OneShotRunControlError(
      `S3 purge failed before DB delete: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  const connection = await getPool().getConnection();
  const deletedCounts: Record<string, number> = {};

  try {
    await connection.beginTransaction();

	    if (bundle.taskManagementIds.length > 0) {
	      deletedCounts.chat_sessions_cleared = await executeOptionalMutation(
	        connection,
        `UPDATE chat_sessions
         SET task_management_id = NULL, updated_at = NOW()
         WHERE task_management_id IN (${buildPlaceholders(bundle.taskManagementIds)})`,
	        bundle.taskManagementIds,
	      );
	      Object.assign(
	        deletedCounts,
	        await clearWatchdogDarciHandoffRefs(connection, {
	          taskManagementIds: bundle.taskManagementIds,
	          taskIds: bundle.taskIds,
	        }),
	      );
	      deletedCounts.router_confirmations = await deleteWhereIn(
	        connection,
        "router_confirmations",
        "task_management_id",
        bundle.taskManagementIds,
      );
      deletedCounts.router_decisions = await deleteWhereIn(
        connection,
        "router_decisions",
        "task_management_id",
        bundle.taskManagementIds,
      );
      deletedCounts.oneshot_dashboard_run_requests = await deleteWhereInOptional(
        connection,
        "oneshot_dashboard_run_requests",
        "task_management_id",
        bundle.taskManagementIds,
      );
    }

    if (bundle.deploymentIds.length > 0) {
      const [result] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE oneshot_deployments
         SET superseded_by = NULL
         WHERE superseded_by IN (${buildPlaceholders(bundle.deploymentIds)})`,
        bundle.deploymentIds,
      );
      deletedCounts.oneshot_deployments_superseded_refs = result.affectedRows ?? 0;
    }

    deletedCounts.oneshot_deployments = await deleteWhereIn(
      connection,
      "oneshot_deployments",
      "oneshot_run_id",
      bundle.runIds,
    );
    deletedCounts.oneshot_notifications = await deleteWhereIn(
      connection,
      "oneshot_notifications",
      "oneshot_run_id",
      bundle.runIds,
    );
    deletedCounts.oneshot_artifacts = await deleteWhereIn(
      connection,
      "oneshot_artifacts",
      "oneshot_run_id",
      bundle.runIds,
    );
    deletedCounts.oneshot_run_events = await deleteWhereIn(
      connection,
      "oneshot_run_events",
      "oneshot_run_id",
      bundle.runIds,
    );
	    deletedCounts.oneshot_workspace_state = await deleteWhereInOptional(
	      connection,
	      "oneshot_workspace_state",
	      "oneshot_run_id",
	      bundle.runIds,
	    );
	    deletedCounts.oneshot_candidate_versions = await deleteWhereInOptional(
	      connection,
	      "oneshot_candidate_versions",
	      "oneshot_run_id",
	      bundle.runIds,
	    );
    deletedCounts.oneshot_runs = await deleteWhereIn(
      connection,
      "oneshot_runs",
      "id",
      bundle.runIds,
    );
    deletedCounts.oneshot_run_groups = await deleteWhereIn(
      connection,
      "oneshot_run_groups",
      "id",
      bundle.runGroupIds,
    );
    deletedCounts.task_management = await deleteWhereIn(
      connection,
      "task_management",
      "id",
      bundle.taskManagementIds,
    );

    if (bundle.taskIds.length > 0) {
      const [result] = await connection.query<mysql.ResultSetHeader>(
        `DELETE FROM tasks
         WHERE id IN (${buildPlaceholders(bundle.taskIds)})
           AND NOT EXISTS (
             SELECT 1 FROM task_management tm WHERE tm.task_id = tasks.id
           )`,
        bundle.taskIds,
      );
      deletedCounts.tasks = result.affectedRows ?? 0;
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return {
    deleted: true,
    affectedRunIds: bundle.runIds,
    sourceTaskManagementIds: bundle.taskManagementIds,
    deletedCounts,
    s3DeletedObjects: s3Result.deletedObjects,
  };
}
