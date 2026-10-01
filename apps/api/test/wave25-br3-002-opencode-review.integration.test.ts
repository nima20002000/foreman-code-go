import { readCurrentExecutions } from './helpers/wave25Agent3.js'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { acknowledgementId } from '../src/modules/interactions/wave25/nativeEvidence.js'
import { deliverApproval } from '../src/modules/interactions/wave25/service.js'
import { normalizedHistory } from '../src/modules/harnesses/opencodeProtocol.js'
import { openCodeReconciliationPayload, readOpenCodeReconciliation } from '../src/modules/harnesses/opencodeReconciliation.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { br1002OpenCodeRuntime } from './helpers/wave25Br1002OpenCodeRuntime.js'
import { br1002Ack, br1002At, type Br1002Runtime } from './helpers/wave25Br1002Cuts.js'
import { br3002ApprovalReplies, br3002Assistant, br3002Cases, br3002Cuts, br3002Decision,
  br3002Effects, br3002Evidence, br3002Notify, type Br3002Case, type Br3002ReviewArgs } from './helpers/wave25Br3002Review.js'

async function start(f: Br1002Runtime) {
  // Use the actual dispatcher, but schedule it manually to expose exact SQL cuts.
  vi.spyOn(f.native.reviewers, 'reconcile').mockResolvedValue(undefined)
  await f.engine.start(f.f.run.id)
  const [interaction] = await f.pending()
  if (!interaction?.approval.designatedOrchestratorAgentId) throw new Error('Expected routed native Worker approval')
  const job = await f.repository.coordination.findReviewJob(interaction.id, interaction.approval.designatedOrchestratorAgentId)
  if (!job) throw new Error('Actual coordinator did not enqueue a review')
  const host = (await readCurrentExecutions(f.runs, f.f.run.id)).find((execution) => execution.agentId === job.reviewerAgentId)!
  const server = f.servers.get(host.id)!
  return { interaction, job, host, server }
}

