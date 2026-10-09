import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/wave25'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { MaterializationReservationCleanup } from '../src/modules/sources/materializationReservationCleanup.js'
import type { SourceReservation } from '../src/modules/sources/reservations.js'

it('saves a completed computer workflow using each accepted native directory and rejects changed execution directories', async () => {
  const fixture = await remoteReviewProduction({ workflow: 'sequential' })
  try {
    const started = await fixture.start()
    const details = await waitForRemoteReview(async () => {
      await fixture.reconcile()
      return fixture.details(started.run.id)
    }, value => value.run.executionState === 'completed' && !value.cleanupPending, 'completed remote workflow cleanup')
    expect(details.run.outcome).toBe('succeeded')
    expect(details.executions).toHaveLength(2)
    expect(details.executions.every(execution => execution.nativeSessionId
      && execution.workingDirectory !== details.run.executionLocation?.rootPath)).toBe(true)
    const scope = { workspaceId: details.run.workspaceId, workflowId: details.run.workflowId }
    const before = CurrentWorkflowReadResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope))
    const graph = structuredClone(before.version.definition)
    agentWorkflowNode(graph.nodes[0]).initialPrompt = 'Use the updated instructions on the next Run.'
    const input = { ...scope, commandId: randomUUID(), executionSemanticsVersion: 3,
      expectedRevision: before.revision, expectedWorkflowVersionId: before.version.id,
      expectedLocationRevision: details.run.executionLocation!.locationRevision,
      expectedAgentConfigurationVersionIds: before.version.agentConfigurationVersionIds, graph }
    const reader = await fixture.access.issue({ name: 'Workflow read only', audience: 'operator',
      expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['workflows:read', 'graph:read'], scope: {} }] })
    const denied = await fixture.call(CURRENT_WORKFLOW_TOOLS.save, input, reader.token)
      .then(result => ({ result }), (error: unknown) => ({ error }))
    if ('error' in denied) expect(denied.error).toMatchObject({ code: -32602 })
    else expect(denied.result.isError).toBe(true)
    const saved = CurrentWorkflowSaveResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.save, input)).value
    expect(saved.version.id).not.toBe(details.run.workflowVersionId)
    expect(CurrentWorkflowReadResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope)).version)
      .toEqual(saved.version)
    expect((await fixture.details(started.run.id)).run).toEqual(details.run)

    const execution = details.executions[0]!
    const originalDirectory = execution.workingDirectory!
    await fixture.db.pool.query("update harness_executions set record=jsonb_set(record,'{workingDirectory}',to_jsonb($2::text)) where id=$1",
      [execution.id, '/different-execution-directory'])
    try {
      const changedGraph = structuredClone(saved.version.definition)
      agentWorkflowNode(changedGraph.nodes[0]).initialPrompt += ' Another edit.'
      await expect(fixture.value(CURRENT_WORKFLOW_TOOLS.save, { ...input, commandId: randomUUID(),
        expectedRevision: saved.revision, expectedWorkflowVersionId: saved.version.id, graph: changedGraph }))
        .rejects.toThrow('WORKFLOW_RUNS_UNSETTLED')
    } finally {
      await fixture.db.pool.query("update harness_executions set record=jsonb_set(record,'{workingDirectory}',to_jsonb($2::text)) where id=$1",
        [execution.id, originalDirectory])
    }
  } catch (error) {
    console.error('Computer workflow failure codes', fixture.failures())
    console.error('Computer workflow executions', (await fixture.db.pool.query(`select id,record->>'state' as state,
      record->'error' as error from harness_executions order by id`)).rows)
    console.error('Computer workflow cleanup', (await fixture.db.pool.query(`select r.id,r.execution_state,
      r.record->>'outcome' as outcome,
      exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending
      from runs r`)).rows)
    console.error('Computer workflow remote receipts', (await fixture.db.pool.query(`select
      receipt->'intent'->>'executionId' as execution_id,receipt->>'phase' as phase,
      receipt->'terminal' as terminal from remote_execution_receipts`)).rows)
    throw error
  } finally { await fixture.close() }
}, 240_000)

it('defers reservation cleanup without waiting on a Run that is preparing native execution', async () => {
  const fixture = await remoteReviewProduction({ workflow: 'sequential' })
  try {
    await fixture.provider.blockModels()
    let runId: string
    try {
      const started = await fixture.start()
      runId = started.run.id
      const reservation = await waitForRemoteReview(async () => {
        const result = await fixture.db.pool.query<{ record: SourceReservation }>(
          `select s.record from source_storage_reservations s
           join execution_dispatch_intents i on i.operation_id=s.owner_id
           where i.run_id=$1 and s.owner_kind='materialization' and s.state<>'reclaimed'`, [runId])
        return result.rows[0]?.record
      }, value => value !== undefined, 'the active workflow source reservation')
      if (!reservation) throw new Error('The workflow has no source reservation.')
      const owner = await RunOwnership.acquire(fixture.db.pool, runId, () => {})
      try { expect(owner).toBeUndefined() } finally { await owner?.release() }
      const transaction = await fixture.db.pool.connect()
      try {
        await transaction.query('begin')
        await transaction.query('select id from runs where id=$1 for update', [runId])
        const reclaim = vi.fn(async () => ({ closures: [] }))
        const cleanup = new MaterializationReservationCleanup(fixture.db.pool, reclaim)
        expect(await cleanup.reconcile()).toBe(0)
        expect(reclaim).not.toHaveBeenCalled()
        const retained = await transaction.query<{ state: string; record: SourceReservation }>(
          'select state,record from source_storage_reservations where reservation_id=$1', [reservation.reservationId])
        expect(retained.rows[0]?.state).not.toBe('reclaimed')
        expect(retained.rows[0]?.record.reclamation).toBeUndefined()
      } finally {
        try { await transaction.query('rollback') } finally { transaction.release() }
      }
    } finally {
      await fixture.provider.releaseModels()
    }
    const completed = await waitForRemoteReview(async () => {
      await fixture.reconcile()
      return fixture.details(runId)
    }, value => value.run.executionState === 'completed' && !value.cleanupPending, 'workflow completion after cleanup deferral')
    expect(completed.run.outcome).toBe('succeeded')
  } finally {
    await fixture.close()
  }
}, 240_000)
