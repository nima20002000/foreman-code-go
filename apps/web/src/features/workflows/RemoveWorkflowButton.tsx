import { useRef } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useQueryClient, type InfiniteData } from '@tanstack/react-query'
import type { WorkflowArchiveInput } from '@graphql/contracts/management'
import type { apiClient } from '../../shared/api/client'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { queryKeys, useArchiveManagedWorkflowMutation } from '../../shared/api/query'
import { Icon, IconButton } from '../../shared/ui/nocturne'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftKey } from '../graph/nextDraft/state'

export function RemoveWorkflowButton({ workspaceId, workflowId, name, revision }: {
  workspaceId: string; workflowId: string; name: string; revision: number
}) {
  const mutation = useArchiveManagedWorkflowMutation()
  const client = useQueryClient()
  const router = useRouter()
  const attempt = useRef(new CommandAttempt<Omit<WorkflowArchiveInput, 'commandId'>>())
  const original = useRef<{ workspaceId: string; workflowId: string; expectedRevision: number } | undefined>(undefined)
  const inFlight = useRef(false)
  const remove = async () => {
    if (inFlight.current) return
    inFlight.current = true
    const generation = sessionGeneration()
    try {
      if (!attempt.current.unresolved) original.current = { workspaceId, workflowId, expectedRevision: revision }
      const result = await mutation.mutateAsync(attempt.current.input(original.current!))
      assertSession(generation)
      attempt.current.succeeded()
      client.setQueryData(queryKeys.managedWorkflow(workspaceId, workflowId), result.value)
      client.setQueriesData<InfiniteData<Awaited<ReturnType<typeof apiClient.listManagedWorkflowPage>>>>({ queryKey: [...queryKeys.managedWorkflows(workspaceId), 'pages'] },
        (current) => current ? { ...current, pages: current.pages.map((page) => ({ ...page,
          items: page.items.filter((item) => item.workflow.id !== workflowId) })) } : current)
      const location = router.state.location
      if (location.pathname === `/workspaces/${encodeURIComponent(workspaceId)}` && location.search.workflowId === workflowId) {
        await router.navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, search: {}, replace: true })
      }
      useGraphDraftStore.getState().dropNextDraft(nextDraftKey(workspaceId, workflowId))
      void client.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) })
      void client.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
    } catch (error) { attempt.current.failed(error) }
    finally { inFlight.current = false }
  }
  return <>
    <IconButton label={mutation.isError ? `Retry removing ${name}` : `Remove ${name}`} variant="ghost" size="sm"
      className="workflow-navigation-remove" disabled={mutation.isPending} onClick={() => void remove()}>
      <Icon name="trash" size={14} />
    </IconButton>
    {mutation.isError ? <p className="workflow-navigation-remove-error" role="alert">{mutation.error.message}</p> : null}
  </>
}
