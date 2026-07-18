# Compose Sessions — Phase 4 (Audio & Video Transcription) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transcribe dropped audio _and_ video sources in a Compose session into transcript `.md` via an ffmpeg sidecar endpoint (normalize → 16 kHz mono WAV, segmented) + a direct Bedrock voxtral client, through the existing per-source conversion pipeline.

**Architecture:** `compose-conversion` routes media → sidecar `POST /extract-audio` (ffmpeg, already in the image) → per-segment `compose-voxtral.transcribe` → concatenated transcript → existing `markSourceConverted` + workspace file + badge. No DB migration (`converter` enum already has `voxtral`).

**Tech Stack:** Node/TypeScript (Vitest), `@aws-sdk/client-bedrock-runtime` (already a dep), FastAPI + ffmpeg sidecar (pytest), Terraform.

**Verified ground truth (live Bedrock probing, see the design addendum + the `voxtral-bedrock-api` memory):**
- Model invoked directly by id `mistral.voxtral-small-24b-2507` (NO `us.` prefix).
- Request: `{"messages":[{"role":"user","content":[{"type":"text","text":"…"},{"type":"input_audio","input_audio":{"data":"<b64>","format":"wav"}}]}],"max_tokens":N}`.
- Response: `choices[0].message.content`. Format enum accepts **only `wav`/`mp3`** → we always feed `wav` from ffmpeg.
- ~44 audio tok/s; segment at ≤600 s to stay under the 32k ceiling.

**Gate for every Node task:** from repo root — `npm run build` (tsc, this project builds clean) and `npx vitest run src/spec-factory`. For the sidecar — `cd sidecar/markitdown && pytest`. Do NOT use the dashboard's "tsc-is-not-a-gate" rule here; the **spec-factory Node service tsc build IS a valid gate**.

**Branch:** `feat/compose-sessions-phase-4-audio` off latest `main`.

---

## Task 1: Sidecar `/extract-audio` endpoint (ffmpeg, segmented)

**Files:**
- Modify: `sidecar/markitdown/app.py`
- Test: `sidecar/markitdown/test_app.py`

The endpoint accepts a media upload, uses ffmpeg to (1) probe duration and (2) extract/transcode the audio track to 16 kHz mono WAV, split into ≤`SEGMENT_SECONDS` chunks. Returns base64 WAV segments. ffmpeg invocation is wrapped in an injectable runner so tests don't need real media or a real ffmpeg.

- [ ] **Step 1: Write the failing tests**

Append to `sidecar/markitdown/test_app.py`:

```python
import app as app_module


def _fake_runner(segments_b64, duration_sec):
    """Return a runner that bypasses real ffmpeg and yields canned output."""
    def run(_media_bytes, _suffix):
        return {"segments": segments_b64, "durationSec": duration_sec}
    return run


def test_extract_audio_returns_segments(monkeypatch):
    monkeypatch.setattr(
        app_module, "extract_audio_segments", _fake_runner(["d2F2MQ==", "d2F2Mg=="], 1200.0)
    )
    files = {"file": ("talk.mp4", b"\x00\x00fakevideo", "video/mp4")}
    res = client.post("/extract-audio", files=files)
    assert res.status_code == 200
    body = res.json()
    assert body["segments"] == ["d2F2MQ==", "d2F2Mg=="]
    assert body["durationSec"] == 1200.0
    assert body["segmentSeconds"] == app_module.SEGMENT_SECONDS


def test_extract_audio_no_track_is_415(monkeypatch):
    def run(_b, _s):
        return {"segments": [], "durationSec": 0.0}
    monkeypatch.setattr(app_module, "extract_audio_segments", run)
    files = {"file": ("silent.mp4", b"\x00\x00novoice", "video/mp4")}
    res = client.post("/extract-audio", files=files)
    assert res.status_code == 415


def test_extract_audio_too_long_is_413(monkeypatch):
    def run(_b, _s):
        return {"segments": ["x"], "durationSec": app_module.MEDIA_MAX_SECONDS + 1}
    monkeypatch.setattr(app_module, "extract_audio_segments", run)
    files = {"file": ("long.mp3", b"audio", "audio/mpeg")}
    res = client.post("/extract-audio", files=files)
    assert res.status_code == 413


def test_extract_audio_ffmpeg_error_is_422(monkeypatch):
    def run(_b, _s):
        raise RuntimeError("ffmpeg exploded")
    monkeypatch.setattr(app_module, "extract_audio_segments", run)
    files = {"file": ("bad.wav", b"audio", "audio/wav")}
    res = client.post("/extract-audio", files=files)
    assert res.status_code == 422


def test_extract_audio_missing_file_is_400():
    res = client.post("/extract-audio")
    assert res.status_code == 400
```

