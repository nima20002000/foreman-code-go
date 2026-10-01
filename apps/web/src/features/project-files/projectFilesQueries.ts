import { useInfiniteQuery, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { projectFilesClient, type ProjectFileRemoveInput, type ProjectFileUploadInput } from './projectFilesClient'

export const projectFilesKeys = {
  list: (workspaceId: string, generation = sessionGeneration()) => ['project-files', generation, workspaceId, 'list'] as const,
  upload: (workspaceId: string, generation = sessionGeneration()) => ['project-files', generation, workspaceId, 'upload'] as const,
  remove: (workspaceId: string, generation = sessionGeneration()) => ['project-files', generation, workspaceId, 'remove'] as const,
}

type ScopedUpload = ProjectFileUploadInput & { generation: number }
type ScopedRemoval = ProjectFileRemoveInput & { generation: number }

export function useProjectFilesQuery(workspaceId: string) {
  return useInfiniteQuery({
    queryKey: projectFilesKeys.list(workspaceId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => projectFilesClient.list(workspaceId, pageParam, signal),
    getNextPageParam: (lastPage, pages) => {
      const next = lastPage.pageInfo.nextCursor
      // A repeated cursor must not create an unbounded More loop.
      return next && !pages.slice(0, -1).some((page) => page.pageInfo.nextCursor === next) ? next : undefined
    },
    placeholderData: () => undefined, // Do not inherit an app-level keepPreviousData across workspaces.
    staleTime: 0,
    retry: false,
  })
}

export function useProjectFileUpload(workspaceId: string) {
  const queryClient = useQueryClient()
  const generation = sessionGeneration()
  const mutationKey = projectFilesKeys.upload(workspaceId, generation)
  const mutation = useMutation({
    mutationKey, retry: false, networkMode: 'always',
    mutationFn: (input: ScopedUpload) => {
      assertSession(input.generation)
      return projectFilesClient.upload(input)
    },
    onSettled: (_data, _error, input) => {
      if (input.generation !== sessionGeneration() || sessionIsSwitching()) return
      // Hook-level callbacks run even when navigation unmounts the originating view.
      return queryClient.invalidateQueries({ queryKey: projectFilesKeys.list(input.workspaceId, input.generation), exact: true })
    },
  })
  // TanStack owns request state and File variables, including navigation away and back.
  // Nothing is mirrored into Zustand, localStorage, or a global selected-workspace variable.
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (entry) => ({
      status: entry.state.status,
      error: entry.state.error,
      input: entry.state.variables as ScopedUpload | undefined,
    }),
  })
  const latest = history.at(-1)
  const pending = () => queryClient.getMutationCache().findAll({ mutationKey, exact: true })
    .some((entry) => entry.state.status === 'pending')
  return {
    isPending: history.some((entry) => entry.status === 'pending'),
    isError: latest?.status === 'error',
    filename: latest?.input?.file.name,
    start(file: File) {
      if (!pending()) mutation.mutate({ workspaceId, generation, file, requestId: crypto.randomUUID() })
    },
    retry() {
      if (!pending() && latest?.status === 'error' && latest.input) mutation.mutate(latest.input)
    },
  }
}

export function useProjectFileRemove(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: projectFilesKeys.remove(workspaceId), retry: false, networkMode: 'always',
    mutationFn: (input: ScopedRemoval) => {
      assertSession(input.generation)
      return projectFilesClient.remove(input)
    },
    onSettled: (_data, _error, input) => {
      if (input.generation !== sessionGeneration() || sessionIsSwitching()) return
      return queryClient.invalidateQueries({ queryKey: projectFilesKeys.list(input.workspaceId, input.generation), exact: true })
    },
  })
}
