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
import { PostgresWorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { Wave25InteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { CANCELED_INTERACTION_RETIRED_SQL } from '../src/modules/interactions/wave25/publication.js'
import type { ExecutionCredentialProvider } from '../src/modules/harnesses/mcpDetection.js'
import { assertMeaningfulSaveAdmitted, readAffectedGraphRuns } from '../src/modules/graph-drafts/saveAdmission.js'
import { DeterministicNativeSessionManager } from '../src/testing/deterministicNativeSession.js'
import { agent3Database, seedAgent3, candidateFor, postgresEnabled } from './helpers/wave25Agent3.js'

class StopNative extends DeterministicNativeSessionManager {
  closeCalls = 0
  failClose = false
  beforeClose: () => Promise<void> = async () => undefined
  override async close(session: NativeSessionReference): Promise<void> {
    this.closeCalls++
    await this.beforeClose()
    if (this.failClose) throw new Error('BE-001 restart synthetic native closure remains uncertain')
    await super.close(session)
  }
}

/** Real isolated PostgreSQL, production coordinator/engine/settlement/retirement
 * and the unchanged meaningful-save predicate. Native I/O is explicitly synthetic;
 * no provider, MCP server, browser, external credentials or local service starts.
 * This suite must be explicitly enabled by the shell orchestrator. */
describe.skipIf(!postgresEnabled)('NIM-2644-BE-001 restart closure receipts (synthetic native / non-Linux branch)', () => {
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
    const credentials = { async prepare() {
      // No provider is involved. The real receipt must already exist at this
      // boundary, before a production OpenCode preflight could start a process.
      const count = await db.pool.query<{ count: string }>(
        'select count(*)::text as count from execution_native_closures where execution_id=$1 and closed_at is null', [execution.id])
      assert.equal(count.rows[0]!.count, '1')
      return { credential: { principalId: issued.principal.id, expiresAt: issued.principal.expiresAt,
        environment: { agentId: execution.agentId, variables: {} } } }
    }, async revokeForExecution(id: string) {
      assert.equal(id, execution.id)
      await revocation.before()
      if (revocation.skip) return
      await credentialService.revokeForExecution(id)
    } } as unknown as ExecutionCredentialProvider
    let nonLinuxCalls = 0
    const recover = (executionId: string, signal: AbortSignal) => {
      // Execute the ACTUAL non-Linux early-return branch, not a successful
      // recovery stub. Restore synchronously; no spawn or filesystem occurs.
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { ...descriptor, value: 'darwin' })
      try {
        nonLinuxCalls++
        return new NativeProcessRegistry(join(db.directory, 'unused-nonlinux-registry')).closeOwner(`execution:${executionId}`, signal)
      } finally { Object.defineProperty(process, 'platform', descriptor) }
    }
    const resolver = new ExecutionScopedNativeSessionManagerResolver(() => manager)
    const closureStore = new PostgresWorkflowClosureStore(db.pool)
    const coordinator = new ApprovalExecutionCoordinator(runs, interactions, budgets, resolver, 60_000, credentials,
      undefined, recover, closureStore)
    // Setup attachment only, BEFORE Stop: exercise the real preflight registration
    // and existing native lane. The recovery path below may NEVER attach again.
    await coordinator.attachOwnedSession({ executionId: execution.id, agentId: execution.agentId,
      harness: session.harness, workingDirectory: execution.workingDirectory! }, session)
    const cold = () => {
      const freshWorkflows = new PostgresWorkflowRepository(db.pool)
      const freshLocations = new WorkspaceLocationService(db.pool, new PostgresCommandCoordinator(db.pool), db.directory)
      const freshRuns = new PostgresRunRepository(db.pool, freshWorkflows, freshLocations)
      const freshInteractions = new Wave25InteractionRepository(db.pool)
      const freshNative = new StopNative('codex')
      const freshResolver = new ExecutionScopedNativeSessionManagerResolver(() => freshNative)
      const freshCoordinator = new ApprovalExecutionCoordinator(freshRuns, freshInteractions,
        new PostgresApprovalBudgetRepository(db.pool), freshResolver, 60_000, credentials, undefined, recover,
        new PostgresWorkflowClosureStore(db.pool))
      const freshEngine = new LangGraphWorkflowEngine(freshRuns, freshWorkflows, freshCoordinator, new MemorySaver(),
        db.directory, freshLocations, undefined, freshInteractions)
      assert.deepEqual(freshCoordinator.residentRunIds(), [])
      return { engine: freshEngine, coordinator: freshCoordinator, native: freshNative, resolver: freshResolver,
        runs: freshRuns, interactions: freshInteractions }
    }
    const cut = async () => {
      await runs.requestStop(f.run.id)
      await runs.requestCleanup(f.run.id)
      let error: unknown
      try { await coordinator.cancelRun(f.run.id) } catch (caught) { error = caught }
      const terminalOwner = await runs.acquireOwnership(f.run.id, () => undefined)
      assert.ok(terminalOwner)
      try { await runs.oneShot(terminalOwner).settleRun(true) } finally { await terminalOwner.release() }
      // Deliberate crash cut: no owner-fenced finalization and no cleanup clear.
      assert.equal((await runs.get(f.run.id))?.executionState, 'completed')
      assert.equal((await runs.getExecution(execution.id))?.state, 'completed')
      assert.equal(await runs.hasPendingCleanup(f.run.id), true)
      return error
    }
    const closureRows = async () => (await db.pool.query<{
      generation: string; execution_identity: unknown; expected_reference: unknown; closed_reference: unknown; closed_at: Date | null
    }>(`select generation::text,execution_identity,expected_reference,closed_reference,closed_at
      from execution_native_closures where execution_id=$1 order by generation`, [execution.id])).rows
    const scope = { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, stagedAgentIds: [] }
    const finalizedAt = async () => (await db.pool.query<{ at: Date | null }>(
      'select workflow_finalized_at as at from execution_native_sessions where execution_id=$1', [execution.id])).rows[0]!.at
    const blocked = async () => assert.rejects(assertMeaningfulSaveAdmitted(db.pool, scope), { code: 'WORKFLOW_RUNS_UNSETTLED' })
    const retired = async () => (await db.pool.query<{ retired: boolean }>(
      `select (${CANCELED_INTERACTION_RETIRED_SQL}) as retired from durable_interactions i where i.id=$1`, [interactionId])).rows[0]!.retired
    return { f, runs, coordinator, interactions, manager, revocation, scope, execution, session, interactionId,
      cold, cut, closureRows, closureStore, nonLinuxCalls: () => nonLinuxCalls,
      principalId: issued.principal.id, finalizedAt, blocked, retired }
  }

  function noNativeRecoveryCalls(fresh: { native: StopNative }) {
    assert.deepEqual(fresh.native.counters, { sessions: 0, attaches: 0, turns: 0, sideEffects: 0, deliveries: 0, cancellations: 0 })
    assert.equal(fresh.native.closeCalls, 0)
  }

  it('recovers after close + terminal settlement with fresh coordinator, resolver, repositories and Run owner; save admits only afterward', async () => {
    const f = await waitingFixture()
    await f.blocked()
    assert.equal(await f.cut(), undefined)
    const rows = await f.closureRows()
    assert.equal(rows.length, 1); assert.ok(rows[0]!.closed_at)
    assert.deepEqual(rows[0]!.closed_reference, f.session)
    assert.equal(await f.finalizedAt(), null); await f.blocked()
    assert.equal(await f.retired(), true)
    const oldNative = { ...f.manager.counters }, oldCloses = f.manager.closeCalls
    const fresh = f.cold()
    assert.equal(await fresh.engine.cancel(f.f.run.id), true)
    const timestamp = await f.finalizedAt(); assert.ok(timestamp)
    assert.equal(await fresh.runs.hasPendingCleanup(f.f.run.id), false)
    assert.equal((await fresh.runs.get(f.f.run.id))?.outcome, 'canceled')
    await assertMeaningfulSaveAdmitted(db.pool, f.scope)
    assert.equal((await readAffectedGraphRuns(db.pool, f.scope))[0]!.settled, true)
    const resource = (await db.pool.query<{ revoked: boolean }>(`select b.revoked_at is not null and p.revoked_at is not null as revoked
      from worker_credential_bindings b join management_principals p on p.id=b.principal_id where b.principal_id=$1`, [f.principalId])).rows[0]
    assert.equal(resource?.revoked, true)
    noNativeRecoveryCalls(fresh)
    assert.deepEqual(f.manager.counters, oldNative); assert.equal(f.manager.closeCalls, oldCloses)
    const again = f.cold()
    await again.engine.cancel(f.f.run.id)
    assert.equal((await f.finalizedAt())!.getTime(), timestamp.getTime())
    assert.equal((await f.closureRows())[0]!.closed_at!.getTime(), rows[0]!.closed_at!.getTime())
    noNativeRecoveryCalls(again)
  }, 30_000)

  it('keeps uncertain closure pending on the actual non-Linux recovery branch despite terminal Run and execution', async () => {
    const f = await waitingFixture(); f.manager.failClose = true
    assert.ok(await f.cut() instanceof AggregateError)
    assert.equal((await f.closureRows())[0]!.closed_at, null)
    const fresh = f.cold()
    await assert.rejects(fresh.engine.cancel(f.f.run.id), AggregateError)
    assert.ok(f.nonLinuxCalls() > 0)
    assert.equal(await f.finalizedAt(), null); assert.equal(await f.retired(), false)
    assert.equal(await f.runs.hasPendingCleanup(f.f.run.id), true); await f.blocked()
    noNativeRecoveryCalls(fresh)
  }, 30_000)

  it('missing pre-upgrade receipts are not synthesized from a terminal record or empty non-Linux registry', async () => {
    const f = await waitingFixture()
    assert.equal(await f.cut(), undefined)
    // Explicit isolated legacy-data fixture: no proof existed before this upgrade.
    await db.pool.query('delete from execution_native_closures where execution_id=$1', [f.execution.id])
    const fresh = f.cold()
    await assert.rejects(fresh.engine.cancel(f.f.run.id), AggregateError)
    assert.ok(f.nonLinuxCalls() > 0)
    assert.equal(await f.finalizedAt(), null); await f.blocked(); noNativeRecoveryCalls(fresh)
    assert.equal((await f.closureRows()).length, 0)
  }, 30_000)

  it('rejects a mismatched positive receipt on non-Linux; immutable evidence cannot be rewritten to repair it', async () => {
    const f = await waitingFixture()
    assert.equal(await f.cut(), undefined)
    const original = (await f.closureRows())[0]!
    await assert.rejects(db.pool.query(`update execution_native_closures set closed_reference=$2::jsonb where generation=$1`,
      [original.generation, JSON.stringify({ ...f.session, nativeSessionId: 'not-this-session' })]), /NATIVE_WORKFLOW_CLOSURE_IMMUTABLE/)
    // A deliberately corrupt INSERT from outside the production writer: read-side
    // identity validation must fail even if every business outcome is terminal.
    await db.pool.query(`insert into execution_native_closures
      (execution_id,execution_identity,expected_reference,closed_reference,closed_at) values($1,$2::jsonb,$3::jsonb,$4::jsonb,clock_timestamp())`,
    [f.execution.id, JSON.stringify(original.execution_identity), JSON.stringify(original.expected_reference),
      JSON.stringify({ ...f.session, nativeSessionId: 'not-this-session' })])
    const fresh = f.cold()
    await assert.rejects(fresh.engine.cancel(f.f.run.id), AggregateError)
    assert.ok(f.nonLinuxCalls() > 0)
    assert.equal(await f.finalizedAt(), null); await f.blocked(); noNativeRecoveryCalls(fresh)
  }, 30_000)

  it('reconciles a synthetic lost reply AFTER the real close-receipt COMMIT without repeating native close', async () => {
    const f = await waitingFixture()
    const record = f.closureStore.record.bind(f.closureStore)
    f.closureStore.record = async (...args) => { await record(...args); throw new Error('Synthetic reply loss after real close COMMIT') }
    assert.ok(await f.cut() instanceof AggregateError)
    assert.ok((await f.closureRows())[0]!.closed_at)
    const fresh = f.cold()
    await fresh.engine.cancel(f.f.run.id)
    assert.ok(await f.finalizedAt()); await assertMeaningfulSaveAdmitted(db.pool, f.scope)
    assert.equal(f.manager.closeCalls, 1); noNativeRecoveryCalls(fresh)
  }, 30_000)

  it('a durable close receipt cannot bypass a missing credential revocation after restart', async () => {
    const f = await waitingFixture(); f.revocation.skip = true
    assert.ok(await f.cut())
    assert.ok((await f.closureRows())[0]!.closed_at)
    const fresh = f.cold()
    await assert.rejects(fresh.engine.cancel(f.f.run.id))
    assert.equal(await f.finalizedAt(), null); await f.blocked(); noNativeRecoveryCalls(fresh)
    f.revocation.skip = false
    await fresh.engine.cancel(f.f.run.id)
    assert.ok(await f.finalizedAt()); await assertMeaningfulSaveAdmitted(db.pool, f.scope)
    noNativeRecoveryCalls(fresh)
  }, 30_000)

  it('does not clear a genuinely unclosed earlier manager lifetime when a later same-session connection closes', async () => {
    const f = await waitingFixture()
    const prior = (await f.closureRows())[0]!
    assert.equal(prior.closed_at, null)
    // The original manager is deliberately neither closed nor disposed. Only a
    // DIFFERENT synthetic native connection closes below. This is not authority
    // about the first connection, despite matching execution/session identity.
    const generation = await f.closureStore.begin(f.execution)
    const successor = new StopNative('codex')
    const configuration = f.f.configurations.find((item) => item.id === f.execution.agentConfigurationVersionId)!
    await successor.attachSession(f.session, { request: {
      executionId: f.execution.id, runId: f.execution.runId, workspaceId: f.scope.workspaceId,
      workflowNodeId: f.execution.workflowNodeId, workingDirectory: f.execution.workingDirectory!,
      runtimeDirectory: f.execution.runtimeDirectory!, configuration, input: f.execution.input,
    } })
    await successor.close(f.session)
    assert.equal(f.manager.closeCalls, 0)
    await assert.rejects(f.closureStore.record(f.execution, f.session, generation, () => undefined),
      { code: 'NATIVE_WORKFLOW_CLOSURE_CONFLICT' })
    assert.ok((await f.closureRows()).every((row) => row.closed_at === null))
    assert.equal(await f.closureStore.read(f.execution), undefined)
    assert.ok(await f.cut() instanceof AggregateError)
    const fresh = f.cold()
    await assert.rejects(fresh.engine.cancel(f.f.run.id), AggregateError)
    assert.ok(f.nonLinuxCalls() > 0)
    assert.equal(await f.finalizedAt(), null)
    assert.equal(await f.runs.hasPendingCleanup(f.f.run.id), true)
    await f.blocked(); noNativeRecoveryCalls(fresh)
  }, 30_000)

})
