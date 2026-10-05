import { DomainError } from '../../src/modules/errors.js'
import { HarnessExecutionError } from '../../src/modules/harnesses/errors.js'
import { nativePersistenceRedactor } from '../../src/modules/interactions/nativePersistence.js'

export interface NativeFailureDetail {
  name: string
  code?: string
  message: string
  causes?: NativeFailureDetail[]
}

export function describeNativeFailure(error: unknown, secrets: readonly string[], depth = 0): NativeFailureDetail {
  const redactor = nativePersistenceRedactor(secrets)
  const detail: NativeFailureDetail = {
    name: error instanceof Error ? redactor.text(error.name).slice(0, 256) : typeof error,
    message: 'Native operation failed without an Error object.',
  }
  if (error instanceof Error) detail.message = redactor.text(error.message).slice(0, 2048)
  if (error instanceof DomainError) detail.code = redactor.text(error.code)
  else if (error instanceof HarnessExecutionError && error.result.error) {
    detail.code = redactor.text(error.result.error.code)
  } else if (error instanceof Error && 'code' in error
    && (typeof error.code === 'string' || typeof error.code === 'number')) {
    detail.code = redactor.text(String(error.code))
  }
  if (depth >= 3) return detail
  const causes: unknown[] = []
  if (error instanceof AggregateError) causes.push(...error.errors.slice(0, 8))
  if (error instanceof Error && error.cause !== undefined && !causes.includes(error.cause)) {
    causes.push(error.cause)
  }
  if (causes.length) detail.causes = causes.slice(0, 8)
    .map(cause => describeNativeFailure(cause, secrets, depth + 1))
  return detail
}
