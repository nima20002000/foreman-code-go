import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useManagedWorkspaceQuery } from '../../shared/api/query'
import { Button, ErrorState, LoadingState, PageHeader } from '../../shared/ui/nocturne'
import { WorkspaceSettingsHeader } from './WorkspaceSettingsHeader'
import { WorkspaceRepositoryForm } from './WorkspaceRepositoryForm'
import '../settings/settingsExperience.css'

export function WorkspaceDetailPage({ workspaceId, section, children }: {
  workspaceId: string; section: 'files' | 'workflows' | 'settings'; children?: ReactNode
}) {
  const workspace = useManagedWorkspaceQuery(workspaceId)
  const current = workspace.data?.workspace.id === workspaceId ? workspace.data : undefined
  const title = section === 'files' ? 'Project files' : section === 'workflows' ? 'Workflows' : 'Settings'
  const unavailable = workspace.isError
    ? <ErrorState title="Workspace unavailable" description={workspace.error.message} onRetry={() => void workspace.refetch()} retrying={workspace.isFetching} />
    : <LoadingState label="Loading workspace…" rows={3} />
  const content = (actions: { rename(): void; remove(): void; chooseLocation(): void }) => <div className="settings-editor-layout">
      <nav className="settings-editor-nav workspace-detail-nav" aria-label="Workspace sections">
        <Link to="/workspaces/$workspaceId/files" params={{ workspaceId }} aria-current={section === 'files' ? 'page' : undefined}>Project files<span aria-hidden="true">›</span></Link>
        <Link to="/workspaces/$workspaceId/workflows" params={{ workspaceId }} aria-current={section === 'workflows' ? 'page' : undefined}>Workflows<span aria-hidden="true">›</span></Link>
        <Link to="/workspaces/$workspaceId/settings" params={{ workspaceId }} aria-current={section === 'settings' ? 'page' : undefined}>Settings<span aria-hidden="true">›</span></Link>
      </nav>
      <div className={`settings-editor-content workspace-detail-content${section === 'settings' ? ' workspace-detail-content--settings' : ''}`}>
        {children ?? <>
          {workspace.isError && unavailable}
          <div hidden={workspace.isError}>
            <div className="workspace-settings-actions" role="group" aria-label="Workspace actions">
              <Button variant="ghost" onClick={actions.rename}>Rename workspace</Button>
              <Button variant="ghost" onClick={actions.chooseLocation}>Choose location</Button>
              <Button variant="danger" onClick={actions.remove}>Remove workspace</Button>
            </div>
            {current && <WorkspaceRepositoryForm key={workspaceId} workspaceId={workspaceId}
              revision={current.revision} repository={current.workspace.repository} />}
          </div>
        </>}
      </div>
    </div>
  return <div className="settings-page settings-experience workspace-detail-page">
    {current ? <WorkspaceSettingsHeader key={workspaceId} workspaceId={workspaceId} name={current.workspace.name} revision={current.revision} title={title} renderContent={content} />
      : <><PageHeader eyebrow="Workspace" title={title} />{unavailable}</>}
  </div>
}
