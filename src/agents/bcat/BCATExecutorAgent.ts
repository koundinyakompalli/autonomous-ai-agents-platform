import { BCATJiraService } from './BCATJiraService.js';
import { ExcelService } from './ExcelService.js';
import { ScenarioDetector } from './ScenarioDetector.js';
import { getScenarioHandler } from './scenarios/index.js';
import { CommentBuilder } from './CommentBuilder.js';
import { ScenarioType } from './types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('bcat-executor-agent');

// Target project for created tickets
const CPSUP_PROJECT = process.env.BCAT_TARGET_PROJECT || 'CPSUP';

// Configurable field names — set these in env to match your JIRA instance custom field IDs
const CUSTOMER_FIELD = process.env.BCAT_CUSTOMER_FIELD || 'customfield_10047';
const ENVIRONMENT_FIELD = process.env.BCAT_ENVIRONMENT_FIELD || 'customfield_environment';
const SOLUTION_FIELD = process.env.BCAT_SOLUTION_FIELD || 'customfield_solution';
const REQUEST_TYPE_FIELD = process.env.BCAT_REQUEST_TYPE_FIELD || 'customfield_10010';

export class BCATExecutorAgent {
  private jira: BCATJiraService;
  private excel: ExcelService;
  private detector: ScenarioDetector;
  private commentBuilder: CommentBuilder;

  constructor(jiraUsername: string, jiraToken: string) {
    const jiraBaseUrl = process.env.JIRA_BASE_URL || '';
    if (!jiraBaseUrl) {
      throw new Error('JIRA_BASE_URL must be set for BCAT-EXECUTOR');
    }
    if (!jiraUsername) {
      throw new Error('jiraUsername must be provided for BCAT-EXECUTOR');
    }
    if (!jiraToken) {
      throw new Error('jiraToken must be provided for BCAT-EXECUTOR');
    }
    this.jira = new BCATJiraService(jiraBaseUrl, jiraUsername, jiraToken);
    this.excel = new ExcelService();
    this.detector = new ScenarioDetector();
    this.commentBuilder = new CommentBuilder();
  }

