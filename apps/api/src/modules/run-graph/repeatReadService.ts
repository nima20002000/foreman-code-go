import type pg from 'pg'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import { CanonicalRunGraphScopeSchema, type RunGraphSnapshot, type RunGraphPage, type RunGraphReset,
  type RepeatGraphSnapshotV3, type RepeatGraphPageV3, type RepeatGraphResetV3 } from '@graphql/contracts/wave25'
import { hasAction, requireAuthorization } from '../access/policy.js'
import type { RunGraphReadApi } from './readService.js'
import { readRepeatGraphSnapshot, readRepeatGraphPage, readRepeatGraphCurrent, type AuthorizeRepeatGraphRead } from './repeatReader.js'
import { RunGraphError } from './errors.js'

/** Authenticated, rollout-gated HTTP/Operator-MCP read boundary. The default is
 * closed. Uses the SAME access policy and actual Run tuple as RunGraphReadService;
 * worker/App principals cannot be promoted into Operator read authority. */
export class RepeatGraphReadService {
  constructor(private readonly primaryPool: pg.Pool, private readonly options: { qualifiedReads?: boolean } = {}) {}
  private authorize(input: ManagementPrincipal): AuthorizeRepeatGraphRead {
    let principal: ManagementPrincipal
    try {
      principal = ManagementPrincipalSchema.parse(input)
      if (!hasAction(principal, 'runs:read')) throw new RunGraphError('GRAPH_READ_ACCESS_DENIED')
    } catch { throw new RunGraphError('GRAPH_READ_ACCESS_DENIED') }
    if (!this.options.qualifiedReads) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
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
  snapshot(principal: ManagementPrincipal, request: unknown): Promise<RunGraphSnapshot | RepeatGraphSnapshotV3>
  events(principal: ManagementPrincipal, request: unknown): Promise<RunGraphPage | RunGraphReset | RepeatGraphPageV3 | RepeatGraphResetV3>
}
/** Concrete interface for the excluded HTTP/MCP callers. No capabilities or
 * admission flag is widened here. Keep their existing policy/transport limits.
 * Unknown versions fail before either producer can coerce them to 1, 2 or 3. */
export function canonicalRunGraphReadApi(legacy: RunGraphReadApi, repeat: RepeatGraphReadService): CanonicalRunGraphReadApi {
  function target(request: unknown) {
    if (typeof request !== 'object' || request === null || !('scope' in request)) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    const scope = CanonicalRunGraphScopeSchema.safeParse(request.scope)
    if (!scope.success) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    return scope.data.executionSemanticsVersion === 3 ? repeat : legacy
  }
  return {
    snapshot: (principal, request) => target(request).snapshot(principal, request),
    events: (principal, request) => target(request).events(principal, request),
  }
}
