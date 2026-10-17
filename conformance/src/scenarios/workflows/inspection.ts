import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import type { ExecutionResult } from '@foreman-code/contracts'
import {
  GraphExecutionIdentitySchema, RunExecutionBindingsPageSchema, RunExecutionDetailSchema,
  RunExecutionsPageSchema, RunInputSourceSchema,
  type RunExecutionBindingsPage, type RunExecutionDetail, type RunExecutionSummary,
  type RunRecordDetail, type WorkflowRunV3,
} from '@foreman-code/contracts/wave25'
import { assertResponse, type NormalizationRule } from '../../assertions.js'
import type { ScenarioContext } from '../../scenario.js'
import type { ExecutableWorkflow } from './authoring.js'
import { workflowDigest } from './digest.js'
import { runPath } from './runs.js'

export function runScope(run: WorkflowRunV3) {
  return { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 as const }
}

export function runSummary(record: RunRecordDetail) {
  const { run } = record
  return { ...runScope(run), executionState: run.executionState, outcome: run.outcome, createdAt: run.createdAt,
    ...(run.startedAt === undefined ? {} : { startedAt: run.startedAt }),
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.stopCause === undefined ? {} : { stopCause: run.stopCause }),
    ...(run.result?.error === undefined ? {} : { failure: run.result.error }), cleanupPending: record.cleanupPending }
}

export function executionIdentity(execution: RunExecutionSummary) {
  assert.notEqual(execution.kind, 'job', 'This fixture requests an Agent execution')
  if (execution.kind === 'job') throw new Error('A Job cannot satisfy an Agent execution expectation')
  return GraphExecutionIdentitySchema.parse({ workflowNodeId: execution.workflowNodeId,
    executionId: execution.executionId, agentId: execution.agentId,
    agentConfigurationVersionId: execution.agentConfigurationVersionId, attempt: execution.attempt })
}

export interface ExecutionExpectation {
  nodeId: string
  attempt?: number
  state?: RunExecutionSummary['state']
  accepted?: boolean
  failure?: ExecutionResult['error']
  occurrence?: RunExecutionSummary['occurrence']
  tickIndex?: number
  continuedFromExecutionId?: string
}

function executionKey(value: { nodeId: string; attempt: number; occurrenceIndex?: number; tickIndex?: number }) {
  return JSON.stringify([value.nodeId, value.attempt, value.occurrenceIndex ?? null, value.tickIndex ?? null])
}

/** Every row is compared in full; expectations select identities, never record snapshots as answers. */
export async function assertExecutions(ctx: ScenarioContext, fixture: ExecutableWorkflow,
  record: RunRecordDetail, expected: readonly ExecutionExpectation[]) {
  const response = await ctx.http.request('GET', `${runPath(record.run)}/executions?limit=100`)
  const page = RunExecutionsPageSchema.parse(response.body)
  const remaining = new Map(expected.map(value => [executionKey({ nodeId: value.nodeId,
    attempt: value.attempt ?? 1, occurrenceIndex: value.occurrence?.occurrenceIndex, tickIndex: value.tickIndex }), value]))
  assert.equal(remaining.size, expected.length, 'Expected execution identities must be distinct')
  assert.equal(page.items.length, expected.length)
  assert.equal(new Set(page.items.map(item => item.executionId)).size, page.items.length)
  const rules: NormalizationRule[] = []
  const items = page.items.map((item, index) => {
    const key = executionKey({ nodeId: item.workflowNodeId, attempt: item.attempt,
      occurrenceIndex: item.occurrence?.occurrenceIndex, tickIndex: item.tickIndex })
    const wanted = remaining.get(key)
    assert.ok(wanted, `Unexpected or duplicate execution: ${key}`)
    remaining.delete(key)
    const node = fixture.saved.version.definition.nodes.find(value => value.id === wanted.nodeId)
    assert.ok(node && node.kind !== 'job')
    const state = wanted.state ?? 'completed'
    const base = `/body/items/${index}`
    rules.push({ pointer: `${base}/executionId`, kind: 'id' }, { pointer: `${base}/createdAt`, kind: 'timestamp' })
    if (state !== 'queued') rules.push({ pointer: `${base}/startedAt`, kind: 'timestamp' })
    if (state === 'completed') rules.push({ pointer: `${base}/finishedAt`, kind: 'timestamp' })
    return { workflowNodeId: node.id, executionId: '<id>', agentId: node.agentId,
      agentConfigurationVersionId: record.run.agentConfigurationVersionIds[node.agentId],
      attempt: wanted.attempt ?? 1, state, acceptedResultAvailable: wanted.accepted ?? true,
      createdAt: '<timestamp>', ...(state === 'queued' ? {} : { startedAt: '<timestamp>' }),
      ...(state === 'completed' ? { finishedAt: '<timestamp>' } : {}),
      ...(wanted.failure === undefined ? {} : { failure: wanted.failure }),
      ...(wanted.occurrence === undefined ? {} : { occurrence: wanted.occurrence }),
      ...(wanted.tickIndex === undefined ? {} : { tickIndex: wanted.tickIndex }),
      ...(wanted.continuedFromExecutionId === undefined ? {} : { continuedFromExecutionId: wanted.continuedFromExecutionId }),
    }
  })
  assert.equal(remaining.size, 0)
  assertResponse(response, { status: 200, body: { run: runSummary(record), items, pageInfo: { nextCursor: null } } }, rules)
  return page.items
}

