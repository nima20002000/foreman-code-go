import { afterEach, describe, expect, it, vi } from 'vitest'
import { qualificationDeadline } from './runtimeQualificationFacts.js'

afterEach(() => vi.useRealTimers())

describe('qualification deadlines', () => {
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
