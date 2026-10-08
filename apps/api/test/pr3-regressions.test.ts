import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HARNESS_DEFAULTS,
  type Agent,
} from '@foreman-code/contracts'

import { configurationInput } from '../src/modules/workspaces/agentConfiguration.js'

const workspaceId = 'workspace-pr3'
describe('PR #3 agent persistence regressions', () => {
  it('honors the nested-only OpenCode discriminator and rejects contradictory harnesses', () => {
    const nested: Agent = { id: 'new-agent', name: 'OpenCode', harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.opencode }
    expect(configurationInput(workspaceId, nested).harness).toEqual(DEFAULT_HARNESS_DEFAULTS.opencode)
    expect(() => configurationInput(workspaceId, { ...nested, harness: 'codex' }))
      .toThrow(expect.objectContaining({ code: 'AGENT_HARNESS_MISMATCH', status: 400 }))
  })

})
