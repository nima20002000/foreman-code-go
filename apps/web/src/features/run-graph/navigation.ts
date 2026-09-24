import { RunGraphScopeSchema, type RunGraphScope } from '@graphql/contracts/wave25'

/** New links point at the board; the old fully pinned paths remain accepted aliases. */
export function runGraphHref(input: RunGraphScope): string {
  const scope = RunGraphScopeSchema.parse(input)
  const query = new URLSearchParams({ workflowId: scope.workflowId, runId: scope.runId,
    workflowVersionId: scope.workflowVersionId, executionSemanticsVersion: String(scope.executionSemanticsVersion) })
  return `/workspaces/${encodeURIComponent(scope.workspaceId)}?${query}`
}
