/**
 * JiraClient - Full JIRA REST API v3 client
 *
 * Provides comprehensive JIRA data fetching including:
 * - Full issue details with all fields
 * - Comments with pagination (ADF format)
 * - Attachments metadata and text content download
 * - ADF (Atlassian Document Format) to Markdown conversion
 *
 * References:
 * - JIRA REST API v3: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
 * - ADF Format: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 * - Basic Auth: https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
 */

import mammoth from "mammoth";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("jira-client");

export function buildPlainTextJiraCommentBody(bodyText: string): {
  type: "doc";
  version: 1;
  content: Array<{
    type: "paragraph";
    content: Array<{ type: "text"; text: string }>;
  }>;
} {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: bodyText }],
      },
    ],
  };
}

function jiraMutationsDisabled(): boolean {
  return (
    process.env.ONESHOT_DISABLE_JIRA_MUTATIONS?.toLowerCase() === "true" ||
    process.env.ONESHOT_DISABLE_JIRA_COMMENTS?.toLowerCase() === "true"
  );
}

export type JiraAttachmentResult =
  | { status: "attached" }
  | { status: "skipped"; reason: "mutations_disabled" };

// =============================================================================
// Types
// =============================================================================

/** Atlassian Document Format (ADF) node */
export type AdfNode = {
  type: string;
  attrs?: Record<string, any>;
  content?: AdfNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
};

/** JIRA Attachment */
export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType?: string;
  size?: number;
  content?: string; // download URL
  thumbnail?: string; // image thumbnail URL
  created?: string;
  author?: {
    displayName?: string;
    accountId?: string;
    emailAddress?: string;
  };
}

/** JIRA Comment */
export interface JiraComment {
  id: string;
  created: string;
  updated: string;
  author?: {
    displayName?: string;
    accountId?: string;
    emailAddress?: string;
  };
  body?: AdfNode; // ADF in REST v3
}

export interface JiraFieldMetadata {
  id: string;
  name: string;
  custom?: boolean;
}

/** Full JIRA Issue */
export interface JiraIssue {
  key: string;
  id: string;
  self: string;
  fields: {
    summary?: string;
    description?: AdfNode; // ADF in REST v3
    created?: string;
    updated?: string;
    status?: { name?: string; statusCategory?: { name?: string } };
    priority?: { name?: string };
    issuetype?: { name?: string; subtask?: boolean };
    resolution?: { name?: string };
    environment?: string | AdfNode | { name?: string; value?: string; displayName?: string };
    labels?: string[];
    components?: Array<{ name?: string }>;
    fixVersions?: Array<{ name?: string }>;
    assignee?: {
      displayName?: string;
      accountId?: string;
      emailAddress?: string;
    };
    reporter?: {
      displayName?: string;
      accountId?: string;
      emailAddress?: string;
    };
    attachment?: JiraAttachment[];
    parent?: { key?: string; fields?: { summary?: string } };
    subtasks?: Array<{
      key?: string;
      fields?: { summary?: string; status?: { name?: string } };
    }>;
    issuelinks?: Array<{
      type?: { name?: string; inward?: string; outward?: string };
      inwardIssue?: {
        key?: string;
        fields?: { summary?: string; status?: { name?: string } };
      };
      outwardIssue?: {
        key?: string;
        fields?: { summary?: string; status?: { name?: string } };
      };
    }>;
    [key: string]: any; // Allow custom fields
  };
}

/** Downloaded text attachment */
export interface TextAttachment {
  id?: string;
  filename: string;
  mimeType?: string;
  content: string;
  size: number;
}

/** Downloaded image attachment (base64 encoded for multimodal LLM) */
export interface ImageAttachment {
  id?: string;
  filename: string;
  mimeType: string;
  /** Base64-encoded image data (without data URI prefix) */
  base64Data: string;
  /** Original size in bytes before encoding */
  originalSize: number;
  /** Width in pixels (if available from metadata) */
  width?: number;
  /** Height in pixels (if available from metadata) */
  height?: number;
}

/** DOCX attachment extraction result for ticket evidence */
export interface DocxAttachmentEvidence {
  id?: string;
  filename: string;
  mimeType?: string;
  content?: string;
  size: number;
  extractionStatus: "included" | "failed";
  warning?: string;
}

/** Comprehensive JIRA data for task generation */
export interface JiraTicketData {
  issue: JiraIssue;
  descriptionMarkdown: string;
  comments: Array<{
    id: string;
    author?: string;
    created: string;
    bodyMarkdown: string;
  }>;
  attachments: JiraAttachment[];
  textAttachments: TextAttachment[];
  /** Image attachments as base64 for multimodal LLM processing */
  imageAttachments: ImageAttachment[];
}

// =============================================================================
// JIRA Client Class
// =============================================================================

