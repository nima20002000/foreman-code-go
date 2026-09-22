import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MemorySaver } from '@langchain/langgraph'
import { HarnessExecutionSchema } from '@graphql/contracts'
import { makeWave25Fixture, RunGraphBatchSchema } from '@graphql/contracts/wave25'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { resolveExecutionDirectory } from '../src/modules/runs/executionDirectory.js'
import { agent3Database, seedAgent3, ownedAgent3, candidateFor, deferred, postgresEnabled } from './helpers/wave25Agent3.js'
import { randomUUID } from 'node:crypto'

/** The actual production engine, Run repositories, G1 transactions and LangGraph
 * checkpoint path. Only filesystem qualification and the native provider are
 * synthetic; native mapping/leases/approval dispatch remain Agents 4/5 tests. */
describe.skipIf(!postgresEnabled)('Agent 3 production engine wiring', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterAll(async () => { await db?.close() })
  afterEach(() => { vi.restoreAllMocks() })
  function runtime(options: { outcome?: 'pass' | 'issues'; cleanupThrows?: boolean; wait?: Promise<void> } = {}) {
    const locations = new WorkspaceLocationService(db.pool, new PostgresCommandCoordinator(db.pool), db.directory)
    vi.spyOn(locations, 'revalidateSnapshot').mockResolvedValue(undefined)
    const workflows = new PostgresWorkflowRepository(db.pool), runs = new PostgresRunRepository(db.pool, workflows, locations)
    const nativeStarts: string[] = [], observations: string[] = [], entered = deferred()
    const native = {
      async ensureObserve(input: Parameters<ApprovalExecutionCoordinator['ensureObserve']>[0]) {
        const candidate = input.candidate
        observations.push(candidate.workflowNodeId)
        // Same binding consumed by the tiny common coordinator hook, never
        // treating an already-admitted row as a freshly created occurrence.
        const fresh = runs.consumeOneShotLaunch(candidate.id, input.owner)
        let session = candidate.nativeSessionId ? await runs.exactOneShotSession(candidate.id, input.owner) : undefined
        if (!session) {
          if (!fresh) throw new Error('Synthetic runtime refuses an uncertain repeat launch')
          nativeStarts.push(candidate.workflowNodeId)
          await runs.assertOneShotNativeBoundary(candidate.id, input.owner)
          session = { harness: 'codex' as const, providerVersion: 'exact-synthetic-version', nativeSessionId: `native-${candidate.id}` }
          await new PostgresInteractionCoordinationRepository(db.pool).bindWorkflowSession(candidate.id, session)
        }
        entered.resolve()
        if (options.wait) await Promise.race([options.wait, new Promise<never>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
          if (input.signal.aborted) reject(input.signal.reason)
        })])
        const version = await runs.getOneShotVersion((await runs.get(candidate.runId, input.owner))!.workflowVersionId)
        const choice = version.definition.nodes.find((node) => node.id === candidate.workflowNodeId)?.choice
        const output = choice ? { routing: { outcome: options.outcome ?? 'pass' }, data: { checked: true } } : { done: true }
        const execution = HarnessExecutionSchema.parse({ ...candidate, nativeSessionId: session.nativeSessionId,
          state: 'completed', result: { outcome: 'succeeded', output }, finishedAt: new Date().toISOString() })
        await runs.updateExecution(execution, input.owner)
        if (options.cleanupThrows) throw new Error('cleanup failed after positively evidenced terminal write')
        return { state: 'completed' as const, execution, result: execution.result! }
      },
      finishRun: vi.fn(async () => undefined), cancelRun: vi.fn(async () => undefined),
      residentRunIds: () => [], reconcileReviews: async () => undefined, reviewers: { shutdown: async () => undefined },
    }
    const engine = new LangGraphWorkflowEngine(runs, workflows, native as unknown as ApprovalExecutionCoordinator,
      new MemorySaver(), db.directory, locations, undefined, undefined, undefined, { workerParallelism: 1 })
    return { engine, runs, nativeStarts, observations, entered, native }
  }
  async function branching() {
    const f = makeWave25Fixture(randomUUID())
    f.version.definition.nodes[0]!.choice = { outcomes: [
      { outcome: 'pass', target: { kind: 'branch_end' } },
      { outcome: 'issues', target: { kind: 'edge', relationshipId: f.version.definition.edges[0]!.id } },
    ] }
    return seedAgent3(db.pool, db.directory, f)
  }
  it.each([['pass', 1], ['issues', 2]] as const)('production engine executes %s with %s real queue/claim records and synthetic native launches', async (outcome, count) => {
    const f = await branching(), r = runtime({ outcome })
    await r.engine.start(f.run.id)
    expect(r.nativeStarts).toHaveLength(count)
    expect((await r.runs.get(f.run.id))?.outcome).toBe('succeeded')
    expect((await db.pool.query('select 1 from harness_executions where run_id=$1', [f.run.id])).rowCount).toBe(count)
    expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch'", [f.run.id])).rowCount).toBe(count)
    expect((await db.pool.query('select 1 from run_input_bindings where run_id=$1', [f.run.id])).rowCount).toBe(count - 1)
    const bodies = await db.pool.query<{ payload: string }>("select payload from run_graph_batches where run_id=$1 and kind='events' order by sequence", [f.run.id])
    const facts = bodies.rows.flatMap((row) => RunGraphBatchSchema.parse(JSON.parse(row.payload)).events.map((event) => event.fact))
    expect(facts.some((fact) => fact.type === 'run.state' && fact.state.executionState === 'completed')).toBe(true)
    expect(facts.some((fact) => fact.type === 'node.state' && fact.state.lifecycle === 'running')).toBe(false) // A5 native ack, not A3 setup
    await r.engine.shutdown()
  })
  it('recovers the exact recorded session after a binding/root-row crash without creating a replacement', async () => {
    const f = await branching(), held = await ownedAgent3(db.pool, f)
    try {
      const admitted = await held.store.admit(f.version.entryNodeId, () => candidateFor(f))
      if (admitted.kind !== 'admitted') throw new Error('Expected queue admission')
      await held.store.claimLaunch(admitted.execution.id, { workingDirectory: db.directory,
        runtimeDirectory: resolveExecutionDirectory(db.directory, f.run.id, f.version.entryNodeId, 1, f.scope.workspaceId) })
      await new PostgresInteractionCoordinationRepository(db.pool).bindWorkflowSession(admitted.execution.id,
        { harness: 'codex', providerVersion: 'original-synthetic-provider-version', nativeSessionId: 'original-exact-session' })
    } finally { await held.owner.release() }
    const r = runtime()
    await r.engine.start(f.run.id)
    expect(r.nativeStarts).toEqual([]); expect(r.observations).toEqual([f.version.entryNodeId])
    expect((await r.runs.getExecution(f.identities[0]!.executionId))?.nativeSessionId).toBe('original-exact-session')
    expect((await r.runs.get(f.run.id))?.outcome).toBe('succeeded')
    await r.engine.shutdown()
  })
  it('settles a claimed-but-unacknowledged execution without issuing any native call', async () => {
    const f = await branching(), held = await ownedAgent3(db.pool, f)
    try {
      const admitted = await held.store.admit(f.version.entryNodeId, () => candidateFor(f))
      if (admitted.kind !== 'admitted') throw new Error('Expected queue admission')
      await held.store.claimLaunch(admitted.execution.id, { workingDirectory: db.directory,
        runtimeDirectory: resolveExecutionDirectory(db.directory, f.run.id, f.version.entryNodeId, 1, f.scope.workspaceId) })
    } finally { await held.owner.release() }
    const r = runtime()
    await expect(r.engine.start(f.run.id)).rejects.toThrow()
    expect(r.nativeStarts).toEqual([]); expect(r.observations).toEqual([])
    expect((await r.runs.get(f.run.id))?.outcome).toBe('failed')
    expect((await db.pool.query('select resolution from run_node_resolutions where run_id=$1 and workflow_node_id=$2', [f.run.id, f.version.entryNodeId])).rows[0]?.resolution).toBe('failed')
    await r.engine.shutdown()
  })
  it('does not change accepted business success when native cleanup throws after the terminal write', async () => {
    const f = await branching(), r = runtime({ cleanupThrows: true })
    await r.engine.start(f.run.id)
    expect(r.nativeStarts).toHaveLength(1)
    expect((await r.runs.get(f.run.id))?.outcome).toBe('succeeded')
    expect(r.native.finishRun).toHaveBeenCalledWith(f.run.id)
    await r.engine.shutdown()
  })
  it('persists a second Run queued before shared capacity and honors its Stop without claiming a launch', async () => {
    const a = await branching(), b = await branching(), release = deferred(), r = runtime({ wait: release.promise })
    const active = r.engine.start(a.run.id)
    await r.entered.promise
    const queued = r.engine.start(b.run.id)
    const queuedResult = queued.catch(() => undefined)
    for (let i = 0; i < 100; i++) {
      if ((await db.pool.query('select 1 from harness_executions where run_id=$1', [b.run.id])).rowCount) break
      await delay(10)
    }
    expect((await db.pool.query('select record->>\'state\' as state from harness_executions where run_id=$1', [b.run.id])).rows[0]?.state).toBe('queued')
    await r.engine.cancel(b.run.id)
    await queuedResult
    expect((await db.pool.query("select 1 from run_graph_effects where run_id=$1 and effect_kind='execution.launch'", [b.run.id])).rowCount).toBe(0)
    expect((await r.runs.get(b.run.id))?.outcome).toBe('canceled')
    release.resolve(); await active; await r.engine.shutdown()
  })
})
