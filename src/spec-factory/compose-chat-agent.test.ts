import { describe, expect, it, vi } from "vitest";
import {
  ComposeChatAgent,
  ComposeChatPromptTooLargeError,
} from "./compose-chat-agent.js";

function agentResult(structured: unknown, sessionId = "sess-1") {
  return {
    success: true,
    output: JSON.stringify(structured),
    structuredOutput: structured,
    sessionId,
    metrics: { durationMs: 1, toolCalls: 0, modelUsed: "claude" },
  };
}

function runAgentReturning(result: unknown) {
  return vi.fn().mockResolvedValue(agentResult(result));
}

describe("ComposeChatAgent", () => {
  it("analyze runs without resume and returns envelope + sessionId", async () => {
    const runAgent = vi.fn().mockResolvedValue(
      agentResult({
        reply: "I read 2 sources. Which user roles need billing exports?",
        readiness: {
          ready: false,
          openQuestions: ["Which user roles need exports?"],
          summary: "Need the affected users.",
        },
        contextMarkdown: "# Context\n\nBilling export.",
      }),
    );
    const agent = new ComposeChatAgent(runAgent as never);

    const out = await agent.run({
      sessionId: 7,
      workspaceRepoId: "compose_abc",
      mode: "analyze",
      resumeSessionId: null,
      latestUserMessage: null,
    });

    expect(out.envelope.readiness.ready).toBe(false);
    expect(out.envelope.contextMarkdown).toContain("Billing export.");
    expect(out.sessionId).toBe("sess-1");
    const call = runAgent.mock.calls[0][0];
    expect(call.repoIds).toEqual(["compose_abc"]);
    expect(call.permissionLevel).toBe("read_only");
    expect(call.resumeSessionId).toBeUndefined();
    expect(call.taskPrompt).toContain("details");
    expect(call.taskPrompt).toContain("# Standard MHK organizational context");
    expect(call.taskPrompt).toContain("mhk-organizational-context.md");
    expect(call.taskPrompt).toContain("module");
    expect(call.taskPrompt).toContain("storyPoints");
    expect(call.taskPrompt).toContain(
      "Ask at most one business or functional clarification",
    );
  });

  it("chat resumes the warm session and passes the user message", async () => {
    const runAgent = vi.fn().mockResolvedValue(
      agentResult(
        {
          reply: "Got it — billing-service.",
          readiness: { ready: true, openQuestions: [], summary: "Ready." },
        },
        "sess-1",
      ),
    );
    const agent = new ComposeChatAgent(runAgent as never);

    const out = await agent.run({
      sessionId: 7,
      workspaceRepoId: "compose_abc",
      mode: "chat",
      resumeSessionId: "sess-1",
      latestUserMessage: "billing-service",
    });

    expect(out.envelope.readiness.ready).toBe(true);
    const call = runAgent.mock.calls[0][0];
    expect(call.resumeSessionId).toBe("sess-1");
    expect(call.forkSessionOnResume).toBe(false);
    expect(call.taskPrompt).toContain("billing-service");
    expect(call.taskPrompt).toContain(
      "Ask at most one business or functional question",
    );
  });

  it("retrieves turn-relevant organizational context for the legacy path", async () => {
    const runAgent = runAgentReturning({
      reply: "The pharmacy workflow is understood.",
      readiness: { ready: true, openQuestions: [], summary: "Ready." },
    });
    const provider = vi.fn().mockReturnValue("PBM AND EPA CONTEXT");
    const agent = new ComposeChatAgent(
      runAgent as never,
      "test-model",
      30_000,
      provider,
    );

    await agent.run({
      sessionId: 7,
      workspaceRepoId: "compose_abc",
      mode: "chat",
      resumeSessionId: null,
      latestUserMessage: "Clarify the PBM ePA workflow",
    });

    expect(provider).toHaveBeenCalledWith("Clarify the PBM ePA workflow");
    expect(runAgent.mock.calls[0][0].taskPrompt).toContain(
      "PBM AND EPA CONTEXT",
    );
  });

  it("strips leaked tool wrapper tags from replies before returning them", async () => {
    const runAgent = vi.fn().mockResolvedValue(
      agentResult({
        reply:
          "Dug into the web services.\n\nHighest-value blocker: Which endpoint?\n\n</parameter>\n\n</invoke>",
        readiness: {
          ready: false,
          openQuestions: ["Which endpoint?"],
          summary: "Need endpoint.",
        },
      }),
    );
    const agent = new ComposeChatAgent(runAgent as never);

    const out = await agent.run({
      sessionId: 7,
      workspaceRepoId: "compose_abc",
      mode: "chat",
      resumeSessionId: "sess-1",
      latestUserMessage: "check web-services",
    });

    expect(out.envelope.reply).toBe("Dug into the web services.");
  });

  it("uses the Compose chat model override before the shared Spec Factory model", async () => {
    vi.stubEnv("COMPOSE_CHAT_MODEL_ID", "fast-chat-model");
    vi.stubEnv("SPEC_FACTORY_MODEL_ID", "heavy-draft-model");
    vi.stubEnv("ANTHROPIC_MODEL", "fallback-model");
    const runAgent = vi.fn().mockResolvedValue(
      agentResult({
        reply: "Which repository should I inspect?",
        readiness: {
          ready: false,
          openQuestions: ["Which repository?"],
          summary: "Need repo.",
        },
      }),
    );
    try {
      const agent = new ComposeChatAgent(runAgent as never);

      await agent.run({
        sessionId: 7,
        workspaceRepoId: "compose_abc",
        mode: "chat",
        resumeSessionId: "sess-1",
        latestUserMessage: "repo?",
      });

      expect(runAgent.mock.calls[0][0].bedrockConfig.model).toBe(
        "fast-chat-model",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("defaults Compose chat to Claude Sonnet 5 when no model override is set", async () => {
    vi.stubEnv("COMPOSE_CHAT_MODEL_ID", "");
    vi.stubEnv("SPEC_FACTORY_MODEL_ID", "");
    vi.stubEnv("ANTHROPIC_MODEL", "");
    const runAgent = vi.fn().mockResolvedValue(
      agentResult({
        reply: "Which repository should I inspect?",
        readiness: {
          ready: false,
          openQuestions: ["Which repository?"],
          summary: "Need repo.",
        },
      }),
    );
    try {
      const agent = new ComposeChatAgent(runAgent as never);

      await agent.run({
        sessionId: 7,
        workspaceRepoId: "compose_abc",
        mode: "chat",
        resumeSessionId: "sess-1",
        latestUserMessage: "repo?",
      });

      expect(runAgent.mock.calls[0][0].bedrockConfig.model).toBe(
        "us.anthropic.claude-sonnet-5",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("instructs the model to build an evidence map and cite source filenames", async () => {
    const runAgent = vi.fn().mockResolvedValue(
      agentResult({
        reply: "I read the sources. Which repository is this for?",
        readiness: {
          ready: false,
          openQuestions: ["Which repo?"],
          summary: "Need repo.",
        },
        contextMarkdown: "# Context",
      }),
    );
    const agent = new ComposeChatAgent(runAgent as never);

    await agent.run({
      sessionId: 7,
      workspaceRepoId: "compose_abc",
      mode: "analyze",
      resumeSessionId: null,
      latestUserMessage: null,
    });

    const prompt = runAgent.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("Build an explicit evidence map");
    expect(prompt).toContain(
      "Cite the source filename (e.g. `## filename.md`) for every factual claim",
    );
    expect(prompt).toContain(
      "Calibrate reading depth to document type: read transcripts and long planning docs end-to-end",
    );
  });

  it("throws ComposeChatPromptTooLargeError when prompt exceeds the configured token cap", async () => {
    vi.stubEnv("COMPOSE_CHAT_MAX_PROMPT_TOKENS", "100");
    const runAgent = vi.fn();
    try {
      const agent = new ComposeChatAgent(runAgent as never);
      const huge = "x".repeat(50_000);
      await expect(
        agent.run({
          sessionId: 7,
          workspaceRepoId: "compose_abc",
          mode: "chat",
          resumeSessionId: "sess-1",
          latestUserMessage: huge,
        }),
      ).rejects.toThrow(ComposeChatPromptTooLargeError);
      expect(runAgent).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not invoke runAgent when the prompt is over the cap, and surfaces estimated token count + cap", async () => {
    vi.stubEnv("COMPOSE_CHAT_MAX_PROMPT_TOKENS", "50");
    const runAgent = vi.fn();
    try {
      const agent = new ComposeChatAgent(runAgent as never);
      const huge = "y".repeat(20_000);
      let captured: ComposeChatPromptTooLargeError | null = null;
      try {
        await agent.run({
          sessionId: 7,
          workspaceRepoId: "compose_abc",
          mode: "chat",
          resumeSessionId: "sess-1",
          latestUserMessage: huge,
        });
      } catch (err) {
        captured = err as ComposeChatPromptTooLargeError;
      }
      expect(captured).toBeInstanceOf(ComposeChatPromptTooLargeError);
      expect(captured?.estimatedTokens).toBeGreaterThan(50);
      expect(captured?.maxTokens).toBe(50);
      expect(captured?.message).toMatch(/Compose context is too large/);
      expect(captured?.message).toMatch(/remove sources or split the session/);
      expect(runAgent).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("proceeds normally when prompt is under the configured cap", async () => {
    vi.stubEnv("COMPOSE_CHAT_MAX_PROMPT_TOKENS", "1000000");
    const runAgent = vi.fn().mockResolvedValue(
      agentResult({
        reply: "ok",
        readiness: { ready: false, openQuestions: [], summary: "x" },
      }),
    );
    try {
      const agent = new ComposeChatAgent(runAgent as never);
      await agent.run({
        sessionId: 7,
        workspaceRepoId: "compose_abc",
        mode: "chat",
        resumeSessionId: "sess-1",
        latestUserMessage: "hi",
      });
      expect(runAgent).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("throws when the agent run fails", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: false,
      error: "boom",
      metrics: { durationMs: 1, toolCalls: 0 },
    });
    const agent = new ComposeChatAgent(runAgent as never);
    await expect(
      agent.run({
        sessionId: 7,
        workspaceRepoId: "r",
        mode: "analyze",
        resumeSessionId: null,
        latestUserMessage: null,
      }),
    ).rejects.toThrow(/boom/);
  });

  it("exposes richer preview fields on the readiness output schema", async () => {
    const runAgent = vi.fn().mockResolvedValue(
      agentResult({
        reply: "ok",
        readiness: { ready: false, openQuestions: [], summary: "" },
      }),
    );
    const agent = new ComposeChatAgent(runAgent as never, "test-model", 1000);
    await agent.run({
      sessionId: 1,
      workspaceRepoId: "compose-1",
      mode: "analyze",
      resumeSessionId: null,
      latestUserMessage: null,
    });
    const schema = runAgent.mock.calls[0][0].outputSchema;
    const readinessProps = schema.properties.readiness.properties;
    expect(readinessProps.confidence.properties.score).toMatchObject({
      minimum: 0,
      maximum: 1,
    });
    expect(readinessProps.risks.type).toBe("array");
    expect(readinessProps.assumptions.type).toBe("array");
    expect(readinessProps.missingEvidence.type).toBe("array");
    expect(readinessProps.nextStep).toMatchObject({ type: "string" });
    expect(
      readinessProps.validatorWarnings.items.properties.severity.enum,
    ).toEqual(["info", "warning", "blocker"]);
    expect(readinessProps.ideating).toMatchObject({ type: "string" });
    expect(readinessProps.problem).toMatchObject({ type: "string" });
    expect(readinessProps.questions.type).toBe("array");
    expect(readinessProps.questions.items.properties.options.maxItems).toBe(3);
    expect(readinessProps.stories.type).toBe("array");
    expect(readinessProps.stories.items.required).toEqual(
      expect.arrayContaining(["id", "title", "summary"]),
    );
  });

  it("instructs the agent to maintain the stories breakdown every turn", async () => {
    const runAgent = runAgentReturning({
      reply: "ok",
      readiness: { ready: false, openQuestions: [], summary: "" },
    });
    const agent = new ComposeChatAgent(runAgent as never, "test-model", 1000);
    await agent.run({
      sessionId: 1,
      workspaceRepoId: "compose-1",
      mode: "chat",
      resumeSessionId: null,
      latestUserMessage: "go",
    });
    const prompt = runAgent.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("readiness.stories");
    expect(prompt).toContain("contract the draft builds from");
    expect(prompt).toContain("Gherkin Scenario/Given/When/Then");
  });

  it("ANALYZE prompt is pick-first with precise A/B/C options + ideating/problem", async () => {
    const runAgent = runAgentReturning({
      reply: "ok",
      readiness: { ready: false, openQuestions: [], summary: "" },
    });
    const agent = new ComposeChatAgent(runAgent as never, "test-model", 1000);
    await agent.run({
      sessionId: 1,
      workspaceRepoId: "compose-1",
      mode: "analyze",
      resumeSessionId: null,
      latestUserMessage: null,
    });
    const prompt = runAgent.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("Pick the one you want to clarify first");
    expect(prompt).toContain("up to 3 concrete");
    expect(prompt).toContain("15 words");
    expect(prompt).toContain("`readiness.ideating`");
    expect(prompt).toContain("`readiness.problem`");
    expect(prompt).toContain("`readiness.confidence`");
    expect(prompt).toContain("`risks`");
    expect(prompt).toContain("`missingEvidence`");
  });

  it("CHAT prompt marks answered questions and refreshes ideating/problem", async () => {
    const runAgent = runAgentReturning({
      reply: "ok",
      readiness: { ready: false, openQuestions: [], summary: "" },
    });
    const agent = new ComposeChatAgent(runAgent as never, "test-model", 1000);
    await agent.run({
      sessionId: 1,
      workspaceRepoId: "compose-1",
      mode: "chat",
      resumeSessionId: null,
      latestUserMessage: "A",
    });
    const prompt = runAgent.mock.calls[0][0].taskPrompt as string;
    expect(prompt).toContain("mark it answered");
    expect(prompt).toContain("`readiness.ideating`");
    expect(prompt).toContain("`readiness.problem`");
    expect(prompt).toContain("`readiness.confidence`");
    expect(prompt).toContain("`validatorWarnings`");
  });
});
