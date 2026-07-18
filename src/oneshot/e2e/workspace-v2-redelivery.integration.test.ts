/**
 * Workspace v2 redelivery E2E.
 *
 * Prerequisites:
 *   CONTAINER_ENGINE=docker scripts/local-oneshot-cluster.sh up --build --no-orchestrator
 *
 * This test uses real MySQL, Moto S3, and Moto SQS. The first implementation
 * publish is fault-injected, the testing FIFO message is left for redelivery,
 * and the second delivery publishes through the real OneShotPublisher.
 */
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import mysql, { type Pool } from "mysql2/promise";
import type { Database } from "../../orchestrator/database.js";
import { OneShotDatabase } from "../database/index.js";
import type { OneShotConsumerConfig } from "../config.js";
import type { OneShotQueueMessage } from "../contracts.js";
import { OneShotPublisher } from "../publisher.js";
import type { PreparedWorkspace } from "../workspaces.js";
import { TesterConsumer } from "../consumers/tester.js";

const describeE2E =
  process.env.ONESHOT_E2E === "1" || process.env.ONESHOT_E2E === "true"
    ? describe
    : describe.skip;

const execFileAsync = promisify(execFile);

const REGION = "us-east-2";
const S3_BUCKET = "specter-results";
const MOTO_ENDPOINT =
  process.env.ONESHOT_MOTO_ENDPOINT ??
  `http://127.0.0.1:${process.env.ONESHOT_MOTO_PORT ?? "5002"}`;
const MYSQL_PORT = Number.parseInt(
  process.env.MYSQL_PORT ?? process.env.ONESHOT_LOCAL_MYSQL_PORT ?? "3307",
  10,
);
const MYSQL_PASSWORD =
  process.env.MYSQL_PASS ?? process.env.DB_PASSWORD ?? "specter_local";

class ShortVisibilityTesterConsumer extends TesterConsumer {
  protected getVisibilityTimeoutSeconds(): number {
    return 1;
  }
}

function buildConfig(testingQueueUrl: string): OneShotConsumerConfig {
  return {
    role: "TESTER",
    region: REGION,
    artifactBucket: S3_BUCKET,
    artifactPrefix: "oneshot",
    maxReviewLoops: 3,
    maxVerificationLoops: 3,
    maxTotalTokens: 10_000_000,
    maxStageTokens: {
      planning: 2_000_000,
      review: 2_000_000,
      implementation: 2_000_000,
      code_review: 2_000_000,
      testing: 2_000_000,
    },
    maxStageAttempts: 5,
    reconcileStaleMinutes: 10,
    reviewerEnabled: true,
    codeReviewerEnabled: true,
    traceEnabled: true,
    tracePostToJira: true,
    verifyEnabled: true,
    verifyMode: "balanced",
    reviewStagesBlockOnExhaustion: false,
    reviewerProvider: "openai",
    reviewerModelId: "gpt-test",
    codeReviewerProvider: "openai",
    codeReviewerModelId: "gpt-test",
    plannerModelId: undefined,
    plannerMaxOutputTokens: 100_000,
    plannerMaxThinkingTokens: undefined,
    plannerMaxRepoToolCalls: 25,
    plannerMaxTurns: 8,
    implementerModelId: "us.anthropic.claude-sonnet-test",
    implementerMaxOutputTokens: 100_000,
    implementerMaxTurns: 8,
    codeReviewerMaxOutputTokens: 100_000,
    plannerClaudePermissionMode: "default",
    plannerClaudeToolVisibility: "restricted",
    plannerClaudeToolGuard: "enabled",
    plannerToolSprawlGuard: true,
    plannerScoutEnabled: false,
    plannerScoutModelId: "us.anthropic.claude-haiku-test-v1:0",
    sdkTraceMode: "off",
    sdkStallThinkingPreview: "off",
    reviewerBypassReason: undefined,
    codeReviewerBypassReason: undefined,
    repoBasePath: path.join(os.tmpdir(), "oneshot-e2e-redelivery-repos"),
    repoAdminBasePath: path.join(os.tmpdir(), "oneshot-e2e-redelivery-repo-admin"),
    workspaceBasePath: path.join(os.tmpdir(), "oneshot-e2e-redelivery-workspaces"),
    workspaceLeaseTtlSeconds: 60,
    workspaceLeaseHeartbeatSeconds: 1,
    repoCacheFreshnessTtlMs: 60_000,
    promptSource: "local",
    promptBucket: S3_BUCKET,
    promptManifestKey: "oneshot/manifest.json",
    promptManifestVersionId: undefined,
    promptCacheTtlMs: 60_000,
    healthcareGuardrailsEnabled: false,
    promptLocalPath: path.join(os.tmpdir(), "oneshot-e2e-prompts"),
    commentAssetBaseUrl: "https://productFactory.mhkdevsandbox.com",
    dashboardBaseUrl: "https://productFactory.mhkdevsandbox.com",
    planningQueueUrl: `${MOTO_ENDPOINT}/000000000000/unused-planning.fifo`,
    reviewQueueUrl: `${MOTO_ENDPOINT}/000000000000/unused-review.fifo`,
    implementationQueueUrl:
      process.env.ONESHOT_IMPLEMENTATION_QUEUE_URL ??
      `${MOTO_ENDPOINT}/000000000000/unused-implementation.fifo`,
    codeReviewQueueUrl: `${MOTO_ENDPOINT}/000000000000/unused-code-review.fifo`,
    testingQueueUrl,
  };
}

