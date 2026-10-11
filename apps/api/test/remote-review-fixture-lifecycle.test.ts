import { afterAll, describe, expect, it, vi } from 'vitest'
import { useRemoteReviewFixture } from './helpers/remoteReviewProductionCases.js'

const state = vi.hoisted(() => {
  const events: string[] = []
  const setupOptions: unknown[] = []
  const fixture = { close: async () => { events.push('cleanup') } }
  // beforeAll calls must remain observable after Vitest clears per-case mock history.
  const setup = async (options: unknown) => {
    setupOptions.push(options)
    events.push('setup')
    return fixture
  }
  return { events, setupOptions, fixture, setup }
})

vi.mock('./helpers/remoteReviewProduction.js', () => ({
  remoteReviewProduction: state.setup, waitForRemoteReview: vi.fn(),
}))

describe('shared remote review fixture lifecycle', () => {
  const withFixture = useRemoteReviewFixture({ workflow: 'single' })

  it('finishes setup before entering the first scenario', async () => {
    expect(state.events).toEqual(['setup'])
    expect(state.setupOptions).toEqual([expect.objectContaining({
      workflow: 'single', parallelSetup: true, parallelProfileChecks: true, reuseMatchingProfiles: true,
    })])
    await withFixture(async fixture => {
      expect(fixture).toBe(state.fixture)
      state.events.push('first scenario')
    })
    expect(state.events).toEqual(['setup', 'first scenario'])
  })

  it('reuses the qualified fixture in the next scenario', async () => {
    await withFixture(async fixture => {
      expect(fixture).toBe(state.fixture)
      state.events.push('second scenario')
    })
    expect(state.setupOptions).toHaveLength(1)
    expect(state.events).toEqual(['setup', 'first scenario', 'second scenario'])
  })
})

afterAll(() => {
  expect(state.events.filter(event => event === 'cleanup')).toHaveLength(1)
  expect(state.events).toEqual(['setup', 'first scenario', 'second scenario', 'cleanup'])
})
