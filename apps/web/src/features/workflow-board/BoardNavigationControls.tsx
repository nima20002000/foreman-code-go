import { useQuery } from '@tanstack/react-query'
import { Toolbar } from '../../shared/ui/nocturne'
import { RunsSelector, type useSelectedRun } from '../runs-selector'
import { ScheduleClockButton } from '../schedules'
import { WorkflowFilesButton } from '../workflow-files'
import { nextDraftApi } from '../graph/nextDraft/transport'
import { WorkflowJobsButton } from './WorkflowJobsButton'
import { boardDraftContextKey } from './keys'
import { useWorkflowBoard } from './context'

export function BoardNavigationControls({ workspaceId, workflowId, selection }: {
  workspaceId: string; workflowId: string; selection: ReturnType<typeof useSelectedRun>
}) {
  const board = useWorkflowBoard()
  const saved = useQuery({ queryKey: boardDraftContextKey(workspaceId, workflowId),
    queryFn: ({ signal }) => nextDraftApi.context(workspaceId, workflowId, { signal }), staleTime: 3000, retry: false })
  return <Toolbar label="Board controls">
    <RunsSelector selection={selection} />
    <WorkflowJobsButton workspaceId={workspaceId} workflowId={workflowId} />
    <ScheduleClockButton workspaceId={workspaceId} workflowId={workflowId} isSaved={Boolean(saved.data?.draft.baseWorkflowVersionId)} />
    <WorkflowFilesButton workspaceId={workspaceId} workflowId={workflowId} readOnly={Boolean(board?.run) || selection.identity.runId !== null} />
  </Toolbar>
}
