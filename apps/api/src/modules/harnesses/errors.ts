import type { ExecutionResult } from '@graphql/contracts'

export class HarnessExecutionError extends Error {
  readonly result: ExecutionResult

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'HarnessExecutionError'
    this.result = { outcome: 'failed', error: { code, message, retryable } }
  }
}

/** Definite provider refusal: the addressed turn is not the active turn. No input was accepted. */
export class NativeTurnNotActiveError extends HarnessExecutionError {
  constructor(message = 'The addressed native turn is no longer active.') {
    super('NATIVE_TURN_NOT_ACTIVE', message)
    this.name = 'NativeTurnNotActiveError'
  }
}
