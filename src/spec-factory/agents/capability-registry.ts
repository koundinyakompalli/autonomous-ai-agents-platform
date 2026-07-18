export type CapabilityName =
  | "legacy_compose_chat"
  | "chat_coordination"
  | "source_distillation"
  | "context_merge"
  | "code_research"
  | "config_research"
  | "devops_research"
  | "critic_review"
  | "handoff_build";

export type CapabilityQueue = "turn" | "agent-task" | "research" | "context";

export interface CapabilityDefinition {
  name: CapabilityName;
  executorType: string;
  queue: CapabilityQueue;
  defaultPriority: number;
  maxRuntimeSeconds: number;
  maxAttempts: number;
  requiresWorkspace: boolean;
  requiresContextVersion: boolean;
  producesGeneratedSource: boolean;
}

export const DEFAULT_CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
  {
    name: "legacy_compose_chat",
    executorType: "legacy_compose_chat",
    queue: "turn",
    defaultPriority: 100,
    maxRuntimeSeconds: 300,
    maxAttempts: 3,
    requiresWorkspace: true,
    requiresContextVersion: false,
    producesGeneratedSource: false,
  },
  {
    name: "chat_coordination",
    executorType: "chat_coordination",
    queue: "turn",
    defaultPriority: 95,
    maxRuntimeSeconds: 120,
    maxAttempts: 2,
    requiresWorkspace: false,
    requiresContextVersion: true,
    producesGeneratedSource: false,
  },
  {
    name: "source_distillation",
    executorType: "source_distillation",
    queue: "agent-task",
    defaultPriority: 80,
    maxRuntimeSeconds: 180,
    maxAttempts: 3,
    requiresWorkspace: true,
    requiresContextVersion: true,
    producesGeneratedSource: false,
  },
  {
    name: "context_merge",
    executorType: "context_merge",
    queue: "context",
    defaultPriority: 90,
    maxRuntimeSeconds: 120,
    maxAttempts: 3,
    requiresWorkspace: true,
    requiresContextVersion: true,
    producesGeneratedSource: false,
  },
  {
    name: "code_research",
    executorType: "code_research",
    queue: "research",
    defaultPriority: 70,
    maxRuntimeSeconds: 600,
    maxAttempts: 2,
    requiresWorkspace: true,
    requiresContextVersion: true,
    producesGeneratedSource: true,
  },
  {
    name: "config_research",
    executorType: "code_research",
    queue: "research",
    defaultPriority: 70,
    maxRuntimeSeconds: 600,
    maxAttempts: 2,
    requiresWorkspace: true,
    requiresContextVersion: true,
    producesGeneratedSource: true,
  },
  {
    name: "devops_research",
    executorType: "code_research",
    queue: "research",
    defaultPriority: 70,
    maxRuntimeSeconds: 600,
    maxAttempts: 2,
    requiresWorkspace: true,
    requiresContextVersion: true,
    producesGeneratedSource: true,
  },
  {
    name: "critic_review",
    executorType: "critic_review",
    queue: "agent-task",
    defaultPriority: 40,
    maxRuntimeSeconds: 120,
    maxAttempts: 1,
    requiresWorkspace: false,
    requiresContextVersion: false,
    producesGeneratedSource: false,
  },
  {
    name: "handoff_build",
    executorType: "handoff_build",
    queue: "agent-task",
    defaultPriority: 60,
    maxRuntimeSeconds: 120,
    maxAttempts: 2,
    requiresWorkspace: true,
    requiresContextVersion: false,
    producesGeneratedSource: false,
  },
];

export class CapabilityRegistry {
  private readonly definitions: Map<string, CapabilityDefinition>;

  constructor(
    definitions: CapabilityDefinition[] = DEFAULT_CAPABILITY_DEFINITIONS,
  ) {
    this.definitions = new Map(
      definitions.map((definition) => [definition.name, { ...definition }]),
    );
  }

  list(): CapabilityDefinition[] {
    return [...this.definitions.values()].map((definition) => ({
      ...definition,
    }));
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  get(name: string): CapabilityDefinition {
    const definition = this.definitions.get(name);
    if (!definition) {
      throw new Error(`unknown_capability:${name}`);
    }
    return { ...definition };
  }
}

export function defaultCapabilityRegistry(): CapabilityRegistry {
  return new CapabilityRegistry();
}

export function assertKnownCapability(name: string): CapabilityName {
  if (!defaultCapabilityRegistry().has(name)) {
    throw new Error(`unknown_capability:${name}`);
  }
  return name as CapabilityName;
}
