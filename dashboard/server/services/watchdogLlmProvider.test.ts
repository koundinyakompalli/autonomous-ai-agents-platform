import { describe, expect, it } from "vitest";
import { WatchdogServiceError } from "./watchdogErrors.js";
import { parseJsonResponse } from "./watchdogLlmProvider.js";

describe("watchdogLlmProvider", () => {
  it("parses raw JSON responses", () => {
    expect(parseJsonResponse<{ findings: unknown[] }>('{"findings":[]}')).toEqual({
      findings: [],
    });
  });

  it("parses fenced JSON responses", () => {
    expect(parseJsonResponse<{ findings: Array<{ title: string }> }>(
      '```json\n{"findings":[{"title":"Auth failures"}]}\n```',
    )).toEqual({
      findings: [{ title: "Auth failures" }],
    });
  });

  it("throws a service error when no JSON object exists", () => {
    expect(() => parseJsonResponse("not json")).toThrow(WatchdogServiceError);
  });
});
