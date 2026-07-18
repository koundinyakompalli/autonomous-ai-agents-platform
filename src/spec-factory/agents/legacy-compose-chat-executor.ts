import {
  ComposeChatAgent,
  type ComposeChatRunInput,
  type ComposeChatRunOutput,
} from "../compose-chat-agent.js";

export interface LegacyComposeChatRunner {
  run(input: ComposeChatRunInput): Promise<ComposeChatRunOutput>;
}

export class LegacyComposeChatExecutor {
  readonly executorType = "legacy_compose_chat";

  constructor(private readonly chatAgent: LegacyComposeChatRunner = new ComposeChatAgent()) {}

  execute(input: ComposeChatRunInput): Promise<ComposeChatRunOutput> {
    return this.chatAgent.run(input);
  }
}
