import assert from 'node:assert/strict'
import { it } from 'vitest'
import type { HarnessNativeEvent } from '@graphql/contracts'
import type { NativeGraphProjectionKey, RunGraphScope } from '@graphql/contracts/wave25'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { openCodeGraphReconciliation } from '../src/modules/harnesses/opencodeGraphReconciliation.js'
import { OPENCODE_RECONCILIATION_EVENT, openCodeReconciliationPayload } from '../src/modules/harnesses/opencodeReconciliation.js'
import { normalizedHistory } from '../src/modules/harnesses/opencodeProtocol.js'

// This is a focused read-port test, NOT a PostgreSQL transaction, owner-fence,
// coordinator, saver or review-dispatcher qualification.
const session = { harness: 'opencode' as const, providerVersion: '1.18.31', nativeSessionId: 'ses_exact' }
const expected = { ownerAgentId: 'agent', correlationId: 'execution:execution', nativeSessionId: session.nativeSessionId,
  nativeTurnId: 'msg_user', providerVersion: session.providerVersion }
const scope: RunGraphScope = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run',
  workflowVersionId: 'version', executionSemanticsVersion: 3 }
const work: NativeGraphProjectionKey = { execution: { workflowNodeId: 'node', executionId: 'execution',
  agentId: 'agent', agentConfigurationVersionId: 'config', attempt: 1 }, workKind: 'workflow', workId: 'execution' }
function fixture() {
  const source = normalizedHistory([{ info: { id: 'msg_final', sessionID: session.nativeSessionId,
    role: 'assistant', parentID: expected.nativeTurnId, finish: 'stop', time: { created: 10, completed: 20 } }, parts: [] }], false)[0]!
  const payload = openCodeReconciliationPayload(session, expected.ownerAgentId, expected.correlationId,
    expected.nativeTurnId, source, 'succeeded')!
  assert(payload)
  const event: HarnessNativeEvent = { executionId: work.execution.executionId,
    connectionId: 'adapter-stream', sequence: 8, occurredAt: new Date(30).toISOString(), type: OPENCODE_RECONCILIATION_EVENT, payload }
  const rows: { record: HarnessNativeEvent; source_sequence: string }[] = [{
    // SQL storage has its own durable sequence. Qualification MUST restore the
    // separate source_sequence before comparing the truthful history identity.
    record: { ...source, executionId: event.executionId, sequence: 97 }, source_sequence: '0',
  }]
  const calls: unknown[][] = []
  const sql = { query: async (_text: string, parameters: unknown[]) => {
    calls.push(parameters)
    return { rows, rowCount: rows.length }
  } } as unknown as GraphTransactionSql
  return { source, event, rows, sql, calls }
}
it('BR1-002: resolves the durable original history source but attributes the observation to its own source', async () => {
  const f = fixture()
  const observation = await openCodeGraphReconciliation(f.sql, f.event, expected, scope, work, '7')
  assert(observation?.kind === 'terminal')
  assert.equal(observation.submissionId, expected.nativeTurnId)
  assert.equal(observation.connectionGeneration, '7')
  assert.equal(observation.sourcePosition, '8')
  assert.equal(observation.terminal.outcome, 'succeeded')
  assert.equal(observation.terminal.nativeSettled, true)
  assert.deepEqual(f.calls, [[f.event.executionId, f.source.connectionId, 0]])
  assert.equal(f.rows[0]!.record.sequence, 97)
  assert.equal(f.rows[0]!.record.connectionId, f.source.connectionId)
})
for (const cut of ['absent', 'rejected', 'omitted', 'wrong-session', 'wrong-source-position', 'wrong-message'] as const) {
  it(`BR1-002: ${cut} stored history cannot be promoted by a reconciliation marker`, async () => {
    const f = fixture()
    if (cut === 'absent') f.rows.splice(0)
    else if (cut === 'rejected') f.rows[0]!.record = { ...f.rows[0]!.record,
      type: 'graph.native.source_rejected', payload: { normalization: 'br1-002/v1', code: 'GRAPH_EVIDENCE_TOO_LARGE' } }
    else if (cut === 'omitted') f.rows[0]!.record.payload = { payloadOmitted: true }
    else if (cut === 'wrong-source-position') f.rows[0]!.source_sequence = '1'
    else {
      const info = f.rows[0]!.record.payload.info as Record<string, unknown>
      info[cut === 'wrong-session' ? 'sessionID' : 'id'] = 'different'
    }
    assert.equal(await openCodeGraphReconciliation(f.sql, f.event, expected, scope, work, '7'), undefined)
  })
}
it('BR1-002: wrong owner or turn does not even resolve a history source', async () => {
  const f = fixture()
  assert.equal(await openCodeGraphReconciliation(f.sql, f.event, { ...expected, ownerAgentId: 'other' }, scope, work, '7'), undefined)
  assert.equal(await openCodeGraphReconciliation(f.sql, f.event, { ...expected, nativeTurnId: 'other' }, scope, work, '7'), undefined)
  assert.equal(f.calls.length, 0)
})
it('BR1-002: marker execution and work owner must agree before any source lookup', async () => {
  const f = fixture()
  assert.equal(await openCodeGraphReconciliation(f.sql, { ...f.event, executionId: 'foreign-execution' }, expected, scope, work, '7'), undefined)
  assert.equal(await openCodeGraphReconciliation(f.sql, f.event, expected, scope,
    { ...work, execution: { ...work.execution, agentId: 'foreign-owner' } }, '7'), undefined)
  assert.equal(f.calls.length, 0)
})
it('BR1-002: a row with a foreign embedded execution cannot supply terminal provenance', async () => {
  const f = fixture()
  f.rows[0]!.record.executionId = 'foreign-execution'
  assert.equal(await openCodeGraphReconciliation(f.sql, f.event, expected, scope, work, '7'), undefined)
})
