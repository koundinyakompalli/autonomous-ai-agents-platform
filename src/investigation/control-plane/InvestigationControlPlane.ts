import { createLogger } from '../../utils/logger.js'
import type { InvestigationAdapterRegistry } from '../adapters/types.js'
import { InvestigationRunner, type InvestigationRunExecution } from './InvestigationRunner.js'
import type { InvestigationRunnerOptions } from './InvestigationRunner.js'
import type { InvestigationRunRecord, InvestigationScope } from '../types/investigation.js'

const logger = createLogger('investigation-control-plane')

export interface CreateInvestigationRunInput {
  jiraKey: string
  title: string
  scope: InvestigationScope
}

export class InvestigationControlPlane {
  private readonly runner: InvestigationRunner

  constructor(
    private readonly adapters: InvestigationAdapterRegistry,
    options: InvestigationRunnerOptions = {},
  ) {
    this.runner = new InvestigationRunner(adapters, options)
  }

  createRun(input: CreateInvestigationRunInput): InvestigationRunRecord {
    const timestamp = new Date().toISOString()
    return {
      id: `inv-${Date.now()}`,
      jiraKey: input.jiraKey,
      title: input.title,
      scope: input.scope,
      status: 'queued',
      currentStage: 'intake',
      confidence: null,
      summary: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
  }

  async executeRun(run: InvestigationRunRecord): Promise<InvestigationRunExecution> {
    logger.info({
      runId: run.id,
      jiraKey: run.jiraKey,
      environment: run.scope.environment,
      clientId: run.scope.clientId,
    }, '[INVESTIGATION_RUN_START]')

    return this.runner.execute({
      ...run,
      status: 'running',
      currentStage: 'aws_triage',
      updatedAt: new Date().toISOString(),
    })
  }
}
