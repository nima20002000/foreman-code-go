import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveInputSchema,
  CurrentWorkflowSaveResultSchema } from '@graphql/contracts/wave25'
import { writerFixture } from './eng04-writer-fixtures.js'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'
import { describe, expect, it } from 'vitest'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { finished, workHandoffFixture } from './helpers/workHandoffFixture.js'

describe.skipIf(!postgresEnabled)('work join routing and rounds', () => {
  for (const recover of [false, true]) {
    for (const branch of [0, 1]) {
      it(`runs the all-join from choice branch ${branch} (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
        const db = await currentDatabase()
        const t = await workHandoffFixture(db.pool, `choice-join-${branch}-${recover}`, (version) => ({ ...version,
          definition: { ...version.definition, handoffs: { contractVersion: 1 },
            executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
            nodes: version.definition.nodes.map((node, index) => index === 0 ? { ...node,
              choice: { outcomes: version.definition.edges.filter((edge) => edge.source === node.id)
                .map((edge, choice) => ({ outcome: `branch_${choice}`,
                  target: { kind: 'edge' as const, relationshipId: edge.id } })) },
            } : node),
          } }))
        try {
          const entry = await t.accept(await t.store.ensureWorkEntry(), {
            ...finished(1), routing: { kind: 'request', outcome: `branch_${branch}` },
          })
          const request = await t.store.admitWorkRequest(entry.id)
          assert.equal(request.kind, 'accepted')
          const selected = await t.accept(request.request.destinationActivationId, finished(1))
          if (recover) await t.restart()
          const route = t.version.definition.edges.find((edge) => edge.source === selected.workflowNodeId)!
          const joined = await t.store.admitWorkRequest(selected.id, route.id)
          assert.equal(joined.kind, 'accepted')
          expect(joined.destinationReady).toBe(true)
          if (recover) await t.restart()
          const input = await t.input(joined.request.destinationActivationId)
          assert.equal(input.work.kind, 'join')
          expect(input.work.sources.map((source) => source.request.requesterExecutionId)).toEqual([selected.id])
          const replay = await t.store.admitWorkRequest(selected.id, route.id)
          assert.equal(replay.kind, 'accepted')
          expect(replay.request).toEqual(joined.request)
          await t.accept(joined.request.destinationActivationId, finished(2))
          const states = (await db.pool.query<{ state: string }>(
            'select state from run_work_activations where run_id=$1', [t.run.id])).rows
          expect(states.every((row) => row.state === 'completed')).toBe(true)
          expect((await db.pool.query('select request_id from run_work_requests where run_id=$1',
            [t.run.id])).rowCount).toBe(2)
        } finally { await t.close(); await db.close() }
      }, 120000)
    }

    it(`releases a waiting join when another branch closes (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
      const db = await currentDatabase()
      const t = await workHandoffFixture(db.pool, `join-close-${recover}`, (version) => ({ ...version,
        definition: { ...version.definition, handoffs: { contractVersion: 1 },
          executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 },
          nodes: version.definition.nodes.map((node, index) => index === 2 ? { ...node,
            choice: { outcomes: [
              { outcome: 'go', target: { kind: 'edge' as const, relationshipId: version.definition.edges[3]!.id } },
              { outcome: 'skip', target: { kind: 'branch_end' as const } },
            ] },
          } : node),
        } }))
      try {
        const a = await t.accept(await t.store.ensureWorkEntry(), finished(1))
        const left = await t.store.admitWorkRequest(a.id, t.version.definition.edges[0]!.id)
        const right = await t.store.admitWorkRequest(a.id, t.version.definition.edges[1]!.id)
        assert.equal(left.kind, 'accepted')
        assert.equal(right.kind, 'accepted')
        const b = await t.accept(left.request.destinationActivationId, finished(1))
        const joined = await t.store.admitWorkRequest(b.id, t.version.definition.edges[2]!.id)
        assert.equal(joined.kind, 'accepted')
        expect(joined.destinationReady).toBe(false)
        const closed = await t.accept(right.request.destinationActivationId, {
          ...finished(1), routing: { kind: 'finish', outcome: 'skip' },
        })
        if (recover) await t.restart()
        expect(await t.route(closed)(right.request.destinationActivationId)).toEqual([joined.request.destinationActivationId])
        if (recover) await t.restart()
        expect(await t.route(closed)(right.request.destinationActivationId)).toEqual([joined.request.destinationActivationId])
        const input = await t.input(joined.request.destinationActivationId)
        assert.equal(input.work.kind, 'join')
        expect(input.work.sources.map((source) => source.request.requesterExecutionId)).toEqual([b.id])
        expect(await t.store.resolveWaitingWorkJoins()).toEqual([])
      } finally { await t.close(); await db.close() }
    }, 120000)

    it(`keeps an unselected join closed (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
      const db = await currentDatabase()
      const t = await workHandoffFixture(db.pool, `join-skipped-${recover}`, (version) => ({ ...version,
        definition: { ...version.definition, handoffs: { contractVersion: 1 },
          nodes: version.definition.nodes.map((node, index) => index === 0 ? { ...node,
            choice: { outcomes: [
              ...version.definition.edges.filter((edge) => edge.source === node.id).map((edge, choice) => ({
                outcome: `branch_${choice}`, target: { kind: 'edge' as const, relationshipId: edge.id },
              })),
              { outcome: 'skip', target: { kind: 'branch_end' as const } },
            ] },
          } : node),
        } }))
      try {
        await t.accept(await t.store.ensureWorkEntry(), { ...finished(1), routing: { kind: 'finish', outcome: 'skip' } })
        if (recover) await t.restart()
        expect(await t.store.resolveWaitingWorkJoins()).toEqual([])
        expect((await db.pool.query('select required from (select work_join_required_edges($1,$1,$2) as required) q',
          [t.run.id, t.version.definition.nodes[3]!.id])).rows[0]?.required).toEqual([])
        expect((await db.pool.query('select activation_id from run_work_activations where run_id=$1 and cause_kind=$2',
          [t.run.id, 'join'])).rowCount).toBe(0)
      } finally { await t.close(); await db.close() }
    }, 120000)

    it(`separates revised join inputs from the completed round (${recover ? 'restart after acceptance' : 'normal'})`, async () => {
      const db = await currentDatabase()
      const t = await workHandoffFixture(db.pool, `join-rework-${recover}`, (version) => ({ ...version,
        definition: { ...version.definition, handoffs: { contractVersion: 1 },
          executionPolicy: { maxParallelism: 3, maxNodeExecutions: 30 },
          nodes: [...version.definition.nodes, { id: 'reviewer', name: 'Reviewer', agentId: version.definition.nodes[3]!.agentId }],
          edges: [...version.definition.edges,
            { id: 'a-reviewer', kind: 'execution', source: version.entryNodeId, target: 'reviewer' }],
        } }))
      try {
        const runRound = async (activationId: string, revision: number) => {
          const a = await t.accept(activationId, finished(revision))
          const branches = []
          for (const edge of t.version.definition.edges.filter((item) => item.source === t.version.entryNodeId
            && item.id !== 'a-reviewer')) {
            const request = await t.store.admitWorkRequest(a.id, edge.id)
            assert.equal(request.kind, 'accepted')
            branches.push(await t.accept(request.request.destinationActivationId, finished(revision)))
          }
          if (recover) await t.restart()
          const joins = []
          for (const execution of branches) {
            const edge = t.version.definition.edges.find((item) => item.source === execution.workflowNodeId)!
            const joined = await t.store.admitWorkRequest(execution.id, edge.id)
            assert.equal(joined.kind, 'accepted')
            expect(joined.destinationReady).toBe(joins.length > 0)
            joins.push(joined)
          }
          expect(joins[0]!.request.destinationActivationId).toBe(joins[1]!.request.destinationActivationId)
          const joinId = joins[0]!.request.destinationActivationId
          const input = await t.input(joinId)
          assert.equal(input.work.kind, 'join')
          expect(input.work.sources.map((source) => source.request.requesterExecutionId).sort())
            .toEqual(branches.map((execution) => execution.id).sort())
          expect(input.work.sources.map((source) => source.acceptedSourceResult.output))
            .toEqual([finished(revision), finished(revision)])
          const replay = await t.store.admitWorkRequest(branches[0]!.id, joins[0]!.request.relationshipId)
          assert.equal(replay.kind, 'accepted')
          expect(replay.replayed).toBe(true)
          expect(replay.request.destinationActivationId).toBe(joinId)
          await t.accept(joinId, finished(revision))
          return { a, joinId }
        }
        const first = await runRound(await t.store.ensureWorkEntry(), 1)
        const reviewRequest = await t.store.admitWorkRequest(first.a.id, 'a-reviewer')
        assert.equal(reviewRequest.kind, 'accepted')
        const review = await t.accept(reviewRequest.request.destinationActivationId, {
          routing: { kind: 'return', requestId: reviewRequest.request.requestId, outcome: 'needs_changes' },
          data: { latestDeliverable: { revision: 1 }, remainingFindings: ['revise both inputs'] },
        })
        if (recover) await t.restart()
        const returned = await t.store.returnWork(review.id)
        assert.ok(returned.value.continuationActivationId)
        const second = await runRound(returned.value.continuationActivationId, 2)
        expect(second.joinId).not.toBe(first.joinId)
        expect((await db.pool.query('select activation_id from run_work_activations where run_id=$1 and cause_kind=$2',
          [t.run.id, 'join'])).rowCount).toBe(2)
      } finally { await t.close(); await db.close() }
    }, 120000)
  }
  it('saves and reads a choice feeding an all-join through authenticated Operator MCP', async () => {
    const db = await currentDatabase()
    const t = await writerFixture(db, 'parallel')
    try {
      const input = CurrentWorkflowSaveInputSchema.parse({ ...t.input, graph: { ...t.input.graph,
        handoffs: { contractVersion: 1 },
        nodes: t.input.graph.nodes.map((node, index) => index === 0 ? { ...node, choice: {
          outcomes: t.input.graph.edges.filter((edge) => edge.source === node.id).map((edge, choice) => ({
            outcome: `branch_${choice}`, target: { kind: 'edge', relationshipId: edge.id },
          })),
        } } : node),
      } })
      const reader = await t.credential([{ actions: ['workflows:read', 'graph:read'],
        scope: { workspaceIds: [input.workspaceId] } }])
      const denied = await t.call(CURRENT_WORKFLOW_TOOLS.save, input, reader.token)
      expect(denied.result?.isError).toBe(true)
      expect((await db.pool.query('select id from workflow_versions where workflow_id=$1',
        [input.workflowId])).rowCount).toBe(0)
      const saved = await t.call(CURRENT_WORKFLOW_TOOLS.save, input)
      expect(saved.result?.isError).not.toBe(true)
      const value = CurrentWorkflowSaveResultSchema.parse(graphRpcValue(saved.result)).value
      const persisted = await t.call(CURRENT_WORKFLOW_TOOLS.saved, {
        workspaceId: input.workspaceId, workflowId: input.workflowId,
      }, reader.token)
      expect(persisted.result?.isError).not.toBe(true)
      const read = CurrentWorkflowReadResultSchema.parse(graphRpcValue(persisted.result))
      expect(read.version).toEqual(value.version)
      const choiceNode = read.version.definition.nodes[0]
      assert.ok(choiceNode && choiceNode.kind !== 'job')
      expect(choiceNode.choice?.outcomes).toHaveLength(2)
      const replay = await t.call(CURRENT_WORKFLOW_TOOLS.save, input)
      expect(CurrentWorkflowSaveResultSchema.parse(graphRpcValue(replay.result)).replayed).toBe(true)
      const blocked = await t.call(CURRENT_WORKFLOW_TOOLS.save, { ...input, commandId: randomUUID() }, reader.token)
      expect(blocked.result?.isError).toBe(true)
      expect((await db.pool.query('select id from workflow_versions where workflow_id=$1',
        [input.workflowId])).rowCount).toBe(1)
    } finally { await t.app.close(); await db.close() }
  }, 120000)
})
