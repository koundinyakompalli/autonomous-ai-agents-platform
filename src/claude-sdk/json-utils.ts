import { jsonrepair } from 'jsonrepair'

export interface JsonRepairParseResult {
  value: unknown
  repaired: boolean
  strategy: 'direct' | 'control_chars' | 'jsonrepair' | 'control_chars+jsonrepair'
  candidateSource?: 'raw' | 'code_block' | 'inline'
}

interface JsonTextCandidate {
  candidate: string
  candidateSource: JsonRepairParseResult['candidateSource']
}

interface ParseAttempt {
  strategy: JsonRepairParseResult['strategy']
  text: string
}

function escapeControlCharacter(char: string): string {
  switch (char) {
    case '\n':
      return '\\n'
    case '\r':
      return '\\r'
    case '\t':
      return '\\t'
    case '\b':
      return '\\b'
    case '\f':
      return '\\f'
    default:
      return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  }
}

function normalizeJsonLikeText(input: string): string {
  return input
    .replace(/^\uFEFF/, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
}

export function sanitizeControlCharactersInJsonStrings(input: string): string {
  let result = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]

    if (inString) {
      if (escaped) {
        result += char
        escaped = false
        continue
      }

      if (char === '\\') {
        result += char
        escaped = true
        continue
      }

      if (char === '"') {
        result += char
        inString = false
        continue
      }

      if (char.charCodeAt(0) < 0x20) {
        result += escapeControlCharacter(char)
        continue
      }

      result += char
      continue
    }

    if (char === '"') {
      inString = true
    }

    result += char
  }

  return result
}

function buildParseAttempts(raw: string): ParseAttempt[] {
  const normalized = normalizeJsonLikeText(raw).trim()
  const sanitized = sanitizeControlCharactersInJsonStrings(normalized)
  const attempts: ParseAttempt[] = []
  const seen = new Set<string>()

  const addAttempt = (strategy: ParseAttempt['strategy'], text: string) => {
    const candidate = text.trim()
    if (!candidate || seen.has(candidate)) {
      return
    }

    seen.add(candidate)
    attempts.push({ strategy, text: candidate })
  }

  addAttempt('direct', normalized)
  addAttempt('control_chars', sanitized)

  try {
    addAttempt('jsonrepair', jsonrepair(normalized))
  } catch {
    // Ignore and keep trying other strategies.
  }

  try {
    addAttempt('control_chars+jsonrepair', jsonrepair(sanitized))
  } catch {
    // Ignore and keep trying other strategies.
  }

  return attempts
}

export function parseJsonWithRepair(raw: string): JsonRepairParseResult {
  let lastError: unknown

  for (const attempt of buildParseAttempts(raw)) {
    try {
      return {
        value: JSON.parse(attempt.text),
        repaired: attempt.strategy !== 'direct',
        strategy: attempt.strategy,
      }
    } catch (error) {
      lastError = error
    }
  }

  if (lastError instanceof Error) {
    throw lastError
  }

  throw new Error('Unable to parse JSON after all repair attempts')
}

function extractBalancedJsonCandidate(text: string, startIndex: number): string | null {
  const opening = text[startIndex]
  if (opening !== '{' && opening !== '[') {
    return null
  }

  const stack: string[] = [opening]
  let inString = false
  let escaped = false

  for (let i = startIndex + 1; i < text.length; i += 1) {
    const char = text[i]

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }

      if (char === '\\') {
        escaped = true
        continue
      }

      if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '{' || char === '[') {
      stack.push(char)
      continue
    }

    if (char === '}' || char === ']') {
      const last = stack[stack.length - 1]
      const matches =
        (last === '{' && char === '}') ||
        (last === '[' && char === ']')

      if (!matches) {
        return null
      }

      stack.pop()
      if (stack.length === 0) {
        return text.slice(startIndex, i + 1)
      }
    }
  }

  return null
}

function extractCodeBlockCandidates(text: string): string[] {
  const candidates: string[] = []
  const patterns = [
    /```(?:json|JSON)?\s*\n([\s\S]*?)\n\s*```/g,
    /```\s*\n([\s\S]*?)\n\s*```/g,
  ]

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) {
        candidates.push(match[1].trim())
      }
    }
  }

  return candidates
}

function extractJsonTextCandidates(output: string): JsonTextCandidate[] {
  const raw = output.trim()
  const candidates: JsonTextCandidate[] = []
  const seenCandidates = new Set<string>()

  const addCandidate = (
    candidate: string,
    candidateSource: JsonRepairParseResult['candidateSource'],
  ) => {
    const normalized = candidate.trim()
    if (!normalized || seenCandidates.has(normalized)) {
      return
    }

    seenCandidates.add(normalized)
    candidates.push({ candidate: normalized, candidateSource })
  }

  for (const codeBlockCandidate of extractCodeBlockCandidates(raw)) {
    addCandidate(codeBlockCandidate, 'code_block')
  }

  if (raw.startsWith('{') || raw.startsWith('[')) {
    addCandidate(raw, 'raw')
  }

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]
    if (char !== '{' && char !== '[') {
      continue
    }

    const candidate = extractBalancedJsonCandidate(raw, i)
    if (!candidate) {
      continue
    }

    addCandidate(candidate, 'inline')
  }

  return candidates
}

export function parseJsonFromTextWithRepair(output: string): JsonRepairParseResult {
  const lastErrors: Error[] = []

  const tryCandidate = (
    candidate: JsonTextCandidate,
  ): JsonRepairParseResult | null => {
    try {
      const parsed = parseJsonWithRepair(candidate.candidate)
      return {
        ...parsed,
        candidateSource: candidate.candidateSource,
      }
    } catch (error) {
      if (error instanceof Error) {
        lastErrors.push(error)
      }
      return null
    }
  }

  for (const candidate of extractJsonTextCandidates(output)) {
    const parsed = tryCandidate(candidate)
    if (parsed) {
      return parsed
    }
  }

  const reasons = lastErrors.map(error => error.message).filter(Boolean)
  if (reasons.length > 0) {
    throw new Error(`Structured JSON could not be repaired: ${reasons.join(' | ')}`)
  }

  throw new Error('Structured JSON object not found in output')
}

export function parseValidatedJsonFromTextWithRepair<T>(
  output: string,
  validate: (value: unknown) => T,
): JsonRepairParseResult & { value: T } {
  const parseErrors: Error[] = []
  const validationErrors: Error[] = []

  for (const candidate of extractJsonTextCandidates(output)) {
    let parsed: JsonRepairParseResult

    try {
      parsed = parseJsonWithRepair(candidate.candidate)
    } catch (error) {
      if (error instanceof Error) {
        parseErrors.push(error)
      }
      continue
    }

    try {
      return {
        ...parsed,
        value: validate(parsed.value),
        candidateSource: candidate.candidateSource,
      }
    } catch (error) {
      if (error instanceof Error) {
        validationErrors.push(error)
      }
    }
  }

  if (validationErrors.length > 0) {
    throw validationErrors[validationErrors.length - 1]
  }

  const reasons = parseErrors.map(error => error.message).filter(Boolean)
  if (reasons.length > 0) {
    throw new Error(`Structured JSON could not be repaired: ${reasons.join(' | ')}`)
  }

  throw new Error('Structured JSON object not found in output')
}

export function parseJsonObjectFromTextWithRepair(output: string): JsonRepairParseResult {
  return parseJsonFromTextWithRepair(output)
}
