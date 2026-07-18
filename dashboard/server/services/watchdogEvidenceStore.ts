import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

function storageRegion() {
  return (
    process.env.WATCHDOG_EVIDENCE_REGION ||
    process.env.WATCHDOG_DARCI_TASK_REGION ||
    process.env.S3_TASK_REGION ||
    process.env.S3_REGION ||
    process.env.AWS_REGION ||
    "us-east-2"
  );
}

function evidenceBucket() {
  const bucketPrefix = process.env.S3_BUCKET_PREFIX || "specter";
  const configured = process.env.WATCHDOG_EVIDENCE_BUCKET;
  return (configured?.trim() ? configured : `${bucketPrefix}-watchdog-evidence`).split(/\s+#/)[0].trim();
}

function evidenceKey(input: { sessionId: string; runAttemptId: string; evidenceId: string }) {
  return [
    "watchdog",
    "evidence",
    input.sessionId,
    input.runAttemptId,
    `${input.evidenceId}.json`,
  ].join("/");
}

function client() {
  return new S3Client({ region: storageRegion() });
}

export async function putWatchdogEvidencePayload(input: {
  sessionId: string;
  runAttemptId: string;
  evidenceId: string;
  payload: unknown;
}) {
  const body = JSON.stringify(input.payload, null, 2);
  const bucket = evidenceBucket();
  const key = evidenceKey(input);
  await client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: "application/json",
    Metadata: {
      type: "watchdog_evidence",
      sessionId: input.sessionId,
      runAttemptId: input.runAttemptId,
      evidenceId: input.evidenceId,
    },
  }));
  return {
    bucket,
    key,
    sha256: createHash("sha256").update(body).digest("hex"),
    byteCount: Buffer.byteLength(body),
  };
}

async function streamToString(body: unknown) {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  const stream = body as AsyncIterable<Uint8Array>;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function getWatchdogEvidencePayload(input: { bucket: string; key: string }) {
  const response = await client().send(new GetObjectCommand({
    Bucket: input.bucket,
    Key: input.key,
  }));
  const text = await streamToString(response.Body);
  return JSON.parse(text) as unknown;
}
