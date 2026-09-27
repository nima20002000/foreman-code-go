import { readCurrentExecutions } from './helpers/wave25Agent3.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeSessionReference } from '@graphql/contracts'
import type { NativeGraphObservation } from '@graphql/contracts/wave25'
import { acknowledgementId } from '../src/modules/interactions/wave25/nativeEvidence.js'
import { OpenCodeNativeSessionManager } from '../src/modules/harnesses/opencodeServer.js'
import { object } from '../src/modules/harnesses/opencodeProtocol.js'
import { OPENCODE_RECONCILIATION_EVENT, readOpenCodeReconciliation } from '../src/modules/harnesses/opencodeReconciliation.js'
import { deliverApproval } from '../src/modules/interactions/wave25/service.js'
import { deferred, postgresEnabled } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { br1002OpenCodeRuntime, br1002Response } from './helpers/wave25Br1002OpenCodeRuntime.js'
import { br1002At, br1002Ack, type Br1002Runtime } from './helpers/wave25Br1002Cuts.js'

type ReviewArgs = Parameters<Br1002Runtime['repository']['coordination']['appendReviewNativeEvent']>

/** Call through the real coordinator/authority. A startup failure must expose the
 * durable selected execution, not masquerade as evidence about review settlement.
 * Only identity/status/error codes are reported: no outputs, prompts or tokens. */
