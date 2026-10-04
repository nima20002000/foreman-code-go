import { describe, expect, it } from 'vitest'
import { mcpLauncherFixture } from './support/mcpLauncher.js'

describe('MCP launcher failure guidance', () => {
  it.each([
    { status: 401, kind: 'authentication', guidance: 'Refresh the owning app credential' },
    { status: 403, kind: 'forbidden', guidance: 'grants and scope' },
    { status: 413, kind: 'request_too_large', guidance: 'Reduce the request payload' },
    { status: 503, kind: 'service_unavailable', guidance: 'Retry later' },
  ])('preserves the RPC id and safely classifies HTTP $status', async ({ status, kind, guidance }) => {
    const f = await mcpLauncherFixture((_message, response) => {
      response.writeHead(status, { 'content-type': 'text/plain' }).end('secret server diagnostic /private/path')
    })
    try {
      f.send({ id: `request-${status}`, method: 'tools/call', params: { name: 'interaction_get' } })
      const result = await f.receive(`request-${status}`)
      expect(result.id).toBe(`request-${status}`)
      expect(result.error).toMatchObject({ data: { kind, httpStatus: status }, message: expect.stringContaining(guidance) })
      expect(JSON.stringify(result)).not.toMatch(/secret|private|[Rr]estart|could not connect/)
    } finally { await f.close() }
  }, 10_000)

  it('reports connection refusal as a transport failure without restart advice', async () => {
    const f = await mcpLauncherFixture(() => {}, { unavailableEndpoint: true })
    try {
      f.send({ id: 17, method: 'ping' })
      const result = await f.receive(17)
      expect(result).toMatchObject({ id: 17, error: {
        data: { kind: 'transport' }, message: expect.stringContaining('Check that the owning app is running'),
      } })
      expect(result.error?.message).not.toMatch(/[Rr]estart/)
    } finally { await f.close() }
  }, 10_000)

  it.each([false, true])('reports timeout before or during streaming; streaming=%s', async (streaming) => {
    const f = await mcpLauncherFixture((_message, response) => {
      if (streaming) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(': keepalive\n\n')
      }
    }, {
      preload: 'const originalTimeout = AbortSignal.timeout; AbortSignal.timeout = () => originalTimeout(100);',
    })
    try {
      f.send({ id: 'timed-out', method: 'tools/call', params: { name: 'interaction_respond' } })
      const result = await f.receive('timed-out')
      expect(result).toMatchObject({ id: 'timed-out', error: {
        data: { kind: 'timeout' }, message: expect.stringContaining('may have committed'),
      } })
      expect(result.error?.message).not.toMatch(/[Rr]estart|could not connect/)
    } finally { await f.close() }
  }, 10_000)
})
