import { useCallback, useEffect, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

import { useManagedWorkspaceQuery } from '../shared/api/query'
import '../shared/ui/resourceDirectory.css'

import { AgentsDirectory } from '../features/agents'
import { McpDetectionSettings, WorkflowDefaultsSettings, WorkspaceExecutionLocationSettings } from '../features/settings'
import { useApprovalInboxStore } from '../features/approvals'
import { WorkflowDirectory } from '../features/workflows'
import { Badge, Card, EmptyState, Icon, PageHeader, SettingsSection, type IconName } from '../shared/ui/nocturne'
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
            <p className="n-eyebrow">GraphQL</p>
            <EmptyState
              icon="clock"
              title={label}
              description="This destination is part of the workspace plan, but it is not implemented yet."
              action={<Badge tone="neutral">Coming soon</Badge>}
            />
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
            <p className="n-eyebrow">GraphQL</p>
            <EmptyState
              icon="clock"
              title={label}
              description="This destination is not implemented yet."
              action={<Badge tone="neutral">Coming soon</Badge>}
            />
          </div>
        ),
      }}
    />
  )
}

export function SettingsRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/settings' })
  const workspace = useManagedWorkspaceQuery(workspaceId)
  const name = workspace.data?.workspace.id === workspaceId ? workspace.data.workspace.name : undefined
  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      activeSection="settings"
      slots={{
        main: (
          <div className="settings-page workspace-overview">
            <PageHeader
              eyebrow={name ?? 'Workspace'}
              title="Settings"
            />
            <ul className="settings-card-list">
              {workspace.data?.locationValidation.status === 'ready' ? <li>
                <WorkspaceExecutionLocationSettings workspaceId={workspaceId} presentation="tile" />
              </li> : null}
              <li>
                <Card className="settings-card">
                  <Link to="/workspaces/$workspaceId/browsers" params={{ workspaceId }} className="settings-card-open">
                    <SettingsCardBody icon="globe" title="Browsers" description="Browser profiles and access" />
                  </Link>
                </Card>
              </li>
            </ul>
            <McpDetectionSettings workspaceId={workspaceId} />
          </div>
        ),
      }}
    />
  )
}

function SettingsCardBody({ icon, title, description }: {
  icon: IconName
  title: string
  description: string
}) {
  return (
    <>
      <span className="settings-card-icon"><Icon name={icon} size={16} /></span>
      <span className="settings-card-copy">
        <strong>{title}</strong>{' '}
        <small>{description}</small>
      </span>
      <Icon className="settings-card-chevron" name="chevron" size={16} />
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

function SettingsDetailPage({ eyebrow = 'GraphQL', title, description, backLink, children }: {
  eyebrow?: string
  title: string
  description: string
  backLink: ReactNode
  children: ReactNode
}) {
  return (
    <div className="settings-page workspace-detail">
      {backLink}
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      {children}
    </div>
  )
}

export { AgentSettingsRouteEntry, HarnessSettingsRouteEntry, OperatorAccessSettingsRouteEntry } from './SettingsExperienceRoutes'

export function GlobalSettingsRouteEntry() {
  return (
    <WorkspaceShell
      workspaceId="workspace-1"
      activeGlobalSection="settings"
      slots={{
        main: (
          <div className="settings-page settings-hub">
            <PageHeader
              eyebrow="GraphQL"
              title="Settings"
              description="Configure application preferences and connected capabilities."
            />
            <h2 className="settings-group-heading" id="settings-defaults-heading">Defaults</h2>
            <ul className="settings-card-list" aria-labelledby="settings-defaults-heading">
              <li>
                <Card className="settings-card">
                  <Link to="/settings/workspaces" className="settings-card-open">
                    <SettingsCardBody icon="folder" title="Workspaces" description="Defaults for new workspaces" />
                  </Link>
                </Card>
              </li>
              <li>
                <Card className="settings-card">
                  <Link to="/settings/harnesses" className="settings-card-open">
                    <SettingsCardBody icon="settings" title="Harnesses" description="Provider presets" />
                  </Link>
                </Card>
              </li>
              <li>
                <Card className="settings-card">
                  <Link to="/settings/agents" className="settings-card-open">
                    <SettingsCardBody icon="bot" title="Agents" description="Orchestrator, Coder and Operator templates" />
                  </Link>
                </Card>
              </li>
              <li>
                <Card className="settings-card">
                  <Link to="/settings/workflows" className="settings-card-open">
                    <SettingsCardBody icon="workflow" title="Workflows" description="Defaults for new workflows" />
                  </Link>
                </Card>
              </li>
            </ul>
          </div>
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

export function GlobalApprovalsRouteEntry() {
  // Old bookmarks lead to workspace choice, never a global queue or a guessed scope.
  return <WorkspacesRouteEntry />
}

export function WorkspaceApprovalsRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/approvals' })
  const { workflowId } = useSearch({ from: '/workspaces/$workspaceId/approvals' })
  const navigate = useNavigate({ from: '/workspaces/$workspaceId/approvals' })
  useEffect(() => {
    useApprovalInboxStore.getState().openInbox({ workspaceId, workflowId })
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, search: workflowId ? { workflowId } : {}, replace: true })
  }, [navigate, workflowId, workspaceId])
  return null
}

export function BrowsersSettingsRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/browsers' })
  return <WorkspaceShell workspaceId={workspaceId} activeSection="settings" slots={{ main:
    <SettingsDetailPage eyebrow={`Workspace · ${workspaceId}`} title="Browsers"
      description="Browser profiles this workspace's agents are allowed to drive."
      backLink={<Link to="/workspaces/$workspaceId/settings" params={{ workspaceId }} className="settings-back-link" aria-label="Back to settings">
        <ArrowLeft aria-hidden="true" size={14} />Settings
      </Link>}>
      <SettingsSection title="Browsers" description="Coming soon">
        <p>Browser profile management is planned but is not implemented yet.</p>
      </SettingsSection>
    </SettingsDetailPage> }} />
}

export function WorkspaceLocationSettingsRouteEntry() {
  const { workspaceId } = useParams({ from: '/workspaces/$workspaceId/settings/location' })
  return <WorkspaceShell workspaceId={workspaceId} activeSection="settings" slots={{ main:
    <div className="settings-page workspace-detail">
      <Link to="/workspaces/$workspaceId/settings" params={{ workspaceId }} className="settings-back-link" aria-label="Back to settings">
        <ArrowLeft aria-hidden="true" size={14} />Settings
      </Link>
      <WorkspaceExecutionLocationSettings key={workspaceId} workspaceId={workspaceId} presentation="card" />
    </div> }} />
}
