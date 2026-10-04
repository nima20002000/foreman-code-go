import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { JobRuntimeFingerprintSchema, JobRuntimeProfileListSchema, type JobRuntimeProfile } from '@foreman-code/contracts/job-runtime'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { JobPolicySchema } from '@foreman-code/contracts/jobs'
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { BrowserAuthentication } from '../src/modules/browser-auth/service.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { JobRuntimeProfiles } from '../src/modules/jobs/runtimeProfiles.js'
import type { PostgresSourceService } from '../src/modules/sources/service.js'
import { registerJobRuntimeProfileRoutes } from '../src/routes/jobRuntimeProfiles.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { jobSpec } from './helpers/jobFixture.js'

const origin = 'http://127.0.0.1:5173', browserHeaders = { host: '127.0.0.1:3000', origin }
/** Real migrated PostgreSQL, domain writes, browser approval and authenticated MCP.
 * Installed candidate capture is a metadata fixture; no physical qualification is claimed. */
async function fixture() {
  const db = await currentDatabase(), access = new PostgresAccessService(db.pool), workspaceId = randomUUID()
  const owner = await access.issue({ name: 'Runtime fixture owner', audience: 'operator',
    grants: [{ actions: ['job_definitions:read', 'job_definitions:write'], scope: { workspaceIds: [workspaceId] } }], expiresAt: new Date(Date.now() + 3_600_000) })
  const mainId = (await db.pool.query('select id from application_installation')).rows[0].id
  const sourceId = randomUUID(), snapshotId = randomUUID(), rootId = randomUUID(), digest = 'a'.repeat(64)
  const root = SourceRootRecordSchema.parse({ version: 1, source: { approvedSourceId: sourceId, snapshotId, manifestDigest: digest },
    selection: { hostRef: { kind: 'main', mainId }, rootPolicyId: rootId, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId, deviceId: null, workerInstallationId: null, workspaceId, rootId, bindingRevision: 1,
      locationRevision: 1, canonicalPath: '/owned-metadata-fixture', filesystem: { device: '1', inode: '2', mountId: '3' },
      accessMode: 'exclusive-write', snapshotId, manifestDigest: digest }, ownerPrincipalId: owner.principal.id,
    authorizedByPrincipalId: owner.principal.id, registration: null, attestationId: randomUUID(), attestationDigest: digest, boundAt: new Date().toISOString() })
  await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId, JSON.stringify({ id: workspaceId, name: 'Runtime metadata fixture' })])
  await db.pool.query("insert into source_approvals(approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request) values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')", [sourceId, snapshotId, workspaceId, owner.principal.id, randomUUID(), digest])
  await db.pool.query("insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record) values($1,$2,$3,$4,'{}')", [snapshotId, sourceId, workspaceId, digest])
  await db.pool.query('insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision) values($1,$2,$3,1)', [rootId, workspaceId, digest])
  await db.pool.query('insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record) values($1,1,$2,$3,$4::jsonb)', [rootId, workspaceId, snapshotId, JSON.stringify(root)])
  const producer = { capture: vi.fn(async (profile: JobRuntimeProfile) => JobRuntimeFingerprintSchema.parse({ schemaVersion: 1,
    profileId: profile.id, profileRevision: profile.revision, specDigest: profile.specDigest, hostRef: root.selection.hostRef,
    registration: null, mainInstallationId: mainId, bootId: randomUUID(), root, runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: digest,
    ociExecutable: '/usr/bin/crun', ociBinarySha256: digest, configurationDigest: digest, imageDigest: profile.policy.imageDigest,
    toolchainDigest: profile.policy.toolchainDigest, limits: profile.limits })),
    run: vi.fn(async () => { throw new Error('private producer failure /secret/path token=do-not-expose') }),
    revalidate: vi.fn(async () => ({ ready: false, reasons: ['UNQUALIFIED'] })) }
  const commands = new PostgresCommandCoordinator(db.pool)
  const service = new JobRuntimeProfiles(db.pool, commands, { resolveRootBinding: async () => root } as unknown as PostgresSourceService, producer)
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    browserAuth: new BrowserAuthentication(db.pool, access, { origin, secret: 'runtime-test-browser-secret-'.repeat(3), ownerPrincipalId: owner.principal.id }),
    operator: { access, services: { commands, jobRuntimeProfiles: service } as OperatorServices } })
  registerJobRuntimeProfileRoutes(app, service)
  const clients: Client[] = [], close = async () => { await Promise.allSettled(clients.map(client => client.close())); await app.close(); await db.close() }
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 }), auth = { authorization: `Bearer ${owner.token}` }
    const base = `/api/management/workspaces/${workspaceId}/jobs`
    const policy = JobPolicySchema.omit({ isolationPolicyId: true, isolationPolicyRevision: true }).strip().parse(jobSpec().policy)
    const input = { commandId: randomUUID(), expectedRevision: null, name: 'Candidate runtime', spec: { rootId, bindingRevision: 1,
      limits: { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 64, diskBytes: 134217728 }, policy: { ...policy, maxWorkerSpoolBytes: 131072 } } }
    const saved = await app.inject({ method: 'POST', url: `${base}/runtime-profiles`, headers: auth, payload: input })
    expect(saved.statusCode, saved.body).toBe(200)
    const profile = saved.json().profile
    const requested = await app.inject({ method: 'POST', url: `${base}/runtime-profiles/${profile.id}/qualification-requests`, headers: auth,
      payload: { commandId: randomUUID(), expectedRevision: 1 } })
    expect(requested.statusCode, requested.body).toBe(200)
    const approval = requested.json().approval
    const connect = async (token = owner.token) => {
      const client = new Client({ name: 'runtime profile parity', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const browser = async () => {
      const account = { email: 'runtime-owner@example.test', password: 'runtime-owner-test-password' }
      expect((await app.inject({ method: 'POST', url: '/api/auth/setup', headers: browserHeaders, payload: account })).statusCode).toBe(201)
      const signedIn = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: browserHeaders, payload: account })
      expect(signedIn.statusCode).toBe(200)
      const cookies = signedIn.headers['set-cookie'], cookie = (Array.isArray(cookies) ? cookies : [cookies!]).map(value => value.split(';')[0]).join('; ')
      return { ...browserHeaders, cookie }
    }
    return { db, access, owner, app, auth, base, workspaceId, profile, approval, input, producer, connect, browser, close }
  } catch (error) { await close(); throw error }
}

