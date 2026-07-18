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
    const vx = new ComposeVoxtral({
      bedrock: bedrock as never,
      modelId: "mistral.voxtral-small-24b-2507",
    });

    const out = await vx.transcribe("d2F2");

    expect(out).toBe("the transcript");
    const command = bedrock.send.mock.calls[0][0];
    const body = JSON.parse(command.input.body as string);
    expect(command.input.modelId).toBe("mistral.voxtral-small-24b-2507");
    const audioPart = body.messages[0].content.find(
      (part: { type: string }) => part.type === "input_audio",
    );
    expect(audioPart.input_audio).toEqual({ data: "d2F2", format: "wav" });
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("sends the caller-provided audio format (mp3) in the input_audio part", async () => {
    const bedrock = fakeBedrock({
      choices: [{ message: { content: "t" } }],
    });
    const vx = new ComposeVoxtral({ bedrock: bedrock as never, modelId: "m" });

    await vx.transcribe("bXAz", "mp3");

    const body = JSON.parse(bedrock.send.mock.calls[0][0].input.body as string);
    const audioPart = body.messages[0].content.find(
      (part: { type: string }) => part.type === "input_audio",
    );
    expect(audioPart.input_audio).toEqual({ data: "bXAz", format: "mp3" });
  });

  it("passes an abort signal through to Bedrock", async () => {
    const bedrock = fakeBedrock({
      choices: [{ message: { content: "the transcript" } }],
    });
    const vx = new ComposeVoxtral({ bedrock: bedrock as never, modelId: "m" });
    const controller = new AbortController();

    await vx.transcribe("d2F2", "wav", { abortSignal: controller.signal });

    expect(bedrock.send.mock.calls[0][1]).toEqual({
      abortSignal: controller.signal,
    });
  });

  it("defaults the byte limit below a 300s WAV segment (the observed prod failure)", async () => {
    // A 300s 16kHz mono pcm_s16le segment base64-encodes to ~12.8 MB, which the
    // Voxtral endpoint rejected with 'Failed to buffer the request body'. The
    // default maxRequestBytes must reject that BEFORE the call so it can't ship.
    const bedrock = fakeBedrock({ choices: [{ message: { content: "x" } }] });
    const vx = new ComposeVoxtral({ bedrock: bedrock as never, modelId: "m" });
    const wav300sBase64Len = Math.ceil((300 * 32_000 + 2) / 3) * 4; // ~12.8 MB

    await expect(
      vx.transcribe("A".repeat(wav300sBase64Len), "wav"),
    ).rejects.toThrow(/too large|limit/i);
    expect(bedrock.send).not.toHaveBeenCalled();
  });

  it("accepts a 300s MP3 segment (~3.2 MB) under the default byte limit", async () => {
    const bedrock = fakeBedrock({ choices: [{ message: { content: "ok" } }] });
    const vx = new ComposeVoxtral({ bedrock: bedrock as never, modelId: "m" });
    // 300s mp3 @ 64kbps mono ≈ 2.4 MB raw → ~3.2 MB base64.
    const mp3Base64Len = Math.ceil(((64_000 / 8) * 300 + 2) / 3) * 4;

    await expect(
      vx.transcribe("A".repeat(mp3Base64Len), "mp3"),
    ).resolves.toBe("ok");
    expect(bedrock.send).toHaveBeenCalledTimes(1);
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

  it("rejects a segment whose request payload exceeds the Bedrock byte limit, without calling Bedrock", async () => {
    const bedrock = fakeBedrock({ choices: [{ message: { content: "x" } }] });
    const vx = new ComposeVoxtral({
      bedrock: bedrock as never,
      modelId: "m",
      maxRequestBytes: 1000,
    });

    await expect(vx.transcribe("A".repeat(2000))).rejects.toThrow(
      /COMPOSE_AUDIO_SEGMENT_SECONDS/,
    );
    expect(bedrock.send).not.toHaveBeenCalled();
  });

  it("rejects a segment whose estimated audio tokens exceed the context window, without calling Bedrock", async () => {
    const bedrock = fakeBedrock({ choices: [{ message: { content: "x" } }] });
    const vx = new ComposeVoxtral({
      bedrock: bedrock as never,
      modelId: "m",
      contextWindowTokens: 100,
      maxTokens: 4,
    });

    // ~10s of 16kHz mono s16le audio: 10 * 32000 = 320000 decoded bytes
    // (~426,668 base64 chars), comfortably under the default byte limit but
    // ~440 audio tokens — over the injected 100-token window.
    const tenSecondBase64 = "A".repeat(Math.ceil((320_000 / 3) * 4));
    await expect(vx.transcribe(tenSecondBase64)).rejects.toThrow(
      /COMPOSE_AUDIO_SEGMENT_SECONDS/,
    );
    expect(bedrock.send).not.toHaveBeenCalled();
  });
});
