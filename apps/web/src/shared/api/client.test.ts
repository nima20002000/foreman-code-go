import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS } from '@graphql/contracts'

import { ApiError, ApiClient, apiClient } from './client'
import { resetMockFixtures, setMockScenario } from '../mocks/scenarios'

describe('Phase 1 API boundary', () => {
  afterEach(() => {
    setMockScenario('normal')
    resetMockFixtures()
  })

  it('parses workspace details and keeps scoped query identities available to callers', async () => {
    const result = await apiClient.getWorkspaceDetails({ workspaceId: 'workspace-1' })

    expect(result.workspace).toMatchObject({ id: 'workspace-1', name: 'Website' })
    expect(result.agents.map((agent) => agent.name)).toEqual([
      'Operator',
      'Researcher',
      'Developer',
      'Reviewer',
    ])
    expect(result.workflows[0]?.edges).toEqual([
      { id: 'edge-researcher-developer', source: 'node-researcher', target: 'node-developer' },
      { id: 'edge-developer-reviewer', source: 'node-developer', target: 'node-reviewer' },
    ])
  })

  it('normalizes an API error response into ApiError', async () => {
    setMockScenario('error')

    await expect(apiClient.getWorkspaceDetails({ workspaceId: 'workspace-1' })).rejects.toMatchObject({
      name: 'ApiError',
      code: 'MOCK_READ_FAILED',
      status: 503,
    })
    expect(ApiError.is(new ApiError({ code: 'TEST', message: 'test' }))).toBe(true)
  })

  it('serves and revision-checks managed settings in mock mode', async () => {
    const agents = await apiClient.getManagedAgentDefaults()
    const workflows = await apiClient.getManagedWorkflowDefaults()
    expect(agents).toEqual({ value: DEFAULT_AGENT_DEFAULTS, revision: 0, versionId: null })
    expect(workflows).toEqual({ value: { approvalHandler: 'orchestrator' }, revision: 0, versionId: null })

    const next = structuredClone(DEFAULT_AGENT_DEFAULTS)
    next.operator.uiEnabled = false
    const updated = await apiClient.updateManagedAgentDefaults({
      commandId: 'mock-agent-defaults-update', expectedRevision: 0, value: next,
    })
    expect(updated).toMatchObject({ value: { value: next, revision: 1 }, replayed: false })
    await expect(apiClient.updateManagedAgentDefaults({
      commandId: 'stale-agent-defaults-update', expectedRevision: 0, value: DEFAULT_AGENT_DEFAULTS,
    })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409 })
  })

  it('passes AbortSignal through to fetch', async () => {
    const controller = new AbortController()
    const signal = controller.signal
    let receivedSignal: AbortSignal | null | undefined
    const client = new ApiClient({
      fetch: async (_input, init) => {
        receivedSignal = init?.signal
        return new Response(JSON.stringify({ agents: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })

    await client.listAgents({ workspaceId: 'workspace-1' }, { signal })
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
    expect(receivedSignal?.aborted).toBe(false)
    controller.abort('caller cancelled')
    expect(receivedSignal?.aborted).toBe(true)
    expect(receivedSignal?.reason).toBe('caller cancelled')
  })
})
