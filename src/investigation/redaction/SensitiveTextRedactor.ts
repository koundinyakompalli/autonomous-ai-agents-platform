import { getConfiguredPhiColumnNames } from '../data/PhiGuard.js'

const REDACTED = '[REDACTED]'
const REDACTED_COUNT = '[REDACTED_COUNT]'

const KEY_VALUE_SUFFIX = String.raw`\b\s*[:=]\s*['"]?[^,'"\n)]+`
const KEY_PREFIX = String.raw`\b([A-Za-z0-9_.-]*(?:`
const KEY_INFIX_SUFFIX = String.raw`)[A-Za-z0-9_.-]*)`

const SECRET_KEY_PATTERNS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'credential',
  String.raw`private[_.-]?key`,
  String.raw`access[_.-]?key`,
  String.raw`session[_.-]?token`,
  String.raw`api[_.-]?key`,
  String.raw`auth[_.-]?key`,
  String.raw`client[_.-]?secret`,
  String.raw`keystore(?:[_.-]?(?:pass|password))?`,
  String.raw`truststore(?:[_.-]?(?:pass|password))?`,
]

const SECURE_PROPERTY_KEY_PATTERNS = [
  String.raw`jdbc(?:\.|_|-)?url`,
  String.raw`database(?:\.|_|-)?url`,
  String.raw`db(?:\.|_|-)?url`,
  'endpoint',
  'uri',
  'url',
  'host',
]

const SECRET_KEY_VALUE_PATTERN = keyValuePattern(SECRET_KEY_PATTERNS)
const SECURE_PROPERTY_KEY_VALUE_PATTERN = keyValuePattern(SECURE_PROPERTY_KEY_PATTERNS)
const INLINE_SECRET_QUERY_PARAM = /([?&](?:password|passwd|pwd|secret|token|access[_.-]?key|session[_.-]?token|api[_.-]?key|auth[_.-]?key)=)[^&\s,'")]+/gi
const DIRECT_SSN_VALUE = /\b\d{3}-\d{2}-\d{4}\b/g
const DIRECT_EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi
const DIRECT_PHONE_VALUE = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g
const LABELED_DOB_VALUE = /\b(dob|date(?:_|\s*|-)?of(?:_|\s*|-)?birth)\b\s*[:#=]?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/gi
const LABELED_IDENTIFIER_VALUE = /\b((?:member|subscriber|patient|person|medicare|medicaid|mbi|hicn|policy|mrn)(?:[_.-]|\s*)?(?:id|no|number|#)?)\s*[:#=]\s*[A-Z0-9-]{4,}\b/gi
const SENSITIVE_COUNT_VALUE = /\b\d{1,9}\s+(members?|patients?|subscribers?|records?|cases?)\b/gi
const TARGET_KEY_TOKEN = /\b[A-Za-z0-9_-]+:(?:DEV|INT|UAT|STAGE|PROD|PROD[-_]REPLICA):[A-Za-z0-9_.:-]+\b/g

let phiKeyValuePatternCache: {
  signature: string
  pattern: RegExp
} | null = null

function keyValuePattern(alternatives: string[]): RegExp {
  return new RegExp(`${KEY_PREFIX}${alternatives.join('|')}${KEY_INFIX_SUFFIX}${KEY_VALUE_SUFFIX}`, 'gi')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function columnNamePattern(columnName: string): string {
  return columnName
    .trim()
    .split(/[_\s.-]+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join(String.raw`(?:[_.-]|\s*)?`)
}

function phiKeyValuePattern(): RegExp {
  const alternatives = Array.from(getConfiguredPhiColumnNames())
    .map(columnNamePattern)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
  const signature = alternatives.join('|')

  if (!phiKeyValuePatternCache || phiKeyValuePatternCache.signature !== signature) {
    phiKeyValuePatternCache = {
      signature,
      pattern: keyValuePattern(alternatives.length > 0 ? alternatives : ['__no_phi_columns__']),
    }
  }

  return phiKeyValuePatternCache.pattern
}

function redactedKeyValue(_match: string, label: string): string {
  return `${label}=${REDACTED}`
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(SECRET_KEY_VALUE_PATTERN, redactedKeyValue)
    .replace(SECURE_PROPERTY_KEY_VALUE_PATTERN, redactedKeyValue)
    .replace(INLINE_SECRET_QUERY_PARAM, (_match, prefix) => `${prefix}${REDACTED}`)
    .replace(phiKeyValuePattern(), redactedKeyValue)
    .replace(LABELED_DOB_VALUE, redactedKeyValue)
    .replace(LABELED_IDENTIFIER_VALUE, redactedKeyValue)
    .replace(DIRECT_SSN_VALUE, '[REDACTED_SSN]')
    .replace(DIRECT_EMAIL_VALUE, '[REDACTED_EMAIL]')
    .replace(DIRECT_PHONE_VALUE, '[REDACTED_PHONE]')
    .replace(SENSITIVE_COUNT_VALUE, (_match, label) => `${REDACTED_COUNT} ${label}`)
}

export function sanitizeAuditText(value: string, maxLength = 1_000): string {
  const limit = maxLength >= 100 ? maxLength : 1_000
  return redactSensitiveText(value)
    .replace(TARGET_KEY_TOKEN, '[TARGET_KEY_REDACTED]')
    .slice(0, limit)
}

export function sanitizeTextValue(value: unknown, fallback = '', maxLength = 8_000): string {
  if (typeof value !== 'string') {
    return fallback
  }

  return redactSensitiveText(value.trim()).slice(0, maxLength)
}
