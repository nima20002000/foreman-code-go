import type {
  ExecutionResult,
  RunExecutionState,
  RunOutcome,
  Timestamp,
  WorkflowRun,
  HarnessExecution,
} from '@graphql/contracts'

export interface RunStateUpdate {
  executionState: RunExecutionState
  outcome: RunOutcome
  result?: ExecutionResult
  startedAt?: Timestamp
  finishedAt?: Timestamp
}

/** Run writes must retain their immutable workflow and agent-configuration pins. */
export interface RunRepository {
  get(runId: string): Promise<WorkflowRun | undefined>
  create(run: WorkflowRun): Promise<void>
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
