import { agentWorkflowVersion } from './helpers/agentWorkflowFixture.js'
import { randomUUID } from 'node:crypto'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reduceRepeatGraphPageV3, makeCurrentWorkflowFixture, ExecutableWorkflowV3Schema } from '@foreman-code/contracts/wave25'
import { readRepeatGraphPage, readRepeatGraphSnapshot } from '../src/modules/run-graph/repeatReader.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { graphHead, postgresEnabled } from './helpers/wave25Agent3.js'
import { ApprovalTransportFaults } from './helpers/eng06ApprovalFaults.js'

function fanInFixture() {
  const fixture = makeCurrentWorkflowFixture(randomUUID())
  const names = ['entry', 'fast', 'slow1', 'slow2', 'unused', 'join']
  const configurations = names.map((name) => AgentConfigurationVersionSchema.parse({
    ...fixture.configurations[0]!, id: `cfg-${fixture.run.id}-${name}`, agentId: `agent-${fixture.run.id}-${name}`,
  }))
  const agent = (name: string) => configurations[names.indexOf(name)]!.agentId
  const edges = [
    { id: 'entry-fast', kind: 'execution' as const, source: 'entry', target: 'fast' },
    { id: 'entry-slow1', kind: 'execution' as const, source: 'entry', target: 'slow1' },
    { id: 'slow1-slow2', kind: 'execution' as const, source: 'slow1', target: 'slow2' },
    { id: 'slow1-unused', kind: 'execution' as const, source: 'slow1', target: 'unused' },
    { id: 'z-fast-join', kind: 'execution' as const, source: 'fast', target: 'join' },
    { id: 'm-unused-join', kind: 'execution' as const, source: 'unused', target: 'join' },
    { id: 'a-slow2-join', kind: 'execution' as const, source: 'slow2', target: 'join' },
  ]
  const version = ExecutableWorkflowV3Schema.parse({ configurations, version: {
    ...fixture.version, entryNodeId: 'entry',
    agentConfigurationVersionIds: Object.fromEntries(configurations.map((item) => [item.agentId, item.id])),
    definition: { ...fixture.version.definition, entryNodeId: 'entry',
      executionPolicy: { maxParallelism: 2, maxNodeExecutions: names.length },
      nodes: names.map((name) => ({ id: name, agentId: agent(name), name,
        ...(name === 'slow1' ? { choice: { outcomes: [
          { outcome: 'selected', target: { kind: 'edge', relationshipId: 'slow1-slow2' } },
          { outcome: 'unused', target: { kind: 'edge', relationshipId: 'slow1-unused' } },
        ] } } : {}),
      })), edges,
    },
  } }).version
  fixture.configurations = configurations
  fixture.identities = names.map((name) => ({ workflowNodeId: name, executionId: `exec-${fixture.run.id}-${name}`,
    agentId: agent(name), agentConfigurationVersionId: configurations[names.indexOf(name)]!.id, attempt: 1 }))
  fixture.version = agentWorkflowVersion(version)
  return fixture
}

/** ENG-03 durability assertions now run through the current V3 engine and real
 * private native captures. The provider is deterministic, not a live binary. */
