import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { UnsavedChangesContext, type EditorRegistration } from '../../../shared/ui/unsavedChanges'
import { useGraphDraftStore } from '../store'
import { nextDraftKey } from './state'
import { fixture } from './core.cases'
import { NextDraftEditor } from './NextDraftEditor'

// Forms/registration test only. This replacement is not React Flow or browser evidence.
vi.mock('./DraftCanvas', () => ({ DraftCanvas: () => <div>Canvas test placeholder</div> }))
const key = nextDraftKey('workspace', 'workflow')
beforeEach(() => { useGraphDraftStore.getState().clearAllDrafts() })

it('registers local form dirtiness and discard with the existing navigation guard', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const registrations = new Map<string, EditorRegistration>()
  const guard = { changed: vi.fn(), surfaces: async () => true, request: async () => true,
    register: (id: string, editor: EditorRegistration) => { registrations.set(id, editor); return () => { registrations.delete(id) } } }
  const user = userEvent.setup()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><UnsavedChangesContext.Provider value={guard}>
    <NextDraftEditor workspaceId="workspace" workflowId="workflow" />
  </UnsavedChangesContext.Provider></QueryClientProvider>)
  await user.click(screen.getByRole('button', { name: /Entry · Node 0/ }))
  await user.type(screen.getByLabelText('Node instruction'), 'Unsaved instruction')
  const registered = [...registrations.values()].find((item) => item.current.label.endsWith('next draft'))!
  expect(registered.current.dirty).toBe(true)
  await act(async () => { await registered.current.discard() })
  expect(screen.getByLabelText('Node instruction')).toHaveValue('')
  expect(registered.current.dirty).toBe(false)
})

it('clearing the application session also purges next drafts and pending conversions', () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  useGraphDraftStore.getState().setNextDraftPromotion(key, { busy: false, request: { kind: 'apply', executionSemanticsVersion: 2,
    expectedRevision: 7, workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft', commandId: 'pending-conversion', operations: [] } })
  useGraphDraftStore.getState().clearAllDrafts()
  expect(useGraphDraftStore.getState().nextDrafts).toEqual({})
  expect(useGraphDraftStore.getState().nextDraftPromotions).toEqual({})
})

it('a remount cannot hide an ambiguous promotion just because the server already returns v2', async () => {
  const { nextDraftApi } = await import('./transport')
  const context = fixture()
  useGraphDraftStore.getState().setNextDraftPromotion(key, { busy: false, error: { code: 'NETWORK_ERROR', message: 'Unknown result', uncertain: true },
    request: { kind: 'apply', executionSemanticsVersion: 2, expectedRevision: 6, workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft', commandId: 'pending-conversion', operations: [{ type: 'nodes.reorder', nodeIds: ['node-0', 'node-1'] }] } })
  const read = vi.spyOn(nextDraftApi, 'context').mockResolvedValue(context)
  render(<NextDraftEditor workspaceId="workspace" workflowId="workflow" />)
  expect(await screen.findByRole('button', { name: 'Reconcile conversion' })).toBeInTheDocument()
  expect(useGraphDraftStore.getState().nextDrafts[key]).toBeUndefined()
  read.mockRestore()
})
