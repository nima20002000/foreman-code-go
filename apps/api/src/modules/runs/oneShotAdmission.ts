import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { AgentConfigurationVersionSchema, type RunExecutionLocation } from '@graphql/contracts'
import { type ManagementPrincipal } from '@graphql/contracts/management'
import {
  ExecutableWorkflowV2Schema, GraphDraftV2Schema, RunStartV2InputSchema,
  WorkflowRunV2Schema, WorkflowVersionV2Schema, canonicalGraphJson,
} from '@graphql/contracts/wave25'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { acceptRunAuthority, bindRunAuthority } from '../access/runAuthority.js'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import { withExclusiveGraphConnection, type GraphTransactionSql } from '../run-graph/connection.js'
import { requiredLocationAccess, type WorkspaceLocationService } from '../workspaces/location.js'
import { assertTriggerDispatch } from '../workflows/triggerAuthority.js'
import { assertWorkflowRecovered } from './recoveryPolicy.js'
import { initializeOneShotPublication } from './oneShotLifecycle.js'

type Request = ReturnType<typeof RunStartV2InputSchema.parse>
type Run = ReturnType<typeof WorkflowRunV2Schema.parse>
interface LocationRow { execution_location: unknown; execution_location_identity: unknown; location_revision: string; archived_at: Date | null }
interface Receipt { input_hash: string; target_key: string; result: unknown }
const locationColumns = 'execution_location,execution_location_identity,location_revision::text,archived_at'

/** The only v2 Run INSERT. The caller owns a real G1 transaction, not a raw
 * BEGIN/COMMIT pair. No environment flag or public qualification bypass exists.
 * Runtime admission calls this after all authorization/pin/location checks;
 * isolated tests may call it with synthetic already-validated records. */
