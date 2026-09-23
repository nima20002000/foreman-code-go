import { describe, expect, it } from 'vitest'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('BR1-002 reviewer native callback', () => {
  it('attributes exact acknowledgement and terminal evidence to a completed host review job', async () => {
    const f = await approvalDatabase()
    try {
      const fence = { id: `lane-${f.reviewer.id}`, token: 'native-writer-token' }
      const job = await f.repository.coordination.transitionReviewJob(f.job.id, 'review-owner-token', 'acknowledged', {
        writerFence: fence, providerTurnOrMessageId: 'provider-review-turn', releaseLease: false,
      })
      const event = (sequence: number, type: string, status?: string) => ({ sequence, type,
        occurredAt: new Date().toISOString(), payload: { threadId: f.reviewer.nativeSessionId,
          turnId: 'provider-review-turn', clientCorrelationId: job.correlationId,
          ...(status ? { status } : {}) } })
      await f.repository.coordination.appendReviewNativeEvent(job, event(1, 'turn.started'), {
        writer: fence, live: true, terminalReady: false,
      })
      const acknowledged = (await f.pool.query<{ approval_native_evidence: { kind: string } }>(
        'select approval_native_evidence from review_jobs where id=$1', [job.id])).rows[0]
      expect(acknowledged?.approval_native_evidence.kind).toBe('submission')
      const current = await f.repository.coordination.transitionReviewJob(job.id, 'review-owner-token', 'acknowledged', {
        writerFence: fence, providerTurnOrMessageId: 'provider-review-turn', releaseLease: false,
      })
      expect(current.state).toBe('acknowledged')
      await f.repository.coordination.appendReviewNativeEvent(current, event(2, 'turn.completed', 'completed'), {
        writer: fence, live: true, terminalReady: true,
      })
      const terminal = (await f.pool.query<{ approval_native_evidence: { kind: string; terminal: { nativeSettled: boolean } } }>(
        'select approval_native_evidence from review_jobs where id=$1', [job.id])).rows[0]
      expect(terminal?.approval_native_evidence).toMatchObject({ kind: 'terminal', terminal: { nativeSettled: true } })
      const completed = await f.repository.coordination.transitionReviewJob(job.id, 'review-owner-token', 'completed', {
        writerFence: fence,
      })
      expect(completed.state).toBe('completed')
      expect((await f.pool.query("select count(*)::integer as count from run_native_activity where run_id=$1 and work_kind='review'",
        [f.run.id])).rows[0].count).toBe(1)
      expect((await f.pool.query("select count(*)::integer as count from run_graph_sources where run_id=$1 and source_kind='native_event'",
        [f.run.id])).rows[0].count).toBeGreaterThan(0)
    } finally { await f.close() }
  }, 30000)

  it('does not settle a failed provider turn as a successful review', async () => {
    const f = await approvalDatabase()
    try {
      const fence = { id: `lane-${f.reviewer.id}`, token: 'native-writer-token' }
      const job = await f.repository.coordination.transitionReviewJob(f.job.id, 'review-owner-token', 'acknowledged', {
        writerFence: fence, providerTurnOrMessageId: 'provider-review-turn', releaseLease: false,
      })
      await f.repository.coordination.appendReviewNativeEvent(job, { sequence: 1, type: 'turn.started',
        occurredAt: new Date().toISOString(), payload: { threadId: job.nativeSessionId,
          turnId: 'provider-review-turn', clientCorrelationId: job.correlationId } },
      { writer: fence, live: true, terminalReady: false })
      await f.repository.coordination.appendReviewNativeEvent(job, { sequence: 2, type: 'turn.completed',
        occurredAt: new Date().toISOString(), payload: { threadId: job.nativeSessionId,
          turnId: 'provider-review-turn', clientCorrelationId: job.correlationId, status: 'failed' } },
      { writer: fence, live: true, terminalReady: true })
      const evidence = (await f.pool.query<{ approval_native_evidence: { terminal: { outcome: string } } }>(
        'select approval_native_evidence from review_jobs where id=$1', [job.id])).rows[0]
      expect(evidence?.approval_native_evidence.terminal.outcome).toBe('failed')
      const result = await f.repository.coordination.transitionReviewJob(job.id, 'review-owner-token', 'completed', {
        writerFence: fence,
      })
      expect(result.state).not.toBe('completed')
    } finally { await f.close() }
  }, 30000)
})
