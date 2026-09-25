import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { interrupt, isGraphInterrupt } from '@langchain/langgraph'
import { HarnessExecutionSchema, HarnessExecutionRequestSchema, type HarnessExecution } from '@graphql/contracts'
import { AcceptedWorkflowRunV3Schema, CurrentRunVersionSnapshotSchema,
  type AcceptedWorkflowRunV3, type WorkflowVersionV3 } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import type { ApprovalExecutionCoordinator } from '../interactions/execution.js'
import { assertSameRepeatExecution, type RepeatNativeLaunchStore, type RepeatNativeObservationStore } from '../interactions/repeatObservation.js'
import { withFilesystemDeadline } from '../workspaces/filesystem.js'
import { requiredLocationAccess, type WorkspaceLocationService } from '../workspaces/location.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import type { RunnerAdmission } from './runnerAdmission.js'
import { currentInitialPrompt } from './currentRouting.js'

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
  scope: RepeatScope; version: WorkflowVersionV3
  owner: Pick<RunOwnership, 'assertOwned'>
  store: Pick<RepeatRunRepository, 'readExecution' | 'settleNativeExecution'>
  /** Required existing native boundary; never supply native.ensureObserve directly.
   * Completed input is per-execution cleanup/reconciliation ONLY. It must never
   * allocate a candidate, directory, credential, session or turn, or call finishRun. */
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
        // A completed replay first repairs finalization from durable closure.
        // No native callback at all is needed for a close/COMMIT reply gap.
        if (stored.execution.state === 'completed') {
          try {
            await input.store.settleNativeExecution(execution.id)
            input.owner.assertOwned()
            signal.throwIfAborted()
            return
          } catch (error) {
            if (!repeatSettlementPending(error)) throw error
            input.owner.assertOwned()
            signal.throwIfAborted()
          }
        }
        // Reload rather than trusting checkpoint/native caller input or location.
        // Completed input requests ONLY this execution's outstanding cleanup;
        // nonterminal input uses the existing claim/session/owner native boundary.
        try { await input.observeExact(stored.execution, signal) }
        catch (error) {
          if (isGraphInterrupt(error)) throw error
          input.owner.assertOwned()
          signal.throwIfAborted()
          const terminal = await input.store.readExecution(execution.id)
          if (terminal.execution.state !== 'completed') throw error
          // Native cleanup can throw after the terminal committed. Preserve it,
          // but never let that fact alone unblock a repeat or technical retry.
          await input.store.settleNativeExecution(execution.id)
          input.owner.assertOwned()
          signal.throwIfAborted()
          return
        }
        input.owner.assertOwned()
        signal.throwIfAborted()
        const terminal = await input.store.readExecution(execution.id)
        if (terminal.execution.state !== 'completed') return repeatConflict('REPEAT_BOUNDARY_PENDING')
        await input.store.settleNativeExecution(execution.id)
        input.owner.assertOwned()
        signal.throwIfAborted()
      })().finally(() => { if (inFlight.get(execution.id) === task) inFlight.delete(execution.id) })
      inFlight.set(execution.id, task)
      return task
    },
  }
}

export interface RepeatNativeObserverContext {
  run: AcceptedWorkflowRunV3
  version: WorkflowVersionV3
  owner: RunOwnership
  store: RepeatNativeLaunchStore
  native: Pick<ApprovalExecutionCoordinator, 'observeExact' | 'assertResume'>
  /** The existing engine-wide worker gate; never construct another gate here. */
  admission: RunnerAdmission
  workflows: Pick<PostgresWorkflowRepository, 'getAgentConfiguration'>
  locations: Pick<WorkspaceLocationService, 'revalidateRunAuthorization' | 'revalidateSnapshot'>
  /** Existing accepted runtime root + repeatExecutionDirectoryKey(executionId). */
  directory(executionId: string): string
}

/** Physical adapter for repeatExecutionDriver.observeExact. The same coordinator
 * owns native events, response delivery, approval checkpointing and cleanup.
 * No Run-wide finishRun, candidate allocation, new scheduler or provider shim. */
