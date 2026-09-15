import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

import { useManagedWorkspaceQuery } from '../../shared/api/query'
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
        <span>{workspace.isPending ? 'Checking the execution folder…'
          : current?.locationValidation.status === 'restricted' ? 'Execution folder access is restricted.'
            : 'Configure an available execution folder before starting this workflow.'}</span>
        <Link to="/workspaces/$workspaceId/settings" params={{ workspaceId }} search={{}}>
          Configure execution folder
        </Link>
      </aside> : null}
      <div className="workspace-execution-content">{children}</div>
    </div>
  )
}
