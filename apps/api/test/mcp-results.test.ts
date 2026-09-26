import { describe, expect, it } from 'vitest'

import { TEXT_MIRROR_BYTES, toolFailure, toolResult } from '../src/mcp/shared/results.js'
import { DomainError } from '../src/modules/errors.js'

describe('MCP result envelopes', () => {
  it.each([
    { input: { items: ['one'] }, expected: { items: ['one'] } },
    { input: ['one'], expected: { value: ['one'] } },
    { input: 'one', expected: { value: 'one' } },
    { input: null, expected: { value: null } },
  ])('serializes successful structured and text results consistently: $input', ({ input, expected }) => {
    expect(toolResult(input)).toEqual({
      content: [{ type: 'text', text: JSON.stringify(expected) }], structuredContent: expected,
    })
  })

  it('carries a large result once, in structuredContent only', () => {
    const value = { input: 'x'.repeat(TEXT_MIRROR_BYTES + 1) }
    const result = toolResult(value)
    expect(result.structuredContent).toBe(value)
    const text = (result.content[0] as { text: string }).text
    expect(text.length).toBeLessThan(512)
    expect(JSON.parse(text)).toMatchObject({ bytes: JSON.stringify(value).length })
  })

  it.each([undefined, { revision: 2 }])('preserves domain failures and optional details: %j', (details) => {
    const error = new DomainError('REVISION_CONFLICT', 'The resource changed.', 409, details)
    const body = { error: { code: 'REVISION_CONFLICT', message: 'The resource changed.', ...(details ? { details } : {}) } }
    expect(toolFailure(error)).toEqual({
      isError: true, content: [{ type: 'text', text: JSON.stringify(body) }],
    })
  })

  it.each([
    { message: undefined, expected: 'The Operator service could not complete the request.' },
    { message: 'The App service could not complete the request.', expected: 'The App service could not complete the request.' },
  ])('redacts unexpected failures while retaining the selected fallback: $expected', ({ message, expected }) => {
    const body = { error: { code: 'INTERNAL_ERROR', message: expected } }
    expect(toolFailure(new Error('sensitive provider diagnostic'), message)).toEqual({
      isError: true, content: [{ type: 'text', text: JSON.stringify(body) }],
    })
  })
})