- [ ] **Step 2: Run; verify FAIL**

Run: `cd sidecar/markitdown && pytest -q` → the new tests fail (endpoint/symbols missing).

- [ ] **Step 3: Implement the endpoint**

Edit `sidecar/markitdown/app.py`. Add imports + config near the top (after the existing `MAX_BYTES`):

```python
import base64
import math
import subprocess


SEGMENT_SECONDS = int(os.environ.get("COMPOSE_AUDIO_SEGMENT_SECONDS", "600"))
MEDIA_MAX_SECONDS = int(os.environ.get("COMPOSE_AUDIO_MAX_SECONDS", "3600"))
MEDIA_MAX_BYTES = int(os.environ.get("COMPOSE_AUDIO_MAX_BYTES", str(500 * 1024 * 1024)))


def _ffprobe_duration(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, timeout=120,
    )
    text = (out.stdout or "").strip()
    try:
        return float(text)
    except ValueError:
        return 0.0


def extract_audio_segments(media_bytes: bytes, suffix: str) -> dict:
    """ffmpeg: probe duration, then extract/transcode the audio track to 16 kHz mono
    WAV split into <=SEGMENT_SECONDS chunks. Returns {'segments': [b64-wav,...],
    'durationSec': float}. Raises on ffmpeg failure. Empty segments => no audio track."""
    with tempfile.TemporaryDirectory() as work:
        in_path = os.path.join(work, f"input{suffix or ''}")
        with open(in_path, "wb") as fh:
            fh.write(media_bytes)

        duration = _ffprobe_duration(in_path)
        seg_pattern = os.path.join(work, "seg_%05d.wav")
        proc = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", in_path, "-vn", "-ac", "1", "-ar", "16000",
             "-c:a", "pcm_s16le", "-f", "segment", "-segment_time", str(SEGMENT_SECONDS),
             seg_pattern],
            capture_output=True, text=True, timeout=1800,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or "ffmpeg failed")

        segments = []
        for name in sorted(os.listdir(work)):
            if name.startswith("seg_") and name.endswith(".wav"):
                with open(os.path.join(work, name), "rb") as fh:
                    segments.append(base64.b64encode(fh.read()).decode("ascii"))
        return {"segments": segments, "durationSec": duration}
```

Then add the route (after `/convert`):

```python
@app.post("/extract-audio")
async def extract_audio(file: Optional[UploadFile] = File(default=None)):
    if file is None:
        raise HTTPException(status_code=400, detail="Provide a media file")

    data = await file.read()
    if len(data) > MEDIA_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Media file too large")

    name = file.filename or ""
    suffix = "." + name.rsplit(".", 1)[1] if "." in name else ""

    try:
        result = extract_audio_segments(data, suffix)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — surface ffmpeg failures as 422
        raise HTTPException(status_code=422, detail=f"Audio extraction failed: {exc}") from exc

    if result["durationSec"] > MEDIA_MAX_SECONDS:
        raise HTTPException(
            status_code=413,
            detail=f"Media too long ({result['durationSec']:.0f}s; max {MEDIA_MAX_SECONDS}s)",
        )
    if not result["segments"]:
        raise HTTPException(status_code=415, detail="No audio track found in the file")

    return {
        "segments": result["segments"],
        "durationSec": result["durationSec"],
        "segmentSeconds": SEGMENT_SECONDS,
    }
```

> Note: the duration cap is checked AFTER extraction because `_ffprobe_duration` runs inside `extract_audio_segments`; the test stubs the whole function, so the 413 path is exercised via the stub returning a large `durationSec`. (`math` import is reserved for future segment-count math; harmless if unused — remove if your linter objects.)

