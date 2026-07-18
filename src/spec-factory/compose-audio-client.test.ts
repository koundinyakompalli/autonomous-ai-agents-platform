import { describe, expect, it, vi } from "vitest";
import { ComposeAudioClient } from "./compose-audio-client.js";

describe("ComposeAudioClient", () => {
  it("POSTs media and returns decoded segment buffers plus duration", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        segments: ["d2F2MQ==", "d2F2Mg=="],
        durationSec: 1200,
        segmentSeconds: 600,
      }),
    });
    const client = new ComposeAudioClient(
      "http://localhost:8080",
      fetchMock as never,
    );

    const result = await client.extractAudio({
      bytes: Buffer.from("media"),
      filename: "talk.mp4",
      mimeType: "video/mp4",
    });

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0].toString("utf8")).toBe("wav1");
    expect(result.durationSec).toBe(1200);
    expect(result.segmentSeconds).toBe(600);
    // Sidecar omitted format (older build) → default to wav for back-compat.
    expect(result.format).toBe("wav");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8080/extract-audio");
    expect(init.method).toBe("POST");
  });

  it("surfaces the sidecar-reported audio format (mp3)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        segments: ["bXAz"],
        durationSec: 300,
        segmentSeconds: 300,
        format: "mp3",
      }),
    });
    const client = new ComposeAudioClient(
      "http://localhost:8080",
      fetchMock as never,
    );

    const result = await client.extractAudio({
      bytes: Buffer.from("media"),
      filename: "talk.mp4",
      mimeType: "video/mp4",
    });

    expect(result.format).toBe("mp3");
  });

  it("passes an abort signal through to the sidecar fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        segments: ["d2F2"],
        durationSec: 10,
        segmentSeconds: 300,
      }),
    });
    const client = new ComposeAudioClient(
      "http://localhost:8080",
      fetchMock as never,
    );
    const controller = new AbortController();

    await client.extractAudio(
      {
        bytes: Buffer.from("media"),
        filename: "talk.mp4",
        mimeType: "video/mp4",
      },
      { signal: controller.signal },
    );

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("throws with status and detail on non-OK", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 415,
      json: async () => ({ detail: "No audio track found in the file" }),
    });
    const client = new ComposeAudioClient(
      "http://localhost:8080",
      fetchMock as never,
    );

    await expect(
      client.extractAudio({
        bytes: Buffer.from("x"),
        filename: "a.mp4",
        mimeType: "video/mp4",
      }),
    ).rejects.toThrow(/415.*No audio track/);
  });
});
