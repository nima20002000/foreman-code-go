import { randomUUID } from 'node:crypto'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { describe, expect, it } from 'vitest'
import { NativeSessionReferenceSchema } from '@graphql/contracts'
import { CURRENT_WORKFLOW_TOOLS, makeCurrentWorkflowFixture } from '@graphql/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled, readCurrentExecutions } from './helpers/wave25Agent3.js'
import { graphHeaders, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { assertSettled, corruptProof, definitionUrl, editThrough, meaningfulInput, parkBeforeNativeEntry,
  rpc, saveThrough, stageThrough, transports, versionCount, type SaveFixture } from './helpers/eng07SaveAdmission.testSupport.js'

async function nativeFacts(f: SaveFixture) {
  const runId = f.f.run.id
  const entries = (await f.db.pool.query('select to_jsonb(n) as record from workflow_native_entries n where run_id=$1 order by execution_id', [runId])).rows
  const closures = (await f.db.pool.query(`select to_jsonb(n) as record from execution_native_closures n
    join harness_executions e on e.id=n.execution_id where e.run_id=$1 order by n.generation`, [runId])).rows
  const recoveries = (await f.db.pool.query(`select to_jsonb(n) as record from execution_native_recoveries n
    join harness_executions e on e.id=n.execution_id where e.run_id=$1 order by n.generation`, [runId])).rows
  const sessions = (await f.db.pool.query(`select to_jsonb(n) as record from execution_native_sessions n
    join harness_executions e on e.id=n.execution_id where e.run_id=$1 order by n.execution_id`, [runId])).rows
  return { entries, closures, recoveries, sessions }
}
async function assertNewVersionOnly(f: SaveFixture, count: number, originalVersion: string) {
  expect(await versionCount(f)).toBe(count + 1)
  const workflow = (await f.db.pool.query('select current_version_id from workflows where id=$1', [f.f.scope.workflowId])).rows[0]!
  expect(workflow.current_version_id).not.toBe(originalVersion)
  const run = await f.runs.get(f.f.run.id)
  expect(run?.workflowVersionId).toBe(originalVersion)
}

/** Real owner/checkpoint/coordinator/SQL settlement and authenticated transports;
 * only the external provider port and timing are deterministic. No native binary
 * or kernel process registry is claimed by this fixture. */
async function recoveredFixture(form: 'single' | 'repeat') {
  const shape = makeCurrentWorkflowFixture(randomUUID(), form)
  const disposed = new Set<string>()
  const f = await currentOperatorIntegration({ fixture: shape, approvalNodeIds: [shape.version.entryNodeId],
    recoverNativeProcesses: async (executionId, signal) => { signal.throwIfAborted(); return disposed.has(executionId) } })
  try {
    await f.engine.start(f.f.run.id)
    expect((await f.pending()).filter((interaction) => interaction.status === 'pending')).toHaveLength(1)
    const executions = await readCurrentExecutions(f.runs, f.f.run.id)
    expect(executions).toHaveLength(1)
    const execution = executions[0]!
    expect(execution.nativeSessionId).toBeDefined()
    const session = NativeSessionReferenceSchema.parse((await f.db.pool.query<{ reference: unknown }>(
      'select reference from execution_native_sessions where execution_id=$1', [execution.id])).rows[0]?.reference)
    const counts = { ...f.provider.counts }
    await f.engine.shutdown()
    // A positive close acknowledgement from this exact deterministic provider
    // lifetime, NOT absence in a new resolver/registry. No create/attach/replay.
    await f.provider.close(session)
    disposed.add(execution.id)
    const cold = f.compose()
    await cold.engine.start(f.f.run.id)
    await assertSettled(f)
    const proof = (await f.db.pool.query(`select p.generation,c.closed_at from execution_native_recoveries p
      join execution_native_closures c on c.generation=p.generation and c.execution_id=p.execution_id
      where p.execution_id=$1`, [execution.id])).rows
    expect(proof).toHaveLength(1)
    expect(proof[0]!.closed_at).toBeNull() // Exercise the recovered reader, not the old closed_at predicate.
    expect(f.provider.counts).toEqual(counts)
    return { f, executionId: execution.id }
  } catch (error) { await f.close(); throw error }
}

for (const transport of transports) describe.skipIf(!postgresEnabled)(`ENG07 native Save admission over ${transport}`, () => {
  for (const form of ['single', 'repeat'] as const) {
    it(`${form}: meaningful Save after Stop-before-native-entry uses the canonical seal`, async () => {
      const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), form), approvalNodeIds: [] })
      const gate = parkBeforeNativeEntry(f)
      try {
        const execution = await gate.parked
        const before = (await f.db.pool.query('select phase from workflow_native_entries where execution_id=$1', [execution.id])).rows[0]!
        expect(['reserved', 'prepared']).toContain(before.phase)
        await f.stop() // Real authorized durable Stop; the engine owns negative settlement.
        await f.engine.cancel(f.f.run.id)
        await gate.drive
        await assertSettled(f)
        const entries = (await f.db.pool.query('select phase from workflow_native_entries where execution_id=$1', [execution.id])).rows
        expect(entries).toEqual([{ phase: 'not_submitted' }])
        expect((await f.runs.getExecution(execution.id))?.nativeSessionId).toBeUndefined()
        expect(f.provider.counts).toEqual({ sessions: 0, starts: 0, responses: 0, attaches: 0 })
        const input = await meaningfulInput(f), count = await versionCount(f), facts = await nativeFacts(f)
        const saved = await saveThrough(f, transport, input)
        expect(agentWorkflowNode(saved.value.version.definition.nodes[0]).initialPrompt).toBe(agentWorkflowNode(input.graph.nodes[0]).initialPrompt)
        await assertNewVersionOnly(f, count, input.expectedWorkflowVersionId!)
        expect(await nativeFacts(f)).toEqual(facts)
      } finally { gate.release(); await gate.drive; gate.restore(); await f.close() }
    }, 60000)

    it(`${form}: Stop-and-save settles the unentered execution and publishes the retained edit`, async () => {
      const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), form), approvalNodeIds: [] })
      const gate = parkBeforeNativeEntry(f)
      try {
        const execution = await gate.parked
        const input = await meaningfulInput(f), count = await versionCount(f)
        const stage = await stageThrough(f, transport, input)
        expect(stage.intent.stops).toHaveLength(1)
        const first = await editThrough(f, transport, stage.advance)
        expect(['waiting', 'saved']).toContain(first.intent?.state)
        // Drain the already authorized Stop, never manufacture another receipt
        // or silently reissue a different command after an uncertain response.
        await f.engine.cancel(f.f.run.id)
        await gate.drive
        await assertSettled(f)
        const result = first.intent?.state === 'saved' ? first : await editThrough(f, transport, stage.advance)
        expect(result.intent?.state).toBe('saved')
        expect(result.intent?.saveInput).toEqual(stage.intent.saveInput)
        expect(result.current.every((item) => item.settled && !item.nativePending)).toBe(true)
        expect((await f.db.pool.query('select phase from workflow_native_entries where execution_id=$1', [execution.id])).rows).toEqual([{ phase: 'not_submitted' }])
        expect((await f.runs.getExecution(execution.id))?.nativeSessionId).toBeUndefined()
        expect(f.provider.counts.sessions).toBe(0); expect(f.provider.counts.starts).toBe(0)
        await assertNewVersionOnly(f, count, input.expectedWorkflowVersionId!)
      } finally { gate.release(); await gate.drive; gate.restore(); await f.close() }
    }, 60000)

    it(`${form}: Save and Stop-and-save accept exact restart-recovery receipts without replay`, async () => {
      const { f } = await recoveredFixture(form)
      try {
        const counts = { ...f.provider.counts }, facts = await nativeFacts(f)
        const input = await meaningfulInput(f), count = await versionCount(f)
        await saveThrough(f, transport, input)
        await assertNewVersionOnly(f, count, input.expectedWorkflowVersionId!)
        const next = await meaningfulInput(f)
        const entry = agentWorkflowNode(next.graph.nodes[0])
        entry.initialPrompt += ' / another meaningful edit'
        const stage = await stageThrough(f, transport, next)
        expect(stage.intent.stops).toHaveLength(0)
        expect(stage.result.current.every((item) => item.settled && !item.nativePending)).toBe(true)
        const result = await editThrough(f, transport, stage.advance)
        expect(result.intent?.state).toBe('saved')
        expect(result.intent?.saveInput).toEqual(stage.intent.saveInput)
        expect(await versionCount(f)).toBe(count + 2)
        expect((await f.runs.get(f.f.run.id))?.workflowVersionId).toBe(input.expectedWorkflowVersionId)
        expect(await nativeFacts(f)).toEqual(facts)
        expect(f.provider.counts).toEqual(counts)
      } finally { await f.close() }
    }, 60000)
  }

  it.each(['missing', 'mismatched'] as const)('%s recovered evidence blocks both direct Save and a previously planned Stop-and-save', async (fault) => {
    const { f, executionId } = await recoveredFixture('single')
    let restore: (() => Promise<void>) | undefined
    try {
      const input = await meaningfulInput(f), count = await versionCount(f)
      const stage = await stageThrough(f, transport, input)
      expect(stage.intent.stops).toHaveLength(0)
      const intact = await nativeFacts(f)
      restore = await corruptProof(f.db.pool, 'execution_native_recoveries', executionId, fault)
      const facts = await nativeFacts(f), counts = { ...f.provider.counts }
      const rejected = { ...input, commandId: randomUUID() }
      if (transport === 'http') {
        const reply = await f.app.inject({ method: 'PUT', url: definitionUrl(input), headers: graphHeaders(f.writer.token), payload: rejected })
        expect(reply.statusCode).toBe(409)
        expect(reply.json()).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
      } else {
        const reply = await rpc(f, CURRENT_WORKFLOW_TOOLS.save, rejected)
        expect(reply.result?.isError).toBe(true)
        expect(graphRpcValue(reply.result as unknown as Parameters<typeof graphRpcValue>[0])).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
      }
      const blocked = await editThrough(f, transport, stage.advance)
      expect(blocked.intent?.state).toBe('waiting')
      expect(blocked.intent?.saveAttempted).toBe(false)
      expect(blocked.current).toEqual([expect.objectContaining({ settled: false, nativePending: true })])
      expect(blocked.intent?.saveInput).toEqual(stage.intent.saveInput)
      expect(await versionCount(f)).toBe(count)
      expect(await nativeFacts(f)).toEqual(facts)
      expect(f.provider.counts).toEqual(counts)
      // Restore ONLY the fixture's original evidence, then reuse the exact
      // retained command. This proves the fault, not an unrelated admission
      // guard, caused the preceding rejection/wait.
      await restore(); restore = undefined
      expect(await nativeFacts(f)).toEqual(intact)
      const saved = await editThrough(f, transport, stage.advance)
      expect(saved.intent?.state).toBe('saved')
      expect(saved.intent?.saveInput).toEqual(stage.intent.saveInput)
      expect(saved.current.every((item) => item.settled && !item.nativePending)).toBe(true)
      expect(await versionCount(f)).toBe(count + 1)
      expect(await nativeFacts(f)).toEqual(intact)
      expect(f.provider.counts).toEqual(counts)
    } finally { await restore?.(); await f.close() }
  }, 60000)

  it('an unbound terminal without its seal is not negative native evidence', async () => {
    const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'), approvalNodeIds: [] })
    const gate = parkBeforeNativeEntry(f)
    let restore: (() => Promise<void>) | undefined
    try {
      const execution = await gate.parked
      await f.stop(); await f.engine.cancel(f.f.run.id); await gate.drive; await assertSettled(f)
      const input = await meaningfulInput(f), count = await versionCount(f)
      const stage = await stageThrough(f, transport, input)
      expect(stage.intent.stops).toHaveLength(0)
      const intact = await nativeFacts(f)
      restore = await corruptProof(f.db.pool, 'workflow_native_entries', execution.id, 'missing')
      const blocked = await editThrough(f, transport, stage.advance)
      expect(blocked.intent?.state).toBe('waiting')
      expect(blocked.current).toEqual([expect.objectContaining({ nativePending: true, settled: false })])
      const rejected = { ...input, commandId: randomUUID() }
      if (transport === 'http') {
        const reply = await f.app.inject({ method: 'PUT', url: definitionUrl(input), headers: graphHeaders(f.writer.token), payload: rejected })
        expect(reply.statusCode).toBe(409)
        expect(reply.json()).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
      } else {
        const reply = await rpc(f, CURRENT_WORKFLOW_TOOLS.save, rejected)
        expect(reply.result?.isError).toBe(true)
        expect(graphRpcValue(reply.result as unknown as Parameters<typeof graphRpcValue>[0])).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
      }
      expect(await versionCount(f)).toBe(count)
      expect(f.provider.counts.sessions).toBe(0); expect(f.provider.counts.starts).toBe(0)
      await restore(); restore = undefined
      const saved = await editThrough(f, transport, stage.advance)
      expect(saved.intent?.state).toBe('saved')
      expect(saved.intent?.saveInput).toEqual(stage.intent.saveInput)
      expect(saved.current.every((item) => item.settled && !item.nativePending)).toBe(true)
      expect(await versionCount(f)).toBe(count + 1)
      expect(await nativeFacts(f)).toEqual(intact)
      expect(f.provider.counts.sessions).toBe(0); expect(f.provider.counts.starts).toBe(0)
    } finally { await restore?.(); gate.release(); await gate.drive; gate.restore(); await f.close() }
  }, 60000)
})
