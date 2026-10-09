import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JobRuntimeApprovalRecord } from '@foreman-code/contracts/job-verification-runtime'
import { preparationProfile, dexter } from '../../../test/helpers/ciPreparationFixture.js'
import { qualificationDeadline, qualificationTimeoutMs } from './runtimeQualificationFacts.js'

afterEach(() => vi.useRealTimers())

describe('qualification deadlines', () => {
  it('reserves every integration run and interruption probe within the reviewed approval', () => {
    vi.useFakeTimers()
    const profile = preparationProfile('integration', 'Integration', dexter,
      '44444444-4444-4444-8444-444444444444', ['integration'])
    profile.spec.policy.executionTimeoutMs = 9_000_000
    const approval = { fingerprint: profile.measurement!.fingerprint,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() } as JobRuntimeApprovalRecord
    const policy = profile.spec.policy
    const perRun = policy.preparationTimeoutMs + policy.serviceStartupTimeoutMs + policy.executionTimeoutMs
      + policy.cancellationGraceMs + policy.publicationTimeoutMs + policy.cleanupTimeoutMs
    expect(qualificationTimeoutMs(profile, approval)).toBe(3 * perRun)
    expect(() => qualificationTimeoutMs(profile, { ...approval,
      expiresAt: new Date(Date.now() + 3 * perRun - 1).toISOString() })).toThrow('approval')
  })

  it('expires at the original deadline when the budget exceeds a Node timer interval', () => {
    vi.useFakeTimers()
    const interval = 2_147_423_647
    const deadline = qualificationDeadline(interval + 1000)
    vi.advanceTimersByTime(interval)
    expect(deadline.signal.aborted).toBe(false)
    vi.advanceTimersByTime(999)
    expect(deadline.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(deadline.signal.aborted).toBe(true)
    deadline.dispose()
  })

  it('releases its timer after a completed qualification', () => {
    vi.useFakeTimers()
    const deadline = qualificationDeadline(1000)
    deadline.dispose()
    vi.advanceTimersByTime(2000)
    expect(deadline.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
