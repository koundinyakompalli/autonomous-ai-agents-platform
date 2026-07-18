import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const DEFAULT_MODEL_ID = "mistral.voxtral-small-24b-2507";
const DEFAULT_MAX_TOKENS = 8192;
// The Voxtral endpoint enforces its OWN request-body buffer limit, well below
// Bedrock's ~25 MB InvokeModel ceiling: a 300 s 16 kHz WAV segment (~12.8 MB
// base64) was rejected in prod with "Failed to buffer the request body: length
// limit exceeded". Default to 8 MB — comfortably above a 300 s mp3 segment
// (~3.2 MB) but below the observed-failing WAV size. Override via
// COMPOSE_VOXTRAL_MAX_REQUEST_BYTES.
const DEFAULT_MAX_REQUEST_BYTES = 8_000_000;
const DEFAULT_AUDIO_FORMAT = "wav";
// Voxtral's format enum accepts only these two (verified by live probing).
type VoxtralAudioFormat = "wav" | "mp3";
// Voxtral's context window. An over-long segment fails as a ValidationException
// because audio tokens + reserved output exceed it — guard before the round trip.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_000;
// Audio shape produced by the sidecar: 16 kHz mono pcm_s16le = 32_000 bytes/sec,
// which Voxtral bills at ~44 tokens/sec (~26,400 tokens for a 600 s segment).
const AUDIO_BYTES_PER_SECOND = 32_000;
const AUDIO_TOKENS_PER_SECOND = 44;
const TRANSCRIBE_PROMPT =
  "Transcribe this audio verbatim. Output only the transcript text, with no preamble or commentary.";

function resolveMaxRequestBytes(): number {
  const raw = Number(process.env.COMPOSE_VOXTRAL_MAX_REQUEST_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_REQUEST_BYTES;
}

interface BedrockLike {
  send: (
    command: InvokeModelCommand,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<{ body?: Uint8Array }>;
}

interface VoxtralResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

export class ComposeVoxtral {
  private readonly bedrock: BedrockLike;
  private readonly modelId: string;
  private readonly maxTokens: number;
  private readonly maxRequestBytes: number;
  private readonly contextWindowTokens: number;

  constructor(
    options: {
      bedrock?: BedrockLike;
      modelId?: string;
      region?: string;
      maxTokens?: number;
      maxRequestBytes?: number;
      contextWindowTokens?: number;
    } = {},
  ) {
    this.bedrock =
      options.bedrock ??
      new BedrockRuntimeClient({
        region:
          options.region ||
          process.env.BEDROCK_REGION ||
          process.env.AWS_REGION ||
          "us-east-2",
      });
    this.modelId =
      options.modelId ||
      process.env.COMPOSE_VOXTRAL_MODEL_ID?.trim() ||
      DEFAULT_MODEL_ID;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxRequestBytes =
      options.maxRequestBytes ?? resolveMaxRequestBytes();
    this.contextWindowTokens =
      options.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  }

  /**
   * Reject a segment that cannot succeed at Bedrock before spending the call:
   * either its base64 audio overflows the request payload cap, or its
   * estimated audio tokens plus reserved output exceed Voxtral's context
   * window. Both fail as opaque ValidationExceptions otherwise, and the fix is
   * the same — lower COMPOSE_AUDIO_SEGMENT_SECONDS so segments are shorter.
   */
  private assertSegmentFits(wavBase64: string): void {
    if (wavBase64.length > this.maxRequestBytes) {
      throw new Error(
        `Audio segment is too large for Voxtral (${wavBase64.length} base64 bytes ` +
          `> ${this.maxRequestBytes} limit). Lower COMPOSE_AUDIO_SEGMENT_SECONDS.`,
      );
    }

    // base64 decodes to ~3/4 of its length; convert to seconds, then tokens.
    const decodedBytes = Math.floor((wavBase64.length * 3) / 4);
    const estimatedAudioSeconds = decodedBytes / AUDIO_BYTES_PER_SECOND;
    const estimatedAudioTokens = Math.ceil(
      estimatedAudioSeconds * AUDIO_TOKENS_PER_SECOND,
    );
    if (estimatedAudioTokens + this.maxTokens > this.contextWindowTokens) {
      throw new Error(
        `Audio segment is too long for Voxtral (~${estimatedAudioTokens} audio tokens ` +
          `+ ${this.maxTokens} output > ${this.contextWindowTokens} context window). ` +
          `Lower COMPOSE_AUDIO_SEGMENT_SECONDS.`,
      );
    }
  }

  async transcribe(
    audioBase64: string,
    format: VoxtralAudioFormat = DEFAULT_AUDIO_FORMAT,
    options: { abortSignal?: AbortSignal } = {},
  ): Promise<string> {
    this.assertSegmentFits(audioBase64);

    const body = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: TRANSCRIBE_PROMPT },
            {
              type: "input_audio",
              input_audio: { data: audioBase64, format },
            },
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
      options.abortSignal ? { abortSignal: options.abortSignal } : undefined,
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
