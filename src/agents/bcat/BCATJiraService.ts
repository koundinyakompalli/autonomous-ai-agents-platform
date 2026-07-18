import { createLogger } from '../../utils/logger.js';
import { bufferToBlobPart } from '../../utils/blob.js';

const logger = createLogger('bcat-jira-service');

export class BCATJiraService {
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

  async getIssue(jiraNumber: string, extraFields: string[] = []): Promise<any> {
    // GET /rest/api/3/issue/{issueIdOrKey}?fields=summary,description,attachment,labels
    const baseFields = 'summary,description,attachment,labels,project';
    const fields = extraFields.length > 0 ? `${baseFields},${extraFields.join(',')}` : baseFields;
    const url = `${this.baseUrl}/rest/api/3/issue/${jiraNumber}?fields=${fields}`;
    const response = await fetch(url, {
      headers: { 'Authorization': this.authHeader, 'Accept': 'application/json' }
    });
    if (!response.ok) {
      throw new Error(`JIRA getIssue failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  async downloadAttachment(attachmentUrl: string): Promise<Buffer> {
    // Download attachment content
    const response = await fetch(attachmentUrl, {
      headers: { 'Authorization': this.authHeader }
    });
    if (!response.ok) {
      throw new Error(`JIRA downloadAttachment failed: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  async createIssue(fields: {
    project: string;
    summary: string;
    description: string;
    issueType: string;
    priority?: string;
    labels?: string[];
    customFields?: Record<string, any>;
  }): Promise<{ key: string; id: string }> {
    // POST /rest/api/3/issue
    const body: any = {
      fields: {
        project: { key: fields.project },
        summary: fields.summary,
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: fields.description }]
            }
          ]
        },
        issuetype: { name: fields.issueType },
        ...(fields.priority && { priority: { name: fields.priority } }),
        ...(fields.labels && fields.labels.length > 0 && { labels: fields.labels }),
        ...(fields.customFields || {}),
      }
    };

    const url = `${this.baseUrl}/rest/api/3/issue`;
    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`JIRA createIssue failed: ${response.status} ${errorText}`);
    }
    return response.json() as Promise<{ key: string; id: string }>;
  }

  async attachFile(issueKey: string, filename: string, buffer: Buffer, mimeType: string = 'application/octet-stream'): Promise<void> {
    // POST /rest/api/3/issue/{issueIdOrKey}/attachments
    const url = `${this.baseUrl}/rest/api/3/issue/${issueKey}/attachments`;
    const formData = new FormData();
    formData.append('file', new Blob([bufferToBlobPart(buffer)], { type: mimeType }), filename);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': this.authHeader,
        'X-Atlassian-Token': 'no-check',
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`JIRA attachFile failed: ${response.status} ${errorText}`);
    }
  }

  async linkIssues(inwardIssueKey: string, outwardIssueKey: string, linkType: string = 'Relates'): Promise<void> {
    // POST /rest/api/3/issueLink
    const url = `${this.baseUrl}/rest/api/3/issueLink`;
    const body = {
      type: { name: linkType },
      inwardIssue: { key: inwardIssueKey },
      outwardIssue: { key: outwardIssueKey },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn({ inwardIssueKey, outwardIssueKey, status: response.status, error: errorText }, '[BCAT_LINK_WARN] Issue link failed');
    }
  }

  async addLabel(jiraNumber: string, label: string): Promise<void> {
    // GET existing labels first, then PUT with new label added
    const issue = await this.getIssue(jiraNumber);
    const existingLabels: string[] = issue.fields?.labels || [];
    if (existingLabels.includes(label)) return;

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
  }

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
      logger.warn({ jiraNumber, label, status: response.status, error: errorText }, '[BCAT_REMOVE_LABEL_WARN] Remove label failed');
    }
  }
}
