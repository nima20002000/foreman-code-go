import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Bot,
  ChevronDown,
  Files,
  History,
  ListTodo,
  PanelsTopLeft,
  Plus,
  Settings,
  SquareTerminal,
  Workflow,
  X,
} from 'lucide-react'
import type { Workspace } from '@graphql/contracts'

import { useWorkspaceDetailsQuery } from '../../shared/api/query'
import { useDismissableSurface } from '../../shared/ui/useDismissableSurface'
import { usePresence } from '../../shared/ui/usePresence'
import { AgentNavigation } from '../agents'
import { WorkflowNavigation } from '../workflows'
import { isSessionWorkspaceId, useWorkspaceSessionStore } from './workspaceSessionStore'
import { useNavigationUiStore } from './navigationUiStore'
import {
  WORKSPACES_ORDER_KEY,
  GLOBAL_NAVIGATION_ORDER_KEY,
  useNavigationOrderStore,
  workspaceSectionsOrderKey,
} from './navigationOrder'
import {
  useReorderableNavigation,
  type ReorderItemProps,
  type ReorderKeyboardProps,
} from './useReorderableNavigation'
import './workspaces.css'

export type WorkspaceSection =
  | 'agents'
  | 'workflows'
  | 'files'
  | 'tasks'
  | 'runs'
  | 'terminal'
  | 'settings'

export type GlobalNavigationSection = 'terminal' | 'settings'

export type WorkspaceNavigationEntry = Pick<Workspace, 'id' | 'name'>

export interface WorkspaceNavigationProps {
  workspaceId: string
  activeSection?: WorkspaceSection
  /** URL-owned workflow selection for the active workspace. */
  activeWorkflowId?: string
  /** URL-owned agent selection for the active workspace. */
  activeAgentId?: string
  /** Active top-level destination outside the workspace tree. */
  activeGlobalSection?: GlobalNavigationSection
  /**
   * Server-shaped workspace list. When omitted, the active workspace
   * projection from the workspace query is the only entry.
   */
  workspaces?: readonly WorkspaceNavigationEntry[]
  navigationCollapsed?: boolean
  /** The workspace directory is selected instead of a specific workspace. */
  workspaceOverviewActive?: boolean
  /** Route-supplied submenu content overrides for the active workspace. */
  agentsContent?: ReactNode
  workflowsContent?: ReactNode
}

const workspaceSections: readonly WorkspaceSection[] = [
  'agents',
  'workflows',
  'files',
  'tasks',
  'runs',
]

const sectionLinks = [
  { section: 'files', label: 'Files', to: '/workspaces/$workspaceId/files', icon: Files },
  { section: 'tasks', label: 'Tasks', to: '/workspaces/$workspaceId/tasks', icon: ListTodo },
  { section: 'runs', label: 'Runs', to: '/workspaces/$workspaceId/runs', icon: History },
] as const

const globalLinks = [
  { section: 'terminal', label: 'Terminal', to: '/terminal', icon: SquareTerminal },
  { section: 'settings', label: 'Settings', to: '/settings', icon: Settings },
] as const

const sectionLinkBySection = new Map<WorkspaceSection, (typeof sectionLinks)[number]>(
  sectionLinks.map((item) => [item.section, item]),
)

const sectionLabels: Record<WorkspaceSection, string> = {
  agents: 'Agents',
  workflows: 'Workflows',
  files: 'Files',
  tasks: 'Tasks',
  runs: 'Runs',
  terminal: 'Terminal',
  settings: 'Settings',
}

const workspaceSectionItems = workspaceSections.map((section) => ({
  id: section,
  label: sectionLabels[section],
}))

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')]
  const first = controls[0]
  const last = controls.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

/**
 * The always-visible create entry point for the workspace list. Creating a
 * workspace needs the future backend, so this opens an explicit wireframe
 * notice instead of inventing persistence.
 */
