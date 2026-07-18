import type { ClaimedAgentTask } from "../compose-database.js";

export interface AgentTaskExecutionResult {
  output?: unknown;
  contextVersionUsed?: number | null;
  outputSourceId?: number | null;
  runtime?: {
    provider?: string | null;
    model?: string | null;
    traceUri?: string | null;
    outputArtifactUri?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    estimatedCostUsd?: number | null;
  };
}

export interface AgentTaskExecutor {
  executorType: string;
  execute(task: ClaimedAgentTask): Promise<AgentTaskExecutionResult | void>;
}

export class AgentTaskExecutorRegistry {
  private readonly executors = new Map<string, AgentTaskExecutor>();

  constructor(executors: AgentTaskExecutor[] = []) {
    for (const executor of executors) {
      this.register(executor);
    }
  }

  register(executor: AgentTaskExecutor): void {
    this.executors.set(executor.executorType, executor);
  }

  has(executorType: string): boolean {
    return this.executors.has(executorType);
  }

  get(executorType: string): AgentTaskExecutor {
    const executor = this.executors.get(executorType);
    if (!executor) {
      throw new Error(`unknown_executor:${executorType}`);
    }
    return executor;
  }

  listExecutorTypes(): string[] {
    return [...this.executors.keys()];
  }

  async execute(task: ClaimedAgentTask): Promise<AgentTaskExecutionResult> {
    const executorType = task.executorType ?? task.capability;
    const result = await this.get(executorType).execute(task);
    if (!result) return {};
    return result;
  }
}
