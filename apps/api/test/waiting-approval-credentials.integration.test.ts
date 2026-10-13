import { readUntil } from './helpers/observableCondition.js'
import { expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { maintainCredential } from '../src/modules/harnesses/credentialHeartbeat.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../src/modules/access/workerCredentials.js'

it.each(['http', 'mcp'] as const)('retains the same requester credential across two lifetimes and resumes through %s', async transport => {
  const f = await currentOperatorIntegration({ credentialTtlMs: 60_000, interactions: true })
  try {
    let runtime = { engine: f.engine, service: f.service }
    await runtime.engine.start(f.f.run.id)
    const [pending] = (await f.pending()).filter(item => item.status === 'pending')
    if (!pending?.executionId) throw new Error('Expected a pending requester')
    const execution = await f.runs.getExecution(pending.executionId)
    const counts = { ...f.provider.counts }
    const read = async () => (await f.db.pool.query<{ principal_id: string; token_hash: string; generation: string;
      expires_at: Date; live: boolean }>(`select b.principal_id,p.token_hash,
        b.approval_connection_generation::text as generation,p.expires_at,
        p.expires_at>clock_timestamp() and p.revoked_at is null and b.revoked_at is null as live
        from worker_credential_bindings b join management_principals p on p.id=b.principal_id
        where b.execution_id=$1`, [pending.executionId])).rows[0]!
    const original = await read()
    const variables = await f.provider.connection().originalEnvironment!({ harness: pending.harness,
      providerVersion: pending.providerVersion, nativeSessionId: pending.nativeSessionId })
    const token = variables?.[APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]
    if (!token) throw new Error('Expected the original process token')
    if (transport === 'mcp') {
      await runtime.engine.shutdown()
      runtime = f.compose()
      Object.assign(f.services, { interactions: new OperatorInteractionService(runtime.service) })
      await runtime.engine.prepareInteraction(pending)
    }
    await readUntil(read, lease => lease.expires_at.getTime() > original.expires_at.getTime() + 125_000,
      { timeoutMs: 140_000, description: 'two requester credential lifetimes' })
    expect(await read()).toMatchObject({ principal_id: original.principal_id, token_hash: original.token_hash,
      generation: original.generation, live: true })
    expect((await read()).expires_at.getTime()).toBeGreaterThan(original.expires_at.getTime())
    expect((await f.access.authenticate(token, 'worker')).id).toBe(original.principal_id)
    expect(await f.runs.getExecution(pending.executionId)).toEqual(execution)
    const reader = await f.access.issue({ name: 'Approval reader', audience: 'operator',
      grants: [{ actions: ['interactions:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const denied = await f.connect(reader.token)
    expect((await denied.callTool({ name: 'interaction_respond', arguments: approvalResponse(pending) })).isError).toBe(true)
    const input = approvalResponse(pending)
    if (transport === 'http') {
      const response = await f.app.inject({ method: 'POST',
        url: `/api/management/interactions/${pending.id}/respond`,
        headers: { authorization: `Bearer ${f.writer.token}` }, payload: input })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json()).toMatchObject({ interaction: { deliveryState: 'delivered' } })
    } else {
      const response = await f.client.callTool({ name: 'interaction_respond', arguments: input })
      expect(response.isError).not.toBe(true)
      expect(decodeMcpToolResult(response)).toMatchObject({ interaction: { deliveryState: 'delivered' } })
    }
    await vi.waitFor(async () => {
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    }, { timeout: 10_000, interval: 10 })
    expect(f.provider.counts).toEqual({ ...counts, responses: counts.responses + 1,
      attaches: counts.attaches + (transport === 'mcp' ? 1 : 0) })
    expect(await f.repository.get(pending.id)).toMatchObject({ deliveryState: 'delivered', nativeSessionId: pending.nativeSessionId })
  } finally { await f.close() }
}, 180_000)

it('issues and renews against database time despite API clock offsets and jumps', async () => {
  const f = await currentOperatorIntegration()
  const wallNow = Date.now.bind(Date)
  let now: { mockRestore(): void } | undefined
  let stop: (() => Promise<void>) | undefined
  try {
    await f.engine.start(f.f.run.id)
    const [pending] = (await f.pending()).filter(item => item.status === 'pending')
    if (!pending?.executionId) throw new Error('Expected a pending requester')
    const service = new Wave25WorkerCredentialService(f.db.pool, f.access, 60_000)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => wallNow() - 120_000)
    now = clock
    const credential = await service.issueForExecution(pending.executionId)
    const lease = async () => (await f.db.pool.query<{ remaining_ms: number; expires_at: Date }>(
      `select (extract(epoch from (expires_at-clock_timestamp()))*1000)::float8 as remaining_ms,expires_at
       from management_principals where id=$1 and revoked_at is null`, [credential.principalId])).rows[0]!
    expect((await lease()).remaining_ms).toBeGreaterThan(30_000)
    expect((await lease()).remaining_ms).toBeLessThanOrEqual(60_000)
    const failures: Error[] = []
    const lifetime = credential as typeof credential & { renewalDeadline?: number }
    const remainingMs = () => lifetime.renewalDeadline === undefined
      ? Date.parse(credential.expiresAt) - Date.now() : lifetime.renewalDeadline - performance.now()
    stop = maintainCredential({ expiresAt: () => credential.expiresAt, ...{ remainingMs },
      signal: new AbortController().signal, onFailure: error => failures.push(error),
      refresh: async () => { credential.expiresAt = await service.renewForExecution(pending.executionId!, credential) },
    })
    for (const offset of [120_000, -180_000, 0]) {
      clock.mockImplementation(() => wallNow() + offset)
      const before = await lease()
      const after = await readUntil(lease, value => value.expires_at.getTime() > before.expires_at.getTime(),
        { timeoutMs: 10_000, description: 'credential renewal after API clock change' })
      expect(after.expires_at.getTime()).toBeGreaterThan(before.expires_at.getTime())
      expect(after.remaining_ms).toBeGreaterThan(30_000)
      expect(failures).toEqual([])
    }
    await stop()
    stop = undefined
    clock.mockRestore()
    expect((await f.access.authenticate(credential.environment.variables[APP_MCP_TOKEN_ENVIRONMENT_VARIABLE], 'worker')).id)
      .toBe(credential.principalId)
    await service.revoke(credential)
    const response = await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(pending))
    expect(response.interaction.deliveryState).toBe('delivered')
  } finally {
    await stop?.()
    now?.mockRestore()
    await f.close()
  }
}, 60_000)

it('stops renewing the waiting requester after its accepted Run authority is revoked', async () => {
  const f = await currentOperatorIntegration({ credentialTtlMs: 60_000 })
  try {
    await f.engine.start(f.f.run.id)
    const [pending] = (await f.pending()).filter(item => item.status === 'pending')
    if (!pending?.executionId) throw new Error('Expected a pending requester')
    let renewalRejected = false
    const renew = Wave25WorkerCredentialService.prototype.renewForExecution
    const renewal = vi.spyOn(Wave25WorkerCredentialService.prototype, 'renewForExecution')
      .mockImplementation(async function (this: Wave25WorkerCredentialService, ...args) {
        try { return await renew.apply(this, args) }
        catch (error) {
          if (args[0] === pending.executionId) renewalRejected = true
          throw error
        }
      })
    await f.access.revoke(f.authorizationPrincipalId)
    try {
      await vi.waitFor(() => expect(renewalRejected).toBe(true), { timeout: 10_000, interval: 10 })
    } finally { renewal.mockRestore() }
    const readExpiry = async () => (await f.db.pool.query<{ expires_at: Date }>(
      'select p.expires_at from management_principals p join worker_credential_bindings b on b.principal_id=p.id where b.execution_id=$1',
      [pending.executionId])).rows[0]!.expires_at.toISOString()
    const stopped = await readExpiry()
    // eslint-disable-next-line no-restricted-syntax -- Proves no further renewal occurs after authority loss.
    await new Promise<void>(resolve => setTimeout(resolve, 2_000))
    expect(await readExpiry()).toBe(stopped)
    expect(f.provider.counts.responses).toBe(0)
    expect(f.provider.counts.starts).toBe(2)
  } finally { await f.close() }
}, 60_000)
