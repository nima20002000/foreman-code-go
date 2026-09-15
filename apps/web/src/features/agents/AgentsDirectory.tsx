import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { AgentSchema, type Agent, type WorkflowDefinition } from '@graphql/contracts'
import { Link } from '@tanstack/react-router'
import { Check, MoreHorizontal, Plus, Trash2, X } from 'lucide-react'

import { useWorkspaceDetailsQuery } from '../../shared/api/query'
import { useSaveAgentMutation } from '../../shared/api/agentSettings'
import { useDismissableSurface } from '../../shared/ui/useDismissableSurface'
import { usePresence } from '../../shared/ui/usePresence'
import { isSessionWorkspaceId } from '../workspaces/workspaceSessionStore'
import { useSessionWorkflowStore } from '../workflows/sessionWorkflowStore'
import { useGraphDraftStore, workflowDraftKey } from '../graph/store'
import { useAgentDirectoryStore } from './agentDirectoryStore'
import { readDeletedAgentIds, readLocalAgents } from './localAgents'
import { effortLabels, effortOptions, initialModel, modelOptions } from './agentSettings'
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
  reorderProps,
  workspaceId,
  blockers,
  onRemove,
  onSave,
  saving,
  saveError,
}: {
  agent: Agent
  local: boolean
  reorderProps?: AgentReorderCardProps
  workspaceId: string
  blockers: readonly Pick<WorkflowDefinition, 'id' | 'name'>[]
  onRemove: () => void
  onSave: (agent: Agent) => void | Promise<void>
  saving: boolean
  saveError?: string
}) {
  const managedReadOnly = !local && import.meta.env.MODE !== 'test'
    && (!import.meta.env.DEV || import.meta.env.VITE_ENABLE_MSW === 'false')
  const [menuOpen, setMenuOpen] = useState(false)
  const [showBlockers, setShowBlockers] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [name, setName] = useState(agent.name)
  const [harness, setHarness] = useState(agent.harness ?? 'codex')
  const [model, setModel] = useState(() => initialModel(agent, agent.harness ?? 'codex'))
  const [effort, setEffort] = useState(agent.effort ?? 'medium')
  const [fastMode, setFastMode] = useState(agent.fastMode ?? false)
  const [localSaveError, setLocalSaveError] = useState<string>()
  const saveInFlight = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    setShowBlockers(false)
    setConfirmClose(false)
  }, [])
  const dirty = name.trim() !== agent.name
    || harness !== (agent.harness ?? 'codex')
    || model !== initialModel(agent, agent.harness ?? 'codex')
    || effort !== (agent.effort ?? 'medium')
    || fastMode !== (agent.fastMode ?? false)
  const requestClose = useCallback(() => {
    if (saveInFlight.current) return
    if (dirty) setConfirmClose(true)
    else closeMenu()
  }, [closeMenu, dirty])
  const save = useCallback(async () => {
    const nextName = name.trim()
    if (!nextName || saveInFlight.current || saving || managedReadOnly) return
    saveInFlight.current = true
    setLocalSaveError(undefined)
    try {
      await onSave({
        ...agent,
        name: nextName,
        harness,
        model,
        effort,
        ...(harness === 'codex' ? { fastMode } : { fastMode: undefined }),
      })
      closeMenu()
    } catch (error) {
      setLocalSaveError(error instanceof Error ? error.message : 'Agent settings could not be saved.')
    } finally {
      saveInFlight.current = false
    }
  }, [agent, closeMenu, effort, fastMode, harness, managedReadOnly, model, name, onSave, saving])
  useDismissableSurface({ open: menuOpen, onDismiss: requestClose, surfaceRef: menuRef, triggerRef })
  const role = agent.role ?? 'Agent'
  const status = local ? 'Local session' : executionLabel(agent)
  const { ref: reorderRef, ...reorderAttributes } = reorderProps ?? {}
  return <div
      ref={reorderRef}
      className="agent-directory-card-shell"
      tabIndex={0}
      data-local-agent={local || undefined}
      aria-label={`${agent.name}, ${role}, ${status}`}
      {...reorderAttributes}
    >
      <article className="agent-directory-card">
        <h2>{agent.name}</h2>
        <span>{role} · {status}</span>
      </article>
    <button
      ref={triggerRef}
      type="button"
      className="agent-directory-card-more"
      aria-label={`Open actions for ${agent.name}`}
      aria-haspopup="dialog"
      aria-expanded={menuOpen}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => {
        if (menuOpen) {
          requestClose()
          return
        }
        setName(agent.name)
        setHarness(agent.harness ?? 'codex')
        setModel(initialModel(agent, agent.harness ?? 'codex'))
        setEffort(agent.effort ?? 'medium')
        setFastMode(agent.fastMode ?? false)
        setMenuOpen(true)
      }}
    >
      <MoreHorizontal aria-hidden="true" size={17} />
    </button>
    {menuOpen ? (
      <div ref={menuRef} className="agent-directory-card-actions" role="dialog" aria-label={`${agent.name} actions`} onPointerDown={(event) => event.stopPropagation()}>
        {localSaveError || saveError ? <p role="alert">{localSaveError ?? saveError}</p> : null}
        {local ? <p role="note">Local preview: these settings are not executable until saved to the workspace.</p> : null}
        {managedReadOnly ? <div role="note">
          <p>Standalone agent editing is read-only in Operator mode. Open a workflow board to change this agent and Save graph.</p>
          {blockers.map((workflow) => <Link key={workflow.id} to="/workspaces/$workspaceId"
            params={{ workspaceId }} search={{ workflowId: workflow.id }}>{workflow.name}</Link>)}
          <button type="button" onClick={closeMenu}>Close</button>
        </div> : confirmClose ? (
          <div className="agent-settings-confirm">
            <p>You made changes. Save or discard?</p>
            <button type="button" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            <button type="button" onClick={closeMenu} disabled={saving}>Discard</button>
          </div>
        ) : <>
          <div className="agent-settings-heading">
            <strong>Agent settings</strong>
            <div>
              {harness === 'codex' ? <label className="agent-settings-fast"><input type="checkbox" disabled={saving} checked={fastMode} onChange={(event) => setFastMode(event.target.checked)} />Fast mode</label> : null}
              <button type="button" className="agent-settings-trash" disabled={saving} aria-label={`Remove ${agent.name}`} onClick={() => {
                if (blockers.length > 0) {
                  setShowBlockers(true)
                  return
                }
                onRemove()
                closeMenu()
              }}><Trash2 aria-hidden="true" size={16} /></button>
              <button type="button" aria-label="Close agent settings" disabled={saving} onClick={requestClose}><X aria-hidden="true" size={15} /></button>
            </div>
          </div>
          <label className="agent-settings-name">Name<input disabled={saving} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <div className="agent-settings-field"><span>Harness</span><select disabled={saving} aria-label="Harness" value={harness} onChange={(event) => {
            const nextHarness = event.target.value as NonNullable<Agent['harness']>
            setHarness(nextHarness)
            const nextModel = modelOptions(nextHarness).includes(model) ? model : modelOptions(nextHarness)[0]
            if (nextModel) setModel(nextModel)
            if (nextModel && !effortOptions(nextHarness, nextModel).includes(effort)) setEffort('max')
            event.currentTarget.blur()
          }}>
            <option value="codex">Codex</option><option value="opencode">OpenCode</option>
          </select></div>
          <div className="agent-settings-field"><span>Model</span><select disabled={saving} aria-label="Model" value={model} onChange={(event) => {
            const nextModel = event.target.value
            setModel(nextModel)
            if (!effortOptions(harness, nextModel).includes(effort)) setEffort('max')
            event.currentTarget.blur()
          }}>
            {modelOptions(harness).map((value) => <option key={value} value={value}>{value}</option>)}
          </select></div>
          <div className="agent-settings-field"><span>Effort</span><select disabled={saving} aria-label="Effort" value={effort} onChange={(event) => {
            setEffort(event.target.value as NonNullable<Agent['effort']>)
            event.currentTarget.blur()
          }}>
            {effortOptions(harness, model).map((value) => (
              <option key={value} value={value}>{effortLabels[value]}</option>
            ))}
          </select></div>
          {showBlockers ? (
          <div className="agent-removal-blocked" role="alert">
            <p>{agent.name} is already in use in:</p>
            {blockers.map((workflow) => (
              <Link
                key={workflow.id}
                to="/workspaces/$workspaceId"
                params={{ workspaceId }}
                search={{ workflowId: workflow.id }}
              >
                {workflow.name}
              </Link>
            ))}
          </div>
          ) : null}
          <div className="agent-settings-actions">
            <button type="button" className="agent-settings-save" aria-label="Save" title="Save" onClick={save} disabled={!dirty || saving}><Check aria-hidden="true" size={16} /></button>
          </div>
        </>}
      </div>
    ) : null}
  </div>
}

