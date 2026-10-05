import type { AgentChatContext } from '@graphql/contracts/agent-chat'
import { createElement, type PropsWithChildren } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionControlStateSchema, unavailableSessionControls } from '@graphql/contracts'
import { sessionControlsApi } from '../../../shared/api/sessionControls'
import { useConversationDraftStore } from '../conversationDraftStore'
import { pendingControl, reservePendingControl, clearPendingControl, recoverPendingControl } from './controlRequest'
import { useSessionControls } from './useSessionControls'

const initial = SessionControlStateSchema.parse({ conversationId: 'chat', revision: 1, profileKey: 'profile',
  desiredMode: 'regular', appliedMode: 'regular', defaults: {}, desired: {}, applied: {}, applicability: 'applied',
  context: null, nativeSessionId: 'native', nativeProviderVersion: 'test', compaction: null, compactions: [],
  busyReason: null, capabilities: unavailableSessionControls('profile') })
function mount(context?: AgentChatContext) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children)
  return renderHook(() => useSessionControls(context ? undefined : 'chat', context?.workspaceId, context), { wrapper })
}
let originalLocks: PropertyDescriptor | undefined
beforeEach(() => {
  originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  const tails = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request<T>(name: string, options: LockOptions, callback: () => T): Promise<T> {
      const work = (tails.get(name) ?? Promise.resolve()).catch(() => undefined).then(() => {
        options.signal?.throwIfAborted()
        return callback()
      })
      tails.set(name, work)
      return work
    },
  } })
})
afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); useConversationDraftStore.getState().clearAllDrafts() })

it('reuses the original compact input after a lost response and remount, then clears the confirmed draft', async () => {
  let saved = initial
  vi.spyOn(sessionControlsApi, 'read').mockImplementation(async () => saved)
  const change = vi.spyOn(sessionControlsApi, 'change').mockRejectedValueOnce(new Error('Response lost'))
  useConversationDraftStore.getState().setDraft('chat', '/compact')
  const first = mount()
  await waitFor(() => expect(first.result.current.state).toBeDefined())
  await act(async () => {
    await expect(first.result.current.command('/compact', 'chat')).rejects.toThrow('Response lost')
  })
  const original = change.mock.calls[0]![1]
  first.unmount()
  const second = mount()
  await waitFor(() => expect(second.result.current.state).toBeDefined())
  change.mockImplementationOnce(async () => {
    saved = { ...initial, revision: 3, compaction: { requestId: original.requestId, nativeSessionId: 'native',
      nativeOperationId: 'compact-turn', status: 'completed', beforeTokens: 100,
      message: 'Context compacted.', observedAt: new Date().toISOString() } }
    return saved
  })
  await act(async () => { await second.result.current.command('/compact', 'chat') })
  expect(change.mock.calls[1]![1]).toEqual(original)
  expect(useConversationDraftStore.getState().drafts.chat).toBeUndefined()
  expect(pendingControl(JSON.stringify(['operator', 'chat', null]))).toBeNull()
})

it('clears a recovered command draft on readback while preserving later edits', async () => {
  vi.spyOn(sessionControlsApi, 'read').mockResolvedValue(initial)
  const change = vi.spyOn(sessionControlsApi, 'change').mockRejectedValue(new Error('Response lost'))
  useConversationDraftStore.getState().setDraft('chat', '/compact')
  const first = mount()
  await waitFor(() => expect(first.result.current.state).toBeDefined())
  await act(async () => { await first.result.current.command('/compact', 'chat').catch(() => undefined) })
  first.unmount()
  const original = change.mock.calls[0]![1]
  useConversationDraftStore.getState().setDraft('chat', 'A later edit')
  vi.mocked(sessionControlsApi.read).mockResolvedValue({ ...initial, compaction: {
    requestId: original.requestId, nativeSessionId: 'native', nativeOperationId: 'compact-turn', status: 'completed',
    beforeTokens: 100, message: 'Context compacted.', observedAt: new Date().toISOString(),
  } })
  const second = mount()
  await waitFor(() => expect(second.result.current.state?.compaction?.status).toBe('completed'))
  expect(useConversationDraftStore.getState().drafts.chat).toBe('A later edit')
  expect(change).toHaveBeenCalledTimes(1)
})

it('reports storage failure and sends no native control without a durable identity', async () => {
  vi.spyOn(sessionControlsApi, 'read').mockResolvedValue(initial)
  const change = vi.spyOn(sessionControlsApi, 'change')
  const mounted = mount()
  await waitFor(() => expect(mounted.result.current.state).toBeDefined())
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Control storage is full') })
  await act(async () => {
    await expect(mounted.result.current.change({ kind: 'compact' })).rejects.toThrow('Control storage is full')
  })
  expect(mounted.result.current.mutation.isError).toBe(true)
  expect(change).not.toHaveBeenCalled()
})