async function runCase(variant: Br3002Case, mode: 'live' | 'lost' | 'reordered', hasDecision = true) {
  const f = await br1002OpenCodeRuntime('orchestrator')
  let cuts: ReturnType<typeof br3002Cuts> | undefined, dispatch: Promise<unknown> | undefined
  try {
    const { compare } = await graphParity(f.db.pool, f.f.scope)
    await compare()
    const { interaction, job, host, server } = await start(f)
    await compare()
    cuts = br3002Cuts(f, mode === 'reordered')
    dispatch = f.native.reviewers.dispatchNext(job.reviewerAgentId, `br3-002-${mode}`)
    void dispatch.catch(() => undefined)
    const started = await br1002At(cuts.started.promise, dispatch)
    expect((await br3002Evidence(f, job.id)).approval_native_evidence?.kind).toBe('submission')
    if (hasDecision) await br3002Decision(f, started)
    expect((await deliverApproval({ repository: f.repository, nativeRuntime: f.native }, interaction.id)).deliveryState).not.toBe('delivered')
    expect(br3002ApprovalReplies(f)).toBe(0)
    await compare()
    const generation = server.generation
    const message = br3002Assistant(server, job.correlationId, job.nativeSessionId, variant)
    if (!variant.reviewOutcome) { cuts.enterMarker.resolve(); cuts.finishMarker.resolve() }
    cuts.continueStart.resolve()
    br3002Notify(server, message, mode !== 'lost')
    let liveArgs: Br3002ReviewArgs | undefined
    if (mode !== 'lost') {
      liveArgs = await br1002At(cuts.assistant.promise, dispatch)
      // Regression: even completed stop/length/filter frames are not rooted,
      // pending-tool-free closure proof. Old code persists a terminal here.
      expect((await br3002Evidence(f, job.id)).approval_native_evidence?.kind).toBe('submission')
      expect((await deliverApproval({ repository: f.repository, nativeRuntime: f.native }, interaction.id)).deliveryState).not.toBe('delivered')
      expect(br3002ApprovalReplies(f)).toBe(0)
      await compare()
      cuts.continueAssistant.resolve()
    }
    if (variant.reviewOutcome) {
      const args = await br1002At(cuts.beforeMarker.promise, dispatch)
      expect(server.generation).toBe(generation)
      expect(args[1].connectionId).toBe(started[1].connectionId)
      const proof = readOpenCodeReconciliation(args[1], { ownerAgentId: job.reviewerAgentId, nativeSessionId: job.nativeSessionId,
        correlationId: job.correlationId, nativeTurnId: started[0].providerTurnOrMessageId!, providerVersion: server.expectedVersion })!
      expect(proof).toBeDefined()
      expect(proof.outcome).toBe(variant.ordinaryOutcome)
      const raw = (await f.db.pool.query<{ record: { connectionId: string; payload: { nativeEventId: string } }; source_sequence: string }>(
        'select record,source_sequence::text from harness_native_events where execution_id=$1 and connection_id=$2 and source_sequence=0',
        [host.id, proof.historySource.connectionId])).rows[0]!
      expect(raw.record.payload.nativeEventId).toBe(proof.historySource.nativeEventId)
      expect(raw.record.connectionId).toBe(proof.historySource.connectionId)
      expect(raw.source_sequence).toBe('0')
      expect(raw.record.connectionId).not.toBe(args[1].connectionId)
      const before = await br3002Evidence(f, job.id)
      cuts.enterMarker.resolve()
      await br1002At(cuts.afterMarker.promise, dispatch)
      const settled = await br3002Evidence(f, job.id)
      expect(settled).toMatchObject({ generation: before.generation, approval_native_evidence: {
        kind: 'terminal', submissionId: started[0].providerTurnOrMessageId,
        connectionGeneration: before.generation, terminal: { outcome: variant.reviewOutcome, nativeSettled: true },
      } })
      expect(BigInt(settled.revision)).toBeGreaterThan(BigInt(before.revision))
      const published = await compare()
      expect(published.state.reviews.find((review) => review.reviewJobId === job.id)).toMatchObject({
        revision: settled.revision, acknowledgementId: acknowledgementId(settled.approval_native_evidence ?? undefined),
      })
      await cuts.original(...args) // exact duplicate marker
      await cuts.original(...started) // old acknowledgement after terminal
      if (liveArgs) await cuts.original(...liveArgs) // including a LOST/DELAYED actual frame, delivered after the marker
      await cuts.original(...args) // reordered marker after that old frame
      expect(await br3002Evidence(f, job.id)).toEqual(settled)
      expect((await compare()).asOfSequence).toBe(published.asOfSequence)
      expect(br3002ApprovalReplies(f)).toBe(0)
      cuts.finishMarker.resolve()
    }
    await dispatch
    const final = await br3002Evidence(f, job.id)
    const effects = await br3002Effects(f, job.id)
    const settlements = effects.filter((effect) => effect.effect_kind === 'review.settle')
    if (variant.reviewOutcome) {
      expect(final.state).toBe(hasDecision && variant.reviewOutcome === 'succeeded' ? 'completed' : 'failed')
      expect(settlements).toHaveLength(1)
    } else {
      // Generic interrupted/error fallback (or an incomplete assistant) cannot
      // become durable native review settlement without a qualifying source.
      expect(['completed', 'failed']).not.toContain(final.state)
      expect(final.approval_native_evidence?.kind).not.toBe('terminal')
      expect(settlements).toHaveLength(0)
    }
    await compare()
    const permitted = hasDecision && variant.reviewOutcome === 'succeeded'
    const delivered = await deliverApproval({ repository: f.repository, nativeRuntime: f.native }, interaction.id)
    if (permitted) {
      expect(delivered.deliveryState).toBe('delivered')
      await f.engine.resumeInteraction(delivered)
      expect((await br1002Ack(f, interaction.id))?.approval_native_ack_id).toMatch(/^native-approval-ack-/)
      expect(await f.receipts()).toHaveLength(1)
      // Replay cannot deliver twice, resume twice or schedule another review.
      await deliverApproval({ repository: f.repository, nativeRuntime: f.native }, interaction.id)
      await f.engine.resumeInteraction(delivered)
      expect(await f.receipts()).toHaveLength(1)
      expect(await f.native.reviewers.dispatchNext(job.reviewerAgentId, 'br3-002-repeat')).toBeUndefined()
    } else {
      expect(delivered.deliveryState).not.toBe('delivered')
      expect((await br1002Ack(f, interaction.id))?.approval_native_ack_id ?? null).toBeNull()
      expect(await f.receipts()).toHaveLength(0)
    }
    expect(br3002ApprovalReplies(f)).toBe(permitted ? 1 : 0)
    expect(f.counts().prompts).toBe(3)
    const finalEffects = await br3002Effects(f, job.id)
    expect(finalEffects.filter((effect) => effect.effect_kind === 'review.settle')).toEqual(settlements)
    expect(finalEffects.filter((effect) => effect.effect_kind === 'approval.deliver')).toHaveLength(permitted ? 1 : 0)
    await compare()
    return { state: final.state, outcome: final.approval_native_evidence?.kind === 'terminal'
      ? final.approval_native_evidence.terminal.outcome : undefined,
    settlements: settlements.length, approvalReplies: br3002ApprovalReplies(f), resumeReceipts: (await f.receipts()).length }
  } finally {
    cuts?.release(); cuts?.restore()
    await dispatch?.catch(() => undefined)
    await f.close()
  }
}

