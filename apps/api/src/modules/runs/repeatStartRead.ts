import { timeRuntimeOperation } from '../../infrastructure/runtimeTiming.js'
import type { AgentConfigurationVersion } from '@foreman-code/contracts'
import {
  AcceptedWorkflowRunV3Schema, ExecutableWorkflowV3Schema, SavedRunVersionSnapshotSchema,
  type AcceptedWorkflowRunV3, type RepeatWorkflowVersionV1,
} from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import {
  IMMUTABLE_WORKFLOW_VERSION_COLUMNS, readImmutableWorkflowVersion, readImmutableAgentConfiguration,
  type ImmutableWorkflowVersionRow, type ImmutableAgentConfigurationRow,
} from '../workflows/immutableRead.js'

export interface AcceptedRepeatRunSnapshot {
  run: AcceptedWorkflowRunV3
  version: RepeatWorkflowVersionV1
  configurations: AgentConfigurationVersion[]
  stopRequested: boolean
  cleanupPending: boolean
}
interface RunRow {
  id: string; workspace_id: string; workflow_id: string; workflow_version_id: string
  execution_state: string; runner_id: string | null; working_directory: string | null
  location_revision: string | null; record: unknown; stopped: boolean; cleanup_pending: boolean
}

/** Same-transaction immutable reader for admission replay / existing owner
 * dispatch. It grants no execution or native authority. It deliberately does
 * not read current workflow/draft/Agent heads or call filesystem/provider code.
 * Do not replace the central repository's old 1/2 parser with a permissive union;
 * its explicit third arm must call this after acquiring the appropriate locks. */
export function readAcceptedRepeatRunLocked(sql: GraphTransactionSql, runId: string): Promise<AcceptedRepeatRunSnapshot> {
  return timeRuntimeOperation('db', 'snapshot.read_run', async () => {
    assertGraphTransaction(sql)
    const found = await sql.query<RunRow>(`select r.id,r.workspace_id,r.workflow_id,r.workflow_version_id,r.execution_state,
      r.runner_id,r.working_directory,r.location_revision::text,r.record,r.stop_requested_at is not null as stopped,
      exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup_pending
      from runs r where r.id=$1 for share of r`, [runId])
    const row = found.rows[0]
    if (found.rows.length !== 1 || !row) throw new DomainError('RUN_NOT_FOUND', 'The exact Run was not found.', 404)
    const run = AcceptedWorkflowRunV3Schema.parse(row.record)
    if (run.id !== runId || row.id !== run.id || row.workspace_id !== run.workspaceId
      || row.workflow_id !== run.workflowId || row.workflow_version_id !== run.workflowVersionId
      || row.execution_state !== run.executionState || row.runner_id !== run.executionLocation.runnerId
      || row.working_directory !== run.executionLocation.rootPath
      || row.location_revision !== String(run.executionLocation.locationRevision)
      || typeof row.stopped !== 'boolean' || typeof row.cleanup_pending !== 'boolean') {
      throw new DomainError('RUN_PIN_CONFLICT', 'The accepted v3 Run differs from its physical scope/location/state.', 409)
    }
    const versions = await sql.query<ImmutableWorkflowVersionRow>(
      `select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS} from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3 for share`,
      [run.workflowVersionId, run.workspaceId, run.workflowId])
    if (versions.rows.length !== 1 || !versions.rows[0]) throw new DomainError('RUN_PIN_CONFLICT', 'The immutable Run version is missing.', 409)
    const version = readImmutableWorkflowVersion(versions.rows[0], { id: run.workflowVersionId, workspaceId: run.workspaceId, workflowId: run.workflowId })
    if (!('executionSemanticsVersion' in version) || version.executionSemanticsVersion !== 3) {
      throw new DomainError('EXECUTION_SEMANTICS_UNSUPPORTED', 'A v3 Run cannot execute a legacy/one-shot version.', 409)
    }
    SavedRunVersionSnapshotSchema.parse({ run, version })
    const rows = await sql.query<ImmutableAgentConfigurationRow>(
      'select id,workspace_id,agent_id,version,record from agent_configuration_versions where workspace_id=$1 and id=any($2::text[]) order by id for share',
      [run.workspaceId, Object.values(run.agentConfigurationVersionIds)])
    const configurations = rows.rows.map((configuration) => readImmutableAgentConfiguration(configuration, {
      id: run.agentConfigurationVersionIds[configuration.agent_id]!, workspaceId: run.workspaceId, agentId: configuration.agent_id,
    }))
    ExecutableWorkflowV3Schema.parse({ version, configurations })
    return { run, version, configurations, stopRequested: row.stopped, cleanupPending: row.cleanup_pending }
  }, { runId })
}
