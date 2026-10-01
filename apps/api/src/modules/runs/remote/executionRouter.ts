import { DomainError } from '../../errors.js'
import { RemoteJobExecutionRpcRequestSchema } from '@graphql/contracts/remote-job-execution'
import type { RemoteExecutionHost } from './executionHost.js'
import type { RemoteJobExecutionHost } from './jobExecutionHost.js'
/** Both executors run on the same authenticated execution-v1 carrier and operation journal. */
export function createRemoteExecutionHandler(workflows: RemoteExecutionHost, jobs?: RemoteJobExecutionHost) {
  return (raw: unknown) => {
    if (RemoteJobExecutionRpcRequestSchema.safeParse(raw).success) {
      if (!jobs) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'This actual workflow host has no installed Job runtime.', 409)
      return jobs.handle(raw)
    }
    return workflows.handle(raw)
  }
}
