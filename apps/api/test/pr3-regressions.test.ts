import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HARNESS_DEFAULTS,
  type Agent,
} from '@foreman-code/contracts'

import { configurationInput } from '../src/modules/workspaces/agentConfiguration.js'

const workspaceId = 'workspace-pr3'
describe('PR #3 agent persistence regressions', () => {
  it('honors the nested-only Claude discriminator and rejects contradictory harnesses', () => {
    const nested: Agent = { id: 'new-agent', name: 'Claude', harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.claude }
    expect(configurationInput(workspaceId, nested).harness).toEqual(DEFAULT_HARNESS_DEFAULTS.claude)
    expect(() => configurationInput(workspaceId, { ...nested, harness: 'codex' }))
      .toThrow(expect.objectContaining({ code: 'AGENT_HARNESS_MISMATCH', status: 400 }))
  })

})
