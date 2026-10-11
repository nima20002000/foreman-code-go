import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, DurableInteractionSchema, GetInteractionResponseSchema,
  ReviewJobSchema, withAdvancedDefaults } from '@foreman-code/contracts'
import { RemoteOperationReceiptSchema, RemoteOwnerControlSchema } from '@foreman-code/contracts/remote-execution'
import { hasPositiveRemoteEntryClosure } from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { SourcePreparationSchema } from '@foreman-code/contracts/source-admission'
import { RunExecutionLocationV3Schema, SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { HarnessCatalogEntrySchema, HarnessCatalogResultSchema, HarnessDefaultsUpdateResultSchema,
  HarnessOptionsResultSchema, ManagedWorkspaceSchema, ManagementHarnessDefaultsSchema } from '@foreman-code/contracts/management'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { hasRetainedRemoteReviewerSource } from '../src/modules/interactions/retainedRemoteReviewer.js'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { buildRemoteReviewWorkerRelease } from './helpers/remoteReviewProvider.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

type Fixture = Awaited<ReturnType<typeof remoteReviewProduction>>

let releaseDirectory: string | undefined
let workerRelease: string

beforeAll(async () => {
  releaseDirectory = await privateFixtureDirectory('remote-review-release-')
  workerRelease = await buildRemoteReviewWorkerRelease(releaseDirectory)
}, 60_000)

afterAll(async () => {
  if (releaseDirectory) await rm(releaseDirectory, { recursive: true, force: true })
})

async function withRemoteReviewFixture(check: (fixture: Fixture) => Promise<void>,
  options: Parameters<typeof remoteReviewProduction>[0] = {}) {
  const fixture = await remoteReviewProduction({ ...options, workerRelease, parallelProfileChecks: true })
  try {
    await check(fixture)
  } catch (error) {
    console.error('Remote review production failure', error)
    console.error('Remote review production error codes', fixture.failures())
    console.error('Remote review jobs', (await fixture.db.pool.query(`select id,state,
      record->'error' as error,record->>'retryAfter' as retry_after,
      record->>'providerTurnOrMessageId' as provider_turn,record->>'attempt' as attempt,
      lease_expires_at>clock_timestamp() as lease_active from review_jobs order by created_at`)).rows)
    console.error('Remote review writer leases', (await fixture.db.pool.query(`select native_session_id,
      record->>'correlationId' as correlation,record->>'leaseToken' is not null as claimed,
      record->>'leaseExpiresAt' as expires_at from native_session_lanes`)).rows)
    console.error('Remote review credential fences', (await fixture.db.pool.query(`select b.execution_id,b.purpose,
      b.approval_review_lease_fence=j.lease_fence as current_job_fence
      from worker_credential_bindings b left join review_jobs j on j.id=b.approval_review_job_id`)).rows)
    console.error('Remote review interactions', (await fixture.db.pool.query(`select id,status,
      record->>'deliveryState' as delivery_state from durable_interactions`)).rows)
    console.error('Remote review delivery attempts', (await fixture.db.pool.query(`select interaction_id,attempt,state,error,
      approval_write_started_at is not null as write_started,remote_owner_control is not null as remote_reserved
      from interaction_delivery_attempts order by interaction_id,attempt`)).rows)
    console.error('Remote reviewer retention', (await fixture.db.pool.query(`select receipt->'intent'->>'executionId' as execution_id,
      receipt->>'phase' as phase,receipt->'retainedReviewer'->>'expiresAt' as retained_until,
      receipt->'terminal'->>'kind' as terminal,clock_timestamp() as observed_at from remote_execution_receipts`)).rows)
    console.error('Remote source reservations', (await fixture.db.pool.query(
      'select owner_id,state,reserved_bytes from source_storage_reservations order by reservation_id')).rows)
    const activity = (await fixture.provider.calls()).filter(call => call.method === undefined
      || call.method === 'turn/start' || call.method === 'turn/interrupt').slice(-30)
    console.error('Remote review provider activity', activity.map(call => ({
      method: call.method, nativeStarted: call.nativeStarted, review: call.review, providerFailure: call.providerFailure,
      reviewDecisionError: call.reviewDecisionError, approvalResponse: call.approvalResponse,
      reviewDecision: call.reviewDecision,
    })))
    try {
      await fixture.close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Remote review and fixture cleanup failed.', { cause: cleanupError })
    }
    throw error
  }
  await fixture.close()
}

async function reviewInProgress(fixture: Fixture) {
  const workspace = ManagedWorkspaceSchema.parse(await fixture.value('workspace_get', {
    workspaceId: fixture.version.definition.workspaceId,
  }))
  expect(workspace.workspace.repository).toMatchObject({ provider: 'github', defaultBranch: 'main' })
  expect(`${workspace.workspace.repository!.owner}/${workspace.workspace.repository!.name}`)
    .toBe(fixture.repositoryName)
  expect(fixture.sourceManifest.capturePolicy).toBe('git-tree-v1')
  expect(fixture.sourceManifest.git?.repository).toBe(fixture.repositoryName)
  const requesterVersion = Object.entries(fixture.version.agentConfigurationVersionIds)
    .find(([agentId]) => agentId !== fixture.version.approval.designatedOrchestratorAgentId)?.[1]
  const row = (await fixture.db.pool.query<{ record: unknown }>(
    'select record from agent_configuration_versions where id=$1', [requesterVersion])).rows[0]
  const configuration = AgentConfigurationVersionSchema.parse(row?.record)
  expect(configuration.harness.harness).toBe('codex')
  if (configuration.harness.harness !== 'codex') throw new Error('The requester requires the Codex fixture.')
  expect(configuration.harness.advanced).toBeUndefined()
  expect(fixture.profiles[1]!.configuration).toEqual(withAdvancedDefaults(configuration.harness))
  const started = await fixture.start()
  const location = RunExecutionLocationV3Schema.parse(started.run.executionLocation)
  expect(location.runnerId).toBe(fixture.profiles[0]!.target.applicationInstallationId)
  expect((await fixture.details(started.run.id)).run.executionLocation).toEqual(location)
  const interaction = await waitForRemoteReview(async () => {
    await fixture.reconcile()
    return (await fixture.pending(started.run.id))[0]
  }, value => value !== undefined, 'routed native interaction')
  if (!interaction) throw new Error('The requester has no pending interaction.')
  const job = await waitForRemoteReview(async () => {
    await fixture.reconcile()
    const row = (await fixture.db.pool.query<{ record: unknown }>(
      'select record from review_jobs where interaction_id=$1', [interaction.id])).rows[0]
    const current = row ? ReviewJobSchema.parse(row.record) : undefined
    if (current?.state === 'failed') throw new Error(`Remote reviewer failed: ${JSON.stringify(current.error)}`)
    return current
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
  it('keeps unavailable native defaults until an explicit choice through authenticated HTTP and MCP', async () => {
    await withRemoteReviewFixture(async fixture => {
      const catalog = HarnessCatalogEntrySchema.parse(await fixture.value('harness_get', { harness: 'codex' }))
      expect(catalog.capability).toBeNull()
      expect(catalog.discoveryError?.code).toBe('HARNESS_MODEL_DEFAULT_UNAVAILABLE')
      const initialOptions = HarnessOptionsResultSchema.parse(fixture.startupCatalog)
      expect(initialOptions.models).toEqual([])
      const options = HarnessOptionsResultSchema.parse(await fixture.value('harness_options_refresh', { harness: 'codex' }))
      expect(options.models.map(model => model.id)).toContain('test-model')
      expect(options.models.find(model => model.id === 'test-model')).toMatchObject({ defaultPriority: 0 })
      expect(HarnessCatalogEntrySchema.parse(await fixture.value('harness_get', { harness: 'codex' }))).toEqual(catalog)
      const configuration = (await fixture.db.pool.query<{ record: { harness: { model: string } } }>(
        'select record from agent_configuration_versions where id=$1',
        [fixture.version.agentConfigurationVersionIds[fixture.version.approval.designatedOrchestratorAgentId!]])
      ).rows[0]!
      expect(configuration.record.harness.model).toBe('test-model')
      const response = await fetch(`${fixture.origin()}/api/management/harnesses/codex`, {
        headers: { authorization: `Bearer ${fixture.writer.token}` },
      })
      expect(response.status).toBe(200)
      expect(HarnessCatalogEntrySchema.parse(await response.json())).toEqual(catalog)
      const reader = await fixture.access.issue({ name: 'No harness grants', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['settings:read'], scope: {} }] })
      const deniedHttp = await fetch(`${fixture.origin()}/api/management/harnesses/codex`, {
        headers: { authorization: `Bearer ${reader.token}` },
      })
      expect(deniedHttp.status).toBe(403)
      const denied = await fixture.call('harness_get', { harness: 'codex' }, reader.token)
        .then(result => ({ result }), (error: unknown) => ({ error }))
      if ('error' in denied) expect(denied.error).toMatchObject({ code: -32602 })
      else expect(denied.result.isError).toBe(true)
      const presets = HarnessCatalogResultSchema.parse(await fixture.value('harness_list', {}))
      const defaults = ManagementHarnessDefaultsSchema.parse(Object.fromEntries(
        presets.items.map(entry => [entry.harness, entry.defaults])))
      defaults.codex.model = 'test-model'
      const input = { commandId: randomUUID(), expectedRevision: catalog.defaultsRevision,
        defaults, configure: ['codex'] }
      const saved = HarnessDefaultsUpdateResultSchema.parse(await fixture.value('harness_defaults_update', input))
      expect(saved.value.defaults.codex.model).toBe('test-model')
      expect(HarnessDefaultsUpdateResultSchema.parse(await fixture.value('harness_defaults_update', input)))
        .toEqual({ ...saved, replayed: true })
      const selected = HarnessCatalogEntrySchema.parse(await fixture.value('harness_get', { harness: 'codex' }))
      expect(selected.discoveryError).toBeNull()
      expect(selected.capability?.ready).toBe(true)
      // A Claude preset stays unavailable until its exact host profile is checked.
      const unconfigured = HarnessCatalogEntrySchema.parse(await fixture.value('harness_get', { harness: 'claude' }))
      expect(unconfigured.capability).toBeNull()
      expect(unconfigured.discoveryError?.code).toBe('CLAUDE_PROFILE_SELECTION_REQUIRED')
      const claudeResponse = await fetch(`${fixture.origin()}/api/management/harnesses/claude`, {
        headers: { authorization: `Bearer ${fixture.writer.token}` },
      })
      expect(claudeResponse.status).toBe(200)
      expect(HarnessCatalogEntrySchema.parse(await claudeResponse.json())).toEqual(unconfigured)
      const deniedSave = await fixture.call('harness_defaults_update', { ...input, commandId: randomUUID() }, reader.token)
        .then(result => ({ result }), (error: unknown) => ({ error }))
      if ('error' in deniedSave) expect(deniedSave.error).toMatchObject({ code: -32602 })
      else expect(deniedSave.result.isError).toBe(true)
    }, { modelCatalog: 'empty-at-startup', claudeInventory: true })
  }, 240_000)

  it('persists a delivered remote decision and denies a read-only caller on the same product endpoint', async () => {
    await withRemoteReviewFixture(async fixture => {
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
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
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
    })
  }, 240_000)

  it.each(['crash', 'graceful', 'expired-receipt'] as const)(
    'continues the original retained review after Main recovery from %s with the Worker alive', async recovery => {
    await withRemoteReviewFixture(async fixture => {
      const active = await reviewInProgress(fixture)
      const beforeInventory = await fixture.inventory()
      const originalWorkerPid = fixture.workerPid()
      const originalLaunches = active.owners.map(owner => ({
        owner: owner.owner, launchId: owner.launchId, guardian: owner.guardian, provider: owner.provider, boundary: owner.boundary,
      }))
      const ownerLaunchIds = fixture.registry.snapshot().launches.filter(owner => originalLaunches.some(
        original => original.owner === owner.owner)).map(owner => owner.launchId).sort()
      const originalReceipts = await receipts(fixture, active.run.id)
      const processCredentials = async () => (await fixture.db.pool.query<{
        principal_id: string; execution_id: string
      }>(`select principal_id,execution_id from worker_credential_bindings
        where run_id=$1 and revoked_at is null order by execution_id,principal_id`, [active.run.id])).rows
      const originalCredentials = await processCredentials()
      expect(originalCredentials.map(row => row.execution_id).sort())
        .toEqual([active.reviewer.id, active.requester.id].sort())
      await fixture.restartMain({ mode: recovery === 'graceful' ? 'graceful' : 'crash', afterShutdown: async () => {
        if (recovery === 'graceful') {
          const lifetime = (await fixture.db.pool.query<{ detached: boolean; closed: boolean }>(`select
            detached_at is not null as detached,closed_at is not null as closed from execution_native_closures
            where execution_id=$1 order by generation desc limit 1`, [active.reviewer.id])).rows[0]
          expect(lifetime).toEqual({ detached: true, closed: false })
          expect(await hasRetainedRemoteReviewerSource(fixture.db.pool, active.reviewer)).toBe(true)
        }
        if (recovery === 'expired-receipt') {
          const expired = new Date(Date.now() - 60_000).toISOString()
          const journal = JSON.parse(await readFile(join(fixture.stateDirectory, 'workflow-operations.json'), 'utf8')) as
            { receipts: unknown[] }
          const worker = journal.receipts.map(receipt => RemoteOperationReceiptSchema.parse(receipt))
            .find(receipt => receipt.intent.executionId === active.reviewer.id)!
          expect(Date.parse(worker.retainedReviewer!.expiresAt)).toBeGreaterThan(Date.now())
          expect(worker.native?.sessionId).toBe(active.reviewer.nativeSessionId)
          const stale = RemoteOperationReceiptSchema.parse({ ...worker, sequence: worker.sequence - 1,
            retainedReviewer: { ...worker.retainedReviewer, expiresAt: expired } })
          await fixture.db.pool.query(`update remote_execution_receipts set sequence=$2,receipt=$3::jsonb
            where operation_id=$1`, [stale.intent.operationId, stale.sequence, JSON.stringify(stale)])
          const cached = (await receipts(fixture, active.run.id)).find(receipt =>
            receipt.intent.executionId === active.reviewer.id)!
          expect(Date.parse(cached.retainedReviewer!.expiresAt)).toBeLessThan(Date.now())
          expect(worker.sequence).toBeGreaterThan(cached.sequence)
        }
      } })
      const inventory = await waitForRemoteReview(fixture.inventory, value => {
        const original = beforeInventory.hostMetadata?.connection?.binding
        const current = value.hostMetadata?.connection?.binding
        return !!current && !!original && current.connectionEpoch !== original.connectionEpoch
      }, 'replacement authenticated inventory generation')
      expect(inventory.installations[0]?.connectionGeneration)
        .not.toBe(beforeInventory.installations[0]?.connectionGeneration)
      expect(fixture.workerPid()).toBe(originalWorkerPid)
      await fixture.reconcile()
      const currentReceipts = await receipts(fixture, active.run.id)
      expect(currentReceipts.map(receipt => ({ intent: receipt.intent, native: receipt.native })))
        .toEqual(originalReceipts.map(receipt => ({ intent: receipt.intent, native: receipt.native })))
      const reconnected = fixture.registry.snapshot().launches.filter(owner => originalLaunches.some(
        original => original.launchId === owner.launchId))
      expect(reconnected.map(owner => ({ owner: owner.owner, launchId: owner.launchId,
        guardian: owner.guardian, provider: owner.provider, boundary: owner.boundary }))).toEqual(originalLaunches)
      expect(reconnected.every(owner => owner.lifecycle === 'active')).toBe(true)
      await waitForRemoteReview(async () => {
        await fixture.reconcile()
        const row = (await fixture.db.pool.query<{ record: unknown; credential_bound: boolean; reviewer_live: boolean }>(`select
          j.record,exists(select 1 from worker_credential_bindings b where b.execution_id=j.execution_id
            and b.approval_review_lease_fence=j.lease_fence and b.revoked_at is null) as credential_bound,
          exists(select 1 from execution_dispatch_intents i join remote_execution_receipts r using(operation_id)
            where i.execution_id=j.execution_id
              and (r.receipt#>>'{retainedReviewer,expiresAt}')::timestamptz>clock_timestamp()) as reviewer_live
          from review_jobs j where j.id=$1`, [active.job.id])).rows[0]
        if (!row) return undefined
        return { job: ReviewJobSchema.parse(row.record),
          credentialBound: row.credential_bound, reviewerLive: row.reviewer_live }
      }, value => !!value && value.job.attempt > active.job.attempt && value.job.state === 'acknowledged'
        && value.credentialBound && value.reviewerLive,
      'replacement Main review lease and original process credential rebinding')
      expect(await processCredentials()).toEqual(originalCredentials)
      if (recovery === 'graceful') {
        const generations = (await fixture.db.pool.query<{ generation: string; detached: boolean; closed: boolean }>(`select
          generation::text,detached_at is not null as detached,closed_at is not null as closed
          from execution_native_closures where execution_id=$1 order by generation`, [active.reviewer.id])).rows
        expect(generations).toHaveLength(2)
        expect(generations[0]).toMatchObject({ detached: true, closed: false })
        expect(generations[1]).toMatchObject({ detached: false, closed: false })
      }
      if (recovery === 'expired-receipt') {
        const renewed = (await receipts(fixture, active.run.id)).find(receipt =>
          receipt.intent.executionId === active.reviewer.id)!
        expect(Date.parse(renewed.retainedReviewer!.expiresAt)).toBeGreaterThan(Date.now())
      }
      const reader = await fixture.access.issue({ name: 'Recovered review reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 300_000), grants: [{ actions: ['interactions:read'],
          scope: { runIds: [active.run.id] } }] })
      const pending = await readInteraction(fixture, active.interaction.id)
      const option = pending.responseOptions.find(option => option.semantic === 'approve_once')!
      const denied = await fixture.call('interaction_respond', { interactionId: pending.id,
        optionId: option.optionId, expectedRevision: pending.revision }, reader.token)
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      expect(await readInteraction(fixture, pending.id)).toEqual(pending)
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
    })
    }, 240_000,
  )

  it('settles the original native owners after an installed Worker crash without launching a replacement', async () => {
    await withRemoteReviewFixture(async fixture => {
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
    })
  }, 240_000)

  it('retries the same reserved decision through authenticated MCP after a post-reservation authorization failure', async () => {
    await withRemoteReviewFixture(async fixture => {
      const active = await reviewInProgress(fixture)
      fixture.denyNextReservedResponse()
      await fixture.provider.releaseReview()
      const repository = new PostgresInteractionRepository(fixture.db.pool)
      const uncertain = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return repository.get(active.interaction.id)
      },
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
    })
  }, 240_000)

  it('closes a requester entry interrupted before session acknowledgment through installed recovery and authenticated Stop', async () => {
    await withRemoteReviewFixture(async fixture => {
      await fixture.provider.blockRequesterSession()
      const started = await fixture.start()
      const blocked = await waitForRemoteReview(async () => {
        const calls = await fixture.provider.calls()
        const executions = await fixture.executions(started.run.id)
        const failed = executions.find(execution => execution.result?.outcome === 'failed')
        if (failed) {
          throw new Error(`Run execution failed before requester session acknowledgment: ${JSON.stringify({
            executionId: failed.id, state: failed.state, errorCode: failed.result?.error?.code,
          })}`)
        }
        return calls
      }, calls => calls.some(call => 'requesterSessionBlocked' in call),
      'requester thread creation before session acknowledgment')
      const provider = blocked.find(call => 'requesterSessionBlocked' in call)!.requesterSessionBlocked as { pid: number }
      const requesterNode = fixture.version.definition.nodes.find(node => node.id !== fixture.version.entryNodeId)!
      const requester = (await fixture.executions(started.run.id)).find(execution => execution.workflowNodeId === requesterNode.id)!
      expect(requester.state).toBe('starting')
      expect(requester.nativeSessionId).toBeUndefined()
      const workerJournal = JSON.parse(await readFile(join(fixture.stateDirectory, 'workflow-operations.json'), 'utf8')) as {
        receipts: unknown[]
      }
      const original = workerJournal.receipts.map(value => RemoteOperationReceiptSchema.parse(value))
        .find(receipt => receipt.intent.executionId === requester.id)!
      expect(original.entryAttempted).toBe(true)
      expect(original.turnEntryAttempted).toBe(false)
      expect(original.native).toBeUndefined()
      expect(original.terminal).toBeUndefined()
      const owners = fixture.registry.snapshot().launches.filter(launch => launch.owner === `execution:${requester.id}`)
      let originalLaunches = owners
      const active = owners.find(owner => owner.provider?.pid === provider.pid)!
      expect(active.lifecycle).toBe('active')
      expect(active.boundary?.kind).toBe('cgroup-v2')
      const entry = fixture.entryCapture(original.intent.operationId)
      expect(entry).toMatchObject({ intent: original.intent, connection: original.connection, owner: active.owner })
      if (!entry) throw new Error('The original requester entry capture is missing.')
      const preparation = SourcePreparationSchema.parse(await fixture.value('source_preparation_get', {
        workspaceId: started.run.workspaceId, operationId: original.intent.operationId,
      }))
      expect(preparation.materializationId).not.toBeNull()
      // Startup can reserve another launch before the Worker exits.
      await fixture.restartWorker(() => {
        originalLaunches = fixture.registry.snapshot().launches.filter(launch => launch.owner === active.owner)
      })
      await fixture.value('run_stop', { workspaceId: started.run.workspaceId,
        runId: started.run.id, commandId: randomUUID() })
      const closed = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return (await receipts(fixture, started.run.id)).find(receipt => receipt.intent.executionId === requester.id)
      }, receipt => !!receipt && hasPositiveRemoteEntryClosure(receipt), 'persisted closure of the original unacknowledged entry')
      expect(closed).toBeDefined()
      expect(closed!.native).toBeUndefined()
      expect(closed!.turnEntryAttempted).toBe(false)
      expect(closed!.terminal?.result).toBeUndefined()
      expect(closed!.terminal?.resultDigest).toBeUndefined()
      expect(closed!.terminal?.entryClosure).toMatchObject({ intent: original.intent,
        connection: original.connection, owner: `execution:${requester.id}` })
      const closedLaunches = closed!.terminal!.entryClosure!.launches
      const originalLaunchIds = [...new Set([...originalLaunches.map(launch => launch.launchId), entry.initialLaunchId])]
      expect(closed!.terminal!.entryClosure!.initialLaunchId).toBe(entry.initialLaunchId)
      expect(closedLaunches.map(launch => launch.launchId).sort())
        .toEqual(originalLaunchIds.sort())
      expect(closedLaunches.find(launch => launch.launchId === active.launchId)).toMatchObject({
        guardian: active.guardian, provider: active.provider, boundary: active.boundary,
        lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty',
      })
      const detail = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return SavedRunDetailsSchema.parse(await fixture.value('run_get', {
          detail: 'full',
          workspaceId: started.run.workspaceId, runId: started.run.id,
        }))
      }, value => value.run.executionState === 'completed', 'authenticated readback of the stopped Run')
      expect(detail.run.outcome).toBe('canceled')
      expect(detail.executions.find(execution => execution.id === requester.id)?.nativeSessionId).toBeUndefined()
      expect((await fixture.db.pool.query('select 1 from execution_native_sessions where execution_id=$1',
        [requester.id])).rows).toEqual([])
      const released = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return SourcePreparationSchema.parse(await fixture.value('source_preparation_get', {
          workspaceId: started.run.workspaceId, operationId: original.intent.operationId,
        }))
      }, value => value.reservationState === 'reclaimed', 'source reclamation after the original entry closure')
      expect(released.materializationId).toBe(preparation.materializationId)
      expect((await fixture.db.pool.query<{ state: string }>(
        'select state from source_execution_materializations where operation_id=$1',
        [original.intent.operationId])).rows[0]?.state).toBe('closed')
      expect(fixture.registry.closedRegistration(active.owner, entry.initialLaunchId))
        .toEqual(closedLaunches.find(launch => launch.launchId === entry.initialLaunchId))
      expect(fixture.registry.snapshot().launches.filter(launch => launch.owner === active.owner)
        .map(launch => launch.launchId).sort()).toEqual(originalLaunches.map(launch => launch.launchId).sort())
      expect((await fixture.provider.calls()).filter(call => 'requesterSessionBlocked' in call)).toHaveLength(1)
      expect((await fixture.provider.calls()).filter(call => call.method === 'turn/start'
        && call.correlationId === `execution:${requester.id}`)).toHaveLength(0)
    })
  }, 240_000)
})