async function waitFor<T>(
  description: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await fn();
      if (value) {
        return value as T;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ""}`,
  );
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function applyWorkspaceV2Migration(pool: Pool): Promise<void> {
  const migrationSql = await fs.readFile(
    path.join(process.cwd(), "db", "migrations", "018_oneshot_workspace_v2.sql"),
    "utf8",
  );
  await pool.query(migrationSql);
}

async function createWorkspaceRepo(): Promise<{
  root: string;
  headSha: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "oneshot-redelivery-repo-"));
  await runGit(["init", "-b", "main"], root);
  await runGit(["config", "user.email", "oneshot-e2e@example.com"], root);
  await runGit(["config", "user.name", "OneShot E2E"], root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "Marker.txt"),
    "the validation marker is intentionally absent\n",
    "utf8",
  );
  await runGit(["add", "."], root);
  await runGit(["commit", "-m", "seed test workspace"], root);
  return { root, headSha: await runGit(["rev-parse", "HEAD"], root) };
}

async function ensureBucket(s3: S3Client): Promise<void> {
  await s3
    .send(new CreateBucketCommand({ Bucket: S3_BUCKET }))
    .catch(() => undefined);
}

async function createFifoQueue(
  sqs: SQSClient,
  namePrefix: string,
): Promise<string> {
  const response = await sqs.send(
    new CreateQueueCommand({
      QueueName: `${namePrefix}-${randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "true",
        VisibilityTimeout: "1",
      },
    }),
  );
  if (!response.QueueUrl) {
    throw new Error(`Moto did not return a queue URL for ${namePrefix}`);
  }
  return response.QueueUrl;
}

async function seedPrerequisites(pool: Pool): Promise<{
  customerId: number;
  repoId: number;
  agentId: number;
}> {
  const [customerRows] = await pool.query<Array<{ id: number }>>(
    "SELECT id FROM customer_branches WHERE customer = 'MHK' LIMIT 1",
  );
  const customerId = customerRows[0]?.id;
  if (!customerId) {
    throw new Error("Missing MHK customer row. Run local-oneshot setup first.");
  }

  const [repoRows] = await pool.query<Array<{ id: number }>>(
    "SELECT id FROM code_repositories WHERE repo_name = 'core-app' LIMIT 1",
  );
  const repoId = repoRows[0]?.id;
  if (!repoId) {
    throw new Error("Missing core-app repo row. Run local-oneshot setup first.");
  }

  const [agentRows] = await pool.query<Array<{ id: number }>>(
    "SELECT id FROM agents WHERE name = 'QUALIFIER' LIMIT 1",
  );
  const agentId = agentRows[0]?.id;
  if (!agentId) {
    throw new Error("Missing QUALIFIER agent row. Run local-oneshot setup first.");
  }

  return { customerId, repoId, agentId };
}

