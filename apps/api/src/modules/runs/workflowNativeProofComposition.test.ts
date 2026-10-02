import { beforeEach, expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { HarnessExecution } from '@graphql/contracts'
import type { AcceptedWorkflowRunV3 } from '@graphql/contracts/wave25'
import type { WorkflowNativeCapture } from '../interactions/workflowNativeCapture.js'
import { ExclusiveGraphConnection, assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import type { RunOwnership } from './ownership.js'
import type { RepeatNativeEvidence } from './repeatNativeRepository.js'
import type { StoredRepeatExecution } from './repeatPostgres.js'
import type { RepeatScope } from './repeatResolution.js'
import { WorkflowNativeProofServices } from './workflowNativeProof.js'
vi.mock('../run-graph/publication.js', () => ({ currentRunGraphPublication: () => ({
  retainNativeSource: async () => ({ sourceDigest: 'original-proof-digest', sourceId: 'original-proof' }),
}) }))
vi.mock('../run-graph/repeatReceipts.js', () => ({ requireRepeatCanonicalReceiptBeforeCommit: vi.fn() }))
vi.mock('./workflowNativeGraph.js', () => ({ appendWorkflowNativeGraphEventLocked: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
function fixture(reject = false) {
  // SQL/native validation ports are isolated here. This exercises actual proof
  // persistence ordering and G1 rollback, not database or physical ownership.
  const events: string[] = []
  const owner = { runId: 'run', assertOwned() {}, readOneShotFence: async () => ({ ownerId: 'owner', fence: '1' }) } as unknown as RunOwnership
  const execution = { id: 'execution', runId: 'run', workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt: 1 } as HarnessExecution
  const capture = { execution, owner, source: { type: 'event', event: { sequence: 1 } }, session: { harness: 'codex', nativeSessionId: 'session' },
    lifetimeGeneration: 1, closureGeneration: '1', lane: null, observedAt: '2026-10-02T00:00:00.000Z' } as WorkflowNativeCapture
  const raw = { query: vi.fn(async (text: string) => {
    if (text.startsWith('insert into workflow_native_proofs')) events.push('proof-stored')
    if (text === 'commit' || text === 'rollback') events.push(text)
    return { rows: [], rowCount: text.startsWith('insert') ? 1 : 0 }
  }) } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(raw, () => owner.assertOwned())
  let passedSql: GraphTransactionSql | undefined
  const callback = vi.fn(async (sql: GraphTransactionSql) => {
    assertGraphTransaction(sql); expect(events).toContain('proof-stored'); events.push('context')
    expect(sql).toBe(passedSql)
    if (reject) throw new Error('context denied')
  })
  const service = new WorkflowNativeProofServices({ read: () => capture }, undefined, callback)
  const validation = service as unknown as { current(): Promise<{ stored: StoredRepeatExecution; scope: RepeatScope }>; physical(): Promise<void> }
  vi.spyOn(validation, 'current').mockResolvedValue({ stored: { execution, ref: { nodeId: 'node', occurrence: null }, inputDigest: 'original-input' } as StoredRepeatExecution,
    scope: { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run', workflowVersionId: 'version', executionSemanticsVersion: 3 } })
  vi.spyOn(validation, 'physical').mockResolvedValue(undefined)
  const persist = () => connection.transaction(sql => {
    passedSql = sql
    return service.persistOriginalLocked(sql, { id: 'run' } as AcceptedWorkflowRunV3, {} as RepeatNativeEvidence, owner)
  })
  return { events, callback, persist }
}
it('admits context after storing the actual proof and before committing its original G1', async () => {
  const f = fixture(); await f.persist()
  expect(f.callback).toHaveBeenCalledOnce()
  expect(f.events).toEqual(['proof-stored', 'context', 'commit'])
})
it('rolls back original proof publication when context admission fails', async () => {
  const f = fixture(true)
  await expect(f.persist()).rejects.toThrow('context denied')
  expect(f.events).toEqual(['proof-stored', 'context', 'rollback'])
})
