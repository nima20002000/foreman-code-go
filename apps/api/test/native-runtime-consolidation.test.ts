import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_CODEX_ADVANCED_CONFIGURATION, DEFAULT_OPENCODE_ADVANCED_CONFIGURATION,
  type HarnessConfiguration, type WorkflowApprovalConfiguration,
} from '@graphql/contracts'
import { ManagementHarnessConfigurationSchema } from '@graphql/contracts/management'
import { describe, it } from 'vitest'

import { assertNativeWorkflowConfiguration } from '../src/modules/harnesses/nativeWorkflowConfiguration.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
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

for (const handler of ['user', 'operator', 'orchestrator'] as const) {
  const approval: WorkflowApprovalConfiguration = { handler,
    ...(handler === 'orchestrator' ? { designatedOrchestratorAgentId: 'reviewer' } : {}) }
  it(`keeps ${handler} routed approval mutually exclusive with native automatic handling`, () => {
    const c = codex(), o = opencode()
    assert.doesNotThrow(() => assertNativeWorkflowConfiguration(c, approval))
    assert.doesNotThrow(() => assertNativeWorkflowConfiguration(o, approval))
    c.advanced!.approvalsReviewer = 'auto_review'
    o.autoApprove = true; o.advanced!.permissionHandling = 'native_auto'
    assert.throws(() => assertNativeWorkflowConfiguration(c, approval), code('WORKFLOW_HARNESS_APPROVAL_CONFLICT'))
    assert.throws(() => assertNativeWorkflowConfiguration(o, approval), code('WORKFLOW_HARNESS_APPROVAL_CONFLICT'))
  })
}

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

describe('native-only execution architecture', () => {
  it('has no legacy provider adapter files or production imports', () => {
    const removed = ['codex.ts', 'opencode.ts', 'resolver.ts', 'fallbackCapabilities.ts']
    for (const file of removed) assert.equal(existsSync(join(root, 'src/modules/harnesses', file)), false, file)
    const banned = /\b(?:CodexAdapter|OpenCodeAdapter|LocalHarnessResolver|HarnessResolver|HarnessAdapter|assertFallbackConfiguration|assertOpenCodeFallbackConfiguration)\b/
    function check(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name)
        if (entry.isDirectory()) check(file)
        else if (/\.[cm]?tsx?$/.test(file)) assert.equal(banned.test(readFileSync(file, 'utf8')), false, file)
      }
    }
    check(join(root, 'src'))
  })

  it('has exactly one coordinator observation path and wires both native providers in production', () => {
    const engine = readFileSync(join(root, 'src/modules/runs/engine.ts'), 'utf8')
    const production = readFileSync(join(root, 'src/production.ts'), 'utf8')
    assert.equal(engine.split('this.nativeExecutions.ensureObserve(').length - 1, 1)
    assert.ok(engine.includes('private readonly nativeExecutions: ApprovalExecutionCoordinator'))
    assert.ok(!engine.includes('this.harnesses.resolve('))
    assert.ok(production.includes('new CodexAppServerSessionManager('))
    assert.ok(production.includes('new OpenCodeNativeSessionManager('))
    assert.ok(production.includes('new NativeHarnessConfigurationQualifier('))
    assert.ok(production.includes('runs, workflows, approvals, checkpoints.saver'))
  })
})