async function seedRun(input: {
  pool: Pool;
  db: OneShotDatabase;
  s3: S3Client;
  customerId: number;
  repoId: number;
  agentId: number;
  implementationCommitSha: string;
}): Promise<{ runId: number; jiraKey: string }> {
  const jiraKey = `E2E-${randomUUID().slice(0, 8).toUpperCase()}`;
  await input.pool.query(
    `INSERT INTO task_management
       (jira_number, customer_id, agent_id, related_code, task_type, task_s3_bucket, task_s3_key, status, source)
     VALUES (?, ?, ?, ?, 'qualification', ?, ?, 'completed', 'jira')`,
    [
      jiraKey,
      input.customerId,
      input.agentId,
      String(input.repoId),
      S3_BUCKET,
      `tasks/${jiraKey}.md`,
    ],
  );
  const [tmRows] = await input.pool.query<Array<{ id: number }>>(
    "SELECT id FROM task_management WHERE jira_number = ? LIMIT 1",
    [jiraKey],
  );
  const sourceTaskManagementId = tmRows[0]?.id;
  if (!sourceTaskManagementId) {
    throw new Error("Failed to seed task_management row.");
  }

  const [result] = await input.pool.query<mysql.ResultSetHeader>(
    `INSERT INTO oneshot_runs (
       workspace_mode,
       jira_key,
       source_task_management_id,
       customer_id,
       repo_id,
       branch_name,
       base_commit_sha,
       state,
       current_plan_version,
       current_review_version,
       current_implementation_version,
       current_implementation_branch,
       current_implementation_commit_sha,
       current_code_review_version,
       current_test_version,
       verification_loop_count,
       max_verification_loops
     )
     VALUES ('v2', ?, ?, ?, ?, 'main', ?, 'queued_for_testing', 1, 1, 2, ?, ?, 1, 1, 0, 3)`,
    [
      jiraKey,
      sourceTaskManagementId,
      input.customerId,
      input.repoId,
      input.implementationCommitSha,
      `oneshot/${jiraKey.toLowerCase()}`,
      input.implementationCommitSha,
    ],
  );
  const runId = result.insertId;

  const plan = {
    jiraKey,
    repoName: "core-app",
    branchName: "main",
    baseCommitSha: input.implementationCommitSha,
    summary: "Validate redelivery does not burn validation retry.",
    specs: [
      {
        id: "SPEC-1",
        objective: "Require a marker that the fixture intentionally omits.",
        acceptanceCriteria: ["The validation marker must be present."],
        targetFiles: ["src/Marker.txt"],
        implementationNotes: ["Use validationChecks for the structural assertion."],
        validationSteps: ["rg EXPECTED_MARKER src/Marker.txt"],
      },
    ],
    assumptions: [],
    openQuestions: [],
    outOfScope: [],
    risks: [],
  };
  const implementation = {
    summary: "Implementation fixture intentionally lacks the marker.",
    completedSpecIds: ["SPEC-1"],
    changedFiles: ["src/Marker.txt"],
    testCommands: [],
    validationCommands: [],
    validationChecks: [
      {
        kind: "must_match",
        pattern: "EXPECTED_MARKER",
        paths: ["src/Marker.txt"],
      },
    ],
    manualVerificationSteps: [],
    testResults: [],
    deviationsFromPlan: [],
    residualRisks: [],
    openFollowUps: [],
    implementationBranch: `oneshot/${jiraKey.toLowerCase()}`,
    implementationCommitSha: input.implementationCommitSha,
  };
  const codeReview = {
    decision: "APPROVED",
    summary: "Fixture approved for redelivery test.",
    blockingFindings: [],
    nonBlockingSuggestions: [],
  };

  const artifacts = [
    { stage: "plan" as const, version: 1, body: plan, metadata: {} },
    {
      stage: "implementation" as const,
      version: 2,
      body: implementation,
      metadata: { implementationCommitSha: input.implementationCommitSha },
    },
    {
      stage: "code_review" as const,
      version: 1,
      body: codeReview,
      metadata: { reviewedImplementationCommitSha: input.implementationCommitSha },
    },
  ];
  for (const artifact of artifacts) {
    const key = `oneshot/${jiraKey}/run-${runId}/${artifact.stage}/v${artifact.version}/${artifact.stage}.json`;
    await input.s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: JSON.stringify(artifact.body),
        ContentType: "application/json",
      }),
    );
    await input.db.artifacts.upsertArtifact({
      oneshot_run_id: runId,
      stage: artifact.stage,
      version: artifact.version,
      status: "completed",
      s3_bucket: S3_BUCKET,
      s3_key: key,
      provider: "fixture",
      model: "fixture",
      metadata_json: artifact.metadata,
    });
  }

  await input.pool.query(
    `INSERT INTO oneshot_candidate_versions (
       oneshot_run_id,
       candidate_version,
       candidate_commit_sha,
       previous_candidate_commit_sha,
       status,
       target_files_json,
       metadata_json,
       finalized_at
     )
     VALUES (?, 2, ?, ?, 'current', ?, ?, NOW(6))`,
    [
      runId,
      input.implementationCommitSha,
      input.implementationCommitSha,
      JSON.stringify(["src/Marker.txt"]),
      JSON.stringify({ source: "workspace-v2-redelivery-e2e" }),
    ],
  );

  return { runId, jiraKey };
}

