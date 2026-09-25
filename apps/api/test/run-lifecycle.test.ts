import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import { Command, GraphInterrupt, MemorySaver, interrupt } from '@langchain/langgraph'
import type { DurableInteraction, HarnessExecution, WorkflowRun, WorkflowVersion } from '@graphql/contracts'
import { it } from 'vitest'

import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'

type State = { runId: string; executionIds: Record<string, string> }
type Snapshot = {
  values: Partial<State>
  next: string[]
  tasks: Array<{ name: string; error?: unknown; result?: unknown; interrupts?: Array<{ id: string; value: unknown }> }>
}
type NodeAction = (nodeId: string, state: State) => Promise<Partial<State>>
type Graph = {
  invoke(input: State | Command, config: { configurable: { thread_id: string }; signal?: AbortSignal }): Promise<State>
  getState(): Promise<Snapshot>
}
type Internals = {
  activeRuns: Map<string, AbortController>
  activeTasks: Map<string, Promise<void>>
  resumeTasks: Map<string, Promise<void>>
  buildGraph(version: WorkflowVersion, action: NodeAction): Graph
  executeNode(run: WorkflowRun, version: WorkflowVersion, nodeId: string, predecessors: string[], state: State, signal: AbortSignal, owner: RunOwnership): Promise<Partial<State>>
}
type EngineArguments = ConstructorParameters<typeof LangGraphWorkflowEngine>

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function fixture(options: { realGraph?: boolean; timeoutMs?: number; nodes?: string[] } = {}) {
  const nodeIds = options.nodes ?? ['approval']
  const run = {
    id: 'run', workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version',
    executionState: 'waiting', outcome: 'pending', approval: { handler: 'user' },
    agentConfigurationVersionIds: {}, executionLocation: { rootPath: '/accepted-project' },
    startedAt: '2026-09-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z',
  } as unknown as WorkflowRun
  const version: WorkflowVersion = {
    id: 'version', workflowId: 'workflow', workspaceId: 'workspace', version: 1,
    entryNodeId: nodeIds[0]!, contentHash: 'sha256:test', createdAt: run.createdAt,
    agentConfigurationVersionIds: {},
    definition: {
      id: 'workflow', workspaceId: 'workspace', name: 'Test', version: 1,
      executionCondition: { kind: 'manual' }, executionPolicy: { maxParallelism: 4, maxNodeExecutions: nodeIds.length },
      nodes: nodeIds.map((id) => ({ id, agentId: 'agent', name: id })),
      edges: nodeIds.slice(1).map((id) => ({ id: `edge-${id}`, source: nodeIds[0]!, target: id, route: { outcomes: ['succeeded'] } })),
    },
  }
  const items = new Map<string, DurableInteraction>()
  const executions = new Map<string, HarnessExecution>()
  const calls = { invocations: [] as Array<State | Command>, cancel: 0, settled: [] as boolean[], bound: [] as string[], owners: 0, peakOwners: 0, releases: 0 }
  const control = {
    remainingMs: 5_000,
    snapshot: { values: { runId: run.id, executionIds: {} }, next: ['approval'], tasks: [] } as Snapshot,
    invoke: async (_input: State | Command, _action: NodeAction): Promise<State> => {
      void _input; void _action
      throw new Error('Unexpected graph invocation')
    },
    read: async (): Promise<Snapshot> => structuredClone(control.snapshot),
  }
  const runs = {
    acquireOwnership: async () => {
      assert.equal(calls.owners, 0, 'concurrent resume attempted to overwrite database ownership')
      calls.owners += 1
      calls.peakOwners = Math.max(calls.peakOwners, calls.owners)
      let released = false
      return {
        client: {},
        assertOwned() { assert.equal(released, false) },
        async release() {
          assert.equal(released, false)
          released = true
          calls.owners -= 1
          calls.releases += 1
        },
      }
    },
    get: async () => ({ ...run }),
    reconciliationCandidates: async () => [{ ...run }],
    updateState: async (_id: string, update: Partial<WorkflowRun>) => { Object.assign(run, update) },
    getExecution: async (id: string) => executions.get(id),
    getAcceptedResult: async (id: string) => ({ outcome: 'succeeded' as const, output: { executionId: id } }),
    remainingApprovalTime: async () => control.remainingMs,
    settleOrphan: async (_id: string, _owner: unknown, canceled: boolean) => {
      void _owner
      if (run.executionState === 'completed') return false
      calls.settled.push(canceled)
      Object.assign(run, { executionState: canceled ? 'completed' : 'interrupted', outcome: canceled ? 'canceled' : 'pending' })
      return true
    },
  }
  const interactions = {
    get: async (id: string) => items.get(id),
    bindGraphInterrupt: async (id: string, graphInterruptId: string) => {
      const item = items.get(id)!
      assert.ok(!item.graphInterruptId || item.graphInterruptId === graphInterruptId)
      const bound = { ...item, graphInterruptId }
      items.set(id, bound)
      calls.bound.push(graphInterruptId)
      return bound
    },
    list: async () => { throw new Error('Historical interaction pagination must not drive resume') },
  }
  const workflows = { getVersion: async () => version }
  const approvals = {
    cancelRun: async () => { calls.cancel += 1 },
    finishRun: async () => undefined, reconcileReviews: async () => undefined,
    residentRunIds: () => [] as string[],
    reviewers: { shutdown: async () => undefined },
  }
  const engine = new LangGraphWorkflowEngine(
    runs as unknown as EngineArguments[0], workflows as unknown as EngineArguments[1],
    approvals as unknown as EngineArguments[2], new MemorySaver(), '/runtime',
    { revalidateSnapshot: async () => undefined } as unknown as EngineArguments[5], undefined,
    interactions as unknown as EngineArguments[7],
  )
  const internals = engine as unknown as Internals
  if (!options.realGraph) {
    internals.buildGraph = (_version, action) => ({
      invoke: async (input) => {
        calls.invocations.push(input)
        return control.invoke(input, action)
      },
      getState: () => control.read(),
    })
  }
  function addInteraction(nodeId = 'approval', delivered = false, graphInterruptId: string | undefined = `interrupt-${nodeId}`) {
    const item = {
      id: `interaction-${nodeId}`, runId: run.id, graphThreadId: run.id,
      workspaceId: run.workspaceId, workflowId: run.workflowId, requestingAgentId: 'agent',
      executionId: `execution-${nodeId}`, nativeSessionId: `native-${nodeId}`, nativeRequestId: `request-${nodeId}`,
      status: delivered ? 'delivered' : 'pending', deliveryState: delivered ? 'delivered' : 'not_started',
      ...(graphInterruptId ? { graphInterruptId } : {}),
    } as DurableInteraction
    items.set(item.id, item)
    executions.set(item.executionId, {
      id: item.executionId, runId: run.id, workflowNodeId: nodeId, agentId: 'agent',
      nativeSessionId: item.nativeSessionId, state: 'waiting',
    } as HarnessExecution)
    return item
  }
  function waiting(...pending: DurableInteraction[]) {
    control.snapshot = {
      values: { runId: run.id, executionIds: {} }, next: pending.map((item) => item.id),
      tasks: pending.map((item) => ({ name: item.id, interrupts: [{ id: item.graphInterruptId ?? `interrupt-${item.id}`, value: { interactionId: item.id } }] })),
    }
  }
  function complete() {
    const state = { runId: run.id, executionIds: Object.fromEntries(nodeIds.map((id) => [id, `execution-${id}`])) }
    control.snapshot = { values: state, next: [], tasks: [] }
    return state
  }
  return { run, version, items, executions, calls, control, runs, workflows, interactions, approvals, engine, internals, addInteraction, waiting, complete }
}