export async function readExecutionDetail(ctx: ScenarioContext, run: WorkflowRunV3, executionId: string) {
  const response = await ctx.http.request('GET', `${runPath(run)}/executions/${executionId}`)
  assert.equal(response.status, 200)
  return { response, value: RunExecutionDetailSchema.parse(response.body) }
}

export async function assertExecutionDetail(ctx: ScenarioContext, record: RunRecordDetail,
  execution: RunExecutionSummary, input: RunExecutionDetail['acceptedInput']['value'],
  result: ExecutionResult | undefined, accepted = true) {
  if (accepted) assert.ok(result, 'An accepted execution requires an exact successful result')
  const detail = await readExecutionDetail(ctx, record.run, execution.executionId)
  assertResponse(detail.response, { status: 200, body: { run: runSummary(record), execution,
    acceptedInput: { digest: workflowDigest(input), value: input },
    acceptedResult: accepted ? { status: 'accepted', digest: workflowDigest(result), value: result } : { status: 'not_accepted' },
    ...(result === undefined ? {} : { reportedResult: result }),
  } })
  return detail.value
}

export function predecessor(relationshipId: string, execution: RunExecutionSummary, result: ExecutionResult) {
  return RunInputSourceSchema.parse({ relationshipId, execution: executionIdentity(execution),
    occurrence: execution.occurrence ?? null, acceptedResultDigest: workflowDigest(result), acceptedResult: result })
}

type BindingSource = Pick<RunExecutionBindingsPage['items'][number], 'kind' | 'source'>

export async function assertBindings(ctx: ScenarioContext, run: WorkflowRunV3, execution: RunExecutionSummary,
  input: RunExecutionDetail['acceptedInput']['value'], sources: readonly BindingSource[]) {
  const response = await ctx.http.request('GET', `${runPath(run)}/executions/${execution.executionId}/bindings?limit=25`)
  RunExecutionBindingsPageSchema.parse(response.body)
  const inputDigest = workflowDigest(input)
  assertResponse(response, { status: 200, body: { scope: runScope(run), executionId: execution.executionId, inputDigest,
    items: sources.map((source, ordinal) => ({ bindingId: '<id>', recipient: executionIdentity(execution),
      recipientOccurrence: execution.occurrence ?? null, inputDigest, ordinal, ...source })),
    pageInfo: { nextCursor: null },
  } }, sources.map((_, index) => ({ pointer: `/body/items/${index}/bindingId`, kind: 'id' as const })))
}

export async function waitForExecution(ctx: ScenarioContext, run: WorkflowRunV3,
  ready: (execution: RunExecutionSummary) => boolean) {
  for (;;) {
    ctx.signal.throwIfAborted()
    const response = await ctx.http.request('GET', `${runPath(run)}/executions?limit=100`)
    assert.equal(response.status, 200)
    const page = RunExecutionsPageSchema.parse(response.body)
    assert.equal(page.run.runId, run.id)
    const matches = page.items.filter(ready)
    assert.ok(matches.length <= 1, 'A controlled execution wait must identify one exact execution')
    if (matches.length === 1) return matches[0]!
    assert.notEqual(page.run.executionState, 'completed', 'Run ended before the requested execution state')
    await setTimeout(100, undefined, { signal: ctx.signal })
  }
}

export function waitForRunningExecution(ctx: ScenarioContext, run: WorkflowRunV3, nodeId: string) {
  return waitForExecution(ctx, run, execution => execution.workflowNodeId === nodeId && execution.state === 'running')
}
