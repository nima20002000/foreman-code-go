import { randomUUID, createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import type { AgentFilePublishInput, TemporaryFileScope } from '@graphql/contracts/files'
import { MAX_FILE_BYTES } from '@graphql/contracts/files'
import { BufferedNativeOutputRegistry, NativeOutputMemoryBudget, createBufferedNativeOutputs } from './bufferedNativeOutput.js'
import { openCodeArtifactMutationAllowed, workflowArtifactFilePolicy } from '../../harnesses/workflowArtifactPolicy.js'
import { DEFAULT_HARNESS_DEFAULTS, DEFAULT_OPENCODE_ADVANCED_CONFIGURATION } from '@graphql/contracts'
import { codexNativeOutputDeclarations } from '../../harnesses/codexNativeOutput.js'

function registry(budget = new NativeOutputMemoryBudget()) {
  const scope: TemporaryFileScope = { kind: 'temporary', chat: { kind: 'agent', conversationId: 'conversation',
    workspaceId: 'workspace', workflowId: 'workflow', agentId: 'agent', runId: 'run', executionId: 'execution' } }
  let active = true
  const current = () => { if (!active) throw new Error('owner withdrawn') }
  const callback = { assertCurrent: current }
  const publications: { input: AgentFilePublishInput; bytes: Buffer }[] = []
  const host = new BufferedNativeOutputRegistry({ scope, budget, assertCurrent: current,
    authorize: async () => current(), publish: async (input, source, call) => {
      const snapshot = await source.sealed(input, call)
      const original = Buffer.from(await snapshot.read(0, snapshot.byteSize))
      const copy = await snapshot.read(0, snapshot.byteSize)
      copy.fill(0)
      expect(Buffer.from(await snapshot.read(0, snapshot.byteSize))).toEqual(original)
      publications.push({ input, bytes: original })
      throw new Error('publisher boundary')
    } })
  const dispatch = (command: Parameters<typeof host.dispatch>[0]) => host.dispatch(command, callback)
  return { host, dispatch, publications, scope, withdraw: () => { active = false } }
}
async function create(host: ReturnType<typeof registry>) {
  const result = await host.dispatch({ operation: 'create', commandId: randomUUID(),
    filename: 'report.txt', mediaType: 'text/plain' })
  if (result.operation !== 'create') throw new Error('create result')
  return result.artifactId
}
it('seals path-free original chunks, denies later writes and gives publishers immutable copies', async () => {
  const f = registry()
  const artifactId = await create(f)
  const bytes = Buffer.from('original 雪')
  const append = { operation: 'append' as const, commandId: randomUUID(), artifactId,
    offset: 0, contentBase64: bytes.toString('base64') }
  expect(await f.dispatch(append)).toMatchObject({ byteSize: bytes.length })
  expect(await f.dispatch(append)).toMatchObject({ byteSize: bytes.length })
  await expect(f.dispatch({ ...append, contentBase64: Buffer.from('changed').toString('base64') })).rejects.toMatchObject({
    code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
  expect(await f.dispatch({ operation: 'seal', commandId: randomUUID(), artifactId })).toMatchObject({
    sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length })
  await expect(f.dispatch({ ...append, commandId: randomUUID(), offset: bytes.length })).rejects.toMatchObject({
    code: 'WORKER_NATIVE_OUTPUT_CONFLICT' })
  await expect(f.dispatch({ operation: 'publish', publication: { commandId: randomUUID(), artifactId,
    filename: 'report.txt', mediaType: 'text/plain' } })).rejects.toThrow('publisher boundary')
  expect(f.publications[0]).toEqual({ input: expect.objectContaining({ scope: f.scope }), bytes })
  await f.host.close()
})
it('accounts for concurrent producers and frees memory only after the original owner closes', async () => {
  const budget = new NativeOutputMemoryBudget(2 * MAX_FILE_BYTES, 1)
  const first = registry(budget)
  const second = registry(budget)
  await create(first)
  await expect(create(second)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_UNAVAILABLE' })
  first.withdraw()
  await expect(create(first)).rejects.toThrow('owner withdrawn')
  await first.host.close()
  await create(second)
  await second.host.close()
})
it('retains mutation replies across a lost post-effect authorization check and rechecks each retry', async () => {
  const scope: TemporaryFileScope = { kind: 'temporary', chat: { kind: 'agent', conversationId: 'conversation',
    workspaceId: 'workspace', workflowId: 'workflow', agentId: 'agent', runId: 'run', executionId: 'execution' } }
  let phase: 'ready' | 'withdrawn' = 'ready'
  let revokeAfterEffect = true
  const budget = new NativeOutputMemoryBudget(2 * MAX_FILE_BYTES, 1)
  const reserve = budget.reserve.bind(budget)
  budget.reserve = bytes => {
    const release = reserve(bytes)
    phase = 'withdrawn'
    return release
  }
  const native = new BufferedNativeOutputRegistry({ scope, budget,
    assertCurrent: () => { if (phase === 'withdrawn') throw new Error('authorization withdrew after effect') },
    authorize: async () => {}, publish: async () => { throw new Error('not publishing') } })
  const callback = { assertCurrent() {} }
  const create = { operation: 'create' as const, commandId: randomUUID(), filename: 'report.txt', mediaType: 'text/plain' as const }
  await expect(native.dispatch(create, callback)).rejects.toThrow('after effect')
  await expect(native.dispatch(create, callback)).rejects.toThrow('after effect')
  phase = 'ready'
  const original = await native.dispatch(create, callback)
  if (original.operation !== 'create') throw new Error('create reply')
  let checks = 0
  const append = { operation: 'append' as const, commandId: randomUUID(), artifactId: original.artifactId,
    offset: 0, contentBase64: Buffer.from('once').toString('base64') }
  const afterAppend = { assertCurrent() {
    checks++
    if (revokeAfterEffect && checks === 3) throw new Error('append acknowledgment lost')
  } }
  await expect(native.dispatch(append, afterAppend)).rejects.toThrow('append acknowledgment lost')
  revokeAfterEffect = false
  expect(await native.dispatch(append, afterAppend)).toMatchObject({ operation: 'append', byteSize: 4 })
  expect(await native.dispatch(create, callback)).toEqual(original)
  await native.close()
})
it('binds buffer callbacks to the admitted OpenCode turn and withdraws them at closure', async () => {
  const f = registry()
  const session = { harness: 'opencode' as const, providerVersion: '1.18.31', nativeSessionId: 'native-session' }
  const output = createBufferedNativeOutputs({ budget: new NativeOutputMemoryBudget(),
    assertQualified: async () => {}, assertCurrent: async () => {}, authorize: async () => f.scope,
    publish: async () => { throw new Error('not publishing') } }).opencode
  const bridge = await output.prepare({ configuration: DEFAULT_HARNESS_DEFAULTS.opencode, providerVersion: '1.18.31',
    directory: '/project', session, clientCorrelationId: 'execution:execution', connectionId: 'connection', runtimeGeneration: 1 },
  new AbortController().signal)
  const pin = { session, nativeTurnId: 'original-turn', connectionId: 'connection', runtimeGeneration: 1,
    assertCurrent() {} }
  await bridge.activate(pin, new AbortController().signal)
  const command = { operation: 'create' as const, commandId: randomUUID(), filename: 'report.txt', mediaType: 'text/plain' as const }
  await expect(bridge.dispatch(command, { ...pin, callId: 'call', nativeTurnId: 'other-turn' },
    new AbortController().signal)).rejects.toMatchObject({ code: 'WORKER_NATIVE_OUTPUT_UNAVAILABLE' })
  expect(await bridge.dispatch(command, { ...pin, callId: 'call' }, new AbortController().signal)).toMatchObject({ operation: 'create' })
  await bridge.close()
  await expect(bridge.dispatch(command, { ...pin, callId: 'late-call' }, new AbortController().signal)).rejects.toThrow()
  await f.host.close()
})
it('preserves OpenCode plan, configured write denies and selected native agent denies', () => {
  const build = { ...DEFAULT_HARNESS_DEFAULTS.opencode, nativeAgent: 'build' }
  expect(workflowArtifactFilePolicy(build).allowMutation).toBe(true)
  expect(workflowArtifactFilePolicy({ ...build, nativeAgent: 'plan' }).allowMutation).toBe(false)
  expect(workflowArtifactFilePolicy({ ...build, advanced: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
    permissionRules: [{ permission: 'edit', pattern: '*', effect: 'deny' }] } }).allowMutation).toBe(false)
  expect(workflowArtifactFilePolicy({ ...build, advanced: { ...DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
    permissionRules: [{ permission: 'files.*', pattern: '*', effect: 'deny' }] } }).allowMutation).toBe(false)
  expect(openCodeArtifactMutationAllowed({ ...build, nativeAgent: 'custom' }, [
    { permission: '*', pattern: '*', effect: 'allow' }, { permission: 'write', pattern: '*', effect: 'deny' },
  ])).toBe(false)
})
it('keeps explicitly writable Codex full-access settings for path-free output tools', () => {
  const fullAccess = { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'danger-full-access' as const }
  expect(workflowArtifactFilePolicy(fullAccess).allowMutation).toBe(true)
  expect(codexNativeOutputDeclarations(fullAccess, 'codex-cli 0.154.0', { storageKind: 'buffer' })).toHaveLength(4)
  expect(() => codexNativeOutputDeclarations(fullAccess, 'codex-cli 0.154.0')).toThrow()
  expect(() => codexNativeOutputDeclarations({ ...fullAccess, sandbox: 'read-only' },
    'codex-cli 0.154.0', { storageKind: 'buffer' })).toThrow()
})
