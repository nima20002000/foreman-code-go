import { Link } from '@tanstack/react-router'
import { useManagedWorkflowsQuery } from '../../shared/api/query'
import { Button, Card, Icon } from '../../shared/ui/nocturne'
import './workflows.css'
import './workspaceWorkflowList.css'

export function WorkspaceWorkflowList({ workspaceId }: { workspaceId: string }) {
  const query = useManagedWorkflowsQuery(workspaceId)
  const workflows = query.data?.items ?? []

  return (
    <section className="workspace-settings-workflows" aria-label="Workflows">
      <h2><Icon name="folder" size={18} />Workflows</h2>
      {query.isPending ? <p role="status">Loading workflows…</p> : null}
      {query.isError ? <div role="alert">Workflows unavailable. <Button size="sm" onClick={() => void query.refetch()}>Retry</Button></div> : null}
      {query.isSuccess && workflows.length === 0 ? <p>No workflows yet</p> : null}
      {workflows.length > 0 ? (
        <ul className="workflow-card-list">
          {workflows.map(({ workflow }) => (
            <li key={workflow.id} className="workflow-card-item">
              <Card className="workflow-card">
                <Link to="/workspaces/$workspaceId" params={{ workspaceId }} search={{ workflowId: workflow.id }} className="workflow-card-open">
                  <Icon name="workflow" size={18} />
                  <span>{workflow.name}</span>
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
