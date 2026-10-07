import { expect, it } from 'vitest'
import { CLAUDE_FULL_ACCESS_REQUIRED, ClaudeHarnessConfigurationSchema } from './claude.js'
import { SupportedHarnessConfigurationSchema, HarnessWorkflowCompatibilitySchema } from './index.js'
import { AgentCreateInputSchema, HarnessDefaultsUpdateInputSchema } from './management/index.js'
import { HostHarnessOverrideSaveSchema } from './harnessRegistry.js'

const configuration = { harness: 'claude' as const, model: 'fixture', authMode: 'subscription' as const,
  configDirectory: '/fixture/profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
  tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} }

it.each(['read-only', 'workspace-write', 'another-mode'])('rejects %s without changing the supplied configuration', sandbox => {
  const value = { ...configuration, sandbox }
  const result = SupportedHarnessConfigurationSchema.safeParse(value)
  expect(result.success).toBe(false)
  if (result.success) throw new Error('Unsupported access mode was accepted')
  expect(result.error.issues.some(issue => issue.message === CLAUDE_FULL_ACCESS_REQUIRED)).toBe(true)
  expect(value.sandbox).toBe(sandbox)
})

it('allows Full access and keeps an unsupported stored value readable for explicit correction', () => {
  expect(SupportedHarnessConfigurationSchema.parse(configuration)).toEqual(configuration)
  expect(ClaudeHarnessConfigurationSchema.parse({ ...configuration, sandbox: 'read-only' }).sandbox).toBe('read-only')
})

it('uses the same Full access validation in agent saves, host saves, preset saves and workflow compatibility', () => {
  const unsupported = { ...configuration, sandbox: 'read-only' }
  const mainId = '11111111-1111-4111-8111-111111111111'
  const commandId = '22222222-2222-4222-8222-222222222222'
  const inputs = [
    AgentCreateInputSchema.safeParse({ workspaceId: 'workspace', agentId: 'agent', commandId,
      name: 'Claude', configuration: unsupported, prompt: {} }),
    HostHarnessOverrideSaveSchema.safeParse({ commandId, instanceId: commandId, expectedRevision: 0,
      presetId: 'preset', enabled: true, configuration: unsupported, target: {
        hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
        harnessInstallationId: 'installed-sdk', installationFingerprint: 'installed-payload',
      } }),
    HarnessWorkflowCompatibilitySchema.safeParse({ configuration: unsupported, workflowApprovalHandler: 'user' }),
  ]
  for (const result of inputs) {
    expect(result.success).toBe(false)
    if (result.success) throw new Error('Unsupported configuration was accepted')
    expect(result.error.issues.some(issue => issue.message === CLAUDE_FULL_ACCESS_REQUIRED)).toBe(true)
  }
  const defaults = HarnessDefaultsUpdateInputSchema.shape.defaults.shape
  expect(defaults.claude.safeParse(unsupported).success).toBe(false)
})
