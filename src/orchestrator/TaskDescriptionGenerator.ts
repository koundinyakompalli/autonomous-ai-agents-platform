/**
 * TaskDescriptionGenerator
 *
 * Uses LLM to convert JIRA tickets into structured task descriptions
 * with full context from description (ADF), comments, and attachments.
 *
 * This enhanced version:
 * 1. Fetches comprehensive JIRA data via REST API v3
 * 2. Converts ADF (Atlassian Document Format) to Markdown
 * 3. Downloads and includes text-based attachments
 * 4. Fetches all comments with pagination
 * 5. Uses LLM to synthesize a structured task description
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { createLogger } from '../utils/logger.js';
import {
  JiraClient,
  createJiraClient,
  adfToMarkdown,
  type JiraTicketData,
  type JiraIssue,
  type JiraAttachment,
  type TextAttachment,
  type ImageAttachment,
  type DocxAttachmentEvidence,
} from './JiraClient.js';
import {
  TICKET_EVIDENCE_SCHEMA_VERSION,
  buildTicketEvidenceStats,
  type TicketEvidenceAttachment,
  type TicketEvidenceV1,
} from '../oneshot/ticket-evidence.js';

const logger = createLogger('orchestrator');

// =============================================================================
// Types
// =============================================================================

/** Basic JIRA issue interface (for backwards compatibility) */
interface BasicJiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: string | any; // Can be string (old) or ADF (new)
    status: { name: string };
    priority?: { name: string };
    labels?: string[];
    assignee?: { displayName: string };
    reporter?: { displayName: string };
    created: string;
    updated: string;
    [key: string]: any;
  };
}

/** Configuration for task generation */
export interface TaskDescriptionConfig {
  /** JIRA base URL */
  jiraBaseUrl?: string;
  /** JIRA username (email) */
  jiraUsername?: string;
  /** JIRA API token (can be overridden per-agent) */
  jiraToken?: string;
  /** Max bytes to download for text attachments */
  maxAttachmentBytes?: number;
  /** Max number of comments to include (default: 50) */
  maxComments?: number;
  /** Max number of text attachments to include (default: 10) */
  maxTextAttachments?: number;
  /** Max total prompt size in characters before truncation (default: 100KB) */
  maxPromptChars?: number;
  /** Bedrock model to use */
  bedrockModel?: string;
  /** AWS region */
  awsRegion?: string;
}

export interface TaskPayload {
  taskDescription: string;
  ticketEvidence: TicketEvidenceV1;
}

interface TaskDescriptionGenerationResult {
  taskDescription: string;
  reviewedImageAttachmentIds: Set<string>;
  reviewedImageAttachmentFilenames: Set<string>;
  multimodalReviewSucceeded: boolean;
}

// =============================================================================
// Prompts
// =============================================================================

const TASK_DESCRIPTION_PROMPT_ENHANCED = `You are an expert task description specialist. Your job is to convert JIRA tickets with ALL their context into clear, comprehensive, actionable task descriptions for AI agents.

IMPORTANT: You have access to the COMPLETE ticket context:
- Full description (converted from Jira's rich text format)
- ALL comments from the discussion thread
- Attachment metadata and downloaded text file contents
- Issue links, subtasks, and relationships

Your goal: Create a thorough task description that captures EVERYTHING an AI agent needs to solve this problem without needing to access JIRA directly.

## Output Format (Markdown)

# Task: [JIRA-KEY] [Summary]

## Executive Summary
[2-3 sentence overview of what needs to be accomplished]

## Problem Statement
[Detailed description of the issue/request from the ticket description]

## Key Context from Discussion
[Important insights, clarifications, or updates from comments]

## Requirements & Constraints
- [Bullet point list of explicit and implicit requirements]
- [Include any constraints mentioned in comments]

## Relevant Files & Data
[List any files mentioned in attachments or description]

## Expected Outcome
[Clear description of what the solution should look like]

## Open Questions
[Any ambiguities or missing information that may need clarification]

---
**Source**: [JIRA-KEY] | **Priority**: [Priority] | **Status**: [Status]
**Reporter**: [Reporter] | **Assignee**: [Assignee]
**Last Updated**: [Updated Date]

---

## Rules:
1. Extract ALL relevant information - do not summarize away important details
2. If the ticket is ambiguous, explicitly note what is unclear
3. Include specific file names, class names, error messages mentioned anywhere
4. Preserve code snippets and stack traces in code blocks
5. Note any suggested solutions or workarounds from comments
6. Flag any conflicting information between description and comments
7. Do NOT invent facts - only use what's provided
8. Clearly list which attachments had reviewed content and which attachments were skipped, unsupported, too large, or extraction-failed
9. Treat unsupported or failed attachment extraction as an evidence gap, not as proof that the ticket is not actionable`;

