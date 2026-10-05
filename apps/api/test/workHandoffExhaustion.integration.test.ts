import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture, WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { runWorkHandoffWithRestart, workHandoffRuntimeFixture } from './helpers/workHandoffRuntimeFixture.js'
import { trustedWorkNoticePrompt } from '../src/modules/runs/workHandoffNotice.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { finished, workHandoffFixture } from './helpers/workHandoffFixture.js'

describe.skipIf(!postgresEnabled)('exhausted saved work routes', () => {
  for (const recover of [false, true]) {
    for (const disposition of ['automatic_finish', 'named_finish', 'finish_with_findings'] as const) {
      it(`records ${disposition} after the notice (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
        const db = await currentDatabase()
        const named = disposition === 'named_finish'
        const t = await workHandoffFixture(db.pool, `exhaust-${disposition}-${recover}`, (version) => ({ ...version,
          definition: { ...version.definition, handoffs: { contractVersion: 1 },
            executionPolicy: { maxParallelism: 1, maxNodeExecutions: 20 },
            nodes: version.definition.nodes.map((node, index) => {
              const configured = { ...node,
                ...(named && index === 0 ? { choice: { outcomes: [
                  { outcome: 'review', target: { kind: 'edge' as const, relationshipId: 'a-b' } },
                ] } } : {}),
              }
              delete configured.join
              return configured
            }),
            edges: [{ id: 'a-b', kind: 'execution', source: version.entryNodeId,
              target: version.definition.nodes[1]!.id, maxWorkHandoffsPerRun: 1 }],
          } }))
        const finish = (revision: number) => ({ ...finished(revision),
          routing: named ? { kind: 'finish' as const, outcome: 'review' } : { kind: 'finish' as const } })
        try {
          const first = await t.accept(await t.store.ensureWorkEntry(), finish(1))
          const request = await t.store.admitWorkRequest(first.id, 'a-b')
          assert.equal(request.kind, 'accepted')
          const review = await t.accept(request.request.destinationActivationId, {
            routing: { kind: 'return', requestId: request.request.requestId, outcome: 'needs_changes' },
            data: { latestDeliverable: { revision: 1 }, remainingFindings: ['revise'] },
          })
          const returned = await t.store.returnWork(review.id)
          assert.ok(returned.value.continuationActivationId)
          const revised = await t.accept(returned.value.continuationActivationId, finish(2))
          if (recover) await t.restart()
          const denial = await t.store.admitWorkRequest(revised.id, 'a-b')
          assert.equal(denial.kind, 'limit_reached')
          expect((await t.store.admitWorkRequest(revised.id, 'a-b')).kind).toBe('limit_reached')
          const input = await t.input(denial.notice.continuationActivationId)
          const prompt = trustedWorkNoticePrompt(input)
          expect(prompt).toContain('maximum number of work handoffs')
          expect(prompt).toContain('automatic')
          const last = await t.accept(denial.notice.continuationActivationId,
            disposition === 'finish_with_findings' ? {
              routing: { kind: 'finish' },
              data: { latestDeliverable: { revision: 3 }, remainingFindings: ['cannot review further'] },
            } : finish(3))
          const before = (await db.pool.query('select activation_id from run_work_activations where run_id=$1',
            [t.run.id])).rowCount
          if (recover) await t.restart()
          const action = t.route(last)
          expect(await action(denial.notice.continuationActivationId)).toEqual([])
          if (recover) await t.restart()
          expect(await t.route(last)(denial.notice.continuationActivationId)).toEqual([])
          const unresolved = (await db.pool.query<{ reason: string; relationship_id: string | null }>(
            'select reason,relationship_id from run_work_unresolved where run_id=$1', [t.run.id])).rows
          expect(unresolved).toEqual([{ reason: disposition === 'finish_with_findings'
            ? 'finish_with_findings' : 'repeated_exhausted_route',
            relationship_id: disposition === 'finish_with_findings' ? null : 'a-b' }])
          if (disposition !== 'finish_with_findings') {
            const direction = await t.store.admitWorkRequest(last.id, 'a-b')
            assert.equal(direction.kind, 'needs_direction')
            expect(direction.replayed).toBe(true)
          }
          expect((await db.pool.query('select activation_id from run_work_activations where run_id=$1',
            [t.run.id])).rowCount).toBe(before)
          expect((await db.pool.query('select denial_id from run_work_denials where run_id=$1',
            [t.run.id])).rowCount).toBe(1)
          expect((await db.pool.query('select used from run_work_connection_usage where run_id=$1',
            [t.run.id])).rows).toEqual([{ used: 1 }])
          expect((await db.pool.query('select delivery_state from run_work_notices where run_id=$1',
            [t.run.id])).rows).toEqual([{ delivery_state: 'delivered' }, { delivery_state: 'delivered' }])
        } finally { await t.close(); await db.close() }
      }, 120000)
    }

    it(`preserves both exhausted routes (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
      const definition = makeCurrentWorkflowFixture(`multiple-exhausted-${recover}`, 'parallel')
      const sourceId = definition.version.entryNodeId
      const targets = definition.version.definition.nodes.slice(1, 3)
      definition.version.definition.handoffs = { contractVersion: 1 }
      definition.version.definition.executionPolicy = { maxParallelism: 2, maxNodeExecutions: 20 }
      definition.version.definition.nodes = definition.version.definition.nodes.map((node) => {
        const configured = { ...node }
        delete configured.join
        return configured
      })
      definition.version.definition.edges = targets.map((node, index) => ({ id: `a-${index + 1}`,
        kind: 'execution', source: sourceId, target: node.id, maxWorkHandoffsPerRun: 1 }))
      const f = await workHandoffRuntimeFixture(definition, (nodeId, request) => {
        const { work } = WorkActivationInputSchema.parse(request.input)
        if (nodeId !== sourceId) {
          assert.equal(work.kind, 'work_request')
          const outcome = nodeId === targets[0]!.id ? 'needs_changes' : 'accepted'
          return { routing: { kind: 'return', requestId: work.request.requestId, outcome },
            data: { latestDeliverable: { revision: 1 }, remainingFindings: outcome === 'needs_changes' ? ['revise'] : [] } }
        }
        if (work.kind === 'limit_denial' && work.denial.relationshipId === 'a-1') {
          return { routing: { kind: 'finish' },
            data: { latestDeliverable: { revision: 3 }, remainingFindings: ['review unavailable'] } }
        }
        if (work.kind === 'entry') return finished(1)
        if (work.kind === 'work_return') return finished(2)
        return finished(3)
      })
      try {
        const runtime = await runWorkHandoffWithRestart(f, recover, (execution) => {
          const { work } = WorkActivationInputSchema.parse(execution.input)
          return work.kind === 'limit_denial' && work.denial.relationshipId === 'a-2'
        })
        expect(await runtime.runs.get(f.f.run.id)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
        const causes = (await f.db.pool.query<{ relationship_id: string; execution_id: string }>(
          `select relationship_id,execution_id from run_work_unresolved
           where run_id=$1 and relationship_id is not null order by relationship_id`, [f.f.run.id])).rows
        expect(causes.map((row) => row.relationship_id)).toEqual(['a-1', 'a-2'])
        expect(new Set(causes.map((row) => row.execution_id)).size).toBe(1)
        expect((await f.db.pool.query('select used from run_work_connection_usage where run_id=$1', [f.f.run.id])).rows)
          .toEqual([{ used: 1 }, { used: 1 }])
        const before = { ...f.provider.counts }
        await runtime.engine.start(f.f.run.id)
        expect(f.provider.counts).toEqual(before)
        expect((await f.db.pool.query('select run_id from run_work_direction_waits where run_id=$1',
          [f.f.run.id])).rowCount).toBe(1)
      } finally { await f.close() }
    }, 120000)

    it(`describes automatic notice alternatives without named choices (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
      const db = await currentDatabase()
      const t = await workHandoffFixture(db.pool, `automatic-alternative-${recover}`, (version) => ({ ...version,
        definition: { ...version.definition, handoffs: { contractVersion: 1 },
          executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
          nodes: version.definition.nodes.map((node) => {
            const configured = { ...node }
            delete configured.join
            return configured
          }),
          edges: [
            { id: 'a-b', kind: 'execution', source: version.entryNodeId,
              target: version.definition.nodes[1]!.id, maxWorkHandoffsPerRun: 1 },
            { id: 'a-c', kind: 'execution', source: version.entryNodeId, target: version.definition.nodes[2]!.id },
          ],
        } }))
      try {
        const a = await t.accept(await t.store.ensureWorkEntry(), finished(1))
        const ab = await t.store.admitWorkRequest(a.id, 'a-b')
        assert.equal(ab.kind, 'accepted')
        const b = await t.accept(ab.request.destinationActivationId, {
          routing: { kind: 'return', requestId: ab.request.requestId, outcome: 'needs_changes' },
          data: { latestDeliverable: { revision: 1 }, remainingFindings: ['revise'] },
        })
        const returned = await t.store.returnWork(b.id)
        assert.ok(returned.value.continuationActivationId)
        const revised = await t.accept(returned.value.continuationActivationId, finished(2))
        if (recover) await t.restart()
        const denied = await t.store.admitWorkRequest(revised.id, 'a-b')
        assert.equal(denied.kind, 'limit_reached')
        if (recover) await t.restart()
        const input = await t.input(denied.notice.continuationActivationId)
        assert.equal(input.work.kind, 'limit_denial')
        expect(input.work.notice.alternatives).toEqual([expect.objectContaining({ relationshipId: 'a-c', outcomes: [] })])
        expect(trustedWorkNoticePrompt(input)).toContain('a clean finish follows saved outgoing connections')
        const final = await t.accept(denied.notice.continuationActivationId, finished(3))
        if (recover) await t.restart()
        const blocked = await t.store.admitWorkRequest(final.id, 'a-b')
        assert.equal(blocked.kind, 'needs_direction')
        const allowed = await t.store.admitWorkRequest(final.id, 'a-c')
        assert.equal(allowed.kind, 'accepted')
        expect(allowed.destinationReady).toBe(true)
      } finally { await t.close(); await db.close() }
    }, 120000)
  }
})