export interface JiraClientConfig {
  baseUrl: string;
  username: string;
  token: string;
  /** Max bytes to download for text attachments (default: 200KB) */
  maxAttachmentBytes?: number;
  /** Max bytes to download for image attachments (default: 5MB) */
  maxImageBytes?: number;
  /** Enable image attachment downloading (default: true) */
  downloadImages?: boolean;
}

export class JiraClient {
  private config: Required<JiraClientConfig>;

  constructor(config: JiraClientConfig) {
    this.config = {
      maxAttachmentBytes: 200_000,
      maxImageBytes: 5_000_000, // 5MB default for images
      downloadImages: true,
      ...config,
      baseUrl: config.baseUrl.replace(/\/$/, ""), // Remove trailing slash
    };
  }

  /**
   * Create Basic Auth header for JIRA Cloud
   * Uses email + API token for authentication
   */
  private getAuthHeader(): string {
    const token = Buffer.from(
      `${this.config.username}:${this.config.token}`,
    ).toString("base64");
    return `Basic ${token}`;
  }

  /**
   * Make authenticated GET request to JIRA
   */
  private async getJson<T>(restPath: string): Promise<T> {
    const url = `${this.config.baseUrl}${restPath}`;

    logger.debug({ path: restPath }, "JIRA API GET");

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.getAuthHeader(),
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      logger.error(
        {
          path: restPath,
          status: response.status,
          statusText: response.statusText,
          error: errorText.substring(0, 500),
        },
        "JIRA API request failed",
      );
      throw new Error(
        `JIRA API error: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`,
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Make authenticated GET request to download text content
   */
  private async getText(urlOrPath: string): Promise<string> {
    const url = urlOrPath.startsWith("http")
      ? urlOrPath
      : `${this.config.baseUrl}${urlOrPath}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.getAuthHeader(),
        Accept: "*/*",
      },
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `JIRA download failed: ${response.status} - ${errorText.substring(0, 200)}`,
      );
    }

    return await response.text();
  }

  // ===========================================================================
  // Issue Fetching
  // ===========================================================================

  /**
   * Fetch full JIRA issue with all relevant fields
   * REST API v3 returns description/body in ADF format
   */
  async fetchIssue(issueKey: string, extraFields: string[] = []): Promise<JiraIssue> {
    const fields = Array.from(new Set([
      "summary",
      "description",
      "created",
      "updated",
      "status",
      "priority",
      "issuetype",
      "resolution",
      "environment",
      "labels",
      "components",
      "fixVersions",
      "assignee",
      "reporter",
      "attachment",
      "parent",
      "subtasks",
      "issuelinks",
      // Common custom fields - add more as needed
      // Story points field: customfield_10016 in most Jira Cloud projects.
      // Override via JIRA_STORY_POINTS_FIELD env var if your project uses a
      // different field (e.g. customfield_10002 on older project templates).
      process.env.JIRA_STORY_POINTS_FIELD ?? "customfield_10016",
      "customfield_10047", // Client Name (MHK)
      "customfield_10100", // Customer field
      ...extraFields,
    ])).join(",");

    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=${fields}`;

    logger.info({ issueKey }, "Fetching JIRA issue");

    const issue = await this.getJson<JiraIssue>(path);

    logger.info(
      {
        issueKey,
        summary: issue.fields.summary?.substring(0, 100),
        hasDescription: !!issue.fields.description,
        attachmentCount: issue.fields.attachment?.length || 0,
      },
      "JIRA issue fetched",
    );

    return issue;
  }

  async fetchFields(): Promise<JiraFieldMetadata[]> {
    const fields = await this.getJson<unknown>("/rest/api/3/field");
    if (!Array.isArray(fields)) {
      return [];
    }
    return fields
      .map((field) => field as Partial<JiraFieldMetadata>)
      .filter((field): field is JiraFieldMetadata =>
        typeof field.id === "string" && typeof field.name === "string",
      );
  }

  // ===========================================================================
  // Comments Fetching (Paginated)
  // ===========================================================================

  /**
   * Fetch all comments for an issue with pagination
   * JIRA paginated endpoint returns ADF body for each comment
   */
  async fetchAllComments(issueKey: string): Promise<JiraComment[]> {
    const allComments: JiraComment[] = [];
    let startAt = 0;
    const maxResults = 100;

    logger.info({ issueKey }, "Fetching JIRA comments");

    while (true) {
      const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?startAt=${startAt}&maxResults=${maxResults}`;

      const page = await this.getJson<{
        startAt: number;
        maxResults: number;
        total: number;
        comments: JiraComment[];
      }>(path);

      const comments = Array.isArray(page.comments) ? page.comments : [];
      const pageStartAt = Number.isFinite(page.startAt) ? page.startAt : startAt;
      const pageMaxResults = Number.isFinite(page.maxResults) && page.maxResults > 0 ? page.maxResults : maxResults;
      const pageTotal = Number.isFinite(page.total) ? page.total : allComments.length + comments.length;

      allComments.push(...comments);
      startAt = pageStartAt + pageMaxResults;

      logger.debug(
        {
          issueKey,
          pageComments: comments.length,
          totalFetched: allComments.length,
          total: pageTotal,
        },
        "Fetched comment page",
      );

      if (startAt >= pageTotal) break;
    }

    logger.info(
      {
        issueKey,
        commentCount: allComments.length,
      },
      "All comments fetched",
    );

    return allComments;
  }

  /**
   * Post a plain-text comment to a JIRA issue. Returns the new comment id.
   *
   * JIRA Cloud's REST v3 `/issue/{key}/comment` endpoint requires an ADF body;
   * this helper wraps a plain string in a minimal single-paragraph ADF doc so
   * callers don't need to construct ADF themselves. If a caller already has
   * an ADF object, they can pass it in directly.
   *
   * Used by the RepoRouter needs_repo_confirmation path so the reporter sees
   * a Jira-native notification alongside the dashboard queue entry. Kept as a
   * general-purpose helper because posting comments is a common Jira op.
   */
  async addComment(
    issueKey: string,
    bodyText: string,
  ): Promise<{ id: string }> {
    if (jiraMutationsDisabled()) {
      logger.warn(
        {
          issueKey,
        },
        "Skipping JIRA comment mutation because mutation guard is set",
      );
      return { id: "mutation-guard-disabled" };
    }
    const url = `${this.config.baseUrl}/rest/api/3/issue/${encodeURIComponent(
      issueKey,
    )}/comment`;
    const adfBody = buildPlainTextJiraCommentBody(bodyText);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.getAuthHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ body: adfBody }),
    });
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `JIRA addComment failed: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`,
      );
    }
    const payload = (await response.json()) as { id: string };
    logger.info(
      {
        issueKey,
        commentId: payload.id,
      },
      "JIRA comment posted",
    );
    return { id: payload.id };
  }

  // ===========================================================================
  // Attachment Handling
  // ===========================================================================

  /**
   * Check if attachment is likely text-based and safe to download
   */
  private isProbablyTextAttachment(attachment: JiraAttachment): boolean {
    const mimeType = (attachment.mimeType ?? "").toLowerCase();
    const filename = (attachment.filename ?? "").toLowerCase();

    // Office Open XML MIME types contain "xmlformats" but are ZIP/binary
    // containers. Dedicated extractors handle them; generic text download would
    // feed raw PK/OOXML bytes into QUALIFIER.
    if (this.isOfficeContainerAttachment(attachment)) {
      return false;
    }

    // Check MIME type
    if (mimeType.startsWith("text/")) return true;
    if (mimeType.includes("json")) return true;
    if (mimeType.includes("xml")) return true;
    if (mimeType.includes("yaml")) return true;
    if (mimeType.includes("yml")) return true;
    if (mimeType === "application/javascript") return true;

    // Check file extension
    const textExtensions = [
      ".txt",
      ".log",
      ".json",
      ".xml",
      ".yaml",
      ".yml",
      ".md",
      ".markdown",
      ".csv",
      ".sql",
      ".sh",
      ".bash",
      ".py",
      ".js",
      ".ts",
      ".java",
      ".properties",
      ".conf",
      ".cfg",
      ".ini",
      ".env",
      ".html",
      ".htm",
      ".css",
      ".config",
      ".gradle",
      ".groovy",
      ".scala",
      ".kt",
    ];

    return textExtensions.some((ext) => filename.endsWith(ext));
  }

  /**
   * Download text-based attachments
   * Only downloads files that are likely text and under size limit
   */
  async fetchTextAttachments(
    attachments: JiraAttachment[],
  ): Promise<TextAttachment[]> {
    const results: TextAttachment[] = [];
    const maxBytes = this.config.maxAttachmentBytes;

    for (const attachment of attachments) {
      // Skip non-text attachments
      if (!this.isProbablyTextAttachment(attachment)) {
        logger.debug(
          {
            filename: attachment.filename,
            mimeType: attachment.mimeType,
          },
          "Skipping non-text attachment",
        );
        continue;
      }

      // Skip large attachments (with special handling for SQL files)
      // SQL files get a higher limit (5MB) since they're critical for SENTRY validation
      const isSqlFile = attachment.filename?.toLowerCase().endsWith(".sql");
      const sizeLimit = isSqlFile ? 5_000_000 : maxBytes; // 5MB for SQL, default for others

      if ((attachment.size ?? 0) > sizeLimit) {
        logger.debug(
          {
            filename: attachment.filename,
            size: attachment.size,
            sizeLimit,
            isSqlFile,
          },
          "Skipping large attachment",
        );
        continue;
      }

      // Skip if no download URL
      if (!attachment.content) {
        logger.debug(
          {
            filename: attachment.filename,
          },
          "Skipping attachment without download URL",
        );
        continue;
      }

      try {
        logger.debug(
          {
            filename: attachment.filename,
            size: attachment.size,
          },
          "Downloading attachment",
        );

        const content = await this.getText(attachment.content);

        // Extra safety: truncate if content is larger than expected
        // For SQL files, use the same 5MB limit; for others, use 100KB
        const truncateLimit = isSqlFile ? 5_000_000 : 100_000;
        const truncatedContent = content.slice(0, truncateLimit);

        results.push({
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          content: truncatedContent,
          size: truncatedContent.length,
        });

        logger.info(
          {
            filename: attachment.filename,
            size: truncatedContent.length,
          },
          "Attachment downloaded",
        );
      } catch (error) {
        // Log but don't fail - attachment download is best-effort
        logger.warn(
          {
            filename: attachment.filename,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to download attachment",
        );
      }
    }

    return results;
  }

  // ===========================================================================
  // Image Attachment Handling
  // ===========================================================================

  /**
   * Check if attachment is an image that can be processed by multimodal LLM
   */
  private isImageAttachment(attachment: JiraAttachment): boolean {
    const mimeType = (attachment.mimeType ?? "").toLowerCase();
    const filename = (attachment.filename ?? "").toLowerCase();

    // Check MIME type
    if (mimeType.startsWith("image/")) {
      // Supported image types for Claude multimodal
      const supportedTypes = [
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/gif",
        "image/webp",
      ];
      return supportedTypes.some((t) => mimeType.includes(t.split("/")[1]));
    }

    // Check file extension
    const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp"];
    return imageExtensions.some((ext) => filename.endsWith(ext));
  }

  private isDocxAttachment(attachment: JiraAttachment): boolean {
    const mimeType = (attachment.mimeType ?? "").toLowerCase();
    const filename = (attachment.filename ?? "").toLowerCase();
    return (
      filename.endsWith(".docx") ||
      mimeType.includes(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      )
    );
  }

  private isSpreadsheetAttachment(attachment: JiraAttachment): boolean {
    const mimeType = (attachment.mimeType ?? "").toLowerCase();
    const filename = (attachment.filename ?? "").toLowerCase();
    return (
      filename.endsWith(".xls") ||
      filename.endsWith(".xlsx") ||
      filename.endsWith(".xlsm") ||
      filename.endsWith(".xlsb") ||
      mimeType.includes("application/vnd.ms-excel") ||
      mimeType.includes("spreadsheetml") ||
      mimeType.includes("spreadsheet")
    );
  }

  private isOfficeContainerAttachment(attachment: JiraAttachment): boolean {
    return (
      this.isDocxAttachment(attachment) ||
      this.isSpreadsheetAttachment(attachment)
    );
  }

  async fetchDocxAttachmentEvidence(
    attachments: JiraAttachment[],
  ): Promise<DocxAttachmentEvidence[]> {
    const results: DocxAttachmentEvidence[] = [];
    const maxBytes = this.config.maxAttachmentBytes;

    for (const attachment of attachments) {
      if (!this.isDocxAttachment(attachment)) {
        continue;
      }

      const size = attachment.size ?? 0;
      if (size > maxBytes) {
        results.push({
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size,
          extractionStatus: "failed",
          warning: `DOCX attachment exceeds ${maxBytes} byte extraction limit`,
        });
        continue;
      }

      if (!attachment.content) {
        results.push({
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size,
          extractionStatus: "failed",
          warning: "DOCX attachment has no download URL",
        });
        continue;
      }

      try {
        const arrayBuffer = await this.getBinary(attachment.content);
        const result = await mammoth.extractRawText({
          buffer: Buffer.from(arrayBuffer),
        });
        const content = result.value.trim();
        const warnings = (result.messages ?? [])
          .map((message: { message?: string }) => message.message)
          .filter((message): message is string => Boolean(message));
        results.push({
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          content,
          size: content.length,
          extractionStatus: "included",
          warning: warnings.join("; ") || undefined,
        });
      } catch (error) {
        results.push({
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size,
          extractionStatus: "failed",
          warning: `DOCX extraction failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return results;
  }

  /**
   * Make authenticated GET request to download binary content
   */
  private async getBinary(urlOrPath: string): Promise<ArrayBuffer> {
    const url = urlOrPath.startsWith("http")
      ? urlOrPath
      : `${this.config.baseUrl}${urlOrPath}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.getAuthHeader(),
        Accept: "*/*",
      },
    });

    if (!response.ok) {
      throw new Error(`JIRA binary download failed: ${response.status}`);
    }

    return await response.arrayBuffer();
  }

  /**
   * Download image attachments and convert to base64 for multimodal LLM
   * Only downloads images under the size limit
   */
  async fetchImageAttachments(
    attachments: JiraAttachment[],
  ): Promise<ImageAttachment[]> {
    if (!this.config.downloadImages) {
      logger.debug("Image downloading disabled");
      return [];
    }

    const results: ImageAttachment[] = [];
    const maxBytes = this.config.maxImageBytes;

    for (const attachment of attachments) {
      // Skip non-image attachments
      if (!this.isImageAttachment(attachment)) {
        continue;
      }

      // Skip large images
      if ((attachment.size ?? 0) > maxBytes) {
        logger.debug(
          {
            filename: attachment.filename,
            size: attachment.size,
            maxBytes,
          },
          "Skipping large image attachment",
        );
        continue;
      }

      // Skip if no download URL
      if (!attachment.content) {
        logger.debug(
          {
            filename: attachment.filename,
          },
          "Skipping image without download URL",
        );
        continue;
      }

      try {
        logger.debug(
          {
            filename: attachment.filename,
            size: attachment.size,
            mimeType: attachment.mimeType,
          },
          "Downloading image attachment",
        );

        const arrayBuffer = await this.getBinary(attachment.content);
        const base64Data = Buffer.from(arrayBuffer).toString("base64");

        // Determine MIME type
        const mimeType =
          attachment.mimeType ||
          this.getMimeTypeFromFilename(attachment.filename);

        results.push({
          id: attachment.id,
          filename: attachment.filename,
          mimeType,
          base64Data,
          originalSize: arrayBuffer.byteLength,
        });

        logger.info(
          {
            filename: attachment.filename,
            originalSize: arrayBuffer.byteLength,
            base64Size: base64Data.length,
          },
          "Image attachment downloaded",
        );
      } catch (error) {
        // Log but don't fail - attachment download is best-effort
        logger.warn(
          {
            filename: attachment.filename,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to download image attachment",
        );
      }
    }

    return results;
  }

  /**
   * Get MIME type from filename extension
   */
  private getMimeTypeFromFilename(filename: string): string {
    const ext = filename.toLowerCase().split(".").pop();
    const mimeTypes: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };
    return mimeTypes[ext || ""] || "image/png";
  }

  // ===========================================================================
  // Comprehensive Data Fetching
  // ===========================================================================

  // ===========================================================================
  // TRIAGE Mutation Methods
  // ===========================================================================

  /**
   * Create a new Jira issue (story/task) as a child of an EPIC.
   * Used by TRIAGE to create security remediation stories.
   */
  async createIssue(data: {
    projectKey: string;
    summary: string;
    description: string;
    issueType?: string;
    labels?: string[];
    priority?: string;
    parentKey?: string;
    storyPoints?: number;
  }): Promise<{ key: string; summary: string }> {
    if (jiraMutationsDisabled()) {
      logger.warn(
        { projectKey: data.projectKey },
        "Skipping createIssue — mutation guard set",
      );
      return { key: "mutation-guard-disabled", summary: data.summary };
    }

    const url = `${this.config.baseUrl}/rest/api/3/issue`;

    const fields: Record<string, unknown> = {
      project: { key: data.projectKey },
      summary: data.summary,
      description: buildPlainTextJiraCommentBody(data.description),
      issuetype: { name: data.issueType ?? "Story" },
    };

    if (data.labels && data.labels.length > 0) {
      fields.labels = data.labels;
    }
    if (data.priority) {
      fields.priority = { name: data.priority };
    }
    if (data.parentKey) {
      fields.parent = { key: data.parentKey };
    }
    if (data.storyPoints != null) {
      // Use the same field as fetchIssue() — configurable via JIRA_STORY_POINTS_FIELD.
      const spField =
        process.env.JIRA_STORY_POINTS_FIELD ?? "customfield_10016";
      fields[spField] = data.storyPoints;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.getAuthHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ fields }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `JIRA createIssue failed: ${response.status} ${response.statusText} - ${errorText.substring(0, 300)}`,
      );
    }

    const payload = (await response.json()) as { key: string };
    logger.info(
      { key: payload.key, summary: data.summary },
      "JIRA issue created",
    );
    return { key: payload.key, summary: data.summary };
  }

  /**
   * Add and/or remove labels on a Jira issue.
   * Used by TRIAGE to manage WIZ-SCAN-PENDING / WIZ-SCAN-IN-PROGRESS labels on the EPIC.
   */
  async updateIssueLabels(
    issueKey: string,
    changes: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    if (jiraMutationsDisabled()) {
      logger.warn(
        { issueKey },
        "Skipping updateIssueLabels — mutation guard set",
      );
      return;
    }

    const operations: Array<Record<string, unknown>> = [];
    for (const label of changes.add ?? []) {
      operations.push({ add: label });
    }
    for (const label of changes.remove ?? []) {
      operations.push({ remove: label });
    }
    if (operations.length === 0) return;

    const url = `${this.config.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: this.getAuthHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        update: { labels: operations },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `JIRA updateIssueLabels failed: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`,
      );
    }

    logger.info(
      { issueKey, add: changes.add, remove: changes.remove },
      "JIRA labels updated",
    );
  }

  /**
   * Download raw attachment content by attachment ID.
   * Uses /rest/api/3/attachment/content/{id} per Jira Cloud API docs.
   */
  async downloadAttachmentById(attachmentId: string): Promise<string> {
    const url = `${this.config.baseUrl}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.getAuthHeader(),
        Accept: "application/octet-stream",
      },
    });

    if (!response.ok) {
      throw new Error(
        `JIRA downloadAttachment failed: ${response.status} ${response.statusText} for attachment ${attachmentId}`,
      );
    }

    // For large files (e.g. 1 GB Wiz CSV), avoid loading the full body into
    // memory. Return the raw Response so callers can stream / chunk as needed.
    // The synchronous text() call below is kept for backward compat with small
    // files; callers that need streaming should use downloadAttachmentStream().
    return response.text();
  }

  /**
   * Stream a large attachment without loading it fully into memory.
   * Returns the raw fetch Response — caller is responsible for consuming
   * response.body (a ReadableStream) and closing it.
   * Used by the Wiz CSV parser to avoid OOM on ~1 GB scan files.
   */
  async downloadAttachmentStream(attachmentId: string): Promise<Response> {
    // Jira returns 303 → S3. Accept: */* avoids 406 that octet-stream triggers.
    const url = `${this.config.baseUrl}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: this.getAuthHeader(),
        Accept: "*/*",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(
        `JIRA downloadAttachmentStream failed: ${response.status} ${response.statusText} for attachment ${attachmentId}`,
      );
    }

    return response;
  }

  /**
   * Attach a file (text content) to a Jira issue.
   * Uses multipart/form-data as required by /rest/api/3/issue/{key}/attachments.
   */
  async attachFileToIssue(
    issueKey: string,
    filename: string,
    content: string,
    contentType = "text/plain",
  ): Promise<JiraAttachmentResult> {
    if (jiraMutationsDisabled()) {
      logger.warn(
        { issueKey, filename },
        "Skipping attachFileToIssue — mutation guard set",
      );
      return { status: "skipped", reason: "mutations_disabled" };
    }

    const url = `${this.config.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`;

    const formData = new FormData();
    formData.append(
      "file",
      new Blob([content], { type: contentType }),
      filename,
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.getAuthHeader(),
        "X-Atlassian-Token": "no-check",
        Accept: "application/json",
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `JIRA attachFileToIssue failed: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`,
      );
    }

    logger.info({ issueKey, filename }, "File attached to Jira issue");
    return { status: "attached" };
  }

