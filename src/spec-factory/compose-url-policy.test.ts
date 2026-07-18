import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeConfluenceUrl,
  normalizePublicHttpsUrl,
  normalizeYoutubeUrl,
} from "./compose-url-policy.js";

describe("compose URL policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes public https URLs", () => {
    expect(
      normalizePublicHttpsUrl(" https://Example.com/display/Page ", {
        label: "Source",
      }),
    ).toBe("https://example.com/display/Page");
  });

  it("rejects non-https URLs", () => {
    expect(() =>
      normalizePublicHttpsUrl("http://example.com", { label: "Source" }),
    ).toThrow(/https/i);
  });

  it("rejects URLs with credentials", () => {
    expect(() =>
      normalizePublicHttpsUrl("https://user:pass@example.com", {
        label: "Source",
      }),
    ).toThrow(/credentials/i);
  });

  it("rejects local and private IP hosts", () => {
    expect(() =>
      normalizePublicHttpsUrl("https://localhost/doc", { label: "Source" }),
    ).toThrow(/public/i);
    expect(() =>
      normalizePublicHttpsUrl("https://169.254.169.254/latest", {
        label: "Source",
      }),
    ).toThrow(/public/i);
    expect(() =>
      normalizePublicHttpsUrl("https://[::1]/doc", { label: "Source" }),
    ).toThrow(/public/i);
  });

  it("limits youtube sources to youtube hosts", () => {
    expect(normalizeYoutubeUrl("https://www.youtube.com/watch?v=abc")).toBe(
      "https://www.youtube.com/watch?v=abc",
    );
    expect(normalizeYoutubeUrl("https://youtu.be/abc")).toBe(
      "https://youtu.be/abc",
    );
    expect(() =>
      normalizeYoutubeUrl("https://example.com/watch?v=abc"),
    ).toThrow(/not allowed/i);
  });

  it("can lock confluence sources to configured host suffixes", () => {
    vi.stubEnv("COMPOSE_CONFLUENCE_ALLOWED_HOST_SUFFIXES", "atlassian.net");
    expect(
      normalizeConfluenceUrl("https://team.atlassian.net/wiki/spaces/A"),
    ).toBe("https://team.atlassian.net/wiki/spaces/A");
    expect(() =>
      normalizeConfluenceUrl("https://wiki.example.com/display/A"),
    ).toThrow(/not allowed/i);
  });
});
