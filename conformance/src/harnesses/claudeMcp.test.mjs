import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { callClaudeHttpTool } from '../../fixtures/harnesses/claude-sdk/mcp.mjs'
import { executeTool } from '../../fixtures/harnesses/claude-sdk/tools.mjs'

const require = createRequire(new URL('../../package.json', import.meta.url))
const closers = []

async function statefulMcp() {
  const state = { initialized: false, calls: [], revision: 0 }
  const token = 'owned-claude-mcp-credential'
  const session = 'owned-mcp-session'
  const server = createServer((request, response) => {
    const handle = async () => {
      if (request.method === 'GET') { response.writeHead(405).end(); return }
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      state.calls.push(body.method)
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return }
      if (body.method !== 'initialize' && (!state.initialized || request.headers['mcp-session-id'] !== session)) {
        response.writeHead(400).end(); return
      }
      if (body.method === 'notifications/initialized') { response.writeHead(202).end(); return }
      let result
      if (body.method === 'initialize') {
        state.initialized = true
        result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: 'conformance-stateful-mcp', version: '1' } }
      } else if (body.method === 'tools/list') {
        result = body.params?.cursor === 'next'
          ? { tools: [{ name: 'record', inputSchema: { type: 'object' } }] }
          : { tools: [{ name: 'read', inputSchema: { type: 'object' } }], nextCursor: 'next' }
      } else if (body.method === 'tools/call' && body.params.name === 'record') {
        state.revision++
        const value = { revision: state.revision, value: body.params.arguments.value }
        result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
      } else { response.writeHead(400).end(); return }
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    }
    void handle().catch(error => {
      response.writeHead(500, { 'content-type': 'text/plain' }).end(String(error))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  closers.push(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The owned MCP fixture did not select a loopback port.')
  const apiOrigin = `http://127.0.0.1:${address.port}`
  return { state, configuration: { type: 'http', url: `${apiOrigin}/mcp`, headers: { Authorization: `Bearer ${token}` } },
    scope: { apiOrigin, appMcpServerNames: ['graphql'], mcpModules: {
      client: require.resolve('@modelcontextprotocol/sdk/client/index.js'),
      streamableHttp: require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    } } }
}

describe('fake Claude authenticated MCP behavior', () => {
  afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())) })

  it('initializes a real stateful session, reads every tool page and preserves its complete tool result', async () => {
    const fixture = await statefulMcp()
    const result = await callClaudeHttpTool('graphql', fixture.configuration, 'record', { value: 'Saved through MCP' },
      AbortSignal.timeout(5000), fixture.scope)
    expect(result).toEqual({ content: [{ type: 'text', text: '{"revision":1,"value":"Saved through MCP"}' }],
      structuredContent: { revision: 1, value: 'Saved through MCP' } })
    expect(fixture.state.revision).toBe(1)
    expect(fixture.state.calls).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/call'])
  })

  it('rejects a foreign endpoint and an undiscovered tool without invoking it', async () => {
    const fixture = await statefulMcp()
    await expect(callClaudeHttpTool('graphql', { ...fixture.configuration, url: 'https://example.invalid/mcp' },
      'record', {}, AbortSignal.timeout(5000), fixture.scope)).rejects.toThrow('isolated target')
    expect(fixture.state.calls).toEqual([])
    await expect(callClaudeHttpTool('graphql', fixture.configuration, 'absent', {},
      AbortSignal.timeout(5000), fixture.scope)).rejects.toThrow('did not expose')
    expect(fixture.state.calls).not.toContain('tools/call')
    expect(fixture.state.revision).toBe(0)
  })

  it('preserves a delivered SDK MCP tool error in the native tool-result frame', async () => {
    const frames = []
    const failure = { isError: true, content: [{ type: 'text', text: 'Owned tool failure' }] }
    const state = { session: { sessionId: 'owned-session', cwd: '/owned-scope' }, model: 'fixture-model',
      signal: AbortSignal.timeout(5000), transcriptPath: '/owned-scope/transcript', emit: frame => frames.push(frame),
      options: { canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
        mcpServers: { files: { type: 'sdk', tools: [{ name: 'read', handler: async () => failure }] } } } }
    expect(await executeTool(state, { uuid: 'owned-message' }, { name: 'mcp__files__read', input: { fileId: 'missing' } })).toBe(false)
    const result = frames.find(frame => frame.type === 'user')
    expect(result.message.content).toEqual([{ type: 'tool_result', tool_use_id: frames[0].message.content[0].id,
      content: JSON.stringify(failure), is_error: true }])
  })
})
