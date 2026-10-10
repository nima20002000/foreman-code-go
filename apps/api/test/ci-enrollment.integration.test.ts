import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { BuildComputerPrepareStatusSchema, CiEnrollmentStateSchema, type BuildComputerPrepareInput,
  type BuildComputerPrepareStatus } from '@foreman-code/contracts'
import { ApprovedSourceSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { JobDefinitionSpecRecordSchema, ResolvedVerificationJobSpecSchema, jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { JobVerificationProfileSchema, jobRuntimeProfilePolicy } from '@foreman-code/contracts/job-verification-runtime'
import { OperatorCapabilitiesSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { CI_ENROLLMENT_ACTIONS, CiEnrollment } from '../src/modules/jobs/ciEnrollment.js'
import type { CiEnrollmentInventory, CiEnrollmentTarget } from '../src/modules/jobs/ciEnrollmentInventory.js'
import { ciEnrollmentProfileInput } from '../src/modules/jobs/ciEnrollmentProfiles.js'
import { CiEnrollmentRepository } from '../src/modules/jobs/ciEnrollmentRepository.js'
import { JobRuntimeProfiles } from '../src/modules/jobs/runtimeProfiles.js'
import { JobComputerSelection, type JobComputerCandidate } from '../src/modules/jobs/computerSelection.js'
import { JobService } from '../src/modules/jobs/service.js'
import { DomainError } from '../src/modules/errors.js'
import { BuildComputerSettings, buildComputerKey } from '../src/modules/settings/buildComputers.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { createSourceManifest } from '../src/modules/sources/manifest.js'
import { createProductionSources } from '../src/modules/sources/production.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { buildComputerFixture, buildQueueFixture } from './helpers/buildComputerFixture.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { verificationCapacityFixture } from './helpers/verificationCapacityFixture.js'
import { verificationFixture } from './helpers/jobVerificationFixture.js'

// Persistence, authorization and MCP are real; source hosts and runtime preparation are bounded fixtures.
async function fixture() {
  const db = await currentDatabase()
  const clients: Client[] = []
  let closeEnrollment: (() => Promise<void>) | undefined
  let closeApp: (() => Promise<void>) | undefined
  async function close() {
    await closeEnrollment?.()
    await Promise.allSettled(clients.map(client => client.close()))
    await closeApp?.()
    await db.close()
  }
  try {
    const access = new PostgresAccessService(db.pool)
    const commands = new PostgresCommandCoordinator(db.pool)
    const workspaceId = randomUUID()
    const mainId = (await db.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const owner = await access.issue({ name: 'CI enrollment owner', audience: 'operator',
      grants: [{ actions: [...CI_ENROLLMENT_ACTIONS, 'jobs:read', 'jobs:cancel',
        'settings:read', 'settings:update', 'capabilities:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 3_600_000) })
    await db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'CI enrollment' })])
    const template = verificationCapacityFixture('device')
    const manifest = createSourceManifest({ version: 1, approvedSourceId: randomUUID(), snapshotId: randomUUID(),
      capturePolicy: 'git-tree-v1', executablePolicy: 'strip', entries: [], deletions: [],
      git: { commit: template.sourceCommit!, tree: '3'.repeat(40), objectFormat: 'sha1' } })
    const source = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
      manifestDigest: manifest.manifestDigest }
    const approved = ApprovedSourceSchema.parse({ version: 1, workspaceId, mainId, locationRevision: 1,
      ownerPrincipalId: owner.principal.id, approvedByPrincipalId: owner.principal.id,
      originIdentityHash: `sha256:${manifest.manifestDigest}`, manifest,
      approvedAt: new Date().toISOString(), availability: 'retained' })
    await db.pool.query(`insert into source_approvals
      (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
      values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
    [source.approvedSourceId, source.snapshotId, workspaceId, owner.principal.id, randomUUID(), source.manifestDigest])
    await db.pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
      values($1,$2,$3,$4,$5::jsonb)`,
    [source.snapshotId, source.approvedSourceId, workspaceId, source.manifestDigest, JSON.stringify(approved)])

    const workers = [buildComputerFixture(mainId, workspaceId), buildComputerFixture(mainId, workspaceId)]
    const computers: CiEnrollmentTarget[] = workers.map(worker => ({
      target: worker.target, buildEnabled: true, connected: true,
    }))
    computers.push({ target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
      keyRevision: null, authorizationRevision: null }, buildEnabled: true, connected: true })
    const roots: SourceRootRecord[] = workers.map(worker => worker.candidate.profile.root)
    const mainRoot = structuredClone(roots[0]!)
    mainRoot.selection.hostRef = { kind: 'main', mainId }
    mainRoot.selection.rootPolicyId = randomUUID()
    mainRoot.binding = { ...mainRoot.binding, rootId: randomUUID(), deviceId: null, workerInstallationId: null }
    mainRoot.registration = null
    roots.push(mainRoot)
    for (const worker of workers) {
      await db.pool.query(`insert into device_registrations
        (id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,'fixture',$4::jsonb)`,
      [worker.registration.deviceId, mainId, worker.registration.workerInstallationId, JSON.stringify(worker.registration)])
    }
    for (const root of roots) {
      root.source = source
      root.ownerPrincipalId = owner.principal.id
      root.authorizedByPrincipalId = owner.principal.id
      root.binding.snapshotId = source.snapshotId
      root.binding.manifestDigest = source.manifestDigest
      await db.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
        values($1,$2,$3,1)`, [root.binding.rootId, workspaceId, randomUUID()])
      await db.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
        values($1,1,$2,$3,$4::jsonb)`, [root.binding.rootId, workspaceId, source.snapshotId, JSON.stringify(root)])
    }
    const noCarrier = (): never => { throw new Error('Enrollment fixture has no physical source carrier') }
    const sourceRuntime = await createProductionSources({ pool: db.pool, commands,
      locations: new WorkspaceLocationService(db.pool, commands), mainId, runtimeRoot: db.directory,
      endpoint: noCarrier, dispatch: noCarrier })
    vi.spyOn(sourceRuntime.sources, 'resolveRootBinding').mockImplementation(async (_sql, _principal, input) => {
      const root = roots.find(row => row.binding.rootId === input.rootId)
      if (!root) throw new Error('Fixture root is missing')
      return root
    })
    const producer = {
      capture: async (): Promise<never> => { throw new Error('No physical qualification in enrollment fixture') },
      run: async (): Promise<never> => { throw new Error('No physical qualification in enrollment fixture') },
      revalidate: async () => ({ ready: false, reasons: ['runtime_setup_required'] }),
    }
    const profiles = new JobRuntimeProfiles(db.pool, commands, sourceRuntime.sources, producer)
    const stored = await profiles.save(owner.principal, 'mcp', workspaceId,
      ciEnrollmentProfileInput(template, roots[0]!, { diskBytes: template.spec.resources.limits.diskBytes,
        mutableInodes: template.spec.resources.mutableInodes }, randomUUID()))
    const preparations = new Map<string, BuildComputerPrepareStatus>()
    const preparation = {
      get: vi.fn(async (_principal: ManagementPrincipal, input: { workspaceId: string; profileId: string }) =>
        preparations.get(input.profileId) ?? BuildComputerPrepareStatusSchema.parse({ profileId: input.profileId,
          deviceId: null, state: 'idle', commit: null, stage: null, message: null, profiles: [],
          startedAt: null, updatedAt: null })),
      start: vi.fn(async (_principal: ManagementPrincipal, _source: 'http' | 'mcp', input: BuildComputerPrepareInput) => {
        const state = BuildComputerPrepareStatusSchema.parse({ profileId: input.profileId, deviceId: null,
          state: 'preparing', commit: input.commit, stage: 'fetch-source', message: null, profiles: [],
          startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        preparations.set(input.profileId, state)
        return state
      }),
    } satisfies ConstructorParameters<typeof CiEnrollment>[3]
    const resources = template.spec.resources
    const inventory: CiEnrollmentInventory = {
      computers: async () => computers,
      storage: vi.fn(async (target: DeviceProvisioningTarget) => ({
        diskBytes: target.hostRef.kind === 'main' ? resources.limits.diskBytes
        : resources.limits.diskBytes * 2, mutableInodes: resources.mutableInodes * 2 })),
      root: vi.fn(async (_principal: ManagementPrincipal, _workspaceId: string, _template: SourceRootRecord,
        target: DeviceProvisioningTarget) => {
        const root = roots.find(row => buildComputerKey({ hostRef: row.selection.hostRef }) === buildComputerKey(target))
        if (!root) throw new DomainError('CI_ENROLLMENT_ROOT_REQUIRED', 'Approved writable root required.', 409)
        return root
      }),
    }
    const enrollment = new CiEnrollment(db.pool, commands, profiles, preparation, inventory)
    closeEnrollment = () => enrollment.close()
    const settings = new BuildComputerSettings(db.pool, commands,
      async () => ({ state: 'ready', reasons: [], remoteExecutionEnabled: true }))
    for (const computer of computers) {
      await settings.update(owner.principal, 'mcp', { target: computer.target, commandId: randomUUID(),
        expectedRevision: 0, buildEnabled: true, buildPriority: 50 })
    }
    const services = { commands, jobRuntimeProfiles: profiles, ciEnrollment: enrollment } as OperatorServices
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services } })
    closeApp = () => app.close()
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token = owner.token) {
      const client = new Client({ name: 'CI enrollment parity', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    return { db, access, commands, workspaceId, owner, computers, roots, inventory, profiles, stored,
      enrollment, preparations, preparation, settings, connect, close }
  } catch (error) {
    await close()
    throw error
  }
}

describe.skipIf(!postgresEnabled)('automatic CI enrollment', () => {
  it.each(['empty', 'revoked'] as const)(
    'reports missing %s workspace templates through authenticated MCP and persists the setup requirement',
    async configuration => {
      const f = await fixture()
      try {
        let workspaceId = f.workspaceId
        if (configuration === 'empty') {
          workspaceId = randomUUID()
          await f.db.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
            [workspaceId, JSON.stringify({ id: workspaceId, name: 'Unconfigured CI' })])
        } else {
          await f.db.pool.query(`update job_runtime_profiles
            set record=jsonb_set(record,'{status}','"revoked"') where workspace_id=$1`, [workspaceId])
        }
        const client = await f.connect()
        const read = async (reader: Client) => {
          const result = await reader.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId } })
          expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
          return CiEnrollmentStateSchema.parse(decodeMcpToolResult(result))
        }
        const initial = await read(client)
        expect(initial.computers).toHaveLength(f.computers.length)
        for (const computer of initial.computers) {
          expect(computer).toMatchObject({ state: 'templates-required', enabled: true,
            revision: 0, profileIds: [], templates: [], updatedAt: null })
          expect(computer.message).toContain('job_runtime_profile_save')
        }
        expect((await f.db.pool.query('select state from ci_enrollment_computers where workspace_id=$1',
          [workspaceId])).rows).toEqual([])

        const reader = await f.access.issue({ name: 'Unconfigured CI reader', audience: 'operator',
          grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [workspaceId] } }],
          expiresAt: new Date(Date.now() + 600_000) })
        const readonly = await f.connect(reader.token)
        expect(await read(readonly)).toEqual(initial)
        const input = { workspaceId, target: f.computers[0]!.target,
          commandId: randomUUID(), expectedRevision: 0, enabled: true }
        const denied = await readonly.callTool({ name: 'ci_enrollment_update', arguments: input })
        expect(denied.isError).toBe(true)
        expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
        expect(await read(readonly)).toEqual(initial)

        const updated = await client.callTool({ name: 'ci_enrollment_update', arguments: input })
        expect(updated.isError, JSON.stringify(updated.content)).not.toBe(true)
        await vi.waitFor(async () => {
          const rows = (await f.db.pool.query<{ state: { state: string } }>(
            'select state from ci_enrollment_computers where workspace_id=$1', [workspaceId])).rows
          expect(rows).toHaveLength(f.computers.length)
          expect(rows.every(row => row.state.state === 'templates-required')).toBe(true)
        }, { timeout: 5000 })
        await f.enrollment.close()
        const readback = await read(readonly)
        expect(readback.computers[0]).toMatchObject({ state: 'templates-required', enabled: true,
          revision: 1, profileIds: [], templates: [] })
        const persisted = (await f.db.pool.query<{ state: unknown }>(
          'select state from ci_enrollment_computers where workspace_id=$1', [workspaceId])).rows
        expect(persisted.map(row => row.state)).toEqual(expect.arrayContaining(readback.computers))
        const restarted = new CiEnrollment(f.db.pool, f.commands, f.profiles, f.preparation, f.inventory)
        try {
          expect(await restarted.read(reader.principal, { workspaceId })).toEqual(readback)
        } finally {
          await restarted.close()
        }
        expect(f.preparation.start.mock.calls.filter(([, , request]) => request.workspaceId === workspaceId))
          .toEqual([])
        expect((await f.db.pool.query(`select outcome from management_audit
          where principal_id=$1 and action='ci_enrollment_update'`, [reader.principal.id])).rows)
          .toEqual([{ outcome: 'denied' }])
      } finally {
        await f.close()
      }
    },
  )

  it.each(['disk', 'inodes'] as const)('reports insufficient %s through MCP without shrinking a clone', async field => {
    const f = await fixture()
    try {
      const storage = f.inventory.storage
      const target = f.computers[1]!.target
      if (f.stored.schemaVersion !== 2) throw new Error('Verification template required')
      const resources = f.stored.spec.resources
      f.inventory.storage = async computer => {
        if (buildComputerKey(computer) !== buildComputerKey(target)) return storage(computer)
        return { diskBytes: resources.limits.diskBytes - (field === 'disk' ? 1 : 0),
          mutableInodes: resources.mutableInodes - (field === 'inodes' ? 1 : 0) }
      }
      await f.enrollment.reconcile()
      const client = await f.connect()
      const result = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      const state = CiEnrollmentStateSchema.parse(decodeMcpToolResult(result))
      expect(state.computers[1]).toMatchObject({ target, state: 'storage-required', profileIds: [],
        templates: [{ templateId: f.stored.id, profileId: null, state: 'storage-required',
          message: 'The installed CI volume is too small for this template’s disk or inode budget.' }] })
      expect(state.computers[0]!.state).toBe('preparing')
      expect(state.computers[2]!.state).toBe('preparing')
      const profiles = (await f.profiles.list(f.owner.principal, f.workspaceId)).profiles
      expect(profiles).toHaveLength(2)
      for (const { profile } of profiles) {
        if (profile.schemaVersion !== 2) throw new Error('Verification profile required')
        expect(profile.spec.resources).toEqual(resources)
      }
      expect(f.preparation.start).toHaveBeenCalledTimes(2)
      expect((await f.db.pool.query('select state from ci_enrollment_computers where workspace_id=$1 and host_key=$2',
        [f.workspaceId, buildComputerKey(target)])).rows[0]!.state).toEqual(state.computers[1])
      await f.enrollment.reconcile()
      expect((await f.profiles.list(f.owner.principal, f.workspaceId)).profiles).toEqual(profiles)
      expect(f.preparation.start).toHaveBeenCalledTimes(2)
    } finally { await f.close() }
  })

  it.each([true, false])('reports ordinary templates without automatic qualification with verification storage=%s',
    async installed => {
      const f = await fixture()
      try {
        const template = buildComputerFixture(f.roots[0]!.binding.mainId, f.workspaceId).candidate.profile
        const ordinary = await f.profiles.save(f.owner.principal, 'mcp', f.workspaceId, {
          commandId: randomUUID(), expectedRevision: null, name: 'Ordinary CI',
          spec: { rootId: f.roots[0]!.binding.rootId, bindingRevision: 1, limits: template.limits,
            policy: { ...jobPolicyRequirementsRecord(template.policy), maxWorkerSpoolBytes: 131072 } },
        })
        if (!installed) f.inventory.storage = async () => null
        const qualification = vi.spyOn(f.profiles, 'requestQualification')
        await f.enrollment.reconcile()
        const reader = await f.access.issue({ name: 'Enrollment status reader', audience: 'operator',
          grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [f.workspaceId] } }],
          expiresAt: new Date(Date.now() + 600_000) })
        const client = await f.connect(reader.token)
        const read = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
        expect(read.isError, JSON.stringify(read.content)).not.toBe(true)
        const state = CiEnrollmentStateSchema.parse(decodeMcpToolResult(read))
        for (const computer of state.computers) {
          expect(computer.state).toBe('partial')
          expect(computer.templates).toContainEqual({ templateId: ordinary.id, profileId: null,
            state: 'not-enrolled-automatically',
            message: 'Ordinary Job templates are not enrolled automatically; configure and qualify their protected runtime explicitly.' })
          expect(computer.templates).toContainEqual(expect.objectContaining({ templateId: f.stored.id,
            state: installed ? 'preparing' : 'runtime-required' }))
        }
        expect(qualification).not.toHaveBeenCalled()
        expect(f.preparation.start).toHaveBeenCalledTimes(installed ? 3 : 0)
        expect((await f.profiles.list(f.owner.principal, f.workspaceId)).profiles).toHaveLength(installed ? 4 : 2)
        const denied = await client.callTool({ name: 'ci_enrollment_update', arguments: {
          workspaceId: f.workspaceId, target: f.computers[0]!.target, expectedRevision: 0,
          enabled: false, commandId: randomUUID(),
        } })
        expect(denied.isError).toBe(true)
        expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
        const forbiddenRead = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: randomUUID() } })
        expect(forbiddenRead.isError).toBe(true)
        expect(JSON.stringify(forbiddenRead.content)).toContain('ACCESS_DENIED')
        const readback = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
        expect(CiEnrollmentStateSchema.parse(decodeMcpToolResult(readback))).toEqual(state)
        const persisted = (await f.db.pool.query('select state from ci_enrollment_computers where workspace_id=$1',
          [f.workspaceId])).rows.map(row => row.state)
        expect(persisted).toEqual(expect.arrayContaining(state.computers))
      } finally { await f.close() }
    })

  it('prepares a fitting template despite another template exceeding installed storage', async () => {
    const f = await fixture()
    try {
      if (f.stored.schemaVersion !== 2) throw new Error('Verification template required')
      const resources = f.stored.spec.resources
      const oversized = await f.profiles.save(f.owner.principal, 'mcp', f.workspaceId, {
        commandId: randomUUID(), expectedRevision: null, name: 'Large suite',
        spec: { ...f.stored.spec, resources: { ...resources,
          limits: { ...resources.limits, diskBytes: resources.limits.diskBytes * 2 } } },
      })
      f.inventory.storage = async () => ({ diskBytes: resources.limits.diskBytes, mutableInodes: resources.mutableInodes })
      await f.enrollment.reconcile()
      const client = await f.connect()
      const read = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      expect(read.isError, JSON.stringify(read.content)).not.toBe(true)
      const state = CiEnrollmentStateSchema.parse(decodeMcpToolResult(read))
      for (const computer of state.computers) {
        expect(computer.state).toBe('partial')
        expect(computer.profileIds).toHaveLength(1)
        expect(computer.templates).toContainEqual(expect.objectContaining({ templateId: oversized.id,
          profileId: null, state: 'storage-required' }))
        expect(computer.templates).toContainEqual({ templateId: f.stored.id,
          profileId: computer.profileIds[0], state: 'preparing', message: null })
        expect(computer.message).toContain('Large suite:')
      }
      expect(f.preparation.start).toHaveBeenCalledTimes(3)
      const saved = (await f.profiles.list(f.owner.principal, f.workspaceId)).profiles
      expect(saved).toHaveLength(4)
      await f.enrollment.reconcile()
      expect((await f.profiles.list(f.owner.principal, f.workspaceId)).profiles).toEqual(saved)
      expect(f.preparation.start).toHaveBeenCalledTimes(3)
      expect((await f.db.pool.query('select state from ci_enrollment_computers where workspace_id=$1',
        [f.workspaceId])).rows.map(row => row.state.templates))
        .toEqual(expect.arrayContaining(state.computers.map(computer => computer.templates)))
    } finally { await f.close() }
  })

  it('continues preparation after one profile fails and persists the failed template through MCP', async () => {
    const f = await fixture()
    try {
      if (f.stored.schemaVersion !== 2) throw new Error('Verification template required')
      const failing = await f.profiles.save(f.owner.principal, 'mcp', f.workspaceId, {
        commandId: randomUUID(), expectedRevision: null, name: 'Failing suite', spec: f.stored.spec,
      })
      const start = f.preparation.start.getMockImplementation()!
      f.preparation.start.mockImplementation(async (...args) => {
        const profile = (await f.profiles.list(f.owner.principal, f.workspaceId)).profiles
          .find(row => row.profile.id === args[2].profileId)!.profile
        if (profile.name === failing.name) {
          throw new DomainError('CI_RUNTIME_PREPARATION_FAILED', 'Runtime preparation failed.', 409)
        }
        return start(...args)
      })
      await f.enrollment.reconcile()
      const client = await f.connect()
      const read = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      expect(read.isError, JSON.stringify(read.content)).not.toBe(true)
      const state = CiEnrollmentStateSchema.parse(decodeMcpToolResult(read))
      for (const computer of state.computers) {
        expect(computer.state).toBe('partial')
        const failure = computer.templates.find(result => result.templateId === failing.id)!
        expect(failure).toMatchObject({ state: 'failed', message: 'Runtime preparation failed.' })
        expect(failure.profileId).not.toBeNull()
        expect(computer.templates).toContainEqual(expect.objectContaining({ templateId: f.stored.id, state: 'preparing' }))
        expect(computer.message).toContain('Failing suite: Runtime preparation failed.')
      }
      expect(f.preparation.start).toHaveBeenCalledTimes(6)
      expect(f.preparations.size).toBe(3)
      expect((await f.db.pool.query('select state from ci_enrollment_computers where workspace_id=$1',
        [f.workspaceId])).rows.map(row => row.state)).toEqual(expect.arrayContaining(state.computers))
    } finally { await f.close() }
  })

  it('enrolls Workers and Main with the same template envelope despite different storage and no repeated derivation', async () => {
    const f = await fixture()
    try {
      await f.enrollment.reconcile()
      const state = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      expect(state.computers).toHaveLength(3)
      expect(state.computers.every(computer => computer.state === 'preparing')).toBe(true)
      expect(f.preparation.start).toHaveBeenCalledTimes(3)
      const saved = (await f.profiles.list(f.owner.principal, f.workspaceId)).profiles.map(row => row.profile)
      expect(saved).toHaveLength(3)
      for (const computer of state.computers) {
        expect(computer.profileIds).toHaveLength(1)
        const profile = saved.find(row => row.id === computer.profileIds[0])!
        expect(profile.schemaVersion).toBe(2)
        if (profile.schemaVersion !== 2) throw new Error('Verification profile required')
        if (f.stored.schemaVersion !== 2) throw new Error('Verification template required')
        expect(profile.spec.resources).toEqual(f.stored.spec.resources)
        expect(profile.spec.suites).toEqual(['unit'])
        const storage = await f.inventory.storage(computer.target)
        expect(profile.spec.resources.limits.diskBytes).toBeLessThanOrEqual(storage!.diskBytes)
        expect(profile.spec.resources.mutableInodes).toBeLessThanOrEqual(storage!.mutableInodes)
        expect(profile.root.selection.hostRef).toEqual(computer.target.hostRef)
      }
      await f.enrollment.reconcile()
      expect((await f.profiles.list(f.owner.principal, f.workspaceId)).profiles.map(row => row.profile)).toEqual(saved)
      expect(f.preparation.start).toHaveBeenCalledTimes(3)
      const persisted = (await f.db.pool.query('select state from ci_enrollment_computers where workspace_id=$1',
        [f.workspaceId])).rows.map(row => row.state)
      const readback = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      expect(persisted).toEqual(expect.arrayContaining(readback.computers))
    } finally { await f.close() }
  })

  it('places the same saved Auto verification request on an enrolled backup after its first computer disconnects', async () => {
    const f = await fixture()
    const sql = await f.db.pool.connect()
    try {
      const storage = f.inventory.storage
      f.inventory.storage = async target => {
        const capacity = await storage(target)
        if (capacity && buildComputerKey(target) === buildComputerKey(f.computers[1]!.target)) {
          return { diskBytes: capacity.diskBytes * 2, mutableInodes: capacity.mutableInodes * 2 }
        }
        return capacity
      }
      await f.enrollment.reconcile()
      const state = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      const saved = (await f.profiles.list(f.owner.principal, f.workspaceId)).profiles
      const base = verificationFixture().spec
      const measured = verificationCapacityFixture('device').measurement!
      // Qualification and native metadata are boundary fixtures; save, envelope matching and claim persistence are real.
      const candidates: JobComputerCandidate[] = state.computers.slice(0, 2).map(computer => {
        const profile = saved.find(row => row.profile.id === computer.profileIds[0])!.profile
        if (profile.schemaVersion !== 2) throw new Error('Verification profile required')
        const root = profile.root
        const spec = ResolvedVerificationJobSpecSchema.parse({
          ...base, source: { ...root.source, commit: profile.sourceCommit! },
          policy: jobRuntimeProfilePolicy(profile), verification: { ...base.verification, resources: profile.spec.resources },
          target: { ...base.target, mainId: root.binding.mainId, mainInstallationId: root.binding.mainId,
            hostRef: root.selection.hostRef, registration: root.registration,
            destination: { ...base.target.destination, rootPolicyId: root.selection.rootPolicyId,
              canonicalProjectRoot: root.binding.canonicalPath, canonicalCwd: root.binding.canonicalPath,
              attestationId: root.attestationId, attestationHash: root.attestationDigest } } })
        const qualified = JobVerificationProfileSchema.parse({ ...profile, status: 'qualified',
          measurement: { ...measured,
            identity: { ...measured.identity, profileId: profile.id, profileRevision: profile.revision,
              rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision },
            fingerprint: { ...measured.fingerprint, profileId: profile.id, profileRevision: profile.revision,
              specDigest: profile.specDigest, root, hostRef: root.selection.hostRef, registration: root.registration,
              mainInstallationId: root.binding.mainId, approvalConfig: profile.approvalConfig },
          } })
        return { spec, profile: qualified, ready: true, reasons: [],
          sourceReservation: { scopeId: `${f.workspaceId}:${root.binding.rootId}`, reservedBytes: 1024 } }
      })
      const placement = new JobComputerSelection(f.settings, {
        candidates: async () => ({ candidates: candidates.filter(candidate =>
          f.computers.some(computer => computer.connected
            && buildComputerKey(computer.target) === buildComputerKey({ hostRef: candidate.spec.target.hostRef }))),
        diagnosticCodes: [] }),
      }, new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }), async () => 64 * 2 ** 30)
      const unavailable = async (): Promise<never> => { throw new Error('This placement test does not launch a runtime') }
      const jobs = new JobService(f.db.pool, f.commands, { placement,
        preparation: { validate: (client, principal, workspaceId, spec) =>
          placement.validateRequest(client, principal, workspaceId, spec),
        choices: async () => ({ targets: [], sources: [], policies: [] }), accept: unavailable,
        revalidateAccepted: unavailable, adoptFinalBinding: unavailable },
        dispatch: { accept: unavailable, cancel: unavailable, cancelForRunCleanup: unavailable, wake: unavailable },
        artifacts: { list: async () => [], read: unavailable } })
      const first = candidates[0]!
      const definition = await jobs.saveDefinition(f.owner.principal, 'mcp', f.workspaceId, {
        commandId: randomUUID(), expectedRevision: null, name: 'Auto verification failover',
        spec: JobDefinitionSpecRecordSchema.parse({ ...first.spec, target: { kind: 'auto' },
          policy: jobPolicyRequirementsRecord(first.spec.policy),
          limits: first.profile.schemaVersion === 2 ? first.profile.spec.resources.limits : first.profile.limits }),
      })
      f.computers[0]!.connected = false
      const persisted = await jobs.getDefinition(f.owner.principal, f.workspaceId, definition.id)
      expect(persisted).toEqual(definition)
      await sql.query('begin')
      const identity = { executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID() }
      const claim = await placement.claim(sql, f.owner.principal, persisted, identity)
      expect(claim.spec).toEqual(candidates[1]!.spec)
      expect(claim.compatibleTargetCount).toBe(1)
      await sql.query('commit')
      expect((await f.db.pool.query('select spec,limits from job_computer_selections where execution_id=$1',
        [identity.executionId])).rows[0]).toEqual({ spec: candidates[1]!.spec,
        limits: first.profile.schemaVersion === 2 ? first.profile.spec.resources.limits : first.profile.limits })
      expect(await jobs.getDefinitionVersion(f.owner.principal, f.workspaceId, definition.id, definition.versionId))
        .toEqual(definition)
    } finally {
      await sql.query('rollback')
      sql.release()
      await f.close()
    }
  })

  it('repairs a previously shrunk same-computer clone without losing its link or rewriting its saved version', async () => {
    const f = await fixture()
    try {
      if (f.stored.schemaVersion !== 2) throw new Error('Verification template required')
      const resources = f.stored.spec.resources
      const smaller = await f.profiles.save(f.owner.principal, 'mcp', f.workspaceId, {
        commandId: randomUUID(), expectedRevision: null, name: f.stored.name,
        spec: { ...f.stored.spec, resources: { ...resources,
          limits: { ...resources.limits, diskBytes: resources.limits.diskBytes / 2 } } },
      })
      await new CiEnrollmentRepository(f.db.pool).save(f.db.pool, f.workspaceId, {
        state: { target: f.computers[0]!.target, revision: 0, enabled: true, state: 'pending',
          profileIds: [smaller.id], templates: [], message: null, updatedAt: null },
        profiles: { [f.stored.id]: { profileId: smaller.id, digest: 'previous-template-budget' } },
      })
      await f.enrollment.reconcile()
      const state = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      expect(state.computers[0]!.profileIds).toEqual([smaller.id])
      const profiles = (await f.profiles.list(f.owner.principal, f.workspaceId)).profiles
      expect(profiles).toHaveLength(4)
      const repaired = profiles.find(row => row.profile.id === smaller.id)!.profile
      expect(repaired).toMatchObject({ revision: smaller.revision + 1, spec: { resources } })
      expect((await f.db.pool.query('select record from job_runtime_profile_versions where profile_id=$1 and revision=$2',
        [smaller.id, smaller.revision])).rows[0]!.record).toEqual(smaller)
      expect(profiles.find(row => row.profile.id === f.stored.id)!.profile).toEqual(f.stored)
      await f.enrollment.reconcile()
      expect((await f.profiles.list(f.owner.principal, f.workspaceId)).profiles).toEqual(profiles)
      expect((await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })).computers[0]!.profileIds)
        .toEqual([smaller.id])
    } finally { await f.close() }
  })

  it('drops disconnected and build-disabled computers, then restores their saved profiles on reconnect', async () => {
    const f = await fixture()
    try {
      await f.enrollment.reconcile()
      const before = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      f.computers[1]!.connected = false
      f.computers[2]!.buildEnabled = false
      await f.enrollment.reconcile()
      const unavailable = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      expect(unavailable.computers[1]!.state).toBe('offline')
      expect(unavailable.computers[2]!.state).toBe('disabled')
      f.computers[1]!.connected = true
      f.computers[2]!.buildEnabled = true
      await f.enrollment.reconcile()
      const restored = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      expect(restored.computers.map(computer => computer.profileIds)).toEqual(
        before.computers.map(computer => computer.profileIds))
      expect(restored.computers.every(computer => computer.state === 'preparing')).toBe(true)
      expect(f.preparation.start).toHaveBeenCalledTimes(3)
    } finally { await f.close() }
  })

  it('automatically enrolls after profile save and build-enable changes', async () => {
    const f = await fixture()
    try {
      f.computers[1]!.buildEnabled = false
      f.profiles.enrollment = f.enrollment
      f.settings.enrollment = f.enrollment
      const template = f.stored
      if (template.schemaVersion !== 2) throw new Error('Verification template required')
      await f.profiles.save(f.owner.principal, 'mcp', f.workspaceId,
        ciEnrollmentProfileInput(template, template.root, {
          diskBytes: template.spec.resources.limits.diskBytes,
          mutableInodes: template.spec.resources.mutableInodes,
        }, randomUUID(), template))
      await vi.waitFor(async () => {
        expect(f.preparation.start).toHaveBeenCalledTimes(2)
        const state = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
        expect(state.computers[1]!.state).toBe('disabled')
      })
      f.computers[1]!.buildEnabled = true
      const preference = await f.settings.read(f.owner.principal, { target: f.computers[1]!.target })
      await f.settings.update(f.owner.principal, 'mcp', { target: f.computers[1]!.target,
        commandId: randomUUID(), expectedRevision: preference.preference.revision,
        buildEnabled: true, buildPriority: 60 })
      await vi.waitFor(async () => {
        expect(f.preparation.start).toHaveBeenCalledTimes(3)
        const state = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
        expect(state.computers[1]!.profileIds).toHaveLength(1)
      })
    } finally { await f.close() }
  })

  it('reports required runtime/root setup and does not revive revoked profiles', async () => {
    const f = await fixture()
    try {
      const storage = f.inventory.storage
      const root = f.inventory.root
      f.inventory.storage = async target => target.hostRef.kind === 'main' ? null : storage(target)
      f.inventory.root = async (_principal, _workspace, _template, target) => {
        if (buildComputerKey(target) === buildComputerKey(f.computers[1]!.target)) {
          throw new DomainError('CI_ENROLLMENT_ROOT_REQUIRED', 'Approved writable root required.', 409)
        }
        return f.roots[0]!
      }
      await f.enrollment.reconcile()
      const state = await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })
      expect(state.computers[1]).toMatchObject({ state: 'root-required',
        templates: [{ templateId: f.stored.id, profileId: null, state: 'root-required',
          message: 'Approved writable root required.' }] })
      expect(state.computers[2]!.state).toBe('runtime-required')
      f.inventory.storage = storage
      f.inventory.root = async (...args) => {
        if (buildComputerKey(args[3]) === buildComputerKey(f.computers[1]!.target)) {
          throw new DomainError('CI_ENROLLMENT_ROOT_REQUIRED', 'Approved writable root required.', 409)
        }
        return root(...args)
      }
      await f.enrollment.reconcile()
      const id = (await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId }))
        .computers[2]!.profileIds[0]!
      await f.db.pool.query(`update job_runtime_profiles set record=jsonb_set(record,'{status}','"revoked"') where id=$1`, [id])
      await f.enrollment.reconcile()
      expect((await f.enrollment.read(f.owner.principal, { workspaceId: f.workspaceId })).computers[2])
        .toMatchObject({ state: 'failed', profileIds: [], templates: [{ templateId: f.stored.id,
          profileId: null, state: 'failed', message: 'The enrolled CI profile was revoked.' }] })
      expect((await f.profiles.list(f.owner.principal, f.workspaceId)).profiles).toHaveLength(2)
      expect(f.preparation.start).toHaveBeenCalledTimes(2)
    } finally { await f.close() }
  })

  it('excludes a disabled enrollment from new Auto placement and re-enables it without changing its root', async () => {
    const f = await fixture()
    try {
      const target = f.computers[0]!.target
      if (target.hostRef.kind !== 'device') throw new Error('Worker fixture required')
      const computer = buildComputerFixture(target.hostRef.mainId, f.workspaceId, target.hostRef.deviceId)
      computer.candidate.spec.target.registration = f.roots[0]!.registration
      const placement = new JobComputerSelection(f.settings, {
        candidates: async () => ({ candidates: [computer.candidate], diagnosticCodes: [] }),
      }, new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }))
      const validate = () => placement.validateRequest(f.db.pool, f.owner.principal, f.workspaceId, computer.auto)
      expect((await validate()).valid).toBe(true)
      await f.enrollment.update(f.owner.principal, 'mcp', { workspaceId: f.workspaceId, target,
        commandId: randomUUID(), expectedRevision: 0, enabled: false })
      expect(await validate()).toMatchObject({ valid: false, reasons: ['disabled'] })
      await f.enrollment.update(f.owner.principal, 'mcp', { workspaceId: f.workspaceId, target,
        commandId: randomUUID(), expectedRevision: 1, enabled: true })
      expect((await validate()).valid).toBe(true)
    } finally { await f.close() }
  })

  it.each([false, true])('serializes MCP disable with a queued claim with persisted enrollment=%s', async persisted => {
    const f = await fixture()
    let queue: Awaited<ReturnType<typeof buildQueueFixture>> | undefined
    let resume: (() => void) | undefined
    let claiming: Promise<void> | undefined
    let disabling: ReturnType<Client['callTool']> | undefined
    try {
      await f.enrollment.close()
      queue = await buildQueueFixture(f.db.pool, f.owner.principal, { workspaceId: f.workspaceId })
      const computer = queue.computers[0]!
      f.computers.push({ target: computer.target, connected: true, buildEnabled: true })
      const client = await f.connect()
      if (persisted) {
        const enabled = await client.callTool({ name: 'ci_enrollment_update', arguments: {
          workspaceId: f.workspaceId, target: computer.target, expectedRevision: 0,
          commandId: randomUUID(), enabled: true,
        } })
        expect(enabled.isError, JSON.stringify(enabled.content)).not.toBe(true)
      } else {
        expect((await f.db.pool.query('select 1 from ci_enrollment_computers where workspace_id=$1 and host_key=$2',
          [f.workspaceId, buildComputerKey(computer.target)])).rowCount).toBe(0)
      }
      const definition = await queue.save()
      const started = await queue.jobs.enqueue(f.owner.principal, 'mcp', f.workspaceId, {
        commandId: randomUUID(), definitionId: definition.id, expectedRevision: definition.revision,
      })
      if (started.kind !== 'pending-admission') throw new Error('Offline computer must keep the Job queued')
      await queue.jobs.wakeQueue()
      let reached!: () => void
      const entered = new Promise<void>(resolve => { reached = resolve })
      const paused = new Promise<void>(resolve => { resume = resolve })
      const requireEnabled = queue.settings.requireEnabled.bind(queue.settings)
      vi.spyOn(queue.settings, 'requireEnabled').mockImplementationOnce(async (...args) => {
        reached()
        await paused
        return requireEnabled(...args)
      })
      queue.online()
      claiming = queue.jobs.wakeQueue()
      await Promise.race([entered, claiming.then(() => { throw new Error('Claim did not reach the placement barrier') })])
      let disableReturned = false
      disabling = client.callTool({ name: 'ci_enrollment_update', arguments: {
        workspaceId: f.workspaceId, target: computer.target, expectedRevision: persisted ? 1 : 0,
        commandId: randomUUID(), enabled: false,
      } }).then(async result => {
        disableReturned = true
        expect((await f.db.pool.query('select 1 from job_computer_selections where execution_id=$1',
          [started.ticket.executionId])).rowCount).toBe(1)
        return result
      })
      await vi.waitFor(async () => {
        const waiting = (await f.db.pool.query<{ count: number }>(`select count(*)::int as count from pg_locks
          where locktype='advisory' and not granted
          and database=(select oid from pg_database where datname=current_database())
          and objid=(hashtext($1)::bigint & 4294967295)`,
        [`ci-enrollment:${f.workspaceId}:${buildComputerKey(computer.target)}`])).rows[0]!
        expect(waiting.count).toBe(1)
      }, { timeout: 2000 })
      expect(disableReturned).toBe(false)
      resume!()
      const disabled = await disabling
      expect(disabled.isError, JSON.stringify(disabled.content)).not.toBe(true)
      await claiming
      expect(await queue.jobs.getQueueTicket(f.owner.principal, f.workspaceId, started.ticket.id))
        .toMatchObject({ state: 'accepted', executionId: started.ticket.executionId })
      const readback = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      expect(CiEnrollmentStateSchema.parse(decodeMcpToolResult(readback)).computers
        .find(value => buildComputerKey(value.target) === buildComputerKey(computer.target)))
        .toMatchObject({ enabled: false, revision: persisted ? 2 : 1, state: 'disabled' })
      const next = await queue.jobs.enqueue(f.owner.principal, 'mcp', f.workspaceId, {
        commandId: randomUUID(), definitionId: definition.id, expectedRevision: definition.revision,
      })
      if (next.kind !== 'pending-admission') throw new Error('Disabled computer must keep the new Job queued')
      await queue.jobs.wakeQueue()
      expect(await queue.jobs.getQueueTicket(f.owner.principal, f.workspaceId, next.ticket.id))
        .toMatchObject({ state: 'blocked', waitingReasons: ['disabled'] })
      expect((await f.db.pool.query('select 1 from job_computer_selections where execution_id=$1',
        [next.ticket.executionId])).rowCount).toBe(0)
      expect((await f.db.pool.query('select spec from job_computer_selections where execution_id=$1',
        [started.ticket.executionId])).rows[0]!.spec).toMatchObject({ target: computer.candidate.spec.target })
    } finally {
      resume?.()
      await Promise.allSettled([claiming, disabling])
      await queue?.jobs.closeQueue()
      await f.close()
    }
  }, 30_000)

  it('stops automatic preparation when the enrollment owner is revoked', async () => {
    const f = await fixture()
    try {
      await f.enrollment.reconcile()
      f.preparations.clear()
      f.preparation.start.mockClear()
      await f.access.revoke(f.owner.principal.id)
      await f.enrollment.reconcile()
      expect(f.preparation.start).not.toHaveBeenCalled()
      await expect(f.enrollment.update(f.owner.principal, 'mcp', { workspaceId: f.workspaceId,
        target: f.computers[0]!.target, commandId: randomUUID(), expectedRevision: 0, enabled: false }))
        .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    } finally { await f.close() }
  })

  it('persists revisioned MCP enable/disable controls, denies callers and retains idempotent audit history', async () => {
    const f = await fixture()
    try {
      const client = await f.connect()
      const tools = (await client.listTools()).tools.map(tool => tool.name)
      expect(tools).toEqual(expect.arrayContaining(['ci_enrollment_get', 'ci_enrollment_update']))
      const discovery = await client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full', workspaceId: f.workspaceId } })
      expect(discovery.isError, JSON.stringify(discovery.content)).not.toBe(true)
      const capabilities = OperatorCapabilitiesSchema.parse(decodeMcpToolResult(discovery))
      expect(capabilities.tools).toEqual(expect.arrayContaining(['ci_enrollment_get', 'ci_enrollment_update']))
      expect(capabilities.requirements).toContainEqual(expect.objectContaining({
        name: 'ci_enrollment_update', actions: CI_ENROLLMENT_ACTIONS,
      }))
      const input = { workspaceId: f.workspaceId, target: f.computers[0]!.target,
        commandId: randomUUID(), expectedRevision: 0, enabled: false }
      const changed = await client.callTool({ name: 'ci_enrollment_update', arguments: input })
      expect(changed.isError, JSON.stringify(changed.content)).not.toBe(true)
      const disabled = CiEnrollmentStateSchema.parse(decodeMcpToolResult(changed)).computers[0]!
      expect(disabled).toMatchObject({ enabled: false, revision: 1, state: 'disabled' })
      expect((await client.callTool({ name: 'ci_enrollment_update', arguments: input })).isError).not.toBe(true)
      const restarted = new CiEnrollment(f.db.pool, f.commands, f.profiles, f.preparation, f.inventory)
      expect((await restarted.read(f.owner.principal, { workspaceId: f.workspaceId })).computers[0])
        .toMatchObject({ target: disabled.target, enabled: false, revision: 1, state: 'disabled' })
      await restarted.close()
      const stale = await client.callTool({ name: 'ci_enrollment_update', arguments: {
        ...input, commandId: randomUUID(), enabled: true,
      } })
      expect(stale.isError).toBe(true)
      expect(JSON.stringify(stale.content)).toContain('REVISION_CONFLICT')
      const conflicting = await client.callTool({ name: 'ci_enrollment_update', arguments: { ...input, enabled: true } })
      expect(conflicting.isError).toBe(true)
      expect(JSON.stringify(conflicting.content)).toContain('COMMAND_ID_CONFLICT')
      const reader = await f.access.issue({ name: 'CI enrollment reader', audience: 'operator',
        grants: [{ actions: ['job_definitions:read'], scope: { workspaceIds: [f.workspaceId] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      const readonly = await f.connect(reader.token)
      expect((await readonly.listTools()).tools.map(tool => tool.name)).not.toContain('ci_enrollment_update')
      const denied = await readonly.callTool({ name: 'ci_enrollment_update', arguments: {
        ...input, commandId: randomUUID(), expectedRevision: 1, enabled: true,
      } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      const read = await readonly.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      expect(CiEnrollmentStateSchema.parse(decodeMcpToolResult(read)).computers[0])
        .toMatchObject({ target: disabled.target, enabled: false, revision: 1, state: 'disabled' })
      const outsider = await f.access.issue({ name: 'Other workspace CI owner', audience: 'operator',
        grants: [{ actions: CI_ENROLLMENT_ACTIONS, scope: { workspaceIds: [randomUUID()] } }],
        expiresAt: new Date(Date.now() + 600_000) })
      const foreign = await f.connect(outsider.token)
      expect((await foreign.callTool({ name: 'ci_enrollment_update', arguments: {
        ...input, commandId: randomUUID(), expectedRevision: 1, enabled: true,
      } })).isError).toBe(true)
      expect((await f.db.pool.query(`select outcome from management_audit
        where principal_id=$1 and action='ci_enrollment_update'`, [reader.principal.id])).rows)
        .toEqual([{ outcome: 'denied' }])
      expect((await f.db.pool.query(`select count(*)::int as count from management_audit
        where principal_id=$1 and action='ci_enrollment_update' and outcome='succeeded'`, [f.owner.principal.id]))
        .rows[0]!.count).toBe(1)
      const enabled = await client.callTool({ name: 'ci_enrollment_update', arguments: {
        ...input, commandId: randomUUID(), expectedRevision: 1, enabled: true,
      } })
      expect(enabled.isError, JSON.stringify(enabled.content)).not.toBe(true)
      await f.enrollment.close()
      const readback = await client.callTool({ name: 'ci_enrollment_get', arguments: { workspaceId: f.workspaceId } })
      const computer = CiEnrollmentStateSchema.parse(decodeMcpToolResult(readback)).computers[0]!
      expect(computer).toMatchObject({ revision: 2, enabled: true })
      expect((await f.db.pool.query(`select revision,enabled from ci_enrollment_computers
        where workspace_id=$1 and host_key=$2`, [f.workspaceId, buildComputerKey(input.target)])).rows[0])
        .toMatchObject({ revision: '2', enabled: true })
    } finally { await f.close() }
  })
})
