import { beforeEach, expect, it, vi } from 'vitest'
import type { WorkflowNativeCapture } from '../../interactions/workflowNativeCapture.js'
import { readAcceptedPlacement } from '../../placement/persistence.js'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import type { RunOwnership } from '../ownership.js'
import type { WorkflowNativeProofRecord } from '../workflowNativeProof.js'
import { createMainWorkflowArtifactTerminals } from './mainWorkflowArtifacts.js'

vi.mock('../../placement/persistence.js', () => ({ readAcceptedPlacement: vi.fn(), readDispatchIntent: vi.fn() }))
beforeEach(() => vi.resetAllMocks())

function fixture() {
  const session = { harness: 'codex' as const, providerVersion: 'unit', nativeSessionId: 'original-session' }
  const source = { type: 'history', history: { terminalTurn: {
    providerId: 'original-turn', result: { outcome: 'succeeded' },
  } } } as WorkflowNativeCapture['source']
  const capture = { execution: { id: 'execution', runId: 'run', workflowNodeId: 'node' },
    session, source, closureGeneration: '1', assertCurrent: vi.fn() } as unknown as WorkflowNativeCapture
  const proof = { session, original: source, lane: { providerId: 'original-turn' } } as WorkflowNativeProofRecord
  const owner = { assertOwned: vi.fn() } as unknown as RunOwnership
  const lifetime = { expected_reference: session as unknown, native_reference: session as unknown, closed: false }
  const sql = { query: vi.fn(async () => ({ rows: [lifetime], rowCount: 1 })) } as unknown as GraphTransactionSql
  vi.mocked(readAcceptedPlacement).mockResolvedValue({
    hostRef: { kind: 'main', mainId: 'main' },
  } as Awaited<ReturnType<typeof readAcceptedPlacement>>)
  const service = createMainWorkflowArtifactTerminals('main')
  return { lifetime, session, capture,
    read: () => service.artifactTerminalContext(sql, owner, capture, proof) }
}

it.each([false, true])('reads the bound Main terminal when initial registration had no session (closed=%s)', async closed => {
  const f = fixture()
  f.lifetime.expected_reference = null
  f.lifetime.closed = closed
  expect(await f.read()).toEqual({ kind: 'main', mainId: 'main' })
  expect(f.capture.assertCurrent).toHaveBeenCalledTimes(closed ? 0 : 1)
})

it.each(['native_reference', 'expected_reference'] as const)('rejects a different Main %s', async field => {
  const f = fixture()
  f.lifetime[field] = { ...f.session, nativeSessionId: 'different-session' }
  await expect(f.read()).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE' })
})

it('requires the persisted session even when the initial lifetime had no reference', async () => {
  const f = fixture()
  f.lifetime.expected_reference = null
  f.lifetime.native_reference = null
  await expect(f.read()).rejects.toMatchObject({ code: 'WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE' })
})
