import OpenAI from 'openai'
import { createLogger } from '../utils/logger.js'
import { createReadOnlyRepoTools, type OpenAiFunctionCall } from './repo-tools.js'
import { calculateUsageCostUsd } from '../oneshot/pricing.js'

const logger = createLogger('openai-sdk')

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MAX_TOOL_ITERATIONS = 30
const OPENAI_MAX_TOOL_ITERATIONS_ENV = 'OPENAI_MAX_TOOL_ITERATIONS'
const DEFAULT_CONTINUATION_MODE = 'stateless'
const OPENAI_TRANSCRIPT_GROWTH_TAG = '[OPENAI_TRANSCRIPT_GROWTH]'

type ContinuationMode = 'stateless' | 'stateful'
type EncryptedReasoningMode = 'unknown' | 'enabled' | 'degraded'
type OpenAiResponseItem = Record<string, unknown>

export interface OpenAiAgentRunnerOptions {
  taskId: string
  systemPrompt: string
  userPrompt: string
  workspacePath: string
  outputSchema: Record<string, unknown>
  schemaName: string
  model: string
  reasoningEffort?: string
  baseUrl?: string
  maxToolIterations?: number
}

export interface OpenAiAgentResult {
  success: boolean
  output: string
  structuredOutput?: unknown
  error?: string
  metrics: {
    durationMs: number
    toolCalls: number
    tokensUsed?: {
      input: number
      output: number
      cachedInput?: number
      cacheWrite?: number
    }
    costUsd?: number
  }
}

interface FilterContinuationItemsResult {
  items: OpenAiResponseItem[]
  retainedByType: Record<string, number>
  droppedByType: Record<string, number>
  retainedEncryptedReasoningCount: number
}

function getRequiredOpenAiApiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for OpenAI agent execution')
  }

  return apiKey
}

function getContinuationMode(): 'stateless' {
  const rawMode = process.env.OPENAI_CONTINUATION_MODE?.trim().toLowerCase() || DEFAULT_CONTINUATION_MODE
  if (rawMode !== 'stateless' && rawMode !== 'stateful') {
    throw new Error(
      `Unsupported OPENAI_CONTINUATION_MODE: ${rawMode}. Supported values: stateless, stateful`,
    )
  }

  if (rawMode === 'stateful') {
    throw new Error(
      'OPENAI_CONTINUATION_MODE=stateful is not implemented for the ZDR rollout. Use stateless continuation.',
    )
  }

  return 'stateless'
}

function getMaxToolIterations(options: OpenAiAgentRunnerOptions): number {
  if (options.maxToolIterations !== undefined) {
    return options.maxToolIterations
  }

  const rawValue = process.env[OPENAI_MAX_TOOL_ITERATIONS_ENV]?.trim()
  if (!rawValue) {
    return DEFAULT_MAX_TOOL_ITERATIONS
  }

  const parsedValue = Number(rawValue)
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(
      `${OPENAI_MAX_TOOL_ITERATIONS_ENV} must be a non-negative integer when set; received ${rawValue}`,
    )
  }

  return parsedValue
}

function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    throw new Error('OpenAI agent returned a non-object payload')
  }

  const maybePayload = payload as {
    output_text?: unknown
    output?: Array<{
      type?: string
      content?: Array<{
        type?: string
        text?: string | { value?: string }
      }>
      text?: string | { value?: string }
    }>
  }

  if (typeof maybePayload.output_text === 'string' && maybePayload.output_text.trim()) {
    return maybePayload.output_text
  }

  const parts: string[] = []
  for (const outputItem of maybePayload.output ?? []) {
    if (typeof outputItem.text === 'string' && outputItem.text.trim()) {
      parts.push(outputItem.text)
    } else if (
      outputItem.text
      && typeof outputItem.text === 'object'
      && typeof outputItem.text.value === 'string'
      && outputItem.text.value.trim()
    ) {
      parts.push(outputItem.text.value)
    }

    for (const contentItem of outputItem.content ?? []) {
      if (typeof contentItem.text === 'string' && contentItem.text.trim()) {
        parts.push(contentItem.text)
        continue
      }

      if (
        contentItem.text
        && typeof contentItem.text === 'object'
        && typeof contentItem.text.value === 'string'
        && contentItem.text.value.trim()
      ) {
        parts.push(contentItem.text.value)
      }
    }
  }

  if (parts.length > 0) {
    return parts.join('\n')
  }

  throw new Error('OpenAI agent response did not contain output text')
}

