import { beginRuntimeTiming } from '../../infrastructure/runtimeTiming.js'
import { DomainError } from '../errors.js'

interface Waiter {
  runId: string
  signal: AbortSignal
  enter(): void
  abort(): void
}

/** Process-local worker capacity, NOT a runtime owner or a persistent job queue.
 * One round-robin turn per Run prevents a wide graph starving a later Run.
 * Review/approval work never uses this worker-only gate. Database rows are queued
 * before waiting here; cancellation removes a waiter without claiming a launch.
 */
export class RunnerAdmission {
  private active = 0
  private queued = 0
  private readonly waiting = new Map<string, Waiter[]>()
  private readonly order: string[] = []
  constructor(readonly maximum = 4, readonly maximumWaiting = 1000, readonly maximumRuns = 32) {
    for (const value of [maximum, maximumWaiting, maximumRuns]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('INVALID_RUNNER_ADMISSION_LIMIT')
    }
  }

  async run<T>(runId: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const acquired = beginRuntimeTiming('engine', 'worker.admission', { runId, count: this.queued })
    try {
      if (this.active < this.maximum && !this.queued) this.active++
      else {
        if (this.queued >= this.maximumWaiting || (!this.waiting.has(runId) && this.waiting.size >= this.maximumRuns)) {
          throw new DomainError('RUNNER_ADMISSION_FULL', 'Worker capacity is full. This queued execution was not launched.', 503)
        }
        await new Promise<void>((resolve, reject) => {
          const waiter: Waiter = {
            runId, signal,
            enter: () => { signal.removeEventListener('abort', waiter.abort); resolve() },
            abort: () => {
              const queue = this.waiting.get(runId)
              const index = queue?.indexOf(waiter) ?? -1
              if (index < 0) return
              queue!.splice(index, 1)
              this.queued--
              if (!queue!.length) this.removeRun(runId)
              reject(signal.reason)
            },
          }
          const queue = this.waiting.get(runId)
          if (queue) queue.push(waiter)
          else { this.waiting.set(runId, [waiter]); this.order.push(runId) }
          this.queued++
          signal.addEventListener('abort', waiter.abort, { once: true })
          if (signal.aborted) waiter.abort()
        })
      }
    } finally { acquired() }
    try { signal.throwIfAborted(); return await work() }
    finally {
      const run = this.order.shift()
      if (run === undefined) this.active--
      else {
        const queue = this.waiting.get(run)!
        const next = queue.shift()!
        this.queued--
        if (queue.length) this.order.push(run)
        else this.waiting.delete(run)
        // Transfer the already counted slot, including abort after wakeup.
        next.enter()
      }
    }
  }

  private removeRun(runId: string): void {
    this.waiting.delete(runId)
    const index = this.order.indexOf(runId)
    if (index >= 0) this.order.splice(index, 1)
  }
  get pending(): number { return this.queued }
  get inFlight(): number { return this.active }
}
