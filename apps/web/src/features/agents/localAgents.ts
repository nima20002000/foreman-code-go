import { AgentSchema, type Agent } from '@graphql/contracts'

function localAgentsKey(workspaceId: string) {
  return `graphql-local-agents:${workspaceId}`
}

export function readLocalAgents(workspaceId: string): Agent[] {
  try {
    const value = sessionStorage.getItem(localAgentsKey(workspaceId))
    if (!value) return []
    const parsed = AgentSchema.array().safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export function writeLocalAgents(workspaceId: string, agents: readonly Agent[]) {
  sessionStorage.setItem(localAgentsKey(workspaceId), JSON.stringify(AgentSchema.array().parse(agents)))
}
