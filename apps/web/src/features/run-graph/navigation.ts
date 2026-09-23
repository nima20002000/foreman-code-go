import { RunGraphScopeSchema, type RunGraphScope } from '@graphql/contracts/wave25'

export function runGraphHref(input: RunGraphScope): string {
  const scope = RunGraphScopeSchema.parse(input)
  const path = [scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId].map(encodeURIComponent)
  return `/workspaces/${path[0]}/workflows/${path[1]}/runs/${path[2]}/graph/${path[3]}/${scope.executionSemanticsVersion}`
}
