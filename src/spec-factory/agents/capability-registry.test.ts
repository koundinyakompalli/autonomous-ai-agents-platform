import { describe, expect, it } from "vitest";
import {
  CapabilityRegistry,
  assertKnownCapability,
  defaultCapabilityRegistry,
} from "./capability-registry.js";

describe("CapabilityRegistry", () => {
  it("lists the shipped capability set", () => {
    const registry = defaultCapabilityRegistry();

    expect(registry.list().map((definition) => definition.name)).toEqual([
      "legacy_compose_chat",
      "chat_coordination",
      "source_distillation",
      "context_merge",
      "code_research",
      "config_research",
      "devops_research",
      "critic_review",
      "handoff_build",
    ]);
    expect(registry.has("code_research")).toBe(true);
    expect(registry.has("config_research")).toBe(true);
    expect(registry.has("devops_research")).toBe(true);
    expect(registry.has("critic_review")).toBe(true);
    expect(registry.has("handoff_build")).toBe(true);
  });

  it("describes the source distillation executor contract", () => {
    const registry = defaultCapabilityRegistry();

    expect(registry.get("source_distillation")).toEqual({
      name: "source_distillation",
      executorType: "source_distillation",
      queue: "agent-task",
      defaultPriority: 80,
      maxRuntimeSeconds: 180,
      maxAttempts: 3,
      requiresWorkspace: true,
      requiresContextVersion: true,
      producesGeneratedSource: false,
    });
  });

  it("describes legacy compose chat as a turn-queue capability", () => {
    const registry = defaultCapabilityRegistry();

    expect(registry.get("legacy_compose_chat")).toMatchObject({
      executorType: "legacy_compose_chat",
      queue: "turn",
      defaultPriority: 100,
      maxRuntimeSeconds: 300,
      maxAttempts: 3,
      requiresWorkspace: true,
      requiresContextVersion: false,
      producesGeneratedSource: false,
    });
  });

  it("describes chat coordination as a turn-queue capability", () => {
    const registry = defaultCapabilityRegistry();

    expect(registry.get("chat_coordination")).toMatchObject({
      executorType: "chat_coordination",
      queue: "turn",
      defaultPriority: 95,
      maxRuntimeSeconds: 120,
      maxAttempts: 2,
      requiresWorkspace: false,
      requiresContextVersion: true,
      producesGeneratedSource: false,
    });
  });

  it("describes code research as a generated-source capability", () => {
    const registry = defaultCapabilityRegistry();

    expect(registry.get("code_research")).toEqual({
      name: "code_research",
      executorType: "code_research",
      queue: "research",
      defaultPriority: 70,
      maxRuntimeSeconds: 600,
      maxAttempts: 2,
      requiresWorkspace: true,
      requiresContextVersion: true,
      producesGeneratedSource: true,
    });
  });

  it("describes specialist research capabilities as generated-source work", () => {
    const registry = defaultCapabilityRegistry();

    expect(registry.get("config_research")).toEqual({
      name: "config_research",
      executorType: "code_research",
      queue: "research",
      defaultPriority: 70,
      maxRuntimeSeconds: 600,
      maxAttempts: 2,
      requiresWorkspace: true,
      requiresContextVersion: true,
      producesGeneratedSource: true,
    });
    expect(registry.get("devops_research")).toEqual({
      name: "devops_research",
      executorType: "code_research",
      queue: "research",
      defaultPriority: 70,
      maxRuntimeSeconds: 600,
      maxAttempts: 2,
      requiresWorkspace: true,
      requiresContextVersion: true,
      producesGeneratedSource: true,
    });
  });

  it("describes critic review as a lightweight agent-task capability", () => {
    const registry = defaultCapabilityRegistry();

    expect(registry.get("critic_review")).toEqual({
      name: "critic_review",
      executorType: "critic_review",
      queue: "agent-task",
      defaultPriority: 40,
      maxRuntimeSeconds: 120,
      maxAttempts: 1,
      requiresWorkspace: false,
      requiresContextVersion: false,
      producesGeneratedSource: false,
    });
  });

  it("describes handoff build as a queued worker capability", () => {
    const registry = defaultCapabilityRegistry();

    expect(registry.get("handoff_build")).toEqual({
      name: "handoff_build",
      executorType: "handoff_build",
      queue: "agent-task",
      defaultPriority: 60,
      maxRuntimeSeconds: 120,
      maxAttempts: 2,
      requiresWorkspace: true,
      requiresContextVersion: false,
      producesGeneratedSource: false,
    });
  });

  it("rejects unknown capability names", () => {
    const registry = new CapabilityRegistry();

    expect(() => registry.get("unknown_research")).toThrow(
      "unknown_capability:unknown_research",
    );
    expect(() => assertKnownCapability("unknown_research")).toThrow(
      "unknown_capability:unknown_research",
    );
  });
});
