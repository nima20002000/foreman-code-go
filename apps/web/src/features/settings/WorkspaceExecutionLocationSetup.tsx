import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

import { useManagedWorkspaceQuery } from '../../shared/api/query'
import { Alert } from '../../shared/ui/nocturne'
import './workspaceLocation.css'

/** Visible recovery next to the workflow surface, not just a disabled Start tooltip. */
export function WorkspaceExecutionLocationSetup({ workspaceId, children, enabled }: {
  workspaceId: string
  children: ReactNode
  enabled: boolean
}) {
  const workspace = useManagedWorkspaceQuery(workspaceId, enabled)
  const current = workspace.data?.workspace.id === workspaceId ? workspace.data : undefined
  if (!enabled) return <>{children}</>
  const ready = current?.locationValidation.status === 'ready'
  return (
    <div className="workspace-execution-surface">
      {!ready ? <aside className="workspace-location-setup" aria-label="Execution folder setup">
        <Alert tone={workspace.isPending ? 'info' : 'warning'} title={workspace.isPending ? 'Checking the execution folder…'
          : current?.locationValidation.status === 'restricted' ? 'Execution folder access is restricted.'
            : 'Configure an available execution folder before starting this workflow.'}
          action={<Link to="/workspaces/$workspaceId/settings/location" params={{ workspaceId }}>
            Configure execution folder
          </Link>} />
      </aside> : null}
      <div className="workspace-execution-content">{children}</div>
    </div>
  )
}
