import { describe, expect, it } from 'vitest'
import { subagentCapabilities, type RunSubagent } from '@graphql/contracts/subagents'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { subagentAvailableActions } from './capabilities.js'
const principal: ManagementPrincipal = { id: 'p', name: 'Scoped', audience: 'operator', grants: [{ actions: ['runs:read', 'runs:subagents:input', 'runs:stop'], scope: { runIds: ['r'] } }], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
const child = { id: 'child', workspaceId: 'w', workflowId: 'wf', runId: 'r', status: 'running', evidence: 'confirmed', nativeMode: 'codex-multi-agent-v2',
  capabilities: subagentCapabilities('codex-multi-agent-v2', '0.154.0') } as RunSubagent
const lease = { generation: 'g', nativeTurnId: 't', matches: () => true, assertCurrent: () => {}, sendInput: async () => {}, interrupt: async () => {} }
describe('native mode and current child action gates', () => {
  it('never enables Codex v2 direct input from contradictory persisted flags', () => {
    const forged = { ...child, capabilities: { ...child.capabilities, sendInput: { support: 'supported' as const, qualification: 'passed' as const }, inputTiming: 'active' as const } }
    expect(subagentAvailableActions(forged, principal, false, lease).sendInput).toBe(false)
  })
  it('requires exact live lease, scoped permission and a clear Run-stop fence', () => {
    const qualified = { ...child, nativeMode: 'opencode-task' as const, status: 'waiting' as const,
      capabilities: { ...subagentCapabilities('opencode-task', '1.18.33'), sendInput: { support: 'supported' as const, qualification: 'passed' as const } } }
    expect(subagentAvailableActions(qualified, principal, false, { ...lease, nativeTurnId: null }).sendInput).toBe(true)
    expect(subagentAvailableActions(qualified, principal, false, lease).sendInput).toBe(false)
    expect(subagentAvailableActions(qualified, principal, true, lease).sendInput).toBe(false)
    expect(subagentAvailableActions(qualified, principal, false).sendInput).toBe(false)
    expect(subagentAvailableActions(qualified, { ...principal, grants: [{ actions: ['runs:read'], scope: {} }] }, false, lease).sendInput).toBe(false)
    expect(subagentAvailableActions(qualified, principal, false, { ...lease, matches: () => false }).sendInput).toBe(false)
  })
})
