import { createHash, randomUUID } from 'node:crypto'
import { HarnessExecutionSchema, type HarnessExecution } from '@graphql/contracts'
import type { RepeatWorkflowVersionV1 } from '@graphql/contracts/wave25'

import type { RunOwnership } from './ownership.js'
import { normalizeRepeatTerminal, type RepeatExecutionDriver } from './repeatNode.js'
import { assertRepeatExecution, repeatConflict, type RepeatNodeRef, type RepeatScope } from './repeatResolution.js'
import type { RepeatRunRepository } from './repeatPostgres.js'

/** Adapt the existing exact-session native driver, not a second native runtime.
 * The shell supplies the same ApprovalExecutionCoordinator/SingleWriterSessionManager
 * path with a v3-capable repository. It must retain claimLaunch/one-use COMMIT permits,
 * unknown-submission reconciliation, connection generation, credential/owner fences,
 * graph.resume, real Worker acknowledgement and exact native closure/cleanup.
 * Neither a saved occurrence nor a returned candidate is a dispatch permission.
 */
export function repeatExecutionDriver(input: {
  scope: RepeatScope; version: RepeatWorkflowVersionV1
  owner: Pick<RunOwnership, 'assertOwned'>
  store: Pick<RepeatRunRepository, 'readExecution'>
  /** Required existing native boundary; never supply native.ensureObserve directly. */
  observeExact(execution: HarnessExecution, signal: AbortSignal): Promise<void>
}): RepeatExecutionDriver {
  const inFlight = new Map<string, Promise<void>>()
  return {
    candidate: (ref, attempt) => {
      input.owner.assertOwned()
      const node = input.version.definition.nodes.find((item) => item.id === ref.nodeId)
      if (!node) return repeatConflict('WORKFLOW_NODE_NOT_FOUND')
      const execution = HarnessExecutionSchema.parse({ id: `execution-${randomUUID()}`, runId: input.scope.runId,
        workflowNodeId: ref.nodeId, agentId: node.agentId,
        agentConfigurationVersionId: input.version.agentConfigurationVersionIds[node.agentId],
        attempt, input: {}, state: 'queued', createdAt: new Date().toISOString() })
      assertRepeatExecution(input.version, input.scope, ref, execution)
      return execution
    },
    observe: (execution, signal) => {
      input.owner.assertOwned()
      signal.throwIfAborted()
      const previous = inFlight.get(execution.id)
      if (previous) return previous
      const task = (async () => {
        const stored = await input.store.readExecution(execution.id)
        if (stored.execution.id !== execution.id || stored.execution.runId !== input.scope.runId) return repeatConflict('REPEAT_EXECUTION_INPUT_CONFLICT')
        input.owner.assertOwned()
        signal.throwIfAborted()
        // Reload rather than trusting checkpoint/native caller input or location.
        // The exact adapter rechecks Stop/authority and claims/reconciles at I/O.
        await input.observeExact(stored.execution, signal)
      })().finally(() => { if (inFlight.get(execution.id) === task) inFlight.delete(execution.id) })
      inFlight.set(execution.id, task)
      return task
    },
  }
}

/** Directory identity must not use only workflowNodeId: each occurrence/attempt
 * has a distinct execution ID. The existing directory allocator owns the root. */
export function repeatExecutionDirectoryKey(executionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(executionId)) return repeatConflict('REPEAT_EXECUTION_ID_INVALID')
  // Fixed-length opaque hash avoids reserved components and filesystem name limits.
  return createHash('sha256').update(executionId).digest('hex')
}

/** Call from the existing coordinator BEFORE either durable terminal observation.
 * Never invoke this to replace an already-written terminal with a different one. */
export function repeatTerminalNormalizer(version: RepeatWorkflowVersionV1, scope: RepeatScope, ref: RepeatNodeRef) {
  return (execution: HarnessExecution): HarnessExecution => normalizeRepeatTerminal(version, scope, ref, execution)
}

/** Pending settlement is not failure, a new occurrence, a new native acknowledgement,
 * or permission to restart. The existing runtime persists its checkpoint/wait state. */
export function repeatSettlementPending(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ['APPROVAL_SETTLEMENT_PENDING', 'REPEAT_BOUNDARY_PENDING', 'REPEAT_CLEANUP_PENDING'].includes(String(error.code))
}

/** Adapter to the existing Run lifecycle writers/coordinator. These operations are
 * not new state authority. Implementations retain the existing native closure,
 * Stop, finalization, selected-work result and cleanup-intent transactions. */
export interface RepeatRuntimeLifecycle {
  preflight(): Promise<void>
  markRunning(): Promise<void>
  currentState(): Promise<{ executionState: string; stopRequested: boolean }>
  persistWait(snapshot: import('./repeatGraph.js').RepeatCheckpoint): Promise<boolean>
  /** Persist cleanup intent BEFORE native cancellation; false retains uncertainty. */
  cancelNativeAndRequestCleanup(): Promise<boolean>
  settleRun(stopped: boolean, interrupted: boolean): Promise<void>
  /** These are the existing post-terminal cleanup/finalization paths, not fake ack. */
  requestCleanup(): Promise<void>
  finishNative(): Promise<void>
  finishCleanup(): Promise<void>
}