function extractUsage(
  payload: unknown,
): { input: number; output: number; cachedInput: number; cacheWrite: number } | undefined {
  if (!payload || typeof payload !== 'object' || !('usage' in payload)) {
    return undefined
  }

  const usage = (payload as { usage?: Record<string, unknown> }).usage
  if (!usage || typeof usage !== 'object') {
    return undefined
  }

  const input = typeof usage.input_tokens === 'number'
    ? usage.input_tokens
    : typeof usage.prompt_tokens === 'number'
      ? usage.prompt_tokens
      : 0
  const output = typeof usage.output_tokens === 'number'
    ? usage.output_tokens
    : typeof usage.completion_tokens === 'number'
      ? usage.completion_tokens
      : 0
  const cachedInputDetails = usage.input_tokens_details as
    | { cached_tokens?: unknown; cache_write_tokens?: unknown }
    | undefined
  const cachedInput = (
    cachedInputDetails
    && typeof cachedInputDetails.cached_tokens === 'number'
  )
    ? cachedInputDetails.cached_tokens
    : 0
  const cacheWrite = (
    cachedInputDetails
    && typeof cachedInputDetails.cache_write_tokens === 'number'
  )
    ? cachedInputDetails.cache_write_tokens
    : 0

  // Treat all-zero usage payloads as "usage unavailable" so callers do not
  // accidentally aggregate placeholder zeros into billing/accounting metrics.
  if (input === 0 && output === 0 && cachedInput === 0 && cacheWrite === 0) {
    return undefined
  }

  return { input, output, cachedInput, cacheWrite }
}

function extractOutputItems(payload: unknown): OpenAiResponseItem[] {
  if (!payload || typeof payload !== 'object' || !('output' in payload)) {
    return []
  }

  const output = (payload as { output?: Array<Record<string, unknown>> }).output
  if (!Array.isArray(output)) {
    return []
  }

  return output.filter(item => item && typeof item === 'object')
}

function extractFunctionCalls(payload: unknown): OpenAiFunctionCall[] {
  return extractOutputItems(payload)
    .filter(item => item?.type === 'function_call')
    .map((item) => ({
      callId: typeof item.call_id === 'string' ? item.call_id : '',
      name: typeof item.name === 'string' ? item.name : '',
      arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
    }))
    .filter(call => call.callId && call.name)
}

function buildUserPromptInputItem(userPrompt: string): OpenAiResponseItem {
  return {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: userPrompt,
      },
    ],
  }
}

function buildTextFormat(options: OpenAiAgentRunnerOptions): Record<string, unknown> {
  return {
    format: {
      type: 'json_schema',
      name: options.schemaName,
      strict: true,
      schema: options.outputSchema,
    },
  }
}

function buildReasoningConfig(options: OpenAiAgentRunnerOptions): Record<string, unknown> | undefined {
  return options.reasoningEffort
    ? { effort: options.reasoningEffort }
    : undefined
}

function buildIncludeConfig(includeEncryptedReasoning: boolean): string[] | undefined {
  return includeEncryptedReasoning ? ['reasoning.encrypted_content'] : undefined
}

function buildInitialResponseRequest(
  options: OpenAiAgentRunnerOptions,
  tools: Array<Record<string, unknown>>,
  includeEncryptedReasoning: boolean,
): Record<string, unknown> {
  const include = buildIncludeConfig(includeEncryptedReasoning)
  return {
    model: options.model,
    instructions: options.systemPrompt,
    input: options.userPrompt,
    reasoning: buildReasoningConfig(options),
    ...(include ? { include } : {}),
    tools,
    text: buildTextFormat(options),
  }
}

function buildStatelessContinuationRequest(
  options: OpenAiAgentRunnerOptions,
  transcriptItems: OpenAiResponseItem[],
  tools: Array<Record<string, unknown>>,
  includeEncryptedReasoning: boolean,
): Record<string, unknown> {
  const include = buildIncludeConfig(includeEncryptedReasoning)
  return {
    model: options.model,
    instructions: options.systemPrompt,
    input: [...transcriptItems],
    reasoning: buildReasoningConfig(options),
    ...(include ? { include } : {}),
    tools,
    text: buildTextFormat(options),
  }
}

