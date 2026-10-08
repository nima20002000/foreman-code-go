import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { apiClient } from './client'
import { queryKeys, usePrefetchBoard } from './query'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('prefetches a workflow board once on hover and reuses fresh data', async () => {
  const getWorkflow = vi.spyOn(apiClient, 'getManagedWorkflow').mockResolvedValue({ workflow: { id: 'workflow-a' } } as never)
  const request = vi.spyOn(apiClient, 'request').mockResolvedValue({ workspace: { id: 'workspace-a' }, workflows: [], agents: [], runs: [] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => usePrefetchBoard(), { wrapper })
  result.current.board('workspace-a', 'workflow-a')
  await waitFor(() => expect(client.getQueryData(queryKeys.managedWorkflow('workspace-a', 'workflow-a'))).toBeDefined())
  await waitFor(() => expect(client.getQueryState(queryKeys.workspaceDetails('workspace-a'))?.status).not.toBe('pending'))
  const calls = request.mock.calls.length + getWorkflow.mock.calls.length
  result.current.board('workspace-a', 'workflow-a')
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(request.mock.calls.length + getWorkflow.mock.calls.length).toBe(calls)
  expect(getWorkflow).toHaveBeenCalledOnce()
  client.clear()
})
