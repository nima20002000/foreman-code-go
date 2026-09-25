import { isDeepStrictEqual } from 'node:util'
import type { HarnessExecution, NativeSessionReference } from '@graphql/contracts'
import type { ClosedWorkflowSession } from './stoppedWorkflowFinalization.js'
import { DomainError } from '../errors.js'

const identityKeys = ['id', 'runId', 'workflowNodeId', 'agentId', 'agentConfigurationVersionId',
  'attempt', 'workingDirectory', 'runtimeDirectory', 'nativeSessionId'] as const

export function repeatNativePending(code = 'REPEAT_CLEANUP_PENDING'): never {
  throw new DomainError(code, 'The exact repeat execution still has unsettled native or approval evidence.', 409)
}

/** A terminal result, an expired lease and a missing local process are not close
 * receipts. Only readWorkflowClosure's current durable generation is acceptable.
 * The SQL caller holds the parent/execution locks until its commit. */
export function assertRepeatNativeClosure(execution: HarnessExecution, session: NativeSessionReference,
  proof: ClosedWorkflowSession | undefined): string {
  if (!proof?.durableGeneration || !/^[1-9][0-9]*$/.test(proof.durableGeneration)) return repeatNativePending()
  if (execution.state !== 'completed' || !execution.result || !execution.finishedAt
    || execution.nativeSessionId !== session.nativeSessionId
    || identityKeys.some((key) => proof.execution[key] !== execution[key])
    || !isDeepStrictEqual(proof.session, session)) {
    return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
  }
  return proof.durableGeneration
}

/** Validate immutable identity BEFORE running a first-observation normalizer.
 * In particular a duplicate of an already-invalid terminal is still immutable:
 * it cannot be repaired by normalization on a later observation. This helper
 * consumes schema-validated records; it is not a wire validator or native gate. */
export function assertRepeatNativeUpdate(previous: HarnessExecution, incoming: HarnessExecution): 'replay' | 'write' {
  const immutable = (execution: HarnessExecution) => ({
    id: execution.id, runId: execution.runId, workflowNodeId: execution.workflowNodeId,
    agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId,
    attempt: execution.attempt, createdAt: execution.createdAt, input: execution.input,
    workingDirectory: execution.workingDirectory, runtimeDirectory: execution.runtimeDirectory,
  })
  if (!isDeepStrictEqual(immutable(previous), immutable(incoming))
    || previous.nativeSessionId !== undefined && previous.nativeSessionId !== incoming.nativeSessionId
    || previous.startedAt !== undefined && previous.startedAt !== incoming.startedAt) {
    return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
  }
  if (previous.state === 'completed') {
    if (!isDeepStrictEqual(previous, incoming)) return repeatNativePending('REPEAT_TERMINAL_CONFLICT')
    return 'replay'
  }
  if (incoming.state === 'queued' && previous.state !== 'queued'
    || incoming.state !== 'completed' && (incoming.result !== undefined || incoming.finishedAt !== undefined)) {
    return repeatNativePending('REPEAT_NATIVE_STATE_CONFLICT')
  }
  if (incoming.state === 'completed' && (!incoming.result || !incoming.finishedAt)) {
    return repeatNativePending('REPEAT_TERMINAL_CONFLICT')
  }
  return isDeepStrictEqual(previous, incoming) ? 'replay' : 'write'
}
