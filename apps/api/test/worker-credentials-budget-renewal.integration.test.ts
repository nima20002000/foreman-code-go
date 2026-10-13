import { beforeEach, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { workerCredentialBudgetFixture } from './helpers/workerCredentialBudgetFixture.js'

const fixture = workerCredentialBudgetFixture()
let pool: typeof fixture.pool
let execution: typeof fixture.execution
let access: typeof fixture.access
let credentials: typeof fixture.credentials
let budgets: typeof fixture.budgets

beforeEach(() => {
  ({ pool, execution, access, credentials, budgets } = fixture)
})

it('renews a live scoped token while its execution lease is still owned', async () => {
  const issued = await credentials.issueForExecution(execution.id)
  await pool.query("update management_principals set expires_at=now()+interval '30 seconds' where id=$1", [issued.principalId])
  const before = (await pool.query('select token_hash from management_principals where id=$1', [issued.principalId])).rows[0]
  const renewedAt = await credentials.renewForExecution(execution.id, issued)
  expect(Date.parse(renewedAt)).toBeGreaterThan(Date.now())
  const after = (await pool.query('select token_hash,expires_at,revoked_at from management_principals where id=$1', [issued.principalId])).rows[0]
  expect(after.token_hash).toEqual(before.token_hash)
  expect(after.expires_at.toISOString()).toBe(renewedAt)
  expect(after.revoked_at).toBe(null)
})

it('cannot renew an expired credential even while its execution is waiting', async () => {
  const issued = await credentials.issueForExecution(execution.id)
  await pool.query("update management_principals set expires_at=now()-interval '1 second' where id=$1",
    [issued.principalId])
  const token = issued.environment.variables.GRAPHQL_MCP_TOKEN!
  await expect(access.authenticate(token, 'worker')).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
  const before = (await pool.query('select expires_at from management_principals where id=$1',
    [issued.principalId])).rows[0].expires_at
  await expect(credentials.renewForExecution(execution.id, issued))
    .rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
  expect((await pool.query('select expires_at from management_principals where id=$1',
    [issued.principalId])).rows[0].expires_at).toEqual(before)
  await expect(access.authenticate(token, 'worker')).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
})

for (const revokedTable of ['management_principals', 'worker_credential_bindings'] as const) {
  it(`cannot revive a credential revoked in ${revokedTable}`, async () => {
    const issued = await credentials.issueForExecution(execution.id)
    const key = revokedTable === 'management_principals' ? 'id' : 'principal_id'
    await pool.query(`update ${revokedTable} set revoked_at=now() where ${key}=$1`, [issued.principalId])
    await expect(credentials.renewForExecution(execution.id, issued)).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
    expect((await pool.query('select expires_at from management_principals where id=$1', [issued.principalId])).rows[0].expires_at.toISOString()).toBe(issued.expiresAt)
  })
}

it('cannot renew a principal for a different execution or mismatched Agent binding', async () => {
  const issued = await credentials.issueForExecution(execution.id)
  await expect(credentials.renewForExecution('another-execution', issued)).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
  await pool.query('update worker_credential_bindings set agent_id=$2 where principal_id=$1', [issued.principalId, 'agent-reviewer'])
  await expect(credentials.renewForExecution(execution.id, issued)).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
})

it('cannot issue or renew credentials after Stop', async () => {
  const issued = await credentials.issueForExecution(execution.id)
  await budgets.stop(execution.id)
  await expect(credentials.renewForExecution(execution.id, issued)).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
  await expect(credentials.issueForExecution(execution.id)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_INACTIVE' })
})

it('cannot renew an exhausted active-time budget even while approval is waiting', async () => {
  const issued = await credentials.issueForExecution(execution.id)
  await pool.query('update approval_execution_state set active_elapsed_ms=active_timeout_ms where execution_id=$1', [execution.id])
  await expect(credentials.renewForExecution(execution.id, issued)).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
})

it('cannot issue or renew credentials for a completed execution before cleanup catches up', async () => {
  const issued = await credentials.issueForExecution(execution.id)
  const completed = HarnessExecutionSchema.parse({ ...execution, state: 'completed', result: { outcome: 'succeeded' }, finishedAt: new Date().toISOString() })
  await pool.query('update harness_executions set record=$2::jsonb where id=$1', [execution.id, JSON.stringify(completed)])
  await expect(credentials.renewForExecution(execution.id, issued)).rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
  await expect(credentials.issueForExecution(execution.id)).rejects.toMatchObject({ code: 'WORKER_EXECUTION_INACTIVE' })
})
