import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'

import { describe, it } from 'vitest'

import { codexRequest } from '../src/modules/harnesses/codexProtocol.js'
import { CodexStdioTransport, type JsonObject, type RpcRequest } from '../src/modules/harnesses/codexStdioTransport.js'
import { calls, fixture, fixtureProtocol, until } from './fixtures/codex-test-helpers.js'

describe('Codex fixtures use the pinned protocol validator', () => {
  it('validates nested client inputs and server request and response payloads', () => {
    const start = { id: 1, method: 'turn/start', params: { threadId: 'thread-1',
      clientUserMessageId: 'application-request-1', input: [{ type: 'text', text: 'hello', text_elements: [] }] } }
    assert.doesNotThrow(() => fixtureProtocol.request(start))
    assert.throws(() => fixtureProtocol.request({ ...start, params: {
      ...start.params, input: [{ type: 'text', text: 'hello', text_elements: [{ byteRange: { start: 0 } }] }],
    } }))
    const approval = { id: 2, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', startedAtMs: 1,
      commandActions: [{ type: 'read', command: 'cat README.md', name: 'README.md', path: 'README.md' }],
    } }
    assert.doesNotThrow(() => fixtureProtocol.serverRequest(approval))
    assert.throws(() => fixtureProtocol.serverRequest({ ...approval, params: {
      ...approval.params, commandActions: [{ type: 'read', command: 42 }],
    } }))
    assert.doesNotThrow(() => fixtureProtocol.serverResponse(approval.method, { decision: 'accept' }))
    assert.throws(() => fixtureProtocol.serverResponse(approval.method, { decision: 'invented-allow' }))
    assert.throws(() => fixtureProtocol.response('model/list', { data: [{ id: 'test-model' }], nextCursor: null }))
  })
})

describe.skipIf(process.platform === 'win32')('Codex executable fixture protocol', () => {
  it('validates live fixture frames and preserves distinct native and application IDs after restart', async () => {
    const f = await fixture()
    const transports: CodexStdioTransport[] = []
    const notifications: Array<{ method: string; params: JsonObject }> = []
    const approvals: RpcRequest[] = []
    const connect = async () => {
      const value = new CodexStdioTransport(f.binary, f.directory, { ...process.env }, fixtureProtocol,
        async (request) => {
          approvals.push(request)
          await value.respond(request.id, request.method, { decision: 'accept' })
        },
        (method, params) => notifications.push({ method, params }),
        () => undefined,
      )
      transports.push(value)
      await value.start()
      return value
    }
    try {
      const first = await connect()
      const created = await codexRequest(first, 'thread/start', { cwd: f.directory, model: 'test-model' })
      const threadId = created.thread.id
      await codexRequest(first, 'config/read', { includeLayers: true })
      await codexRequest(first, 'model/list', {})
      await codexRequest(first, 'mcpServerStatus/list', {})
      const started = await codexRequest(first, 'turn/start', { threadId, clientUserMessageId: 'application-request-1',
        input: [{ type: 'text', text: 'wait', text_elements: [] }] })
      await codexRequest(first, 'turn/steer', { threadId, expectedTurnId: started.turn.id,
        clientUserMessageId: 'application-request-2', input: [{ type: 'text', text: 'steer', text_elements: [] }] })
      await first.close()

      const restarted = await connect()
      const resumed = await codexRequest(restarted, 'thread/resume', { threadId, cwd: f.directory })
      assert.equal(resumed.thread.id, threadId)
      const readback = await codexRequest(restarted, 'thread/read', { threadId, includeTurns: true })
      const turn = readback.thread.turns[0]!
      assert.equal(turn.id, started.turn.id)
      const userMessages = turn.items.filter((item) => item.type === 'userMessage')
      assert.deepEqual(userMessages.map((item) => item.clientId), ['application-request-1', 'application-request-2'])
      assert.equal(new Set(userMessages.map((item) => item.id)).size, 2)
      for (const item of userMessages) assert.notEqual(item.id, item.clientId)
      const page = await codexRequest(restarted, 'thread/turns/list', { threadId })
      assert.deepEqual(page.data, readback.thread.turns)
      await codexRequest(restarted, 'turn/interrupt', { threadId, turnId: turn.id })
      await until(async () => notifications.some((entry) => entry.method === 'turn/completed'))

      const approved = await codexRequest(restarted, 'turn/start', { threadId,
        input: [{ type: 'text', text: 'approval', text_elements: [] }], clientUserMessageId: 'application-request-3' })
      await until(async () => notifications.some((entry) => entry.method === 'turn/completed'
        && (entry.params.turn as JsonObject).id === approved.turn.id))
      assert.equal(approvals.length, 1)
      assert.equal(approvals[0]!.params!.threadId, threadId)
      assert(notifications.some((entry) => entry.method === 'serverRequest/resolved'))
      assert(notifications.some((entry) => entry.method === 'item/completed'))
      const logged = await calls(f.directory)
      assert.equal(logged.filter((entry) => (entry.wire as JsonObject | undefined)?.method === 'thread/start').length, 1)
      assert.equal(logged.filter((entry) => (entry.wire as JsonObject | undefined)?.method === 'turn/start').length, 2)
    } finally {
      await Promise.all(transports.map((value) => value.close()))
      await rm(f.directory, { recursive: true, force: true })
    }
  })
})
