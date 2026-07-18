import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import path from "path";
import type {
  JiraAttachment,
  JiraClient,
  JiraTicketData,
} from "../orchestrator/JiraClient.js";
import { createS3Client } from "../utils/awsClients.js";
import {
  artifactKind,
  isPriorityLouiseArtifact,
  type ArchivedEvidenceAttachment,
} from "./evidence.js";
import type { SpecFactoryAttachmentSummary } from "./types.js";

type AttachmentJiraClient = Pick<JiraClient, "downloadAttachmentStream">;

export interface AttachmentArchiveRepository {
  upsertAttachment(input: UpsertAttachmentArchiveInput): Promise<SpecFactoryAttachmentSummary>;
}

export interface UpsertAttachmentArchiveInput {
  sourceId: number;
  jiraAttachmentId: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
  artifactKind: string;
  isPriority: boolean;
  s3Bucket: string | null;
  s3Key: string | null;
  sha256: string | null;
  extractedText: string | null;
  extractionStatus: SpecFactoryAttachmentSummary["extractionStatus"];
  errorMessage: string | null;
}

export interface AttachmentArchiveResult {
  archived: ArchivedEvidenceAttachment[];
  warnings: string[];
}

const DEFAULT_MAX_TEXT_ATTACHMENT_BYTES = 5_000_000;
const DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES = 5_000_000;
const DEFAULT_MAX_EXTRACTED_TEXT_CHARS = 500_000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultArchiveBucket(): string {
  return (
    process.env.SPEC_FACTORY_ATTACHMENT_BUCKET?.trim() ||
    process.env.SPEC_FACTORY_ARTIFACT_BUCKET?.trim() ||
    `${process.env.S3_BUCKET_PREFIX || "specter"}-results`
  );
}

function safeFilename(filename: string): string {
  const basename = path.basename(filename).replace(/[^A-Za-z0-9._-]+/g, "_");
  return basename || "attachment";
}

function isTextAttachment(attachment: JiraAttachment): boolean {
  const mimeType = (attachment.mimeType ?? "").toLowerCase();
  const filename = (attachment.filename ?? "").toLowerCase();

  if (mimeType.startsWith("text/")) return true;
  if (mimeType.includes("json")) return true;
  if (mimeType.includes("xml")) return true;
  if (mimeType.includes("yaml") || mimeType.includes("yml")) return true;
  if (mimeType === "application/javascript") return true;

  return [
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
  ].some((ext) => filename.endsWith(ext));
}

function isImageAttachment(attachment: JiraAttachment): boolean {
  const mimeType = (attachment.mimeType ?? "").toLowerCase();
  const filename = (attachment.filename ?? "").toLowerCase();
  if (mimeType.startsWith("image/")) {
    return ["png", "jpeg", "jpg", "gif", "webp"].some((type) =>
      mimeType.includes(type),
    );
  }
  return [".png", ".jpg", ".jpeg", ".gif", ".webp"].some((ext) =>
    filename.endsWith(ext),
  );
}

