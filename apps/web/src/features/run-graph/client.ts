import { RUN_CURRENT_ROUTE, RunCurrentRequestSchema, RunCurrentResponseSchema, type RunCurrentResponse } from '@graphql/contracts/run-current'
import { RunEventsListInputSchema, RunEventsPageSchema } from '@graphql/contracts/management'
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
  legacy(scope: RunGraphScope, signal: AbortSignal): Promise<RunCurrentResponse>
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
    legacy: (scope, signal) => client.request(legacyCurrentReadPath(scope), RunCurrentResponseSchema, { signal }),
  }
}
export const runGraphClient = createRunGraphClient()

export function legacyCurrentReadPath(scope: RunGraphScope): string {
  const request = RunCurrentRequestSchema.parse(scope)
  const path = RUN_CURRENT_ROUTE.replace(':workspaceId', encodeURIComponent(request.workspaceId))
    .replace(':runId', encodeURIComponent(request.runId))
  return `${path}?${new URLSearchParams({ workflowId: request.workflowId,
    workflowVersionId: request.workflowVersionId, executionSemanticsVersion: '1' })}`
}

/** Explicit detail access only. One page per call; never used by synchronization. */
export async function readLegacyRunActivityPage(scope: RunGraphScope, afterSequence: number | undefined,
  signal: AbortSignal, client: ApiClient = apiClient) {
  const pin = RunCurrentRequestSchema.parse(scope)
  if (afterSequence !== undefined && !Number.isSafeInteger(afterSequence)) {
    throw new GraphProtocolError('GRAPH_INVALID_LEGACY_HISTORY')
  }
  const input = RunEventsListInputSchema.parse({ workspaceId: pin.workspaceId, runId: pin.runId,
    ...(afterSequence === undefined ? {} : { afterSequence }), limit: 50 })
  const query = new URLSearchParams({ limit: String(input.limit) })
  if (input.afterSequence !== undefined) query.set('cursor', String(input.afterSequence))
  const response = await client.request(`/api/management/workspaces/${encodeURIComponent(input.workspaceId)}/runs/${encodeURIComponent(input.runId)}/events?${query}`,
    RunEventsPageSchema, { signal })
  let previous = input.afterSequence ?? -1
  for (const item of response.items) {
    if (item.runId !== input.runId || !Number.isSafeInteger(item.sequence) || item.sequence <= previous) {
      throw new GraphProtocolError('GRAPH_INVALID_LEGACY_HISTORY')
    }
    previous = item.sequence
  }
  if (response.items.length > input.limit || response.pageInfo.nextCursor !== null
    && (response.items.length === 0 || response.pageInfo.nextCursor !== String(previous))) {
    throw new GraphProtocolError('GRAPH_INVALID_LEGACY_HISTORY')
  }
  return response
}
