import { beforeEach, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { HarnessExecution, NativeSessionReference } from '@foreman-code/contracts'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { remoteEntryClosureDigest, remoteNonEntryClosureDigest } from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import { DomainError } from '../errors.js'

const ports = vi.hoisted(() => {
  const connection = {
    mainId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
    workerInstallationId: '33333333-3333-4333-8333-333333333333',
    bootId: '66666666-6666-4666-8666-666666666666',
    keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1,
  }
  const intent = {
    schemaVersion: 1, protocolVersion: 1, mainId: connection.mainId,
    runId: 'run', nodeId: 'node', executionId: 'execution', operationId: 'operation',
    occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt',
    bindingHash: 'a'.repeat(64), inputDigest: `sha256:${'b'.repeat(64)}`,
    owner: { grantId: 'grant', epoch: '1' },
  }
  const placement = {
    mainId: connection.mainId, bindingHash: intent.bindingHash,
    hostRef: { kind: 'device', mainId: connection.mainId, deviceId: connection.deviceId },
    registration: {
      workerInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    },
  }
  return { connection, intent, placement, authority: vi.fn(), prefetch: vi.fn(), closed: vi.fn(),
    persist: vi.fn(), reject: vi.fn() }
})
vi.mock('./persistence.js', () => ({
  readDispatchIntent: async () => ports.intent,
  readAcceptedPlacement: async () => ports.placement,
  readNativePlacement: async () => ({}),
}))
vi.mock('./executionBinding.js', () => ({
  readNativeExecutionBinding: () => ({
    workingTree: { canonicalCwd: '/workspace/source' }, materialization: { state: 'prepared' },
  }),
}))
vi.mock('../runs/remote/persistence.js', () => ({
  readReconciledDispatchIntent: async () => ports.intent,
  persistVerifiedRemoteReceipt: ports.persist,
  auditRejectedRemoteReceipt: ports.reject,
}))
vi.mock('./executionAuthority.js', () => ({ assertRemoteExecutionAuthority: ports.authority }))
vi.mock('../runs/remote/workflowPhysicalVerification.js', () => ({
  createRemoteWorkflowPhysicalVerification: () => ({ prefetch: ports.prefetch, confirmedClosed: ports.closed }),
}))
import { createProductionRemoteWorkflow } from './productionRemoteWorkflow.js'

beforeEach(() => {
  vi.resetAllMocks()
  ports.prefetch.mockResolvedValue({ kind: 'original-remote-physical' })
  ports.closed.mockReturnValue(true)
})

function fixture() {
  const state = { session: null as NativeSessionReference | null, stored: undefined as RemoteOperationReceipt | undefined,
    cleanup: new Date('2026-10-01T00:00:00.000Z') as Date | undefined }
  const receipt: RemoteOperationReceipt = {
    schemaVersion: 1, intent: ports.intent as RemoteOperationReceipt['intent'], connection: ports.connection,
    workerIncarnationId: '44444444-4444-4444-8444-444444444444', sequence: 4,
    phase: 'confirmed_terminal', entryAttempted: true, turnEntryAttempted: false, stopFence: true, controls: [],
    native: { sessionId: 'session', processIdentityDigest: 'c'.repeat(64) },
    terminal: { kind: 'cancelled', closureEvidenceDigest: 'd'.repeat(64) },
  }
  const query = vi.fn(async (text: string) => {
    if (text.includes('from execution_native_sessions')) {
      return { rows: state.session ? [{ reference: state.session }] : [], rowCount: state.session ? 1 : 0 }
    }
    if (text.includes('from remote_dispatch_origins')) return { rows: [{ connection: ports.connection }], rowCount: 1 }
    if (text.includes('from remote_execution_receipts')) {
      return { rows: state.stored ? [{ receipt: state.stored }] : [], rowCount: state.stored ? 1 : 0 }
    }
    if (text.includes('from run_cleanup_intents')) {
      return { rows: state.cleanup ? [{ requested_at: state.cleanup }] : [], rowCount: state.cleanup ? 1 : 0 }
    }
    return { rows: [], rowCount: 0 }
  })
  const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => undefined)
  const owner = {
    runId: 'run', assertOwned() {}, oneShotConnection: () => connection,
    readOneShotFence: async () => ({ ownerId: 'owner', fence: '1' }),
  } as unknown as RunOwnership
  const request = vi.fn<(payload: unknown, options?: { signal?: AbortSignal }) => Promise<{ payload: unknown }>>(
    async () => ({ payload: { status: 'known', receipt } }))
  ports.persist.mockImplementation(async (_sql, _owner, evidence) => { state.stored = evidence.receipt })
  const composition = createProductionRemoteWorkflow({
    pool: { query } as unknown as pg.Pool,
    locations: {} as Parameters<typeof createProductionRemoteWorkflow>[0]['locations'],
    endpoint: () => ({ captureRequest: () => ({ binding: ports.connection, request }) }) as unknown as
      ReturnType<Parameters<typeof createProductionRemoteWorkflow>[0]['endpoint']>,
    producer: () => ({} as NonNullable<ReturnType<Parameters<typeof createProductionRemoteWorkflow>[0]['producer']>>),
    execution: async () => ({
      id: 'execution', runId: 'run', workflowNodeId: 'node', attempt: 1, workingDirectory: '/workspace/source',
    } as HarnessExecution),
  })
  return { state, receipt, request, composition, owner, close: () => connection.close() }
}

