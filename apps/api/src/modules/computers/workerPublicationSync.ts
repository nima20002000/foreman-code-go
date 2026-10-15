export function startWorkerPublicationSync(
  _location: { directory: string; version: string },
  sync: () => Promise<void>,
  reportError: (error: unknown) => void,
): () => void {
  const timer = setInterval(() => { void sync().catch(reportError) }, 60_000)
  timer.unref()
  return () => clearInterval(timer)
}
