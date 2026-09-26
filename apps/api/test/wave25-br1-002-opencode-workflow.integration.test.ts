import { afterEach, describe, expect, it, vi } from 'vitest'
import { insertCurrentRunFixture } from './helpers/eng04CurrentRunFixture.js'
import { nativeGraphSource } from '../src/modules/run-graph/nativeIngestion.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { readOpenCodeReconciliation } from '../src/modules/harnesses/opencodeReconciliation.js'
import { nativeMessageId } from '../src/modules/harnesses/opencodeProtocol.js'
import { deferred, postgresEnabled } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { br1002OpenCodeRuntime, br1002Response } from './helpers/wave25Br1002OpenCodeRuntime.js'
import { br1002Ack, br1002At, br1002Batches, br1002ContinuationCut,
  type Br1002NativeArgs, type Br1002Runtime } from './helpers/wave25Br1002Cuts.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('BR1-002 actual OpenCode coordinator / PostgreSQL saver / Worker acknowledgement', () => {
  it('compares complete replay at delivery, real saver consume, one acknowledgement/retirement and terminal cuts', async () => {
    const f = await br1002OpenCodeRuntime()
    const replyEntered = deferred(), replyRelease = deferred()
    let cut: ReturnType<typeof br1002ContinuationCut> | undefined
    let response: Promise<unknown> | undefined
    try {
      const { compare } = await graphParity(f.db.pool, f.f.scope)
      await compare()
      await f.engine.start(f.f.run.id)
      const [interaction] = await f.pending()
      if (!interaction) throw new Error('The actual coordinator did not create an OpenCode approval')
      const waiting = await compare()
      expect(waiting.state.interactions.some((i) => i.interactionId === interaction.id)).toBe(true)
      expect(interaction.graphInterruptId).toBeTruthy()
      const checkpoint = await f.saver.getTuple(f.config)
      expect(checkpoint).toBeDefined()
      const server = f.servers.get(interaction.executionId)!
      server.beforeReply = async () => { replyEntered.resolve(); await replyRelease.promise }
      cut = br1002ContinuationCut(f)
      response = f.service.respond({ kind: 'user', principal: f.principal }, br1002Response(interaction))
      await br1002At(replyEntered.promise, response)
      await compare()
      expect(await f.receipts()).toHaveLength(0)
      expect((await br1002Ack(f, interaction.id))?.approval_native_ack_id ?? null).toBeNull()
      replyRelease.resolve()
      const args = await br1002At(cut.before.promise, response)
      const [event, , lease, , continuation] = args
      expect(lease?.live).toBe(false)
      expect(continuation?.correlationId).toBe(`execution:${interaction.executionId}`)
      expect(continuation?.providerId).toBe(nativeMessageId(`execution:${interaction.executionId}`))
      expect(continuation?.responseDeliveries).toHaveLength(1)
      expect((await f.repository.get(interaction.id))?.deliveryState).toBe('delivered')
      expect(await f.receipts()).toHaveLength(1)
      // Inspect the actual saver tuple at the interrupted checkpoint, not a fake
      // Command.resume or a second pool's invented checkpoint write.
      const consumed = await f.saver.getTuple(checkpoint!.config)
      expect(consumed?.pendingWrites?.filter((write) => write[1] === '__resume__')).toHaveLength(1)
      expect(await br1002Ack(f, interaction.id)).toMatchObject({ state: 'resumed', approval_native_ack_id: null })
      const pendingNative = await compare()
      expect(pendingNative.state.interactions.some((i) => i.interactionId === interaction.id)).toBe(true)
      const proof = readOpenCodeReconciliation(event, { ownerAgentId: interaction.requestingAgentId,
        correlationId: continuation!.correlationId, nativeTurnId: continuation!.providerId,
        nativeSessionId: interaction.nativeSessionId, providerVersion: interaction.providerVersion })!
      expect(proof).toBeDefined()
      const raw = (await f.db.pool.query<{ source_sequence: string; record: typeof event }>(
        'select source_sequence::text,record from harness_native_events where execution_id=$1 and connection_id=$2 and source_sequence=0',
        [interaction.executionId, proof.historySource.connectionId])).rows[0]!
      expect(raw.source_sequence).toBe('0')
      expect(raw.record.connectionId).toBe(proof.historySource.connectionId)
      expect(raw.record.payload.nativeEventId).toBe(proof.historySource.nativeEventId)
      expect(raw.record.type).toBe('message.updated')
      expect(event.connectionId).not.toBe(raw.record.connectionId)
      cut.enter.resolve()
      await br1002At(cut.after.promise, response)
      const acknowledged = await compare()
      expect(acknowledged.state.interactions.some((i) => i.interactionId === interaction.id)).toBe(false)
      expect(acknowledged.state.run.pendingInteractionCount).toBe(0)
      expect(await br1002Ack(f, interaction.id)).toMatchObject({
        state: 'resumed', approval_native_ack_source: nativeGraphSource(event),
      })
      const batches = await br1002Batches(f)
      const retirement = batches.filter((batch) => batch.facts.some((fact) => fact.type === 'worker.resumed'
        && fact.interactionId === interaction.id))
      expect(retirement).toHaveLength(1)
      const final = retirement[0]!.facts.find((fact) => fact.type === 'interaction.state' && fact.interaction.interactionId === interaction.id)
      const retired = retirement[0]!.facts.find((fact) => fact.type === 'exchange.retired' && fact.exchangeId === interaction.id)
      expect(final?.type).toBe('interaction.state')
      expect(retired?.type).toBe('exchange.retired')
      if (final?.type !== 'interaction.state' || retired?.type !== 'exchange.retired') throw new Error('Incomplete retirement publication')
      expect(final.interaction.resumeState).toBe('acknowledged')
      expect(retired.finalRevision).toBe(final.interaction.revision)
      // Duplicate/reordered raw observations use the exact original tuples and
      // currently held owner; neither another provider action nor another ack.
      await cut.original(...args)
      await cut.original(...args)
      expect((await compare()).asOfSequence).toBe(acknowledged.asOfSequence)
      cut.finish.resolve()
      await response
      const terminal = await compare()
      expect(terminal.state.run.outcome).toBe('succeeded')
      expect(terminal.state.run.pendingInteractionCount).toBe(0)
      expect(f.counts()).toEqual({ sessions: 2, prompts: 2, responses: 1 })
      expect((await br1002Batches(f)).flatMap((b) => b.facts).filter((fact) => fact.type === 'worker.resumed')).toHaveLength(1)
      expect((await f.db.pool.query("select 1 from harness_native_events where execution_id=$1 and record->>'type' in ('turn.completed','turn/completed')",
        [interaction.executionId])).rowCount).toBe(0)
      await f.service.reconcile((await f.repository.get(interaction.id))!)
      expect((await compare()).asOfSequence).toBe(terminal.asOfSequence)
      expect(f.counts().responses).toBe(1)
    } finally {
      replyRelease.resolve(); cut?.release()
      await response?.catch(() => undefined)
      cut?.restore(); await f.close()
    }
  }, 60000)

  it('an exact response receipt and completed native history cannot acknowledge before real checkpoint consumption', async () => {
    const f = await br1002OpenCodeRuntime()
    try {
      await f.engine.start(f.f.run.id)
      const { compare } = await graphParity(f.db.pool, f.f.scope)
      const [i] = await f.pending()
      if (!i) throw new Error('Expected a real approval wait')
      const crash = vi.spyOn(f.engine, 'resumeInteraction').mockRejectedValue(new Error('BR1-002 before real saver consume'))
      await f.service.respond({ kind: 'user', principal: f.principal }, br1002Response(i))
      crash.mockRestore()
      const delivered = (await f.repository.get(i.id))!
      expect(delivered.deliveryState).toBe('delivered')
      expect(await f.receipts()).toHaveLength(0)
      const attached = await f.native.attachInteraction(delivered)
      if (!(attached.manager instanceof SingleWriterSessionManager)) throw new Error('Expected the actual qualified writer')
      const owner = await RunOwnership.acquire(f.db.pool, f.f.run.id, () => undefined)
      if (!owner) throw new Error('Expected the waiting Run owner to be available')
      try {
        await attached.manager.withLane(attached.session, `execution:${i.executionId}`, undefined, async (native, lane) => {
          const history = await native.reconcile(attached.session, `execution:${i.executionId}`)
          const terminal = history.terminalTurn!
          expect(terminal.correlationId).toBe(`execution:${i.executionId}`)
          expect(history.responseDeliveries).toHaveLength(1)
          lane.providerId = terminal.providerId
          for (const event of history.events) await f.runs.appendNativeEvent({ ...event, executionId: i.executionId }, owner,
            { ...lane.fence, providerId: terminal.providerId, live: false }, undefined,
            { session: attached.session, providerId: terminal.providerId, correlationId: terminal.correlationId,
              responseDeliveries: history.responseDeliveries ?? [] })
        })
      } finally { await owner.release() }
      expect((await br1002Ack(f, i.id))?.approval_native_ack_id ?? null).toBeNull()
      expect((await compare()).state.interactions.some((item) => item.interactionId === i.id)).toBe(true)
      await f.engine.resumeInteraction(delivered)
      expect(await f.receipts()).toHaveLength(1)
      expect((await br1002Ack(f, i.id))?.approval_native_ack_id).toMatch(/^continuation-ack-/)
      expect((await compare()).state.interactions.some((item) => item.interactionId === i.id)).toBe(false)
      expect(f.counts()).toEqual({ sessions: 2, prompts: 2, responses: 1 })
    } finally { await f.close() }
  }, 60000)

  for (const field of ['missing', 'nativeRequestId', 'nativeRequestType', 'nativeSessionId', 'providerVersion', 'optionId', 'semantic', 'harness', 'source', 'contradictory'] as const) {
    it(`retains the outstanding native obligation for ${field} response evidence after a real saver consume`, async () => {
      const f = await br1002OpenCodeRuntime()
      let response: Promise<unknown> | undefined
      let cut: ReturnType<typeof br1002ContinuationCut> | undefined
      try {
        await f.engine.start(f.f.run.id)
        const { compare } = await graphParity(f.db.pool, f.f.scope)
        const [i] = await f.pending()
        if (!i) throw new Error('Expected approval')
        cut = br1002ContinuationCut(f, (args) => {
          const altered: Br1002NativeArgs = [...args]
          const proof = args[4]!
          const receipts = field === 'missing' ? [] : field === 'contradictory'
            ? [...proof.responseDeliveries, ...proof.responseDeliveries.map((receipt) => ({ ...receipt, semantic: 'reject' }))]
            : proof.responseDeliveries.map((receipt) => ({ ...receipt, [field]: 'foreign' }))
          // Explicit negative injection at the coordinator's provider-result
          // boundary. All event/source IDs and persisted delivery stay intact.
          altered[4] = { ...proof, responseDeliveries: receipts as typeof proof.responseDeliveries }
          return altered
        })
        response = f.service.respond({ kind: 'user', principal: f.principal }, br1002Response(i))
        await br1002At(cut.before.promise, response)
        cut.enter.resolve()
        await br1002At(cut.after.promise, response)
        expect(await f.receipts()).toHaveLength(1)
        expect((await br1002Ack(f, i.id))?.approval_native_ack_id ?? null).toBeNull()
        const stillPending = await compare()
        expect(stillPending.state.interactions.some((item) => item.interactionId === i.id)).toBe(true)
        expect((await br1002Batches(f)).flatMap((batch) => batch.facts).filter((fact) => fact.type === 'worker.resumed')).toHaveLength(0)
        cut.finish.resolve(); await response
        await compare()
        expect(f.counts()).toEqual({ sessions: 2, prompts: 2, responses: 1 })
      } finally { cut?.release(); await response?.catch(() => undefined); cut?.restore(); await f.close() }
    }, 60000)
  }

  for (const field of ['correlation', 'turn', 'session', 'provider-version', 'provider'] as const) {
    it(`rejects a mismatched ${field} continuation even with unchanged authentic raw history and exact response receipt`, async () => {
      const f = await br1002OpenCodeRuntime()
      let response: Promise<unknown> | undefined
      let cut: ReturnType<typeof br1002ContinuationCut> | undefined
      try {
        await f.engine.start(f.f.run.id)
        const { compare } = await graphParity(f.db.pool, f.f.scope)
        const [i] = await f.pending()
        if (!i) throw new Error('Expected approval')
        cut = br1002ContinuationCut(f, (args) => {
          const altered: Br1002NativeArgs = [...args], original = args[4]!
          altered[4] = { ...original, session: { ...original.session } }
          if (field === 'correlation') altered[4].correlationId = 'execution:another-execution'
          if (field === 'turn') altered[4].providerId = 'msg_another_turn'
          if (field === 'session') altered[4].session.nativeSessionId = 'ses_another_session'
          if (field === 'provider-version') altered[4].session.providerVersion = 'another-version'
          if (field === 'provider') altered[4].session.harness = 'codex'
          return altered
        })
        response = f.service.respond({ kind: 'user', principal: f.principal }, br1002Response(i))
        await br1002At(cut.before.promise, response)
        cut.enter.resolve(); await br1002At(cut.after.promise, response)
        expect(await f.receipts()).toHaveLength(1)
        expect((await br1002Ack(f, i.id))?.approval_native_ack_id ?? null).toBeNull()
        expect((await compare()).state.interactions.some((item) => item.interactionId === i.id)).toBe(true)
        expect((await br1002Batches(f)).flatMap((batch) => batch.facts).filter((fact) => fact.type === 'worker.resumed')).toHaveLength(0)
        cut.finish.resolve(); await response; await compare()
        expect(f.counts()).toEqual({ sessions: 2, prompts: 2, responses: 1 })
      } finally { cut?.release(); await response?.catch(() => undefined); cut?.restore(); await f.close() }
    }, 60000)
  }

  for (const boundary of ['writer-token', 'writer-generation', 'run-owner', 'foreign-run-owner', 'Stop'] as const) {
    it(`does not acknowledge a completed history after ${boundary} changes`, async () => {
      const f: Br1002Runtime = await br1002OpenCodeRuntime()
      let response: Promise<unknown> | undefined
      let cut: ReturnType<typeof br1002ContinuationCut> | undefined
      try {
        await f.engine.start(f.f.run.id)
        const { compare } = await graphParity(f.db.pool, f.f.scope)
        const [i] = await f.pending()
        if (!i) throw new Error('Expected approval')
        cut = br1002ContinuationCut(f)
        response = f.service.respond({ kind: 'user', principal: f.principal }, br1002Response(i))
        const args = await br1002At(cut.before.promise, response)
        const owner = args[1]!, lease = args[2]!
        if (boundary === 'writer-token') {
          await expect(cut.original(args[0], owner, { ...lease, token: 'not-the-held-token' }, args[3], args[4]))
            .rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
        } else if (boundary === 'writer-generation') {
          await f.db.pool.query(`update native_session_lanes set record=jsonb_set(record,'{connectionGeneration}',
            to_jsonb((record->>'connectionGeneration')::integer+1)) where id=$1`, [lease.id])
          await cut.original(...args)
        } else if (boundary === 'foreign-run-owner') {
          const revision = Number((await f.db.pool.query<{ revision: string }>(
            'select revision::text from workflows where id=$1', [f.f.scope.workflowId])).rows[0]!.revision)
          const { run: otherRun } = await insertCurrentRunFixture(f.db.pool,
            { ...f.f, run: { ...f.f.run, id: `${f.f.run.id}-foreign` } },
            { workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId, revision,
              currentVersionId: f.f.version.id, version: f.f.version }, f.f.run.authorizationPrincipalId!)
          const otherOwner = await RunOwnership.acquire(f.db.pool, otherRun.id, () => undefined)
          if (!otherOwner) throw new Error('Expected an actual independent foreign Run owner')
          const otherPublications = (await f.db.pool.query('select sequence::text,payload from run_graph_batches where run_id=$1 order by sequence', [otherRun.id])).rows
          try {
            // The event is authentic but belongs to the original Run. No raw
            // source or publication may be attributed to this different owner.
            await expect(cut.original(args[0], otherOwner, lease, args[3], args[4])).rejects.toBeDefined()
            expect((await f.db.pool.query('select sequence::text,payload from run_graph_batches where run_id=$1 order by sequence', [otherRun.id])).rows).toEqual(otherPublications)
          } finally { await otherOwner.release() }
        } else if (boundary === 'run-owner') {
          await owner.release()
          await expect(cut.original(...args)).rejects.toBeDefined()
        } else {
          await f.stop()
          await cut.original(...args)
        }
        expect((await br1002Ack(f, i.id))?.approval_native_ack_id ?? null).toBeNull()
        expect((await br1002Batches(f)).flatMap((batch) => batch.facts).filter((fact) => fact.type === 'worker.resumed')).toHaveLength(0)
        await compare()
        expect(f.counts()).toEqual({ sessions: 2, prompts: 2, responses: 1 })
        // Negative authority cuts are observed while the coordinator is paused.
        // Releasing it is cleanup, NOT evidence of successful new-generation
        // takeover or canceled-exchange parity (the separate BR2-002 lane).
      } finally { cut?.release(); await response?.catch(() => undefined); cut?.restore(); await f.close() }
    }, 60000)
  }
})