function filterContinuationItems(items: OpenAiResponseItem[]): FilterContinuationItemsResult {
  const retainedByType: Record<string, number> = {}
  const droppedByType: Record<string, number> = {}
  let retainedEncryptedReasoningCount = 0

  const retainedItems = items.filter((item) => {
    const type = typeof item.type === 'string' ? item.type : 'unknown'

    if (type === 'message' || type === 'function_call' || type === 'function_call_output') {
      retainedByType[type] = (retainedByType[type] ?? 0) + 1
      return true
    }

    if (type === 'reasoning') {
      if (typeof item.encrypted_content === 'string' && item.encrypted_content.trim()) {
        retainedByType[type] = (retainedByType[type] ?? 0) + 1
        retainedEncryptedReasoningCount += 1
        return true
      }
      droppedByType[type] = (droppedByType[type] ?? 0) + 1
      return false
    }

    droppedByType[type] = (droppedByType[type] ?? 0) + 1
    return false
  })

  return {
    items: retainedItems,
    retainedByType,
    droppedByType,
    retainedEncryptedReasoningCount,
  }
}

function buildToolErrorOutput(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return JSON.stringify({
    ok: false,
    error: message,
  })
}

function isEncryptedReasoningIncludeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()

  if (normalized.includes('reasoning.encrypted_content') || normalized.includes('encrypted_content')) {
    return true
  }

  return normalized.includes('include')
    && (
      normalized.includes('invalid')
      || normalized.includes('unknown')
      || normalized.includes('unsupported')
      || normalized.includes('unrecognized')
      || normalized.includes('not allowed')
    )
}

function estimateInputTokensFromItems(items: OpenAiResponseItem[]): number {
  if (items.length === 0) {
    return 0
  }

  // Rough transcript-growth estimate for rollout diagnostics only. Use the
  // provider usage payloads, not this estimate, for billing-accurate numbers.
  return Math.ceil(Buffer.byteLength(JSON.stringify(items), 'utf8') / 4)
}

async function createInitialResponse(
  client: OpenAI,
  options: OpenAiAgentRunnerOptions,
  tools: Array<Record<string, unknown>>,
): Promise<{ response: unknown; encryptedReasoningMode: EncryptedReasoningMode }> {
  try {
    const response = await client.responses.create(
      buildInitialResponseRequest(options, tools, true) as never,
    )
    return { response, encryptedReasoningMode: 'unknown' }
  } catch (error) {
    if (!isEncryptedReasoningIncludeError(error)) {
      throw error
    }

    logger.warn({
      taskId: options.taskId,
      model: options.model,
      errorMessage: error instanceof Error ? error.message : String(error),
    }, 'Encrypted reasoning include rejected on initial request; retrying without include')

    const response = await client.responses.create(
      buildInitialResponseRequest(options, tools, false) as never,
    )

    logger.warn({
      taskId: options.taskId,
      model: options.model,
    }, 'Encrypted reasoning unavailable; continuing in degraded stateless mode')

    return { response, encryptedReasoningMode: 'degraded' }
  }
}

function updateEncryptedReasoningMode(
  currentMode: EncryptedReasoningMode,
  retainedEncryptedReasoningCount: number,
  options: OpenAiAgentRunnerOptions,
): EncryptedReasoningMode {
  if (currentMode !== 'unknown') {
    return currentMode
  }

  if (retainedEncryptedReasoningCount > 0) {
    logger.info({
      taskId: options.taskId,
      model: options.model,
    }, 'Encrypted reasoning accepted and available for stateless continuation')
    return 'enabled'
  }

  logger.warn({
    taskId: options.taskId,
    model: options.model,
  }, 'Encrypted reasoning not returned; continuing in degraded stateless mode')
  return 'degraded'
}

