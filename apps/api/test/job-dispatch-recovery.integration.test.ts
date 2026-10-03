import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import { JobService } from '../src/modules/jobs/service.js'
import { RemoteJobCarrierDispatch } from '../src/modules/runs/remote/jobCarrierDispatch.js'
import { jobSpec } from './helpers/jobFixture.js'

// Own random schema on the explicitly selected loopback server. No physical
// qualification/native entry or journal absence as proof of nonexecution.
it.skipIf(!process.env.JOB_DISPATCH_DATABASE_URL)('reports retained delivery/reconciliation failures through HTTP and MCP without redispatch or fabricated cancellation', async () => {
  const connectionString = process.env.JOB_DISPATCH_DATABASE_URL!
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('Use the authorized local PostgreSQL server.')
  const schema = `job_dispatch_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString, max: 1 })
  const pool = new pg.Pool({ connectionString, max: 4, options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` })
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined, dispatch: PostgresJobDispatch | undefined
  await admin.query(`create schema ${schema}`)
  try {
    await applyApplicationMigrations(pool)
    const workspaceId = randomUUID(), deviceId = randomUUID()
    await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId, JSON.stringify({ id: workspaceId, name: 'Dispatch recovery fixture' })])
    const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
    const writer = await access.issue({ name: 'Job writer', audience: 'operator', expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['job_definitions:read', 'job_definitions:write', 'jobs:start', 'jobs:cancel', 'jobs:read'], scope: { workspaceIds: [workspaceId] } }] })
    const reader = await access.issue({ name: 'Job reader', audience: 'operator', expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['jobs:read'], scope: { workspaceIds: [workspaceId] } }] })
    const request = vi.fn(async (_device: string, _namespace: string, raw: unknown): Promise<{ payload: unknown }> => {
      if ((raw as { method: string }).method === 'job-dispatch') throw new Error('transport rejected before a receipt; secret must not be exposed')
      return { payload: { status: 'unknown', reason: 'journal_absence_requires_reconciliation' } }
    })
    dispatch = new PostgresJobDispatch(pool, new RemoteJobCarrierDispatch(pool, { request }, undefined), {
      revalidate: async () => {}, authorizeControl: async () => {}, observe: async () => { throw new Error('No receipt was returned.') },
    })
    const jobs = new JobService(pool, commands, {
      preparation: { choices: async () => ({ targets: [], sources: [], policies: [] }), validate: async () => ({ valid: true, reasons: [], sideEffects: false }),
        revalidateAccepted: async () => {}, adoptFinalBinding: async () => {}, accept: async (_sql, _principal, _workspace, spec) => ({ ...spec, source: { ...spec.source, materializationId: randomUUID(), materializationDigest: '1'.repeat(64) } }) },
      dispatch, artifacts: { list: async () => [], read: async () => { throw new Error('No physical artifact.') } },
    })
    app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } }, operator: { access, services: { jobs, commands } as unknown as OperatorServices } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'dispatch-recovery', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(writer.token), deniedClient = await connect(reader.token)
    const root = `/api/management/workspaces/${workspaceId}/jobs`, headers = { authorization: `Bearer ${writer.token}` }
    const spec = jobSpec()
    spec.target.hostRef = { kind: 'device', mainId: spec.target.mainId, deviceId }
    spec.target.registration = { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
    const saved = await app.inject({ method: 'POST', url: `${root}/definitions`, headers, payload: { commandId: randomUUID(), expectedRevision: null, name: 'Retained dispatch', spec } })
    expect(saved.statusCode).toBe(200)
    const command = { commandId: randomUUID(), definitionId: saved.json().definition.id, expectedRevision: 1 }
    const start = await app.inject({ method: 'POST', url: `${root}/executions`, headers, payload: command })
    expect(start.statusCode).toBe(503)
    expect(start.json().error).toMatchObject({ code: 'JOB_DISPATCH_PENDING', details: { retryable: true } })
    expect(JSON.stringify(start.json())).not.toContain('secret')
    const original = (await pool.query('select e.record,d.delivery_attempted,d.receipt_sequence,d.last_receipt from job_executions e join job_dispatch_intents d on d.execution_id=e.id where e.workspace_id=$1', [workspaceId])).rows
    expect(original).toHaveLength(1)
    const execution = original[0].record
    expect(original[0]).toMatchObject({ delivery_attempted: true, receipt_sequence: '0', last_receipt: null })
    expect(execution.process).toMatchObject({ phase: 'queued', outcome: null, processStopped: false })
    expect(start.json().error.details).toMatchObject({ executionId: execution.id, attemptId: execution.attemptId, operationId: execution.operationId })
    await dispatch.close()
    const retry = await client.callTool({ name: 'job_start', arguments: { workspaceId, ...command } })
    expect(retry.isError).toBe(true); expect(JSON.stringify(retry.content)).toContain('JOB_DISPATCH_PENDING')
    expect(request.mock.calls.map(([, , raw]) => (raw as { method: string }).method)).toEqual(['job-dispatch', 'job-status'])
    const cancel = await client.callTool({ name: 'job_cancel', arguments: { workspaceId, executionId: execution.id, commandId: randomUUID() } })
    expect(cancel.isError).toBe(true); expect(JSON.stringify(cancel.content)).toContain('JOB_DISPATCH_PENDING')
    expect(request.mock.calls.map(([, , raw]) => (raw as { method: string }).method)).toEqual(['job-dispatch', 'job-status', 'job-status', 'job-control'])
    const read = await client.callTool({ name: 'job_get', arguments: { workspaceId, executionId: execution.id } })
    expect(read.isError).not.toBe(true)
    expect(read.structuredContent).toMatchObject({ execution: { id: execution.id, attemptId: execution.attemptId, operationId: execution.operationId, acceptedSpec: execution.acceptedSpec,
      process: { phase: 'queued', outcome: null, processStopped: false }, transport: 'unknown', publication: 'pending', cancelRequestedAt: expect.any(String) } })
    const http = await app.inject({ method: 'GET', url: `${root}/executions/${execution.id}`, headers })
    expect(http.statusCode).toBe(200); expect(http.json()).toEqual(read.structuredContent)
    const denied = await deniedClient.callTool({ name: 'job_cancel', arguments: { workspaceId, executionId: execution.id, commandId: randomUUID() } })
    expect(denied.isError).toBe(true); expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(request).toHaveBeenCalledTimes(4)
    expect((await pool.query('select id from job_executions where workspace_id=$1', [workspaceId])).rows).toEqual([{ id: execution.id }])
  } finally {
    await Promise.allSettled(clients.map(client => client.close())); await app?.close(); await dispatch?.close(); await pool.end()
    try { await admin.query(`drop schema ${schema} cascade`) } finally { await admin.end() }
  }
}, 90000)
