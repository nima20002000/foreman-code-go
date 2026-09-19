/** Public lifecycle boundaries only: a resolved step must mean that its work is drained. */
export interface RuntimeShutdownStep {
  name: string
  run(): void | Promise<unknown>
}

export interface RuntimeShutdownOptions {
  /** Each stop must synchronously close admission and signal cancellation before its first await. */
  stop: RuntimeShutdownStep[]
  /** Producers which can still allocate managers (for example an in-flight recovery pass). */
  drain: RuntimeShutdownStep[]
  dispose: RuntimeShutdownStep[]
  releaseOwnership(): Promise<void>
}

function settle(steps: RuntimeShutdownStep[]): Promise<Error[]> {
  // Start every sibling even if another throws synchronously or never settles.
  const work = steps.map(async (step) => step.run())
  return Promise.allSettled(work).then((results) => results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [new Error(`Runtime shutdown step '${steps[index]!.name}' failed.`, { cause: result.reason })]
      : [],
  ))
}

/**
 * begin() is for preClose: signal work without waiting for HTTP requests to drain.
 * finish() is for onClose: drain producers, dispose managers, and unlock LAST.
 * A rejected cleanup is not evidence of closure. Retain the owner connection on
 * failure, including timeouts whose underlying work may still be running.
 */
export class RuntimeShutdown {
  private stopping: Promise<Error[]> | undefined
  private completion: Promise<void> | undefined

  constructor(private readonly options: RuntimeShutdownOptions) {}

  begin(): void {
    if (this.stopping) return
    // Publish the promise before invoking callbacks, including synchronous re-entry.
    let stopped!: (errors: Error[]) => void
    this.stopping = new Promise<Error[]>((resolve) => { stopped = resolve })
    void settle(this.options.stop).then(stopped)
  }

  finish(): Promise<void> {
    // Publish the shared result before any lifecycle callback can re-enter.
    this.completion ??= Promise.resolve().then(async () => {
      const errors = await this.stopping!
      errors.push(...await settle(this.options.drain))
      // Attempt every disposer even when a previous drain failed. Such a failure
      // still forbids unlocking; disposal must not disguise unfinished work.
      errors.push(...await settle(this.options.dispose))
      if (errors.length) {
        throw new AggregateError(errors, 'Production runtime shutdown was incomplete; runtime ownership was not released.')
      }
      await this.options.releaseOwnership()
    })
    this.begin()
    return this.completion
  }
}
