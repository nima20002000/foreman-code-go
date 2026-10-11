export class DomainError extends Error {
  // Transport handlers reuse a denial already recorded by the domain service.
  denialAudited = false

  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}