it('reconciliation preserves healthy approval waits across repeated ticks', async () => {
  const f = fixture()
  const item = f.addInteraction()
  f.waiting(item)
  for (let tick = 0; tick < 3; tick += 1) await f.engine.reconcile((error) => { throw error })
  assert.equal(f.run.executionState, 'waiting')
  assert.deepEqual(f.items.get(item.id), item)
  assert.equal(f.calls.cancel, 0)
  assert.deepEqual(f.calls.settled, [])
  assert.deepEqual(f.calls.invocations, [])
  assert.equal(f.calls.owners, 0)
})

it('reconciliation repairs only a missing binding after the checkpoint was saved', async () => {
  const f = fixture()
  f.run.executionState = 'running'
  const item = f.addInteraction()
  delete item.graphInterruptId
  f.waiting(item)
  await f.engine.reconcile((error) => { throw error })
  assert.equal(f.run.executionState, 'waiting')
  assert.deepEqual(f.calls.bound, [`interrupt-${item.id}`])
  assert.equal(f.items.get(item.id)?.nativeSessionId, item.nativeSessionId)
  assert.equal(f.items.get(item.id)?.nativeRequestId, item.nativeRequestId)
  assert.deepEqual(f.calls.settled, [])
  assert.deepEqual(f.calls.invocations, [])
})

