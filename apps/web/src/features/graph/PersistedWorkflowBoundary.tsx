import { useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { CompatibleWorkflowDefinitionSchema } from '@graphql/contracts'

/** Current persisted records are not all legacy drafts. Guard before mounting the
 * legacy graph, whose queries, mapper and editing operations intentionally remain v1.
 * Do not normalize or cast a typed relationship into an untyped legacy edge. */
export function PersistedWorkflowBoundary({ workspaceId, workflowId, workflow, children }: {
  workspaceId: string
  workflowId: string
  workflow: unknown
  children: ReactNode
}) {
  const [showDefinition, setShowDefinition] = useState(false)
  const parsed = CompatibleWorkflowDefinitionSchema.safeParse(workflow)
  if (!parsed.success || parsed.data.workspaceId !== workspaceId || parsed.data.id !== workflowId) {
    return <section role="alert" className="workflow-graph-state workflow-graph-state-error">
      <h2>Workflow unavailable</h2>
      <p>The saved workflow does not match a supported definition in this workspace. Reload before editing.</p>
    </section>
  }
  const definition = parsed.data
  if (!('executionSemanticsVersion' in definition)) return <>{children}</>

  // Root decoding requires the exact tag 2, entry field and typed relationships.
  // This view does not infer Run state or admit a new Run.
  return <section className="workflow-graph-state" aria-label="Saved typed workflow" data-testid="persisted-workflow-v2">
    <h2>{definition.name}</h2>
    <p>Execution semantics 2 · Saved workflow version {definition.version ?? 'not published'}</p>
    <p>Entry node: <code>{definition.entryNodeId ?? 'not selected'}</code></p>
    <p>This typed workflow uses the v2 draft editor, not the legacy graph editor. New-Run admission remains disabled.</p>
    <Link to="/workspaces/$workspaceId/workflows/$workflowId/draft" params={{ workspaceId, workflowId }}>
      Open typed draft editor
    </Link>
    <h3>Relationships</h3>
    {definition.edges.length ? <ul>{definition.edges.map((edge) => <li key={edge.id}>
      <code>{edge.id}</code>: {edge.kind} · <code>{edge.source}</code> → <code>{edge.target}</code>
    </li>)}</ul> : <p>No relationships in this saved definition.</p>}
    <details onToggle={(event) => setShowDefinition(event.currentTarget.open)}>
      <summary>Exact saved definition, including choices and relationship kinds</summary>
      {showDefinition ? <pre>{JSON.stringify(definition, null, 2)}</pre> : null}
    </details>
  </section>
}