// OpenAI continuation is stateless for the current ZDR rollout. The SDK keeps
// a future-facing continuation-mode boundary, but phase 1 only implements the
// stateless transcript path and fails fast if stateful mode is selected.
export async function runOpenAiAgent(
  options: OpenAiAgentRunnerOptions,
): Promise<OpenAiAgentResult> {
  const startTime = Date.now()
  const apiKey = getRequiredOpenAiApiKey()
  const continuationMode = getContinuationMode()
  const baseURL = options.baseUrl?.trim() || process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL
  const client = new OpenAI({ apiKey, baseURL })
  const repoTools = createReadOnlyRepoTools(options.workspacePath)
  const maxToolIterations = getMaxToolIterations(options)
  let toolCallCount = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCachedInputTokens = 0
  let totalCacheWriteTokens = 0
  const conversationItems: OpenAiResponseItem[] = [buildUserPromptInputItem(options.userPrompt)]

  logger.info({
    taskId: options.taskId,
    model: options.model,
    workspacePath: options.workspacePath,
    schemaName: options.schemaName,
    continuationMode,
  }, 'Starting OpenAI agent task')

  try {
    const initialResponse = await createInitialResponse(client, options, repoTools.tools)
    let response = initialResponse.response
    let encryptedReasoningMode = initialResponse.encryptedReasoningMode

    for (let iteration = 0; iteration <= maxToolIterations; iteration += 1) {
      const usage = extractUsage(response)
      if (usage) {
        totalInputTokens += usage.input
        totalOutputTokens += usage.output
        totalCachedInputTokens += usage.cachedInput
        totalCacheWriteTokens += usage.cacheWrite
      }

      const continuationItems = filterContinuationItems(extractOutputItems(response))
      if (continuationItems.items.length > 0) {
        conversationItems.push(...continuationItems.items)
      }

      logger.debug({
        taskId: options.taskId,
        iteration,
        retainedByType: continuationItems.retainedByType,
        droppedByType: continuationItems.droppedByType,
      }, 'Filtered OpenAI continuation items')

      encryptedReasoningMode = updateEncryptedReasoningMode(
        encryptedReasoningMode,
        continuationItems.retainedEncryptedReasoningCount,
        options,
      )

      const functionCalls = extractFunctionCalls(response)
      if (functionCalls.length === 0) {
        const rawOutput = extractResponseText(response)
        let structuredOutput: unknown
        try {
          structuredOutput = JSON.parse(rawOutput)
        } catch {
          structuredOutput = undefined
        }

        const tokensUsed = totalInputTokens > 0 || totalOutputTokens > 0
          ? {
            input: totalInputTokens,
            output: totalOutputTokens,
            cachedInput: totalCachedInputTokens > 0 ? totalCachedInputTokens : undefined,
            cacheWrite: totalCacheWriteTokens > 0 ? totalCacheWriteTokens : undefined,
          }
          : undefined

        return {
          success: true,
          output: rawOutput,
          structuredOutput,
          metrics: {
            durationMs: Date.now() - startTime,
            toolCalls: toolCallCount,
            tokensUsed,
            costUsd: calculateUsageCostUsd('openai', options.model, tokensUsed),
          },
        }
      }

      if (iteration === maxToolIterations) {
        throw new Error(`OpenAI agent exceeded max tool iterations (${maxToolIterations})`)
      }

      const toolOutputs: OpenAiResponseItem[] = []
      for (const call of functionCalls) {
        let output: unknown
        try {
          output = await repoTools.execute(call)
        } catch (error) {
          logger.warn({
            taskId: options.taskId,
            tool: call.name,
            callId: call.callId,
            error: error instanceof Error ? error.message : String(error),
          }, 'OpenAI repo tool failed')
          output = buildToolErrorOutput(error)
        }

        toolOutputs.push({
          type: 'function_call_output',
          call_id: call.callId,
          output: typeof output === 'string' ? output : JSON.stringify(output),
        })
        toolCallCount += 1
      }

      conversationItems.push(...toolOutputs)

      const estimatedInputTokens = estimateInputTokensFromItems(conversationItems)
      logger.info({
        taskId: options.taskId,
        turn: iteration + 1,
        itemCount: conversationItems.length,
        estimatedInputTokens,
      }, OPENAI_TRANSCRIPT_GROWTH_TAG)

      logger.debug({
        taskId: options.taskId,
        iteration,
        toolCalls: functionCalls.map(call => call.name),
        encryptedReasoningMode,
      }, 'Continuing OpenAI agent after tool execution')

      response = await client.responses.create(
        buildStatelessContinuationRequest(
          options,
          conversationItems,
          repoTools.tools,
          encryptedReasoningMode !== 'degraded',
        ) as never,
      )
    }

    throw new Error('OpenAI agent stopped without producing a final response')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error({
      taskId: options.taskId,
      error: message,
    }, 'OpenAI agent task failed')

    const tokensUsed = totalInputTokens > 0 || totalOutputTokens > 0
      ? {
        input: totalInputTokens,
        output: totalOutputTokens,
        cachedInput: totalCachedInputTokens > 0 ? totalCachedInputTokens : undefined,
        cacheWrite: totalCacheWriteTokens > 0 ? totalCacheWriteTokens : undefined,
      }
      : undefined

    return {
      success: false,
      output: '',
      error: message,
      metrics: {
        durationMs: Date.now() - startTime,
        toolCalls: toolCallCount,
        tokensUsed,
        costUsd: calculateUsageCostUsd('openai', options.model, tokensUsed),
      },
    }
  }
}