const TASK_DESCRIPTION_PROMPT_SIMPLE = `You are a task description specialist. Convert JIRA tickets into concise, structured task descriptions for AI agents.

Your goal: Create a clear, actionable task description that an AI agent can use to solve the problem.

Input: JIRA ticket JSON
Output: Structured markdown task description

Format:
# Task: [JIRA-KEY] [Summary]

## Objective
[Clear statement of what needs to be accomplished]

## Context
[Relevant background information from the ticket]

## Details
[Key details, requirements, or constraints]

## Expected Outcome
[What the agent should produce]

---
JIRA: [Key] | Priority: [Priority] | Status: [Status]`;

// =============================================================================
// TaskDescriptionGenerator Class
// =============================================================================

export class TaskDescriptionGenerator {
  private bedrockClient: BedrockRuntimeClient;
  private model: string;
  private config: TaskDescriptionConfig;

  constructor(config?: TaskDescriptionConfig) {
    this.config = {
      awsRegion: process.env.AWS_REGION || 'us-east-1',
      bedrockModel: process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      jiraBaseUrl: process.env.JIRA_BASE_URL,
      jiraUsername: process.env.JIRA_USERNAME,
      jiraToken: process.env.JIRA_TOKEN,
      maxAttachmentBytes: 200_000,
      maxComments: 50,           // Limit comments to prevent prompt explosion
      maxTextAttachments: 10,    // Limit text files to include
      maxPromptChars: 800_000,   // ~800KB text (~200K tokens input limit for Claude)
      ...config,
    };

    this.bedrockClient = new BedrockRuntimeClient({
      region: this.config.awsRegion,
    });
    this.model = this.config.bedrockModel!;
  }

  // ===========================================================================
  // Enhanced Generation (Full JIRA Data)
  // ===========================================================================

  /**
   * Generate comprehensive task description from JIRA ticket key
   * Fetches all data: description (ADF), comments, attachments
   *
   * @param issueKey - JIRA issue key (e.g., "PROJ-123")
   * @param jiraToken - Optional agent-specific JIRA token
   * @returns Structured markdown task description
   */
  async generateFromTicketKey(
    issueKey: string,
    jiraToken?: string
  ): Promise<string> {
    const payload = await this.generateTaskDataFromTicketKey(
      issueKey,
      jiraToken,
      false,
    );
    return payload.taskDescription;
  }

  async generateTaskPayloadFromTicketKey(
    issueKey: string,
    jiraToken?: string,
  ): Promise<TaskPayload> {
    const payload = await this.generateTaskDataFromTicketKey(
      issueKey,
      jiraToken,
      true,
    );
    if (!payload.ticketEvidence) {
      throw new Error(`Ticket evidence was not generated for ${issueKey}`);
    }
    return {
      taskDescription: payload.taskDescription,
      ticketEvidence: payload.ticketEvidence,
    };
  }

