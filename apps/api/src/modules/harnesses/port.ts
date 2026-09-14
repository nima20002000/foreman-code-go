import type {
  AgentHarness,
  ExecutionResult,
  HarnessExecutionRequest,
} from '@graphql/contracts'

export interface HarnessSession {
  nativeSessionId: string
}

/** ENG-03 owns native process/session details; orchestration depends only on this port. */
export interface HarnessAdapter {
  readonly harness: AgentHarness
  start(request: HarnessExecutionRequest): Promise<HarnessSession>
  cancel(nativeSessionId: string): Promise<void>
  result(nativeSessionId: string): Promise<ExecutionResult | undefined>
}
