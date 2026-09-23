/** Bounded codes, never raw server/native payloads, are safe to present in the inspector. */
export class GraphProtocolError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'GraphProtocolError'
  }
}