  private async generateTaskDataFromTicketKey(
    issueKey: string,
    jiraToken: string | undefined,
    includeTicketEvidence: boolean,
  ): Promise<{ taskDescription: string; ticketEvidence?: TicketEvidenceV1 }> {
    logger.info({ jira: issueKey }, 'Generating enhanced task description');

    // Validate JIRA config
    if (!this.config.jiraBaseUrl || !this.config.jiraUsername) {
      throw new Error('JIRA configuration missing: jiraBaseUrl and jiraUsername required');
    }

    // Create JIRA client with agent-specific token or global token
    const jiraClient = createJiraClient({
      baseUrl: this.config.jiraBaseUrl,
      username: this.config.jiraUsername,
      token: jiraToken || this.config.jiraToken!,
      maxAttachmentBytes: this.config.maxAttachmentBytes,
    });

    try {
      // Fetch comprehensive ticket data
      const ticketData = await jiraClient.fetchTicketData(issueKey);

      logger.info({
        jira: issueKey,
        descriptionLength: ticketData.descriptionMarkdown.length,
        commentCount: ticketData.comments.length,
        attachmentCount: ticketData.attachments.length,
        textAttachmentCount: ticketData.textAttachments.length,
        imageAttachmentCount: ticketData.imageAttachments.length,
      }, 'Fetched comprehensive JIRA data');

      const generation = await this.generateTaskDescriptionFromTicketData(ticketData);
      const response = generation.taskDescription;

      // Append SQL attachments verbatim so downstream agents (e.g. SENTRY)
      // always receive the raw SQL regardless of how the LLM summarized it.
      const sqlAttachments = ticketData.textAttachments.filter(t =>
        t.filename.toLowerCase().endsWith('.sql')
      );

      let finalDescription = sqlAttachments.length > 0
        ? this.appendSqlAttachments(response, sqlAttachments)
        : response;

      // Append SQL found inline in comment bodies verbatim. Comment SQL goes
      // through LLM summarisation and may be paraphrased or dropped entirely.
      finalDescription = this.appendSqlFromComments(finalDescription, ticketData.comments);

      const sqlCommentCount = this.extractSqlBlocks(ticketData.comments).length;

      const docxAttachments =
        includeTicketEvidence &&
        typeof jiraClient.fetchDocxAttachmentEvidence === 'function'
          ? await jiraClient
              .fetchDocxAttachmentEvidence(ticketData.attachments)
              .catch((error) => {
                logger.warn(
                  {
                    jira: issueKey,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  'DOCX evidence extraction failed; continuing with metadata gaps',
                );
                return [] as DocxAttachmentEvidence[];
              })
          : [];

      if (includeTicketEvidence) {
        finalDescription = this.appendAttachmentReviewReference(
          finalDescription,
          ticketData,
          docxAttachments,
          generation,
        );
      }

      logger.info({
        jira: issueKey,
        responseLength: finalDescription.length,
        imagesSent: ticketData.imageAttachments.length,
        sqlAttachmentsAppended: sqlAttachments.length,
        sqlCommentBlocksAppended: sqlCommentCount,
        imageAttachmentsReviewed: generation.reviewedImageAttachmentIds.size,
        docxAttachmentsReviewed: docxAttachments.filter(
          (attachment) => attachment.extractionStatus === 'included',
        ).length,
      }, 'Enhanced task description generated');

      return includeTicketEvidence
        ? {
            taskDescription: finalDescription,
            ticketEvidence: this.buildTicketEvidence(
              ticketData,
              docxAttachments,
            ),
          }
        : { taskDescription: finalDescription };
    } catch (error) {
      logger.error({
        jira: issueKey,
        error: error instanceof Error ? error.message : String(error),
      }, 'Failed to generate enhanced task description');
      throw error;
    }
  }

  private async generateTaskDescriptionFromTicketData(
    ticketData: JiraTicketData,
  ): Promise<TaskDescriptionGenerationResult> {
    if (ticketData.imageAttachments.length > 0) {
      const content = this.buildMultimodalContent(ticketData);

      try {
        const reviewedImages = ticketData.imageAttachments.slice(0, 10);
        return {
          taskDescription: await this.callBedrockMultimodal(content),
          reviewedImageAttachmentIds: new Set(
            reviewedImages
              .map((attachment) => attachment.id)
              .filter((id): id is string => Boolean(id)),
          ),
          reviewedImageAttachmentFilenames: new Set(
            reviewedImages.map((attachment) => attachment.filename),
          ),
          multimodalReviewSucceeded: true,
        };
      } catch (error) {
        logger.warn({
          jira: ticketData.issue.key,
          imageAttachmentCount: ticketData.imageAttachments.length,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : 'Unknown',
        }, 'Bedrock multimodal generation failed, falling back to text-only prompt');

        return {
          taskDescription: await this.callBedrock(this.buildEnhancedPrompt(ticketData)),
          reviewedImageAttachmentIds: new Set(),
          reviewedImageAttachmentFilenames: new Set(),
          multimodalReviewSucceeded: false,
        };
      }
    }

    return {
      taskDescription: await this.callBedrock(this.buildEnhancedPrompt(ticketData)),
      reviewedImageAttachmentIds: new Set(),
      reviewedImageAttachmentFilenames: new Set(),
      multimodalReviewSucceeded: false,
    };
  }

  private buildTicketEvidence(
    data: JiraTicketData,
    docxAttachments: DocxAttachmentEvidence[],
  ): TicketEvidenceV1 {
    const { issue } = data;
    const textById = new Map(
      data.textAttachments
        .filter((attachment) => attachment.id)
        .map((attachment) => [attachment.id!, attachment]),
    );
    const textByFilename = new Map(
      data.textAttachments.map((attachment) => [attachment.filename, attachment]),
    );
    const imageById = new Map(
      data.imageAttachments
        .filter((attachment) => attachment.id)
        .map((attachment) => [attachment.id!, attachment]),
    );
    const imageByFilename = new Map(
      data.imageAttachments.map((attachment) => [attachment.filename, attachment]),
    );
    const docxById = new Map(
      docxAttachments
        .filter((attachment) => attachment.id)
        .map((attachment) => [attachment.id!, attachment]),
    );
    const docxByFilename = new Map(
      docxAttachments.map((attachment) => [attachment.filename, attachment]),
    );
    const warnings: string[] = [];

    const links = (issue.fields.issuelinks ?? [])
      .map((link) => {
        if (link.inwardIssue) {
          return `${link.type?.inward ?? 'inward'}: ${link.inwardIssue.key} - ${link.inwardIssue.fields?.summary ?? ''}`.trim();
        }
        if (link.outwardIssue) {
          return `${link.type?.outward ?? 'outward'}: ${link.outwardIssue.key} - ${link.outwardIssue.fields?.summary ?? ''}`.trim();
        }
        return null;
      })
      .filter((link): link is string => Boolean(link));

    const attachments = data.attachments.map<TicketEvidenceAttachment>((attachment) => {
      const text = attachment.id
        ? textById.get(attachment.id)
        : textByFilename.get(attachment.filename);
      if (text) {
        return {
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
          created: attachment.created,
          author: attachment.author?.displayName,
          extractionStatus: 'included',
          extractedText: text.content,
        };
      }

      const docx = attachment.id
        ? docxById.get(attachment.id)
        : docxByFilename.get(attachment.filename);
      if (docx?.extractionStatus === 'included') {
        if (docx.warning) {
          warnings.push(`${attachment.filename}: ${docx.warning}`);
        }
        return {
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
          created: attachment.created,
          author: attachment.author?.displayName,
          extractionStatus: 'included',
          extractedText: docx.content ?? '',
          warning: docx.warning,
        };
      }
      if (docx?.extractionStatus === 'failed') {
        const warning = docx.warning ?? 'DOCX extraction failed';
        warnings.push(`${attachment.filename}: ${warning}`);
        return {
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
          created: attachment.created,
          author: attachment.author?.displayName,
          extractionStatus: 'failed',
          warning,
        };
      }

      const image = attachment.id
        ? imageById.get(attachment.id)
        : imageByFilename.get(attachment.filename);
      if (image) {
        return {
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType ?? image.mimeType,
          size: attachment.size ?? image.originalSize,
          created: attachment.created,
          author: attachment.author?.displayName,
          extractionStatus: 'included',
          imageDigest:
            `Image ${attachment.filename} (${image.mimeType}, ${image.originalSize} bytes) ` +
            'was included in the QUALIFIER multimodal task-summary pass; use the generated task summary and Jira original for visual details.',
        };
      }

      const warning = 'Unsupported or skipped attachment; metadata only.';
      warnings.push(`${attachment.filename}: ${warning}`);
      return {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        created: attachment.created,
        author: attachment.author?.displayName,
        extractionStatus: 'metadata_only',
        warning,
      };
    });

    const evidenceWithoutStats = {
      schemaVersion: TICKET_EVIDENCE_SCHEMA_VERSION,
      jiraKey: issue.key,
      capturedAt: new Date().toISOString(),
      issue: {
        summary: issue.fields.summary,
        issueType: issue.fields.issuetype?.name,
        status: issue.fields.status?.name,
        priority: issue.fields.priority?.name,
        resolution: issue.fields.resolution?.name,
        labels: issue.fields.labels ?? [],
        components: (issue.fields.components ?? [])
          .map((component) => component.name)
          .filter((name): name is string => Boolean(name)),
        fixVersions: (issue.fields.fixVersions ?? [])
          .map((version) => version.name)
          .filter((name): name is string => Boolean(name)),
        reporter: issue.fields.reporter?.displayName,
        assignee: issue.fields.assignee?.displayName,
        created: issue.fields.created,
        updated: issue.fields.updated,
        parent: issue.fields.parent
          ? {
              key: issue.fields.parent.key,
              summary: issue.fields.parent.fields?.summary,
            }
          : undefined,
        subtasks: (issue.fields.subtasks ?? []).map((subtask) => ({
          key: subtask.key,
          summary: subtask.fields?.summary,
          status: subtask.fields?.status?.name,
        })),
        links,
      },
      descriptionMarkdown: data.descriptionMarkdown,
      comments: data.comments,
      attachments,
      warnings,
    };

    return {
      ...evidenceWithoutStats,
      stats: buildTicketEvidenceStats(evidenceWithoutStats),
    };
  }

  /**
   * Append SQL file contents verbatim to the generated task description.
   *
   * The LLM may paraphrase or omit SQL from its summary. Appending the raw
   * SQL guarantees that SENTRY (and any other downstream agent) sees the
   * exact statements even when the ticket description contains no inline SQL.
   */
  private appendSqlAttachments(description: string, sqlAttachments: TextAttachment[]): string {
    const blocks = sqlAttachments.map(t =>
      `#### ${t.filename}\n\`\`\`sql\n${t.content}\n\`\`\``
    ).join('\n\n');

    return `${description}\n\n---\n\n## SQL Attachments (${sqlAttachments.length} file${sqlAttachments.length !== 1 ? 's' : ''})\n\n${blocks}`;
  }

  /**
   * Extract SQL code blocks from comment bodies and append verbatim.
   *
   * Comment bodies go through LLM summarisation and SQL inside them can be
   * paraphrased or dropped. This method finds any code block in a comment
   * that contains SQL keywords and appends it with author/date attribution
   * so downstream agents always see the original SQL.
   */
  private appendSqlFromComments(
    description: string,
    comments: Array<{ author?: string; created: string; bodyMarkdown: string }>
  ): string {
    const blocks = this.extractSqlBlocks(comments);
    if (blocks.length === 0) return description;

    const sections = blocks.map(b =>
      `#### Comment by ${b.author} (${b.created})\n\`\`\`sql\n${b.sql}\n\`\`\``
    ).join('\n\n');

    return `${description}\n\n---\n\n## SQL from Comments (${blocks.length} block${blocks.length !== 1 ? 's' : ''})\n\n${sections}`;
  }

  private appendAttachmentReviewReference(
    description: string,
    data: JiraTicketData,
    docxAttachments: DocxAttachmentEvidence[],
    generation: TaskDescriptionGenerationResult,
  ): string {
    const reference = this.buildAttachmentReviewReference(
      data,
      docxAttachments,
      generation,
    );
    return reference ? `${description}\n\n---\n\n${reference}` : description;
  }

  private buildAttachmentReviewReference(
    data: JiraTicketData,
    docxAttachments: DocxAttachmentEvidence[],
    generation: TaskDescriptionGenerationResult,
  ): string {
    if (data.attachments.length === 0) {
      return '';
    }

    const textById = new Map(
      data.textAttachments
        .filter((attachment) => attachment.id)
        .map((attachment) => [attachment.id!, attachment]),
    );
    const textByFilename = new Map(
      data.textAttachments.map((attachment) => [attachment.filename, attachment]),
    );
    const imageById = new Map(
      data.imageAttachments
        .filter((attachment) => attachment.id)
        .map((attachment) => [attachment.id!, attachment]),
    );
    const imageByFilename = new Map(
      data.imageAttachments.map((attachment) => [attachment.filename, attachment]),
    );
    const docxById = new Map(
      docxAttachments
        .filter((attachment) => attachment.id)
        .map((attachment) => [attachment.id!, attachment]),
    );
    const docxByFilename = new Map(
      docxAttachments.map((attachment) => [attachment.filename, attachment]),
    );

    const reviewed: string[] = [];
    const notReviewed: string[] = [];

    for (const attachment of data.attachments) {
      const text = attachment.id
        ? textById.get(attachment.id)
        : textByFilename.get(attachment.filename);
      if (text) {
        reviewed.push(
          this.formatAttachmentReviewBullet(
            attachment,
            `text content downloaded and included (${text.size} chars)`,
          ),
        );
        continue;
      }

      const docx = attachment.id
        ? docxById.get(attachment.id)
        : docxByFilename.get(attachment.filename);
      if (docx?.extractionStatus === 'included') {
        reviewed.push(
          this.formatAttachmentReviewBullet(
            attachment,
            `DOCX text extracted and included in ticket evidence (${docx.size} chars)`,
          ),
        );
        continue;
      }
      if (docx?.extractionStatus === 'failed') {
        notReviewed.push(
          this.formatAttachmentReviewBullet(
            attachment,
            docx.warning ?? 'DOCX extraction failed',
          ),
        );
        continue;
      }

      const image = attachment.id
        ? imageById.get(attachment.id)
        : imageByFilename.get(attachment.filename);
      const imageReviewed =
        attachment.id
          ? generation.reviewedImageAttachmentIds.has(attachment.id)
          : generation.reviewedImageAttachmentFilenames.has(attachment.filename);
      if (image && imageReviewed) {
        reviewed.push(
          this.formatAttachmentReviewBullet(
            attachment,
            `image sent to multimodal task-summary pass (${image.originalSize} bytes)`,
          ),
        );
        continue;
      }
      if (image) {
        notReviewed.push(
          this.formatAttachmentReviewBullet(
            attachment,
            generation.multimodalReviewSucceeded
              ? 'image was downloaded but omitted from multimodal review due to image limit; metadata only'
              : 'image was downloaded but multimodal review was unavailable; metadata only',
          ),
        );
        continue;
      }

      notReviewed.push(
        this.formatAttachmentReviewBullet(
          attachment,
          this.attachmentNotReviewedReason(attachment),
        ),
      );
    }

    const reviewedBody =
      reviewed.length > 0 ? reviewed.join('\n') : '- None';
    const notReviewedBody =
      notReviewed.length > 0 ? notReviewed.join('\n') : '- None';

    return [
      '## Attachment Review Reference',
      '',
      'Supported attachment content reviewed by intake is listed below. Files in "Not Reviewed / Metadata Only" were preserved as evidence gaps and should not be treated as automatic blockers.',
      '',
      '### Reviewed Attachments',
      reviewedBody,
      '',
      '### Not Reviewed / Metadata Only',
      notReviewedBody,
    ].join('\n');
  }

  private formatAttachmentReviewBullet(
    attachment: JiraAttachment,
    reason: string,
  ): string {
    const size =
      typeof attachment.size === 'number' ? `${attachment.size} bytes` : 'size unknown';
    return `- \`${attachment.filename}\` (${attachment.mimeType ?? 'unknown'}, ${size}): ${reason}`;
  }

  private attachmentNotReviewedReason(attachment: JiraAttachment): string {
    const filename = attachment.filename.toLowerCase();
    if (
      filename.endsWith('.xls') ||
      filename.endsWith('.xlsx') ||
      filename.endsWith('.xlsm') ||
      filename.endsWith('.xlsb')
    ) {
      return 'unsupported spreadsheet attachment; metadata only';
    }
    if (filename.endsWith('.doc')) {
      return 'unsupported legacy Word attachment; DOCX is supported but DOC is metadata only';
    }
    if (!attachment.content) {
      return 'attachment has no download URL; metadata only';
    }
    return 'unsupported or skipped attachment; metadata only';
  }

  /**
   * Extract SQL code blocks from an array of comment bodies.
   * Matches ```sql ... ``` and plain ``` ... ``` blocks whose content
   * starts with a SQL keyword (SELECT, INSERT, UPDATE, DELETE, CREATE,
   * ALTER, DROP, WITH, CALL, TRUNCATE).
   */
  private extractSqlBlocks(
    comments: Array<{ author?: string; created: string; bodyMarkdown: string }>
  ): Array<{ author: string; created: string; sql: string }> {
    const SQL_KEYWORDS = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|CALL|TRUNCATE)\b/im;
    // Matches ```sql ... ``` or ``` ... ``` (non-greedy, handles multiline)
    const CODE_BLOCK = /```(?:sql)?\s*\n([\s\S]*?)```/gi;

    const results: Array<{ author: string; created: string; sql: string }> = [];

    for (const comment of comments) {
      const author = comment.author ?? 'Unknown';
      let match: RegExpExecArray | null;

      CODE_BLOCK.lastIndex = 0;
      while ((match = CODE_BLOCK.exec(comment.bodyMarkdown)) !== null) {
        const content = match[1].trim();
        if (content && SQL_KEYWORDS.test(content)) {
          results.push({ author, created: comment.created, sql: content });
        }
      }
    }

    return results;
  }

