import { beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { readUnboundWorkflowClosure, readWorkflowClosure } from '../interactions/workflowClosure.js'
import { hasRetainedRemoteReviewerSource, readRetainedRemoteReviewer } from '../interactions/retainedRemoteReviewer.js'
import { closeCompletedWorkflowSources, localWorkflowSourceClosed } from './workflowCleanup.js'
import { PostgresSourceService } from './service.js'

vi.mock('../interactions/workflowClosure.js', () => ({
  readWorkflowClosure: vi.fn(),
  readUnboundWorkflowClosure: vi.fn(),
}))
vi.mock('../interactions/retainedRemoteReviewer.js', () => ({
  readRetainedRemoteReviewer: vi.fn(), hasRetainedRemoteReviewerSource: vi.fn(),
}))
beforeEach(() => vi.resetAllMocks())

function fixture(bound: boolean, state: 'completed' | 'starting' = 'completed') {
  const execution = HarnessExecutionSchema.parse({
    id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1,
    workingDirectory: '/private/source/tree', runtimeDirectory: '/private/runtime',
    input: {}, state, createdAt: '2026-10-04T00:00:00Z',
    ...(bound ? { nativeSessionId: 'native-session' } : {}),
    ...(state === 'completed' ? {
      result: { outcome: 'canceled' }, finishedAt: '2026-10-04T00:01:00Z',
    } : {}),
  })
  const sql = { query: vi.fn(async () => ({ rows: [{ record: execution }] })) } as unknown as GraphSqlClient
  return { execution, sql }
}

it.each([true, false])('requires stored physical closure when a completed execution is bound=%s', async bound => {
  const f = fixture(bound)
  expect(await localWorkflowSourceClosed(f.sql, f.execution.id)).toBe(false)
  const read = bound ? vi.mocked(readWorkflowClosure) : vi.mocked(readUnboundWorkflowClosure)
  expect(read).toHaveBeenCalledWith(f.sql, f.execution)
  if (bound) {
    vi.mocked(readWorkflowClosure).mockResolvedValue({
      execution: f.execution, durableGeneration: '1',
      session: { harness: 'codex', nativeSessionId: 'native-session', providerVersion: '0.154.0' },
    } as NonNullable<Awaited<ReturnType<typeof readWorkflowClosure>>>)
  } else {
    vi.mocked(readUnboundWorkflowClosure).mockResolvedValue({
      execution: f.execution, durableGeneration: '1',
    } as NonNullable<Awaited<ReturnType<typeof readUnboundWorkflowClosure>>>)
  }
  expect(await localWorkflowSourceClosed(f.sql, f.execution.id)).toBe(true)
})

it('keeps a live execution claim even if a previous lifetime has closure evidence', async () => {
  const f = fixture(false, 'starting')
  expect(await localWorkflowSourceClosed(f.sql, f.execution.id)).toBe(false)
  expect(readUnboundWorkflowClosure).not.toHaveBeenCalled()
  expect(readWorkflowClosure).not.toHaveBeenCalled()
})

it('keeps the claim when execution identity or closure lookup cannot be confirmed', async () => {
  const f = fixture(true)
  expect(await localWorkflowSourceClosed(f.sql, 'another-execution')).toBe(false)
  vi.mocked(readWorkflowClosure).mockRejectedValue(new Error('closure database unavailable'))
  await expect(localWorkflowSourceClosed(f.sql, f.execution.id)).rejects.toThrow('closure database unavailable')
})

function remoteSourceFixture() {
  const execution = HarnessExecutionSchema.parse({ ...fixture(true).execution, result: { outcome: 'succeeded' } })
  const hash = 'a'.repeat(64)
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  const record = SourceMaterializationRecordSchema.parse({
    receipt: { version: 1, materializationId: randomUUID(), executionId: execution.id, attemptId: randomUUID(),
      placementHash: hash, keyRevision: 1, authorizationRevision: 1,
      binding: { version: 1, mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
        workspaceId: 'workspace', rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
        canonicalPath: '/original/source', filesystem, accessMode: 'read-only', snapshotId: randomUUID(), manifestDigest: hash },
      verifiedManifestDigest: hash, verifiedEntries: 1, verifiedBytes: 4,
      verifiedAt: '2026-10-04T00:00:00Z', localTreeIdentity: filesystem },
    rootPolicyId: randomUUID(), rootPolicyRevision: '1', operationId: randomUUID(), reservationId: randomUUID(),
    sourceBindingHash: hash, finalDispatchBindingHash: hash, state: 'prepared',
  })
  const settlement = { pending: false }
  const pool = { query: async () => ({ rows: [{ record, execution, settlement_pending: settlement.pending }] }) } as unknown as Pick<pg.Pool, 'query'>
  const sources = { confirmClosed: vi.fn(async () => undefined) }
  const report = vi.fn()
  return { pool, sources, report, record, execution, settlement }
}

it('leaves a sessionless interrupted copy for physical reservation reclamation', async () => {
  const f = remoteSourceFixture()
  delete f.execution.nativeSessionId
  f.execution.result = { outcome: 'failed',
    error: { code: 'EXECUTION_INTERRUPTED', message: 'Owner restarted', retryable: false } }
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  expect(hasRetainedRemoteReviewerSource).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
})

it('retains the source claim for a verified original reviewer, then requires physical closure after retention ends', async () => {
  const f = remoteSourceFixture()
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(true)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(false)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledWith(f.record)
})

it('keeps the original source when Main retention authority expires before physical closure', async () => {
  const f = remoteSourceFixture()
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(true)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(false)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledWith(f.record)
})

it('reconciles source ownership after reviewer credentials are revoked without requiring review access', async () => {
  const f = remoteSourceFixture()
  vi.mocked(readRetainedRemoteReviewer).mockRejectedValue(new Error('The original reviewer process lease is required'))
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(true)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
  expect(readRetainedRemoteReviewer).not.toHaveBeenCalled()
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(false)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledWith(f.record)
  expect(f.report).not.toHaveBeenCalled()
})

it('reports closure uncertainty when no verified retained reviewer owns the source', async () => {
  const f = remoteSourceFixture()
  const uncertainty = new Error('Original source closure is unconfirmed')
  f.sources.confirmClosed.mockRejectedValue(uncertainty)
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledWith(f.record)
  expect(f.report).toHaveBeenCalledWith(uncertainty)
})

it('reproduces unconfirmed physical closure and defers the actual source service only for verified retention', async () => {
  const f = remoteSourceFixture()
  const releaseClaim = vi.fn(async () => ({ retainedBytes: 0 }))
  const dependencies = [f.pool, {}, {}, {}, f.record.receipt.binding.mainId, {}, { releaseClaim },
    { confirmedClosed: async () => false }] as unknown as ConstructorParameters<typeof PostgresSourceService>
  const sources = new PostgresSourceService(...dependencies)
  await expect(sources.confirmClosed(f.record)).rejects.toMatchObject({ code: 'SOURCE_EXECUTION_UNCERTAIN' })
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(true)
  await closeCompletedWorkflowSources(f.pool, sources, f.report)
  expect(f.report).not.toHaveBeenCalled()
  expect(releaseClaim).not.toHaveBeenCalled()
  vi.mocked(hasRetainedRemoteReviewerSource).mockResolvedValue(false)
  await closeCompletedWorkflowSources(f.pool, sources, f.report)
  expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ code: 'SOURCE_EXECUTION_UNCERTAIN' }))
  expect(releaseClaim).not.toHaveBeenCalled()
})

it('defers a completed Main node while its original native lifetime is still settling', async () => {
  const f = remoteSourceFixture()
  f.record.receipt.binding.deviceId = null
  f.record.receipt.binding.workerInstallationId = null
  f.record.receipt.keyRevision = null
  f.record.receipt.authorizationRevision = null
  f.settlement.pending = true
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
  f.settlement.pending = false
  await closeCompletedWorkflowSources(f.pool, f.sources, f.report)
  expect(f.sources.confirmClosed).toHaveBeenCalledWith(f.record)
})
