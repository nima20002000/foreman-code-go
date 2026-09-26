import { afterEach, describe, expect, it, vi } from 'vitest'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { assertWave25WorkerBinding } from '../src/modules/interactions/wave25/credentialAuthority.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { executionRows, readback, recoveryFixture } from './helpers/eng06DRecovery.js'

afterEach(() => vi.restoreAllMocks())

// Real V3 retry admission, original-result capture, credential issuance,
// revocation, renewal and authentication. No authority predicate is mocked.
describe.skipIf(!postgresEnabled)('ENG06 fresh authority for a same-slot technical retry', () => {
  it.each(['sequential', 'repeat'] as const)('%s: attempt two gets a fresh credential without reviving attempt one', async (form) => {
    // Call-through spy observes the actual issued launch credentials. Tokens stay
    // in memory only; do not include them in provider diagnostics or SQL fixtures.
    const issuance = vi.spyOn(PostgresAccessService.prototype, 'issue')
    const f = await recoveryFixture(form, ({ attempt }) => attempt === 1 ? 'retryable_failure' : 'park')
    try {
      f.launch()
      await expect.poll(async () => (await executionRows(f)).some((row) => row.execution.attempt === 2
        && row.execution.state === 'running' && f.provider.atBarrier(row.execution.id)), { timeout: 20000 }).toBe(true)
      const rows = (await executionRows(f)).sort((a, b) => a.execution.attempt - b.execution.attempt)
      expect(rows.map((row) => row.execution.attempt), JSON.stringify(f.diagnostics())).toEqual([1, 2])
      const first = rows[0]!, retry = rows[1]!
      expect(first.execution.state).toBe('completed')
      expect(first.execution.result).toMatchObject({ outcome: 'failed', error: { code: 'ENG06_NATIVE_FAILURE', retryable: true } })
      expect(f.provider.originalResult(first.execution.id)).toEqual(first.execution.result)
      expect(retry.execution.id).not.toBe(first.execution.id)
      expect(retry.execution.nativeSessionId).not.toBe(first.execution.nativeSessionId)
      expect(retry.slot_id).toBe(first.slot_id)
      expect(retry.input_json).toBe(first.input_json); expect(retry.input_digest).toBe(first.input_digest)
      expect(retry.execution.agentConfigurationVersionId).toBe(first.execution.agentConfigurationVersionId)

      const bindings = (await f.base.db.pool.query<{
        principal_id: string; execution_id: string; principal_revoked: boolean; binding_revoked: boolean;
        execution_closed: boolean; native_session_id: string | null; generation: string | null; unexpired: boolean;
      }>(`select b.principal_id,b.execution_id,p.revoked_at is not null as principal_revoked,
          b.revoked_at is not null as binding_revoked,e.worker_credentials_closed_at is not null as execution_closed,
          b.approval_native_session_id as native_session_id,b.approval_connection_generation::text as generation,
          p.expires_at>clock_timestamp() as unexpired
        from worker_credential_bindings b join management_principals p on p.id=b.principal_id
        join harness_executions e on e.id=b.execution_id
        where b.run_id=$1 and b.purpose='workflow' order by e.attempt,b.principal_id`, [f.base.f.run.id])).rows
      const old = bindings.filter((binding) => binding.execution_id === first.execution.id)
      expect(old.length).toBeGreaterThan(0)
      for (const binding of old) expect(binding).toMatchObject({ principal_revoked: true, binding_revoked: true })
      const live = bindings.filter((binding) => binding.execution_id === retry.execution.id && !binding.principal_revoked && !binding.binding_revoked)
      expect(live).toHaveLength(1)
      const current = live[0]!
      expect(current).toMatchObject({ execution_closed: false, unexpired: true, native_session_id: retry.execution.nativeSessionId })
      expect(current.generation).not.toBeNull()
      expect(old.some((binding) => binding.principal_id === current.principal_id)).toBe(false)

      const issued = await Promise.all(issuance.mock.results.flatMap((result) => result.type === 'return' ? [result.value] : []))
      const currentIssued = issued.find((item) => item.principal.id === current.principal_id)
      expect(currentIssued !== undefined).toBe(true)
      const access = new PostgresAccessService(f.base.db.pool)
      const credentials = new Wave25WorkerCredentialService(f.base.db.pool, access)
      // The same shared predicate is used by the App endpoint, renewal and the
      // terminal-credential sweep; none may reject a live retry merely for being attempt two.
      await credentials.reconcileTerminalCredentials()
      await expect(assertWave25WorkerBinding(f.base.db.pool, current.principal_id)).resolves.toBeUndefined()
      const principal = await access.authenticate(currentIssued!.token, 'worker')
      expect(principal).toMatchObject({ id: current.principal_id, agentId: retry.execution.agentId,
        audience: 'worker', revokedAt: null, grants: [{ actions: ['interactions:read'], scope: {
          workspaceIds: [f.base.f.scope.workspaceId], workflowIds: [f.base.f.scope.workflowId], runIds: [f.base.f.run.id],
        } }] })
      expect(Date.parse(await credentials.renewForExecution(retry.execution.id, { principalId: current.principal_id }))).toBeGreaterThan(Date.now())
      for (const binding of old) {
        const oldIssued = issued.find((item) => item.principal.id === binding.principal_id)
        expect(oldIssued !== undefined).toBe(true)
        await expect(access.authenticate(oldIssued!.token, 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
        await expect(credentials.renewForExecution(retry.execution.id, { principalId: binding.principal_id })).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      }
      await expect(credentials.issueForExecution(first.execution.id)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })

      // Existing HTTP/Operator MCP read services report both distinct attempts
      // without progress, a new Run, or an invented repeat occurrence.
      const view = await readback(f)
      expect(view.record.run).toMatchObject({ executionState: 'running', outcome: 'pending' })
      expect(view.page.items).toHaveLength(2)
      expect(view.page.items.map((item) => item.attempt).sort()).toEqual([1, 2])
      const occurrences = await f.base.db.pool.query('select occurrence_id from run_repeat_occurrences where run_id=$1', [f.base.f.run.id])
      expect(occurrences.rows).toHaveLength(form === 'repeat' ? 1 : 0)

      // Accepting attempt two must not weaken explicit revocation of its token.
      await credentials.revoke({ principalId: current.principal_id })
      await expect(access.authenticate(currentIssued!.token, 'worker')).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      await expect(credentials.renewForExecution(retry.execution.id, { principalId: current.principal_id })).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      expect(f.provider.counts).toMatchObject({ starts: 2, sessions: 2, attaches: 0 })
    } finally { await f.close() }
  }, 90000)
})
