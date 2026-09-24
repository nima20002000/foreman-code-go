import { describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../../shared/api/client'
import { createRunGraphClient, legacyCurrentReadPath, legacyHistoryReadPath, readLegacyRunActivityPage, readLegacyRunHistory } from './client'
import { legacyCurrent, legacyScope } from './fe-r2-001.fixtures'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
})
describe('FE-R2-001 actual shared HTTP client boundary', () => {
  it('refreshes only current facts with all immutable pins and the existing credentials/signal', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(legacyCurrent()))
    const client = new ApiClient({ fetch })
    const api = createRunGraphClient(client)
    const getRun = vi.spyOn(client, 'getRun')
    for (let poll = 0; poll < 3; ++poll) await api.legacy(legacyScope, new AbortController().signal)
    expect(getRun).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(3)
    for (const [url, init] of fetch.mock.calls) {
      const request = new URL(String(url), 'http://localhost')
      expect(request.pathname).toBe(`/api/management/workspaces/${legacyScope.workspaceId}/runs/${legacyScope.runId}/current`)
      expect(Object.fromEntries(request.searchParams)).toEqual({ workflowId: legacyScope.workflowId,
        workflowVersionId: legacyScope.workflowVersionId, executionSemanticsVersion: '1' })
      expect(init?.credentials).toBe('same-origin')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
    expect(() => legacyCurrentReadPath({ ...legacyScope, executionSemanticsVersion: 2 })).toThrow()
  })
  it('requests one bounded history page only on explicit invocation, without draining nextCursor', async () => {
    const item = (sequence: number) => ({ id: `a-${sequence}`, runId: legacyScope.runId, sequence,
      source: 'backend', kind: 'run_state_changed', occurredAt: '2026-09-22T00:00:00.000Z', payload: {} })
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ items: [item(4)], pageInfo: { nextCursor: '4' } }))
    const client = new ApiClient({ fetch })
    expect(fetch).not.toHaveBeenCalled()
    const page = await readLegacyRunActivityPage(legacyScope, undefined, new AbortController().signal, client)
    expect(page.pageInfo.nextCursor).toBe('4')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/events?limit=50')
    fetch.mockResolvedValueOnce(json({ items: [item(6)], pageInfo: { nextCursor: null } }))
    await readLegacyRunActivityPage(legacyScope, 4, new AbortController().signal, client)
    expect(String(fetch.mock.calls[1]?.[0])).toContain('cursor=4')
    expect(fetch).toHaveBeenCalledTimes(2)
    await expect(readLegacyRunActivityPage(legacyScope, Number.MAX_SAFE_INTEGER + 1,
      new AbortController().signal, client)).rejects.toThrow('GRAPH_INVALID_LEGACY_HISTORY')
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('never accepts an old full-details response or falls back on permission loss', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({ ...legacyCurrent(), activity: [] }))
    const api = createRunGraphClient(new ApiClient({ fetch }))
    await expect(api.legacy(legacyScope, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    fetch.mockResolvedValueOnce(json({ error: { code: 'ACCESS_DENIED', message: 'Denied' } }, 403))
    await expect(api.legacy(legacyScope, new AbortController().signal)).rejects.toMatchObject({ status: 403 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it('reads historical pins through a separate exact-scope request', async () => {
    const detail = { kind: 'legacy-run-history', runId: legacyScope.runId, workspaceId: legacyScope.workspaceId,
      workflowId: legacyScope.workflowId, workflowVersionId: legacyScope.workflowVersionId,
      executionSemanticsVersion: 1, version: 1, entryNodeId: 'node-fe-r2',
      nodes: [{ id: 'node-fe-r2', agentId: 'agent-fe-r2', name: 'old-node', agentConfigurationVersionId: 'config-fe-r2' }],
      edges: [], agentConfigurations: [], latestResults: [] }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(detail))
    const signal = new AbortController().signal
    expect((await readLegacyRunHistory(legacyScope, signal, new ApiClient({ fetch }))).nodes[0]?.name).toBe('old-node')
    expect(new URL(String(fetch.mock.calls[0]?.[0])).pathname + new URL(String(fetch.mock.calls[0]?.[0])).search)
      .toBe(legacyHistoryReadPath(legacyScope))
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    expect(() => legacyHistoryReadPath({ ...legacyScope, executionSemanticsVersion: 2 })).toThrow()
    fetch.mockResolvedValueOnce(json({ ...detail, runId: 'other-run' }))
    await expect(readLegacyRunHistory(legacyScope, signal, new ApiClient({ fetch })))
      .rejects.toThrow('GRAPH_INVALID_LEGACY_HISTORY')
  })
})