function truncateText(text: string): string {
  const maxChars = envNumber(
    "SPEC_FACTORY_MAX_EXTRACTED_TEXT_CHARS",
    DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
  );
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

function archiveKey(sourceJiraKey: string, attachment: JiraAttachment): string {
  return [
    "spec-factory",
    sourceJiraKey,
    "attachments",
    `${attachment.id}-${safeFilename(attachment.filename)}`,
  ].join("/");
}

function toArchivedEvidence(
  row: SpecFactoryAttachmentSummary,
): ArchivedEvidenceAttachment {
  return {
    jiraAttachmentId: row.jiraAttachmentId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    s3Bucket: row.s3Bucket,
    s3Key: row.s3Key,
    sha256: row.sha256,
    extractedText: row.extractedText,
    extractionStatus: row.extractionStatus,
    errorMessage: row.errorMessage,
  };
}

export class SpecFactoryAttachmentArchiver {
  private readonly bucket: string;
  private readonly maxTextBytes: number;
  private readonly maxImageBytes: number;

  constructor(
    private readonly jiraClient: AttachmentJiraClient,
    private readonly repository: AttachmentArchiveRepository,
    private readonly s3Client: S3Client = createS3Client({
      region: process.env.AWS_REGION || "us-east-2",
    }),
    options: {
      bucket?: string;
      maxTextBytes?: number;
      maxImageBytes?: number;
    } = {},
  ) {
    this.bucket = options.bucket || defaultArchiveBucket();
    this.maxTextBytes =
      options.maxTextBytes ??
      envNumber(
        "SPEC_FACTORY_MAX_TEXT_ATTACHMENT_BYTES",
        DEFAULT_MAX_TEXT_ATTACHMENT_BYTES,
      );
    this.maxImageBytes =
      options.maxImageBytes ??
      envNumber(
        "SPEC_FACTORY_MAX_IMAGE_ATTACHMENT_BYTES",
        DEFAULT_MAX_IMAGE_ATTACHMENT_BYTES,
      );
  }

  async archiveTicketAttachments(input: {
    sourceId: number;
    ticketData: JiraTicketData;
  }): Promise<AttachmentArchiveResult> {
    const archived: ArchivedEvidenceAttachment[] = [];
    const warnings: string[] = [];

    const attachments = Array.isArray(input.ticketData.attachments)
      ? input.ticketData.attachments
      : [];

    for (const attachment of attachments) {
      const text = isTextAttachment(attachment);
      const image = isImageAttachment(attachment);
      if (!text && !image) continue;

      const maxBytes = text ? this.maxTextBytes : this.maxImageBytes;
      if ((attachment.size ?? 0) > maxBytes) {
        const row = await this.repository.upsertAttachment({
          sourceId: input.sourceId,
          jiraAttachmentId: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType ?? null,
          sizeBytes: attachment.size ?? null,
          artifactKind: artifactKind(attachment.filename),
          isPriority: isPriorityLouiseArtifact(
            attachment.filename,
            input.ticketData.issue.key,
          ),
          s3Bucket: null,
          s3Key: null,
          sha256: null,
          extractedText: null,
          extractionStatus: "skipped",
          errorMessage: `Attachment exceeds ${maxBytes} byte limit.`,
        });
        archived.push(toArchivedEvidence(row));
        warnings.push(`${attachment.filename} was skipped because it exceeds ${maxBytes} bytes.`);
        continue;
      }

      try {
        const response = await this.jiraClient.downloadAttachmentStream(
          attachment.id,
        );
        const buffer = Buffer.from(await response.arrayBuffer());
        const key = archiveKey(input.ticketData.issue.key, attachment);
        const sha256 = createHash("sha256").update(buffer).digest("hex");
        const mimeType =
          attachment.mimeType ||
          response.headers.get("content-type") ||
          "application/octet-stream";

        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: buffer,
            ContentType: mimeType,
            Metadata: {
              source_jira_key: input.ticketData.issue.key,
              jira_attachment_id: attachment.id,
            },
          }),
        );

        const row = await this.repository.upsertAttachment({
          sourceId: input.sourceId,
          jiraAttachmentId: attachment.id,
          filename: attachment.filename,
          mimeType,
          sizeBytes: buffer.byteLength,
          artifactKind: artifactKind(attachment.filename),
          isPriority: isPriorityLouiseArtifact(
            attachment.filename,
            input.ticketData.issue.key,
          ),
          s3Bucket: this.bucket,
          s3Key: key,
          sha256,
          extractedText: text ? truncateText(buffer.toString("utf8")) : null,
          extractionStatus: text ? "extracted" : "stored",
          errorMessage: null,
        });
        archived.push(toArchivedEvidence(row));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const row = await this.repository.upsertAttachment({
          sourceId: input.sourceId,
          jiraAttachmentId: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType ?? null,
          sizeBytes: attachment.size ?? null,
          artifactKind: artifactKind(attachment.filename),
          isPriority: isPriorityLouiseArtifact(
            attachment.filename,
            input.ticketData.issue.key,
          ),
          s3Bucket: null,
          s3Key: null,
          sha256: null,
          extractedText: null,
          extractionStatus: "failed",
          errorMessage: message,
        });
        archived.push(toArchivedEvidence(row));
        warnings.push(`Failed to archive ${attachment.filename}: ${message}`);
      }
    }

    return { archived, warnings };
  }
}