afterAll(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('BR3-002 actual OpenCode / ReviewerDispatcher / owned PostgreSQL settlement', () => {
  // Every scenario owns its schema, engine, provider fixture and instance-scoped spies.
  // Concurrent cases avoid serializing thousands of independent PostgreSQL round trips.
  for (const variant of br3002Cases) it.concurrent(`${variant.name}: live, lost-live and reordered-live have one stable policy result`, async () => {
    const live = await runCase(variant, 'live')
    expect(await runCase(variant, 'lost')).toEqual(live)
    expect(await runCase(variant, 'reordered')).toEqual(live)
  }, 180000)

  it.concurrent('requires a durable decision even for a successful stop terminal', async () => {
    const variant = br3002Cases[0]!
    const live = await runCase(variant, 'live', false)
    expect(await runCase(variant, 'lost', false)).toEqual(live)
    expect(live).toMatchObject({ state: 'failed', outcome: 'succeeded', settlements: 1, approvalReplies: 0, resumeReceipts: 0 })
  }, 120000)

  it.concurrent('rejects contradictory terminal evidence rather than overwriting the first failed receipt', async () => {
    const f = await br1002OpenCodeRuntime('orchestrator')
    let cuts: ReturnType<typeof br3002Cuts> | undefined, dispatch: Promise<unknown> | undefined
    try {
      const { interaction, job, server } = await start(f)
      const { compare } = await graphParity(f.db.pool, f.f.scope)
      cuts = br3002Cuts(f)
      dispatch = f.native.reviewers.dispatchNext(job.reviewerAgentId, 'br3-002-conflict')
      void dispatch.catch(() => undefined)
      const started = await br1002At(cuts.started.promise, dispatch)
      await br3002Decision(f, started)
      cuts.continueStart.resolve()
      br3002Notify(server, br3002Assistant(server, job.correlationId, job.nativeSessionId, br3002Cases[1]!), false)
      const args = await br1002At(cuts.beforeMarker.promise, dispatch)
      cuts.enterMarker.resolve(); await br1002At(cuts.afterMarker.promise, dispatch)
      const first = await br3002Evidence(f, job.id), published = await compare()
      expect(first.approval_native_evidence).toMatchObject({ kind: 'terminal', terminal: { outcome: 'failed' } })
      // Negative-only corruption injection: another provider-shaped raw
      // assistant and a contradictory, well-shaped marker. The real manager's
      // cache does NOT emit these sources; the captured-original fence rejects
      // both before a competing terminal can reach the graph.
      const other = br3002Assistant(server, job.correlationId, job.nativeSessionId, br3002Cases[0]!)
      const raw = normalizedHistory([other], false)[0]!
      await expect(cuts.original(args[0], raw, { ...args[2]!, live: false }))
        .rejects.toMatchObject({ code: 'REVIEW_ORIGINAL_SOURCE_CONFLICT' })
      const payload = openCodeReconciliationPayload({ harness: job.provider, nativeSessionId: job.nativeSessionId,
        providerVersion: server.expectedVersion }, job.reviewerAgentId, job.correlationId, started[0].providerTurnOrMessageId!, raw, 'succeeded')!
      expect(payload).toBeDefined()
      await expect(cuts.original(args[0], { ...args[1], sequence: args[1].sequence + 1000, payload }, args[2]))
        .rejects.toMatchObject({ code: 'REVIEW_ORIGINAL_SOURCE_CONFLICT' })
      expect(await br3002Evidence(f, job.id)).toEqual(first)
      expect((await compare()).asOfSequence).toBe(published.asOfSequence)
      expect((await deliverApproval({ repository: f.repository, nativeRuntime: f.native }, interaction.id)).deliveryState).not.toBe('delivered')
      expect(br3002ApprovalReplies(f)).toBe(0)
      cuts.finishMarker.resolve(); await dispatch
      expect((await br3002Effects(f, job.id)).filter((effect) => effect.effect_kind === 'review.settle')).toHaveLength(1)
    } finally { cuts?.release(); cuts?.restore(); await dispatch?.catch(() => undefined); await f.close() }
  }, 60000)

  for (const fault of ['job-owner', 'writer-owner', 'expired-job', 'expired-writer', 'old-generation',
    'old-connection', 'native-session', 'correlation', 'provider-version', 'Stop'] as const) {
    it.concurrent(`cannot settle or deliver a decided review across ${fault}`, async () => {
      const f = await br1002OpenCodeRuntime('orchestrator')
      let cuts: ReturnType<typeof br3002Cuts> | undefined, dispatch: Promise<unknown> | undefined
      try {
        const { interaction, job, server } = await start(f)
        const { compare } = await graphParity(f.db.pool, f.f.scope)
        cuts = br3002Cuts(f)
        dispatch = f.native.reviewers.dispatchNext(job.reviewerAgentId, `br3-002-${fault}`)
        void dispatch.catch(() => undefined)
        const started = await br1002At(cuts.started.promise, dispatch)
        await br3002Decision(f, started)
        cuts.continueStart.resolve()
        br3002Notify(server, br3002Assistant(server, job.correlationId, job.nativeSessionId, br3002Cases[0]!), false)
        const args = await br1002At(cuts.beforeMarker.promise, dispatch), projection = args[2]!
        const before = await br3002Evidence(f, job.id)
        if (fault === 'job-owner') {
          await expect(cuts.original({ ...args[0], leaseToken: 'expired-owner-token' }, args[1], projection))
            .rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
        } else if (fault === 'writer-owner') {
          await expect(cuts.original(args[0], args[1], { ...projection, writer: { ...projection.writer, token: 'expired-writer-token' } }))
            .rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
        } else if (fault === 'expired-job') {
          await f.db.pool.query("update review_jobs set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb($2::text)) where id=$1",
            [job.id, '2000-01-01T00:00:00.000Z'])
          await expect(cuts.original(...args)).rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
        } else if (fault === 'expired-writer') {
          await f.db.pool.query("update native_session_lanes set record=jsonb_set(record,'{leaseExpiresAt}',to_jsonb($2::text)) where id=$1",
            [projection.writer.id, '2000-01-01T00:00:00.000Z'])
          await expect(cuts.original(...args)).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
        } else if (fault === 'old-generation') {
          await f.db.pool.query(`update native_session_lanes set record=jsonb_set(record,'{connectionGeneration}',
            to_jsonb((record->>'connectionGeneration')::integer+1)) where id=$1`, [projection.writer.id])
          await expect(cuts.original(...args)).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
        } else if (fault === 'old-connection') {
          await expect(cuts.original(args[0], { ...args[1], connectionId: 'old-connection-not-current' }, projection))
            .rejects.toMatchObject({ code: 'REVIEW_ORIGINAL_SOURCE_CONFLICT' })
        } else if (fault === 'native-session' || fault === 'correlation') {
          const fields = fault === 'native-session' ? { nativeSessionId: 'ses_not_owned' } : { correlationId: 'not-this-review' }
          await expect(cuts.original({ ...args[0], ...fields }, args[1], projection)).rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
        } else if (fault === 'provider-version') {
          await f.db.pool.query("update review_jobs set provider_version='wrong-provider-version' where id=$1", [job.id])
          await cuts.original(...args)
        } else {
          await f.stop()
          // Already-owned terminal evidence may truthfully aid cleanup after Stop;
          // it must not authorize business completion or Worker delivery.
          await cuts.original(...args).catch((error: unknown) => { expect(error).toBeDefined() })
        }
        const after = await br3002Evidence(f, job.id)
        if (fault !== 'Stop') {
          expect(after.approval_native_evidence).toEqual(before.approval_native_evidence)
          expect(after.revision).toBe(before.revision)
        }
        expect(after.state).not.toBe('completed')
        expect((await deliverApproval({ repository: f.repository, nativeRuntime: f.native }, interaction.id)).deliveryState).not.toBe('delivered')
        expect(br3002ApprovalReplies(f)).toBe(0)
        expect(await f.receipts()).toHaveLength(0)
        expect((await br1002Ack(f, interaction.id))?.approval_native_ack_id ?? null).toBeNull()
        expect(f.counts().prompts).toBe(3)
        const latest = await compare()
        if (fault === 'Stop') expect(latest.state.run.stopRequested).toBe(true)
        // No new-generation recovery or BR3-001 cleanup/retirement claim here.
      } finally { cuts?.release(); cuts?.restore(); await dispatch?.catch(() => undefined); await f.close() }
    }, 60000)
  }
})
