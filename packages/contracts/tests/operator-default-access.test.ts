import { expect, it } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, operatorHarnessDefaults } from '../src/index.js'

it('defaults only the Operator to full access and preserves approval routing', () => {
  expect(DEFAULT_AGENT_DEFAULTS.operator.harness).toMatchObject({ sandbox: 'danger-full-access', advanced: { approvalPolicy: 'on-request' } })
  expect(DEFAULT_AGENT_DEFAULTS.coder.harness).toMatchObject({ sandbox: 'read-only' })
  expect(DEFAULT_AGENT_DEFAULTS.orchestrator.harness).toMatchObject({ sandbox: 'read-only' })
  expect(DEFAULT_HARNESS_DEFAULTS.codex.sandbox).toBe('read-only')
  expect(operatorHarnessDefaults(DEFAULT_HARNESS_DEFAULTS.codex)).toMatchObject({ sandbox: 'danger-full-access', advanced: { approvalPolicy: 'on-request' } })
  expect(operatorHarnessDefaults(DEFAULT_HARNESS_DEFAULTS.opencode)).toEqual(DEFAULT_HARNESS_DEFAULTS.opencode)
})
