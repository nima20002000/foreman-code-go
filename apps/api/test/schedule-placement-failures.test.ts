import { describe, expect, it } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { scheduleRejectionReason } from '../src/modules/schedules/postgresDispatcher.js'

describe('schedule placement failures', () => {
  it.each([
    'PLACEMENT_ADMISSION_CONFLICT', 'ROOT_POLICY_CONFLICT', 'ROOT_POLICY_UNAVAILABLE',
    'ROOT_CONFIGURATION_CONFLICT', 'ROOT_CONFIGURATION_MISSING', 'HARNESS_INSTANCE_INVALID',
    'HARNESS_INSTANCE_CHANGED', 'HARNESS_INSTALLATION_INVALID', 'HARNESS_INSTALLATION_CHANGED',
  ])('records deterministic %s as a configuration rejection', (code) => {
    expect(scheduleRejectionReason(new DomainError(code, 'Private diagnostic.', 409))).toBe('workflow_not_executable')
  })
  it.each([
    'HARNESS_INVENTORY_UNAVAILABLE', 'HARNESS_INVENTORY_STALE', 'HARNESS_INSTANCE_UNAVAILABLE',
    'WORKER_CONNECTION_UNAVAILABLE', 'HARNESS_PROFILE_UNAVAILABLE', 'UNKNOWN_CONFLICT',
  ])('leaves %s retryable', (code) => {
    expect(scheduleRejectionReason(new DomainError(code, 'Private diagnostic.', 409))).toBeUndefined()
  })
  it('does not classify unknown infrastructure failures as configuration rejection', () => {
    expect(scheduleRejectionReason(new Error('Private database diagnostic.'))).toBeUndefined()
  })
})