function NewWorkspaceControl() {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const createWorkspace = useWorkspaceSessionStore((state) => state.createWorkspace)

  const closeCreateDialog = useCallback(() => {
    setCreating(false)
    setName('')
    setNameError(undefined)
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    if (!creating) return
    nameInputRef.current?.focus()
  }, [creating])

  useDismissableSurface({
    open: creating,
    onDismiss: closeCreateDialog,
    surfaceRef: dialogRef,
    triggerRef,
  })

  const createNewWorkspace = () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setNameError('Enter a workspace name.')
      nameInputRef.current?.focus()
      return
    }
    const workspace = createWorkspace(trimmedName)
    closeCreateDialog()
    void navigate({
      to: '/workspaces/$workspaceId',
      params: { workspaceId: workspace.id },
    })
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="workspace-navigation-add"
        aria-label="New workspace"
        title="New workspace"
        aria-haspopup="dialog"
        aria-expanded={creating}
        onClick={() => setCreating(true)}
      >
        <Plus aria-hidden="true" size={15} />
        <span className="nav-item-label">New workspace</span>
      </button>

      {creating ? (
        <div className="workspace-create-backdrop">
          <div
            ref={dialogRef}
            className="workspace-create-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-workspace-title"
            aria-describedby="new-workspace-description"
            onKeyDown={trapDialogFocus}
          >
            <div className="workspace-create-heading">
              <h2 id="new-workspace-title">New workspace</h2>
              <button
                ref={closeButtonRef}
                type="button"
                aria-label="Close new workspace"
                title="Close"
                onClick={closeCreateDialog}
              >
                <X aria-hidden="true" size={16} />
              </button>
            </div>
            <p id="new-workspace-description">
              Create a workspace for its own agents, workflows, files, tasks, and runs.
            </p>
            <label className="workspace-create-label" htmlFor="new-workspace-name">Name</label>
            <input
              ref={nameInputRef}
              id="new-workspace-name"
              value={name}
              autoFocus
              onChange={(event) => {
                setName(event.target.value)
                if (nameError) setNameError(undefined)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  createNewWorkspace()
                }
              }}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? 'new-workspace-name-error' : undefined}
            />
            {nameError ? (
              <p id="new-workspace-name-error" className="workspace-create-error" role="alert">
                {nameError}
              </p>
            ) : null}
            <div className="workspace-create-actions">
              <button type="button" onClick={closeCreateDialog}>
                Close
              </button>
              <button
                type="button"
                onClick={createNewWorkspace}
              >
                Create workspace
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

interface WorkspaceTreeItemProps {
  entry: WorkspaceNavigationEntry
  active: boolean
  expanded: boolean
  onActivate: () => void
  onToggle: () => void
  activeSection: WorkspaceSection
  activeWorkflowId?: string
  activeAgentId?: string
  navigationCollapsed: boolean
  agentsContent?: ReactNode
  workflowsContent?: ReactNode
  reorderItemProps?: ReorderItemProps
  reorderKeyboardProps?: ReorderKeyboardProps
}

