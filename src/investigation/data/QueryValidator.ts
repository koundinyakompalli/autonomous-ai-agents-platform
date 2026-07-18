import type { InvestigationQueryPack } from '../types/investigation.js'

export interface QueryValidationResult {
  valid: boolean
  reasons: string[]
}

const FORBIDDEN_PATTERNS = [
  /\bselect\s+\*/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\binsert\b/i,
  /\bdrop\b/i,
  /\balter\b/i,
  /\btruncate\b/i,
  /;\s*$/i,
] as const

export class QueryValidator {
  validate(pack: InvestigationQueryPack): QueryValidationResult {
    const reasons: string[] = []

    if (!/\blimit\b/i.test(pack.sql)) {
      reasons.push('Query pack SQL must include an explicit LIMIT clause.')
    }

    if (pack.maxRows <= 0 || pack.maxRows > 500) {
      reasons.push('Query pack maxRows must be between 1 and 500.')
    }

    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(pack.sql)) {
        reasons.push(`Query pack SQL matched forbidden pattern: ${pattern}`)
      }
    }

    return {
      valid: reasons.length === 0,
      reasons,
    }
  }
}
