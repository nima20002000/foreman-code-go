import type { WorkflowSchedule } from '@foreman-code/contracts/schedules'

export interface ScheduleDispatcherPort {
  listDueSchedules(input: { throughUtc: string; limit: number; cursor?: string }): Promise<{
    items: WorkflowSchedule[]; pageInfo: { nextCursor: string | null }
  }>
  dispatch(schedule: WorkflowSchedule): Promise<void>
}
export interface ScheduleDispatcherOptions {
  clock?: () => Date
  isReady?: () => boolean
  reportError: (error: unknown) => void
  pollIntervalMs?: number
}

/** API-owned loop, never a browser timer. A process coalesces ticks; correctness
 * across processes belongs to the transaction/unique occurrence in the port.
 * No timer accumulates work while a previous tick or shutdown is pending. */
export class WorkflowScheduleDispatcher {
  private readonly clock: () => Date
  private readonly interval: number
  private active: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private closed = false
  private sweep: { throughUtc: string; cursor?: string } | undefined

  constructor(private readonly port: ScheduleDispatcherPort, private readonly options: ScheduleDispatcherOptions) {
    this.clock = options.clock ?? (() => new Date())
    this.interval = options.pollIntervalMs ?? 1_000
    if (!Number.isInteger(this.interval) || this.interval < 1 || this.interval > 2_147_483_647) {
      throw new RangeError('pollIntervalMs must be a positive 32-bit integer.')
    }
  }

  tick(): Promise<void> {
    if (this.closed || this.options.isReady?.() === false) return Promise.resolve()
    if (this.active) return this.active
    this.active = this.scan().finally(() => { this.active = undefined })
    return this.active
  }

  private async scan(): Promise<void> {
    // Keep the fixed-boundary keyset across bounded passes. A persistently
    // failing first page must not starve later workflows. Wrap at sweep end.
    const sweep = this.sweep ??= { throughUtc: this.clock().toISOString() }
    const { throughUtc } = sweep
    const seen = new Set<string>()
    for (let page = 0; page < 5 && !this.closed; page++) {
      const cursor = sweep.cursor
      const batch = await this.port.listDueSchedules({ throughUtc, limit: 100, ...(cursor ? { cursor } : {}) })
      for (const schedule of batch.items) {
        if (this.closed || this.options.isReady?.() === false) return
        if (seen.has(schedule.workflowId)) continue
        seen.add(schedule.workflowId)
        try { await this.port.dispatch(schedule) } catch (error) { this.options.reportError(error) }
      }
      if (!batch.pageInfo.nextCursor || batch.pageInfo.nextCursor === cursor) { this.sweep = undefined; return }
      sweep.cursor = batch.pageInfo.nextCursor
    }
  }

  start(): void {
    if (this.running || this.closed) return
    this.running = true
    const poll = async () => {
      try { await this.tick() } catch (error) { this.options.reportError(error) }
      if (!this.closed) {
        this.timer = setTimeout(() => { void poll() }, this.interval)
        this.timer.unref()
      }
    }
    void poll()
  }

  async stop(): Promise<void> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    await this.active
  }
}
