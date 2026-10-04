import type { JobExecution, JobLogPage } from '@graphql/contracts/jobs'
import { ApiError } from '../../shared/api/client'

export const jobAccessLost = (error: unknown) => ApiError.is(error) && [401, 403, 404].includes(error.status)
/** A response for another job/Run is a contradiction, not a transient fault: never retry it. */
export const jobReadRetry = (count: number, error: unknown) => !jobAccessLost(error) && !(ApiError.is(error) && error.code === 'JOB_SELECTION_MISMATCH') && count < 1
export function jobError(error: unknown) {
  if (jobAccessLost(error)) return 'Job history unavailable or permission lost. Previously loaded data is hidden.'
  return error instanceof Error ? error.message : 'The job request could not be completed.'
}
/** Strip CSI, OSC, escape and nonprinting controls. React renders the remaining output as text. */
export function plainLog(text: string) {
  // Control matching is intentional: remove terminal commands before display.
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}
export function loadedChunks(pages: JobLogPage[] = []) {
  const chunks = new Map<string, JobLogPage['chunks'][number]>()
  for (const page of pages) for (const chunk of page.chunks) chunks.set(`${chunk.attemptId}:${chunk.sequence}`, chunk)
  return [...chunks.values()].sort((a, b) => a.sequence - b.sequence)
}
export function processLabel(execution: JobExecution) {
  const { process } = execution
  if (process.outcome === 'cancelled' && process.processStopped) return 'Cancellation confirmed'
  if (execution.cancelRequestedAt && !process.processStopped) return 'Cancellation requested · stop unconfirmed'
  return (process.outcome ?? process.phase).replaceAll('_', ' ')
}

export function jobWriteUncertain(error: unknown) {
  return Boolean(error) && !(ApiError.is(error) && error.status >= 400 && error.status < 500)
}
