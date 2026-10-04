import assert from 'node:assert/strict'
import { it } from 'vitest'
import { HarnessWorkflowCompatibilitySchema, OpenCodeHarnessConfigurationSchema } from '@foreman-code/contracts'
import { configuration, advanced } from './opencode-fixtures.js'

for (const handler of ['user', 'orchestrator'] as const) {
  it(`[F03] legacy autoApprove with omitted Advanced settings conflicts with ${handler} routing`, () => {
    assert.equal(HarnessWorkflowCompatibilitySchema.safeParse({
      configuration: { ...configuration(), autoApprove: true }, workflowApprovalHandler: handler,
    }).success, false)
  })
  it(`[F03] explicit native auto handling conflicts with ${handler} routing`, () => {
    assert.equal(HarnessWorkflowCompatibilitySchema.safeParse({
      configuration: { ...configuration(), autoApprove: true, advanced: { ...advanced(), permissionHandling: 'native_auto' } }, workflowApprovalHandler: handler,
    }).success, false)
  })
}
it('[F03] legacy non-auto settings remain compatible with routed approval', () => {
  assert.equal(HarnessWorkflowCompatibilitySchema.safeParse({ configuration: configuration(), workflowApprovalHandler: 'user' }).success, true)
})
it('[F03] native auto handling remains available without a routed workflow handler', () => {
  assert.equal(HarnessWorkflowCompatibilitySchema.safeParse({ configuration: { ...configuration(), autoApprove: true } }).success, true)
})
it('[F26] the contract distinguishes no named variant from an advertised named choice', () => {
  assert.equal(OpenCodeHarnessConfigurationSchema.safeParse({ ...configuration(), variant: '' }).success, true)
  assert.equal(OpenCodeHarnessConfigurationSchema.safeParse({ ...configuration(), variant: 'max' }).success, true)
  assert.equal(OpenCodeHarnessConfigurationSchema.safeParse({ ...configuration(), variant: undefined }).success, false)
})
