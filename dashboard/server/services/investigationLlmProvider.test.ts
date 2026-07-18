import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InvokeModelCommand, InvokeModelCommandOutput } from '@aws-sdk/client-bedrock-runtime'
import {
  getInvestigationLlmConfig,
  runInvestigationLlmJson,
} from './investigationLlmProvider.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('investigationLlmProvider', () => {
  it('keeps the Bedrock profile separate from the client investigation profile', () => {
    vi.stubEnv('INVESTIGATION_AWS_PROFILE', 'client-prod')
    vi.stubEnv('INVESTIGATION_LLM_AWS_PROFILE', 'platform-bedrock')
    vi.stubEnv('INVESTIGATION_LLM_AWS_REGION', 'us-west-2')
    vi.stubEnv('INVESTIGATION_LLM_MODEL_ID', 'us.anthropic.claude-sonnet-test')

    expect(getInvestigationLlmConfig()).toEqual({
      awsProfile: 'platform-bedrock',
      region: 'us-west-2',
      modelId: 'us.anthropic.claude-sonnet-test',
    })
  })

  it('does not inherit the client discovery region for Bedrock', () => {
    vi.stubEnv('AWS_REGION', 'us-west-2')
    vi.stubEnv('INVESTIGATION_LLM_AWS_REGION', '')
    vi.stubEnv('BEDROCK_AWS_REGION', '')

    expect(getInvestigationLlmConfig().region).toBe('us-east-2')
  })

  it('invokes Bedrock directly with no tools and a schema-constrained JSON prompt', async () => {
    vi.stubEnv('INVESTIGATION_AWS_PROFILE', 'client-prod')
    vi.stubEnv('INVESTIGATION_LLM_AWS_PROFILE', 'platform-bedrock')
    vi.stubEnv('INVESTIGATION_LLM_AWS_REGION', 'us-east-2')
    vi.stubEnv('INVESTIGATION_LLM_MODEL_ID', 'us.anthropic.claude-sonnet-test')
    let captured: InvokeModelCommand | undefined
    const response = await runInvestigationLlmJson<{ status: string }>({
      systemPrompt: 'Classify evidence gaps.',
      userPrompt: 'Evidence summary.',
      schema: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string' } },
      },
      maxTokens: 900,
      timeoutMs: 60_000,
    }, config => ({
      async send(command): Promise<InvokeModelCommandOutput> {
        captured = command
        expect(config).toEqual({
          awsProfile: 'platform-bedrock',
          region: 'us-east-2',
          modelId: 'us.anthropic.claude-sonnet-test',
        })
        return {
          body: new TextEncoder().encode(JSON.stringify({
            content: [{ type: 'text', text: '{"status":"ok"}' }],
            usage: { input_tokens: 12, output_tokens: 4 },
          })),
          $metadata: {},
        }
      },
    }))

    const input = captured?.input
    const body = JSON.parse(new TextDecoder().decode(input?.body as Uint8Array))
    expect(input).toMatchObject({
      modelId: 'us.anthropic.claude-sonnet-test',
      contentType: 'application/json',
      accept: 'application/json',
    })
    expect(body).toMatchObject({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 900,
      temperature: 0,
      system: 'Classify evidence gaps.',
    })
    expect(JSON.stringify(body)).toContain('Return only one JSON object')
    expect(JSON.stringify(body)).not.toContain('tools')
    expect(response).toMatchObject({
      providerKey: 'bedrock_runtime',
      modelId: 'us.anthropic.claude-sonnet-test',
      parsed: { status: 'ok' },
      metrics: { toolCalls: 0, inputTokens: 12, outputTokens: 4 },
    })
  })
})
