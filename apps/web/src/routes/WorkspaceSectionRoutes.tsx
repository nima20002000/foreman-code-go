import { useCallback, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  Inbox,
  KeyRound,
  SlidersHorizontal,
  Workflow,
  type LucideIcon,
} from 'lucide-react'

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

function SettingsCardBody({ icon: Icon, title, description }: {
  icon: LucideIcon
  title: string
  description: string
}) {
  return (
    <>
      <span className="settings-card-icon"><Icon aria-hidden="true" size={18} /></span>
      <span className="settings-card-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <ChevronRight aria-hidden="true" className="settings-card-chevron" size={16} />
    </>
  )
}

function SettingsBackLink() {
  return (
    <Link to="/settings" className="settings-back-link" aria-label="Back to settings">
      <ArrowLeft aria-hidden="true" size={14} />Settings
    </Link>
  )
}

function SettingsDetailPage({ title, description, backLink, children }: {
  title: string
  description: string
  backLink: ReactNode
  children: ReactNode
}) {
  return (
    <div className="settings-page">
      <header>
        {backLink}
        <p className="panel-kicker">GraphQL</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      {children}
    </div>
  )
}

function McpDetectionSection({ workspaceId }: { workspaceId?: string }) {
  return workspaceId
    ? <McpDetectionSettings workspaceId={workspaceId} />
    : <p className="settings-state">Select a workspace from navigation to inspect its runner-scoped App MCP evidence.</p>
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
            <ul className="settings-card-list">
              <li className="settings-card">
                <Link to="/settings/harnesses" className="settings-card-open">
                  <SettingsCardBody icon={SlidersHorizontal} title="Harnesses" description="Provider presets" />
                </Link>
              </li>
              <li className="settings-card">
                <Link to="/settings/agents" className="settings-card-open">
                  <SettingsCardBody icon={Bot} title="Agents" description="Orchestrator, Coder and Operator templates" />
                </Link>
              </li>
              <li className="settings-card">
                <Link to="/settings/workflows" className="settings-card-open">
                  <SettingsCardBody icon={Workflow} title="Workflows" description="Defaults for new workflows" />
                </Link>
              </li>
              <li className="settings-card">
                <Link to="/approvals" className="settings-card-open">
                  <SettingsCardBody icon={Inbox} title="Approval Inbox" description="Global review queue and delivery history" />
                </Link>
              </li>
              <li className="settings-card">
                <Link to="/settings/operator-access" className="settings-card-open">
                  <SettingsCardBody icon={KeyRound} title="Operator access" description="Enroll this browser with a local credential" />
                </Link>
              </li>
            </ul>
          </div>
        ),
      }}
    />
  )
}

export function HarnessSettingsRouteEntry() {
  const detectionWorkspaceId = useNavigationUiStore((state) => state.activeWorkspaceId)
  return (
    <WorkspaceShell
      workspaceId="workspace-1"
      activeGlobalSection="settings"
      slots={{
        main: (
          <SettingsDetailPage
            title="Harnesses"
            description="Provider presets. Role templates under Agents determine new board Agent defaults; existing Agents never change."
            backLink={<SettingsBackLink />}
          >
            <HarnessDefaultsSettings />
            <McpDetectionSection workspaceId={detectionWorkspaceId} />
          </SettingsDetailPage>
        ),
      }}
    />
  )
}

export function AgentSettingsRouteEntry() {
  const detectionWorkspaceId = useNavigationUiStore((state) => state.activeWorkspaceId)
  return (
    <WorkspaceShell
      workspaceId="workspace-1"
      activeGlobalSection="settings"
      slots={{
        main: (
          <SettingsDetailPage
            title="Agents"
            description="Copied into new Agents. Existing Agents and accepted runs stay pinned."
            backLink={<SettingsBackLink />}
          >
            <AgentDefaultsSettings />
            <McpDetectionSection workspaceId={detectionWorkspaceId} />
          </SettingsDetailPage>
        ),
      }}
    />
  )
}

export function WorkflowSettingsRouteEntry() {
  return (
    <WorkspaceShell
      workspaceId="workspace-1"
      activeGlobalSection="settings"
      slots={{
        main: (
          <SettingsDetailPage
            title="Workflows"
            description="New workflows copy this handler. Existing and in-flight approvals do not change."
            backLink={<SettingsBackLink />}
          >
            <WorkflowDefaultsSettings />
          </SettingsDetailPage>
        ),
      }}
    />
  )
}

export function OperatorAccessSettingsRouteEntry() {
  return (
    <WorkspaceShell
      workspaceId="workspace-1"
      activeGlobalSection="settings"
      slots={{
        main: (
          <SettingsDetailPage
            title="Operator access"
            description="Enroll this browser with a scoped local credential. It is kept in an HttpOnly cookie, not browser storage."
            backLink={<SettingsBackLink />}
          >
            <OperatorAccessSettings />
          </SettingsDetailPage>
        ),
      }}
    />
  )
}

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
