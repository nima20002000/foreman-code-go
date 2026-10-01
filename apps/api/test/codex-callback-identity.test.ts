import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type { CodexHarnessConfiguration, NativeSessionReference } from '@graphql/contracts'
import { CodexAppServerSessionManager, type CodexTransport } from '../src/modules/harnesses/codexAppServer.js'
import { CodexRuntimeFileTurn } from '../src/modules/harnesses/codexFiles/runtime.js'
import type { CodexFileTurn } from '../src/modules/harnesses/codexFiles/turn.js'
import { QUALIFIED_CODEX_VERSION } from '../src/modules/harnesses/codexProtocol.js'
import type { RpcRequest } from '../src/modules/harnesses/codexStdioTransport.js'
import { translateCodexInteraction } from '../src/modules/harnesses/codexInteractions.js'
import { errorCode, fixtureProtocol, input } from './fixtures/codex-test-helpers.js'

type Runtime = ReturnType<CodexAppServerSessionManager['requireRuntime']>
type Prepared = Parameters<CodexAppServerSessionManager['runtime']>[0]
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve }); return { promise, release } }
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

async function fixture(id: string | number = 901, files = true) {
  const session = { harness: 'codex' as const, providerVersion: QUALIFIED_CODEX_VERSION, nativeSessionId: 'callback-thread' }
  const source = input('/callback-no-io')
  const manager = new CodexAppServerSessionManager('not-executed')
  const writes: Array<{ operation: string; id: string | number; method?: string }> = []
  const transport: CodexTransport = { start: async () => undefined, request: async () => ({}), close: async () => undefined,
    reject: async (id) => { writes.push({ operation: 'reject', id }) },
    respond: async (id, method) => { writes.push({ operation: 'respond', id, method }) }, isConnected: () => true }
  const seam = manager as unknown as {
    runtime(prepared: Prepared, session: NativeSessionReference, transport: CodexTransport): Runtime
    runtimes: Map<string, Runtime>; transports: Set<CodexTransport>
    handleRequest(runtime: Runtime, request: RpcRequest): Promise<void>
    handleNotification(runtime: Runtime, method: string, params: Record<string, unknown>): void
  }
  const runtime = seam.runtime({ input: source, harnessConfiguration: source.request.configuration.harness as CodexHarnessConfiguration,
    workingDirectory: '/callback-no-io', scopedCredentialVariable: undefined, strippedCredentialVariable: undefined,
    environment: {}, disabledAppMcpServerNames: [], qualified: {
      binary: 'not-executed', identity: 'fixture-identity', providerVersion: QUALIFIED_CODEX_VERSION, protocol: fixtureProtocol,
      schemaManifestSha256: 'fixture-schema', stableSchemaGitBlob: 'fixture-stable', referenceSchemaManifestSha256: 'fixture-reference',
    } }, session, transport)
  runtime.phase = 'active'; runtime.activeTurnId = 'callback-turn'
  seam.runtimes.set(session.nativeSessionId, runtime); seam.transports.add(transport)
  const completion = gate()
  let calls = 0
  if (files) {
    const bridge = new CodexRuntimeFileTurn({ activate: async () => undefined, close: async () => undefined,
      call: async () => { calls += 1; await completion.promise; return { success: true, contentItems: [{ type: 'inputText', text: 'fixture result' }] } },
    } as unknown as CodexFileTurn, session.nativeSessionId)
    await bridge.activate(runtime.activeTurnId)
    runtime.files = bridge
  }
  const approval: RpcRequest = { id, method: 'item/commandExecution/requestApproval', params: {
    threadId: session.nativeSessionId, turnId: runtime.activeTurnId, itemId: 'command-item', command: 'printf fixture',
    cwd: '/callback-no-io', availableDecisions: ['accept', 'decline'],
  } }
  const file: RpcRequest = { id, method: 'item/tool/call', params: { threadId: session.nativeSessionId,
    turnId: runtime.activeTurnId, callId: 'file-call', tool: 'files_read', arguments: { fileId: 'fixture-file' } } }
  const translated = translateCodexInteraction({ session, configuration: runtime.configuration,
    connectionId: runtime.connectionId, generation: runtime.generation }, approval)!
  const pending = translated.pending
  const query = { nativeRequestId: pending.turn.nativeRequestId!, nativeRequestType: pending.nativeRequestType,
    expectedNativeTurnId: pending.turn.nativeTurnId! }
  return { manager, session, runtime, seam, writes, completion, approval, file, query, pending, calls: () => calls,
    cleanup: async () => { completion.release(); await flush(); await manager.shutdown() } }
}

