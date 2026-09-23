import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { MemorySaver } from '@langchain/langgraph'
import { HarnessExecutionSchema } from '@graphql/contracts'
import { ExecutableWorkflowV2Schema, makeWave25Fixture } from '@graphql/contracts/wave25'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { createAppMcpRuntime } from '../src/modules/app-runtime/composition.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import type { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { resolveExecutionDirectory } from '../src/modules/runs/executionDirectory.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { agent3Database, candidateFor, deferred, ownedAgent3, postgresEnabled, seedAgent3, terminalAgent3 } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('ENG-03 C native lifecycle with durable parallel branches', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => { db = await agent3Database() }, 60_000)
  afterAll(async () => { await db?.close() })

  async function fixture(extraQueued = false) {
    const f = makeWave25Fixture(randomUUID())
    const entry = f.version.definition.nodes[0]!, first = f.version.definition.nodes[1]!
    const sibling = { ...first, id: `sibling-${randomUUID()}`, name: 'Sibling' }
    const config = { ...f.configurations[1]!, id: `cfg-${randomUUID()}`, agentId: `agent-${randomUUID()}` }
    sibling.agentId = config.agentId
    const queuedConfig = extraQueued ? { ...config, id: `cfg-${randomUUID()}`, agentId: `agent-${randomUUID()}` } : undefined
    const queued = queuedConfig ? { ...first, id: `queued-${randomUUID()}`, agentId: queuedConfig.agentId, name: 'Queued' } : undefined
    const configurations = [...f.configurations, config, ...(queuedConfig ? [queuedConfig] : [])]
    const nodes = [entry, first, sibling, ...(queued ? [queued] : [])]
    const version = ExecutableWorkflowV2Schema.parse({
      version: { ...f.version, definition: {
        ...f.version.definition, executionPolicy: { maxParallelism: 2, maxNodeExecutions: nodes.length },
        nodes, edges: [
          f.version.definition.edges[0]!,
          { id: `edge-${randomUUID()}`, kind: 'execution', source: entry.id, target: sibling.id },
          ...(queued ? [{ id: `edge-${randomUUID()}`, kind: 'execution' as const, source: entry.id, target: queued.id }] : []),
        ],
      }, agentConfigurationVersionIds: Object.fromEntries(configurations.map((item) => [item.agentId, item.id])) },
      configurations,
    }).version
    f.version = version
    f.configurations.push(config)
    f.identities.push({ workflowNodeId: sibling.id, executionId: `exec-${randomUUID()}`,
      agentId: config.agentId, agentConfigurationVersionId: config.id, attempt: 1 })
    if (queued && queuedConfig) {
      f.configurations.push(queuedConfig)
      f.identities.push({ workflowNodeId: queued.id, executionId: `exec-${randomUUID()}`,
        agentId: queuedConfig.agentId, agentConfigurationVersionId: queuedConfig.id, attempt: 1 })
    }
    f.run = { ...f.run, agentConfigurationVersionIds: version.agentConfigurationVersionIds }
    await seedAgent3(db.pool, db.directory, f)
    return { f, entry: entry.id, first: first.id, sibling: sibling.id, queued: queued?.id }
  }

  function runtime(onNode: (nodeId: string, signal: AbortSignal) => Promise<'succeeded' | 'failed'>) {
    const locations = new WorkspaceLocationService(db.pool, new PostgresCommandCoordinator(db.pool), db.directory)
    vi.spyOn(locations, 'revalidateSnapshot').mockResolvedValue(undefined)
    const workflows = new PostgresWorkflowRepository(db.pool)
    const runs = new PostgresRunRepository(db.pool, workflows, locations)
    const starts: string[] = [], observations: string[] = []
    const native = {
      async ensureObserve(input: Parameters<ApprovalExecutionCoordinator['ensureObserve']>[0]) {
        const execution = input.candidate
        observations.push(execution.workflowNodeId)
        const fresh = runs.consumeOneShotLaunch(execution.id, input.owner)
        let session = execution.nativeSessionId ? await runs.exactOneShotSession(execution.id, input.owner) : undefined
        if (!session) {
          if (!fresh) throw new Error('Native start may not be replayed')
          starts.push(execution.workflowNodeId)
          session = { harness: 'codex' as const, providerVersion: 'synthetic-c', nativeSessionId: `native-${execution.id}` }
          await new PostgresInteractionCoordinationRepository(db.pool).bindWorkflowSession(execution.id, session)
        }
        const outcome = await onNode(execution.workflowNodeId, input.signal)
        input.signal.throwIfAborted()
        const completed = HarnessExecutionSchema.parse({ ...execution, nativeSessionId: session.nativeSessionId,
          state: 'completed', result: outcome === 'succeeded' ? { outcome, output: { text: execution.workflowNodeId } }
            : { outcome, error: { code: 'SYNTHETIC_PROCESS_EXIT', message: 'The task-owned process exited.', retryable: false } },
          finishedAt: new Date().toISOString() })
        await runs.updateExecution(completed, input.owner)
        return { state: 'completed' as const, execution: completed, result: completed.result! }
      },
      cancelRun: vi.fn(async () => undefined), finishRun: vi.fn(async () => undefined),
      residentRunIds: () => [], reconcileReviews: async () => undefined,
      reviewers: { shutdown: async () => undefined },
    }
    const engine = new LangGraphWorkflowEngine(runs, workflows, native as unknown as ApprovalExecutionCoordinator,
      new MemorySaver(), db.directory, locations, undefined, undefined, undefined, { workerParallelism: 2 })
    return { engine, runs, starts, observations, native }
  }

  it('stops both active branches before any later native dispatch and leaves another Run intact', async () => {
    const one = await fixture(true), other = await fixture()
    const entered = deferred(), release = deferred()
    const active = new Set<string>()
    const r = runtime(async (node, signal) => {
      if (node === one.first || node === one.sibling || node === one.queued) {
        active.add(node)
        if (active.size === 2) entered.resolve()
        await Promise.race([release.promise, new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          if (signal.aborted) reject(signal.reason)
        })])
      }
      return 'succeeded'
    })
    const task = r.engine.start(one.f.run.id).catch(() => undefined)
    await entered.promise
    await expect.poll(async () => (await db.pool.query(
      `select count(*)::int as count from harness_executions where run_id=$1 and record->>'state'='queued'`, [one.f.run.id],
    )).rows[0]?.count).toBe(1)
    const queued = (await db.pool.query<{ workflow_node_id: string }>(
      `select workflow_node_id from harness_executions where run_id=$1 and record->>'state'='queued'`, [one.f.run.id],
    )).rows[0]!.workflow_node_id
    await r.engine.cancel(one.f.run.id)
    await task
    expect((await r.runs.get(one.f.run.id))?.outcome).toBe('canceled')
    expect(r.starts).not.toContain(queued)
    expect((await r.runs.get(other.f.run.id))?.executionState).toBe('queued')
    expect(r.native.cancelRun).toHaveBeenCalledWith(one.f.run.id)
    await r.engine.cancel(other.f.run.id)
    release.resolve()
    await r.engine.shutdown()
  }, 30_000)

  it('fails the Run when one branch exits abnormally and cancels the active sibling', async () => {
    const { f, first, sibling } = await fixture()
    const siblingEntered = deferred()
    const r = runtime(async (node, signal) => {
      if (node === sibling) {
        siblingEntered.resolve()
        await new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          if (signal.aborted) reject(signal.reason)
        })
      }
      if (node === first) await siblingEntered.promise
      return node === first ? 'failed' : 'succeeded'
    })
    await expect(r.engine.start(f.run.id)).rejects.toThrow()
    expect((await r.runs.get(f.run.id))?.outcome).toBe('failed')
    expect(r.starts.filter((id) => id === sibling)).toHaveLength(1)
    expect(r.native.cancelRun).toHaveBeenCalledWith(f.run.id)
    await r.engine.shutdown()
  }, 30_000)

  it('deduplicates Start and reconcile while both branches are active', async () => {
    const { f, first, sibling } = await fixture()
    const entered = deferred(), release = deferred(), active = new Set<string>()
    const r = runtime(async (node) => {
      if (node === first || node === sibling) {
        active.add(node)
        if (active.size === 2) entered.resolve()
        await release.promise
      }
      return 'succeeded'
    })
    const task = r.engine.start(f.run.id)
    await entered.promise
    expect(r.engine.start(f.run.id)).toBe(task)
    await r.engine.reconcile()
    release.resolve()
    await task
    expect(r.starts).toHaveLength(3)
    expect(new Set(r.starts).size).toBe(3)
    expect((await r.runs.get(f.run.id))?.outcome).toBe('succeeded')
    await delay(1)
    await r.engine.shutdown()
  }, 30_000)

  it('reconciles an unfinished exact session after one sibling was accepted without another native start', async () => {
    const { f, entry, first, sibling } = await fixture()
    const held = await ownedAgent3(db.pool, f)
    let unfinishedId = ''
    try {
      await held.store.updateRun({ executionState: 'running', outcome: 'pending', startedAt: new Date().toISOString() })
      const admittedEntry = await held.store.admit(entry, () => candidateFor(f, entry))
      if (admittedEntry.kind !== 'admitted') throw new Error('Entry was not admitted')
      await terminalAgent3(db.pool, held.store, f, admittedEntry.execution)
      await held.store.acceptTerminal(admittedEntry.execution.id)
      const accepted = await held.store.admit(first, () => candidateFor(f, first))
      if (accepted.kind !== 'admitted') throw new Error('First branch was not admitted')
      await terminalAgent3(db.pool, held.store, f, accepted.execution, { accepted: 'first' })
      await held.store.acceptTerminal(accepted.execution.id)
      const unfinished = await held.store.admit(sibling, () => candidateFor(f, sibling))
      if (unfinished.kind !== 'admitted') throw new Error('Sibling was not admitted')
      unfinishedId = unfinished.execution.id
      await held.store.claimLaunch(unfinishedId, { workingDirectory: db.directory,
        runtimeDirectory: resolveExecutionDirectory(db.directory, f.run.id, sibling, 1, f.scope.workspaceId) })
      await new PostgresInteractionCoordinationRepository(db.pool).bindWorkflowSession(unfinishedId,
        { harness: 'codex', providerVersion: 'exact-before-restart', nativeSessionId: `native-${unfinishedId}` })
    } finally { await held.owner.release() }
    const r = runtime(async () => 'succeeded')
    await r.engine.reconcile()
    expect(r.starts).toEqual([])
    expect(r.observations).toEqual([sibling])
    expect((await r.runs.getExecution(unfinishedId))?.nativeSessionId).toBe(`native-${unfinishedId}`)
    expect((await r.runs.get(f.run.id))?.outcome).toBe('succeeded')
    expect((await db.pool.query('select count(*)::int as count from harness_executions where run_id=$1', [f.run.id])).rows[0]?.count).toBe(3)
    await r.engine.shutdown()
  }, 30_000)

  it('issues an authenticated v2 App credential through the composed runtime and revokes it at Stop', async () => {
    const { f, entry } = await fixture()
    const held = await ownedAgent3(db.pool, f)
    let executionId = ''
    try {
      await held.store.updateRun({ executionState: 'running', outcome: 'pending', startedAt: new Date().toISOString() })
      const admitted = await held.store.admit(entry, () => candidateFor(f, entry))
      if (admitted.kind !== 'admitted') throw new Error('Entry was not admitted')
      executionId = admitted.execution.id
      await held.store.claimLaunch(executionId, { workingDirectory: db.directory,
        runtimeDirectory: resolveExecutionDirectory(db.directory, f.run.id, entry, 1, f.scope.workspaceId) })
    } finally { await held.owner.release() }
    const access = new PostgresAccessService(db.pool)
    const composed = createAppMcpRuntime({ pool: db.pool, access,
      commands: new PostgresCommandCoordinator(db.pool), interactions: new PostgresInteractionRepository(db.pool),
      runnerId: 'runner-local', config: { host: '127.0.0.1', port: 3000,
        harnesses: { codexBinary: '/bin/false', openCodeBinary: '/bin/false', timeoutMs: 30_000 } } as Parameters<typeof createAppMcpRuntime>[0]['config'] })
    const credentials = Reflect.get(composed.executionCredentials, 'credentials')
    expect(credentials).toBeInstanceOf(Wave25WorkerCredentialService)
    const issued = await credentials.issueForExecution(executionId)
    const token = issued.environment.variables.GRAPHQL_APP_MCP_TOKEN!
    expect(await access.authenticate(token, 'worker')).toMatchObject({ agentId: f.configurations[0]!.agentId })
    await credentials.revokeForRun(f.run.id)
    await expect(access.authenticate(token, 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
  }, 30_000)
})
