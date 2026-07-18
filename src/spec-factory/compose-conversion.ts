import { promises as fs } from "fs";
import path from "path";
import { createLogger, type Logger } from "../utils/logger.js";
import type { ComposeRepository } from "./compose-database.js";
import type { ComposeUploads } from "./compose-uploads.js";
import type { MarkitdownClient } from "./compose-markitdown-client.js";
import type { ComposeAudioClient } from "./compose-audio-client.js";
import type { ComposeVoxtral } from "./compose-voxtral.js";
import type { ComposeSessionSourceSummary } from "./compose-types.js";
import type { ImmutableArtifactStore } from "./storage/immutable-s3-artifact-store.js";
import {
  specFactoryMetrics,
  type SpecFactoryMetrics,
  type SpecFactoryWorkOutcome,
} from "./telemetry/metrics.js";
import { withSpecFactorySpan } from "./telemetry/tracing.js";

type ConversionSource = ComposeSessionSourceSummary & {
  conversionQueuedAt?: string;
};

const AUDIO_EXTS = [
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".oga",
  ".flac",
  ".webm",
  ".opus",
];
const VIDEO_EXTS = [
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".avi",
  ".wmv",
  ".flv",
];
// Document conversion (markitdown /convert) is a single bounded round trip.
const DEFAULT_CONVERT_TIMEOUT_MS = 300_000;
// Audio extraction is an ffmpeg transcode in the sidecar (budgeted ~1800s
// there for hour-long media); give it room rather than the doc-convert budget.
const DEFAULT_EXTRACT_AUDIO_TIMEOUT_MS = 600_000;
// Each Voxtral segment is its own Bedrock call. Bounding PER SEGMENT (not the
// whole loop) is what lets long media transcribe — the old single wrapper
// around the entire loop failed multi-segment sources even when healthy.
const DEFAULT_TRANSCRIBE_SEGMENT_TIMEOUT_MS = 120_000;
const DEFAULT_TRANSCRIBE_SEGMENT_MAX_ATTEMPTS = 2;
const DEFAULT_TRANSCRIBE_SEGMENT_RETRY_DELAY_MS = 1_000;
// Lease must exceed the worst-case total wall clock for one source
// (extract + every segment near its timeout) so an expired lease cannot be
// reclaimed and double-processed mid-transcription. With the defaults above a
// 1h/300s-segment source is ~600s extract + 12*120s segments ≈ 2040s; 40min
// leaves headroom.
const DEFAULT_CONVERSION_LEASE_MS = 2_400_000;
// A claim increments conversion_attempts; once it reaches this many a transient
// failure stops being retried and is recorded as failed (manual reconvert).
const DEFAULT_MAX_CONVERSION_ATTEMPTS = 4;
// Exponential backoff (ms) gating the next auto-retry, indexed by attempt #.
// The gate is enforced via the conversion lease: the row stays `converting`
// with a future lease so claimNextPendingSource only re-picks it after the gate.
const DEFAULT_RETRY_BACKOFF_MS = [15_000, 60_000, 180_000];

export function mediaMimeOrExt(
  mimeType: string | null,
  filename: string | null,
): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return true;
  const name = (filename ?? "").toLowerCase();
  return [...AUDIO_EXTS, ...VIDEO_EXTS].some((ext) => name.endsWith(ext));
}

/**
 * Whether a conversion failure is worth auto-retrying. Transient = network
 * blips, throttling, 5xx, timeouts, contention — requeueing the same input can
 * succeed. Deterministic = bad/unsupported input, validation, auth, config —
 * retrying the same input fails identically, so fail fast.
 *
 * Bedrock/markitdown/ffmpeg-specific (do NOT reuse oneshot/retry-classifier:
 * its patterns target the Claude SDK, not these error strings). Default to
 * deterministic (false) when unsure so we never hot-spin a futile retry.
 */
