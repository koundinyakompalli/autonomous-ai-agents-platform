import { BCATJiraService } from './BCATJiraService.js';
import { ExcelService } from './ExcelService.js';
import { ScenarioDetector } from './ScenarioDetector.js';
import { getScenarioHandler } from './scenarios/index.js';
import { CommentBuilder } from './CommentBuilder.js';
import { ScenarioType } from './types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('bcat-planner-agent');

export class BCATplannerAgent {
  private jira: BCATJiraService;
  private excel: ExcelService;
  private detector: ScenarioDetector;
  private commentBuilder: CommentBuilder;

  constructor(jiraUsername: string, jiraToken: string) {
    const jiraBaseUrl = process.env.JIRA_BASE_URL || '';
    if (!jiraBaseUrl) {
      throw new Error('JIRA_BASE_URL must be set for BCAT-PLANNER');
    }
    if (!jiraUsername) {
      throw new Error('jiraUsername must be provided for BCAT-PLANNER');
    }
    if (!jiraToken) {
      throw new Error('jiraToken must be provided for BCAT-PLANNER');
    }
    this.jira = new BCATJiraService(jiraBaseUrl, jiraUsername, jiraToken);
    this.excel = new ExcelService();
    this.detector = new ScenarioDetector();
    this.commentBuilder = new CommentBuilder();
  }

  async plan(jiraNumber: string, additionalContext: string = ''): Promise<string> {
    const logContext = { jira: jiraNumber };
    logger.info(logContext, '[BCAT_PLAN_START] Starting BCAT planning phase');

    try {
      // Step 1: Get JIRA issue and find Excel attachment
      logger.info(logContext, '[BCAT_PLAN_FETCH] Fetching JIRA issue');
      const issue = await this.jira.getIssue(jiraNumber);
      const title: string = issue.fields?.summary || '';
      const attachments: any[] = issue.fields?.attachment || [];

      // Find Excel attachment
      const excelAttachment = attachments.find((att: any) => {
        const fn = (att.filename || '').toLowerCase();
        return fn.endsWith('.xlsx') || fn.endsWith('.xls');
      });

      if (!excelAttachment) {
        throw new Error('No Excel (.xlsx/.xls) attachment found on JIRA ticket');
      }

      const filename: string = excelAttachment.filename;
      logger.info({ ...logContext, filename }, '[BCAT_PLAN_ATTACHMENT] Found Excel attachment');

      // Step 2: Download and parse Excel
      const buffer = await this.jira.downloadAttachment(excelAttachment.content);
      const workbook = this.excel.parseWorkbook(buffer);
      const sheetNames = this.excel.getSheetNames(workbook);

      // Step 3: Detect scenario
      const scenarioType = this.detector.detectScenario(filename, title, sheetNames);
      logger.info({ ...logContext, scenarioType, sheetNames }, '[BCAT_PLAN_SCENARIO] Detected scenario');

      if (scenarioType === ScenarioType.UNKNOWN) {
        logger.warn(logContext, '[BCAT_PLAN_UNKNOWN] Unknown scenario type - defaulting to LETTERS');
      }

      // Step 4: Extract ticket previews
      const handler = getScenarioHandler(scenarioType);
      const tickets = handler.extractTickets(workbook, filename);
      logger.info({ ...logContext, ticketCount: tickets.length }, '[BCAT_PLAN_TICKETS] Extracted ticket previews');

      // Step 5: Build plan comment
      const planComment = this.commentBuilder.buildPlanComment(jiraNumber, scenarioType, filename, tickets);

      // Step 6: Add bcat-planned label
      logger.info(logContext, '[BCAT_PLAN_LABEL] Adding bcat-planned label');
      await this.jira.addLabel(jiraNumber, 'bcat-planned');

      logger.info({ ...logContext, ticketCount: tickets.length }, '[BCAT_PLAN_COMPLETE] Planning complete');
      return planComment;

    } catch (error: any) {
      logger.error({ ...logContext, error: error.message }, '[BCAT_PLAN_ERROR] Planning failed');
      // Return error comment as output so orchestrator can post it
      return this.commentBuilder.buildErrorComment(jiraNumber, 'PLANNING', error.message);
    }
  }
}
