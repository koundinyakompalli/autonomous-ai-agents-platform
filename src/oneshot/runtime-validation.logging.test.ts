import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Database } from '../orchestrator/database.js'
import type { OneShotConsumerConfig } from './config.js'

function createMockDatabase(): Database {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT DATABASE()')) {
      return [[{ dbName: 'Specter' }], undefined]
    }
    if (sql.includes('FROM information_schema.tables')) {
      return [[
        { tableName: 'oneshot_run_groups' },
        { tableName: 'oneshot_runs' },
        { tableName: 'oneshot_artifacts' },
        { tableName: 'oneshot_notifications' },
        { tableName: 'oneshot_run_events' },
        { tableName: 'router_decisions' },
        { tableName: 'router_confirmations' },
        { tableName: 'historical_ticket_index' },
      ], undefined]
    }
    if (sql.includes('FROM information_schema.columns')) {
      if (sql.includes("table_name = 'task_management'")) {
        return [[
          {
            columnType:
              "enum('assigned','in_progress','waiting_repo_confirmation','completed','failed','failed_retries_exhausted','posting_to_jira','posted_to_jira')",
          },
        ], undefined]
      }
      return [[
        { columnName: 'run_group_id' },
        { columnName: 'epic_key' },
        { columnName: 'planning_attempt_count' },
        { columnName: 'implementation_attempt_count' },
        { columnName: 'code_review_attempt_count' },
      ], undefined]
    }
    throw new Error(`Unexpected SQL in test: ${sql}`)
  })

  return {
    getPool: () => ({ query }) as never,
  } as Database
}

function createBaseConfig(overrides: Partial<OneShotConsumerConfig> = {}): OneShotConsumerConfig {
  return {
    role: 'PLANNER',
    region: 'us-east-2',
    artifactBucket: 'specter-results',
    artifactPrefix: 'oneshot',
    maxReviewLoops: 3,
    maxVerificationLoops: 3,
    maxTotalTokens: 1000,
    maxStageTokens: {
      planning: 1000,
      review: 1000,
      implementation: 1000,
      code_review: 1000,
      testing: 1000,
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
    plannerModelId: undefined,
    plannerMaxOutputTokens: 100_000,
    implementerModelId: 'us.anthropic.claude-sonnet-test',
    implementerMaxOutputTokens: 100_000,
    plannerClaudePermissionMode: 'default',
    plannerClaudeToolVisibility: 'restricted',
    plannerClaudeToolGuard: 'enabled',
    plannerScoutEnabled: false,
    plannerScoutModelId: 'us.anthropic.claude-haiku-test-v1:0',
    repoBasePath: '/tmp/repositories',
    repoAdminBasePath: '/tmp/repo-admin',
    repoCacheBasePath: '/tmp/oneshot/repos',
    workspaceBasePath: '/tmp/oneshot',
    worktreeBasePath: '/tmp/oneshot',
    promptSource: 'local',
    promptBucket: 'specter-results',
    promptManifestKey: 'oneshot/manifest.json',
    promptManifestVersionId: undefined,
    promptCacheTtlMs: 1000,
    healthcareGuardrailsEnabled: false,
    promptLocalPath: '/tmp/oneshot-prompts',
    planningQueueUrl: 'https://example.com/planning.fifo',
    reviewQueueUrl: 'https://example.com/review.fifo',
    implementationQueueUrl: 'https://example.com/implementation.fifo',
    codeReviewQueueUrl: 'https://example.com/code-review.fifo',
    testingQueueUrl: 'https://example.com/testing.fifo',
    ...overrides,
  }
}

async function createLocalPromptTree(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-prompts-'))
  await fs.mkdir(path.join(root, 'prompts'), { recursive: true })
  await fs.mkdir(path.join(root, 'guardrails'), { recursive: true })
  await fs.writeFile(path.join(root, 'prompts', 'plan.md'), 'plan prompt')
  await fs.writeFile(path.join(root, 'guardrails', 'plan-guardrails.md'), 'plan guardrails')
  return root
}

const ORIGINAL_ENV = { ...process.env }

describe('runtime validation logging', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('../utils/logger.js')
  })

  it('logs the specific failing preflight step', async () => {
    process.env.ANTHROPIC_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
    process.env.GITHUB_REPO_TOKEN = 'token'

    const info = vi.fn()
    const error = vi.fn()
    vi.doMock('../utils/logger.js', () => ({
      createLogger: () => ({ info, error }),
    }))

    const promptRoot = await createLocalPromptTree()
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-'))
    const repoAdminRoot = path.join(os.tmpdir(), `missing-repo-admin-${Date.now()}`)

    const { validateOneShotConsumerRuntime } = await import('./runtime-validation.js')

    await expect(validateOneShotConsumerRuntime({
      db: createMockDatabase(),
      config: createBaseConfig({
        repoAdminBasePath: repoAdminRoot,
        workspaceBasePath: workspaceRoot,
        promptLocalPath: promptRoot,
      }),
      s3Client: { send: vi.fn().mockResolvedValue({}) } as never,
      sqsClient: { send: vi.fn().mockResolvedValue({ Attributes: { QueueArn: 'arn:aws:sqs:::planning' } }) } as never,
      claudeExecutableValidator: vi.fn().mockResolvedValue({
        path: '/tmp/claude',
        source: 'explicit_option',
        platform: 'linux',
        arch: 'x64',
        libc: 'glibc',
        versionOutput: 'claude-test 1.0',
      }),
    })).rejects.toThrow(/repo-admin base path/i)

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'repo_admin_path',
        role: 'PLANNER',
        errorMessage: expect.stringContaining('repo-admin base path does not exist'),
      }),
      'OneShot runtime validation step failed',
    )
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        step: 'schema',
        role: 'PLANNER',
      }),
      'Starting OneShot runtime validation step',
    )
  })
})
