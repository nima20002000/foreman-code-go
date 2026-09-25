import { createBoardStartClient } from '../../workflow-board/startClient'
import { describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../../../shared/api/client'
import { createNextDraftApi } from './transport'
import { fixture } from './core.cases'
import { currentWorkflowFixture as makeWave25Fixture } from '../../../shared/mocks/currentWorkflow'
import type { DraftRequest } from './state'
const request: DraftRequest = { kind: 'apply', executionSemanticsVersion: 3, workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft',
  commandId: 'authoring-test-command', expectedRevision: 7, operations: [{ type: 'workflow.set_entry', entryNodeId: 'node-0' }] }
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('Agent 6 existing authenticated HTTP boundary (mock responses, not backend auth proof)', () => {
  it('sends the V3 command with cookies, exact revision and typed operations', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ value: { draft: { ...fixture().draft, revision: 8 }, effects: [] }, replayed: false }))
    const api = createNextDraftApi(new ApiClient({ fetch }))
    await api.write(request)
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toMatch(/\/api\/management\/workspaces\/workspace\/workflows\/workflow\/drafts\/draft\/operations$/)
    expect(init!.credentials).toBe('same-origin')
    expect(JSON.parse(String(init!.body))).toMatchObject({ executionSemanticsVersion: 3, expectedRevision: 7, commandId: request.commandId, operations: request.operations })
    expect(JSON.parse(String(init!.body))).not.toHaveProperty('kind')
  })
  it('surfaces denied permission without alternate endpoints or credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code: 'FORBIDDEN', message: 'Denied' } }, 403))
    await expect(createNextDraftApi(new ApiClient({ fetch })).write(request)).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(fetch).toHaveBeenCalledOnce()
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).has('Authorization')).toBe(false)
  })
  it('rejects a successful-looking response from the wrong scope or revision', async () => {
    for (const draft of [{ ...fixture().draft, revision: 10 }, { ...fixture().draft, revision: 8, workflowId: 'another' }]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ value: { draft, effects: [] }, replayed: false }))
      await expect(createNextDraftApi(new ApiClient({ fetch })).write(request)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }
  })
  it('does not reinterpret unknown execution semantics as legacy or idle', async () => {
    const draft = fixture().draft
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ ...draft, graph: { ...draft.graph, executionSemanticsVersion: 99 } }))
    await expect(createNextDraftApi(new ApiClient({ fetch })).open('workspace', 'workflow')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('reads the catalog between matching draft revisions before exposing role pins', async () => {
    const context = fixture()
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(context.draft))
      .mockResolvedValueOnce(response({ items: context.agents, pageInfo: { nextCursor: null } }))
      .mockResolvedValueOnce(response(context.draft))
    const result = await createNextDraftApi(new ApiClient({ fetch })).context('workspace', 'workflow')
    expect(result.agents[0]!.agent.configurationVersionId).toBe('configuration-0')
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('starts the exact saved V3 version through authenticated HTTP and rejects mismatched admission', async () => {
    const saved = makeWave25Fixture('web-start')
    const input = { workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId,
      workflowVersionId: saved.scope.workflowVersionId, executionSemanticsVersion: 3 as const,
      expectedWorkflowRevision: 1, expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
      draftId: 'draft-web-start', expectedDraftRevision: 3, expectedLocationRevision: 1,
      commandId: 'start-web-start', input: {} }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ run: saved.run, accepted: true, replayed: false }))
    const api = createBoardStartClient(new ApiClient({ fetch }))
    expect((await api.start(input)).run.id).toBe(saved.scope.runId)
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toContain(`/workspaces/${saved.scope.workspaceId}/workflows/${saved.scope.workflowId}/runs`)
    expect(init!.credentials).toBe('same-origin')
    expect(JSON.parse(String(init!.body))).toMatchObject({ executionSemanticsVersion: 3,
      workflowVersionId: saved.scope.workflowVersionId, draftId: input.draftId,
      expectedDraftRevision: 3, commandId: input.commandId })
    fetch.mockResolvedValue(response({ run: { ...saved.run, workflowId: 'other-workflow' }, accepted: true, replayed: false }))
    await expect(api.start(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('requests bounded Run pages by cursor and rejects an out-of-scope list row', async () => {
    const saved = makeWave25Fixture('web-pages')
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response({ items: [saved.run], pageInfo: { nextCursor: 'run-next' } }))
    const api = createNextDraftApi(new ApiClient({ fetch }))
    const first = await api.runs(saved.scope.workspaceId, saved.scope.workflowId)
    expect(first.pageInfo.nextCursor).toBe('run-next')
    await api.runs(saved.scope.workspaceId, saved.scope.workflowId, first.pageInfo.nextCursor)
    expect(String(fetch.mock.calls[0]![0])).toContain('limit=20')
    expect(String(fetch.mock.calls[1]![0])).toContain('cursor=run-next')
    fetch.mockResolvedValue(response({ items: [{ ...saved.run, workflowId: 'wrong' }], pageInfo: { nextCursor: null } }))
    await expect(api.runs(saved.scope.workspaceId, saved.scope.workflowId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
