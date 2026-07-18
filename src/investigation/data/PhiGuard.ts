import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { normalizeColumnKey } from '../config/AnchorDiagnosticsConfig.js'

type PhiColumnsConfig = {
  columns: Set<string>
  loaded: boolean
}

let configuredPhiColumns: PhiColumnsConfig | null = null

function normalizeColumnName(value: string): string {
  return value.trim().toLowerCase()
}

function phiColumnsConfigPaths(): string[] {
  const override = process.env.INVESTIGATION_PHI_COLUMNS_CONFIG?.trim()
  if (override) {
    return [override]
  }

  return [
    path.join(process.cwd(), 'meridian/backend/config/phi_columns.yaml'),
    path.join(process.cwd(), '..', 'meridian/backend/config/phi_columns.yaml'),
  ]
}

function parsePhiColumnsYaml(content: string): string[] {
  const columns: string[] = []

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trimEnd()
    const match = line.match(/^\s*-\s+([A-Za-z0-9_]+)\s*$/)
    if (match?.[1]) {
      columns.push(match[1])
    }
  }

  return columns
}

function loadConfiguredPhiColumns(): PhiColumnsConfig {
  if (configuredPhiColumns) {
    return configuredPhiColumns
  }

  const columns = new Set<string>()
  let loaded = false
  for (const configPath of phiColumnsConfigPaths()) {
    if (existsSync(configPath)) {
      try {
        for (const column of parsePhiColumnsYaml(readFileSync(configPath, 'utf8'))) {
          columns.add(normalizeColumnName(column))
        }
        loaded = true
        break
      } catch {
        // Fail closed below when PHI config cannot be read.
      }
    }
  }

  configuredPhiColumns = { columns, loaded }
  return configuredPhiColumns
}

export function getConfiguredPhiColumnNames(): Set<string> {
  return new Set(loadConfiguredPhiColumns().columns)
}

export class PhiGuard {
  private isBlockedColumnName(key: string): boolean {
    const config = loadConfiguredPhiColumns()
    const normalized = normalizeColumnName(normalizeColumnKey(key))
    return !config.loaded
      || config.columns.has(normalized)
      || /(?:^|_)(first|last|middle|full)_?name$/.test(normalized)
      || /(?:^|_)(phone|fax|email|address|zip|dob|ssn|npi|mrn)$/.test(normalized)
      || /(?:^|_)(member|subscriber|patient|person|medicare|medicaid|mbi|hicn|policy|tax)_?(id|no|number)?$/.test(normalized)
  }

  redactRow(row: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(row)) {
      if (this.isBlockedColumnName(key)) {
        sanitized[key] = '[REDACTED]'
      } else {
        sanitized[key] = value
      }
    }

    return sanitized
  }

  redactRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return rows.map(row => this.redactRow(row))
  }
}