export function isTransientConversionError(message: string): boolean {
  if (!message) return false;
  const text = message.toLowerCase();

  // Deterministic markers take precedence (a 422 carrying the word "timeout"
  // upstream is still a bad input, not a transient blip).
  if (
    /\b4\d\d\b/.test(text) || // any 4xx (400/403/415/422 …) is client/input error
    /validation|unsupported|access ?denied|forbidden|unauthorized|not configured|no audio|invalid|lower compose_audio_segment_seconds/.test(
      text,
    )
  ) {
    return false;
  }

  return /throttl|too ?many ?requests|rate ?exceed|service ?unavailable|\b5\d\d\b|timed out|timeout|econnreset|econnrefused|etimedout|socket hang up|network|temporar|throttling|503|502|504|429/.test(
    text,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withAbortableTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const running = Promise.resolve().then(() => work(controller.signal));
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([running, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

interface ConversionRepo {
  claimNextPendingSource(input?: {
    leaseMs?: number;
  }): Promise<ConversionSource | null>;
  getSession(sessionId: number): Promise<{ workspacePath: string } | null>;
  markSourceConverted(input: {
    sourceId: number;
    markdownPath: string | null;
    markdownContent: string;
  }): Promise<void>;
  completeSourceConversion?(input: {
    sourceId: number;
    markdownPath: string | null;
    markdownContent: string;
    distillationTask?: {
      sessionId: number;
      capability: string;
      executorType?: string | null;
      input: unknown;
      priority?: number;
      event: {
        eventType: string;
        payload: unknown;
        actorType?: string | null;
        actorId?: string | null;
        contextVersion?: number | null;
      };
    };
  }): Promise<{ distillationAgentTaskId?: number | null }>;
  markSourceFailed(input: {
    sourceId: number;
    errorMessage: string;
  }): Promise<void>;
  markSourceUnsupported(input: {
    sourceId: number;
    errorMessage: string;
  }): Promise<void>;
  markSourceForRetry(input: {
    sourceId: number;
    errorMessage: string;
    retryDelayMs: number;
  }): Promise<void>;
  createAgentTask?(input: {
    sessionId: number;
    capability: string;
    executorType?: string | null;
    input: unknown;
    priority?: number;
  }): Promise<number>;
}

interface FsWriter {
  writeMarkdown(input: {
    workspacePath: string;
    sourceId: number;
    filename: string;
    markdown: string;
  }): Promise<string>;
}

interface ConversionEventPublisher {
  appendSessionEvent(input: {
    sessionId: number;
    eventType: string;
    payload: unknown;
    actorType?: string | null;
    actorId?: string | null;
    agentTaskId?: number | null;
    contextVersion?: number | null;
  }): Promise<unknown>;
}

const defaultFsWriter: FsWriter = {
  async writeMarkdown({ workspacePath, sourceId, filename, markdown }) {
    const dir = path.join(workspacePath, "sources");
    await fs.mkdir(dir, { recursive: true });
    const safe = (filename.split(/[\\/]/).pop() ?? "source").replace(
      /[^A-Za-z0-9._-]/g,
      "_",
    );
    const outPath = path.join(dir, `${sourceId}-${safe}.md`);
    await fs.writeFile(outPath, markdown, "utf8");
    return outPath;
  },
};

export class ComposeConversionWorker {
  private readonly fsWriter: FsWriter;
  private readonly convertTimeoutMs: number;
  private readonly extractAudioTimeoutMs: number;
  private readonly transcribeSegmentTimeoutMs: number;
  private readonly transcribeSegmentMaxAttempts: number;
  private readonly transcribeSegmentRetryDelayMs: number;
  private readonly conversionLeaseMs: number;
  private readonly maxConversionAttempts: number;
  private readonly retryBackoffMs: number[];
  private readonly enqueueDistillation: boolean;
  private readonly audio?: Pick<ComposeAudioClient, "extractAudio">;
  private readonly voxtral?: Pick<ComposeVoxtral, "transcribe">;
  private readonly logger: Pick<Logger, "info" | "warn" | "error">;
  private readonly eventPublisher?: ConversionEventPublisher;
  private readonly artifactStore?: ImmutableArtifactStore;
  private readonly metrics: Pick<
    SpecFactoryMetrics,
    "recordWorkStarted" | "recordWorkCompleted"
  >;
  private running = false;

  constructor(
    private readonly repository: ConversionRepo &
      Pick<ComposeRepository, "claimNextPendingSource" | "markSourceForRetry">,
    private readonly uploads: Pick<ComposeUploads, "fetchRawObject">,
    private readonly markitdown: Pick<
      MarkitdownClient,
      "convertFile" | "convertUrl"
    >,
    options: {
      fsWriter?: FsWriter;
      convertTimeoutMs?: number;
      extractAudioTimeoutMs?: number;
      transcribeSegmentTimeoutMs?: number;
      transcribeSegmentMaxAttempts?: number;
      transcribeSegmentRetryDelayMs?: number;
      conversionLeaseMs?: number;
      maxConversionAttempts?: number;
      retryBackoffMs?: number[];
      enqueueDistillation?: boolean;
      audio?: Pick<ComposeAudioClient, "extractAudio">;
      voxtral?: Pick<ComposeVoxtral, "transcribe">;
      logger?: Pick<Logger, "info" | "warn" | "error">;
      eventPublisher?: ConversionEventPublisher;
      artifactStore?: ImmutableArtifactStore;
      metrics?: Pick<
        SpecFactoryMetrics,
        "recordWorkStarted" | "recordWorkCompleted"
      >;
    } = {},
  ) {
    this.fsWriter = options.fsWriter ?? defaultFsWriter;
    this.convertTimeoutMs =
      options.convertTimeoutMs ?? DEFAULT_CONVERT_TIMEOUT_MS;
    this.extractAudioTimeoutMs =
      options.extractAudioTimeoutMs ?? DEFAULT_EXTRACT_AUDIO_TIMEOUT_MS;
    this.transcribeSegmentTimeoutMs =
      options.transcribeSegmentTimeoutMs ??
      DEFAULT_TRANSCRIBE_SEGMENT_TIMEOUT_MS;
    this.transcribeSegmentMaxAttempts = Math.max(
      1,
      Math.trunc(
        options.transcribeSegmentMaxAttempts ??
          DEFAULT_TRANSCRIBE_SEGMENT_MAX_ATTEMPTS,
      ),
    );
    this.transcribeSegmentRetryDelayMs = Math.max(
      0,
      options.transcribeSegmentRetryDelayMs ??
        DEFAULT_TRANSCRIBE_SEGMENT_RETRY_DELAY_MS,
    );
    this.conversionLeaseMs =
      options.conversionLeaseMs ?? DEFAULT_CONVERSION_LEASE_MS;
    this.maxConversionAttempts =
      options.maxConversionAttempts ?? DEFAULT_MAX_CONVERSION_ATTEMPTS;
    this.retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.enqueueDistillation = options.enqueueDistillation ?? false;
    this.audio = options.audio;
    this.voxtral = options.voxtral;
    this.logger = options.logger ?? createLogger("compose-conversion");
    this.eventPublisher = options.eventPublisher;
    this.artifactStore = options.artifactStore;
    this.metrics = options.metrics ?? specFactoryMetrics;
  }

  /** Backoff (ms) before the next retry, given attempts already made. */
  private retryDelayMs(attemptsMade: number): number {
    const idx = Math.min(
      Math.max(attemptsMade - 1, 0),
      this.retryBackoffMs.length - 1,
    );
    return this.retryBackoffMs[idx];
  }

  /** Non-reentrant drain of all pending sources. */
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const source = await this.repository.claimNextPendingSource({
          leaseMs: this.conversionLeaseMs,
        });
        if (!source) return;
        await this.convertOne(source);
      }
    } finally {
      this.running = false;
    }
  }

  async convertOne(source: ConversionSource): Promise<void> {
    const startedAt = Date.now();
    this.metrics.recordWorkStarted({
      workType: "conversion",
      subtype: source.kind,
      queuedAt: source.conversionQueuedAt ?? source.createdAt,
      startedAt,
    });
    return withSpecFactorySpan(
      "conversion.execute",
      {
        requestId: source.requestId ?? undefined,
        sessionId: source.sessionId,
        sourceId: source.id,
      },
      async (span) => {
        span.setAttribute("spec_factory.source_kind", source.kind);
        await this.convertOneAttempt(source, startedAt);
      },
    );
  }

  private async convertOneAttempt(
    source: ComposeSessionSourceSummary,
    startedAt: number,
  ): Promise<void> {
    const isMedia = Boolean(
      source.s3KeyRaw &&
      mediaMimeOrExt(source.mimeType, source.originalFilename),
    );
    this.logger.info(
      {
        sourceId: source.id,
        sessionId: source.sessionId,
        kind: source.kind,
        mimeType: source.mimeType,
        sizeBytes: source.sizeBytes,
        path: isMedia ? "transcribe" : "convert",
      },
      "compose conversion started",
    );
    await this.publishConversionEvent(source, "source.conversion.started", {
      sourceId: source.id,
      kind: source.kind,
      path: isMedia ? "transcribe" : "convert",
      attemptsMade: source.conversionAttempts,
      converter: source.converter,
    });
    let segmentCount = 0;
    try {
      let markdown: string;
      if (isMedia) {
        const transcript = await this.transcribeMedia(source);
        if (transcript === null) {
          this.logger.warn(
            { sourceId: source.id, sessionId: source.sessionId },
            "compose source unsupported: no audio track",
          );
          await this.repository.markSourceUnsupported({
            sourceId: source.id,
            errorMessage: "No audio track found in the media file.",
          });
          await this.publishConversionEvent(
            source,
            "source.conversion.failed",
            {
              sourceId: source.id,
              kind: source.kind,
              path: "transcribe",
              status: "unsupported",
              retrying: false,
              errorMessage: "No audio track found in the media file.",
            },
          );
          this.recordConversionOutcome(source, startedAt, "failed");
          return;
        }
        markdown = transcript.text;
        segmentCount = transcript.segmentCount;
      } else if (
        (source.kind === "youtube" || source.kind === "confluence") &&
        source.sourceUrl
      ) {
        markdown = await withTimeout(
          this.markitdown.convertUrl(source.sourceUrl),
          this.convertTimeoutMs,
          "Conversion",
        );
      } else if (source.s3KeyRaw) {
        const bytes = await this.uploads.fetchRawObject(source.s3KeyRaw);
        markdown = await withTimeout(
          this.markitdown.convertFile({
            bytes,
            filename: source.originalFilename ?? "source",
            mimeType: source.mimeType,
          }),
          this.convertTimeoutMs,
          "Conversion",
        );
      } else {
        const errorMessage = "Source has neither an uploaded object nor a URL";
        await this.repository.markSourceFailed({
          sourceId: source.id,
          errorMessage,
        });
        await this.publishConversionEvent(source, "source.conversion.failed", {
          sourceId: source.id,
          kind: source.kind,
          path: "convert",
          status: "failed",
          retrying: false,
          errorMessage,
        });
        this.recordConversionOutcome(source, startedAt, "failed");
        return;
      }

      let markdownPath: string | null = null;
      if (this.artifactStore) {
        const artifact = await this.artifactStore.write({
          workspacePath: `sessions/${source.sessionId}/sources/${source.id}`,
          relativePath: `${source.id}-${source.originalFilename ?? "source"}.md`,
          content: Buffer.from(markdown, "utf8"),
        });
        markdownPath = artifact.artifactUri;
      } else {
        const session = await this.repository.getSession(source.sessionId);
        if (!session?.workspacePath) {
          throw new Error(
            `Compose session ${source.sessionId} has no conversion workspace`,
          );
        }
        markdownPath = await this.fsWriter.writeMarkdown({
          workspacePath: session.workspacePath,
          sourceId: source.id,
          filename: source.originalFilename ?? "source",
          markdown,
        });
      }

      await this.completeConvertedSource(source, {
        sourceId: source.id,
        markdownPath,
        markdownContent: markdown,
      });
      await this.publishConversionEvent(source, "source.conversion.completed", {
        sourceId: source.id,
        kind: source.kind,
        path: isMedia ? "transcribe" : "convert",
        markdownPath,
        markdownChars: markdown.length,
        segmentCount,
        durationMs: Date.now() - startedAt,
      });
      this.logger.info(
        {
          sourceId: source.id,
          sessionId: source.sessionId,
          kind: source.kind,
          segmentCount,
          markdownChars: markdown.length,
          durationMs: Date.now() - startedAt,
        },
        "compose source converted",
      );
      this.recordConversionOutcome(source, startedAt, "succeeded");
    } catch (error) {
      // Pipeline failure (fetch, convert, timeout, fs-write). Transient causes
      // (network/throttle/5xx/timeout) get a bounded backoff retry; everything
      // else — and exhausted transient retries — is recorded as failed.
      // markdownContent persists on success, so an EFS-write failure that lands
      // here is still recoverable via reconvert.
      const message = errorMessage(error);
      // conversion_attempts was incremented when this source was claimed, so it
      // already counts the current (failed) attempt.
      const attemptsMade = source.conversionAttempts;
      const transient = isTransientConversionError(message);
      const canRetry = transient && attemptsMade < this.maxConversionAttempts;

      if (canRetry) {
        const retryDelayMs = this.retryDelayMs(attemptsMade);
        this.logger.warn(
          {
            sourceId: source.id,
            sessionId: source.sessionId,
            kind: source.kind,
            path: isMedia ? "transcribe" : "convert",
            attemptsMade,
            maxAttempts: this.maxConversionAttempts,
            retryDelayMs,
            durationMs: Date.now() - startedAt,
            error: message,
          },
          "compose conversion transient failure; scheduling retry",
        );
        await this.repository.markSourceForRetry({
          sourceId: source.id,
          errorMessage: message,
          retryDelayMs,
        });
        await this.publishConversionEvent(source, "source.conversion.failed", {
          sourceId: source.id,
          kind: source.kind,
          path: isMedia ? "transcribe" : "convert",
          status: "retrying",
          retrying: true,
          attemptsMade,
          maxAttempts: this.maxConversionAttempts,
          retryDelayMs,
          errorMessage: message,
          durationMs: Date.now() - startedAt,
        });
        this.recordConversionOutcome(source, startedAt, "failed");
        return;
      }

      this.logger.error(
        {
          sourceId: source.id,
          sessionId: source.sessionId,
          kind: source.kind,
          path: isMedia ? "transcribe" : "convert",
          attemptsMade,
          transient,
          durationMs: Date.now() - startedAt,
          error: message,
        },
        "compose conversion failed",
      );
      await this.repository.markSourceFailed({
        sourceId: source.id,
        errorMessage: message,
      });
      await this.publishConversionEvent(source, "source.conversion.failed", {
        sourceId: source.id,
        kind: source.kind,
        path: isMedia ? "transcribe" : "convert",
        status: "failed",
        retrying: false,
        attemptsMade,
        maxAttempts: this.maxConversionAttempts,
        transient,
        errorMessage: message,
        durationMs: Date.now() - startedAt,
      });
      this.recordConversionOutcome(source, startedAt, "failed");
    }
  }

  private recordConversionOutcome(
    source: ComposeSessionSourceSummary,
    startedAt: number,
    outcome: SpecFactoryWorkOutcome,
  ): void {
    this.metrics.recordWorkCompleted({
      workType: "conversion",
      subtype: source.kind,
      outcome,
      startedAt,
    });
  }

  private async publishConversionEvent(
    source: ComposeSessionSourceSummary,
    eventType: string,
    payload: Record<string, unknown>,
    metadata: {
      agentTaskId?: number | null;
      contextVersion?: number | null;
    } = {},
  ): Promise<void> {
    if (!this.eventPublisher) return;
    try {
      const event: {
        sessionId: number;
        eventType: string;
        payload: unknown;
        actorType: string;
        actorId: string;
        agentTaskId?: number | null;
        contextVersion?: number | null;
      } = {
        sessionId: source.sessionId,
        eventType,
        payload,
        actorType: "system",
        actorId: "compose-conversion-worker",
      };
      if ("agentTaskId" in metadata) {
        event.agentTaskId = metadata.agentTaskId ?? null;
      }
      if ("contextVersion" in metadata) {
        event.contextVersion = metadata.contextVersion ?? null;
      }
      await this.eventPublisher.appendSessionEvent(event);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          sourceId: source.id,
          sessionId: source.sessionId,
          eventType,
        },
        "compose conversion event write failed",
      );
    }
  }

  private async maybeEnqueueDistillation(
    source: ComposeSessionSourceSummary,
  ): Promise<void> {
    if (!this.enqueueDistillation) return;
    if (!this.repository.createAgentTask) {
      this.logger.warn(
        { sourceId: source.id, sessionId: source.sessionId },
        "compose source distillation enqueue unavailable",
      );
      return;
    }
    try {
      const baseContextVersion = source.contextVersionUsed ?? null;
      const agentTaskId = await this.repository.createAgentTask({
        sessionId: source.sessionId,
        capability: "source_distillation",
        executorType: "source_distillation",
        input: {
          sourceId: source.id,
          baseContextVersion,
        },
        priority: 80,
      });
      await this.publishConversionEvent(
        source,
        "task.queued",
        {
          capability: "source_distillation",
          executorType: "source_distillation",
          sourceId: source.id,
          baseContextVersion,
        },
        {
          agentTaskId,
          contextVersion: baseContextVersion,
        },
      );
    } catch (error) {
      this.logger.warn(
        {
          sourceId: source.id,
          sessionId: source.sessionId,
          error: errorMessage(error),
        },
        "compose source distillation enqueue failed",
      );
    }
  }

  private async completeConvertedSource(
    source: ComposeSessionSourceSummary,
    input: {
      sourceId: number;
      markdownPath: string | null;
      markdownContent: string;
    },
  ): Promise<void> {
    const distillationTask = this.distillationTaskForSource(source);
    if (this.repository.completeSourceConversion) {
      await this.repository.completeSourceConversion({
        ...input,
        ...(distillationTask ? { distillationTask } : {}),
      });
      return;
    }

    await this.repository.markSourceConverted(input);
    await this.maybeEnqueueDistillation(source);
  }

  private distillationTaskForSource(source: ComposeSessionSourceSummary): {
    sessionId: number;
    capability: string;
    executorType: string;
    input: { sourceId: number; baseContextVersion: number | null };
    priority: number;
    event: {
      eventType: string;
      payload: {
        capability: string;
        executorType: string;
        sourceId: number;
        baseContextVersion: number | null;
      };
      actorType: string;
      actorId: string;
      contextVersion: number | null;
    };
  } | null {
    if (!this.enqueueDistillation) return null;
    const baseContextVersion = source.contextVersionUsed ?? null;
    return {
      sessionId: source.sessionId,
      capability: "source_distillation",
      executorType: "source_distillation",
      input: {
        sourceId: source.id,
        baseContextVersion,
      },
      priority: 80,
      event: {
        eventType: "task.queued",
        payload: {
          capability: "source_distillation",
          executorType: "source_distillation",
          sourceId: source.id,
          baseContextVersion,
        },
        actorType: "system",
        actorId: "compose-conversion-worker",
        contextVersion: baseContextVersion,
      },
    };
  }

  private async transcribeMedia(
    source: ComposeSessionSourceSummary,
  ): Promise<{ text: string; segmentCount: number } | null> {
    if (!this.audio || !this.voxtral) {
      throw new Error("Audio transcription is not configured");
    }
    if (!source.s3KeyRaw) {
      throw new Error("Media source has no uploaded object");
    }

    const bytes = await this.uploads.fetchRawObject(source.s3KeyRaw);
    let segments: Buffer[];
    // Codec the sidecar produced; passed to Voxtral so input_audio.format
    // matches the actual bytes (mp3 keeps segments under the request-body limit).
    let audioFormat: "wav" | "mp3" = "wav";
    try {
      // ffmpeg transcode in the sidecar — bound it on its own (longer) budget,
      // separate from the per-segment Bedrock budget below.
      const extracted = await withAbortableTimeout(
        (signal) =>
          this.audio!.extractAudio(
            {
              bytes,
              filename: source.originalFilename ?? "media",
              mimeType: source.mimeType,
            },
            { signal },
          ),
        this.extractAudioTimeoutMs,
        "Audio extraction",
      );
      segments = extracted.segments;
      audioFormat = extracted.format ?? "wav";
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes("(415)") || /no audio/i.test(message)) {
        return null;
      }
      throw error;
    }

    if (segments.length === 0) return null;

    const transcripts: string[] = [];
    for (let i = 0; i < segments.length; i += 1) {
      try {
        const text = await this.transcribeSegmentWithRetry({
          audioBase64: segments[i].toString("base64"),
          audioFormat,
          segmentIndex: i + 1,
          segmentCount: segments.length,
          source,
        });
        transcripts.push(text.trim());
      } catch (error) {
        throw new Error(
          `Transcription failed on segment ${i + 1}/${segments.length}: ${errorMessage(error)}`,
        );
      }
    }
    return { text: transcripts.join("\n\n"), segmentCount: segments.length };
  }

  private async transcribeSegmentWithRetry(input: {
    audioBase64: string;
    audioFormat: "wav" | "mp3";
    segmentIndex: number;
    segmentCount: number;
    source: ComposeSessionSourceSummary;
  }): Promise<string> {
    const maxAttempts =
      input.source.conversionAttempts >= this.maxConversionAttempts
        ? 1
        : this.transcribeSegmentMaxAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // Bound EACH segment's Bedrock call independently. The whole loop is
        // intentionally NOT wrapped in a single timeout — that previously
        // failed long, healthy media whose cumulative work outran one budget.
        return await withAbortableTimeout(
          (abortSignal) =>
            this.voxtral!.transcribe(input.audioBase64, input.audioFormat, {
              abortSignal,
            }),
          this.transcribeSegmentTimeoutMs,
          `Segment ${input.segmentIndex}/${input.segmentCount} transcription`,
        );
      } catch (error) {
        const message = errorMessage(error);
        const transient = isTransientConversionError(message);
        if (!transient || attempt >= maxAttempts) {
          throw error;
        }
        this.logger.warn(
          {
            sourceId: input.source.id,
            sessionId: input.source.sessionId,
            kind: input.source.kind,
            segmentIndex: input.segmentIndex,
            segmentCount: input.segmentCount,
            attempt,
            maxAttempts,
            retryDelayMs: this.transcribeSegmentRetryDelayMs,
            error: message,
          },
          "compose media segment transient failure; retrying",
        );
        await sleep(this.transcribeSegmentRetryDelayMs);
      }
    }
    throw new Error("Segment transcription retry loop exited unexpectedly");
  }
}
