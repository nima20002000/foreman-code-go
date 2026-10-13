import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { useGraphDraftStore } from '../store'
import { fixture } from './core.cases'
import { newNextDraft, nextDraftKey } from './state'
import { storeEditSnapshot, readEditSnapshot, editSnapshotAcknowledged } from './editIntentStorage'
import { nextDraftApi } from './transport'
import { NextDraftEditor } from './NextDraftEditor'

vi.mock('./DraftCanvas', () => ({ DraftCanvas: () => <div>Draft canvas</div> }))
const scope = nextDraftKey('workspace', 'workflow')
const ownerKey = protectedKey('ui', 'graph-edit-intent:tab')
const clients: QueryClient[] = []
const held = new Set<string>()
beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts()
  localStorage.clear()
  sessionStorage.clear()
  held.clear()
  vi.spyOn(nextDraftApi, 'context').mockResolvedValue(fixture())
  vi.spyOn(nextDraftApi, 'editRead').mockResolvedValue({ intent: null, current: [], canStop: false, affectedSetChanged: false })
  vi.stubGlobal('navigator', { ...navigator, locks: {
    request: async (name: string, options: unknown, callback?: (lock: unknown) => unknown) => {
      if (typeof options === 'function') return options({ name })
      if (held.has(name)) return callback!(null)
      held.add(name)
      try { return await callback!({ name }) }
      finally { held.delete(name) }
    },
  } })
})
afterEach(() => {
  cleanup()
  window.dispatchEvent(new Event('pagehide'))
  clients.splice(0).forEach(client => client.clear())
  useGraphDraftStore.getState().clearAllDrafts()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}>
    <NextDraftEditor workspaceId="workspace" workflowId="workflow" initialContext={fixture()} />
  </QueryClientProvider>)
}

it('claims separate ownership before recovering a copied sessionStorage form and preserves it on ordinary reload', async () => {
  sessionStorage.setItem(ownerKey, 'copied-owner')
  const original = newNextDraft(fixture(), 'opener')
  original.graph = { ...original.graph, description: 'Opener draft' }
  storeEditSnapshot(scope, original, 'opener-acknowledgement')
  const originalSnapshot = readEditSnapshot(scope)
  // The opener's lifetime lock remains held even while that document is suspended.
  held.add(protectedKey('ui', 'graph-edit-intent:owner:copied-owner'))
  const first = mount()
  await screen.findByText('Draft canvas')
  await waitFor(() => expect(sessionStorage.getItem(ownerKey)).not.toBe('copied-owner'))
  const clonedOwner = sessionStorage.getItem(ownerKey)!
  expect(editSnapshotAcknowledged(scope, original, 'opener-acknowledgement')).toBe(true)
  act(() => useGraphDraftStore.getState().changeNextDraft(scope, graph => ({ ...graph, description: 'Cloned draft' })))
  expect(readEditSnapshot(scope)?.graph.description).toBe('Cloned draft')
  first.unmount()
  window.dispatchEvent(new Event('pagehide'))
  await waitFor(() => expect(held.has(protectedKey('ui', `graph-edit-intent:owner:${clonedOwner}`))).toBe(false))
  act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
  mount()
  await screen.findByText('Draft canvas')
  expect(sessionStorage.getItem(ownerKey)).toBe(clonedOwner)
  expect(readEditSnapshot(scope)?.graph.description).toBe('Cloned draft')
  sessionStorage.setItem(ownerKey, 'copied-owner')
  expect(readEditSnapshot(scope)).toEqual(originalSnapshot)
  expect(editSnapshotAcknowledged(scope, original, 'opener-acknowledgement')).toBe(true)
})
