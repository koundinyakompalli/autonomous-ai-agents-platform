import { createHash } from "node:crypto";
import path from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface ImmutableArtifactWriteInput {
  workspacePath: string;
  relativePath: string;
  content: Buffer;
}

export interface ImmutableArtifactRef {
  artifactUri: string;
  bytes: number;
  sha256: string;
}

export interface ImmutableArtifactStore {
  write(input: ImmutableArtifactWriteInput): Promise<ImmutableArtifactRef>;
  read(artifactUri: string): Promise<Buffer>;
}

export class ImmutableS3ArtifactStore implements ImmutableArtifactStore {
  constructor(
    private readonly client: Pick<S3Client, "send">,
    private readonly bucket: string,
    private readonly prefix = "spec-factory",
  ) {
    if (!bucket.trim()) throw new Error("immutable_artifact_bucket_required");
  }

  async write(
    input: ImmutableArtifactWriteInput,
  ): Promise<ImmutableArtifactRef> {
    const sha256 = createHash("sha256").update(input.content).digest("hex");
    const safeName = path.posix
      .basename(input.relativePath)
      .replace(/[^A-Za-z0-9._-]/g, "_");
    const workspaceKey = createHash("sha256")
      .update(input.workspacePath)
      .digest("hex")
      .slice(0, 16);
    const key = [
      this.prefix.replace(/^\/+|\/+$/g, ""),
      "workspaces",
      workspaceKey,
      "sha256",
      sha256.slice(0, 2),
      sha256,
      safeName,
    ]
      .filter(Boolean)
      .join("/");
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: input.content,
          ContentType: contentType(input.relativePath),
          ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
          IfNoneMatch: "*",
          Metadata: {
            sha256,
            workspace: workspaceKey,
          },
        }),
      );
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (
        Number(head.ContentLength ?? -1) !== input.content.byteLength ||
        head.Metadata?.sha256 !== sha256
      ) {
        throw new Error("immutable_artifact_collision");
      }
    }
    return {
      artifactUri: `s3://${this.bucket}/${key}`,
      bytes: input.content.byteLength,
      sha256,
    };
  }

  async read(artifactUri: string): Promise<Buffer> {
    const { bucket, key } = parseS3Uri(artifactUri);
    if (bucket !== this.bucket) throw new Error("artifact_bucket_not_allowed");
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!response.Body) throw new Error("artifact_body_missing");
    return Buffer.from(await response.Body.transformToByteArray());
  }
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) throw new Error("invalid_artifact_uri");
  return { bucket: match[1]!, key: match[2]! };
}

function isPreconditionFailure(error: unknown): boolean {
  const value = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    value?.name === "PreconditionFailed" ||
    value?.$metadata?.httpStatusCode === 412
  );
}

function contentType(relativePath: string): string {
  if (relativePath.endsWith(".json")) return "application/json";
  if (relativePath.endsWith(".md")) return "text/markdown; charset=utf-8";
  return "application/octet-stream";
}
