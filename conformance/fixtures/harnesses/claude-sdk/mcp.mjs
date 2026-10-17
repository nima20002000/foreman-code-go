import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

async function fixtureScope() {
  return JSON.parse(await readFile(new URL('fixture-scope.json', import.meta.url), 'utf8'))
}

function endpointFor(scope, serverName, server) {
  const endpoint = new URL(server.url)
  if (!scope.appMcpServerNames.includes(serverName) || endpoint.protocol !== 'http:'
    || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
    || endpoint.origin !== scope.apiOrigin || endpoint.pathname !== '/mcp' || !endpoint.port
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Fake Claude MCP must use this isolated target’s configured App endpoint.')
  }
  const headers = new Headers(server.headers)
  if (!/^Bearer\s+\S+$/i.test(headers.get('authorization') ?? '')) {
    throw new Error('Fake Claude MCP needs its delivered scoped credential.')
  }
  return { endpoint, headers }
}

async function discoverTools(client, signal) {
  const names = new Set()
  const cursors = new Set()
  let cursor
  do {
    const result = await client.listTools(cursor ? { cursor } : {}, { signal })
    for (const tool of result.tools) {
      if (!tool.name || names.has(tool.name)) throw new Error('Fake Claude MCP received a duplicate or empty tool name.')
      names.add(tool.name)
      if (names.size > 10_000) throw new Error('Fake Claude MCP catalog exceeded the fixture bound.')
    }
    cursor = result.nextCursor
    if (cursor !== undefined) {
      if (!cursor || cursors.has(cursor) || !result.tools.length) {
        throw new Error('Fake Claude MCP tool discovery did not advance.')
      }
      cursors.add(cursor)
    }
  } while (cursor !== undefined)
  return names
}

/** Initializes the actual configured MCP server; native scripts never bypass its discovery or authorization. */
export async function callClaudeHttpTool(serverName, server, name, args, signal, scope) {
  signal?.throwIfAborted()
  const selectedScope = scope ?? await fixtureScope()
  const { endpoint, headers } = endpointFor(selectedScope, serverName, server)
  const { Client } = require(selectedScope.mcpModules.client)
  const { StreamableHTTPClientTransport } = require(selectedScope.mcpModules.streamableHttp)
  const client = new Client({ name: 'foreman-conformance-claude', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers, redirect: 'error' },
  })
  let result
  let failure
  try {
    await client.connect(transport, { signal })
    const tools = await discoverTools(client, signal)
    if (!tools.has(name)) throw new Error(`Fake Claude MCP did not expose the requested tool: ${name}.`)
    result = await client.callTool({ name, arguments: args }, undefined, { signal })
  } catch (error) { failure = error }
  try { await client.close() }
  catch (cleanup) {
    if (failure) throw new AggregateError([failure, cleanup], 'Fake Claude MCP call and transport cleanup failed.', { cause: cleanup })
    throw cleanup
  }
  if (failure) throw failure
  return result
}
