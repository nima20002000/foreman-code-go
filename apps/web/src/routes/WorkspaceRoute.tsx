import type { ReactNode } from 'react'

import {
  WorkspaceShell,
  type WorkspaceShellSlots,
} from '../shared/ui/WorkspaceShell'

export type WorkspaceRouteState = 'ready' | 'loading' | 'error' | 'not-found' | 'empty' | 'stale'

export interface WorkspaceRouteViewProps {
  workspaceId: string
  selectedAgentId?: string
  activeWorkflowId?: string
  activeAgentId?: string
  state?: WorkspaceRouteState
  stateMessage?: string
  slots?: WorkspaceShellSlots
}

function DefaultWorkspaceSlot({ workspaceId }: { workspaceId: string }) {
  return <strong>{workspaceId}</strong>
}

function DefaultGraphSlot({
  workspaceId,
  selectedAgentId,
  state,
  stateMessage,
}: Pick<WorkspaceRouteViewProps, 'workspaceId' | 'selectedAgentId' | 'state' | 'stateMessage'>) {
  if (state === 'loading') {
    return (
      <div className="surface-placeholder" data-testid="workspace-loading" role="status">
        <p className="panel-kicker">Workspace</p>
        <h2>Loading workspace…</h2>
        <p>Workspace data will appear here when the request completes.</p>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="surface-placeholder surface-placeholder-error" data-testid="workspace-error" role="alert">
        <p className="panel-kicker">Workspace</p>
        <h2>Workspace unavailable</h2>
        <p>{stateMessage ?? 'The workspace could not be loaded.'}</p>
      </div>
    )
  }

  if (state === 'not-found') {
    return (
      <div className="surface-placeholder surface-placeholder-error" data-testid="workspace-not-found" role="alert">
        <p className="panel-kicker">Workspace</p>
        <h2>Workspace not found</h2>
        <p>{stateMessage ?? `Workspace ${workspaceId} is not available.`}</p>
      </div>
    )
  }

  if (state === 'empty') {
    return (
      <div className="surface-placeholder" data-testid="workspace-empty">
        <p className="panel-kicker">Graph</p>
        <h2>No saved workflow yet</h2>
        <p>This workspace does not have a saved workflow to display.</p>
      </div>
    )
  }

  if (state === 'stale') {
    return (
      <div className="surface-placeholder surface-placeholder-stale" data-testid="workspace-stale" role="status">
        <p className="panel-kicker">Workspace</p>
        <h2>Selection needs attention</h2>
        <p>{stateMessage ?? `Agent ${selectedAgentId ?? 'selection'} is no longer available.`}</p>
      </div>
    )
  }

  return (
    <div className="surface-placeholder" data-testid="workspace-ready">
      <p className="panel-kicker">Graph</p>
      <h2>Workflow graph</h2>
      <p>
        The graph surface is ready for workspace {workspaceId}.
        {selectedAgentId ? ` Agent ${selectedAgentId} is selected.` : ' No agent is selected.'}
      </p>
    </div>
  )
}

export function WorkspaceRouteView({
  workspaceId,
  selectedAgentId,
  activeWorkflowId,
  activeAgentId,
  state = 'ready',
  stateMessage,
  slots,
}: WorkspaceRouteViewProps) {
  const resolvedSlots: WorkspaceShellSlots = {
    workspace: slots?.workspace ?? <DefaultWorkspaceSlot workspaceId={workspaceId} />,
    graph:
      slots?.graph ?? (
        <DefaultGraphSlot
          workspaceId={workspaceId}
          selectedAgentId={selectedAgentId}
          state={state}
          stateMessage={stateMessage}
        />
      ),
  }

  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      activeWorkflowId={activeWorkflowId}
      activeAgentId={activeAgentId}
      slots={resolvedSlots}
    />
  )
}

export interface WorkspaceSelectionProps {
  workspaceId: string
  selectedAgentId?: string
  activeWorkflowId?: string
  activeAgentId?: string
  state?: WorkspaceRouteState
  stateMessage?: string
  slots?: WorkspaceShellSlots
  /** Optional extra content for route-level consumers above the shell. */
  children?: ReactNode
}

export function WorkspaceSelection({
  children,
  ...props
}: WorkspaceSelectionProps) {
  const state = props.state ?? 'ready'

  return (
    <div className="workspace-route" data-testid="workspace-route">
      <WorkspaceRouteView {...props} state={state} />
      {children}
    </div>
  )
}
