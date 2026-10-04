import type { JobExecution } from '@foreman-code/contracts'
import { executeJob, type JobExecutorPorts, type JobExecutorResult } from './executor.js'

/** W07 carrier routes job payloads here; W08 remains the launch/owner authority. */
export function createJobWorkerHandler(ports: JobExecutorPorts, settle: (execution: JobExecution, result: JobExecutorResult) => Promise<void>) {
  return async (execution: JobExecution, cancellation: AbortSignal): Promise<JobExecutorResult> => {
    const result = await executeJob(execution, ports, cancellation)
    // The injected B sink checks attempt+owner and stores result independently of publication.
    await settle(execution, result)
    return result
  }
}
