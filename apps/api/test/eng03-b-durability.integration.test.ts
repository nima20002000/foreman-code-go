import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema } from '@graphql/contracts'
import { applyRunGraphPageFixture, ExecutableWorkflowV2Schema, makeWave25Fixture } from '@graphql/contracts/wave25'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { createCompactSnapshotAssembler } from '../src/modules/run-graph/compactSnapshot.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { readRunGraphPage, readRunGraphSnapshot } from '../src/modules/run-graph/reader.js'
import { buildOneShotGraph } from '../src/modules/runs/oneShotGraph.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import {
  agent3Database, candidateFor, graphHead, ownedAgent3, postgresEnabled, seedAgent3, terminalAgent3,
  setFixtureVersion,
} from './helpers/wave25Agent3.js'

function fanInFixture() {
  const fixture = makeWave25Fixture(randomUUID())
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
  const version = ExecutableWorkflowV2Schema.parse({ configurations, version: {
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
  return setFixtureVersion(fixture, version)
}

describe.skipIf(!postgresEnabled)('ENG-03 B PostgreSQL duplicate and checkpoint qualification', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  let checkpoints: ReturnType<typeof createCheckpointStore>
  const owners: RunOwnership[] = []
  beforeAll(async () => {
    db = await agent3Database()
    checkpoints = createCheckpointStore(process.env.WAVE25_TEST_DATABASE_URL!, `${db.schema}_checkpoints`)
    await checkpoints.setup()
  }, 60000)
  afterEach(async () => { while (owners.length) await owners.pop()!.release() })
  afterAll(async () => {
    await checkpoints?.close()
    if (db) {
      await db.pool.query(`drop schema if exists ${db.schema}_checkpoints cascade`)
      await db.close()
    }
  })

  it('persists unequal-depth selected inputs in relationship order and keeps the Run open for a slow sibling', async () => {
    const fixture = await seedAgent3(db.pool, db.directory, fanInFixture())
    const { owner, store } = await ownedAgent3(db.pool, fixture); owners.push(owner)
    const authorize = async () => undefined
    const assemble = createCompactSnapshotAssembler(async () => ({ interactions: [], reviews: [] }))
    const snapshot = () => readRunGraphSnapshot(db.pool, { scope: fixture.scope, protocolVersion: 1 }, authorize, assemble)
    const baseline = await snapshot()
    async function admit(nodeId: string) {
      return store.admit(nodeId, () => candidateFor(fixture, nodeId))
    }
    async function finish(nodeId: string, output: unknown) {
      const admission = await admit(nodeId)
      if (admission.kind !== 'admitted') throw new Error(`Expected ${nodeId} to be admitted`)
      await terminalAgent3(db.pool, store, fixture, admission.execution, output)
      await store.acceptTerminal(admission.execution.id)
      return admission.execution
    }
    await finish('entry', { exact: 'entry' })
    await finish('fast', { exact: 'fast' })
    expect(await admit('join')).toEqual({ kind: 'waiting' })
    await expect(store.completeRun()).rejects.toMatchObject({ code: 'WORKFLOW_UNRESOLVED' })
    await finish('slow1', { routing: { outcome: 'selected' }, data: { exact: 'slow1' } })
    expect(await admit('unused')).toMatchObject({ kind: 'resolved', resolution: { resolution: 'skipped' } })
    expect(await admit('join')).toEqual({ kind: 'waiting' })
    const slow = await admit('slow2')
    expect(slow.kind).toBe('admitted')
    expect(await admit('join')).toEqual({ kind: 'waiting' })
    await expect(store.completeRun()).rejects.toMatchObject({ code: 'WORKFLOW_UNRESOLVED' })
    if (slow.kind !== 'admitted') throw new Error('Missing slow execution')
    await terminalAgent3(db.pool, store, fixture, slow.execution, { exact: 'slow2' })
    await store.acceptTerminal(slow.execution.id)
    const join = await admit('join')
    if (join.kind !== 'admitted') throw new Error('Join was not admitted')
    const predecessors = (join.execution.input as { predecessors: Array<{ relationshipId: string; senderExecutionId: string; acceptedResult: unknown }> }).predecessors
    expect(predecessors.map((item) => item.relationshipId)).toEqual(['a-slow2-join', 'z-fast-join'])
    expect(predecessors.map((item) => item.senderExecutionId)).toEqual([
      fixture.identities.find((item) => item.workflowNodeId === 'slow2')!.executionId,
      fixture.identities.find((item) => item.workflowNodeId === 'fast')!.executionId,
    ])
    const bindings = (await db.pool.query<{ record: { relationshipId: string; inputOrdinal: number; acceptedResultDigest: string; recipientInputDigest: string;
      sender: { executionId: string }; recipient: { executionId: string } } }>(
      'select record from run_input_bindings where run_id=$1 order by (record->>\'inputOrdinal\')::int', [fixture.run.id])).rows
      .filter((row) => ['a-slow2-join', 'z-fast-join'].includes(row.record.relationshipId))
    expect(bindings.map((row) => [row.record.relationshipId, row.record.inputOrdinal])).toEqual([
      ['a-slow2-join', 0], ['z-fast-join', 1],
    ])
    for (const [ordinal, row] of bindings.entries()) {
      expect(row.record.sender.executionId).toBe(predecessors[ordinal]!.senderExecutionId)
      expect(row.record.recipient.executionId).toBe(join.execution.id)
      expect(row.record.acceptedResultDigest).toBe(graphSourceDigest(predecessors[ordinal]!.acceptedResult))
      expect(row.record.recipientInputDigest).toBe(graphSourceDigest(join.execution.input))
    }
    expect(await admit('join')).toMatchObject({ kind: 'admitted', reused: true, execution: { id: join.execution.id } })
    await terminalAgent3(db.pool, store, fixture, join.execution, { exact: 'join' })
    await store.acceptTerminal(join.execution.id)
    await store.completeRun()
    expect((await db.pool.query<{ record: { outcome: string } }>('select record from runs where id=$1', [fixture.run.id])).rows[0]!.record.outcome).toBe('succeeded')
    expect((await db.pool.query('select 1 from harness_executions where run_id=$1 and workflow_node_id=$2', [fixture.run.id, 'join'])).rowCount).toBe(1)
    const current = await snapshot()
    let replay = baseline
    for (;;) {
      const page = await readRunGraphPage(db.pool, { scope: fixture.scope, protocolVersion: 1,
        afterSequence: replay.asOfSequence }, authorize)
      const applied = applyRunGraphPageFixture(replay, page, 1, 1)
      expect(applied.kind).toBe('applied')
      replay = applied.snapshot
      if (page.kind === 'page' && !page.hasMore) break
    }
    expect(replay.asOfSequence).toBe(current.asOfSequence)
    expect(replay).toEqual(current)
  })

  it('commits one launch, accepted result, route and exact input under concurrent duplicate calls', async () => {
    const fixture = await seedAgent3(db.pool, db.directory)
    const { owner, store } = await ownedAgent3(db.pool, fixture); owners.push(owner)
    const entryId = fixture.version.entryNodeId
    const candidate = () => candidateFor(fixture, entryId)
    const admissions = await Promise.all([store.admit(entryId, candidate), store.admit(entryId, candidate)])
    expect(admissions.map((item) => item.kind)).toEqual(['admitted', 'admitted'])
    expect(admissions.filter((item) => item.kind === 'admitted' && !item.reused)).toHaveLength(1)
    const execution = admissions[0]!.kind === 'admitted' ? admissions[0]!.execution : undefined
    if (!execution) throw new Error('Missing queued execution')

    const paths = { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/${execution.id}` }
    const launches = await Promise.all([store.claimLaunch(execution.id, paths), store.claimLaunch(execution.id, paths)])
    expect(launches.filter(Boolean)).toHaveLength(1)
    expect(store.consumeLaunchPermit(execution.id)).toBe(true)
    expect(store.consumeLaunchPermit(execution.id)).toBe(false)
    const claimed = launches.find(Boolean)!
    const session = { harness: 'codex' as const, providerVersion: 'synthetic-no-native-call', nativeSessionId: `native-${execution.id}` }
    await new PostgresInteractionCoordinationRepository(db.pool).bindWorkflowSession(execution.id, session)
    await store.updateExecution(HarnessExecutionSchema.parse({ ...claimed, nativeSessionId: session.nativeSessionId,
      state: 'completed', result: { outcome: 'succeeded', output: { exact: 'entry' } }, finishedAt: new Date().toISOString() }))
    const accepted = await Promise.all([store.acceptTerminal(execution.id), store.acceptTerminal(execution.id)])
    expect(accepted[0]).toEqual(accepted[1])
    const head = await graphHead(db.pool, fixture.run.id)
    expect(await store.acceptTerminal(execution.id)).toEqual(accepted[0])
    expect(await graphHead(db.pool, fixture.run.id)).toBe(head)

    const recipientId = fixture.identities[1]!.workflowNodeId
    const receivers = await Promise.all([
      store.admit(recipientId, () => candidateFor(fixture, recipientId)),
      store.admit(recipientId, () => candidateFor(fixture, recipientId)),
    ])
    expect(receivers.filter((item) => item.kind === 'admitted' && !item.reused)).toHaveLength(1)
    const receiver = receivers[0]!.kind === 'admitted' ? receivers[0]!.execution : undefined
    if (!receiver) throw new Error('Missing receiving execution')
    expect((receiver.input as { predecessors: unknown[] }).predecessors).toEqual([{
      relationshipId: fixture.version.definition.edges[0]!.id, senderNodeId: entryId,
      senderExecutionId: execution.id, acceptedResult: { outcome: 'succeeded', output: { exact: 'entry' } },
    }])
    expect((await db.pool.query('select 1 from run_input_bindings where run_id=$1', [fixture.run.id])).rowCount).toBe(1)
    const effects = await db.pool.query<{ effect_kind: string; count: string }>(
      'select effect_kind,count(*)::text as count from run_graph_effects where run_id=$1 group by effect_kind', [fixture.run.id])
    expect(Object.fromEntries(effects.rows.map((row) => [row.effect_kind, Number(row.count)]))).toMatchObject({
      'execution.launch': 1, 'result.accept': 1, 'route.resolve': 1, 'input.bind': 2,
    })
  })

  it('replays a committed result before checkpoint acknowledgement without another native launch, and preserves snapshot/delta parity', async () => {
    const fixture = await seedAgent3(db.pool, db.directory)
    const { owner, store } = await ownedAgent3(db.pool, fixture); owners.push(owner)
    const authorize = async () => undefined
    const assemble = createCompactSnapshotAssembler(async () => ({ interactions: [], reviews: [] }))
    const snapshot = () => readRunGraphSnapshot(db.pool, { scope: fixture.scope, protocolVersion: 1 }, authorize, assemble)
    const baseline = await snapshot()
    const nativeCalls: string[] = []
    const driver = {
      candidate: (nodeId: string) => candidateFor(fixture, nodeId),
      observe: async (execution: ReturnType<typeof candidateFor>) => {
        nativeCalls.push(execution.id)
        await terminalAgent3(db.pool, store, fixture, execution, { exact: execution.workflowNodeId })
      },
    }
    let loseAcknowledgement = true
    const repository = {
      admit: store.admit.bind(store),
      acceptTerminal: async (executionId: string) => {
        const resolution = await store.acceptTerminal(executionId)
        if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error('ENG03_LOST_RESULT_ACK') }
        return resolution
      },
    }
    const input = { runId: fixture.run.id, version: fixture.version, store: repository, driver,
      checkpointer: checkpoints.saver, signal: new AbortController().signal }
    const first = buildOneShotGraph(input)
    await expect(first.graph.invoke({ runId: fixture.run.id, executionIds: {} }, first.config)).rejects.toThrow('ENG03_LOST_RESULT_ACK')
    expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='result.accept'", [fixture.run.id])).rowCount).toBe(1)
    const recovered = buildOneShotGraph(input)
    await recovered.graph.invoke(null, recovered.config)
    expect(nativeCalls).toEqual(fixture.identities.map((item) => item.executionId))
    expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='result.accept'", [fixture.run.id])).rowCount).toBe(2)
    expect((await db.pool.query('select 1 from run_input_bindings where run_id=$1', [fixture.run.id])).rowCount).toBe(1)
    const current = await snapshot()
    const page = await readRunGraphPage(db.pool, { scope: fixture.scope, protocolVersion: 1,
      afterSequence: baseline.asOfSequence }, authorize)
    const replay = applyRunGraphPageFixture(baseline, page, 1, 1)
    expect(replay.kind).toBe('applied')
    expect(replay.snapshot).toEqual(current)
    expect(await graphHead(db.pool, fixture.run.id)).toBe(current.asOfSequence)
  })
})
