import { afterEach, describe, expect, it } from 'vitest'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { agent3Database, candidateFor, postgresEnabled } from './helpers/wave25Agent3.js'
import { currentRepositoryFixture } from './helpers/wave25CurrentRepository.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { repeatRuntimeDirectory } from '../src/modules/runs/repeatRepositoryHost.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })

// Actual current lifecycle writers and complete V3 reducer. Successful native
// work comes from the composed provider fixture, never manually bound sessions
// or caller-created terminal rows. Routing/fan-in is covered by ENG03-B and the
// current Agent3 graph suites; this suite qualifies persisted lifecycle parity.
describe.skipIf(!postgresEnabled)('Current lifecycle producers and complete graph replay', () => {
  it.each(['failed', 'canceled'] as const)('matches snapshots through admission, launch claim, %s and cleanup', async (outcome) => {
    const db = await agent3Database(); closes.push(db.close)
    const t = await currentRepositoryFixture(db), f = t.f
    const owner = await t.repository.acquireOwnership(f.run.id, () => undefined)
    if (!owner) throw new Error('Expected actual Run ownership')
    closes.push(() => owner.release())
    const store = await t.repository.repeat(owner), { compare } = await graphParity(db.pool, f.scope)
    await compare()
    await t.repository.updateState(f.run.id, { executionState: 'running', outcome: 'pending', startedAt: new Date().toISOString() }, owner)
    await compare()
    const admitted = await store.admit({ nodeId: f.version.entryNodeId, occurrence: null }, () => candidateFor(f))
    if (admitted.kind !== 'admitted') throw new Error('Expected exact queue admission')
    await compare()
    const claimed = await store.claimLaunch(admitted.execution.id, { workingDirectory: f.run.executionLocation!.rootPath,
      runtimeDirectory: repeatRuntimeDirectory(db.directory, f.scope, admitted.execution) })
    expect(claimed).toBeDefined()
    await compare()
    if (outcome === 'canceled') await t.stop()
    else await t.repository.requestCleanup(f.run.id, owner)
    const pending = await compare()
    expect(pending.state.run.cleanupPending).toBe(true)
    expect((await store.readExecution(admitted.execution.id)).execution.state).toBe('starting')
    await t.repository.settleOrphan(f.run.id, owner, outcome === 'canceled')
    const terminal = await compare()
    expect(terminal.state.run.outcome).toBe(outcome)
    expect((await store.readExecution(admitted.execution.id)).execution.result?.outcome).toBe(outcome)
    expect((await db.pool.query('select 1 from run_repeat_results where execution_id=$1', [admitted.execution.id])).rowCount).toBe(0)
    await t.repository.finishCleanup(f.run.id, false, owner)
    const settled = await compare()
    expect(settled.state.run.cleanupPending).toBe(false)
    await t.repository.finishCleanup(f.run.id, false, owner)
    expect((await compare()).asOfSequence).toBe(settled.asOfSequence)
  }, 60000)

  it.each(['queued', 'starting'] as const)('Stop from %s does not manufacture native cancellation before settlement', async (initial) => {
    const db = await agent3Database(); closes.push(db.close)
    const t = await currentRepositoryFixture(db), f = t.f
    const owner = await t.repository.acquireOwnership(f.run.id, () => undefined)
    if (!owner) throw new Error('Expected actual Run ownership')
    closes.push(() => owner.release())
    const store = await t.repository.repeat(owner), { compare } = await graphParity(db.pool, f.scope)
    const admitted = await store.admit({ nodeId: f.version.entryNodeId, occurrence: null }, () => candidateFor(f))
    if (admitted.kind !== 'admitted') throw new Error('Expected current queue admission')
    if (initial === 'starting') await store.claimLaunch(admitted.execution.id, { workingDirectory: f.run.executionLocation!.rootPath,
      runtimeDirectory: repeatRuntimeDirectory(db.directory, f.scope, admitted.execution) })
    const before = (await store.readExecution(admitted.execution.id)).execution
    await compare(); await t.stop()
    const stopped = await compare()
    expect(stopped.state.run.stopRequested).toBe(true)
    expect((await store.readExecution(admitted.execution.id)).execution).toEqual(before)
    expect(stopped.state.nodes.every((node) => node.state.lifecycle !== 'canceled')).toBe(true)
    await t.stop()
    expect((await compare()).asOfSequence).toBe(stopped.asOfSequence)
    await t.repository.settleOrphan(f.run.id, owner, true)
    expect((await compare()).state.run.outcome).toBe('canceled')
    expect((await store.readExecution(admitted.execution.id)).execution.result?.outcome).toBe('canceled')
  }, 60000)

  it('replays actual native wait, delivery, original acknowledgement and accepted-result cuts completely', async () => {
    const f = await checkpointRuntimeFixture(); closes.push(f.close)
    const { compare } = await graphParity(f.db.pool, f.f.scope)
    await compare()
    await f.engine.start(f.f.run.id)
    const [interaction] = await f.pending()
    if (!interaction) throw new Error('Expected a captured native approval request')
    const waiting = await compare()
    expect(waiting.state.interactions.some((item) => item.interactionId === interaction.id)).toBe(true)
    expect(waiting.state.run.pendingInteractionCount).toBe(1)
    const result = await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(interaction))
    expect(result.interaction.deliveryState).toBe('delivered')
    const completed = await compare()
    expect(completed.state.run.outcome).toBe('succeeded')
    expect(completed.state.run.pendingInteractionCount).toBe(0)
    expect(completed.state.interactions).toEqual([])
    expect(completed.state.results).toHaveLength(2)
    expect(completed.state.bindings).toHaveLength(1)
    const receipts = await f.receipts()
    await f.engine.resumeInteraction(result.interaction)
    // A terminal notification reruns cleanup and publishes its pending/finished
    // cuts, while accepted results and the original resume receipt stay fixed.
    expect((await compare()).state).toEqual(completed.state)
    expect(await f.receipts()).toEqual(receipts)
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
  }, 60000)
})
