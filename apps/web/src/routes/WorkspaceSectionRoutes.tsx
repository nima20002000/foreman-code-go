import { useCallback } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'

import { AgentsDirectory } from '../features/agents'
import { WorkspaceShell, type WorkspaceSection } from '../shared/ui/WorkspaceShell'
import type { GlobalNavigationSection } from '../features/workspaces'

export function AgentsRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/agents' })
  const { agentId } = useSearch({ from: '/workspaces/$workspaceId/agents' })
  const navigate = useNavigate({ from: '/workspaces/$workspaceId/agents' })
  const selectAgent = useCallback((nextAgentId: string) => {
    void navigate({ search: (previous) => ({ ...previous, agentId: nextAgentId }) })
  }, [navigate])
  const clearAgent = useCallback(() => {
    void navigate({
      replace: true,
      search: (previous) => {
        const next = { ...previous }
        delete next.agentId
        return next
      },
    })
  }, [navigate])
  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      activeSection="agents"
      activeAgentId={agentId}
      slots={{
        main: (
          <AgentsDirectory
            workspaceId={workspaceId}
            selectedAgentId={agentId}
            onSelectAgent={selectAgent}
            onClearAgent={clearAgent}
          />
        ),
      }}
    />
  )
}

export function ComingSoonRouteEntry({ section, label }: { section: WorkspaceSection; label: string }) {
  const params = useParams({ strict: false })
  const workspaceId = 'workspaceId' in params && typeof params.workspaceId === 'string'
    ? params.workspaceId
    : 'workspace-1'

  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      activeSection={section === 'terminal' || section === 'settings' ? 'workflows' : section}
      activeGlobalSection={section === 'terminal' || section === 'settings' ? section : undefined}
      slots={{
        main: (
          <div className="coming-soon-page" data-testid="coming-soon">
            <p className="panel-kicker">Phase 1</p>
            <h1>{label}</h1>
            <p>Coming soon</p>
            <span>This destination is part of the workspace plan, but it is not implemented yet.</span>
          </div>
        ),
      }}
    />
  )
}

export function GlobalComingSoonRouteEntry({
  section,
  label,
}: {
  section: GlobalNavigationSection
  label: string
}) {
  return (
    <WorkspaceShell
      workspaceId="workspace-1"
      activeGlobalSection={section}
      slots={{
        main: (
          <div className="coming-soon-page" data-testid="coming-soon">
            <p className="panel-kicker">GraphQL</p>
            <h1>{label}</h1>
            <p>Coming soon</p>
            <span>This destination is available globally and is not connected in Phase 1.</span>
          </div>
        ),
      }}
    />
  )
}

function SettingsPage({ browsersSelected = false }: { browsersSelected?: boolean }) {
  const params = useParams({ strict: false })
  const workspaceId = 'workspaceId' in params && typeof params.workspaceId === 'string'
    ? params.workspaceId
    : 'workspace-1'

  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      activeSection="workflows"
      activeGlobalSection="settings"
      slots={{
        main: (
          <div className="settings-page">
            <header>
              <p className="panel-kicker">Workspace</p>
              <h1>Settings</h1>
              <p>Configure workspace-level preferences and connected capabilities.</p>
            </header>
            <nav aria-label="Settings sections">
              <a href={`/workspaces/${encodeURIComponent(workspaceId)}/browsers`} aria-current={browsersSelected ? 'page' : undefined}>
                <span>
                  <strong>Browsers</strong>
                  <small>Browser profiles and access</small>
                </span>
                <span className="settings-coming-soon">Coming soon</span>
              </a>
            </nav>
            {browsersSelected ? (
              <section className="settings-section" aria-labelledby="browsers-settings-title">
                <h2 id="browsers-settings-title">Browsers</h2>
                <p>Coming soon</p>
                <span>Browser profile management is planned, but no browser capability is connected in Phase 1.</span>
              </section>
            ) : null}
          </div>
        ),
      }}
    />
  )
}

export function SettingsRouteEntry() {
  return <SettingsPage />
}

export function GlobalSettingsRouteEntry() {
  return (
    <WorkspaceShell
      workspaceId="workspace-1"
      activeGlobalSection="settings"
      slots={{
        main: (
          <div className="settings-page">
            <header>
              <p className="panel-kicker">GraphQL</p>
              <h1>Settings</h1>
              <p>Configure application preferences and connected capabilities.</p>
            </header>
          </div>
        ),
      }}
    />
  )
}

export function BrowsersSettingsRouteEntry() {
  return <SettingsPage browsersSelected />
}
