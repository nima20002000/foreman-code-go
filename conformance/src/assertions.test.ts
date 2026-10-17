import { describe, expect, it } from 'vitest'
import { assertJson, assertResponse } from './assertions.js'

describe('full response comparison', () => {
  it('normalizes one named timestamp and still rejects an extra response property', () => {
    const expected = { status: 200, body: { id: 'workspace-fixed', createdAt: '<timestamp>' } }
    const actual = { status: 200, headers: new Headers(), body: {
      id: 'workspace-fixed', createdAt: '2026-10-17T00:00:00.000Z',
    } }
    const rules = [{ pointer: '/body/createdAt', kind: 'timestamp' as const }]
    expect(() => assertResponse(actual, expected, rules)).not.toThrow()
    expect(() => assertResponse({ ...actual, body: { ...actual.body, extra: true } }, expected, rules)).toThrow()
  })

  it('rejects whole objects and malformed nondeterministic values', () => {
    const response = { status: 200, headers: new Headers(), body: { value: { changed: true } } }
    expect(() => assertResponse(response, { status: 200, body: { value: '<id>' } },
      [{ pointer: '/body/value', kind: 'id' }])).toThrow('Invalid id')
    expect(() => assertResponse({ ...response, body: { value: 'not-a-time' } },
      { status: 200, body: { value: '<timestamp>' } }, [{ pointer: '/body/value', kind: 'timestamp' }])).toThrow()
  })

  it('compares the complete error status and error body', () => {
    const expected = { status: 403, body: { error: { code: 'ACCESS_DENIED', message: 'Denied' } } }
    expect(() => assertResponse({ status: 401, headers: new Headers(), body: expected.body }, expected)).toThrow()
    expect(() => assertResponse({ status: 403, headers: new Headers(), body: {
      error: { code: 'AUTH_REQUIRED', message: 'Denied' },
    } }, expected)).toThrow()
  })

  it('compares public JSON tool results with the same individually named normalization rules', () => {
    const actual = { fileId: 'file-123', revision: 2, content: { text: 'Retained result' } }
    const expected = { fileId: '<id>', revision: 2, content: { text: 'Retained result' } }
    const rules = [{ pointer: '/body/fileId', kind: 'id' as const }]
    expect(() => assertJson(actual, expected, rules)).not.toThrow()
    expect(() => assertJson({ ...actual, extra: true }, expected, rules)).toThrow()
    expect(() => assertJson({ ...actual, content: { text: 'Changed result' } }, expected, rules)).toThrow()
    expect(actual.fileId).toBe('file-123')
  })

  it('normalizes a named native request ID through the shared opaque ID contract', () => {
    const actual = { nativeRequestId: 'session:turn:item/tool/requestUserInput:connection:1:string:rpcid', answer: 'retained' }
    const expected = { nativeRequestId: '<opaque-id>', answer: 'retained' }
    const rules = [{ pointer: '/body/nativeRequestId', kind: 'opaque-id' as const }]
    expect(() => assertJson(actual, expected, rules)).not.toThrow()
    expect(() => assertJson({ ...actual, answer: 'changed' }, expected, rules)).toThrow()
    expect(() => assertJson({ ...actual, extra: true }, expected, rules)).toThrow()
    expect(() => assertJson(actual, { ...expected, nativeRequestId: '<id>' },
      [{ pointer: '/body/nativeRequestId', kind: 'id' }])).toThrow('Invalid id')
  })

  it('rejects empty, untrimmed, and object values for an opaque ID leaf', () => {
    const expected = { nativeRequestId: '<opaque-id>' }
    const rules = [{ pointer: '/body/nativeRequestId', kind: 'opaque-id' as const }]
    for (const nativeRequestId of ['', '  ', ' native-id ', { id: 'native-id' }]) {
      expect(() => assertJson({ nativeRequestId }, expected, rules)).toThrow('Invalid opaque-id')
    }
  })
})
