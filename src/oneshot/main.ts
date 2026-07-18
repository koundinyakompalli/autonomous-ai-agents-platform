import { initTelemetry, shutdownTelemetry } from './telemetry/init.js'
import { getDatabase, initDatabase } from '../orchestrator/database.js'
import { createLogger } from '../utils/logger.js'
import { getOneShotConsumerConfig, type OneShotConsumerConfig } from './config.js'
import type { QueueConsumerHealthSnapshot } from './consumer-base.js'
import { OneShotHealthServer } from './health-server.js'
import { validateOneShotConsumerRuntime } from './runtime-validation.js'
import { PlannerConsumer } from './consumers/planner.js'
import { ImplementerConsumer } from './consumers/implementer.js'
import { ReviewerConsumer } from './consumers/reviewer.js'
import { CodeReviewerConsumer } from './consumers/code-reviewer.js'
import { TesterConsumer } from './consumers/tester.js'
import { buildErrorLogFields } from '../utils/error-logging.js'

const logger = createLogger('oneshot-main')

function stageModelBinding(config: OneShotConsumerConfig): Record<string, unknown> {
  switch (config.role) {
    case 'PLANNER':
      return {
        stage: 'planning',
        model: config.plannerModelId ?? null,
        modelSource: config.plannerModelId ? 'ONESHOT_PLANNER_MODEL_ID' : 'sdk_fallback',
        scoutModel: config.plannerScoutEnabled ? config.plannerScoutModelId : null,
        scoutStage: config.plannerScoutEnabled ? 'planning_scout' : null,
      }
    case 'REVIEWER':
      return {
        stage: 'review',
        provider: config.reviewerProvider,
        model: config.reviewerModelId ?? null,
        modelSource: config.reviewerModelId ? 'ONESHOT_REVIEWER_MODEL_ID' : 'provider_default',
      }
    case 'IMPLEMENTER':
      return {
        stage: 'implementation',
        model: config.implementerModelId,
        modelSource: 'ONESHOT_IMPLEMENTER_MODEL_ID',
      }
    case 'CODE_REVIEWER':
      return {
        stage: 'code_review',
        provider: config.codeReviewerProvider,
        model: config.codeReviewerModelId ?? null,
        modelSource: config.codeReviewerModelId ? 'ONESHOT_CODE_REVIEWER_MODEL_ID' : 'provider_default',
      }
    case 'TESTER':
      return {
        stage: 'testing',
        model: null,
        modelSource: 'none',
      }
  }
}

async function main(): Promise<void> {
  const config = getOneShotConsumerConfig()
  const role = config.role

  initTelemetry(role)

  await initDatabase()
  const db = getDatabase()
  const agent = await db.getAgentByName(role)
  if (!agent) {
    throw new Error(`OneShot consumer ${role} is missing a corresponding agents table row`)
  }

  logger.info(
    {
      role,
      legacyAgentModel: agent.model,
      ...stageModelBinding(config),
    },
    'Using OneShot stage-level model configuration; agents table model is not applied to provider environment',
  )

  let consumer: { start: () => Promise<void>; stop: () => Promise<void>; getHealthSnapshot: () => QueueConsumerHealthSnapshot }
  switch (role) {
    case 'PLANNER':
      consumer = new PlannerConsumer({ config })
      break
    case 'REVIEWER':
      consumer = new ReviewerConsumer({ config })
      break
    case 'IMPLEMENTER':
      consumer = new ImplementerConsumer({ config })
      break
    case 'CODE_REVIEWER':
      consumer = new CodeReviewerConsumer({ config })
      break
    case 'TESTER':
      consumer = new TesterConsumer({ config })
      break
  }

  await validateOneShotConsumerRuntime({
    db,
    config,
  })

  const healthServer = new OneShotHealthServer({
    role,
    reporter: consumer,
  })
  await healthServer.start()

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ role, signal }, 'Shutting down OneShot consumer')
    await consumer.stop()
    await healthServer.stop()
    await shutdownTelemetry()
    logger.info({ role }, 'OneShot consumer shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      logger.error({ role, signal: 'SIGTERM', ...buildErrorLogFields(err) }, 'Shutdown error')
      process.exit(1)
    })
  })
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      logger.error({ role, signal: 'SIGINT', ...buildErrorLogFields(err) }, 'Shutdown error')
      process.exit(1)
    })
  })

  logger.info({ role }, 'Starting OneShot consumer')
  healthServer.setReady(true)
  await consumer.start()
}

main().catch(error => {
  const role = process.env.ONESHOT_ROLE?.trim() || 'unknown'
  logger.error({ role, ...buildErrorLogFields(error) }, 'Fatal error in OneShot main')
  process.exit(1)
})
