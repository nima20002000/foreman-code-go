import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { JobVerificationProfileInputSchema, JobVerificationProfileSchema,
  JobRuntimeQualificationReadRecordSchema } from '@foreman-code/contracts/job-verification-runtime'
import { ApprovedSourceSchema } from '@foreman-code/contracts/source-admission'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { BrowserAuthentication } from '../src/modules/browser-auth/service.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { createJobRuntimeProfileService } from '../src/modules/jobs/runtimeProfileFactory.js'
import { createInstalledJobRuntimeHost, readProtectedRuntimeConfiguration } from '../src/modules/jobs/installedRuntimeHost.js'
import { InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES } from '../src/modules/jobs/installedVerificationRuntime.js'
import { reserveInstalledJobQualification } from '../src/modules/jobs/installedRuntimeQualification.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { createProductionSources } from '../src/modules/sources/production.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { registerJobRuntimeProfileRoutes } from '../src/routes/jobRuntimeProfiles.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

/** Requires an installed image, offline seed, real enforced quota pool and reviewed source/profile inputs. */
describe('installed ordinary verification qualification through authenticated MCP', () => {
  it('requests, human approves, runs every ordinary suite, and restores persisted readiness after host restart', async () => {
    const configurationPath = process.env.FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION
    const profilePath = process.env.FOREMAN_CODE_VERIFICATION_QUALIFICATION_PROFILE
    if (!configurationPath || !profilePath) {
      throw new Error('Provide protected FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION and PROFILE inputs.')
    }
    const ownerUid = process.getuid!()
    const installed = await readProtectedRuntimeConfiguration({ path: configurationPath, ownerUid },
      InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES)
    const spec = await readProtectedRuntimeConfiguration({ path: profilePath, ownerUid }, JobVerificationProfileInputSchema)
    expect(spec.suites).toEqual(['install', 'typecheck', 'lint', 'unit', 'build'])
    expect(installed.descriptor.target.hostRef.kind).toBe('main')
    const db = await currentDatabase()
    const clients: Client[] = []
    let app: ReturnType<typeof buildApp> | undefined
    let journal: RemoteOperationJournal | undefined
    try {
      const workspaceId = installed.root.binding.workspaceId
      const mainId = installed.descriptor.target.mainInstallationId
      const access = new PostgresAccessService(db.pool)
      const owner = await access.issue({ name: 'Physical verification owner', audience: 'operator',
        grants: [{ actions: ['job_definitions:read', 'job_definitions:write', 'sources:read', 'source_roots:read'],
          scope: { workspaceIds: [workspaceId] } }], expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
      const reader = await access.issue({ name: 'Physical verification reader', audience: 'operator',
        grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [workspaceId] } }],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
      const root = { ...installed.root, ownerPrincipalId: owner.principal.id, authorizedByPrincipalId: owner.principal.id }
      const configuration = { ...installed, root }
      const location = { path: join(db.directory, 'job-runtime.json'), ownerUid }
      await writeFile(location.path, JSON.stringify(configuration), { mode: 0o600 })
      await db.pool.query('update application_installation set id=$1 where singleton=true', [mainId])
      await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
        [workspaceId, JSON.stringify({ id: workspaceId, name: 'Physical verification' })])
      const manifest = configuration.qualificationSource.manifest
      await db.pool.query(`insert into source_approvals(approved_source_id,snapshot_id,workspace_id,
        owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
        values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`, [manifest.approvedSourceId, manifest.snapshotId,
        workspaceId, owner.principal.id, randomUUID(), manifest.manifestDigest])
      const source = ApprovedSourceSchema.parse({ version: 1, workspaceId, ownerPrincipalId: owner.principal.id,
        approvedByPrincipalId: owner.principal.id, mainId, locationRevision: root.binding.locationRevision,
        originIdentityHash: `sha256:${manifest.manifestDigest}`, manifest,
        approvedAt: new Date().toISOString(), availability: 'retained' })
      await db.pool.query('insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record) values($1,$2,$3,$4,$5::jsonb)',
        [manifest.snapshotId, manifest.approvedSourceId, workspaceId, manifest.manifestDigest, JSON.stringify(source)])
      await db.pool.query('insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision) values($1,$2,$3,$4)',
        [root.binding.rootId, workspaceId, manifest.manifestDigest, root.binding.bindingRevision])
      await db.pool.query('insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record) values($1,$2,$3,$4,$5::jsonb)',
        [root.binding.rootId, root.binding.bindingRevision, workspaceId, manifest.snapshotId, JSON.stringify(root)])
      await db.pool.query(`insert into workspace_root_policies(root_policy_id,root_policy_revision,
        workspace_id,host_scope,location_revision,record) values($1,$2,$3,$4,$5,$6::jsonb)`,
      [root.selection.rootPolicyId, root.selection.rootPolicyRevision, workspaceId, `main:${mainId}`,
        root.selection.locationRevision, JSON.stringify(root)])
      const commands = new PostgresCommandCoordinator(db.pool)
      const unavailableCarrier = (): never => { throw new Error('Main-local qualification must not contact a device.') }
      const sources = await createProductionSources({ pool: db.pool, commands,
        locations: new WorkspaceLocationService(db.pool, commands), mainId, runtimeRoot: db.directory,
        endpoint: unavailableCarrier, dispatch: unavailableCarrier })
      journal = await RemoteOperationJournal.open(join(db.directory, 'qualification.json'), { initializeNewInstallation: true })
      const registry = new NativeProcessRegistry(join(db.directory, 'native-processes'))
      const host = () => createInstalledJobRuntimeHost({ identity: db.pool, configuration: location,
        reserve: original => reserveInstalledJobQualification({ candidate: original.candidate,
          admission: original.nativeAdmission, host: { hostRef: original.nativeAdmission.hostRef,
            registration: original.nativeAdmission.registration, mainInstallationId: original.nativeAdmission.mainInstallationId,
            bootId: original.nativeAdmission.bootId, connection: original.nativeAdmission.connection }, journal: journal!, registry,
          signal: original.signal, assertAdmission: async supplied => {
            expect(supplied).toEqual(original.nativeAdmission)
            await original.assertAdmission()
          }, authority: {
            assertCurrent: async candidate => { expect(candidate).toEqual(original.candidate); await original.assertAdmission() },
            readApproval: async id => {
              if (id !== original.approval.id) return null
              await original.assertAdmission()
              return { status: 'approved', fingerprint: original.approval.fingerprintDigest, expiresAt: original.approval.expiresAt }
            },
            reserve: async () => { throw new Error('Installed original native reservation required.') },
          } }) })
      const installedHost = host()
      const profiles = createJobRuntimeProfileService({ pool: db.pool, commands, sources: sources.sources, host: installedHost })
      const origin = 'http://127.0.0.1:5173'
      app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        browserAuth: new BrowserAuthentication(db.pool, access, { origin,
          secret: 'physical-qualification-browser-secret'.repeat(3), ownerPrincipalId: owner.principal.id }),
        operator: { access, services: { commands, jobRuntimeProfiles: profiles } as OperatorServices } })
      registerJobRuntimeProfileRoutes(app, profiles)
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'physical verification', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { authProvider: { token: async () => token } }))
        return client
      }
      const operator = await connect(owner.token)
      const readonly = await connect(reader.token)
      const saved = await operator.callTool({ name: 'job_runtime_profile_save', arguments: {
        workspaceId, commandId: randomUUID(), expectedRevision: null, name: 'Complete ordinary verification', spec } })
      expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true)
      const profile = JobVerificationProfileSchema.parse((saved.structuredContent as { profile: unknown }).profile)
      const request = { workspaceId, commandId: randomUUID(), profileId: profile.id, expectedRevision: profile.revision }
      expect((await readonly.callTool({ name: 'job_runtime_qualification_request', arguments: request })).isError).toBe(true)
      const pending = await operator.callTool({ name: 'job_runtime_qualification_request', arguments: request })
      expect(pending.isError, JSON.stringify(pending.content)).not.toBe(true)
      const approvalId = (pending.structuredContent as { approval: { id: string } }).approval.id
      const browserHeaders = { host: '127.0.0.1:3000', origin }
      const account = { email: 'physical-owner@example.test', password: 'physical-owner-test-password' }
      expect((await app.inject({ method: 'POST', url: '/api/auth/setup', headers: browserHeaders, payload: account })).statusCode).toBe(201)
      const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: browserHeaders, payload: account })
      const cookies = login.headers['set-cookie']
      const cookie = (Array.isArray(cookies) ? cookies : [cookies!]).map(value => value.split(';')[0]).join('; ')
      const approval = await app.inject({ method: 'POST',
        url: `/api/management/workspaces/${workspaceId}/jobs/runtime-qualifications/${approvalId}/approve`,
        headers: { ...browserHeaders, cookie }, payload: { commandId: randomUUID() } })
      expect(approval.statusCode, approval.body).toBe(200)
      const run = { workspaceId, approvalId, commandId: randomUUID() }
      expect((await readonly.callTool({ name: 'job_runtime_qualification_run', arguments: run })).isError).toBe(true)
      const qualified = await operator.callTool({ name: 'job_runtime_qualification_run', arguments: run },
        { timeout: 24 * 60 * 60 * 1000 })
      expect(qualified.isError, JSON.stringify(qualified.content)).not.toBe(true)
      const read = await operator.callTool({ name: 'job_runtime_qualification_get', arguments: { workspaceId, approvalId } })
      const completed = JobRuntimeQualificationReadRecordSchema.parse(read.structuredContent)
      expect(completed.profile.status).toBe('qualified')
      expect(completed.measurement?.schemaVersion).toBe(2)
      expect(completed.readiness.ready).toBe(true)
      expect((await db.pool.query('select record from job_runtime_profiles where id=$1', [profile.id])).rows[0].record)
        .toEqual(completed.profile)
      const restarted = host()
      expect(await restarted.currentMetadata(db.pool, completed.profile)).toBeNull()
      await restarted.capture!(completed.profile)
      const restartedProfiles = createJobRuntimeProfileService({ pool: db.pool, commands,
        sources: sources.sources, host: restarted })
      expect(await restartedProfiles.readiness(db.pool, completed.profile)).toEqual({ ready: true, reasons: [] })
      expect((await journal.qualificationStatus(completed.approval.qualificationId))?.phase).toBe('closed')
      expect((await journal.qualificationStatus(completed.approval.qualificationId))?.result?.outcome).toBe('qualified')
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      await app?.close()
      await journal?.close()
      await db.close()
    }
  }, 24 * 60 * 60 * 1000)
})
