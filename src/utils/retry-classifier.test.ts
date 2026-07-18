import { describe, expect, it } from "vitest";
import {
  isDeterministicError,
  isTransientError,
} from "./retry-classifier.js";

describe("isTransientError", () => {
  describe("transient categories", () => {
    const transientCases: Array<[string, string]> = [
      ["throttling word", "Bedrock throttling exception, please retry"],
      ["explicit Throttling", "ThrottlingException raised by upstream"],
      ["too many requests", "429 too many requests"],
      ["bare 429", "Upstream returned 429"],
      ["service unavailable", "503 service unavailable"],
      ["bare 5xx (502)", "Bad gateway: 502"],
      ["bare 5xx (504)", "Gateway timed out: 504"],
      ["timeout word", "Request timed out after 30s"],
      ["timeout shorthand", "operation timeout exceeded"],
      ["ECONNRESET", "ECONNRESET: socket hang up"],
      ["lowercase econnreset", "fetch failed: econnreset"],
      ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432"],
      ["ETIMEDOUT", "connect ETIMEDOUT upstream"],
      ["socket hang up", "Error: socket hang up"],
      ["network word", "network error during upload"],
      ["temporary failure", "temporary failure in name resolution"],
      ["rate exceeded", "rate exceeded for InvokeModel"],
    ];

    it.each(transientCases)("classifies %s as transient", (_, msg) => {
      expect(isTransientError(msg)).toBe(true);
    });
  });

  describe("deterministic categories (must NOT be transient)", () => {
    const deterministicCases: Array<[string, string]> = [
      ["validation", "Validation error: missing field"],
      ["4xx 400", "HTTP 400 Bad Request"],
      ["4xx 403", "HTTP 403 Forbidden"],
      ["4xx 415", "HTTP 415 Unsupported Media Type"],
      ["4xx 422", "HTTP 422 unprocessable entity"],
      ["auth/unauthorized", "Unauthorized: token expired"],
      ["forbidden", "Forbidden: caller may not access resource"],
      ["access denied", "AccessDenied: not allowed"],
      ["unsupported", "Unsupported audio format"],
      ["not configured", "Bedrock model not configured"],
      ["invalid", "invalid input shape"],
    ];

    it.each(deterministicCases)("classifies %s as NOT transient", (_, msg) => {
      expect(isTransientError(msg)).toBe(false);
    });
  });

  it("treats messages mixing deterministic + transient phrases as deterministic (deterministic markers win)", () => {
    // A 422 carrying the word "timeout" upstream is still bad input, not a blip.
    expect(
      isTransientError("HTTP 422 validation: upstream timeout payload"),
    ).toBe(false);
  });

  it("defaults to NOT transient for empty / unknown / ambiguous inputs (no hot-spin)", () => {
    expect(isTransientError("")).toBe(false);
    expect(isTransientError("totally unrelated text")).toBe(false);
    expect(isTransientError(undefined as unknown as string)).toBe(false);
    expect(isTransientError(null as unknown as string)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isTransientError("THROTTLING EXCEPTION")).toBe(true);
    expect(isTransientError("ECONNRESET")).toBe(true);
  });
});

describe("isDeterministicError", () => {
  describe("explicit OneShot-derived deterministic markers", () => {
    // Patterns carried over from src/oneshot/retry-classifier.ts so callers
    // that adopt this module preserve OneShot's deterministic semantics.
    it("matches Claude Code output-token cap overflow", () => {
      expect(
        isDeterministicError(
          "Claude's response exceeded the 4096 output token maximum",
        ),
      ).toBe(true);
      expect(
        isDeterministicError("response exceeded the 200000 output token maximum"),
      ).toBe(true);
    });

    it("matches schema_invalid_after_success", () => {
      expect(
        isDeterministicError(
          "Planner structured output failed: schema_invalid_after_success",
        ),
      ).toBe(true);
    });

    it("matches structured_output_retries_exhausted", () => {
      expect(
        isDeterministicError(
          "Provider structured_output_retries_exhausted after 3 repairs",
        ),
      ).toBe(true);
    });

    it("matches retrofit deterministic outcomes", () => {
      expect(
        isDeterministicError(
          "already_applied: source change is patch-equivalent on target",
        ),
      ).toBe(true);
      expect(
        isDeterministicError(
          "retrofit_branch_mismatch: target does not match run branch",
        ),
      ).toBe(true);
      expect(
        isDeterministicError(
          "retrofit_source_branch_missing: not found on origin",
        ),
      ).toBe(true);
    });
  });

  describe("general deterministic markers (validation / auth / 4xx / unsupported)", () => {
    it.each([
      ["validation", "Validation failed on field"],
      ["4xx", "HTTP 422 unprocessable entity"],
      ["unauthorized", "Unauthorized: token expired"],
      ["access denied", "AccessDenied: caller cannot read"],
      ["unsupported", "unsupported media type"],
      ["not configured", "voxtral model not configured"],
    ])("matches %s", (_, msg) => {
      expect(isDeterministicError(msg)).toBe(true);
    });
  });

  describe("transient inputs are NOT deterministic", () => {
    it.each([
      "Bedrock throttling exception",
      "503 service unavailable",
      "ECONNRESET: socket hang up",
      "operation timeout",
      "temporary failure in name resolution",
    ])("returns false for %s", (msg) => {
      expect(isDeterministicError(msg)).toBe(false);
    });
  });

  it("returns false for empty / unknown messages (consistent with OneShot semantics)", () => {
    // OneShot's isDeterministicFailure returns false on empty; we preserve that
    // so callers can distinguish "known deterministic" from "unknown".
    expect(isDeterministicError("")).toBe(false);
    expect(isDeterministicError(undefined as unknown as string)).toBe(false);
    expect(isDeterministicError("totally unrelated text")).toBe(false);
  });

  it("supports extending with extra deterministic patterns (string)", () => {
    expect(
      isDeterministicError("CUSTOM_FAILURE_MARKER: bedrock segment too large", {
        extraDeterministicPatterns: ["custom_failure_marker"],
      }),
    ).toBe(true);
  });

  it("supports extending with extra deterministic patterns (RegExp)", () => {
    expect(
      isDeterministicError("payload exceeds 25MB Bedrock limit", {
        extraDeterministicPatterns: [/\bexceeds\s+\d+mb\b/i],
      }),
    ).toBe(true);
  });

  it("extra patterns do NOT change defaults when they don't match", () => {
    expect(
      isDeterministicError("Bedrock throttling exception", {
        extraDeterministicPatterns: ["never-matches"],
      }),
    ).toBe(false);
  });
});
