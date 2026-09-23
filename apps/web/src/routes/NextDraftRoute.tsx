import { useParams } from '@tanstack/react-router'

import { NextDraftEditor } from '../features/graph/nextDraft/NextDraftEditor'

export function NextDraftRoute() {
  const { workspaceId, workflowId } = useParams({ from: '/workspaces/$workspaceId/workflows/$workflowId/draft' })
  return <NextDraftEditor key={JSON.stringify([workspaceId, workflowId])} workspaceId={workspaceId} workflowId={workflowId} />
}
