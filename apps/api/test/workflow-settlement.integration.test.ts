import assert from 'node:assert/strict'
import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionResult, HarnessExecution } from '@foreman-code/contracts'
import { CANONICAL_RUN_GRAPH_MCP_TOOLS, CanonicalRunGraphCurrentSchema,
  type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { executeRepeatRuntime } from '../src/modules/runs/repeatRuntime.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'
import type { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { workflowSettlementFixture } from './helpers/workflowSettlementFixture.js'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'
import { assertWorkflowFailureReadback } from './helpers/workflowFailureReadback.js'

// Native terminals and physical closure are explicit test inputs. Authenticated
// Save/MCP reads, canonical publication, SQL transactions and settlement execute.
vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
  settleRepeatNativeExecutionWithProofLocked: vi.fn(async () => undefined),
}))

type Fixture = Awaited<ReturnType<typeof workflowSettlementFixture>>
const timeout = 120000
const finish = (revision = 1): ExecutionResult => ({ outcome: 'succeeded', output: {
  routing: { kind: 'finish' }, data: { latestDeliverable: { revision }, remainingFindings: [] },
} })
const failed = (retryable: boolean): ExecutionResult => ({ outcome: 'failed',
  error: { code: 'PROVIDER_FAILED', message: 'Native execution failed.', retryable } })
const handoffs = (budget: number) => (graph: WorkflowDefinitionV3): WorkflowDefinitionV3 => ({ ...graph,
  handoffs: { contractVersion: 1 }, executionPolicy: { maxParallelism: 2, maxNodeExecutions: budget },
})

async function withFixture(configure: (graph: WorkflowDefinitionV3) => WorkflowDefinitionV3,
  work: (fixture: Fixture) => Promise<void>, form: 'sequential' | 'parallel' = 'sequential') {
  await nim2691TaskDatabase(async (pool, directory) => {
    await applyApplicationMigrations(pool)
    const db = { pool, directory, schema: 'public', close: async () => undefined } as
      Awaited<ReturnType<typeof currentDatabase>>
    const fixture = await workflowSettlementFixture(db, configure, form)
    try { await work(fixture) } finally { await fixture.close() }
  })
}

async function acceptedActivation(f: Fixture, activationId: string, result: ExecutionResult) {
  const admitted = await f.store.admitWorkActivation(activationId, (nodeId) => f.candidate(nodeId))
  await f.finish(admitted.execution.id, result)
  const accepted = await f.accept(admitted.execution.id)
  assert.equal(accepted.kind, 'accepted')
  return accepted.execution
}

async function sourceAndRequest(f: Fixture) {
  const entry = await f.store.ensureWorkEntry()
  const source = await acceptedActivation(f, entry, finish())
  const request = await f.store.admitWorkRequest(source.id, f.version.definition.edges[0]!.id)
  assert.equal(request.kind, 'accepted')
  return { source, request: request.request }
}

