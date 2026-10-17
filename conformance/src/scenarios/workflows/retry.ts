import assert from 'node:assert/strict'
import type { ExecutionResult } from '@foreman-code/contracts'
import { RunAcceptedInputValueSchema } from '@foreman-code/contracts/wave25'
import type { Scenario } from '../../scenario.js'
import { createExecutableWorkflow } from './authoring.js'
import { installCodexScripts } from './codexScript.js'
import { assertBindings, assertExecutionDetail, assertExecutions } from './inspection.js'
import { startWorkflow, waitForCompletedRun } from './runs.js'

export const retryWorkflowScenarios: Scenario[] = [{
  id: 'workflow.retry-transient-native-failure',
  title: 'A transient Codex failure retries the same accepted input and accepts only the successful attempt',
  lane: 'E', timeoutMs: 180_000,
  covers: [{ surface: 'workflow', name: 'retry', case: 'success' }],
  async run(ctx) {
    const prompt = 'Conformance technical retry'
    const fixture = await createExecutableWorkflow(ctx, { name: 'Retry transient native work', initialPrompt: prompt })
    const failure: ExecutionResult = { outcome: 'failed', error: {
      code: 'CODEX_TURN_FAILED', message: 'Conformance transient native failure', retryable: true,
    } }
    const success = { outcome: 'succeeded' as const, output: { text: 'Recovered native answer' } }
    await installCodexScripts(ctx, [{ id: 'transient-retry', includes: prompt, turns: [
      { failure: failure.error!.message, codexErrorInfo: 'internalServerError' },
      { answer: success.output.text },
    ] }])
    const { run } = await startWorkflow(ctx, fixture, { task: 'Preserve this input through retry', counter: 23 })
    const completed = await waitForCompletedRun(ctx, run, success)
    const nodeId = fixture.saved.version.definition.nodes[0]!.id
    const executions = await assertExecutions(ctx, fixture, completed, [
      { nodeId, attempt: 1, accepted: false, failure: failure.error },
      { nodeId, attempt: 2 },
    ])
    assert.deepStrictEqual(executions.map(execution => execution.attempt), [2, 1])
    const input = RunAcceptedInputValueSchema.parse({ executionSemanticsVersion: 3,
      runInput: run.input, occurrence: null, entry: null, predecessors: [],
    })
    for (const execution of executions) {
      const accepted = execution.attempt === 2
      await assertExecutionDetail(ctx, completed, execution, input, accepted ? success : failure, accepted)
      await assertBindings(ctx, run, execution, input, [])
    }
  },
}]
