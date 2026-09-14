import type {
  ExecutionResult,
  RunExecutionState,
  RunOutcome,
  Timestamp,
  WorkflowRun,
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
}

/** ENG-04 maps a pinned run to LangGraph without coupling HTTP routes to graph internals. */
export interface WorkflowOrchestrator {
  start(runId: string): Promise<void>
  resume(runId: string): Promise<void>
}
