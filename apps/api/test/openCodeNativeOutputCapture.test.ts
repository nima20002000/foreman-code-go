import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES, nativeOutputToolArguments,
  parseNativeOutputToolCommand } from '@graphql/contracts/worker-native-output'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { createAdmittedNativeManager } from '../src/modules/harnesses/admittedManager.js'
import { nativeOpenCodeMcpToolName } from '../src/modules/harnesses/openCodePermissionPolicy.js'
import { nativeMessageId, object } from '../src/modules/harnesses/opencodeProtocol.js'
import { NativeResponseJournal } from '../src/modules/harnesses/recovery/responseJournal.js'
import { repeatDigest } from '../src/modules/runs/repeatResolution.js'
import { advanced, configuration, environment, errorCode, FixtureServer, json, request, sessionFor } from './opencode-fixtures.js'

const toolName = WORKER_NATIVE_OUTPUT_TOOL_NAMES.create
const nativeTool = nativeOpenCodeMcpToolName(toolName)
const correlationId = 'original-native-output-turn'

class ResidentServer extends FixtureServer {
  ownerAgentId = 'agent-1'
  nativePid = process.pid
  resident = true
  detached = false
  ensureCalls = 0
  beforeResident: ((path: string) => void) | undefined
  get residentGeneration() { return this.resident ? this.generation : undefined }
  async ensure(signal?: AbortSignal) { this.ensureCalls++; await super.ensure(signal) }
  async detachForRestart() { this.detached = true; return true }
  recoverEnvironment() { this.detached = false; return this.environment && structuredClone(this.environment) }
  async dispose() { if (!this.detached) { this.resident = false; await super.dispose() } }
  async requestResident(path: string, signal: AbortSignal, generation: number) {
    signal.throwIfAborted()
    this.beforeResident?.(path)
    if (!this.resident || generation !== this.generation) return undefined
    const url = new URL(path, 'http://fixture.invalid')
    if (url.pathname === '/agent') return json(this.agents)
    if (url.pathname === '/permission') return json(this.permissions)
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const sessionId = parts[1]!
    if (parts[0] !== 'session') throw new Error('Unexpected resident output read')
    if (parts.length === 2) return json(this.sessionInfos.get(sessionId))
    const messages = this.messages.get(sessionId) ?? []
    if (parts[3]) return json(messages.find(message => message.info.id === parts[3]))
    const end = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : messages.length
    const start = Math.max(0, end - Number(url.searchParams.get('limit')))
    return json(messages.slice(start, end), 200, start > 0 ? { 'x-next-cursor': String(start) } : {})
  }
}

async function setup(options: { sessionPolicy?: 'allow' | 'ask' | 'deny'; automatic?: boolean;
  journal?: NativeResponseJournal } = {}) {
  const server = new ResidentServer()
  server.agents = [{ name: 'build', permission: [{ permission: '*', pattern: '*', action: 'allow' }] }]
  const harness = { ...configuration(), autoApprove: options.automatic ?? false,
    advanced: { ...advanced(), permissionHandling: options.automatic ? 'native_auto' as const : 'graphql_routed' as const,
      permissionRules: options.sessionPolicy ? [{ permission: nativeTool, pattern: '*', effect: options.sessionPolicy }] : [] },
  }
  const native = new OpenCodeNativeSessionManager({ server, ownerAgentId: 'agent-1',
    ...(options.journal ? { responseJournal: options.journal } : {}) })
  const session = await sessionFor(native, harness)
  const turn = native.startTurn(session, { clientCorrelationId: correlationId, prompt: 'hello' })[Symbol.asyncIterator]()
  await turn.next()
  const args = { commandId: randomUUID(), filename: 'output.md', mediaType: 'text/markdown' }
  const assistant = server.assistant(nativeMessageId(correlationId), '', undefined, false, session.nativeSessionId)
  assistant.parts = [{ id: 'original-part', sessionID: session.nativeSessionId, messageID: assistant.info.id,
    type: 'tool', tool: nativeTool, callID: 'original-call', state: { status: 'running', input: structuredClone(args) } }]
  const permission = { id: 'original-ask', sessionID: session.nativeSessionId, permission: nativeTool,
    patterns: ['*'], always: ['*'], metadata: {}, tool: { messageID: String(assistant.info.id), callID: 'original-call' } }
  return { server, native, session, harness, turn, args, assistant, permission,
    async close() { await turn.return?.(); await native.dispose() } }
}

