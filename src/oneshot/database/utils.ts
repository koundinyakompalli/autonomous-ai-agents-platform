export type JsonObjectRowValue = Record<string, unknown> | string | null

export function parseJsonValue(value: JsonObjectRowValue): Record<string, unknown> | null {
  if (!value) {
    return null
  }

  return typeof value === 'string'
    ? (JSON.parse(value) as Record<string, unknown>)
    : value
}
