import {
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createS3Client } from "../utils/awsClients.js";
import type { ComposeUploadTarget } from "./compose-types.js";

const DEFAULT_EXPIRES_SECONDS = 900;
// S3 DeleteObjects accepts at most 1000 keys per request.
const S3_DELETE_BATCH = 1000;

export function safeUploadFilename(filename: string): string {
  const basename = (filename.split(/[\\/]/).pop() ?? "").replace(
    /[^A-Za-z0-9._-]/g,
    "_",
  );
  return basename || "upload";
}

export function composeRawKey(
  s3Prefix: string,
  sourceId: number,
  filename: string,
): string {
  const prefix = s3Prefix.endsWith("/") ? s3Prefix : `${s3Prefix}/`;
  return `${prefix}raw/${sourceId}-${safeUploadFilename(filename)}`;
}

type Presigner = (
  client: S3Client,
  command: PutObjectCommand | GetObjectCommand,
  options: { expiresIn: number },
) => Promise<string>;

function inlineContentDisposition(filename: string): string {
  const safe = safeUploadFilename(filename).replace(/"/g, "_");
  return `inline; filename="${safe}"`;
}

export class ComposeUploads {
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly presign: Presigner;

  constructor(options?: {
    bucket?: string;
    client?: S3Client;
    presign?: Presigner;
  }) {
    this.bucket =
      options?.bucket ||
      process.env.SPEC_FACTORY_ATTACHMENT_BUCKET?.trim() ||
      `${process.env.S3_BUCKET_PREFIX || "specter"}-results`;
    this.client = options?.client ?? createS3Client();
    this.presign = options?.presign ?? (getSignedUrl as unknown as Presigner);
  }

  async createUploadUrl(input: {
    s3Prefix: string;
    sourceId: number;
    filename: string;
    mimeType: string | null;
  }): Promise<ComposeUploadTarget> {
    const s3KeyRaw = composeRawKey(
      input.s3Prefix,
      input.sourceId,
      input.filename,
    );
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: s3KeyRaw,
      ContentType: input.mimeType ?? "application/octet-stream",
    });
    const uploadUrl = await this.presign(this.client, command, {
      expiresIn: DEFAULT_EXPIRES_SECONDS,
    });
    return {
      sourceId: input.sourceId,
      uploadUrl,
      s3KeyRaw,
      expiresInSeconds: DEFAULT_EXPIRES_SECONDS,
    };
  }

  async createPreviewUrl(input: {
    s3KeyRaw: string;
    filename: string;
    mimeType: string | null;
  }): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: input.s3KeyRaw,
      ResponseContentDisposition: inlineContentDisposition(input.filename),
      ResponseContentType: input.mimeType ?? "application/octet-stream",
    });
    return this.presign(this.client, command, {
      expiresIn: DEFAULT_EXPIRES_SECONDS,
    });
  }

  async fetchRawObject(s3KeyRaw: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: s3KeyRaw }),
    );
    const body = response.Body as unknown as {
      transformToByteArray: () => Promise<Uint8Array>;
    };
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async listKeys(input: {
    prefix: string;
    continuationToken?: string;
  }): Promise<{
    keys: string[];
    objects: Array<{ key: string; lastModified: Date | null }>;
    nextContinuationToken: string | null;
  }> {
    const prefix = input.prefix.trim();
    if (!prefix) {
      throw new Error("listKeys requires a non-empty prefix");
    }
    const listed = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: input.continuationToken,
      }),
    );
    const objects = (listed.Contents ?? [])
      .map((object) => ({
        key: object.Key ?? "",
        lastModified: object.LastModified ?? null,
      }))
      .filter((object) => Boolean(object.key));
    return {
      keys: objects.map((object) => object.key),
      objects,
      nextContinuationToken: listed.IsTruncated
        ? (listed.NextContinuationToken ?? null)
        : null,
    };
  }

  async deleteKeys(keys: string[]): Promise<number> {
    const uniqueKeys = [...new Set(keys.map((key) => key.trim()))].filter(
      Boolean,
    );
    let deleted = 0;
    for (let i = 0; i < uniqueKeys.length; i += S3_DELETE_BATCH) {
      const batch = uniqueKeys.slice(i, i + S3_DELETE_BATCH);
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        }),
      );
      deleted += result.Deleted?.length ?? 0;
    }
    return deleted;
  }

  async deleteArtifactUris(artifactUris: string[]): Promise<number> {
    const keys = artifactUris.map((artifactUri) => {
      let parsed: URL;
      try {
        parsed = new URL(artifactUri);
      } catch {
        throw new Error("deleteArtifactUris requires valid s3 URIs");
      }
      if (parsed.protocol !== "s3:" || parsed.hostname !== this.bucket) {
        throw new Error("deleteArtifactUris rejected an unapproved bucket");
      }
      const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
      if (!key) throw new Error("deleteArtifactUris requires a non-empty key");
      return key;
    });
    return this.deleteKeys(keys);
  }

  /**
   * Delete every object under a session prefix (raw uploads + any derived
   * objects). Paginates ListObjectsV2 and batch-deletes up to 1000 keys at a
   * time. Returns the count deleted. Refuses a blank prefix so a misconfigured
   * caller can never trigger a bucket-wide wipe.
   */
  async deletePrefix(s3Prefix: string): Promise<number> {
    const prefix = s3Prefix.trim();
    if (!prefix) {
      throw new Error("deletePrefix requires a non-empty prefix");
    }

    let deleted = 0;
    let continuationToken: string | undefined;
    do {
      const listed = await this.listKeys({ prefix, continuationToken });
      deleted += await this.deleteKeys(listed.keys);
      continuationToken = listed.nextContinuationToken ?? undefined;
    } while (continuationToken);

    return deleted;
  }
}
