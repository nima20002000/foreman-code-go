import { createHash } from 'node:crypto'

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function commandInputHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`
}

