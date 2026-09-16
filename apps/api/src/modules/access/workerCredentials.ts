import { HarnessExecutionSchema, WorkflowRunSchema } from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'
import type { ChildProcessEnvironment } from '../harnesses/port.js'
import type { PostgresAccessService } from './postgres.js'

export const APP_MCP_TOKEN_ENVIRONMENT_VARIABLE = 'GRAPHQL_APP_MCP_TOKEN'
export const DEFAULT_WORKER_CREDENTIAL_TTL_MS = 15 * 60 * 1000

interface ExecutionIdentityRow {
  execution_id: string
  run_id: string
  agent_id: string
  workspace_id: string
  workflow_id: string
  execution_record: unknown
  run_record: unknown
}

export interface IssuedWorkerCredential {
  principalId: string
  environment: ChildProcessEnvironment
  expiresAt: string
}

/** Issues only from durable execution/run identity; callers cannot supply alternate scope. */
export class WorkerCredentialService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly access: PostgresAccessService,
    private readonly ttlMs = DEFAULT_WORKER_CREDENTIAL_TTL_MS,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000) {
      throw new RangeError('Worker credential TTL must be at least one minute.')
    }
  }

  async issueForExecution(executionId: string): Promise<IssuedWorkerCredential> {
    const result = await this.pool.query<ExecutionIdentityRow>(
      `select he.id as execution_id, he.run_id, he.agent_id,
              r.workspace_id, r.workflow_id, he.record as execution_record, r.record as run_record
       from harness_executions he
       join runs r on r.id = he.run_id
       join agents a on a.id = he.agent_id and a.workspace_id = r.workspace_id
       where he.id = $1`, [executionId],
    )
    const identity = result.rows[0]
    if (!identity) {
      throw new DomainError('WORKER_EXECUTION_NOT_FOUND', 'The accepted execution identity was not found.', 409)
    }
    const execution = HarnessExecutionSchema.parse(identity.execution_record)
    const run = WorkflowRunSchema.parse(identity.run_record)
    if (execution.id !== identity.execution_id || execution.runId !== identity.run_id
      || execution.agentId !== identity.agent_id || run.id !== identity.run_id
      || run.workspaceId !== identity.workspace_id || run.workflowId !== identity.workflow_id) {
      throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'The durable execution identity is inconsistent.', 409)
    }
    const expiresAt = new Date(Date.now() + this.ttlMs)
    const issued = await this.access.issue({
      name: `execution:${identity.execution_id}`,
      audience: 'worker',
      agentId: identity.agent_id,
      // Actions are a schema-required carrier only. App policy reads the exact scopes and
      // Operator policy categorically rejects the worker audience.
      grants: [{
        actions: [
          'interactions:read',
          ...(run.approval?.handler === 'orchestrator'
            && run.approval.designatedOrchestratorAgentId === identity.agent_id
            ? ['interactions:respond' as const]
            : []),
        ],
        scope: {
          workspaceIds: [identity.workspace_id],
          workflowIds: [identity.workflow_id],
          runIds: [identity.run_id],
        },
      }],
      expiresAt,
    })
    try {
      await this.pool.query(
        `insert into worker_credential_bindings
          (principal_id, execution_id, run_id, workspace_id, workflow_id, agent_id, environment_variable)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [issued.principal.id, identity.execution_id, identity.run_id, identity.workspace_id,
          identity.workflow_id, identity.agent_id, APP_MCP_TOKEN_ENVIRONMENT_VARIABLE],
      )
    } catch (error) {
      await this.access.revoke(issued.principal.id).catch(() => undefined)
      throw error
    }
    return {
      principalId: issued.principal.id,
      environment: {
        agentId: identity.agent_id,
        variables: { [APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]: issued.token },
      },
      expiresAt: issued.principal.expiresAt,
    }
  }

  async revoke(credential: Pick<IssuedWorkerCredential, 'principalId'>): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('update management_principals set revoked_at = coalesce(revoked_at, now()) where id = $1', [credential.principalId])
      await client.query('update worker_credential_bindings set revoked_at = coalesce(revoked_at, now()) where principal_id = $1', [credential.principalId])
      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
}
