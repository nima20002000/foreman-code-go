import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { ThemeToggle } from '../../features/theme'
import {
  DEFAULT_NAVIGATION_WIDTH,
  MAX_NAVIGATION_WIDTH,
  MIN_NAVIGATION_WIDTH,
  WorkspaceNavigation,
  type GlobalNavigationSection,
  type WorkspaceNavigationEntry,
  type WorkspaceSection,
  useNavigationUiStore,
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
  /** Workspace directory is selected instead of an individual workspace. */
  workspaceOverviewActive?: boolean
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
  workspaceOverviewActive = false,
  workspaces,
}: WorkspaceShellProps) {
  const navigationCollapsed = useNavigationUiStore((state) => state.collapsed)
  const navigationWidth = useNavigationUiStore((state) => state.width)
  const rememberedWorkspaceId = useNavigationUiStore((state) => state.activeWorkspaceId)
  const setCollapsed = useNavigationUiStore((state) => state.setCollapsed)
  const setNavigationWidth = useNavigationUiStore((state) => state.setWidth)
  const stopResizeRef = useRef<(() => void) | null>(null)

  const navigationWorkspaceId = activeGlobalSection
    ? rememberedWorkspaceId ?? workspaceId
    : workspaceId

  useEffect(() => () => stopResizeRef.current?.(), [])

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || navigationCollapsed) return
    event.preventDefault()
    stopResizeRef.current?.()

    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = navigationWidth

    const stop = () => {
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      stopResizeRef.current = null
    }
    const resize = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      setNavigationWidth(startWidth + moveEvent.clientX - startX)
    }
    const finish = (endEvent: PointerEvent) => {
      if (endEvent.pointerId === pointerId) stop()
    }

    stopResizeRef.current = stop
    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }, [navigationCollapsed, navigationWidth, setNavigationWidth])

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 8
    let nextWidth: number | undefined
    if (event.key === 'ArrowLeft') nextWidth = navigationWidth - step
    if (event.key === 'ArrowRight') nextWidth = navigationWidth + step
    if (event.key === 'Home') nextWidth = MIN_NAVIGATION_WIDTH
    if (event.key === 'End') nextWidth = MAX_NAVIGATION_WIDTH
    if (nextWidth === undefined) return
    event.preventDefault()
    setNavigationWidth(nextWidth)
  }

  return (
    <div
      className={`workspace-shell${navigationCollapsed ? ' workspace-shell-navigation-collapsed' : ''}`}
      data-testid="workspace-shell"
      style={{ '--navigation-width': `${navigationWidth}px` } as CSSProperties}
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

        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-label="Resize navigation"
          aria-orientation="vertical"
          aria-valuemin={MIN_NAVIGATION_WIDTH}
          aria-valuemax={MAX_NAVIGATION_WIDTH}
          aria-valuenow={navigationWidth}
          tabIndex={navigationCollapsed ? -1 : 0}
          title="Drag to resize navigation"
          onPointerDown={startResize}
          onKeyDown={resizeWithKeyboard}
          onDoubleClick={() => setNavigationWidth(DEFAULT_NAVIGATION_WIDTH)}
        />

        <nav className="shell-navigation" id="workspace-primary-navigation">
          <p className="sidebar-brand" data-testid="sidebar-brand">
            <span aria-hidden="true" className="sidebar-brand-mark">
              G
            </span>
            <span className="sidebar-brand-name">GraphQL</span>
            <span className="visually-hidden">graphql</span>
          </p>

          <WorkspaceNavigation
            workspaceId={navigationWorkspaceId}
            activeSection={activeSection}
            activeWorkflowId={activeWorkflowId}
            activeAgentId={activeAgentId}
            activeGlobalSection={activeGlobalSection}
            workspaceOverviewActive={workspaceOverviewActive}
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
