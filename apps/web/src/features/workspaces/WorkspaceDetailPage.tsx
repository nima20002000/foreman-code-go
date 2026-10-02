import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useManagedWorkspaceQuery } from '../../shared/api/query'
import { Button, PageHeader } from '../../shared/ui/nocturne'
import { WorkspaceSettingsHeader } from './WorkspaceSettingsHeader'
import '../settings/settingsExperience.css'

export function WorkspaceDetailPage({ workspaceId, section, children }: {
  workspaceId: string; section: 'files' | 'workflows' | 'settings'; children?: ReactNode
}) {
  const workspace = useManagedWorkspaceQuery(workspaceId)
  const current = workspace.data?.workspace.id === workspaceId ? workspace.data : undefined
  const title = section === 'files' ? 'Project files' : section === 'workflows' ? 'Workflows' : 'Settings'
  const content = (actions?: { rename(): void; remove(): void; chooseLocation(): void }) => <div className="settings-editor-layout">
      <nav className="settings-editor-nav workspace-detail-nav" aria-label="Workspace sections">
        <Link to="/workspaces/$workspaceId/files" params={{ workspaceId }} aria-current={section === 'files' ? 'page' : undefined}>Project files<span aria-hidden="true">›</span></Link>
        <Link to="/workspaces/$workspaceId/workflows" params={{ workspaceId }} aria-current={section === 'workflows' ? 'page' : undefined}>Workflows<span aria-hidden="true">›</span></Link>
        <Link to="/workspaces/$workspaceId/settings" params={{ workspaceId }} aria-current={section === 'settings' ? 'page' : undefined}>Settings<span aria-hidden="true">›</span></Link>
      </nav>
      <div className="settings-editor-content workspace-detail-content">
        {children ?? <div className="workspace-settings-summary">
          <h2>Workspace settings</h2>
          <div className="settings-simple-row"><div><strong>Name</strong><p>{current?.workspace.name}</p></div><Button disabled={!actions} onClick={actions?.rename}>Rename workspace</Button></div>
          <div className="settings-simple-row"><div><strong>Execution location</strong></div><Button disabled={!actions} onClick={actions?.chooseLocation}>Choose location</Button></div>
          <div className="settings-simple-row"><div><strong>Remove workspace</strong></div><Button variant="danger" disabled={!actions} onClick={actions?.remove}>Remove workspace</Button></div>
        </div>}
      </div>
    </div>
  return <div className="settings-page settings-experience workspace-detail-page">
    <Link to="/workspaces" className="settings-back-link" aria-label="Back to workspaces"><span aria-hidden="true">←</span> Workspaces</Link>
    {current ? <WorkspaceSettingsHeader key={workspaceId} workspaceId={workspaceId} name={current.workspace.name} revision={current.revision} title={title} renderContent={content} />
      : <><PageHeader eyebrow="Workspace" title={title} />{content()}</>}
  </div>
}
