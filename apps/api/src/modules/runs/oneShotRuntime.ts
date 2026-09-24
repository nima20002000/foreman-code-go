import { mkdir } from 'node:fs/promises'
import { ZodError } from 'zod'
import { randomUUID } from 'node:crypto'
import { interrupt, isGraphInterrupt, type Command } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { HarnessExecutionSchema, HarnessExecutionRequestSchema, type HarnessExecution, type WorkflowRun } from '@graphql/contracts'
import { ExecutableWorkflowV2Schema, WorkflowRunV2Schema, canonicalGraphJson, type WorkflowVersionV2 } from '@graphql/contracts/wave25'
import { DomainError } from '../errors.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import type { ApprovalExecutionCoordinator } from '../interactions/execution.js'
import { withCleanupDeadline } from '../interactions/cleanup.js'
import { withFilesystemDeadline } from '../workspaces/filesystem.js'
import { requiredLocationAccess, type WorkspaceLocationService } from '../workspaces/location.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'
import type { PostgresRunRepository } from './postgres.js'
import type { RunOwnership } from './ownership.js'
import { buildOneShotGraph, type OneShotCheckpoint } from './oneShotGraph.js'
import type { OneShotExecutionDriver, OneShotGraphState } from './oneShotNode.js'
import type { RunnerAdmission } from './runnerAdmission.js'
import { oneShotInitialPrompt } from './oneShotPrompt.js'

export interface OneShotRuntimeContext {
  run: WorkflowRun
  version: WorkflowVersionV2
  runs: PostgresRunRepository
  workflows: PostgresWorkflowRepository
  native: ApprovalExecutionCoordinator
  locations: WorkspaceLocationService
  owner: RunOwnership
  signal: AbortSignal
  admission: RunnerAdmission
  directory(nodeId: string): string
}

/** Adapter to the existing exact-session coordinator, not another native runtime.
 * No native/credential/directory allocation occurs until durable queue admission,
 * both capacity gates, security revalidation, and a committed first-launch claim.
 */