function runningFixture() {
  const f = fixture()
  delete f.receipt.terminal
  f.receipt.phase = 'running'
  f.receipt.stopFence = false
  f.state.stored = structuredClone(f.receipt)
  f.state.session = { harness: 'codex', providerVersion: 'fixture', nativeSessionId: f.receipt.native!.sessionId }
  return f
}

it('sends the same fenced Stop after cold restart until physical closure is confirmed', async () => {
  const f = runningFixture()
  const commands: unknown[] = []
  const signal = new AbortController().signal
  f.request.mockImplementation(async payload => {
    const frame = payload as { method: string; command?: unknown }
    if (frame.method === 'control') {
      commands.push(frame.command)
      if (commands.length > 1) {
        f.receipt.phase = 'confirmed_terminal'
        f.receipt.stopFence = true
        f.receipt.sequence++
        f.receipt.terminal = { kind: 'cancelled', closureEvidenceDigest: 'd'.repeat(64) }
      }
    }
    return { payload: { status: 'known', receipt: structuredClone(f.receipt) } }
  })
  try {
    await expect(f.composition.confirmClosedExecution('execution', signal, f.owner)).resolves.toBe(false)
    await expect(f.composition.confirmClosedExecution('execution', signal, f.owner)).resolves.toBe(true)
    expect(commands).toHaveLength(2)
    expect(commands[0]).toEqual(commands[1])
    expect(commands[0]).toMatchObject({ operationId: f.receipt.intent.operationId,
      attemptId: f.receipt.intent.attemptId, executionId: 'execution', native: f.receipt.native,
      owner: f.receipt.intent.owner, action: { kind: 'stop' } })
    expect(f.request.mock.calls.every(call => call[1]?.signal === signal)).toBe(true)
    expect(f.state.stored).toEqual(f.receipt)
    expect(ports.closed).toHaveBeenCalled()
  } finally { await f.close() }
})

it.each(['cleanup', 'authority', 'native'] as const)(
  'does not send a cold Stop after its %s changes', async defect => {
    const f = runningFixture()
    if (defect === 'cleanup') f.state.cleanup = undefined
    if (defect === 'authority') ports.authority.mockRejectedValue(new DomainError('REMOTE_AUTHORITY_DENIED', 'Revoked', 403))
    if (defect === 'native') f.state.stored!.native = { ...f.receipt.native!, sessionId: 'replacement-session' }
    try {
      await expect(f.composition.confirmClosedExecution('execution', new AbortController().signal, f.owner))
        .rejects.toBeInstanceOf(DomainError)
      expect(f.request).toHaveBeenCalledTimes(1)
      expect(ports.persist).not.toHaveBeenCalled()
    } finally { await f.close() }
  },
)

