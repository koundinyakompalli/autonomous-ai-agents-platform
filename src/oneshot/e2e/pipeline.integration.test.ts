/**
 * End-to-end integration test for the full OneShot pipeline:
 *   Planner → Plan Reviewer → Implementer → Code Reviewer → Tester → PR
 *
 * Prerequisites: Docker Compose with MySQL 8 and LocalStack S3 must be running.
 * Run via: bash local-e2e/run.sh
 *
 * What's real: MySQL state transitions, S3 artifact storage, Zod schema validation.
 * What's mocked: LLM providers, workspace manager, git remote ops, GitHub API, test executor.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { SQSClient, type Message } from '@aws-sdk/client-sqs'
import mysql, { type Pool } from 'mysql2/promise'
import { OneShotDatabase } from '../database/index.js'
import type { OneShotConsumerConfig } from '../config.js'

const describeE2E =
  process.env.ONESHOT_E2E === '1' || process.env.ONESHOT_E2E === 'true'
    ? describe
    : describe.skip

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest)
// ---------------------------------------------------------------------------

vi.mock('../git.js', () => ({
  getRemoteBranchHead: vi.fn().mockImplementation((_repo, branchName: string) => ({
    branchName,
    headSha: branchName === 'master'
      ? 'aabbccdd00112233445566778899aabbccddeeff'
      : 'ff00112233445566778899aabbccddeeff00aabb',
  })),
  branchExistsOnRemote: vi.fn().mockResolvedValue(false),
  commitAllChanges: vi.fn().mockResolvedValue(undefined),
  getCurrentHeadSha: vi.fn().mockResolvedValue('ff00112233445566778899aabbccddeeff00aabb'),
  listChangedFiles: vi.fn().mockResolvedValue(['src/main.java', 'src/test/MainTest.java']),
  parseGitNameStatusPaths: (output: string) =>
    output
      .split('\n')
      .flatMap((line) => line.trim().split('\t').slice(1))
      .filter(Boolean)
      .sort(),
  pushBranch: vi.fn().mockResolvedValue(undefined),
  createOrResetLocalBranch: vi.fn().mockResolvedValue(undefined),
  buildAuthenticatedRepoUrl: vi.fn().mockResolvedValue('https://x-access-token:tok@github.com/org/repo.git'),
  buildWriteAuthenticatedRepoUrl: vi.fn().mockReturnValue('https://x-access-token:tok@github.com/org/repo.git'),
  runGitCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
  resolveFirstRemoteBranchHead: vi.fn().mockResolvedValue({
    branchName: 'master',
    headSha: 'aabbccdd00112233445566778899aabbccddeeff',
  }),
}))

vi.mock('../github.js', () => ({
  createDraftPullRequest: vi.fn().mockResolvedValue({
    number: 42,
    url: 'https://api.github.com/repos/org/repo/pulls/42',
    htmlUrl: 'https://github.com/org/repo/pull/42',
    draft: true,
    nodeId: 'PR_kw42',
  }),
  ensureDraftPullRequest: vi.fn().mockResolvedValue({
    number: 42,
    url: 'https://api.github.com/repos/org/repo/pulls/42',
    htmlUrl: 'https://github.com/org/repo/pull/42',
    draft: false,
    nodeId: 'PR_kw42',
    reused: false,
  }),
  updatePullRequest: vi.fn().mockResolvedValue({
    number: 42,
    url: 'https://api.github.com/repos/org/repo/pulls/42',
    htmlUrl: 'https://github.com/org/repo/pull/42',
    draft: false,
    nodeId: 'PR_kw42',
  }),
  fetchCommitStatusSummary: vi.fn().mockResolvedValue({
    state: 'success',
    description: 'GitHub CI is success across 1 status check(s) and 0 check run(s).',
    statusCount: 1,
    checkRunCount: 0,
    requiredCheckState: 'present',
  }),
  parseGitHubRepoUrl: vi.fn().mockReturnValue({ owner: 'org', repo: 'repo' }),
}))

vi.mock('../review-context.js', () => ({
  buildReviewContext: vi.fn().mockResolvedValue({
    fileContents: [{ path: 'src/main.java', content: '// placeholder' }],
    totalBytes: 100,
  }),
}))

vi.mock('../code-review-context.js', () => ({
  buildCodeReviewContext: vi.fn().mockResolvedValue({
    diffContent: '--- a/src/main.java\n+++ b/src/main.java\n@@ -1 +1 @@\n-old\n+new',
    changedFileContents: [{ path: 'src/main.java', content: '// new impl' }],
    totalBytes: 200,
  }),
}))

vi.mock('../test-executor.js', () => ({
  resolveTestCommands: vi.fn().mockResolvedValue({
    kind: 'commands' as const,
    executionKind: 'automated_tests' as const,
    automatedCommands: ['mvn test -B'],
    validationCommands: [],
    validationChecks: [],
    skippedTestCommands: [],
    mavenSkippedTestCommands: [],
    mavenBuildsDisabled: false,
    source: 'heuristic' as const,
    parserNotes: [],
  }),
  executeTestCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'Tests passed', stderr: '', durationMs: 1500 }),
  captureTestReportSnapshot: vi.fn().mockResolvedValue(new Map()),
  findAndParseTestReports: vi.fn().mockResolvedValue({ passCount: 8, failCount: 0, skipCount: 1, failedTests: [] }),
  findAndParseCoverage: vi.fn().mockResolvedValue({ linePercent: 92.5, branchPercent: 87.3, threshold: 80, passed: true }),
  truncateOutput: vi.fn().mockReturnValue('=== STDOUT ===\nTests passed\n=== STDERR ===\n'),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { PlannerConsumer } from '../consumers/planner.js'
import { ReviewerConsumer } from '../consumers/reviewer.js'
import { ImplementerConsumer } from '../consumers/implementer.js'
import { CodeReviewerConsumer } from '../consumers/code-reviewer.js'
import { TesterConsumer } from '../consumers/tester.js'
import type { ClaudePlannerProvider, PlannerResponse } from '../providers/claude-planner.js'
import type { OpenAiReviewerProvider, OpenAiReviewerResponse } from '../providers/openai-reviewer.js'
import type { ClaudeImplementerProvider, ImplementerResponse } from '../providers/claude-implementer.js'
import type { OpenAiCodeReviewerProvider, OpenAiCodeReviewerResponse } from '../providers/openai-code-reviewer.js'

// ---------------------------------------------------------------------------
// Testable subclasses — expose protected handleMessage
// ---------------------------------------------------------------------------

class TestablePlanner extends PlannerConsumer {
  async processMessage(msg: Message, receiveCount = 1): Promise<boolean> {
    return this.handleMessage(msg, receiveCount)
  }
}

class TestableReviewer extends ReviewerConsumer {
  async processMessage(msg: Message, receiveCount = 1): Promise<boolean> {
    return this.handleMessage(msg, receiveCount)
  }
}

class TestableImplementer extends ImplementerConsumer {
  async processMessage(msg: Message, receiveCount = 1): Promise<boolean> {
    return this.handleMessage(msg, receiveCount)
  }
}

class TestableCodeReviewer extends CodeReviewerConsumer {
  async processMessage(msg: Message, receiveCount = 1): Promise<boolean> {
    return this.handleMessage(msg, receiveCount)
  }
}

class TestableTester extends TesterConsumer {
  async processMessage(msg: Message, receiveCount = 1): Promise<boolean> {
    return this.handleMessage(msg, receiveCount)
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_COMMIT = 'aabbccdd00112233445566778899aabbccddeeff'
const IMPL_COMMIT = 'ff00112233445566778899aabbccddeeff00aabb'
const JIRA_KEY = 'TEST-1234'
const LOCALSTACK_ENDPOINT = process.env.LOCALSTACK_ENDPOINT || 'http://127.0.0.1:4566'
const S3_BUCKET = 'specter-results'

// ---------------------------------------------------------------------------
// Canned provider responses
// ---------------------------------------------------------------------------

const CANNED_PLAN = {
  jiraKey: JIRA_KEY,
  repoName: 'core-app',
  branchName: 'master',
  baseCommitSha: BASE_COMMIT,
  summary: 'Add null-check guard for patient lookup',
  specs: [
    {
      id: 'SPEC-1',
      objective: 'Guard patient lookup against missing records',
      acceptanceCriteria: ['Patient lookup returns safely when patient is missing', 'Unit test covers null patient scenario'],
      targetFiles: ['src/main/java/PatientService.java', 'src/test/java/PatientServiceTest.java'],
      implementationNotes: ['Add null check before accessing patient fields', 'Follow existing test style in service tests'],
      validationSteps: ['mvn test -B'],
    },
  ],
  assumptions: ['Single-repo change'],
  openQuestions: [],
  outOfScope: [],
  risks: ['None identified'],
}

const CANNED_REVIEW = {
  decision: 'APPROVED' as const,
  score: 91,
  sageDimensions: [
    { name: 'Completeness', score: 95, weight: 0.25, notes: 'Covers all AC.' },
    { name: 'Correctness', score: 90, weight: 0.25, notes: 'Logic is sound.' },
    { name: 'Security', score: 88, weight: 0.20, notes: 'No security concerns.' },
    { name: 'Testability', score: 92, weight: 0.15, notes: 'Good test coverage plan.' },
    { name: 'Maintainability', score: 89, weight: 0.10, notes: 'Clean approach.' },
    { name: 'Risk', score: 90, weight: 0.05, notes: 'Low risk change.' },
  ],
  blockingFindings: [],
  requiredChanges: [],
  nonBlockingSuggestions: ['Consider logging the null case.'],
  confidence: 'high' as const,
  coverageAssessment: 'Plan fully covers the requested scope.',
}

const CANNED_IMPLEMENTATION_OUTPUT = {
  summary: 'Added null check to patient lookup and corresponding service test.',
  completedSpecIds: ['SPEC-1'],
  implementedTraceTestIds: [`${JIRA_KEY}-TRACE-C-001`],
  changedFiles: ['src/main/java/PatientService.java', 'src/test/java/PatientServiceTest.java'],
  testCommands: ['mvn test -B'],
  manualVerificationSteps: [],
  testResults: [{ command: 'mvn test -B', status: 'passed' as const, summary: 'All tests pass' }],
  deviationsFromPlan: [],
  residualRisks: [],
  openFollowUps: [],
}

const CANNED_CODE_REVIEW = {
  decision: 'APPROVED' as const,
  score: 94,
  sageDimensions: [
    { name: 'Correctness', score: 96, weight: 0.20, notes: 'Implementation matches plan.' },
    { name: 'Security', score: 95, weight: 0.20, notes: 'No vulnerabilities.' },
    { name: 'Test Quality', score: 92, weight: 0.15, notes: 'Good coverage.' },
    { name: 'Code Quality', score: 93, weight: 0.15, notes: 'Clean code.' },
    { name: 'Performance', score: 90, weight: 0.15, notes: 'No issues.' },
    { name: 'Completeness', score: 95, weight: 0.15, notes: 'All AC met.' },
  ],
  findings: [],
  blockingFindings: [],
  requiredChanges: [],
  nonBlockingSuggestions: ['Minor: consider extracting guard to a helper.'],
  confidence: 'high' as const,
  summary: 'Implementation is clean, well-tested, and matches the plan.',
  implementationVersion: 1,
}

// ---------------------------------------------------------------------------
// Mock providers
// ---------------------------------------------------------------------------

function createMockPlannerProvider(): ClaudePlannerProvider {
  return {
    generatePlan: vi.fn().mockResolvedValue({
      plan: CANNED_PLAN,
      rawOutput: JSON.stringify(CANNED_PLAN),
      metrics: { durationMs: 5000, toolCalls: 12, tokensUsed: { input: 3000, output: 1500 } },
    } satisfies PlannerResponse),
  } as unknown as ClaudePlannerProvider
}

function createMockReviewerProvider(): OpenAiReviewerProvider {
  return {
    reviewPlan: vi.fn().mockResolvedValue({
      review: CANNED_REVIEW,
      rawOutput: JSON.stringify(CANNED_REVIEW),
      metrics: { durationMs: 4000, tokensUsed: { input: 2000, output: 800 } },
    } satisfies OpenAiReviewerResponse),
  } as unknown as OpenAiReviewerProvider
}

function createMockImplementerProvider(): ClaudeImplementerProvider {
  return {
    implementPlan: vi.fn().mockResolvedValue({
      implementation: CANNED_IMPLEMENTATION_OUTPUT,
      rawOutput: JSON.stringify(CANNED_IMPLEMENTATION_OUTPUT),
      metrics: { durationMs: 30000, toolCalls: 45, tokensUsed: { input: 8000, output: 4000 } },
    } satisfies ImplementerResponse),
  } as unknown as ClaudeImplementerProvider
}

function createMockCodeReviewerProvider(): OpenAiCodeReviewerProvider {
  return {
    reviewCode: vi.fn().mockResolvedValue({
      review: CANNED_CODE_REVIEW,
      rawOutput: JSON.stringify(CANNED_CODE_REVIEW),
      metrics: { durationMs: 6000, tokensUsed: { input: 3000, output: 1200 } },
    } satisfies OpenAiCodeReviewerResponse),
  } as unknown as OpenAiCodeReviewerProvider
}

function createMockWorkspaceManager() {
  const workspace = {
    repoRoot: '/tmp/e2e-workspace',
    workspacePath: '/tmp/e2e-workspace',
    statePath: '/tmp/e2e-workspace-state',
    cleanup: vi.fn().mockResolvedValue(undefined),
  }
  return {
    prepareWorkspace: vi.fn().mockResolvedValue(workspace),
    preparePlannerWorkspace: vi.fn().mockResolvedValue(workspace),
    prepareReviewerWorkspace: vi.fn().mockResolvedValue(workspace),
    prepareImplementerWorkspace: vi.fn().mockResolvedValue(workspace),
    prepareCodeReviewerWorkspace: vi.fn().mockResolvedValue(workspace),
    prepareTesterWorkspace: vi.fn().mockResolvedValue(workspace),
  }
}

function createMockPublisher() {
  return {
    publishStageMessage: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockStorage() {
  return {
    downloadResult: vi.fn().mockResolvedValue(`# ${JIRA_KEY}\nFix NPE in PatientService when patient not found.`),
    uploadResult: vi.fn().mockResolvedValue({ bucket: S3_BUCKET, key: 'results/test.md' }),
    uploadTaskDescription: vi.fn().mockResolvedValue({ bucket: S3_BUCKET, key: 'tasks/test.md' }),
    getBucketName: vi.fn().mockReturnValue(S3_BUCKET),
    getTaskBucket: vi.fn().mockReturnValue(S3_BUCKET),
    generateResultKey: vi.fn().mockReturnValue('results/test.md'),
    generateTaskKey: vi.fn().mockReturnValue('tasks/test.md'),
  }
}

// ---------------------------------------------------------------------------
// Mock database (wraps real mysql pool with getRepositoryById / getTaskManagementById)
// ---------------------------------------------------------------------------

function createMockDb(pool: Pool) {
  return {
    getPool: () => pool,
    getRepositoryById: vi.fn().mockResolvedValue({
      id: 1,
      repo_name: 'core-app',
      repo_url: 'https://github.com/org/repo.git',
      default_branch: 'master',
    }),
    getTaskManagementById: vi.fn().mockResolvedValue({
      id: 1,
      task_s3_bucket: S3_BUCKET,
      task_s3_key: 'tasks/TEST-1234.md',
    }),
    getAgentByName: vi.fn().mockResolvedValue({
      id: 1,
      name: 'PLANNER',
      model: 'us.anthropic.claude-sonnet-4-6',
    }),
  }
}

// ---------------------------------------------------------------------------
// Shared config (bypasses env-var requirement)
// ---------------------------------------------------------------------------

function buildTestConfig(): OneShotConsumerConfig {
  return {
    role: 'PLANNER',
    region: 'us-east-2',
    artifactBucket: S3_BUCKET,
    artifactPrefix: 'oneshot',
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
    tracePostToJira: false,
    verifyEnabled: true,
    verifyMode: 'balanced',
    reviewStagesBlockOnExhaustion: false,
    plannerModelId: undefined,
    plannerMaxOutputTokens: 100_000,
    implementerModelId: 'us.anthropic.claude-sonnet-test',
    implementerMaxOutputTokens: 100_000,
    plannerClaudePermissionMode: 'default',
    plannerClaudeToolVisibility: 'restricted',
    plannerClaudeToolGuard: 'enabled',
    plannerScoutEnabled: false,
    plannerScoutModelId: 'us.anthropic.claude-haiku-test-v1:0',
    reviewerBypassReason: undefined,
    codeReviewerBypassReason: undefined,
    repoBasePath: '/tmp/e2e-repos',
    repoAdminBasePath: '/tmp/e2e-repos',
    workspaceBasePath: '/tmp/e2e-workspaces',
    promptSource: 'local',
    promptBucket: S3_BUCKET,
    promptManifestKey: 'oneshot/manifest.json',
    promptManifestVersionId: undefined,
    promptCacheTtlMs: 60_000,
    healthcareGuardrailsEnabled: false,
    promptLocalPath: '/tmp/prompts',
    commentAssetBaseUrl: 'https://productFactory.mhkdevsandbox.com',
    dashboardBaseUrl: 'https://productFactory.mhkdevsandbox.com',
    planningQueueUrl: 'http://localhost:4566/000000000000/oneshot-planning.fifo',
    reviewQueueUrl: 'http://localhost:4566/000000000000/oneshot-review.fifo',
    implementationQueueUrl: 'http://localhost:4566/000000000000/oneshot-implementation.fifo',
    codeReviewQueueUrl: 'http://localhost:4566/000000000000/oneshot-code-review.fifo',
    testingQueueUrl: 'http://localhost:4566/000000000000/oneshot-testing.fifo',
  }
}

// ---------------------------------------------------------------------------
// SQS message helper
// ---------------------------------------------------------------------------

function buildMessage(body: Record<string, unknown>): Message {
  return {
    MessageId: `msg-${Date.now()}`,
    ReceiptHandle: `receipt-${Date.now()}`,
    Body: JSON.stringify(body),
    Attributes: { ApproximateReceiveCount: '1' },
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describeE2E('OneShot E2E Pipeline (integration)', () => {
  let pool: Pool
  let oneShotDb: OneShotDatabase
  let s3: S3Client
  let sqsClient: SQSClient
  let runId: number

  const config = buildTestConfig()

  async function expectS3ObjectExists(key: string): Promise<void> {
    await expect(
      s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key })),
    ).resolves.toBeTruthy()
  }

  beforeAll(async () => {
    // MySQL connection
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: parseInt(process.env.MYSQL_PORT || '3307', 10),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASS || 'specter_e2e',
      database: 'Specter',
      waitForConnections: true,
      connectionLimit: 5,
    })

    oneShotDb = new OneShotDatabase(pool)

    // LocalStack S3
    s3 = new S3Client({
      region: 'us-east-2',
      endpoint: LOCALSTACK_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    })

    // SQS client (not used for polling, but consumers require one)
    sqsClient = new SQSClient({
      region: 'us-east-2',
      endpoint: LOCALSTACK_ENDPOINT,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    })

    // Seed prerequisite rows
    const conn = await pool.getConnection()
    try {
      // Ensure agent rows exist (schema.sql already seeds PLANNER/REVIEWER/IMPLEMENTER,
      // migration 010 seeds CODE_REVIEWER/TESTER)

      // Ensure customer_branches row
      const [customerRows] = await conn.query(
        `SELECT id FROM customer_branches WHERE customer = 'MHK' LIMIT 1`,
      ) as [Array<{ id: number }>, unknown]
      const customerId = customerRows[0]?.id
      if (!customerId) throw new Error('Missing MHK customer row — did schema.sql run?')

      // Ensure code_repositories row
      const [repoRows] = await conn.query(
        `SELECT id FROM code_repositories WHERE repo_name = 'core-app' LIMIT 1`,
      ) as [Array<{ id: number }>, unknown]
      const repoId = repoRows[0]?.id
      if (!repoId) throw new Error('Missing core-app repo row — did schema.sql run?')

      // Ensure task_management row for this test run
      const [agentRows] = await conn.query(
        `SELECT id FROM agents WHERE name = 'QUALIFIER' LIMIT 1`,
      ) as [Array<{ id: number }>, unknown]
      const agentId = agentRows[0]?.id
      if (!agentId) throw new Error('Missing QUALIFIER agent row — did schema.sql run?')

      await conn.query(
        `INSERT INTO task_management (jira_number, customer_id, agent_id, related_code, task_type, task_s3_bucket, task_s3_key, status, source)
         VALUES (?, ?, ?, ?, 'qualification', ?, ?, 'completed', 'jira')
         ON DUPLICATE KEY UPDATE task_s3_bucket = VALUES(task_s3_bucket)`,
        [JIRA_KEY, customerId, agentId, String(repoId), S3_BUCKET, 'tasks/TEST-1234.md'],
      )

      const [tmRows] = await conn.query(
        `SELECT id FROM task_management WHERE jira_number = ? LIMIT 1`,
        [JIRA_KEY],
      ) as [Array<{ id: number }>, unknown]
      const tmId = tmRows[0]?.id
      if (!tmId) throw new Error('Failed to create task_management row')

      // Clean up any prior e2e run data (idempotent re-run support)
      const [priorRuns] = await conn.query(
        `SELECT id FROM oneshot_runs WHERE jira_key = ?`,
        [JIRA_KEY],
      ) as [Array<{ id: number }>, unknown]
      for (const prior of priorRuns) {
        await conn.query(`DELETE FROM oneshot_notifications WHERE oneshot_run_id = ?`, [prior.id])
        await conn.query(`DELETE FROM oneshot_artifacts WHERE oneshot_run_id = ?`, [prior.id])
        await conn.query(`DELETE FROM oneshot_runs WHERE id = ?`, [prior.id])
      }

      // Create the oneshot_run
      const [insertResult] = await conn.query(
        `INSERT INTO oneshot_runs (jira_key, source_task_management_id, customer_id, repo_id, branch_name, base_commit_sha, state)
         VALUES (?, ?, ?, ?, 'master', ?, 'queued_for_planning')`,
        [JIRA_KEY, tmId, customerId, repoId, BASE_COMMIT],
      ) as [{ insertId: number }, unknown]
      runId = insertResult.insertId

      // Upload task description to S3
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: 'tasks/TEST-1234.md',
        Body: `# ${JIRA_KEY}\nFix NPE in PatientService when patient not found.`,
        ContentType: 'text/markdown',
      }))

      // Upload qualification artifact to S3
      const qualificationData = {
        jiraKey: JIRA_KEY,
        ticketSummary: 'Fix NPE in PatientService',
        repoId,
        repoName: 'core-app',
        repoUrl: 'https://github.com/org/repo.git',
        branchName: 'master',
        baseCommitSha: BASE_COMMIT,
        qualified: true,
        requirementsSummary: ['Prevent NPE when patient lookup returns null'],
        acceptanceCriteriaPresent: true,
        blockingReasons: [],
        nonBlockingWarnings: [],
        pfosEligible: true,
      }

      const qualArtifactKey = `oneshot/${JIRA_KEY}/run-${runId}/qualification/v1/qualification.json`
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: qualArtifactKey,
        Body: JSON.stringify(qualificationData),
        ContentType: 'application/json',
      }))

      await oneShotDb.artifacts.upsertArtifact({
        oneshot_run_id: runId,
        stage: 'qualification',
        version: 1,
        status: 'completed',
        s3_bucket: S3_BUCKET,
        s3_key: qualArtifactKey,
        provider: 'anthropic',
        model: 'us.anthropic.claude-sonnet-4-6',
        metadata_json: { pfosEligible: true },
      })
    } finally {
      conn.release()
    }
  }, 30_000)

  afterAll(async () => {
    await pool.end()
    s3.destroy()
    sqsClient.destroy()
  })

  // -------------------------------------------------------------------------
  // Stage 1: Planner
  // -------------------------------------------------------------------------

  it('Stage 1 — Planner: queued_for_planning → queued_for_review', async () => {
    const mockDb = createMockDb(pool)
    const consumer = new TestablePlanner({
      config: { ...config, role: 'PLANNER' },
      db: mockDb as any,
      storage: createMockStorage() as any,
      sqsClient,
      s3Client: s3,
      publisher: createMockPublisher() as any,
      workspaceManager: createMockWorkspaceManager() as any,
      plannerProvider: createMockPlannerProvider(),
    })

    const msg = buildMessage({
      run_id: runId,
      stage: 'planning',
      version: 1,
      expected_state: 'queued_for_planning',
      revision: false,
      emitted_at: new Date().toISOString(),
    })

    const shouldDelete = await consumer.processMessage(msg)
    expect(shouldDelete).toBe(true)

    const run = await oneShotDb.runs.getRunById(runId)
    expect(run).toBeTruthy()
    expect(run!.state).toBe('queued_for_review')
    expect(run!.current_plan_version).toBe(1)

    // Verify plan artifact in S3
    const planArtifact = await oneShotDb.artifacts.getLatestArtifact(runId, 'plan')
    expect(planArtifact).toBeTruthy()
    expect(planArtifact!.s3_bucket).toBe(S3_BUCKET)

    const traceArtifact = await oneShotDb.artifacts.getLatestArtifact(runId, 'trace')
    expect(traceArtifact).toBeTruthy()
    expect(traceArtifact!.status).toBe('completed')
    expect(traceArtifact!.s3_key).toBe(
      `oneshot/${JIRA_KEY}/run-${runId}/trace/v1/test-cases.json`,
    )
    expect(traceArtifact!.metadata_json?.traceGuardrailResult).toEqual(
      expect.objectContaining({ passed: true, columnCount: 16 }),
    )
    const traceCsvKey = traceArtifact!.metadata_json?.csvS3Key
    expect(traceCsvKey).toBe(
      `oneshot/${JIRA_KEY}/run-${runId}/trace/v1/test-cases.csv`,
    )
    await expectS3ObjectExists(traceArtifact!.s3_key)
    await expectS3ObjectExists(traceCsvKey as string)

    const verifyArtifact = await oneShotDb.artifacts.getLatestArtifact(runId, 'verify')
    expect(verifyArtifact).toBeTruthy()
    expect(verifyArtifact!.status).toBe('completed')
    expect(verifyArtifact!.s3_key).toBe(
      `oneshot/${JIRA_KEY}/run-${runId}/verify/v1/verify-report.json`,
    )
    expect(verifyArtifact!.metadata_json).toEqual(
      expect.objectContaining({
        recommendation: 'APPROVED',
        riskLevel: 'LOW',
      }),
    )
    await expectS3ObjectExists(verifyArtifact!.s3_key)
  }, 15_000)

  // -------------------------------------------------------------------------
  // Stage 2: Plan Reviewer
  // -------------------------------------------------------------------------

  it('Stage 2 — Reviewer: queued_for_review → queued_for_implementation', async () => {
    const mockDb = createMockDb(pool)
    const consumer = new TestableReviewer({
      config: { ...config, role: 'REVIEWER' },
      db: mockDb as any,
      sqsClient,
      s3Client: s3,
      publisher: createMockPublisher() as any,
      workspaceManager: createMockWorkspaceManager() as any,
      reviewerProvider: createMockReviewerProvider(),
    })

    const msg = buildMessage({
      run_id: runId,
      stage: 'review',
      version: 1,
      expected_state: 'queued_for_review',
      revision: false,
      emitted_at: new Date().toISOString(),
    })

    const shouldDelete = await consumer.processMessage(msg)
    expect(shouldDelete).toBe(true)

    const run = await oneShotDb.runs.getRunById(runId)
    expect(run!.state).toBe('queued_for_implementation')
    expect(run!.current_review_version).toBeGreaterThanOrEqual(1)
    expect(run!.current_implementation_version).toBe(1)

    // Verify review artifact
    const reviewArtifact = await oneShotDb.artifacts.getLatestArtifact(runId, 'review')
    expect(reviewArtifact).toBeTruthy()
  }, 15_000)

  // -------------------------------------------------------------------------
  // Stage 3: Implementer
  // -------------------------------------------------------------------------

  it('Stage 3 — Implementer: queued_for_implementation → queued_for_code_review', async () => {
    const mockDb = createMockDb(pool)
    const consumer = new TestableImplementer({
      config: { ...config, role: 'IMPLEMENTER' },
      db: mockDb as any,
      sqsClient,
      s3Client: s3,
      publisher: createMockPublisher() as any,
      workspaceManager: createMockWorkspaceManager() as any,
      implementerProvider: createMockImplementerProvider(),
    })

    const msg = buildMessage({
      run_id: runId,
      stage: 'implementation',
      version: 1,
      expected_state: 'queued_for_implementation',
      revision: false,
      emitted_at: new Date().toISOString(),
    })

    const shouldDelete = await consumer.processMessage(msg)
    expect(shouldDelete).toBe(true)

    const run = await oneShotDb.runs.getRunById(runId)
    expect(run!.state).toBe('queued_for_code_review')
    expect(run!.current_implementation_version).toBe(1)
    expect(run!.current_implementation_branch).toContain('oneshot/')
    expect(run!.current_implementation_commit_sha).toBe(IMPL_COMMIT)

    // Verify implementation artifact
    const implArtifact = await oneShotDb.artifacts.getLatestArtifact(runId, 'implementation')
    expect(implArtifact).toBeTruthy()

    // Verify git operations were called
    const { pushBranch } = await import('../git.js')
    expect(pushBranch).toHaveBeenCalled()
  }, 15_000)

  // -------------------------------------------------------------------------
  // Stage 4: Code Reviewer
  // -------------------------------------------------------------------------

  it('Stage 4 — Code Reviewer: queued_for_code_review → queued_for_testing', async () => {
    const mockDb = createMockDb(pool)
    const consumer = new TestableCodeReviewer({
      config: { ...config, role: 'CODE_REVIEWER' },
      db: mockDb as any,
      sqsClient,
      s3Client: s3,
      publisher: createMockPublisher() as any,
      workspaceManager: createMockWorkspaceManager() as any,
      codeReviewerProvider: createMockCodeReviewerProvider(),
    })

    // Read current run to get the code_review_version set by implementer
    const currentRun = await oneShotDb.runs.getRunById(runId)
    const codeReviewVersion = currentRun!.current_code_review_version ?? 1

    const msg = buildMessage({
      run_id: runId,
      stage: 'code_review',
      version: codeReviewVersion,
      expected_state: 'queued_for_code_review',
      revision: false,
      emitted_at: new Date().toISOString(),
    })

    const shouldDelete = await consumer.processMessage(msg)
    expect(shouldDelete).toBe(true)

    const run = await oneShotDb.runs.getRunById(runId)
    expect(run!.state).toBe('queued_for_testing')
    expect(run!.current_code_review_version).toBeGreaterThanOrEqual(1)

    // Verify code review artifact
    const crArtifact = await oneShotDb.artifacts.getLatestArtifact(runId, 'code_review')
    expect(crArtifact).toBeTruthy()
  }, 15_000)

  // -------------------------------------------------------------------------
  // Stage 5: Tester
  // -------------------------------------------------------------------------

  it('Stage 5 — Tester: queued_for_testing → pr_open', async () => {
    const mockDb = createMockDb(pool)
    const consumer = new TestableTester({
      config: { ...config, role: 'TESTER' },
      db: mockDb as any,
      sqsClient,
      s3Client: s3,
      publisher: createMockPublisher() as any,
      workspaceManager: createMockWorkspaceManager() as any,
    })

    const currentRun = await oneShotDb.runs.getRunById(runId)
    const testVersion = currentRun!.current_test_version ?? 1

    const msg = buildMessage({
      run_id: runId,
      stage: 'testing',
      version: testVersion,
      expected_state: 'queued_for_testing',
      revision: false,
      emitted_at: new Date().toISOString(),
    })

    const shouldDelete = await consumer.processMessage(msg)
    expect(shouldDelete).toBe(true)

    const run = await oneShotDb.runs.getRunById(runId)
    expect(run!.state).toBe('pr_open')

    // Verify test result artifact
    const testArtifact = await oneShotDb.artifacts.getLatestArtifact(runId, 'test_result')
    expect(testArtifact).toBeTruthy()

    // Verify PR creation was called
    const { ensureDraftPullRequest } = await import('../github.js')
    expect(ensureDraftPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'org',
        repo: 'repo',
        head: expect.stringContaining('oneshot/'),
        base: 'master',
      }),
    )

    // Verify the final OneShot success notification was created for PR readiness
    const notifications = await pool.query(
      `SELECT * FROM oneshot_notifications WHERE oneshot_run_id = ? AND notification_type = 'pr_ready'`,
      [runId],
    ) as [Array<{ notification_type: string }>, unknown]
    expect(notifications[0].length).toBeGreaterThan(0)
  }, 15_000)

  // -------------------------------------------------------------------------
  // Full pipeline summary
  // -------------------------------------------------------------------------

  it('verifies all 8 artifact stages were produced', async () => {
    const artifacts = await oneShotDb.artifacts.getArtifactsForRun(runId)
    const stages = artifacts.map(a => a.stage)

    expect(stages).toContain('qualification')
    expect(stages).toContain('plan')
    expect(stages).toContain('trace')
    expect(stages).toContain('verify')
    expect(stages).toContain('review')
    expect(stages).toContain('implementation')
    expect(stages).toContain('code_review')
    expect(stages).toContain('test_result')
    expect(artifacts.length).toBe(8)
  })

  it('verifies token usage was accumulated', async () => {
    const run = await oneShotDb.runs.getRunById(runId)
    expect(run!.total_tokens_used).toBeGreaterThan(0)
  })
})
