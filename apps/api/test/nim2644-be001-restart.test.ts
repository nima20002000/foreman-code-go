import assert from 'node:assert/strict'
import { it } from 'vitest'
import type pg from 'pg'
import type { AgentConfigurationVersion, HarnessExecution, NativeSessionReference } from '@graphql/contracts'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import type { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import type { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import type { ExecutionCredentialProvider } from '../src/modules/harnesses/mcpDetection.js'
import type { NativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { finalizeStoppedWorkflowSessions } from '../src/modules/interactions/stoppedWorkflowFinalization.js'
import { PostgresWorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import { nativeLanes } from './helpers/nativeLanes.js'

const at = '2026-09-24T00:00:00.000Z'
interface Row { generation: string; execution_identity: unknown; expected_reference: unknown | null;
  closed_reference: unknown | null; closed: boolean }

/** Deliberately a SQL/transaction double, not PostgreSQL acceptance. The separate
 * integration file exercises the actual migration, locks, coordinator and save SQL. */
function fixture(reviewer = false) {
  let execution: HarnessExecution = { id: 'be001-restart-execution', runId: 'be001-restart-run', workflowNodeId: 'be001-restart-node',
    agentId: 'be001-restart-agent', agentConfigurationVersionId: 'be001-restart-config', attempt: 1,
    input: {}, state: 'waiting', nativeSessionId: 'be001-restart-native', workingDirectory: '/synthetic',
    runtimeDirectory: '/synthetic/runtime', createdAt: at,
    ...(reviewer ? { state: 'completed' as const, result: { outcome: 'succeeded' as const }, finishedAt: at } : {}) }
  const session: NativeSessionReference = { harness: 'codex', providerVersion: 'synthetic-no-native-call', nativeSessionId: execution.nativeSessionId! }
  const configuration: AgentConfigurationVersion = { id: execution.agentConfigurationVersionId, workspaceId: 'be001-restart-ws',
    agentId: execution.agentId, productRole: reviewer ? 'orchestrator' : 'coder', version: 1,
    harness: { harness: 'codex', model: 'synthetic-no-native-call', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' },
    prompt: {}, assignedSkills: [], contentHash: 'sha256:' + '0'.repeat(64), createdAt: at }
  const state = { terminal: false, stopped: false, finalized: reviewer, outstanding: false, owned: true,
    failBegin: false, failCloseWrite: false, loseCommitReply: false, failNativeClose: false, loseAtFinalFence: false,
    finalizationWrites: 0, revocations: 0, retirementCalls: 0, closeWrites: 0, beginCalls: 0,
    preflightCalls: 0, closes: 0, attaches: 0, cancels: 0, creates: 0, turns: 0, reads: 0,
    recoveryCalls: 0, resolutions: 0, budgetStops: 0, interactionCancels: 0 }
  let rows: Row[] = []
  let before: Row[] | undefined
  let lastWriteWasClosure = false
  let beforePreflight = () => undefined as void
  let beforeClose = async () => undefined as void
  const query = async (text: string, values: unknown[] = []) => {
    const result = (data: unknown[]) => ({ rows: data, rowCount: data.length })
    if (text === 'begin') { before = structuredClone(rows); return result([]) }
    if (text === 'commit') {
      before = undefined
      if (lastWriteWasClosure && state.loseCommitReply) {
        state.loseCommitReply = false; lastWriteWasClosure = false
        throw new Error('Synthetic lost COMMIT reply AFTER durable close write')
      }
      lastWriteWasClosure = false; return result([])
    }
    if (text === 'rollback') { if (before) rows = before; before = undefined; return result([]) }
    if (text === 'select id from runs where id=$1 for update') return result(values[0] === execution.runId ? [{ id: values[0] }] : [])
    if (text.startsWith('select record from harness_executions')) {
      return result(values[0] === execution.id && values[1] === execution.runId ? [{ record: execution }] : [])
    }
    if (text.startsWith('select 1 from runs')) return result(!state.terminal && !state.stopped ? [{}] : [])
    if (text.startsWith('select reference from execution_native_sessions')) return result([{ reference: session }])
    if (text.startsWith('insert into execution_native_closures')) {
      state.beginCalls++
      if (state.failBegin) throw new Error('Synthetic lifetime registration failure')
      const row: Row = { generation: String(rows.length + 1), execution_identity: JSON.parse(values[1] as string),
        expected_reference: values[2] === null ? null : JSON.parse(values[2] as string), closed_reference: null, closed: false }
      rows.push(row); return result([{ generation: row.generation }])
    }
    if (text.startsWith('select generation::text')) return result(rows.at(-1)
      ? [{ ...rows.at(-1)!, prior_unclosed: rows.slice(0, -1).some((row) => !row.closed) }] : [])
    if (text.startsWith('update execution_native_closures')) {
      if (state.failCloseWrite) throw new Error('Synthetic close receipt write failure')
      const row = rows.find((item) => item.generation === values[1])
      if (!row || row.closed || values[0] !== execution.id) return result([])
      row.closed = true; row.closed_reference = JSON.parse(values[2] as string)
      lastWriteWasClosure = true; state.closeWrites++
      return result([{ generation: row.generation }])
    }
    if (text.includes('join lateral')) {
      state.reads++
      const row = rows.at(-1)
      return result(row && values[0] === execution.id && values[1] === execution.runId ? [{ ...row, record: execution, reference: session, prior_unclosed: rows.slice(0, -1).some((item) => !item.closed) }] : [])
    }
    if (text.startsWith('select\n')) return result([{ terminal: state.terminal }])
    if (text.startsWith('select id,record')) return result([{ id: execution.id, record: execution }])
    if (text.includes('for update of s')) return result([{ execution_id: execution.id, reference: session, finalized: state.finalized }])
    if (text.includes('as outstanding')) return result([{ outstanding: state.outstanding }])
    if (text.startsWith('update execution_native_sessions')) {
      assert.deepEqual(JSON.parse(values[1] as string), session)
      state.finalized = true; state.finalizationWrites++; return result([{ execution_id: execution.id }])
    }
    throw new Error(`Unexpected SQL in unit double: ${text}`)
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const run = () => ({ id: execution.runId, workspaceId: configuration.workspaceId, workflowId: 'be001-restart-wf',
    workflowVersionId: 'be001-restart-version',
    ...(reviewer ? { approval: { handler: 'orchestrator' as const, designatedOrchestratorAgentId: execution.agentId } } : {}),
    executionState: state.terminal ? 'completed' : 'waiting', outcome: state.terminal ? 'canceled' : 'pending' })
  const runs = { get: async () => run(), getExecution: async () => execution,
    getExecutionConfiguration: async () => configuration, listExecutions: async () => [execution],
    updateExecution: async (next: HarnessExecution) => { execution = next } } as unknown as PostgresRunRepository
  const coordination = { ...nativeLanes(), workflowSession: async () => ({ session, finalized: state.finalized, reviewerActive: false }),
    hasUnsettledReview: async () => false, finishStoppedReviews: async () => { state.retirementCalls++ } }
  const interactions = { coordination, getForExecution: async () => undefined, cancelPendingForRun: async () => { state.interactionCancels++; return 1 } } as unknown as PostgresInteractionRepository
  const budgets = { stop: async () => { state.budgetStops++ } } as unknown as PostgresApprovalBudgetRepository
  const credentials = { prepare: async () => {
    state.preflightCalls++; beforePreflight()
    return { credential: { principalId: 'synthetic-credential', expiresAt: new Date(Date.now() + 300_000).toISOString(),
      environment: { agentId: execution.agentId, variables: {} } } }
  }, revokeForExecution: async () => { state.revocations++ } } as unknown as ExecutionCredentialProvider
  const cold = () => {
    let resident = false
    const manager = { harness: 'codex', attachSession: async (reference: NativeSessionReference) => {
      assert.deepEqual(reference, session); state.attaches++; return reference
    }, close: async (reference: NativeSessionReference) => {
      assert.deepEqual(reference, session); state.closes++; await beforeClose()
      if (state.failNativeClose) throw new Error('Synthetic uncertain native close')
    }, cancel: async () => { state.cancels++; return true },
    createSession: async () => { state.creates++; throw new Error('Replacement creation forbidden') },
    startTurn: () => { state.turns++; throw new Error('Turn replay forbidden') },
    history: async () => ({ events: [], pendingInteractions: [] }), reconcile: async () => ({ events: [], pendingInteractions: [] }),
    respond: async () => { throw new Error('Approval delivery forbidden') },
  } as unknown as NativeHarnessSessionManager
    const resolver = { resolve() {
      state.resolutions++
      return { manager, get processState() { return resident ? 'resident' : 'needs_start' },
        beginStart() {}, markResident() { resident = true } }
    }, release() { resident = false } } as NativeSessionManagerResolver
    const store = new PostgresWorkflowClosureStore(pool)
    const coordinator = new ApprovalExecutionCoordinator(runs, interactions, budgets, resolver, 60_000, credentials, undefined,
      async () => { state.recoveryCalls++; return false }, store)
    return { coordinator, store, resolver, manager }
  }
  const context = () => ({ executionId: execution.id, agentId: execution.agentId, workingDirectory: execution.workingDirectory!, harness: 'codex' as const,
    ...(reviewer ? { purpose: 'reviewer' as const } : {}) })
  let fenceCount = 0
  const owner = { runId: execution.runId, assertOwned() { if (!state.owned) throw new Error('RUN_OWNERSHIP_LOST') },
    async readOneShotFence() { if (state.loseAtFinalFence && ++fenceCount === 2) state.owned = false; if (!state.owned) throw new Error('RUN_OWNERSHIP_LOST'); return { ownerId: 'unit-owner', fence: '1' } },
    oneShotConnection: () => ({ transaction: async (work: (sql: GraphTransactionSql) => Promise<void>) => {
      const wasFinalized = state.finalized
      try { await work({ query } as unknown as GraphTransactionSql) } catch (error) { state.finalized = wasFinalized; throw error }
    } }),
  } as unknown as RunOwnership
  return { cold, state, pool, session, owner, context, execution: () => execution, rows: () => rows,
    terminal: () => { state.terminal = true; state.stopped = true;
      execution = { ...execution, state: 'completed', result: { outcome: 'canceled' }, finishedAt: at } },
    beforePreflight: (fn: typeof beforePreflight) => { beforePreflight = fn }, beforeClose: (fn: typeof beforeClose) => { beforeClose = fn } }
}

it('BE-001 restart: registers before credential preflight/attachment and recovers committed close with entirely fresh coordinator/resolver', async () => {
  const f = fixture(), first = f.cold()
  f.beforePreflight(() => { assert.equal(f.rows().length, 1); assert.equal(f.rows()[0]!.closed, false); assert.equal(f.state.attaches, 0) })
  await first.coordinator.attachOwnedSession(f.context(), f.session)
  await first.coordinator.cancelRun(f.execution().runId)
  assert.equal(f.rows()[0]!.closed, true); assert.equal(f.state.finalized, false)
  f.terminal()
  const fresh = f.cold(), calls = { closes: f.state.closes, attaches: f.state.attaches, resolutions: f.state.resolutions }
  assert.deepEqual(fresh.coordinator.residentRunIds(), [])
  await fresh.coordinator.cancelRun(f.execution().runId, f.owner)
  assert.equal(f.state.finalized, true)
  assert.deepEqual({ closes: f.state.closes, attaches: f.state.attaches, resolutions: f.state.resolutions }, calls)
  assert.equal(f.state.creates, 0); assert.equal(f.state.turns, 0)
  await fresh.coordinator.cancelRun(f.execution().runId, f.owner)
  assert.equal(f.state.finalizationWrites, 1); assert.equal(f.state.closeWrites, 1)
})

it('BE-001 restart: registration failure prevents credential/native preflight', async () => {
  const f = fixture(), first = f.cold(); f.state.failBegin = true
  await assert.rejects(first.coordinator.attachOwnedSession(f.context(), f.session), /registration failure/)
  assert.equal(f.state.preflightCalls, 0); assert.equal(f.state.attaches, 0); assert.equal(f.rows().length, 0)
})

it('BE-001 restart: uncertain native close never creates a receipt, even after terminal settlement and cold recovery', async () => {
  const f = fixture(), first = f.cold()
  await first.coordinator.attachOwnedSession(f.context(), f.session)
  f.state.failNativeClose = true
  await assert.rejects(first.coordinator.cancelRun(f.execution().runId), AggregateError)
  assert.equal(f.rows()[0]!.closed, false)
  f.terminal()
  await assert.rejects(f.cold().coordinator.cancelRun(f.execution().runId, f.owner), AggregateError)
  assert.equal(f.state.finalized, false); assert.equal(f.state.attaches, 1)
})

it('BE-001 restart: raw close followed by receipt write failure stays uncertain after restart', async () => {
  const f = fixture(), first = f.cold()
  await first.coordinator.attachOwnedSession(f.context(), f.session)
  f.state.failCloseWrite = true
  await assert.rejects(first.coordinator.cancelRun(f.execution().runId), AggregateError)
  f.terminal()
  assert.equal(f.state.closes, 1); assert.equal(f.rows()[0]!.closed, false)
  await assert.rejects(f.cold().coordinator.cancelRun(f.execution().runId, f.owner), AggregateError)
  assert.equal(f.state.finalized, false)
})

it('BE-001 restart: lost close COMMIT reply is reconciled from durable evidence without another native close', async () => {
  const f = fixture(), first = f.cold()
  await first.coordinator.attachOwnedSession(f.context(), f.session)
  f.state.loseCommitReply = true
  await assert.rejects(first.coordinator.cancelRun(f.execution().runId), AggregateError)
  f.terminal()
  assert.equal(f.rows()[0]!.closed, true)
  await f.cold().coordinator.cancelRun(f.execution().runId, f.owner)
  assert.equal(f.state.finalized, true); assert.equal(f.state.closes, 1)
})

it('BE-001 restart: a later registered preflight masks an old close before any replacement native attachment', async () => {
  const f = fixture(), first = f.cold()
  await first.coordinator.attachOwnedSession(f.context(), f.session)
  await first.coordinator.cancelRun(f.execution().runId)
  assert.equal(f.rows()[0]!.closed, true)
  const proof = await first.store.read(f.execution()); assert.ok(proof)
  const next = await f.cold().store.begin(f.execution()) // SQL-only admission, no native action
  assert.notEqual(next, f.rows()[0]!.generation)
  assert.equal(await first.store.read(f.execution()), undefined)
  f.terminal()
  // Even the old coordinator's cached proof must be revalidated on the owner transaction.
  await assert.rejects(finalizeStoppedWorkflowSessions(f.execution().runId, f.owner, () => proof), /exact native closure/)
  await assert.rejects(first.coordinator.cancelRun(f.execution().runId, f.owner), AggregateError)
  await assert.rejects(f.cold().coordinator.cancelRun(f.execution().runId, f.owner), AggregateError)
  assert.equal(f.state.finalized, false); assert.equal(f.rows()[0]!.closed, true); assert.equal(f.state.attaches, 1)
})

it('BE-001 restart: stale generation cannot publish a late close for the newer lifetime', async () => {
  const f = fixture(), first = f.cold()
  await first.coordinator.attachOwnedSession(f.context(), f.session)
  f.beforeClose(async () => { await f.cold().store.begin(f.execution()) })
  await assert.rejects(first.coordinator.cancelRun(f.execution().runId), AggregateError)
  assert.equal(f.rows().length, 2); assert.ok(f.rows().every((row) => !row.closed))
})

it('BE-001 restart: missing receipts and mismatched execution/session/provider evidence are not recovery proof', async () => {
  const empty = fixture(); empty.terminal()
  await assert.rejects(empty.cold().coordinator.cancelRun(empty.execution().runId, empty.owner), AggregateError)
  for (const corrupt of [
    (row: Row) => { row.closed_reference = { harness: 'opencode', providerVersion: 'other', nativeSessionId: 'other' } },
    (row: Row) => { row.expected_reference = { harness: 'codex', providerVersion: 'other', nativeSessionId: 'other' } },
    (row: Row) => { row.execution_identity = { ...(row.execution_identity as object), agentConfigurationVersionId: 'other' } },
    (row: Row) => { row.execution_identity = { ...(row.execution_identity as object), runtimeDirectory: '/other' } },
  ]) {
    const f = fixture(), first = f.cold()
    await first.coordinator.attachOwnedSession(f.context(), f.session)
    await first.coordinator.cancelRun(f.execution().runId)
    corrupt(f.rows()[0]!) // Deliberately corrupt read-side data in the unit double only.
    f.terminal()
    await assert.rejects(f.cold().coordinator.cancelRun(f.execution().runId, f.owner), AggregateError)
    assert.equal(f.state.finalized, false); assert.equal(f.state.attaches, 1)
  }
})

it('BE-001 restart: durable close cannot bypass resource obligations or a lost finalization owner', async () => {
  for (const mode of ['outstanding', 'owner'] as const) {
    const f = fixture(), first = f.cold()
    await first.coordinator.attachOwnedSession(f.context(), f.session)
    await first.coordinator.cancelRun(f.execution().runId)
    f.terminal()
    if (mode === 'outstanding') f.state.outstanding = true
    else f.state.loseAtFinalFence = true
    await assert.rejects(f.cold().coordinator.cancelRun(f.execution().runId, f.owner))
    assert.equal(f.state.finalized, false)
  }
})


it('BE-001 restart: a newer close cannot hide an older unconfirmed native lifetime', async () => {
  const f = fixture(), first = f.cold()
  await first.store.begin(f.execution()) // Earlier dispatched lifetime has no positive closure.
  await first.coordinator.attachOwnedSession(f.context(), f.session)
  await assert.rejects(first.coordinator.cancelRun(f.execution().runId), AggregateError)
  assert.equal(f.rows().length, 2)
  assert.ok(f.rows().every((row) => !row.closed))
  f.terminal()
  await assert.rejects(f.cold().coordinator.cancelRun(f.execution().runId, f.owner), AggregateError)
  assert.equal(f.state.finalized, false)
})


// Production's ordinary restart does not call cancelRun for retained waiting
// sessions. Its disposer must close their exact captured lifetimes first.
for (const reviewer of [false, true]) it(`BE-001 graceful restart: ${reviewer ? 'completed Orchestrator reviewer' : 'waiting Worker'} closes before a fresh legitimate attachment`, async () => {
  const f = fixture(reviewer), first = f.cold()
  await first.coordinator.attachOwnedSession(f.context(), f.session)
  const before = structuredClone(f.execution())
  await first.coordinator.closeForRestart()
  assert.equal(f.rows()[0]!.closed, true)
  assert.equal(f.rows()[0]!.generation, '1')
  assert.deepEqual(f.execution(), before)
  assert.equal(f.state.stopped, false)
  assert.equal(f.state.revocations, 0)
  assert.equal(f.state.budgetStops, 0)
  assert.equal(f.state.interactionCancels, 0)
  assert.equal(f.state.retirementCalls, 0)
  assert.equal(f.state.finalizationWrites, 0)
  assert.equal(f.state.cancels, 0)
  assert.equal(f.state.creates, 0); assert.equal(f.state.turns, 0)
  // The retired coordinator must not admit another lifetime.
  await assert.rejects(first.coordinator.attachOwnedSession(f.context(), f.session), /shutting down/)
  assert.equal(f.rows().length, 1)
  const fresh = f.cold()
  await fresh.coordinator.attachOwnedSession(f.context(), f.session)
  assert.equal(f.rows().length, 2)
  assert.equal(f.rows()[1]!.closed, false)
  assert.equal(await fresh.store.read(f.execution()), undefined)
  await fresh.coordinator.closeForRestart()
  assert.ok(f.rows().every((row) => row.closed))
  assert.equal((await fresh.store.read(f.execution()))?.durableGeneration, '2')
  assert.equal(f.state.closes, 2); assert.equal(f.state.attaches, 2)
  assert.equal(f.state.revocations, 0); assert.equal(f.state.cancels, 0)
})

it('BE-001 graceful restart: coalesces disposal and does not record a close before the actual close resolves', async () => {
  const f = fixture(), first = f.cold()
  await first.coordinator.attachOwnedSession(f.context(), f.session)
  let release!: () => void, entered!: () => void
  const permit = new Promise<void>((resolve) => { release = resolve })
  const called = new Promise<void>((resolve) => { entered = resolve })
  f.beforeClose(async () => { entered(); await permit })
  const closing = first.coordinator.closeForRestart()
  const same = first.coordinator.closeForRestart()
  assert.equal(closing, same)
  await called
  assert.equal(f.rows()[0]!.closed, false)
  release()
  await closing
  await first.coordinator.closeForRestart()
  assert.equal(f.state.closes, 1); assert.equal(f.state.closeWrites, 1)
})

it('BE-001 graceful restart: native close rejection preserves uncertainty; only the same manager successful retry can record it', async () => {
  const f = fixture(), first = f.cold()
  await first.coordinator.attachOwnedSession(f.context(), f.session)
  f.state.failNativeClose = true
  await assert.rejects(first.coordinator.closeForRestart(), AggregateError)
  assert.equal(f.rows()[0]!.closed, false)
  assert.equal(await f.cold().store.read(f.execution()), undefined)
  f.state.failNativeClose = false
  await first.coordinator.closeForRestart()
  assert.equal(f.rows()[0]!.closed, true)
  assert.equal(f.state.closes, 2); assert.equal(f.state.attaches, 1)
  assert.equal(f.state.revocations, 0); assert.equal(f.state.cancels, 0)
})

it('BE-001 graceful restart: receipt write failure cannot become shutdown success or a reusable close proof', async () => {
  const f = fixture(), first = f.cold()
  await first.coordinator.attachOwnedSession(f.context(), f.session)
  f.state.failCloseWrite = true
  await assert.rejects(first.coordinator.closeForRestart(), AggregateError)
  assert.equal(f.rows()[0]!.closed, false)
  assert.equal(await f.cold().store.read(f.execution()), undefined)
  f.state.failCloseWrite = false
  await first.coordinator.closeForRestart()
  assert.equal(f.rows()[0]!.closed, true)
  assert.equal(f.state.closes, 2); assert.equal(f.state.beginCalls, 1)
})

it('BE-001 graceful restart: a genuinely unclosed predecessor is not closed by a later matching-session attachment', async () => {
  const f = fixture(), first = f.cold()
  await first.coordinator.attachOwnedSession(f.context(), f.session)
  // Simulate loss of the old API without executing its native close/disposer.
  const fresh = f.cold()
  await fresh.coordinator.attachOwnedSession(f.context(), f.session)
  assert.equal(f.rows().length, 2)
  await assert.rejects(fresh.coordinator.closeForRestart(), AggregateError)
  assert.ok(f.rows().every((row) => !row.closed))
  assert.equal(await fresh.store.read(f.execution()), undefined)
  assert.equal(f.state.closes, 1, 'a close of generation 2 cannot prove generation 1 closed')
  f.terminal()
  await assert.rejects(f.cold().coordinator.cancelRun(f.execution().runId, f.owner), AggregateError)
  assert.equal(f.state.finalized, false)
})

it('BE-001 graceful restart: a newer generation appearing during close fences the obsolete disposer', async () => {
  const f = fixture(), first = f.cold()
  await first.coordinator.attachOwnedSession(f.context(), f.session)
  f.beforeClose(async () => { await f.cold().store.begin(f.execution()) })
  await assert.rejects(first.coordinator.closeForRestart(), AggregateError)
  assert.equal(f.rows().length, 2); assert.ok(f.rows().every((row) => !row.closed))
  assert.equal(f.state.finalizationWrites, 0)
})
