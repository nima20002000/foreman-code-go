import assert from 'node:assert/strict'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpClient, McpHttpError, McpProtocolError } from './mcp.js'

const bodies: ReadableStream<Uint8Array>[] = []

function trackedBody(text: string, ended: boolean) {
  const state = { canceled: 0 }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      if (ended) controller.close()
    },
    cancel() { state.canceled++ },
  })
  bodies.push(body)
  return { body, state }
}

function event(message: unknown) {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`
}

/** Fetch is replaced before any request. The selected loopback address is only
 * protocol input; these response-body regressions open no sockets or target. */
function ownedMcp(options: { protocolError?: boolean } = {}) {
  const baseUrl = `http://127.0.0.1:${randomInt(49_152, 65_536)}`
  const token = randomBytes(32).toString('hex')
  const session = randomUUID()
  const requests: Array<{ method: string; authorization: string | null; session: string | null }> = []
  const responses: Array<ReturnType<typeof trackedBody>> = []
  const notification = { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'Owned progress' } }
  const result = { content: [{ type: 'text', text: '{"value":"owned"}' }], structuredContent: { value: 'owned' } }
  const respond: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    assert.equal(request.url, `${baseUrl}/mcp`)
    assert.equal(request.method, 'POST')
    const message = JSONRPCMessageSchema.parse(await request.json())
    assert.ok('method' in message)
    assert.ok(typeof message.method === 'string')
    requests.push({ method: message.method, authorization: request.headers.get('authorization'),
      session: request.headers.get('mcp-session-id') })
    let text: string
    let status = 200
    let contentType = 'text/event-stream'
    let ended = false
    if (request.headers.get('authorization') !== `Bearer ${token}`) {
      status = 401
      contentType = 'application/json'
      ended = true
      text = JSON.stringify({ error: 'owned credential denied' })
    } else if (message.method === 'notifications/initialized') {
      status = 202
      contentType = 'text/plain'
      ended = true
      text = ''
    } else {
      assert.ok('id' in message)
      if (message.method === 'initialize') {
        text = event({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'owned-mcp-lifecycle', version: '1' } } })
      } else {
        assert.equal(message.method, 'tools/call')
        assert.ok('params' in message)
        assert.deepStrictEqual(message.params, { name: 'read', arguments: { fileId: 'owned-file' } })
        text = options.protocolError
          ? event({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Owned protocol failure',
            data: { field: 'fileId', received: 'owned-file' } } })
          : event(notification) + event({ jsonrpc: '2.0', id: message.id, result })
      }
    }
    const response = trackedBody(text, ended)
    responses.push(response)
    return new Response(response.body, { status,
      headers: { 'content-type': contentType, 'mcp-session-id': session } })
  }
  vi.stubGlobal('fetch', respond)
  return { baseUrl, token, session, requests, responses, notification, result,
    client: new McpClient({ baseUrl, token, signal: AbortSignal.timeout(5000) }) }
}

describe('MCP owns each response body until its public call settles', () => {
  afterEach(async () => {
    vi.unstubAllGlobals()
    const settled = await Promise.allSettled(bodies.splice(0).map(async body => {
      assert.equal(body.locked, false, 'A settled MCP call must release its response reader.')
      await body.cancel()
    }))
    const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Owned MCP response cleanup failed.')
  })

  it('cancels initialized and successful SSE responses before returning the exact tool result', async () => {
    const fixture = ownedMcp()
    expect(await fixture.client.callTool('read', { fileId: 'owned-file' })).toEqual(fixture.result)
    expect(fixture.client.notifications).toEqual([fixture.notification])
    expect(fixture.responses.map(response => response.state.canceled)).toEqual([1, 0, 1])
    expect(fixture.responses.every(response => !response.body.locked)).toBe(true)
    expect(fixture.requests).toEqual([
      { method: 'initialize', authorization: `Bearer ${fixture.token}`, session: null },
      { method: 'notifications/initialized', authorization: `Bearer ${fixture.token}`, session: fixture.session },
      { method: 'tools/call', authorization: `Bearer ${fixture.token}`, session: fixture.session },
    ])
  })

  it('cancels the SSE reader before rejecting with the raw JSON-RPC error details', async () => {
    const fixture = ownedMcp({ protocolError: true })
    const failure: unknown = await fixture.client.callTool('read', { fileId: 'owned-file' }).catch(error => error)
    assert.ok(failure instanceof McpProtocolError)
    expect(failure.code).toBe(-32602)
    expect(failure.message).toBe('Owned protocol failure')
    expect(failure.data).toEqual({ field: 'fileId', received: 'owned-file' })
    expect(fixture.responses.map(response => response.state.canceled)).toEqual([1, 0, 1])
    expect(fixture.responses.every(response => !response.body.locked)).toBe(true)
  })

  it('rejects missing credentials and consumes denied overrides without replacing its owned credential', async () => {
    const fixture = ownedMcp()
    expect(() => new McpClient({ baseUrl: fixture.baseUrl, token: '' })).toThrow('fresh Operator credential')
    expect(fixture.requests).toEqual([])
    const deniedToken = randomBytes(32).toString('hex')
    const failure: unknown = await fixture.client.callTool('read', { fileId: 'owned-file' },
      { token: deniedToken }).catch(error => error)
    assert.ok(failure instanceof McpHttpError)
    expect(failure.status).toBe(401)
    expect(failure.body).toEqual({ error: 'owned credential denied' })
    expect(fixture.responses.map(response => response.state.canceled)).toEqual([1, 0, 0])
    expect(fixture.responses.every(response => !response.body.locked)).toBe(true)
    expect(await fixture.client.callTool('read', { fileId: 'owned-file' })).toEqual(fixture.result)
    expect(fixture.requests.map(request => request.authorization)).toEqual([
      `Bearer ${fixture.token}`, `Bearer ${fixture.token}`, `Bearer ${deniedToken}`, `Bearer ${fixture.token}`,
    ])
    expect(fixture.requests.map(request => request.method)).toEqual([
      'initialize', 'notifications/initialized', 'tools/call', 'tools/call',
    ])
    expect(fixture.responses.map(response => response.state.canceled)).toEqual([1, 0, 0, 1])
    expect(fixture.responses.every(response => !response.body.locked)).toBe(true)
  })
})
