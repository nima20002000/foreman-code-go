import type { ReactNode } from 'react'

import { WorkspaceExecutionLocationSetup } from '../features/settings/WorkspaceExecutionLocationSetup'
import { Alert, EmptyState, ErrorState, LoadingState } from '../shared/ui/nocturne'

import {
  WorkspaceShell,
  type WorkspaceShellSlots,
} from '../shared/ui/WorkspaceShell'

export type WorkspaceRouteState = 'ready' | 'loading' | 'error' | 'not-found' | 'empty' | 'stale'

export interface WorkspaceRouteViewProps {
  workspaceId: string
  selectedAgentId?: string
  activeWorkflowId?: string
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
      <div className="n-theme" data-testid="workspace-loading">
        <LoadingState label="Loading workspace…" />
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="n-theme" data-testid="workspace-error">
        <ErrorState
          title="Workspace unavailable"
          description={stateMessage ?? 'The workspace could not be loaded.'}
        />
      </div>
    )
  }

  if (state === 'not-found') {
    return (
      <div className="n-theme" data-testid="workspace-not-found">
        <ErrorState
          title="Workspace not found"
          description={stateMessage ?? `Workspace ${workspaceId} is not available.`}
        />
      </div>
    )
  }

  if (state === 'empty') {
    return (
      <div className="n-theme" data-testid="workspace-empty">
        <EmptyState
          icon="workflow"
          title="No saved workflow yet"
          description="This workspace does not have a saved workflow to display."
        />
      </div>
    )
  }

  if (state === 'stale') {
    return (
      <div className="n-theme" data-testid="workspace-stale">
        <Alert live tone="warning" title="Selection needs attention">
          {stateMessage ?? `Agent ${selectedAgentId ?? 'selection'} is no longer available.`}
        </Alert>
      </div>
    )
  }

  return (
    <div className="n-theme" data-testid="workspace-ready">
      <EmptyState
        icon="workflow"
        title="Workflow graph"
        description={`The graph surface is ready for workspace ${workspaceId}.${selectedAgentId ? ` Agent ${selectedAgentId} is selected.` : ' No agent is selected.'}`}
      />
    </div>
  )
}

export function WorkspaceRouteView({
  workspaceId,
  selectedAgentId,
  activeWorkflowId,
  state = 'ready',
  stateMessage,
  slots,
}: WorkspaceRouteViewProps) {
  const realMode = import.meta.env.MODE !== 'test' && (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_MSW === 'false')
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

  if (realMode) {
    resolvedSlots.graph = (
      <WorkspaceExecutionLocationSetup workspaceId={workspaceId} enabled>
        {resolvedSlots.graph}
      </WorkspaceExecutionLocationSetup>
    )
  }

  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      activeWorkflowId={activeWorkflowId}
      slots={resolvedSlots}
    />
  )
}

export interface WorkspaceSelectionProps {
  workspaceId: string
  selectedAgentId?: string
  activeWorkflowId?: string
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