describe('connection-scoped typed callback identity across files and approvals', () => {
  for (const id of [901, '901']) it(`approval-first collision on ${typeof id} ID fences approval before file execution or reply`, async () => {
    const f = await fixture(id)
    try {
      await f.seam.handleRequest(f.runtime, f.approval)
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'available')
      await f.seam.handleRequest(f.runtime, f.file)
      assert.equal(f.calls(), 0)
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'recovery_required')
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).reason, 'identity_mismatch')
      await assert.rejects(f.manager.respond(f.session, f.query.nativeRequestId, f.pending.responseOptions[0]!),
        (error) => errorCode(error) === 'NATIVE_RESPONSE_RECONCILIATION_REQUIRED')
      assert.deepEqual(f.writes, [])
    } finally { await f.cleanup() }
  })

  for (const id of [901, '901']) it(`file-first collision on ${typeof id} ID fences the original in-flight response`, async () => {
    const f = await fixture(id)
    try {
      await f.seam.handleRequest(f.runtime, f.file)
      assert.equal(f.calls(), 1)
      await f.seam.handleRequest(f.runtime, f.approval)
      assert.equal(await f.manager.pending(f.session), undefined)
      assert.notEqual((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'available')
      f.completion.release(); await flush()
      assert.deepEqual(f.writes, [])
      await f.seam.handleRequest(f.runtime, f.file)
      assert.equal(f.calls(), 1)
      assert.deepEqual(f.writes, [])
    } finally { await f.cleanup() }
  })

  it('never automatically denies a colliding file call under the pending approval ID', async () => {
    const f = await fixture(901, false)
    try {
      await f.seam.handleRequest(f.runtime, f.approval)
      await f.seam.handleRequest(f.runtime, f.file)
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'recovery_required')
      assert.deepEqual(f.writes, [])
    } finally { await f.cleanup() }
  })

  it('retains resolved approval identity before any file effect', async () => {
    const f = await fixture()
    try {
      await f.seam.handleRequest(f.runtime, f.approval)
      f.seam.handleNotification(f.runtime, 'serverRequest/resolved', { threadId: f.session.nativeSessionId, requestId: 901 })
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).reason, 'request_consumed')
      await f.seam.handleRequest(f.runtime, f.file)
      assert.equal(f.calls(), 0)
      assert.deepEqual(f.writes, [])
    } finally { await f.cleanup() }
  })

  it('does not conflate numeric and string RPC IDs', async () => {
    const f = await fixture()
    try {
      await f.seam.handleRequest(f.runtime, f.approval)
      await f.seam.handleRequest(f.runtime, { ...f.file, id: '901' })
      assert.equal(f.calls(), 1)
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'available')
      f.completion.release(); await flush()
      assert.deepEqual(f.writes, [{ operation: 'respond', id: '901', method: 'item/tool/call' }])
    } finally { await f.cleanup() }
  })

  it('retains a denied file callback identity before a later approval', async () => {
    const f = await fixture(901, false)
    try {
      await f.seam.handleRequest(f.runtime, f.file); await flush()
      assert.deepEqual(f.writes, [{ operation: 'respond', id: 901, method: 'item/tool/call' }])
      await f.seam.handleRequest(f.runtime, f.approval)
      assert.equal(await f.manager.pending(f.session), undefined)
      assert.notEqual((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'available')
      assert.equal(f.writes.length, 1)
    } finally { await f.cleanup() }
  })

  it('retains consumed file identity after the per-turn file receipt cache is cleared', async () => {
    const f = await fixture()
    try {
      await f.seam.handleRequest(f.runtime, f.file)
      f.completion.release(); await flush()
      assert.equal(f.writes.length, 1)
      // This cache is cleared by the existing next-turn admission; the connection
      // still owns the consumed raw RPC ID in its bounded resolved inventory.
      f.runtime.fileRequests.clear()
      await f.seam.handleRequest(f.runtime, f.approval)
      assert.equal(await f.manager.pending(f.session), undefined)
      assert.equal(f.writes.length, 1)
    } finally { await f.cleanup() }
  })

  it('fences changed file payloads but coalesces an equivalent in-flight envelope', async () => {
    const f = await fixture()
    try {
      await f.seam.handleRequest(f.runtime, f.file)
      await f.seam.handleRequest(f.runtime, { ...f.file, params: { ...f.file.params } })
      assert.equal(f.calls(), 1)
      await f.seam.handleRequest(f.runtime, { ...f.file, params: { ...f.file.params, arguments: { fileId: 'another-file' } } })
      f.completion.release(); await flush()
      assert.deepEqual(f.writes, [])
    } finally { await f.cleanup() }
  })

  it('fences a colliding foreign-thread envelope without replying under the legitimate callback ID', async () => {
    const f = await fixture()
    try {
      await f.seam.handleRequest(f.runtime, f.approval)
      await f.seam.handleRequest(f.runtime, { ...f.file, params: { ...f.file.params, threadId: 'foreign-thread' } })
      assert.equal(f.calls(), 0)
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'recovery_required')
      assert.deepEqual(f.writes, [])
    } finally { await f.cleanup() }
  })

  it('keeps a fresh cold connection independent while refusing the predecessor callback ID', async () => {
    const first = await fixture()
    const replacement = await fixture()
    try {
      await first.seam.handleRequest(first.runtime, first.approval)
      await replacement.seam.handleRequest(replacement.runtime, replacement.approval)
      assert.notEqual(first.query.nativeRequestId, replacement.query.nativeRequestId)
      assert.equal((await replacement.manager.inspectResponseAvailability(replacement.session, first.query)).state, 'unavailable')
      assert.equal((await replacement.manager.inspectResponseAvailability(replacement.session, replacement.query)).state, 'available')
      assert.deepEqual(first.writes, [])
      assert.deepEqual(replacement.writes, [])
    } finally { await Promise.all([first.cleanup(), replacement.cleanup()]) }
  })
})
