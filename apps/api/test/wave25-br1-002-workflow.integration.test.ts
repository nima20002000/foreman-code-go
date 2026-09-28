import { describe, expect, it } from 'vitest'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'

describe.skipIf(!postgresEnabled)('BR1-002 production workflow native callback', () => {
  it('persists raw history, exact correlation and graph source from the real coordinator callback', async () => {
    const f = await checkpointRuntimeFixture()
    try {
      await f.engine.start(f.f.run.id)
      const raw = await f.db.pool.query<{ execution_id: string; sequence: string }>(
        `select n.execution_id,n.sequence::text from harness_native_events n
         join harness_executions e on e.id=n.execution_id where e.run_id=$1 order by n.execution_id,n.sequence`, [f.f.run.id])
      const correlations = await f.db.pool.query<{ execution_id: string; work_kind: string; native_session_id: string }>(
        'select execution_id,work_kind,native_session_id from run_native_correlations where run_id=$1 order by execution_id', [f.f.run.id])
      const sources = await f.db.pool.query<{ source_id: string; first_sequence: string }>(
        "select source_id,first_sequence::text from run_graph_sources where run_id=$1 and source_kind='native_event' order by source_id", [f.f.run.id])
      expect(raw.rows.length).toBeGreaterThan(0)
      expect(correlations.rows.length).toBeGreaterThan(0)
      expect(correlations.rows.every((row) => row.work_kind === 'workflow')).toBe(true)
      const approvals = await f.db.pool.query<{ interaction_id: string; native_request_id: string;
        native_session_id: string; proof: { session: { nativeSessionId: string };
          original: { type: string; history: { pendingInteractions: { turn: { nativeRequestId: string } }[] } } } }>(
        `select i.id as interaction_id,i.record->>'nativeRequestId' as native_request_id,
           c.native_session_id,p.record as proof from durable_interactions i
         join run_native_correlations c on c.run_id=i.run_id and c.execution_id=i.execution_id
           and c.work_kind='workflow' and c.native_session_id=i.record->>'nativeSessionId'
         join workflow_native_proofs p on p.proof_id=i.approval_native_request_proof_id
           and p.run_id=i.run_id and p.execution_id=i.execution_id
         where i.run_id=$1`, [f.f.run.id])
      expect(approvals.rows.length).toBeGreaterThan(0)
      expect(approvals.rows.every((row) => row.proof.session.nativeSessionId === row.native_session_id
        && row.proof.original.type === 'history'
        && row.proof.original.history.pendingInteractions.some((request) =>
          request.turn.nativeRequestId === row.native_request_id))).toBe(true)
      expect(sources.rows.length).toBeGreaterThan(0)
      const batches = await f.db.pool.query<{ payload: string }>(
        'select payload from run_graph_batches where run_id=$1 and sequence=any($2::bigint[]) and kind=\'events\'',
        [f.f.run.id, sources.rows.map((row) => row.first_sequence)])
      const facts = batches.rows.flatMap((row) => (JSON.parse(row.payload) as { events: { fact: { type: string;
        state?: { lifecycle: string } } }[] }).events.map((event) => event.fact))
      // The initial queued state is uncertain until the provider's explicit
      // submission acknowledgement promotes this exact turn to running.
      expect(facts.some((fact) => fact.type === 'node.state' && fact.state?.lifecycle === 'unknown')).toBe(true)
      expect(facts.some((fact) => fact.type === 'node.state' && fact.state?.lifecycle === 'running')).toBe(true)
    } finally { await f.close() }
  }, 60000)

  it('records Worker continuation only after the checkpoint receipt and exact native terminal history', async () => {
    const f = await checkpointRuntimeFixture()
    try {
      await f.engine.start(f.f.run.id)
      const [interaction] = await f.pending()
      if (!interaction) throw new Error('Expected the native approval request')
      const option = interaction.responseOptions.find((item) => item.semantic === 'approve_once')
      if (!option) throw new Error('Expected the saved approve-once option')
      const result = await f.service.respond({ kind: 'user', principal: f.principal }, {
        interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision,
      })
      expect(result.interaction.deliveryState).toBe('delivered')
      expect(await f.receipts()).toHaveLength(1)
      const resumed = (await f.db.pool.query<{ approval_native_ack_id: string | null;
        approval_native_ack_source: { sourceKind: string; sourceId: string; sourceRevision: string } | null;
        approval_native_ack_record: { acknowledgementId: string; originalProofId: string } | null }>(
        `select approval_native_ack_id,approval_native_ack_source,approval_native_ack_record
         from interaction_graph_resumes where interaction_id=$1`, [interaction.id])).rows[0]
      expect(resumed?.approval_native_ack_id).toMatch(/^native-approval-ack-/)
      expect(resumed?.approval_native_ack_source).toMatchObject({ sourceKind: 'native_event', sourceRevision: '1' })
      expect(resumed?.approval_native_ack_record?.acknowledgementId).toBe(resumed?.approval_native_ack_id)
      expect(resumed?.approval_native_ack_record?.originalProofId).toBe(resumed?.approval_native_ack_source?.sourceId)
      const batches = await f.db.pool.query<{ payload: string | null }>(
        "select payload from run_graph_batches where run_id=$1 and kind='events' order by sequence", [f.f.run.id])
      const facts = batches.rows.flatMap((row) => row.payload
        ? (JSON.parse(row.payload) as { events: { fact: { type: string; interactionId?: string;
          acknowledgementId?: string } }[] }).events.map((event) => event.fact) : [])
      expect(facts.some((fact) => fact.type === 'worker.resumed' && fact.interactionId === interaction.id
        && fact.acknowledgementId === resumed?.approval_native_ack_id)).toBe(true)
      expect(f.provider.counts.responses).toBe(1)
    } finally { await f.close() }
  }, 60000)

  it('publishes native acknowledgement as running while fresh snapshots and complete replay agree', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { acknowledgeStarts: true })
    try {
      const { compare } = await graphParity(f.db.pool, f.f.scope)
      await compare()
      await f.engine.start(f.f.run.id)
      await compare()
      const batches = await f.db.pool.query<{ payload: string | null }>(
        "select payload from run_graph_batches where run_id=$1 and kind='events' order by sequence", [f.f.run.id])
      const facts = batches.rows.flatMap((row) => row.payload
        ? (JSON.parse(row.payload) as { events: { fact: { type: string; state?: { lifecycle: string } } }[] })
          .events.map((event) => event.fact) : [])
      expect(facts.some((fact) => fact.type === 'node.state' && fact.state?.lifecycle === 'running')).toBe(true)
    } finally { await f.close() }
  }, 60000)

  it('publishes an exact transport disconnect as stale without treating it as terminal success', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { acknowledgeStarts: true, disconnectAfterStart: true })
    try {
      const { compare } = await graphParity(f.db.pool, f.f.scope)
      await compare()
      await f.engine.start(f.f.run.id)
      const disconnected = await compare()
      const batches = await f.db.pool.query<{ payload: string | null }>(
        "select payload from run_graph_batches where run_id=$1 and kind='events' order by sequence", [f.f.run.id])
      const facts = batches.rows.flatMap((row) => row.payload
        ? (JSON.parse(row.payload) as { events: { fact: { type: string; activity?: { status: string } } }[] })
          .events.map((event) => event.fact) : [])
      expect(facts.some((fact) => fact.type === 'node.activity' && fact.activity?.status === 'stale')).toBe(true)
      expect((await f.runs.get(f.f.run.id))?.outcome).not.toBe('succeeded')
      expect((await compare()).asOfSequence).toBe(disconnected.asOfSequence)
      const [interaction] = await f.pending()
      const option = interaction?.responseOptions.find((item) => item.semantic === 'approve_once')
      if (!interaction || !option) throw new Error('Expected one pending approval after disconnect')
      await f.service.respond({ kind: 'user', principal: f.principal }, {
        interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision,
      })
      const afterContinuation = await compare()
      expect(afterContinuation.state.run.outcome).toBe('succeeded')
      expect(afterContinuation.state.nodes.every((node) => node.activity.status !== 'stale')).toBe(true)
    } finally { await f.close() }
  }, 60000)

  it('keeps snapshot and replay equal while native approval delivery is pending and after continuation', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { acknowledgeStarts: true })
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    try {
      await f.engine.start(f.f.run.id)
      const { compare } = await graphParity(f.db.pool, f.f.scope)
      await compare()
      const [interaction] = await f.pending()
      const option = interaction?.responseOptions.find((item) => item.semantic === 'approve_once')
      if (!interaction || !option) throw new Error('Expected pending approval')
      f.provider.beforeRespond = async () => { entered(); await waiting }
      const response = f.service.respond({ kind: 'user', principal: f.principal }, {
        interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision,
      })
      await started
      const pending = await compare()
      expect(pending.state.run.pendingInteractionCount).toBeGreaterThan(0)
      expect(pending.state.interactions.some((item) => item.interactionId === interaction.id)).toBe(true)
      release()
      await response
      const resumed = await compare()
      expect(resumed.state.run.pendingInteractionCount).toBe(0)
      expect(resumed.state.interactions.find((item) => item.interactionId === interaction.id)).toBeUndefined()
    } finally { release(); await f.close() }
  }, 60000)

  it('retains the approval obligation and parity when native delivery is uncertain', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { acknowledgeStarts: true })
    try {
      await f.engine.start(f.f.run.id)
      const { compare } = await graphParity(f.db.pool, f.f.scope)
      await compare()
      const [interaction] = await f.pending()
      const option = interaction?.responseOptions.find((item) => item.semantic === 'approve_once')
      if (!interaction || !option) throw new Error('Expected pending approval')
      f.provider.beforeRespond = async () => { throw new Error('deterministic delivery uncertainty') }
      await f.service.respond({ kind: 'user', principal: f.principal }, {
        interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision,
      })
      const uncertain = await compare()
      expect(uncertain.state.run.pendingInteractionCount).toBeGreaterThan(0)
      expect(uncertain.state.interactions.some((item) => item.interactionId === interaction.id)).toBe(true)
      expect((await f.db.pool.query<{ approval_native_ack_id: string | null }>(
        'select approval_native_ack_id from interaction_graph_resumes where interaction_id=$1', [interaction.id]))
        .rows[0]?.approval_native_ack_id ?? null).toBeNull()
      expect(await f.receipts()).toHaveLength(0)
    } finally { await f.close() }
  }, 60000)
})