function runtime(f: Fixture, observe: (execution: HarnessExecution) => Promise<void>, saver = new MemorySaver()) {
  return () => executeRepeatRuntime({ runId: f.run.id, version: f.version, store: f.store,
    owner: { assertOwned() {} }, signal: new AbortController().signal, checkpointer: saver,
    driver: { candidate: (ref, attempt) => f.candidate(ref.nodeId, attempt), observe }, lifecycle: f.lifecycle })
}

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('workflow settlement and execution capacity', () => {
  it.each([false, true])('settles a nonretryable handoff failure once (restart before acceptance: %s)', async (restart) => {
    await withFixture(handoffs(2), async (f) => {
      let launches = 0
      if (restart) {
        const entry = await f.store.ensureWorkEntry()
        const admitted = await f.store.admitWorkActivation(entry, (nodeId) => f.candidate(nodeId))
        await f.finish(admitted.execution.id, failed(false))
        await f.restart()
      }
      const execute = runtime(f, async (execution) => {
        if (execution.state !== 'completed') { launches++; await f.finish(execution.id, failed(false)) }
      })
      await expect(execute()).rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
      expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'failed' })
      expect(f.failureSettlements).toBe(1)
      expect(launches).toBe(restart ? 0 : 1)
      await f.restart()
      await expect(execute()).rejects.toBeInstanceOf(Error)
      await expect(execute()).rejects.toBeInstanceOf(Error)
      expect(f.failureSettlements).toBe(1)
      expect(launches).toBe(restart ? 0 : 1)
      expect((await f.db.pool.query('select 1 from harness_executions where run_id=$1', [f.run.id])).rowCount).toBe(1)
    })
  }, timeout)

  it.each([false, true])('settles an exhausted technical retry once (restart at final terminal: %s)', async (restart) => {
    await withFixture(handoffs(3), async (f) => {
      let launches = 0
      if (restart) {
        const entry = await f.store.ensureWorkEntry()
        const first = await f.store.admitWorkActivation(entry, (nodeId) => f.candidate(nodeId))
        await f.finish(first.execution.id, failed(true))
        const retry = await f.store.acceptWorkTerminal(first.execution.id,
          (attempt) => f.candidate(first.execution.workflowNodeId, attempt))
        assert.equal(retry.kind, 'retry')
        await f.finish(retry.execution.id, failed(true))
        await f.restart()
      }
      const execute = runtime(f, async (execution) => {
        if (execution.state !== 'completed') { launches++; await f.finish(execution.id, failed(true)) }
      })
      await expect(execute()).rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
      expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'failed' })
      await f.restart()
      await expect(execute()).rejects.toBeInstanceOf(Error)
      expect(f.failureSettlements).toBe(1)
      expect(launches).toBe(restart ? 0 : 2)
      expect((await f.db.pool.query('select 1 from harness_executions where run_id=$1', [f.run.id])).rowCount).toBe(2)
    })
  }, timeout)

  it.each([false, true])('aggregates all terminal review revisions beyond node count (restart: %s)', async (restart) => {
    await withFixture((graph) => {
      const [a, b, c] = graph.nodes
      assert.ok(a && b && c)
      return { ...handoffs(9)(graph), nodes: [a, b, c], edges: [
        { id: 'review', kind: 'execution', source: a.id, target: b.id },
        { id: 'publish', kind: 'execution', source: a.id, target: c.id },
      ] }
    }, async (f) => {
      let activationId = await f.store.ensureWorkEntry()
      const terminalIds: string[] = []
      for (let revision = 1; revision <= 3; revision++) {
        const source = await acceptedActivation(f, activationId, finish(revision))
        const review = await f.store.admitWorkRequest(source.id, 'review')
        const publish = await f.store.admitWorkRequest(source.id, 'publish')
        assert.equal(review.kind, 'accepted')
        assert.equal(publish.kind, 'accepted')
        const output = await acceptedActivation(f, publish.request.destinationActivationId, finish(revision))
        terminalIds.push(output.id)
        const outcome = revision < 3 ? 'needs_changes' : 'accepted'
        const reviewer = await acceptedActivation(f, review.request.destinationActivationId,
          { outcome: 'succeeded', output: { routing: { kind: 'return', requestId: review.request.requestId, outcome },
            data: { latestDeliverable: { revision }, remainingFindings: outcome === 'accepted' ? [] : [{ id: 'revise' }] } } })
        if (restart) await f.restart() // Accepted terminal exists, return decision does not.
        const returned = await f.store.returnWork(reviewer.id)
        if (revision < 3) {
          assert.ok(returned.value.continuationActivationId)
          activationId = returned.value.continuationActivationId
        } else terminalIds.push(reviewer.id)
      }
      if (restart) await f.restart() // All accepted terminals exist, Run completion does not.
      expect(await f.store.completeWorkRun()).toBe('completed')
      const completed = await f.readRun()
      expect(completed).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      const outputs = (completed.result?.output as { outputs: Array<{ executionId: string }> }).outputs
      expect(outputs).toHaveLength(4)
      expect(outputs.map((output) => output.executionId).sort()).toEqual(terminalIds.sort())
      const bytes = structuredClone(completed)
      await f.restart()
      expect(await f.store.completeWorkRun()).toBe('completed')
      expect(await f.readRun()).toEqual(bytes)
      expect((await f.db.pool.query("select 1 from run_repeat_effects where run_id=$1 and effect_kind='run.complete'",
        [f.run.id])).rowCount).toBe(1)
      const read = await f.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.current, { protocolVersion: 1, scope: f.scope })
      expect(read.result?.isError, JSON.stringify(read)).not.toBe(true)
      const persisted = CanonicalRunGraphCurrentSchema.parse(graphRpcValue(read.result))
      expect(persisted.state.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      expect(persisted.state.executions).toHaveLength(9)
      const denied = await f.credential([{ actions: ['workflows:read'], scope: { workspaceIds: [f.run.workspaceId] } }])
      const denial = await f.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.current, { protocolVersion: 1, scope: f.scope }, denied.token)
      expect(denial.result?.isError).toBe(true)
    }, 'parallel')
  }, timeout)

  it.each([false, true])('fails downstream admission after an early retry uses the last slot (restart: %s)', async (restart) => {
    for (const workHandoffs of [false, true]) {
      await withFixture((graph) => ({ ...graph,
        ...(workHandoffs ? { handoffs: { contractVersion: 1 } } : {}),
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: 2 },
      }), async (f) => {
        const saver = new MemorySaver()
        let launched = 0
        const observe = async (execution: HarnessExecution) => {
          if (execution.state === 'completed') return
          launched++
          await f.finish(execution.id, execution.attempt === 1 ? failed(true) : finish())
        }
        if (workHandoffs) {
          const entry = await f.store.ensureWorkEntry()
          const first = await f.store.admitWorkActivation(entry, (nodeId) => f.candidate(nodeId))
          await f.finish(first.execution.id, failed(true))
          const retry = await f.store.acceptWorkTerminal(first.execution.id,
            (attempt) => f.candidate(first.execution.workflowNodeId, attempt))
          assert.equal(retry.kind, 'retry')
          await f.finish(retry.execution.id, finish())
          await f.accept(retry.execution.id)
        } else {
          const ref = { nodeId: f.version.entryNodeId, occurrence: null }
          const first = await f.store.admit(ref, () => f.candidate(ref.nodeId))
          assert.equal(first.kind, 'admitted')
          await f.finish(first.execution.id, failed(true))
          const retry = await f.store.acceptTerminal(first.execution.id, (attempt) => f.candidate(ref.nodeId, attempt))
          assert.equal(retry.kind, 'retry')
          await f.finish(retry.execution.id, { outcome: 'succeeded', output: { revision: 2 } })
          await f.store.acceptTerminal(retry.execution.id, () => { throw new Error('Success cannot retry') })
        }
        if (restart) await f.restart()
        const execute = runtime(f, observe, saver)
        await expect(execute()).rejects.toMatchObject({ code: workHandoffs
          ? 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED' : 'REPEAT_EXECUTION_BUDGET_EXHAUSTED' })
        expect(launched).toBe(0)
        expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'failed' })
        expect((await f.db.pool.query('select 1 from harness_executions where run_id=$1', [f.run.id])).rowCount).toBe(2)
        expect((await f.db.pool.query('select 1 from run_work_requests where run_id=$1', [f.run.id])).rowCount).toBe(0)
      })
    }
  }, timeout)

  it.each([false, true])('protects queued activation capacity from a technical retry (restart: %s)', async (restart) => {
    await withFixture((graph) => {
      const [a, b, c] = graph.nodes
      assert.ok(a && b && c)
      return { ...handoffs(3)(graph), nodes: [a, b, c], edges: [
        { id: 'first', kind: 'execution', source: a.id, target: b.id },
        { id: 'second', kind: 'execution', source: a.id, target: c.id },
      ] }
    }, async (f) => {
      const source = await acceptedActivation(f, await f.store.ensureWorkEntry(), finish())
      const first = await f.store.admitWorkRequest(source.id, 'first')
      const second = await f.store.admitWorkRequest(source.id, 'second')
      assert.equal(first.kind, 'accepted')
      assert.equal(second.kind, 'accepted')
      const branch = await f.store.admitWorkActivation(first.request.destinationActivationId, (nodeId) => f.candidate(nodeId))
      await f.finish(branch.execution.id, failed(true))
      if (restart) await f.restart()
      f.setProductionRetryPolicy()
      await expect(f.store.acceptWorkTerminal(branch.execution.id,
        () => { throw new Error('Retry must not consume the queued sibling reservation') }))
        .rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
      const sibling = await f.store.admitWorkActivation(second.request.destinationActivationId, (nodeId) => f.candidate(nodeId))
      expect(sibling.reused).toBe(false)
      expect((await f.store.admitWorkRequest(source.id, 'second')).replayed).toBe(true)
      expect((await f.store.admitWorkActivation(second.request.destinationActivationId,
        () => { throw new Error('Replay must not reserve another slot') })).reused).toBe(true)
      expect((await f.db.pool.query('select 1 from harness_executions where run_id=$1', [f.run.id])).rowCount).toBe(3)
    }, 'parallel')
  }, timeout)

  it.each([false, true])('budgets denial continuations and reuses their reservation on replay (restart: %s)', async (restart) => {
    await withFixture((graph) => ({ ...handoffs(5)(graph),
      edges: graph.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 1 })),
    }), async (f) => {
      const { request } = await sourceAndRequest(f)
      const reviewer = await acceptedActivation(f, request.destinationActivationId, { outcome: 'succeeded', output: {
        routing: { kind: 'return', requestId: request.requestId, outcome: 'needs_changes' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'revise' }] },
      } })
      const returned = await f.store.returnWork(reviewer.id)
      assert.ok(returned.value.continuationActivationId)
      const rework = await acceptedActivation(f, returned.value.continuationActivationId, finish(2))
      if (restart) await f.restart()
      const denied = await f.store.admitWorkRequest(rework.id, f.version.definition.edges[0]!.id)
      assert.equal(denied.kind, 'limit_reached')
      const continuationId = denied.notice.continuationActivationId
      expect((await f.store.admitWorkRequest(rework.id, f.version.definition.edges[0]!.id)).replayed).toBe(true)
      const continuation = await f.store.admitWorkActivation(continuationId, (nodeId) => f.candidate(nodeId))
      expect(continuation.reused).toBe(false)
      expect((await f.db.pool.query('select 1 from run_work_denials where run_id=$1', [f.run.id])).rowCount).toBe(1)
      expect((await f.db.pool.query('select 1 from run_work_activations where run_id=$1', [f.run.id])).rowCount).toBe(4)
    })
    await withFixture((graph) => ({ ...handoffs(3)(graph),
      edges: graph.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 1 })),
    }), async (f) => {
      const { request } = await sourceAndRequest(f)
      const reviewer = await acceptedActivation(f, request.destinationActivationId, { outcome: 'succeeded', output: {
        routing: { kind: 'return', requestId: request.requestId, outcome: 'needs_changes' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'revise' }] },
      } })
      const returned = await f.store.returnWork(reviewer.id)
      assert.ok(returned.value.continuationActivationId)
      const rework = await acceptedActivation(f, returned.value.continuationActivationId, finish(2))
      if (restart) await f.restart()
      await expect(f.store.admitWorkRequest(rework.id, f.version.definition.edges[0]!.id))
        .rejects.toMatchObject({ code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED' })
      expect((await f.db.pool.query('select 1 from run_work_denials where run_id=$1', [f.run.id])).rowCount).toBe(0)
      expect((await f.db.pool.query('select 1 from run_work_activations where run_id=$1', [f.run.id])).rowCount).toBe(3)
    })
  }, timeout)

  it.each([false, true])('refuses a review-return continuation beyond the budget without committing a return (restart: %s)', async (restart) => {
    await withFixture(handoffs(2), async (f) => {
      const { request } = await sourceAndRequest(f)
      const reviewer = await acceptedActivation(f, request.destinationActivationId, { outcome: 'succeeded', output: {
        routing: { kind: 'return', requestId: request.requestId, outcome: 'needs_changes' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'revise' }] },
      } })
      if (restart) await f.restart()
      const execute = runtime(f, async (execution) => { assert.equal(execution.state, 'completed') })
      await expect(execute()).rejects.toMatchObject({ code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED' })
      expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'failed', result: {
        outcome: 'failed', error: { code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED', retryable: false },
      } })
      expect((await f.db.pool.query('select 1 from run_work_returns where run_id=$1', [f.run.id])).rowCount).toBe(0)
      expect((await f.db.pool.query('select 1 from run_work_activations where run_id=$1', [f.run.id])).rowCount).toBe(2)
      expect((await f.store.readExecution(reviewer.id)).execution.result).toEqual(reviewer.result)
      await f.restart()
      await assertWorkflowFailureReadback(f, 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED')
    })
  }, timeout)

  it('retains the first specific failure across interrupted cleanup and owner restart', async () => {
    await withFixture(handoffs(2), async f => {
      const failure: ExecutionResult = { outcome: 'failed', error: {
        code: 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED', message: 'The Run has no execution capacity for rework.', retryable: false,
      } }
      await f.lifecycle.requestCleanup(failure)
      await f.lifecycle.requestCleanup({ outcome: 'failed', error: {
        code: 'CLEANUP_RETRY', message: 'A later cleanup error.', retryable: false,
      } })
      expect(await f.readRun()).toMatchObject({ executionState: 'running', outcome: 'pending' })
      await f.restart()
      await f.lifecycle.settleRun(false, true)
      await f.lifecycle.finishCleanup()
      expect((await f.readRun()).result).toEqual(failure)
      await assertWorkflowFailureReadback(f, 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED')
      await f.lifecycle.settleRun(false, false)
      expect((await f.readRun()).result).toEqual(failure)
    })
  }, timeout)

  it.each([false, true])('persists a direction wait for accepted review findings (restart after acceptance: %s)', async (restart) => {
    await withFixture(handoffs(2), async (f) => {
      const { request } = await sourceAndRequest(f)
      const reviewer = await acceptedActivation(f, request.destinationActivationId, { outcome: 'succeeded', output: {
        routing: { kind: 'return', requestId: request.requestId, outcome: 'accepted' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'open-finding' }] },
      } })
      if (restart) await f.restart()
      const execute = runtime(f, async (execution) => { assert.equal(execution.state, 'completed') })
      await execute()
      expect(await f.readRun()).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
      expect(await f.store.completeWorkRun()).toBe('needs_direction')
      await f.restart()
      await execute()
      expect(await f.store.completeWorkRun()).toBe('needs_direction')
      expect(await f.readRun()).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
      const returned = await f.store.returnWork(reviewer.id)
      expect(returned).toMatchObject({ replayed: true, value: { requestId: request.requestId, outcome: 'accepted',
        remainingFindings: [{ id: 'open-finding' }] } })
      expect((await f.db.pool.query('select 1 from run_work_returns where run_id=$1', [f.run.id])).rowCount).toBe(1)
      expect((await f.db.pool.query('select 1 from run_work_direction_waits where run_id=$1', [f.run.id])).rowCount).toBe(1)
      expect((await f.db.pool.query("select 1 from run_activity where run_id=$1 and kind='work_direction_wait'",
        [f.run.id])).rowCount).toBe(1)
      expect((await f.db.pool.query('select 1 from harness_executions where run_id=$1', [f.run.id])).rowCount).toBe(2)
      expect(f.failureSettlements).toBe(0)
    })
  }, timeout)

  it.each([false, true])('rejects another branch\'s return before accepting its result (restart: %s)', async (restart) => {
    await withFixture(handoffs(8), async (f) => {
      const source = await acceptedActivation(f, await f.store.ensureWorkEntry(), finish())
      const edges = f.version.definition.edges.filter((edge) => edge.kind === 'execution'
        && edge.source === f.version.entryNodeId)
      const left = await f.store.admitWorkRequest(source.id, edges[0]!.id)
      const right = await f.store.admitWorkRequest(source.id, edges[1]!.id)
      assert.equal(left.kind, 'accepted')
      assert.equal(right.kind, 'accepted')
      const admitted = await f.store.admitWorkActivation(right.request.destinationActivationId,
        (nodeId) => f.candidate(nodeId))
      await f.finish(admitted.execution.id, { outcome: 'succeeded', output: {
        routing: { kind: 'return', requestId: left.request.requestId, outcome: 'accepted' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: [] },
      } })
      if (restart) await f.restart()
      await expect(f.accept(admitted.execution.id)).rejects.toMatchObject({ code: 'WORK_RETURN_ANCESTRY_CONFLICT' })
      expect((await f.store.readExecution(admitted.execution.id)).accepted).toBe(false)
      expect((await f.db.pool.query('select execution_id from run_work_results where execution_id=$1',
        [admitted.execution.id])).rowCount).toBe(0)
      expect((await f.db.pool.query('select return_id from run_work_returns where run_id=$1',
        [f.run.id])).rowCount).toBe(0)
    }, 'parallel')
  }, timeout)
})
