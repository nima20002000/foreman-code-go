import type { GetRunResponse } from '@graphql/contracts'
import {
  RUN_GRAPH_ROUTES, RunGraphCapabilitiesSchema, RunGraphEventsRequestSchema,
  RunGraphEventsResponseSchema, RunGraphReadRequestSchema, RunGraphSnapshotSchema,
  type RunGraphScope, type RunGraphSnapshot, type RunGraphPage, type RunGraphReset,
} from '@graphql/contracts/wave25'
import { apiClient, type ApiClient } from '../../shared/api/client'
import { GraphProtocolError } from './errors'

export type GraphCapabilities = ReturnType<typeof RunGraphCapabilitiesSchema.parse>
export interface RunGraphClient {
  capabilities(signal: AbortSignal): Promise<GraphCapabilities>
  snapshot(scope: RunGraphScope, signal: AbortSignal): Promise<RunGraphSnapshot>
  events(scope: RunGraphScope, afterSequence: string, signal: AbortSignal): Promise<RunGraphPage | RunGraphReset>
  legacy(scope: RunGraphScope, signal: AbortSignal): Promise<GetRunResponse>
}

export function graphReadPath(scope: RunGraphScope, afterSequence?: string): string {
  const request = afterSequence === undefined
    ? RunGraphReadRequestSchema.parse({ scope, protocolVersion: 1 })
    : RunGraphEventsRequestSchema.parse({ scope, protocolVersion: 1, afterSequence })
  const path = (afterSequence === undefined ? RUN_GRAPH_ROUTES.snapshot : RUN_GRAPH_ROUTES.events)
    .replace(':workspaceId', encodeURIComponent(request.scope.workspaceId))
    .replace(':workflowId', encodeURIComponent(request.scope.workflowId))
    .replace(':runId', encodeURIComponent(request.scope.runId))
  const query = new URLSearchParams({ workflowVersionId: request.scope.workflowVersionId,
    executionSemanticsVersion: String(request.scope.executionSemanticsVersion) })
  if (afterSequence !== undefined) query.set('afterSequence', afterSequence)
  return `${path}?${query.toString()}`
}

/** Selection is a successful, schema-checked capability negotiation, not an error fallback. */
export function negotiateGraphReader(input: unknown, scope: RunGraphScope): 'graph' | 'legacy' {
  const capabilities = RunGraphCapabilitiesSchema.safeParse(input)
  if (!capabilities.success) throw new GraphProtocolError('GRAPH_UNSUPPORTED_PROTOCOL')
  const value = capabilities.data
  if (value.protocolVersions.includes(1) && value.executionSemanticsVersions.includes(scope.executionSemanticsVersion)) return 'graph'
  // S2 explicitly advertises only [2] for graph reads. Semantics 1 retains its existing reader.
  if (scope.executionSemanticsVersion === 1 && !value.executionSemanticsVersions.includes(1)) return 'legacy'
  throw new GraphProtocolError('GRAPH_UNSUPPORTED_PROTOCOL')
}

/** Uses the existing cookie/session/authentication boundary; no parallel fetch implementation. */
export function createRunGraphClient(client: ApiClient = apiClient): RunGraphClient {
  return {
    capabilities: (signal) => client.request(RUN_GRAPH_ROUTES.capabilities, RunGraphCapabilitiesSchema, { signal }),
    snapshot: (scope, signal) => client.request(graphReadPath(scope), RunGraphSnapshotSchema, { signal }),
    events: (scope, after, signal) => client.request(graphReadPath(scope, after), RunGraphEventsResponseSchema, { signal }),
    legacy: (scope, signal) => client.getRun({ workspaceId: scope.workspaceId, runId: scope.runId }, { signal }),
  }
}
export const runGraphClient = createRunGraphClient()