- [ ] **Step 4: Run; verify PASS**

Run: `cd sidecar/markitdown && pytest -q` → all tests pass (3 existing + 5 new).

- [ ] **Step 5: Commit**

```bash
git add sidecar/markitdown/app.py sidecar/markitdown/test_app.py
git commit -m "feat(compose-sidecar): add /extract-audio (ffmpeg media→segmented wav)"
```

---

## Task 2: `compose-voxtral.ts` — direct Bedrock transcription client

**Files:**
- Create: `src/spec-factory/compose-voxtral.ts`
- Test: `src/spec-factory/compose-voxtral.test.ts`

A thin client that sends the verified Mistral body via `InvokeModelCommand` and returns the transcript. The Bedrock client is injected for testability (mirrors how `MarkitdownClient` injects `fetch`).

- [ ] **Step 1: Write the failing test**

Create `src/spec-factory/compose-voxtral.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ComposeVoxtral } from "./compose-voxtral.js";

function fakeBedrock(payload: unknown) {
  return {
    send: vi.fn().mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify(payload)),
    }),
  };
}

describe("ComposeVoxtral", () => {
  it("sends the verified Mistral body and returns choices[0].message.content", async () => {
    const bedrock = fakeBedrock({
      choices: [{ message: { content: "the transcript" } }],
      usage: { total_tokens: 42 },
    });
    const vx = new ComposeVoxtral({ bedrock: bedrock as never, modelId: "mistral.voxtral-small-24b-2507" });
    const out = await vx.transcribe("d2F2");
    expect(out).toBe("the transcript");

    const command = bedrock.send.mock.calls[0][0];
    const body = JSON.parse(command.input.body as string);
    expect(command.input.modelId).toBe("mistral.voxtral-small-24b-2507");
    const audioPart = body.messages[0].content.find((p: { type: string }) => p.type === "input_audio");
    expect(audioPart.input_audio).toEqual({ data: "d2F2", format: "wav" });
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("throws when the response has no transcript content", async () => {
    const bedrock = fakeBedrock({ choices: [] });
    const vx = new ComposeVoxtral({ bedrock: bedrock as never, modelId: "m" });
    await expect(vx.transcribe("d2F2")).rejects.toThrow(/no transcript/i);
  });

  it("propagates Bedrock errors", async () => {
    const bedrock = { send: vi.fn().mockRejectedValue(new Error("AccessDenied")) };
    const vx = new ComposeVoxtral({ bedrock: bedrock as never, modelId: "m" });
    await expect(vx.transcribe("d2F2")).rejects.toThrow(/AccessDenied/);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-voxtral.test.ts` → fails (module missing).

- [ ] **Step 3: Implement**

Create `src/spec-factory/compose-voxtral.ts`:

```ts
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const DEFAULT_MODEL_ID = "mistral.voxtral-small-24b-2507";
const DEFAULT_MAX_TOKENS = 8192;
const TRANSCRIBE_PROMPT =
  "Transcribe this audio verbatim. Output only the transcript text, with no preamble or commentary.";

interface BedrockLike {
  send: (command: InvokeModelCommand) => Promise<{ body?: Uint8Array }>;
}

interface VoxtralResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class ComposeVoxtral {
  private readonly bedrock: BedrockLike;
  private readonly modelId: string;
  private readonly maxTokens: number;

  constructor(options: {
    bedrock?: BedrockLike;
    modelId?: string;
    region?: string;
    maxTokens?: number;
  } = {}) {
    this.bedrock =
      options.bedrock ??
      new BedrockRuntimeClient({
        region: options.region || process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-2",
      });
    this.modelId =
      options.modelId || process.env.COMPOSE_VOXTRAL_MODEL_ID?.trim() || DEFAULT_MODEL_ID;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  /** Transcribe one base64-encoded WAV segment. Returns the transcript text. */
  async transcribe(wavBase64: string): Promise<string> {
    const body = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: TRANSCRIBE_PROMPT },
            { type: "input_audio", input_audio: { data: wavBase64, format: "wav" } },
          ],
        },
      ],
      max_tokens: this.maxTokens,
    });

    const response = await this.bedrock.send(
      new InvokeModelCommand({
        modelId: this.modelId,
        contentType: "application/json",
        accept: "application/json",
        body,
      }),
    );

    const raw = response.body ? new TextDecoder().decode(response.body) : "";
    let parsed: VoxtralResponse;
    try {
      parsed = JSON.parse(raw) as VoxtralResponse;
    } catch {
      throw new Error(`voxtral returned non-JSON response: ${raw.slice(0, 200)}`);
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("voxtral returned no transcript content");
    }
    return content;
  }
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-voxtral.test.ts` → 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-voxtral.ts src/spec-factory/compose-voxtral.test.ts
git commit -m "feat(compose): add ComposeVoxtral direct Bedrock transcription client"
```

---

## Task 3: `compose-audio-client.ts` — sidecar `/extract-audio` client

**Files:**
- Create: `src/spec-factory/compose-audio-client.ts`
- Test: `src/spec-factory/compose-audio-client.test.ts`

Mirrors `MarkitdownClient`: injects `fetch`, POSTs multipart, returns the segment list.

- [ ] **Step 1: Write the failing test**

Create `src/spec-factory/compose-audio-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ComposeAudioClient } from "./compose-audio-client.js";