export function oneShotExecutionDriver(context: OneShotRuntimeContext): OneShotExecutionDriver {
  const { run, version, runs, workflows, native, locations, owner } = context
  const store = runs.oneShot(owner)
  const inFlight = new Map<string, Promise<void>>()
  const observe = async (admitted: HarnessExecution, signal: AbortSignal): Promise<void> => {
    let execution = admitted
    try {
      await context.admission.run(run.id, signal, async () => {
        signal.throwIfAborted()
        owner.assertOwned()
        const configuration = await workflows.getAgentConfiguration(execution.agentConfigurationVersionId)
        const node = version.definition.nodes.find((item) => item.id === execution.workflowNodeId)
        if (!configuration || !node || configuration.id !== version.agentConfigurationVersionIds[node.agentId]
          || configuration.workspaceId !== run.workspaceId || configuration.agentId !== node.agentId) {
          throw new DomainError('EXECUTION_OCCURRENCE_CONFLICT', 'Native work requires the exact immutable configuration.', 409)
        }
        assertNativeWorkflowConfiguration(configuration.harness, run.approval,
          run.approval?.handler === 'orchestrator' && configuration.agentId === run.approval.designatedOrchestratorAgentId)
        if (!run.executionLocation) throw new DomainError('RUN_LOCATION_MISSING', 'Native work requires the accepted execution location.', 409)
        const validate = async () => {
          signal.throwIfAborted()
          owner.assertOwned()
          if (run.authorizationPrincipalId) {
            await locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId, owner.client)
          }
          await locations.revalidateSnapshot(run.workspaceId, run.executionLocation!, requiredLocationAccess([configuration]), signal)
          signal.throwIfAborted()
        }
        await validate()
        const paths = { workingDirectory: run.executionLocation.rootPath, runtimeDirectory: context.directory(node.id) }
        const claimed = await store.claimLaunch(execution.id, paths)
        if (claimed) execution = claimed
        else execution = await store.recoverSession(execution.id)
        if (execution.state === 'completed') return
        if (!claimed && !execution.nativeSessionId) {
          // A missing acknowledgement/session after dispatch is uncertain, never
          // an excuse to manufacture another session. Publish an abnormal durable
          // disposition so parents/joins cannot wait forever; cleanup stays pending.
          await store.failExecution(execution.id, 'NATIVE_SESSION_START_UNCERTAIN')
          await runs.requestCleanup(run.id)
          throw new DomainError('NATIVE_SESSION_START_UNCERTAIN', 'Native dispatch may have occurred. The execution was not replayed.', 409)
        }
        if (execution.workingDirectory !== paths.workingDirectory || execution.runtimeDirectory !== paths.runtimeDirectory) {
          throw new DomainError('EXECUTION_LOCATION_CONFLICT', 'Recovery cannot replace the execution location or storage identity.', 409)
        }
        await validate()
        await store.assertNativeBoundary(execution.id)
        // The only directory allocation is in the newly claimed branch.
        if (claimed) await withFilesystemDeadline((check) => check(() => mkdir(paths.runtimeDirectory, { recursive: true })), signal)
        const initialPrompt = oneShotInitialPrompt(node)
        const request = HarnessExecutionRequestSchema.parse({
          executionId: execution.id, runId: run.id, workspaceId: run.workspaceId,
          workflowNodeId: node.id, ...paths, ...(initialPrompt ? { initialPrompt } : {}),
          configuration, input: execution.input,
        })
        for (;;) {
          await store.assertNativeBoundary(execution.id)
          const observation = await native.ensureObserve({ candidate: execution, request, approval: run.approval,
            workflowId: run.workflowId, graphThreadId: run.id, owner, signal })
          execution = observation.execution
          if (observation.state === 'completed') return // acceptance re-reads the durable record
          const resumed: unknown = interrupt({ interactionId: observation.interaction.id,
            interactionIds: observation.interactions.map((item) => item.id) })
          // Same checkpoint identity and exact delivered interaction validation as
          // the legacy engine. This never decides/delivers/replays an approval.
          await native.assertResume(execution, resumed)
        }
      })
    } catch (error) {
      if (isGraphInterrupt(error) || (error instanceof DomainError && ['RUNNER_ADMISSION_FULL', 'SESSION_LANE_BUSY'].includes(error.code))) throw error
      owner.assertOwned() // a lost owner cannot settle a replacement owner's work
      const terminal = await runs.getExecution(execution.id, owner)
      // Native cleanup can throw AFTER a positively evidenced terminal result
      // was persisted. Let the wrapper accept/resolve that exact record instead
      // of converting cleanup failure into a different business outcome. The
      // existing exact-session record retains unfinalized cleanup; Run completion
      // creates its cleanup intent atomically and finishRun retries closure.
      if (terminal?.state === 'completed') return
      const stopped = await runs.hasRequestedStop(run.id)
      await store.failExecution(execution.id, signal.aborted ? 'EXECUTION_INTERRUPTED' : 'NATIVE_EXECUTION_FAILED', stopped)
      throw new DomainError('WORKFLOW_SELECTED_EXECUTION_FAILED', 'A selected execution ended abnormally; native work was not replayed.', 409)
    }
  }
  return {
    candidate: (nodeId) => {
      const node = version.definition.nodes.find((item) => item.id === nodeId)
      if (!node) throw new DomainError('WORKFLOW_NODE_NOT_FOUND', 'Unknown node.', 404)
      return HarnessExecutionSchema.parse({ id: `execution-${randomUUID()}`, runId: run.id, workflowNodeId: nodeId,
        agentId: node.agentId, agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
        attempt: 1, input: {}, state: 'queued', createdAt: new Date().toISOString() })
    },
    observe: (execution, signal) => {
      const existing = inFlight.get(execution.id)
      if (existing) return existing
      const task = observe(execution, signal).finally(() => { if (inFlight.get(execution.id) === task) inFlight.delete(execution.id) })
      inFlight.set(execution.id, task)
      return task
    },
  }
}

