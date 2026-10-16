import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion } from '@foreman-code/contracts'
import type { WorkflowNativeCapture, WorkflowNativeCaptureInput } from '../interactions/workflowNativeCapture.js'
import type { CapturedReviewNativeSource } from '../interactions/reviewNativeCapture.js'
import type { remoteNativeManager } from './workerCarrier.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { physicalFixture } from '../runs/remote/__tests__/installedWorkflowHost.js'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import { VerifiedRemoteEvidence } from '../runs/remote/resultBridge.js'
import { createProductionRemoteWorkflow } from './productionRemoteWorkflow.js'

const ports = vi.hoisted(() => ({ manager: vi.fn(), persist: vi.fn() }))
vi.mock('./workerCarrier.js', () => ({ remoteNativeManager: ports.manager }))
vi.mock('./executionAuthority.js', () => ({ assertRemoteExecutionAuthority: async () => {} }))
vi.mock('./remoteReviewerAuthority.js', () => ({ assertRemoteReviewerReceipt: async () => {} }))
vi.mock('../runs/remote/persistence.js', async importOriginal => ({
  ...await importOriginal<typeof import('../runs/remote/persistence.js')>(),
  persistVerifiedRemoteReceipt: ports.persist,
}))

async function fixture() {
  ports.manager.mockClear()
  const f = await physicalFixture()
  const state = { receipt: structuredClone(f.readout.receipt), failAck: false,
    reviewProofs: [] as { record: unknown }[] }
  const originalQuery = f.query.getMockImplementation()!
  const query = async (text: string) => {
    if (text.includes('from remote_execution_receipts')) return { rows: [{ receipt: state.receipt }], rowCount: 1 }
    if (text.includes('from review_native_proofs')) return { rows: state.reviewProofs, rowCount: state.reviewProofs.length }
    return originalQuery(text)
  }
  ports.persist.mockImplementation(async (_sql, _owner, evidence: VerifiedRemoteEvidence) => {
    state.receipt = structuredClone(evidence.receipt)
  })
  f.request.mockImplementation(async payload => {
    const frame = payload as { method: string; receiptSequence: number; sourceDigest: string }
    if (frame.method === 'physical-ack') {
      if (state.failAck) throw new Error('Acknowledgment lost')
      return { payload: { version: 1, operationId: f.intent.operationId, receiptSequence: frame.receiptSequence,
        sourceDigest: frame.sourceDigest, status: 'retired' } }
    }
    if (frame.method === 'status') return { payload: { status: 'known', receipt: f.readout.receipt } }
    return { payload: f.readout }
  })
  await f.sqlConnection.close()
  const sqlConnection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => undefined)
  Object.assign(f.owner, { oneShotConnection: () => sqlConnection,
    readOneShotFence: async () => ({ ownerId: 'owner', fence: '1' }) })
  const composition = createProductionRemoteWorkflow({ pool: { query } as unknown as pg.Pool,
    locations: {} as Parameters<typeof createProductionRemoteWorkflow>[0]['locations'],
    endpoint: () => ({ currentBinding: f.currentBinding,
      captureRequest: () => ({ binding: f.context.binding, request: f.request }) }) as unknown as
      ReturnType<Parameters<typeof createProductionRemoteWorkflow>[0]['endpoint']>,
    producer: () => ({} as NonNullable<ReturnType<Parameters<typeof createProductionRemoteWorkflow>[0]['producer']>>),
    execution: async () => f.execution,
  })
  await composition.prepare(f.execution.id)
  const configuration: AgentConfigurationVersion = { id: f.execution.agentConfigurationVersionId,
    agentId: f.execution.agentId, workspaceId: 'workspace', version: 1, prompt: { system: 'test' },
    assignedSkills: [], harness: DEFAULT_HARNESS_DEFAULTS.codex, contentHash: 'fixture', createdAt: f.execution.createdAt }
  composition.manager({ executionId: f.execution.id, agentId: f.execution.agentId,
    configuration, harness: 'codex', workingDirectory: f.execution.workingDirectory! }, () => f.owner)
  const callbacks = ports.manager.mock.calls.at(-1)![2] as Parameters<typeof remoteNativeManager>[2]
  const observe = async () => {
    const receipt = f.readout.receipt
    await VerifiedRemoteEvidence.commit(receipt, f.connection, await callbacks.commit(receipt, f.connection, {}))
    await callbacks.observeOriginalSource!(receipt, { type: 'history', history: f.readout.history! } as never)
  }
  const closeNative = () => {
    f.readout.receipt = { ...f.readout.receipt, sequence: f.readout.receipt.sequence + 1,
      phase: 'confirmed_terminal', stopFence: true, terminal: { kind: 'cancelled',
        closureEvidenceDigest: commandInputHash({ intent: f.intent, native: f.readout.receipt.native,
          launch: f.captured.launch, physicalOwnerClosed: true }).slice('sha256:'.length) } }
    f.readout.observation = { ...f.captured.launch, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' } as never
    f.readout.closure = { ownerClosed: true, launch: f.readout.observation }
  }
  return { ...f, sqlConnection, composition, state, observe, closeNative }
}