describe("ComposeAudioClient", () => {
  it("POSTs media and returns decoded segment buffers + duration", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ segments: ["d2F2MQ==", "d2F2Mg=="], durationSec: 1200, segmentSeconds: 600 }),
    });
    const client = new ComposeAudioClient("http://localhost:8080", fetchMock as never);
    const result = await client.extractAudio({
      bytes: Buffer.from("media"),
      filename: "talk.mp4",
      mimeType: "video/mp4",
    });
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].toString("utf8")).toBe("wav1");
    expect(result.durationSec).toBe(1200);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8080/extract-audio");
    expect(init.method).toBe("POST");
  });

  it("throws with status + detail on non-OK", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 415,
      json: async () => ({ detail: "No audio track found in the file" }),
    });
    const client = new ComposeAudioClient("http://localhost:8080", fetchMock as never);
    await expect(
      client.extractAudio({ bytes: Buffer.from("x"), filename: "a.mp4", mimeType: "video/mp4" }),
    ).rejects.toThrow(/415.*No audio track/);
  });
});
```

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-audio-client.test.ts`

- [ ] **Step 3: Implement**

Create `src/spec-factory/compose-audio-client.ts`:

```ts
type FetchFn = typeof fetch;

export interface ExtractAudioResult {
  segments: Buffer[];
  durationSec: number;
  segmentSeconds: number;
}

export class ComposeAudioClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async extractAudio(input: {
    bytes: Buffer;
    filename: string;
    mimeType: string | null;
  }): Promise<ExtractAudioResult> {
    const form = new FormData();
    const blob = new Blob([input.bytes], {
      type: input.mimeType ?? "application/octet-stream",
    });
    form.append("file", blob, input.filename);

    const response = await this.fetchFn(`${this.baseUrl}/extract-audio`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      let detail = "";
      try {
        const body = (await response.json()) as { detail?: string };
        detail = body?.detail ? `: ${body.detail}` : "";
      } catch {
        detail = "";
      }
      throw new Error(`extract-audio failed (${response.status})${detail}`);
    }
    const body = (await response.json()) as {
      segments?: string[];
      durationSec?: number;
      segmentSeconds?: number;
    };
    return {
      segments: (body.segments ?? []).map((b64) => Buffer.from(b64, "base64")),
      durationSec: body.durationSec ?? 0,
      segmentSeconds: body.segmentSeconds ?? 0,
    };
  }
}
```

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-audio-client.test.ts` → 2 pass.

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-audio-client.ts src/spec-factory/compose-audio-client.test.ts
git commit -m "feat(compose): add ComposeAudioClient sidecar /extract-audio client"
```

---

## Task 4: Wire media transcription into `compose-conversion.ts`

**Files:**
- Modify: `src/spec-factory/compose-conversion.ts`
- Test: `src/spec-factory/compose-conversion.test.ts`