it('reconciliation resumes delivered current interrupts without native response replay', async () => {
  const f = fixture()
  const item = f.addInteraction('approval', true)
  f.waiting(item)
  f.control.invoke = async () => f.complete()
  await f.engine.reconcile((error) => { throw error })
  assert.equal(f.run.executionState, 'completed')
  assert.deepEqual((f.calls.invocations[0] as Command).resume, { [item.graphInterruptId!]: { interactionId: item.id } })
  assert.equal(f.calls.cancel, 0)
  assert.deepEqual(f.calls.settled, [])
})

it('reconciliation rereads terminal runs under ownership instead of settling stale candidates', async () => {
  const f = fixture()
  f.runs.reconciliationCandidates = async () => {
    const candidate = { ...f.run }
    f.run.executionState = 'completed'
    return [candidate]
  }
  await f.engine.reconcile((error) => { throw error })
  assert.deepEqual(f.calls.settled, [])
  assert.deepEqual(f.calls.invocations, [])
  assert.equal(f.calls.cancel, 0)
})

it('reconciliation finishes a terminal checkpoint using accepted results without invoking nodes', async () => {
  const f = fixture()
  f.run.executionState = 'running'
  f.complete()
  await f.engine.reconcile((error) => { throw error })
  assert.equal(f.run.outcome, 'succeeded')
  assert.deepEqual(f.calls.invocations, [])
  assert.deepEqual(f.calls.settled, [])
})

for (const hasApprovalSibling of [false, true]) {
  it(`reconciliation does not replay genuinely orphaned work (approval sibling: ${hasApprovalSibling})`, async () => {
    const f = fixture()
    f.run.executionState = 'running'
    if (hasApprovalSibling) f.waiting(f.addInteraction())
    f.control.snapshot.tasks.push({ name: 'orphan', interrupts: [] })
    f.control.snapshot.next.push('orphan')
    await f.engine.reconcile((error) => { throw error })
    assert.equal(f.run.executionState, 'interrupted')
    assert.deepEqual(f.calls.settled, [false])
    assert.deepEqual(f.calls.invocations, [])
  })
}

it('a checkpoint read failure leaves approval state recoverable for the next tick', async () => {
  const f = fixture()
  const item = f.addInteraction('approval', true)
  f.waiting(item)
  const read = f.control.read
  f.control.read = async () => { throw new Error('checkpoint unavailable') }
  const errors: unknown[] = []
  await f.engine.reconcile((error) => { errors.push(error) })
  assert.equal(errors.length, 1)
  assert.equal(f.run.executionState, 'waiting')
  assert.equal(f.items.get(item.id)?.deliveryState, 'delivered')
  assert.equal(f.calls.cancel, 0)
  f.control.read = read
  f.control.invoke = async () => f.complete()
  await f.engine.reconcile((error) => { throw error })
  assert.equal(f.run.outcome, 'succeeded')
})

