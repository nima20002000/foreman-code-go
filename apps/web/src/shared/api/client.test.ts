import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS } from '@graphql/contracts'
import { HarnessConfigurationCheckResultSchema } from '@graphql/contracts/management'
import { GraphDraftV3Schema } from '@graphql/contracts/wave25'
import { currentWorkflowFixture as makeWave25Fixture } from '../mocks/currentWorkflow'

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
      { id: 'edge-researcher-developer', kind: 'execution', source: 'node-researcher', target: 'node-developer' },
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

  it('covers the Harness and workspace settings requests used in mock mode', async () => {
    const catalog = await apiClient.getManagedHarnessCatalog()
    expect(catalog.map((entry) => entry.harness)).toEqual(['codex', 'opencode'])
    expect(catalog.every((entry) => entry.defaultsRevision === 0)).toBe(true)

    const checked = await apiClient.request(
      '/api/management/harnesses/validate',
      HarnessConfigurationCheckResultSchema,
      { method: 'POST', body: { configuration: DEFAULT_HARNESS_DEFAULTS.codex } },
    )
    expect(checked).toMatchObject({ configuration: DEFAULT_HARNESS_DEFAULTS.codex, qualification: { ready: true, version: 'mock' } })

    const workspace = await apiClient.getManagedWorkspace('workspace-1')
    expect(workspace).toMatchObject({ workspace: { id: 'workspace-1' }, locationValidation: { status: 'unconfigured' } })
    await expect(apiClient.validateWorkspaceLocation({
      workspaceId: 'workspace-1', runnerId: 'runner-local', rootPath: '/workspace', accessMode: 'read-only',
    })).resolves.toMatchObject({ workspaceId: 'workspace-1', location: { rootPath: '/workspace' } })
    await expect(apiClient.getScopedMcpDetection('workspace-1', 'codex')).resolves.toMatchObject({
      runnerId: 'runner-local', detection: { harness: 'codex', state: 'not_detected' },
    })
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

  it('accepts an exact v2 Apply revert and its idempotent HTTP replay', async () => {
    const fixture = makeWave25Fixture('web-revert')
    const draft = GraphDraftV3Schema.parse({
      id: 'draft-web-revert', workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
      revision: 9, publishedRevision: 9, baseWorkflowVersionId: fixture.version.id,
      graph: fixture.version.definition, stagedAgents: [], updatedByPrincipalId: 'principal-web-revert',
      updatedAt: fixture.createdAt,
    })
    const response = (replayed: boolean) => new Response(JSON.stringify({
      value: { draft, revertedApplyCommandId: 'apply-web-revert', priorRevision: 7 }, replayed,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(false))
      .mockResolvedValueOnce(response(true))
    const client = new ApiClient({ fetch })
    const input = { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
      draftId: draft.id, commandId: 'revert-web-revert', expectedRevision: 8,
      applyCommandId: 'apply-web-revert' }

    expect((await client.revertManagedGraphApply(input)).value.draft).toEqual(draft)
    expect(await client.revertManagedGraphApply(input)).toMatchObject({ replayed: true, value: { draft } })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([input, input])
  })
})
