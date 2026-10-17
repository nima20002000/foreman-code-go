import { randomUUID } from 'node:crypto'
import { assistant } from './frames.mjs'

async function runHooks(options, event, input, signal) {
  for (const group of options.hooks?.[event] ?? []) {
    if (group.matcher && !new RegExp(group.matcher).test(input.tool_name)) continue
    for (const hook of group.hooks) {
      const answer = await hook({ ...input, hook_event_name: event }, input.tool_use_id, { signal })
      if (answer?.hookSpecificOutput?.permissionDecision === 'deny') return false
    }
  }
  return true
}

async function invokeTool(call, options, signal) {
  const matched = /^mcp__(.+?)__(.+)$/.exec(call.name)
  if (!matched) return call.result ?? { content: [{ type: 'text', text: 'Scripted tool result.' }] }
  const [, serverName, toolName] = matched
  const server = options.mcpServers?.[serverName]
  if (!server) throw new Error(`Fake Claude did not receive MCP configuration for ${serverName}.`)
  if (server.type === 'sdk') {
    const tool = server.tools?.find(entry => entry.name === toolName)
    if (!tool) throw new Error(`Fake Claude SDK MCP tool ${toolName} is unavailable.`)
    return tool.handler(call.input, { signal })
  }
  if (server.type !== 'http') throw new Error('Fake Claude supports only delivered HTTP and in-process SDK MCP servers.')
  const response = await fetch(server.url, { method: 'POST', signal,
    headers: { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: toolName, arguments: call.input } }) })
  const text = await response.text()
  const data = text.split('\n').find(line => line.startsWith('data:'))
  const body = JSON.parse(data ? data.slice(5).trim() : text)
  if (!response.ok || body.error || !body.result) throw new Error('Fake Claude MCP request failed.')
  return body.result
}

export async function executeTool(state, message, call) {
  const toolId = randomUUID()
  const input = { session_id: state.session.sessionId, cwd: state.session.cwd,
    transcript_path: state.transcriptPath, tool_name: call.name, tool_input: call.input, tool_use_id: toolId }
  state.emit(assistant(state.session, message, [{ type: 'tool_use', id: toolId, name: call.name, input: call.input }], state.model))
  let allowed = await runHooks(state.options, 'PreToolUse', input, state.signal)
  if (allowed && state.options.canUseTool) {
    const decision = await state.options.canUseTool(call.name, call.input, { toolUseID: toolId,
      signal: state.signal, suggestions: [] })
    allowed = decision.behavior === 'allow'
    if (allowed && decision.updatedInput) call = { ...call, input: decision.updatedInput }
  }
  const output = allowed ? await invokeTool(call, state.options, state.signal) : { error: 'Tool request denied.' }
  state.emit({ type: 'user', uuid: randomUUID(), session_id: state.session.sessionId, parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId,
      content: JSON.stringify(output), is_error: !allowed }] } })
  if (allowed) await runHooks(state.options, 'PostToolUse', { ...input, tool_response: output }, state.signal)
  return allowed
}

export function tool(name, description, inputSchema, handler, annotations) {
  return { name, description, inputSchema, handler, annotations }
}

export function createSdkMcpServer({ name, version, tools }) {
  return { type: 'sdk', name, version, tools }
}
