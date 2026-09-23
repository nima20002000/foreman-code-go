import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import type { HarnessNativeEvent, NativeHarnessEvent } from '@graphql/contracts'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { NATIVE_PRODUCER_MAX_BYTES, NATIVE_PRODUCER_REJECTION_TYPE } from '../src/modules/run-graph/nativeProducerNormalization.js'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'

/** Real repository callback + PostgreSQL raw allocation/deduplication regressions.
 * No manual graph consumer or approval_native_evidence seeding. This intentionally
 * narrower suite does NOT qualify ApprovalExecutionCoordinator/ReviewerDispatcher,
 * graph projection, review settlement, or Worker continuation. It must be extended
 * by the remaining BR1-002 positive production-composition tests. */
describe('BR1-002 production raw callback rejection/replay persistence', () => {
  let f: Awaited<ReturnType<typeof approvalDatabase>>
  let runs: PostgresRunRepository
  let dispose: (() => Promise<void>) | undefined
  beforeEach(async () => {
    dispose = undefined
    f = await approvalDatabase()
    dispose = f.close
    const locations = new WorkspaceLocationService(f.pool, new PostgresCommandCoordinator(f.pool), tmpdir())
    runs = new PostgresRunRepository(f.pool, new PostgresWorkflowRepository(f.pool), locations)
  }, 60000)
  afterEach(async () => { const close = dispose; dispose = undefined; await close?.() })

  function frame(sequence: number, payload: Record<string, unknown>, type = 'text.delta', connectionId = 'br1-002-source-a'): NativeHarnessEvent {
    return { connectionId, sequence, type, occurredAt: '2026-09-22T00:00:00.000Z', payload }
  }
  async function raw(executionId: string) {
    return (await f.pool.query<{ sequence: number; source_sequence: number | null; connection_id: string | null; record: HarnessNativeEvent }>(
      'select sequence,source_sequence,connection_id,record from harness_native_events where execution_id=$1 order by sequence', [executionId])).rows
  }
  async function nativeActivity(executionId: string) {
    return (await f.pool.query<{ payload: { nativeEventSequence: number; nativeEventType: string } }>(
      "select payload from run_activity where harness_execution_id=$1 and kind='harness_output' order by sequence", [executionId])).rows
  }

  it('workflow callback rejects a retained oversized source and preserves the next valid event on live/replay', async () => {
    const owner = await runs.acquireOwnership(f.run.id, () => undefined)
    if (!owner) throw new Error('Test could not acquire the real Run owner')
    try {
      const retained = [frame(12, { text: 'x'.repeat(NATIVE_PRODUCER_MAX_BYTES) }), frame(13, { text: 'valid, already redacted' })]
      const callback = (event: NativeHarnessEvent) => runs.appendNativeEvent({ ...event, executionId: f.requester.id }, owner)
      for (const event of retained) await callback(event) // live callback
      for (const event of retained) await callback(event) // the provider retains the ORIGINAL oversized source
      for (const event of [...retained].reverse()) await callback(event)
      const rows = await raw(f.requester.id)
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.source_sequence)).toEqual([12, 13])
      expect(rows[0]!.record.type).toBe(NATIVE_PRODUCER_REJECTION_TYPE)
      expect(Buffer.byteLength(JSON.stringify(rows[0]!.record))).toBeLessThan(4096)
      expect(rows[1]!.record.payload).toEqual(retained[1]!.payload)
      expect(retained[0]!.type).toBe('text.delta')
      const activities = await nativeActivity(f.requester.id)
      expect(activities.map((row) => row.payload.nativeEventSequence)).toEqual(rows.map((row) => row.sequence))
    } finally { await owner.release() }
  })

  it('the qualified reviewer callback uses the same normalization on a completed workflow host', async () => {
    expect(f.reviewer.state).toBe('completed')
    const retained = [frame(50, { item: { id: 'x'.repeat(32769), type: 'commandExecution' } }, 'item.started'),
      frame(51, { threadId: f.reviewer.nativeSessionId, item: { id: 'valid-item', type: 'commandExecution' } }, 'item.started')]
    const projection = { writer: { id: `lane-${f.reviewer.id}`, token: 'native-writer-token' },
      live: true, terminalReady: false }
    for (const event of retained) await f.repository.coordination.appendReviewNativeEvent(f.job, event, projection)
    for (const event of retained) await f.repository.coordination.appendReviewNativeEvent(f.job, event, projection)
    const rows = await raw(f.reviewer.id)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.source_sequence)).toEqual([50, 51])
    expect(rows[0]!.record.type).toBe(NATIVE_PRODUCER_REJECTION_TYPE)
    expect(rows[1]!.record.payload).toEqual(retained[1]!.payload)
    expect(await raw(f.requester.id)).toHaveLength(0) // never attribute review raw history to the Worker
    expect((await runs.getExecution(f.reviewer.id))?.state).toBe('completed')
  })

  it('rejects a v2 reviewer callback without its current writer fence', async () => {
    await expect(f.repository.coordination.appendReviewNativeEvent(f.job,
      frame(60, { threadId: f.reviewer.nativeSessionId, turnId: 'unqualified' }, 'turn.started')))
      .rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
    expect(await raw(f.reviewer.id)).toHaveLength(0)
  })

  it('a later bounded variant cannot resurrect a rejected source, including from a fresh repository instance', async () => {
    const source = frame(70, { text: 'x'.repeat(NATIVE_PRODUCER_MAX_BYTES) })
    await runs.appendNativeEvent({ ...source, executionId: f.requester.id })
    const cold = new PostgresRunRepository(f.pool, new PostgresWorkflowRepository(f.pool),
      new WorkspaceLocationService(f.pool, new PostgresCommandCoordinator(f.pool), tmpdir()))
    await cold.appendNativeEvent({ ...source, executionId: f.requester.id, type: 'turn.completed', payload: { turn: { id: 'not-proof', status: 'completed' } } })
    await cold.appendNativeEvent({ ...frame(71, { text: 'next' }), executionId: f.requester.id })
    const rows = await raw(f.requester.id)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.record.type).toBe(NATIVE_PRODUCER_REJECTION_TYPE)
    expect(rows[1]!.source_sequence).toBe(71)
  })

  it('does not coalesce different source connections or swallow accepted-source conflicts', async () => {
    const first = frame(2, { text: 'first' })
    await runs.appendNativeEvent({ ...first, executionId: f.requester.id })
    await runs.appendNativeEvent({ ...frame(2, { text: 'second' }, 'text.delta', 'br1-002-source-b'), executionId: f.requester.id })
    await runs.appendNativeEvent({ ...first, executionId: f.requester.id })
    expect(await raw(f.requester.id)).toHaveLength(2)
    await expect(runs.appendNativeEvent({ ...first, executionId: f.requester.id, payload: { text: 'conflicting' } }))
      .rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT' })
  })

  it('preserves connection-less legacy numbering and makes repeated rejections a no-op', async () => {
    const legacy = { ...frame(400, { text: 'x'.repeat(NATIVE_PRODUCER_MAX_BYTES) }), connectionId: undefined }
    await runs.appendNativeEvent({ ...legacy, executionId: f.requester.id })
    await runs.appendNativeEvent({ ...legacy, executionId: f.requester.id })
    const rows = await raw(f.requester.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sequence: 400, source_sequence: null, connection_id: null })
    expect(rows[0]!.record.type).toBe(NATIVE_PRODUCER_REJECTION_TYPE)
  })

  it('retains late native metadata as its own raw source rather than changing an earlier source body', async () => {
    const part = frame(1, { part: { id: 'part-a', messageID: 'message-a', type: 'tool', tool: 'read', state: { status: 'running' } } }, 'message.part.updated')
    const metadata = frame(2, { info: { id: 'message-a', parentID: 'request-a', sessionID: 'session-a', role: 'assistant' } }, 'message.updated')
    for (const event of [part, metadata, part]) await runs.appendNativeEvent({ ...event, executionId: f.requester.id })
    const rows = await raw(f.requester.id)
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.record.payload)).toEqual([part.payload, metadata.payload])
  })

  it('cannot turn a rejected terminal-looking frame into success after durable Stop', async () => {
    await runs.requestStop(f.run.id)
    const before = (await f.pool.query('select record,execution_state,stop_requested_at from runs where id=$1', [f.run.id])).rows
    const batches = (await f.pool.query('select count(*)::text as count from run_graph_batches where run_id=$1', [f.run.id])).rows
    const oversized = frame(100, { text: 'x'.repeat(NATIVE_PRODUCER_MAX_BYTES), turn: { id: 'not-proof', status: 'completed' } }, 'turn.completed')
    await runs.appendNativeEvent({ ...oversized, executionId: f.requester.id })
    await runs.appendNativeEvent({ ...oversized, executionId: f.requester.id })
    expect((await raw(f.requester.id))[0]!.record.type).toBe(NATIVE_PRODUCER_REJECTION_TYPE)
    expect((await f.pool.query('select record,execution_state,stop_requested_at from runs where id=$1', [f.run.id])).rows).toEqual(before)
    expect((await f.pool.query('select count(*)::text as count from run_graph_batches where run_id=$1', [f.run.id])).rows).toEqual(batches)
  })
})