Replace the "audio → unsupported" branch with the media transcription path; broaden routing to audio **and** video.

- [ ] **Step 1: Update the existing tests + add media cases**

In `src/spec-factory/compose-conversion.test.ts`:

(a) In `buildWorker`, add the two new injected clients to the mock set and pass them to the worker constructor:

```ts
  const audio = {
    extractAudio: vi.fn().mockResolvedValue({
      segments: [Buffer.from("wav1"), Buffer.from("wav2")],
      durationSec: 90,
      segmentSeconds: 600,
    }),
  };
  const voxtral = {
    transcribe: vi
      .fn()
      .mockResolvedValueOnce("Part one.")
      .mockResolvedValueOnce("Part two."),
  };
  const worker = new ComposeConversionWorker(
    repo as never,
    uploads as never,
    markitdown as never,
    { fsWriter: fsWriter as never, audio: audio as never, voxtral: voxtral as never, ...options },
  );
  return { worker, repo, uploads, markitdown, fsWriter, audio, voxtral };
```

(b) REPLACE the existing `it("marks audio sources unsupported (Phase 2 defers voxtral)", ...)` test with these:

```ts
  it("transcribes an audio source via extract-audio + voxtral and joins segments", async () => {
    const { worker, repo, audio, voxtral } = buildWorker();
    await worker.convertOne(source({ mimeType: "audio/mpeg", originalFilename: "memo.mp3" }) as never);
    expect(audio.extractAudio).toHaveBeenCalled();
    expect(voxtral.transcribe).toHaveBeenCalledTimes(2);
    expect(repo.markSourceConverted).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 7, markdownContent: "Part one.\n\nPart two." }),
    );
  });

  it("transcribes a video source (audio track) the same way", async () => {
    const { worker, audio, repo } = buildWorker();
    await worker.convertOne(source({ mimeType: "video/mp4", originalFilename: "demo.mp4" }) as never);
    expect(audio.extractAudio).toHaveBeenCalled();
    expect(repo.markSourceConverted).toHaveBeenCalled();
  });

  it("marks media with no audio track unsupported", async () => {
    const { worker, repo, audio, voxtral } = buildWorker();
    audio.extractAudio.mockResolvedValueOnce({ segments: [], durationSec: 0, segmentSeconds: 600 });
    await worker.convertOne(source({ mimeType: "video/mp4", originalFilename: "silent.mp4" }) as never);
    expect(voxtral.transcribe).not.toHaveBeenCalled();
    expect(repo.markSourceUnsupported).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringMatching(/no audio/i),
    });
  });

  it("marks failed when a segment transcription throws", async () => {
    const { worker, repo, voxtral } = buildWorker();
    voxtral.transcribe.mockReset();
    voxtral.transcribe.mockResolvedValueOnce("ok").mockRejectedValueOnce(new Error("bedrock boom"));
    await worker.convertOne(source({ mimeType: "audio/wav", originalFilename: "x.wav" }) as never);
    expect(repo.markSourceFailed).toHaveBeenCalledWith({
      sourceId: 7,
      errorMessage: expect.stringContaining("bedrock boom"),
    });
  });
```

(c) Update the `audioMimeOrExt` unit test to the new exported name `mediaMimeOrExt` and add video coverage:

```ts
  it("mediaMimeOrExt detects audio and video", () => {
    expect(mediaMimeOrExt("audio/mpeg", "x.mp3")).toBe(true);
    expect(mediaMimeOrExt(null, "clip.wav")).toBe(true);
    expect(mediaMimeOrExt("video/mp4", "demo.mp4")).toBe(true);
    expect(mediaMimeOrExt(null, "rec.mov")).toBe(true);
    expect(mediaMimeOrExt("application/pdf", "x.pdf")).toBe(false);
  });
```

And fix the import line: `import { ComposeConversionWorker, mediaMimeOrExt } from "./compose-conversion.js";`

- [ ] **Step 2: Run; verify FAIL**

Run: `npx vitest run src/spec-factory/compose-conversion.test.ts`

- [ ] **Step 3: Implement**

In `src/spec-factory/compose-conversion.ts`:

