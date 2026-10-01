import { RemoteJobExecutionRpcRequestSchema } from '@graphql/contracts/remote-job-execution'
import type { RemoteExecutionHost } from './executionHost.js'
import type { RemoteJobExecutionHost } from './jobExecutionHost.js'
/** Both executors run on the same authenticated execution-v1 carrier and operation journal. */
export function createRemoteExecutionHandler(workflows: RemoteExecutionHost, jobs: RemoteJobExecutionHost) {
  return (raw: unknown) => RemoteJobExecutionRpcRequestSchema.safeParse(raw).success ? jobs.handle(raw) : workflows.handle(raw)
}
