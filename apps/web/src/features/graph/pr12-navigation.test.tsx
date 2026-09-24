import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowDefinition } from '@graphql/contracts'
import { GraphEditor } from './GraphEditor'
import { getGraphDraft, useGraphDraftStore, workflowDraftKey } from './store'
import { useApprovalInboxStore } from '../approvals'

vi.mock('@xyflow/react', async () => ({
  ...await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react'),
  ReactFlow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Background: () => null, Controls: () => null,
}))
afterEach(() => { cleanup(); useGraphDraftStore.getState().clearAllDrafts(); useApprovalInboxStore.getState().closeInbox(); sessionStorage.clear() })

describe('PR12 graph approval inbox', () => {
  it.each([false, true])('preserves dirty drafts, including an unresolved save (%s)', async (pending) => {
    const workflow: WorkflowDefinition = { id: 'nav-workflow', workspaceId: 'nav-workspace', name: 'Navigation test', executionCondition: { kind: 'manual' }, nodes: [], edges: [] }
    const key = workflowDraftKey(workflow.workspaceId, workflow.id)
    useGraphDraftStore.getState().updateDraft(key, workflow, (value) => ({ ...value, approval: { handler: 'user' } }))
    useGraphDraftStore.getState().setManagedSaving(key, pending)
    const original = getGraphDraft(key)
    const root = createRootRoute({ component: Outlet })
    const graph = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId', component: () => <GraphEditor workspaceId={workflow.workspaceId} workflow={workflow} agents={[]} /> })
    const router = createRouter({ routeTree: root.addChildren([graph]), history: createMemoryHistory({ initialEntries: ['/workspaces/nav-workspace'] }) })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /Open human approval inbox/ }))
    expect(useApprovalInboxStore.getState()).toMatchObject({ open: true, workspaceId: workflow.workspaceId, workflowId: workflow.id })
    expect(getGraphDraft(key)).toEqual(original)
    expect(useGraphDraftStore.getState().managedSaving[key] ?? false).toBe(pending)
    client.clear()
  })
})
