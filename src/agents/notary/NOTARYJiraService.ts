/**
 * NOTARY Jira Service
 *
 * All Jira REST API calls for the NOTARY agent:
 * - Search tickets by JQL (release source)
 * - Fetch individual issues with ADF content
 * - Update customfield_10044 (Client Notes) — append AI draft
 * - Add / remove labels (reviewed_notes, draft_client_notes)
 *
 * Uses Basic auth (username:token) identical to BCATJiraService pattern.
 */

import { createLogger } from '../../utils/logger.js';
import type { TicketRecord } from './types.js';

const logger = createLogger('notary-jira-service');

/** JIRA custom field IDs */
const FIELD_CLIENT_NOTES   = 'customfield_10044';
const FIELD_RELEASE_SOURCE = 'customfield_10054';

/** Labels used by NOTARY */
export const LABEL_REVIEWED_NOTES   = 'reviewed_notes';
export const LABEL_DRAFT_NOTES      = 'draft_client_notes';

/** Issue types that do NOT receive client notes */
const SKIP_ISSUE_TYPES = new Set(['Story', 'Epic', 'Sub-task', 'Task']);

export class NOTARYJiraService {
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

    // ─── Search ──────────────────────────────────────────────────────────────

    /**
     * Fetch all MPDEV tickets for a release source version.
     * Paginates automatically via nextPageToken.
     */
    async fetchReleaseTickets(releaseVersion: string): Promise<TicketRecord[]> {
        const jql = `cf[10054] ~ "${releaseVersion}" AND project = MPDEV ORDER BY cf[10054] desc, priority DESC, created DESC`;
        const fields = [
            'summary', 'status', 'assignee', 'issuetype', 'priority',
            FIELD_RELEASE_SOURCE, FIELD_CLIENT_NOTES, 'labels', 'description',
        ];

        const tickets: TicketRecord[] = [];
        const maxResults = 50;
        let nextPageToken: string | undefined;

        logger.info({ releaseVersion, jql }, '[NOTARY_JIRA_SEARCH] Fetching release tickets');

        while (true) {
            // POST /rest/api/3/search/jql — new Atlassian endpoint
            // Paginates via nextPageToken (startAt is no longer accepted)
            const url = `${this.baseUrl}/rest/api/3/search/jql`;
            const requestBody: Record<string, unknown> = {
                jql,
                fields,
                maxResults,
            };
            if (nextPageToken) {
                requestBody.nextPageToken = nextPageToken;
            }

            const response = await fetch(url, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                const err = await response.text();
                throw new Error(`JIRA search failed [${response.status}]: ${err}`);
            }

            const data: any = await response.json();
            const issues: any[] = data.issues ?? [];

            for (const issue of issues) {
                tickets.push(this.mapIssueToRecord(issue));
            }

            logger.debug({
                releaseVersion,
                fetched: issues.length,
                totalSoFar: tickets.length,
                isLast: data.isLast,
            }, '[NOTARY_JIRA_PAGE] Page fetched');

            if (data.isLast || issues.length === 0) break;
            nextPageToken = data.nextPageToken;
            if (!nextPageToken) break;
        }

        logger.info({ releaseVersion, count: tickets.length }, '[NOTARY_JIRA_SEARCH_DONE] Tickets fetched');
        return tickets;
    }

    /**
     * Fetch a single issue with full ADF content for customfield_10044.
     * Used before appending a draft (to get current ADF document).
     */
    async getIssueAdf(jiraKey: string): Promise<any> {
        const url = `${this.baseUrl}/rest/api/3/issue/${jiraKey}?fields=${FIELD_CLIENT_NOTES},labels`;
        const response = await fetch(url, { headers: this.headers });

        if (!response.ok) {
            throw new Error(`JIRA getIssue failed [${response.status}] for ${jiraKey}`);
        }

        const data: any = await response.json();
        return data.fields?.[FIELD_CLIENT_NOTES] ?? null;
    }

    // ─── Write: Client Notes ──────────────────────────────────────────────────

    /**
     * Append an AI-generated draft to customfield_10044.
     *
     * Always appends — never overwrites.
     * Structure appended:
     *   <hr/>
     *   <bold+italic>AI-GENERATED DRAFT (pending review):</bold+italic>
     *   <paragraph> ... draft text ... </paragraph>
     */
    async appendAiDraft(jiraKey: string, draftText: string): Promise<void> {
        // Step 1: Read current ADF
        const currentAdf = await this.getIssueAdf(jiraKey);

        // Step 2: Build new content nodes to append
        const appendNodes = [
            { type: 'rule' },
            {
                type: 'paragraph',
                content: [{
                    type: 'text',
                    text: '***FOR INTERNAL USE ONLY*** AI-GENERATED DRAFT (pending review):',
                    marks: [{ type: 'strong' }, { type: 'em' }],
                }],
            },
            ...this.textToAdfParagraphs(draftText),
        ];

        // Step 3: Merge into existing document or create new one
        const existingContent: any[] = currentAdf?.content ?? [];
        const newDocument = {
            type: 'doc',
            version: 1,
            content: [...existingContent, ...appendNodes],
        };

        // Step 4: PUT update
        const url = `${this.baseUrl}/rest/api/3/issue/${jiraKey}`;
        const body = { fields: { [FIELD_CLIENT_NOTES]: newDocument } };

        const response = await fetch(url, {
            method: 'PUT',
            headers: this.headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`JIRA appendAiDraft failed [${response.status}] for ${jiraKey}: ${err}`);
        }

        logger.info({ jiraKey, draftLength: draftText.length }, '[NOTARY_JIRA_DRAFT_APPENDED] AI draft appended');
    }