describe.skipIf(!postgresEnabled)('Current workflow result and checkpoint durability', () => {
  describe('six-node routing fixture', () => {
    let t: Awaited<ReturnType<typeof checkpointRuntimeFixture>>
    beforeEach(async () => {
      t = await checkpointRuntimeFixture(1, 1, { fixture: fanInFixture(), approvalNodeIds: ['slow2'],
        outputFor: (node) => node === 'slow1' ? { routing: { outcome: 'selected' }, data: { exact: node } } : { exact: node } })
    })
    afterEach(async () => { await t?.close() })
    it('persists six-node unequal-depth selected inputs in relationship order and keeps the slow sibling open', async () => {
      const snapshot = () => readRepeatGraphSnapshot(t.db.pool, { scope: t.f.scope, protocolVersion: 1 }, async () => undefined)
      const baseline = await snapshot()
      await t.engine.start(t.f.run.id)
      const pending = await t.pending(); expect(pending).toHaveLength(1)
      expect((await t.runs.get(t.f.run.id))?.outcome).toBe('pending')
      expect((await t.db.pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2', [t.f.run.id, 'join'])).rowCount).toBe(0)
      const fast = (await t.db.pool.query<{ accepted: boolean }>('select accepted from harness_executions where run_id=$1 and workflow_node_id=$2', [t.f.run.id, 'fast'])).rows[0]
      expect(fast?.accepted).toBe(true)
      await t.service.respond({ kind: 'user', principal: t.principal }, approvalResponse(pending[0]!))
      expect((await t.runs.get(t.f.run.id))?.outcome).toBe('succeeded')
      const joinRows = await t.db.pool.query<{ record: { id: string; input: { predecessors: Array<{ relationshipId: string; execution: { executionId: string }; acceptedResult: unknown }> } } }>(
        'select record from harness_executions where run_id=$1 and workflow_node_id=$2', [t.f.run.id, 'join'])
      expect(joinRows.rowCount).toBe(1)
      const join = joinRows.rows[0]!.record, predecessors = join.input.predecessors
      expect(predecessors.map((item) => item.relationshipId)).toEqual(['a-slow2-join', 'z-fast-join'])
      const bindings = (await snapshot()).state.inputBindings
        .filter((row) => ['a-slow2-join', 'z-fast-join'].includes(row.relationshipId))
        .sort((a, b) => a.inputOrdinal - b.inputOrdinal)
      expect(bindings.map((row) => [row.relationshipId, row.inputOrdinal])).toEqual([['a-slow2-join', 0], ['z-fast-join', 1]])
      for (const [ordinal, row] of bindings.entries()) {
        expect(row.sender.executionId).toBe(predecessors[ordinal]!.execution.executionId)
        expect(row.recipient.executionId).toBe(join.id)
        expect(row.acceptedResultDigest).toBe(graphSourceDigest(predecessors[ordinal]!.acceptedResult))
        expect(row.recipientInputDigest).toBe(graphSourceDigest(join.input))
      }
      expect(t.provider.startedNodes).not.toContain('unused')
      expect(t.provider.counts.starts).toBe(5)
      const current = await snapshot()
      let replay = baseline
      for (;;) {
        const page = await readRepeatGraphPage(t.db.pool, { scope: t.f.scope, protocolVersion: 1, afterSequence: replay.asOfSequence }, async () => undefined)
        if (page.kind !== 'page') throw new Error('Unexpected graph reset')
        replay = reduceRepeatGraphPageV3(replay, page)
        if (page.kind === 'page' && !page.hasMore) break
      }
      expect(replay).toEqual(current)
      expect(await graphHead(t.db.pool, t.f.run.id)).toBe(current.asOfSequence)
    }, 60000)
  })
  it('a cold engine closes the waiting native lifetime without replaying the completed predecessor', async () => {
    const faults = new ApprovalTransportFaults()
    const t = await checkpointRuntimeFixture(1, 1, {
      recoverNativeProcesses: (executionId, signal) => faults.recoverNativeProcesses(executionId, signal),
    })
    const connection = t.provider.connection.bind(t.provider)
    vi.spyOn(t.provider, 'connection').mockImplementation(() => faults.wrap(connection()))
    try {
      await t.engine.start(t.f.run.id)
      const pending = (await t.pending())[0]!
      const before = { ...t.provider.counts }
      const acceptedBefore = (await t.db.pool.query<{ count: string }>(
        "select count(*)::text as count from run_graph_effects where run_id=$1 and effect_kind='result.accept'",
        [t.f.run.id])).rows[0]!.count
      faults.killOnRestart = true
      await t.engine.shutdown()
      const recovered = t.compose()
      await recovered.engine.resume(t.f.run.id)
      expect(t.provider.counts.starts).toBe(before.starts)
      expect(t.provider.counts.sessions).toBe(before.sessions)
      expect(t.provider.closedSessions.has(pending.nativeSessionId)).toBe(true)
      expect((await t.db.pool.query<{ count: string }>(
        "select count(*)::text as count from run_graph_effects where run_id=$1 and effect_kind='result.accept'",
        [t.f.run.id])).rows[0]!.count).toBe(acceptedBefore)
      expect(await recovered.runs.get(t.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'failed' })
      expect((await recovered.repository.get(pending.id))?.status).toBe('canceled')
      expect(t.provider.counts.responses).toBe(0)
    } finally { await t.close() }
  }, 60000)
  it('a committed result survives a lost acceptance acknowledgement without another native launch', async () => {
    const t = await checkpointRuntimeFixture()
    try {
      const factory = t.runs.repeatRepositoryFactory(), original = factory.forOwner.bind(factory)
      let lose = true
      const hook = vi.spyOn(factory, 'forOwner').mockImplementation((...args) => {
        const store = original(...args), accept = store.acceptTerminal.bind(store)
        if (!vi.isMockFunction(store.acceptTerminal)) vi.spyOn(store, 'acceptTerminal').mockImplementation(async (...input) => {
          const result = await accept(...input)
          if (lose) { lose = false; throw new Error('ENG03_LOST_RESULT_ACK') }
          return result
        })
        return store
      })
      await expect(t.engine.start(t.f.run.id)).rejects.toThrow('ENG03_LOST_RESULT_ACK')
      expect((await t.db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='result.accept'", [t.f.run.id])).rowCount).toBe(1)
      hook.mockRestore()
      await t.engine.resume(t.f.run.id)
      await t.service.respond({ kind: 'user', principal: t.principal }, approvalResponse((await t.pending())[0]!))
      expect(t.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
      expect((await t.runs.get(t.f.run.id))?.outcome).toBe('succeeded')
      expect((await t.db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='result.accept'", [t.f.run.id])).rowCount).toBe(2)
    } finally { vi.restoreAllMocks(); await t.close() }
  }, 60000)
})
