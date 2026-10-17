import { randomUUID } from 'node:crypto'

const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

export function initialization(session, options) {
  return { type: 'system', subtype: 'init', uuid: randomUUID(), session_id: session.sessionId,
    cwd: session.cwd, model: options.model ?? 'claude-sonnet-4-6', claude_code_version: '2.1.284',
    tools: options.tools ?? [], mcp_servers: Object.keys(options.mcpServers ?? {}).map(name => ({ name, status: 'connected' })),
    permissionMode: options.permissionMode ?? 'default', slash_commands: ['compact'],
    output_style: 'default', apiKeySource: 'none', skills: [], plugins: [], agents: [] }
}

export function assistant(session, message, content, model) {
  return { type: 'assistant', uuid: randomUUID(), session_id: session.sessionId,
    parent_tool_use_id: null, user_message_uuid: message.uuid,
    message: { id: randomUUID(), type: 'message', role: 'assistant', model,
      content, stop_reason: 'end_turn', stop_sequence: null, usage } }
}

export function result(session, message, answer, failure = false) {
  return { type: 'result', subtype: failure ? 'error_during_execution' : 'success', uuid: randomUUID(),
    session_id: session.sessionId, user_message_uuid: message.uuid, user_message_uuids: [message.uuid],
    is_error: failure, duration_ms: 1, duration_api_ms: 1, num_turns: 1,
    result: answer, stop_reason: 'end_turn', total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [],
    ...(failure ? { errors: [answer] } : {}) }
}

export function textFrames(session, message, text, model) {
  const complete = assistant(session, message, [{ type: 'text', text }], model)
  const stream = event => ({ type: 'stream_event', uuid: randomUUID(), session_id: session.sessionId,
    parent_tool_use_id: null, user_message_uuid: message.uuid, event })
  return [stream({ type: 'message_start', message: { ...complete.message, content: [] } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    stream({ type: 'content_block_stop', index: 0 }), stream({ type: 'message_stop' }), complete]
}
