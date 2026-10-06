import assert from 'node:assert/strict'

export function sessionControlHeaders(matrix) {
  const headers = { 'content-type': 'application/json' }
  if (matrix.browserOrigin) {
    const origin = new URL(matrix.browserOrigin)
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Use the configured local browser origin.')
    assert.equal(origin.href, `${origin.origin}/`, 'Provide an origin without a path, query or fragment.')
    headers.origin = origin.origin
  }
  return headers
}
