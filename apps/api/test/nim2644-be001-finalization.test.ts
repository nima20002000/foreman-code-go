import assert from 'node:assert/strict'
import { it } from 'vitest'
import type { HarnessExecution, NativeSessionReference } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { finalizeStoppedWorkflowSessions, type ClosedWorkflowSession } from '../src/modules/interactions/stoppedWorkflowFinalization.js'

/** Unit-level transaction double. The separately named integration suite tests
 * actual SQL/locks/Stop/save admission; this file does NOT stand in for that. */
function fixture() {
  const execution: HarnessExecution = { id: 'be001-execution', runId: 'be001-run', workflowNodeId: 'be001-node',
    agentId: 'be001-agent', agentConfigurationVersionId: 'be001-configuration', attempt: 1,
    input: {}, state: 'completed', result: { outcome: 'canceled' }, nativeSessionId: 'be001-native',
    workingDirectory: '/synthetic', runtimeDirectory: '/synthetic/runtime',
    createdAt: '2026-09-24T00:00:00.000Z', finishedAt: '2026-09-24T00:00:01.000Z' }
  const session: NativeSessionReference = { harness: 'codex', providerVersion: 'synthetic-no-native-call', nativeSessionId: execution.nativeSessionId! }
  const state = { terminal: true, outstanding: false, finalized: false, hasBinding: true, owned: true,
    commitCount: 0, updateCount: 0, fenceCount: 0, loseOnLastFence: false, swapOnUpdate: false }
  let proof: ClosedWorkflowSession | undefined = { execution: { ...execution }, session: { ...session } }
  const readClosure = () => proof
  const sql = { async query(text: string, values: unknown[]) {
    if (text.startsWith('select\n')) return { rows: [{ terminal: state.terminal }], rowCount: 1 }
    if (text.startsWith('select id,record')) return { rows: [{ id: execution.id, record: execution }], rowCount: 1 }
    if (text.includes('for update of s')) return { rows: state.hasBinding ? [{ execution_id: execution.id, reference: session, finalized: state.finalized }] : [], rowCount: state.hasBinding ? 1 : 0 }
    if (text.includes('as outstanding')) return { rows: [{ outstanding: state.outstanding }], rowCount: 1 }
    if (text.startsWith('update execution_native_sessions')) {
      assert.equal(values[0], execution.id)
      assert.deepEqual(JSON.parse(values[1] as string), session)
      state.finalized = true; state.updateCount++
      if (state.swapOnUpdate) proof = { execution: { ...execution }, session: { ...session } }
      return { rows: [{ execution_id: execution.id }], rowCount: 1 }
    }
    throw new Error(`Unexpected query: ${text}`)
  } } as unknown as GraphTransactionSql
  const owner = { runId: execution.runId,
    assertOwned() { if (!state.owned) throw new Error('RUN_OWNERSHIP_LOST') },
    async readOneShotFence() {
      state.fenceCount++
      if (state.loseOnLastFence && state.fenceCount === 2) state.owned = false
      if (!state.owned) throw new Error('RUN_OWNERSHIP_LOST')
      return { ownerId: 'synthetic-owner', fence: 'synthetic-fence' }
    },
    oneShotConnection() { return { transaction: async (work: (sql: GraphTransactionSql) => Promise<void>) => {
      const before = state.finalized
      try { await work(sql); state.commitCount++ } catch (error) { state.finalized = before; throw error }
    } } },
  } as unknown as RunOwnership
  return { execution, session, state, owner, readClosure, clearProof: () => { proof = undefined },
    proof: () => proof!, finalize: () => finalizeStoppedWorkflowSessions(execution.runId, owner, readClosure) }
}

it('BE-001 finalizes the exact closed session only after terminal state and all cleanup obligations, idempotently', async () => {
  const f = fixture()
  await f.finalize()
  assert.equal(f.state.finalized, true)
  assert.equal(f.state.commitCount, 1)
  assert.equal(f.state.updateCount, 1)
  f.clearProof() // A durable finalized timestamp does not require a new close.
  await f.finalize()
  assert.equal(f.state.updateCount, 1)
})

it('BE-001 terminal Run/execution and cleanup acceptance never substitute for native closure', async () => {
  const f = fixture(); f.clearProof()
  await assert.rejects(f.finalize(), /exact native closure/)
  assert.equal(f.state.finalized, false); assert.equal(f.state.updateCount, 0)
})

it('BE-001 does not create a missing native binding', async () => {
  const f = fixture(); f.state.hasBinding = false
  await assert.rejects(f.finalize(), /exact native closure/)
  assert.equal(f.state.updateCount, 0)
})

it('BE-001 blocks while Run or execution is nonterminal or resource/review/interaction cleanup is outstanding', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.state.terminal = false },
    (f: ReturnType<typeof fixture>) => { f.execution.state = 'waiting'; delete f.execution.result; delete f.execution.finishedAt },
    (f: ReturnType<typeof fixture>) => { f.state.outstanding = true },
  ]) {
    const f = fixture(); change(f)
    await assert.rejects(f.finalize(), /exact native closure/)
    assert.equal(f.state.updateCount, 0)
  }
})

it('BE-001 rejects changed execution, session, provider, configuration and path identities', async () => {
  for (const change of [
    (p: ClosedWorkflowSession) => { p.execution.runId = 'other-run' },
    (p: ClosedWorkflowSession) => { p.execution.id = 'other-execution' },
    (p: ClosedWorkflowSession) => { p.execution.agentConfigurationVersionId = 'other-configuration' },
    (p: ClosedWorkflowSession) => { p.execution.workingDirectory = '/other' },
    (p: ClosedWorkflowSession) => { p.session.nativeSessionId = 'other-session' },
    (p: ClosedWorkflowSession) => { p.session.providerVersion = 'other-provider-version' },
    (p: ClosedWorkflowSession) => { p.session.harness = 'claude' },
  ]) {
    const f = fixture(); change(f.proof())
    await assert.rejects(f.finalize(), /exact native closure/)
    assert.equal(f.state.finalized, false); assert.equal(f.state.updateCount, 0)
  }
})

it('BE-001 rejects the wrong Run owner before opening a transaction', async () => {
  const f = fixture()
  await assert.rejects(finalizeStoppedWorkflowSessions('another-run', f.owner, f.readClosure), /cannot cross Run identities/)
  assert.equal(f.state.fenceCount, 0); assert.equal(f.state.commitCount, 0)
})

it('BE-001 rolls back when database ownership is lost at the final fence', async () => {
  const f = fixture(); f.state.loseOnLastFence = true
  await assert.rejects(f.finalize(), /RUN_OWNERSHIP_LOST/)
  assert.equal(f.state.finalized, false); assert.equal(f.state.commitCount, 0)
})

it('BE-001 rolls back a close proof invalidated by a late connection generation', async () => {
  const f = fixture(); f.state.swapOnUpdate = true
  await assert.rejects(f.finalize(), /exact native closure/)
  assert.equal(f.state.finalized, false); assert.equal(f.state.commitCount, 0)
})
