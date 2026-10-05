import { createElement, type PropsWithChildren } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionControlStateSchema, unavailableSessionControls } from '@graphql/contracts'
import { sessionControlsApi } from '../../../shared/api/sessionControls'
import { useConversationDraftStore } from '../conversationDraftStore'
import { pendingControl } from './controlRequest'
import { useSessionControls } from './useSessionControls'

const initial = SessionControlStateSchema.parse({ conversationId: 'chat', revision: 1, profileKey: 'profile',
  desiredMode: 'regular', appliedMode: 'regular', defaults: {}, desired: {}, applied: {}, applicability: 'applied',
  context: null, nativeSessionId: 'native', nativeProviderVersion: 'test', compaction: null, compactions: [],
  busyReason: null, capabilities: unavailableSessionControls('profile') })
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children)
  return renderHook(() => useSessionControls('chat'), { wrapper })
}
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
