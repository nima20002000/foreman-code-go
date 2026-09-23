import { HarnessExecutionSchema, type ExecutionResult } from '@graphql/contracts'
import {
  NodeResolutionSchema, RunNodeInputV2Schema, type GraphExecutionIdentity, type InputBinding, type GraphFact,
} from '@graphql/contracts/wave25'
import { type RunGraphPublication, type GraphEffectGuard, graphSourceDigest } from '../../src/modules/run-graph/publication.js'
import { putInputBinding, putNodeResolution } from '../../src/modules/run-graph/records.js'

/** Real SQL example. The supplied guard locks EXISTING effect authority; never a no-op or cached echo. */
export async function exampleAcceptResult(
  publication: RunGraphPublication, identity: GraphExecutionIdentity, guard: GraphEffectGuard, result: ExecutionResult,
  resolvedAt: string, selectedRelationshipIds: string[], unselectedRelationshipIds: string[] = [],
) {
  if (result.outcome !== 'succeeded') throw new Error('EXAMPLE_REQUIRES_SUCCESS')
  const resultDigest = graphSourceDigest(result)
  const resolution = NodeResolutionSchema.parse({
    workflowNodeId: identity.workflowNodeId, resolution: 'succeeded', execution: identity,
    acceptedResultDigest: resultDigest, branchEnded: false, selectedRelationshipIds, unselectedRelationshipIds, resolvedAt,
  })
  const facts: GraphFact[] = [
    { type: 'result.accepted', execution: identity, resultDigest },
    { type: 'node.resolved', resolution },
    { type: 'node.state', state: { workflowNodeId: identity.workflowNodeId, lifecycle: 'succeeded', execution: identity } },
  ]
  const digest = graphSourceDigest({ identity, result, resolvedAt, selectedRelationshipIds, unselectedRelationshipIds })
  return publication.effect({
    effect: { identity: { kind: 'result.accept', entityId: identity.executionId }, digest },
    evidence: { sourceKind: 'execution', sourceId: identity.executionId, sourceRevision: '1' },
    sourceDigest: digest, facts,
  }, guard, async (sql) => {
    const found = await sql.query<{ record: unknown }>('select record from harness_executions where run_id=$1 and id=$2 for update', [publication.scope.runId, identity.executionId])
    const current = HarnessExecutionSchema.parse(found.rows[0]?.record)
    if (current.state === 'completed') throw new Error('EXAMPLE_ALREADY_COMPLETED_WITHOUT_RECEIPT')
    const completed = HarnessExecutionSchema.parse({ ...current, state: 'completed', result, finishedAt: resolvedAt })
    await sql.query('update harness_executions set accepted=true,record=$2::jsonb where id=$1', [identity.executionId, JSON.stringify(completed)])
    await putNodeResolution(sql, publication.scope, resolution)
    return resolution
  })
}
export function exampleBindInput(publication: RunGraphPublication, binding: InputBinding, input: unknown, guard: GraphEffectGuard) {
  const acceptedInput = RunNodeInputV2Schema.parse(input)
  const digest = graphSourceDigest({ binding, input: acceptedInput })
  return publication.effect({
    effect: { identity: { kind: 'input.bind', entityId: binding.bindingId }, digest },
    evidence: { sourceKind: 'input_binding', sourceId: binding.bindingId, sourceRevision: '0' },
    sourceDigest: digest, facts: [{ type: 'input.bound', binding }],
  }, guard, async (sql) => {
    const found = await sql.query<{ record: unknown }>('select record from harness_executions where run_id=$1 and id=$2 for update', [publication.scope.runId, binding.recipient.executionId])
    const current = HarnessExecutionSchema.parse(found.rows[0]?.record)
    if (current.state !== 'queued') throw new Error('EXAMPLE_INPUT_ALREADY_STARTED')
    const recipient = HarnessExecutionSchema.parse({ ...current, input: acceptedInput })
    await sql.query('update harness_executions set record=$2::jsonb where id=$1', [recipient.id, JSON.stringify(recipient)])
    await putInputBinding(sql, publication.scope, binding)
  })
}