export function repeatNativeObserver(context: RepeatNativeObserverContext):
  (admitted: HarnessExecution, signal: AbortSignal) => Promise<void> {
  const run = AcceptedWorkflowRunV3Schema.parse(context.run)
  CurrentRunVersionSnapshotSchema.parse({ run, version: context.version })
  const { owner, store, native, locations } = context
  const common = { workflowId: run.workflowId, graphThreadId: run.id, approval: run.approval, owner }
  return async (admitted, signal) => {
    const check = () => {
      signal.throwIfAborted()
      owner.assertOwned()
      if (admitted.runId !== run.id || owner.runId !== run.id) throw new DomainError(
        'GRAPH_SCOPE_MISMATCH', 'An occurrence cannot borrow another Run owner or admission slot.', 409)
    }
    const reload = async () => {
      check()
      const stored = await store.readExecution(admitted.id)
      assertSameRepeatExecution(admitted, stored.execution)
      assertRepeatExecution(context.version, { workspaceId: run.workspaceId, workflowId: run.workflowId,
        workflowVersionId: run.workflowVersionId, runId: run.id, executionSemanticsVersion: 3 }, stored.ref, stored.execution)
      check()
      return stored.execution
    }
    let execution = await reload()
    // Do not even enter capacity or compute a directory for terminal replay.
    if (execution.state === 'completed') {
      await native.observeExact({ ...common, execution, store, signal })
      return
    }
    await context.admission.run(run.id, signal, async () => {
      execution = await reload() // Stop or another exact observation may win while queued.
      if (execution.state === 'completed') {
        await native.observeExact({ ...common, execution, store, signal })
        return
      }
      const node = context.version.definition.nodes.find((item) => item.id === execution.workflowNodeId)
      const configuration = await context.workflows.getAgentConfiguration(execution.agentConfigurationVersionId)
      check()
      if (!node || !configuration || configuration.id !== context.version.agentConfigurationVersionIds[node.agentId]
        || configuration.agentId !== node.agentId || configuration.workspaceId !== run.workspaceId) {
        throw new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT', 'Native work requires the immutable occurrence configuration.', 409)
      }
      assertNativeWorkflowConfiguration(configuration.harness, run.approval,
        run.approval.handler === 'orchestrator' && configuration.agentId === run.approval.designatedOrchestratorAgentId)
      const validate = async () => {
        check()
        await locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId, owner.client)
        check()
        await locations.revalidateSnapshot(run.workspaceId, run.executionLocation, requiredLocationAccess([configuration]), signal)
        check()
      }
      await validate()
      const paths = { workingDirectory: run.executionLocation.rootPath, runtimeDirectory: context.directory(execution.id) }
      const claimed = await store.claimLaunch(execution.id, paths)
      check()
      execution = claimed ?? await store.recoverSession(execution.id)
      check()
      assertSameRepeatExecution(admitted, execution)
      if (execution.state === 'completed') {
        await native.observeExact({ ...common, execution, store, signal })
        return
      }
      if (execution.workingDirectory !== paths.workingDirectory || execution.runtimeDirectory !== paths.runtimeDirectory) {
        throw new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT', 'Recovery cannot replace the accepted occurrence directories.', 409)
      }
      if (!claimed && !execution.nativeSessionId) throw new DomainError('NATIVE_SESSION_START_UNCERTAIN',
        'Dispatch may have occurred. No second native session or turn was started.', 409)
      await validate()
      await store.assertExecutionAdmission(execution.id)
      check()
      if (claimed) {
        // Preparation permits only directory setup. A second acknowledged
        // transition is required before manager or credential preflight.
        if (execution.nativeSessionId) throw new DomainError('NATIVE_ENTRY_CONFLICT', 'A first entry already owns a native session.', 409)
        await store.beginNativeEntry(execution.id)
        check()
        await withFilesystemDeadline((checkFilesystem) => checkFilesystem(() => mkdir(paths.runtimeDirectory, { recursive: true })), signal)
        check()
      }
      const boundary: RepeatNativeObservationStore = {
        readExecution: (id) => store.readExecution(id),
        settleNativeExecution: (id) => store.settleNativeExecution(id),
        exactSession: (id) => store.exactSession(id),
        assertExecutionAdmission: async (id) => { await validate(); await store.assertExecutionAdmission(id); check() },
        assertNativeBoundary: async (id) => { await validate(); await store.assertNativeBoundary(id); check() },
        authorizeNativeSubmission: async (id) => {
          check()
          if (id !== execution.id || !claimed) throw new DomainError('NATIVE_ENTRY_CONFLICT', 'Recovery cannot authorize another submission.', 409)
          await validate()
          await store.authorizeNativeSubmission(id)
          check()
        },
        consumeLaunch: (id) => { check(); return id === execution.id && store.consumeLaunch(id) },
      }
      const initialPrompt = currentInitialPrompt(node, context.version.definition.repeat?.blocks.some((block) => block.exitNodeId === node.id) ?? false)
      const request = HarnessExecutionRequestSchema.parse({ executionId: execution.id, runId: run.id,
        workspaceId: run.workspaceId, workflowNodeId: node.id, ...paths,
        ...(initialPrompt ? { initialPrompt } : {}), configuration, input: execution.input })
      for (;;) {
        const observation = await native.observeExact({ ...common, execution, request, store: boundary, signal })
        execution = observation.execution
        if (observation.state === 'completed') return
        const resumed: unknown = interrupt({ interactionId: observation.interaction.id,
          interactionIds: observation.interactions.map((item) => item.id) })
        // Same delivered interaction checkpoint; never a new decision/delivery.
        await native.assertResume(execution, resumed)
      }
    })
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
export function repeatTerminalNormalizer(version: WorkflowVersionV3, scope: RepeatScope, ref: RepeatNodeRef) {
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
  runId: string; version: WorkflowVersionV3
  owner: Pick<RunOwnership, 'assertOwned'>; signal: AbortSignal
  store: Pick<RepeatRunRepository, 'admit' | 'acceptTerminal' | 'enterBlock' | 'readOccurrence' | 'transition' | 'resolveExcluded' | 'completeRun'>
  driver: RepeatExecutionDriver; lifecycle: RepeatRuntimeLifecycle
  checkpointer: import('@langchain/langgraph-checkpoint').BaseCheckpointSaver
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
      'WORKFLOW_SELECTED_EXECUTION_FAILED', 'WORKFLOW_UNRESOLVED', 'WORKFLOW_RESULT_TOO_LARGE', 'EXECUTION_OCCURRENCE_CONFLICT',
      'RUN_PIN_CONFLICT', 'ACCESS_DENIED', 'GRAPH_SECURITY_UNQUALIFIED', 'GRAPH_STOP_CONFLICT', 'GRAPH_TERMINAL_CONFLICT',
      // Launch preflight refusals happen before any native session exists.
      'APP_MCP_PREFLIGHT_FAILED', 'MCP_INSPECTION_CONTEXT_MISMATCH', 'HARNESS_INSPECTOR_UNAVAILABLE',
      'WORKER_EXECUTION_IDENTITY_INVALID', 'HARNESS_CONFIGURATION_MISMATCH',
    ].includes(code)
  }
  const cancel = () => cancellation ??= input.lifecycle.cancelNativeAndRequestCleanup()
  const drain = () => withCleanupDeadline(async () => { while (tasks.size) await Promise.allSettled([...tasks]) })
  const { graph, config } = buildRepeatGraph({ ...input, signal,
    track: (task) => {
      tasks.add(task)
      void task.then(() => { tasks.delete(task) }, (error: unknown) => {
        tasks.delete(task)
        if (!(input.signal.reason instanceof DomainError && input.signal.reason.code === 'ENGINE_RESTART') && definitive(error)) {
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
    // A2 commits authenticated task-local resume writes on this checkpointer.
    // The runtime never accepts an unreceipted raw resume Command.
    const state = snapshot.values.runId === input.runId ? null
      : { runId: input.runId, occurrences: {}, boundaries: {}, executionIds: {} }
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
    if (input.signal.aborted && input.signal.reason instanceof DomainError && input.signal.reason.code === 'ENGINE_RESTART') {
      // The owning engine closes the original native sessions before releasing
      // ownership. Restart is not a synthetic Stop or terminal business result.
      failed.abort(error)
      await drain()
      throw error
    }
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
