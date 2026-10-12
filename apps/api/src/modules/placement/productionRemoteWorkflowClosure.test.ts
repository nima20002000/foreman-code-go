import { beforeEach, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { HarnessExecution, NativeSessionReference } from '@foreman-code/contracts'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { remoteEntryClosureDigest } from '@foreman-code/contracts/remote-execution-entry-closure-node'
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
  const state = { session: null as NativeSessionReference | null, stored: undefined as RemoteOperationReceipt | undefined }
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
    return { rows: [], rowCount: 0 }
  })
  const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => undefined)
  const owner = {
    runId: 'run', assertOwned() {}, oneShotConnection: () => connection,
    readOneShotFence: async () => ({ ownerId: 'owner', fence: '1' }),
  } as unknown as RunOwnership
  const request = vi.fn(async () => ({ payload: { status: 'known', receipt } }))
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
