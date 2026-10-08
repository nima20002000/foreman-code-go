import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { apiClient } from './client'
import { queryKeys, useWorkflowPages, useWorkspacePages } from './query'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

it('shows the sidebar workflows page in the directory while the full list loads', async () => {
  vi.spyOn(apiClient, 'listManagedWorkflowPage').mockImplementation(() => new Promise(() => {}))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const sidebar = { pages: [{ items: [{ workflow: { id: 'workflow-a', name: 'A' } }], pageInfo: { nextCursor: null } }], pageParams: [undefined] }
  client.setQueryData([...queryKeys.managedWorkflows('workspace-a'), 'pages'], sidebar)
  const { result } = renderHook(() => useWorkflowPages('workspace-a', true, 'directory'), { wrapper: wrapper(client) })
  await waitFor(() => expect(result.current.isPlaceholderData).toBe(true))
  expect(result.current.isPending).toBe(false)
  expect(result.current.data).toEqual(sidebar)
  client.clear()
})

it('shows the sidebar workspaces page in the directory while the full list loads', async () => {
  vi.spyOn(apiClient, 'listManagedWorkspacePage').mockImplementation(() => new Promise(() => {}))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const sidebar = { pages: [{ items: [{ workspace: { id: 'workspace-a', name: 'A' } }], pageInfo: { nextCursor: null } }], pageParams: [undefined] }
  client.setQueryData([...queryKeys.managedWorkspaces, 'pages'], sidebar)
  const { result } = renderHook(() => useWorkspacePages(true, 'directory'), { wrapper: wrapper(client) })
  await waitFor(() => expect(result.current.data).toEqual(sidebar))
  expect(result.current.isPending).toBe(false)
  client.clear()
})
