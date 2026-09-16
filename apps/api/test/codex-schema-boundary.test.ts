import assert from 'node:assert/strict'

import { it } from 'vitest'

import { protocolFromBundle } from '../src/modules/harnesses/codexProtocol.js'
import type { JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'

/**
 * Small schema fixture to exercise the actual Zod converter and protocol decoder.
 * It is NOT claimed as the installed Codex manifest. The live qualification test
 * separately compiles the installation's measured, version-gated bundle.
 */
function bundle(): JsonObject {
  const responses: Record<string, string> = {
    initialize: 'InitializeResponse', 'thread/start': 'ThreadStartResponse', 'thread/resume': 'ThreadResumeResponse',
    'thread/read': 'ThreadReadResponse', 'thread/turns/list': 'ThreadTurnsListResponse', 'thread/items/list': 'ThreadItemsListResponse',
    'turn/start': 'TurnStartResponse', 'turn/interrupt': 'TurnInterruptResponse', 'config/read': 'ConfigReadResponse',
    'model/list': 'ModelListResponse', 'mcpServerStatus/list': 'ListMcpServerStatusResponse',
    'account/login/start': 'LoginAccountResponse', 'account/login/cancel': 'CancelLoginAccountResponse',
  }
  const serverResponses: Record<string, string> = {
    'item/commandExecution/requestApproval': 'CommandExecutionRequestApprovalResponse',
    'item/fileChange/requestApproval': 'FileChangeRequestApprovalResponse',
    'item/permissions/requestApproval': 'PermissionsRequestApprovalResponse',
    'item/tool/requestUserInput': 'ToolRequestUserInputResponse',
    'mcpServer/elicitation/request': 'McpServerElicitationRequestResponse',
  }
  const v2: JsonObject = {}
  for (const name of [...Object.values(responses), ...Object.values(serverResponses)]) v2[name] = { type: 'object' }
  v2.Turn = {
    type: 'object', required: ['id', 'items', 'status'], properties: {
      id: { type: 'string', minLength: 1 }, items: { type: 'array', items: { type: 'object' } },
      status: { enum: ['inProgress', 'completed', 'failed', 'interrupted'] },
    },
  }
  v2.TurnStartResponse = { type: 'object', required: ['turn'], properties: { turn: { $ref: '#/definitions/v2/Turn' } } }
  v2.CommandExecutionRequestApprovalResponse = {
    type: 'object', required: ['decision'], properties: { decision: { enum: ['accept', 'acceptForSession', 'decline', 'cancel'] } },
  }
  const envelope = (method: string, notification = false): JsonObject => ({
    type: 'object', required: notification ? ['method', 'params'] : ['id', 'method'],
    properties: {
      method: { enum: [method] }, id: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
      params: notification ? { type: 'object', required: ['threadId', 'turn'], properties: {
        threadId: { type: 'string', minLength: 1 }, turn: { $ref: '#/definitions/v2/Turn' },
      } } : { type: 'object' },
    },
  })
  return { $schema: 'http://json-schema.org/draft-07/schema#', definitions: {
    v2,
    ClientRequest: { oneOf: Object.keys(responses).map((method) => envelope(method)) },
    ServerRequest: { oneOf: Object.keys(serverResponses).map((method) => envelope(method)) },
    ServerNotification: { oneOf: ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'serverRequest/resolved'].map((method) => envelope(method, true)) },
  } }
}

it('F28: generated-schema references validate payloads rather than merely reporting a constant hash', () => {
  const protocol = protocolFromBundle(bundle())
  const turn = { id: 'turn-1', items: [], status: 'completed' }
  protocol.response('turn/start', { turn })
  protocol.notification({ method: 'turn/completed', params: { threadId: 'thread-1', turn } })
  protocol.serverResponse('item/commandExecution/requestApproval', { decision: 'decline' })
  assert.throws(() => protocol.response('turn/start', { turn: { id: '', items: [], status: 'completed' } }))
  assert.throws(() => protocol.notification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'wrong' } } }))
  assert.throws(() => protocol.serverResponse('item/commandExecution/requestApproval', { decision: 'invented-allow' }))
  assert.throws(() => protocol.request({ id: 1, method: 'unqualified/mutation', params: {} }))
})

it('F28: incomplete generated bundles fail qualification before execution', () => {
  assert.throws(() => protocolFromBundle({ definitions: {} }))
})
