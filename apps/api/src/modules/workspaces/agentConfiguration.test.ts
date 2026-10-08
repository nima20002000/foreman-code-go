import { describe, expect, it } from 'vitest'
import {
  AgentConfigurationVersionSchema,
  AgentSchema,
  DEFAULT_HARNESS_DEFAULTS,
  RETIRED_OPENCODE_MESSAGE,
} from '@foreman-code/contracts'
import { configurationInput } from './agentConfiguration.js'

const retired = AgentConfigurationVersionSchema.parse({
  id: 'saved-configuration',
  workspaceId: 'workspace',
  agentId: 'agent',
  version: 1,
  prompt: { system: 'Saved instructions' },
  assignedSkills: [],
  harness: {
    harness: 'opencode',
    model: 'saved-model',
    variant: 'max',
    nativeAgent: 'build',
    thinking: true,
    autoApprove: false,
  },
  contentHash: 'saved-content-hash',
  createdAt: '2026-10-01T00:00:00.000Z',
})

describe('retired Agent configurations', () => {
  it('reads the saved configuration unchanged and rejects using it for new settings', () => {
    const saved = structuredClone(retired)
    const agent = AgentSchema.parse({ id: 'agent', name: 'Saved agent', role: 'builder' })
    expect(() => configurationInput('workspace', agent, retired)).toThrow(RETIRED_OPENCODE_MESSAGE)
    expect(retired).toEqual(saved)
    expect(AgentConfigurationVersionSchema.parse(retired)).toEqual(saved)
  })

  it('rejects an explicit retired choice before constructing an executable configuration', () => {
    const agent = AgentSchema.parse({
      id: 'agent', name: 'Saved agent', role: 'builder', harness: 'opencode',
      harnessConfiguration: retired.harness,
    })
    expect(() => configurationInput('workspace', agent)).toThrow(RETIRED_OPENCODE_MESSAGE)
  })

  it('allows an explicit supported replacement while retaining the original saved facts', () => {
    const agent = AgentSchema.parse({
      id: 'agent', name: 'Saved agent', role: 'builder', harness: 'codex',
      harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex,
    })
    const replacement = configurationInput('workspace', agent, retired)
    expect(replacement.harness).toEqual(DEFAULT_HARNESS_DEFAULTS.codex)
    expect(replacement.prompt).toEqual(retired.prompt)
    expect(retired.harness.harness).toBe('opencode')
    expect(retired.harness.model).toBe('saved-model')
  })
})