it('run-level resume resolves only current checkpoint IDs, including interactions beyond 100 old rows', async () => {
  const f = fixture()
  for (let index = 0; index < 150; index += 1) f.addInteraction(`old-${index}`, true)
  const left = f.addInteraction('approval', true)
  const right = f.addInteraction('other', true)
  f.waiting(left, right)
  f.control.invoke = async () => f.complete()
  await f.engine.resume(f.run.id)
  assert.deepEqual((f.calls.invocations[0] as Command).resume, {
    [left.graphInterruptId!]: { interactionId: left.id },
    [right.graphInterruptId!]: { interactionId: right.id },
  })
  assert.equal(f.calls.invocations.length, 1)
})

it('a resume map combines delivered branches but excludes undecided current interrupts', async () => {
  const f = fixture()
  const delivered = f.addInteraction('approval', true)
  const pending = f.addInteraction('other')
  f.waiting(delivered, pending)
  f.control.invoke = async () => {
    f.waiting(pending)
    return { runId: f.run.id, executionIds: {} }
  }
  await f.engine.resumeInteraction(delivered)
  assert.deepEqual((f.calls.invocations[0] as Command).resume, { [delivered.graphInterruptId!]: { interactionId: delivered.id } })
  assert.equal(f.run.executionState, 'waiting')
  assert.equal(f.items.get(pending.id)?.deliveryState, 'not_started')
})

it('concurrent resume callers wait behind the active run and retain one task/controller owner', async () => {
  const f = fixture()
  const starting = deferred()
  const resumeEntered = deferred()
  const finishing = deferred()
  f.run.executionState = 'queued'
  const left = f.addInteraction('approval', true)
  const right = f.addInteraction('other', true)
  f.waiting(left, right)
  f.control.invoke = async (input) => {
    if (!(input instanceof Command)) {
      await starting.promise
      return { runId: f.run.id, executionIds: {} }
    }
    resumeEntered.resolve()
    await finishing.promise
    return f.complete()
  }
  const start = f.engine.start(f.run.id)
  const first = f.engine.resumeInteraction(left)
  const second = f.engine.resumeInteraction(right)
  starting.resolve()
  await start
  await resumeEntered.promise
  const activeTask = f.internals.activeTasks.get(f.run.id)
  const activeController = f.internals.activeRuns.get(f.run.id)
  assert.ok(activeTask)
  assert.ok(activeController)
  const third = f.engine.resumeInteraction(left)
  await Promise.resolve()
  assert.equal(f.internals.activeTasks.get(f.run.id), activeTask)
  assert.equal(f.internals.activeRuns.get(f.run.id), activeController)
  finishing.resolve()
  await Promise.all([first, second, third])
  assert.equal(f.calls.peakOwners, 1)
  assert.equal(f.calls.invocations.filter((input) => input instanceof Command).length, 1)
  assert.equal(f.internals.activeTasks.size, 0)
  assert.equal(f.internals.activeRuns.size, 0)
  assert.equal(f.internals.resumeTasks.size, 0)
})

it('a failed queued resume does not discard another caller or the durable delivered intent', async () => {
  const f = fixture()
  const item = f.addInteraction('approval', true)
  f.waiting(item)
  let reads = 0
  const read = f.control.read
  f.control.read = async () => {
    reads += 1
    if (reads === 1) throw new Error('temporary checkpoint read failure')
    return read()
  }
  f.control.invoke = async () => f.complete()
  const first = assert.rejects(f.engine.resumeInteraction(item), /temporary checkpoint/)
  const second = f.engine.resumeInteraction(item)
  await Promise.all([first, second])
  assert.equal(f.items.get(item.id)?.deliveryState, 'delivered')
  assert.equal(f.run.outcome, 'succeeded')
  assert.equal(f.calls.peakOwners, 1)
})

