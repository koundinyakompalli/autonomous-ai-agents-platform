import { describe, expect, it } from "vitest";
import { isDeterministicFailure } from "./retry-classifier.js";

describe("isDeterministicFailure", () => {
  it("matches Claude Code 4096 output-token overflow (the CPDEV-21561 signature)", () => {
    const msg =
      "Claude Code returned an error result: API Error: Claude's response exceeded the 4096 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.";
    expect(isDeterministicFailure(msg)).toBe(true);
  });

  it("matches any numeric output-token cap overflow (50000, 200000, etc.)", () => {
    expect(
      isDeterministicFailure(
        "response exceeded the 50000 output token maximum",
      ),
    ).toBe(true);
    expect(
      isDeterministicFailure(
        "response exceeded the 200000 output token maximum",
      ),
    ).toBe(true);
  });

  it("matches schema_invalid_after_success failure kind", () => {
    expect(
      isDeterministicFailure(
        "Planner structured output failed schema validation after SDK success: schema_invalid_after_success",
      ),
    ).toBe(true);
  });

  it("matches retrofit_contract_missing_after_normalization failure kind", () => {
    expect(
      isDeterministicFailure(
        "retrofit_contract_missing_after_normalization: Retrofit planner output did not include required retrofit contract fields.",
      ),
    ).toBe(true);
  });

  it("matches structured_output_retries_exhausted failure kind", () => {
    expect(
      isDeterministicFailure(
        "Provider returned structured_output_retries_exhausted after 3 repair attempts",
      ),
    ).toBe(true);
  });

  it("matches already_applied retrofit failures", () => {
    expect(
      isDeterministicFailure(
        "already_applied: Retrofit source change CPDEV-1234 from batch-monorepo-master is already patch-equivalent on batch-monorepo-3.18; no missing retrofit changes to plan.",
      ),
    ).toBe(true);
  });

  it("matches deterministic retrofit setup failures", () => {
    expect(
      isDeterministicFailure(
        "retrofit_branch_mismatch: Retrofit target branch batch-monorepo-3.18 does not match run branch master.",
      ),
    ).toBe(true);
    expect(
      isDeterministicFailure(
        "retrofit_source_branch_missing: Retrofit source branch batch-monorepo-master was not found on origin.",
      ),
    ).toBe(true);
  });

  it("does NOT match transient stalls that should retry", () => {
    expect(
      isDeterministicFailure(
        "SDK_POST_TOOL_IDLE_TIMEOUT: no stream event for 30000ms",
      ),
    ).toBe(false);
    expect(isDeterministicFailure("SDK timeout after 1200000ms")).toBe(false);
    expect(isDeterministicFailure("Turn limit exceeded (max: 180)")).toBe(
      false,
    );
    expect(isDeterministicFailure("ECONNRESET: socket hang up")).toBe(false);
  });

  it("handles empty / undefined-ish input", () => {
    expect(isDeterministicFailure("")).toBe(false);
    expect(isDeterministicFailure(undefined as unknown as string)).toBe(false);
  });

  it("is case-insensitive on the output-token overflow pattern", () => {
    expect(
      isDeterministicFailure("RESPONSE EXCEEDED THE 4096 OUTPUT TOKEN MAXIMUM"),
    ).toBe(true);
  });
});
