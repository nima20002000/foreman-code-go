import assert from 'node:assert/strict'
import { Command, MemorySaver, interrupt } from '@langchain/langgraph'
import { buildWorkHandoffGraph } from '../src/modules/runs/workHandoffGraph.js'
import { randomUUID } from 'node:crypto'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveInputSchema,
  CurrentWorkflowSaveResultSchema, WorkActivationInputSchema, makeCurrentWorkflowFixture, parseWorkHandoffResult } from '@foreman-code/contracts/wave25'
import { writerFixture } from './eng04-writer-fixtures.js'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'
import { describe, expect, it } from 'vitest'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { finished, workHandoffFixture } from './helpers/workHandoffFixture.js'
import { runWorkHandoffWithRestart, workHandoffRuntimeFixture } from './helpers/workHandoffRuntimeFixture.js'

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
        expect(await t.store.resolveWaitingWorkJoins(left.request.destinationActivationId)).toEqual([])
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
        expect(await t.store.resolveWaitingWorkJoins(await t.store.ensureWorkEntry())).toEqual([])
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
  it('dispatches one join approval task and preserves its dispatch on checkpoint replay', async () => {
    const db = await currentDatabase()
    const t = await workHandoffFixture(db.pool, 'concurrent-join-approval', (version) => ({ ...version,
      definition: { ...version.definition, handoffs: { contractVersion: 1 },
        executionPolicy: { maxParallelism: 2, maxNodeExecutions: 20 } } }))
    try {
      const entryId = await t.store.ensureWorkEntry()
      const entry = await t.accept(entryId, finished(1))
      const branches = []
      for (const edge of t.version.definition.edges.filter((item) => item.source === t.version.entryNodeId)) {
        const request = await t.store.admitWorkRequest(entry.id, edge.id)
        assert.equal(request.kind, 'accepted')
        branches.push(await t.accept(request.request.destinationActivationId, finished(1)))
      }
      const results = new Map([entry, ...branches].map((execution) =>
        [WorkActivationInputSchema.parse(execution.input).work.activation.activationId, execution]))
      const checkpointer = new MemorySaver()
      const compose = () => buildWorkHandoffGraph({ runId: t.run.id, version: t.version, checkpointer,
        signal: new AbortController().signal, port: {
          ensureEntryActivation: () => t.store.ensureWorkEntry(),
          executeActivation: async (id) => {
            const execution = results.get(id)
            if (execution) return t.route(execution)(id)
            interrupt({ approval: 'join' })
            await t.accept(id, finished(2))
            return []
          },
        } })
      let work = compose()
      await work.graph.invoke(work.initial, work.config)
      const waiting = await work.graph.getState(work.config)
      expect(waiting.tasks.flatMap((task) => task.interrupts ?? [])).toHaveLength(1)
      expect(waiting.tasks.filter((task) => task.interrupts?.length)).toHaveLength(1)
      const claims = (await db.pool.query<{ activation_id: string; source_activation_id: string }>(
        'select activation_id,source_activation_id from run_work_join_dispatches where run_id=$1', [t.run.id])).rows
      expect(claims).toHaveLength(1)
      await t.restart()
      const routed = await Promise.all(branches.map((execution) => {
        const id = [...results].find(([, item]) => item.id === execution.id)![0]
        return t.route(execution)(id)
      }))
      expect(routed.flat()).toEqual([claims[0]!.activation_id])
      work = compose()
      await work.graph.invoke(new Command({ resume: true }), work.config)
      expect((await work.graph.getState(work.config)).tasks).toHaveLength(0)
      expect((await db.pool.query('select id from harness_executions where run_id=$1 and workflow_node_id=$2',
        [t.run.id, t.version.definition.nodes[3]!.id])).rowCount).toBe(1)
    } finally { await t.close(); await db.close() }
  }, 120000)

  for (const restart of [false, true]) {
    it(`releases a revised join after an incoming connection is exhausted and its notice finishes (restart=${restart})`, async () => {
      const definition = makeCurrentWorkflowFixture(`join-exhausted-${restart}`, 'parallel')
      const sourceId = definition.version.entryNodeId
      const joinId = definition.version.definition.nodes[3]!.id
      definition.version.definition.handoffs = { contractVersion: 1 }
      definition.version.definition.executionPolicy = { maxParallelism: 3, maxNodeExecutions: 30 }
      definition.version.definition.nodes.push({ id: 'reviewer', name: 'Reviewer',
        agentId: definition.version.definition.nodes[3]!.agentId })
      definition.version.definition.edges[3]!.maxWorkHandoffsPerRun = 1
      definition.version.definition.edges.push({ id: 'a-reviewer', kind: 'execution', source: sourceId, target: 'reviewer' })
      const f = await workHandoffRuntimeFixture(definition, (nodeId, request) => {
        const { work } = WorkActivationInputSchema.parse(request.input)
        if (work.kind === 'limit_denial') return { routing: { kind: 'finish' },
          data: { latestDeliverable: { revision: 2 }, remainingFindings: ['incoming review exhausted'] } }
        let revision = 1
        if (work.kind === 'work_return') revision = 2
        else if (work.kind === 'work_request') {
          revision = (parseWorkHandoffResult(work.acceptedSourceResult).data.latestDeliverable as { revision: number }).revision
        } else if (work.kind === 'join') {
          revision = (parseWorkHandoffResult(work.sources[0]!.acceptedSourceResult).data.latestDeliverable as { revision: number }).revision
        }
        if (nodeId === 'reviewer') {
          assert.equal(work.kind, 'work_request')
          return { routing: { kind: 'return', requestId: work.request.requestId,
            outcome: revision === 1 ? 'needs_changes' : 'accepted' },
          data: { latestDeliverable: { revision }, remainingFindings: revision === 1 ? ['revise'] : [] } }
        }
        return finished(revision)
      })
      try {
        const runtime = await runWorkHandoffWithRestart(f, restart, (execution) => {
          const { work } = WorkActivationInputSchema.parse(execution.input)
          return work.kind === 'limit_denial'
        })
        expect(await runtime.runs.get(f.f.run.id)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
        const joins = (await f.db.pool.query<{ record: unknown }>(
          `select e.record from harness_executions e join run_work_activations a
           on a.activation_id=e.work_activation_id where e.run_id=$1 and a.workflow_node_id=$2
           order by a.activation_sequence`, [f.f.run.id, joinId])).rows
        expect(joins).toHaveLength(2)
        const first = WorkActivationInputSchema.parse((joins[0]!.record as { input: unknown }).input)
        const revised = WorkActivationInputSchema.parse((joins[1]!.record as { input: unknown }).input)
        assert.equal(first.work.kind, 'join')
        assert.equal(revised.work.kind, 'join')
        expect(first.work.sources).toHaveLength(2)
        expect(revised.work.sources).toHaveLength(1)
        expect(revised.work.sources[0]!.request.relationshipId).toBe(definition.version.definition.edges[2]!.id)
        expect(revised.work.activation.activationId).not.toBe(first.work.activation.activationId)
        const before = { ...f.provider.counts }
        await runtime.engine.start(f.f.run.id)
        expect(f.provider.counts).toEqual(before)
        expect((await f.db.pool.query('select run_id from run_work_direction_waits where run_id=$1',
          [f.f.run.id])).rowCount).toBe(1)
      } finally { await f.close() }
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
