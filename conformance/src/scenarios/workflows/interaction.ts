import assert from 'node:assert/strict'
import {
  DurableInteractionSchema, GetInteractionResponseSchema, NativeQuestionSchema,
  RespondToInteractionRequestSchema, RespondToInteractionResponseSchema,
  type DurableInteraction,
} from '@foreman-code/contracts'
import { DEFAULT_MANAGEMENT_ACTIONS, LocalHumanAccessSchema, NON_EXPIRING_CREDENTIAL_TIMESTAMP,
  ManagedInteractionSchema, InteractionSummaryResultSchema } from '@foreman-code/contracts/management'
import { RunAcceptedInputValueSchema } from '@foreman-code/contracts/wave25'
import { assertJson, assertResponse } from '../../assertions.js'
import type { Scenario } from '../../scenario.js'
import { readCoverage } from '../http/support.js'
import { assertInvalidCallerDenied, assertReadOnlyDenied, callTool, mcpClaims, operatorClients } from '../mcp/support.js'
import { assertApiError, httpCoverage } from '../smoke/support.js'
import { createExecutableWorkflow } from './authoring.js'
import { installCodexScripts } from './codexScript.js'
import { assertBindings, assertExecutionDetail, assertExecutions, waitForExecution } from './inspection.js'
import { assertInteractionReads, interactionActivity, interactionCounts, waitForPendingInput } from './interactionRead.js'
import { runPath, startWorkflow, waitForCompletedRun, waitForRun } from './runs.js'

const questions = NativeQuestionSchema.array().parse([{ id: 'choice', header: 'Fixture choice',
  question: 'Which isolated conformance result should this turn use?', isOther: false, isSecret: false,
  options: [{ label: 'Blue', description: 'Use the selected conformance value.' },
    { label: 'Green', description: 'Use the alternate conformance value.' }],
}])
const response = { choice: { answers: ['Blue'] } }
const method = 'item/tool/requestUserInput'

function assertPending(interaction: DurableInteraction, run: Parameters<typeof runPath>[0],
  execution: Awaited<ReturnType<typeof waitForExecution>>) {
  assert.ok(execution.kind !== 'job')
  const request = interaction.request
  assert.ok(request && typeof request === 'object' && !Array.isArray(request))
  assert.equal(typeof request.itemId, 'string')
  assert.ok(interaction.nativeRequestId.startsWith(`${interaction.nativeSessionId}:turn-1:${method}:`))
  assert.ok(interaction.nativeRequestId.endsWith(`:string:${request.itemId}`))
  assertJson(interaction, {
    id: '<id>', revision: 1, workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    executionId: execution.executionId, requestingAgentId: execution.agentId,
    harness: 'codex', providerVersion: '0.154.0', nativeSessionId: '<id>', nativeRequestId: '<opaque-id>',
    nativeRequestType: method, graphThreadId: run.id, graphInterruptId: '<id>',
    request: { itemId: '<id>', questions, isBlocking: true, threadId: interaction.nativeSessionId, turnId: 'turn-1' },
    approval: run.approval, responseOptions: [{ optionId: '<id>', semantic: 'approve_once', label: 'Submit answers',
      persistence: 'request', affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false,
      input: { kind: 'questions', questions } }],
    status: 'pending', deliveryState: 'not_started', createdAt: '<timestamp>', updatedAt: '<timestamp>',
  }, [
    ...['id', 'nativeSessionId', 'graphInterruptId', 'request/itemId', 'responseOptions/0/optionId']
      .map(pointer => ({ pointer: `/body/${pointer}`, kind: 'id' as const })),
    { pointer: '/body/nativeRequestId', kind: 'opaque-id' },
    ...['createdAt', 'updatedAt'].map(pointer => ({ pointer: `/body/${pointer}`, kind: 'timestamp' as const })),
  ])
}

