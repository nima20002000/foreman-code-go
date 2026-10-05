import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { JobOutputCollectionError } from './executorOutputs.js'

export function jobLifecycleSignal(execution: JobExecutionRecord, phase: 'publication' | 'cleanup'): AbortSignal {
  if (execution.schemaVersion === 1) return AbortSignal.timeout(15 * 60 * 1000)
  const deadline = phase === 'publication' ? execution.acceptedSpec.lifecycle.publicationDeadlineAt
    : execution.acceptedSpec.lifecycle.cleanupDeadlineAt
  const remaining = Date.parse(deadline) - Date.now()
  if (remaining <= 0) return AbortSignal.abort(new JobOutputCollectionError(`Job ${phase} deadline expired.`))
  return AbortSignal.timeout(remaining)
}