(a) Replace the `AUDIO_EXTS` const + `audioMimeOrExt` function with:

```ts
const AUDIO_EXTS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".oga", ".flac", ".webm", ".opus"];
const VIDEO_EXTS = [".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".wmv", ".flv"];

export function mediaMimeOrExt(
  mimeType: string | null,
  filename: string | null,
): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return true;
  const name = (filename ?? "").toLowerCase();
  return [...AUDIO_EXTS, ...VIDEO_EXTS].some((ext) => name.endsWith(ext));
}
```

(b) Add the injected client types to the constructor. Update the imports at the top:

```ts
import type { ComposeAudioClient } from "./compose-audio-client.js";
import type { ComposeVoxtral } from "./compose-voxtral.js";
```

(c) Add fields + constructor options:

```ts
export class ComposeConversionWorker {
  private readonly fsWriter: FsWriter;
  private readonly convertTimeoutMs: number;
  private readonly audio?: Pick<ComposeAudioClient, "extractAudio">;
  private readonly voxtral?: Pick<ComposeVoxtral, "transcribe">;
  private running = false;

  constructor(
    private readonly repository: ConversionRepo &
      Pick<ComposeRepository, "claimNextPendingSource">,
    private readonly uploads: Pick<ComposeUploads, "fetchRawObject">,
    private readonly markitdown: Pick<MarkitdownClient, "convertFile" | "convertUrl">,
    options: {
      fsWriter?: FsWriter;
      convertTimeoutMs?: number;
      audio?: Pick<ComposeAudioClient, "extractAudio">;
      voxtral?: Pick<ComposeVoxtral, "transcribe">;
    } = {},
  ) {
    this.fsWriter = options.fsWriter ?? defaultFsWriter;
    this.convertTimeoutMs = options.convertTimeoutMs ?? DEFAULT_CONVERT_TIMEOUT_MS;
    this.audio = options.audio;
    this.voxtral = options.voxtral;
  }
```

(d) Replace the audio branch at the top of `convertOne`'s `try` block. The whole conversion body becomes: compute `markdown` either from the media path, the youtube path, or the file path. Replace the existing audio `if (...) { markSourceUnsupported ... return; }` block AND the subsequent `let markdown` logic with:

```ts
      let markdown: string;
      if (mediaMimeOrExt(source.mimeType, source.originalFilename)) {
        markdown = await withTimeout(
          this.transcribeMedia(source),
          this.convertTimeoutMs,
          "Transcription",
        );
        if (markdown === MEDIA_NO_AUDIO) {
          await this.repository.markSourceUnsupported({
            sourceId: source.id,
            errorMessage: "No audio track found in the media file.",
          });
          return;
        }
      } else if (source.kind === "youtube" && source.sourceUrl) {
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
        await this.repository.markSourceFailed({
          sourceId: source.id,
          errorMessage: "Source has neither an uploaded object nor a URL",
        });
        return;
      }
```

(e) Add the `MEDIA_NO_AUDIO` sentinel near the other consts and the `transcribeMedia` helper method on the class:

```ts
const MEDIA_NO_AUDIO = " __COMPOSE_NO_AUDIO__";
```

```ts
  private async transcribeMedia(
    source: ComposeSessionSourceSummary,
  ): Promise<string> {
    if (!this.audio || !this.voxtral) {
      throw new Error("Audio transcription is not configured");
    }
    if (!source.s3KeyRaw) {
      throw new Error("Audio source has no uploaded object");
    }
    const bytes = await this.uploads.fetchRawObject(source.s3KeyRaw);
    const { segments } = await this.audio.extractAudio({
      bytes,
      filename: source.originalFilename ?? "media",
      mimeType: source.mimeType,
    });
    if (segments.length === 0) {
      return MEDIA_NO_AUDIO;
    }
    const transcripts: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      try {
        const text = await this.voxtral.transcribe(segments[i].toString("base64"));
        transcripts.push(text.trim());
      } catch (error) {
        throw new Error(
          `Transcription failed on segment ${i + 1}/${segments.length}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return transcripts.join("\n\n");
  }
