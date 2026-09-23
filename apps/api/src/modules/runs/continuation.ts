import { AgentConfigurationVersionSchema, HarnessExecutionSchema } from '@graphql/contracts'
import { CompatibleWorkflowRunSchema } from '@graphql/contracts/wave25'
import type pg from 'pg'
import { DomainError } from '../errors.js'
import { interactionConnection } from '../interactions/connection.js'
import { requiredLocationAccess } from '../workspaces/location.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'

/** Shared by preflight, attachment and approval writes, before native side effects. */
export function continuationValidator(pool: pg.Pool, locations: WorkspaceLocationService) {
  return async (executionId: string, signal?: AbortSignal): Promise<void> => {
    const client = interactionConnection.getStore() ?? pool
    const result = await client.query<{ execution: unknown; run: unknown; configuration: unknown }>(
      `select he.record as execution,r.record as run,c.record as configuration
       from harness_executions he join runs r on r.id=he.run_id
       join agent_configuration_versions c on c.id=he.record->>'agentConfigurationVersionId'
       where he.id=$1`, [executionId],
    )
    const row = result.rows[0]
    if (!row) throw new DomainError('WORKER_EXECUTION_NOT_FOUND', 'The accepted execution is unavailable.', 409)
    const execution = HarnessExecutionSchema.parse(row.execution)
    const run = CompatibleWorkflowRunSchema.parse(row.run)
    const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
    if (run.executionState === 'completed' || run.executionState === 'interrupted' || !run.executionLocation
      || execution.id !== executionId || execution.runId !== run.id
      || execution.workingDirectory !== run.executionLocation.rootPath
      || configuration.agentId !== execution.agentId || configuration.workspaceId !== run.workspaceId
      || configuration.id !== execution.agentConfigurationVersionId
      || run.agentConfigurationVersionIds[execution.agentId] !== configuration.id) {
      throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Native continuation requires the accepted active Run identity.', 409)
    }
    if (run.authorizationPrincipalId) await locations.revalidateRunAuthorization(
      run.authorizationPrincipalId, run.workspaceId, run.workflowId, client,
    )
    await locations.revalidateSnapshot(run.workspaceId, run.executionLocation, requiredLocationAccess([configuration]), signal)
    signal?.throwIfAborted()
  }
}
