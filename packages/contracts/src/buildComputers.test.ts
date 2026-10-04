import { expect, it } from 'vitest'
import { BuildComputerPreferenceSchema, BuildComputerUpdateSchema } from './buildComputers.js'
import { deviceProvisioningTargetFixture } from './deviceProvisioningFixtures.js'

it('validates participation revisions and bounded priority without changing device authority', () => {
  const preference = { target: deviceProvisioningTargetFixture, revision: 0, buildEnabled: false, buildPriority: 50 }
  expect(BuildComputerPreferenceSchema.parse(preference)).toEqual(preference)
  const input = { ...preference, commandId: 'build-command', expectedRevision: 0 }
  delete (input as Partial<typeof input>).revision
  expect(BuildComputerUpdateSchema.safeParse(input).success).toBe(true)
  for (const buildPriority of [-1, 101, 1.5]) {
    expect(BuildComputerUpdateSchema.safeParse({ ...input, buildPriority }).success).toBe(false)
  }
  expect(BuildComputerUpdateSchema.safeParse({ ...input, expectedRevision: -1 }).success).toBe(false)
})