function WorkspaceTreeItem({
  entry,
  active,
  expanded,
  onActivate,
  onToggle,
  activeSection,
  activeWorkflowId,
  activeAgentId,
  navigationCollapsed,
  agentsContent,
  workflowsContent,
  reorderItemProps,
  reorderKeyboardProps,
}: WorkspaceTreeItemProps) {
  const agentsExpanded = useNavigationUiStore(
    (state) => state.expandedSections[entry.id]?.agents ?? true,
  )
  const workflowsExpanded = useNavigationUiStore(
    (state) => state.expandedSections[entry.id]?.workflows ?? true,
  )
  const setSectionExpanded = useNavigationUiStore((state) => state.setSectionExpanded)
  const sectionsPresence = usePresence(expanded)
  const agentsPresence = usePresence(agentsExpanded)
  const workflowsPresence = usePresence(workflowsExpanded)

  const idPrefix = useId().replaceAll(':', '')
  const sectionsId = `${idPrefix}-sections`
  const agentsPanelId = `${idPrefix}-agents`
  const workflowsPanelId = `${idPrefix}-workflows`

  const agentsActive = active && activeSection === 'agents'
  const workflowsActive = active && activeSection === 'workflows'

  const sections = useReorderableNavigation(
    workspaceSectionsOrderKey(entry.id),
    workspaceSectionItems,
  )

  const renderSection = (section: WorkspaceSection) => {
    const reorderProps = sections.getItemProps(section)
    if (section === 'agents') {
      return (
        <>
          <div className="nav-item-row" {...reorderProps}>
            <Link
              to="/workspaces/$workspaceId/agents"
              params={{ workspaceId: entry.id }}
              className={`nav-item${agentsActive ? ' nav-item-active' : ''}`}
              aria-current={agentsActive ? 'page' : undefined}
              aria-label={navigationCollapsed ? 'Agents' : undefined}
              title="Agents"
              {...sections.getKeyboardProps(section)}
            >
              <span className="nav-item-primary">
                <Bot aria-hidden="true" className="nav-item-icon" size={16} />
                <span className="nav-item-label">Agents</span>
              </span>
            </Link>
            <button
              type="button"
              className="nav-item-toggle"
              aria-expanded={agentsExpanded}
              aria-controls={agentsPanelId}
              aria-label={`${agentsExpanded ? 'Collapse' : 'Expand'} agents in ${entry.name}`}
              title="Agents"
              onClick={() => setSectionExpanded(entry.id, 'agents', !agentsExpanded)}
              {...sections.getKeyboardProps(section)}
            >
              <ChevronDown aria-hidden="true" className="nav-item-chevron" size={14} />
            </button>
          </div>
          {agentsPresence.mounted ? (
            <div
              className={`workspace-navigation-panel nav-submenu-motion${agentsPresence.exiting ? ' is-exiting' : ''}`}
              id={agentsPanelId}
              aria-hidden={!agentsExpanded}
              inert={!agentsExpanded ? true : undefined}
            >
              {(active ? agentsContent : undefined) ?? (
                <AgentNavigation
                  workspaceId={entry.id}
                  activeAgentId={active ? activeAgentId : undefined}
                />
              )}
            </div>
          ) : null}
        </>
      )
    }

    if (section === 'workflows') {
      return (
        <>
          <div className="nav-item-row" {...reorderProps}>
            <Link
              to="/workspaces/$workspaceId"
              params={{ workspaceId: entry.id }}
              className={`nav-item${workflowsActive ? ' nav-item-active' : ''}`}
              aria-current={workflowsActive ? 'page' : undefined}
              aria-label={navigationCollapsed ? 'Workflows' : undefined}
              title="Workflows"
              {...sections.getKeyboardProps(section)}
            >
              <span className="nav-item-primary">
                <Workflow aria-hidden="true" className="nav-item-icon" size={16} />
                <span className="nav-item-label">Workflows</span>
              </span>
            </Link>
            <button
              type="button"
              className="nav-item-toggle"
              aria-expanded={workflowsExpanded}
              aria-controls={workflowsPanelId}
              aria-label={`${workflowsExpanded ? 'Collapse' : 'Expand'} workflows in ${entry.name}`}
              title="Workflows"
              onClick={() => setSectionExpanded(entry.id, 'workflows', !workflowsExpanded)}
              {...sections.getKeyboardProps(section)}
            >
              <ChevronDown aria-hidden="true" className="nav-item-chevron" size={14} />
            </button>
          </div>
          {workflowsPresence.mounted ? (
            <div
              className={`workspace-navigation-panel nav-submenu-motion${workflowsPresence.exiting ? ' is-exiting' : ''}`}
              id={workflowsPanelId}
              aria-hidden={!workflowsExpanded}
              inert={!workflowsExpanded ? true : undefined}
            >
              {(active ? workflowsContent : undefined) ?? (
                <WorkflowNavigation
                  workspaceId={entry.id}
                  activeWorkflowId={active ? activeWorkflowId : undefined}
                />
              )}
            </div>
          ) : null}
        </>
      )
    }

    const item = sectionLinkBySection.get(section)
    if (!item) return null
    const itemActive = active && activeSection === item.section

    return (
      <Link
        to={item.to}
        params={{ workspaceId: entry.id }}
        className={`nav-item${itemActive ? ' nav-item-active' : ''}`}
        aria-current={itemActive ? 'page' : undefined}
        aria-label={navigationCollapsed ? item.label : undefined}
        title={item.label}
        {...reorderProps}
        {...sections.getKeyboardProps(section)}
      >
        <span className="nav-item-primary">
          <item.icon aria-hidden="true" className="nav-item-icon" size={16} />
          <span className="nav-item-label">{item.label}</span>
        </span>
      </Link>
    )
  }

  return (
    <li>
      <div className="nav-item-row" {...reorderItemProps}>
        <Link
          to="/workspaces/$workspaceId"
          params={{ workspaceId: entry.id }}
          search={{}}
          activeOptions={{ exact: true, includeSearch: false }}
          className={`nav-item nav-item-parent${active ? ' nav-item-active' : ''}`}
          aria-current={active ? 'location' : undefined}
          aria-label={navigationCollapsed ? entry.name : undefined}
          title={entry.name}
          data-testid={`workspace-entry-${entry.id}`}
          onClick={onActivate}
          {...reorderKeyboardProps}
        >
          <span className="nav-item-primary">
            <PanelsTopLeft aria-hidden="true" className="nav-item-icon" size={16} />
            <span className="nav-item-label">{entry.name}</span>
          </span>
        </Link>
        <button
          type="button"
          className="nav-item-toggle"
          aria-expanded={expanded}
          aria-controls={sectionsId}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${entry.name}`}
          title={entry.name}
          onClick={onToggle}
          {...reorderKeyboardProps}
        >
          <ChevronDown aria-hidden="true" className="nav-item-chevron" size={14} />
        </button>
      </div>

      {sectionsPresence.mounted ? (
        <ul
          className={`nav-submenu workspace-entry-sections nav-submenu-motion${sectionsPresence.exiting ? ' is-exiting' : ''}`}
          id={sectionsId}
          aria-hidden={!expanded}
          inert={!expanded ? true : undefined}
          {...sections.containerProps}
        >
          {sections.orderedIds.map((section) => {
            const sectionId = section as WorkspaceSection
            return (
              <li key={sectionId}>
                {renderSection(sectionId)}
              </li>
            )
          })}
        </ul>
      ) : null}
    </li>
  )
}

/**
 * The workspace-first sidebar hierarchy. Workspaces is the collapsible parent,
 * every workspace entry expands into its own Agents, Workflows, Files, Tasks,
 * and Runs destinations. Terminal and Settings are global links below the
 * workspace tree. Agents and Workflows are collapsible submenus. Workspace and
 * workflow lists are server-shaped query projections; selection stays in the
 * URL through router links.
 */
export function WorkspaceNavigation({
  workspaceId,
  activeSection = 'workflows',
  activeWorkflowId,
  activeAgentId,
  activeGlobalSection,
  workspaces,
  navigationCollapsed = false,
  workspaceOverviewActive = false,
  agentsContent,
  workflowsContent,
}: WorkspaceNavigationProps) {
  const detailsQuery = useWorkspaceDetailsQuery(workspaceId, {
    enabled: !isSessionWorkspaceId(workspaceId),
  })
  const sessionWorkspaces = useWorkspaceSessionStore((state) => state.workspaces)
  const knownWorkspaces = useWorkspaceSessionStore((state) => state.knownWorkspaces)
  const hiddenWorkspaceIds = useWorkspaceSessionStore((state) => state.hiddenWorkspaceIds)
  const registerWorkspace = useWorkspaceSessionStore((state) => state.registerWorkspace)
  const rememberWorkspace = useNavigationUiStore((state) => state.rememberWorkspace)
  const workspacesExpanded = useNavigationUiStore((state) => state.workspacesExpanded)
  const setWorkspacesExpanded = useNavigationUiStore((state) => state.setWorkspacesExpanded)
  const expandedWorkspaceIds = useNavigationUiStore((state) => state.expandedWorkspaceIds)
  const setWorkspaceExpanded = useNavigationUiStore((state) => state.setWorkspaceExpanded)
  const workspacesPresence = usePresence(workspacesExpanded)

  useEffect(() => {
    for (const workspace of workspaces ?? []) registerWorkspace(workspace)
    const activeWorkspace = detailsQuery.data?.workspace
    if (activeWorkspace) registerWorkspace({ id: activeWorkspace.id, name: activeWorkspace.name })
  }, [detailsQuery.data?.workspace, registerWorkspace, workspaces])

  useEffect(() => {
    const sessionWorkspaceExists = sessionWorkspaces.some((workspace) => workspace.id === workspaceId)
    if (!activeGlobalSection && !workspaceOverviewActive && (detailsQuery.data?.workspace || sessionWorkspaceExists)) {
      rememberWorkspace(workspaceId)
    }
  }, [activeGlobalSection, detailsQuery.data?.workspace, rememberWorkspace, sessionWorkspaces, workspaceId, workspaceOverviewActive])

  const entries = useMemo<readonly WorkspaceNavigationEntry[]>(
    () => {
      const hidden = new Set(hiddenWorkspaceIds)
      const next = knownWorkspaces.filter((entry) => !hidden.has(entry.id))
      const known = new Set(next.map((entry) => entry.id))
      for (const sessionWorkspace of sessionWorkspaces) {
        if (!known.has(sessionWorkspace.id)) {
          next.push(sessionWorkspace)
          known.add(sessionWorkspace.id)
        }
      }
      if (!activeGlobalSection && !workspaceOverviewActive && !known.has(workspaceId)) {
        next.unshift({
          id: workspaceId,
          name: detailsQuery.data?.workspace.name ?? workspaceId,
        })
      }
      return next
    },
    [activeGlobalSection, detailsQuery.data?.workspace.name, hiddenWorkspaceIds, knownWorkspaces, sessionWorkspaces, workspaceId, workspaceOverviewActive],
  )

  const entryItems = useMemo(
    () => entries.map((entry) => ({ id: entry.id, label: entry.name })),
    [entries],
  )
  const entryById = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  )
  const entriesReorder = useReorderableNavigation(WORKSPACES_ORDER_KEY, entryItems)
  const globalReorder = useReorderableNavigation(
    GLOBAL_NAVIGATION_ORDER_KEY,
    globalLinks.map((item) => ({ id: item.section, label: item.label })),
  )
  const globalLinkBySection = new Map(globalLinks.map((item) => [item.section, item]))
  const announcement = useNavigationOrderStore((state) => state.announcement)

  const toggleWorkspace = (id: string) => {
    setWorkspaceExpanded(id, !(expandedWorkspaceIds[id] ?? id === workspaceId))
  }

  const workspacesActive = workspaceOverviewActive || (
    !activeGlobalSection && workspaceSections.includes(activeSection)
  )

  return (
    <>
      <ul className="workspace-navigation" data-testid="workspace-navigation">
        <li>
          <div className="nav-item-row">
            <Link
              to="/workspaces"
              activeOptions={{ exact: true }}
              className={`nav-item nav-item-parent${workspacesActive ? ' nav-item-active' : ''}`}
              aria-label={navigationCollapsed ? 'Workspaces' : undefined}
              title="Workspaces"
            >
              <span className="nav-item-primary">
                <PanelsTopLeft aria-hidden="true" className="nav-item-icon" size={16} />
                <span className="nav-item-label">Workspaces</span>
              </span>
            </Link>
            <button
              type="button"
              className="nav-item-toggle"
              aria-expanded={workspacesExpanded}
              aria-controls="workspace-entries"
              aria-label="Workspaces"
              title="Workspaces"
              onClick={() => setWorkspacesExpanded(!workspacesExpanded)}
            >
              <ChevronDown aria-hidden="true" className="nav-item-chevron" size={14} />
            </button>
          </div>

          {workspacesPresence.mounted ? (
            <ul
              className={`nav-submenu workspace-navigation-list nav-submenu-motion${workspacesPresence.exiting ? ' is-exiting' : ''}`}
              id="workspace-entries"
              aria-hidden={!workspacesExpanded}
              inert={!workspacesExpanded ? true : undefined}
              {...entriesReorder.containerProps}
            >
              {entriesReorder.orderedIds.map((entryId) => {
                const entry = entryById.get(entryId)
                if (!entry) return null
                return (
                  <WorkspaceTreeItem
                    key={entry.id}
                    entry={entry}
                    active={entry.id === workspaceId && !activeGlobalSection && !workspaceOverviewActive}
                    expanded={expandedWorkspaceIds[entry.id] ?? (
                      entry.id === workspaceId && !activeGlobalSection && !workspaceOverviewActive
                    )}
                    onActivate={() => rememberWorkspace(entry.id)}
                    onToggle={() => toggleWorkspace(entry.id)}
                    activeSection={activeSection}
                    activeWorkflowId={activeWorkflowId}
                    activeAgentId={activeAgentId}
                    navigationCollapsed={navigationCollapsed}
                    agentsContent={agentsContent}
                    workflowsContent={workflowsContent}
                    reorderItemProps={entriesReorder.getItemProps(entry.id)}
                    reorderKeyboardProps={entriesReorder.getKeyboardProps(entry.id)}
                  />
                )
              })}
              <li>
                <NewWorkspaceControl />
              </li>
            </ul>
          ) : null}
        </li>
      </ul>

      <ul
        className="workspace-global-navigation"
        aria-label="Global navigation"
        {...globalReorder.containerProps}
      >
        {globalReorder.orderedIds.map((section) => {
          const item = globalLinkBySection.get(section as GlobalNavigationSection)
          if (!item) return null
          const active = activeGlobalSection === item.section
          return (
            <li key={item.section} {...globalReorder.getItemProps(item.section)}>
              <Link
                to={item.to}
                className={`nav-item${active ? ' nav-item-active' : ''}`}
                aria-current={active ? 'page' : undefined}
                aria-label={navigationCollapsed ? item.label : undefined}
                title={item.label}
                {...globalReorder.getKeyboardProps(item.section)}
              >
                <span className="nav-item-primary">
                  <item.icon aria-hidden="true" className="nav-item-icon" size={16} />
                  <span className="nav-item-label">{item.label}</span>
                </span>
              </Link>
            </li>
          )
        })}
      </ul>

      <p
        key={announcement?.nonce ?? 0}
        className="visually-hidden"
        data-testid="navigation-reorder-announcement"
        role="status"
        aria-live="polite"
      >
        {announcement?.message ?? ''}
      </p>
    </>
  )
}