function assertDelivered(actual: DurableInteraction, pending: DurableInteraction, auditReference: string,
  revision: 5 | 6) {
  assertJson(actual, { ...pending, revision, status: 'delivered', deliveryState: 'delivered',
    selectedOptionId: pending.responseOptions[0]!.optionId, selectedSemantic: 'approve_once',
    nativeResponse: { optionId: pending.responseOptions[0]!.optionId, semantic: 'approve_once', response },
    auditReference, decidedAt: '<timestamp>', deliveredAt: '<timestamp>', updatedAt: '<timestamp>',
  }, ['decidedAt', 'deliveredAt', 'updatedAt'].map(pointer => ({ pointer: `/body/${pointer}`, kind: 'timestamp' as const })))
  assert.ok(Date.parse(actual.decidedAt!) >= Date.parse(pending.createdAt))
  assert.ok(Date.parse(actual.deliveredAt!) >= Date.parse(actual.decidedAt!))
}

export const interactionWorkflowScenarios: Scenario[] = (['user-http', 'operator-http', 'operator-mcp'] as const).map((channel): Scenario => ({
  id: `workflow.native-input-resume-${channel}`,
  title: `A ${channel} question response reaches the native turn once and resumes the same saved execution`,
  lane: 'E', authentication: 'operator', timeoutMs: 180_000,
  covers: [{ surface: 'workflow', name: 'interactions-resume', case: 'success' },
    { surface: 'harness', name: 'codex-native', case: 'success' },
    ...['/api/user/interactions', '/api/user/interactions/:interactionId',
      '/api/management/interactions', '/api/management/interactions/:interactionId'].flatMap(readCoverage),
    ...['/api/user/interactions/:interactionId/respond', '/api/management/interactions/:interactionId/respond']
      .flatMap(path => [httpCoverage('POST', path, 'success'), httpCoverage('POST', path, 'error')]),
    ...mcpClaims('interaction_summary', 'interaction_list', 'interaction_get', 'interaction_respond')],
  async run(ctx) {
    const prompt = `Conformance native question through ${channel}`
    const fixture = await createExecutableWorkflow(ctx, { name: `Native input ${channel}`, initialPrompt: prompt })
    await installCodexScripts(ctx, [{ id: 'question', includes: prompt, turns: [{
      interaction: { method, params: { questions, isBlocking: true } }, jsonAnswer: { $ref: 'interaction' },
    }] }])
    const { operator, readOnly } = operatorClients(ctx)
    const operatorToken = ctx.target.operatorToken
    assert.ok(operatorToken, 'Interaction authorization checks require the fresh Operator credential.')
    const identityResponse = await ctx.http.request('GET', '/api/local-human', { token: operatorToken })
    const identity = LocalHumanAccessSchema.parse(identityResponse.body)
    assertResponse(identityResponse, { status: 200, body: { principal: { id: '<id>', name: 'Conformance manage',
      expiresAt: NON_EXPIRING_CREDENTIAL_TIMESTAMP, grants: [{ actions: DEFAULT_MANAGEMENT_ACTIONS, scope: {} }] } } },
    [{ pointer: '/body/principal/id', kind: 'id' }])
    const { run } = await startWorkflow(ctx, fixture, { task: 'Retain this exact input while waiting', revision: 71 })
    const pending = await waitForPendingInput(ctx, run)
    const execution = await waitForExecution(ctx, run, item => item.state === 'waiting')
    assertPending(pending, run, execution)
    const waiting = await waitForRun(ctx, run, record => record.run.executionState === 'waiting')
    assertResponse(waiting.response, { status: 200, body: { run: { ...run, executionState: 'waiting', startedAt: '<timestamp>' },
      stopRequested: false, cleanupPending: false } }, [{ pointer: '/body/run/startedAt', kind: 'timestamp' }])
    assert.deepStrictEqual(await assertExecutions(ctx, fixture, waiting.record,
      [{ nodeId: execution.workflowNodeId, state: 'waiting', accepted: false }]), [execution])
    const acceptedInput = RunAcceptedInputValueSchema.parse({ executionSemanticsVersion: 3,
      runInput: run.input, occurrence: null, entry: null, predecessors: [] })
    await assertExecutionDetail(ctx, waiting.record, execution, acceptedInput, undefined, false)
    const input = RespondToInteractionRequestSchema.parse({ interactionId: pending.id,
      optionId: pending.responseOptions[0]!.optionId, expectedRevision: pending.revision, response })
    await assertReadOnlyDenied(readOnly, 'interaction_respond', input)
    assert.deepStrictEqual(await callTool(readOnly, 'interaction_get', { interactionId: pending.id }, ManagedInteractionSchema),
      { interaction: pending, activity: interactionActivity(pending, false), canRespond: false })
    assert.deepStrictEqual(await callTool(operator, 'interaction_summary', { runId: run.id }, InteractionSummaryResultSchema),
      interactionCounts(pending))
    const userPath = `/api/user/interactions/${pending.id}/respond`
    const operatorPath = `/api/management/interactions/${pending.id}/respond`
    const answer = channel === 'operator-mcp'
      ? await callTool(operator, 'interaction_respond', input, RespondToInteractionResponseSchema)
      : await (async () => {
        const result = await ctx.http.request('POST', channel === 'user-http' ? userPath : operatorPath,
          { body: input, ...(channel === 'user-http' ? {} : { token: operatorToken }) })
        assert.equal(result.status, 200)
        const value = RespondToInteractionResponseSchema.parse(result.body)
        assertResponse(result, { status: 200, body: value })
        return value
      })()
    assert.equal(answer.replayed, false)
    assert.ok(answer.interaction.revision === 5 || answer.interaction.revision === 6,
      'Delivery and graph consumption must settle before the response; only worker acknowledgment may race the return')
    const auditReference = channel === 'user-http' ? 'principal-local-human' : identity.principal.id
    assertDelivered(answer.interaction, pending, auditReference, answer.interaction.revision)
    const result = { outcome: 'succeeded' as const, output: { text: JSON.stringify({ answers: response }) } }
    const completed = await waitForCompletedRun(ctx, run, result)
    const [settled] = await assertExecutions(ctx, fixture, completed, [{ nodeId: execution.workflowNodeId }])
    assert.ok(settled)
    assert.equal(settled.executionId, pending.executionId, 'Respond must resume the original execution, without a new attempt')
    await assertExecutionDetail(ctx, completed, settled, acceptedInput, result)
    await assertBindings(ctx, run, settled, acceptedInput, [])
    const read = await ctx.http.request('GET', `/api/user/interactions/${pending.id}`)
    const delivered = DurableInteractionSchema.parse(GetInteractionResponseSchema.parse(read.body).interaction)
    assertDelivered(delivered, pending, auditReference, 6)
    await assertInteractionReads(ctx, delivered, operator, readOnly)
    for (const path of [userPath, operatorPath]) {
      assertResponse(await ctx.http.request('POST', path, { body: input }),
        { status: 200, body: { interaction: delivered, replayed: true } })
      assertApiError(await ctx.http.request('POST', path, { body: { ...input, interactionId: 'missing-interaction' } }),
        400, 'INVALID_INTERACTION', 'The response does not match the requested interaction.')
    }
    assertApiError(await ctx.http.request('POST', userPath, { body: input, token: operatorToken }),
      403, 'MCP_BROWSER_REVIEW_REQUIRED', 'Review this change in the local app.')
    assert.deepStrictEqual(await callTool(operator, 'interaction_respond', input, RespondToInteractionResponseSchema),
      { interaction: delivered, replayed: true })
    await assertInvalidCallerDenied(operator, 'interaction_respond', input)
    await ctx.target.restart()
    assertResponse(await ctx.http.request('GET', `${runPath(run)}/record`), { status: 200, body: completed })
    await assertExecutionDetail(ctx, completed, settled, acceptedInput, result)
    const restarted = operatorClients(ctx)
    await assertInteractionReads(ctx, delivered, restarted.operator, restarted.readOnly)
  },
}))
