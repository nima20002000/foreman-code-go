import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { AgentSchema, type Agent, type WorkflowDefinition } from '@graphql/contracts'
import { Link } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'

import { useWorkspaceDetailsQuery } from '../../shared/api/query'
import { useSaveAgentMutation } from '../../shared/api/agentSettings'
import {
  Button, Card, CardHeader, Checkbox, Dialog, EmptyState, Icon, IconButton, LoadingState,
  PageHeader, Select, TextField, Textarea,
} from '../../shared/ui/nocturne'
import { useDismissableSurface } from '../../shared/ui/useDismissableSurface'
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
      <Card className="agent-directory-card">
        <CardHeader title={agent.name} description={`${role} · ${status}`} />
      </Card>
    <IconButton
      ref={triggerRef}
      className="agent-directory-card-more"
      label={`Open actions for ${agent.name}`}
      variant="ghost"
      size="sm"
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
      <Icon name="more" size={17} />
    </IconButton>
    {menuOpen ? (
      <div ref={menuRef} className="agent-directory-card-actions" role="dialog" aria-label={`${agent.name} actions`} onPointerDown={(event) => event.stopPropagation()}>
        {localSaveError || saveError ? <p role="alert">{localSaveError ?? saveError}</p> : null}
        {local ? <p role="note">Local preview: these settings are not executable until saved to the workspace.</p> : null}
        {managedReadOnly ? <div role="note">
          <p>Standalone agent editing is read-only in Operator mode. Open a workflow board to change this agent and Save graph.</p>
          {blockers.map((workflow) => <Link key={workflow.id} to="/workspaces/$workspaceId"
            params={{ workspaceId }} search={{ workflowId: workflow.id }}>{workflow.name}</Link>)}
          <Button onClick={closeMenu}>Close</Button>
        </div> : confirmClose ? (
          <div className="agent-settings-confirm">
            <p>You made changes. Save or discard?</p>
            <Button onClick={save} disabled={saving} loading={saving} loadingLabel="Saving…">Save</Button>
            <Button onClick={closeMenu} disabled={saving}>Discard</Button>
          </div>
        ) : <>
          <div className="agent-settings-heading">
            <strong>Agent settings</strong>
            <div>
              {harness === 'codex' ? <Checkbox label="Fast mode" disabled={saving} checked={fastMode} onChange={(event) => setFastMode(event.target.checked)} /> : null}
              <IconButton label={`Remove ${agent.name}`} className="agent-settings-trash" size="sm" disabled={saving} onClick={() => {
                if (blockers.length > 0) {
                  setShowBlockers(true)
                  return
                }
                onRemove()
                closeMenu()
              }}><Trash2 aria-hidden="true" size={16} /></IconButton>
              <IconButton label="Close agent settings" size="sm" disabled={saving} onClick={requestClose}><Icon name="close" size={15} /></IconButton>
            </div>
          </div>
          <TextField className="agent-settings-name" label="Name" disabled={saving} value={name} onChange={(event) => setName(event.target.value)} />
          <Select label="Harness" disabled={saving} value={harness} options={[{ value: 'codex', label: 'Codex' }, { value: 'opencode', label: 'OpenCode' }]} onChange={(event) => {
            const nextHarness = event.target.value as NonNullable<Agent['harness']>
            setHarness(nextHarness)
            const nextModel = modelOptions(nextHarness).includes(model) ? model : modelOptions(nextHarness)[0]
            if (nextModel) setModel(nextModel)
            if (nextModel && !effortOptions(nextHarness, nextModel).includes(effort)) setEffort('max')
            event.currentTarget.blur()
          }} />
          <Select label="Model" disabled={saving} value={model} options={modelOptions(harness).map((value) => ({ value, label: value }))} onChange={(event) => {
            const nextModel = event.target.value
            setModel(nextModel)
            if (!effortOptions(harness, nextModel).includes(effort)) setEffort('max')
            event.currentTarget.blur()
          }} />
          <Select label="Effort" disabled={saving} value={effort} options={effortOptions(harness, model).map((value) => ({ value, label: effortLabels[value] }))} onChange={(event) => {
            setEffort(event.target.value as NonNullable<Agent['effort']>)
            event.currentTarget.blur()
          }} />
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
            <IconButton label="Save" className="agent-settings-save" size="sm" disabled={!dirty || saving} onClick={save}><Icon name="check" size={16} /></IconButton>
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
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    hydrateWorkspace(workspaceId)
  }, [hydrateWorkspace, workspaceId])

  const closeAddAgent = useCallback(() => {
    setAdding(false)
    setError(undefined)
    addButtonRef.current?.focus()
  }, [])

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
      <PageHeader
        eyebrow="Workspace directory"
        title="Agents"
        description="Browse the reusable agents available to this workspace."
        actions={
          <Button
            ref={addButtonRef}
            variant="primary"
            aria-expanded={adding}
            aria-controls="add-agent-form"
            leading={<Icon name="plus" size={16} />}
            onClick={() => {
              setAdding(true)
              setError(undefined)
            }}
          >
            Add agent
          </Button>
        }
      />

      {adding ? (
        <Dialog
          open
          onOpenChange={(open) => { if (!open) closeAddAgent() }}
          title="Add a local agent"
          description="This creates a session-only draft in this browser tab. It is not saved to the workspace."
          closeLabel="Close add agent"
          size="lg"
          closeOnOutsideClick
          initialFocusRef={nameInputRef}
        >
          <form className="agent-add-form" id="add-agent-form" onSubmit={addAgent} noValidate>
            <TextField
              ref={nameInputRef}
              label="Name"
              name="name"
              autoComplete="off"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'agent-name-error' : undefined}
            />
            <TextField label="Role" hint="Optional" name="role" autoComplete="off" />
            <Textarea className="agent-add-description" label="Description" hint="Optional" name="description" rows={3} />
            {error ? <p className="agent-add-error" id="agent-name-error" role="alert">{error}</p> : null}
            <div className="agent-add-actions">
              <Button onClick={closeAddAgent}>Cancel</Button>
              <Button type="submit" variant="primary">Add local agent</Button>
            </div>
          </form>
        </Dialog>
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
        <div data-testid="agents-empty">
          <EmptyState
            icon="bot"
            title="No agents yet"
            description="Add a local session draft to explore the directory layout. Persistent agent creation is not available in Phase 1."
          />
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
    return <div data-testid="agents-loading"><LoadingState label="Loading agents…" /></div>
  }

  if (agentsQuery.isError || !agentsQuery.data) {
    return (
      <div data-testid="agents-error" role="alert">
        <EmptyState
          icon="warning"
          title="Agents unavailable"
          description={agentsQuery.error instanceof Error ? agentsQuery.error.message : 'The agents directory could not be loaded.'}
          action={<Button onClick={() => void agentsQuery.refetch()} leading={<Icon name="refresh" size={16} />}>Retry</Button>}
        />
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
