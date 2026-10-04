import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DurableInteraction } from '@foreman-code/contracts'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { deferred, postgresEnabled } from './helpers/wave25Agent3.js'

type Fixture = Awaited<ReturnType<typeof checkpointRuntimeFixture>>
const fixtures: Fixture[] = []
afterEach(async () => {
  try { while (fixtures.length) await fixtures.pop()!.close() } finally { vi.restoreAllMocks() }
})
async function fixture(branches: 1 | 2 = 1, pendingPerExecution: 1 | 2 = 1) {
  const original = { closedSessions: new Set<string>() }
  const f = await checkpointRuntimeFixture(branches, pendingPerExecution, {
    // The deterministic provider records the original manager's physical
    // close during shutdown; cold recovery may use only that exact receipt.
    recoverNativeProcesses: async (executionId, signal) => {
      signal.throwIfAborted()
      return original.closedSessions.has(`native-${executionId}`)
    },
  })
  original.closedSessions = f.provider.closedSessions
  fixtures.push(f)
  return f
}
function response(interaction: DurableInteraction) {
  const option = interaction.responseOptions.find((item) => item.semantic === 'approve_once')
  if (!option) throw new Error('Missing native approve-once option')
  return { interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision }
}
async function expireAbandonedClaims(f: Fixture) {
  // Test-only clock advancement after a crashed consumer; do not sleep through
  // the production TTL and do not change the token/fence/state being tested.
  await f.db.pool.query(`update interaction_graph_resumes set lease_expires_at=clock_timestamp()-interval '1 microsecond'
    where run_id=$1 and state='resuming'`, [f.f.run.id])
}
async function restart(f: Fixture) {
  // Shutdown records the original manager's native closure before the new
  // composition acquires Run ownership.
  await f.engine.shutdown()
  return f.compose()
}
async function recover(f: Fixture) {
  await f.engine.resume(f.f.run.id)
}

async function stageDelivered(f: Fixture) {
  // Crash the registered callback, not the delivery/helper implementation.
  // Both native decisions are delivered via the real service/coordinator first.
  const crash = vi.spyOn(f.engine, 'resumeInteraction').mockRejectedValue(new Error('crash-after-delivery-before-consume'))
  try {
    for (const interaction of await f.pending()) {
      const result = await f.service.respond({ kind: 'user', principal: f.principal }, response(interaction))
      expect(result.interaction.deliveryState).toBe('delivered')
    }
  } finally { crash.mockRestore() }
  expect(await f.receipts()).toEqual([])
}
async function checkpointCut(f: Fixture) {
  const tuple = await f.saver.getTuple(f.config)
  if (!tuple) throw new Error('Expected an actual persisted checkpoint')
  return { config: tuple.config, pendingWrites: tuple.pendingWrites }
}

function crashAfterCommitSaver(f: Fixture) {
  const getTuple = f.saver.getTuple.bind(f.saver)
  let crashed = false
  const spy = vi.spyOn(f.saver, 'getTuple').mockImplementation(async (config) => {
    if (!crashed && (await f.receipts()).length) {
      crashed = true
      throw new Error('crash-after-commit-before-graph-dispatch')
    }
    return getTuple(config)
  })
  return { get crashed() { return crashed }, restore: () => spy.mockRestore() }
}

