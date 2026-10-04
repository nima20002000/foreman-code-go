import assert from 'node:assert/strict'

import {
  DEFAULT_CODEX_ADVANCED_CONFIGURATION, DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
  type HarnessConfiguration, type WorkflowApprovalConfiguration,
} from '@foreman-code/contracts'
import { ManagementHarnessConfigurationSchema } from '@foreman-code/contracts/management'
import { it } from 'vitest'

import { assertNativeWorkflowConfiguration } from '../src/modules/harnesses/nativeWorkflowConfiguration.js'

function codex(): Extract<HarnessConfiguration, { harness: 'codex' }> {
  return { harness: 'codex', model: 'fixture', reasoningEffort: 'medium', serviceTier: 'standard', sandbox: 'workspace-write',
    advanced: structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION) }
}
function opencode(): Extract<HarnessConfiguration, { harness: 'opencode' }> {
  return { harness: 'opencode', model: 'fixture/model', variant: 'max', nativeAgent: 'build', thinking: false,
    autoApprove: false, advanced: structuredClone(DEFAULT_OPENCODE_ADVANCED_CONFIGURATION) }
}
function code(expected: string) {
  return (error: unknown) => { assert.equal((error as { code?: string }).code, expected); return true }
}

for (const handler of ['user', 'orchestrator'] as const) {
  const approval: WorkflowApprovalConfiguration = { handler,
    ...(handler === 'orchestrator' ? { designatedOrchestratorAgentId: 'reviewer' } : {}) }
  it(`keeps ${handler} routing per Agent while checking explicit Codex self-review`, () => {
    const c = codex(), o = opencode()
    assert.doesNotThrow(() => assertNativeWorkflowConfiguration(c, approval))
    assert.doesNotThrow(() => assertNativeWorkflowConfiguration(o, approval))
    c.advanced!.approvalsReviewer = 'auto_review'
    o.autoApprove = true; o.advanced!.permissionHandling = 'native_auto'
    if (handler === 'orchestrator') assert.doesNotThrow(() => assertNativeWorkflowConfiguration(c, approval))
    else assert.throws(() => assertNativeWorkflowConfiguration(c, approval), code('WORKFLOW_HARNESS_APPROVAL_CONFLICT'))
    assert.throws(() => assertNativeWorkflowConfiguration(o, approval), code('WORKFLOW_HARNESS_APPROVAL_CONFLICT'))
  })
}

it('allows native Codex review only for the designated Orchestrator node', () => {
  const reviewer = codex()
  reviewer.advanced!.approvalsReviewer = 'auto_review'
  const approval = { handler: 'orchestrator' as const, designatedOrchestratorAgentId: 'reviewer' }
  assert.doesNotThrow(() => assertNativeWorkflowConfiguration(reviewer, approval, true))
  assert.doesNotThrow(() => assertNativeWorkflowConfiguration(reviewer, approval))
  reviewer.advanced!.approvalPolicy = 'never'
  assert.throws(() => assertNativeWorkflowConfiguration(reviewer, approval, true), code('WORKFLOW_HARNESS_APPROVAL_CONFLICT'))
})

it('allows explicit Codex never and auto-review with no routed reviewer, independent of sandbox', () => {
  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
    const never = codex(), review = codex()
    never.sandbox = sandbox; never.advanced!.approvalPolicy = 'never'
    review.sandbox = sandbox; review.advanced!.approvalsReviewer = 'auto_review'
    assert.doesNotThrow(() => assertNativeWorkflowConfiguration(never))
    assert.doesNotThrow(() => assertNativeWorkflowConfiguration(review))
  }
})

it('accepts native auto in management while preserving ordered deny rules and saved data', () => {
  const o = opencode()
  o.autoApprove = true; o.advanced!.permissionHandling = 'native_auto'
  o.advanced!.permissionRules = [{ permission: 'bash', pattern: '*', effect: 'deny' }]
  const before = structuredClone(o)
  assert.equal(ManagementHarnessConfigurationSchema.safeParse(o).success, true)
  assert.doesNotThrow(() => assertNativeWorkflowConfiguration(o))
  assert.deepEqual(o, before)
})

it('rejects inconsistent OpenCode auto representations instead of silently repairing them', () => {
  const o = opencode()
  o.autoApprove = true
  assert.equal(ManagementHarnessConfigurationSchema.safeParse(o).success, false)
  assert.throws(() => assertNativeWorkflowConfiguration(o), code('WORKFLOW_HARNESS_APPROVAL_CONFLICT'))
})

it('refuses ambiguous legacy records without inventing a reviewer, auto approval, or never policy', () => {
  for (const value of [codex(), opencode()]) {
    delete value.advanced
    const before = structuredClone(value)
    assert.throws(() => assertNativeWorkflowConfiguration(value), code('NATIVE_APPROVAL_CONFIGURATION_REQUIRED'))
    assert.deepEqual(value, before)
    assert.doesNotThrow(() => assertNativeWorkflowConfiguration(value, { handler: 'user' }))
  }
})

it('accepts the legacy explicit OpenCode auto boolean only when no routed authority competes', () => {
  const value = opencode(); delete value.advanced; value.autoApprove = true
  assert.doesNotThrow(() => assertNativeWorkflowConfiguration(value))
  assert.throws(() => assertNativeWorkflowConfiguration(value, { handler: 'user' }), code('WORKFLOW_HARNESS_APPROVAL_CONFLICT'))
})

it('refuses incomplete Orchestrator authority and ephemeral routed Codex sessions', () => {
  assert.throws(() => assertNativeWorkflowConfiguration(codex(), { handler: 'orchestrator' }), code('WORKFLOW_APPROVAL_INCOMPLETE'))
  const value = codex(); value.advanced!.sessionPersistence = 'ephemeral'
  assert.throws(() => assertNativeWorkflowConfiguration(value, { handler: 'user' }), code('WORKFLOW_HARNESS_APPROVAL_CONFLICT'))
})
