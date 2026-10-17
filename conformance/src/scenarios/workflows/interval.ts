import assert from 'node:assert/strict'
import {
  AGENT_INTERVAL_MIN_SECONDS, IntervalCheckAcceptedInputSchema, RunAcceptedInputValueSchema,
} from '@foreman-code/contracts/wave25'
import type { Scenario } from '../../scenario.js'
import { independentCodexSessions } from './agents.js'
import { createExecutableWorkflow } from './authoring.js'
import { installCodexScripts } from './codexScript.js'
import {
  assertBindings, assertExecutionDetail, assertExecutions, predecessor, waitForExecution, waitForRunningExecution,
} from './inspection.js'
import { startWorkflow } from './runs.js'
import { assertActiveRun, stopWorkflow } from './stop.js'

export const intervalWorkflowScenarios: Scenario[] = [{
  id: 'workflow.interval-checks-do-not-route',
  title: 'Interval checks run beside graph work and retain reports without accepting them as predecessor results',
  lane: 'E', timeoutMs: 180_000,
  covers: [{ surface: 'workflow', name: 'interval', case: 'success' }],
  async run(ctx) {
    const graphPrompt = 'Conformance interval graph work'
    const checkPrompt = 'Conformance interval maintenance check'
    const downstreamPrompt = 'Conformance held downstream graph work'
    const everySeconds = AGENT_INTERVAL_MIN_SECONDS
    const fixture = await createExecutableWorkflow(ctx, { name: 'Interval checks beside graph work', form: 'sequential',
      configuration: independentCodexSessions(),
      configureGraph: definition => ({ ...definition, nodes: definition.nodes.map((node, index) => ({ ...node,
        initialPrompt: index === 0 ? graphPrompt : downstreamPrompt,
        ...(index === 0 ? { interval: { everySeconds, prompt: checkPrompt } } : {}),
      })) }),
    })
    const graphResult = { outcome: 'succeeded' as const, output: { text: 'Conformance graph result' } }
    const checkResult = { outcome: 'succeeded' as const, output: { text: 'Conformance completed maintenance check' } }
    await installCodexScripts(ctx, [
      // Fresh checks retain the original task, so the graph selector excludes their loop prompt.
      { id: 'interval-check', includes: checkPrompt, turns: [
        { answer: checkResult.output.text },
        { holdUntilFile: 'unreleased-later-check', answer: 'A later check must remain held' },
      ] },
      { id: 'interval-graph', includes: graphPrompt, excludes: [checkPrompt],
        turns: [{ answer: graphResult.output.text }] },
      { id: 'interval-downstream', includes: downstreamPrompt,
        turns: [{ holdUntilFile: 'unreleased-downstream', answer: 'Downstream must remain held' }] },
    ])
    const { run } = await startWorkflow(ctx, fixture, { task: 'Keep graph and check inputs distinct', value: 41 })
    const [observer, downstream] = fixture.saved.version.definition.nodes
    assert.ok(observer && downstream)
    await waitForRunningExecution(ctx, run, downstream.id)
    await waitForExecution(ctx, run, execution => execution.workflowNodeId === observer.id
      && execution.tickIndex === 2 && execution.state === 'running')
    const active = await assertActiveRun(ctx, run)
    const items = await assertExecutions(ctx, fixture, active, [
      { nodeId: observer.id }, { nodeId: downstream.id, state: 'running', accepted: false },
      { nodeId: observer.id, tickIndex: 1, accepted: false },
      { nodeId: observer.id, tickIndex: 2, state: 'running', accepted: false },
    ])
    const graph = items.find(item => item.workflowNodeId === observer.id && item.tickIndex === undefined)!
    const next = items.find(item => item.workflowNodeId === downstream.id)!
    const firstCheck = items.find(item => item.tickIndex === 1)!
    const heldCheck = items.find(item => item.tickIndex === 2)!
    assert.ok(graph.finishedAt && firstCheck.finishedAt)
    assert.ok(Date.parse(firstCheck.createdAt) >= Date.parse(graph.finishedAt) + everySeconds * 1000)
    assert.ok(Date.parse(heldCheck.createdAt) >= Date.parse(firstCheck.finishedAt) + everySeconds * 1000)
    const graphInput = RunAcceptedInputValueSchema.parse({ executionSemanticsVersion: 3,
      runInput: run.input, occurrence: null, entry: null, predecessors: [],
    })
    await assertExecutionDetail(ctx, active, graph, graphInput, graphResult)
    await assertBindings(ctx, run, graph, graphInput, [])
    const relationship = fixture.saved.version.definition.edges.find(edge => edge.kind === 'execution')!
    const source = predecessor(relationship.id, graph, graphResult)
    const downstreamInput = RunAcceptedInputValueSchema.parse({ executionSemanticsVersion: 3,
      runInput: run.input, occurrence: null, entry: null, predecessors: [source],
    })
    await assertExecutionDetail(ctx, active, next, downstreamInput, undefined, false)
    await assertBindings(ctx, run, next, downstreamInput, [{ kind: 'predecessor', source }])
    for (const check of [firstCheck, heldCheck]) {
      const input = IntervalCheckAcceptedInputSchema.parse({ executionSemanticsVersion: 3,
        runInput: run.input, occurrence: null, entry: null, predecessors: [],
        tick: { index: check.tickIndex, everySeconds },
      })
      await assertExecutionDetail(ctx, active, check, input, check.tickIndex === 1 ? checkResult : undefined, false)
      await assertBindings(ctx, run, check, input, [])
    }
    const stopped = await stopWorkflow(ctx, run)
    const canceled = await assertExecutions(ctx, fixture, stopped, [
      { nodeId: observer.id }, { nodeId: downstream.id, accepted: false },
      { nodeId: observer.id, tickIndex: 1, accepted: false }, { nodeId: observer.id, tickIndex: 2, accepted: false },
    ])
    assert.deepStrictEqual(canceled.find(item => item.executionId === graph.executionId), graph)
    assert.deepStrictEqual(canceled.find(item => item.executionId === firstCheck.executionId), firstCheck)
    for (const previous of [next, heldCheck]) {
      const execution = canceled.find(item => item.executionId === previous.executionId)
      assert.ok(execution, 'Stop must settle the same held native execution')
      const input = execution.tickIndex === undefined ? downstreamInput : IntervalCheckAcceptedInputSchema.parse({
        executionSemanticsVersion: 3, runInput: run.input, occurrence: null, entry: null, predecessors: [],
        tick: { index: 2, everySeconds },
      })
      await assertExecutionDetail(ctx, stopped, execution, input, { outcome: 'canceled' }, false)
    }
  },
}]
