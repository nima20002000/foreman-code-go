import { useCallback, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

import { AgentsDirectory } from '../features/agents'
import { McpDetectionSettings, WorkflowDefaultsSettings, WorkspaceExecutionLocationSettings } from '../features/settings'
import { ApprovalInbox } from '../features/approvals'
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
          <div className="coming-soon-page n-theme" data-testid="coming-soon">
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
          <div className="coming-soon-page n-theme" data-testid="coming-soon">
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
  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      activeSection="settings"
      slots={{
        main: (
          <div className="settings-page">
            <PageHeader
              eyebrow={`Workspace · ${workspaceId}`}
              title="Settings"
              description="Configure workspace-level preferences and connected capabilities."
            />
            <ul className="settings-card-list">
              <li>
                <Card className="settings-card">
                  <Link to="/workspaces/$workspaceId/settings/location" params={{ workspaceId }} className="settings-card-open">
                    <SettingsCardBody icon="folder" title="Execution location" description="Folder where this workspace's agents run" />
                  </Link>
                </Card>
              </li>
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
      <span className="settings-card-icon"><Icon name={icon} size={18} /></span>
      <span className="settings-card-copy">
        <strong>{title}</strong>
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
    <div className="settings-page">
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
            <h2 className="settings-group-heading" id="settings-operations-heading">Operations</h2>
            <ul className="settings-card-list" aria-labelledby="settings-operations-heading">
              <li>
                <Card className="settings-card">
                  <Link to="/approvals" className="settings-card-open">
                    <SettingsCardBody icon="shield" title="Approval Inbox" description="Global review queue and delivery history" />
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
  const { interactionId, approvalView } = useSearch({ from: '/approvals' })
  const navigate = useNavigate({ from: '/approvals' })
  return <WorkspaceShell workspaceId="workspace-1" activeGlobalSection="settings" slots={{ main:
    <SettingsDetailPage title="Approval Inbox" description="Global review queue and delivery history." backLink={<SettingsBackLink />}>
      <ApprovalInbox embedded selectedInteractionId={interactionId} view={approvalView}
        onChangeView={(next) => void navigate({ search: (previous) => ({ ...previous, approvalView: next, interactionId: undefined }) })}
        onSelectInteraction={(next) => void navigate({ search: (previous) => ({ ...previous, interactionId: next }) })} />
    </SettingsDetailPage> }} />
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
    <SettingsDetailPage eyebrow={`Workspace · ${workspaceId}`} title="Execution location"
      description="Agents start in this folder. Filesystem restrictions depend on the selected harness and future isolation support."
      backLink={<Link to="/workspaces/$workspaceId/settings" params={{ workspaceId }} className="settings-back-link" aria-label="Back to settings">
        <ArrowLeft aria-hidden="true" size={14} />Settings
      </Link>}>
      <WorkspaceExecutionLocationSettings key={workspaceId} workspaceId={workspaceId} />
    </SettingsDetailPage> }} />
}
