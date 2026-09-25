import type {
  ExecutionResult,
  RunExecutionState,
  RunOutcome,
  Timestamp,
  HarnessExecution,
} from '@graphql/contracts'
import type { AcceptedWorkflowRunV3 } from '@graphql/contracts/wave25'
import type { RepeatRepositoryServices } from './repeatRepositoryHost.js'

/** Current execution pins only. A3 implements storage; no missing-pin default. */
export type RepositoryExecutionSemantics = 3
export type RepositoryWorkflowRun = AcceptedWorkflowRunV3

/** Internal composition, not an activation flag. The central repository always
 * supplies the real canonical publisher. Native/lifecycle owners supply these
 * real same-transaction proof services; absence leaves v3 writes unavailable. */
export interface RepeatRepositoryActivation {
  runtimeRoot: string
  services: Omit<RepeatRepositoryServices, 'openPublicationLocked'>
}

export interface RunStateUpdate {
  executionState: RunExecutionState
  outcome: RunOutcome
  result?: ExecutionResult
  startedAt?: Timestamp
  finishedAt?: Timestamp
}

/** Run writes must retain their immutable workflow and agent-configuration pins. */
export interface RunRepository {
  get(runId: string): Promise<RepositoryWorkflowRun | undefined>
  create(run: RepositoryWorkflowRun): Promise<void>
  updateState(runId: string, update: RunStateUpdate): Promise<void>
  /** Stable occurrence identity used by interrupt/resume node re-entry. */
  ensureExecution?(execution: HarnessExecution): Promise<{ execution: HarnessExecution; created: boolean }>
}

/** ENG-04 maps a pinned run to LangGraph without coupling HTTP routes to graph internals. */
export interface WorkflowOrchestrator {
  start(runId: string): Promise<void>
  resume(runId: string): Promise<void>
  cancel(runId: string): Promise<boolean>
  shutdown(): Promise<void>
}
