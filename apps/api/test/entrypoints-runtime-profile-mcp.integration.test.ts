import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { JobRuntimeFingerprintSchema, JobRuntimeProfileListSchema } from '@foreman-code/contracts/job-runtime'
import { ApprovedSourceSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { JOB_VERIFICATION_APPROVAL_LIFETIME_MS } from '@foreman-code/contracts/job-verification-policy'
import type { JobRuntimeProfileRecord, JobRuntimeApprovalRecord } from '@foreman-code/contracts/job-verification-runtime'
import { JobPolicySchema } from '@foreman-code/contracts/jobs'
import { JobRuntimeProfileListRecordSchema, JobVerificationProfileSchema, JobVerificationRuntimeFingerprintSchema,
  JobVerificationRuntimeMeasurementSchema, JobRuntimeQualificationReadRecordSchema, QualifiedVerificationJobRuntimeSchema } from '@foreman-code/contracts/job-verification-runtime'
import { jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { JobSql } from '../src/modules/jobs/repository.js'
import { JobRuntimeProfiles } from '../src/modules/jobs/runtimeProfiles.js'
import type { JobRuntimeQualificationProducer } from '../src/modules/jobs/runtimeProfilePorts.js'
import { createProductionSources } from '../src/modules/sources/production.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { registerJobRuntimeProfileRoutes } from '../src/routes/jobRuntimeProfiles.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { jobSpec } from './helpers/jobFixture.js'
import { verificationFixture } from './helpers/jobVerificationFixture.js'
import { verificationRuntimeFixture } from './helpers/verificationRuntimeFixture.js'

const origin = 'http://127.0.0.1:5173', browserHeaders = { host: '127.0.0.1:3000', origin }
const verificationSaveResult = z.object({ profile: JobVerificationProfileSchema }).strict()
/** Real migrated PostgreSQL, domain writes, browser approval and authenticated MCP.
 * Producer records are contract fixtures; physical ordinary qualification has separate acceptance coverage. */
async function fixture() {
  const db = await currentDatabase(), access = new PostgresAccessService(db.pool), workspaceId = randomUUID()
  const owner = await access.issue({ name: 'Runtime fixture owner', audience: 'operator',
    grants: [{ actions: ['job_definitions:read', 'job_definitions:write', 'sources:read', 'source_roots:read',
      'jobs:start', 'job_artifacts:read'], scope: { workspaceIds: [workspaceId] } }], expiresAt: new Date(Date.now() + 3_600_000) })
  const mainId = (await db.pool.query('select id from application_installation')).rows[0].id
  const sourceId = randomUUID(), snapshotId = randomUUID(), rootId = randomUUID()
  const sourceBytes = Buffer.from('{}')
  const manifest = createSourceManifest({ version: 1, approvedSourceId: sourceId, snapshotId,
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip',
    git: { commit: '2'.repeat(40), tree: '3'.repeat(40), objectFormat: 'sha1' },
    entries: [{ path: 'package.json', kind: 'file', executable: false,
      byteSize: sourceBytes.length, sha256: sourceSha256(sourceBytes) }], deletions: [] })
  const digest = manifest.manifestDigest
  const root = SourceRootRecordSchema.parse({ version: 1, source: { approvedSourceId: sourceId, snapshotId, manifestDigest: digest },
    selection: { hostRef: { kind: 'main', mainId }, rootPolicyId: rootId, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId, deviceId: null, workerInstallationId: null, workspaceId, rootId, bindingRevision: 1,
      locationRevision: 1, canonicalPath: '/owned-metadata-fixture', filesystem: { device: '1', inode: '2', mountId: '3' },
      accessMode: 'exclusive-write', snapshotId, manifestDigest: digest }, ownerPrincipalId: owner.principal.id,
    authorizedByPrincipalId: owner.principal.id, registration: null, attestationId: randomUUID(), attestationDigest: digest, boundAt: new Date().toISOString() })
  await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId, JSON.stringify({ id: workspaceId, name: 'Runtime metadata fixture' })])
  await db.pool.query("insert into source_approvals(approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request) values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')", [sourceId, snapshotId, workspaceId, owner.principal.id, randomUUID(), digest])
  const approvedSource = ApprovedSourceSchema.parse({ version: 1, workspaceId, ownerPrincipalId: owner.principal.id,
    approvedByPrincipalId: owner.principal.id, mainId, locationRevision: 1,
    originIdentityHash: `sha256:${digest}`, manifest, approvedAt: root.boundAt, availability: 'retained' })
  await db.pool.query('insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record) values($1,$2,$3,$4,$5::jsonb)',
    [snapshotId, sourceId, workspaceId, digest, JSON.stringify(approvedSource)])
  await db.pool.query('insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision) values($1,$2,$3,1)', [rootId, workspaceId, digest])
  await db.pool.query('insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record) values($1,1,$2,$3,$4::jsonb)', [rootId, workspaceId, snapshotId, JSON.stringify(root)])
  const producer = { capture: vi.fn(async (profile: JobRuntimeProfileRecord) => {
    if (profile.schemaVersion === 2) {
      const metadata = verificationRuntimeFixture().measurement.fingerprint
      return JobVerificationRuntimeFingerprintSchema.parse({ ...metadata, profileId: profile.id,
        profileRevision: profile.revision, specDigest: profile.specDigest, root: profile.root,
        hostRef: profile.root.selection.hostRef, registration: profile.root.registration, mainInstallationId: mainId,
        resources: profile.spec.resources, limits: profile.spec.resources.limits, sourceCommit: profile.sourceCommit,
        network: profile.spec.policy.network, approvalConfig: profile.approvalConfig,
        imageDigest: profile.spec.policy.imageDigest, toolchainDigest: profile.spec.policy.toolchainDigest,
        quotaPool: { ...metadata.quotaPool!, slots: metadata.quotaPool!.slots.map(slot => ({
          ...slot, filesystem: { ...profile.root.binding.filesystem, inode: slot.filesystem.inode },
        })) } })
    }
    return JobRuntimeFingerprintSchema.parse({ schemaVersion: 1,
    profileId: profile.id, profileRevision: profile.revision, specDigest: profile.specDigest, hostRef: root.selection.hostRef,
    registration: null, mainInstallationId: mainId, bootId: randomUUID(), root, runtimeExecutable: '/usr/bin/podman', runtimeBinarySha256: digest,
    ociExecutable: '/usr/bin/crun', ociBinarySha256: digest, configurationDigest: digest, imageDigest: profile.policy.imageDigest,
    toolchainDigest: profile.policy.toolchainDigest, limits: profile.limits }) }),
    reconcile: vi.fn<JobRuntimeQualificationProducer['run']>(async () => ({ outcome:'denied',closure:'unconfirmed',
      reasons:['JOB_RUNTIME_QUALIFICATION_FAILED'] })),
    run: vi.fn<JobRuntimeQualificationProducer['run']>(async (approval: JobRuntimeApprovalRecord) => {
      if (approval.schemaVersion === 1) throw new Error('private producer failure /secret/path token=do-not-expose')
      const fixture = verificationRuntimeFixture()
      const profile = JobVerificationProfileSchema.parse((await db.pool.query(
        'select record from job_runtime_profile_versions where profile_id=$1 and revision=$2',
        [approval.profileId, approval.profileRevision])).rows[0].record)
      const fingerprint = approval.fingerprint
      const measurement = JobVerificationRuntimeMeasurementSchema.parse({ ...fixture.measurement, fingerprint,
        approvedAt: approval.approvedAt ?? approval.requestedAt,
        checkedAt: new Date().toISOString(), expiresAt: approval.expiresAt,
        identity: { ...fixture.measurement.identity, profileId: profile.id, profileRevision: profile.revision,
          rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision,
          qualificationId: approval.qualificationId, fingerprintDigest: approval.fingerprintDigest,
          imageDigest: fingerprint.imageDigest, toolchainDigest: fingerprint.toolchainDigest, network: fingerprint.network,
          approvalId: approval.id, approvalExpiresAt: approval.expiresAt, qualificationExpiresAt: approval.expiresAt },
        suites: profile.spec.suites.map(suite => ({ ...fixture.measurement.suites[0], suite,
          resources: profile.spec.resources })),
      })
      const runtime = QualifiedVerificationJobRuntimeSchema.parse({ ...fixture.runtime, ...fingerprint.limits,
        policyId: profile.id, policyRevision: profile.revision, qualificationId: approval.qualificationId,
        imageDigest: fingerprint.imageDigest, toolchainDigest: fingerprint.toolchainDigest, network: fingerprint.network,
        quota: fingerprint.quota, deviceLimits: fingerprint.deviceLimits, provisioningSuite: fingerprint.provisioningSuite,
        aggregateCgroupIdentityDigest: fingerprint.aggregateCgroupIdentityDigest, imageManifestDigest: fingerprint.imageManifestDigest,
        imageConfigDigest: fingerprint.imageConfigDigest, resourcePolicyRevision: fingerprint.resourcePolicyRevision,
        resourcePolicyDigest: fingerprint.resourcePolicyDigest, runtimeApprovalId: fingerprint.runtimeApprovalId,
        runtimeApprovalRevision: fingerprint.runtimeApprovalRevision })
      return { outcome: 'qualified' as const, measurement, runtime }
    }),
    revalidate: vi.fn(async (_sql: JobSql, profile: JobRuntimeProfileRecord) => profile.schemaVersion === 2
      ? { ready: true, reasons: [] } : { ready: false, reasons: ['UNQUALIFIED'] }) }
  const commands = new PostgresCommandCoordinator(db.pool)
  const noCarrier = (): never => { throw new Error('Source snapshot readback cannot contact a worker') }
  const sourceRuntime = await createProductionSources({ pool: db.pool, commands,
    locations: new WorkspaceLocationService(db.pool, commands), mainId, runtimeRoot: db.directory,
    endpoint: noCarrier, dispatch: noCarrier })
  vi.spyOn(sourceRuntime.sources, 'resolveRootBinding').mockResolvedValue(root)
  const service = new JobRuntimeProfiles(db.pool, commands, sourceRuntime.sources, producer)
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    localHuman: { current: () => access.currentOperator(owner.principal.id) }, browserOrigin: origin,
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
    const browser = async () => browserHeaders
    return { db, access, owner, app, auth, base, workspaceId, profile, approval, input, producer, connect, browser, close,
      service, createService: () => new JobRuntimeProfiles(db.pool,new PostgresCommandCoordinator(db.pool),
        sourceRuntime.sources,producer) }
  } catch (error) { await close(); throw error }
}

