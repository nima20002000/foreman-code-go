import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { MemorySaver } from '@langchain/langgraph'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { DurableInteractionSchema, HarnessExecutionSchema, NATIVE_INTERACTION_FIXTURES,
  type NativeSessionReference } from '@graphql/contracts'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { WorkerCredentialService, APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../src/modules/access/workerCredentials.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { Wave25InteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { CANCELED_INTERACTION_RETIRED_SQL } from '../src/modules/interactions/wave25/publication.js'
import type { ExecutionCredentialProvider } from '../src/modules/harnesses/mcpDetection.js'
import { assertMeaningfulSaveAdmitted, readAffectedGraphRuns } from '../src/modules/graph-drafts/saveAdmission.js'
import { DeterministicNativeSessionManager } from '../src/testing/deterministicNativeSession.js'
import { agent3Database, seedAgent3, candidateFor, deferred, postgresEnabled } from './helpers/wave25Agent3.js'

class StopNative extends DeterministicNativeSessionManager {
  closeCalls = 0
  failClose = false
  beforeClose: () => Promise<void> = async () => undefined
  override async close(session: NativeSessionReference): Promise<void> {
    this.closeCalls++
    await this.beforeClose()
    if (this.failClose) throw new Error('BE-001 synthetic native closure remains uncertain')
    await super.close(session)
  }
}

/** Real isolated PostgreSQL, production coordinator/engine/settlement/retirement
 * and the unchanged meaningful-save predicate. Native I/O is explicitly synthetic;
 * no provider, MCP server, browser, external credentials or local service starts.
 * This suite must be explicitly enabled by the shell orchestrator. */
describe.skipIf(!postgresEnabled)('NIM-2644-BE-001 Stop releases meaningful-save admission', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => { db = await agent3Database() }, 60_000)
  afterAll(async () => { await db?.close() })

  async function waitingFixture() {
    const f = await seedAgent3(db.pool, db.directory)
    const workflows = new PostgresWorkflowRepository(db.pool)
    const locations = new WorkspaceLocationService(db.pool, new PostgresCommandCoordinator(db.pool), db.directory)
    const runs = new PostgresRunRepository(db.pool, workflows, locations)
    const interactions = new Wave25InteractionRepository(db.pool)
    const budgets = new PostgresApprovalBudgetRepository(db.pool)
    const manager = new StopNative('codex')
    const owner = await runs.acquireOwnership(f.run.id, () => undefined)
    assert.ok(owner)
    let execution = candidateFor(f)
    const session: NativeSessionReference = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: `native-${randomUUID()}` }
    let interactionId = ''
    try {
      const store = runs.oneShot(owner)
      await store.updateRun({ executionState: 'running', outcome: 'pending', startedAt: new Date().toISOString() })
      const admitted = await store.admit(execution.workflowNodeId, () => execution)
      assert.equal(admitted.kind, 'admitted')
      assert.ok(admitted.kind === 'admitted')
      const claimed = await store.claimLaunch(execution.id, {
        workingDirectory: db.directory, runtimeDirectory: join(db.directory, execution.id),
      })
      assert.ok(claimed)
      execution = claimed
      const configuration = f.configurations.find((item) => item.id === execution.agentConfigurationVersionId)!
      await manager.attachSession(session, { request: {
        executionId: execution.id, runId: f.run.id, workspaceId: f.scope.workspaceId,
        workflowNodeId: execution.workflowNodeId, workingDirectory: execution.workingDirectory!,
        runtimeDirectory: execution.runtimeDirectory!, configuration, input: execution.input,
      } })
      await interactions.coordination.ensureLane({ id: `lane-${randomUUID()}`,
        harness: session.harness, nativeSessionId: session.nativeSessionId, ownerAgentId: execution.agentId,
        revision: 0, observedStatus: 'idle', connectionGeneration: 0, observedAt: new Date().toISOString() })
      await interactions.coordination.bindWorkflowSession(execution.id, session)
      execution = HarnessExecutionSchema.parse({ ...execution, nativeSessionId: session.nativeSessionId, state: 'waiting' })
      await store.updateExecution(execution)
      await budgets.ensure(execution.id, f.run.id, 60_000)
      await budgets.beginWait(execution.id)
      for await (const event of manager.startTurn(session, { prompt: 'Synthetic BE-001 approval wait', clientCorrelationId: f.run.id })) {
        void event; break
      }
      const pending = await manager.pending(session)
      assert.ok(pending?.turn.nativeRequestId)
      interactionId = `be001-interaction-${randomUUID()}`
      await interactions.create(DurableInteractionSchema.parse({ ...NATIVE_INTERACTION_FIXTURES.codex,
        id: interactionId, workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
        runId: f.run.id, executionId: execution.id, requestingAgentId: execution.agentId,
        approval: { handler: 'user' }, graphThreadId: f.run.id, graphInterruptId: `interrupt-${interactionId}`,
        harness: session.harness, providerVersion: session.providerVersion, nativeSessionId: session.nativeSessionId,
        nativeRequestId: pending.turn.nativeRequestId, nativeRequestType: pending.nativeRequestType,
        request: pending.request, responseOptions: pending.responseOptions,
      }))
      await store.updateRun({ executionState: 'waiting', outcome: 'pending' })
    } finally { await owner.release() }

    // Synthetic persisted Worker binding. Tokens are never sent to a native
    // process, logged or stored in the handoff; no production authority is used.
    const issued = await new PostgresAccessService(db.pool).issue({
      name: 'BE-001 isolated test Worker', audience: 'worker', agentId: execution.agentId,
      grants: [{ actions: ['interactions:read'], scope: { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId], runIds: [f.run.id] } }],
      expiresAt: new Date(Date.now() + 300_000),
    })
    await db.pool.query(`insert into worker_credential_bindings
      (principal_id,execution_id,run_id,agent_id,workspace_id,workflow_id,environment_variable,purpose)
      values($1,$2,$3,$4,$5,$6,$7,'workflow')`,
    [issued.principal.id, execution.id, f.run.id, execution.agentId, f.scope.workspaceId, f.scope.workflowId, APP_MCP_TOKEN_ENVIRONMENT_VARIABLE])
    const revocation: { before: () => Promise<void>; skip: boolean } = { before: async () => undefined, skip: false }
    const credentialService = new WorkerCredentialService(db.pool, new PostgresAccessService(db.pool))
    const credentials = { async revokeForExecution(id: string) {
      assert.equal(id, execution.id)
      await revocation.before()
      if (revocation.skip) return
      await credentialService.revokeForExecution(id)
    } } as unknown as ExecutionCredentialProvider
    const resolver = new ExecutionScopedNativeSessionManagerResolver(() => manager)
    const configuration = f.configurations.find((item) => item.id === execution.agentConfigurationVersionId)!
    const resident = resolver.resolve({ executionId: execution.id, agentId: execution.agentId,
      harness: 'codex', workingDirectory: execution.workingDirectory!, configuration })
    resident.beginStart!(); resident.markResident!()
    const coordinator = new ApprovalExecutionCoordinator(runs, interactions, budgets, resolver, 60_000, credentials)
    const engine = new LangGraphWorkflowEngine(runs, workflows, coordinator, new MemorySaver(), db.directory, locations, undefined, interactions)
    const scope = { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, stagedAgentIds: [] }
    const finalizedAt = async () => (await db.pool.query<{ at: Date | null }>(
      'select workflow_finalized_at as at from execution_native_sessions where execution_id=$1', [execution.id])).rows[0]!.at
    const blocked = async () => assert.rejects(assertMeaningfulSaveAdmitted(db.pool, scope), { code: 'WORKFLOW_RUNS_UNSETTLED' })
    const retired = async () => (await db.pool.query<{ retired: boolean }>(
      `select (${CANCELED_INTERACTION_RETIRED_SQL}) as retired from durable_interactions i where i.id=$1`, [interactionId])).rows[0]!.retired
    return { f, runs, engine, coordinator, interactions, manager, revocation, scope, execution, session, interactionId,
      principalId: issued.principal.id, finalizedAt, blocked, retired }
  }

  it('keeps save blocked across close, credential and retirement boundaries, then admits a meaningful save', async () => {
    const f = await waitingFixture()
    const closeEntered = deferred(), closeRelease = deferred(), revokeEntered = deferred(), revokeRelease = deferred()
    const reviewEntered = deferred(), reviewRelease = deferred()
    f.manager.beforeClose = async () => { closeEntered.resolve(); await closeRelease.promise }
    f.revocation.before = async () => { revokeEntered.resolve(); await revokeRelease.promise }
    const finishReviews = f.interactions.coordination.finishStoppedReviews.bind(f.interactions.coordination)
    f.interactions.coordination.finishStoppedReviews = async (...args) => {
      reviewEntered.resolve(); await reviewRelease.promise
      return finishReviews(...args)
    }
    await f.blocked()
    assert.equal(await f.finalizedAt(), null)
    const stopping = f.engine.cancel(f.f.run.id)
    // Observe rejection immediately, even if a pre-boundary fixture fails.
    void stopping.catch(() => undefined)
    try {
      await Promise.race([closeEntered.promise, stopping.then(() => { throw new Error('Stop skipped native close') })])
      assert.equal(await f.finalizedAt(), null); await f.blocked()
      closeRelease.resolve()
      await Promise.race([revokeEntered.promise, stopping.then(() => { throw new Error('Stop skipped credential cleanup') })])
      assert.equal(await f.finalizedAt(), null); await f.blocked()
      revokeRelease.resolve()
      await Promise.race([reviewEntered.promise, stopping.then(() => { throw new Error('Stop skipped retirement') })])
      assert.equal(await f.finalizedAt(), null); assert.equal(await f.retired(), false); await f.blocked()
      reviewRelease.resolve()
      assert.equal(await stopping, true)
    } finally {
      closeRelease.resolve(); revokeRelease.resolve(); reviewRelease.resolve()
      await stopping.catch(() => undefined)
    }
    assert.equal((await f.runs.get(f.f.run.id))?.executionState, 'completed')
    assert.equal((await f.runs.get(f.f.run.id))?.outcome, 'canceled')
    assert.equal((await f.runs.getExecution(f.execution.id))?.result?.outcome, 'canceled')
    assert.equal(await f.runs.hasPendingCleanup(f.f.run.id), false)
    assert.equal((await f.interactions.get(f.interactionId))?.status, 'canceled')
    assert.equal(await f.retired(), true)
    const credential = (await db.pool.query<{ revoked: boolean }>(`select
      b.revoked_at is not null and p.revoked_at is not null and e.worker_credentials_closed_at is not null as revoked
      from worker_credential_bindings b join management_principals p on p.id=b.principal_id
      join harness_executions e on e.id=b.execution_id where b.principal_id=$1`, [f.principalId])).rows[0]
    assert.equal(credential?.revoked, true)
    const first = await f.finalizedAt(); assert.ok(first)
    await assertMeaningfulSaveAdmitted(db.pool, f.scope)
    const state = (await readAffectedGraphRuns(db.pool, f.scope))[0]!
    assert.equal(state.settled, true); assert.equal(state.nativePending, false)
    assert.deepEqual(f.manager.counters, { sessions: 0, attaches: 1, turns: 1, sideEffects: 1, deliveries: 0, cancellations: 1 })
    assert.equal(f.manager.closeCalls, 1)
    await f.engine.cancel(f.f.run.id)
    assert.equal((await f.finalizedAt())!.getTime(), first.getTime())
    assert.equal(f.manager.closeCalls, 1)
    assert.equal(f.manager.counters.deliveries, 0)
  }, 30_000)

  it('a terminal canceled Run with uncertain native close stays unfinalized and blocks save, then safely retries', async () => {
    const f = await waitingFixture(); f.manager.failClose = true
    await assert.rejects(f.engine.cancel(f.f.run.id), AggregateError)
    assert.equal((await f.runs.get(f.f.run.id))?.executionState, 'completed')
    assert.equal((await f.runs.getExecution(f.execution.id))?.result?.outcome, 'canceled')
    assert.equal(await f.finalizedAt(), null)
    assert.equal(await f.runs.hasPendingCleanup(f.f.run.id), true)
    assert.equal(await f.retired(), false)
    await f.blocked()
    f.manager.failClose = false
    await f.engine.cancel(f.f.run.id)
    assert.ok(await f.finalizedAt()); await assertMeaningfulSaveAdmitted(db.pool, f.scope)
    assert.equal(f.manager.counters.attaches, 1); assert.equal(f.manager.counters.turns, 1)
    assert.equal(f.manager.counters.deliveries, 0)
  }, 30_000)

  it('keeps finalization pending when the reviewer/interaction cleanup publication fails after native close', async () => {
    const f = await waitingFixture()
    const finishReviews = f.interactions.coordination.finishStoppedReviews.bind(f.interactions.coordination)
    f.interactions.coordination.finishStoppedReviews = async () => { throw new Error('BE-001 synthetic review cleanup publication failure') }
    await assert.rejects(f.engine.cancel(f.f.run.id), /review cleanup publication failure/)
    assert.equal(f.manager.closeCalls, 1)
    assert.equal(await f.finalizedAt(), null); assert.equal(await f.retired(), false)
    assert.equal(await f.runs.hasPendingCleanup(f.f.run.id), true); await f.blocked()
    f.interactions.coordination.finishStoppedReviews = finishReviews
    await f.engine.cancel(f.f.run.id)
    assert.ok(await f.finalizedAt()); assert.equal(await f.retired(), true)
    await assertMeaningfulSaveAdmitted(db.pool, f.scope)
    assert.equal(f.manager.closeCalls, 1)
  }, 30_000)

  it('successful close and a no-op credential cleanup cannot fabricate workflow finalization', async () => {
    const f = await waitingFixture(); f.revocation.skip = true
    await assert.rejects(f.engine.cancel(f.f.run.id))
    assert.equal(f.manager.closeCalls, 1)
    assert.equal(await f.finalizedAt(), null); await f.blocked()
    assert.equal(await f.runs.hasPendingCleanup(f.f.run.id), true)
    f.revocation.skip = false
    await f.engine.cancel(f.f.run.id)
    assert.ok(await f.finalizedAt()); await assertMeaningfulSaveAdmitted(db.pool, f.scope)
    assert.equal(f.manager.closeCalls, 1)
  }, 30_000)
})
