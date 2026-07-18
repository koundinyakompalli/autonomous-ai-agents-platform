import { describe, expect, it } from 'vitest'
import {
  parseJsonFromTextWithRepair,
  parseValidatedJsonFromTextWithRepair,
  parseJsonWithRepair,
  sanitizeControlCharactersInJsonStrings,
} from './json-utils.js'

describe('claude-sdk json utils', () => {
  it('escapes literal newlines inside JSON string values', () => {
    const raw = '{"renderedMarkdown":"line one\nline two"}'
    const sanitized = sanitizeControlCharactersInJsonStrings(raw)
    expect(sanitized).toBe('{"renderedMarkdown":"line one\\nline two"}')
  })

  it('parses JSON with literal control characters in string values', () => {
    const raw = '{"renderedMarkdown":"line one\nline two\tindent"}'
    const parsed = parseJsonWithRepair(raw)
    expect(parsed.repaired).toBe(true)
    expect(parsed.strategy).toBe('control_chars')
    expect(parsed.value).toEqual({
      renderedMarkdown: 'line one\nline two\tindent',
    })
  })

  it('repairs common malformed object literal output', () => {
    const raw = `{jiraKey:'CPDEV-1', summary:'ok', scope:['a','b',], requirements:['r1' 'r2'], renderedMarkdown:"line one\nline two"}`
    const parsed = parseJsonWithRepair(raw)
    expect(parsed.repaired).toBe(true)
    expect(parsed.strategy).toBe('jsonrepair')
    expect(parsed.value).toEqual({
      jiraKey: 'CPDEV-1',
      summary: 'ok',
      scope: ['a', 'b'],
      requirements: ['r1', 'r2'],
      renderedMarkdown: 'line one\nline two',
    })
  })

  it('extracts and parses a JSON object embedded in surrounding text', () => {
    const raw = 'prefix {"summary":"ok","renderedMarkdown":"a\nb"} suffix'
    const parsed = parseJsonFromTextWithRepair(raw)
    expect(parsed.repaired).toBe(true)
    expect(parsed.candidateSource).toBe('inline')
    expect(parsed.value).toEqual({
      summary: 'ok',
      renderedMarkdown: 'a\nb',
    })
  })

  it('extracts and repairs JSON from code fences', () => {
    const raw = `Here is the response:

\`\`\`json
{jiraKey:'CPDEV-1', impactedFiles:['a.ts' 'b.ts'], renderedMarkdown:"hello\nworld"}
\`\`\``

    const parsed = parseJsonFromTextWithRepair(raw)
    expect(parsed.repaired).toBe(true)
    expect(parsed.candidateSource).toBe('code_block')
    expect(parsed.value).toEqual({
      jiraKey: 'CPDEV-1',
      impactedFiles: ['a.ts', 'b.ts'],
      renderedMarkdown: 'hello\nworld',
    })
  })

  it('skips invalid JSON candidates until one matches the expected schema', () => {
    const raw = `First attempt:

\`\`\`json
{"summary":"missing required fields"}
\`\`\`

Second attempt:

\`\`\`json
{
  "jiraKey": "CPDEV-1",
  "repoName": "core-app",
  "branchName": "master",
  "baseCommitSha": "0123456789abcdef0123456789abcdef01234567",
  "summary": "Implement the approved PFOS change.",
  "specs": [
    {
      "id": "spec-1",
      "objective": "Wire the queue consumer.",
      "acceptanceCriteria": ["Queue message is consumed."],
      "targetFiles": ["src/oneshot/consumer.ts"],
      "implementationNotes": ["Follow existing queue patterns."],
      "validationSteps": ["Run vitest src/oneshot."]
    }
  ]
}
\`\`\``

    const parsed = parseValidatedJsonFromTextWithRepair(raw, (value) => {
      const candidate = value as Record<string, unknown>
      if (!candidate.jiraKey || !candidate.summary || !Array.isArray(candidate.specs)) {
        throw new Error('candidate does not match plan shape')
      }

      return candidate
    })

    expect(parsed.candidateSource).toBe('code_block')
    expect(parsed.value).toMatchObject({
      jiraKey: 'CPDEV-1',
      repoName: 'core-app',
      branchName: 'master',
      summary: 'Implement the approved PFOS change.',
    })
  })
})
