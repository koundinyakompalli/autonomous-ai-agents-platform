/**
 * VERITAS JIRA Service
 *
 * JIRA API calls for evidence collection:
 * - getIssue: fetch issue details
 * - getIssueWithComments: fetch issue + all comments
 * - getLinkedIssues: extract linked issue keys
 * - addLabel / removeLabel: manage VERITAS labels
 *
 * Uses Bearer token auth, same pattern as BCATJiraService.
 */

import { createLogger } from '../../utils/logger.js';
import type { TicketComment } from './types.js';

const logger = createLogger('veritas-jira-service');

export class VERITASJiraService {
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
     * Fetch a JIRA issue with core fields
     */
    async getIssue(jiraNumber: string): Promise<any> {
        const url = `${this.baseUrl}/rest/api/3/issue/${jiraNumber}?fields=summary,description,status,priority,issuetype,labels,created,resolutiondate,issuelinks,comment`;
        const response = await fetch(url, {
            headers: { 'Authorization': this.authHeader, 'Accept': 'application/json' },
        });
        if (!response.ok) {
            throw new Error(`JIRA getIssue failed for ${jiraNumber}: ${response.status} ${response.statusText}`);
        }
        return response.json();
    }

    /**
     * Fetch a JIRA issue with full details and all comments
     */
    async getIssueWithComments(jiraNumber: string): Promise<{
        key: string;
        summary: string;
        status: string;
        priority: string;
        issueType: string;
        created: string;
        resolved: string | null;
        description: string;
        labels: string[];
        comments: TicketComment[];
        linkedIssueKeys: string[];
    }> {
        const issue = await this.getIssue(jiraNumber);
        const fields = issue.fields;

        // Extract description as plain text from ADF
        const description = this.extractTextFromAdf(fields.description);

        // Extract comments
        const comments: TicketComment[] = (fields.comment?.comments || []).map((c: any) => ({
            id: c.id,
            author: c.author?.displayName || c.author?.emailAddress || 'Unknown',
            created: c.created,
            body: this.extractTextFromAdf(c.body),
        }));

        // Extract linked issue keys
        const linkedIssueKeys = this.extractLinkedIssueKeys(fields.issuelinks || []);

        return {
            key: issue.key,
            summary: fields.summary || '',
            status: fields.status?.name || 'Unknown',
            priority: fields.priority?.name || 'Unknown',
            issueType: fields.issuetype?.name || 'Unknown',
            created: fields.created || '',
            resolved: fields.resolutiondate || null,
            description,
            labels: fields.labels || [],
            comments,
            linkedIssueKeys,
        };
    }

    /**
     * Extract linked issue keys from issuelinks field
     */
    private extractLinkedIssueKeys(issuelinks: any[]): string[] {
        const keys: string[] = [];
        for (const link of issuelinks) {
            if (link.inwardIssue?.key) {
                keys.push(link.inwardIssue.key);
            }
            if (link.outwardIssue?.key) {
                keys.push(link.outwardIssue.key);
            }
        }
        return [...new Set(keys)]; // deduplicate
    }

    /**
     * Extract the link type description for a linked issue
     */
    getLinkTypeForKey(issuelinks: any[], targetKey: string): string {
        for (const link of issuelinks) {
            if (link.inwardIssue?.key === targetKey) {
                return link.type?.inward || 'related to';
            }
            if (link.outwardIssue?.key === targetKey) {
                return link.type?.outward || 'related to';
            }
        }
        return 'related to';
    }

    /**
     * Add a label to a JIRA issue
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

        logger.info({ jiraNumber, label }, '[VERITAS_LABEL_ADD] Label added');
    }

    /**
     * Remove a label from a JIRA issue
     */
    async removeLabel(jiraNumber: string, label: string): Promise<void> {
        const url = `${this.baseUrl}/rest/api/3/issue/${jiraNumber}`;
        const body = { update: { labels: [{ remove: label }] } };

        const response = await fetch(url, {
            method: 'PUT',
            headers: this.headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.warn({ jiraNumber, label, status: response.status, error: errorText }, '[VERITAS_LABEL_REMOVE_WARN] Remove label failed');
        } else {
            logger.info({ jiraNumber, label }, '[VERITAS_LABEL_REMOVE] Label removed');
        }
    }

    /**
     * Extract plain text from Atlassian Document Format (ADF)
     * Recursively walks the ADF tree and extracts text nodes.
     */
    private extractTextFromAdf(adf: any): string {
        if (!adf) return '';
        if (typeof adf === 'string') return adf;

        const parts: string[] = [];

        if (adf.type === 'text') {
            return adf.text || '';
        }

        if (adf.content && Array.isArray(adf.content)) {
            for (const node of adf.content) {
                const text = this.extractTextFromAdf(node);
                if (text) parts.push(text);
            }
        }

        // Add newlines between paragraphs and headings
        if (adf.type === 'paragraph' || adf.type === 'heading') {
            return parts.join('') + '\n';
        }

        // List items
        if (adf.type === 'listItem') {
            return '- ' + parts.join('') + '\n';
        }

        // Code blocks
        if (adf.type === 'codeBlock') {
            return '```\n' + parts.join('') + '\n```\n';
        }

        return parts.join('');
    }
}
