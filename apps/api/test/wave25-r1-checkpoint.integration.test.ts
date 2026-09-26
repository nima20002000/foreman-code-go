import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalPostgresSaver } from '../src/infrastructure/approvalCheckpointSaver.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { br1002Response } from './helpers/wave25Br1002OpenCodeRuntime.js'
import { deferred, postgresEnabled } from './helpers/wave25Agent3.js'
import type { DurableInteraction } from '@graphql/contracts'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!(); vi.restoreAllMocks() })
async function fixture() {
  const f = await checkpointRuntimeFixture(); closes.push(f.close)
  await f.engine.start(f.f.run.id)
  const [interaction] = await f.pending()
  if (!interaction) throw new Error('Expected original native request and persisted checkpoint')
  const crash = vi.spyOn(f.engine, 'resumeInteraction').mockRejectedValue(new Error('crash-after-delivery'))
  let delivered: DurableInteraction
  try {
    delivered = (await f.service.respond({ kind: 'user', principal: f.principal }, br1002Response(interaction))).interaction
    expect(delivered.deliveryState).toBe('delivered')
  } finally { crash.mockRestore() }
  expect(await f.receipts()).toEqual([])
  await f.engine.shutdown()
  return { ...f, delivered }
}

describe.skipIf(!postgresEnabled)('BR1-003: actual current checkpoint and Run-owner receipt transaction', () => {
  it('rolls back task-local writes and graph.resume together before commit', async () => {
    const f = await fixture(), before = await f.writes()
    let wrote = false
    class FailBeforeCommit extends ApprovalPostgresSaver {
      override async consumeApprovalInterrupt(sql: GraphTransactionSql, interaction: DurableInteraction) {
        await super.consumeApprovalInterrupt(sql, interaction)
        wrote = true
        throw new Error('injected-before-checkpoint-receipt-commit')
      }
    }
    const failed = f.compose(new FailBeforeCommit(f.db.pool, undefined, { schema: f.db.schema }))
    await expect(failed.engine.resume(f.f.run.id)).rejects.toBeDefined()
    expect(wrote).toBe(true)
    expect(await f.writes()).toEqual(before)
    expect(await f.receipts()).toEqual([])
    expect(f.provider.counts.responses).toBe(1)
    await failed.engine.shutdown()
    await f.compose().engine.resume(f.f.run.id)
    expect(await f.receipts()).toHaveLength(1)
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
  }, 60000)

  it('recovers commit-before-ack without repeating a native response or resume receipt', async () => {
    const f = await fixture()
    const saver = new class extends ApprovalPostgresSaver {
      crashed = false
      override async getTuple(config: Parameters<ApprovalPostgresSaver['getTuple']>[0]) {
        if (!this.crashed && (await f.receipts()).length) {
          this.crashed = true; throw new Error('crash-after-commit-before-dispatch')
        }
        return super.getTuple(config)
      }
    }(f.db.pool, undefined, { schema: f.db.schema })
    const failed = f.compose(saver)
    await expect(failed.engine.resume(f.f.run.id)).rejects.toBeDefined()
    expect(saver.crashed).toBe(true)
    const receipts = await f.receipts()
    expect(receipts).toHaveLength(1)
    await failed.engine.shutdown()
    const next = f.compose()
    await next.engine.resume(f.f.run.id)
    await next.engine.resumeInteraction(f.delivered)
    expect(await f.receipts()).toEqual(receipts)
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
  }, 60000)

  it('excludes a competing Run owner while the real checkpoint consumer is active', async () => {
    const f = await fixture(), entered = deferred(), release = deferred()
    const saver = new class extends ApprovalPostgresSaver {
      override async consumeApprovalInterrupt(sql: GraphTransactionSql, interaction: DurableInteraction) {
        entered.resolve(); await release.promise
        return super.consumeApprovalInterrupt(sql, interaction)
      }
    }(f.db.pool, undefined, { schema: f.db.schema })
    const runtime = f.compose(saver), operation = runtime.engine.resume(f.f.run.id)
    try {
      await Promise.race([entered.promise, operation.then(() => { throw new Error('Missing checkpoint cut') })])
      const competitor = await RunOwnership.acquire(f.db.pool, f.f.run.id, () => undefined)
      try { expect(competitor).toBeUndefined() } finally { await competitor?.release() }
      release.resolve(); await operation
      expect(await f.receipts()).toHaveLength(1)
      expect(f.provider.counts.responses).toBe(1)
    } finally { release.resolve(); await operation.catch(() => undefined) }
  }, 60000)

  it('rejects a stale interrupt without accepting a checkpoint receipt', async () => {
    const f = await fixture(), before = await f.writes()
    const owner = await RunOwnership.acquire(f.db.pool, f.f.run.id, () => undefined)
    if (!owner) throw new Error('Expected exact Run ownership')
    try {
      await expect(owner.oneShotConnection().transaction((sql) => f.saver.consumeApprovalInterrupt(sql,
        { ...f.delivered, graphInterruptId: 'unrelated-interrupt' }))).rejects.toMatchObject({ code: 'GRAPH_INTERRUPT_NOT_CURRENT' })
      expect(await f.writes()).toEqual(before)
      expect(await f.receipts()).toEqual([])
    } finally { await owner.release() }
  }, 60000)
})
