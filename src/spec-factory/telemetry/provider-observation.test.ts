import { describe, expect, it } from "vitest";
import { providerFailureOutcome } from "./provider-observation.js";

describe("provider observation", () => {
  it("classifies provider throttles without treating generic failures as throttles", () => {
    expect(providerFailureOutcome("ThrottlingException: rate exceeded")).toBe(
      "throttled",
    );
    expect(providerFailureOutcome("HTTP 429 too many requests")).toBe(
      "throttled",
    );
    expect(providerFailureOutcome("ValidationError: bad prompt")).toBe(
      "failed",
    );
  });
});
