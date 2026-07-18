import { describe, expect, it } from "vitest";
import { normalizedRoute, requestIdFromHeader } from "./http.js";

describe("Spec Factory HTTP telemetry", () => {
  it("preserves valid caller request IDs and replaces unsafe values", () => {
    expect(requestIdFromHeader("trace-123:abc")).toBe("trace-123:abc");
    expect(requestIdFromHeader("contains spaces")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("normalizes numeric and UUID path identifiers", () => {
    expect(
      normalizedRoute(
        "/api/spec-factory/compose",
        "/sessions/81/turns/550e8400-e29b-41d4-a716-446655440000",
      ),
    ).toBe("/api/spec-factory/compose/sessions/:id/turns/:id");
  });
});
