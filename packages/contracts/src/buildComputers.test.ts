import { expect, it } from 'vitest'
import { BuildComputerPreferenceSchema, BuildComputerUpdateSchema } from './buildComputers.js'
import { deviceProvisioningTargetFixture } from './deviceProvisioningFixtures.js'

it('validates participation revisions and bounded priority without changing device authority', () => {
  const preference = { target: deviceProvisioningTargetFixture, revision: 0, buildEnabled: false, buildPriority: 50,
    buildRole: 'backup' as const, buildAllowancePercent: 40 }
  expect(BuildComputerPreferenceSchema.parse(preference)).toEqual(preference)
  // Preferences saved before roles and allowances existed read as a primary computer with its whole allowance.
  const saved: Partial<typeof preference> = { ...preference }
  delete saved.buildRole
  delete saved.buildAllowancePercent
  expect(BuildComputerPreferenceSchema.parse(saved)).toEqual({ ...saved, buildRole: 'primary', buildAllowancePercent: 100 })
  const input = { ...preference, commandId: 'build-command', expectedRevision: 0 }
  delete (input as Partial<typeof input>).revision
  expect(BuildComputerUpdateSchema.safeParse(input).success).toBe(true)
  for (const buildPriority of [-1, 101, 1.5]) {
    expect(BuildComputerUpdateSchema.safeParse({ ...input, buildPriority }).success).toBe(false)
  }
  expect(BuildComputerUpdateSchema.safeParse({ ...input, expectedRevision: -1 }).success).toBe(false)
})