it('captures the running root tool call and normalized complete input without starting or recovering its server', async () => {
  const f = await setup()
  try {
    object(f.assistant.parts[0]!.state).input = { ...f.args, filename: ' output.md ' }
    const ensure = f.server.ensureCalls
    const requests = f.server.calls.length
    const captured = await f.native.captureNativeOutputCall(f.session, toolName, f.args)
    assert.deepEqual(captured.descriptor, { nativeSessionId: f.session.nativeSessionId,
      rootTurnId: nativeMessageId(correlationId), assistantMessageId: f.assistant.info.id,
      callId: 'original-call', toolName,
      inputDigest: repeatDigest(nativeOutputToolArguments(parseNativeOutputToolCommand(toolName, f.args)), 4 * 1024 * 1024) })
    assert.equal(captured.effectivePolicy, 'allow')
    assert.equal(captured.nativeAutoApproval, undefined)
    captured.assertCurrent()
    assert.equal(f.server.ensureCalls, ensure)
    assert.equal(f.server.calls.length, requests)
    await assert.rejects(f.native.captureNativeOutputCall(f.session, toolName, { ...f.args, filename: 'different.md' }),
      errorCode('OPENCODE_NATIVE_OUTPUT_CALL_UNAVAILABLE'))
    f.server.generation++
    assert.throws(captured.assertCurrent, errorCode('OPENCODE_NATIVE_OUTPUT_CALL_UNAVAILABLE'))
  } finally { await f.close() }
})

it('captures a valid concurrent output call without using another invalid native tool input', async () => {
  const f = await setup()
  try {
    f.assistant.parts.push({ ...structuredClone(f.assistant.parts[0]!), callID: 'invalid-call',
      state: { status: 'running', input: { unexpected: 'invalid native output input' } } })
    assert.equal((await f.native.captureNativeOutputCall(f.session, toolName, f.args)).descriptor.callId, 'original-call')
  } finally { await f.close() }
})

for (const failure of ['foreign-parent', 'foreign-agent', 'newer-root', 'completed-part', 'ambiguous-call', 'changed-input', 'foreign-permission'] as const) {
  it(`does not capture a native output callback with ${failure}`, async () => {
    const f = await setup()
    try {
      if (failure === 'foreign-parent') f.assistant.info.parentID = 'another-turn'
      if (failure === 'foreign-agent') f.assistant.info.agent = 'plan'
      if (failure === 'newer-root') f.server.user('a-later-native-turn')
      if (failure === 'completed-part') object(f.assistant.parts[0]!.state).status = 'completed'
      if (failure === 'changed-input') object(f.assistant.parts[0]!.state).input = { ...f.args, commandId: randomUUID() }
      if (failure === 'ambiguous-call') f.assistant.parts.push({ ...structuredClone(f.assistant.parts[0]!), callID: 'second-call' })
      if (failure === 'foreign-permission') f.server.permissions = [{ ...f.permission, permission: 'bash' }]
      await assert.rejects(f.native.captureNativeOutputCall(f.session, toolName, f.args),
        errorCode('OPENCODE_NATIVE_OUTPUT_CALL_UNAVAILABLE'))
    } finally { await f.close() }
  })
}

for (const effect of ['ask', 'deny'] as const) {
  it(`retains inherited actual native ${effect} policy for an output call`, async () => {
    const f = await setup()
    try {
      f.server.agents = [{ name: 'build', permission: [{ permission: '*', pattern: '*', action: 'allow' },
        { permission: nativeTool, pattern: '*', action: effect }] }]
      assert.equal((await f.native.captureNativeOutputCall(f.session, toolName, f.args)).effectivePolicy, effect)
    } finally { await f.close() }
  })
}

it('retains a matching pending ask and does not mistake native-auto configuration for a delivered reply', async () => {
  const f = await setup({ automatic: true })
  try {
    f.server.permissions = [f.permission]
    const captured = await f.native.captureNativeOutputCall(f.session, toolName, f.args)
    assert.equal(captured.effectivePolicy, 'ask')
    assert.equal(captured.nativeAutoApproval, undefined)
    assert.deepEqual(f.server.permissions, [f.permission])
    assert.equal(f.server.calls.filter(call => call.path.includes('/reply')).length, 0)
    await f.native.pendingAll(f.session)
    const delivered = await f.native.captureNativeOutputCall(f.session, toolName, f.args)
    assert.deepEqual(delivered.nativeAutoApproval, { nativeRequestId: f.permission.id,
      nativeSessionId: f.session.nativeSessionId, permission: nativeTool, patterns: ['*'],
      assistantMessageId: f.assistant.info.id, callId: 'original-call', reply: 'once' })
    assert.equal(f.server.calls.filter(call => call.path.includes('/reply')).length, 1)
  } finally { await f.close() }
})

