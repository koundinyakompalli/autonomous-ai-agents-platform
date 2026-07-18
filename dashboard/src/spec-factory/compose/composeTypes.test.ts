import { describe, expect, it } from "vitest";
import type {
  ComposeSessionSummary,
  ComposeSourceSummary,
  ComposeChatMessage,
  ComposeReadiness,
  ComposeStreamEvent,
  ComposeUploadTarget,
} from "./composeTypes.js";

describe("composeTypes", () => {
  it("shapes a session, source, message, readiness, and upload target", () => {
    const session: ComposeSessionSummary = {
      id: 1, name: "X", status: "draft", sourceId: null, readiness: null,
      sourceCount: 0, passwordProtected: false, createdAt: "t", updatedAt: "t",
    };
    const source: ComposeSourceSummary = {
      id: 1, sessionId: 1, kind: "generated_research", originalFilename: "a.md",
      conversionStatus: "pending", errorMessage: null, markdownContent: null,
    };
    const msg: ComposeChatMessage = { id: 1, sessionId: 1, role: "assistant", content: "hi", createdAt: "t" };
    const readiness: ComposeReadiness = { ready: false, openQuestions: ["q"], summary: "s" };
    const target: ComposeUploadTarget = { sourceId: 1, uploadUrl: "u", s3KeyRaw: "k", expiresInSeconds: 900 };
    expect(session.status).toBe("draft");
    expect(source.kind).toBe("generated_research");
    expect(source.conversionStatus).toBe("pending");
    expect(msg.role).toBe("assistant");
    expect(readiness.ready).toBe(false);
    expect(target.sourceId).toBe(1);
  });

  it("models a retrying status stream event with attempt metadata", () => {
    const event: ComposeStreamEvent = {
      type: "status",
      status: "retrying",
      attempt: 2,
      maxAttempts: 5,
      nextRetryInSeconds: 4,
      message: "Bedrock throttle",
    };
    if (event.type !== "status" || event.status !== "retrying") {
      throw new Error("expected retrying status event");
    }
    expect(event.attempt).toBe(2);
    expect(event.maxAttempts).toBe(5);
    expect(event.nextRetryInSeconds).toBe(4);
    expect(event.message).toBe("Bedrock throttle");
  });

  it("ComposeReadiness carries ideating/problem/questions/stories", () => {
    const readiness: ComposeReadiness = {
      ready: false,
      openQuestions: ["q"],
      summary: "s",
      ideating: "shaping",
      problem: "solving",
      questions: [
        { id: "q-1", question: "Which repo?", options: ["a", "b"], answered: false },
      ],
      stories: [{ id: "s-1", title: "T", summary: "one line", sequence: 1 }],
    };
    expect(readiness.questions?.[0].options).toEqual(["a", "b"]);
    expect(readiness.stories?.[0].title).toBe("T");
  });
});
