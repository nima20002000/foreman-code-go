import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { AcceptedCurrentNodeResultSchema, NodeResolutionSchema, parseRepeatExitResultV1, parseWorkHandoffResult,
  type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'

import { ExecutionLimiter } from './limiter.js'
import { assertRepeatNativeUpdate } from '../interactions/repeatNativeEvidence.js'
import { parseCurrentChoiceResult } from './currentRouting.js'
import {
  assertRepeatExecution, blockForNode, repeatConflict, repeatDigest, repeatExecutionIdentity, repeatTickIndex,
  type RepeatNodeRef, type RepeatResolution, type RepeatScope,
} from './repeatResolution.js'

export type RepeatAdmission = { kind: 'waiting' } | { kind: 'resolved'; resolution: RepeatResolution }
  | { kind: 'admitted'; execution: HarnessExecution; reused: boolean }
export type RepeatAcceptance = { kind: 'accepted' | 'resolved'; resolution: RepeatResolution }
  | { kind: 'retry'; execution: HarnessExecution }
export interface RepeatNodeStore {
  admit(ref: RepeatNodeRef, candidate: () => HarnessExecution): Promise<RepeatAdmission>
  acceptTerminal(executionId: string, candidate: (attempt: number) => HarnessExecution): Promise<RepeatAcceptance>
}
/** Common exact-session native adapter for every current V3 graph. Candidate allocates only a record.
 * Observe must claim through the existing receipt/owner/security path, or reconcile
 * the exact session. An occurrence or input receipt is NEVER a launch capability. */
export interface RepeatExecutionDriver {
  candidate(ref: RepeatNodeRef, attempt: number): HarnessExecution
  observe(execution: HarnessExecution, signal: AbortSignal): Promise<void>
}
export interface RepeatGraphState {
  runId: string
  occurrences: Record<string, string>
  boundaries: Record<string, 'body' | 'done'>
  /** Bounded checkpoint hints only. Durable scoped rows, not these hints, bind inputs. */
  executionIds: Record<string, { executionId: string; occurrenceId: string | null }>
}

/** MUST run before the native coordinator's FIRST durable terminal observation.
 * Already-written/accepted evidence must instead be checked, never normalized in place.
 * The shared parser accepts only the exact native text carrier, without changing
 * stored result bytes or accepting mixed carriers, prose or Markdown. */
export function normalizeRepeatTerminal(version: WorkflowVersionV3, scope: RepeatScope,
  ref: RepeatNodeRef, value: HarnessExecution): HarnessExecution {
  const execution = HarnessExecutionSchema.parse(value)
  assertRepeatExecution(version, scope, ref, execution)
  if (execution.state !== 'completed') return execution
  if (!execution.result) return repeatConflict('EXECUTION_RESULT_MISSING')
  if (execution.result.outcome !== 'succeeded') return execution
  // An interval check has no result contract; its reply never routes the graph.
  if (repeatTickIndex(execution.input) !== undefined) return execution
  if (version.definition.handoffs) {
    try { parseWorkHandoffResult(execution.result); return execution }
    catch {
      return HarnessExecutionSchema.parse({ ...execution, result: { outcome: 'failed', error: {
        code: 'WORK_RESULT_INVALID', message: 'The complete result did not satisfy the pinned work-handoff contract.', retryable: false,
      } } })
    }
  }
  try {
    repeatTerminalResolution(version, scope, ref, execution)
    return execution
  } catch {
    return HarnessExecutionSchema.parse({ ...execution, result: { outcome: 'failed', error: {
      code: 'REPEAT_RESULT_INVALID', message: 'The complete result did not satisfy its pinned bounded result contract.', retryable: false,
    } } })
  }
}

/** Native repository first-observation entry point. Identity and existing
 * terminal evidence are checked BEFORE normalization. The caller must still
 * validate the exact native session/owner/lease, approval receipts and Stop and
 * publish the returned record atomically with its canonical lifecycle facts.
 * Do not use this on raw provider-event storage or result acceptance/replay. */
export function prepareRepeatNativeUpdate(version: WorkflowVersionV3, scope: RepeatScope,
  ref: RepeatNodeRef, previousValue: HarnessExecution, incomingValue: HarnessExecution): HarnessExecution {
  const previous = HarnessExecutionSchema.parse(previousValue)
  const incoming = HarnessExecutionSchema.parse(incomingValue)
  assertRepeatExecution(version, scope, ref, previous)
  assertRepeatExecution(version, scope, ref, incoming)
  if (assertRepeatNativeUpdate(previous, incoming) === 'replay') return previous
  return normalizeRepeatTerminal(version, scope, ref, incoming)
}

export function repeatTerminalResolution(version: WorkflowVersionV3, scope: RepeatScope,
  ref: RepeatNodeRef, execution: HarnessExecution): RepeatResolution {
  assertRepeatExecution(version, scope, ref, execution)
  if (execution.state !== 'completed' || !execution.result || !execution.finishedAt) return repeatConflict('EXECUTION_RESULT_NOT_ACCEPTABLE')
  const node = version.definition.nodes.find((item) => item.id === ref.nodeId)!
  const outgoing = version.definition.edges.filter((edge) => edge.kind === 'execution' && edge.source === node.id).map((edge) => edge.id).sort()
  const block = blockForNode(version, ref.nodeId)
  const exit = block?.exitNodeId === ref.nodeId
  let selected: string[] = [], deferred: string[] = [], outcome: string | undefined, branchEnded = false
  if (execution.result.outcome === 'succeeded') {
    AcceptedCurrentNodeResultSchema.parse(execution.result)
    if (node.choice) {
      outcome = (exit ? parseRepeatExitResultV1(execution.result, node.choice, node.kind === 'job' ? undefined : node.artifactOutputs)
        : parseCurrentChoiceResult(execution.result, node.choice, node.kind === 'job' ? undefined : node.artifactOutputs)).routing.outcome
      const target = node.choice.outcomes.find((item) => item.outcome === outcome)!.target
      if (exit) deferred = outgoing
      else {
        branchEnded = target.kind === 'branch_end'
        if (target.kind === 'edge') selected = [target.relationshipId]
      }
    } else selected = outgoing
  }
  return { ref, deferredRelationshipIds: deferred, value: NodeResolutionSchema.parse({
    workflowNodeId: ref.nodeId, execution: repeatExecutionIdentity(execution), resolution: execution.result.outcome,
    ...(execution.result.outcome === 'succeeded' ? { acceptedResultDigest: repeatDigest(execution.result, 64 * 1024) } : {}),
    ...(outcome === undefined ? {} : { outcome }), branchEnded, selectedRelationshipIds: selected,
    unselectedRelationshipIds: outgoing.filter((id) => !selected.includes(id) && !deferred.includes(id)), resolvedAt: execution.finishedAt,
  }) }
}
export function inactiveRepeatResolution(version: WorkflowVersionV3, ref: RepeatNodeRef,
  kind: 'skipped' | 'excluded', resolvedAt: string): RepeatResolution {
  return { ref, deferredRelationshipIds: [], value: NodeResolutionSchema.parse({ workflowNodeId: ref.nodeId,
    resolution: kind, branchEnded: false, selectedRelationshipIds: [],
    unselectedRelationshipIds: version.definition.edges.filter((edge) => edge.kind === 'execution' && edge.source === ref.nodeId).map((edge) => edge.id).sort(),
    resolvedAt,
  }) }
}
function checkpointResolution(resolution: RepeatResolution): Partial<RepeatGraphState> {
  if (['failed', 'canceled'].includes(resolution.value.resolution)) return repeatConflict('WORKFLOW_SELECTED_EXECUTION_FAILED')
  const execution = resolution.value.execution
  return execution ? { executionIds: { [resolution.ref.nodeId]: {
    executionId: execution.executionId, occurrenceId: resolution.ref.occurrence?.occurrenceId ?? null,
  } } } : {}
}

export function repeatNodeAction(input: {
  runId: string; store: RepeatNodeStore; driver: RepeatExecutionDriver; limiter: ExecutionLimiter; signal: AbortSignal;
}): (ref: RepeatNodeRef, state: RepeatGraphState) => Promise<Partial<RepeatGraphState>> {
  return async (ref, state) => {
    if (state.runId !== input.runId) return repeatConflict('RUN_PIN_CONFLICT')
    input.signal.throwIfAborted()
    const admitted = await input.store.admit(ref, () => input.driver.candidate(ref, 1))
    if (admitted.kind === 'waiting') return repeatConflict('WORKFLOW_UNRESOLVED')
    if (admitted.kind === 'resolved') return checkpointResolution(admitted.resolution)
    let execution = admitted.execution
    for (;;) {
      input.signal.throwIfAborted()
      if (execution.state === 'completed') {
        // A crash can leave a terminal result before exact cleanup/finalization.
        // Re-enter observation for settlement, never for a new native launch.
        // Do not hold native launch capacity for this SQL/cleanup-only replay.
        await input.driver.observe(execution, input.signal)
      } else await input.limiter.run(input.signal, async () => {
        input.signal.throwIfAborted()
        await input.driver.observe(execution, input.signal)
      })
      input.signal.throwIfAborted()
      const accepted = await input.store.acceptTerminal(execution.id, (attempt) => input.driver.candidate(ref, attempt))
      if (accepted.kind !== 'retry') return checkpointResolution(accepted.resolution)
      // Technical attempts keep the same slot and frozen input. The repository
      // checked retry policy, exact negative evidence, cleanup and budget at COMMIT.
      execution = accepted.execution
    }
  }
}