it('releases real execution bindings after cold closure is committed and acknowledged', async () => {
  const f = await fixture()
  try {
    await f.observe()
    f.closeNative()
    f.state.failAck = true
    await expect(f.composition.confirmClosedExecution(f.execution.id, new AbortController().signal, f.owner))
      .rejects.toThrow('Acknowledgment lost')
    expect(f.composition.binding(f.execution.id)).toBeDefined()
    f.state.failAck = false
    expect(await f.composition.confirmClosedExecution(f.execution.id, new AbortController().signal, f.owner)).toBe(true)
    expect(f.state.receipt).toEqual(f.readout.receipt)
    expect(f.composition.binding(f.execution.id)).toBeUndefined()
    expect(f.composition.isRemote(f.execution.id)).toBe(false)
    await f.composition.prepare(f.execution.id)
    expect(() => f.composition.capture({ owner: f.owner } as WorkflowNativeCaptureInput, {
      execution: f.execution, source: { type: 'history', history: f.readout.history! }, closureGeneration: '1',
    } as unknown as WorkflowNativeCapture)).toThrowError(expect.objectContaining({ code: 'REMOTE_NATIVE_SOURCE_NOT_CAPTURED' }))
  } finally { await f.sqlConnection.close() }
})

it.each([false, true])('releases real reviewer source maps only after closed lifetime ACKs (closed=%s)', async closed => {
  const f = await fixture()
  const result = { outcome: 'succeeded' as const, output: { text: 'workflow result' } }
  const assignment = { jobId: 'review-job', interactionId: 'interaction', reviewerAgentId: f.execution.agentId,
    correlationId: 'review:review-job', session: f.session }
  try {
    await f.journal.retainReviewer(f.intent.operationId, { agentId: f.execution.agentId,
      expiresAt: '2099-01-01T00:00:00.000Z' }, { ...f.source.history,
      terminalTurn: { correlationId: `execution:${f.execution.id}`, providerId: 'original-turn', result } })
    await f.journal.reserveReviewTurn(f.intent.operationId, assignment, 'a'.repeat(64), -1)
    await f.journal.enterReviewTurn(f.intent.operationId, assignment.correlationId)
    await f.journal.acknowledgeReviewTurn(f.intent.operationId, assignment.correlationId, 'review-turn')
    const history = { events: [], pendingInteractions: [], correlationId: assignment.correlationId,
      nativeTurnId: 'review-turn', terminalTurn: { correlationId: assignment.correlationId,
        providerId: 'review-turn', result: { outcome: 'succeeded' as const } } }
    await f.journal.settleReviewTurn(f.intent.operationId, history)
    const status = await f.journal.status(f.intent.operationId)
    if (status.status !== 'known') throw new Error('Expected reviewer receipt')
    f.readout.receipt = status.receipt
    f.readout.history = history
    f.execution.state = 'completed'
    f.execution.result = result
    f.execution.finishedAt = new Date().toISOString()
    f.lane.correlation = assignment.correlationId
    f.lane.provider_id = 'review-turn'
    if (closed) f.closeNative()
    await f.observe()
    const capture: CapturedReviewNativeSource = { execution: f.execution, session: f.session, owner: f.owner,
      job: { id: assignment.jobId, correlationId: assignment.correlationId } as CapturedReviewNativeSource['job'],
      lifetimeGeneration: 1, closureGeneration: '1', lane: { ...f.lifetime.lane!, providerId: 'review-turn' },
      source: { type: 'history', history }, observedAt: f.execution.createdAt, assertCurrent() {} }
    f.composition.captureReview(capture)
    f.state.reviewProofs.push({ record: { job: assignment, session: f.session, original: capture.source } })
    await f.sqlConnection.transaction(sql => f.composition.assertReviewPhysical(sql, capture))
    f.state.failAck = true
    await f.composition.afterReviewCommit(f.execution.id)
    expect(f.composition.binding(f.execution.id)).toBeDefined()
    f.state.failAck = false
    await f.composition.afterReviewCommit(f.execution.id)
    if (closed) {
      expect(f.composition.binding(f.execution.id)).toBeUndefined()
      await expect(f.sqlConnection.transaction(sql => f.composition.assertReviewPhysical(sql, capture)))
        .rejects.toMatchObject({ code: 'REMOTE_NATIVE_SOURCE_NOT_CAPTURED' })
      await f.composition.prepare(f.execution.id)
      expect(() => f.composition.capture({ owner: f.owner } as WorkflowNativeCaptureInput, {
        execution: f.execution, source: { type: 'history', history }, closureGeneration: '1',
      } as unknown as WorkflowNativeCapture)).toThrowError(expect.objectContaining({ code: 'REMOTE_NATIVE_SOURCE_NOT_CAPTURED' }))
    } else {
      expect(f.composition.isRemote(f.execution.id)).toBe(true)
      expect(f.composition.getRemoteNativeOwners()).toEqual([])
    }
  } finally { await f.sqlConnection.close() }
})
