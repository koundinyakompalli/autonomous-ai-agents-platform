import type { Database, OneShotDashboardRunRequest } from './database.js'
import { IssueAssignmentService } from './IssueAssignmentService.js'
import { PFOS_LABEL, normalizeJiraLabels } from '../oneshot/contracts.js'
import { OneShotService } from '../oneshot/service.js'
import { createLogger } from '../utils/logger.js'

const logger = createLogger('oneshot-dashboard-run-requests')

export class OneShotDashboardRunRequestProcessor {
  constructor(
    private readonly db: Database,
    private readonly oneShotService: OneShotService,
    private readonly issueAssignmentService: IssueAssignmentService,
  ) {}

  async processQueuedRequests(limit = 5): Promise<{ processed: number; failed: number }> {
    let processed = 0
    let failed = 0

    while (processed < limit) {
      const request = await this.db.claimNextOneShotDashboardRunRequest()
      if (!request) {
        break
      }

      processed += 1

      try {
        await this.processClaimedRequest(request)
      } catch (error) {
        failed += 1
        const message = error instanceof Error ? error.message : String(error)
        logger.error( {
          requestId: request.id,
          jiraKey: request.jira_key,
          error: message,
        },'Failed to process OneShot dashboard run request')
        await this.db.markOneShotDashboardRunRequestFailed(request.id, message)
      }
    }

    return { processed, failed }
  }

  private async processClaimedRequest(
    request: OneShotDashboardRunRequest,
  ): Promise<void> {
    const qualifierAgent = await this.db.getAgentByName('QUALIFIER')
    if (!qualifierAgent || !qualifierAgent.is_active) {
      throw new Error('QUALIFIER agent is not configured for dashboard run requests')
    }

    const existingRun = await this.oneShotService.getLatestRunByJiraKey(request.jira_key)
    if (existingRun) {
      throw new Error(
        `A OneShot run already exists for ${request.jira_key}; dashboard new-run only supports fresh submissions.`,
      )
    }

    const issue = await this.issueAssignmentService.fetchJiraIssue(
      request.jira_key,
      qualifierAgent.jira_token,
    )

    const labels = normalizeJiraLabels(issue.fields.labels)
    if (!labels.has(PFOS_LABEL)) {
      logger.info( {
        requestId: request.id,
        jiraKey: request.jira_key,
      },'Adding PFOS label for dashboard-submitted run request')
      await this.issueAssignmentService.addLabel(
        request.jira_key,
        PFOS_LABEL,
        qualifierAgent.jira_token,
      )
    }

    const existingTaskManagement = await this.db.getTaskManagementByJiraAndAgent(
      request.jira_key,
      qualifierAgent.id,
    )

    const assignment = await this.issueAssignmentService.assignIssueToAgent(
      issue,
      qualifierAgent,
      {
        existingTaskManagement,
        qualifierMode: 'fresh',
        fullIssue: issue,
      },
    )

    await this.db.markOneShotDashboardRunRequestTaskCreated(
      request.id,
      assignment.taskManagementId,
    )

    logger.info( {
      requestId: request.id,
      jiraKey: request.jira_key,
      taskManagementId: assignment.taskManagementId,
      disposition: assignment.disposition,
    },'Processed OneShot dashboard run request')
  }
}
