import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { AgentSchema, type Agent } from '@graphql/contracts'
import { Plus, X } from 'lucide-react'

import { useAgentsQuery } from '../../shared/api/query'
import { readLocalAgents, writeLocalAgents } from './localAgents'
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

function AgentCard({ agent, local }: { agent: Agent; local: boolean }) {
  return (
    <article className="agent-directory-card" data-local-agent={local || undefined}>
      <div className="agent-directory-card-heading">
        <div>
          <p className="agent-directory-card-role">{agent.role ?? 'Agent'}</p>
          <h2>{agent.name}</h2>
        </div>
        <span className={`agent-directory-source${local ? ' agent-directory-source-local' : ''}`}>
          {local ? 'Local session' : 'Workspace data'}
        </span>
      </div>
      <p className="agent-directory-description">
        {agent.description?.trim() || 'No description has been provided.'}
      </p>
      <dl className="agent-directory-facts">
        <div>
          <dt>State</dt>
          <dd>{local ? 'Not connected' : executionLabel(agent)}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{agent.model ?? 'Not specified'}</dd>
        </div>
      </dl>
    </article>
  )
}

export function AgentsDirectoryContent({ workspaceId, agents }: { workspaceId: string; agents: readonly Agent[] }) {
  const [localAgents, setLocalAgents] = useState<Agent[]>(() => readLocalAgents(workspaceId))
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string>()
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLFormElement>(null)

  const closeAddAgent = useCallback(() => {
    setAdding(false)
    setError(undefined)
    addButtonRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!adding) return
    dialogRef.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeAddAgent()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [adding, closeAddAgent])

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
    setLocalAgents(next)
    writeLocalAgents(workspaceId, next)
    setError(undefined)
    closeAddAgent()
  }

  const visibleAgents = [...agents, ...localAgents]

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

      {adding ? (
        <div
          className="agent-add-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAddAgent()
          }}
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
        <div className="agent-directory-grid" aria-label="Agents">
          {agents.map((agent) => <AgentCard key={agent.id} agent={agent} local={false} />)}
          {localAgents.map((agent) => <AgentCard key={agent.id} agent={agent} local />)}
        </div>
      ) : (
        <div className="agents-directory-empty" data-testid="agents-empty">
          <h2>No agents yet</h2>
          <p>Add a local session draft to explore the directory layout. Persistent agent creation is not available in Phase 1.</p>
        </div>
      )}
    </div>
  )
}

export function AgentsDirectory({ workspaceId }: { workspaceId: string }) {
  const agentsQuery = useAgentsQuery(workspaceId)

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

  return <AgentsDirectoryContent workspaceId={workspaceId} agents={agentsQuery.data.agents} />
}