it('failed graph resume I/O remains recoverable without canceling approvals', async () => {
  const f = fixture()
  const item = f.addInteraction('approval', true)
  f.waiting(item)
  f.control.invoke = async () => { throw new Error('checkpoint write failed') }
  await assert.rejects(f.engine.resumeInteraction(item), /checkpoint write failed/)
  assert.notEqual(f.run.executionState, 'completed')
  assert.equal(f.items.get(item.id)?.deliveryState, 'delivered')
  assert.equal(f.calls.cancel, 0)
  f.control.invoke = async () => f.complete()
  await f.engine.reconcile((error) => { throw error })
  assert.equal(f.run.outcome, 'succeeded')
})

it('finishing tasks remove tracking only when they still own the registered entries', async () => {
  const f = fixture()
  const finishing = deferred()
  f.run.executionState = 'queued'
  f.control.invoke = async () => { await finishing.promise; return f.complete() }
  const start = f.engine.start(f.run.id)
  const replacementController = new AbortController()
  const replacementTask = Promise.resolve()
  f.internals.activeRuns.set(f.run.id, replacementController)
  f.internals.activeTasks.set(f.run.id, replacementTask)
  finishing.resolve()
  await start
  assert.equal(f.internals.activeRuns.get(f.run.id), replacementController)
  assert.equal(f.internals.activeTasks.get(f.run.id), replacementTask)
})

it('a finished short-budget branch does not arm a timer against other branches or successors', async () => {
  const f = fixture({ timeoutMs: 60_000, nodes: ['short', 'long', 'successor'] })
  f.control.remainingMs = 1
  const short = f.addInteraction('short', true)
  const long = f.addInteraction('long', true)
  f.waiting(short, long)
  const visited: string[] = []
  f.internals.executeNode = async (_run, _version, nodeId, _predecessors, _state, signal) => {
    if (nodeId !== 'short') await delay(25)
    signal.throwIfAborted()
    visited.push(nodeId)
    return { executionIds: { [nodeId]: `execution-${nodeId}` } }
  }
  f.control.invoke = async (_input, action) => {
    const state = { runId: f.run.id, executionIds: {} }
    await Promise.all([action('short', state), action('long', state)])
    await action('successor', state)
    return f.complete()
  }
  await f.engine.resumeInteraction(short)
  assert.deepEqual(visited, ['short', 'long', 'successor'])
  assert.equal(f.run.outcome, 'succeeded')
  assert.equal(f.calls.cancel, 0)
})

it('approval waiting is not bounded by the active run timer', async () => {
  const f = fixture({ timeoutMs: 10 })
  const item = f.addInteraction()
  f.waiting(item)
  await f.engine.reconcile((error) => { throw error })
  await delay(30)
  assert.equal(f.run.executionState, 'waiting')
  assert.equal(f.calls.cancel, 0)
  Object.assign(item, { status: 'delivered', deliveryState: 'delivered' })
  f.control.invoke = async () => f.complete()
  await f.engine.resumeInteraction(item)
  assert.equal(f.run.outcome, 'succeeded')
})

it('shutdown drains the active resume and rejects queued work without launching another owner', async () => {
  const f = fixture()
  const entered = deferred()
  const item = f.addInteraction('approval', true)
  f.waiting(item)
  f.internals.executeNode = async (_run, _version, _nodeId, _predecessors, _state, signal) => {
    entered.resolve()
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    return {}
  }
  f.control.invoke = async (_input, action) => {
    await action('approval', { runId: f.run.id, executionIds: {} })
    return f.complete()
  }
  const first = f.engine.resumeInteraction(item)
  await entered.promise
  const second = assert.rejects(f.engine.resumeInteraction(item), { code: 'ENGINE_CLOSING' })
  await f.engine.shutdown()
  await Promise.all([first, second])
  assert.equal(f.calls.invocations.length, 1)
  assert.equal(f.calls.owners, 0)
  assert.equal(f.internals.activeRuns.size, 0)
  assert.equal(f.internals.resumeTasks.size, 0)
})