it('keeps node control identity across reloads that reconstruct context fields in another order', async () => {
  const context = { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' }
  vi.spyOn(sessionControlsApi, 'readContext').mockResolvedValue(initial)
  const change = vi.spyOn(sessionControlsApi, 'changeContext').mockRejectedValueOnce(new Error('Response lost'))
  const first = mount(context)
  await waitFor(() => expect(first.result.current.state).toBeDefined())
  await act(async () => { await expect(first.result.current.change({ kind: 'compact' })).rejects.toThrow('Response lost') })
  const original = change.mock.calls[0]![1]
  first.unmount()
  const second = mount({ agentId: 'agent', workflowNodeId: 'node', workflowId: 'workflow', workspaceId: 'workspace' })
  await waitFor(() => expect(second.result.current.state).toBeDefined())
  change.mockResolvedValueOnce({ ...initial, compaction: { requestId: original.requestId,
    nativeSessionId: 'native', nativeOperationId: 'compact-turn', status: 'completed', beforeTokens: 100,
    message: 'Context compacted.', observedAt: new Date().toISOString() } })
  await act(async () => { await second.result.current.change({ kind: 'compact' }) })
  expect(change.mock.calls[1]![1]).toEqual(original)
})

it('reserves one compact identity across competing tabs and preserves it through a lost winner response', async () => {
  const scope = JSON.stringify(['operator', 'chat', null])
  const ids = vi.spyOn(crypto, 'randomUUID')
  const [first, second] = await Promise.all([
    reservePendingControl(scope, { kind: 'compact' }, 1),
    reservePendingControl(scope, { kind: 'compact' }, 2),
  ])
  expect(second).toEqual(first)
  expect(ids).toHaveBeenCalledTimes(1)
  await clearPendingControl(scope, 'losing-request')
  expect(pendingControl(scope)).toEqual(first)
  expect(await reservePendingControl(scope, { kind: 'compact' }, 3)).toEqual(first)
  await recoverPendingControl(scope, { ...initial, compaction: {
    requestId: first.request.requestId, nativeSessionId: 'native', nativeOperationId: 'turn', status: 'completed',
    beforeTokens: 100, message: 'Done', observedAt: new Date().toISOString(),
  } })
  expect(pendingControl(scope)).toBeNull()
})

it('clears a superseded settings journal using the original completed receipt', async () => {
  const scope = JSON.stringify(['operator', 'chat', null])
  const original = await reservePendingControl(scope, { kind: 'mode', mode: 'plan' }, 1)
  await recoverPendingControl(scope, { ...initial, lastRequestId: 'later-writer' })
  expect(pendingControl(scope)).toEqual(original)
  await recoverPendingControl(scope, { ...initial, lastRequestId: 'later-writer',
    completedRequestId: original.request.requestId })
  expect(pendingControl(scope)).toBeNull()
  expect((await reservePendingControl(scope, { kind: 'mode', mode: 'regular' }, 3)).request.requestId)
    .not.toBe(original.request.requestId)
})

it('recovers a superseded receipt before admitting a different control', async () => {
  let saved = initial
  vi.spyOn(sessionControlsApi, 'read').mockImplementation(async () => saved)
  const change = vi.spyOn(sessionControlsApi, 'change').mockRejectedValueOnce(new Error('Response lost'))
  const first = mount()
  await waitFor(() => expect(first.result.current.state).toBeDefined())
  await act(async () => { await expect(first.result.current.change({ kind: 'mode', mode: 'plan' })).rejects.toThrow('Response lost') })
  const original = change.mock.calls[0]![1]
  first.unmount()
  saved = { ...initial, revision: 4, lastRequestId: 'other-settings-writer' }
  const second = mount()
  await waitFor(() => expect(second.result.current.state?.revision).toBe(4))
  change.mockResolvedValueOnce({ ...saved, completedRequestId: original.requestId })
    .mockImplementationOnce(async (_id, request) => ({ ...saved, revision: 5, lastRequestId: request.requestId }))
  await act(async () => { await second.result.current.change({ kind: 'mode', mode: 'regular' }) })
  expect(change.mock.calls[1]![1]).toEqual(original)
  expect(change.mock.calls[2]![1]).toMatchObject({ kind: 'mode', mode: 'regular', expectedRevision: 4 })
  expect(pendingControl(JSON.stringify(['operator', 'chat', null]))).toBeNull()
})
