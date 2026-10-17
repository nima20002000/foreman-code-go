import assert from 'node:assert/strict'
import { IntervalCheckAcceptedInputSchema, RunAcceptedInputValueSchema } from '@foreman-code/contracts/wave25'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { independentCodexSessions } from './agents.js'
import { createExecutableWorkflow } from './authoring.js'
import { installCodexScripts } from './codexScript.js'
import { assertBindings, assertExecutionDetail, assertExecutions, waitForExecution } from './inspection.js'
import { runPath, startWorkflow } from './runs.js'
import { assertActiveRun, stopWorkflow } from './stop.js'

export const restartWorkflowScenarios: Scenario[] = [{
  id: 'workflow.restart-between-interval-checks',
  title: 'Killing and restarting an active interval Run preserves its completed graph work and resumes its due check',
  lane: 'E', timeoutMs: 180_000,
  covers: [{ surface: 'workflow', name: 'restart-recovery', case: 'success' }],
  async run(ctx) {
    const graphPrompt = 'Conformance graph checkpoint before restart'
    const checkPrompt = 'Conformance scheduled check after restart'
    const everySeconds = 30
    const fixture = await createExecutableWorkflow(ctx, { name: 'Recover an active interval Run',
      configuration: independentCodexSessions(), initialPrompt: graphPrompt,
      configureGraph: definition => ({ ...definition,
        nodes: definition.nodes.map(node => ({ ...node, interval: { everySeconds, prompt: checkPrompt } })),
      }),
    })
    const result = { outcome: 'succeeded' as const, output: { text: 'Conformance result accepted before restart' } }
    await installCodexScripts(ctx, [
      { id: 'restart-check', includes: checkPrompt,
        turns: [{ holdUntilFile: 'unreleased-recovered-check', answer: 'Recovered check remains controlled' }] },
      { id: 'restart-graph', includes: graphPrompt, excludes: [checkPrompt], turns: [{ answer: result.output.text }] },
    ])
    const { run } = await startWorkflow(ctx, fixture, { task: 'Retain this exact checkpoint', nested: { value: 53 } })
    const nodeId = fixture.saved.version.definition.nodes[0]!.id
    await waitForExecution(ctx, run, execution => execution.workflowNodeId === nodeId
      && execution.tickIndex === undefined && execution.state === 'completed' && execution.acceptedResultAvailable)
    const active = await assertActiveRun(ctx, run)
    const [graph] = await assertExecutions(ctx, fixture, active, [{ nodeId }])
    assert.ok(graph)
    const input = RunAcceptedInputValueSchema.parse({ executionSemanticsVersion: 3,
      runInput: run.input, occurrence: null, entry: null, predecessors: [],
    })
    await assertExecutionDetail(ctx, active, graph, input, result)
    await assertBindings(ctx, run, graph, input, [])
    assert.ok(graph.finishedAt)
    assert.ok(Date.now() + 5000 < Date.parse(graph.finishedAt) + everySeconds * 1000,
      'The kill fixture must begin before the next native check is due')
    // Kill the owned API during a real active Run, after accepted graph work has settled.
    await ctx.target.stop('kill')
    await ctx.target.restart()
    assertResponse(await ctx.http.request('GET', `${runPath(run)}/record`), { status: 200, body: active })
    await waitForExecution(ctx, run, execution => execution.workflowNodeId === nodeId
      && execution.tickIndex === 1 && execution.state === 'running')
    const recovered = await assertExecutions(ctx, fixture, active, [
      { nodeId }, { nodeId, tickIndex: 1, state: 'running', accepted: false },
    ])
    assert.deepStrictEqual(recovered.find(execution => execution.tickIndex === undefined), graph)
    const check = recovered.find(execution => execution.tickIndex === 1)!
    assert.ok(Date.parse(check.createdAt) >= Date.parse(graph.finishedAt) + everySeconds * 1000)
    const checkInput = IntervalCheckAcceptedInputSchema.parse({ executionSemanticsVersion: 3,
      runInput: run.input, occurrence: null, entry: null, predecessors: [], tick: { index: 1, everySeconds },
    })
    await assertExecutionDetail(ctx, active, check, checkInput, undefined, false)
    await assertBindings(ctx, run, check, checkInput, [])
    const stopped = await stopWorkflow(ctx, run)
    const final = await assertExecutions(ctx, fixture, stopped, [{ nodeId }, { nodeId, tickIndex: 1, accepted: false }])
    assert.deepStrictEqual(final.find(execution => execution.tickIndex === undefined), graph)
    const canceled = final.find(execution => execution.tickIndex === 1)!
    assert.equal(canceled.executionId, check.executionId)
    await assertExecutionDetail(ctx, stopped, canceled, checkInput, { outcome: 'canceled' }, false)
  },
}]
