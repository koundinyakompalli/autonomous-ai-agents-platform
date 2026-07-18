import { describe, expect, it } from "vitest";
import {
  ComposeSessionStatusSchema,
  ComposeSourceKindSchema,
  composeSourceJiraKey,
  type ComposeSessionSourceSummary,
  type ComposeUploadTarget,
  ComposeChatEnvelopeSchema,
  type ComposeChatEvent,
} from "./compose-types.js";

describe("compose-types", () => {
  it("accepts valid session statuses", () => {
    expect(ComposeSessionStatusSchema.parse("draft")).toBe("draft");
    expect(ComposeSessionStatusSchema.parse("handed_off")).toBe("handed_off");
  });

  it("rejects unknown source kinds", () => {
    expect(ComposeSourceKindSchema.safeParse("pdf").success).toBe(false);
    expect(ComposeSourceKindSchema.safeParse("note").success).toBe(true);
    expect(ComposeSourceKindSchema.safeParse("generated_research").success).toBe(
      true,
    );
  });

  it("mints a synthetic source key that matches the Spec Factory regex", () => {
    const key = composeSourceJiraKey(42);
    expect(key).toBe("COMPOSE-42");
    expect(/^[A-Z][A-Z0-9]+-\d+$/.test(key)).toBe(true);
  });

  it("ComposeSessionSourceSummary carries markdownContent and ComposeUploadTarget is shaped", () => {
    const source: ComposeSessionSourceSummary = {
      id: 1,
      sessionId: 2,
      requestId: null,
      kind: "file",
      originalFilename: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      sourceUrl: null,
      s3KeyRaw: "compose/2/raw/1-spec.pdf",
      converter: "markitdown",
      markdownPath: null,
      markdownContent: null,
      conversionStatus: "pending",
      errorMessage: null,
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    };
    const target: ComposeUploadTarget = {
      sourceId: 1,
      uploadUrl: "https://s3.example/put",
      s3KeyRaw: "compose/2/raw/1-spec.pdf",
      expiresInSeconds: 900,
    };
    expect(source.markdownContent).toBeNull();
    expect(target.sourceId).toBe(1);
  });

  it("ComposeSessionSourceSummary carries generated research metadata", () => {
    const source: ComposeSessionSourceSummary = {
      id: 61,
      sessionId: 7,
      requestId: null,
      kind: "generated_research",
      originalFilename: "code-research.md",
      mimeType: null,
      sizeBytes: null,
      sourceUrl: null,
      s3KeyRaw: null,
      converter: "none",
      markdownPath: null,
      markdownContent: "# Research",
      sourceOrigin: "agent",
      generatedByTaskId: 501,
      parentSourceIds: [12, 13],
      contextVersionUsed: 4,
      evidence: { repositories: ["billing-service"] },
      confidence: "high",
      artifactUri: "s3://bucket/compose/7/generated/code-research.md",
      artifactSha256: "a".repeat(64),
      artifactBytes: 2048,
      conversionStatus: "converted",
      errorMessage: null,
      createdAt: "2026-06-02T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    };

    expect(source.kind).toBe("generated_research");
    expect(source.sourceOrigin).toBe("agent");
    expect(source.generatedByTaskId).toBe(501);
  });
});

describe("compose chat types", () => {
  it("ComposeChatEnvelopeSchema parses a full envelope and defaults", () => {
    const parsed = ComposeChatEnvelopeSchema.parse({
      reply: "Which repository is this for?",
      readiness: {
        ready: false,
        openQuestions: ["Which repo?"],
        summary: "Need the repo.",
        details: {
          module: "Platform",
          repositories: ["core-app", "interop"],
          difficulty: "M",
          loeHours: 24,
          storyPoints: 5,
        },
      },
    });
    expect(parsed.reply).toContain("repository");
    expect(parsed.readiness.ready).toBe(false);
    expect(parsed.readiness.details).toMatchObject({
      module: "Platform",
      repositories: ["core-app", "interop"],
      difficulty: "M",
      loeHours: 24,
      storyPoints: 5,
    });
    expect(parsed.contextMarkdown).toBeUndefined();
  });

  it("ComposeChatEvent is a discriminated union of stream events", () => {
    const ev: ComposeChatEvent = {
      type: "message",
      role: "assistant",
      content: "hi",
    };
    expect(ev.type).toBe("message");
    const ready: ComposeChatEvent = {
      type: "readiness",
      readiness: { ready: true, openQuestions: [], summary: "ok" },
    };
    expect(ready.type).toBe("readiness");
    const status: ComposeChatEvent = { type: "status", status: "thinking" };
    expect(status.status).toBe("thinking");
  });

  it("ComposeChatEvent supports a 'retrying' status with retry-ETA fields", () => {
    // Cross-lane seam: the dashboard's ComposeStreamEvent type must be
    // updated to mirror this 'retrying' status so the SSE consumer can
    // render the retry banner. See report.
    const retrying: ComposeChatEvent = {
      type: "status",
      status: "retrying",
      mode: "chat",
      attempt: 1,
      maxAttempts: 3,
      nextRetryInSeconds: 1,
    };
    expect(retrying.type).toBe("status");
    if (retrying.type === "status") {
      expect(retrying.status).toBe("retrying");
      expect(retrying.attempt).toBe(1);
      expect(retrying.maxAttempts).toBe(3);
      expect(retrying.nextRetryInSeconds).toBe(1);
    }
  });

  it("ComposeReadinessSchema accepts and preserves a stories breakdown", () => {
    const parsed = ComposeChatEnvelopeSchema.parse({
      reply: "Here is the plan.",
      readiness: {
        ready: false,
        openQuestions: ["q1"],
        summary: "s",
        stories: [
          {
            id: "story-1",
            title: "Add token plumbing",
            summary: "Send x-compose-token on protected reads",
            repos: ["dashboard"],
            sequence: 1,
          },
        ],
      },
    });
    expect(parsed.readiness.stories).toHaveLength(1);
    expect(parsed.readiness.stories?.[0]).toMatchObject({
      id: "story-1",
      title: "Add token plumbing",
      sequence: 1,
    });
  });

  it("ComposeChatEnvelopeSchema preserves richer readiness preview fields", () => {
    const parsed = ComposeChatEnvelopeSchema.parse({
      reply: "Ready with warnings.",
      readiness: {
        ready: true,
        openQuestions: [],
        summary: "Medical appeals case creation is ready to draft.",
        confidence: {
          score: 0.82,
          rationale: "Sources include Jira scope and selected repo evidence.",
        },
        risks: ["Appeals queue routing needs QA validation."],
        assumptions: ["Existing EPIC creation flow remains unchanged."],
        missingEvidence: ["No test data fixture was provided."],
        nextStep: "Generate draft with warnings.",
        validatorWarnings: [
          {
            code: "missing_test_plan",
            message: "Test plan is thin.",
            severity: "warning",
          },
        ],
      },
    });

    expect(parsed.readiness.confidence).toEqual({
      score: 0.82,
      rationale: "Sources include Jira scope and selected repo evidence.",
    });
    expect(parsed.readiness.risks).toEqual([
      "Appeals queue routing needs QA validation.",
    ]);
    expect(parsed.readiness.validatorWarnings?.[0]).toMatchObject({
      code: "missing_test_plan",
      severity: "warning",
    });
  });
});
