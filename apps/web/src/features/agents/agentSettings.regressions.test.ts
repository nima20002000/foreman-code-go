import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type HarnessDefaults } from '@graphql/contracts'

import { configuredHarness, defaultAgentForHarness, nextHarnessAgentName } from './agentSettings'

const defaults: HarnessDefaults = {
  codex: {
    ...DEFAULT_HARNESS_DEFAULTS.codex,
    model: 'gpt-5.6-terra', reasoningEffort: 'high', sandbox: 'workspace-write', serviceTier: 'priority',
  },
  opencode: {
    ...DEFAULT_HARNESS_DEFAULTS.opencode,
    nativeAgent: 'plan', variant: 'low', thinking: true,
  },
}

describe('PR #3 harness defaults and names', () => {
  it.each(['codex', 'opencode'] as const)('uses the same saved %s template for direct creation and harness switching', (target) => {
    const source = target === 'codex' ? 'opencode' : 'codex'
    const original = defaultAgentForHarness(source, 'agent-new', 'New agent', defaults[source])
    const direct = defaultAgentForHarness(target, 'agent-new', 'New agent', defaults[target])
    expect(direct.harnessConfiguration).toEqual(defaults[target])
    expect(configuredHarness(
      original,
      target,
      direct.model!,
      direct.effort!,
      direct.fastMode ?? false,
      direct.harnessConfiguration?.harness === 'codex' ? direct.harnessConfiguration.sandbox : 'read-only',
      defaults,
    )).toEqual(direct.harnessConfiguration)
  })

  it('does not apply later global defaults to an existing agent', () => {
    const existing = defaultAgentForHarness('codex', 'existing', 'Existing agent')
    expect(configuredHarness(existing, 'codex', existing.model!, existing.effort!, false, 'read-only'))
      .toEqual(DEFAULT_HARNESS_DEFAULTS.codex)
    expect(defaults.codex.sandbox).toBe('workspace-write')
  })

  it.each(['codex', 'opencode'] as const)('continues %s names through 998, 999, 1000, and 1001', (harness) => {
    const agents = [{ id: 'agent-998', name: `${harness}-998` }]
    for (const expected of [999, 1000, 1001]) {
      const name = nextHarnessAgentName(harness, agents)
      expect(name).toBe(`${harness}-${expected}`)
      expect(agents.some((agent) => agent.name === name)).toBe(false)
      agents.push({ id: `agent-${expected}`, name })
    }
  })
})
