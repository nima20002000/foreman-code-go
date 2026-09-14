import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { AgentSchema, type Agent } from '@graphql/contracts'
import { Plus, X } from 'lucide-react'

import { useAgentsQuery } from '../../shared/api/query'
import { useDismissableSurface } from '../../shared/ui/useDismissableSurface'
import { usePresence } from '../../shared/ui/usePresence'
import { isSessionWorkspaceId } from '../workspaces/workspaceSessionStore'
import { useAgentDirectoryStore } from './agentDirectoryStore'
import { readDeletedAgentIds, readLocalAgents } from './localAgents'
import { useReorderableAgents, type AgentReorderCardProps } from './useReorderableAgents'
import './agents.css'

function executionLabel(agent: Agent): string {
  const value = agent.executionState ?? agent.status
  if (!value) return 'No execution state'
  return value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return
  const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, a[href]')]
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

function AgentCard({
  agent,
  local,
  selected,
  onSelect,
  buttonRef,
  reorderProps,
}: {
  agent: Agent
  local: boolean
  selected: boolean
  onSelect?: (agentId: string) => void
  buttonRef?: (button: HTMLButtonElement | null) => void
  reorderProps?: AgentReorderCardProps
}) {
  const role = agent.role ?? 'Agent'
  const status = local ? 'Local session' : executionLabel(agent)
  const { ref: reorderRef, ...reorderAttributes } = reorderProps ?? {}
  return (
    <button
      type="button"
      ref={(button) => {
        buttonRef?.(button)
        reorderRef?.(button)
      }}
      className="agent-directory-card"
      data-local-agent={local || undefined}
      data-selected={selected || undefined}
      aria-label={`${agent.name}, ${role}, ${status}`}
      aria-pressed={selected}
      {...reorderAttributes}
      onClick={() => onSelect?.(agent.id)}
    >
      <h2>{agent.name}</h2>
      <span>{role} · {status}</span>
    </button>
  )
}

export function AgentsDirectoryContent({
  workspaceId,
  agents,
  selectedAgentId,
  onSelectAgent,
  onClearAgent,
}: {
  workspaceId: string
  agents: readonly Agent[]
  selectedAgentId?: string
  onSelectAgent?: (agentId: string) => void
  onClearAgent?: () => void
}) {
  const catalog = useAgentDirectoryStore((state) => state.catalogs[workspaceId])
  const hydrateWorkspace = useAgentDirectoryStore((state) => state.hydrateWorkspace)
  const setStoredLocalAgents = useAgentDirectoryStore((state) => state.setLocalAgents)
  const localAgents = catalog?.localAgents ?? readLocalAgents(workspaceId)
  const deletedAgentIds = catalog?.deletedAgentIds ?? readDeletedAgentIds(workspaceId)
  const announcement = useAgentDirectoryStore((state) => state.announcement)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string>()
  const addPresence = usePresence(adding)
  const detailPresence = usePresence(Boolean(selectedAgentId))
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLFormElement>(null)
  const detailDialogRef = useRef<HTMLDivElement>(null)
  const detailCloseRef = useRef<HTMLButtonElement>(null)
  const agentCardRefs = useRef(new Map<string, HTMLButtonElement>())
  const detailReturnFocusIdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    hydrateWorkspace(workspaceId)
  }, [hydrateWorkspace, workspaceId])

  const closeAddAgent = useCallback(() => {
    setAdding(false)
    setError(undefined)
    addButtonRef.current?.focus()
  }, [])

  const closeAgentDetails = useCallback(() => {
    const returnFocusId = detailReturnFocusIdRef.current ?? selectedAgentId
    onClearAgent?.()
    window.setTimeout(() => {
      if (returnFocusId) agentCardRefs.current.get(returnFocusId)?.focus()
    }, 0)
  }, [onClearAgent, selectedAgentId])

  useDismissableSurface({
    open: adding,
    onDismiss: closeAddAgent,
    surfaceRef: dialogRef,
    triggerRef: addButtonRef,
  })

  useEffect(() => {
    if (!adding) return
    dialogRef.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus()
  }, [adding])

  useDismissableSurface({
    open: Boolean(selectedAgentId),
    onDismiss: closeAgentDetails,
    surfaceRef: detailDialogRef,
  })

  useEffect(() => {
    if (!selectedAgentId) return
    setAdding(false)
    detailCloseRef.current?.focus()
  }, [selectedAgentId])

  const addAgent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const role = String(form.get('role') ?? '').trim()
    const description = String(form.get('description') ?? '').trim()
    if (!name) {
      setError('Name is required.')
      return
    }

    const parsed = AgentSchema.safeParse({
      id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      ...(role ? { role } : {}),
      ...(description ? { description } : {}),
    })
    if (!parsed.success) {
      setError('Review the agent details and try again.')
      return
    }

    const next = [...localAgents, parsed.data]
    setStoredLocalAgents(workspaceId, next)
    setError(undefined)
    closeAddAgent()
  }

  const deletedAgentIdSet = new Set(deletedAgentIds)
  const visibleAgents = [...agents, ...localAgents].filter((agent) => !deletedAgentIdSet.has(agent.id))
  const reorder = useReorderableAgents(
    workspaceId,
    visibleAgents.map((agent) => ({ id: agent.id, label: agent.name })),
  )
  const agentById = new Map(visibleAgents.map((agent) => [agent.id, agent]))
  const orderedAgents = reorder.orderedIds
    .map((agentId) => agentById.get(agentId))
    .filter((agent): agent is Agent => Boolean(agent))
  const localAgentIds = new Set(localAgents.map((agent) => agent.id))
  const liveAgent = visibleAgents.find((agent) => agent.id === selectedAgentId)
  const detailAgentSnapshotRef = useRef<Agent | undefined>(liveAgent)
  if (liveAgent) detailAgentSnapshotRef.current = liveAgent
  const selectedAgent = liveAgent ?? (detailPresence.exiting ? detailAgentSnapshotRef.current : undefined)
  const selectedAgentIsLocal = Boolean(selectedAgent && localAgents.some((agent) => agent.id === selectedAgent.id))
  const openAgentDetails = (agentId: string) => {
    detailReturnFocusIdRef.current = agentId
    setAdding(false)
    onSelectAgent?.(agentId)
  }

  useEffect(() => {
    if (selectedAgentId) {
      detailReturnFocusIdRef.current = selectedAgentId
      return
    }
    const returnFocusId = detailReturnFocusIdRef.current
    if (!returnFocusId) return
    window.setTimeout(() => agentCardRefs.current.get(returnFocusId)?.focus(), 0)
  }, [selectedAgentId])

  return (
    <div className="agents-directory" data-testid="agents-directory">
      <header className="agents-directory-header">
        <div>
          <p className="panel-kicker">Workspace directory</p>
          <h1>Agents</h1>
          <p>Browse the reusable agents available to this workspace.</p>
        </div>
        <button
          ref={addButtonRef}
          type="button"
          className="agents-add-button"
          aria-expanded={adding}
          aria-controls="add-agent-form"
          onClick={() => {
            setAdding(true)
            setError(undefined)
          }}
        >
          <Plus aria-hidden="true" size={16} />
          Add agent
        </button>
      </header>

      {addPresence.mounted ? (
        <div
          className="agent-add-backdrop"
          data-presence={addPresence.exiting ? 'exiting' : 'entering'}
          inert={addPresence.exiting || undefined}
        >
          <form
            ref={dialogRef}
            className="agent-add-form"
            id="add-agent-form"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-agent-title"
            aria-describedby="add-agent-description"
            onSubmit={addAgent}
            onKeyDown={trapDialogFocus}
            noValidate
          >
            <div className="agent-add-form-heading">
              <div className="agent-add-form-copy">
                <h2 id="add-agent-title">Add a local agent</h2>
                <p id="add-agent-description">This creates a session-only draft in this browser tab. It is not saved to the workspace.</p>
              </div>
              <button type="button" aria-label="Close add agent" title="Close" onClick={closeAddAgent}>
                <X aria-hidden="true" size={17} />
              </button>
            </div>
            <label>
              Name
              <input name="name" autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={error ? 'agent-name-error' : undefined} />
            </label>
            <label>
              Role <span>Optional</span>
              <input name="role" autoComplete="off" />
            </label>
            <label className="agent-add-description">
              Description <span>Optional</span>
              <textarea name="description" rows={3} />
            </label>
            {error ? <p className="agent-add-error" id="agent-name-error" role="alert">{error}</p> : null}
            <div className="agent-add-actions">
              <button type="button" onClick={closeAddAgent}>Cancel</button>
              <button type="submit" className="agents-add-button">Add local agent</button>
            </div>
          </form>
        </div>
      ) : null}

      {visibleAgents.length > 0 ? (
        <div className="agent-directory-grid" aria-label="Agents" {...reorder.containerProps}>
          {orderedAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              local={localAgentIds.has(agent.id)}
              selected={selectedAgentId === agent.id}
              onSelect={openAgentDetails}
              reorderProps={reorder.getCardProps(agent.id)}
              buttonRef={(button) => {
                if (button) agentCardRefs.current.set(agent.id, button)
                else agentCardRefs.current.delete(agent.id)
              }}
            />
          ))}
        </div>
      ) : (
        <div className="agents-directory-empty" data-testid="agents-empty">
          <h2>No agents yet</h2>
          <p>Add a local session draft to explore the directory layout. Persistent agent creation is not available in Phase 1.</p>
        </div>
      )}

      <p
        key={announcement?.nonce ?? 0}
        className="visually-hidden"
        data-testid="agent-reorder-announcement"
        role="status"
        aria-live="polite"
      >
        {announcement?.message ?? ''}
      </p>

      {detailPresence.mounted ? (
        <div
          className="agent-detail-backdrop"
          data-presence={detailPresence.exiting ? 'exiting' : 'entering'}
          inert={detailPresence.exiting || undefined}
        >
          <div
            ref={detailDialogRef}
            className="agent-detail-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-detail-title"
            aria-describedby="agent-detail-description"
            onKeyDown={trapDialogFocus}
          >
            <div className="agent-detail-heading">
              <div>
                <p className="panel-kicker">Agent details</p>
                <h2 id="agent-detail-title">{selectedAgent ? selectedAgent.name : 'Agent unavailable'}</h2>
              </div>
              <button ref={detailCloseRef} type="button" aria-label="Close agent details" onClick={closeAgentDetails}>
                <X aria-hidden="true" size={17} />
              </button>
            </div>
            {selectedAgent ? (
              <>
                <p id="agent-detail-description">
                  {selectedAgent.description?.trim() || 'No description has been provided.'}
                </p>
                <dl className="agent-detail-facts">
                  <div><dt>Role</dt><dd>{selectedAgent.role ?? 'Agent'}</dd></div>
                  <div><dt>State</dt><dd>{selectedAgentIsLocal ? 'Not connected' : executionLabel(selectedAgent)}</dd></div>
                  <div><dt>Model</dt><dd>{selectedAgent.model ?? 'Not specified'}</dd></div>
                  <div><dt>Source</dt><dd>{selectedAgentIsLocal ? 'Local session' : 'Workspace data'}</dd></div>
                </dl>
              </>
            ) : (
              <p id="agent-detail-description">
                This agent is not available in the current workspace or browser session.
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function AgentsDirectory({
  workspaceId,
  selectedAgentId,
  onSelectAgent,
  onClearAgent,
}: {
  workspaceId: string
  selectedAgentId?: string
  onSelectAgent?: (agentId: string) => void
  onClearAgent?: () => void
}) {
  const sessionWorkspace = isSessionWorkspaceId(workspaceId)
  const agentsQuery = useAgentsQuery(workspaceId, { enabled: !sessionWorkspace })

  if (sessionWorkspace) {
    return (
      <AgentsDirectoryContent
        key={workspaceId}
        workspaceId={workspaceId}
        agents={[]}
        selectedAgentId={selectedAgentId}
        onSelectAgent={onSelectAgent}
        onClearAgent={onClearAgent}
      />
    )
  }

  if (agentsQuery.isPending) {
    return <div className="agents-directory-state" data-testid="agents-loading" role="status">Loading agents…</div>
  }

  if (agentsQuery.isError || !agentsQuery.data) {
    return (
      <div className="agents-directory-state agents-directory-state-error" data-testid="agents-error" role="alert">
        <h1>Agents unavailable</h1>
        <p>{agentsQuery.error instanceof Error ? agentsQuery.error.message : 'The agents directory could not be loaded.'}</p>
        <button type="button" onClick={() => void agentsQuery.refetch()}>Retry</button>
      </div>
    )
  }

  return (
    <AgentsDirectoryContent
      key={workspaceId}
      workspaceId={workspaceId}
      agents={agentsQuery.data.agents}
      selectedAgentId={selectedAgentId}
      onSelectAgent={onSelectAgent}
      onClearAgent={onClearAgent}
    />
  )
}