it('conflicting checkpoint identity fails closed instead of replacing durable/native IDs', async () => {
  const f = fixture()
  const item = f.addInteraction('approval', true)
  f.waiting(item)
  f.control.snapshot.tasks[0]!.interrupts![0]!.id = 'different-interrupt'
  await assert.rejects(f.engine.resumeInteraction(item), { code: 'INTERACTION_INTERRUPT_CONFLICT' })
  assert.equal(f.items.get(item.id)?.graphInterruptId, item.graphInterruptId)
  assert.deepEqual(f.calls.bound, [])
  assert.deepEqual(f.calls.invocations, [])
  assert.equal(f.run.executionState, 'waiting')
})

for (const bubble of [false, true]) {
  it(`ordinary GraphInterrupt does not cancel delayed sibling work (bubbled: ${bubble})`, async () => {
    const f = fixture({ nodes: ['entry', 'approval', 'sibling'] })
    const item = f.addInteraction()
    f.waiting(item)
    f.run.executionState = 'queued'
    let siblingFinished = false
    let siblingAborted = false
    f.internals.executeNode = async (_run, _version, nodeId, _predecessors, _state, signal) => {
      if (nodeId === 'approval') throw new GraphInterrupt([{ id: item.graphInterruptId!, value: { interactionId: item.id } }])
      try { await delay(15, undefined, { signal }) } catch (error) { siblingAborted = true; throw error }
      siblingFinished = true
      return { executionIds: { sibling: 'execution-sibling' } }
    }
    f.control.invoke = async (_input, action) => {
      const work = [action('approval', { runId: f.run.id, executionIds: {} }), action('sibling', { runId: f.run.id, executionIds: {} })]
      if (bubble) await Promise.all(work)
      else await Promise.allSettled(work)
      return { runId: f.run.id, executionIds: {} }
    }
    await f.engine.start(f.run.id)
    assert.equal(siblingFinished, true)
    assert.equal(siblingAborted, false)
    assert.equal(f.run.executionState, 'waiting')
    assert.equal(f.calls.cancel, 0)
    assert.equal(f.calls.owners, 0)
  })
}

it('a genuine sibling error after an interrupt still fails the run with the real cause', async () => {
  const f = fixture({ nodes: ['entry', 'approval', 'failed'] })
  const item = f.addInteraction()
  f.waiting(item)
  f.run.executionState = 'queued'
  f.internals.executeNode = async (_run, _version, nodeId) => {
    if (nodeId === 'approval') throw new GraphInterrupt([{ id: item.graphInterruptId!, value: { interactionId: item.id } }])
    await delay(5)
    throw new Error('actual sibling failure')
  }
  f.control.invoke = async (_input, action) => {
    await Promise.allSettled([action('approval', { runId: f.run.id, executionIds: {} }), action('failed', { runId: f.run.id, executionIds: {} })])
    return { runId: f.run.id, executionIds: {} }
  }
  await f.engine.start(f.run.id)
  assert.equal(f.run.outcome, 'failed')
  assert.equal(f.run.result?.error?.message, 'actual sibling failure')
})

it('remaining approval budget uses the owner connection, deduplicates IDs and selects the tightest remaining budget', async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const owner = {
    runId: 'run',
    assertOwned() {},
    client: { async query(sql: string, values: unknown[]) {
      queries.push({ sql, values })
      if (sql.includes('select r.record,v.record as version')) return { rows: [{ record: { id: 'run' }, version: {}, execution_semantics_version: 1 }] }
      return { rows: [{ remaining_ms: '80.5', stopped_at: null }, { remaining_ms: '20', stopped_at: null }] }
    } },
  } as unknown as RunOwnership
  const repository = new PostgresRunRepository(
    { query() { throw new Error('must not acquire another pool connection') } } as unknown as ConstructorParameters<typeof PostgresRunRepository>[0],
    {} as ConstructorParameters<typeof PostgresRunRepository>[1], {} as ConstructorParameters<typeof PostgresRunRepository>[2],
  )
  assert.equal(await repository.remainingApprovalTime('run', ['a', 'b', 'a'], owner), 20)
  const budget = queries.find((query) => query.sql.includes('approval_execution_state'))!
  assert.deepEqual(budget.values, ['run', ['a', 'b']])
  assert.match(budget.sql, /approval_wait_started_at is not null then 0/)
  assert.match(budget.sql, /active_timeout_ms - budget.active_elapsed_ms/)
  assert.match(budget.sql, /clock_timestamp\(\)-budget.active_started_at/)
})