/** Executes the one graph on the existing Run thread. The only loops here drain
 * already tracked wrappers; business progression is inside guarded graph edges.
 * The shared engine remains responsible for Run ownership, admission of the Run,
 * authenticated graph-resume claims and choosing this semantics-3 entry point. */
export async function executeRepeatRuntime(input: {
  runId: string; version: RepeatWorkflowVersionV1
  owner: Pick<RunOwnership, 'assertOwned'>; signal: AbortSignal
  store: Pick<RepeatRunRepository, 'admit' | 'acceptTerminal' | 'enterBlock' | 'readOccurrence' | 'transition' | 'resolveExcluded' | 'completeRun'>
  driver: RepeatExecutionDriver; lifecycle: RepeatRuntimeLifecycle
  checkpointer: import('@langchain/langgraph-checkpoint').BaseCheckpointSaver
  resumeCommand?: import('@langchain/langgraph').Command
  configuredParallelism?: number
}): Promise<void> {
  const { buildRepeatGraph } = await import('./repeatGraph.js')
  const { isGraphInterrupt } = await import('@langchain/langgraph')
  const { withCleanupDeadline } = await import('../interactions/cleanup.js')
  const { ZodError } = await import('zod')
  const failed = new AbortController(), signal = AbortSignal.any([input.signal, failed.signal])
  const tasks = new Set<Promise<Partial<import('./repeatNode.js').RepeatGraphState>>>()
  let firstFailure: unknown, preflightComplete = false, cancellation: Promise<boolean> | undefined
  const definitive = (error: unknown): boolean => {
    if (repeatSettlementPending(error) || isGraphInterrupt(error)) return false
    if (error instanceof ZodError || (error instanceof Error && error.message === 'GRAPH_JSON_LIMIT')) return true
    if (typeof error !== 'object' || !error || !('code' in error)) return false
    const code = String(error.code)
    return code.startsWith('REPEAT_') || code.startsWith('AUTH_') || [
      'WORKFLOW_SELECTED_EXECUTION_FAILED', 'WORKFLOW_UNRESOLVED', 'EXECUTION_OCCURRENCE_CONFLICT',
      'RUN_PIN_CONFLICT', 'ACCESS_DENIED', 'GRAPH_SECURITY_UNQUALIFIED', 'GRAPH_STOP_CONFLICT', 'GRAPH_TERMINAL_CONFLICT',
    ].includes(code)
  }
  const cancel = () => cancellation ??= input.lifecycle.cancelNativeAndRequestCleanup()
  const drain = () => withCleanupDeadline(async () => { while (tasks.size) await Promise.allSettled([...tasks]) })
  const { graph, config } = buildRepeatGraph({ ...input, signal,
    track: (task) => {
      tasks.add(task)
      void task.then(() => { tasks.delete(task) }, (error: unknown) => {
        tasks.delete(task)
        if (definitive(error)) {
          firstFailure ??= error
          failed.abort(error)
          void cancel().catch(() => undefined)
        }
      })
    },
  })
  try {
    input.owner.assertOwned()
    await input.lifecycle.preflight()
    preflightComplete = true
    signal.throwIfAborted()
    await input.lifecycle.markRunning()
    await input.store.resolveExcluded()
    const snapshot = await graph.getState(config)
    if (snapshot.values.runId && snapshot.values.runId !== input.runId) return repeatConflict('RUN_PIN_CONFLICT')
    const state = input.resumeCommand ?? (snapshot.values.runId === input.runId ? null
      : { runId: input.runId, occurrences: {}, boundaries: {}, executionIds: {} })
    // Native iterators need not honor cancellation; the graph invocation is raced
    // independently, then existing exact native cleanup and wrapper drain run below.
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([graph.invoke(state, config), new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })])
    } finally { if (onAbort) signal.removeEventListener('abort', onAbort) }
    await drain()
    signal.throwIfAborted()
    if (firstFailure) throw firstFailure
    if (await input.lifecycle.persistWait(await graph.getState(config))) return
    await input.store.completeRun()
    await input.lifecycle.requestCleanup()
    await input.lifecycle.finishNative()
    await input.lifecycle.finishCleanup()
  } catch (error) {
    input.owner.assertOwned()
    const current = await input.lifecycle.currentState()
    if (current.executionState === 'completed') throw error // immutable terminal, cleanup may still be pending
    const terminalFailure = !preflightComplete || !!firstFailure || definitive(error) || input.signal.aborted || current.stopRequested
    if (!terminalFailure) {
      await drain()
      if (isGraphInterrupt(error) && await input.lifecycle.persistWait(await graph.getState(config))) return
      // I/O, ambiguous receipts and settlement waits retain exact durable work.
      // The owning engine may retry the same checkpoint, never initial state.
      throw error
    }
    failed.abort(error)
    const closing = cancel()
    let drained = false
    try { await drain(); drained = true } catch { /* retain uncertain cleanup */ }
    const clean = await closing
    input.owner.assertOwned()
    await input.lifecycle.settleRun(current.stopRequested, input.signal.aborted && !current.stopRequested)
    if (clean && drained && (await input.lifecycle.currentState()).executionState === 'completed') {
      await input.lifecycle.finishNative()
      await input.lifecycle.finishCleanup()
    }
    throw error
  }
}
