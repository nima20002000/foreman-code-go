import assert from 'node:assert/strict'

export function sessionControlHeaders(matrix, row, environment = process.env) {
  const token = row.httpTokenEnv ? environment[row.httpTokenEnv] : undefined
  if (row.httpTokenEnv) assert.ok(token, `Missing ${row.httpTokenEnv}`)
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  if (matrix.browserOrigin) {
    const origin = new URL(matrix.browserOrigin)
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Use the configured local browser origin.')
    assert.equal(origin.href, `${origin.origin}/`, 'Provide an origin without a path, query or fragment.')
    headers.origin = origin.origin
  }
  return headers
}
