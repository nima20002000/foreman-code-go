import { describe, expect, it } from 'vitest'
import { RunSubagentInputSchema,
  SubagentCapabilitiesSchema, RunSubagentSchema, subagentCapabilities } from './subagents.js'

describe('native child contracts and evidence gates', () => {
  it.each(['codex-multi-agent-v2', 'codex-collab'] as const)('reports protocol support separately from live qualification for %s', mode => {
    const capabilities = subagentCapabilities(mode, '0.154.0')
    for (const action of ['sendInput', 'interrupt', 'executionResume'] as const) {
      expect(capabilities[action]).toEqual({ support: 'supported', qualification: 'unverified' })
    }
    expect(capabilities.inputTiming).toBe('active-and-idle')
    expect(capabilities.historyReadback.support).not.toBe('unsupported')
  })
  it('separates protocol evidence from app qualification and exact version evidence', () => {
    expect(subagentCapabilities('opencode-task', '1.18.33')).toMatchObject({ sendInput: { support: 'supported', qualification: 'unverified' }, inputTiming: 'idle', toolCalls: { support: 'unverified' } })
    expect(subagentCapabilities('opencode-task', '1.18.31').sendInput).toEqual({ support: 'supported', qualification: 'passed' })
    expect(subagentCapabilities('opencode-task', '1.18.30').sendInput.qualification).toBe('unverified')
    expect(subagentCapabilities('claude-agent', '2.1.284').toolCalls.qualification).toBe('unverified')
    expect(SubagentCapabilitiesSchema.safeParse({}).success).toBe(false)
  })
  it('requires exact revision and rejects extra native authority in input commands', () => {
    const command = { workspaceId: 'w', runId: 'r', subagentId: 'c', commandId: 'cmd', expectedRevision: '1', text: 'continue' }
    expect(RunSubagentInputSchema.parse(command)).toEqual(command)
    expect(RunSubagentInputSchema.safeParse({ ...command, nativeSessionId: 'foreign' }).success).toBe(false)
    expect(RunSubagentInputSchema.safeParse({ ...command, text: '' }).success).toBe(false)
  })
  it('requires a provider-specific child identity', () => {
    expect(RunSubagentSchema.safeParse({}).success).toBe(false)
  })
})