```

> The `MEDIA_NO_AUDIO` sentinel keeps `transcribeMedia` returning a string (so it composes with `withTimeout<string>`), while letting the caller distinguish "no audio track" (→ unsupported) from a real transcript. A genuine transcript can't collide (it starts with a NUL byte).

- [ ] **Step 4: Run; verify PASS**

Run: `npx vitest run src/spec-factory/compose-conversion.test.ts` → all pass (existing markitdown/youtube/timeout/drain + 4 new media cases + updated `mediaMimeOrExt`).

- [ ] **Step 5: Commit**

```bash
git add src/spec-factory/compose-conversion.ts src/spec-factory/compose-conversion.test.ts
git commit -m "feat(compose): transcribe audio+video sources via extract-audio + voxtral"
```

---

## Task 5: Wire the clients in `server.ts`

**Files:**
- Modify: `src/spec-factory/server.ts`

- [ ] **Step 1: Add imports** (with the other compose imports near the top):

```ts
import { ComposeVoxtral } from "./compose-voxtral.js";
import { ComposeAudioClient } from "./compose-audio-client.js";
```

- [ ] **Step 2: Construct the clients and pass them to the worker.**

Replace the existing `composeConversionWorker` construction:

```ts
  const composeAudioClient = new ComposeAudioClient(
    process.env.COMPOSE_MARKITDOWN_URL?.trim() || "http://localhost:8080",
  );
  const composeVoxtral = new ComposeVoxtral({
    modelId: process.env.COMPOSE_VOXTRAL_MODEL_ID?.trim() || undefined,
  });
  const composeConversionWorker = new ComposeConversionWorker(
    composeRepository,
    composeUploads,
    markitdownClient,
    { audio: composeAudioClient, voxtral: composeVoxtral },
  );
```

- [ ] **Step 3: Verify build + full spec-factory suite**

Run: `npm run build` (tsc clean) and `npx vitest run src/spec-factory` (all green — the worker's new ctor args are optional so nothing else breaks).

- [ ] **Step 4: Commit**

```bash
git add src/spec-factory/server.ts
git commit -m "feat(compose): wire voxtral + audio sidecar clients into the conversion worker"
```

---

## Task 6: Terraform — IAM allowlist + env vars

**Files:**
- Modify: `terraform/variables.tf`
- Modify: `terraform/iam.tf`
- Modify: `terraform/spec-factory-ecs.tf`

- [ ] **Step 1: Add variables.**

Append to `terraform/variables.tf`:

```hcl
variable "compose_voxtral_model_id" {
  description = "Bedrock model id for Compose audio/video transcription (invoked directly, no us. profile prefix)"
  type        = string
  default     = "mistral.voxtral-small-24b-2507"
}

variable "compose_audio_segment_seconds" {
  description = "Max seconds of audio per voxtral request; ffmpeg segments longer media into chunks of this size"
  type        = number
  default     = 600
}
```

- [ ] **Step 2: Add the voxtral foundation-model ARN to the spec-factory Bedrock allowlist.**

In `terraform/iam.tf`, inside the `task_bedrock_claude_sdk` policy's `Resource = concat(...)`, add a new conditional block (after the `spec_factory_model_id` block, before the closing `)`):

```hcl
          trimspace(var.compose_voxtral_model_id) != "" ? [
            # Compose audio/video transcription — invoked by bare model id (no inference profile)
            "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.compose_voxtral_model_id}",
          ] : [],
```

> Note: voxtral has NO `us.` inference profile — only the `foundation-model` ARN. Do not add an `inference-profile/` line for it.

- [ ] **Step 3: Add the container env vars.**

In `terraform/spec-factory-ecs.tf`, in the spec-factory container's `environment` list (after the `COMPOSE_MARKITDOWN_URL` entry — add a comma to that line):

```hcl
        { name = "COMPOSE_MARKITDOWN_URL", value = "http://localhost:8080" },
        { name = "COMPOSE_VOXTRAL_MODEL_ID", value = var.compose_voxtral_model_id },
        { name = "COMPOSE_AUDIO_SEGMENT_SECONDS", value = tostring(var.compose_audio_segment_seconds) }
