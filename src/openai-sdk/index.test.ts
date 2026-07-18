import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  openAiMock,
  responsesCreateMock,
  loggerInfoMock,
  loggerWarnMock,
  loggerDebugMock,
  loggerErrorMock,
} = vi.hoisted(() => {
  const responsesCreateMock = vi.fn()
  const loggerInfoMock = vi.fn()
  const loggerWarnMock = vi.fn()
  const loggerDebugMock = vi.fn()
  const loggerErrorMock = vi.fn()
  return {
    responsesCreateMock,
    loggerInfoMock,
    loggerWarnMock,
    loggerDebugMock,
    loggerErrorMock,
    openAiMock: vi.fn(function OpenAIMock() {
      return {
        responses: {
          create: responsesCreateMock,
        },
      }
    }),
  }
})

vi.mock('openai', () => ({
  default: openAiMock,
}))

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: loggerInfoMock,
    warn: loggerWarnMock,
    debug: loggerDebugMock,
    error: loggerErrorMock,
  })),
}))

const ORIGINAL_ENV = { ...process.env }

function buildOptions(overrides: Partial<import('./index.js').OpenAiAgentRunnerOptions> = {}): import('./index.js').OpenAiAgentRunnerOptions {
  return {
    taskId: 'openai-test-task',
    systemPrompt: 'Review the plan',
    userPrompt: 'Return JSON',
    workspacePath: '/tmp/workspace',
    outputSchema: {
      type: 'object',
      properties: {
        decision: { type: 'string' },
      },
      required: ['decision'],
    },
    schemaName: 'review_schema',
    model: 'gpt-5.4',
    ...overrides,
  }
}

