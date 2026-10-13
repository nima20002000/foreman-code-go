import { afterEach, expect, it, vi } from 'vitest'
import { WorkerCredentialService } from '../src/modules/access/workerCredentials.js'
import { routedApprovalFixture } from './helpers/routedApprovalFixture.js'

afterEach(() => vi.restoreAllMocks())

it('renews only the bound reviewer principal and execution while preserving its token', async () => {
  const f = await routedApprovalFixture()
  try {
    const credential = await f.credentials.issueForReviewer(f.reviewer.id)
    const service = new WorkerCredentialService(f.db.pool, f.access)
    await expect(service.renewForExecution(f.requester.id, credential))
      .rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
    await expect(service.renewForExecution(f.reviewer.id, { principalId: 'unbound-principal' }))
      .rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
    const expiresAt = await service.renewForExecution(f.reviewer.id, credential)
    const principal = await f.access.authenticate(credential.environment.variables.GRAPHQL_MCP_TOKEN!, 'worker')
    expect(principal).toMatchObject({ id: credential.principalId, expiresAt })
    expect(credential.renewalDeadline).toBeGreaterThan(performance.now())
  } finally {
    await f.close()
  }
}, 60_000)

const invalidations = [
  ['expired principal',
    "update management_principals set expires_at=clock_timestamp()-interval '1 second' where id=$1", 'principal'],
  ['revoked principal',
    'update management_principals set revoked_at=clock_timestamp() where id=$1', 'principal'],
  ['revoked binding',
    'update worker_credential_bindings set revoked_at=clock_timestamp() where principal_id=$1', 'principal'],
  ['binding to a different orchestrator',
    "update worker_credential_bindings set agent_id='different-orchestrator' where principal_id=$1", 'principal'],
  ['unfinalized native session',
    'update execution_native_sessions set workflow_finalized_at=null where execution_id=$1', 'execution'],
  ['closed run credentials',
    'update runs set worker_credentials_closed_at=clock_timestamp() where id=$1', 'run'],
] as const

it.each(invalidations)('refuses reviewer renewal after %s without extending expiry', async (_reason, statement, target) => {
  const f = await routedApprovalFixture()
  try {
    const credential = await f.credentials.issueForReviewer(f.reviewer.id)
    const token = credential.environment.variables.GRAPHQL_MCP_TOKEN!
    expect(await f.access.authenticate(token, 'worker')).toMatchObject({
      id: credential.principalId,
      agentId: f.reviewer.agentId,
    })
    const deadline = credential.renewalDeadline
    const ids = { principal: credential.principalId, run: f.run.id, execution: f.reviewer.id }
    await f.db.pool.query(statement, [ids[target]])
    expect((await f.runs.get(f.run.id))?.approval).toEqual(f.run.approval)
    const readExpiry = async () => (await f.db.pool.query<{ expires_at: Date }>(
      'select expires_at from management_principals where id=$1', [credential.principalId],
    )).rows[0]!.expires_at.toISOString()
    const before = await readExpiry()
    const service = new WorkerCredentialService(f.db.pool, f.access)
    await expect(service.renewForExecution(f.reviewer.id, credential))
      .rejects.toMatchObject({ code: 'WORKER_CREDENTIAL_NOT_RENEWABLE' })
    expect(await readExpiry()).toBe(before)
    expect(credential.renewalDeadline).toBe(deadline)
  } finally {
    await f.close()
  }
}, 60_000)