```

And in the `compose-markitdown` sidecar container, add an `environment` block (it currently has none) so the sidecar honors the same segment size:

```hcl
      environment = [
        { name = "COMPOSE_AUDIO_SEGMENT_SECONDS", value = tostring(var.compose_audio_segment_seconds) }
      ]
```

- [ ] **Step 4: Validate.**

Run: `cd terraform && terraform fmt && terraform validate` (validate may require init; `terraform fmt -check` at minimum must pass). Record output.

- [ ] **Step 5: Commit**

```bash
git add terraform/variables.tf terraform/iam.tf terraform/spec-factory-ecs.tf
git commit -m "feat(compose): terraform voxtral IAM + audio transcription env vars"
```

---

## Task 7: Completion notes

**Files:**
- Create: `docs/superpowers/plans/2026-06-03-compose-sessions-phase-4-COMPLETION.md`

- [ ] **Step 1: Full verification.**

Run from repo root: `npm run build` and `npx vitest run src/spec-factory` (record counts). Run `cd sidecar/markitdown && pytest -q` (record counts).

- [ ] **Step 2: Write the completion doc** covering: what shipped (sidecar `/extract-audio` ffmpeg endpoint with segmentation; `ComposeVoxtral`; `ComposeAudioClient`; conversion worker media path audio+video with chunk+stitch; server wiring; terraform IAM+env); the verified voxtral facts (wav/mp3-only, request/response shape, ~44 tok/s); test/build results; the **deploy order caveat (apply IAM before first transcription)**; that there's no migration; the deferred items (diarization, translation, streaming). Include a manual verification path:

```
1. Deploy (sidecar image + spec-factory image rebuilt; terraform IAM+env applied).
2. Compose tab → New Session → drop an .mp3 voice memo or an .mp4 screen recording.
3. Badge: converting → converted. Open the workspace source .md → it holds the transcript.
4. Analyze Sources → the transcript is part of the agent's context; chat references it.
5. Long media (>10 min) is split + stitched into one transcript; a file with no audio track shows "unsupported — no audio track".
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-06-03-compose-sessions-phase-4-COMPLETION.md
git commit -m "docs(compose): Phase 4 audio/video transcription completion notes"
```

---

## Self-Review

**1. Spec coverage** (design addendum `2026-06-03-compose-phase-4-audio-design.md`):
- ffmpeg `/extract-audio` segmented endpoint → Task 1. ✓
- Direct voxtral Bedrock client (verified body) → Task 2. ✓
- Sidecar client → Task 3. ✓
- Conversion worker media routing (audio+video), chunk+stitch, no-audio→unsupported, segment-fail→failed → Task 4. ✓
- Server wiring → Task 5. ✓
- IAM allowlist (bare ARN, no `us.`) + env vars + segment var → Task 6. ✓
- Scope decision 1 (audio+video) → `mediaMimeOrExt` + VIDEO_EXTS (Task 4). ✓
- Scope decision 2 (chunk+stitch) → ffmpeg `-f segment` (Task 1) + per-segment loop join (Task 4). ✓
- Guardrails (segment budget, total cap, timeout, partial-fail policy) → Tasks 1 + 4. ✓

**2. Placeholder scan:** every code/test step contains complete code. No TBD/TODO. The `math` import note in Task 1 is flagged as removable.

**3. Type consistency:** `ComposeVoxtral.transcribe(wavBase64: string): Promise<string>` (Task 2) ← called with `segments[i].toString("base64")` (Task 4). `ComposeAudioClient.extractAudio({bytes,filename,mimeType}): Promise<{segments: Buffer[], durationSec, segmentSeconds}>` (Task 3) ← consumed in Task 4 + constructed in Task 5. Worker ctor new optional `{audio, voxtral}` (Task 4) ← passed in Task 5 + tests (Task 4). `mediaMimeOrExt` rename consistent across Task 4 impl + test. `COMPOSE_VOXTRAL_MODEL_ID` / `COMPOSE_AUDIO_SEGMENT_SECONDS` consistent across server (Task 5) + terraform (Task 6) + sidecar (Task 1). ✓

**Deploy dependency:** IAM (Task 6) must be applied before the first media transcription, else InvokeModel → AccessDenied. Noted in the completion doc (Task 7).
