import { describe, expect, it, vi } from 'vitest'
import { DISABLED_RUN_GRAPH_CAPABILITIES } from '@graphql/contracts/wave25'
import { ApiClient } from '../../shared/api/client'
import { createRunGraphClient, graphReadPath, negotiateGraphReader } from './client'
import { fixture, page } from './testFixtures'

describe('frozen graph read client', () => {
  it('uses the shared route and exact scope/cursor query without numeric cursor conversion', () => {
    const f = fixture()
    const path = graphReadPath(f.scope, '9007199254740993')
    expect(path).toContain(`/api/workspaces/${f.scope.workspaceId}/workflows/${f.scope.workflowId}/runs/${f.scope.runId}/graph/v1/events?`)
    const query = new URL(path, 'http://localhost').searchParams
    expect(Object.fromEntries(query)).toEqual({ workflowVersionId: f.scope.workflowVersionId,
      executionSemanticsVersion: '2', afterSequence: '9007199254740993' })
    expect(() => graphReadPath(f.scope, '01')).toThrow()
  })
  it('chooses compatibility only on successful explicit negotiation for semantics 1', () => {
    const f = fixture()
    expect(negotiateGraphReader(DISABLED_RUN_GRAPH_CAPABILITIES, { ...f.scope, executionSemanticsVersion: 1 })).toBe('legacy')
    expect(() => negotiateGraphReader(DISABLED_RUN_GRAPH_CAPABILITIES, f.scope)).toThrow('GRAPH_UNSUPPORTED_PROTOCOL')
    expect(negotiateGraphReader({ ...DISABLED_RUN_GRAPH_CAPABILITIES, protocolVersions: [1], executionSemanticsVersions: [2] }, f.scope)).toBe('graph')
    for (const unavailable of [undefined, { error: 'temporary outage' }, { ...DISABLED_RUN_GRAPH_CAPABILITIES, capabilityVersion: 2 }]) {
      expect(() => negotiateGraphReader(unavailable, { ...f.scope, executionSemanticsVersion: 1 })).toThrow('GRAPH_UNSUPPORTED_PROTOCOL')
    }
  })
  it('preserves the existing HTTP cookie/auth/session boundary and validates responses', async () => {
    const f = fixture()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(page(f.scope, [])), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    const api = createRunGraphClient(new ApiClient({ fetch }))
    await expect(api.events(f.scope, '0', new AbortController().signal)).resolves.toEqual(page(f.scope, []))
    expect(fetch.mock.calls[0]?.[1]?.credentials).toBe('same-origin')
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET')
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...page(f.scope, []), protocolVersion: 99 }), { status: 200 }))
    await expect(api.events(f.scope, '0', new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'GRAPH_READ_ACCESS_DENIED', message: 'Denied' } }), { status: 403 }))
    await expect(api.snapshot(f.scope, new AbortController().signal)).rejects.toMatchObject({ status: 403 })
  })
})