async function startReview(f: Br1002Runtime) {
  const authority = vi.spyOn(f.repository, 'assertOrchestratorConnection')
  // engine.start enqueues the durable job and also starts the background
  // reviewer loop. This test invokes dispatchNext itself to hold exact cuts.
  vi.spyOn(f.native.reviewers, 'reconcile').mockResolvedValue(undefined)
  try {
    await f.engine.start(f.f.run.id)
    return authority.mock.calls.map(([request]) => request)
  } catch (cause) {
    const [executions, counts] = await Promise.allSettled([
      readCurrentExecutions(f.runs, f.f.run.id),
      f.db.pool.query<{ interactions: string; review_jobs: string }>(`select
        (select count(*)::text from durable_interactions where run_id=$1) as interactions,
        (select count(*)::text from review_jobs j join durable_interactions i on i.id=j.interaction_id
          where i.run_id=$1) as review_jobs`, [f.f.run.id]),
    ])
    const details = {
      runId: f.f.run.id,
      entryNodeId: f.f.version.entryNodeId,
      authorityRequests: authority.mock.calls.map(([request]) => ({
        executionId: request.executionId, runId: request.runId,
        requestingAgentId: request.requestingAgentId, handler: request.approval.handler,
        nativeSessionId: request.nativeSessionId ?? null, harness: request.harness ?? null,
      })),
      executions: executions.status === 'fulfilled' ? executions.value.map((execution) => ({
        executionId: execution.id, workflowNodeId: execution.workflowNodeId, agentId: execution.agentId,
        state: execution.state, nativeSessionId: execution.nativeSessionId ?? null,
        outcome: execution.result?.outcome ?? null, errorCode: execution.result?.error?.code ?? null,
      })) : { readFailed: true },
      durableCounts: counts.status === 'fulfilled' ? counts.value.rows[0] : { readFailed: true },
      providerCalls: f.counts(),
    }
    // Keep the original failure as the cause. A diagnostic read failure cannot
    // turn the engine failure into success or replace it with a SQL error.
    throw new Error(`BR1-002 engine.start failed before reviewer dispatch: ${JSON.stringify(details)}`, { cause })
  } finally { authority.mockRestore() }
}
function reviewCuts(f: Br1002Runtime, holdLive = false) {
  const live = deferred<ReviewArgs>(), before = deferred<ReviewArgs>(), after = deferred<ReviewArgs>()
  const enter = deferred(), finish = deferred(), continueLive = deferred()
  let selected = false, selectedLive = false
  const original = f.repository.coordination.appendReviewNativeEvent.bind(f.repository.coordination)
  const spy = vi.spyOn(f.repository.coordination, 'appendReviewNativeEvent').mockImplementation(async (...args) => {
    const [, event, projection] = args
    if (!selected && event.type === OPENCODE_RECONCILIATION_EVENT && projection?.terminalReady) {
      selected = true; before.resolve(args); await enter.promise
      await original(...args)
      after.resolve(args); await finish.promise
      return
    }
    await original(...args)
    if (!selectedLive && projection?.live && event.type === 'message.updated' && object(event.payload.info).role === 'user') {
      selectedLive = true; live.resolve(args)
      if (holdLive) await continueLive.promise
    }
  })
  return { live, before, after, enter, finish, continueLive, original,
    release() { continueLive.resolve(); enter.resolve(); finish.resolve() }, restore() { spy.mockRestore() } }
}
async function evidence(f: Br1002Runtime, jobId: string) {
  return (await f.db.pool.query<{ state: string; revision: string; generation: string;
    approval_native_evidence: NativeGraphObservation | null }>(
    'select state,revision::text,approval_connection_generation::text as generation,approval_native_evidence from review_jobs where id=$1', [jobId])).rows[0]!
}
async function decision(f: Br1002Runtime, args: ReviewArgs) {
  const job = args[0], interaction = (await f.repository.get(job.interactionId))!
  const host = (await readCurrentExecutions(f.runs, f.f.run.id)).find((e) => e.agentId === job.reviewerAgentId)!
  const credential = await f.credentials.issueForReviewer(host.id)
  try {
    const principal = await f.access.authenticate(credential.environment.variables.GRAPHQL_MCP_TOKEN, 'worker')
    const input = br1002Response(interaction)
    const option = interaction.responseOptions.find((item) => item.optionId === input.optionId)!
    // This is the real decision repository and SQL worker authority, not an
    // authenticated MCP request or provider tool call. This test-only principal
    // is never given to the native manager and is revoked after its one use.
    return await f.repository.decide({ id: interaction.id, optionId: input.optionId, expectedRevision: input.expectedRevision,
      principal, nativeResponse: { optionId: option.optionId, semantic: option.semantic } })
  } finally { await f.credentials.revoke({ principalId: credential.principalId }) }
}
afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('BR1-002 actual reviewer dispatcher / OpenCode same-generation history', () => {
  it('reaches a real pending review through exact Worker native authority before dispatch', async () => {
    const f = await br1002OpenCodeRuntime('orchestrator')
    try {
      const { compare } = await graphParity(f.db.pool, f.f.scope)
      await compare()
      const requests = await startReview(f)
      const executions = await readCurrentExecutions(f.runs, f.f.run.id)
      expect(executions).toHaveLength(2)
      const entry = executions.find((execution) => execution.workflowNodeId === f.f.version.entryNodeId)!
      const worker = executions.find((execution) => execution.workflowNodeId !== f.f.version.entryNodeId)!
      expect(entry).toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
      expect(worker).toMatchObject({ state: 'waiting' })
      expect(worker.nativeSessionId).toBeTruthy()
      // These are the real pre-create arguments, not a repaired mock return.
      // The coordinator must forward its already-owned exact session identity.
      expect(requests[0]).toMatchObject({
        workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId, runId: f.f.run.id,
        executionId: worker.id, requestingAgentId: worker.agentId,
        nativeSessionId: worker.nativeSessionId, harness: 'opencode', approval: f.f.run.approval,
      })
      const pending = await f.pending()
      expect(pending).toHaveLength(1)
      const interaction = pending[0]!
      expect(interaction).toMatchObject({ executionId: worker.id, nativeSessionId: worker.nativeSessionId,
        status: 'pending', deliveryState: 'not_started' })
      expect((await f.repository.coordination.workflowSession(entry.id))?.finalized).toBe(true)
      const job = await f.repository.coordination.findReviewJob(interaction.id, entry.agentId)
      expect(job).toMatchObject({ state: 'pending', interactionId: interaction.id,
        reviewerAgentId: entry.agentId, nativeSessionId: entry.nativeSessionId })
      expect(await f.saver.getTuple(f.config)).toBeDefined()
      expect(f.counts()).toEqual({ sessions: 2, prompts: 2, responses: 0 })
      await compare()
    } finally { await f.close() }
  }, 60000)

  it.each(['nativeSessionId', 'harness', 'providerVersion'] as const)(
    'rejects pending-session %s mismatch before pre-create authority or review enqueue', async (field) => {
      const f = await br1002OpenCodeRuntime('orchestrator')
      const authority = vi.spyOn(f.repository, 'assertOrchestratorConnection')
      const create = vi.spyOn(f.repository, 'create')
      const enqueue = vi.spyOn(f.native.reviewers, 'enqueue')
      const original = OpenCodeNativeSessionManager.prototype.history
      let corrupted = 0
      const corruptSession = (session: NativeSessionReference): NativeSessionReference => field === 'nativeSessionId'
        ? { ...session, nativeSessionId: 'ses_not_the_owned_worker' }
        : field === 'harness' ? { ...session, harness: 'codex' }
          : { ...session, providerVersion: 'not-the-owned-provider-version' }
      const history = vi.spyOn(OpenCodeNativeSessionManager.prototype, 'history').mockImplementation(
        async function (this: OpenCodeNativeSessionManager, ...args: Parameters<OpenCodeNativeSessionManager['history']>) {
          const observed = await original.apply(this, args)
          if (!observed.pendingInteractions.length) return observed
          const pendingInteractions = observed.pendingInteractions.map((pending) => ({
            ...pending, session: corruptSession(pending.session),
          }))
          corrupted += pendingInteractions.length
          return { ...observed, pendingInteractions,
            ...(pendingInteractions[0] ? { pendingInteraction: pendingInteractions[0] } : {}) }
        },
      )
      try {
        await expect(f.engine.start(f.f.run.id)).rejects.toMatchObject({ code: 'WORKFLOW_SELECTED_EXECUTION_FAILED' })
        expect(corrupted).toBeGreaterThan(0)
        const executions = await readCurrentExecutions(f.runs, f.f.run.id)
        expect(executions).toHaveLength(2)
        const entry = executions.find((execution) => execution.workflowNodeId === f.f.version.entryNodeId)!
        const worker = executions.find((execution) => execution.workflowNodeId !== f.f.version.entryNodeId)!
        expect(entry).toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
        expect(worker).toMatchObject({ state: 'completed', result: {
          outcome: 'failed', error: { code: 'NATIVE_SESSION_IDENTITY_MISMATCH' },
        } })
        expect(authority).not.toHaveBeenCalled()
        expect(create).not.toHaveBeenCalled()
        expect(enqueue).not.toHaveBeenCalled()
        expect(await f.pending()).toHaveLength(0)
        expect(f.counts()).toEqual({ sessions: 2, prompts: 2, responses: 1 })
        const replies = [...f.servers.values()].flatMap((server) => server.calls)
          .filter((call) => /^\/permission\/[^/]+\/reply/.test(call.path))
        expect(replies[0]?.body).toMatchObject({ reply: 'reject' })
      } finally { history.mockRestore(); await f.close() }
    }, 60000,
  )

  it('settles a live-started review with a lost terminal notification before native Worker delivery is permitted', async () => {
    const f = await br1002OpenCodeRuntime('orchestrator')
    let cuts: ReturnType<typeof reviewCuts> | undefined
    let dispatch: Promise<unknown> | undefined
    try {
      const { compare } = await graphParity(f.db.pool, f.f.scope)
      await compare(); await startReview(f); await compare()
      const [i] = await f.pending()
      if (!i?.approval.designatedOrchestratorAgentId) throw new Error('Expected the routed actual OpenCode approval')
      const job = await f.repository.coordination.findReviewJob(i.id, i.approval.designatedOrchestratorAgentId)
      if (!job) throw new Error('The actual coordinator did not enqueue the review')
      const queued = await evidence(f, job.id)
      cuts = reviewCuts(f, true)
      dispatch = f.native.reviewers.dispatchNext(job.reviewerAgentId, 'br1-002-dispatcher')
      const started = await br1002At(cuts.live.promise, dispatch)
      const liveEvidence = await evidence(f, job.id)
      expect(liveEvidence.approval_native_evidence?.kind).toBe('submission')
      expect(started[0].providerTurnOrMessageId).toBeTruthy()
      // Regression: this exact cut used to have an acknowledgement only in the
      // fresh snapshot. The complete reference consumer must accept the new
      // review revision, not silently overwrite a different same-revision fact.
      const liveAck = acknowledgementId(liveEvidence.approval_native_evidence ?? undefined)
      expect(liveAck).toMatch(/^ack:/)
      const livePublished = await compare()
      expect(livePublished.state.reviews.find((review) => review.reviewJobId === job.id)).toMatchObject({
        acknowledgementId: liveAck, revision: liveEvidence.revision,
      })
      expect(BigInt(liveEvidence.revision)).toBeGreaterThan(BigInt(queued.revision))
      await cuts.original(...started)
      expect(await evidence(f, job.id)).toEqual(liveEvidence)
      expect((await compare()).asOfSequence).toBe(livePublished.asOfSequence)
      cuts.continueLive.resolve()
      await decision(f, started)
      const decided = (await f.repository.get(i.id))!
      expect(decided.status).toBe('delivery_pending')
      expect((await deliverApproval({ repository: f.repository, nativeRuntime: f.native }, i.id)).deliveryState).toBe('pending')
      expect(f.counts().responses).toBe(0)
      await compare()
      const host = (await readCurrentExecutions(f.runs, f.f.run.id)).find((e) => e.agentId === job.reviewerAgentId)!
      const server = f.servers.get(host.id)!
      const generation = server.generation
      server.finishFromHistory(job.correlationId, job.nativeSessionId)
      server.closeStreams() // Lost SSE, not a fabricated turn.completed notification.
      const terminalArgs = await br1002At(cuts.before.promise, dispatch)
      expect(server.generation).toBe(generation)
      expect(terminalArgs[2]).toMatchObject({ terminalReady: true })
      expect((await evidence(f, job.id)).approval_native_evidence?.kind).toBe('submission')
      const observation = terminalArgs[1]
      expect(observation.connectionId).toBe(started[1].connectionId)
      const proof = readOpenCodeReconciliation(observation, { ownerAgentId: job.reviewerAgentId,
        nativeSessionId: job.nativeSessionId, correlationId: job.correlationId,
        nativeTurnId: started[0].providerTurnOrMessageId!, providerVersion: server.expectedVersion })!
      expect(proof).toBeDefined()
      const raw = (await f.db.pool.query<{ source_sequence: string; record: { connectionId: string; payload: { nativeEventId: string } } }>(
        'select source_sequence::text,record from harness_native_events where execution_id=$1 and connection_id=$2 and source_sequence=0',
        [host.id, proof.historySource.connectionId])).rows[0]!
      expect(raw.record.connectionId).not.toBe(observation.connectionId)
      expect(raw.record.payload.nativeEventId).toBe(proof.historySource.nativeEventId)
      expect(raw.source_sequence).toBe('0')
      await compare()
      cuts.enter.resolve()
      await br1002At(cuts.after.promise, dispatch)
      const terminalEvidence = await evidence(f, job.id)
      expect(terminalEvidence).toMatchObject({ generation: liveEvidence.generation,
        approval_native_evidence: { kind: 'terminal', submissionId: started[0].providerTurnOrMessageId,
          connectionGeneration: liveEvidence.generation, terminal: { outcome: 'succeeded', nativeSettled: true } } })
      const terminalAck = acknowledgementId(terminalEvidence.approval_native_evidence ?? undefined)
      expect(terminalAck).toMatch(/^ack:/)
      expect(terminalAck).not.toBe(liveAck)
      expect(BigInt(terminalEvidence.revision)).toBeGreaterThan(BigInt(liveEvidence.revision))
      const published = await compare()
      expect(published.state.reviews.find((review) => review.reviewJobId === job.id)).toMatchObject({
        acknowledgementId: terminalAck, revision: terminalEvidence.revision,
      })
      await cuts.original(...terminalArgs)
      // Replaying an earlier acknowledged submission after terminal evidence
      // must not relabel the receipt, change its revision, or revive the review.
      await cuts.original(...started)
      expect(await evidence(f, job.id)).toEqual(terminalEvidence)
      expect((await compare()).asOfSequence).toBe(published.asOfSequence)
      expect(f.counts().responses).toBe(0)
      cuts.finish.resolve(); await dispatch
      expect((await evidence(f, job.id)).state).toBe('completed')
      await compare()
      const delivered = await deliverApproval({ repository: f.repository, nativeRuntime: f.native }, i.id)
      expect(delivered.deliveryState).toBe('delivered')
      await f.engine.resumeInteraction(delivered)
      expect((await br1002Ack(f, i.id))?.approval_native_ack_id).toMatch(/^continuation-ack-/)
      const terminal = await compare()
      expect(terminal.state.run.pendingInteractionCount).toBe(0)
      expect(terminal.state.run.outcome).toBe('succeeded')
      expect(f.counts()).toEqual({ sessions: 2, prompts: 3, responses: 1 })
      expect(await f.native.reviewers.dispatchNext(job.reviewerAgentId, 'br1-002-repeat')).toBeUndefined()
      expect(f.counts()).toEqual({ sessions: 2, prompts: 3, responses: 1 })
    } finally {
      cuts?.release(); cuts?.restore()
      await f.close()
      void dispatch?.catch(() => undefined)
    }
  }, 60000)

  for (const cut of ['job-owner', 'writer-owner', 'job-lease-expiry', 'writer-lease-expiry',
    'native-session', 'correlation', 'generation', 'provider-version', 'Stop'] as const) {
    it(`does not turn a durable application decision into native settlement across ${cut}`, async () => {
      const f = await br1002OpenCodeRuntime('orchestrator')
      let cuts: ReturnType<typeof reviewCuts> | undefined
      let dispatch: Promise<unknown> | undefined
      try {
        await startReview(f)
        const { compare } = await graphParity(f.db.pool, f.f.scope)
        const [i] = await f.pending()
        if (!i?.approval.designatedOrchestratorAgentId) throw new Error('Expected routed approval')
        const job = (await f.repository.coordination.findReviewJob(i.id, i.approval.designatedOrchestratorAgentId))!
        cuts = reviewCuts(f)
        dispatch = f.native.reviewers.dispatchNext(job.reviewerAgentId, `br1-002-${cut}`)
        const started = await br1002At(cuts.live.promise, dispatch)
        await decision(f, started)
        const host = (await readCurrentExecutions(f.runs, f.f.run.id)).find((e) => e.agentId === job.reviewerAgentId)!
        const server = f.servers.get(host.id)!
        server.finishFromHistory(job.correlationId, job.nativeSessionId); server.closeStreams()
        const args = await br1002At(cuts.before.promise, dispatch)
        const projection = args[2]!
        const beforeRejected = await evidence(f, job.id)
        if (cut === 'job-owner') {
          await expect(cuts.original({ ...args[0], leaseToken: 'not-the-current-job-owner' }, args[1], projection))
            .rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
        } else if (cut === 'writer-owner') {
          await expect(cuts.original(args[0], args[1], { ...projection,
            writer: { ...projection.writer, token: 'not-the-current-writer' } })).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
        } else if (cut === 'job-lease-expiry') {
          // The review_job_lease trigger derives the column from record; expire
          // the authoritative record so the column and guard agree.
          await f.db.pool.query("update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb($2::text)) where id=$1",
            [job.id, '2000-01-01T00:00:00.000Z'])
          await cuts.original(...args).catch((error: unknown) => {
            expect(error).toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
          })
        } else if (cut === 'writer-lease-expiry') {
          await f.db.pool.query("update native_session_lanes set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb($2::text)) where id=$1",
            [projection.writer.id, '2000-01-01T00:00:00.000Z'])
          await expect(cuts.original(...args)).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
        } else if (cut === 'native-session' || cut === 'correlation') {
          const changed = cut === 'native-session' ? { nativeSessionId: 'ses_not_this_review' } : { correlationId: 'not-this-review' }
          await expect(cuts.original({ ...args[0], ...changed }, args[1], projection))
            .rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
        } else if (cut === 'generation') {
          await f.db.pool.query(`update native_session_lanes set record=jsonb_set(record,'{connectionGeneration}',
            to_jsonb((record->>'connectionGeneration')::integer+1)) where id=$1`, [projection.writer.id])
          await expect(cuts.original(...args)).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
        } else if (cut === 'provider-version') {
          // Corrupt only the isolated durable context; keep the actual adapter
          // observation/raw history unchanged. A differently pinned version is
          // not valid settlement evidence even on the same writer generation.
          await f.db.pool.query("update review_jobs set provider_version='different-provider-version' where id=$1", [job.id])
          await cuts.original(...args)
        } else {
          await f.runs.requestStop(f.f.run.id)
          await cuts.original(...args).catch((error: unknown) => {
            expect(error).toBeDefined()
          })
        }
        const afterRejected = await evidence(f, job.id)
        if (cut !== 'Stop') {
          expect(afterRejected.approval_native_evidence).toEqual(beforeRejected.approval_native_evidence)
          expect(afterRejected.revision).toBe(beforeRejected.revision)
          expect(afterRejected.approval_native_evidence?.kind).not.toBe('terminal')
        }
        // Stop may retain truthful terminal evidence from an already-owned
        // native turn for cleanup; it must not complete the business review or
        // deliver/resume the Worker.
        expect((await evidence(f, job.id)).state).not.toBe('completed')
        expect(f.counts()).toEqual({ sessions: 2, prompts: 3, responses: 0 })
        expect((await br1002Ack(f, i.id))?.approval_native_ack_id ?? null).toBeNull()
        const latest = await compare()
        if (cut === 'Stop') expect(latest.state.run.stopRequested).toBe(true)
        // No assertion that Stop cleanup/canceled exchange retirement is fixed,
        // and no assertion that a new-generation replacement can take over.
      } finally { cuts?.release(); cuts?.restore(); await f.close(); void dispatch?.catch(() => undefined) }
    }, 60000)
  }
})
