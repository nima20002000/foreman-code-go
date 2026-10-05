import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
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
import { createProductionJobs } from '../src/modules/jobs/production.js'
import { createJobRuntimeProfileService } from '../src/modules/jobs/runtimeProfileFactory.js'
import { createInstalledJobRuntimeHost, readProtectedRuntimeConfiguration } from '../src/modules/jobs/installedRuntimeHost.js'
import { InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES } from '../src/modules/jobs/installedVerificationRuntime.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { ApprovedRootAllowlistSchema, WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { JobBuildQueueConfigurationSchema, JobAdmissionResultSchema } from '@foreman-code/contracts/job-admission'
import { JobAuthoringChoicesRecordSchema, JobExecutionRecordSchema, ResolvedVerificationJobSpecSchema } from '@foreman-code/contracts/job-verification'
import { jobRuntimeProfilePolicy } from '@foreman-code/contracts/job-verification-runtime'
import { buildComputerTarget } from '../src/modules/settings/buildComputers.js'
import { openPrivateRoot, identity } from '../src/modules/sources/privateFilesystem.js'
import { sourceSha256 } from '../src/modules/sources/manifest.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { registerJobRuntimeProfileRoutes } from '../src/routes/jobRuntimeProfiles.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

/** Requires an installed image, offline seed, real enforced quota pool and reviewed source/profile inputs. */
describe('installed ordinary verification qualification through authenticated MCP', () => {
  it('requests, human approves, runs every ordinary suite, and restores persisted readiness after host restart', async () => {
    const configurationPath = process.env.FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION
    const profilePath = process.env.FOREMAN_CODE_VERIFICATION_QUALIFICATION_PROFILE
    const queuePath = process.env.FOREMAN_CODE_VERIFICATION_QUALIFICATION_QUEUE
    if (!configurationPath || !profilePath || !queuePath) {
      throw new Error('Provide protected FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION, PROFILE and QUEUE inputs.')
    }
    const ownerUid = process.getuid!()
    const installed = await readProtectedRuntimeConfiguration({ path: configurationPath, ownerUid },
      InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES)
    const spec = await readProtectedRuntimeConfiguration({ path: profilePath, ownerUid }, JobVerificationProfileInputSchema)
    const queue = await readProtectedRuntimeConfiguration({ path: queuePath, ownerUid }, JobBuildQueueConfigurationSchema)
    expect(spec.suites).toEqual(['install', 'typecheck', 'lint', 'unit', 'build'])
    expect(installed.descriptor.target.hostRef.kind).toBe('main')
    const db = await currentDatabase()
    const clients: Client[] = []
    let app: ReturnType<typeof buildApp> | undefined
    let journal: RemoteOperationJournal | undefined
    let runtime: Awaited<ReturnType<typeof createProductionJobs>> | undefined
    try {
      const workspaceId = installed.root.binding.workspaceId
      const mainId = installed.descriptor.target.mainInstallationId
      const access = new PostgresAccessService(db.pool)
      const owner = await access.issue({ name: 'Physical verification owner', audience: 'operator',
        grants: [{ actions: ['job_definitions:read', 'job_definitions:write', 'sources:read', 'source_roots:read', 'jobs:start', 'jobs:read', 'job_artifacts:read'],
          scope: { workspaceIds: [workspaceId] } },
          { actions: ['settings:read', 'settings:update', 'workspace_locations:read'], scope: {} }], expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
      const reader = await access.issue({ name: 'Physical verification reader', audience: 'operator',
        grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [workspaceId] } }],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) })
      const root = { ...installed.root, ownerPrincipalId: owner.principal.id, authorizedByPrincipalId: owner.principal.id }
      const configuration = { ...installed, root }
      const location = { path: join(db.directory, 'job-runtime.json'), ownerUid }
      await writeFile(location.path, JSON.stringify(configuration), { mode: 0o600 })
      await writeFile(join(db.directory, 'job-queue.json'), JSON.stringify(queue), { mode: 0o600 })
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
      const commands = new PostgresCommandCoordinator(db.pool)
      const registry = new NativeProcessRegistry(join(db.directory, 'native-processes'))
      runtime = await createProductionJobs({ pool: db.pool, commands,
        locations: new WorkspaceLocationService(db.pool, commands), mainId,
        runtimeRoot: db.directory, storageRoot: join(db.directory, 'files'), nativeRegistry: registry,
        endpoint: () => { throw new Error('Main-local qualification and Jobs cannot contact a device.') } })
      const runtimeDirectory = await openPrivateRoot(configuration.descriptor.runtimeRoot)
      let runtimeFilesystem
      try { runtimeFilesystem = await identity(runtimeDirectory) } finally { await runtimeDirectory.close() }
      const roots = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef: root.selection.hostRef,
        applicationInstallationId: mainId, configurationRevision: '1',
        bases: [{ baseId: root.binding.rootId, canonicalPath: root.binding.canonicalPath,
          filesystem: root.binding.filesystem, accessModes: ['read-write'] }],
        managedRuntimeRoot: configuration.descriptor.runtimeRoot, runtimeFilesystem })
      await writeFile(join(db.directory, 'approved-roots.json'), JSON.stringify(roots), { mode: 0o600 })
      await runtime.policies.publishApprovedHostConfiguration(db.pool, roots, { mainId,
        hostRef: roots.hostRef, applicationInstallationId: mainId, configurationRevision: '1',
        configurationDigest: sourceSha256(Buffer.from(JSON.stringify(roots))) })
      const policy = WorkspaceRootPolicySchema.parse({ schemaVersion: 1, rootPolicyId: root.selection.rootPolicyId,
        rootPolicyRevision: root.selection.rootPolicyRevision, workspaceId, hostRef: root.selection.hostRef,
        applicationInstallationId: mainId, registration: null, locationRevision: root.selection.locationRevision,
        ownerPrincipalId: owner.principal.id, allowedBaseId: root.binding.rootId, configurationRevision: '1',
        relativePath: '', accessMode: 'read-write', canonicalProjectRoot: root.binding.canonicalPath,
        filesystem: root.binding.filesystem, directoryIdentityHash: sourceSha256(Buffer.from(JSON.stringify(root.binding.filesystem))),
        managedRuntimeRoot: roots.managedRuntimeRoot, runtimeFilesystem, attestationId: root.attestationId,
        attestationDigest: root.attestationDigest })
      await db.pool.query(`insert into workspace_root_policies(root_policy_id,root_policy_revision,
        workspace_id,host_scope,location_revision,record) values($1,$2,$3,$4,$5,$6::jsonb)`,
      [policy.rootPolicyId, policy.rootPolicyRevision, workspaceId, `main:${mainId}`,
        policy.locationRevision, JSON.stringify(policy)])
      for (const entry of manifest.entries) {
        await runtime.snapshots.write(manifest.snapshotId, entry,
          await readFile(join(configuration.qualificationSource.directory, entry.path)))
      }
      await runtime.snapshots.commit(manifest)
      const profiles = runtime.profiles
      const origin = 'http://127.0.0.1:5173'
      app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        browserAuth: new BrowserAuthentication(db.pool, access, { origin,
          secret: 'physical-qualification-browser-secret'.repeat(3), ownerPrincipalId: owner.principal.id }),
        operator: { access, services: { commands, jobRuntimeProfiles: profiles, jobs: runtime.jobs } as OperatorServices } })
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
      const settings = await runtime.buildComputers.update(owner.principal, 'mcp', {
        target: buildComputerTarget({ hostRef: root.selection.hostRef, registration: null, mainInstallationId: mainId }),
        commandId: randomUUID(), expectedRevision: 0, buildEnabled: true, buildPriority: 100 })
      expect(settings.state).toBe('ready')
      const choices = JobAuthoringChoicesRecordSchema.parse(await runtime.jobs.choices(owner.principal, workspaceId, 'mcp'))
      const template = choices.verificationTemplates!.find(item => item.profileId === profile.id && item.suite === 'install')!
      expect(template.ready).toBe(true)
      const definition = await runtime.jobs.saveDefinition(owner.principal, 'mcp', workspaceId, {
        commandId: randomUUID(), expectedRevision: null, name: 'Main offline install', spec: ResolvedVerificationJobSpecSchema.parse({
          source: choices.sources[0]!, target: choices.targets[0]!.target, argv: template.argv,
          inputs: [], outputs: template.outputs!, policy: jobRuntimeProfilePolicy(completed.profile),
          verification: { suite: template.suite, resources: template.resources,
            parameters: template.parameters, credentialRefs: [] },
        }),
      })
      expect((await readonly.callTool({ name: 'job_start', arguments: {
        workspaceId, commandId: randomUUID(), definitionId: definition.id, expectedRevision: definition.revision } })).isError).toBe(true)
      const started = await operator.callTool({ name: 'job_start', arguments: {
        workspaceId, commandId: randomUUID(), definitionId: definition.id, expectedRevision: definition.revision } },
      { timeout: template.policy.preparationTimeoutMs + 60000 })
      expect(started.isError, JSON.stringify(started.content)).not.toBe(true)
      const admission = JobAdmissionResultSchema.parse((started.structuredContent as { admission: unknown }).admission)
      let executionId: string
      if (admission.kind === 'pending-admission') executionId = admission.ticket.executionId
      else if (admission.kind === 'accepted') executionId = admission.executionId
      else executionId = admission.execution.id
      const deadline = Date.now() + template.policy.preparationTimeoutMs + template.policy.executionTimeoutMs
        + template.policy.publicationTimeoutMs + template.policy.cleanupTimeoutMs
      let execution
      while (Date.now() < deadline) {
        await runtime.jobs.wakeQueue()
        const row = (await db.pool.query('select record from job_executions where id=$1', [executionId])).rows[0]
        if (row) {
          execution = JobExecutionRecordSchema.parse(row.record)
          await runtime.dispatch.wake(execution.id)
          execution = JobExecutionRecordSchema.parse((await db.pool.query('select record from job_executions where id=$1',
            [execution.id])).rows[0].record)
          if (execution.process.phase === 'terminal' && !['pending', 'collecting'].includes(execution.publication)) break
        }
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      expect(execution).toMatchObject({ schemaVersion: 2, process: { phase: 'terminal', outcome: 'succeeded', processStopped: true },
        publication: 'complete', acceptedSpec: { target: { hostRef: { kind: 'main' } } } })
      const executionReadback = await operator.callTool({ name: 'job_get', arguments: { workspaceId, executionId: execution!.id } })
      expect(executionReadback.isError, JSON.stringify(executionReadback.content)).not.toBe(true)
      expect((executionReadback.structuredContent as { execution: unknown }).execution).toEqual(execution)
      expect((await runtime.jobs.listArtifacts(owner.principal, workspaceId, execution!.id, 'mcp')).map(output => output.path).sort())
        .toEqual(template.outputs!.map(output => output.path).sort())
      expect((await readonly.callTool({ name: 'job_runtime_qualification_run', arguments: run })).isError).toBe(true)
      const replay = await operator.callTool({ name: 'job_runtime_qualification_run', arguments: run })
      expect(replay.isError).not.toBe(true)
      expect((replay.structuredContent as { profile: unknown }).profile).toEqual(completed.profile)
      const restarted = createInstalledJobRuntimeHost({ identity: db.pool, configuration: location,
        reserve: async () => { throw new Error('Metadata restart cannot reserve native work.') } })
      expect(await restarted.currentMetadata(db.pool, completed.profile)).toBeNull()
      await restarted.capture!(completed.profile)
      const restartedProfiles = createJobRuntimeProfileService({ pool: db.pool, commands,
        sources: runtime.sources, host: restarted })
      expect(await restartedProfiles.readiness(db.pool, completed.profile)).toEqual({ ready: true, reasons: [] })
      await runtime.close()
      runtime = undefined
      journal = await RemoteOperationJournal.open(join(db.directory, 'job-runtime-operations.json'))
      expect(await journal.pendingQualifications()).toEqual([])
      expect((await journal.qualificationStatus(completed.approval.qualificationId))?.phase).toBe('closed')
      expect((await journal.qualificationStatus(completed.approval.qualificationId))?.result?.outcome).toBe('qualified')
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      await app?.close()
      await runtime?.close()
      await journal?.close()
      await db.close()
    }
  }, 24 * 60 * 60 * 1000)
})
