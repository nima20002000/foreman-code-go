import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'

import { useAgentsQuery } from '../../shared/api/query'
import { isSessionWorkspaceId } from '../workspaces/workspaceSessionStore'
import { useAgentDirectoryStore } from './agentDirectoryStore'
import { readDeletedAgentIds, readLocalAgents } from './localAgents'
import './agents.css'

export interface AgentNavigationProps {
  workspaceId: string
  /** URL-owned selection; undefined means no agent is selected in the URL. */
  activeAgentId?: string
}

/**
 * The nested agent submenu for one workspace. The list comes from the
 * server-shaped agents query; the selected agent stays in the URL `agentId`.
 */
export function AgentNavigation({ workspaceId, activeAgentId }: AgentNavigationProps) {
  const sessionWorkspace = isSessionWorkspaceId(workspaceId)
  const agentsQuery = useAgentsQuery(workspaceId, { enabled: !sessionWorkspace })
  const catalog = useAgentDirectoryStore((state) => state.catalogs[workspaceId])
  const hydrateWorkspace = useAgentDirectoryStore((state) => state.hydrateWorkspace)

  useEffect(() => {
    hydrateWorkspace(workspaceId)
  }, [hydrateWorkspace, workspaceId])

  const localAgents = catalog?.localAgents ?? readLocalAgents(workspaceId)
  const deletedAgentIds = catalog?.deletedAgentIds ?? readDeletedAgentIds(workspaceId)
  const deletedAgentIdSet = new Set(deletedAgentIds)

  const agents = [
    ...(sessionWorkspace ? [] : agentsQuery.data?.agents ?? []),
    ...localAgents,
  ].filter((agent) => !deletedAgentIdSet.has(agent.id))

  return (
    <section className="agent-navigation" data-testid="agent-navigation" aria-label="Workspace agents">
      {!sessionWorkspace && agentsQuery.isPending ? (
        <p className="agent-navigation-state" role="status">
          Loading agents…
        </p>
      ) : !sessionWorkspace && agentsQuery.isError ? (
        <p
          className="agent-navigation-state agent-navigation-state-error"
          data-testid="agent-navigation-error"
          role="alert"
        >
          Agents unavailable
        </p>
      ) : agents.length === 0 ? (
        <p className="agent-navigation-state" data-testid="agent-navigation-empty">
          No agents yet
        </p>
      ) : (
        <ul className="nav-submenu agent-navigation-list">
          {agents.map((agent) => {
            const active = agent.id === activeAgentId
            return (
              <li key={agent.id}>
                <Link
                  to="/workspaces/$workspaceId/agents"
                  params={{ workspaceId }}
                  search={(previous) => ({ ...previous, agentId: agent.id })}
                  className={`nav-item agent-navigation-item${active ? ' nav-item-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  title={agent.name}
                >
                  <span className="nav-item-label">{agent.name}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
