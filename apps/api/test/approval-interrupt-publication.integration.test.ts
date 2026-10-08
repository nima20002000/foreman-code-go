import { randomUUID } from 'node:crypto'
import { makeCurrentWorkflowFixture, RunStartV3ResultSchema } from '@foreman-code/contracts/wave25'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { streamingOperator } from './helpers/streamingRunOperator.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { deferred, postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'
import { graphParity } from './helpers/wave25R1GraphParity.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  try { while (closes.length) await closes.pop()!() } finally { vi.restoreAllMocks() }
})

async function approvalWithActiveSibling() {
  const source = makeCurrentWorkflowFixture(randomUUID())
  const f = await checkpointRuntimeFixture(2, 1, {
    fixture: source, approvalNodeIds: [source.version.definition.nodes[1]!.id], insertRun: false,
  })
  closes.push(f.close)
  const operator = await streamingOperator(f)
  closes.push(() => operator.app.close())
  const entered = deferred()
  const release = deferred()
  closes.push(async () => { release.resolve() })
  const original = f.provider.startTurn.bind(f.provider)
  vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
    const execution = await f.runs.getExecution(session.nativeSessionId.slice('native-'.length))
    for await (const event of original(session, input)) {
      yield event
      if (event.type === 'turn.started' && execution?.workflowNodeId.endsWith('-parallel')) {
        entered.resolve()
        await release.promise
      }
    }
  })
  const denied = await graphRpc(operator.app, operator.reader.token, 'tools/call', {
    name: 'run_start', arguments: operator.input,
  })
  expect(graphRpcValue(denied.result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
  expect(f.provider.counts).toMatchObject({ sessions: 0, starts: 0 })
  const started = await graphRpc(operator.app, operator.writer.token, 'tools/call', {
    name: 'run_start', arguments: operator.input,
  })
  expect(started.result?.isError).not.toBe(true)
  const { run } = RunStartV3ResultSchema.parse(graphRpcValue(started.result))
  await entered.promise
  await expect.poll(async () => (await f.repository.list({ runId: run.id, limit: 10 }))[0]?.graphInterruptId,
    { timeout: 5_000 }).toBeTruthy()
  const [interaction] = await f.repository.list({ runId: run.id, limit: 10 })
  const sibling = (await readCurrentExecutions(f.runs, run.id))
    .find((execution) => execution.workflowNodeId.endsWith('-parallel'))!
  expect(sibling.state).toBe('running')
  expect(sibling.result).toBeUndefined()
  const read = await graphRpc(operator.app, operator.reader.token, 'tools/call', {
    name: 'interaction_get', arguments: { interactionId: interaction!.id },
  })
  expect(read.result?.isError).not.toBe(true)
  expect(graphRpcValue(read.result)).toMatchObject({ interaction: {
    id: interaction!.id, graphInterruptId: interaction!.graphInterruptId, status: 'pending',
  } })
  return { f, operator, run, interaction: interaction!, sibling, release }
}

describe.skipIf(!postgresEnabled)('approval interrupt publication', () => {
  it('binds and consumes the persisted approval while a sibling remains active through authenticated MCP', async () => {
    const { f, operator, run, interaction, sibling, release } = await approvalWithActiveSibling()
    let responseTask: Promise<unknown> | undefined
    try {
      const user = await operator.access.issue({ name: 'Native approval User', audience: 'user',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { runIds: [run.id] } }] })
      await expect(f.service.respond({ kind: 'user', principal: operator.reader.principal },
        approvalResponse(interaction))).rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
      expect((await f.repository.get(interaction.id))?.status).toBe('pending')
      let responded = false
      let responseError: unknown
      responseTask = f.service.respond({ kind: 'user', principal: user.principal }, approvalResponse(interaction))
        .catch((error: unknown) => { responseError = error }).finally(() => { responded = true })
      await expect.poll(() => responded, { timeout: 5_000 }).toBe(true)
      expect(responseError).toBeUndefined()
      expect((await f.repository.get(interaction.id))?.deliveryState).toBe('delivered')
      expect((await f.runs.getExecution(sibling.id))?.state).toBe('running')
      const resumed = await f.db.pool.query<{ state: string }>(
        'select state from interaction_graph_resumes where interaction_id=$1', [interaction.id])
      expect(resumed.rows[0]?.state).toBe('resumed')
      const wait = await graphRpc(operator.app, operator.reader.token, 'tools/call', {
        name: 'run_get', arguments: { workspaceId: run.workspaceId, runId: run.id },
      })
      expect(graphRpcValue(wait.result)).toMatchObject({ run: { id: run.id, executionState: 'waiting' } })
      release.resolve()
      await f.engine.start(run.id)
      const finished = await graphRpc(operator.app, operator.reader.token, 'tools/call', {
        name: 'run_get', arguments: { workspaceId: run.workspaceId, runId: run.id },
      })
      expect(graphRpcValue(finished.result)).toMatchObject({ run: { id: run.id, outcome: 'succeeded' } })
      expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3, responses: 1, attaches: 0 })
      expect(await f.runs.hasPendingCleanup(run.id)).toBe(false)
      await (await graphParity(f.db.pool, { ...f.f.scope, runId: run.id })).compare()
      await f.service.respond({ kind: 'user', principal: user.principal }, approvalResponse(interaction))
      expect(f.provider.counts).toMatchObject({ sessions: 3, starts: 3, responses: 1, attaches: 0 })
      expect(operator.dispatchErrors).toEqual([])
    } finally {
      release.resolve()
      await responseTask
    }
  }, 60_000)

  it.each(['pending', 'delivered'] as const)(
    'keeps the first Stop and late sibling output fenced after a %s approval', async (status) => {
      const { f, operator, run, interaction, release } = await approvalWithActiveSibling()
      if (status === 'delivered') {
        const user = await operator.access.issue({ name: 'Native approval User', audience: 'user',
          expiresAt: new Date(Date.now() + 600_000),
          grants: [{ actions: ['interactions:respond'], scope: { runIds: [run.id] } }] })
        const response = await f.service.respond({ kind: 'user', principal: user.principal },
          approvalResponse(interaction))
        expect(response.interaction.deliveryState).toBe('delivered')
      }
      const stopped = await graphRpc(operator.app, operator.writer.token, 'tools/call', {
        name: 'run_stop', arguments: { workspaceId: run.workspaceId, runId: run.id, commandId: randomUUID() },
      })
      expect(stopped.result?.isError).not.toBe(true)
      await expect.poll(async () => (await f.runs.get(run.id))?.outcome, { timeout: 10_000 }).toBe('canceled')
      expect((await f.repository.get(interaction.id))?.status).toBe('canceled')
      const resume = await f.db.pool.query<{ approval_native_ack_id: string | null }>(
        'select approval_native_ack_id from interaction_graph_resumes where interaction_id=$1', [interaction.id])
      expect(resume.rows).toEqual(status === 'delivered' ? [{ approval_native_ack_id: null }] : [])
      const counts = { ...f.provider.counts }
      release.resolve()
      await f.engine.reconcile()
      expect(f.provider.counts).toEqual(counts)
      expect((await f.repository.get(interaction.id))?.graphInterruptId).toBe(interaction.graphInterruptId)
      expect((await f.runs.get(run.id))?.outcome).toBe('canceled')
      expect(await f.runs.hasPendingCleanup(run.id)).toBe(false)
      await (await graphParity(f.db.pool, { ...f.f.scope, runId: run.id })).compare()
  }, 60_000)
})