describeE2E("workspace v2 SQS redelivery E2E", () => {
  let pool: Pool;
  let oneShotDb: OneShotDatabase;
  let sqs: SQSClient;
  let s3: S3Client;
  let testingQueueUrl: string;
  let implementationQueueUrl: string;
  let oldAwsEndpoint: string | undefined;
  let oldAwsEndpointSqs: string | undefined;
  let oldAwsProfile: string | undefined;
  let oldImplementationQueueUrl: string | undefined;
  const seededRunIds: number[] = [];
  const seededJiraKeys: string[] = [];

  beforeAll(async () => {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST ?? "127.0.0.1",
      port: MYSQL_PORT,
      user: process.env.MYSQL_USER ?? "root",
      password: MYSQL_PASSWORD,
      database: process.env.MYSQL_DB ?? process.env.DB_NAME ?? "Specter",
      waitForConnections: true,
      connectionLimit: 5,
      multipleStatements: true,
    });
    oneShotDb = new OneShotDatabase(pool);
    await applyWorkspaceV2Migration(pool);
    sqs = new SQSClient({
      region: REGION,
      endpoint: MOTO_ENDPOINT,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    s3 = new S3Client({
      region: REGION,
      endpoint: MOTO_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await ensureBucket(s3);
    testingQueueUrl = await createFifoQueue(sqs, "oneshot-v2-redelivery-testing");
    implementationQueueUrl = await createFifoQueue(
      sqs,
      "oneshot-v2-redelivery-implementation",
    );

    oldAwsEndpoint = process.env.AWS_ENDPOINT_URL;
    oldAwsEndpointSqs = process.env.AWS_ENDPOINT_URL_SQS;
    oldAwsProfile = process.env.AWS_PROFILE;
    oldImplementationQueueUrl = process.env.ONESHOT_IMPLEMENTATION_QUEUE_URL;
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.AWS_REGION = REGION;
    process.env.AWS_DEFAULT_REGION = REGION;
    delete process.env.AWS_PROFILE;
    process.env.AWS_ENDPOINT_URL = MOTO_ENDPOINT;
    process.env.AWS_ENDPOINT_URL_SQS = MOTO_ENDPOINT;
    process.env.ONESHOT_IMPLEMENTATION_QUEUE_URL = implementationQueueUrl;
  }, 30_000);

  afterAll(async () => {
    await Promise.allSettled([
      testingQueueUrl
        ? sqs.send(new DeleteQueueCommand({ QueueUrl: testingQueueUrl }))
        : Promise.resolve(),
      implementationQueueUrl
        ? sqs.send(new DeleteQueueCommand({ QueueUrl: implementationQueueUrl }))
        : Promise.resolve(),
    ]);
    if (pool) {
      for (const runId of seededRunIds) {
        await pool.query("DELETE FROM oneshot_notifications WHERE oneshot_run_id = ?", [
          runId,
        ]);
        await pool.query("DELETE FROM oneshot_artifacts WHERE oneshot_run_id = ?", [
          runId,
        ]);
        await pool.query("DELETE FROM oneshot_runs WHERE id = ?", [runId]);
      }
      for (const jiraKey of seededJiraKeys) {
        await pool.query("DELETE FROM task_management WHERE jira_number = ?", [
          jiraKey,
        ]);
      }
      await pool.end();
    }
    sqs?.destroy();
    s3?.destroy();
    if (oldAwsEndpoint === undefined) {
      delete process.env.AWS_ENDPOINT_URL;
    } else {
      process.env.AWS_ENDPOINT_URL = oldAwsEndpoint;
    }
    if (oldAwsEndpointSqs === undefined) {
      delete process.env.AWS_ENDPOINT_URL_SQS;
    } else {
      process.env.AWS_ENDPOINT_URL_SQS = oldAwsEndpointSqs;
    }
    if (oldAwsProfile === undefined) {
      delete process.env.AWS_PROFILE;
    } else {
      process.env.AWS_PROFILE = oldAwsProfile;
    }
    if (oldImplementationQueueUrl === undefined) {
      delete process.env.ONESHOT_IMPLEMENTATION_QUEUE_URL;
    } else {
      process.env.ONESHOT_IMPLEMENTATION_QUEUE_URL = oldImplementationQueueUrl;
    }
  });

  it("redelivers testing after first implementation publish failure and publishes on second delivery", async () => {
    const prereqs = await seedPrerequisites(pool);
    const workspaceRepo = await createWorkspaceRepo();
    const seeded = await seedRun({
      pool,
      db: oneShotDb,
      s3,
      ...prereqs,
      implementationCommitSha: workspaceRepo.headSha,
    });
    seededRunIds.push(seeded.runId);
    seededJiraKeys.push(seeded.jiraKey);

    const config = buildConfig(testingQueueUrl);
    const fakeDb = {
      getPool: () => pool,
      getRepositoryById: vi.fn().mockResolvedValue({
        id: prereqs.repoId,
        repo_name: "core-app",
        repo_url: "https://github.com/org/repo.git",
        description: "fixture",
        default_branch: "main",
        created_at: new Date(),
      }),
    } as unknown as Database;
    const workspace: PreparedWorkspace = {
      repoRoot: workspaceRepo.root,
      runPath: path.dirname(workspaceRepo.root),
      workspacePath: workspaceRepo.root,
      statePath: path.join(workspaceRepo.root, ".oneshot-state"),
      cleanup: vi.fn().mockResolvedValue(undefined),
      assertLeaseValid: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceManager = {
      prepareTesterWorkspace: vi.fn().mockResolvedValue(workspace),
    };

    const realPublisher = new OneShotPublisher(REGION);
    let publishAttempts = 0;
    const publisher = {
      publishStageMessage: vi.fn(async (...args: Parameters<OneShotPublisher["publishStageMessage"]>) => {
        publishAttempts += 1;
        if (publishAttempts === 1) {
          throw new Error("Injected implementation publish failure");
        }
        await realPublisher.publishStageMessage(...args);
      }),
    } as OneShotPublisher;

    const consumer = new ShortVisibilityTesterConsumer({
      config,
      db: fakeDb,
      sqsClient: sqs,
      s3Client: s3,
      publisher,
      workspaceManager: workspaceManager as never,
    });

    const body: OneShotQueueMessage = {
      run_id: seeded.runId,
      stage: "testing",
      version: 1,
      expected_state: "queued_for_testing",
      revision: false,
      emitted_at: new Date().toISOString(),
      expected_implementation_commit_sha: workspaceRepo.headSha,
      expected_implementation_version: 2,
    };
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: testingQueueUrl,
        MessageBody: JSON.stringify(body),
        MessageGroupId: String(seeded.runId),
        MessageDeduplicationId: `${seeded.runId}:testing:1:initial`,
      }),
    );

    const consumerLoop = consumer.start();
    try {
      await waitFor("first fault-injected publish attempt", async () =>
        publishAttempts >= 1 ? true : null,
      );
      const [revertRows] = await pool.query<Array<{ id: number }>>(
        `SELECT id
           FROM oneshot_run_events
          WHERE oneshot_run_id = ?
            AND event_type = 'state_revert'
            AND stage = 'testing'
            AND JSON_EXTRACT(metadata_json, '$.validationOnly') = true
          LIMIT 1`,
        [seeded.runId],
      );
      expect(revertRows).toHaveLength(1);

      await waitFor("run returned to queued_for_testing", async () => {
        const run = await oneShotDb.runs.getRunById(seeded.runId);
        return run?.state === "queued_for_testing" ? run : null;
      });
      const runAfterFirstDelivery = await oneShotDb.runs.getRunById(seeded.runId);
      expect(runAfterFirstDelivery?.current_implementation_version).toBe(2);
      expect(runAfterFirstDelivery?.current_test_version).toBe(1);

      await waitFor("second publish attempt through real publisher", async () =>
        publishAttempts >= 2 ? true : null,
        20_000,
      );

      const runAfterSecondDelivery = await waitFor(
        "run queued for implementation after redelivery",
        async () => {
          const run = await oneShotDb.runs.getRunById(seeded.runId);
          return run?.state === "queued_for_implementation" ? run : null;
        },
      );
      expect(runAfterSecondDelivery.current_implementation_version).toBe(3);
      expect(runAfterSecondDelivery.current_test_version).toBe(1);

      const implementationMessage = await waitFor(
        "implementation queue message",
        async () => {
          const response = await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: implementationQueueUrl,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 1,
            }),
          );
          return response.Messages?.[0] ?? null;
        },
      );
      const implementationBody = JSON.parse(
        implementationMessage.Body ?? "{}",
      ) as OneShotQueueMessage;
      expect(implementationBody.run_id).toBe(seeded.runId);
      expect(implementationBody.stage).toBe("implementation");
      expect(implementationBody.version).toBe(3);
      expect(implementationBody.expected_state).toBe("queued_for_implementation");
    } finally {
      await consumer.stop();
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: testingQueueUrl,
          MessageBody: JSON.stringify({
            run_id: seeded.runId + 10_000_000,
            stage: "testing",
            version: 1,
            expected_state: "queued_for_testing",
            revision: false,
            emitted_at: new Date().toISOString(),
          }),
          MessageGroupId: "stop",
        }),
      );
      await Promise.race([
        consumerLoop,
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }, 45_000);
});