export function AgentsDirectoryContent({
  workspaceId,
  agents,
  selectedAgentId,
  onClearAgent,
  workflows = [],
  onSavePersistedAgent,
  saving = false,
  saveError,
}: {
  workspaceId: string
  agents: readonly Agent[]
  selectedAgentId?: string
  onClearAgent?: () => void
  workflows?: readonly WorkflowDefinition[]
  onSavePersistedAgent?: (agent: Agent) => Promise<void>
  saving?: boolean
  saveError?: string
}) {
  const catalog = useAgentDirectoryStore((state) => state.catalogs[workspaceId])
  const hydrateWorkspace = useAgentDirectoryStore((state) => state.hydrateWorkspace)
  const setStoredLocalAgents = useAgentDirectoryStore((state) => state.setLocalAgents)
  const deleteAgent = useAgentDirectoryStore((state) => state.deleteAgent)
  const sessionWorkflows = useSessionWorkflowStore((state) => state.workflows)
  const workflowNameOverrides = useSessionWorkflowStore((state) => state.workflowNameOverrides)
  const hiddenWorkflowIds = useSessionWorkflowStore((state) => state.hiddenWorkflowIds)
  const graphDrafts = useGraphDraftStore((state) => state.drafts)
  const localAgents = catalog?.localAgents ?? readLocalAgents(workspaceId)
  const deletedAgentIds = catalog?.deletedAgentIds ?? readDeletedAgentIds(workspaceId)
  const announcement = useAgentDirectoryStore((state) => state.announcement)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string>()
  const addPresence = usePresence(adding)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    hydrateWorkspace(workspaceId)
  }, [hydrateWorkspace, workspaceId])

  const closeAddAgent = useCallback(() => {
    setAdding(false)
    setError(undefined)
    addButtonRef.current?.focus()
  }, [])

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
  const visibleAgents = [...new Map([...agents, ...localAgents]
    .filter((agent) => !deletedAgentIdSet.has(agent.id))
    .map((agent) => [agent.id, agent])).values()]
  const reorder = useReorderableAgents(
    workspaceId,
    visibleAgents.map((agent) => ({ id: agent.id, label: agent.name })),
  )
  const agentById = new Map(visibleAgents.map((agent) => [agent.id, agent]))
  const orderedAgents = reorder.orderedIds
    .map((agentId) => agentById.get(agentId))
    .filter((agent): agent is Agent => Boolean(agent))
  const localAgentIds = new Set(localAgents.map((agent) => agent.id))
  const workspaceWorkflows = [
    ...workflows,
    ...Object.values(sessionWorkflows).filter((workflow) => workflow.workspaceId === workspaceId),
  ]
    .filter((workflow) => !hiddenWorkflowIds.includes(workflow.id))
    .map((workflow) => graphDrafts[workflowDraftKey(workspaceId, workflow.id)]?.workflow ?? workflow)
    .map((workflow) => ({
      ...workflow,
      name: workflowNameOverrides[workflow.id] ?? workflow.name,
    }))
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
              saving={saving}
              saveError={saveError}
              local={localAgentIds.has(agent.id)}
              reorderProps={reorder.getCardProps(agent.id)}
              workspaceId={workspaceId}
              blockers={workspaceWorkflows.filter((workflow) => (
                workflow.nodes.some((node) => node.agentId === agent.id)
              ))}
              onRemove={() => {
                deleteAgent(workspaceId, agent.id)
                if (selectedAgentId === agent.id) onClearAgent?.()
              }}
              onSave={async (updatedAgent) => {
                const persisted = !isSessionWorkspaceId(workspaceId) && agents.some((entry) => entry.id === updatedAgent.id)
                if (persisted && updatedAgent.configurationVersionId && !onSavePersistedAgent) {
                  throw new Error('Executable agent settings require the workspace save connection. These changes were not saved.')
                }
                if (persisted && onSavePersistedAgent) {
                  await onSavePersistedAgent(updatedAgent)
                  // Remove legacy browser overrides only after the server accepts
                  // the immutable configuration. Never discard a failed edit.
                  const latest = useAgentDirectoryStore.getState().catalogs[workspaceId]?.localAgents ?? localAgents
                  setStoredLocalAgents(workspaceId, latest.filter((entry) => entry.id !== updatedAgent.id))
                } else {
                  setStoredLocalAgents(workspaceId, [
                    ...localAgents.filter((entry) => entry.id !== updatedAgent.id),
                    updatedAgent,
                  ])
                }
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

    </div>
  )
}

export function AgentsDirectory({
  workspaceId,
  selectedAgentId,
  onClearAgent,
}: {
  workspaceId: string
  selectedAgentId?: string
  onClearAgent?: () => void
}) {
  const sessionWorkspace = isSessionWorkspaceId(workspaceId)
  const saveAgentMutation = useSaveAgentMutation()
  const agentsQuery = useWorkspaceDetailsQuery(workspaceId, { enabled: !sessionWorkspace })

  if (sessionWorkspace) {
    return (
      <AgentsDirectoryContent
        key={workspaceId}
        workspaceId={workspaceId}
        agents={[]}
        workflows={[]}
        selectedAgentId={selectedAgentId}
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
      onSavePersistedAgent={async (agent) => { await saveAgentMutation.mutateAsync({ workspaceId, agent }) }}
      saving={saveAgentMutation.isPending}
      saveError={saveAgentMutation.error instanceof Error ? saveAgentMutation.error.message : undefined}
      workflows={agentsQuery.data.workflows}
      selectedAgentId={selectedAgentId}
      onClearAgent={onClearAgent}
    />
  )
}
