import { describe, expect, it, vi } from "vitest";
import { MarkitdownClient } from "./compose-markitdown-client.js";

describe("MarkitdownClient", () => {
  it("convertFile POSTs multipart and returns markdown", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ markdown: "# Hello" }),
    });
    const client = new MarkitdownClient(
      "http://localhost:8080",
      fetchMock as never,
    );
    const md = await client.convertFile({
      bytes: Buffer.from("hi"),
      filename: "a.txt",
      mimeType: "text/plain",
    });
    expect(md).toBe("# Hello");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:8080/convert");
    expect(init.method).toBe("POST");
  });

  it("convertUrl POSTs the url form field", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ markdown: "transcript" }),
    });
    const client = new MarkitdownClient(
      "http://localhost:8080",
      fetchMock as never,
    );
    const md = await client.convertUrl(" https://YOUTU.BE/x ");
    expect(md).toBe("transcript");
    const [, init] = fetchMock.mock.calls[0];
    expect((init.body as FormData).get("url")).toBe("https://youtu.be/x");
  });

  it("convertUrl rejects non-public urls before calling the sidecar", async () => {
    const fetchMock = vi.fn();
    const client = new MarkitdownClient(
      "http://localhost:8080",
      fetchMock as never,
    );
    await expect(client.convertUrl("http://example.com")).rejects.toThrow(
      /https/i,
    );
    await expect(client.convertUrl("https://10.0.0.2/wiki")).rejects.toThrow(
      /public/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws with the sidecar status + detail on non-OK", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ detail: "Conversion failed: bad zip" }),
    });
    const client = new MarkitdownClient(
      "http://localhost:8080",
      fetchMock as never,
    );
    await expect(client.convertUrl("https://x")).rejects.toThrow(
      /422.*Conversion failed/,
    );
  });
});
