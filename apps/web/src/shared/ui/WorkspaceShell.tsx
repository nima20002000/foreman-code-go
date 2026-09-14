import { useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { ThemeToggle } from '../../features/theme'
import {
  WorkspaceNavigation,
  type GlobalNavigationSection,
  type WorkspaceNavigationEntry,
  type WorkspaceSection,
} from '../../features/workspaces'

export type { WorkspaceSection } from '../../features/workspaces'

export interface WorkspaceShellSlots {
  /** Content for the workspace slot in the header. */
  workspace?: ReactNode
  /** Content for the runner slot in the header. */
  runner?: ReactNode
  /** Center graph surface. */
  graph?: ReactNode
  /** Bottom terminal surface. */
  terminal?: ReactNode
  /** Non-graph workspace content, such as a directory page. */
  main?: ReactNode
}

export interface WorkspaceShellProps {
  workspaceId: string
  slots?: WorkspaceShellSlots
  activeSection?: WorkspaceSection
  /** URL-owned workflow selection handed to the nested Workflows submenu. */
  activeWorkflowId?: string
  /** URL-owned agent selection handed to the nested Agents submenu. */
  activeAgentId?: string
  /** Top-level destination outside the workspace tree. */
  activeGlobalSection?: GlobalNavigationSection
  /** Server-shaped workspace list; defaults to the active workspace projection. */
  workspaces?: readonly WorkspaceNavigationEntry[]
}

function DefaultGraph({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="surface-placeholder">
      <p className="panel-kicker">Graph</p>
      <h2>Workflow graph</h2>
      <p>No graph connected for workspace {workspaceId}.</p>
    </div>
  )
}

export function WorkspaceShell({
  workspaceId,
  slots = {},
  activeSection = 'workflows',
  activeWorkflowId,
  activeAgentId,
  activeGlobalSection,
  workspaces,
}: WorkspaceShellProps) {
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
          <p className="sidebar-brand" data-testid="sidebar-brand">
            <span aria-hidden="true" className="sidebar-brand-mark">
              G
            </span>
            <span className="sidebar-brand-name">GraphQL</span>
            <span className="visually-hidden">graphql</span>
          </p>

          <WorkspaceNavigation
            workspaceId={workspaceId}
            activeSection={activeSection}
            activeWorkflowId={activeWorkflowId}
            activeAgentId={activeAgentId}
            activeGlobalSection={activeGlobalSection}
            workspaces={workspaces}
            navigationCollapsed={navigationCollapsed}
          />
        </nav>

        <div className="sidebar-footer">
          <p className="sidebar-note">Phase 1 · Mock data</p>
          <ThemeToggle />
        </div>
      </aside>

      <main className="shell-main">
        {slots.main ? (
          <section className="shell-content" data-slot="main" aria-label="Workspace content">
            {slots.main}
          </section>
        ) : (
          <>
            <section className="graph-surface" data-slot="graph" aria-label="Workflow graph">
              {slots.graph ?? <DefaultGraph workspaceId={workspaceId} />}
            </section>
          </>
        )}
      </main>
    </div>
  )
}
