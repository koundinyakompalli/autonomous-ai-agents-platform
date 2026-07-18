import type {
  CoordinatorContextBundle,
  CoordinatorDecision,
} from "./chat-coordinator.js";

export interface ChatCoordinatorRunner {
  decide(bundle: CoordinatorContextBundle): Promise<CoordinatorDecision>;
}

export class ChatCoordinationExecutor {
  readonly executorType = "chat_coordination";

  constructor(private readonly coordinator: ChatCoordinatorRunner) {}

  execute(bundle: CoordinatorContextBundle): Promise<CoordinatorDecision> {
    return this.coordinator.decide(bundle);
  }
}
