import type pg from 'pg'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import { CanonicalRunGraphScopeSchema, CanonicalRunGraphReadCapabilitiesSchema, type CanonicalRunGraphReadCapabilities,
  type RunGraphSnapshot, type RunGraphPage, type RunGraphReset,
  type RepeatGraphSnapshotV3, type RepeatGraphPageV3, type RepeatGraphResetV3, type RepeatGraphCurrentV3 } from '@graphql/contracts/wave25'
import { hasAction, requireAuthorization } from '../access/policy.js'
import type { RunGraphReadApi } from './readService.js'
import { readRepeatGraphSnapshot, readRepeatGraphPage, readRepeatGraphCurrent, type AuthorizeRepeatGraphRead } from './repeatReader.js'
import { RunGraphError } from './errors.js'

/** Authenticated, rollout-gated HTTP/Operator-MCP read boundary. The default is
 * closed. Uses the SAME access policy and actual Run tuple as RunGraphReadService;
 * worker/App principals cannot be promoted into Operator read authority. */
export class RepeatGraphReadService {
  readonly qualifiedReads: boolean
  constructor(private readonly primaryPool: pg.Pool, options: { qualifiedReads?: boolean } = {}) {
    // Capture once at trusted composition, not from a mutable request/options object.
    this.qualifiedReads = options.qualifiedReads === true
  }
  private authorize(input: ManagementPrincipal): AuthorizeRepeatGraphRead {
    let principal: ManagementPrincipal
    try {
      principal = ManagementPrincipalSchema.parse(input)
      if (!hasAction(principal, 'runs:read')) throw new RunGraphError('GRAPH_READ_ACCESS_DENIED')
    } catch { throw new RunGraphError('GRAPH_READ_ACCESS_DENIED') }
    if (!this.qualifiedReads) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
    return async (sql, scope) => {
      const row = (await sql.query<{ workspace_id: string; workflow_id: string; id: string }>(
        'select workspace_id,workflow_id,id from runs where id=$1', [scope.runId])).rows[0]
      if (!row) throw new RunGraphError('GRAPH_READ_ACCESS_DENIED')
      requireAuthorization(principal, 'runs:read', { workspaceId: row.workspace_id, workflowId: row.workflow_id, runId: row.id })
    }
  }
  private async checked<T>(read: () => Promise<T>): Promise<T> {
    try { return await read() } catch (error) {
      throw error instanceof RunGraphError ? error : new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
  }
  snapshot(principal: ManagementPrincipal, request: unknown) {
    return this.checked(() => readRepeatGraphSnapshot(this.primaryPool, request, this.authorize(principal)))
  }
  current(principal: ManagementPrincipal, request: unknown) {
    return this.checked(() => readRepeatGraphCurrent(this.primaryPool, request, this.authorize(principal)))
  }
  events(principal: ManagementPrincipal, request: unknown) {
    return this.checked(() => readRepeatGraphPage(this.primaryPool, request, this.authorize(principal)))
  }
}
export interface CanonicalRunGraphReadApi {
  capabilities: RunGraphReadApi['capabilities']
  readCapabilities(principal: ManagementPrincipal): CanonicalRunGraphReadCapabilities
  current(principal: ManagementPrincipal, request: unknown): Promise<RunGraphSnapshot | RepeatGraphCurrentV3>
  snapshot(principal: ManagementPrincipal, request: unknown): Promise<RunGraphSnapshot | RepeatGraphSnapshotV3>
  events(principal: ManagementPrincipal, request: unknown): Promise<RunGraphPage | RunGraphReset | RepeatGraphPageV3 | RepeatGraphResetV3>
}
/** Shared dispatch for the canonical HTTP/MCP callers. The original legacy
 * capability response is unchanged; additive discovery describes READS only.
 * Unknown versions fail before either producer can coerce them to 1, 2 or 3. */
export function canonicalRunGraphReadApi(legacy: RunGraphReadApi, repeat = legacy.repeat): CanonicalRunGraphReadApi {
  function target(request: unknown) {
    if (typeof request !== 'object' || request === null || !('scope' in request)) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    const scope = CanonicalRunGraphScopeSchema.safeParse(request.scope)
    if (!scope.success) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    if (scope.data.executionSemanticsVersion !== 3) return { kind: 'legacy' as const, reader: legacy }
    if (!repeat) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
    return { kind: 'repeat' as const, reader: repeat }
  }
  return {
    capabilities: (principal) => legacy.capabilities(principal),
    readCapabilities: (principal) => {
      // This call retains the same runs:read principal requirement as legacy
      // discovery. Scope authorization still occurs against each actual Run.
      const capabilities = legacy.capabilities(principal)
      const persistedReads = repeat?.qualifiedReads === true
      const readSemanticsVersions = [...capabilities.executionSemanticsVersions, ...(persistedReads ? [3] : [])]
      return CanonicalRunGraphReadCapabilitiesSchema.parse({
        capabilityVersion: 1, protocolVersions: readSemanticsVersions.length ? [1] : [],
        readSemanticsVersions, transport: capabilities.transport, activePollMs: capabilities.activePollMs,
        semantics3: { persistedReads, payload: 'metadata_only', runtimeAdmission: false, meaningfulEdit: false },
      })
    },
    current: (principal, request) => {
      const reader = target(request)
      // Legacy current/history are not reinterpreted as v3 envelopes.
      return reader.kind === 'repeat' ? reader.reader.current(principal, request) : reader.reader.snapshot(principal, request)
    },
    snapshot: (principal, request) => target(request).reader.snapshot(principal, request),
    events: (principal, request) => target(request).reader.events(principal, request),
  }
}
