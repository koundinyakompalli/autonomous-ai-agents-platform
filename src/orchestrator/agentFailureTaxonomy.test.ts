import { describe, expect, it } from "vitest";
import { classifyAgentFailure } from "./agentFailureTaxonomy.js";

describe("classifyAgentFailure", () => {
  it("classifies SDK timeouts and turn limits as transient retryable failures", () => {
    expect(classifyAgentFailure("SDK timeout after 1800000ms")).toMatchObject({
      category: "sdk_timeout",
      retryable: true,
      deterministic: false,
    });
    expect(classifyAgentFailure("Turn limit exceeded (max: 100)")).toMatchObject({
      category: "turn_limit",
      retryable: true,
      deterministic: false,
    });
    expect(
      classifyAgentFailure(
        "SDK_POST_TOOL_IDLE_TIMEOUT: no stream event for 90000ms after repository tools, toolCalls=44, output=111",
      ),
    ).toMatchObject({
      category: "sdk_timeout",
      retryable: true,
      deterministic: false,
    });
  });

  it("classifies raw fetch and network failures as transient retryable failures", () => {
    expect(classifyAgentFailure("fetch failed")).toMatchObject({
      category: "provider_transient",
      retryable: true,
      deterministic: false,
    });
    expect(classifyAgentFailure("cause: ECONNRESET")).toMatchObject({
      category: "provider_transient",
      retryable: true,
      deterministic: false,
    });
    expect(
      classifyAgentFailure(
        "retrofit_source_lookup_failed: Could not list source PR commits. 401 Bad credentials",
      ),
    ).toMatchObject({
      category: "provider_transient",
      retryable: true,
      deterministic: false,
    });
    expect(
      classifyAgentFailure(
        "source_pr_lookup_failed: Could not list source PR evidence. 401 Bad credentials",
      ),
    ).toMatchObject({
      category: "provider_transient",
      retryable: true,
      deterministic: false,
    });
    expect(
      classifyAgentFailure(
        "target_branch_lookup_failed: Target branch lookup failed for core-app.",
      ),
    ).toMatchObject({
      category: "provider_transient",
      retryable: true,
      deterministic: false,
    });
  });

  it("classifies output cap and runtime JS errors as deterministic non-retryable failures", () => {
    expect(
      classifyAgentFailure(
        "Claude Code returned an error result: API Error: Claude's response exceeded the 4096 output token maximum.",
      ),
    ).toMatchObject({
      category: "output_token_cap",
      retryable: false,
      deterministic: true,
    });
    expect(
      classifyAgentFailure("Cannot read properties of undefined (reading 'toLowerCase')"),
    ).toMatchObject({
      category: "runtime_bug",
      retryable: false,
      deterministic: true,
    });
  });

  it("keeps unknown errors non-retryable until explicitly classified", () => {
    expect(classifyAgentFailure("some new unexpected failure")).toMatchObject({
      category: "unknown",
      retryable: false,
    });
  });
});
