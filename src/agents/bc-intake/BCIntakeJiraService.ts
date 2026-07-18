/**
 * BC-INTAKE JIRA Service
 *
 * JIRA API operations for BC Upgrade ticket validation:
 * - Get issue with attachments
 * - Download Word/DOCX attachments
 * - Post validation comments (with deduplication check)
 * - Add labels (DARCI, HERMES, Clio)
 * - Set Configuration Start Date custom field
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../../utils/logger.js';
import type { TicketValidationResult } from './types.js';
import { AI_NOTE_FIELDS, JIRA_FIELD_IDS } from './types.js';

const logger = createLogger('bc-intake-jira-service');

interface IssueAttachment {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
    content: string; // Download URL
}

function isDocxAttachment(attachment: IssueAttachment): boolean {
    return attachment.filename.toLowerCase().endsWith('.docx');
}

export class BCIntakeJiraService {
    private baseUrl: string;
    private authHeader: string;

    constructor(baseUrl: string, username: string, token: string) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.authHeader = `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
    }

    private get headers() {
        return {
            'Authorization': this.authHeader,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        };
    }

    /**
     * Get JIRA issue with attachments
     */
    async getIssue(jiraNumber: string): Promise<any> {
        const url = `${this.baseUrl}/rest/api/3/issue/${jiraNumber}?fields=summary,description,status,reporter,attachment,created,labels`;

        logger.debug({ jiraNumber }, '[BC_INTAKE_JIRA_GET] Fetching issue');

        const response = await fetch(url, {
            headers: { 'Authorization': this.authHeader, 'Accept': 'application/json' },
        });

        if (!response.ok) {
            throw new Error(`JIRA getIssue failed for ${jiraNumber}: ${response.status} ${response.statusText}`);
        }

        const issue = await response.json() as any;

        logger.info({
            jiraNumber,
            attachmentCount: issue.fields?.attachment?.length || 0,
        }, '[BC_INTAKE_JIRA_GET_SUCCESS] Issue fetched');

        return issue;
    }

    /**
     * Get attachments from issue
     */
    async getAttachments(jiraNumber: string): Promise<IssueAttachment[]> {
        const issue = await this.getIssue(jiraNumber);
        const attachments = issue.fields?.attachment || [];

        return attachments.map((att: any) => ({
            id: att.id,
            filename: att.filename,
            mimeType: att.mimeType,
            size: att.size,
            content: att.content,
        }));
    }

    /**
     * Download supported DOCX attachment from JIRA
     *
     * Returns path to downloaded file in temp directory
     */
    async downloadWordAttachment(jiraNumber: string): Promise<string | null> {
        const logContext = { jiraNumber };

        logger.info(logContext, '[BC_INTAKE_DOWNLOAD] Looking for DOCX intake attachment');

        const attachments = await this.getAttachments(jiraNumber);

        const docxAttachment = attachments.find(isDocxAttachment);

        if (!docxAttachment) {
            const unsupportedDocAttachment = attachments.find(att =>
                att.filename.toLowerCase().endsWith('.doc')
            );

            if (unsupportedDocAttachment) {
                logger.warn({
                    ...logContext,
                    filename: unsupportedDocAttachment.filename,
                }, '[BC_INTAKE_DOWNLOAD_UNSUPPORTED] Legacy .doc attachments are not supported; require DOCX');
            }

            logger.warn(logContext, '[BC_INTAKE_DOWNLOAD_NONE] No supported DOCX attachment found');
            return null;
        }

        logger.info({
            ...logContext,
            filename: docxAttachment.filename,
            size: docxAttachment.size,
        }, '[BC_INTAKE_DOWNLOAD_START] Downloading DOCX attachment');

        // Download to temp directory
        const tempDir = os.tmpdir();
        const tempFilePath = path.join(tempDir, `bc-intake-${jiraNumber}-${Date.now()}.docx`);

        const response = await fetch(docxAttachment.content, {
            headers: { 'Authorization': this.authHeader },
        });

        if (!response.ok) {
            throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        await fs.promises.writeFile(tempFilePath, Buffer.from(arrayBuffer));

        logger.info({
            ...logContext,
            tempFilePath,
            fileSize: (await fs.promises.stat(tempFilePath)).size,
        }, '[BC_INTAKE_DOWNLOAD_SUCCESS] DOCX attachment downloaded');

        return tempFilePath;
    }

    /**
     * Check if BC-INTAKE agent has already commented on this ticket
     */
    async hasAgentCommented(jiraNumber: string): Promise<boolean> {
        const url = `${this.baseUrl}/rest/api/3/issue/${jiraNumber}/comment`;

        const response = await fetch(url, {
            headers: { 'Authorization': this.authHeader, 'Accept': 'application/json' },
        });

        if (!response.ok) {
            logger.warn({ jiraNumber }, '[BC_INTAKE_CHECK_COMMENTS_WARN] Could not check existing comments');
            return false;
        }

        const data = await response.json() as any;
        const comments = data.comments || [];

        // Check if any comment is from BC-INTAKE agent specifically
        for (const comment of comments) {
            const bodyText = JSON.stringify(comment.body || '');

            // Only match BC-INTAKE's own signature, not other DevAI agents (DARCI, HERMES)
            if (bodyText.includes('BC Upgrade Ticket Validation Results') || bodyText.includes('BC-INTAKE Ran with Result')) {
                logger.info({ jiraNumber }, '[BC_INTAKE_DUPLICATE_DETECTED] Agent has already commented');
                return true;
            }
        }

        return false;
    }

    /**
     * Post validation comment to JIRA ticket
     */
    async postValidationComment(
        jiraNumber: string,
        validation: TicketValidationResult,
        mentionReporter: boolean = false,
        reporterAccountId?: string
    ): Promise<void> {
        const logContext = { jiraNumber, isComplete: validation.isComplete };

        // Check for duplicate comments to prevent agent from commenting twice
        const alreadyCommented = await this.hasAgentCommented(jiraNumber);
        if (alreadyCommented) {
            logger.info(logContext, '[BC_INTAKE_COMMENT_SKIP] Agent has already commented, skipping duplicate');
            return;
        }

        logger.info(logContext, '[BC_INTAKE_COMMENT_POST] Posting validation comment');

        // Build comment body using ADF (Atlassian Document Format)
        const commentBody = this.buildValidationCommentADF(
            validation,
            mentionReporter,
            reporterAccountId
        );

        const url = `${this.baseUrl}/rest/api/3/issue/${jiraNumber}/comment`;

        const response = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ body: commentBody }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`JIRA postComment failed: ${response.status} ${errorText}`);
        }

        logger.info(logContext, '[BC_INTAKE_COMMENT_SUCCESS] Validation comment posted');
    }

    /**
     * Build validation comment in ADF format
     */
    private buildValidationCommentADF(
        validation: TicketValidationResult,
        mentionReporter: boolean,
        reporterAccountId?: string
    ): any {
        const content: any[] = [];

        // Add reporter mention if needed (for incomplete tickets)
        if (mentionReporter && reporterAccountId) {
            content.push({
                type: 'paragraph',
                content: [
                    {
                        type: 'mention',
                        attrs: { id: reporterAccountId },
                    },
                ],
            });
        }

        // Title panel
        const status = validation.isComplete ? 'COMPLETE' : 'INCOMPLETE';
        const statusEmoji = validation.isComplete ? '✅' : '⚠️';
        const panelType = validation.isComplete ? 'success' : 'warning';

        content.push({
            type: 'panel',
            attrs: { panelType },
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: `${statusEmoji} BC Upgrade Ticket Validation Results`, marks: [{ type: 'strong' }] },
                    ],
                },
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: `Status: ${status} - ` },
                        {
                            type: 'text',
                            text: validation.isComplete
                                ? 'All mandatory fields are filled in'
                                : `Missing ${validation.missingFields.length} required field(s)`,
                        },
                    ],
                },
            ],
        });

        // For incomplete tickets, show missing fields first
        if (!validation.isComplete && validation.missingFields.length > 0) {
            content.push({
                type: 'heading',
                attrs: { level: 3 },
                content: [{ type: 'text', text: `Missing Fields (${validation.missingFields.length})` }],
            });

            const missingList: any[] = [];
            for (const field of validation.missingFields) {
                missingList.push({
                    type: 'listItem',
                    content: [
                        {
                            type: 'paragraph',
                            content: [
                                { type: 'text', text: `${field.field}`, marks: [{ type: 'strong' }] },
                                { type: 'text', text: ` - ${field.reason || 'Missing from form'}` },
                            ],
                        },
                    ],
                });
            }

            content.push({
                type: 'bulletList',
                content: missingList,
            });
        }

        // Show completed fields
        content.push({
            type: 'heading',
            attrs: { level: 3 },
            content: [{ type: 'text', text: `Completed Fields (${validation.completedCount}/${validation.totalFields})` }],
        });

        const completedList: any[] = [];
        for (const field of validation.completedFields) {
            completedList.push({
                type: 'listItem',
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            { type: 'text', text: '✅ ' },
                            { type: 'text', text: field.field, marks: [{ type: 'strong' }] },
                        ],
                    },
                ],
            });
        }

        content.push({
            type: 'bulletList',
            content: completedList,
        });

        // Source document
        if (validation.sourceDocument) {
            content.push({
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'Validated from: ', marks: [{ type: 'em' }] },
                    { type: 'text', text: `[${validation.sourceDocument}]`, marks: [{ type: 'em' }] },
                    { type: 'text', text: ' (parsed automatically)', marks: [{ type: 'em' }] },
                ],
            });
        }

        // Add instructions for incomplete tickets
        if (!validation.isComplete) {
            content.push({
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'Please complete the missing fields and update the attached document.', marks: [{ type: 'strong' }] },
                ],
            });
        }

        // Timestamp
        content.push({
            type: 'paragraph',
            content: [
                { type: 'text', text: `Validated: ${new Date().toISOString()}`, marks: [{ type: 'em' }] },
            ],
        });

        return {
            type: 'doc',
            version: 1,
            content,
        };
    }

    /**
     * Add label to issue
     */
    async addLabel(jiraNumber: string, label: string): Promise<void> {
        const url = `${this.baseUrl}/rest/api/3/issue/${jiraNumber}`;
        const body = { update: { labels: [{ add: label }] } };

        const response = await fetch(url, {
            method: 'PUT',
            headers: this.headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`JIRA addLabel failed: ${response.status} ${errorText}`);
        }

        logger.info({ jiraNumber, label }, '[BC_INTAKE_LABEL_ADD] Label added');
    }

    /**
     * Set Configuration Start Date custom field
     */
    async setConfigurationStartDate(jiraNumber: string, date: string): Promise<void> {
        const url = `${this.baseUrl}/rest/api/3/issue/${jiraNumber}`;

        // Assuming customfield_10114 is the Configuration Start Date field
        // This should be configured in the environment or agent config
        const fieldId = process.env.BC_INTAKE_CONFIG_DATE_FIELD || 'customfield_10114';

        const body = {
            fields: {
                [fieldId]: date, // YYYY-MM-DD format
            },
        };

        const response = await fetch(url, {
            method: 'PUT',
            headers: this.headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`JIRA setConfigurationStartDate failed: ${response.status} ${errorText}`);
        }

        logger.info({ jiraNumber, date, fieldId }, '[BC_INTAKE_CONFIG_DATE_SET] Configuration Start Date set');
    }

    /**
     * Set Estimated Completion Date custom field
     *
     * - Before 3pm EST: current date + 48 hours
     * - After 3pm EST: current date + 72 hours
     */
    async setEstimatedCompletionDate(jiraNumber: string, date: string): Promise<void> {
        const url = `${this.baseUrl}/rest/api/3/issue/${jiraNumber}`;
        const fieldId = process.env.BC_INTAKE_ESTIMATED_COMPLETION_DATE_FIELD || JIRA_FIELD_IDS.ESTIMATED_COMPLETION_DATE;

        const body = {
            fields: {
                [fieldId]: date, // YYYY-MM-DD format
            },
        };

        const response = await fetch(url, {
            method: 'PUT',
            headers: this.headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`JIRA setEstimatedCompletionDate failed: ${response.status} ${errorText}`);
        }

        logger.info({ jiraNumber, date, fieldId }, '[BC_INTAKE_EST_DATE_SET] Estimated Completion Date set');
    }

    /**
     * Post a run summary comment to JIRA ticket Comments section (always runs).
     *
     * Complete tickets: "BC-INTAKE Ran with Result of 10/10 fields filled"
     * Incomplete tickets: @mention intake user + missing fields list + field count
     */
    async postRunSummaryComment(
        jiraNumber: string,
        validation: TicketValidationResult,
        reporterAccountId?: string
    ): Promise<void> {
        const logContext = { jiraNumber, isComplete: validation.isComplete };
        logger.info(logContext, '[BC_INTAKE_SUMMARY_COMMENT_POST] Posting run summary comment');

        const content: any[] = [];

        if (validation.isComplete) {
            // Complete: simple one-liner
            content.push({
                type: 'paragraph',
                content: [
                    {
                        type: 'text',
                        text: `BC-INTAKE Ran with Result of ${validation.completedCount}/${validation.totalFields} fields filled`,
                        marks: [{ type: 'strong' }],
                    },
                ],
            });
        } else {
            // Incomplete: @mention + missing fields + count
            if (reporterAccountId) {
                content.push({
                    type: 'paragraph',
                    content: [
                        { type: 'mention', attrs: { id: reporterAccountId } },
                        { type: 'text', text: ' — BC-INTAKE validation found missing fields.' },
                    ],
                });
            }

            content.push({
                type: 'paragraph',
                content: [
                    {
                        type: 'text',
                        text: `BC-INTAKE Ran with Result of ${validation.completedCount}/${validation.totalFields} fields filled`,
                        marks: [{ type: 'strong' }],
                    },
                ],
            });

            const missingList: any[] = validation.missingFields.map(field => ({
                type: 'listItem',
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            { type: 'text', text: field.field, marks: [{ type: 'strong' }] },
                            { type: 'text', text: ` — ${field.reason || 'Missing from form'}` },
                        ],
                    },
                ],
            }));

            content.push(
                {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'Missing Fields:', marks: [{ type: 'strong' }] }],
                },
                { type: 'bulletList', content: missingList }
            );
        }

        const url = `${this.baseUrl}/rest/api/3/issue/${jiraNumber}/comment`;

        const response = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ body: { type: 'doc', version: 1, content } }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`JIRA postRunSummaryComment failed: ${response.status} ${errorText}`);
        }

        logger.info(logContext, '[BC_INTAKE_SUMMARY_COMMENT_SUCCESS] Run summary comment posted');
    }

    /**
     * Get reporter account ID for mentions
     */
    async getReporterAccountId(jiraNumber: string): Promise<string | undefined> {
        const issue = await this.getIssue(jiraNumber);
        return issue.fields?.reporter?.accountId;
    }

    /**
     * Get AI Note fields from issue
     */
    async getAINoteFields(jiraNumber: string): Promise<Record<string, string | null>> {
        const fieldIds = AI_NOTE_FIELDS.map(f => f.fieldId).join(',');
        const url = `${this.baseUrl}/rest/api/3/issue/${jiraNumber}?fields=${fieldIds}`;

        logger.debug({ jiraNumber }, '[BC_INTAKE_AI_NOTES_GET] Fetching AI Note fields');

        const response = await fetch(url, {
            headers: { 'Authorization': this.authHeader, 'Accept': 'application/json' },
        });

        if (!response.ok) {
            throw new Error(`JIRA getAINoteFields failed for ${jiraNumber}: ${response.status} ${response.statusText}`);
        }

        const issue = await response.json() as any;
        const noteFields: Record<string, string | null> = {};

        for (const noteField of AI_NOTE_FIELDS) {
            noteFields[noteField.fieldId] = issue.fields?.[noteField.fieldId] || null;
        }

        logger.info({
            jiraNumber,
            noteFields: Object.entries(noteFields).map(([id, value]) => ({ id, isEmpty: !value }))
        }, '[BC_INTAKE_AI_NOTES_GET_SUCCESS] AI Note fields fetched');

        return noteFields;
    }

    /**
     * Find first available (empty) AI Note field
     * Returns field ID and name, or null if all are filled
     */
    async findFirstAvailableAINote(jiraNumber: string): Promise<{ fieldId: string; name: string } | null> {
        const noteFields = await this.getAINoteFields(jiraNumber);

        for (const noteField of AI_NOTE_FIELDS) {
            const value = noteFields[noteField.fieldId];
            if (!value || value.trim().length === 0) {
                logger.info({
                    jiraNumber,
                    fieldId: noteField.fieldId,
                    fieldName: noteField.name
                }, '[BC_INTAKE_AI_NOTE_AVAILABLE] Found available AI Note field');
                return { fieldId: noteField.fieldId, name: noteField.name };
            }
        }

        logger.warn({ jiraNumber }, '[BC_INTAKE_AI_NOTE_FULL] All AI Note fields are filled');
        return null;
    }

    /**
     * Post validation result to AI Note field
     */
    async postToAINote(
        jiraNumber: string,
        fieldId: string,
        fieldName: string,
        validation: TicketValidationResult
    ): Promise<void> {
        const logContext = { jiraNumber, fieldId, fieldName, isComplete: validation.isComplete };

        logger.info(logContext, '[BC_INTAKE_AI_NOTE_POST] Posting validation to AI Note field');

        // Build text content for AI Note field
        const noteContent = this.buildValidationNoteText(validation);

        const url = `${this.baseUrl}/rest/api/3/issue/${jiraNumber}`;

        const body = {
            fields: {
                [fieldId]: noteContent,
            },
        };

        const response = await fetch(url, {
            method: 'PUT',
            headers: this.headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`JIRA postToAINote failed: ${response.status} ${errorText}`);
        }

        logger.info(logContext, '[BC_INTAKE_AI_NOTE_POST_SUCCESS] Validation posted to AI Note field');
    }

    /**
     * Build validation result as plain text for AI Note fields
     */
    private buildValidationNoteText(validation: TicketValidationResult): string {
        const status = validation.isComplete ? 'COMPLETE ✅' : 'INCOMPLETE ⚠️';
        const timestamp = new Date().toISOString();

        let text = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BC UPGRADE TICKET VALIDATION RESULTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Status: ${status}
${validation.isComplete ? 'All mandatory fields are filled in' : `Missing ${validation.missingFields.length} required field(s)`}

`;

        // For incomplete tickets, show missing fields first
        if (!validation.isComplete && validation.missingFields.length > 0) {
            text += `MISSING FIELDS (${validation.missingFields.length}):\n`;
            for (const field of validation.missingFields) {
                text += `  ❌ ${field.field} - ${field.reason || 'Missing from form'}\n`;
            }
            text += '\n';
        }

        // Show completed fields
        text += `COMPLETED FIELDS (${validation.completedCount}/${validation.totalFields}):\n`;
        for (const field of validation.completedFields) {
            text += `  ✅ ${field.field}\n`;
        }
        text += '\n';

        // Source document
        if (validation.sourceDocument) {
            text += `Validated from: ${validation.sourceDocument} (parsed automatically)\n\n`;
        }

        // Add instructions for incomplete tickets
        if (!validation.isComplete) {
            text += '⚠️  Please complete the missing fields and update the attached document.\n\n';
        }

        // Timestamp
        text += `Validated: ${timestamp}\n`;
        text += `Agent: BC-INTAKE\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

        return text;
    }
}
