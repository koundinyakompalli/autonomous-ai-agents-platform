# Compose Sessions — Phase 4: Audio & Video Transcription (Design Addendum)

> Addendum to `2026-06-02-compose-sessions-design.md`. Phases 1–3b are merged. This
> resolves the one open question that design deferred to planning ("confirm how audio
> bytes are supplied to voxtral") — answered authoritatively by **live Bedrock probing**
> on 2026-06-03 — and records two scope decisions the operator made.

## Goal

Turn dropped **audio _and_ video** files in a Compose session into transcript `.md`
sources, so spoken material (voice memos, meeting captures, Loom/screen recordings)
becomes first-class context for the clarification agent and the draft — through the same
per-source pipeline, badges, and workspace files every other source already uses.

## Verified facts (live `bedrock-runtime invoke-model` probes, us-east-2, acct 323960442001)

- `mistral.voxtral-small-24b-2507` is **invoked directly by model ID** — NO `us.`
  inference-profile prefix (unlike Claude models).
- **Request body is OpenAI/Mistral chat-completions style:**
  ```json
  {"messages":[{"role":"user","content":[
     {"type":"text","text":"Transcribe this audio verbatim. Output only the transcript."},
     {"type":"input_audio","input_audio":{"data":"<base64>","format":"wav"}}
  ]}],"max_tokens":N}
  ```
- **Response:** `choices[0].message.content` (string). Cost in
  `usage.{prompt_tokens,completion_tokens,total_tokens}`.
- **`format` is a STRICT ENUM — only `"wav"` and `"mp3"` are accepted.** Every other
  string (`m4a, aac, ogg, opus, flac, webm, mp4, mpeg, pcm`) is rejected at JSON
  deserialize ("value did not match any expected variant"), _before_ any byte decode.
- **Token cost ≈ 44 audio tokens/second** (measured: 8.6 s speech → ~382 prompt tokens).
  Voxtral's 32k context ⇒ **~12 minutes of audio per request** is the binding limit
  (also bounded by the Bedrock InvokeModel inline-payload size limit).
- **End-to-end proven, including video:** a clean containerized `ffmpeg` demuxed the audio
  track out of an `.mp4` (mpeg4 video + aac audio), transcoded it to 16 kHz mono WAV, and
  voxtral returned a verbatim, correct transcript. The exact production chain works.

(Recorded in agent memory as `voxtral-bedrock-api` for future reference.)

## Scope decisions (operator, 2026-06-03)

1. **Inputs accepted: audio _and_ video.** ffmpeg normalizes ANY recognized audio
   (`wav/mp3/m4a/aac/ogg/flac/webm`) or video (`mp4/mov/webm/mkv/avi/m4v`) by extracting
   and transcoding its audio track to 16 kHz mono WAV before voxtral.
2. **Long media: chunk + stitch (full length).** Media longer than the per-request audio
   budget is split by ffmpeg into ≤10-minute segments; each segment is transcribed; the
   transcripts are concatenated in order into one `.md`. Hour-long recordings are supported.

## Architecture

```
upload (audio|video)  ──▶  compose-conversion worker
                              │  (routes media → voxtral path)
                              ▼
                       sidecar  POST /extract-audio   (ffmpeg)
                              │   multipart media in → { segments:[wav-b64,…], durationSec }
                              ▼
                       compose-voxtral.ts  (BedrockRuntimeClient + InvokeModelCommand)
                              │   one InvokeModel per segment, concatenate
                              ▼
                       transcript .md  → workspace/sources/<id>-<name>.md  +  markdownContent (DB)
                              │
                              ▼
                       markSourceConverted  → badge: converted   (Sources panel, unchanged)
```

### Components

| Component | Change |
|---|---|
| `sidecar/markitdown/app.py` | New stateless `POST /extract-audio`: accept a media upload, run ffmpeg to (a) probe duration and (b) extract/transcode the audio track to 16 kHz mono WAV, segmenting into ≤`SEGMENT_SECONDS` (default 600) chunks. Return `{ segments: [base64-wav,…], durationSec, segmentSeconds }`. 415 if no audio track; 413 over a size/duration cap; 422 on ffmpeg failure. (ffmpeg is **already** in `Dockerfile.compose-markitdown`.) |
| `sidecar/markitdown/requirements.txt` | unchanged (ffmpeg is an OS package, not pip). |
| `src/spec-factory/compose-voxtral.ts` (new) | Thin `BedrockRuntimeClient` + `InvokeModelCommand` client. `transcribe(wavBase64) → string` using the verified Mistral body; injected `bedrock` + `modelId` for testability (mirrors `MarkitdownClient`'s injected `fetch`). Surfaces Bedrock errors with status/detail. |
| `src/spec-factory/compose-audio-client.ts` (new) | Thin `fetch` client for the sidecar `POST /extract-audio` (mirrors `MarkitdownClient`): `extractAudio({bytes,filename,mimeType}) → { segments: Buffer[]/base64[], durationSec }`. |
| `src/spec-factory/compose-conversion.ts` | Replace the "audio → unsupported" branch. New routing: audio **or** video → extract-audio → for each segment `voxtral.transcribe` → join with `\n\n` → write markdown (existing fsWriter + `markSourceConverted`). Extend `audioMimeOrExt` into `mediaMimeOrExt` (audio + video exts/mimes). Reuse the existing per-source `withTimeout` and `failed`/`unsupported` paths. A media file whose extract yields zero segments / no audio track → `unsupported` ("no audio track found"). |
| `src/spec-factory/server.ts` | Construct `ComposeVoxtral` (model id from `COMPOSE_VOXTRAL_MODEL_ID`) and `ComposeAudioClient` (sidecar URL, reuse `COMPOSE_MARKITDOWN_URL`); pass both into `ComposeConversionWorker` (new optional ctor args — default-constructed so existing tests/wiring stay green). |
| `terraform/variables.tf` | New `compose_voxtral_model_id` (default `mistral.voxtral-small-24b-2507`) + `compose_audio_segment_seconds` (default 600). |
| `terraform/iam.tf` | Add to the spec-factory Bedrock `InvokeModel` allowlist (gated on the var, bare foundation-model ARN, **no** `us.` profile): `arn:aws:bedrock:${region}::foundation-model/${compose_voxtral_model_id}`. |
| `terraform/spec-factory-ecs.tf` | New container env: `COMPOSE_VOXTRAL_MODEL_ID`, `COMPOSE_AUDIO_SEGMENT_SECONDS`. Sidecar gets `SEGMENT_SECONDS` + a media size cap env. |

### Routing & converter value

`converter='voxtral'` (already in the `compose_session_sources.converter` enum and
`ComposeConverterSchema`) is recorded for media sources. No migration needed.

### Guardrails

- **Per-request audio budget:** `COMPOSE_AUDIO_SEGMENT_SECONDS` (default 600 s = 10 min)
  keeps each voxtral call well under the ~12-min/32k-context ceiling.
- **Total media cap:** sidecar rejects (413) media over a duration cap
  (`MEDIA_MAX_SECONDS`, default 3600) and over the existing byte cap, so a runaway file
  can't fan out into hundreds of segments.
- **Per-source conversion timeout:** the existing `convertTimeoutMs` in the worker bounds
  the whole extract+transcribe chain; on overrun the source is marked `failed` (retryable).
- **Partial-failure policy:** if any segment transcription fails, the source is marked
  `failed` with the segment index in the message (retry re-runs the whole source) — simpler
  and correct vs. emitting a half transcript that silently drops content.

## Testing

- **Sidecar (`test_app.py`):** `/extract-audio` happy path (mock/stub ffmpeg via a fake
  runner so CI needs no real media), no-audio-track → 415, oversize → 413, ffmpeg error → 422.
- **`compose-voxtral.test.ts`:** builds the exact verified request body; parses
  `choices[0].message.content`; surfaces non-OK Bedrock errors. (Injected fake `bedrock`
  client — no network.)
- **`compose-audio-client.test.ts`:** POSTs multipart to `/extract-audio`; returns segments;
  throws with status+detail on non-OK (mirrors `compose-markitdown-client.test.ts`).
- **`compose-conversion.test.ts` (extend):** media source → extract→transcribe→converted
  (single + multi-segment join); no-audio-track → unsupported; segment failure → failed;
  the existing markitdown/youtube/timeout cases stay green; `mediaMimeOrExt` covers audio+video.
- **Gate:** `npm run build` (tsc) + `npx vitest run src/spec-factory` for Node;
  `pytest` in `sidecar/markitdown` for the sidecar. (`tsc --noEmit` is the gate for the
  Node service — that project builds clean, unlike the dashboard.)

## Deployment

- **Migrations:** none (the `converter` enum already includes `voxtral`).
- **Image:** the sidecar image rebuilds with the new endpoint (ffmpeg already present); the
  spec-factory Node image rebuilds with the voxtral/audio clients. Normal CI build + ECS
  redeploy on merge.
- **Terraform:** apply the IAM allowlist addition + the two new env vars. **IAM must be
  applied before the first media transcription** or InvokeModel returns AccessDenied.

## Out of scope (deferred)

- Speaker diarization / timestamps (voxtral returns a flat transcript).
- Translation (transcribe in source language only).
- Real-time/streaming transcription (batch per-source only).
- Format hardening for exotic edge cases (very large ZIPs, EPub quirks) — separate work.
