import { describe, expect, it, vi } from "vitest";
import {
  PROMPT_REGISTRY,
  SpecFactoryPromptRegistryRepository,
  resolvePromptVersion,
  validatePromptVersionForPurpose,
} from "./prompt-registry.js";

describe("prompt registry", () => {
  it("resolves active prompt versions by LLM purpose", () => {
    expect(resolvePromptVersion({ purpose: "chat_coordinator_fast" })).toBe(
      "chat_coordinator@v2",
    );
    expect(resolvePromptVersion({ purpose: "critic_review" })).toBe(
      "critic_review@v1",
    );
    expect(resolvePromptVersion({ purpose: "source_distillation" })).toBe(
      "source_distillation@v2",
    );
  });

  it("accepts a registered requested version for an allowed purpose", () => {
    expect(
      validatePromptVersionForPurpose({
        purpose: "chat_coordinator_strong",
        promptVersion: "chat_coordinator@v1",
      }),
    ).toBe("chat_coordinator@v1");
  });

  it("rejects unknown, malformed, or purpose-mismatched prompt versions", () => {
    expect(() =>
      resolvePromptVersion({
        purpose: "critic_review",
        requestedVersion: "chat_coordinator@v1",
      }),
    ).toThrow("prompt_version_purpose_mismatch");
    expect(() =>
      resolvePromptVersion({
        purpose: "critic_review",
        requestedVersion: "critic-review-v1",
      }),
    ).toThrow("invalid_prompt_version");
    expect(() =>
      resolvePromptVersion({
        purpose: "critic_review",
        requestedVersion: "missing_prompt@v1",
      }),
    ).toThrow("prompt_version_not_registered");
  });

  it("keeps registry entries unique", () => {
    const versions = PROMPT_REGISTRY.map((entry) => entry.promptVersion);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("resolves default prompt versions from the durable registry table", async () => {
    const query = vi.fn().mockResolvedValue([
      [
        {
          prompt_version: "chat_coordinator@v2",
          version: 2,
          active: 1,
          purposes_json: JSON.stringify(["chat_coordinator_fast"]),
          source: "db://prompt/chat",
          changelog_json: JSON.stringify(["Tuned for faster routing."]),
          schema_expectation: "CoordinatorDecisionSchema",
        },
      ],
    ]);
    const repository = new SpecFactoryPromptRegistryRepository({
      query,
    } as never);

    await expect(
      repository.resolvePromptVersion({
        purpose: "chat_coordinator_fast",
        allowDefault: true,
      }),
    ).resolves.toBe("chat_coordinator@v2");

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("JSON_CONTAINS(purposes_json, JSON_QUOTE(?))"),
      ["chat_coordinator_fast"],
    );
  });

  it("validates explicit prompt versions through the durable registry table", async () => {
    const query = vi.fn().mockResolvedValue([
      [
        {
          prompt_version: "chat_coordinator@v2",
          version: 2,
          active: 0,
          purposes_json: ["chat_coordinator_fast"],
          source: "db://prompt/chat",
          changelog_json: [],
          schema_expectation: "CoordinatorDecisionSchema",
        },
      ],
    ]);
    const repository = new SpecFactoryPromptRegistryRepository({
      query,
    } as never);

    await expect(
      repository.resolvePromptVersion({
        purpose: "chat_coordinator_fast",
        requestedVersion: "chat_coordinator@v2",
      }),
    ).resolves.toBe("chat_coordinator@v2");
    await expect(
      repository.resolvePromptVersion({
        purpose: "critic_review",
        requestedVersion: "chat_coordinator@v2",
      }),
    ).rejects.toThrow(
      "prompt_version_purpose_mismatch:chat_coordinator@v2:critic_review",
    );
  });
});
