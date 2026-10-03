import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { JobRuntimeFingerprintSchema, JobRuntimeProfileListSchema, type JobRuntimeProfile } from '@graphql/contracts/job-runtime'
import { SourceRootRecordSchema } from '@graphql/contracts/source-admission'
import { JobPolicySchema } from '@graphql/contracts/jobs'
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
