import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import { pendingSessionControls } from './sessionControlDefaults.js'
it('offers first-turn Plan without claiming native application or model capacity', () => {
  const controls = pendingSessionControls(DEFAULT_HARNESS_DEFAULTS.codex)
  expect(controls.plan.supported).toBe(true)
  expect(controls.plan.reason).toContain('first native message')
  expect(controls.modelCapacity).toBeNull()
  expect(controls.contextBudgets).toEqual([])
})