export async function insertOneShotRun(sql: GraphTransactionSql, input: unknown): Promise<Run> {
  const run = WorkflowRunV2Schema.parse(input)
  if (run.executionState !== 'queued' || run.outcome !== 'pending') {
    throw new DomainError('RUN_ADMISSION_INVALID', 'A new Run must start queued with a pending outcome.', 409)
  }
  await sql.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record,
    runner_id,working_directory,location_revision) values($1,$2,$3,$4,'queued',$5::jsonb,$6,$7,$8)`,
  [run.id, run.workspaceId, run.workflowId, run.workflowVersionId, JSON.stringify(run),
    run.executionLocation?.runnerId ?? null, run.executionLocation?.rootPath ?? null,
    run.executionLocation?.locationRevision ?? null])
  await initializeOneShotPublication(sql, run)
  return run
}

/** Execution-side application service behind assertWave25Admission in the public
 * RunManagementService. It reuses existing command locks/receipts/audit and Run
 * authority records. No new queue, token, owner, retry or occurrence subsystem.
 * Filesystem location validation happens BEFORE the publication transaction;
 * its exact database revision/identity are rechecked under lock inside it.
 */
export async function admitOneShotRun(
  pool: pg.Pool, locations: WorkspaceLocationService, principal: ManagementPrincipal,
  source: 'http' | 'mcp', raw: Request, options: { maximumResidentRuns?: number; triggerJobId?: string } = {},
): Promise<{ value: Run; replayed: boolean }> {
  const input = RunStartV2InputSchema.parse(raw)
  const maximumResidentRuns = options.maximumResidentRuns ?? 32
  if (!Number.isInteger(maximumResidentRuns) || maximumResidentRuns < 1 || maximumResidentRuns > 128) {
    throw new Error('maximumResidentRuns must be an integer between 1 and 128')
  }
  const authorize = (caller: ManagementPrincipal) => {
    requireAuthorization(caller, 'runs:start', { workspaceId: input.workspaceId, workflowId: input.workflowId })
    requireAuthorization(caller, 'workspace_locations:read', { workspaceId: input.workspaceId })
  }
  authorize(principal)
  const hash = commandInputHash({ ...input, ...(options.triggerJobId ? { triggerJobId: options.triggerJobId } : {}) })
  const target = `workflow:${input.workflowId}:version:${input.workflowVersionId}`
  const readReceipt = async (sql: Pick<GraphTransactionSql, 'query'>): Promise<Run | undefined> => {
    const found = await sql.query<Receipt>(`select input_hash,target_key,result from management_command_receipts
      where principal_id=$1 and operation='run.start' and command_id=$2`, [principal.id, input.commandId])
    const receipt = found.rows[0]
    if (!receipt) return undefined
    if (receipt.input_hash !== hash || receipt.target_key !== target) {
      throw new DomainError('COMMAND_ID_CONFLICT', 'This command ID was already used with different input.', 409)
    }
    return WorkflowRunV2Schema.parse(receipt.result)
  }
  // A replay does not depend on the directory still existing. Revalidate access
  // even when returning an old receipt, and never dispatch again on replay.
  const replay = await withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
    authorize(await readLiveManagementPrincipal(sql as unknown as Pick<pg.ClientBase, 'query'>, principal.id))
    return readReceipt(sql)
  }))
  if (replay) return { value: replay, replayed: true }

  const prepared = await pool.connect()
  let location: RunExecutionLocation
  let locationRow: LocationRow
  try {
    const versionRow = await prepared.query<{ record: unknown }>(
      'select record from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3',
      [input.workflowVersionId, input.workspaceId, input.workflowId])
    const version = WorkflowVersionV2Schema.parse(versionRow.rows[0]?.record)
    const configs = await prepared.query<{ record: unknown }>(
      'select record from agent_configuration_versions where workspace_id=$1 and id=any($2::text[]) order by id',
      [input.workspaceId, Object.values(version.agentConfigurationVersionIds)])
    const configurations = configs.rows.map((row) => AgentConfigurationVersionSchema.parse(row.record))
    ExecutableWorkflowV2Schema.parse({ version, configurations })
    for (const configuration of configurations) assertNativeWorkflowConfiguration(configuration.harness, version.approval,
      version.approval.handler === 'orchestrator' && configuration.agentId === version.approval.designatedOrchestratorAgentId)
    const before = await prepared.query<LocationRow>(`select ${locationColumns} from workspaces where id=$1`, [input.workspaceId])
    locationRow = before.rows[0]!
    // Idle client: the snapshot's SELECT autocommits before any filesystem wait.
    location = await locations.snapshot(prepared, input.workspaceId, input.expectedLocationRevision, requiredLocationAccess(configurations))
    const after = await prepared.query<LocationRow>(`select ${locationColumns} from workspaces where id=$1`, [input.workspaceId])
    if (!locationRow || JSON.stringify(locationRow) !== JSON.stringify(after.rows[0])) {
      throw new DomainError('LOCATION_REVISION_CONFLICT', 'The location changed during validation.', 409)
    }
  } finally { prepared.release() }

  try {
    return await withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
      // Same command key/operation as the legacy service. The command receipt,
      // authority, queued Run and first semantic batch all commit together.
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`command:${principal.id}:run.start:${input.commandId}`])
      authorize(await readLiveManagementPrincipal(sql as unknown as Pick<pg.ClientBase, 'query'>, principal.id))
      const replayed = await readReceipt(sql)
      if (replayed) return { value: replayed, replayed: true }
      // A small runner-level admission bound, not a distributed scheduler. A
      // review/approval continuation never enters this new-Run admission path.
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`admission:runner:${location.runnerId}`])
      await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`admission:workspace:${input.workspaceId}`])
      const client = sql as unknown as pg.PoolClient // existing helpers below are SQL-only
      await assertWorkflowRecovered(client, input.workspaceId, input.workflowId)
      if (options.triggerJobId) await assertTriggerDispatch(client, principal, { ...input, triggerJobId: options.triggerJobId })
      const workspace = await sql.query<LocationRow>(`select ${locationColumns} from workspaces where id=$1 for update`, [input.workspaceId])
      if (!workspace.rows[0] || workspace.rows[0].archived_at || JSON.stringify(workspace.rows[0]) !== JSON.stringify(locationRow)) {
        throw new DomainError('LOCATION_REVISION_CONFLICT', 'The accepted workspace location changed before admission.', 409)
      }
      const parent = await sql.query<{ current_version_id: string | null; archived_at: Date | null }>(
        'select current_version_id,archived_at from workflows where id=$1 and workspace_id=$2 for update', [input.workflowId, input.workspaceId])
      if (!parent.rows[0] || parent.rows[0].archived_at || parent.rows[0].current_version_id !== input.workflowVersionId) {
        throw new DomainError('WORKFLOW_VERSION_UNSUPPORTED', 'Only the current active saved version can be started.', 409)
      }
      if (input.draftId !== undefined) {
        const rows = await sql.query<{ record: unknown }>(`select record from graph_drafts
          where id=$1 and workspace_id=$2 and workflow_id=$3 and discarded_at is null for share`,
        [input.draftId, input.workspaceId, input.workflowId])
        const draft = GraphDraftV2Schema.parse(rows.rows[0]?.record)
        if (draft.revision !== input.expectedDraftRevision || draft.publishedRevision !== draft.revision
          || draft.baseWorkflowVersionId !== input.workflowVersionId) {
          throw new DomainError('DISPLAYED_GRAPH_NOT_PUBLISHED', 'Reload and save the displayed graph before starting.', 409)
        }
      }
      const versions = await sql.query<{ record: unknown }>(
        'select record from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3',
        [input.workflowVersionId, input.workspaceId, input.workflowId])
      const version = WorkflowVersionV2Schema.parse(versions.rows[0]?.record)
      const configs = await sql.query<{ id: string; current_configuration_version_id: string; record: unknown }>(
        `select a.id,a.current_configuration_version_id,v.record from agents a
         join agent_configuration_versions v on v.id=a.current_configuration_version_id
         where a.workspace_id=$1 and a.archived_at is null and a.id=any($2::text[]) order by a.id for share of a`,
        [input.workspaceId, Object.keys(version.agentConfigurationVersionIds)])
      if (configs.rows.length !== Object.keys(version.agentConfigurationVersionIds).length
        || configs.rows.some((row) => row.current_configuration_version_id !== version.agentConfigurationVersionIds[row.id])) {
        throw new DomainError('WORKFLOW_CONFIGURATION_STALE', 'Save the graph again after Agent settings change.', 409)
      }
      const configurations = configs.rows.map((row) => AgentConfigurationVersionSchema.parse(row.record))
      ExecutableWorkflowV2Schema.parse({ version, configurations })
      for (const configuration of configurations) assertNativeWorkflowConfiguration(configuration.harness, version.approval,
        version.approval.handler === 'orchestrator' && configuration.agentId === version.approval.designatedOrchestratorAgentId)
      const live = await sql.query<{ count: string }>(`select count(*)::text as count from runs r where r.runner_id=$1
        and (r.execution_state in ('queued','running','waiting') or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending))`, [location.runnerId])
      if (Number(live.rows[0]!.count) >= maximumResidentRuns) throw new DomainError('RUNNER_ADMISSION_FULL', 'The runner has reached its bounded active-Run capacity.', 409)
      const authority = await acceptRunAuthority(client, principal)
      authorize(authority.principal)
      const run = WorkflowRunV2Schema.parse({ id: `run-${randomUUID()}`, workspaceId: input.workspaceId, workflowId: input.workflowId,
        workflowVersionId: version.id, executionSemanticsVersion: 2, agentConfigurationVersionIds: version.agentConfigurationVersionIds,
        executionLocation: location, authorizationPrincipalId: authority.principal.id, approval: version.approval,
        executionCondition: version.definition.executionCondition, executionState: 'queued', outcome: 'pending', input: input.input,
        createdAt: new Date().toISOString() })
      await insertOneShotRun(sql, run)
      await bindRunAuthority(client, run.id, authority)
      await sql.query(`insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result)
        values($1,'run.start',$2,$3,$4,$5::jsonb)`, [principal.id, input.commandId, target, hash, canonicalGraphJson(run)])
      await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
        values($1,$2,'run.start',$3,'succeeded',$4::jsonb)`, [principal.id, source, target, JSON.stringify({ commandId: input.commandId })])
      return { value: run, replayed: false }
    }))
  } catch (error) {
    await pool.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,$2,'run.start',$3,'failed',$4::jsonb)`, [principal.id, source, target,
    JSON.stringify({ commandId: input.commandId, code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR' })]).catch(() => undefined)
    throw error
  }
}
