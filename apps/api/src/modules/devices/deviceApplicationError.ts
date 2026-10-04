import type { DeviceApplicationFailure } from '@graphql/contracts/device-application'

const retryability: Readonly<Record<string, boolean>> = {
  'extension-rejected': false,
  unavailable: true,
  backpressure: true,
  timeout: true,
  transport: true,
  cancelled: false,
  'payload-too-large': false,
  authentication: false,
  permission: false,
  unauthorized: false,
  revoked: false,
  expired: false,
  conflict: false,
  forbidden: false,
  wrong_main: false,
  'job-output-expired': false,
  'job-publication-pending': true,
  'source-repository-timeout': true,
  'source-repository-uncertain': false,
  AUTH_REVOKED: false,
  REMOTE_AUTHORITY_DENIED: false,
  REMOTE_REVIEWER_DENIED: false,
  REVIEWER_BINDING_REBIND_REQUIRED: true,
  REMOTE_CONTROL_UNAVAILABLE: false,
  REMOTE_DISPATCH_UNAVAILABLE: true,
  REMOTE_BINDING_CONFLICT: false,
  REMOTE_OBSERVATION_NOT_AUTHENTICATED: false,
  REMOTE_NATIVE_PHYSICAL_UNAVAILABLE: false,
  REMOTE_NATIVE_PHYSICAL_BACKPRESSURE: true,
  REMOTE_NATIVE_SOURCE_NOT_CAPTURED: false,
  REMOTE_NATIVE_SOURCE_BACKPRESSURE: true,
  REMOTE_ARTIFACT_PHYSICAL_UNAVAILABLE: false,
  NATIVE_ARTIFACT_AUTHORITY_DENIED: false,
  WORKER_WORKFLOW_UNAVAILABLE: false,
  WORKER_EXECUTION_NOT_FOUND: false,
  WORKER_EXECUTION_IDENTITY_INVALID: false,
  PLACEMENT_INVALID_ROOT: false,
  PLACEMENT_BINDING_CONFLICT: false,
  PLACEMENT_ADMISSION_CONFLICT: false,
  PLACEMENT_PREPARATION_REQUIRED: false,
  PLACEMENT_MAIN_MISMATCH: false,
  PLACEMENT_CONFLICT: false,
  EXECUTION_PLACEMENT_CONFLICT: false,
  SOURCE_OPERATION_AUTHORITY_CONFLICT: false,
  SOURCE_CONNECTION_CONFLICT: false,
  SOURCE_ATTEMPT_CONFLICT: false,
  SOURCE_CAPACITY: false,
  SOURCE_DISK_CAPACITY: false,
  SOURCE_REPOSITORY_TIMEOUT: true,
  SOURCE_REPOSITORY_UNCERTAIN: false,
}

export function deviceApplicationFailure(error: unknown): DeviceApplicationFailure {
  const proposed = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  const code = typeof proposed === 'string' && Object.hasOwn(retryability, proposed) ? proposed : 'extension-rejected'
  return { code, retryable: retryability[code]! }
}

export class DeviceApplicationError extends Error {
  readonly retryable: boolean
  constructor(readonly code: string) {
    super(code)
    this.retryable = deviceApplicationFailure({ code }).retryable
  }
}
