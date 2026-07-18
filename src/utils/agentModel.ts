import { createLogger } from './logger.js'

const logger = createLogger('agent-model')

export type AgentModelProvider = 'anthropic' | 'openai' | 'unknown'

export function inferAgentModelProvider(model: string): AgentModelProvider {
  const normalized = model.trim().toLowerCase()

  if (normalized.startsWith('us.anthropic.') || normalized.startsWith('anthropic.')) {
    return 'anthropic'
  }

  if (
    normalized.startsWith('gpt-')
    || normalized.startsWith('o1')
    || normalized.startsWith('o3')
    || normalized.startsWith('o4')
    || normalized.startsWith('openai')
  ) {
    return 'openai'
  }

  return 'unknown'
}

export function applyAgentModelToProcessEnv(
  model: string,
  context: { agentName: string },
): AgentModelProvider {
  const provider = inferAgentModelProvider(model)

  process.env.AGENT_MODEL = model

  if (provider === 'anthropic') {
    process.env.ANTHROPIC_MODEL = model
  } else if (provider === 'openai') {
    if (context.agentName === 'CODE_REVIEWER') {
      process.env.OPENAI_CODE_REVIEWER_MODEL = model
    } else {
      process.env.OPENAI_REVIEWER_MODEL = model
    }
  } else {
    logger.warn( {
      agentName: context.agentName,
      model,
    },'Unable to infer provider for agent model; leaving provider-specific env unchanged')
  }

  logger.info( {
    agentName: context.agentName,
    model,
    provider,
  },'Applied agent model from agents table to process environment')

  return provider
}
