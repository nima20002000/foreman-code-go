import assert from 'node:assert/strict'
import {
  RunHandoffsReadSchema, WorkHandoffResultSchema,
  type RunHandoffsRead,
} from '@foreman-code/contracts/wave25'
import { assertJson, assertResponse } from '../../assertions.js'
import type { Scenario, ScenarioContext } from '../../scenario.js'
import { assertProtectedRead, readCoverage } from '../http/support.js'
import { assertInvalidCallerDenied, callTool, mcpClaims, operatorClients } from '../mcp/support.js'
import { createExecutableWorkflow } from './authoring.js'
import { installCodexScripts } from './codexScript.js'
import { workflowDigest } from './digest.js'
import { handoffReadInput } from './handoffInput.js'
import { assertBindings, assertExecutionDetail, assertExecutions, readExecutionDetail, runScope } from './inspection.js'
import { runPath, startWorkflow, waitForCompletedRun } from './runs.js'

async function assertHandoffRead(ctx: ScenarioContext, expected: RunHandoffsRead) {
  const { workspaceId, runId } = expected.scope
  await assertProtectedRead(ctx, `/api/management/workspaces/${workspaceId}/runs/${runId}/handoffs`, expected)
  const { operator, readOnly } = operatorClients(ctx)
  for (const client of [operator, readOnly]) {
    assert.deepStrictEqual(await callTool(client, 'run_handoffs_get_v1', { workspaceId, runId }, RunHandoffsReadSchema), expected)
    await assertInvalidCallerDenied(client, 'run_handoffs_get_v1', { workspaceId, runId })
  }
}

export const handoffWorkflowScenarios: Scenario[] = [{
  id: 'workflow.work-handoff-accepted-return',
  title: 'A saved work route hands off the exact deliverable and accepts the matching return once',
  lane: 'E', authentication: 'operator', timeoutMs: 180_000,
  covers: [{ surface: 'workflow', name: 'work-handoff', case: 'success' },
    ...readCoverage('/api/management/workspaces/:workspaceId/runs/:runId/handoffs'),
    ...mcpClaims('run_handoffs_get_v1')],
  async run(ctx) {
    const prompts = ['Conformance request saved work review', 'Conformance accept received work review']
    const fixture = await createExecutableWorkflow(ctx, { name: 'Accept exact work handoff', form: 'sequential',
      configureGraph: definition => ({ ...definition, handoffs: { contractVersion: 1 },
        nodes: definition.nodes.map((node, index) => ({ ...node, initialPrompt: prompts[index]!,
          ...(index === 0 ? { choice: { outcomes: [{ outcome: 'review',
            target: { kind: 'edge' as const, relationshipId: definition.edges[0]!.id } }] } } : {}),
        })),
      }),
    })
    const [requester, reviewer] = fixture.saved.version.definition.nodes
    const edge = fixture.saved.version.definition.edges[0]!
    assert.ok(requester && reviewer && requester.kind !== 'job' && reviewer.kind !== 'job')
    const requested = WorkHandoffResultSchema.parse({ routing: { kind: 'request', outcome: 'review' },
      data: { latestDeliverable: { revision: 1, text: 'Exact conformance deliverable' }, remainingFindings: [] } })
    const returned = WorkHandoffResultSchema.parse({ routing: { kind: 'return', outcome: 'accepted' },
      data: { latestDeliverable: { revision: 1, text: 'Exact conformance deliverable', reviewed: true }, remainingFindings: [] } })
    const results = [requested, returned].map(value => ({ outcome: 'succeeded' as const,
      output: { text: JSON.stringify(value) } }))
    await installCodexScripts(ctx, prompts.map((prompt, index) => ({
      id: `handoff-step-${index}`, includes: prompt, turns: [{ answer: results[index]!.output.text }],
    })))
    const { run } = await startWorkflow(ctx, fixture, { task: 'Review this saved route only', revision: 67 })
    const completed = await waitForCompletedRun(ctx, run, results[1]!)
    const executions = await assertExecutions(ctx, fixture, completed,
      [{ nodeId: requester.id }, { nodeId: reviewer.id }])
    const source = executions.find(execution => execution.workflowNodeId === requester.id)!
    const destination = executions.find(execution => execution.workflowNodeId === reviewer.id)!
    const entryDetail = await readExecutionDetail(ctx, run, source.executionId)
    const entry = handoffReadInput(entryDetail.value.acceptedInput.value)
    assert.equal(entry.work.kind, 'entry')
    const scope = runScope(run)
    assertJson(entry, { executionSemanticsVersion: 3, runInput: run.input, occurrence: null, entry: null, predecessors: [],
      work: { kind: 'entry', activation: { scope, activationId: '<id>', workflowNodeId: requester.id,
        lineageId: run.id, cause: { kind: 'entry' } } },
    }, [{ pointer: '/body/work/activation/activationId', kind: 'id' }])
    await assertExecutionDetail(ctx, completed, source, entry, results[0]!)
    await assertBindings(ctx, run, source, entry, [])
    const receivedDetail = await readExecutionDetail(ctx, run, destination.executionId)
    const received = handoffReadInput(receivedDetail.value.acceptedInput.value)
    assert.ok(received.work.kind === 'work_request')
    const { request, activation } = received.work
    assert.notEqual(activation.activationId, entry.work.activation.activationId)
    assertJson(received, { executionSemanticsVersion: 3, runInput: run.input, occurrence: null, entry: null, predecessors: [],
      work: { kind: 'work_request', activation: { scope, activationId: '<id>', workflowNodeId: reviewer.id,
        lineageId: run.id, cause: { kind: 'work_request', requestId: request.requestId } },
      request: { scope, requestId: '<id>', relationshipId: edge.id,
        requesterActivationId: entry.work.activation.activationId, requesterExecutionId: source.executionId,
        destinationActivationId: activation.activationId, requesterNodeId: requester.id, destinationNodeId: reviewer.id,
        payloadDigest: workflowDigest(results[0]!), acceptedAt: '<timestamp>', ordinal: 1 },
      acceptedSourceResult: results[0]! },
    }, [{ pointer: '/body/work/activation/activationId', kind: 'id' },
      { pointer: '/body/work/request/requestId', kind: 'id' },
      { pointer: '/body/work/request/acceptedAt', kind: 'timestamp' }])
    await assertExecutionDetail(ctx, completed, destination, received, results[1]!)
    await assertBindings(ctx, run, destination, received, [])
    const endpoint = (node: typeof requester) => ({ nodeId: node.id, nodeName: node.name,
      agentId: node.agentId, agentName: node.name })
    const handoffs = RunHandoffsReadSchema.parse({ scope, policy: 'work', runState: 'completed',
      connections: [{ relationshipId: edge.id, source: endpoint(requester), target: endpoint(reviewer),
        workRequestDirection: 'source_to_target', used: 1, limit: null, remaining: null }],
      routes: [{ requesterNodeId: requester.id, outcome: 'review', relationshipId: edge.id,
        destinationNodeId: reviewer.id, available: false }], notices: [], unresolved: [], directionWait: false,
    })
    await assertHandoffRead(ctx, handoffs)
    await ctx.target.restart()
    assertResponse(await ctx.http.request('GET', `${runPath(run)}/record`), { status: 200, body: completed })
    await assertExecutionDetail(ctx, completed, source, entry, results[0]!)
    await assertExecutionDetail(ctx, completed, destination, received, results[1]!)
    await assertHandoffRead(ctx, handoffs)
  },
}]
