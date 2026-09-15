import type { ExecutionResult } from '@graphql/contracts'

export class HarnessExecutionError extends Error {
  readonly result: ExecutionResult

  constructor(code: string, message: string, retryable = false) {
    super(message)
    this.name = 'HarnessExecutionError'
    this.result = { outcome: 'failed', error: { code, message, retryable } }
  }
}
