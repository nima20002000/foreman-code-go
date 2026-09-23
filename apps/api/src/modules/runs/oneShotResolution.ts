import { createHash } from 'node:crypto'
import { HarnessExecutionSchema, type ExecutionResult, type HarnessExecution, type RunInput } from '@graphql/contracts'
import {
  AcceptedNodeResultV2Schema, GraphExecutionIdentitySchema, InputBindingSchema,
  NodeResolutionSchema, RunNodeInputV2Schema, parseChoiceResultEnvelope,
  type ChoiceResultEnvelope, type GraphExecutionIdentity, type InputBinding, type NodeResolution, type WorkflowChoice, type WorkflowVersionV2,
} from '@graphql/contracts/wave25'

import { DomainError } from '../errors.js'
import { graphSourceDigest } from '../run-graph/publication.js'
import { compileOneShotTopology, decideOneShotAdmission } from './topology.js'

export function oneShotIdentity(execution: HarnessExecution): GraphExecutionIdentity {
  if (execution.attempt !== 1) throw new DomainError('WORKFLOW_REPEAT_UNSUPPORTED', 'One-shot executions have one attempt.', 409)
  return GraphExecutionIdentitySchema.parse({
    workflowNodeId: execution.workflowNodeId, executionId: execution.id,
    agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId,
    attempt: execution.attempt,
  })
}

export function assertOneShotExecutionPin(version: WorkflowVersionV2, execution: HarnessExecution): void {
  oneShotIdentity(execution)
  const node = version.definition.nodes.find((item) => item.id === execution.workflowNodeId)
  if (!node || node.agentId !== execution.agentId
    || version.agentConfigurationVersionIds[node.agentId] !== execution.agentConfigurationVersionId) {
    throw new DomainError('EXECUTION_OCCURRENCE_CONFLICT', 'The execution does not match the immutable node/configuration pin.', 409)
  }
}

/** Parsing-only view of the exact Codex/OpenCode final-text carrier. Bound the
 * original result here so durable record rechecks can use the same policy without
 * rewriting stored evidence, accepted digests or inputs. Mixed carriers stay invalid.
 */
export function parseOneShotChoiceResult(result: ExecutionResult, choice: WorkflowChoice): ChoiceResultEnvelope {
  AcceptedNodeResultV2Schema.parse(result)
  const output = result.outcome === 'succeeded' ? result.output : undefined
  if (output !== null && typeof output === 'object' && !Array.isArray(output)
    && Object.keys(output).length === 1 && 'text' in output && typeof output.text === 'string') {
    return parseChoiceResultEnvelope({ ...result, output: output.text }, choice)
  }
  return parseChoiceResultEnvelope(result, choice)
}

/** Validate complete evidence BEFORE the first terminal record is written; never salvage a JSON prefix. */
export function normalizeOneShotTerminal(version: WorkflowVersionV2, input: HarnessExecution): HarnessExecution {
  const execution = HarnessExecutionSchema.parse(input)
  assertOneShotExecutionPin(version, execution)
  if (execution.state !== 'completed') return execution
  if (!execution.result) throw new DomainError('EXECUTION_RESULT_MISSING', 'A terminal execution requires an explicit result.', 409)
  if (execution.result.outcome !== 'succeeded') return execution
  const node = version.definition.nodes.find((item) => item.id === execution.workflowNodeId)!
  try {
    if (node.choice) parseOneShotChoiceResult(execution.result, node.choice)
    else AcceptedNodeResultV2Schema.parse(execution.result)
    return execution
  } catch {
    // No model output, paths, parser fragments or secrets are copied into the public error.
    return HarnessExecutionSchema.parse({
      ...execution, result: { outcome: 'failed', error: {
        code: node.choice ? 'WORKFLOW_CHOICE_RESULT_INVALID' : 'WORKFLOW_RESULT_INVALID',
        message: 'The complete result did not satisfy the pinned bounded result contract.', retryable: false,
      } },
    })
  }
}

