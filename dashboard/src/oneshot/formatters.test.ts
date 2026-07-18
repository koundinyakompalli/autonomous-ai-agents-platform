import { describe, expect, it } from "vitest";
import {
  formatElapsedClockMs,
  formatModelName,
  formatTokens,
} from "./formatters.js";

describe("formatElapsedClockMs", () => {
  it("clamps zero and negative inputs to 0:00", () => {
    expect(formatElapsedClockMs(0)).toBe("0:00");
    expect(formatElapsedClockMs(-1)).toBe("0:00");
    expect(formatElapsedClockMs(-60_000)).toBe("0:00");
  });

  it("clamps NaN and Infinity to 0:00", () => {
    expect(formatElapsedClockMs(Number.NaN)).toBe("0:00");
    expect(formatElapsedClockMs(Number.POSITIVE_INFINITY)).toBe("0:00");
  });

  it("formats sub-minute durations with a leading zero on seconds", () => {
    expect(formatElapsedClockMs(1_000)).toBe("0:01");
    expect(formatElapsedClockMs(9_000)).toBe("0:09");
    expect(formatElapsedClockMs(42_000)).toBe("0:42");
  });

  it("formats sub-hour durations as M:SS without leading zero on minutes", () => {
    expect(formatElapsedClockMs(60_000)).toBe("1:00");
    expect(formatElapsedClockMs(125_000)).toBe("2:05");
    expect(formatElapsedClockMs(3_599_000)).toBe("59:59");
  });

  it("formats hour+ durations as H:MM:SS", () => {
    expect(formatElapsedClockMs(3_600_000)).toBe("1:00:00");
    expect(formatElapsedClockMs(7_384_000)).toBe("2:03:04");
  });

  it("floors sub-second remainders", () => {
    expect(formatElapsedClockMs(999)).toBe("0:00");
    expect(formatElapsedClockMs(1_999)).toBe("0:01");
  });
});

describe("formatModelName", () => {
  it("renders friendly Anthropic and OpenAI model labels", () => {
    expect(formatModelName("us.anthropic.claude-opus-4-6-v1")).toBe(
      "Opus 4.6",
    );
    expect(formatModelName("us.anthropic.claude-sonnet-4-6")).toBe(
      "Sonnet 4.6",
    );
    expect(
      formatModelName("us.anthropic.claude-haiku-4-5-20251001-v1:0"),
    ).toBe("Haiku 4.5");
    expect(formatModelName("gpt-5.4")).toBe("GPT-5.4");
    expect(formatModelName("openai/gpt-5.4")).toBe("GPT-5.4");
  });

  it("falls back to a compact raw model id", () => {
    expect(formatModelName("vendor.example.custom-model")).toBe(
      "custom-model",
    );
    expect(formatModelName(null)).toBe("—");
  });

  it("renders all Sonnet 5 identifier variants as Sonnet 5", () => {
    expect(formatModelName("us.anthropic.claude-sonnet-5")).toBe("Sonnet 5");
    expect(formatModelName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(
      formatModelName("us.anthropic.claude-sonnet-5-20260701-v1:0"),
    ).toBe("Sonnet 5");
  });

  it("renders a friendly label for deterministic plan-contract rows", () => {
    expect(formatModelName("plan-contract-v1")).toBe("Plan Contract Check");
  });
});

describe("formatTokens", () => {
  it("clamps non-finite token values", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
  });
});
