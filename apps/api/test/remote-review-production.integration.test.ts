import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DurableInteractionSchema, GetInteractionResponseSchema, ReviewJobSchema } from '@graphql/contracts'
import { RemoteOperationReceiptSchema, RemoteOwnerControlSchema } from '@graphql/contracts/remote-execution'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'

type Fixture = Awaited<ReturnType<typeof remoteReviewProduction>>

async function reviewInProgress(fixture: Fixture) {
  const started = await fixture.start()
  const interaction = await waitForRemoteReview(async () => {
    await fixture.reconcile()
    return (await fixture.pending(started.run.id))[0]
  }, value => value !== undefined, 'routed native interaction')
  if (!interaction) throw new Error('The requester has no pending interaction.')
  const job = await waitForRemoteReview(async () => {
    await fixture.reconcile()
    const row = (await fixture.db.pool.query<{ record: unknown }>(
      'select record from review_jobs where interaction_id=$1', [interaction.id])).rows[0]
    return row ? ReviewJobSchema.parse(row.record) : undefined
  }, value => value?.state === 'acknowledged', 'authenticated remote review submission')
  if (!job) throw new Error('The retained reviewer has no submitted review job.')
  const executions = await fixture.executions(started.run.id)
  const reviewer = executions.find(execution => execution.agentId === job.reviewerAgentId)
  const requester = executions.find(execution => execution.id === interaction.executionId)
  if (!reviewer || !requester) throw new Error('The Run is missing its native execution identities.')
  const owners = fixture.registry.snapshot().launches.filter(launch => launch.lifecycle === 'active'
    && [reviewer.id, requester.id].some(executionId => launch.owner === `execution:${executionId}`))
  expect(owners).toHaveLength(2)
  for (const owner of owners) {
    expect(owner.guardian).toBeDefined()
    expect(owner.provider).toBeDefined()
    expect(owner.boundary?.kind).toBe('cgroup-v2')
  }
  return { run: started.run, interaction, job, reviewer, requester, owners }
}

async function readInteraction(fixture: Fixture, interactionId: string) {
  return GetInteractionResponseSchema.parse(await fixture.value('interaction_get', { interactionId })).interaction
}

async function deliveredReview(fixture: Fixture, interactionId: string) {
  const interaction = await waitForRemoteReview(async () => {
    await fixture.reconcile()
    return readInteraction(fixture, interactionId)
  }, value => value.deliveryState === 'delivered', 'persisted native decision delivery')
  const job = await waitForRemoteReview(async () => {
    await fixture.reconcile()
    const row = (await fixture.db.pool.query<{ record: unknown }>(
      'select record from review_jobs where interaction_id=$1', [interactionId])).rows[0]!
    return ReviewJobSchema.parse(row.record)
  }, value => value.state === 'completed', 'persisted completed remote review')
  expect(interaction.selectedSemantic).toBe('approve_once')
  expect(interaction.deliveredAt).toBeDefined()
  expect(job.providerTurnOrMessageId).toBeDefined()
  expect(job.completedAt).toBeDefined()
  return { interaction, job }
}

async function receipts(fixture: Fixture, runId: string) {
  const rows = await fixture.db.pool.query<{ receipt: unknown }>(`select r.receipt
    from remote_execution_receipts r join execution_dispatch_intents i on i.operation_id=r.operation_id
    where i.run_id=$1 order by i.execution_id`, [runId])
  return rows.rows.map(row => RemoteOperationReceiptSchema.parse(row.receipt))
}

