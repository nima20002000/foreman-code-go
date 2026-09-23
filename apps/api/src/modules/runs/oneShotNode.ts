import type { HarnessExecution } from '@graphql/contracts'
import type { NodeResolution } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'
import { ExecutionLimiter } from './limiter.js'
import type { OneShotRunRepository } from './oneShotPostgres.js'

export interface OneShotGraphState { runId: string; executionIds: Record<string, string> }

/**
 * The engine adapter must atomically claim a queued dispatch, or reconcile an
 * existing exact session. `observe` is not permission to blindly call startTurn.
 * It must retain the existing durable approval interrupt/resume implementation.
 * The production adapter lives in oneShotRuntime.ts.
 */
export interface OneShotExecutionDriver {
  candidate(nodeId: string): HarnessExecution
  observe(execution: HarnessExecution, signal: AbortSignal): Promise<void>
}

function stateForResolution(resolution: NodeResolution): Partial<OneShotGraphState> {
  if (resolution.resolution === 'failed' || resolution.resolution === 'canceled') {
    throw new DomainError('WORKFLOW_SELECTED_EXECUTION_FAILED', 'A selected execution did not succeed.', 409)
  }
  return resolution.execution ? { executionIds: { [resolution.workflowNodeId]: resolution.execution.executionId } } : {}
}

/**
 * Runtime wrapper used by the v2 graph and focused tests. Admission is durable
 * BEFORE waiting for capacity. Skipped and already-resolved wrappers perform
 * bookkeeping only and never invoke candidate/observe or acquire a native slot.
 */
export function oneShotNodeAction(input: {
  runId: string
  store: Pick<OneShotRunRepository, 'admit' | 'acceptTerminal'>
  driver: OneShotExecutionDriver
  limiter: ExecutionLimiter
  signal: AbortSignal
}): (nodeId: string, state: OneShotGraphState) => Promise<Partial<OneShotGraphState>> {
  return async (nodeId, state) => {
    if (state.runId !== input.runId) throw new DomainError('RUN_PIN_CONFLICT', 'Graph state belongs to another Run.', 409)
    input.signal.throwIfAborted()
    const admission = await input.store.admit(nodeId, () => input.driver.candidate(nodeId))
    if (admission.kind === 'waiting') {
      throw new DomainError('WORKFLOW_UNRESOLVED', 'The graph barrier ran before every incoming relationship resolved.', 409)
    }
    if (admission.kind === 'resolved') return stateForResolution(admission.resolution)
    const execution = admission.execution
    if (execution.state !== 'completed') {
      // No terminal repair path enters native capacity, including after a
      // checkpoint-write crash following an accepted predecessor result.
      await input.limiter.run(input.signal, async () => {
        input.signal.throwIfAborted()
        await input.driver.observe(execution, input.signal)
      })
    }
    input.signal.throwIfAborted()
    return stateForResolution(await input.store.acceptTerminal(execution.id))
  }
}
