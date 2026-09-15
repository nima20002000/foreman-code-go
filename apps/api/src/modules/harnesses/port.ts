import type {
  AgentHarness,
  ExecutionResult,
  HarnessExecutionRequest,
  HarnessQualification,
} from '@graphql/contracts'

export interface NativeEventInput {
  type: string
  payload: Record<string, unknown>
}

export interface HarnessExecutionCallbacks {
  signal: AbortSignal
  onSession(nativeSessionId: string): Promise<void>
  onEvent(event: NativeEventInput): Promise<void>
}

/** Product Agent execution boundary; native Agent/session concepts stay inside adapters. */
export interface HarnessAdapter {
  readonly harness: AgentHarness
  qualify(request: HarnessExecutionRequest, signal?: AbortSignal): Promise<HarnessQualification>
  execute(request: HarnessExecutionRequest, callbacks: HarnessExecutionCallbacks): Promise<ExecutionResult>
  resume(
    request: HarnessExecutionRequest,
    nativeSessionId: string,
    callbacks: HarnessExecutionCallbacks,
  ): Promise<ExecutionResult>
  cancel(executionId: string): Promise<boolean>
}

export interface HarnessResolver {
  resolve(harness: AgentHarness): HarnessAdapter
}
