import { WorkflowRunSchema } from '@graphql/contracts'
import type pg from 'pg'

import type { ChildProcessEnvironment } from '../harnesses/port.js'
import type { PostgresAccessService } from './postgres.js'
import { lockWorkerExecution, requireActiveWorkerExecution } from './workerLifecycle.js'

export const APP_MCP_TOKEN_ENVIRONMENT_VARIABLE = 'GRAPHQL_APP_MCP_TOKEN'
export const DEFAULT_WORKER_CREDENTIAL_TTL_MS = 15 * 60 * 1000
export const WORKER_CREDENTIAL_EXPIRY_MARGIN_MS = 30_000

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
    readonly ttlMs = DEFAULT_WORKER_CREDENTIAL_TTL_MS,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 2147483647) {
      throw new RangeError('Worker credential TTL must be at least one minute.')
    }
  }

  private async transaction<T>(perform: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const client = await this.pool.connect()
      let releaseError: Error | undefined
      try {
        await client.query('begin')
        const value = await perform(client)
        await client.query('commit')
        return value
      } catch (error) {
        try { await client.query('rollback') } catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : new Error('Credential rollback failed.')
        }
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (releaseError || attempt >= 2 || (code !== '40P01' && code !== '40001')) throw error
      } finally {
        client.release(releaseError)
      }
    }
  }

  async issueForExecution(executionId: string): Promise<IssuedWorkerCredential> {
    return this.transaction(async (client) => {
      const identity = await lockWorkerExecution(client, executionId)
      requireActiveWorkerExecution(identity)
      const run = WorkflowRunSchema.parse(identity.run_record)
      const issued = await this.access.issue({
        name: `execution:${identity.execution_id}`,
        audience: 'worker',
        agentId: identity.agent_id,
        grants: [{
          actions: [
            'interactions:read',
            ...(run.approval?.handler === 'orchestrator'
              && run.approval.designatedOrchestratorAgentId === identity.agent_id
              ? ['interactions:respond' as const] : []),
          ],
          scope: {
            workspaceIds: [identity.workspace_id],
            workflowIds: [identity.workflow_id],
            runIds: [identity.run_id],
          },
        }],
        expiresAt: new Date(Date.now() + this.ttlMs),
      }, client)
      await client.query(
        `insert into worker_credential_bindings
          (principal_id, execution_id, run_id, workspace_id, workflow_id, agent_id, environment_variable)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [issued.principal.id, identity.execution_id, identity.run_id, identity.workspace_id,
          identity.workflow_id, identity.agent_id, APP_MCP_TOKEN_ENVIRONMENT_VARIABLE],
      )
      return {
        principalId: issued.principal.id,
        environment: {
          agentId: identity.agent_id,
          variables: { [APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]: issued.token },
        },
        expiresAt: issued.principal.expiresAt,
      }
    })
  }

  private async lockParents(client: pg.PoolClient, executionId: string): Promise<void> {
    const found = await client.query<{ run_id: string }>(
      `select run_id from harness_executions where id=$1
       union select run_id from worker_credential_bindings where execution_id=$1`, [executionId],
    )
    await client.query('select id from runs where id=any($1::text[]) order by id for update',
      [found.rows.map((row) => row.run_id).sort()])
    await client.query('select id from harness_executions where id=$1 for update', [executionId])
  }

  private async revokeIds(client: pg.PoolClient, principalIds: string[]): Promise<void> {
    if (principalIds.length === 0) return
    await client.query('select id from management_principals where id=any($1::text[]) order by id for update', [principalIds])
    await client.query(
      'update management_principals set revoked_at=coalesce(revoked_at,now()) where id=any($1::text[])', [principalIds],
    )
    // Use exactly the captured IDs on BOTH sides, including repair of old
    // binding-revoked/principal-active inconsistencies from earlier versions.
    await client.query(
      'update worker_credential_bindings set revoked_at=coalesce(revoked_at,now()) where principal_id=any($1::text[])', [principalIds],
    )
  }

  async revoke(credential: Pick<IssuedWorkerCredential, 'principalId'>): Promise<void> {
    await this.transaction(async (client) => {
      const found = await client.query<{ execution_id: string }>(
        'select execution_id from worker_credential_bindings where principal_id=$1', [credential.principalId],
      )
      if (found.rows[0]) await this.lockParents(client, found.rows[0].execution_id)
      await this.revokeIds(client, [credential.principalId])
    })
  }

  /** Terminal/Stop cleanup permanently closes this execution to new issuance. */
  async revokeForExecution(executionId: string): Promise<number> {
    return this.transaction(async (client) => {
      await this.lockParents(client, executionId)
      await client.query(
        'update harness_executions set worker_credentials_closed_at=coalesce(worker_credentials_closed_at,now()) where id=$1',
        [executionId],
      )
      const active = await client.query<{ principal_id: string }>(
        `select b.principal_id from worker_credential_bindings b
         left join management_principals p on p.id=b.principal_id
         where b.execution_id=$1 and (b.revoked_at is null or (p.id is not null and p.revoked_at is null))
         order by b.principal_id`, [executionId],
      )
      const principalIds = active.rows.map((row) => row.principal_id)
      await this.revokeIds(client, principalIds)
      return principalIds.length
    })
  }

  /** The run barrier also blocks credentials for executions created during Stop. */
  async revokeForRun(runId: string, transactionClient?: pg.PoolClient): Promise<number> {
    const perform = async (client: pg.PoolClient): Promise<number> => {
      await client.query('select id from runs where id=$1 for update', [runId])
      await client.query(
        'update runs set worker_credentials_closed_at=coalesce(worker_credentials_closed_at,now()) where id=$1', [runId],
      )
      await client.query('select id from harness_executions where run_id=$1 order by id for update', [runId])
      await client.query(
        'update harness_executions set worker_credentials_closed_at=coalesce(worker_credentials_closed_at,now()) where run_id=$1', [runId],
      )
      const active = await client.query<{ principal_id: string }>(
        `select b.principal_id from worker_credential_bindings b
         left join management_principals p on p.id=b.principal_id
         where b.run_id=$1 and (b.revoked_at is null or (p.id is not null and p.revoked_at is null))
         order by b.principal_id`, [runId],
      )
      const principalIds = active.rows.map((row) => row.principal_id)
      await this.revokeIds(client, principalIds)
      return principalIds.length
    }
    // Management Stop already owns a transaction/lease. Do not request a
    // second pool connection or commit that caller's transaction here.
    return transactionClient ? perform(transactionClient) : this.transaction(perform)
  }

  /** Durable terminal records + bindings are the retry queue; no in-memory token is needed. */
  async reconcileTerminalCredentials(): Promise<void> {
    const pending = await this.pool.query<{ execution_id: string }>(
      `select distinct b.execution_id from worker_credential_bindings b
       left join harness_executions he on he.id=b.execution_id
       left join runs r on r.id=b.run_id
       left join management_principals p on p.id=b.principal_id
       where (b.revoked_at is null or (p.id is not null and p.revoked_at is null))
         and (he.id is null or r.id is null or he.worker_credentials_closed_at is not null
           or r.worker_credentials_closed_at is not null
           or he.record->>'state' not in ('starting','running','waiting')
           or r.execution_state not in ('running','waiting'))
       order by b.execution_id limit 100`,
    )
    let failure: unknown
    for (const row of pending.rows) {
      try { await this.revokeForExecution(row.execution_id) } catch (error) { failure ??= error }
    }
    // Heal unbound worker principals left by the old non-atomic issuer as well.
    await this.pool.query(
      `update management_principals p set revoked_at=now()
       where p.audience='worker' and p.revoked_at is null
         and not exists (select 1 from worker_credential_bindings b where b.principal_id=p.id)`,
    )
    if (failure) throw failure
  }
}
