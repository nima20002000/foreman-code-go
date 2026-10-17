import assert from 'node:assert/strict'
import { RunAcceptedInputValueSchema } from '@foreman-code/contracts/wave25'
import { assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { independentCodexSessions } from './agents.js'
import { createExecutableWorkflow } from './authoring.js'
import { installCodexScripts, releaseCodexTurn } from './codexScript.js'
import {
  assertBindings, assertExecutionDetail, assertExecutions, predecessor,
  waitForExecution, waitForRunningExecution,
} from './inspection.js'
import { runPath, startWorkflow, waitForCompletedRun } from './runs.js'
import { assertActiveRun } from './stop.js'

export const joinWorkflowScenarios: Scenario[] = [{
  id: 'workflow.parallel-join-accepted-predecessors',
  title: 'A parallel join waits for both branches and retains each exact accepted predecessor',
  lane: 'E', timeoutMs: 180_000,
  covers: [{ surface: 'workflow', name: 'join', case: 'success' }],
  async run(ctx) {
    const prompts = ['Conformance split work', 'Conformance left branch',
      'Conformance right branch', 'Conformance join work']
    const results = prompts.map((_, index) => ({ outcome: 'succeeded' as const,
      output: { text: `Conformance graph result ${index}` } }))
    const fixture = await createExecutableWorkflow(ctx, { name: 'Join both accepted branches', form: 'parallel',
      configuration: independentCodexSessions(),
      configureGraph: definition => ({ ...definition,
        nodes: definition.nodes.map((node, index) => ({ ...node, initialPrompt: prompts[index]! })),
      }),
    })
    await installCodexScripts(ctx, prompts.map((prompt, index) => ({
      id: `parallel-node-${index}`, includes: prompt,
      turns: [{ answer: results[index]!.output.text,
        ...(index === 1 || index === 2 ? { holdUntilFile: `parallel-release-${index}` } : {}) }],
    })))
    const { run } = await startWorkflow(ctx, fixture, { task: 'Join exact branch outputs', revision: 61 })
    const [entry, left, right, join] = fixture.saved.version.definition.nodes
    assert.ok(entry && left && right && join)
    await waitForRunningExecution(ctx, run, left.id)
    await waitForRunningExecution(ctx, run, right.id)
    const active = await assertActiveRun(ctx, run)
    await assertExecutions(ctx, fixture, active, [
      { nodeId: entry.id }, { nodeId: left.id, state: 'running', accepted: false },
      { nodeId: right.id, state: 'running', accepted: false },
    ])
    await releaseCodexTurn(ctx, 'parallel-release-1')
    await waitForExecution(ctx, run, execution => execution.workflowNodeId === left.id
      && execution.state === 'completed' && execution.acceptedResultAvailable)
    // Exact membership proves that one finished branch cannot admit the join.
    await assertExecutions(ctx, fixture, active, [
      { nodeId: entry.id }, { nodeId: left.id }, { nodeId: right.id, state: 'running', accepted: false },
    ])
    await releaseCodexTurn(ctx, 'parallel-release-2')
    const completed = await waitForCompletedRun(ctx, run, results[3]!)
    const executions = await assertExecutions(ctx, fixture, completed,
      fixture.saved.version.definition.nodes.map(node => ({ nodeId: node.id })))
    const executionFor = (nodeId: string) => {
      const execution = executions.find(value => value.workflowNodeId === nodeId)
      assert.ok(execution)
      return execution
    }
    for (const [index, node] of fixture.saved.version.definition.nodes.entries()) {
      const sources = fixture.saved.version.definition.edges
        .filter(edge => edge.kind === 'execution' && edge.target === node.id)
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        .map(edge => {
          const sourceIndex = fixture.saved.version.definition.nodes.findIndex(value => value.id === edge.source)
          assert.ok(sourceIndex >= 0)
          return predecessor(edge.id, executionFor(edge.source), results[sourceIndex]!)
        })
      const input = RunAcceptedInputValueSchema.parse({ executionSemanticsVersion: 3,
        runInput: run.input, occurrence: null, entry: null, predecessors: sources,
      })
      await assertExecutionDetail(ctx, completed, executionFor(node.id), input, results[index]!)
      await assertBindings(ctx, run, executionFor(node.id), input,
        sources.map(source => ({ kind: 'predecessor', source })))
    }
    const joined = executionFor(join.id)
    assert.ok(joined.startedAt && executionFor(left.id).finishedAt && executionFor(right.id).finishedAt)
    assert.ok(Date.parse(joined.startedAt) >= Date.parse(executionFor(left.id).finishedAt!))
    assert.ok(Date.parse(joined.startedAt) >= Date.parse(executionFor(right.id).finishedAt!))
    await ctx.target.restart()
    assertResponse(await ctx.http.request('GET', `${runPath(run)}/record`), { status: 200, body: completed })
    await assertExecutions(ctx, fixture, completed,
      fixture.saved.version.definition.nodes.map(node => ({ nodeId: node.id })))
  },
}]