export async function executeOneShotRuntime(input: OneShotRuntimeContext & {
  checkpointer: BaseCheckpointSaver
  resumeCommand?: Command
  persistWait(snapshot: OneShotCheckpoint): Promise<boolean>
  configuredParallelism?: number
}): Promise<void> {
  const run = WorkflowRunV2Schema.parse(input.run)
  const { version, runs, owner, signal, native } = input
  if (run.workflowVersionId !== version.id || run.workspaceId !== version.workspaceId || run.workflowId !== version.workflowId
    || canonicalGraphJson(run.agentConfigurationVersionIds) !== canonicalGraphJson(version.agentConfigurationVersionIds)
    || canonicalGraphJson(run.approval) !== canonicalGraphJson(version.approval)) {
    throw new DomainError('RUN_PIN_CONFLICT', 'The Run does not match its immutable version.', 409)
  }
  const store = runs.oneShot(owner)
  const failed = new AbortController()
  const nodeSignal = AbortSignal.any([signal, failed.signal])
  const tasks = new Set<Promise<Partial<OneShotGraphState>>>()
  let taskError: unknown
  let preflightComplete = false
  let cleanup: Promise<boolean> | undefined
  const isFailure = (error: unknown) => error instanceof ZodError
    || (error instanceof Error && error.message === 'GRAPH_JSON_LIMIT')
    || (error instanceof DomainError && (['WORKFLOW_SELECTED_EXECUTION_FAILED', 'RUN_PIN_CONFLICT', 'EXECUTION_OCCURRENCE_CONFLICT', 'WORKFLOW_UNRESOLVED',
      'ACCESS_DENIED', 'WORKFLOW_RESULT_TOO_LARGE', 'GRAPH_SECURITY_UNQUALIFIED', 'GRAPH_STOP_CONFLICT', 'GRAPH_TERMINAL_CONFLICT'].includes(error.code)
      || error.code.startsWith('AUTH_')))
  const cancelNative = () => cleanup ??= (async () => {
    await runs.requestCleanup(run.id)
    try { await native.cancelRun(run.id); return true } catch { return false }
  })()
  const driver = oneShotExecutionDriver({ ...input, signal: nodeSignal })
  const { graph, config } = buildOneShotGraph({ runId: run.id, version, store, driver,
    checkpointer: input.checkpointer, signal: nodeSignal, configuredParallelism: input.configuredParallelism ?? 4,
    track: (task) => {
      tasks.add(task)
      void task.then(() => { tasks.delete(task) }, (error: unknown) => {
        tasks.delete(task)
        if (isFailure(error)) {
          taskError ??= error
          failed.abort(error) // release queued siblings before draining active wrappers
          void cancelNative().catch(() => undefined)
        }
      })
    },
  })
  const drain = () => withCleanupDeadline(async () => { while (tasks.size) await Promise.allSettled([...tasks]) })
  try {
    const configs = []
    for (const id of Object.values(version.agentConfigurationVersionIds)) {
      const config = await input.workflows.getAgentConfiguration(id)
      if (!config) throw new DomainError('AGENT_CONFIGURATION_UNAVAILABLE', 'An immutable configuration is missing.', 409)
      configs.push(config)
    }
    ExecutableWorkflowV2Schema.parse({ version, configurations: configs })
    for (const configuration of configs) assertNativeWorkflowConfiguration(configuration.harness, run.approval,
      run.approval?.handler === 'orchestrator' && configuration.agentId === run.approval.designatedOrchestratorAgentId)
    preflightComplete = true
    signal.throwIfAborted()
    await store.updateRun({ executionState: 'running', outcome: 'pending', startedAt: run.startedAt ?? new Date().toISOString() })
    await store.resolveExcluded()
    const snapshot = await graph.getState(config)
    // Retain pending checkpoint tasks after I/O/process loss. Reconstructed
    // wrappers reread queue/results; no initial state is written over that thread.
    const value = input.resumeCommand ?? (snapshot.values.runId === run.id ? null : { runId: run.id, executionIds: {} })
    // Do not depend on a native iterator honoring AbortSignal. Cancellation is
    // independently observed and all wrapper tasks are drained below.
    await observeInvocation(graph.invoke(value, config), nodeSignal)
    await drain()
    signal.throwIfAborted()
    if (taskError) throw taskError
    if (await input.persistWait(await graph.getState(config))) return
    await store.completeRun()
    // Business result is immutable even if later native/reviewer cleanup fails.
    await runs.requestCleanup(run.id)
    await native.finishRun(run.id)
    await runs.finishCleanup(run.id, false)
  } catch (error) {
    owner.assertOwned()
    const current = await runs.get(run.id, owner)
    if (current?.executionState === 'completed') throw error
    const stop = await runs.hasRequestedStop(run.id)
    const terminalFailure = !preflightComplete || !!taskError || isFailure(error) || signal.aborted || stop
    if (!terminalFailure) {
      // Read/checkpoint/publication I/O errors leave committed queue/results in
      // place. Re-entry observes the same attempt; it never creates a new turn.
      await drain()
      if (isGraphInterrupt(error) && await input.persistWait(await graph.getState(config))) return
      throw error
    }
    failed.abort(error)
    const closing = cancelNative()
    let drained = false
    try { await drain(); drained = true } catch { /* unfinished cleanup stays visible */ }
    const clean = await closing
    owner.assertOwned()
    await store.settleRun(stop, signal.aborted && !stop)
    // A waiting/aborted node may never re-enter ensureObserve's finalizer.
    // Failure here deliberately leaves the durable cleanup intent pending.
    if (clean && drained && (await runs.get(run.id, owner))?.executionState === 'completed') {
      await native.cancelRun(run.id, owner)
    }
    await runs.finishCleanup(run.id, !clean || !drained)
    throw error
  }
}

async function observeInvocation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { if (abort) signal.removeEventListener('abort', abort) }
}