    /**
     * Append AI-suggested corrected notes to customfield_10044.
     * Used when existing notes fail verification (Category E inaccurate).
     *
     * Structure appended:
     *   <hr/>
     *   <bold+italic>***FOR INTERNAL USE ONLY*** SUGGESTED NOTES BASED ON REVIEW AI-GENERATED DRAFT (pending review):</bold+italic>
     *   <paragraph> ... suggested notes text ... </paragraph>
     */
    async appendSuggestedNotes(jiraKey: string, suggestedText: string): Promise<void> {
        // Step 1: Read current ADF
        const currentAdf = await this.getIssueAdf(jiraKey);

        // Step 2: Build new content nodes to append
        const appendNodes = [
            { type: 'rule' },
            {
                type: 'paragraph',
                content: [{
                    type: 'text',
                    text: '***FOR INTERNAL USE ONLY*** SUGGESTED NOTES BASED ON REVIEW AI-GENERATED DRAFT (pending review):',
                    marks: [{ type: 'strong' }, { type: 'em' }],
                }],
            },
            ...this.textToAdfParagraphs(suggestedText),
        ];

        // Step 3: Merge into existing document or create new one
        const existingContent: any[] = currentAdf?.content ?? [];
        const newDocument = {
            type: 'doc',
            version: 1,
            content: [...existingContent, ...appendNodes],
        };

        // Step 4: PUT update
        const url = `${this.baseUrl}/rest/api/3/issue/${jiraKey}`;
        const body = { fields: { [FIELD_CLIENT_NOTES]: newDocument } };

        const response = await fetch(url, {
            method: 'PUT',
            headers: this.headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`JIRA appendSuggestedNotes failed [${response.status}] for ${jiraKey}: ${err}`);
        }

        logger.info({ jiraKey, suggestedLength: suggestedText.length }, '[NOTARY_JIRA_SUGGESTED_APPENDED] Suggested notes appended');
    }

    // ─── Write: Labels ────────────────────────────────────────────────────────

    /**
     * Add a label to a ticket using the update/add pattern (non-destructive).
     */
    async addLabel(jiraKey: string, label: string): Promise<void> {
        const url = `${this.baseUrl}/rest/api/3/issue/${jiraKey}`;
        const body = { update: { labels: [{ add: label }] } };

        const response = await fetch(url, {
            method: 'PUT',
            headers: this.headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(`JIRA addLabel failed [${response.status}] for ${jiraKey} label=${label}: ${err}`);
        }

        logger.info({ jiraKey, label }, '[NOTARY_JIRA_LABEL_ADDED] Label added');
    }

    /**
     * Remove a label from a ticket.
     */
    async removeLabel(jiraKey: string, label: string): Promise<void> {
        const url = `${this.baseUrl}/rest/api/3/issue/${jiraKey}`;
        const body = { update: { labels: [{ remove: label }] } };

        const response = await fetch(url, {
            method: 'PUT',
            headers: this.headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const err = await response.text();
            logger.warn({ jiraKey, label, status: response.status, err }, '[NOTARY_JIRA_LABEL_REMOVE_WARN] Remove label failed');
        }
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /**
     * Convert plain text (with newlines) into ADF paragraph nodes.
     * Each non-empty line becomes its own paragraph for readability.
     */
    private textToAdfParagraphs(text: string): any[] {
        const lines = text.split('\n');
        const nodes: any[] = [];

        for (const line of lines) {
            if (line.trim() === '') {
                // Empty line → spacing paragraph
                nodes.push({ type: 'paragraph', content: [] });
            } else {
                nodes.push({
                    type: 'paragraph',
                    content: [{ type: 'text', text: line }],
                });
            }
        }

        return nodes.length > 0 ? nodes : [{ type: 'paragraph', content: [{ type: 'text', text: text }] }];
    }

    /**
     * Extract plain text from an ADF document node recursively.
     */
    extractAdfText(adf: any): string {
        if (!adf) return '';
        if (typeof adf === 'string') return adf;
        if (adf.type === 'text') return adf.text ?? '';

        const children: any[] = adf.content ?? [];
        return children.map((n: any) => this.extractAdfText(n)).join(' ').replace(/\s+/g, ' ').trim();
    }

    /**
     * Map a raw JIRA REST API issue object to a TicketRecord.
     */
    private mapIssueToRecord(issue: any): TicketRecord {
        const fields = issue.fields ?? {};
        const issueType: string = fields.issuetype?.name ?? 'Unknown';
        const clientNotesAdf = fields[FIELD_CLIENT_NOTES] ?? null;
        const clientNotesText = this.extractAdfText(clientNotesAdf);
        const labels: string[] = fields.labels ?? [];

        return {
            key: issue.key,
            summary: fields.summary ?? '',
            issueType,
            status: fields.status?.name ?? '',
            assignee: fields.assignee?.displayName ?? 'Unassigned',
            labels,
            clientNotesAdf,
            clientNotesText,
            description: this.extractAdfText(fields.description),
            classification: SKIP_ISSUE_TYPES.has(issueType) ? 'SKIPPED' : 'E', // Refined in NOTARYAgent
        };
    }

    /**
     * Whether an issue type should be skipped entirely.
     */
    static isSkippedIssueType(issueType: string): boolean {
        return SKIP_ISSUE_TYPES.has(issueType);
    }
}
