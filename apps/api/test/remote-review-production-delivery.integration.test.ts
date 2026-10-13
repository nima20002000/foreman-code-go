import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { deliveredReview, receipts, reviewInProgress, useRemoteReviewFixture } from './helpers/remoteReviewProductionCases.js'

let diagnosticOutput: MockInstance<typeof console.info>
beforeAll(() => {
  diagnosticOutput = vi.spyOn(console, 'info')
})
const withRemoteReviewFixture = useRemoteReviewFixture()
afterAll(() => diagnosticOutput.mockRestore())

describe('production remote review and native recovery through authenticated MCP', () => {
  it('persists a delivered remote decision and denies a read-only caller on the same product endpoint', async () => {
    await withRemoteReviewFixture(async fixture => {
      const active = await reviewInProgress(fixture)
      const run = SavedRunDetailsSchema.parse(await fixture.value('run_get', {
        workspaceId: active.run.workspaceId, runId: active.run.id, detail: 'full',
      }))
      expect(run.executions.find(execution => execution.id === active.reviewer.id)).toMatchObject({
        state: 'completed', result: { outcome: 'succeeded' }, nativeSessionId: active.reviewer.nativeSessionId,
      })
      expect(run.executions.find(execution => execution.id === active.requester.id)).toMatchObject({
        state: 'waiting', nativeSessionId: active.interaction.nativeSessionId,
      })
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
      // Phase reporting must stay bounded while the native workflow runs.
      const output = diagnosticOutput.mock.calls.map(arguments_ => JSON.stringify(arguments_)).join('\n')
      expect(Buffer.byteLength(output)).toBeLessThan(64 * 1024)
    })
  }, 240_000)
})
