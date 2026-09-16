import { HarnessExecutionSchema, WorkflowRunSchema } from '@graphql/contracts'
import type pg from 'pg'

import { DomainError } from '../errors.js'
import type { ChildProcessEnvironment } from '../harnesses/port.js'
import type { PostgresAccessService } from './postgres.js'

export const APP_MCP_TOKEN_ENVIRONMENT_VARIABLE = 'GRAPHQL_APP_MCP_TOKEN'
export const DEFAULT_WORKER_CREDENTIAL_TTL_MS = 15 * 60 * 1000
export const WORKER_CREDENTIAL_RENEWAL_WINDOW_MS = 60_000

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

  issueForExecution(executionId: string): Promise<IssuedWorkerCredential> {
    return this.issue(executionId, 'workflow')
  }

  issueForReviewer(executionId: string): Promise<IssuedWorkerCredential> {
    return this.issue(executionId, 'reviewer')
  }

  private async issue(executionId: string, purpose: 'workflow' | 'reviewer'): Promise<IssuedWorkerCredential> {
    const result = await this.pool.query<ExecutionIdentityRow>(
      `select he.id as execution_id, he.run_id, he.agent_id,
              r.workspace_id, r.workflow_id, he.record as execution_record, r.record as run_record
       from harness_executions he
       join runs r on r.id = he.run_id
       join agents a on a.id = he.agent_id and a.workspace_id = r.workspace_id
       where he.id = $1 and not exists (
         select 1 from approval_execution_state where execution_id=he.id and stopped_at is not null
       )`, [executionId],
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
    if (run.executionState === 'completed' || purpose === 'workflow' && execution.state === 'completed') {
      throw new DomainError('WORKER_EXECUTION_TERMINAL', 'A terminal execution cannot receive worker credentials.', 409)
    }
    if (purpose === 'reviewer') {
      const ready = await this.pool.query(
        `select s.execution_id from execution_native_sessions s
         join harness_executions he on he.id=s.execution_id
         join agent_configuration_versions c on c.id=he.record->>'agentConfigurationVersionId'
         where s.execution_id=$1 and s.workflow_finalized_at is not null
           and s.reference->>'nativeSessionId'=he.record->>'nativeSessionId'
           and c.record->>'productRole'='orchestrator'`, [executionId],
      )
      if (execution.state !== 'completed' || run.approval?.handler !== 'orchestrator'
        || run.approval.designatedOrchestratorAgentId !== execution.agentId || !ready.rowCount) {
        throw new DomainError('REVIEWER_EXECUTION_NOT_READY', 'Only the finalized designated Orchestrator session can receive Run-lifetime review credentials.', 409)
      }
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
          (principal_id, execution_id, run_id, workspace_id, workflow_id, agent_id, environment_variable, purpose)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [issued.principal.id, identity.execution_id, identity.run_id, identity.workspace_id,
          identity.workflow_id, identity.agent_id, APP_MCP_TOKEN_ENVIRONMENT_VARIABLE, purpose],
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

  /**
   * Control-plane lease renewal, not bearer-token self-renewal. Only expiry changes:
   * the exact principal, token, Agent and grants stay bound to the same live execution.
   * An expired lease may be renewed after approval waiting; revocation is irreversible.
   */
  async renewForExecution(executionId: string, credential: Pick<IssuedWorkerCredential, 'principalId'>): Promise<string> {
    const result = await this.pool.query<{ expires_at: Date }>(
      `update management_principals p
       set expires_at=greatest(p.expires_at,now()+($3::bigint * interval '1 millisecond'))
       from worker_credential_bindings b
       join harness_executions he on he.id=b.execution_id and he.agent_id=b.agent_id and he.run_id=b.run_id
       join runs r on r.id=b.run_id and r.workspace_id=b.workspace_id and r.workflow_id=b.workflow_id
       join agents a on a.id=b.agent_id and a.workspace_id=b.workspace_id
       join approval_execution_state s on s.execution_id=he.id
       where p.id=$1 and b.principal_id=p.id and b.execution_id=$2
         and p.audience='worker' and p.agent_id=b.agent_id
         and b.environment_variable=$4 and p.revoked_at is null and b.revoked_at is null
         and he.record->>'id'=he.id and he.record->>'runId'=r.id and he.record->>'agentId'=b.agent_id
         and r.record->>'id'=r.id and r.record->>'workspaceId'=b.workspace_id and r.record->>'workflowId'=b.workflow_id
         and ((b.purpose='workflow' and he.record->>'state' in ('running','waiting')
           and s.active_elapsed_ms + coalesce(extract(epoch from (now()-s.active_started_at))*1000,0) < s.active_timeout_ms)
           or (b.purpose='reviewer' and he.record->>'state'='completed'
             and r.record->'approval'->>'handler'='orchestrator'
             and r.record->'approval'->>'designatedOrchestratorAgentId'=b.agent_id
             and exists (select 1 from execution_native_sessions ns where ns.execution_id=he.id
               and ns.workflow_finalized_at is not null and ns.reference->>'nativeSessionId'=he.record->>'nativeSessionId')))
         and r.record->>'executionState' in ('running','waiting') and r.record->>'outcome'='pending'
         and s.stopped_at is null
       returning p.expires_at`,
      [credential.principalId, executionId, this.ttlMs, APP_MCP_TOKEN_ENVIRONMENT_VARIABLE],
    )
    if (!result.rows[0]) {
      throw new DomainError('WORKER_CREDENTIAL_NOT_RENEWABLE', 'The worker credential is revoked, mismatched, or its execution is no longer active.', 409)
    }
    return result.rows[0].expires_at.toISOString()
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

  /** Terminal/Stop cleanup. Repeated calls are safe and return newly revoked credentials only. */
  async revokeForExecution(executionId: string): Promise<number> {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const active = await client.query<{ principal_id: string }>(
        `select principal_id from worker_credential_bindings
         where execution_id=$1 and revoked_at is null
         order by principal_id for update`,
        [executionId],
      )
      const principalIds = active.rows.map((row) => row.principal_id)
      if (principalIds.length > 0) {
        await client.query(
          'update management_principals set revoked_at=coalesce(revoked_at,now()) where id=any($1::text[])',
          [principalIds],
        )
        await client.query(
          'update worker_credential_bindings set revoked_at=coalesce(revoked_at,now()) where execution_id=$1 and revoked_at is null',
          [executionId],
        )
      }
      await client.query('commit')
      return principalIds.length
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
}
