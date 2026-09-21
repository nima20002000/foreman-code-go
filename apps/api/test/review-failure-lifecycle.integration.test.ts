import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GetRunResponseSchema, ReviewJobSchema, type DurableInteraction, type ReviewJob } from '@graphql/contracts'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { AutomaticReviewService } from '../src/modules/interactions/automaticReview.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { requestReviewFailureStop } from '../src/modules/interactions/reviewFailureLifecycle.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import type { InteractionNativeRuntime } from '../src/modules/interactions/runtimePorts.js'
import type { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import type { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'

// Real PostgreSQL repositories, migrations, auth and MCP. Native dispatch and
// process cleanup below are explicit deterministic ports, NOT live providers.
const connectionString = process.env.TEST_DATABASE_URL ?? 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_nim2601'
let schema: string, root: string
let admin: pg.Pool, pool: pg.Pool
let app: FastifyInstance | undefined
const clients: Client[] = []
const schedulers: AutomaticReviewService[] = []
beforeEach(async () => {
  schema = `review_failure_${randomUUID().replaceAll('-', '')}`
  root = await mkdtemp(join(tmpdir(), 'graphql-review-failure-'))
  admin = new pg.Pool({ connectionString })
  await admin.query(`create schema "${schema}"`)
  pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` })
  await applyApplicationMigrations(pool)
  await ensureAcceptanceSeed(pool)
})
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()))
  await Promise.allSettled(schedulers.splice(0).map((scheduler) => scheduler.shutdown()))
  await app?.close(); app = undefined
  vi.restoreAllMocks()
  await pool?.end()
  await admin?.query(`drop schema if exists "${schema}" cascade`)
  await admin?.end()
  await rm(root, { recursive: true, force: true })
})
const noNative: InteractionNativeRuntime = {
  attachInteraction: async () => { throw new Error('No native mutation in lifecycle persistence test') },
  attachOwnedSession: async () => { throw new Error('No native mutation in lifecycle persistence test') },
}
type Fixture = Awaited<ReturnType<typeof routedApprovalFixture>>
function scheduler(f: Fixture, access: PostgresAccessService, stop: (runId: string) => Promise<void>) {
  const service = new AutomaticReviewService(pool, f.runs, noNative,
    { reconcileReviewLifetimes: async () => undefined } as unknown as OperatorChatService, access,
    { revalidateRunAuthorization: async () => undefined } as unknown as WorkspaceLocationService,
    { enabled: () => true } as unknown as NativeRollout, stop)
  schedulers.push(service)
  return service
}
// Test-only access to scheduling so ordering is deterministic. No production API is widened.
function internals(service: AutomaticReviewService) {
  return service as unknown as {
    schedule(interaction: DurableInteraction): Promise<void>
    dispatcher: { dispatchNext(agentId: string, workerId: string): Promise<ReviewJob | undefined>; reconcile(onError: (error: unknown) => void): Promise<void> }
  }
}
async function saveJob(f: Fixture, code?: string) {
  const job = ReviewJobSchema.parse({ id: `job-${randomUUID()}`, interactionId: f.interaction.id,
    reviewerAgentId: f.reviewerId, attempt: 0, state: 'pending', provider: f.reviewerSession.harness,
    nativeSessionId: f.reviewerSession.nativeSessionId, correlationId: `correlation-${randomUUID()}`,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  await f.interactions.coordination.ensureReviewJob(job, { executionId: f.reviewer.id,
    workingDirectory: root, providerVersion: f.reviewerSession.providerVersion })
  if (!code) return job
  const token = `lease-${randomUUID()}`
  await f.interactions.coordination.claimReviewJob(job.id, 'test', token, new Date(Date.now() + 60000).toISOString())
  return f.interactions.coordination.transitionReviewJob(job.id, token, 'failed', { error: { code, message: 'Provider failure; private diagnostic omitted from public cause.' } })
}
async function connect(address: string, token: string) {
  const client = new Client({ name: 'review-failure-readback', version: '1.0.0' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp/operator', address), { authProvider: { token: async () => token } }))
  return client
}

it('scheduling B while the reviewer dispatches failed A stops only A and persists its exact identity', async () => {
  const f = await routedApprovalFixture(pool, root, root, 'direct')
  const access = new PostgresAccessService(pool)
  // Same immutable workflow/configuration and SAME reviewer Agent, distinct Run/session/execution.
  const runB = { ...f.run, id: `run-B-${randomUUID()}`, authorizationPrincipalId: 'test-scheduling-authority' }
  await f.runs.create(runB)
  const reviewerB = { ...f.reviewer, id: `${runB.id}-reviewer`, runId: runB.id, nativeSessionId: `${runB.id}-session-review` }
  const requesterB = { ...f.requester, id: `${runB.id}-worker`, runId: runB.id, nativeSessionId: `${runB.id}-session-worker` }
  await f.runs.ensureExecution(reviewerB); await f.runs.ensureExecution(requesterB)
  await f.interactions.coordination.bindWorkflowSession(reviewerB.id, { ...f.reviewerSession, nativeSessionId: reviewerB.nativeSessionId })
  await f.interactions.coordination.finalizeWorkflowSession(reviewerB.id)
  const b = (await f.interactions.create({ ...f.interaction, id: `${runB.id}-interaction`, runId: runB.id,
    graphThreadId: runB.id, graphInterruptId: `${runB.id}-interrupt`, executionId: requesterB.id, nativeSessionId: requesterB.nativeSessionId })).interaction
  const a = await saveJob(f, 'REVIEW_NO_DECISION')
  // Positive cleanup is a fixture fact for A only, not inferred for B.
  await pool.query(`update review_jobs set record=jsonb_set(record,'{cleanup}',$2::jsonb) where id=$1`, [a.id, JSON.stringify({
    nativeState: 'closed', credentialState: 'revoked', interruptState: 'not_sent', completedAt: new Date().toISOString(),
  })])
  const failedA = (await f.interactions.coordination.findReviewJob(f.interaction.id, f.reviewerId))!
  const stopped: string[] = []
  const service = scheduler(f, access, async (runId) => { stopped.push(runId) })
  vi.spyOn(internals(service).dispatcher, 'dispatchNext').mockResolvedValue(failedA)
  await internals(service).schedule(b)
  expect(stopped).toEqual([f.run.id])
  expect(await f.runs.get(runB.id)).toMatchObject({ executionState: 'waiting' })
  expect((await pool.query('select run_id from run_cleanup_intents where pending')).rows).toEqual([{ run_id: f.run.id }])
  expect((await f.runs.get(f.run.id))?.stopCause).toMatchObject({ interactionId: f.interaction.id, reviewJobId: a.id,
    error: { code: 'REVIEW_NO_DECISION' } })
  const aEvents = await pool.query<{ run_id: string; harness_execution_id: string }>(
    `select run_id,harness_execution_id from run_activity where payload->>'reviewJobId'=$1`, [a.id])
  expect(aEvents.rows.length).toBeGreaterThan(0)
  expect(aEvents.rows.every((row) => row.run_id === f.run.id && row.harness_execution_id === f.reviewer.id)).toBe(true)
  expect((await pool.query(`select 1 from run_activity where run_id=$1 and payload->>'reviewJobId'=$2`, [runB.id, a.id])).rowCount).toBe(0)

  // Simulate successful Stop settlement with an OLD Run JSON snapshot. The
  // database must retain the independently committed cause despite that stale writer.
  await pool.query(`update runs set execution_state='completed',record=$2::jsonb where id=$1`, [f.run.id, JSON.stringify({
    ...f.run, executionState: 'completed', outcome: 'canceled', result: { outcome: 'canceled' }, finishedAt: new Date().toISOString(),
  })])
  await f.interactions.cancelPendingForRun(f.run.id)
  await f.runs.finishCleanup(f.run.id, false)
  // A fresh set of service objects reads back through the authenticated endpoint.
  const operator = await access.issue({ name: 'Read both Runs', audience: 'operator', expiresAt: new Date(Date.now() + 60000),
    grants: [{ actions: ['runs:read', 'interactions:read'], scope: { runIds: [f.run.id, runB.id] } }] })
  const denied = await access.issue({ name: 'Only B', audience: 'operator', expiresAt: new Date(Date.now() + 60000),
    grants: [{ actions: ['runs:read'], scope: { runIds: [runB.id] } }] })
  app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access, services: { commands: f.commands, interactions: new OperatorInteractionService(f.service, f.interactions),
      runs: new RunManagementService(pool, f.commands, f.runs, {} as never, f.locations) } as never } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const reader = await connect(address, operator.token)
  const other = await connect(address, denied.token)
  const input = { workspaceId: f.run.workspaceId, runId: f.run.id }
  expect((await other.callTool({ name: 'run_get', arguments: input })).isError).toBe(true)
  const read = await reader.callTool({ name: 'run_get', arguments: input })
  expect(read.isError).not.toBe(true)
  const persisted = GetRunResponseSchema.parse(read.structuredContent)
  expect(persisted.run).toMatchObject({ executionState: 'completed', outcome: 'canceled', stopCause: { reviewJobId: a.id } })
  expect(persisted.run.stopCause?.error.message).not.toContain('private diagnostic')
  expect(persisted.cleanupPending).toBe(false)
  expect(persisted.liveActivity?.nodes.every((node) => node.state === 'idle' && node.action === null)).toBe(true)
  const detail = await reader.callTool({ name: 'interaction_get', arguments: { interactionId: f.interaction.id } })
  expect(detail.isError).not.toBe(true)
  expect(detail.structuredContent).toMatchObject({ interaction: { status: 'canceled' },
    review: { state: 'failed', reviewJobId: a.id, cleanupPending: false, error: { code: 'REVIEW_NO_DECISION' } } })
  expect((await f.runs.get(runB.id))?.stopCause).toBeUndefined()
})

it.each(['REVIEW_NATIVE_CLOSURE_UNCONFIRMED', 'REVIEW_SUBMISSION_REJECTED'] as const)(
  '%s persists incomplete cleanup and a retryable Stop intent across application restart', async (code) => {
    const f = await routedApprovalFixture(pool, root, root, 'direct')
    const access = new PostgresAccessService(pool)
    const failed = await saveJob(f, code)
    expect(failed.cleanup).toMatchObject({ nativeState: 'pending', credentialState: 'pending' })
    expect(failed.cleanup?.completedAt).toBeUndefined()
    const calls: string[] = []
    const unavailableStop = async (runId: string) => { calls.push(runId); throw new Error('Native closure remains unconfirmed') }
    const first = scheduler(f, access, unavailableStop)
    vi.spyOn(internals(first).dispatcher, 'reconcile').mockResolvedValue(undefined)
    await first.tick()
    expect(calls).toEqual([f.run.id])
    expect((await pool.query('select pending from run_cleanup_intents where run_id=$1', [f.run.id])).rows[0]).toEqual({ pending: true })
    await first.shutdown()
    const restarted = scheduler(f, access, unavailableStop)
    vi.spyOn(internals(restarted).dispatcher, 'reconcile').mockResolvedValue(undefined)
    await restarted.tick()
    expect(calls).toEqual([f.run.id, f.run.id])
    const after = await new PostgresInteractionCoordinationRepository(pool).findReviewJob(f.interaction.id, f.reviewerId)
    expect(after).toMatchObject({ state: 'failed', cleanup: { nativeState: 'pending' } })
    expect(after?.cleanup?.completedAt).toBeUndefined()
    expect(await f.interactions.get(f.interaction.id)).toMatchObject({ status: 'pending', deliveryState: 'not_started' })
    expect(f.manager.counters.deliveries).toBe(0)
    const read = await f.runs.getDetails(f.run.workspaceId, f.run.id)
    expect(read).toMatchObject({ cleanupPending: true, run: { stopCause: { error: { code } } } })
    // Only an explicit successful global Stop may record confirmed closure.
    await f.interactions.coordination.finishStoppedReviews(f.run.id, true)
    const settled = await f.interactions.coordination.findReviewJob(f.interaction.id, f.reviewerId)
    expect(settled?.cleanup).toMatchObject({ nativeState: 'closed', credentialState: 'revoked' })
    expect(settled?.cleanup?.completedAt).toBeDefined()
  },
)

it('failure reference cannot use a caller-supplied Run to stop another execution', async () => {
  const f = await routedApprovalFixture(pool, root, root, 'direct')
  expect(await requestReviewFailureStop(pool, { reviewJobId: 'missing-job' })).toBeUndefined()
  expect((await pool.query('select run_id from run_cleanup_intents where pending')).rowCount).toBe(0)
  const job = await saveJob(f)
  expect(await requestReviewFailureStop(pool, { reviewJobId: job.id })).toBeUndefined()
  expect((await f.runs.get(f.run.id))?.stopCause).toBeUndefined()
})
