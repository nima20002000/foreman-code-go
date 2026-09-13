import type { ReactNode } from 'react'

import { TerminalPlaceholder } from '../../features/terminal/TerminalPlaceholder'
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
}

export interface WorkspaceShellProps {
  workspaceId: string
  slots?: WorkspaceShellSlots
}

const navigationItems = [
  { label: 'Workspaces', href: '/', available: true },
  { label: 'Agents', available: false },
  { label: 'Browsers', available: false },
  { label: 'Tasks', available: false },
  { label: 'Runs', available: false },
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

function DefaultContext() {
  return (
    <div className="surface-placeholder">
      <p className="panel-kicker">Context</p>
      <h2>Workspace context</h2>
      <p>Select a workflow or agent to inspect its context.</p>
    </div>
  )
}

export function WorkspaceShell({ workspaceId, slots = {} }: WorkspaceShellProps) {
  return (
    <div className="workspace-shell" data-testid="workspace-shell">
      <aside className="shell-sidebar" aria-label="Primary navigation">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            G
          </span>
          <span>graphql</span>
        </div>

        <nav className="shell-navigation">
          <p className="nav-label">Workspace</p>
          <ul>
            {navigationItems.map((item) => (
              <li key={item.label}>
                {item.available ? (
                  <a
                    className="nav-item nav-item-active"
                    href={item.href}
                    aria-current="page"
                  >
                    {item.label}
                  </a>
                ) : (
                  <button
                    type="button"
                    className="nav-item nav-item-unavailable"
                    disabled
                    aria-disabled="true"
                    title={`${item.label} is not available yet`}
                  >
                    <span>{item.label}</span>
                    <span className="availability-note">Unavailable</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </nav>

        <p className="sidebar-note">Phase 1 · Mock data</p>
      </aside>

      <header className="shell-header">
        <div className="header-slot" data-slot="workspace-header">
          <span className="slot-label">Workspace</span>
          {slots.workspace ?? <strong>{workspaceId}</strong>}
        </div>
        <div className="header-slot" data-slot="runner-header">
          <span className="slot-label">Runner</span>
          {slots.runner ?? <span>Not connected</span>}
        </div>
        <div className="header-surface-state" role="status" aria-live="polite">
          Phase 1 · Mock data
        </div>
        <ThemeToggle />
      </header>

      <main className="shell-main">
        <section className="graph-surface" data-slot="graph" aria-label="Workflow graph">
          {slots.graph ?? <DefaultGraph workspaceId={workspaceId} />}
        </section>
        <aside className="context-surface" data-slot="context" aria-label="Workspace context">
          {slots.context ?? <DefaultContext />}
        </aside>
      </main>

      <section className="terminal-surface" data-slot="terminal" aria-label="Terminal">
        {slots.terminal ?? <TerminalPlaceholder />}
      </section>
    </div>
  )
}
