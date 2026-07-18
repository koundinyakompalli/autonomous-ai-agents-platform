/**
 * BC-INTAKE Agent - BC Upgrade Ticket Validation Agent
 *
 * Hybrid agent: deterministic document parsing + field validation
 *
 * ## Workflow
 * 1. [BC_INTAKE_INIT] - Agent created with credentials
 * 2. [BC_INTAKE_DOWNLOAD] - Download Word attachment from JIRA
 * 3. [BC_INTAKE_PARSE] - Parse document and extract fields
 * 4. [BC_INTAKE_VALIDATE] - Validate 10 mandatory fields
 * 5. [BC_INTAKE_AI_NOTE] - Post detailed validation result to AI Note field (or fallback to comment)
 * 6. [BC_INTAKE_SUMMARY] - Always post run summary comment to Comments section
 *                         Incomplete: @mention intake user + missing fields list
 *                         Complete: "BC-INTAKE Ran with Result of X/10 fields filled"
 * 7. [BC_INTAKE_PROCESS] - For complete tickets (10/10): add DARCI + HERMES labels,
 *                         set Configuration Start Date, set Estimated Completion Date
 * 8. [BC_INTAKE_CLEANUP] - Remove temp files
 */

import fs from 'fs';
import { createLogger } from '../../utils/logger.js';
import { BCIntakeJiraService } from './BCIntakeJiraService.js';
import { BCIntakeDocumentParser } from './BCIntakeDocumentParser.js';
import type {
    BCIntakeAgentOptions,
    BCIntakeResult,
    IntakeFormFields,
    TicketValidationResult,
    FieldValidation,
    MANDATORY_FIELD_NAMES,
} from './types.js';

const logger = createLogger('bc-intake-agent');

/** Mandatory field names for validation */
const MANDATORY_FIELDS: string[] = [
    'Module',
    'Severity Level',
    'Environment',
    'Test Case Description',
    'Case #',
    'Member ID',
    'Applicable Test Data',
    'Steps to Reproduce',
    'Expected Results',
    'Actual Results',
];

/** Field mapping from IntakeFormFields to display names */
const FIELD_DISPLAY_MAP: Record<keyof IntakeFormFields, string> = {
    module: 'Module',
    severityLevel: 'Severity Level',
    environment: 'Environment',
    testCaseDescription: 'Test Case Description',
    caseNumber: 'Case #',
    memberId: 'Member ID',
    applicableTestData: 'Applicable Test Data',
    stepsToReproduce: 'Steps to Reproduce',
    expectedResults: 'Expected Results',
    actualResults: 'Actual Results',
};

export class BCIntakeAgent {
    private options: BCIntakeAgentOptions;
    private instanceId: string;
    private jira: BCIntakeJiraService;
    private parser: BCIntakeDocumentParser;

    constructor(options: BCIntakeAgentOptions) {
        this.instanceId = `bc-intake-${Date.now()}`;
        this.options = {
            timeoutMs: 10 * 60 * 1000, // 10 minutes default
            ...options,
        };

        const logContext = {
            instanceId: this.instanceId,
            timeoutMs: this.options.timeoutMs,
        };

        logger.debug(logContext, '[BC_INTAKE_INIT] Creating BCIntakeAgent instance');

        // Initialize JIRA service
        const jiraBaseUrl = process.env.JIRA_BASE_URL || 'https://mhkjira.atlassian.net';
        const jiraUsername = options.jiraUsername || process.env.JIRA_USERNAME || '';
        const jiraToken = options.jiraToken || process.env.JIRA_TOKEN || '';

        this.jira = new BCIntakeJiraService(jiraBaseUrl, jiraUsername, jiraToken);
        this.parser = new BCIntakeDocumentParser();

        logger.info(logContext, '[BC_INTAKE_INIT] BCIntakeAgent initialized');
    }

