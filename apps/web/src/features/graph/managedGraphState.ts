import type { Agent, WorkflowDefinition } from '@graphql/contracts'
import type { GraphDraft } from '@graphql/contracts/management'

export type AgentRevisions = Readonly<Record<string, number | null>>
export interface ManagedEditBase {
  draft: GraphDraft
  agents: readonly Agent[]
  metadataRevisions: AgentRevisions
}
export type CloneSources = Readonly<Record<string, string>>

/** Stable comparison ignores object insertion order, never array ordering. */
export function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
export function sameManagedValue(left: unknown, right: unknown): boolean { return stableValue(left) === stableValue(right) }

export function managedDraftIsPublished(draft: GraphDraft): boolean {
  return draft.baseWorkflowVersionId !== null && draft.publishedRevision === draft.revision
}

export function captureManagedBase(draft: GraphDraft, agents: readonly Agent[], revisions: AgentRevisions): ManagedEditBase {
  return structuredClone({
    draft,
    agents: [...new Map([...agents, ...draft.stagedAgents.map((entry) => entry.agent)].map((agent) => [agent.id, agent])).values()],
    metadataRevisions: { ...revisions, ...Object.fromEntries(draft.stagedAgents.map((entry) => [entry.agent.id, entry.baseRevision])) },
  })
}

export function assertManagedBase(base: ManagedEditBase, current: GraphDraft): void {
  if (base.draft.id !== current.id || base.draft.workspaceId !== current.workspaceId
    || base.draft.workflowId !== current.workflowId || base.draft.revision !== current.revision) {
    throw new Error('This shared draft changed elsewhere. Your local edits are preserved. Discard local edits to load the latest draft; they will not be rebased automatically.')
  }
}

/** Strip server-owned workflow metadata when comparing an acknowledged graph. */
export function sameEditableGraph(left: WorkflowDefinition, right: WorkflowDefinition): boolean {
  return sameManagedValue(
    { nodes: left.nodes.map((node) => ({ ...node, position: undefined })), edges: left.edges, executionPolicy: left.executionPolicy, executionCondition: left.executionCondition, approval: left.approval, requiredAgentCount: left.requiredAgentCount },
    { nodes: right.nodes.map((node) => ({ ...node, position: undefined })), edges: right.edges, executionPolicy: right.executionPolicy, executionCondition: right.executionCondition, approval: right.approval, requiredAgentCount: right.requiredAgentCount },
  )
}
