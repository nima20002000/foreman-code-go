import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import { appLauncherPath } from '../src/modules/harnesses/appMcpLauncher.js'
import { collect } from './fixtures/codex-test-helpers.js'
import { manager, source, json, flag, wire, useCodexFixture } from './codex-app-server.test-support.js'

const tool = { name: 'context_get', inputSchema: { type: 'object' } }
const ready = (name = 'graphql') => ({
  name, runtimeStatus: 'connected', toolsError: null, tools: { context_get: tool },
  resources: [], resourceTemplates: [], authStatus: 'bearerToken',
})

describe('workflow Codex MCP readiness', () => {
  useCodexFixture({ requestTimeoutMs: 5_000 })

  it.each(['foreman-code', 'graphql'])('checks the live %s session before submitting a turn', async name => {
    await json('mcp.json', { name, enabled: true, required: true,
      transport: { type: 'stdio', command: process.execPath, args: [appLauncherPath()],
        env_vars: ['GRAPHQL_MCP_TOKEN'] } })
    await json('mcp-status.json', { data: [ready(name)], nextCursor: null })
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'ready' }))
    const requests = await wire()
    const statusIndex = requests.findIndex(request => request.method === 'mcpServerStatus/list')
    assert(statusIndex >= 0)
    assert(statusIndex < requests.findIndex(request => request.method === 'turn/start'))
    assert.deepEqual(requests[statusIndex]!.params, {
      threadId: session.nativeSessionId, detail: 'toolsAndAuthOnly',
    })
  })

  it.each([
    [],
    [ready('unrelated')],
    [ready('foreman-code')],
    [{ ...ready(), tools: {} }],
    [{ ...ready(), runtimeStatus: 'failed' }],
    [{ ...ready(), runtimeStatus: 'starting' }],
    [{ ...ready(), runtimeStatus: 'disabled' }],
    [{ ...ready(), runtimeStatus: null }],
    [{ ...ready(), toolsError: 'Discovery failed' }],
  ].map(data => ({ data })))('fails without submitting when the runtime catalog is unavailable: $data', async ({ data }) => {
    await json('mcp-status.json', { data, nextCursor: null })
    const session = await manager.createSession(source)
    await assert.rejects(collect(manager.startTurn(session, {
      prompt: 'complete', clientCorrelationId: 'unavailable',
    })), (error: unknown) => {
      assert(error instanceof NativeDeliveryError)
      assert.equal(error.delivery, 'not_sent')
      assert.equal(error.result.error?.code, 'CODEX_APP_MCP_NOT_READY')
      assert.equal(error.result.error?.retryable, true)
      assert.match(error.message, /Retry the activation/)
      return true
    })
    assert.equal((await wire('turn/start')).length, 0)
    assert.equal((await manager.history(session)).terminalResult, undefined)
    await json('mcp-status.json', { data: [ready()], nextCursor: null })
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'retry' }))
    assert.equal((await wire('turn/start')).length, 1)
  })

  it('checks subsequent catalog pages in the same native session', async () => {
    await json('mcp-status.json', { data: [ready('unrelated')], nextCursor: 'next' })
    await json('mcp-status-pages.json', { next: { data: [ready()], nextCursor: null } })
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'paged' }))
    const requests = await wire('mcpServerStatus/list')
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[1]!.params, {
      threadId: session.nativeSessionId, detail: 'toolsAndAuthOnly', cursor: 'next',
    })
  })

  it('makes a failed native readiness request retryable without sending model input', async () => {
    await flag('reject-mcp-status')
    const session = await manager.createSession(source)
    await assert.rejects(collect(manager.startTurn(session, {
      prompt: 'complete', clientCorrelationId: 'status-failed',
    })), (error: unknown) => error instanceof NativeDeliveryError && error.delivery === 'not_sent'
      && error.result.error?.code === 'CODEX_APP_MCP_NOT_READY' && error.result.error.retryable)
    assert.equal((await wire('turn/start')).length, 0)
  })

  it('rechecks readiness after a completed turn instead of trusting a previous catalog', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'first' }))
    const previous = (await manager.history(session)).terminalResult
    await json('mcp-status.json', { data: [], nextCursor: null })
    await assert.rejects(collect(manager.startTurn(session, {
      prompt: 'complete', clientCorrelationId: 'second',
    })), (error: unknown) => error instanceof NativeDeliveryError && error.delivery === 'not_sent')
    assert.equal((await wire('turn/start')).length, 1)
    assert.deepEqual((await manager.history(session)).terminalResult, previous)
  })
})
