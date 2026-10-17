import { createHash, randomUUID } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, type ExecutionResult } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationReceipt, WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHistory, NativeSessionStart } from '../harnesses/port.js'
import type { NativeLaunchObservation, NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import type { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { createInstalledWorkerConversations } from './installedWorkerConversations.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

const provider = vi.hoisted(() => ({
  session: { harness: 'codex' as const, providerVersion: 'fixture-codex', nativeSessionId: 'original-session' },
  starts: [] as NativeSessionStart[],
  history: { events: [], pendingInteractions: [] } as NativeHistory,
  creates: 0,
}))
vi.mock('../runs/remote/installedWorkflowConfiguration.js', () => ({
  readInstalledWorkflowConfiguration: async () => ({}),
}))
vi.mock('./installedConversationDirectory.js', () => ({
  installedConversationDirectory: async () => ({ assertCurrent: async () => {} }),
}))
vi.mock('./installedNativeProfile.js', () => ({
  createInstalledConversationNativeReader: () => ({ repository: {}, capture: async () => ({
    inspection: { installation: { launcher: { resolvedLauncher: '/fixture/codex' } } },
    qualification: { version: 'fixture-codex' },
  }) }),
}))
// Only provider IO and installation qualification are replaced; host, callbacks, journal and recovery are real.
vi.mock('../harnesses/codexAppServer.js', async importOriginal => ({
  ...await importOriginal<typeof import('../harnesses/codexAppServer.js')>(),
  CodexAppServerSessionManager: class {
    readonly harness = 'codex'
    async createSession() { provider.creates++; return provider.session }
    async attachSession(session: typeof provider.session, start: NativeSessionStart) {
      provider.starts.push(start)
      return session
    }
    async reconcile() { return structuredClone(provider.history) }
    async dispose() {}
  },
}))
beforeEach(() => {
  provider.starts.length = 0
  provider.creates = 0
  provider.history = { events: [], pendingInteractions: [], correlationId: 'unfinished', nativeTurnId: 'native-turn',
    terminalResult: { outcome: 'succeeded', output: 'Saved native answer' } }
})

async function fixture() {
  const f = workerConversationFixture('agent')
  const base = AgentConfigurationVersionSchema.parse(f.configuration)
  const instructions = 'Use the node skill.'
  const configuration = { ...base, assignedSkills: [{ skillId: 'node-skill', version: '1' }],
    resolvedSkills: [{ skillId: 'node-skill', version: '1', instructions,
      contentHash: `sha256:${createHash('sha256').update(instructions).digest('hex')}` }] }
  const binding = { ...f.binding, owner: { ...f.binding.owner, configurationHash: commandInputHash(configuration) } }
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  const launches: NativeLaunchObservation[] = []
  let closureConfirmed = true
  const closeOwner = vi.fn(async (owner: string) => {
    if (!closureConfirmed) return false
    for (const [index, launch] of launches.entries()) {
      if (launch.owner === owner) launches[index] = { ...launch, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' }
    }
    return true
  })
  const registry = {
    scope: (owner: string) => ({ owner, root: '/fixture/native-processes' }),
    reserveLaunch: async (owner: string) => {
      const launch: NativeLaunchObservation = { owner, launchId: randomUUID(), bootId: f.connection.bootId,
        lifecycle: 'active', guardian: { pid: 11111, startTicks: '10' }, provider: { pid: 11112, startTicks: '11' },
        boundary: { kind: 'cgroup-v2', path: '/fixture/native-boundary', device: '1', inode: '2' } }
      launches.push(launch)
      return { launchId: launch.launchId }
    },
    snapshot: () => ({ revision: 'fixture', launches }), closeOwner, abandonReservedLaunch: async () => {},
  } as unknown as NativeProcessRegistry
  const bridge = new MainWorkerConversationBridge()
  const signal = new AbortController().signal
  const host = await createInstalledWorkerConversations({ stateDirectory: '/fixture/worker-state', configuration: null,
    registry, journal: async () => ({ conversations: journal }) as unknown as RemoteOperationJournal,
    current: () => f.connection,
    capture: () => ({ binding: f.connection, request: async raw => ({ payload: await bridge.handle(raw, f.connection, signal) }) }),
    request: async () => { throw new Error('Recovery cannot use an application credential') },
    approvedRoots: async () => { throw new Error('Directory admission is supplied by this fixture') },
    codexSuiteRevision: 'fixture-suite', signal })
  if (!host) throw new Error('Installed conversation host required')
  const request = async (input: WorkerConversationRpcRequest) => {
    const lease = bridge.capture({ request: input, current: async () => {},
      callbacks: { sessionObserved: async session => { expect(session).toEqual(provider.session) } }, channel: { binding: f.connection,
      request: async raw => ({ payload: await host.handle(raw, f.connection, signal) }) } })
    try { return await lease.request() } finally { await lease.close() }
  }
  await request({ method: 'conversation.open', binding: f.binding, configuration: base,
    mode: 'create', operationId: 'original-create' })
  await journal.reserveTurn(f.binding, 'unfinished', commandInputHash('original-input'))
  await journal.submitted(f.binding, 'unfinished', { nativeTurnId: 'native-turn' })
  await journal.finishTurn(f.binding, 'unfinished')
  launches[0] = { ...launches[0]!, lifecycle: 'ended' }
  const transition = () => request({ method: 'conversation.open', binding, configuration, previousBinding: f.binding,
    previousConfiguration: base, mode: 'attach', source: provider.session, operationId: 'skills' })
  return { ...f, originalBinding: f.binding, base, binding, configuration, journal, launches, transition, closeOwner,
    setClosureConfirmed(value: boolean) { closureConfirmed = value },
    cleanup: async () => { closureConfirmed = true; await host.close(); await bridge.close() } }
}

it.each(['succeeded', 'failed'] as const)(
  'recovers the saved %s result under the original skills after the resident process exits', async outcome => {
    const f = await fixture()
    const result: ExecutionResult = outcome === 'succeeded' ? { outcome, output: 'Saved native answer' }
      : { outcome, error: { code: 'NATIVE_FAILURE', message: 'Saved native failure', retryable: false } }
    provider.history.terminalResult = result
    try {
      const response = await f.transition() as { receipt: WorkerConversationReceipt }
      expect(response.receipt.binding).toEqual(f.binding)
      expect(response.receipt.session).toEqual(provider.session)
      expect(response.receipt.creation?.operationId).toBe('original-create')
      expect(response.receipt.turns[0]).toMatchObject({ status: 'completed', nativeTurnId: 'native-turn', result })
      expect(provider.starts.map(start => 'configuration' in start && start.configuration)).toEqual([f.base, f.configuration])
      expect(response.receipt.ownerTransitions).toHaveLength(2)
      expect(f.launches.slice(0, 2).every(launch => launch.lifecycle === 'closed' && launch.closureEvidence)).toBe(true)
      expect(provider.creates).toBe(1)
    } finally { await f.cleanup() }
  })

it('retains the old binding while closure is unconfirmed and recovers on retry without a Worker restart', async () => {
  const f = await fixture()
  try {
    f.setClosureConfirmed(false)
    await expect(f.transition()).rejects.toThrow('closure is unconfirmed')
    expect((await f.journal.read(f.originalBinding))?.turns[0]?.status).toBe('uncertain')
    expect(provider.starts).toHaveLength(0)
    expect(f.launches).toHaveLength(1)
    f.setClosureConfirmed(true)
    await expect(f.transition()).resolves.toMatchObject({ receipt: { binding: f.binding } })
    expect(provider.creates).toBe(1)
  } finally { await f.cleanup() }
})

it('keeps the old binding and uncertain turn when the exited process has no saved terminal result', async () => {
  const f = await fixture()
  delete provider.history.terminalResult
  try {
    await expect(f.transition()).rejects.toThrow('could not be recovered')
    const saved = await f.journal.read(f.originalBinding)
    expect(saved?.binding).toEqual(f.originalBinding)
    expect(saved?.turns[0]?.status).toBe('uncertain')
    expect(saved?.turns[0]?.result).toBeUndefined()
    expect(provider.starts.map(start => 'configuration' in start && start.configuration)).toEqual([f.base])
    expect(provider.creates).toBe(1)
  } finally { await f.cleanup() }
})

it('settles a live resident without replacing it before the skills migration', async () => {
  const f = await fixture()
  f.launches[0] = { ...f.launches[0]!, lifecycle: 'active' }
  try {
    await expect(f.transition()).resolves.toMatchObject({ receipt: { binding: f.binding } })
    expect(provider.starts.map(start => 'configuration' in start && start.configuration)).toEqual([f.configuration])
    expect(provider.creates).toBe(1)
  } finally { await f.cleanup() }
})

it('refuses a different exited process without closing it or rewriting its saved turn', async () => {
  const f = await fixture()
  f.launches[0] = { ...f.launches[0]!, provider: { pid: 22222, startTicks: '22' } }
  try {
    await expect(f.transition()).rejects.toThrow('unavailable or changed')
    expect(f.closeOwner).not.toHaveBeenCalled()
    expect(provider.starts).toHaveLength(0)
    expect((await f.journal.read(f.originalBinding))?.turns[0]?.status).toBe('uncertain')
  } finally { await f.cleanup() }
})