describe.skipIf(!postgresEnabled)('runtime profile authenticated HTTP/MCP parity', () => {
  it.each(['http', 'mcp'] as const)('rejects an oversized spool on %s profile save before writing a profile', async transport => {
    const f = await fixture()
    try {
      const input = { ...f.input, commandId: randomUUID(), spec: { ...f.input.spec, policy: { ...f.input.spec.policy, maxWorkerSpoolBytes: 67108865 } } }
      if (transport === 'http') {
        const response = await f.app.inject({ method: 'POST', url: `${f.base}/runtime-profiles`, headers: f.auth, payload: input })
        expect(response.statusCode, response.body).toBe(400)
      } else {
        const client = await f.connect()
        expect((await client.callTool({ name: 'job_runtime_profile_save', arguments: { ...input, workspaceId: f.workspaceId } })).isError).toBe(true)
      }
      expect((await f.db.pool.query('select count(*)::int as count from job_runtime_profiles')).rows[0].count).toBe(1)
      expect(f.producer.run).not.toHaveBeenCalled()
    } finally { await f.close() }
  }, 120_000)

  it('rejects qualification requests for an older oversized profile on HTTP and MCP before candidate capture', async () => {
    const f = await fixture()
    try {
      const older = { ...f.profile, policy: { ...f.profile.policy, maxWorkerSpoolBytes: 67108865 } }
      await f.db.pool.query('update job_runtime_profiles set record=$2::jsonb where id=$1', [f.profile.id, JSON.stringify(older)])
      f.producer.capture.mockClear()
      const http = await f.app.inject({ method: 'POST', url: `${f.base}/runtime-profiles/${f.profile.id}/qualification-requests`, headers: f.auth,
        payload: { commandId: randomUUID(), expectedRevision: 1 } })
      expect(http.statusCode, http.body).toBe(400)
      const client = await f.connect()
      expect((await client.callTool({ name: 'job_runtime_qualification_request', arguments: {
        workspaceId: f.workspaceId, profileId: f.profile.id, commandId: randomUUID(), expectedRevision: 1,
      } })).isError).toBe(true)
      expect(f.producer.capture).not.toHaveBeenCalled(); expect(f.producer.run).not.toHaveBeenCalled()
      expect((await f.db.pool.query('select count(*)::int as count from job_runtime_qualification_approvals')).rows[0].count).toBe(1)
      expect((await f.db.pool.query('select record from job_runtime_profiles where id=$1', [f.profile.id])).rows[0].record).toEqual(older)
    } finally { await f.close() }
  }, 120_000)

  it.each(['http', 'mcp'] as const)('settles a thrown %s qualification in recovery-required with a sanitized reason and retained ownership', async transport => {
    const f = await fixture()
    try {
      const browser = await f.browser(), commandId = randomUUID(), client = await f.connect()
      const approved = await f.app.inject({ method: 'POST', url: `${f.base}/runtime-qualifications/${f.approval.id}/approve`, headers: browser,
        payload: { commandId: randomUUID() } })
      expect(approved.statusCode, approved.body).toBe(200)
      if (transport === 'http') {
        const response = await f.app.inject({ method: 'POST', url: `${f.base}/runtime-qualifications/${f.approval.id}/run`, headers: f.auth, payload: { commandId } })
        expect(response.statusCode).toBe(500); expect(response.body).not.toContain('/secret/path')
      } else {
        const response = await client.callTool({ name: 'job_runtime_qualification_run', arguments: { workspaceId: f.workspaceId, approvalId: f.approval.id, commandId } })
        expect(response.isError).toBe(true); expect(JSON.stringify(response)).not.toContain('/secret/path')
      }
      const read = await f.app.inject({ method: 'GET', url: `${f.base}/runtime-qualifications/${f.approval.id}`, headers: f.auth })
      expect(read.statusCode, read.body).toBe(200)
      expect(read.json()).toMatchObject({ profile: { status: 'recovery-required', measurement: null }, approval: { status: 'recovery-required' },
        measurement: null, readiness: { ready: false, reasons: ['JOB_RUNTIME_QUALIFICATION_FAILED'], sideEffects: false } })
      expect((await client.callTool({ name: 'job_runtime_qualification_get', arguments: { workspaceId: f.workspaceId, approvalId: f.approval.id } })).structuredContent).toEqual(read.json())
      const stored = (await f.db.pool.query('select run_command_id,run_principal_id,run_result from job_runtime_qualification_approvals where id=$1', [f.approval.id])).rows[0]
      expect(stored).toEqual({ run_command_id: commandId, run_principal_id: f.owner.principal.id,
        run_result: { outcome: 'denied', closure: 'unconfirmed', reasons: ['JOB_RUNTIME_QUALIFICATION_FAILED'] } })
      const retry = await client.callTool({ name: 'job_runtime_qualification_run', arguments: { workspaceId: f.workspaceId, approvalId: f.approval.id, commandId } })
      expect(retry.isError, JSON.stringify(retry.content)).not.toBe(true)
      expect(retry.structuredContent).toMatchObject({ profile: { status: 'recovery-required', measurement: null } })
      expect(f.producer.run).toHaveBeenCalledOnce()
    } finally { await f.close() }
  }, 120_000)

  it('lists the shared persisted profile and pending approval DTO and denies a foreign scope', async () => {
    const f = await fixture()
    try {
      const client = await f.connect()
      const http = await f.app.inject({ method: 'GET', url: `${f.base}/runtime-profiles`, headers: f.auth })
      expect(http.statusCode, http.body).toBe(200)
      const expected = JobRuntimeProfileListSchema.parse(http.json())
      expect(expected.profiles).toHaveLength(1); expect(expected.approvals).toEqual([f.approval])
      const read = await client.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId: f.workspaceId } })
      expect(read.isError, JSON.stringify(read.content)).not.toBe(true)
      expect(JobRuntimeProfileListSchema.parse(read.structuredContent)).toEqual(expected)
      const persisted = (await f.db.pool.query('select record from job_runtime_profiles where id=$1', [f.profile.id])).rows[0].record
      expect(expected.profiles[0]?.profile).toEqual(persisted)
      const outsider = await f.access.issue({ name: 'Foreign scope reader', audience: 'operator',
        grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: ['foreign'] } }], expiresAt: new Date(Date.now() + 600_000) })
      const denied = await f.connect(outsider.token)
      expect((await denied.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId: f.workspaceId } })).isError).toBe(true)
      expect((await f.db.pool.query("select outcome from management_audit where principal_id=$1 and action='job_runtime_profile_list'", [outsider.principal.id])).rows).toEqual([{ outcome: 'denied' }])
      expect(f.producer.run).not.toHaveBeenCalled(); expect(f.producer.revalidate).not.toHaveBeenCalled()
    } finally { await f.close() }
  }, 120_000)
})
