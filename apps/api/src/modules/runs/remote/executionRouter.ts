import { DomainError } from '../../errors.js'
import { RemoteJobExecutionRpcRequestRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import type { RemoteJobExecutionHost } from './jobExecutionHost.js'
/** Both executors run on the same authenticated execution-v1 carrier and operation journal. */
export function createRemoteExecutionHandler(workflows: { handle(raw: unknown): Promise<unknown> }, jobs?: RemoteJobExecutionHost) {
  return (raw: unknown) => {
    if (RemoteJobExecutionRpcRequestRecordSchema.safeParse(raw).success) {
      if (!jobs) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'This actual workflow host has no installed Job runtime.', 409)
      return jobs.handle(raw)
    }
    return workflows.handle(raw)
  }
}
