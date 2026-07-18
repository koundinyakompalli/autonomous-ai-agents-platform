import { describe, expect, it } from "vitest";
import {
  hasActionVerb,
  hasContextualVerb,
  isContextualMention,
} from "./text-utils.js";

describe("isContextualMention (v3.5 tightened behaviour)", () => {
  it("'Remove WSUMQuestionSetRequest from interop' is actionable, not contextual", () => {
    // Pre-v3.5 returned true because `from` is a contextual verb, even though
    // `Remove` is an action verb. This is the exact regression this fixes.
    const sentence = "Remove WSUMQuestionSetRequest from interop";
    expect(hasActionVerb(sentence)).toBe(true);
    expect(hasContextualVerb(sentence)).toBe(true);
    expect(isContextualMention(sentence)).toBe(false);
  });

  it("'Update interop using core-app as reference' is actionable, not contextual", () => {
    const sentence = "Update interop using core-app as reference";
    expect(hasActionVerb(sentence)).toBe(true);
    expect(isContextualMention(sentence)).toBe(false);
  });

  it("'Reference: WSUMQuestionSetRequest in cp-medhok-monorepo' is contextual", () => {
    // No action verb; only the contextual "Reference:" + "in".
    const sentence = "Reference: WSUMQuestionSetRequest in cp-medhok-monorepo";
    expect(hasActionVerb(sentence)).toBe(false);
    expect(isContextualMention(sentence)).toBe(true);
  });

  it("'called by interop during order-sign' is contextual", () => {
    const sentence = "called by interop during order-sign";
    expect(hasActionVerb(sentence)).toBe(false);
    expect(isContextualMention(sentence)).toBe(true);
  });

  it("'Add getUmQuestionSet to CoreRestClient' is actionable even without any contextual verb", () => {
    const sentence = "Add getUmQuestionSet to CoreRestClient";
    expect(hasActionVerb(sentence)).toBe(true);
    expect(isContextualMention(sentence)).toBe(false);
  });

  it("a plain noun phrase with no verbs at all is not contextual (nothing to classify)", () => {
    const sentence = "WSUMQuestionSetRequest";
    expect(hasActionVerb(sentence)).toBe(false);
    expect(hasContextualVerb(sentence)).toBe(false);
    expect(isContextualMention(sentence)).toBe(false);
  });
});
