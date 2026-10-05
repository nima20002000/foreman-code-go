import { describe, expect, it } from 'vitest'
import { RunSubagentInputSchema, SubagentCapabilitiesSchema, RunSubagentSchema, subagentCapabilities } from './subagents.js'

describe('native child contracts and evidence gates', () => {
  it('keeps Codex v2 steering unsupported even with a claimed qualification', () => {
    expect(subagentCapabilities('codex-multi-agent-v2', '0.154.0').sendInput).toEqual({ support: 'unsupported', qualification: 'unverified', reasonCode: 'CODEX_V2_DIRECT_INPUT_UNSUPPORTED' })
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