describe.skipIf(!postgresEnabled)('runtime profile authenticated HTTP/MCP parity', () => {
  it('keeps a newer qualification ready when an older denial completes and reads old evidence separately', async () => {
    const f = await fixture()
    let finish!: () => void
    let pending: ReturnType<Client['callTool']> | undefined
    try {
      const v = verificationFixture()
      const client = await f.connect()
      const second = await f.connect()
      const response = await client.callTool({ name:'job_runtime_profile_save',arguments:{ workspaceId:f.workspaceId,
        commandId:randomUUID(),expectedRevision:null,name:'Concurrent qualification',spec:{
          rootId:f.input.spec.rootId,bindingRevision:1,resources:v.resources,policy:jobPolicyRequirementsRecord(v.spec.policy),
          suites:['unit'],approvalConfig:{ approvalLifetimeMs:JOB_VERIFICATION_APPROVAL_LIFETIME_MS },
        } } })
      expect(response.isError,JSON.stringify(response.content)).not.toBe(true)
      const saved = verificationSaveResult.parse(decodeMcpToolResult(response)).profile
      const capture = async (using = client) => {
        const result = await using.callTool({ name:'job_runtime_qualification_request',arguments:{ workspaceId:f.workspaceId,
          profileId:saved.id,expectedRevision:saved.revision,commandId:randomUUID() } })
        expect(result.isError,JSON.stringify(result.content)).not.toBe(true)
        return (decodeMcpToolResult(result) as { approval:JobRuntimeApprovalRecord }).approval
      }
      const older = await capture()
      let started!: () => void
      const entered = new Promise<void>(resolve => { started = resolve })
      const release = new Promise<void>(resolve => { finish = resolve })
      f.producer.run.mockImplementationOnce(async () => {
        started()
        await release
        return { outcome:'denied',closure:'confirmed',reasons:['Older suite failed'] }
      })
      pending = client.callTool({ name:'job_runtime_qualification_run',arguments:{ workspaceId:f.workspaceId,
        approvalId:older.id,commandId:randomUUID() } })
      await entered
      const newer = await capture(second)
      const completed = await second.callTool({ name:'job_runtime_qualification_run',arguments:{ workspaceId:f.workspaceId,
        approvalId:newer.id,commandId:randomUUID() } })
      expect(completed.isError,JSON.stringify(completed.content)).not.toBe(true)
      const qualified = verificationSaveResult.parse(decodeMcpToolResult(completed)).profile
      finish()
      const denied = await pending
      expect(denied.isError,JSON.stringify(denied.content)).not.toBe(true)
      expect(decodeMcpToolResult(denied)).toEqual({ profile:qualified })
      const read = await client.callTool({ name:'job_runtime_qualification_get',arguments:{
        workspaceId:f.workspaceId,approvalId:older.id } })
      expect(JobRuntimeQualificationReadRecordSchema.parse(decodeMcpToolResult(read))).toMatchObject({
        approval:{ id:older.id,status:'failed' },measurement:null,profile:qualified,readiness:{ ready:true,sideEffects:false },
      })
      expect((await f.db.pool.query('select record from job_runtime_profiles where id=$1',[saved.id])).rows[0].record)
        .toEqual(qualified)
      expect(qualified.measurement?.identity.qualificationId).toBe(newer.qualificationId)
      expect((await f.db.pool.query('select record,run_result from job_runtime_qualification_approvals where id=$1',
        [older.id])).rows[0]).toMatchObject({ record:{ status:'failed' },run_result:{ outcome:'denied',closure:'confirmed' } })
    } finally {
      finish?.()
      await Promise.allSettled(pending ? [pending] : [])
      await f.close()
    }
  },120_000)

  it.each(['throw','unconfirmed'] as const)('reconciles a saved %s result through MCP across service restart', async fault => {
    const f = await fixture()
    try {
      vi.spyOn(f.service,'qualify').mockImplementation((...args) => f.createService().qualify(...args))
      const client = await f.connect()
      const commandId = randomUUID()
      const args = { workspaceId:f.workspaceId,approvalId:f.approval.id,commandId }
      if (fault === 'unconfirmed') f.producer.run.mockResolvedValueOnce({ outcome:'denied',closure:'unconfirmed',
        reasons:['Original cleanup pending'] })
      const first = await client.callTool({ name:'job_runtime_qualification_run',arguments:args })
      expect(first.isError === true).toBe(fault === 'throw')
      f.producer.reconcile.mockResolvedValue({ outcome:'denied',closure:'confirmed',reasons:['Original operation closed'] })
      const reader = await f.access.issue({ name:'Qualification reader',audience:'operator',
        grants:[{ actions:['job_definitions:read'],scope:{ workspaceIds:[f.workspaceId] } }],
        expiresAt:new Date(Date.now() + 600_000) })
      const readonly = await f.connect(reader.token)
      expect((await readonly.callTool({ name:'job_runtime_qualification_run',arguments:args })).isError).toBe(true)
      expect((await client.callTool({ name:'job_runtime_qualification_run',arguments:{ ...args,commandId:randomUUID() } })).isError)
        .toBe(true)
      const recovered = await client.callTool({ name:'job_runtime_qualification_run',arguments:args })
      expect(recovered.isError,JSON.stringify(recovered.content)).not.toBe(true)
      expect(decodeMcpToolResult(recovered)).toMatchObject({ profile:{ status:'failed',measurement:null } })
      expect(decodeMcpToolResult((await client.callTool({ name:'job_runtime_qualification_run',arguments:args }))))
        .toEqual(decodeMcpToolResult(recovered))
      const readback = await readonly.callTool({ name:'job_runtime_qualification_get',
        arguments:{ workspaceId:f.workspaceId,approvalId:f.approval.id } })
      expect(decodeMcpToolResult(readback)).toMatchObject({ approval:{ status:'failed' },profile:{ status:'failed' } })
      const row = (await f.db.pool.query(`select run_command_id,run_principal_id,run_result
        from job_runtime_qualification_approvals where id=$1`,[f.approval.id])).rows[0]
      expect(row).toEqual({ run_command_id:commandId,run_principal_id:f.owner.principal.id,
        run_result:{ outcome:'denied',closure:'confirmed',reasons:['Original operation closed'] } })
      expect(f.producer.run).toHaveBeenCalledOnce()
      expect(f.producer.reconcile).toHaveBeenCalledOnce()
    } finally { await f.close() }
  },120_000)

  it.each(['expired','edited'] as const)('recovers an %s original operation without replacing newer profile data', async change => {
    const f = await fixture()
    try {
      const client = await f.connect()
      const commandId = randomUUID()
      const args = { workspaceId:f.workspaceId,approvalId:f.approval.id,commandId }
      f.producer.run.mockResolvedValueOnce({ outcome:'denied',closure:'unconfirmed',reasons:['Cleanup pending'] })
      expect((await client.callTool({ name:'job_runtime_qualification_run',arguments:args })).isError).not.toBe(true)
      if (change === 'expired') {
        const record = { ...f.approval,status:'recovery-required',expiresAt:'2020-01-01T00:00:00Z' }
        await f.db.pool.query('update job_runtime_qualification_approvals set record=$2::jsonb where id=$1',
          [f.approval.id,JSON.stringify(record)])
      } else {
        const changed = await client.callTool({ name:'job_runtime_profile_save',arguments:{ workspaceId:f.workspaceId,
          ...f.input,id:f.profile.id,expectedRevision:1,commandId:randomUUID(),name:'Edited profile' } })
        expect(changed.isError,JSON.stringify(changed.content)).not.toBe(true)
      }
      const current = (await f.db.pool.query('select record from job_runtime_profiles where id=$1',[f.profile.id])).rows[0].record
      f.producer.reconcile.mockResolvedValue({ outcome:'denied',closure:'confirmed',reasons:['Original cleanup confirmed'] })
      const recovered = await client.callTool({ name:'job_runtime_qualification_run',arguments:args })
      expect(recovered.isError,JSON.stringify(recovered.content)).not.toBe(true)
      const persisted = (await f.db.pool.query('select record from job_runtime_profiles where id=$1',[f.profile.id])).rows[0].record
      if (change === 'edited') expect(persisted).toEqual(current)
      else expect(persisted).toMatchObject({ status:'failed',measurement:null })
      expect(decodeMcpToolResult((await client.callTool({ name:'job_runtime_qualification_get',
        arguments:{ workspaceId:f.workspaceId,approvalId:f.approval.id } }))))
        .toMatchObject({ approval:{ status:'failed' },profile:persisted })
      expect(f.producer.run).toHaveBeenCalledOnce()
      expect(f.producer.reconcile).toHaveBeenCalledOnce()
    } finally { await f.close() }
  },120_000)

  it.each(['qualifying','recovery-required'] as const)('discovers %s ownership through HTTP and read-only MCP', async status => {
    const f = await fixture()
    try {
      const commandId = randomUUID()
      const record = { ...f.approval,status }
      await f.db.pool.query(`update job_runtime_qualification_approvals
        set record=$2::jsonb,run_command_id=$3,run_principal_id=$4 where id=$1`,
      [f.approval.id,JSON.stringify(record),commandId,f.owner.principal.id])
      const before = (await f.db.pool.query('select * from job_runtime_qualification_approvals where id=$1',[f.approval.id])).rows[0]
      const reader = await f.access.issue({ name:'Recovery discovery reader',audience:'operator',
        grants:[{ actions:['job_definitions:read'],scope:{ workspaceIds:[f.workspaceId] } }],
        expiresAt:new Date(Date.now() + 600_000) })
      const readonly = await f.connect(reader.token)
      const listed = await readonly.callTool({ name:'job_runtime_profile_list',arguments:{ workspaceId:f.workspaceId } })
      expect(listed.isError,JSON.stringify(listed.content)).not.toBe(true)
      const result = JobRuntimeProfileListRecordSchema.parse(decodeMcpToolResult(listed))
      expect(result.approvals).toEqual([{ ...record,runCommandId:commandId,runPrincipalId:f.owner.principal.id }])
      const http = await f.app.inject({ method:'GET',url:`${f.base}/runtime-profiles`,
        headers:{ authorization:`Bearer ${reader.token}` } })
      expect(http.statusCode,http.body).toBe(200)
      expect(http.json()).toEqual(result)
      const outsider = await f.access.issue({ name:'Outside recovery scope',audience:'operator',
        grants:[{ actions:['job_definitions:read'],scope:{ workspaceIds:['foreign'] } }],
        expiresAt:new Date(Date.now() + 600_000) })
      const denied = await f.connect(outsider.token)
      expect((await denied.callTool({ name:'job_runtime_profile_list',arguments:{ workspaceId:f.workspaceId } })).isError)
        .toBe(true)
      expect((await f.db.pool.query('select * from job_runtime_qualification_approvals where id=$1',[f.approval.id])).rows[0])
        .toEqual(before)
      expect(f.producer.run).not.toHaveBeenCalled()
      expect(f.producer.reconcile).not.toHaveBeenCalled()
    } finally { await f.close() }
  },120_000)
  it.each(['http', 'mcp'] as const)('persists reviewed offline verification settings on %s and reads the same commit through MCP', async transport => {
    const f = await fixture()
    try {
      const v = verificationFixture()
      const input = { commandId: randomUUID(), expectedRevision: null, name: 'Ordinary verification',
        spec: { rootId: f.input.spec.rootId, bindingRevision: f.input.spec.bindingRevision,
          resources: v.resources, policy: jobPolicyRequirementsRecord(v.spec.policy),
          suites: ['install', 'typecheck', 'lint', 'unit', 'build'], approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS } } }
      const client = await f.connect()
      let saved
      if (transport === 'http') {
        const response = await f.app.inject({ method: 'POST', url: `${f.base}/runtime-profiles`, headers: f.auth, payload: input })
        expect(response.statusCode, response.body).toBe(200)
        saved = JobVerificationProfileSchema.parse(response.json().profile)
      } else {
        const response = await client.callTool({ name: 'job_runtime_profile_save',
          arguments: { workspaceId: f.workspaceId, ...input } })
        expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
        saved = verificationSaveResult.parse(decodeMcpToolResult(response)).profile
      }
      expect(saved.spec).toEqual(input.spec)
      expect(saved).toMatchObject({ schemaVersion: 2, revision: 1, status: 'unqualified', measurement: null,
        sourceCommit: '2'.repeat(40), approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS,
          review: { authority: 'repository-owner', decisionId: 'offline-verification', reviewedOn: '2026-10-05' } } })
      const retry = await client.callTool({ name: 'job_runtime_profile_save', arguments: { workspaceId: f.workspaceId, ...input } })
      expect(retry.isError, JSON.stringify(retry.content)).not.toBe(true)
      expect(verificationSaveResult.parse(decodeMcpToolResult(retry)).profile).toEqual(saved)
      const persisted = (await f.db.pool.query('select record from job_runtime_profiles where id=$1', [saved.id])).rows[0].record
      expect(persisted).toEqual(saved)
      const versions = (await f.db.pool.query('select record from job_runtime_profile_versions where profile_id=$1', [saved.id])).rows
      expect(versions).toEqual([{ record: saved }])
      const read = await client.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId: f.workspaceId } })
      const result = JobRuntimeProfileListRecordSchema.parse(decodeMcpToolResult(read))
      expect(result.profiles.find(item => item.profile.id === saved.id)).toEqual({ profile: saved, ready: false,
        reasons: ['runtime_setup_required'], sideEffects: false })
      const http = await f.app.inject({ method: 'GET', url: `${f.base}/runtime-profiles`, headers: f.auth })
      expect(http.statusCode, http.body).toBe(200)
      expect(http.json()).toEqual(result)

      f.producer.capture.mockClear()
      const pending = await client.callTool({ name: 'job_runtime_qualification_request', arguments: {
        workspaceId: f.workspaceId, profileId: saved.id, commandId: randomUUID(), expectedRevision: saved.revision } })
      expect(pending.isError, JSON.stringify(pending.content)).not.toBe(true)
      const approval = (decodeMcpToolResult(pending) as { approval: { id: string } }).approval
      expect(f.producer.capture).toHaveBeenCalledWith(saved)
      // A paired, authorized computer qualifies its captured candidate directly; there is no approval route.
      const approve = await f.app.inject({ method: 'POST', url: `${f.base}/runtime-qualifications/${approval.id}/approve`,
        headers: await f.browser(), payload: { commandId: randomUUID() } })
      expect(approve.statusCode).toBe(404)
      const runCommandId = randomUUID()
      const run = await client.callTool({ name: 'job_runtime_qualification_run', arguments: {
        workspaceId: f.workspaceId, approvalId: approval.id, commandId: runCommandId } })
      expect(run.isError, JSON.stringify(run.content)).not.toBe(true)
      const qualified = JobVerificationProfileSchema.parse((decodeMcpToolResult(run) as { profile: unknown }).profile)
      expect(qualified.status).toBe('qualified')
      expect(qualified.measurement?.suites.map(item => item.suite)).toEqual(saved.spec.suites)
      const qualification = await client.callTool({ name: 'job_runtime_qualification_get', arguments: {
        workspaceId: f.workspaceId, approvalId: approval.id } })
      const completed = JobRuntimeQualificationReadRecordSchema.parse(decodeMcpToolResult(qualification))
      expect(completed).toMatchObject({ profile: qualified, approval: { status: 'complete' },
        readiness: { ready: true, reasons: [], sideEffects: false } })
      expect((await f.db.pool.query('select record from job_runtime_profiles where id=$1', [saved.id])).rows[0].record)
        .toEqual(qualified)
      expect(decodeMcpToolResult((await client.callTool({ name: 'job_runtime_qualification_run', arguments: {
        workspaceId: f.workspaceId, approvalId: approval.id, commandId: runCommandId } }))))
        .toEqual(decodeMcpToolResult(run))
      expect(f.producer.run).toHaveBeenCalledOnce()

      const reader = await f.access.issue({ name: 'Verification reader', audience: 'operator',
        grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [f.workspaceId] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      const readonly = await f.connect(reader.token)
      expect((await readonly.callTool({ name: 'job_runtime_profile_save',
        arguments: { workspaceId: f.workspaceId, ...input, commandId: randomUUID() } })).isError).toBe(true)
      const readback = await readonly.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId: f.workspaceId } })
      expect(JobRuntimeProfileListRecordSchema.parse(decodeMcpToolResult(readback)).profiles.find(item => item.profile.id === saved.id))
        .toEqual({ profile: qualified, ready: true, reasons: [], sideEffects: false })
      for (const name of ['job_runtime_qualification_request', 'job_runtime_qualification_run']) {
        const args = name.endsWith('request') ? { profileId: saved.id, expectedRevision: 1 } : { approvalId: approval.id }
        expect((await readonly.callTool({ name, arguments: { workspaceId: f.workspaceId,
          commandId: randomUUID(), ...args } })).isError).toBe(true)
      }
      expect((await f.db.pool.query("select outcome from management_audit where principal_id=$1 and action='job_runtime_profile_save'",
        [reader.principal.id])).rows).toEqual([{ outcome: 'denied' }])
      expect((await f.db.pool.query('select count(*)::int as count from job_runtime_profile_versions where profile_id=$1',
        [saved.id])).rows[0].count).toBe(1)
    } finally { await f.close() }
  }, 120_000)

  it('edits verification settings through MCP with revision conflicts and immutable persisted history', async () => {
    const f = await fixture()
    try {
      const v = verificationFixture()
      const input = { commandId: randomUUID(), expectedRevision: null, name: 'Unit verification',
        spec: { rootId: f.input.spec.rootId, bindingRevision: 1, resources: v.resources,
          policy: jobPolicyRequirementsRecord(v.spec.policy), suites: ['unit'],
          approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS } } }
      const client = await f.connect()
      const created = await client.callTool({ name: 'job_runtime_profile_save', arguments: { workspaceId: f.workspaceId, ...input } })
      expect(created.isError, JSON.stringify(created.content)).not.toBe(true)
      const first = verificationSaveResult.parse(decodeMcpToolResult(created)).profile
      const edit = { ...input, commandId: randomUUID(), id: first.id, expectedRevision: first.revision,
        name: 'Install and unit verification', spec: { ...input.spec, suites: ['install', 'unit'] } }
      const updated = await client.callTool({ name: 'job_runtime_profile_save', arguments: { workspaceId: f.workspaceId, ...edit } })
      expect(updated.isError, JSON.stringify(updated.content)).not.toBe(true)
      const second = verificationSaveResult.parse(decodeMcpToolResult(updated)).profile
      expect(second.revision).toBe(2)
      expect(second.spec.suites).toEqual(['install', 'unit'])
      expect(second.createdAt).toBe(first.createdAt)
      const conflict = await f.app.inject({ method: 'POST', url: `${f.base}/runtime-profiles`, headers: f.auth,
        payload: { ...edit, commandId: randomUUID() } })
      expect(conflict.statusCode, conflict.body).toBe(409)
      expect(conflict.json().error.code).toBe('REVISION_CONFLICT')
      const invalid = await client.callTool({ name: 'job_runtime_profile_save', arguments: {
        workspaceId: f.workspaceId, ...edit, commandId: randomUUID(), expectedRevision: 2,
        spec: { ...edit.spec, approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS,
          review: { reviewedByPrincipalId: f.owner.principal.id, reviewedAt: new Date().toISOString(), decisionDigest: 'a'.repeat(64) } } },
      } })
      expect(invalid.isError).toBe(true)
      expect((await f.db.pool.query('select record from job_runtime_profiles where id=$1', [first.id])).rows[0].record).toEqual(second)
      const history = (await f.db.pool.query('select record from job_runtime_profile_versions where profile_id=$1 order by revision',
        [first.id])).rows.map(row => row.record)
      expect(history).toEqual([first, second])
      expect(f.producer.run).not.toHaveBeenCalled()
    } finally { await f.close() }
  }, 120_000)

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
      const commandId = randomUUID(), client = await f.connect()
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
      expect(decodeMcpToolResult((await client.callTool({ name: 'job_runtime_qualification_get', arguments: { workspaceId: f.workspaceId, approvalId: f.approval.id } })))).toEqual(read.json())
      const stored = (await f.db.pool.query('select run_command_id,run_principal_id,run_result from job_runtime_qualification_approvals where id=$1', [f.approval.id])).rows[0]
      expect(stored).toEqual({ run_command_id: commandId, run_principal_id: f.owner.principal.id,
        run_result: { outcome: 'denied', closure: 'unconfirmed', reasons: ['JOB_RUNTIME_QUALIFICATION_FAILED'] } })
      const retry = await client.callTool({ name: 'job_runtime_qualification_run', arguments: { workspaceId: f.workspaceId, approvalId: f.approval.id, commandId } })
      expect(retry.isError, JSON.stringify(retry.content)).not.toBe(true)
      expect(decodeMcpToolResult(retry)).toMatchObject({ profile: { status: 'recovery-required', measurement: null } })
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
      expect(JobRuntimeProfileListSchema.parse(decodeMcpToolResult(read))).toEqual(expected)
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
