import type { HarnessExecution } from '@foreman-code/contracts'
import { readUntil } from './observableCondition.js'

type StartupExecution = Pick<HarnessExecution, 'id' | 'workflowNodeId' | 'state' | 'result'>

type Startup = {
  entryNodeId: string
  readExecutions(): Promise<StartupExecution[]>
  readCalls(): Promise<Array<Record<string, unknown>>>
  reconcile(): Promise<void>
  subscribe?: (changed: () => void) => () => void
}

export async function waitForRequesterSession(startup: Startup) {
  return readUntil(async () => {
    const calls = await startup.readCalls()
    const executions = await startup.readExecutions()
    const failed = executions.find(execution => execution.result?.outcome === 'failed')
    if (failed) {
      throw new Error(`Run execution failed before requester session acknowledgment: ${JSON.stringify({
        executionId: failed.id, state: failed.state, errorCode: failed.result?.error?.code,
      })}`)
    }
    return calls
  }, calls => calls.some(call => 'requesterSessionBlocked' in call), {
    timeoutMs: 90_000,
    minimumReadIntervalMs: 1_000,
    description: 'requester thread creation before session acknowledgment',
    ...(startup.subscribe ? { subscribe: startup.subscribe } : {}),
  })
}
