import type { CiRunRecord } from '@foreman-code/contracts'

/** Tickets keep their ID when setup is retried; executors need a fresh ID for idempotent starts. */
export function ciExecutionRunId(run: CiRunRecord): string {
  return run.setupRetry?.runId ?? run.id
}
