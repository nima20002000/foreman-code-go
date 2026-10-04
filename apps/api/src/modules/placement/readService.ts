import type pg from 'pg'
import { WorkerObservationSchema, type WorkerObservation } from '@foreman-code/contracts/node-placement'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { RunPlacementGetInputSchema, RunPlacementGetResultSchema, type RunPlacementGetResult } from '@foreman-code/contracts/placement-readback'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import { readPlacement } from './binding.js'

/** Accepted-but-unstarted nodes have zero observations. This service never
 * substitutes current Board settings or claims that admission proves execution. */
export class RunPlacementReadService {
  constructor(private readonly pool: pg.Pool, private readonly readObservations:
    (client: pg.PoolClient, runId: string, nodeId: string) => Promise<readonly WorkerObservation[]>) {}
  async get(principal: ManagementPrincipal, raw: unknown): Promise<RunPlacementGetResult> {
    const input = RunPlacementGetInputSchema.parse(raw)
    const authorize = (candidate: ManagementPrincipal) => {
      requireAuthorization(candidate, 'runs:read', input)
      requireAuthorization(candidate, 'workspace_locations:read', input)
    }
    authorize(principal)
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const live = await readLiveManagementPrincipal(client, principal.id)
      authorize(live)
      const run = await client.query('select id from runs where workspace_id=$1 and workflow_id=$2 and id=$3',
        [input.workspaceId, input.workflowId, input.runId])
      if (!run.rowCount) throw new DomainError('RUN_NOT_FOUND', 'Run not found in this workspace and workflow.', 404)
      const rows = await client.query<{ record: unknown }>('select record from run_node_placements where run_id=$1 and node_id=$2', [input.runId, input.nodeId])
      const pin = rows.rows[0]
      if (!pin) throw new DomainError('RUN_NODE_PLACEMENT_NOT_FOUND', 'No accepted placement exists for this node; current settings cannot replace it.', 404)
      const placement = readPlacement(pin.record)
      if (rows.rows.length !== 1 || placement.runId !== input.runId || placement.nodeId !== input.nodeId) {
        throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'Persisted placement is outside the requested Run node.', 409)
      }
      // Worker observations remain B's authenticated journal projection. Do not
      // manufacture them from a dispatch intent or caller-supplied native proof.
      const observations = (await this.readObservations(client, input.runId, input.nodeId)).map((raw) => WorkerObservationSchema.parse(raw))
      for (const observation of observations) {
        const intents = await client.query<{ record: { executionId: string; attemptId: string; bindingHash: string } }>(
          'select record from execution_dispatch_intents where operation_id=$1 and run_id=$2 and node_id=$3',
          [observation.operationId, input.runId, input.nodeId])
        const intent = intents.rows[0]?.record
        if (intents.rows.length !== 1 || intent?.executionId !== observation.executionId
          || intent.attemptId !== observation.attemptId || intent.bindingHash !== observation.bindingHash) {
          throw new DomainError('WORKER_OBSERVATION_CONFLICT', 'Persisted observation has no matching original operation.', 409)
        }
        if (observation.bindingHash !== placement.bindingHash || observation.connection.mainId !== placement.mainId
          || placement.hostRef.kind !== 'device' || observation.connection.deviceId !== placement.hostRef.deviceId
          || observation.connection.workerInstallationId !== placement.registration?.workerInstallationId
          || observation.connection.keyRevision !== placement.registration?.keyRevision
          || observation.connection.authorizationRevision !== placement.registration?.authorizationRevision) {
          throw new DomainError('WORKER_OBSERVATION_CONFLICT', 'Persisted observation does not match the accepted placement.', 409)
        }
      }
      const result = RunPlacementGetResultSchema.parse({ ...input, readback: { evidence: 'accepted', placement, observations } })
      authorize(principal); authorize(live)
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally { client.release() }
  }
}
