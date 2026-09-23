import type pg from 'pg'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@graphql/contracts/management'
import {
  DISABLED_RUN_GRAPH_CAPABILITIES, RunGraphCapabilitiesSchema, graphJsonBytes,
  type RunGraphSnapshot, type RunGraphPage, type RunGraphReset,
} from '@graphql/contracts/wave25'
import { hasAction, requireAuthorization } from '../access/policy.js'
import { RunGraphError } from './errors.js'
import { readRunGraphPage, readRunGraphSnapshot, type AuthorizeRunGraphRead, type ReadCurrentRunGraph } from './reader.js'
import { observeGraph, type GraphMeasurementSink } from './measurements.js'

export interface RunGraphReadApi {
  capabilities(principal: ManagementPrincipal): typeof DISABLED_RUN_GRAPH_CAPABILITIES
  snapshot(principal: ManagementPrincipal, request: unknown): Promise<RunGraphSnapshot>
  events(principal: ManagementPrincipal, request: unknown): Promise<RunGraphPage | RunGraphReset>
}

/** Both HTTP and Operator MCP use this service. Supply the PRIMARY database pool. */
export class RunGraphReadService implements RunGraphReadApi {
  constructor(private readonly primaryPool: pg.Pool, private readonly assemble: ReadCurrentRunGraph,
    private readonly options: { qualifiedReads?: boolean; measurements?: GraphMeasurementSink } = {}) {}

  capabilities(principal: ManagementPrincipal) {
    this.principal(principal)
    if (!this.options.qualifiedReads) return DISABLED_RUN_GRAPH_CAPABILITIES
    return RunGraphCapabilitiesSchema.parse({ ...DISABLED_RUN_GRAPH_CAPABILITIES,
      protocolVersions: [1], executionSemanticsVersions: [2] })
    // Reader qualification NEVER enables authoring/admission. That remains the coordinator's gate.
  }
  private principal(input: ManagementPrincipal): ManagementPrincipal {
    try {
      const principal = ManagementPrincipalSchema.parse(input)
      if (hasAction(principal, 'runs:read')) return principal
    } catch { /* App/worker principals and malformed/expired grants fail closed. */ }
    throw new RunGraphError('GRAPH_READ_ACCESS_DENIED')
  }
  private authorize(principal: ManagementPrincipal): AuthorizeRunGraphRead {
    return async (sql, scope) => {
      // Authorize the ACTUAL tuple, not a caller's workspace/workflow claim. G1
      // independently compares every requested pin against that tuple afterwards.
      const row = (await sql.query<{ workspace_id: string; workflow_id: string; id: string }>(
        'select workspace_id,workflow_id,id from runs where id=$1', [scope.runId])).rows[0]
      if (!row) throw new RunGraphError('GRAPH_READ_ACCESS_DENIED')
      requireAuthorization(principal, 'runs:read', { workspaceId: row.workspace_id, workflowId: row.workflow_id, runId: row.id })
    }
  }
  async snapshot(input: ManagementPrincipal, request: unknown): Promise<RunGraphSnapshot> {
    const principal = this.principal(input)
    if (!this.options.qualifiedReads) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
    return this.measured('snapshot', () => readRunGraphSnapshot(this.primaryPool, request, this.authorize(principal), this.assemble))
  }
  async events(input: ManagementPrincipal, request: unknown): Promise<RunGraphPage | RunGraphReset> {
    const principal = this.principal(input)
    if (!this.options.qualifiedReads) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
    return this.measured('delta', () => readRunGraphPage(this.primaryPool, request, this.authorize(principal)))
  }
  private async measured<T>(stage: 'snapshot' | 'delta', work: () => Promise<T>): Promise<T> {
    const start = performance.now()
    try {
      const value = await work()
      observeGraph(this.options.measurements, { stage, outcome: 'ok', durationMs: performance.now() - start, bytes: graphJsonBytes(value) })
      return value
    } catch (error) {
      observeGraph(this.options.measurements, { stage, outcome: 'error', durationMs: performance.now() - start })
      // A corrupt row / SQL error must not leak native data via transports or logs.
      throw error instanceof RunGraphError ? error : new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
  }
}
