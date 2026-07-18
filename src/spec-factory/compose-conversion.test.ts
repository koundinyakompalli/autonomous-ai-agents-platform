import { describe, expect, it, vi } from "vitest";
import {
  ComposeConversionWorker,
  mediaMimeOrExt,
  isTransientConversionError,
} from "./compose-conversion.js";
import { currentSpecFactoryCorrelation } from "./telemetry/correlation.js";

function source(overrides = {}) {
  return {
    id: 7,
    sessionId: 4,
    requestId: null,
    kind: "file",
    originalFilename: "spec.pdf",
    mimeType: "application/pdf",
    sizeBytes: 10,
    sourceUrl: null,
    s3KeyRaw: "compose/4/raw/7-spec.pdf",
    converter: "markitdown",
    markdownPath: null,
    markdownContent: null,
    conversionStatus: "converting",
    conversionAttempts: 1,
    conversionLeaseExpiresAt: null,
    conversionStartedAt: null,
    errorMessage: null,
    createdAt: "x",
    updatedAt: "x",
    ...overrides,
  };
}

function buildWorker(options = {}) {
  const repo = {
    claimNextPendingSource: vi.fn(),
    getSession: vi.fn().mockResolvedValue({ id: 4, workspacePath: "/w/4" }),
    markSourceConverted: vi.fn().mockResolvedValue(undefined),
    markSourceFailed: vi.fn().mockResolvedValue(undefined),
    markSourceUnsupported: vi.fn().mockResolvedValue(undefined),
    markSourceForRetry: vi.fn().mockResolvedValue(undefined),
    createAgentTask: vi.fn().mockResolvedValue(88),
  };
  const uploads = {
    fetchRawObject: vi.fn().mockResolvedValue(Buffer.from("raw")),
  };
  const markitdown = {
    convertFile: vi.fn().mockResolvedValue("# Converted"),
    convertUrl: vi.fn().mockResolvedValue("transcript"),
  };
  const fsWriter = {
    writeMarkdown: vi.fn().mockResolvedValue("/w/4/sources/7-spec.pdf.md"),
  };
  const audio = {
    extractAudio: vi.fn().mockResolvedValue({
      segments: [Buffer.from("wav1"), Buffer.from("wav2")],
      durationSec: 90,
      segmentSeconds: 600,
      format: "mp3",
    }),
  };
  const voxtral = {
    transcribe: vi
      .fn()
      .mockResolvedValueOnce("Part one.")
      .mockResolvedValueOnce("Part two."),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const eventPublisher = {
    appendSessionEvent: vi.fn().mockResolvedValue({ id: 901 }),
  };
  const worker = new ComposeConversionWorker(
    repo as never,
    uploads as never,
    markitdown as never,
    {
      fsWriter: fsWriter as never,
      audio: audio as never,
      voxtral: voxtral as never,
      logger: logger as never,
      eventPublisher: eventPublisher as never,
      ...options,
    },
  );
  return {
    worker,
    repo,
    uploads,
    markitdown,
    fsWriter,
    audio,
    voxtral,
    logger,
    eventPublisher,
  };
}

describe("ComposeConversionWorker", () => {
  it("mediaMimeOrExt detects audio and video", () => {
    expect(mediaMimeOrExt("audio/mpeg", "x.mp3")).toBe(true);
    expect(mediaMimeOrExt(null, "clip.wav")).toBe(true);
    expect(mediaMimeOrExt("video/mp4", "demo.mp4")).toBe(true);
    expect(mediaMimeOrExt(null, "rec.mov")).toBe(true);
    expect(mediaMimeOrExt("application/pdf", "x.pdf")).toBe(false);
  });

  it("converts a file source via markitdown and marks converted", async () => {
    const { worker, repo, uploads, markitdown, fsWriter, eventPublisher } =
      buildWorker();
    await worker.convertOne(source() as never);
    expect(uploads.fetchRawObject).toHaveBeenCalledWith(
      "compose/4/raw/7-spec.pdf",
    );
    expect(markitdown.convertFile).toHaveBeenCalled();
    expect(fsWriter.writeMarkdown).toHaveBeenCalled();
    expect(repo.markSourceConverted).toHaveBeenCalledWith({
      sourceId: 7,
      markdownPath: "/w/4/sources/7-spec.pdf.md",
      markdownContent: "# Converted",
    });
    expect(eventPublisher.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 4,
      eventType: "source.conversion.started",
      payload: expect.objectContaining({
        sourceId: 7,
        kind: "file",
        path: "convert",
        attemptsMade: 1,
      }),
      actorType: "system",
      actorId: "compose-conversion-worker",
    });
    expect(eventPublisher.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 4,
      eventType: "source.conversion.completed",
      payload: expect.objectContaining({
        sourceId: 7,
        kind: "file",
        path: "convert",
        markdownPath: "/w/4/sources/7-spec.pdf.md",
        markdownChars: "# Converted".length,
      }),
      actorType: "system",
      actorId: "compose-conversion-worker",
    });
  });

  it("stores converted markdown as an immutable artifact when configured", async () => {
    const artifactStore = {
      write: vi.fn().mockResolvedValue({
        artifactUri: "s3://bucket/spec-factory/sha256/source.md",
        sha256: "a".repeat(64),
        bytes: 11,
      }),
      read: vi.fn(),
    };
    const { worker, repo, fsWriter } = buildWorker({
      artifactStore: artifactStore as never,
    });

    await worker.convertOne(source() as never);

    expect(artifactStore.write).toHaveBeenCalledWith({
      workspacePath: "sessions/4/sources/7",
      relativePath: "7-spec.pdf.md",
      content: Buffer.from("# Converted", "utf8"),
    });
    expect(fsWriter.writeMarkdown).not.toHaveBeenCalled();
    expect(repo.markSourceConverted).toHaveBeenCalledWith({
      sourceId: 7,
      markdownPath: "s3://bucket/spec-factory/sha256/source.md",
      markdownContent: "# Converted",
    });
  });

  it("measures conversion eligibility age and restores request correlation", async () => {
    const metrics = {
      recordWorkStarted: vi.fn(),
      recordWorkCompleted: vi.fn(),
    };
    const { worker, markitdown } = buildWorker({ metrics });
    markitdown.convertFile.mockImplementationOnce(async () => {
      expect(currentSpecFactoryCorrelation()).toMatchObject({
        requestId: "request-conversion-7",
        sessionId: 4,
        sourceId: 7,
      });
      return "# Converted";
    });

    await worker.convertOne(
      source({
        requestId: "request-conversion-7",
        conversionQueuedAt: "2026-07-09T10:00:00.000Z",
      }) as never,
    );

    expect(metrics.recordWorkStarted).toHaveBeenCalledWith({
      workType: "conversion",
      subtype: "file",
      queuedAt: "2026-07-09T10:00:00.000Z",
      startedAt: expect.any(Number),
    });
    expect(metrics.recordWorkCompleted).toHaveBeenCalledWith({
      workType: "conversion",
      subtype: "file",
      outcome: "succeeded",
      startedAt: expect.any(Number),
    });
  });

  it("queues source distillation after conversion when enabled", async () => {
    const { worker, repo, eventPublisher } = buildWorker({
      enqueueDistillation: true,
    });

    await worker.convertOne(source() as never);

    expect(repo.createAgentTask).toHaveBeenCalledWith({
      sessionId: 4,
      capability: "source_distillation",
      executorType: "source_distillation",
      input: {
        sourceId: 7,
        baseContextVersion: null,
      },
      priority: 80,
    });
    expect(eventPublisher.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 4,
      eventType: "task.queued",
      payload: {
        capability: "source_distillation",
        executorType: "source_distillation",
        sourceId: 7,
        baseContextVersion: null,
      },
      actorType: "system",
      actorId: "compose-conversion-worker",
      agentTaskId: 88,
      contextVersion: null,
    });
  });

  it("uses atomic source conversion completion when distillation is enabled", async () => {
    const { worker, repo, eventPublisher } = buildWorker({
      enqueueDistillation: true,
    });
    const completeSourceConversion = vi.fn().mockResolvedValue({
      distillationAgentTaskId: 88,
    });
    (
      repo as typeof repo & {
        completeSourceConversion: typeof completeSourceConversion;
      }
    ).completeSourceConversion = completeSourceConversion;

    await worker.convertOne(
      source({ contextVersionUsed: 4, originalFilename: "spec.pdf" }) as never,
    );

    expect(completeSourceConversion).toHaveBeenCalledWith({
      sourceId: 7,
      markdownPath: "/w/4/sources/7-spec.pdf.md",
      markdownContent: "# Converted",
      distillationTask: {
        sessionId: 4,
        capability: "source_distillation",
        executorType: "source_distillation",
        input: {
          sourceId: 7,
          baseContextVersion: 4,
        },
        priority: 80,
        event: {
          eventType: "task.queued",
          payload: {
            capability: "source_distillation",
            executorType: "source_distillation",
            sourceId: 7,
            baseContextVersion: 4,
          },
          actorType: "system",
          actorId: "compose-conversion-worker",
          contextVersion: 4,
        },
      },
    });
    expect(repo.markSourceConverted).not.toHaveBeenCalled();
    expect(repo.createAgentTask).not.toHaveBeenCalled();
    expect(eventPublisher.appendSessionEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "task.queued" }),
    );
  });

  it("materializes an immutable revision even when distillation is disabled", async () => {
    const { worker, repo } = buildWorker({ enqueueDistillation: false });
    const completeSourceConversion = vi.fn().mockResolvedValue({
      sourceRevisionId: 101,
      chunkCount: 1,
      distillationAgentTaskId: null,
    });
    (
      repo as typeof repo & {
        completeSourceConversion: typeof completeSourceConversion;
      }
    ).completeSourceConversion = completeSourceConversion;

    await worker.convertOne(source() as never);

    expect(completeSourceConversion).toHaveBeenCalledWith({
      sourceId: 7,
      markdownPath: "/w/4/sources/7-spec.pdf.md",
      markdownContent: "# Converted",
    });
    expect(repo.markSourceConverted).not.toHaveBeenCalled();
  });

  it("keeps converted source state when distillation enqueue fails", async () => {
    const { worker, repo, logger } = buildWorker({ enqueueDistillation: true });
    repo.createAgentTask.mockRejectedValueOnce(new Error("queue down"));

    await worker.convertOne(source() as never);

    expect(repo.markSourceConverted).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 7,
        sessionId: 4,
        error: "queue down",
      }),
      expect.stringMatching(/distillation enqueue failed/i),
    );
  });

  it("converts a youtube source via convertUrl", async () => {
    const { worker, markitdown, repo } = buildWorker();
    await worker.convertOne(
      source({
        kind: "youtube",
        sourceUrl: "https://youtu.be/x",
        s3KeyRaw: null,
        originalFilename: "https://youtu.be/x",
      }) as never,
    );
    expect(markitdown.convertUrl).toHaveBeenCalledWith("https://youtu.be/x");
    expect(repo.markSourceConverted).toHaveBeenCalled();
  });

  it("converts a confluence source via convertUrl", async () => {
    const { worker, markitdown, repo } = buildWorker();
    await worker.convertOne(
      source({
        kind: "confluence",
        sourceUrl: "https://wiki.example.com/display/PROJ/Page",
        s3KeyRaw: null,
        originalFilename: "https://wiki.example.com/display/PROJ/Page",
      }) as never,
    );
    expect(markitdown.convertUrl).toHaveBeenCalledWith(
      "https://wiki.example.com/display/PROJ/Page",
    );
    expect(repo.markSourceConverted).toHaveBeenCalled();
  });

  it("transcribes an audio source via extract-audio plus voxtral and joins segments", async () => {
    const { worker, repo, audio, voxtral } = buildWorker();
    await worker.convertOne(
      source({ mimeType: "audio/mpeg", originalFilename: "clip.mp3" }) as never,
    );
    expect(audio.extractAudio).toHaveBeenCalled();
    expect(voxtral.transcribe).toHaveBeenCalledTimes(2);
    // The format the sidecar reports (mp3) must be passed through to Voxtral so
    // the input_audio.format matches the actual bytes.
    expect(voxtral.transcribe).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      "mp3",
      expect.objectContaining({ abortSignal: expect.any(Object) }),
    );
    expect(repo.markSourceConverted).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 7,
        markdownContent: "Part one.\n\nPart two.",
      }),
    );
  });

  it("transcribes a video source with an audio track the same way", async () => {
    const { worker, audio, repo } = buildWorker();
    await worker.convertOne(
      source({ mimeType: "video/mp4", originalFilename: "demo.mp4" }) as never,
    );
    expect(audio.extractAudio).toHaveBeenCalled();
    expect(repo.markSourceConverted).toHaveBeenCalled();
  });

  it("marks media with no audio track unsupported", async () => {
    const { worker, repo, audio, voxtral, eventPublisher } = buildWorker();
    audio.extractAudio.mockResolvedValueOnce({
      segments: [],
      durationSec: 0,
      segmentSeconds: 600,
    });

    await worker.convertOne(
      source({
        mimeType: "video/mp4",
        originalFilename: "silent.mp4",
      }) as never,
    );

    expect(voxtral.transcribe).not.toHaveBeenCalled();
    expect(repo.markSourceUnsupported).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringMatching(/no audio/i),
    });
    expect(eventPublisher.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 4,
      eventType: "source.conversion.failed",
      payload: expect.objectContaining({
        sourceId: 7,
        kind: "file",
        status: "unsupported",
        retrying: false,
        errorMessage: expect.stringMatching(/no audio/i),
      }),
      actorType: "system",
      actorId: "compose-conversion-worker",
    });
  });

  it("marks failed when a segment transcription throws", async () => {
    const { worker, repo, voxtral } = buildWorker();
    voxtral.transcribe.mockReset();
    voxtral.transcribe
      .mockResolvedValueOnce("ok")
      .mockRejectedValueOnce(new Error("bedrock boom"));

    await worker.convertOne(
      source({ mimeType: "audio/wav", originalFilename: "x.wav" }) as never,
    );

    expect(repo.markSourceFailed).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringContaining("bedrock boom"),
    });
  });

  it("marks failed when markitdown throws", async () => {
    const { worker, repo, markitdown } = buildWorker();
    markitdown.convertFile.mockRejectedValueOnce(new Error("bad pdf"));
    await worker.convertOne(source() as never);
    expect(repo.markSourceFailed).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringContaining("bad pdf"),
    });
  });

  it("marks failed when a conversion exceeds the timeout and attempts are exhausted", async () => {
    const { worker, repo, markitdown } = buildWorker({
      convertTimeoutMs: 10,
      maxConversionAttempts: 4,
    });
    // convertFile hangs longer than the timeout
    markitdown.convertFile.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve("late"), 1000)),
    );
    await worker.convertOne(source({ conversionAttempts: 4 }) as never);
    expect(repo.markSourceFailed).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringMatching(/timed out/i),
    });
    expect(repo.markSourceConverted).not.toHaveBeenCalled();
  });

  it("retries (not fails) a timeout while attempts remain, since a timeout is transient", async () => {
    const { worker, repo, markitdown, eventPublisher } = buildWorker({
      convertTimeoutMs: 10,
    });
    markitdown.convertFile.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve("late"), 1000)),
    );
    await worker.convertOne(source({ conversionAttempts: 1 }) as never);
    expect(repo.markSourceForRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 7,
        errorMessage: expect.stringMatching(/timed out/i),
      }),
    );
    expect(repo.markSourceFailed).not.toHaveBeenCalled();
    expect(eventPublisher.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 4,
      eventType: "source.conversion.failed",
      payload: expect.objectContaining({
        sourceId: 7,
        kind: "file",
        status: "retrying",
        retrying: true,
        retryDelayMs: expect.any(Number),
        errorMessage: expect.stringMatching(/timed out/i),
      }),
      actorType: "system",
      actorId: "compose-conversion-worker",
    });
  });

  it("does not fail a multi-segment transcription just because total work exceeds the markitdown convert timeout", async () => {
    // Regression: the old single 300s wrapper around the whole transcribeMedia
    // loop killed long media even when every individual segment was healthy.
    // Each segment here resolves quickly; the doc-convert timeout is tiny but
    // must NOT bound the transcription path.
    const { worker, repo, voxtral } = buildWorker({
      convertTimeoutMs: 5,
      transcribeSegmentTimeoutMs: 1000,
      extractAudioTimeoutMs: 1000,
    });
    voxtral.transcribe.mockReset();
    voxtral.transcribe.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve("seg"), 20)),
    );

    await worker.convertOne(
      source({ mimeType: "audio/mpeg", originalFilename: "long.mp3" }) as never,
    );

    expect(repo.markSourceConverted).toHaveBeenCalled();
    expect(repo.markSourceFailed).not.toHaveBeenCalled();
  });

  it("fails with a per-segment timeout when a single segment hangs and attempts are exhausted", async () => {
    const { worker, repo, voxtral } = buildWorker({
      transcribeSegmentTimeoutMs: 10,
      maxConversionAttempts: 4,
    });
    voxtral.transcribe.mockReset();
    voxtral.transcribe.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve("never"), 1000)),
    );

    await worker.convertOne(
      source({
        mimeType: "audio/wav",
        originalFilename: "x.wav",
        conversionAttempts: 4,
      }) as never,
    );

    expect(repo.markSourceFailed).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringMatching(/segment.*timed out/i),
    });
    expect(repo.markSourceConverted).not.toHaveBeenCalled();
  });

  it("retries a transient Bedrock segment failure without discarding prior segments", async () => {
    const { worker, repo, audio, voxtral } = buildWorker({
      transcribeSegmentMaxAttempts: 2,
      transcribeSegmentRetryDelayMs: 0,
    });
    voxtral.transcribe.mockReset();
    voxtral.transcribe
      .mockResolvedValueOnce("Part one.")
      .mockRejectedValueOnce(new Error("ThrottlingException: rate exceeded"))
      .mockResolvedValueOnce("Part two.");

    await worker.convertOne(
      source({ mimeType: "audio/wav", originalFilename: "x.wav" }) as never,
    );

    expect(audio.extractAudio).toHaveBeenCalledTimes(1);
    expect(voxtral.transcribe).toHaveBeenCalledTimes(3);
    expect(repo.markSourceConverted).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 7,
        markdownContent: "Part one.\n\nPart two.",
      }),
    );
    expect(repo.markSourceForRetry).not.toHaveBeenCalled();
    expect(repo.markSourceFailed).not.toHaveBeenCalled();
  });

  it("fails with an extract-audio timeout when ffmpeg extraction hangs and attempts are exhausted", async () => {
    const { worker, repo, audio } = buildWorker({
      extractAudioTimeoutMs: 10,
      maxConversionAttempts: 4,
    });
    audio.extractAudio.mockReset();
    audio.extractAudio.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({ segments: [], durationSec: 0, segmentSeconds: 300 }),
            1000,
          ),
        ),
    );

    await worker.convertOne(
      source({
        mimeType: "video/mp4",
        originalFilename: "demo.mp4",
        conversionAttempts: 4,
      }) as never,
    );

    expect(repo.markSourceFailed).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringMatching(/audio extraction timed out/i),
    });
  });

  it("aborts a hung audio extraction request when its timeout fires", async () => {
    const { worker, repo, audio } = buildWorker({
      extractAudioTimeoutMs: 10,
      maxConversionAttempts: 4,
    });
    let capturedSignal: AbortSignal | undefined;
    audio.extractAudio.mockReset();
    audio.extractAudio.mockImplementationOnce(
      (_input: unknown, options?: { signal?: AbortSignal }) => {
        capturedSignal = options?.signal;
        return new Promise(() => undefined);
      },
    );

    await worker.convertOne(
      source({
        mimeType: "video/mp4",
        originalFilename: "demo.mp4",
        conversionAttempts: 4,
      }) as never,
    );

    expect(capturedSignal?.aborted).toBe(true);
    expect(repo.markSourceFailed).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringMatching(/audio extraction timed out/i),
    });
  });

  it("aborts a hung Bedrock transcription request when its timeout fires", async () => {
    const { worker, repo, voxtral } = buildWorker({
      transcribeSegmentTimeoutMs: 10,
      maxConversionAttempts: 4,
    });
    let capturedSignal: AbortSignal | undefined;
    voxtral.transcribe.mockReset();
    voxtral.transcribe.mockImplementationOnce(
      (
        _audioBase64: string,
        _format: "wav" | "mp3",
        options?: { abortSignal?: AbortSignal },
      ) => {
        capturedSignal = options?.abortSignal;
        return new Promise(() => undefined);
      },
    );

    await worker.convertOne(
      source({
        mimeType: "audio/wav",
        originalFilename: "x.wav",
        conversionAttempts: 4,
      }) as never,
    );

    expect(capturedSignal?.aborted).toBe(true);
    expect(repo.markSourceFailed).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringMatching(/segment.*timed out/i),
    });
  });

  it("logs a structured success with source id, kind, and segment count", async () => {
    const { worker, logger } = buildWorker();
    await worker.convertOne(
      source({ mimeType: "audio/mpeg", originalFilename: "clip.mp3" }) as never,
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 7, segmentCount: 2 }),
      expect.stringMatching(/converted/i),
    );
  });

  it("logs a structured error with source id and cause on failure", async () => {
    const { worker, logger, markitdown } = buildWorker();
    markitdown.convertFile.mockRejectedValueOnce(new Error("bad pdf"));
    await worker.convertOne(source() as never);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 7 }),
      expect.stringMatching(/bad pdf|conversion failed/i),
    );
  });

  it("isTransientConversionError classifies retryable vs deterministic causes", () => {
    // Transient: network/throttle/5xx/timeout/contention.
    expect(
      isTransientConversionError("ThrottlingException: rate exceeded"),
    ).toBe(true);
    expect(isTransientConversionError("ServiceUnavailableException")).toBe(
      true,
    );
    expect(isTransientConversionError("markitdown convert failed (503)")).toBe(
      true,
    );
    expect(isTransientConversionError("extract-audio failed (502)")).toBe(true);
    expect(
      isTransientConversionError(
        "Segment 1/3 transcription timed out after 120000ms",
      ),
    ).toBe(true);
    expect(isTransientConversionError("ECONNRESET")).toBe(true);
    expect(isTransientConversionError("TooManyRequestsException")).toBe(true);
    // Deterministic: bad input, unsupported, validation, auth — retry is futile.
    expect(
      isTransientConversionError("ValidationException: audio too long"),
    ).toBe(false);
    expect(isTransientConversionError("markitdown convert failed (422)")).toBe(
      false,
    );
    expect(isTransientConversionError("AccessDeniedException")).toBe(false);
    expect(
      isTransientConversionError("Lower COMPOSE_AUDIO_SEGMENT_SECONDS"),
    ).toBe(false);
    expect(
      isTransientConversionError("Audio transcription is not configured"),
    ).toBe(false);
  });

  it("schedules a backoff retry (not failed) for a transient error within the attempt budget", async () => {
    const { worker, repo, markitdown } = buildWorker();
    markitdown.convertFile.mockRejectedValueOnce(
      new Error("ThrottlingException: slow down"),
    );

    await worker.convertOne(source({ conversionAttempts: 1 }) as never);

    expect(repo.markSourceForRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 7,
        retryDelayMs: expect.any(Number),
        errorMessage: expect.stringContaining("ThrottlingException"),
      }),
    );
    expect(
      repo.markSourceForRetry.mock.calls[0][0].retryDelayMs,
    ).toBeGreaterThan(0);
    expect(repo.markSourceFailed).not.toHaveBeenCalled();
  });

  it("fails (no further retry) for a transient error once attempts are exhausted", async () => {
    const { worker, repo, markitdown } = buildWorker({
      maxConversionAttempts: 3,
    });
    markitdown.convertFile.mockRejectedValueOnce(
      new Error("503 Service Unavailable"),
    );

    await worker.convertOne(source({ conversionAttempts: 3 }) as never);

    expect(repo.markSourceFailed).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringContaining("503"),
    });
    expect(repo.markSourceForRetry).not.toHaveBeenCalled();
  });

  it("fails immediately (no retry) for a deterministic error regardless of attempts", async () => {
    const { worker, repo, markitdown } = buildWorker();
    markitdown.convertFile.mockRejectedValueOnce(
      new Error("markitdown convert failed (422): bad pdf"),
    );

    await worker.convertOne(source({ conversionAttempts: 1 }) as never);

    expect(repo.markSourceFailed).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringContaining("422"),
    });
    expect(repo.markSourceForRetry).not.toHaveBeenCalled();
  });

  it("uses exponential backoff growing with attempt number", async () => {
    const { worker: w1, repo: r1, markitdown: m1 } = buildWorker();
    m1.convertFile.mockRejectedValueOnce(new Error("ECONNRESET"));
    await w1.convertOne(source({ conversionAttempts: 1 }) as never);

    const { worker: w2, repo: r2, markitdown: m2 } = buildWorker();
    m2.convertFile.mockRejectedValueOnce(new Error("ECONNRESET"));
    await w2.convertOne(source({ conversionAttempts: 2 }) as never);

    const delay1 = r1.markSourceForRetry.mock.calls[0][0].retryDelayMs;
    const delay2 = r2.markSourceForRetry.mock.calls[0][0].retryDelayMs;
    expect(delay2).toBeGreaterThan(delay1);
  });

  it("drain() claims until none remain", async () => {
    const { worker, repo } = buildWorker();
    repo.claimNextPendingSource
      .mockResolvedValueOnce(source({ id: 1 }))
      .mockResolvedValueOnce(null);
    const spy = vi.spyOn(worker, "convertOne").mockResolvedValue(undefined);
    await worker.drain();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("drain() claims with the configured conversion lease", async () => {
    const { worker, repo } = buildWorker({ conversionLeaseMs: 123_000 });
    repo.claimNextPendingSource.mockResolvedValueOnce(null);

    await worker.drain();

    expect(repo.claimNextPendingSource).toHaveBeenCalledWith({
      leaseMs: 123_000,
    });
  });
});
