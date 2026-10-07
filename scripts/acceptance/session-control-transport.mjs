import assert from 'node:assert/strict'

/** MCP-created Operator chats remain owned by their creating caller. */
export function sessionControlTransport({ baseUrl, tool, request }) {
  const base = new URL(baseUrl)
  const path = (row, suffix) => new URL(
    `/api/workspaces/${encodeURIComponent(row.workspaceId)}/agent-chat/conversations/`
      + `${encodeURIComponent(row.conversationId)}${suffix}`, base)
  const operator = row => {
    assert.ok(row.conversationId, 'Provide the Operator conversation owned by the MCP caller.')
    return { conversationId: row.conversationId }
  }
  return {
    controls(row) {
      if (row.role === 'operator') return tool('operator_chat_controls_get', operator(row))
      return request(path(row, '/session-controls'))
    },
    transcript(row) {
      if (row.role === 'operator') return tool('operator_chat_get', operator(row))
      return request(new URL(row.readPath, base))
    },
    change(row, input, options) {
      if (row.role === 'operator') {
        return tool('operator_chat_controls_update', { ...operator(row), request: input }, options)
      }
      return request(path(row, '/session-controls'), input, options)
    },
    send(row, input) {
      if (row.role === 'operator') return tool('operator_chat_send', { ...operator(row), request: input })
      return request(new URL(row.sendPath, base), input)
    },
    futureDefaults(row) {
      if (row.role !== 'operator') {
        assert.ok(row.futureDefaultsReadPath, 'Provide an uninitialized future node in the same settings scope.')
        return request(new URL(row.futureDefaultsReadPath, base))
      }
      assert.ok(row.futureDefaultsConversationId, 'Provide an unread future chat with the same Operator configuration.')
      return tool('operator_chat_controls_get', { conversationId: row.futureDefaultsConversationId })
    },
  }
}
