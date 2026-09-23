export interface LoopClock {
  schedule(work: () => void, delay: number): unknown
  cancel(handle: unknown): void
}
const clock: LoopClock = {
  schedule: (work, delay) => setTimeout(work, delay),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** One in-flight task, one timer. A disposed generation can never schedule another task. */
export function createSerialLoop(
  work: (signal: AbortSignal) => Promise<number | false>,
  onUnexpectedError: (error: unknown) => void,
  timer: LoopClock = clock,
) {
  const controller = new AbortController()
  let handle: unknown
  let running = false
  let stopped = false
  const schedule = (delay: number) => {
    handle = timer.schedule(() => {
      handle = undefined
      if (stopped || running) return
      running = true
      void work(controller.signal).then((next) => {
        running = false
        if (!stopped && next !== false) schedule(Math.max(0, next))
      }, (error: unknown) => {
        running = false
        if (!stopped) { stopped = true; onUnexpectedError(error) }
      })
    }, delay)
  }
  schedule(0)
  return {
    signal: controller.signal,
    wake() {
      if (stopped || running) return
      if (handle !== undefined) timer.cancel(handle)
      schedule(0)
    },
    dispose() {
      if (stopped && controller.signal.aborted) return
      stopped = true
      controller.abort()
      if (handle !== undefined) timer.cancel(handle)
      handle = undefined
    },
  }
}
