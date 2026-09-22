import { afterEach, describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@graphql/contracts'
import { randomUUID } from 'node:crypto'
import { makeWave25Fixture, WorkflowVersionV2Schema } from '@graphql/contracts/wave25'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { agent3Database, seedAgent3, ownedAgent3, candidateFor, setFixtureVersion, postgresEnabled } from './helpers/wave25Agent3.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { changeOneShotLifecycle } from '../src/modules/runs/oneShotLifecycle.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })

describe.skipIf(!postgresEnabled)('BR1-004: real lifecycle producers and complete reference-consumer replay', () => {
  it.each(['failed', 'canceled'] as const)('matches complete snapshots through setup, wait, %s before acceptance and cleanup', async (outcome) => {
    const db = await agent3Database(); closes.push(db.close)
    const f = await seedAgent3(db.pool, db.directory)
    const { owner, store } = await ownedAgent3(db.pool, f); closes.push(() => owner.release())
    const { compare } = await graphParity(db.pool, f.scope, f.snapshot)
    await compare() // replay the actual insertOneShotRun admission publication
    await store.updateRun({ executionState: 'running', outcome: 'pending', startedAt: new Date().toISOString() })
    await compare()
    const admission = await store.admit(f.version.entryNodeId, () => candidateFor(f))
    if (admission.kind !== 'admitted') throw new Error('Expected actual queue admission')
    await compare()
    const starting = await store.claimLaunch(admission.execution.id, { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/native` })
    if (!starting) throw new Error('Expected actual launch claim')
    const beforeSetup = await compare()
    await store.updateExecution(HarnessExecutionSchema.parse({ ...starting, state: 'running' }))
    const afterSetup = await compare()
    expect(afterSetup.state).toEqual(beforeSetup.state)
    expect(afterSetup.asOfSequence).toBe(beforeSetup.asOfSequence)
    expect(afterSetup.state.nodes.find((node) => node.state.workflowNodeId === starting.workflowNodeId)?.state.lifecycle).toBe('starting')
    const session = { harness: 'codex' as const, providerVersion: 'synthetic-no-provider', nativeSessionId: `session-${starting.id}` }
    await new PostgresInteractionCoordinationRepository(db.pool).bindWorkflowSession(starting.id, session)
    const bound = await store.recoverSession(starting.id)
    const afterBinding = await compare()
    expect(afterBinding.state).toEqual(afterSetup.state)
    expect(afterBinding.asOfSequence).toBe(afterSetup.asOfSequence) // binding is not native progress
    await store.updateExecution(HarnessExecutionSchema.parse({ ...bound, state: 'waiting' }))
    await compare()
    await store.updateExecution(HarnessExecutionSchema.parse({ ...bound, state: 'running' }))
    await compare()
    const completed = HarnessExecutionSchema.parse({ ...bound, nativeSessionId: session.nativeSessionId,
      state: 'completed', result: outcome === 'canceled' ? { outcome } : { outcome,
        error: { code: 'SYNTHETIC_TERMINAL', message: 'Deterministic terminal fixture.', retryable: false } },
      finishedAt: new Date().toISOString() })
    await store.updateExecution(completed)
    const beforeAcceptance = await compare()
    const node = beforeAcceptance.state.nodes.find((item) => item.state.workflowNodeId === completed.workflowNodeId)!
    expect(node.state.lifecycle).toBe(outcome)
    expect(node.resolution).toBeUndefined()
    expect(node.acceptedResultDigest).toBeUndefined()
    await store.acceptTerminal(completed.id)
    await compare()
    await store.settleRun(false, true)
    await compare()
    for (const pending of [true, false]) {
      await changeOneShotLifecycle(db.pool, f.run.id, { kind: 'cleanup', pending })
      await compare()
    }
    expect((await db.pool.query('select stop_requested_at from runs where id=$1', [f.run.id])).rows[0].stop_requested_at).toBeNull()
  }, 60000)

  it.each(['pass', 'issues'] as const)('matches accepted %s routing and actual input binding without inventing an unselected activation', async (selected) => {
    const db = await agent3Database(); closes.push(db.close)
    const fixture = makeWave25Fixture(randomUUID()), edge = fixture.version.definition.edges[0]!
    const changed = WorkflowVersionV2Schema.parse({ ...fixture.version, definition: { ...fixture.version.definition,
      nodes: fixture.version.definition.nodes.map((node) => node.id === fixture.version.entryNodeId ? { ...node,
        choice: { outcomes: [{ outcome: 'pass', target: { kind: 'branch_end' } },
          { outcome: 'issues', target: { kind: 'edge', relationshipId: edge.id } }] } } : node) } })
    const f = await seedAgent3(db.pool, db.directory, setFixtureVersion(fixture, changed))
    const { owner, store } = await ownedAgent3(db.pool, f); closes.push(() => owner.release())
    const { compare } = await graphParity(db.pool, f.scope, f.snapshot)
    await compare()
    await store.updateRun({ executionState: 'running', outcome: 'pending', startedAt: new Date().toISOString() })
    await compare()
    // Only provider/session evidence is seeded here. These are real lifecycle,
    // acceptance/routing/binding producers, NOT native-callback qualification.
    const finish = async (nodeId: string, output: Record<string, unknown>) => {
      const admitted = await store.admit(nodeId, () => candidateFor(f, nodeId))
      if (admitted.kind !== 'admitted') throw new Error('Expected selected node admission')
      await compare()
      const claimed = await store.claimLaunch(admitted.execution.id,
        { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/${nodeId}` })
      if (!claimed) throw new Error('Expected exactly one launch claim')
      await compare()
      await new PostgresInteractionCoordinationRepository(db.pool).bindWorkflowSession(claimed.id,
        { harness: 'codex', providerVersion: 'synthetic-no-provider', nativeSessionId: `session-${claimed.id}` })
      const bound = await store.recoverSession(claimed.id)
      await compare()
      const terminal = HarnessExecutionSchema.parse({ ...bound, state: 'completed',
        result: { outcome: 'succeeded', output }, finishedAt: new Date().toISOString() })
      await store.updateExecution(terminal)
      const beforeAcceptance = await compare(), node = beforeAcceptance.state.nodes.find((value) => value.state.workflowNodeId === nodeId)!
      expect(node.state.lifecycle).toBe('succeeded')
      expect(node.resolution).toBeUndefined()
      expect(node.acceptedResultDigest).toBeUndefined()
      await store.acceptTerminal(terminal.id)
      const accepted = await compare()
      await store.acceptTerminal(terminal.id)
      expect((await compare()).asOfSequence).toBe(accepted.asOfSequence)
      return terminal
    }
    const first = await finish(f.version.entryNodeId, { routing: { outcome: selected }, data: { observed: true } })
    const resolved = (await compare()).state.nodes.find((node) => node.state.workflowNodeId === first.workflowNodeId)!.resolution!
    expect(resolved.selectedRelationshipIds).toEqual(selected === 'issues' ? [edge.id] : [])
    expect(resolved.unselectedRelationshipIds).toEqual(selected === 'pass' ? [edge.id] : [])
    if (selected === 'issues') {
      await finish(edge.target, { done: true })
      const bound = (await compare()).state.inputBindings
      expect(bound).toHaveLength(1)
      expect(bound[0]!.sender.executionId).toBe(first.id)
      expect(bound[0]!.relationshipId).toBe(edge.id)
    } else {
      const inactive = await store.admit(edge.target, () => { throw new Error('Unselected route allocated an execution') })
      expect(inactive.kind).toBe('resolved')
      const current = await compare()
      expect(current.state.inputBindings).toEqual([])
      expect(current.state.nodes.find((node) => node.state.workflowNodeId === edge.target)!.state.execution).toBeUndefined()
    }
    await store.completeRun()
    const completed = await compare()
    expect(completed.state.run.outcome).toBe('succeeded')
    expect(completed.state.run.cleanupPending).toBe(true)
    await changeOneShotLifecycle(db.pool, f.run.id, { kind: 'cleanup', pending: false })
    expect((await compare()).state.run.cleanupPending).toBe(false)
  }, 60000)

  it.each(['queued', 'starting'] as const)('publishes Stop from %s without manufacturing node cancellation before actual settlement', async (initial) => {
    const db = await agent3Database(); closes.push(db.close)
    const f = await seedAgent3(db.pool, db.directory)
    const { owner, store } = await ownedAgent3(db.pool, f); closes.push(() => owner.release())
    const { compare } = await graphParity(db.pool, f.scope, f.snapshot)
    await compare()
    const admitted = await store.admit(f.version.entryNodeId, () => candidateFor(f))
    if (admitted.kind !== 'admitted') throw new Error('Expected node admission')
    if (initial === 'starting') await store.claimLaunch(admitted.execution.id,
      { workingDirectory: db.directory, runtimeDirectory: `${db.directory}/never-submitted` })
    await compare()
    await changeOneShotLifecycle(db.pool, f.run.id, { kind: 'stop' })
    const stopped = await compare()
    expect(stopped.state.run.stopRequested).toBe(true)
    expect(stopped.state.nodes.find((node) => node.state.workflowNodeId === f.version.entryNodeId)!.state.lifecycle).toBe('unknown')
    expect(stopped.state.nodes.every((node) => node.activity.status === 'none')).toBe(true)
    await changeOneShotLifecycle(db.pool, f.run.id, { kind: 'stop' })
    expect((await compare()).asOfSequence).toBe(stopped.asOfSequence)
    await store.settleRun(true)
    const settled = await compare()
    expect(settled.state.run.outcome).toBe('canceled')
    expect(settled.state.nodes.find((node) => node.state.workflowNodeId === f.version.entryNodeId)!.state.lifecycle).toBe('canceled')
  }, 60000)

  // Intentionally NOT substituted with manually inserted native evidence or a
  // synthetic checkpoint consumer. These require the other lanes' composition.
  it.todo('actual native acknowledgement/disconnect/reconnect callback uses the lifecycle delta hook at a stable committed head')
  it.todo('actual approval delivery failure and delivered/checkpoint-pending/native-ack cuts match all exchanges and attention')
  it.todo('actual canceled interaction retirement and confirmed-review cleanup preserve complete replay parity')

})
