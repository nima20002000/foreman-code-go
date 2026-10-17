import assert from 'node:assert/strict'
import { IdSchema } from '@foreman-code/contracts'
import type { PublicResponse } from './clients/http.js'

export type NormalizationKind = 'timestamp' | 'uuid' | 'id' | 'opaque-id' | 'duration'
export interface NormalizationRule { pointer: string; kind: NormalizationKind }
export interface ExpectedResponse { status: number; body: unknown }

function validLeaf(value: unknown, kind: NormalizationKind): boolean {
  if (kind === 'duration') return typeof value === 'number' && Number.isFinite(value) && value >= 0
  if (typeof value !== 'string') return false
  if (kind === 'opaque-id') {
    const parsed = IdSchema.safeParse(value)
    return parsed.success && parsed.data === value
  }
  if (kind === 'timestamp') {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      && Number.isFinite(Date.parse(value))
  }
  if (kind === 'uuid') return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  return /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,255}$/.test(value)
}

function parentAtPointer(root: unknown, pointer: string): { parent: Record<string, unknown>; key: string } {
  assert.ok(pointer.startsWith('/body/'), 'Only individually named response body leaves may be normalized')
  const tokens = pointer.slice(1).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'))
  const key = tokens.pop()!
  let parent = root
  for (const token of tokens) {
    assert.ok(parent !== null && typeof parent === 'object' && Object.hasOwn(parent, token),
      `Normalization path is absent: ${pointer}`)
    parent = (parent as Record<string, unknown>)[token]
  }
  assert.ok(parent !== null && typeof parent === 'object' && Object.hasOwn(parent, key),
    `Normalization leaf is absent: ${pointer}`)
  return { parent: parent as Record<string, unknown>, key }
}

function compareNormalized(actual: unknown, expected: unknown, rules: readonly NormalizationRule[]): void {
  const comparable: unknown = structuredClone(actual)
  const seen = new Set<string>()
  for (const rule of rules) {
    assert.ok(!seen.has(rule.pointer), `Duplicate normalization rule: ${rule.pointer}`)
    seen.add(rule.pointer)
    const actualLeaf = parentAtPointer(comparable, rule.pointer)
    const expectedLeaf = parentAtPointer(expected, rule.pointer)
    assert.ok(validLeaf(actualLeaf.parent[actualLeaf.key], rule.kind),
      `Invalid ${rule.kind} at ${rule.pointer}`)
    const marker = `<${rule.kind}>`
    assert.equal(expectedLeaf.parent[expectedLeaf.key], marker, `Expected normalization marker at ${rule.pointer}`)
    actualLeaf.parent[actualLeaf.key] = marker
  }
  assert.deepStrictEqual(comparable, expected)
}

/** Full body and status comparison; no object stripping, wildcard paths, or snapshot recording. */
export function assertResponse(
  actual: PublicResponse,
  expected: ExpectedResponse,
  rules: readonly NormalizationRule[] = [],
): void {
  compareNormalized({ status: actual.status, body: actual.body }, expected, rules)
}

/** Compare a complete public JSON result without inventing an HTTP envelope or status. */
export function assertJson(actual: unknown, expected: unknown, rules: readonly NormalizationRule[] = []): void {
  compareNormalized({ body: actual }, { body: expected }, rules)
}