  /**
   * Search Jira issues with JQL using POST /rest/api/3/search/jql.
   * Uses cursor-based pagination (isLast / nextPageToken) — the new API
   * does NOT accept startAt and returns no total field.
   */
  async searchIssues(
    jql: string,
    fields = "key,summary,labels",
    maxResults = 50,
  ): Promise<{
    total: number;
    issues: Array<{ key: string; fields?: JiraIssue["fields"] }>;
  }> {
    const allIssues: Array<{ key: string; fields?: JiraIssue["fields"] }> = [];
    let nextPageToken: string | undefined;

    do {
      const url = `${this.config.baseUrl}/rest/api/3/search/jql`;
      const requestBody: Record<string, unknown> = {
        jql,
        fields: fields.split(",").map((f) => f.trim()),
        maxResults,
      };
      if (nextPageToken) requestBody.nextPageToken = nextPageToken;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: this.getAuthHeader(),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `JIRA searchIssues failed: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`,
        );
      }

      const page = (await response.json()) as {
        issues?: Array<{ key: string; fields?: JiraIssue["fields"] }>;
        isLast?: boolean;
        nextPageToken?: string;
      };

      allIssues.push(...(page.issues ?? []));
      nextPageToken = page.isLast ? undefined : page.nextPageToken;
    } while (nextPageToken);

    return { total: allIssues.length, issues: allIssues };
  }

  /**
   * Fetch all JIRA data needed for task generation
   * Includes issue, comments, text attachments, and image attachments
   */
  async fetchTicketData(issueKey: string): Promise<JiraTicketData> {
    const startTime = Date.now();
    logger.info({ issueKey }, "Fetching comprehensive JIRA ticket data");

    // Step 1: Fetch issue and comments in parallel
    const fetchStart = Date.now();
    const [issue, comments] = await Promise.all([
      this.fetchIssue(issueKey),
      this.fetchAllComments(issueKey),
    ]);
    const fetchMs = Date.now() - fetchStart;
    logger.debug({ issueKey, fetchMs }, "Issue and comments fetched");

    // Step 2: Convert description ADF to Markdown
    const descriptionMarkdown = adfToMarkdown(issue.fields.description);

    // Step 3: Convert comment bodies to Markdown
    const commentsMd = comments.map((c) => ({
      id: c.id,
      author: c.author?.displayName,
      created: c.created,
      bodyMarkdown: adfToMarkdown(c.body),
    }));

    // Step 4: Get attachments from issue
    const attachments = issue.fields.attachment ?? [];
    const textableCount = attachments.filter((a) =>
      this.isProbablyTextAttachment(a),
    ).length;
    const imagableCount = attachments.filter((a) =>
      this.isImageAttachment(a),
    ).length;

    logger.debug(
      {
        issueKey,
        totalAttachments: attachments.length,
        textableCount,
        imagableCount,
      },
      "Attachment analysis",
    );

    // Step 5: Download text-based and image attachments in parallel
    const downloadStart = Date.now();
    const [textAttachments, imageAttachments] = await Promise.all([
      this.fetchTextAttachments(attachments),
      this.fetchImageAttachments(attachments),
    ]);
    const downloadMs = Date.now() - downloadStart;

    // Calculate total bytes downloaded
    const textBytes = textAttachments.reduce((sum, t) => sum + t.size, 0);
    const imageBytes = imageAttachments.reduce(
      (sum, i) => sum + i.originalSize,
      0,
    );
    const totalMs = Date.now() - startTime;

    logger.info(
      {
        issueKey,
        totalMs,
        fetchMs,
        downloadMs,
        hasDescription: !!descriptionMarkdown,
        descriptionLength: descriptionMarkdown.length,
        commentCount: commentsMd.length,
        attachmentCount: attachments.length,
        textAttachmentCount: textAttachments.length,
        textAttachmentBytes: textBytes,
        imageAttachmentCount: imageAttachments.length,
        imageAttachmentBytes: imageBytes,
        totalBytesDownloaded: textBytes + imageBytes,
      },
      "JIRA ticket data fetched",
    );

    return {
      issue,
      descriptionMarkdown,
      comments: commentsMd,
      attachments,
      textAttachments,
      imageAttachments,
    };
  }
}