  /**
   * Build comprehensive prompt from JIRA ticket data
   */
  private buildEnhancedPrompt(data: JiraTicketData): string {
    const { issue, descriptionMarkdown, comments, attachments, textAttachments } = data;

    // Apply limits to prevent prompt explosion
    const maxComments = this.config.maxComments ?? 50;
    const maxTextAttachments = this.config.maxTextAttachments ?? 10;
    const maxPromptChars = this.config.maxPromptChars ?? 150_000;

    // Limit comments (take most recent)
    const limitedComments = comments.length > maxComments
      ? comments.slice(-maxComments)  // Take last N (most recent)
      : comments;
    const commentsOmitted = comments.length - limitedComments.length;

    // Limit text attachments
    const limitedTextAttachments = textAttachments.slice(0, maxTextAttachments);
    const textAttachmentsOmitted = textAttachments.length - limitedTextAttachments.length;

    if (commentsOmitted > 0 || textAttachmentsOmitted > 0) {
      logger.warn({
        jira: issue.key,
        totalComments: comments.length,
        includedComments: limitedComments.length,
        commentsOmitted,
        totalTextAttachments: textAttachments.length,
        includedTextAttachments: limitedTextAttachments.length,
        textAttachmentsOmitted,
      }, 'Content truncated due to size limits');
    }

    // Format attachment metadata for context
    const attachmentSummary = attachments.map(a => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      created: a.created,
      author: a.author?.displayName,
      hasContent: textAttachments.some(t => t.filename === a.filename),
    }));

    // Format issue links
    const issueLinks = (issue.fields.issuelinks ?? []).map(link => {
      if (link.inwardIssue) {
        return `- ${link.type?.inward}: ${link.inwardIssue.key} - ${link.inwardIssue.fields?.summary}`;
      }
      if (link.outwardIssue) {
        return `- ${link.type?.outward}: ${link.outwardIssue.key} - ${link.outwardIssue.fields?.summary}`;
      }
      return null;
    }).filter(Boolean);

    // Format subtasks
    const subtasks = (issue.fields.subtasks ?? []).map(s =>
      `- [${s.fields?.status?.name}] ${s.key}: ${s.fields?.summary}`
    );

    // Format components
    const components = (issue.fields.components ?? []).map(c => c.name).filter(Boolean);

    // Format fix versions
    const fixVersions = (issue.fields.fixVersions ?? []).map(v => v.name).filter(Boolean);

    const prompt = `${TASK_DESCRIPTION_PROMPT_ENHANCED}

---

## JIRA TICKET DATA

### Metadata
- **Key**: ${issue.key}
- **Summary**: ${issue.fields.summary ?? ''}
- **Type**: ${issue.fields.issuetype?.name ?? ''}
- **Status**: ${issue.fields.status?.name ?? ''} (${issue.fields.status?.statusCategory?.name ?? ''})
- **Priority**: ${issue.fields.priority?.name ?? 'Unknown'}
- **Resolution**: ${issue.fields.resolution?.name ?? 'Unresolved'}
- **Reporter**: ${issue.fields.reporter?.displayName ?? 'Unknown'}
- **Assignee**: ${issue.fields.assignee?.displayName ?? 'Unassigned'}
- **Created**: ${issue.fields.created ?? ''}
- **Updated**: ${issue.fields.updated ?? ''}
- **Labels**: ${(issue.fields.labels ?? []).join(', ') || 'None'}
- **Components**: ${components.join(', ') || 'None'}
- **Fix Versions**: ${fixVersions.join(', ') || 'None'}
${issue.fields.parent ? `- **Parent**: ${issue.fields.parent.key} - ${issue.fields.parent.fields?.summary}` : ''}

### Description
${descriptionMarkdown || '(No description provided)'}

### Related Issues
${issueLinks.length > 0 ? issueLinks.join('\n') : '(No linked issues)'}

### Subtasks
${subtasks.length > 0 ? subtasks.join('\n') : '(No subtasks)'}

### Comments Thread (${limitedComments.length} of ${comments.length} comments${commentsOmitted > 0 ? ` - ${commentsOmitted} older comments omitted` : ''})
${limitedComments.length === 0 ? '(No comments)' : ''}
${limitedComments.map((c, index) => `
#### Comment #${index + 1}
- **Author**: ${c.author ?? 'Unknown'}
- **Date**: ${c.created}