it('keeps an unconfirmed native auto reply uncertain without synthesizing approval or resending it', async () => {
  const f = await setup({ automatic: true, sessionPolicy: 'ask' })
  try {
    f.server.permissions = [f.permission]
    f.server.beforeRequest = path => path.includes('/original-ask/reply') ? json(false) : undefined
    await assert.rejects(f.native.pendingAll(f.session), errorCode('OPENCODE_NATIVE_AUTO_REPLY_UNCONFIRMED'))
    assert.equal((await f.native.captureNativeOutputCall(f.session, toolName, f.args)).nativeAutoApproval, undefined)
    await assert.rejects(f.native.pendingAll(f.session), errorCode('OPENCODE_NATIVE_AUTO_REPLY_UNCONFIRMED'))
    assert.equal(f.server.calls.filter(call => call.path.includes('/original-ask/reply')).length, 1)
  } finally { f.server.beforeRequest = undefined; await f.close() }
})

it('recovers confirmed native auto call approval from the protected journal with a fresh adapter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-output-auto-'))
  const journal = new NativeResponseJournal(directory)
  const f = await setup({ automatic: true, sessionPolicy: 'ask', journal })
  let restored: OpenCodeNativeSessionManager | undefined
  try {
    f.server.permissions = [f.permission]
    await f.native.pendingAll(f.session)
    const before = await f.native.captureNativeOutputCall(f.session, toolName, f.args)
    await f.turn.return?.()
    await f.native.closeForRestart(f.session)
    await f.native.dispose()
    restored = new OpenCodeNativeSessionManager({ server: f.server, ownerAgentId: 'agent-1',
      responseJournal: new NativeResponseJournal(directory) })
    const recovered = restored.recoverEnvironment()
    assert.deepEqual(recovered, environment())
    await restored.attachSession(f.session, { request: request(f.harness), correlationId,
      ...(recovered ? { environment: recovered } : {}) })
    const after = await restored.captureNativeOutputCall(f.session, toolName, f.args)
    assert.deepEqual(after.descriptor, before.descriptor)
    assert.deepEqual(after.nativeAutoApproval, before.nativeAutoApproval)
    assert.equal(after.effectivePolicy, 'ask')
    assert.equal(f.server.restartEnvironments.length, 1)
    assert.equal(f.server.calls.filter(call => call.path.includes('/original-ask/reply')).length, 1)
  } finally {
    await restored?.dispose()
    await f.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('does not produce a callback when its original resident process changes during inspection', async () => {
  const f = await setup()
  try {
    f.server.beforeResident = path => { if (path.startsWith('/agent')) f.server.generation++ }
    await assert.rejects(f.native.captureNativeOutputCall(f.session, toolName, f.args),
      errorCode('OPENCODE_NATIVE_OUTPUT_CALL_UNAVAILABLE'))
  } finally { f.server.beforeResident = undefined; await f.close() }
})

it('keeps admitted capture passive and forwards it only after original profile recovery admission', async () => {
  const f = await setup()
  let admissions = 0
  const admitted = createAdmittedNativeManager('opencode', async signal => {
    signal.throwIfAborted()
    admissions++
    return { manager: f.native }
  })
  try {
    await assert.rejects(admitted.manager.captureNativeOutputCall!(f.session, toolName, f.args),
      errorCode('HARNESS_NATIVE_OUTPUT_CAPTURE_UNAVAILABLE'))
    assert.equal(admissions, 0)
    const requests = f.server.calls.length
    const generation = f.server.generation
    assert.deepEqual(await admitted.manager.recoverEnvironment!(), environment())
    assert.equal(admissions, 1)
    assert.equal(f.server.calls.length, requests)
    assert.equal(f.server.generation, generation)
    const captured = await admitted.manager.captureNativeOutputCall!(f.session, toolName, f.args)
    assert.equal(captured.descriptor.callId, 'original-call')
    assert.equal(admissions, 1)
    assert.equal(f.server.calls.length, requests)
    await admitted.manager.dispose?.()
    assert.throws(captured.assertCurrent, errorCode('NATIVE_MANAGER_DISPOSED'))
    await assert.rejects(admitted.manager.captureNativeOutputCall!(f.session, toolName, f.args),
      errorCode('NATIVE_MANAGER_DISPOSED'))
    assert.equal(admissions, 1)
  } finally { await admitted.manager.dispose?.(); await f.close() }
})

it('does not bypass failed selected-profile recovery admission to use an existing native adapter', async () => {
  let admissions = 0
  const admitted = createAdmittedNativeManager('opencode', async () => {
    admissions++
    throw new Error('Selected profile was revoked')
  })
  try {
    await assert.rejects(admitted.manager.recoverEnvironment!(), /Selected profile was revoked/)
    await assert.rejects(admitted.manager.captureNativeOutputCall!(
      { harness: 'opencode', providerVersion: '1.18.31', nativeSessionId: 'unadmitted-session' }, toolName, {}),
    errorCode('HARNESS_NATIVE_OUTPUT_CAPTURE_UNAVAILABLE'))
    assert.equal(admissions, 1)
  } finally { await admitted.manager.dispose?.() }
})
