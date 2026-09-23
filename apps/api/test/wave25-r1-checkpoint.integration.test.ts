import { afterEach, describe, expect, it } from 'vitest'
import { Annotation, END, START, StateGraph, interrupt } from '@langchain/langgraph'
import { ApprovalPostgresSaver } from '../src/infrastructure/approvalCheckpointSaver.js'
import { consumeDeliveredApprovals } from '../src/modules/runs/approvalCheckpointResume.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { settleCheckpointFixtureReview } from './helpers/wave25R1CheckpointReview.js'
import { deliveryFixture } from './helpers/wave25ApprovalFixture.js'
import type { DurableInteraction } from '@graphql/contracts'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })
const State = Annotation.Root({ runId: Annotation<string>(), result: Annotation<unknown>() })
async function fixture() {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !url.pathname.toLowerCase().includes('test')) {
    throw new Error('Use a loopback PostgreSQL database explicitly named for tests')
  }
  const f = await approvalDatabase({ runThread: true }); closes.push(f.close)
  const schema = (await f.pool.query<{ name: string }>('select current_schema() as name')).rows[0]!.name
  const saver = new ApprovalPostgresSaver(f.pool, undefined, { schema })
  await saver.setup()
  let resumedNodes = 0, responseCalls = 0
  // A real LangGraph interrupt persisted by the SAME PostgresSaver used in
  // production. The node is deterministic; no native provider is launched.
  const compile = (checkpointer: ApprovalPostgresSaver) => new StateGraph(State).addNode('approval', () => {
    const result: unknown = interrupt({ interactionId: f.interaction.id, interactionIds: [f.interaction.id] })
    resumedNodes++
    return { result }
  }).addEdge(START, 'approval').addEdge('approval', END).compile({ checkpointer })
  const graph = compile(saver)
  const config = { configurable: { thread_id: f.run.id } }
  await graph.invoke({ runId: f.run.id }, config)
  const snapshot = await graph.getState(config)
  const interruptId = snapshot.tasks.flatMap((task) => task.interrupts ?? [])[0]?.id
  if (!interruptId) throw new Error('Expected the real persisted interrupt identity')
  const bound = await f.repository.bindGraphInterrupt(f.interaction.id, interruptId)
  await f.repository.decide({ id: bound.id, optionId: 'approve-once', expectedRevision: bound.revision,
    principal: f.principal, nativeResponse: { optionId: 'approve-once', semantic: 'approve_once' } })
  // Review evidence is an explicitly synthetic upstream fixture, not BR1-002 qualification.
  await settleCheckpointFixtureReview(f)
  const delivery = await f.repository.delivery.claim(bound.id, 'checkpoint-test-delivery')
  if (!delivery) throw new Error('Expected delivery ownership')
  const delivered = await f.repository.delivery.finish(delivery, async () => {
    responseCalls++
    return { state: 'delivered', evidence: deliveryFixture().proof }
  })
  const owner = await RunOwnership.acquire(f.pool, f.run.id, () => undefined)
  if (!owner) throw new Error('Expected the real Run owner')
  closes.push(() => owner.release())
  const writes = async () => (await saver.getTuple(config))?.pendingWrites
  const receipts = async () => (await f.pool.query(`select effect_digest,first_sequence::text from run_graph_effects
    where run_id=$1 and effect_kind='graph.resume' order by entity_id`, [f.run.id])).rows
  return { ...f, schema, saver, graph, compile, config, owner, delivered, writes, receipts,
    resumedNodes: () => resumedNodes, responseCalls: () => responseCalls }
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('BR1-003: actual Postgres checkpoint and Run-owner receipt transaction', () => {
  it('rolls back task-local checkpoint writes and graph.resume together before commit', async () => {
    const f = await fixture(), before = await f.writes(), head = await f.receipts()
    let wroteBeforeFailure = false
    class FailBeforeCommit extends ApprovalPostgresSaver {
      override async consumeApprovalInterrupt(sql: GraphTransactionSql, interaction: DurableInteraction) {
        await super.consumeApprovalInterrupt(sql, interaction)
        wroteBeforeFailure = true
        throw new Error('injected-before-checkpoint-receipt-commit')
      }
    }
    const claim = await f.repository.delivery.claimAtomicGraphResume(f.delivered.id, 'rollback-owner')
    expect(claim).toBeDefined()
    await expect(consumeDeliveredApprovals(f.owner, new FailBeforeCommit(f.pool, undefined, { schema: f.schema }),
      f.repository, [f.delivered], claim)).rejects.toMatchObject({ code: 'GRAPH_INVALID_FACT' })
    // RunGraphPublication deliberately sanitizes arbitrary mutate-callback errors.
    expect(wroteBeforeFailure).toBe(true)
    expect(await f.writes()).toEqual(before)
    expect(await f.receipts()).toEqual(head)
    expect(f.resumedNodes()).toBe(0)
    expect(f.responseCalls()).toBe(1)
    expect(await consumeDeliveredApprovals(f.owner, f.saver, f.repository, [f.delivered], claim)).toBe(true)
    expect(await f.receipts()).toHaveLength(1)
    await f.graph.invoke(null, f.config)
    expect(f.resumedNodes()).toBe(1)
  }, 60000)

  it('recovers commit-before-ack and repeated delivery without repeating a response or checkpoint write', async () => {
    const f = await fixture()
    expect(await consumeDeliveredApprovals(f.owner, f.saver, f.repository, [f.delivered])).toBe(true)
    const committed = await f.writes(), receipts = await f.receipts()
    expect(receipts).toHaveLength(1)
    expect(f.resumedNodes()).toBe(0) // the atomic consumer never invoked the graph
    await f.owner.release()
    closes.pop() // released owner; successor owns the cleanup slot below
    const successor = await RunOwnership.acquire(f.pool, f.run.id, () => undefined)
    if (!successor) throw new Error('Expected independent successor ownership')
    closes.push(() => successor.release())
    for (let n = 0; n < 3; n++) {
      expect(await consumeDeliveredApprovals(successor, f.saver, f.repository, [f.delivered])).toBe(true)
      expect(await f.writes()).toEqual(committed)
      expect(await f.receipts()).toEqual(receipts)
    }
    // A new graph instance reads persisted task-local values after restart.
    const recoveredGraph = f.compile(new ApprovalPostgresSaver(f.pool, undefined, { schema: f.schema }))
    const resumed = await recoveredGraph.invoke(null, f.config)
    expect(resumed.result).toEqual({ interactionId: f.delivered.id })
    expect(f.resumedNodes()).toBe(1)
    expect(f.responseCalls()).toBe(1)
    expect((await f.pool.query('select state from interaction_graph_resumes where interaction_id=$1', [f.delivered.id])).rows[0].state).toBe('resumed')
  }, 60000)

  it('independent competing Run owners cannot both consume the checkpoint', async () => {
    const f = await fixture()
    const competitor = await RunOwnership.acquire(f.pool, f.run.id, () => undefined)
    try { expect(competitor).toBeUndefined() } finally { await competitor?.release() }
    expect(await f.receipts()).toHaveLength(0)
    await consumeDeliveredApprovals(f.owner, f.saver, f.repository, [f.delivered])
    await expect(consumeDeliveredApprovals(f.owner, f.saver, f.repository, [{ ...f.delivered, runId: 'different-run' }]))
      .rejects.toMatchObject({ code: 'GRAPH_INTERRUPT_INVALID' })
    expect(await f.receipts()).toHaveLength(1)
    expect(f.responseCalls()).toBe(1)
  }, 60000)

  it('rejects an absent/stale interrupt without accepting a synthetic checkpoint receipt', async () => {
    const f = await fixture(), before = await f.writes()
    const badSaver = new ApprovalPostgresSaver(f.pool, undefined, { schema: f.schema })
    await expect(f.owner.oneShotConnection().transaction((sql) => badSaver.consumeApprovalInterrupt(sql,
      { ...f.delivered, graphInterruptId: 'unrelated-interrupt' }))).rejects.toMatchObject({ code: 'GRAPH_INTERRUPT_NOT_CURRENT' })
    expect(await f.writes()).toEqual(before)
    expect(await f.receipts()).toHaveLength(0)
  }, 60000)
})
