import { useCallback } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'

import { AgentsDirectory } from '../features/agents'
import { AgentDefaultsSettings, HarnessDefaultsSettings, McpDetectionSettings, OperatorAccessSettings, WorkflowDefaultsSettings, WorkspaceExecutionLocationSettings } from '../features/settings'
import { ApprovalInbox } from '../features/approvals'
import { WorkflowDirectory } from '../features/workflows'
import { WorkspaceShell, type WorkspaceSection } from '../shared/ui/WorkspaceShell'
import {
  WorkspaceDirectory,
  useNavigationUiStore,
  type GlobalNavigationSection,
} from '../features/workspaces'

export function WorkspacesRouteEntry() {
  const activeWorkspaceId = useNavigationUiStore((state) => state.activeWorkspaceId)

  return (
    <WorkspaceShell
      workspaceId={activeWorkspaceId ?? 'workspace-1'}
      workspaceOverviewActive
      slots={{ main: <WorkspaceDirectory /> }}
    />
  )
}

export function AgentsRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/agents' })
  const { agentId } = useSearch({ from: '/workspaces/$workspaceId/agents' })
  const navigate = useNavigate({ from: '/workspaces/$workspaceId/agents' })
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
      slots={{
        main: (
          <AgentsDirectory
            workspaceId={workspaceId}
            selectedAgentId={agentId}
            onClearAgent={clearAgent}
          />
        ),
      }}
    />
  )
}

export function WorkflowsRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/workflows' })

  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      activeSection="workflows"
      slots={{ main: <WorkflowDirectory workspaceId={workspaceId} /> }}
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
      activeSection="settings"
      slots={{
        main: (
          <div className="settings-page">
            <header>
              <p className="panel-kicker">Workspace · {workspaceId}</p>
              <h1>Settings</h1>
              <p>Configure workspace-level preferences and connected capabilities.</p>
            </header>
            <nav aria-label="Settings sections">
              <Link to="/workspaces/$workspaceId/browsers" params={{ workspaceId }} aria-current={browsersSelected ? 'page' : undefined}>
                <span>
                  <strong>Browsers</strong>
                  <small>Browser profiles and access</small>
                </span>
                <span className="settings-coming-soon">Coming soon</span>
              </Link>
            </nav>
            {!browsersSelected ? <><WorkspaceExecutionLocationSettings key={workspaceId} workspaceId={workspaceId} /><McpDetectionSettings workspaceId={workspaceId} /></> : null}
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

function GlobalSettingsPage({ selected }: { selected?: 'harnesses' | 'agents' | 'workflows' }) {
  const detectionWorkspaceId = useNavigationUiStore((state) => state.activeWorkspaceId)
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
            <nav aria-label="Settings sections">
              <Link to="/settings/harnesses" aria-current={selected === 'harnesses' ? 'page' : undefined}>
                <span>
                  <strong>Harnesses</strong>
                  <small>Provider presets</small>
                </span>
              </Link>
              <Link to="/settings/agents" aria-current={selected === 'agents' ? 'page' : undefined}>
                <span><strong>Agents</strong><small>Orchestrator, Coder and Operator templates</small></span>
              </Link>
              <Link to="/settings/workflows" aria-current={selected === 'workflows' ? 'page' : undefined}>
                <span><strong>Workflows</strong><small>Defaults for new workflows</small></span>
              </Link>
              <Link to="/approvals"><span><strong>Approval Inbox</strong><small>Global review queue and delivery history</small></span></Link>
            </nav>
            <OperatorAccessSettings />
            {selected === 'harnesses' ? <HarnessDefaultsSettings /> : null}
            {selected === 'agents' ? <AgentDefaultsSettings /> : null}
            {selected === 'workflows' ? <WorkflowDefaultsSettings /> : null}
            {selected === 'harnesses' || selected === 'agents' ? detectionWorkspaceId
              ? <McpDetectionSettings workspaceId={detectionWorkspaceId} />
              : <p>Select a workspace from navigation to inspect its runner-scoped App MCP evidence.</p> : null}
          </div>
        ),
      }}
    />
  )
}

export function GlobalSettingsRouteEntry() {
  return <GlobalSettingsPage />
}

export function HarnessSettingsRouteEntry() {
  return <GlobalSettingsPage selected="harnesses" />
}

export function AgentSettingsRouteEntry() { return <GlobalSettingsPage selected="agents" /> }
export function WorkflowSettingsRouteEntry() { return <GlobalSettingsPage selected="workflows" /> }

export function GlobalApprovalsRouteEntry() {
  const { interactionId, approvalView } = useSearch({ from: '/approvals' })
  const navigate = useNavigate({ from: '/approvals' })
  return <WorkspaceShell workspaceId="workspace-1" slots={{ main: <ApprovalInbox selectedInteractionId={interactionId} view={approvalView}
    onChangeView={(next) => void navigate({ search: (previous) => ({ ...previous, approvalView: next, interactionId: undefined }) })}
    onSelectInteraction={(next) => void navigate({ search: (previous) => ({ ...previous, interactionId: next }) })} /> }} />
}

export function WorkspaceApprovalsRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/approvals' })
  const { workflowId, interactionId, approvalView } = useSearch({ from: '/workspaces/$workspaceId/approvals' })
  const navigate = useNavigate({ from: '/workspaces/$workspaceId/approvals' })
  return <WorkspaceShell workspaceId={workspaceId} activeSection="workflows" slots={{ main: <ApprovalInbox workspaceId={workspaceId} workflowId={workflowId} selectedInteractionId={interactionId} view={approvalView}
    onChangeView={(next) => void navigate({ search: (previous) => ({ ...previous, approvalView: next, interactionId: undefined }) })}
    onSelectInteraction={(next) => void navigate({ search: (previous) => ({ ...previous, interactionId: next }) })} /> }} />
}

export function BrowsersSettingsRouteEntry() {
  return <SettingsPage browsersSelected />
}