it('requires physical closure even after cold Stop reports a terminal result', async () => {
  const f = runningFixture()
  ports.closed.mockReturnValue(false)
  f.request.mockImplementation(async payload => {
    if ((payload as { method: string }).method === 'control') {
      f.receipt.phase = 'confirmed_terminal'
      f.receipt.stopFence = true
      f.receipt.sequence++
      f.receipt.terminal = { kind: 'cancelled', closureEvidenceDigest: 'd'.repeat(64) }
    }
    return { payload: { status: 'known', receipt: structuredClone(f.receipt) } }
  })
  try {
    await expect(f.composition.confirmClosedExecution('execution', new AbortController().signal, f.owner))
      .resolves.toBe(false)
    expect(f.request.mock.calls.map(call => (call[0] as { method: string }).method)).toEqual(['status', 'control'])
    expect(ports.persist).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('persists proven cold closure when Main crashed before binding the native session', async () => {
  const f = fixture()
  try {
    await expect(f.composition.confirmClosedExecution('execution', new AbortController().signal, f.owner))
      .resolves.toBe(true)
    expect(ports.closed).toHaveBeenCalledWith(expect.any(Object), null)
    expect(f.state.stored).toEqual(f.receipt)
    expect(f.state.session).toBeNull()
    expect(f.request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ method: 'status' }), expect.any(Object))
  } finally { await f.close() }
})

it('stops and settles an accepted remote preparation that never entered native execution', async () => {
  const f = fixture()
  delete f.receipt.native
  delete f.receipt.terminal
  f.receipt.phase = 'received'
  f.receipt.entryAttempted = false
  f.receipt.stopFence = false
  const accepted = structuredClone(f.receipt)
  f.request.mockImplementation(async (...args: unknown[]) => {
    const frame = args[0] as { method: string; command?: unknown }
    if (frame.method === 'control') {
      f.receipt.phase = 'confirmed_terminal'
      f.receipt.stopFence = true
      f.receipt.sequence++
      f.receipt.terminal = { kind: 'not_started', closureEvidenceDigest: remoteNonEntryClosureDigest(f.receipt.intent) }
    }
    return { payload: { status: 'known', receipt: frame.method === 'status' ? accepted : f.receipt } }
  })
  try {
    await expect(f.composition.confirmClosedExecution('execution', new AbortController().signal, f.owner))
      .resolves.toBe(true)
    expect(f.request.mock.calls.map(call => (call[0] as unknown as { method: string }).method))
      .toEqual(['status', 'control'])
    expect(f.request.mock.calls[1]![0]).toMatchObject({ command: {
      operationId: f.receipt.intent.operationId, attemptId: f.receipt.intent.attemptId,
      executionId: f.receipt.intent.executionId, owner: f.receipt.intent.owner, action: { kind: 'stop' },
    } })
    expect(f.state.stored).toEqual(f.receipt)
    expect(ports.prefetch).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('persists positive closure for an interrupted entry that never returned a session', async () => {
  const f = fixture()
  const entryClosure = {
    intent: f.receipt.intent, connection: f.receipt.connection, owner: 'execution:execution',
    initialLaunchId: '55555555-5555-4555-8555-555555555555',
    launches: [{ owner: 'execution:execution', launchId: '55555555-5555-4555-8555-555555555555',
      bootId: f.receipt.connection.bootId, lifecycle: 'closed' as const, closureEvidence: 'linux_boot_changed' as const }],
  }
  delete f.receipt.native
  f.receipt.terminal = { kind: 'cancelled', entryClosure, closureEvidenceDigest: remoteEntryClosureDigest(entryClosure) }
  try {
    await expect(f.composition.confirmClosedExecution('execution', new AbortController().signal, f.owner))
      .resolves.toBe(true)
    expect(f.state.stored).toEqual(f.receipt)
    expect(ports.prefetch).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('leaves a live or unconfirmed native owner unsettled', async () => {
  const f = fixture()
  ports.closed.mockReturnValue(false)
  try {
    await expect(f.composition.confirmClosedExecution('execution', new AbortController().signal, f.owner))
      .resolves.toBe(false)
    expect(f.state.stored).toBeUndefined()
    expect(f.request).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})

it('rejects closure after a bound session appears during physical readback', async () => {
  const f = fixture()
  ports.prefetch.mockImplementation(async () => {
    f.state.session = { harness: 'codex', providerVersion: 'fixture', nativeSessionId: 'replacement-session' }
    return { kind: 'original-remote-physical' }
  })
  try {
    await expect(f.composition.confirmClosedExecution('execution', new AbortController().signal, f.owner))
      .rejects.toMatchObject({ code: 'REMOTE_CLOSURE_INVALID' })
    expect(f.state.stored).toBeUndefined()
  } finally { await f.close() }
})

it('keeps revoked execution authority from publishing cold closure', async () => {
  const f = fixture()
  ports.authority.mockRejectedValue(new DomainError('AUTH_REVOKED', 'Execution access revoked', 403))
  try {
    await expect(f.composition.confirmClosedExecution('execution', new AbortController().signal, f.owner))
      .rejects.toMatchObject({ code: 'REMOTE_CLOSURE_RECEIPT_REJECTED' })
    expect(f.state.stored).toBeUndefined()
    expect(ports.reject).toHaveBeenCalled()
  } finally { await f.close() }
})