// =============================================================================
// ADF to Markdown Converter
// =============================================================================

/**
 * Convert Atlassian Document Format (ADF) to Markdown
 *
 * ADF is Jira's rich text format returned by REST API v3.
 * This converts the most common node types to readable Markdown.
 *
 * Reference: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 */
export function adfToMarkdown(adf: AdfNode | undefined | null): string {
  if (!adf) return "";

  const output: string[] = [];

  function walk(node: AdfNode | undefined | null): void {
    if (!node) return;

    switch (node.type) {
      case "doc":
        // Root document node - process children
        (node.content ?? []).forEach(walk);
        break;

      case "paragraph":
        output.push(renderInline(node.content ?? []).trim());
        output.push("");
        break;

      case "heading": {
        const level = Math.min(Math.max(node.attrs?.level ?? 1, 1), 6);
        const text = renderInline(node.content ?? []).trim();
        output.push(`${"#".repeat(level)} ${text}`);
        output.push("");
        break;
      }

      case "bulletList":
        (node.content ?? []).forEach((li) => {
          const item = renderListItem(li);
          if (item) output.push(`- ${item}`);
        });
        output.push("");
        break;

      case "orderedList": {
        let index = 1;
        (node.content ?? []).forEach((li) => {
          const item = renderListItem(li);
          if (item) output.push(`${index++}. ${item}`);
        });
        output.push("");
        break;
      }

      case "codeBlock": {
        const language = node.attrs?.language || "";
        const code = (node.content ?? [])
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("");
        output.push(`\`\`\`${language}`);
        output.push(code);
        output.push("```");
        output.push("");
        break;
      }

      case "blockquote":
        (node.content ?? []).forEach((c) => {
          const beforeLength = output.length;
          walk(c);
          // Prefix newly added lines with >
          for (let i = beforeLength; i < output.length; i++) {
            if (output[i].trim()) {
              output[i] = `> ${output[i]}`;
            }
          }
        });
        output.push("");
        break;

      case "rule":
        output.push("---");
        output.push("");
        break;

      case "table":
        renderTable(node, output);
        break;

      case "mediaSingle":
      case "mediaGroup":
        // Media nodes - just note that there's an image/file
        (node.content ?? []).forEach((media) => {
          if (media.type === "media") {
            const altText = media.attrs?.alt || media.attrs?.id || "attachment";
            output.push(`![${altText}](attachment)`);
          }
        });
        output.push("");
        break;

      case "panel": {
        const panelType = node.attrs?.panelType || "info";
        output.push(`> **${panelType.toUpperCase()}**`);
        (node.content ?? []).forEach((c) => {
          const beforeLength = output.length;
          walk(c);
          for (let i = beforeLength; i < output.length; i++) {
            if (output[i].trim()) {
              output[i] = `> ${output[i]}`;
            }
          }
        });
        output.push("");
        break;
      }

      case "expand": {
        const title = node.attrs?.title || "Details";
        output.push(`<details>`);
        output.push(`<summary>${title}</summary>`);
        output.push("");
        (node.content ?? []).forEach(walk);
        output.push(`</details>`);
        output.push("");
        break;
      }

      default:
        // Unknown node type - try to process children
        if (node.content) {
          node.content.forEach(walk);
        }
        break;
    }
  }

  /**
   * Render inline content (text with marks)
   */
  function renderInline(nodes: AdfNode[]): string {
    return nodes
      .map((n) => {
        if (!n) return "";

        if (n.type === "text") {
          let text = n.text ?? "";
          const marks = n.marks ?? [];

          for (const mark of marks) {
            switch (mark.type) {
              case "strong":
                text = `**${text}**`;
                break;
              case "em":
                text = `*${text}*`;
                break;
              case "code":
                text = `\`${text}\``;
                break;
              case "strike":
                text = `~~${text}~~`;
                break;
              case "underline":
                text = `<u>${text}</u>`;
                break;
              case "link":
                const href = mark.attrs?.href;
                if (href) text = `[${text}](${href})`;
                break;
              case "textColor":
                // Skip color formatting for Markdown
                break;
              case "subsup":
                const type = mark.attrs?.type;
                if (type === "sub") text = `<sub>${text}</sub>`;
                else if (type === "sup") text = `<sup>${text}</sup>`;
                break;
            }
          }
          return text;
        }

        if (n.type === "hardBreak") return "\n";

        if (n.type === "mention") {
          const text = n.attrs?.text || n.attrs?.id || "user";
          return `@${text}`;
        }

        if (n.type === "emoji") {
          return n.attrs?.shortName || n.attrs?.text || "";
        }

        if (n.type === "inlineCard") {
          const url = n.attrs?.url;
          return url ? `[${url}](${url})` : "";
        }

        if (n.type === "status") {
          const text = n.attrs?.text || "status";
          return `[${text}]`;
        }

        if (n.type === "date") {
          const timestamp = n.attrs?.timestamp;
          if (timestamp) {
            const date = new Date(parseInt(timestamp));
            return date.toISOString().split("T")[0];
          }
          return "";
        }

        // Recurse for other inline nodes
        if (n.content) {
          return renderInline(n.content);
        }

        return "";
      })
      .join("");
  }

  /**
   * Render a list item node
   */
  function renderListItem(liNode: AdfNode): string {
    if (!liNode || liNode.type !== "listItem") return "";

    const parts: string[] = [];
    for (const child of liNode.content ?? []) {
      if (child.type === "paragraph") {
        parts.push(renderInline(child.content ?? []).trim());
      } else if (child.content) {
        parts.push(renderInline(child.content).trim());
      }
    }
    return parts.filter(Boolean).join(" ");
  }

  /**
   * Render a table node
   */
  function renderTable(tableNode: AdfNode, out: string[]): void {
    const rows: string[][] = [];
    let maxCols = 0;

    for (const rowNode of tableNode.content ?? []) {
      if (rowNode.type !== "tableRow") continue;

      const cells: string[] = [];
      for (const cellNode of rowNode.content ?? []) {
        if (cellNode.type !== "tableCell" && cellNode.type !== "tableHeader")
          continue;

        // Render cell content
        const cellContent = (cellNode.content ?? [])
          .map((c) => {
            if (c.type === "paragraph") {
              return renderInline(c.content ?? []).trim();
            }
            return "";
          })
          .filter(Boolean)
          .join(" ");

        cells.push(cellContent);
      }

      rows.push(cells);
      maxCols = Math.max(maxCols, cells.length);
    }

    if (rows.length === 0) return;

    // Normalize row lengths
    rows.forEach((row) => {
      while (row.length < maxCols) row.push("");
    });

    // Output as Markdown table
    const [headerRow, ...bodyRows] = rows;

    // Header
    out.push(`| ${headerRow.join(" | ")} |`);
    // Separator
    out.push(`| ${headerRow.map(() => "---").join(" | ")} |`);
    // Body rows
    for (const row of bodyRows) {
      out.push(`| ${row.join(" | ")} |`);
    }
    out.push("");
  }

  // Process the ADF
  walk(adf);

  // Clean up: collapse excessive blank lines
  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// =============================================================================
// Singleton Factory
// =============================================================================

let clientInstance: JiraClient | null = null;

/**
 * Get or create JiraClient instance
 */
export function getJiraClient(config?: JiraClientConfig): JiraClient {
  if (!clientInstance && config) {
    clientInstance = new JiraClient(config);
  }
  if (!clientInstance) {
    throw new Error(
      "JiraClient not initialized. Provide config on first call.",
    );
  }
  return clientInstance;
}

/**
 * Create a new JiraClient with provided config (doesn't use singleton)
 */
export function createJiraClient(config: JiraClientConfig): JiraClient {
  return new JiraClient(config);
}