describe('production remote review and native recovery through authenticated MCP', () => {
  it('persists a delivered remote decision and denies a read-only caller on the same product endpoint', async () => {
    const fixture = await remoteReviewProduction()
    try {
      const active = await reviewInProgress(fixture)
      const reader = await fixture.access.issue({ name: 'Remote review reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 300_000), grants: [{ actions: ['interactions:read'],
          scope: { runIds: [active.run.id] } }] })
      const read = await fixture.call('interaction_get', { interactionId: active.interaction.id }, reader.token)
      expect(read.isError).not.toBe(true)
      const before = await new PostgresInteractionRepository(fixture.db.pool).get(active.interaction.id)
      const option = active.interaction.responseOptions.find(option => option.semantic === 'approve_once')!
      const denied = await fixture.call('interaction_respond', { interactionId: active.interaction.id,
        optionId: option.optionId, expectedRevision: active.interaction.revision }, reader.token)
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ROLE_NOT_ALLOWED')
      expect(await new PostgresInteractionRepository(fixture.db.pool).get(active.interaction.id)).toEqual(before)
      expect((await fixture.provider.calls()).filter(call => 'approvalResponse' in call)).toHaveLength(0)
      await fixture.provider.releaseReview()
      const delivered = await deliveredReview(fixture, active.interaction.id)
      const persisted = await new PostgresInteractionRepository(fixture.db.pool).get(active.interaction.id)
      expect(persisted).toEqual(delivered.interaction)
      expect((await fixture.provider.calls()).filter(call => 'approvalResponse' in call)).toHaveLength(1)
      expect(delivered.job.nativeSessionId).toBe(active.reviewer.nativeSessionId)
      const entry = (await receipts(fixture, active.run.id)).find(receipt => receipt.intent.executionId === active.reviewer.id)!
      expect(entry.native?.sessionId).toBe(active.reviewer.nativeSessionId)
      expect(entry.reviewTurns).toContainEqual(expect.objectContaining({
        assignment: expect.objectContaining({ jobId: active.job.id, correlationId: active.job.correlationId }),
        providerId: delivered.job.providerTurnOrMessageId, settled: true,
      }))
    } finally { await fixture.close() }
  }, 240_000)

  it('continues credential maintenance and the retained review after Main crashes with the Worker still alive', async () => {
    const fixture = await remoteReviewProduction()
    try {
      const active = await reviewInProgress(fixture)
      const beforeInventory = await fixture.inventory()
      const originalWorkerPid = fixture.workerPid()
      const originalLaunches = active.owners.map(owner => ({
        owner: owner.owner, launchId: owner.launchId, guardian: owner.guardian, provider: owner.provider, boundary: owner.boundary,
      }))
      const ownerLaunchIds = fixture.registry.snapshot().launches.filter(owner => originalLaunches.some(
        original => original.owner === owner.owner)).map(owner => owner.launchId).sort()
      const originalReceipts = await receipts(fixture, active.run.id)
      await fixture.restartMain()
      const inventory = await waitForRemoteReview(fixture.inventory, value => {
        const original = beforeInventory.hostMetadata?.connection?.binding
        const current = value.hostMetadata?.connection?.binding
        return !!current && !!original && current.connectionEpoch !== original.connectionEpoch
      }, 'replacement authenticated inventory generation')
      expect(inventory.installations[0]?.connectionGeneration)
        .not.toBe(beforeInventory.installations[0]?.connectionGeneration)
      expect(fixture.workerPid()).toBe(originalWorkerPid)
      await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return receipts(fixture, active.run.id)
      }, value => value.some(receipt => originalReceipts.some(original =>
        original.intent.operationId === receipt.intent.operationId
        && (original.intent.owner.epoch !== receipt.intent.owner.epoch
          || original.intent.owner.grantId !== receipt.intent.owner.grantId))),
      'new Main owner for the original native process')
      const reconnected = fixture.registry.snapshot().launches.filter(owner => originalLaunches.some(
        original => original.launchId === owner.launchId))
      expect(reconnected.map(owner => ({ owner: owner.owner, launchId: owner.launchId,
        guardian: owner.guardian, provider: owner.provider, boundary: owner.boundary }))).toEqual(originalLaunches)
      expect(reconnected.every(owner => owner.lifecycle === 'active')).toBe(true)
      await waitForRemoteReview(async () => {
        await fixture.reconcile()
        const row = (await fixture.db.pool.query<{ record: unknown }>(
          'select record from review_jobs where id=$1', [active.job.id])).rows[0]!
        return ReviewJobSchema.parse(row.record)
      }, value => value.attempt > active.job.attempt && value.state === 'acknowledged',
      'replacement Main review lease and original process credential rebinding')
      // Retained review renewal runs every ten seconds; wait beyond one interval
      // before using the original process credential to deliver the decision.
      await new Promise(resolve => setTimeout(resolve, 11_000))
      await fixture.reconcile()
      await fixture.provider.releaseReview()
      const delivered = await deliveredReview(fixture, active.interaction.id)
      expect(delivered.job.nativeSessionId).toBe(active.job.nativeSessionId)
      expect(delivered.job.providerTurnOrMessageId).toBe(active.job.providerTurnOrMessageId)
      expect((await fixture.provider.calls()).filter(call => 'approvalResponse' in call)).toHaveLength(1)
      const starts = (await fixture.provider.calls()).filter(call => call.method === 'turn/start'
        && call.correlationId === active.job.correlationId)
      expect(starts).toHaveLength(1)
      expect(fixture.registry.snapshot().launches.filter(owner => originalLaunches.some(
        original => original.owner === owner.owner)).map(owner => owner.launchId).sort())
        .toEqual(ownerLaunchIds)
    } finally { await fixture.close() }
  }, 240_000)

  it('settles the original native owners after an installed Worker crash without launching a replacement', async () => {
    const fixture = await remoteReviewProduction()
    try {
      const active = await reviewInProgress(fixture)
      const originalReceipts = await receipts(fixture, active.run.id)
      const ownerLaunchIds = fixture.registry.snapshot().launches.filter(owner => active.owners.some(
        original => original.owner === owner.owner)).map(owner => owner.launchId).sort()
      const workerPid = fixture.workerPid()
      await fixture.restartWorker()
      expect(fixture.workerPid()).not.toBe(workerPid)
      await fixture.value('run_stop', { workspaceId: active.run.workspaceId,
        runId: active.run.id, commandId: randomUUID() })
      const settled = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return receipts(fixture, active.run.id)
      }, value => value.length === originalReceipts.length && value.every(receipt => receipt.phase === 'confirmed_terminal'),
      'positive original native closure after Worker restart')
      for (const receipt of settled) {
        const original = originalReceipts.find(value => value.intent.operationId === receipt.intent.operationId)!
        expect(receipt.native).toEqual(original.native)
        expect(receipt.terminal?.closureEvidenceDigest).toMatch(/^[a-f0-9]{64}$/)
      }
      const closed = fixture.registry.snapshot().launches.filter(owner => active.owners.some(
        original => original.launchId === owner.launchId))
      expect(closed.map(owner => owner.launchId).sort()).toEqual(active.owners.map(owner => owner.launchId).sort())
      expect(closed.every(owner => owner.lifecycle === 'closed' && owner.closureEvidence === 'cgroup_v2_empty')).toBe(true)
      expect(fixture.registry.snapshot().launches.filter(owner => active.owners.some(
        original => original.owner === owner.owner)).map(owner => owner.launchId).sort()).toEqual(ownerLaunchIds)
      const detail = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return fixture.details(active.run.id)
      }, value => value.run.executionState === 'completed', 'settled Run after original worker closure')
      expect(detail.run.outcome).toBe('canceled')
      expect((await fixture.provider.calls()).filter(call => call.method === 'turn/start'
        && call.correlationId === active.job.correlationId)).toHaveLength(1)
    } finally { await fixture.close() }
  }, 240_000)

  it('retries the same reserved decision through authenticated MCP after a post-reservation authorization failure', async () => {
    const fixture = await remoteReviewProduction()
    try {
      const active = await reviewInProgress(fixture)
      fixture.denyNextReservedResponse()
      await fixture.provider.releaseReview()
      const repository = new PostgresInteractionRepository(fixture.db.pool)
      const uncertain = await waitForRemoteReview(() => repository.get(active.interaction.id),
        value => value?.deliveryState === 'uncertain', 'persisted uncertain approval after actual Main authorization denial')
      expect(uncertain?.selectedSemantic).toBe('approve_once')
      const command = fixture.deniedResponse()
      expect(command).toBeDefined()
      const serialized = JSON.parse(await readFile(join(fixture.stateDirectory, 'workflow-operations.json'), 'utf8')) as {
        controlDeliveries: Array<{ operationId: string; commandId: string; phase: string }>
      }
      expect(serialized.controlDeliveries).toContainEqual({ operationId: command!.operationId,
        commandId: command!.commandId, phase: 'reserved' })
      const attempt = (await fixture.db.pool.query<{ remote_owner_control: unknown }>(
        'select remote_owner_control from interaction_delivery_attempts where interaction_id=$1 order by attempt desc limit 1',
        [active.interaction.id])).rows[0]!
      expect(RemoteOwnerControlSchema.parse(attempt.remote_owner_control)).toEqual(command)
      expect((await fixture.provider.calls()).filter(call => 'approvalResponse' in call)).toHaveLength(0)
      await fixture.restoreOriginalResponseGrant()
      await fixture.provider.retryReview()
      const delivered = await deliveredReview(fixture, active.interaction.id)
      expect(DurableInteractionSchema.parse((await fixture.value('interaction_get', {
        interactionId: active.interaction.id,
      }) as { interaction: unknown }).interaction)).toEqual(delivered.interaction)
      const receipt = (await receipts(fixture, active.run.id)).find(receipt => receipt.intent.executionId === active.requester.id)!
      expect(receipt.controls.filter(control => control.action.kind === 'respond')).toEqual([command])
      expect(fixture.deliveryReads).toContainEqual({ command, phase: 'reserved' })
      expect((await fixture.provider.calls()).filter(call => 'approvalResponse' in call)).toHaveLength(1)
    } finally { await fixture.close() }
  }, 240_000)
})
