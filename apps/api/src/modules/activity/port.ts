import type { RunActivity } from '@foreman-code/contracts'

/** Native harness events are normalized here before ENG-05 exposes live activity. */
export interface ActivityRepository {
  append(activity: RunActivity): Promise<void>
  list(runId: string, afterSequence?: number, limit?: number): Promise<RunActivity[]>
}

export interface ActivitySubscription {
  subscribe(runId: string, afterSequence?: number): AsyncIterable<RunActivity>
}
