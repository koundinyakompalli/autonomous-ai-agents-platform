import { bufferToBlobPart } from "../utils/blob.js";

type FetchFn = typeof fetch;

export type ComposeAudioFormat = "wav" | "mp3";

export interface ExtractAudioResult {
  segments: Buffer[];
  durationSec: number;
  segmentSeconds: number;
  /** Codec of the returned segment bytes — must match the Voxtral format enum. */
  format: ComposeAudioFormat;
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
  }, options: { signal?: AbortSignal } = {}): Promise<ExtractAudioResult> {
    const form = new FormData();
    const blob = new Blob([bufferToBlobPart(input.bytes)], {
      type: input.mimeType ?? "application/octet-stream",
    });
    form.append("file", blob, input.filename);

    const response = await this.fetchFn(`${this.baseUrl}/extract-audio`, {
      method: "POST",
      body: form,
      signal: options.signal,
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
      format?: string;
    };
    // The sidecar reports the codec it produced. Default to "wav" when absent
    // for back-compat with an older sidecar (which only ever emitted wav); the
    // updated sidecar emits "mp3" to fit the Voxtral request-body limit.
    const format: ComposeAudioFormat = body.format === "mp3" ? "mp3" : "wav";
    return {
      segments: (body.segments ?? []).map((segment) =>
        Buffer.from(segment, "base64"),
      ),
      durationSec: body.durationSec ?? 0,
      segmentSeconds: body.segmentSeconds ?? 0,
      format,
    };
  }
}
