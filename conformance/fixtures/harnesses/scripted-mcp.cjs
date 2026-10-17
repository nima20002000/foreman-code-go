/* global require, module */
/* eslint @typescript-eslint/no-require-imports: "off" -- Adjacent native fixture extension. */
const { isDeepStrictEqual } = require('node:util')
const { readMcpConfiguration, toolEnabled } = require('./scripted-mcp-configuration.cjs')

function jsonMcpValue(response) {
  if (response.isError === true) throw new Error('The native App MCP tool returned an error result.')
  const text = response.content.find(item => item.type === 'text' && typeof item.text === 'string')
  if (!text) throw new Error('The native App MCP tool returned no JSON text.')
  const value = JSON.parse(text.text)
  if (response.structuredContent !== undefined && !isDeepStrictEqual(value, response.structuredContent)) {
    throw new Error('Native App MCP JSON text and structured content disagree.')
  }
  return value
}

function requestOptions(configuration, key, signal) {
  const seconds = configuration.policy[key]
  if (seconds === undefined) return { signal }
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('Native App MCP timeout configuration must be a positive number.')
  }
  return { signal, timeout: seconds * 1000 }
}

async function listTools(client, options) {
  const tools = new Map()
  const cursors = new Set()
  let cursor
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, options)
    for (const tool of page.tools) {
      if (!tool.name || tools.has(tool.name)) throw new Error('Native App MCP discovery returned a duplicate or empty name.')
      tools.set(tool.name, tool)
      if (tools.size > 10_000) throw new Error('Native App MCP discovery exceeded its catalog bound.')
    }
    cursor = page.nextCursor
    if (cursor !== undefined) {
      if (!cursor || cursors.has(cursor) || !page.tools.length) throw new Error('Native App MCP discovery cursor did not advance.')
      cursors.add(cursor)
    }
  } while (cursor !== undefined)
  return tools
}

async function connect(configuration, signal) {
  const { Client } = require(configuration.modules.client)
  const client = new Client({ name: 'foreman-conformance-native', version: '0.1.0' })
  const selected = configuration.connection
  let transport
  if (selected.kind === 'http') {
    const { StreamableHTTPClientTransport } = require(configuration.modules.streamableHttp)
    transport = new StreamableHTTPClientTransport(selected.endpoint, {
      requestInit: { headers: { authorization: `Bearer ${selected.token}` }, redirect: 'error' },
    })
  } else {
    const { StdioClientTransport } = require(configuration.modules.stdio)
    transport = new StdioClientTransport({ command: selected.command, args: selected.args,
      env: selected.environment, stderr: 'inherit' })
  }
  try {
    const options = requestOptions(configuration, 'startup_timeout_sec', signal)
    await client.connect(transport, options)
    return { client, tools: await listTools(client, options) }
  } catch (error) {
    try { await client.close() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Native MCP setup and transport cleanup failed.') }
    throw error
  }
}

/** Every call uses the accepted native configuration and the real initialized MCP server. */
function createMcpTurn({ root, overrides, operation, nextRequestId, recordItem }) {
  let configuration
  let connection
  let closed = false
  const connected = async () => {
    operation.controller.signal.throwIfAborted()
    configuration ??= readMcpConfiguration(root, overrides)
    connection ??= connect(configuration, operation.controller.signal)
    return connection
  }
  return {
    async call(name, argumentsValue) {
      if (closed) throw new Error('The native MCP turn is already closed.')
      const { client, tools } = await connected()
      const tool = tools.get(name)
      if (!tool || !toolEnabled(configuration.policy, name)) {
        throw new Error(`The native MCP configuration does not expose this tool: ${name}`)
      }
      const item = { type: 'mcpToolCall', id: nextRequestId(), server: configuration.name,
        tool: name, status: 'inProgress', arguments: argumentsValue, appContext: null, pluginId: null,
        readOnlyHint: tool.annotations?.readOnlyHint ?? null, result: null, error: null, durationMs: null }
      recordItem(item, false)
      let result
      try {
        const options = requestOptions(configuration, 'tool_timeout_sec', operation.controller.signal)
        result = await client.callTool({ name, arguments: argumentsValue }, undefined, options)
      } catch (error) {
        if (!operation.cancelled) recordItem({ ...item, status: 'failed', durationMs: 1,
          error: { message: error.message } }, true)
        throw error
      }
      const failed = result.isError === true
      recordItem({ ...item, status: failed ? 'failed' : 'completed', durationMs: 1,
        result: { content: result.content, structuredContent: result.structuredContent ?? null, _meta: result._meta ?? null },
        error: failed ? { message: 'The App MCP server returned a tool error.' } : null }, true)
      return jsonMcpValue(result)
    },
    async close() {
      if (closed) return
      closed = true
      if (!connection) return
      // ignore: failed setup already closed its transport; the owning turn reports that original rejection.
      const ready = await connection.then(value => value, () => undefined)
      if (ready) await ready.client.close()
    },
  }
}

module.exports = { createMcpTurn }