for (const rows of [[], [{ remaining_ms: '100', stopped_at: new Date() }]]) {
  it(`missing or stopped persisted budgets fail closed (${rows.length} rows)`, async () => {
    const repository = new PostgresRunRepository(
      {} as ConstructorParameters<typeof PostgresRunRepository>[0], {} as ConstructorParameters<typeof PostgresRunRepository>[1], {} as ConstructorParameters<typeof PostgresRunRepository>[2],
    )
    const owner = { runId: 'run', assertOwned() {}, client: { query: async (sql: string) => ({ rows: sql.includes('select r.record,v.record as version')
      ? [{ record: { id: 'run' }, version: {}, execution_semantics_version: 1 }] : rows }) } } as unknown as RunOwnership
    await assert.rejects(repository.remainingApprovalTime('run', ['a'], owner), { code: 'EXECUTION_STOPPED' })
  })
}

it('[real LangGraph] parallel interrupts preserve completed predecessor work and exact current resume identities', async () => {
  const f = fixture({ realGraph: true, nodes: ['entry', 'left', 'right'] })
  f.run.executionState = 'queued'
  const left = f.addInteraction('left')
  const right = f.addInteraction('right')
  delete left.graphInterruptId
  delete right.graphInterruptId
  const entries = new Map<string, number>()
  let effects = 0
  f.internals.executeNode = async (_run, _version, nodeId, _predecessors, _state, signal) => {
    entries.set(nodeId, (entries.get(nodeId) ?? 0) + 1)
    if (nodeId === 'entry') effects += 1
    const item = f.items.get(`interaction-${nodeId}`)
    if (item?.deliveryState !== 'delivered' && item) {
      if (nodeId === 'right') await delay(15, undefined, { signal })
      interrupt({ interactionId: item.id })
      throw new Error('An undelivered interaction must not receive a resume value')
    }
    return { executionIds: { [nodeId]: `execution-${nodeId}` } }
  }
  await f.engine.start(f.run.id)
  assert.equal(f.run.executionState, 'waiting')
  assert.equal(f.items.get(left.id)?.graphInterruptId != null, true)
  assert.equal(f.items.get(right.id)?.graphInterruptId != null, true)
  await f.engine.reconcile((error) => { throw error })
  for (const item of f.items.values()) Object.assign(item, { status: 'delivered', deliveryState: 'delivered' })
  await Promise.all([f.engine.resumeInteraction(f.items.get(left.id)!), f.engine.resumeInteraction(f.items.get(right.id)!)])
  assert.equal(f.run.outcome, 'succeeded')
  assert.equal(entries.get('entry'), 1)
  assert.equal(entries.get('left'), 2)
  assert.equal(entries.get('right'), 2)
  assert.equal(effects, 1)
  assert.equal(f.calls.peakOwners, 1)
})

it('[real LangGraph] an approval wait with a completed sibling remains healthy during reconciliation', async () => {
  const f = fixture({ realGraph: true, nodes: ['entry', 'approval', 'sibling'] })
  f.run.executionState = 'queued'
  const item = f.addInteraction()
  delete item.graphInterruptId
  let siblingEntries = 0
  f.internals.executeNode = async (_run, _version, nodeId, _predecessors, _state, signal) => {
    if (nodeId === 'approval') {
      interrupt({ interactionId: item.id })
      throw new Error('Approval remains undecided')
    }
    if (nodeId === 'sibling') { await delay(15, undefined, { signal }); siblingEntries += 1 }
    return { executionIds: { [nodeId]: `execution-${nodeId}` } }
  }
  await f.engine.start(f.run.id)
  await f.engine.reconcile((error) => { throw error })
  assert.equal(f.run.executionState, 'waiting')
  assert.equal(siblingEntries, 1)
  assert.equal(f.calls.cancel, 0)
  assert.deepEqual(f.calls.settled, [])
})