describe('runOpenAiAgent', () => {
  beforeEach(() => {
    vi.resetModules()
    responsesCreateMock.mockReset()
    openAiMock.mockClear()
    loggerInfoMock.mockReset()
    loggerWarnMock.mockReset()
    loggerDebugMock.mockReset()
    loggerErrorMock.mockReset()
    process.env = { ...ORIGINAL_ENV }
    process.env.OPENAI_API_KEY = 'test-openai-key'
    delete process.env.OPENAI_CONTINUATION_MODE
    delete process.env.OPENAI_MAX_TOOL_ITERATIONS
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.unstubAllEnvs()
  })

  it('returns a direct final response without tool calls', async () => {
    const { runOpenAiAgent } = await import('./index.js')
    responsesCreateMock.mockResolvedValue({
      id: 'resp-final',
      output_text: '{"decision":"APPROVED"}',
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        input_tokens_details: {
          cached_tokens: 250_000,
        },
      },
    })

    const result = await runOpenAiAgent(buildOptions())

    expect(result.success).toBe(true)
    expect(result.output).toBe('{"decision":"APPROVED"}')
    expect(result.structuredOutput).toEqual({ decision: 'APPROVED' })
    expect(result.metrics.tokensUsed).toEqual({
      input: 1_000_000,
      output: 100_000,
      cachedInput: 250_000,
    })
    expect(result.metrics.costUsd).toBe(3.4375)
    expect(responsesCreateMock).toHaveBeenCalledTimes(1)
    expect(responsesCreateMock.mock.calls[0]?.[0]).toMatchObject({
      input: 'Return JSON',
      include: ['reasoning.encrypted_content'],
    })
  })

  it('reports and prices OpenAI cache-write tokens', async () => {
    const { runOpenAiAgent } = await import('./index.js')
    responsesCreateMock.mockResolvedValue({
      id: 'resp-final',
      output_text: '{"decision":"APPROVED"}',
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        input_tokens_details: {
          cached_tokens: 200_000,
          cache_write_tokens: 100_000,
        },
      },
    })

    const result = await runOpenAiAgent(buildOptions({ model: 'gpt-5.6-luna' }))

    expect(result.metrics.tokensUsed).toEqual({
      input: 1_000_000,
      output: 100_000,
      cachedInput: 200_000,
      cacheWrite: 100_000,
    })
    expect(result.metrics.costUsd).toBe(1.445)
  })

  it('continues statelessly without previous_response_id after tool errors', async () => {
    const { runOpenAiAgent } = await import('./index.js')
    responsesCreateMock
      .mockResolvedValueOnce({
        id: 'resp-1',
        usage: {
          input_tokens: 5,
          output_tokens: 3,
        },
        output: [
          {
            type: 'function_call',
            call_id: 'call-1',
            name: 'read_file',
            arguments: JSON.stringify({ path: '../secret.txt' }),
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'resp-2',
        output_text: '{"decision":"APPROVED"}',
        usage: {
          input_tokens: 6,
          output_tokens: 4,
        },
      })

    const result = await runOpenAiAgent(buildOptions({ reasoningEffort: 'high' }))

    expect(result.success).toBe(true)
    expect(result.structuredOutput).toEqual({ decision: 'APPROVED' })
    expect(result.metrics.toolCalls).toBe(1)

    const continuationRequest = responsesCreateMock.mock.calls[1]?.[0] as {
      previous_response_id?: string
      input: Array<Record<string, unknown>>
      tools: Array<unknown>
      reasoning?: { effort: string }
      include?: string[]
    }

    expect(continuationRequest.previous_response_id).toBeUndefined()
    expect(continuationRequest.reasoning).toEqual({ effort: 'high' })
    expect(continuationRequest.tools).toBeDefined()
    expect(continuationRequest.include).toBeUndefined()
    expect(continuationRequest.input).toHaveLength(3)
    expect(continuationRequest.input[0]).toMatchObject({
      type: 'message',
      role: 'user',
    })
    expect(continuationRequest.input[1]).toMatchObject({
      type: 'function_call',
      call_id: 'call-1',
      name: 'read_file',
    })
    expect(continuationRequest.input[2]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call-1',
    })
    expect(JSON.parse(String(continuationRequest.input[2]?.output))).toMatchObject({
      ok: false,
      error: expect.stringContaining('outside the workspace'),
    })
  })

  it('carries encrypted reasoning items forward when available', async () => {
    const { runOpenAiAgent } = await import('./index.js')
    responsesCreateMock
      .mockResolvedValueOnce({
        id: 'resp-1',
        usage: {
          input_tokens: 9,
          output_tokens: 5,
        },
        output: [
          {
            type: 'reasoning',
            encrypted_content: 'enc-1',
          },
          {
            type: 'reasoning',
            summary: [{ text: 'drop me' }],
          },
          {
            type: 'function_call',
            call_id: 'call-2',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '.' }),
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'resp-2',
        output_text: '{"decision":"APPROVED"}',
        usage: {
          input_tokens: 7,
          output_tokens: 4,
        },
      })

    const result = await runOpenAiAgent(buildOptions())

    expect(result.success).toBe(true)

    const continuationRequest = responsesCreateMock.mock.calls[1]?.[0] as {
      input: Array<Record<string, unknown>>
      include?: string[]
    }

    expect(continuationRequest.include).toEqual(['reasoning.encrypted_content'])
    expect(continuationRequest.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'reasoning',
          encrypted_content: 'enc-1',
        }),
      ]),
    )
    expect(continuationRequest.input).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'reasoning',
          summary: expect.anything(),
        }),
      ]),
    )
  })

  it('retries the first request without encrypted reasoning include when unsupported', async () => {
    const { runOpenAiAgent } = await import('./index.js')
    responsesCreateMock
      .mockRejectedValueOnce(new Error('Invalid include value reasoning.encrypted_content'))
      .mockResolvedValueOnce({
        id: 'resp-1b',
        usage: {
          input_tokens: 4,
          output_tokens: 2,
        },
        output: [
          {
            type: 'function_call',
            call_id: 'call-3',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '.' }),
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'resp-2',
        output_text: '{"decision":"APPROVED"}',
        usage: {
          input_tokens: 3,
          output_tokens: 1,
        },
      })

    const result = await runOpenAiAgent(buildOptions())

    expect(result.success).toBe(true)
    expect(responsesCreateMock.mock.calls[0]?.[0]).toMatchObject({
      include: ['reasoning.encrypted_content'],
    })
    expect(responsesCreateMock.mock.calls[1]?.[0]).not.toHaveProperty('include')
    expect(responsesCreateMock.mock.calls[2]?.[0]).not.toHaveProperty('include')
  })

  it('fails the run if encrypted reasoning include retry also fails', async () => {
    const { runOpenAiAgent } = await import('./index.js')
    responsesCreateMock
      .mockRejectedValueOnce(new Error('Invalid include value reasoning.encrypted_content'))
      .mockRejectedValueOnce(new Error('Temporary upstream failure'))

    const result = await runOpenAiAgent(buildOptions())

    expect(result.success).toBe(false)
    expect(result.error).toContain('Temporary upstream failure')
    expect(responsesCreateMock).toHaveBeenCalledTimes(2)
  })

  it('aggregates total input tokens without double-counting cached input semantics', async () => {
    const { runOpenAiAgent } = await import('./index.js')
    responsesCreateMock
      .mockResolvedValueOnce({
        id: 'resp-1',
        usage: {
          input_tokens: 120,
          output_tokens: 12,
        },
        output: [
          {
            type: 'function_call',
            call_id: 'call-4',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '.' }),
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'resp-2',
        output_text: '{"decision":"APPROVED"}',
        usage: {
          input_tokens: 240,
          output_tokens: 18,
          input_tokens_details: {
            cached_tokens: 80,
          },
        },
      })

    const result = await runOpenAiAgent(buildOptions())

    expect(result.success).toBe(true)
    expect(result.metrics.tokensUsed).toEqual({
      input: 360,
      output: 30,
      cachedInput: 80,
    })
  })

  it('supports multiple continuation turns without previous_response_id', async () => {
    const { runOpenAiAgent } = await import('./index.js')
    responsesCreateMock
      .mockResolvedValueOnce({
        id: 'resp-1',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
        },
        output: [
          {
            type: 'function_call',
            call_id: 'call-a',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '.' }),
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'resp-2',
        usage: {
          input_tokens: 20,
          output_tokens: 3,
        },
        output: [
          {
            type: 'function_call',
            call_id: 'call-b',
            name: 'glob_search',
            arguments: JSON.stringify({ pattern: '**/*.ts', cwd: '.' }),
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'resp-3',
        output_text: '{"decision":"APPROVED"}',
        usage: {
          input_tokens: 30,
          output_tokens: 4,
        },
      })

    const result = await runOpenAiAgent(buildOptions())

    expect(result.success).toBe(true)
    expect(result.metrics.toolCalls).toBe(2)

    const secondContinuation = responsesCreateMock.mock.calls[2]?.[0] as {
      previous_response_id?: string
      input: Array<Record<string, unknown>>
    }

    expect(secondContinuation.previous_response_id).toBeUndefined()
    expect(secondContinuation.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ call_id: 'call-a', type: 'function_call' }),
        expect.objectContaining({ call_id: 'call-a', type: 'function_call_output' }),
        expect.objectContaining({ call_id: 'call-b', type: 'function_call' }),
        expect.objectContaining({ call_id: 'call-b', type: 'function_call_output' }),
      ]),
    )
    expect(secondContinuation.input.length).toBeGreaterThan(
      (responsesCreateMock.mock.calls[1]?.[0] as { input: Array<Record<string, unknown>> }).input.length,
    )

    const transcriptGrowthLogs = loggerInfoMock.mock.calls.filter(
      ([fields, message]) => fields?.turn && message === '[OPENAI_TRANSCRIPT_GROWTH]',
    )
    expect(transcriptGrowthLogs).toHaveLength(2)
    expect(transcriptGrowthLogs.map(([fields]) => fields.turn)).toEqual([1, 2])
  })

  it('honors OPENAI_MAX_TOOL_ITERATIONS for longer review loops', async () => {
    process.env.OPENAI_MAX_TOOL_ITERATIONS = '50'
    const { runOpenAiAgent } = await import('./index.js')

    for (let index = 0; index < 50; index += 1) {
      responsesCreateMock.mockResolvedValueOnce({
        id: `resp-tool-${index}`,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
        output: [
          {
            type: 'function_call',
            call_id: `call-tool-${index}`,
            name: 'list_directory',
            arguments: JSON.stringify({ path: '.', maxDepth: 0 }),
          },
        ],
      })
    }
    responsesCreateMock.mockResolvedValueOnce({
      id: 'resp-final',
      output_text: '{"decision":"APPROVED"}',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    })

    const result = await runOpenAiAgent(buildOptions())

    expect(result.success).toBe(true)
    expect(result.metrics.toolCalls).toBe(50)
    expect(responsesCreateMock).toHaveBeenCalledTimes(51)
  })

  it('uses a default tool-iteration budget large enough for reviewer loops', async () => {
    const { runOpenAiAgent } = await import('./index.js')

    for (let index = 0; index < 13; index += 1) {
      responsesCreateMock.mockResolvedValueOnce({
        id: `resp-default-tool-${index}`,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
        output: [
          {
            type: 'function_call',
            call_id: `call-default-tool-${index}`,
            name: 'list_directory',
            arguments: JSON.stringify({ path: '.', maxDepth: 0 }),
          },
        ],
      })
    }
    responsesCreateMock.mockResolvedValueOnce({
      id: 'resp-final',
      output_text: '{"decision":"APPROVED"}',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    })

    const result = await runOpenAiAgent(buildOptions())

    expect(result.success).toBe(true)
    expect(result.metrics.toolCalls).toBe(13)
    expect(responsesCreateMock).toHaveBeenCalledTimes(14)
  })

  it('fails fast when OPENAI_MAX_TOOL_ITERATIONS is invalid', async () => {
    process.env.OPENAI_MAX_TOOL_ITERATIONS = 'twelve'
    const { runOpenAiAgent } = await import('./index.js')

    await expect(runOpenAiAgent(buildOptions())).rejects.toThrow(
      'OPENAI_MAX_TOOL_ITERATIONS must be a non-negative integer when set; received twelve',
    )
    expect(responsesCreateMock).not.toHaveBeenCalled()
  })

  it('fails fast when stateful continuation mode is selected', async () => {
    process.env.OPENAI_CONTINUATION_MODE = 'stateful'
    const { runOpenAiAgent } = await import('./index.js')

    await expect(runOpenAiAgent(buildOptions())).rejects.toThrow(
      'OPENAI_CONTINUATION_MODE=stateful is not implemented for the ZDR rollout. Use stateless continuation.',
    )
  })

  it('produces the same decision class for the same transcript across retries', async () => {
    const { runOpenAiAgent } = await import('./index.js')
    responsesCreateMock
      .mockResolvedValueOnce({
        id: 'resp-run-1-step-1',
        usage: {
          input_tokens: 5,
          output_tokens: 2,
        },
        output: [
          {
            type: 'function_call',
            call_id: 'call-retry-1',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '.' }),
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'resp-run-1-step-2',
        output_text: '{"decision":"APPROVED"}',
        usage: {
          input_tokens: 6,
          output_tokens: 3,
        },
      })
      .mockResolvedValueOnce({
        id: 'resp-run-2-step-1',
        usage: {
          input_tokens: 5,
          output_tokens: 2,
        },
        output: [
          {
            type: 'function_call',
            call_id: 'call-retry-2',
            name: 'list_directory',
            arguments: JSON.stringify({ path: '.' }),
          },
        ],
      })
      .mockResolvedValueOnce({
        id: 'resp-run-2-step-2',
        output_text: '{"decision":"APPROVED"}',
        usage: {
          input_tokens: 7,
          output_tokens: 4,
        },
      })

    const first = await runOpenAiAgent(buildOptions())
    const second = await runOpenAiAgent(buildOptions())

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect((first.structuredOutput as { decision: string }).decision).toBe('APPROVED')
    expect((second.structuredOutput as { decision: string }).decision).toBe('APPROVED')
  })
})