describe.skipIf(!postgresEnabled)('BR1-003 production-composed approval/checkpoint recovery', () => {
  it('normal service response uses production registration, actual saver and one native delivery', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id)
    const [interaction] = await f.pending()
    expect(interaction?.graphInterruptId).toBeTruthy()
    expect(f.provider.counts.starts).toBe(2)
    // Native dispatch is outside the resume transaction. An independent writer
    // can take the same parent lock while the provider responds.
    f.provider.beforeRespond = async () => {
      const client = await f.db.pool.connect()
      try {
        await client.query('begin')
        await client.query('select id from runs where id=$1 for no key update nowait', [f.f.run.id])
      } finally { await client.query('rollback'); client.release() }
    }
    const result = await f.service.respond({ kind: 'user', principal: f.principal }, response(interaction!))
    expect(result.interaction.deliveryState).toBe('delivered')
    expect(await f.receipts()).toHaveLength(1)
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
    // Repeated late engine delivery notifications cannot submit another response.
    for (let n = 0; n < 3; n++) await f.engine.resumeInteraction(result.interaction)
    expect(await f.receipts()).toHaveLength(1)
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
  }, 60000)

  it('repeated service delivery/decision requests do not repeat an already acknowledged native response', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id)
    const [interaction] = await f.pending(), input = response(interaction!)
    const crash = vi.spyOn(f.engine, 'resumeInteraction').mockRejectedValue(new Error('crash-before-consume'))
    try {
      for (let n = 0; n < 4; n++) {
        const result = await f.service.respond({ kind: 'user', principal: f.principal }, input)
        expect(result.interaction.deliveryState).toBe('delivered')
        expect(result.replayed).toBe(n > 0)
      }
      expect(f.provider.counts.responses).toBe(1)
      expect(await f.receipts()).toEqual([])
    } finally { crash.mockRestore() }
    await f.engine.resume(f.f.run.id)
    expect(await f.receipts()).toHaveLength(1)
    expect(f.provider.counts.responses).toBe(1)
  }, 60000)

  it('a cold restart closes the delivered native lifetime and cannot create a graph receipt', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id)
    await stageDelivered(f)
    const [interaction] = await f.pending(), cut = await checkpointCut(f)
    const before = { ...f.provider.counts }
    const successor = await restart(f)
    expect(f.provider.closedSessions.has(interaction!.nativeSessionId)).toBe(true)
    await successor.engine.resume(f.f.run.id)
    expect(await f.receipts()).toEqual([])
    expect((await f.saver.getTuple(cut.config))?.pendingWrites).toEqual(cut.pendingWrites)
    expect(f.provider.counts).toMatchObject({ sessions: before.sessions, starts: before.starts, responses: 1 })
    expect((await successor.runs.get(f.f.run.id))?.outcome).toBe('failed')
    expect((await successor.repository.get(interaction!.id))?.status).toBe('canceled')
  }, 60000)

  it('rolls back real task writes, outbox completion and receipt when the SQL consumer fails', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id)
    await stageDelivered(f)
    const cut = await checkpointCut(f)
    const consume = f.saver.consumeApprovalInterrupt.bind(f.saver)
    let writes = 0
    const failure = vi.spyOn(f.saver, 'consumeApprovalInterrupt').mockImplementation(async (sql, interaction) => {
      await consume(sql, interaction)
      writes++
      throw new Error('rollback-real-checkpoint')
    })
    const errors: unknown[] = []
    await f.engine.resume(f.f.run.id).catch((error: unknown) => errors.push(error))
    expect(errors).toHaveLength(1)
    expect(writes).toBe(1)
    expect(errors[0]).toMatchObject({ code: 'GRAPH_INVALID_FACT' }) // Publication sanitizes callback errors.
    expect((await f.saver.getTuple(cut.config))?.pendingWrites).toEqual(cut.pendingWrites)
    expect(await f.receipts()).toEqual([])
    expect((await f.db.pool.query("select state from interaction_graph_resumes where run_id=$1", [f.f.run.id])).rows)
      .not.toContainEqual({ state: 'resumed' })
    expect(f.provider.counts.responses).toBe(1)
    failure.mockRestore()
    await expireAbandonedClaims(f)
    await f.engine.resume(f.f.run.id)
    expect(await f.receipts()).toHaveLength(1)
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
  }, 60000)

  it('retries after COMMIT before graph acknowledgement, without another native response or resume value', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id)
    const cut = await checkpointCut(f)
    const failingSaver = crashAfterCommitSaver(f)
    const [interaction] = await f.pending()
    const result = await f.service.respond({ kind: 'user', principal: f.principal }, response(interaction!))
    expect(result.interaction.deliveryState).toBe('delivered')
    expect(failingSaver.crashed).toBe(true)
    const receipts = await f.receipts()
    const committed = (await f.saver.getTuple(cut.config))?.pendingWrites
    expect(receipts).toHaveLength(1)
    expect(committed?.filter((write) => write[1] === '__resume__')).toHaveLength(1)
    expect((await f.db.pool.query('select state,approval_native_ack_id from interaction_graph_resumes where interaction_id=$1', [interaction!.id])).rows[0])
      .toEqual({ state: 'resumed', approval_native_ack_id: null })
    failingSaver.restore()
    await f.engine.resume(f.f.run.id)
    for (let n = 0; n < 3; n++) await f.engine.resumeInteraction(result.interaction)
    expect(await f.receipts()).toEqual(receipts)
    expect((await f.saver.getTuple(cut.config))?.pendingWrites?.filter((write) => write[1] === '__resume__'))
      .toEqual(committed?.filter((write) => write[1] === '__resume__'))
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
  }, 60000)

  it.each(['stop', 'revoked_authority', 'closed_execution'] as const)(
    'a committed receipt is not continuation authority after %s', async (race) => {
      const f = await fixture()
      await f.engine.start(f.f.run.id)
      const cut = await checkpointCut(f), saver = crashAfterCommitSaver(f)
      const [interaction] = await f.pending()
      const result = await f.service.respond({ kind: 'user', principal: f.principal }, response(interaction!))
      expect(saver.crashed).toBe(true)
      const receipts = await f.receipts(), committed = (await f.saver.getTuple(cut.config))?.pendingWrites
      expect(receipts).toHaveLength(1)
      if (race === 'stop') await f.stop()
      if (race === 'revoked_authority') await f.db.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [f.authorizationPrincipalId])
      if (race === 'closed_execution') await f.db.pool.query('update harness_executions set worker_credentials_closed_at=clock_timestamp() where id=$1', [interaction!.executionId])
      saver.restore()
      const observe = vi.spyOn(f.native, 'observeExact')
      if (race === 'stop') await f.engine.resumeInteraction(result.interaction)
      else await expect(f.engine.resumeInteraction(result.interaction)).rejects.toMatchObject({
        code: race === 'revoked_authority' ? 'RUN_AUTHORIZATION_REVOKED' : 'EXECUTION_STOPPED',
      })
      expect(observe).not.toHaveBeenCalled()
      expect(await f.receipts()).toEqual(receipts)
      expect((await f.saver.getTuple(cut.config))?.pendingWrites).toEqual(committed)
      expect(f.provider.counts.responses).toBe(1)
    }, 60000)

  it.each(['lease_expiry', 'stop', 'revoked_authority', 'closed_execution'] as const)(
    '%s while the service resume is queued cannot commit a checkpoint or repeat delivery', async (race) => {
      const f = await fixture(), waiting = deferred(), release = deferred(), queued = deferred()
      const update = f.runs.updateState.bind(f.runs), resume = f.engine.resumeInteraction.bind(f.engine)
      let gated = false
      const stateSpy = vi.spyOn(f.runs, 'updateState').mockImplementation(async (...args) => {
        const result = await update(...args)
        if (!gated && args[1].executionState === 'waiting') {
          gated = true; waiting.resolve(); await release.promise
        }
        return result
      })
      const resumeSpy = vi.spyOn(f.engine, 'resumeInteraction').mockImplementation((...args) => {
        queued.resolve()
        return resume(...args) // Actual queueResume waits behind the start task.
      })
      const starting = f.engine.start(f.f.run.id)
      const startResult = starting.catch((error: unknown) => error)
      let responseResult: Promise<unknown> | undefined
      try {
        await Promise.race([waiting.promise, starting])
        const [interaction] = await f.pending(), cut = await checkpointCut(f)
        responseResult = f.service.respond({ kind: 'user', principal: f.principal }, response(interaction!)).catch((error: unknown) => error)
        await Promise.race([queued.promise, responseResult])
        expect((await f.db.pool.query('select state from interaction_graph_resumes where interaction_id=$1', [interaction!.id])).rows[0])
          .toEqual({ state: 'resuming' })
        if (race === 'lease_expiry') await expireAbandonedClaims(f)
        if (race === 'stop') await f.stop()
        if (race === 'revoked_authority') await f.db.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1', [f.authorizationPrincipalId])
        if (race === 'closed_execution') await f.db.pool.query('update harness_executions set worker_credentials_closed_at=clock_timestamp() where id=$1', [interaction!.executionId])
        release.resolve()
        await startResult; await responseResult
        expect(await f.receipts()).toEqual([])
        expect((await f.saver.getTuple(cut.config))?.pendingWrites).toEqual(cut.pendingWrites)
        expect(f.provider.counts.responses).toBe(1)
        if (race === 'lease_expiry') {
          await recover(f)
          expect(await f.receipts()).toHaveLength(1)
          expect(f.provider.counts.responses).toBe(1)
        }
      } finally {
        release.resolve()
        await startResult; await responseResult
        stateSpy.mockRestore(); resumeSpy.mockRestore()
      }
    }, 60000)

  it('independent competing engine owners cannot consume one delivered checkpoint twice', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id); await stageDelivered(f)
    const held = await RunOwnership.acquire(f.db.pool, f.f.run.id, () => undefined)
    if (!held) throw new Error('Expected independent database ownership')
    try {
      await expect(f.engine.resume(f.f.run.id)).rejects.toMatchObject({ code: 'RUN_ALREADY_OWNED' })
      expect(await f.receipts()).toEqual([])
      expect(f.provider.counts.responses).toBe(1)
      await held.release()
      await recover(f)
    } finally { await held.release() }
    await recover(f)
    expect(await f.receipts()).toHaveLength(1)
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
  }, 60000)

  it('two actual persisted parallel delivered branches commit two task values and two receipts together', async () => {
    const f = await fixture(2)
    await f.engine.start(f.f.run.id)
    const interactions = await f.pending()
    expect(interactions).toHaveLength(2)
    expect(new Set(interactions.map((item) => item.executionId)).size).toBe(2)
    expect(new Set(interactions.map((item) => item.graphInterruptId)).size).toBe(2)
    await stageDelivered(f)
    const cut = await checkpointCut(f)
    const consume = f.saver.consumeApprovalInterrupt.bind(f.saver)
    let writes = 0
    const failure = vi.spyOn(f.saver, 'consumeApprovalInterrupt').mockImplementation(async (sql, interaction) => {
      await consume(sql, interaction)
      if (++writes === 2) throw new Error('rollback-second-branch')
    })
    const errors: unknown[] = []
    await f.engine.resume(f.f.run.id).catch((error: unknown) => errors.push(error))
    expect(writes).toBe(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'GRAPH_INVALID_FACT' })
    expect((await f.saver.getTuple(cut.config))?.pendingWrites).toEqual(cut.pendingWrites)
    expect(await f.receipts()).toEqual([]) // Includes the FIRST branch's receipt.
    expect(f.provider.counts.responses).toBe(2)
    failure.mockRestore()
    await expireAbandonedClaims(f)
    await recover(f)
    const stored = (await f.saver.getTuple(cut.config))?.pendingWrites?.filter((write) => write[1] === '__resume__') ?? []
    expect(stored).toHaveLength(2)
    expect(new Set(stored.map((write) => write[0])).size).toBe(2) // Actual task IDs, not a plan-only array test.
    expect(await f.receipts()).toHaveLength(2)
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
    expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3, responses: 2 })
  }, 60000)
  it('two delivered sibling requests in one persisted task share one value but have separate receipts', async () => {
    const f = await fixture(1, 2)
    await f.engine.start(f.f.run.id)
    const interactions = await f.pending()
    expect(interactions).toHaveLength(2)
    expect(new Set(interactions.map((item) => item.executionId)).size).toBe(1)
    expect(new Set(interactions.map((item) => item.graphInterruptId)).size).toBe(1)
    const cut = await checkpointCut(f)
    await stageDelivered(f)
    await recover(f)
    const stored = (await f.saver.getTuple(cut.config))?.pendingWrites?.filter((write) => write[1] === '__resume__') ?? []
    expect(stored).toHaveLength(1)
    expect(stored[0]![2]).toEqual([{ interactionId: interactions[0]!.id }])
    expect(await f.receipts()).toHaveLength(2)
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 2 })
  }, 60000)

  it('an unreceipted pre-existing task value is not laundered into a fresh receipt', async () => {
    const f = await fixture()
    await f.engine.start(f.f.run.id); await stageDelivered(f)
    const [interaction] = await f.pending(), cut = await checkpointCut(f)
    const interrupted = cut.pendingWrites?.find((write) => write[1] === '__interrupt__')
    if (!interrupted) throw new Error('Expected the persisted task interrupt')
    // Deliberately model an old/incorrect checkpoint writer using the actual
    // saver API. This is invalid historical fixture state, never production code.
    await f.saver.putWrites(cut.config, [['__resume__', [{ interactionId: interaction!.id }]]], interrupted[0])
    const invalid = (await f.saver.getTuple(cut.config))?.pendingWrites
    const errors: unknown[] = []
    await f.engine.resume(f.f.run.id).catch((error: unknown) => errors.push(error))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'GRAPH_INVALID_FACT' }) // The public publication error is sanitized.
    expect((await f.saver.getTuple(cut.config))?.pendingWrites).toEqual(invalid)
    expect(await f.receipts()).toEqual([])
    expect(f.provider.counts.responses).toBe(1)
  }, 60000)

})