  async execute(jiraNumber: string, additionalContext: string = ''): Promise<string> {
    const logContext = { jira: jiraNumber };
    logger.info(logContext, '[BCAT_EXEC_START] Starting BCAT execution phase');

    try {
      // Step 1: Get JIRA issue and find Excel attachment
      logger.info(logContext, '[BCAT_EXEC_FETCH] Fetching JIRA issue');
      const issue = await this.jira.getIssue(jiraNumber, [CUSTOMER_FIELD, ENVIRONMENT_FIELD, SOLUTION_FIELD, REQUEST_TYPE_FIELD]);
      const title: string = issue.fields?.summary || '';
      const attachments: any[] = issue.fields?.attachment || [];

      // Extract customer, environment, solution, and request type from parent ticket to inherit on created tickets
      const customerValue = issue.fields?.[CUSTOMER_FIELD];
      const environmentValue = issue.fields?.[ENVIRONMENT_FIELD];
      const solutionValue = issue.fields?.[SOLUTION_FIELD];
      const requestTypeRaw = issue.fields?.[REQUEST_TYPE_FIELD];

      // Extract request type ID as string - handle both object and string formats
      let requestTypeId: string | undefined;
      if (requestTypeRaw) {
        if (typeof requestTypeRaw === 'string') {
          requestTypeId = requestTypeRaw;
        } else if (typeof requestTypeRaw === 'object' && requestTypeRaw.requestType?.id) {
          requestTypeId = String(requestTypeRaw.requestType.id);
        } else if (typeof requestTypeRaw === 'object' && requestTypeRaw.id) {
          requestTypeId = String(requestTypeRaw.id);
        }
      }

      const inheritedFields: Record<string, any> = {};
      if (customerValue) inheritedFields[CUSTOMER_FIELD] = customerValue;
      if (environmentValue) inheritedFields[ENVIRONMENT_FIELD] = environmentValue;
      if (solutionValue) inheritedFields[SOLUTION_FIELD] = solutionValue;
      if (requestTypeId) inheritedFields[REQUEST_TYPE_FIELD] = requestTypeId;
      logger.info({ ...logContext, customerValue, environmentValue, solutionValue, requestTypeId }, '[BCAT_EXEC_INHERIT] Inherited customer, environment, solution, and request type from parent ticket');

      const excelAttachment = attachments.find((att: any) => {
        const fn = (att.filename || '').toLowerCase();
        return fn.endsWith('.xlsx') || fn.endsWith('.xls');
      });

      if (!excelAttachment) {
        throw new Error('No Excel (.xlsx/.xls) attachment found on JIRA ticket');
      }

      const filename: string = excelAttachment.filename;
      logger.info({ ...logContext, filename }, '[BCAT_EXEC_ATTACHMENT] Found Excel attachment');

      // Step 2: Download and parse Excel
      const buffer = await this.jira.downloadAttachment(excelAttachment.content);
      const workbook = this.excel.parseWorkbook(buffer);
      const sheetNames = this.excel.getSheetNames(workbook);

      // Step 3: Detect scenario
      const scenarioType = this.detector.detectScenario(filename, title, sheetNames);
      logger.info({ ...logContext, scenarioType }, '[BCAT_EXEC_SCENARIO] Detected scenario');

      // Step 4: Extract tickets
      const handler = getScenarioHandler(scenarioType);
      let tickets = handler.extractTickets(workbook, filename);

      // For Upgrades scenario: format summary as "Client | Tab - Technically Enabled Config"
      let upgradesClientLabel = '';
      if (scenarioType === ScenarioType.UPGRADES) {
        // Extract client name - handle array format [{ value: 'BCBSMA CP', id: '...' }]
        let clientName = '';
        if (customerValue) {
          if (Array.isArray(customerValue) && customerValue.length > 0) {
            const firstItem = customerValue[0];
            clientName = firstItem?.value || firstItem?.name || firstItem?.displayName || String(firstItem);
          } else if (typeof customerValue === 'object') {
            clientName = customerValue.value || customerValue.name || customerValue.displayName || '';
          } else {
            clientName = String(customerValue);
          }
        }
        upgradesClientLabel = clientName || 'Client';
        tickets = tickets.map(ticket => ({
          ...ticket,
          summary: `${upgradesClientLabel} | ${ticket.summary} - Technically Enabled Config`.substring(0, 255),
        }));
        logger.info({ ...logContext, clientName: upgradesClientLabel }, '[BCAT_EXEC_UPGRADES_SUMMARY] Formatted Upgrades ticket summaries');
      }

      logger.info({ ...logContext, ticketCount: tickets.length }, '[BCAT_EXEC_TICKETS] Extracted tickets to create');

      // Step 5: Create JIRA tickets
      const created: Array<{ jiraKey: string; summary: string; sourceRef: string }> = [];
      const failed: Array<{ summary: string; sourceRef: string; error: string }> = [];

      for (const ticket of tickets) {
        const logTicketCtx = { ...logContext, summary: ticket.summary, sourceRef: ticket.sourceRef };
        try {
          // Create the issue — inherit customer and environment from parent BCAT ticket
          const newIssue = await this.jira.createIssue({
            project: CPSUP_PROJECT,
            summary: ticket.summary,
            description: ticket.description,
            issueType: ticket.issueType,
            priority: ticket.priority,
            labels: ticket.labels,
            customFields: { ...inheritedFields, ...ticket.customFields },
          });

          logger.info({ ...logTicketCtx, jiraKey: newIssue.key }, '[BCAT_EXEC_CREATED] Ticket created');

          // Attach per-ticket Excel if scenario provides one
          const attachmentBuffer = handler.getAttachmentBuffer(workbook, ticket.sourceRef);
          if (attachmentBuffer) {
            const attachFilename = `${newIssue.key}-${filename}`;
            await this.jira.attachFile(newIssue.key, attachFilename, attachmentBuffer);
            logger.info({ ...logTicketCtx, jiraKey: newIssue.key }, '[BCAT_EXEC_ATTACHED] Attachment added');
          }

          // Link to parent ticket
          await this.jira.linkIssues(newIssue.key, jiraNumber, 'Relates');

          created.push({
            jiraKey: newIssue.key,
            summary: ticket.summary,
            sourceRef: ticket.sourceRef,
          });

        } catch (ticketError: any) {
          logger.error({ ...logTicketCtx, error: ticketError.message }, '[BCAT_EXEC_TICKET_ERROR] Failed to create ticket');
          failed.push({
            summary: ticket.summary,
            sourceRef: ticket.sourceRef,
            error: ticketError.message,
          });
        }
      }

      // Step 5b: For Upgrades — create one additional "Features needed - CONFIG ENV" ticket
      if (scenarioType === ScenarioType.UPGRADES) {
        const configEnvSummary = `${upgradesClientLabel} | Features needed - CONFIG ENV`.substring(0, 255);
        try {
          const configEnvIssue = await this.jira.createIssue({
            project: CPSUP_PROJECT,
            summary: configEnvSummary,
            description: `Configuration and environment features needed for ${jiraNumber}.`,
            issueType: 'Task',
            labels: ['BCAT-created'],
            customFields: { ...inheritedFields },
          });
          await this.jira.linkIssues(configEnvIssue.key, jiraNumber, 'Relates');
          created.push({ jiraKey: configEnvIssue.key, summary: configEnvSummary, sourceRef: 'config-env' });
          logger.info({ ...logContext, jiraKey: configEnvIssue.key }, '[BCAT_EXEC_CONFIG_ENV] Config ENV ticket created');
        } catch (configEnvError: any) {
          logger.error({ ...logContext, error: configEnvError.message }, '[BCAT_EXEC_CONFIG_ENV_ERROR] Failed to create Config ENV ticket');
          failed.push({ summary: configEnvSummary, sourceRef: 'config-env', error: configEnvError.message });
        }
      }

      // Step 6: Add bcat-processed label
      logger.info(logContext, '[BCAT_EXEC_LABEL] Adding bcat-processed label');
      await this.jira.addLabel(jiraNumber, 'bcat-processed');

      // Step 7: Build completion comment
      const completionComment = this.commentBuilder.buildCompletionComment(
        jiraNumber, scenarioType, filename, created, failed
      );

      logger.info({ ...logContext, createdCount: created.length, failedCount: failed.length, totalCount: tickets.length }, '[BCAT_EXEC_COMPLETE] Execution complete');
      return completionComment;

    } catch (error: any) {
      logger.error({ ...logContext, error: error.message }, '[BCAT_EXEC_ERROR] Execution failed');
      return this.commentBuilder.buildErrorComment(jiraNumber, 'EXECUTION', error.message);
    }
  }
}