export function oneShotResolution(version: WorkflowVersionV2, execution: HarnessExecution): NodeResolution {
  assertOneShotExecutionPin(version, execution)
  if (execution.state !== 'completed' || !execution.result || !execution.finishedAt) {
    throw new DomainError('EXECUTION_RESULT_NOT_ACCEPTABLE', 'Only durable terminal evidence can resolve a node.', 409)
  }
  const node = version.definition.nodes.find((item) => item.id === execution.workflowNodeId)!
  const outgoing = version.definition.edges.filter((edge) => edge.kind === 'execution' && edge.source === node.id)
  let selected: string[] = [], outcome: string | undefined, branchEnded = false
  if (execution.result.outcome === 'succeeded') {
    if (node.choice) {
      outcome = parseOneShotChoiceResult(execution.result, node.choice).routing.outcome
      const target = node.choice.outcomes.find((item) => item.outcome === outcome)!.target
      branchEnded = target.kind === 'branch_end'
      if (target.kind === 'edge') selected = [target.relationshipId]
    } else {
      AcceptedNodeResultV2Schema.parse(execution.result)
      selected = outgoing.map((edge) => edge.id)
    }
  }
  return NodeResolutionSchema.parse({
    workflowNodeId: node.id, execution: oneShotIdentity(execution), resolution: execution.result.outcome,
    ...(execution.result.outcome === 'succeeded' ? { acceptedResultDigest: graphSourceDigest(execution.result) } : {}),
    ...(outcome !== undefined ? { outcome } : {}), branchEnded,
    selectedRelationshipIds: selected.sort(),
    unselectedRelationshipIds: outgoing.map((edge) => edge.id).filter((id) => !selected.includes(id)).sort(),
    resolvedAt: execution.finishedAt,
  })
}

export function inactiveOneShotResolution(
  version: WorkflowVersionV2, nodeId: string, resolution: 'skipped' | 'excluded', resolvedAt: string,
): NodeResolution {
  if (!version.definition.nodes.some((node) => node.id === nodeId)) throw new DomainError('WORKFLOW_NODE_NOT_FOUND', 'Unknown node.', 409)
  return NodeResolutionSchema.parse({
    workflowNodeId: nodeId, resolution, branchEnded: false, selectedRelationshipIds: [],
    unselectedRelationshipIds: version.definition.edges.filter((edge) => edge.kind === 'execution' && edge.source === nodeId).map((edge) => edge.id).sort(),
    resolvedAt,
  })
}

/** Domain IDs derive from the one-shot receiving execution and relationship, not from a replay attempt. */
export function oneShotBindingId(runId: string, recipientId: string, relationshipId: string): string {
  return `binding-${createHash('sha256').update(JSON.stringify([runId, recipientId, relationshipId])).digest('hex')}`
}

export function bindOneShotInput(input: {
  version: WorkflowVersionV2; runInput: RunInput; recipient: HarnessExecution; boundAt: string;
  resolutions: ReadonlyMap<string, NodeResolution>;
  predecessors: ReadonlyMap<string, { execution: HarnessExecution; accepted: boolean }>;
}): { execution: HarnessExecution; bindings: InputBinding[] } {
  const { version, recipient, resolutions, predecessors } = input
  assertOneShotExecutionPin(version, recipient)
  const decision = decideOneShotAdmission(compileOneShotTopology(version), recipient.workflowNodeId, resolutions)
  if (decision.kind !== 'run') throw new DomainError('EXECUTION_NOT_ADMISSIBLE', 'Resolve every incoming relationship before admission.', 409)
  if (recipient.state !== 'queued' || recipient.nativeSessionId || recipient.result) {
    throw new DomainError('EXECUTION_INPUT_IMMUTABLE', 'Inputs may only be bound before native activation.', 409)
  }
  const selected = decision.selected.map((edge) => {
    const resolution = resolutions.get(edge.source)
    const previous = resolution?.execution && predecessors.get(resolution.execution.executionId)
    if (!previous || !previous.accepted || previous.execution.runId !== recipient.runId
      || previous.execution.workflowNodeId !== edge.source || previous.execution.state !== 'completed'
      || previous.execution.result?.outcome !== 'succeeded'
      || graphSourceDigest(previous.execution.result) !== resolution?.acceptedResultDigest
      || graphSourceDigest(oneShotIdentity(previous.execution)) !== graphSourceDigest(resolution.execution)) {
      throw new DomainError('EXECUTION_INPUT_NOT_ACCEPTED', 'A selected input requires its exact durable accepted predecessor.', 409)
    }
    assertOneShotExecutionPin(version, previous.execution)
    return { edge, previous: previous.execution }
  })
  const value = RunNodeInputV2Schema.parse({
    executionSemanticsVersion: 2, runInput: input.runInput,
    predecessors: selected.map(({ edge, previous }) => ({
      relationshipId: edge.id, senderNodeId: previous.workflowNodeId,
      senderExecutionId: previous.id, acceptedResult: previous.result,
    })),
  })
  const execution = HarnessExecutionSchema.parse({ ...recipient, input: value })
  const bindings = selected.map(({ edge, previous }, inputOrdinal) => InputBindingSchema.parse({
    bindingId: oneShotBindingId(recipient.runId, recipient.id, edge.id), relationshipId: edge.id,
    sender: oneShotIdentity(previous), recipient: oneShotIdentity(execution),
    acceptedResultDigest: graphSourceDigest(previous.result), recipientInputDigest: graphSourceDigest(value),
    inputOrdinal, boundAt: input.boundAt,
  }))
  return { execution, bindings }
}
