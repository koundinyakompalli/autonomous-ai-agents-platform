# Compose Sessions — Phase 4 Audio/Video Transcription Completion

## What Shipped

- Sidecar `/extract-audio` endpoint accepts uploaded audio/video, uses `ffmpeg` to extract 16 kHz mono WAV audio, segments long media, and returns base64 WAV chunks.
- `ComposeVoxtral` invokes Bedrock directly with `mistral.voxtral-small-24b-2507` and the verified Mistral chat-completions request body.
- `ComposeAudioClient` posts media to the sidecar `/extract-audio` endpoint and returns decoded segment buffers.
- `ComposeConversionWorker` routes uploaded audio and video through extract-audio plus Voxtral, transcribes each segment, and stitches transcript chunks with blank-line separators into one markdown source.
- Media files with no audio track are marked `unsupported`; segment transcription failures mark the source `failed` so it can be retried.
- Uploaded media sources are stored with `converter = "voxtral"`; non-media uploads remain `markitdown`.
- `server.ts` wires the sidecar audio client and Voxtral client into the conversion worker.
- Terraform adds `compose_voxtral_model_id`, `compose_audio_segment_seconds`, ECS env vars, sidecar segment-size env, and the bare Voxtral foundation-model ARN to the Bedrock invoke allowlist.

## Verified Voxtral Facts

- Model id: `mistral.voxtral-small-24b-2507` without a `us.` inference-profile prefix.
- Input format accepted by the model is `wav` or `mp3`; production feeds `wav` from `ffmpeg`.
- Request shape uses `messages[0].content[]` with a text prompt and `input_audio`.
- Response transcript is read from `choices[0].message.content`.
- Measured audio budget is about 44 audio tokens per second, so the default segment size is 600 seconds.

## Verification

- `cd sidecar/markitdown && pytest -q`: 8 passed, 1 existing Starlette deprecation warning.
- `npx vitest run src/spec-factory/compose-voxtral.test.ts src/spec-factory/compose-audio-client.test.ts src/spec-factory/compose-conversion.test.ts src/spec-factory/compose-service.test.ts`: 4 files, 53 tests passed.
- `npm run build`: passed.
- `terraform fmt -check terraform`: passed.
- `npx vitest run src/spec-factory/routes.test.ts src/spec-factory/compose-routes.test.ts` outside the sandbox: 2 files, 35 tests passed.
- `npx vitest run src/spec-factory/*.test.ts` outside the sandbox: 29 files, 255 tests passed.

The broader `npx vitest run src/spec-factory` pattern is not the right gate in this workspace: it also matches `dashboard/src/spec-factory/*` and fails at the root because `jsdom` is installed under `dashboard`. In the sandbox it also cannot bind route-test servers and reports `listen EPERM 0.0.0.0`; the backend suite passes outside the sandbox with the backend-only glob.

## Deployment Notes

- No DB migration is required; `voxtral` already exists in the converter enum.
- Apply Terraform IAM/env changes before the first deployed media transcription. Without the new Bedrock allowlist entry, Voxtral invoke calls will fail with `AccessDenied`.
- Rebuild and deploy both the Spec Factory Node image and the compose-markitdown sidecar image.

## Manual Verification Path

1. Deploy sidecar image, Spec Factory image, and Terraform IAM/env changes.
2. Compose tab -> New Session -> upload an `.mp3` voice memo or `.mp4` screen recording.
3. Confirm the source badge moves through processing to ready/converted.
4. Open the generated markdown preview and confirm it contains the transcript.
5. Run Analyze Sources and confirm the transcript is included in context and chat answers.
6. Upload a video with no audio track and confirm it is shown as unsupported.

## Deferred

- Speaker diarization and timestamps.
- Translation.
- Real-time or streaming transcription.
- Additional hardening for unusual media/container edge cases.
