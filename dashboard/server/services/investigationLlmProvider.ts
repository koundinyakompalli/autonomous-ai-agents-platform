import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandInput,
  type InvokeModelCommandOutput,
} from '@aws-sdk/client-bedrock-runtime'
import { defaultProvider } from '@aws-sdk/credential-provider-node'

export interface InvestigationLlmRequest {
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
  schema?: Record<string, unknown>
  timeoutMs?: number
}

export interface InvestigationLlmResponse<T> {
  providerKey: 'bedrock_runtime'
  modelId: string
  text: string
  parsed: T
  metrics: {
    durationMs: number
    toolCalls: number
    inputTokens?: number
    outputTokens?: number
  }
}

export interface InvestigationBedrockSender {
  send(
    command: InvokeModelCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<InvokeModelCommandOutput>
}

type InvestigationBedrockFactory = (config: {
  region: string
  awsProfile?: string
}) => InvestigationBedrockSender

export function getInvestigationLlmConfig(): {
  modelId: string
  region: string
  awsProfile?: string
} {
  const modelId =
    process.env.INVESTIGATION_LLM_MODEL_ID?.trim()
    || process.env.ANTHROPIC_MODEL?.trim()
    || process.env.BEDROCK_MODEL?.trim()
    || process.env.BEDROCK_MODEL_ID?.trim()
    || 'us.anthropic.claude-sonnet-4-6'
  const region =
    process.env.INVESTIGATION_LLM_AWS_REGION?.trim()
    || process.env.BEDROCK_AWS_REGION?.trim()
    || 'us-east-2'
  const awsProfile =
    process.env.INVESTIGATION_LLM_AWS_PROFILE?.trim()
    || process.env.AWS_PROFILE?.trim()
    || undefined

  return { modelId, region, awsProfile }
}

export async function runInvestigationLlmJson<T>(
  request: InvestigationLlmRequest,
  createClient: InvestigationBedrockFactory = createBedrockClient,
): Promise<InvestigationLlmResponse<T>> {
  const config = getInvestigationLlmConfig()
  const startedAt = Date.now()
  const timeoutMs = Math.max(5_000, request.timeoutMs || 60_000)
  const maxTokens = request.maxTokens || 4_096
  const schemaInstruction = request.schema
    ? `\nReturn only one JSON object that conforms to this JSON Schema:\n${JSON.stringify(request.schema)}`
    : '\nReturn only one JSON object.'
  const body = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature: 0,
    system: request.systemPrompt,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `${request.userPrompt}${schemaInstruction}` }],
    }],
  }
  const input: InvokeModelCommandInput = {
    modelId: config.modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: Buffer.from(JSON.stringify(body)),
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`Investigation Bedrock request exceeded ${timeoutMs}ms timeout`)), timeoutMs)
  let response: InvokeModelCommandOutput
  try {
    response = await createClient(config).send(new InvokeModelCommand(input), { abortSignal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Investigation Bedrock request exceeded ${timeoutMs}ms timeout`)
    throw error
  } finally {
    clearTimeout(timer)
  }
  const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
    content?: Array<{ type?: string; text?: string }>
    stop_reason?: string
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  if (payload.stop_reason === 'max_tokens') {
    throw new Error('Investigation Bedrock response was truncated before valid JSON was returned')
  }
  const text = (payload.content || [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (!text) throw new Error('Investigation Bedrock response did not contain text')

  return {
    providerKey: 'bedrock_runtime',
    modelId: config.modelId,
    text,
    parsed: parseJsonResponse(text) as T,
    metrics: {
      durationMs: Date.now() - startedAt,
      toolCalls: 0,
      inputTokens: payload.usage?.input_tokens,
      outputTokens: payload.usage?.output_tokens,
    },
  }
}

function createBedrockClient(config: { region: string; awsProfile?: string }): InvestigationBedrockSender {
  return new BedrockRuntimeClient({
    region: config.region,
    ...(config.awsProfile ? { credentials: defaultProvider({ profile: config.awsProfile }) } : {}),
  })
}

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = fenced?.[1]?.trim() || extractFirstJsonObject(trimmed)
  return JSON.parse(candidate)
}

function extractFirstJsonObject(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('Investigation LLM response did not contain a JSON object')
  }
  return text.slice(start, end + 1)
}
