import { afterAll, describe, expect, it, vi } from 'vitest'
import { useRemoteReviewFixture } from './helpers/remoteReviewProductionCases.js'

const state = vi.hoisted(() => {
  const events: string[] = []
  const fixture = { close: vi.fn(async () => { events.push('cleanup') }) }
  const setup = vi.fn(async () => {
    events.push('setup')
    return fixture
  })
  return { events, fixture, setup }
})

vi.mock('./helpers/remoteReviewProduction.js', () => ({
  remoteReviewProduction: state.setup, waitForRemoteReview: vi.fn(),
}))

describe('shared remote review fixture lifecycle', () => {
  const withFixture = useRemoteReviewFixture({ workflow: 'single' })

  it('finishes setup before entering the first scenario', async () => {
    expect(state.events).toEqual(['setup'])
    expect(state.setup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      workflow: 'single', parallelSetup: true, parallelProfileChecks: true, reuseMatchingProfiles: true,
    }))
    await withFixture(async fixture => {
      expect(fixture).toBe(state.fixture)
      state.events.push('first scenario')
    })
    expect(state.fixture.close).not.toHaveBeenCalled()
  })

  it('reuses the qualified fixture in the next scenario', async () => {
    await withFixture(async fixture => {
      expect(fixture).toBe(state.fixture)
      state.events.push('second scenario')
    })
    expect(state.setup).toHaveBeenCalledTimes(1)
    expect(state.fixture.close).not.toHaveBeenCalled()
  })
})

afterAll(() => {
  expect(state.fixture.close).toHaveBeenCalledTimes(1)
  expect(state.events).toEqual(['setup', 'first scenario', 'second scenario', 'cleanup'])
})
