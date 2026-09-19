import { Link } from '@tanstack/react-router'
import { useManagedWorkflowsQuery } from '../../shared/api/query'
import { Button, Icon, SettingsSection } from '../../shared/ui/nocturne'
import './workspaceWorkflowList.css'

export function WorkspaceWorkflowList({ workspaceId }: { workspaceId: string }) {
  const query = useManagedWorkflowsQuery(workspaceId)
  const workflows = query.data?.items ?? []

  return (
    <SettingsSection title="Workflows">
      {query.isPending ? <p role="status">Loading workflows…</p> : null}
      {query.isError ? <div role="alert">Workflows unavailable. <Button size="sm" onClick={() => void query.refetch()}>Retry</Button></div> : null}
      {query.isSuccess && workflows.length === 0 ? <p>No workflows yet</p> : null}
      {workflows.length > 0 ? (
        <ul className="workspace-settings-workflows">
          {workflows.map(({ workflow }) => (
            <li key={workflow.id}>
              <Link to="/workspaces/$workspaceId" params={{ workspaceId }} search={{ workflowId: workflow.id }}>
                <span>{workflow.name}</span>
                <Icon name="chevron" size={16} />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsSection>
  )
}
