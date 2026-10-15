/** Time spent with at least one operation in progress, excluding idle gaps. */
export function operationDuration() {
  let elapsedMs = 0
  return {
    get elapsedMs() { return elapsedMs },
    async measure<T>(operation: () => Promise<T>): Promise<T> {
      const started = performance.now()
      try {
        return await operation()
      } finally {
        elapsedMs += performance.now() - started
      }
    },
  }
}