${c.bodyMarkdown || '(Empty comment)'}
`).join('\n---\n')}

### Attachments (${attachments.length} files)
${attachments.length === 0 ? '(No attachments)' : ''}
\`\`\`json
${JSON.stringify(attachmentSummary, null, 2)}
\`\`\`

### Downloaded Text Attachments (${limitedTextAttachments.length} of ${textAttachments.length}${textAttachmentsOmitted > 0 ? ` - ${textAttachmentsOmitted} files omitted` : ''})
${limitedTextAttachments.length === 0 ? '(No text attachments downloaded)' : ''}
${limitedTextAttachments.map(t => `
#### File: ${t.filename} (${t.mimeType ?? 'unknown'})
\`\`\`
${t.content}
\`\`\`
`).join('\n')}

---

Generate the comprehensive task description now:`;

    // Check total prompt size and warn if exceeding limits
    if (prompt.length > maxPromptChars) {
      logger.warn({
        jira: issue.key,
        originalLength: prompt.length,
        maxAllowed: maxPromptChars,
        truncatedTo: maxPromptChars,
      }, 'Prompt exceeds size limit - truncating');

      // Truncate prompt, keeping the system prompt and metadata intact
      const truncationMarker = '\n\n[Content truncated due to size limits. ';
      const truncationNote = `Original prompt was ${(prompt.length / 1024).toFixed(0)}KB, truncated to ${(maxPromptChars / 1024).toFixed(0)}KB]\n\n---\n\nGenerate the comprehensive task description now:`;

      return prompt.substring(0, maxPromptChars - truncationMarker.length - truncationNote.length) + truncationMarker + truncationNote;
    }

    return prompt;
  }

  /**
   * Build multimodal content array for Claude (text + images)
   * Uses Claude's multimodal format with base64 images
   */
  private buildMultimodalContent(data: JiraTicketData): Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> {
    const { imageAttachments } = data;
    const content: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [];

    // Add text prompt first
    const textPrompt = this.buildEnhancedPrompt(data);
    content.push({
      type: 'text',
      text: textPrompt,
    });

    // Add images if present (Claude supports up to 20 images per request)
    if (imageAttachments.length > 0) {
      // Add note about images before the images themselves
      content.push({
        type: 'text',
        text: `\n\n### Image Attachments (${imageAttachments.length} images)\n\nThe following images are attached to this JIRA ticket. Please examine them carefully for any relevant information (screenshots, diagrams, error messages, UI mockups, etc.) and incorporate your findings into the task description:\n`,
      });

      // Add each image (limit to 10 to avoid exceeding limits)
      const imagesToSend = imageAttachments.slice(0, 10);
      for (const img of imagesToSend) {
        // Add image metadata text
        content.push({
          type: 'text',
          text: `\n**Image: ${img.filename}** (${img.mimeType}, ${(img.originalSize / 1024).toFixed(1)} KB)\n`,
        });

        // Add the actual image
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mimeType,
            data: img.base64Data,
          },
        });
      }

      if (imageAttachments.length > 10) {
        content.push({
          type: 'text',
          text: `\n\n*Note: ${imageAttachments.length - 10} additional images were not included due to limits.*\n`,
        });
      }
    }

    return content;
  }

  /**
   * Call Bedrock with multimodal content (text + images)
   */
  private async callBedrockMultimodal(content: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>): Promise<string> {
    // Calculate content stats for logging
    const textBlocks = content.filter(c => c.type === 'text');
    const imageBlocks = content.filter(c => c.type === 'image');
    const totalTextLength = textBlocks.reduce((sum, t) => sum + (t.text?.length || 0), 0);
    const totalImageBytes = imageBlocks.reduce((sum, img) => {
      const base64Length = img.source?.data?.length || 0;
      return sum + Math.floor(base64Length * 0.75); // base64 to bytes approx
    }, 0);

    logger.info({
      model: this.model,
      textBlocks: textBlocks.length,
      imageBlocks: imageBlocks.length,
      totalTextChars: totalTextLength,
      totalImageKB: Math.round(totalImageBytes / 1024),
      maxTokens: 50000,
    }, 'Calling Bedrock with multimodal content');

    const startTime = Date.now();

    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 50000,
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          content: content,
        },
      ],
    };

    const command = new InvokeModelCommand({
      modelId: this.model,
      body: JSON.stringify(payload),
      contentType: 'application/json',
      accept: 'application/json',
    });

    try {
      const response = await this.bedrockClient.send(command);
      const durationMs = Date.now() - startTime;

      if (!response.body) {
        throw new Error('Empty response from Bedrock');
      }

      const responseBody = JSON.parse(new TextDecoder().decode(response.body));

      // Extract usage metrics if available
      const usage = responseBody.usage || {};
      logger.info({
        durationMs,
        durationSec: (durationMs / 1000).toFixed(1),
        inputTokens: usage.input_tokens || 'N/A',
        outputTokens: usage.output_tokens || 'N/A',
        stopReason: responseBody.stop_reason || 'N/A',
        responseLength: responseBody.content?.[0]?.text?.length || 0,
      }, 'Bedrock multimodal response received');

      if (responseBody.content && responseBody.content.length > 0) {
        return responseBody.content[0].text;
      }

      throw new Error('No content in Bedrock response');
    } catch (error) {
      const durationMs = Date.now() - startTime;
      logger.error({
        durationMs,
        model: this.model,
        error: error instanceof Error ? error.message : String(error),
        errorName: error instanceof Error ? error.name : 'Unknown',
      }, 'Bedrock multimodal call failed');
      throw error;
    }
  }

  // ===========================================================================
  // Simple Generation (Backwards Compatible)
  // ===========================================================================

  /**
   * Generate task description from pre-fetched JIRA issue
   * Uses simpler prompt without comment/attachment context
   *
   * @param jiraIssue - JIRA issue object (already fetched)
   * @returns Structured markdown task description
   */
  async generateTaskDescription(jiraIssue: BasicJiraIssue): Promise<string> {
    logger.info({ jira: jiraIssue.key }, 'Generating task description (simple mode)');

    try {
      // Handle both string and ADF description
      let descriptionText = '';
      if (jiraIssue.fields.description) {
        if (typeof jiraIssue.fields.description === 'string') {
          descriptionText = jiraIssue.fields.description;
        } else if (jiraIssue.fields.description.type === 'doc') {
          // ADF format - convert to markdown
          descriptionText = adfToMarkdown(jiraIssue.fields.description);
        } else {
          descriptionText = JSON.stringify(jiraIssue.fields.description);
        }
      }

      // Format JIRA ticket as JSON for the LLM
      const jiraJson = JSON.stringify(
        {
          key: jiraIssue.key,
          summary: jiraIssue.fields.summary,
          description: descriptionText || 'No description provided',
          status: jiraIssue.fields.status?.name,
          priority: jiraIssue.fields.priority?.name || 'Unknown',
          labels: jiraIssue.fields.labels || [],
          assignee: jiraIssue.fields.assignee?.displayName,
          reporter: jiraIssue.fields.reporter?.displayName,
          created: jiraIssue.fields.created,
          updated: jiraIssue.fields.updated,
        },
        null,
        2
      );

      // Call Bedrock
      const prompt = `${TASK_DESCRIPTION_PROMPT_SIMPLE}

JIRA Ticket:
\`\`\`json
${jiraJson}
\`\`\`

Generate the task description:`;

      const response = await this.callBedrock(prompt);

      logger.info({
        jira: jiraIssue.key,
        length: response.length,
      }, 'Task description generated');

      return response;
    } catch (error) {
      logger.error({
        jira: jiraIssue.key,
        error,
      }, 'Failed to generate task description');
      throw error;
    }
  }

  // ===========================================================================
  // Bedrock Integration
  // ===========================================================================

  /**
   * Call Bedrock to generate task description
   */
  private async callBedrock(prompt: string): Promise<string> {
    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 50000,
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    };

    const command = new InvokeModelCommand({
      modelId: this.model,
      body: JSON.stringify(payload),
      contentType: 'application/json',
      accept: 'application/json',
    });

    const response = await this.bedrockClient.send(command);

    if (!response.body) {
      throw new Error('Empty response from Bedrock');
    }

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));

    if (responseBody.content && responseBody.content.length > 0) {
      return responseBody.content[0].text;
    }

    throw new Error('No content in Bedrock response');
  }
}
