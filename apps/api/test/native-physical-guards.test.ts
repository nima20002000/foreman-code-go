import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { ExclusiveGraphConnection, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import * as receipts from '../src/modules/run-graph/repeatReceipts.js'
import * as entry from '../src/modules/runs/workflowNativeEntry.js'
import { WorkflowNativeProofServices } from '../src/modules/runs/workflowNativeProof.js'
import type { StoredRepeatExecution } from '../src/modules/runs/repeatPostgres.js'
import type { WorkflowNativeCapture } from '../src/modules/interactions/workflowNativeCapture.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import type { RepeatScope } from '../src/modules/runs/repeatResolution.js'
import { nativeProofModel } from './eng04-native-proof-model.js'

afterEach(() => vi.restoreAllMocks())

// Scripted guard records only: no claim of real SQL or native-process proof.
function fixture() {
  const { execution, session } = nativeProofModel()
  const owner = { runId: execution.runId, assertOwned() {} } as RunOwnership
  const scope = { workspaceId: 'workspace-proof-1', workflowId: 'workflow-proof-1', runId: execution.runId,
    workflowVersionId: 'version-proof-1', executionSemanticsVersion: 3 as const }
  const stored = { execution, ref: { nodeId: execution.workflowNodeId, occurrence: null },
    inputDigest: `sha256:${'1'.repeat(64)}` } as StoredRepeatExecution
  const capture = { execution, session, owner, source: { type: 'history' }, closureGeneration: '1',
    lane: { id: 'original-lane', token: 'original-token', connectionGeneration: 1, providerId: 'original-turn' },
    assertCurrent() {} } as unknown as WorkflowNativeCapture
  vi.spyOn(entry, 'readWorkflowNativeEntryLocked').mockResolvedValue({ phase: 'entered', transition: { phase: 'entered' },
    source_id: 'original-source', source_digest: 'original-digest' } as Awaited<ReturnType<typeof entry.readWorkflowNativeEntryLocked>>)
  vi.spyOn(receipts, 'assertRepeatCanonicalReceiptLocked').mockResolvedValue(undefined)
  const records = { session: { reference: structuredClone(session) }, configuration: { harness: session.harness },
    closure: { generation: '1', expected_reference: structuredClone(session), closed: false },
    lane: { owner_agent_id: execution.agentId, harness: session.harness, native_session_id: session.nativeSessionId,
      generation: '1', token: 'original-token', correlation: `execution:${execution.id}`, provider_id: 'original-turn', held: true } }
  const reads: unknown[][] = []
  const connection = new ExclusiveGraphConnection({ query: async (sql: string, values?: unknown[]) => {
    if (sql.startsWith('with current_session')) { reads.push(values!); return { rows: [structuredClone(records)], rowCount: 1 } }
    if (sql.startsWith('begin') || ['commit', 'rollback'].includes(sql)) return { rows: [], rowCount: 0 }
    throw new Error(`Unexpected guard SQL: ${sql}`)
  } } as unknown as pg.ClientBase, () => owner.assertOwned())
  const additional = vi.fn(async () => undefined)
  const service = new WorkflowNativeProofServices({ read: () => capture }, additional)
  const guarded = service as unknown as { physical(sql: GraphTransactionSql, scope: RepeatScope,
    stored: StoredRepeatExecution, capture: WorkflowNativeCapture, owner: RunOwnership): Promise<void> }
  const check = (sql: GraphTransactionSql) => guarded.physical(sql, scope, stored, capture, owner)
  return { records, connection, check, reads, additional }
}

for (const field of ['session', 'configuration', 'closure', 'generation', 'token', 'agent', 'turn', 'expiry'] as const) {
  it(`still rejects replaced physical ${field}`, async () => {
    const f = fixture()
    if (field === 'session') f.records.session.reference.nativeSessionId = 'different-session'
    if (field === 'configuration') f.records.configuration.harness = 'opencode'
    if (field === 'closure') f.records.closure.closed = true
    if (field === 'generation') f.records.lane.generation = '2'
    if (field === 'token') f.records.lane.token = 'different-token'
    if (field === 'agent') f.records.lane.owner_agent_id = 'different-agent'
    if (field === 'turn') f.records.lane.provider_id = 'different-turn'
    if (field === 'expiry') f.records.lane.held = false
    await expect(f.connection.transaction(f.check)).rejects.toMatchObject({ code: expect.any(String) })
  })
}

it('reads every physical field afresh, including expiry and additional guards, at the next boundary', async () => {
  const f = fixture()
  await expect(f.connection.transaction(async (sql) => {
    await f.check(sql)
    f.records.lane.held = false
    await f.check(sql)
  })).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
  expect(f.reads).toHaveLength(2)
  expect(f.reads[0]).toEqual(f.reads[1])
  expect(f.additional).toHaveBeenCalledTimes(2)
})
