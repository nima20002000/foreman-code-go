import { useState, type ReactNode } from 'react'
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  History,
  ListTodo,
  PanelsTopLeft,
  Settings,
  SquareTerminal,
} from 'lucide-react'

import { ThemeToggle } from '../../features/theme'

export interface WorkspaceShellSlots {
  /** Content for the workspace slot in the header. */
  workspace?: ReactNode
  /** Content for the runner slot in the header. */
  runner?: ReactNode
  /** Center graph surface. */
  graph?: ReactNode
  /** Right-hand context surface. */
  context?: ReactNode
  /** Bottom terminal surface. */
  terminal?: ReactNode
  /** Non-graph workspace content, such as a directory page. */
  main?: ReactNode
}

export type WorkspaceSection = 'workspaces' | 'agents' | 'tasks' | 'runs' | 'terminal' | 'settings'

export interface WorkspaceShellProps {
  workspaceId: string
  slots?: WorkspaceShellSlots
  activeSection?: WorkspaceSection
}

const navigationItems = [
  { section: 'workspaces', label: 'Workspaces', path: '', icon: PanelsTopLeft },
  { section: 'agents', label: 'Agents', path: '/agents', icon: Bot },
  { section: 'tasks', label: 'Tasks', path: '/tasks', icon: ListTodo },
  { section: 'runs', label: 'Runs', path: '/runs', icon: History },
  { section: 'terminal', label: 'Terminal', path: '/terminal', icon: SquareTerminal },
] as const

function DefaultGraph({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="surface-placeholder">
      <p className="panel-kicker">Graph</p>
      <h2>Workflow graph</h2>
      <p>No graph connected for workspace {workspaceId}.</p>
    </div>
  )
}

export function WorkspaceShell({ workspaceId, slots = {}, activeSection = 'workspaces' }: WorkspaceShellProps) {
  const [navigationCollapsed, setNavigationCollapsed] = useState(
    () => globalThis.sessionStorage?.getItem('graphql-navigation-collapsed') === 'true',
  )

  const setCollapsed = (collapsed: boolean) => {
    setNavigationCollapsed(collapsed)
    globalThis.sessionStorage?.setItem('graphql-navigation-collapsed', String(collapsed))
  }

  return (
    <div
      className={`workspace-shell${navigationCollapsed ? ' workspace-shell-navigation-collapsed' : ''}`}
      data-testid="workspace-shell"
    >
      <aside
        className="shell-sidebar"
        aria-label="Primary navigation"
        data-collapsed={navigationCollapsed}
      >
        <button
          type="button"
          className="sidebar-collapse-button"
          aria-label={navigationCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={navigationCollapsed ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!navigationCollapsed}
          aria-controls="workspace-primary-navigation"
          onClick={() => setCollapsed(!navigationCollapsed)}
        >
          {navigationCollapsed ? (
            <ChevronRight aria-hidden="true" size={16} />
          ) : (
            <ChevronLeft aria-hidden="true" size={16} />
          )}
        </button>

        <nav className="shell-navigation" id="workspace-primary-navigation">
          <p className="nav-label">Workspace</p>
          <ul>
            {navigationItems.map((item) => (
              <li key={item.label}>
                <a
                  className={`nav-item${activeSection === item.section ? ' nav-item-active' : ''}`}
                  href={`/workspaces/${encodeURIComponent(workspaceId)}${item.path}`}
                  aria-current={activeSection === item.section ? 'page' : undefined}
                  aria-label={navigationCollapsed ? item.label : undefined}
                  title={item.label}
                >
                  <item.icon aria-hidden="true" className="nav-item-icon" size={16} />
                  <span className="nav-item-label">{item.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="sidebar-footer">
          <p className="sidebar-note">Phase 1 · Mock data</p>
          <ThemeToggle />
          <a
            className={`nav-item sidebar-settings${activeSection === 'settings' ? ' nav-item-active' : ''}`}
            href={`/workspaces/${encodeURIComponent(workspaceId)}/settings`}
            aria-current={activeSection === 'settings' ? 'page' : undefined}
            aria-label={navigationCollapsed ? 'Settings' : undefined}
            title="Settings"
          >
            <span className="nav-item-primary">
              <Settings aria-hidden="true" className="nav-item-icon" size={16} />
              <span className="nav-item-label">Settings</span>
            </span>
          </a>
        </div>
      </aside>

      <main className="shell-main">
        {slots.main ? (
          <section className="shell-content" data-slot="main" aria-label="Workspace content">
            {slots.main}
          </section>
        ) : (
          <section className="graph-surface" data-slot="graph" aria-label="Workflow graph">
            {slots.graph ?? <DefaultGraph workspaceId={workspaceId} />}
          </section>
        )}
      </main>
    </div>
  )
}