    /**
     * Process BC Upgrade ticket validation
     *
     * @param jiraNumber - JIRA ticket key (e.g., CPSUP-12345)
     * @param additionalContext - Optional context from orchestrator
     * @returns Validation result with actions taken
     */
    async validate(jiraNumber: string, additionalContext?: string): Promise<BCIntakeResult> {
        const startTime = Date.now();
        const logContext = {
            jiraNumber,
            instanceId: this.instanceId,
        };

        logger.info(logContext, '[BC_INTAKE_VALIDATE_START] Starting BC Upgrade ticket validation');

        let tempFilePath: string | null = null;
        let documentParsed = false;

        try {
            // Step 1: Download supported DOCX attachment
            logger.info(logContext, '[BC_INTAKE_DOWNLOAD] Downloading DOCX attachment from JIRA');
            tempFilePath = await this.jira.downloadWordAttachment(jiraNumber);

            if (!tempFilePath) {
                throw new Error('No supported DOCX attachment found in ticket');
            }

            logger.info({ ...logContext, tempFilePath }, '[BC_INTAKE_DOWNLOAD_SUCCESS] DOCX attachment downloaded');

            // Step 2: Parse document
            logger.info(logContext, '[BC_INTAKE_PARSE] Parsing intake form document');
            const parseResult = await this.parser.parseDocument(tempFilePath);

            if (!parseResult.success) {
                throw new Error(`Document parsing failed: ${parseResult.error}`);
            }

            documentParsed = true;

            logger.info({
                ...logContext,
                fieldsExtracted: Object.keys(parseResult.fields).length,
            }, '[BC_INTAKE_PARSE_SUCCESS] Document parsed successfully');

            // Step 3: Validate fields
            logger.info(logContext, '[BC_INTAKE_VALIDATE_FIELDS] Validating mandatory fields');
            const validation = this.validateFields(parseResult.fields);
            validation.sourceDocument = parseResult.fileName;

            logger.info({
                ...logContext,
                isComplete: validation.isComplete,
                completedCount: validation.completedCount,
                missingCount: validation.missingFields.length,
            }, '[BC_INTAKE_VALIDATE_FIELDS_DONE] Field validation complete');

            // Step 4: Determine if reporter should be mentioned (for fallback comment)
            const mentionReporter = !validation.isComplete;
            let reporterAccountId: string | undefined;

            if (mentionReporter) {
                reporterAccountId = await this.jira.getReporterAccountId(jiraNumber);
            }

            // Step 5: Post validation to AI Agent Notes tab (or fallback to comment)
            logger.info(logContext, '[BC_INTAKE_POST] Posting validation result');

            let postedToAINote = false;
            let aiNoteField: string | undefined;

            // Try to find available AI Note field
            const availableNote = await this.jira.findFirstAvailableAINote(jiraNumber);

            if (availableNote) {
                // Post to AI Note field
                try {
                    await this.jira.postToAINote(
                        jiraNumber,
                        availableNote.fieldId,
                        availableNote.name,
                        validation
                    );
                    postedToAINote = true;
                    aiNoteField = availableNote.name;
                    logger.info({ ...logContext, aiNoteField }, '[BC_INTAKE_AI_NOTE_SUCCESS] Posted to AI Note field');
                } catch (error: any) {
                    logger.warn({
                        ...logContext,
                        error: error.message,
                        aiNoteField: availableNote.name
                    }, '[BC_INTAKE_AI_NOTE_WARN] Failed to post to AI Note, falling back to comment');
                    postedToAINote = false;
                }
            } else {
                logger.info(logContext, '[BC_INTAKE_FALLBACK] All AI Note fields full, using comment fallback');
            }

            // Fallback to comment if AI Note posting failed or all fields full
            if (!postedToAINote) {
                logger.info(logContext, '[BC_INTAKE_COMMENT] Posting validation comment');
                await this.jira.postValidationComment(
                    jiraNumber,
                    validation,
                    mentionReporter,
                    reporterAccountId
                );
                logger.info(logContext, '[BC_INTAKE_COMMENT_SUCCESS] Validation comment posted');
            }

            // Step 6: Always post run summary comment to Comments section
            try {
                await this.jira.postRunSummaryComment(jiraNumber, validation, reporterAccountId);
                logger.info(logContext, '[BC_INTAKE_SUMMARY] Run summary comment posted');
            } catch (error: any) {
                logger.warn({ ...logContext, error: error.message }, '[BC_INTAKE_SUMMARY_WARN] Failed to post run summary comment');
            }

            // Step 7: Process complete tickets (10/10 fields only)
            const actions: {
                postedToAINote?: boolean;
                aiNoteField?: string;
                commentPosted?: boolean;
                labelsAdded?: string[];
                configDateSet?: boolean;
                estimatedCompletionDateSet?: boolean;
            } = {
                postedToAINote,
                aiNoteField,
                commentPosted: !postedToAINote, // Comment posted if AI Note failed
            };
            let configurationStartDate: string | undefined;
            let estimatedCompletionDate: string | undefined;

            if (validation.isComplete) {
                logger.info(logContext, '[BC_INTAKE_PROCESS] Processing complete ticket (10/10 fields)');

                // Add DARCI and HERMES labels
                const labelsToAdd = ['DARCI', 'HERMES'];
                const addedLabels: string[] = [];

                for (const label of labelsToAdd) {
                    try {
                        await this.jira.addLabel(jiraNumber, label);
                        addedLabels.push(label);
                        logger.info({ ...logContext, label }, '[BC_INTAKE_PROCESS_LABEL] Label added');
                    } catch (error: any) {
                        logger.warn({ ...logContext, label, error: error.message }, '[BC_INTAKE_PROCESS_LABEL_WARN] Failed to add label');
                    }
                }

                if (addedLabels.length > 0) {
                    actions.labelsAdded = addedLabels;
                }

                // Set Configuration Start Date
                try {
                    configurationStartDate = this.calculateConfigurationStartDate();
                    await this.jira.setConfigurationStartDate(jiraNumber, configurationStartDate);
                    actions.configDateSet = true;
                    logger.info({ ...logContext, configurationStartDate }, '[BC_INTAKE_PROCESS_DATE] Configuration Start Date set');
                } catch (error: any) {
                    logger.warn({ ...logContext, error: error.message }, '[BC_INTAKE_PROCESS_DATE_WARN] Failed to set Configuration Start Date');
                }

                // Set Estimated Completion Date
                try {
                    estimatedCompletionDate = this.calculateEstimatedCompletionDate();
                    await this.jira.setEstimatedCompletionDate(jiraNumber, estimatedCompletionDate);
                    actions.estimatedCompletionDateSet = true;
                    logger.info({ ...logContext, estimatedCompletionDate }, '[BC_INTAKE_PROCESS_EST_DATE] Estimated Completion Date set');
                } catch (error: any) {
                    logger.warn({ ...logContext, error: error.message }, '[BC_INTAKE_PROCESS_EST_DATE_WARN] Failed to set Estimated Completion Date');
                }
            }

            const durationMs = Date.now() - startTime;

            logger.info({
                ...logContext,
                durationMs,
                isComplete: validation.isComplete,
            }, '[BC_INTAKE_VALIDATE_SUCCESS] BC Upgrade ticket validation complete');

            return {
                success: true,
                jiraNumber,
                validation,
                actionsT: actions,
                configurationStartDate,
                estimatedCompletionDate,
                metrics: {
                    durationMs,
                    documentParsed,
                    fieldsValidated: validation.totalFields,
                },
            };
        } catch (error: any) {
            const durationMs = Date.now() - startTime;

            logger.error({
                ...logContext,
                durationMs,
                error: error.message,
                errorStack: error.stack,
            }, '[BC_INTAKE_VALIDATE_ERROR] Validation failed');

            return {
                success: false,
                jiraNumber,
                validation: {
                    isComplete: false,
                    completedFields: [],
                    missingFields: [],
                    totalFields: MANDATORY_FIELDS.length,
                    completedCount: 0,
                },
                actionsT: {
                    postedToAINote: false,
                    commentPosted: false,
                },
                error: error.message,
                metrics: {
                    durationMs,
                    documentParsed,
                    fieldsValidated: 0,
                },
            };
        } finally {
            // Cleanup: Remove temp file
            if (tempFilePath) {
                try {
                    await fs.promises.unlink(tempFilePath);
                    logger.debug({ ...logContext, tempFilePath }, '[BC_INTAKE_CLEANUP] Temp file removed');
                } catch (cleanupError: any) {
                    logger.warn({
                        ...logContext,
                        error: cleanupError.message,
                    }, '[BC_INTAKE_CLEANUP_WARN] Failed to remove temp file');
                }
            }
        }
    }

