import { describe, expect, it } from 'vitest'
import { CODEX_SUBAGENT_CONTROL_UNSUPPORTED, subagentCapabilities, type RunSubagent } from '@foreman-code/contracts/subagents'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { subagentAvailableActions } from './capabilities.js'
const principal: ManagementPrincipal = { id: 'p', name: 'Scoped', audience: 'operator', grants: [{ actions: ['runs:read', 'runs:subagents:input', 'runs:stop'], scope: { runIds: ['r'] } }], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
const child = { id: 'child', workspaceId: 'w', workflowId: 'wf', runId: 'r', status: 'running', evidence: 'confirmed', provider: 'codex', nativeMode: 'codex-multi-agent-v2',
  capabilities: subagentCapabilities('codex-multi-agent-v2', '0.154.0') } as RunSubagent
const lease = { generation: 'g', nativeTurnId: 't', matches: () => true, assertCurrent: () => {}, sendInput: async () => {}, interrupt: async () => {} }
describe('native mode and current child action gates', () => {
  it.each(['codex-multi-agent-v2', 'codex-collab'] as const)('keeps %s controls unavailable despite contradictory flags', nativeMode => {
    const forged = { ...child, nativeMode, native: { ...child.native, currentTurnId: 't' }, capabilities: {
      ...child.capabilities, sendInput: { support: 'supported' as const, qualification: 'passed' as const },
      interrupt: { support: 'supported' as const, qualification: 'passed' as const }, inputTiming: 'active' as const,
    } }
    expect(subagentAvailableActions(forged, principal, false, lease)).toEqual({
      sendInput: false, interrupt: false, blockedReason: CODEX_SUBAGENT_CONTROL_UNSUPPORTED,
    })
    expect(subagentAvailableActions(forged, principal, false)).toEqual({
      sendInput: false, interrupt: false, blockedReason: CODEX_SUBAGENT_CONTROL_UNSUPPORTED,
    })
  })
  it('requires exact live lease, scoped permission and a clear Run-stop fence', () => {
    const qualified = { ...child, provider: 'opencode' as const, nativeMode: 'opencode-task' as const, status: 'waiting' as const,
      capabilities: subagentCapabilities('opencode-task', '1.18.31') }
    expect(subagentAvailableActions(qualified, principal, false, { ...lease, nativeTurnId: null }).sendInput).toBe(true)
    expect(subagentAvailableActions(qualified, principal, false, lease).sendInput).toBe(false)
    expect(subagentAvailableActions(qualified, principal, true, lease).sendInput).toBe(false)
    expect(subagentAvailableActions(qualified, principal, false).sendInput).toBe(false)
    expect(subagentAvailableActions(qualified, { ...principal, grants: [{ actions: ['runs:read'], scope: {} }] }, false, lease).sendInput).toBe(false)
    expect(subagentAvailableActions(qualified, principal, false, { ...lease, matches: () => false }).sendInput).toBe(false)
  })
})