    /**
     * Calculate Estimated Completion Date based on current time
     *
     * - Before 3pm EST: current date + 48 hours
     * - After 3pm EST: current date + 72 hours
     */
    private calculateEstimatedCompletionDate(): string {
        const now = new Date();

        // Use Intl to get the correct Eastern offset (handles EST/EDT automatically)
        const estFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
        const estParts = estFormatter.formatToParts(now);
        const p = Object.fromEntries(estParts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
        const estTime = new Date(`${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour.padStart(2,'0')}:${p.minute}:00`);

        const isBeforeCutoff = estTime.getHours() < 15;
        const hoursToAdd = isBeforeCutoff ? 48 : 72;

        const completionDate = new Date(estTime.getTime() + hoursToAdd * 60 * 60 * 1000);

        const year = completionDate.getFullYear();
        const month = String(completionDate.getMonth() + 1).padStart(2, '0');
        const day = String(completionDate.getDate()).padStart(2, '0');

        return `${year}-${month}-${day}`;
    }

    /**
     * Validate extracted fields against mandatory requirements
     */
    private validateFields(fields: IntakeFormFields): TicketValidationResult {
        const completedFields: FieldValidation[] = [];
        const missingFields: FieldValidation[] = [];

        for (const [fieldKey, displayName] of Object.entries(FIELD_DISPLAY_MAP)) {
            const value = fields[fieldKey as keyof IntakeFormFields];
            const isCompleted = value && value.trim().length > 0;

            const fieldValidation: FieldValidation = {
                field: displayName,
                completed: isCompleted,
                value: isCompleted ? value : undefined,
                reason: isCompleted ? undefined : 'Missing from form',
            };

            if (isCompleted) {
                completedFields.push(fieldValidation);
            } else {
                missingFields.push(fieldValidation);
            }
        }

        return {
            isComplete: missingFields.length === 0,
            completedFields,
            missingFields,
            totalFields: MANDATORY_FIELDS.length,
            completedCount: completedFields.length,
        };
    }

    /**
     * Calculate Configuration Start Date based on current time
     *
     * - Before 3pm EST: Today
     * - After 3pm EST: Tomorrow
     */
    private calculateConfigurationStartDate(): string {
        const now = new Date();

        // Use Intl to get the correct Eastern offset (handles EST/EDT automatically)
        const estFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
        const estParts = estFormatter.formatToParts(now);
        const p = Object.fromEntries(estParts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
        const estTime = new Date(`${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour.padStart(2,'0')}:${p.minute}:00`);

        // Check if before 3pm EST (15:00)
        const cutoffHour = 15;
        const isBeforeCutoff = estTime.getHours() < cutoffHour;

        let configDate: Date;
        if (isBeforeCutoff) {
            configDate = estTime; // Today
        } else {
            configDate = new Date(estTime.getTime() + 24 * 60 * 60 * 1000); // Tomorrow
        }

        // Format as YYYY-MM-DD
        const year = configDate.getFullYear();
        const month = String(configDate.getMonth() + 1).padStart(2, '0');
        const day = String(configDate.getDate()).padStart(2, '0');

        return `${year}-${month}-${day}`;
    }
}
