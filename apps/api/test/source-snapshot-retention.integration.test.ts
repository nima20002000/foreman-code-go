import { randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { JobDefinitionSchema, JobExecutionSchema, type JobExecution } from '@foreman-code/contracts/jobs'
import { JobVerificationProfileSchema } from '@foreman-code/contracts/job-verification-runtime'
import { ApprovedSourceSchema, SourceApproveResultSchema, SourceListResultSchema,
  SourceRootRecordSchema, type ApprovedSource } from '@foreman-code/contracts/source-admission'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { JobRepository } from '../src/modules/jobs/repository.js'
import { qualifiedGit } from '../src/modules/sources/capture.js'
import type { RegisteredSourceRootPort } from '../src/modules/sources/admissionPorts.js'
import { SOURCE_AGGREGATE_LIMITS, type SourceReservation } from '../src/modules/sources/reservations.js'
import { PostgresSourceService } from '../src/modules/sources/service.js'
import { SOURCE_RETENTION_SECONDS } from '../src/modules/sources/snapshotRetention.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { agent3Database } from './helpers/wave25Agent3.js'
import { jobExecution, jobSpec } from './helpers/jobFixture.js'
import { verificationCapacityFixture } from './helpers/verificationCapacityFixture.js'

let fixture: Awaited<ReturnType<typeof setup>> | undefined
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await fixture?.close()
  fixture = undefined
})

async function setup() {
  const database = await agent3Database()
  const pool = database.pool
  const project = join(database.directory, 'project')
  const canonical = join(database.directory, 'snapshots')
  const runtime = join(database.directory, 'runtime')
  for (const path of [project, canonical, runtime]) await mkdir(path, { mode: 0o700 })
  const commands = new PostgresCommandCoordinator(pool)
  const access = new PostgresAccessService(pool)
  const owner = await access.issue({ name: 'Snapshot retention fixture', audience: 'operator',
    grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
    expiresAt: new Date(Date.now() + 3600_000) })
  const locations = new WorkspaceLocationService(pool, commands, runtime, 'runner-local', database.directory)
  const workspaces = new WorkspaceManagementService(pool, commands, locations)
  const created = await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Retention' })
  const workspaceId = created.value.workspace.id
  const located = await locations.set(owner.principal, 'http', { workspaceId, commandId: randomUUID(),
    expectedLocationRevision: created.value.locationRevision, runnerId: locations.runnerId, rootPath: project })
  const mainId = (await pool.query<{ id: string }>(
    'select id from application_installation where singleton=true')).rows[0]!.id
  await qualifiedGit(project, ['init', '--template='])
  await writeFile(join(project, 'source.ts'), 'export const value = 1\n')
  await qualifiedGit(project, ['add', '.'])
  await qualifiedGit(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'Fixture source'])
  const commit = (await qualifiedGit(project, ['rev-parse', 'HEAD'])).toString().trim()
  const notInvoked = async (): Promise<never> => { throw new Error('No native execution in this metadata fixture.') }
  const store = new PrivateSourceSnapshotStore(canonical)
  const sources = new PostgresSourceService(pool, commands, locations, store, mainId,
    { authorize: notInvoked, attest: notInvoked, fence: notInvoked } satisfies RegisteredSourceRootPort,
    { authorize: notInvoked, prepare: notInvoked, verify: notInvoked, verifyWorkingDirectory: notInvoked,
      releaseClaim: notInvoked, authorizeFinal: notInvoked }, { confirmedClosed: notInvoked })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access, services: { sources, commands, workspaces, locations } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  async function connect(token: string) {
    const client = new Client({ name: 'snapshot-retention', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { authProvider: { token: async () => token } }))
    return client
  }
  const client = await connect(owner.token)
  const approval = { workspaceId, commandId: randomUUID(), commit, approvedPaths: ['source.ts'],
    executablePolicy: 'strip', expectedLocationRevision: located.value.locationRevision }
  async function approve(ageSeconds = 0) {
    const input = { ...approval, commandId: randomUUID() }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() - ageSeconds * 1000)
    try {
      const response = await client.callTool({ name: 'source_approve', arguments: input })
      expect(response.isError, JSON.stringify(response)).not.toBe(true)
      return { input, source: SourceApproveResultSchema.parse(response.structuredContent).value }
    } finally { vi.useRealTimers() }
  }
  function sourcePin(source: ApprovedSource) {
    return { approvedSourceId: source.manifest.approvedSourceId,
      snapshotId: source.manifest.snapshotId, manifestDigest: source.manifest.manifestDigest }
  }
  function pin(source: ApprovedSource) {
    return { workspaceId, ...sourcePin(source) }
  }
  async function reservation(source: ApprovedSource) {
    return (await pool.query<{ state: string; reserved_bytes: string; record: SourceReservation }>(
      "select state,reserved_bytes,record from source_storage_reservations where owner_kind='capture' and owner_id=$1",
      [source.manifest.snapshotId])).rows[0]!
  }
  async function read(source: ApprovedSource) {
    const response = await client.callTool({ name: 'source_get', arguments: pin(source) })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    return ApprovedSourceSchema.parse(response.structuredContent)
  }
  async function seedJob(source: ApprovedSource, retentionSeconds = SOURCE_RETENTION_SECONDS) {
    const now = source.approvedAt
    const spec = jobSpec()
    spec.source = { ...sourcePin(source), commit }
    spec.policy.retentionSeconds = retentionSeconds
    const definition = JobDefinitionSchema.parse({ schemaVersion: 1, id: randomUUID(), versionId: randomUUID(),
      workspaceId, name: 'Snapshot consumer', revision: 1, spec, createdAt: now, updatedAt: now })
    await pool.query(`insert into job_definitions(id,workspace_id,revision,version_id,record,updated_by)
      values($1,$2,1,$3,$4::jsonb,$5)`,
    [definition.id, workspaceId, definition.versionId, JSON.stringify(definition), owner.principal.id])
    await pool.query(`insert into job_definition_versions(id,definition_id,workspace_id,revision,record)
      values($1,$2,$3,1,$4::jsonb)`,
    [definition.versionId, definition.id, workspaceId, JSON.stringify(definition)])
    const base = jobExecution()
    const execution = JobExecutionSchema.parse({ ...base, id: randomUUID(), workspaceId,
      operationId: randomUUID(), attemptId: randomUUID(), createdAt: now, updatedAt: now,
      acceptedSpec: { ...base.acceptedSpec, ...spec,
        source: { ...spec.source, materializationId: randomUUID(), materializationDigest: 'a'.repeat(64) },
        definitionId: definition.id, definitionVersionId: definition.versionId } })
    await pool.query(`insert into job_executions
      (id,workspace_id,definition_version_id,operation_id,attempt_id,record,accepted_spec,accepted_by)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [execution.id, workspaceId, definition.versionId, execution.operationId, execution.attemptId,
      JSON.stringify(execution), JSON.stringify(execution.acceptedSpec), owner.principal.id])
    return execution
  }
  async function finishJob(execution: JobExecution, finishedAt = execution.createdAt) {
    await new JobRepository().putExecution(pool, { ...execution, publication: 'complete',
      process: { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true },
      startedAt: execution.createdAt, finishedAt, updatedAt: finishedAt })
  }
  return { pool, store, sources, client, access, owner, workspaceId, canonical, mainId,
    approve, sourcePin, pin, reservation, read, seedJob, finishJob, connect,
    async close() {
      await Promise.allSettled(clients.map(value => value.close()))
      await app.close()
      await database.close()
    } }
}

it('reclaims older terminal snapshots before capture capacity fails and exposes unavailability through authenticated MCP',
  async () => {
    fixture = await setup()
    const f = fixture
    const approvals = []
    let chargedBytes = 0
    while (chargedBytes <= SOURCE_AGGREGATE_LIMITS.bytes) {
      const approved = await f.approve(SOURCE_RETENTION_SECONDS * 3)
      approvals.push(approved)
      await f.finishJob(await f.seedJob(approved.source))
      const reservation = await f.reservation(approved.source)
      // Exercise the conservative full capture charge without writing a GiB of fixture files.
      await f.sources.reservations.retain(f.pool, reservation.record, 'retained')
      chargedBytes += reservation.record.reservedBytes
    }
    expect(approvals.length).toBeGreaterThan(1)
    const first = approvals[0]!
    const listed = await f.client.callTool({ name: 'source_list', arguments: { workspaceId: f.workspaceId } })
    expect(listed.isError).not.toBe(true)
    const items = SourceListResultSchema.parse(listed.structuredContent).items
    expect(items.find(item => item.manifest.snapshotId === first.source.manifest.snapshotId)?.availability)
      .toBe('unavailable')
    const get = await f.client.callTool({ name: 'source_get', arguments: f.pin(first.source) })
    expect(get.isError).toBe(true)
    expect(JSON.stringify(get.content)).toContain('SOURCE_UNAVAILABLE')
    const retry = await f.client.callTool({ name: 'source_approve', arguments: first.input })
    expect(retry.isError).toBe(true)
    expect(JSON.stringify(retry.content)).toContain('SOURCE_UNAVAILABLE')
    expect((await f.reservation(first.source)).state).toBe('reclaimed')
    expect(await f.store.retainedCaptureBytes(first.source.manifest.snapshotId)).toBe(0)
    await expect(stat(join(f.canonical, first.source.manifest.snapshotId))).rejects.toMatchObject({ code: 'ENOENT' })
    await f.read(approvals.at(-1)!.source)
    const denied = await f.access.issue({ name: 'Other workspace', audience: 'operator',
      grants: [{ actions: ['sources:read', 'sources:approve', 'workspace_locations:read'],
        scope: { workspaceIds: ['other-workspace'] } }], expiresAt: new Date(Date.now() + 120_000) })
    const deniedClient = await f.connect(denied.token)
    for (const name of ['source_get', 'source_list']) {
      const response = await deniedClient.callTool({ name, arguments: name === 'source_get'
        ? f.pin(first.source) : { workspaceId: f.workspaceId } })
      expect(response.isError).toBe(true)
      expect(JSON.stringify(response.content)).toContain('ACCESS_DENIED')
    }
    const deniedApproval = await deniedClient.callTool({ name: 'source_approve',
      arguments: { ...first.input, commandId: randomUUID() } })
    expect(deniedApproval.isError).toBe(true)
    expect(JSON.stringify(deniedApproval.content)).toContain('ACCESS_DENIED')
  }, 120_000)

it('keeps active Jobs, recent terminal use, longer Job retention and a qualified verification profile retained', async () => {
  fixture = await setup()
  const f = fixture
  const old = SOURCE_RETENTION_SECONDS * 3
  const active = (await f.approve(old)).source
  const execution = await f.seedJob(active)
  const recent = (await f.approve(old)).source
  await f.finishJob(await f.seedJob(recent), new Date().toISOString())
  const longer = (await f.approve(old)).source
  await f.finishJob(await f.seedJob(longer, old * 2))
  const pinned = (await f.approve(old)).source
  // Qualified metadata exercises retention; this fixture does not launch or qualify a runtime.
  const base = verificationCapacityFixture('main')
  const hostRef = { kind: 'main', mainId: f.mainId }
  const root = SourceRootRecordSchema.parse({ ...base.root, source: f.sourcePin(pinned),
    selection: { ...base.root.selection, hostRef },
    binding: { ...base.root.binding, snapshotId: pinned.manifest.snapshotId,
      manifestDigest: pinned.manifest.manifestDigest, workspaceId: f.workspaceId, mainId: f.mainId } })
  const profile = JobVerificationProfileSchema.parse({ ...base, workspaceId: f.workspaceId, root,
    sourceCommit: pinned.manifest.git!.commit, measurement: { ...base.measurement!,
      fingerprint: { ...base.measurement!.fingerprint, root, hostRef,
        sourceCommit: pinned.manifest.git!.commit } } })
  await f.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
    values($1,$2,$3,1)`, [root.binding.rootId, f.workspaceId, randomUUID()])
  await f.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
    values($1,1,$2,$3,$4::jsonb)`, [root.binding.rootId, f.workspaceId, pinned.manifest.snapshotId, JSON.stringify(root)])
  await f.pool.query(`insert into job_runtime_profiles(id,workspace_id,revision,root_id,binding_revision,record)
    values($1,$2,1,$3,1,$4::jsonb)`, [profile.id, f.workspaceId, root.binding.rootId, JSON.stringify(profile)])
  await f.sources.releaseUnusedSnapshots()
  for (const source of [active, recent, longer, pinned]) {
    expect((await f.read(source)).availability).toBe('retained')
    expect((await f.reservation(source)).state).toBe('retained')
    expect(await f.store.retainedCaptureBytes(source.manifest.snapshotId)).toBeGreaterThan(0)
  }
  await f.finishJob(execution)
  await f.sources.releaseUnusedSnapshots()
  expect((await f.reservation(active)).state).toBe('reclaimed')
  expect((await f.read(pinned)).availability).toBe('retained')
}, 60_000)

it('skips a snapshot while admission holds its shared lock, then releases it after admission ends', async () => {
  fixture = await setup()
  const f = fixture
  const source = (await f.approve(SOURCE_RETENTION_SECONDS * 3)).source
  const sql = await f.pool.connect()
  try {
    await sql.query('begin')
    await f.sources.resolveApprovedSource(sql, f.owner.principal, f.workspaceId, f.pin(source))
    await f.sources.releaseUnusedSnapshots()
    expect((await f.read(source)).availability).toBe('retained')
    await sql.query('commit')
    await f.sources.releaseUnusedSnapshots()
    expect((await f.reservation(source)).state).toBe('reclaimed')
  } finally {
    await sql.query('rollback')
    sql.release()
  }
}, 60_000)

it.each(['deletion', 'accounting'] as const)('retries interrupted %s without resurrecting the unavailable snapshot',
  async failure => {
    fixture = await setup()
    const f = fixture
    const approved = await f.approve(SOURCE_RETENTION_SECONDS * 3)
    if (failure === 'deletion') {
      vi.spyOn(f.store, 'remove').mockRejectedValueOnce(new Error('Injected deletion failure'))
    } else {
      await f.pool.query(`create function fail_snapshot_accounting() returns trigger language plpgsql as $$
        begin if new.state='reclaimed' then raise exception 'Injected accounting failure'; end if; return new; end $$;
        create trigger fail_snapshot_accounting before update on source_storage_reservations
          for each row execute function fail_snapshot_accounting()`)
    }
    await expect(f.sources.releaseUnusedSnapshots()).rejects.toThrow('Injected')
    const listed = SourceListResultSchema.parse((await f.client.callTool({ name: 'source_list',
      arguments: { workspaceId: f.workspaceId } })).structuredContent)
    expect(listed.items[0]!.availability).toBe('unavailable')
    expect((await f.reservation(approved.source)).state).toBe('retained')
    const retry = await f.client.callTool({ name: 'source_approve', arguments: approved.input })
    expect(retry.isError).toBe(true)
    expect(JSON.stringify(retry.content)).toContain('SOURCE_UNAVAILABLE')
    if (failure === 'accounting') {
      expect(await f.store.retainedCaptureBytes(approved.source.manifest.snapshotId)).toBe(0)
      await f.pool.query('drop trigger fail_snapshot_accounting on source_storage_reservations')
    }
    await f.sources.releaseUnusedSnapshots()
    expect((await f.reservation(approved.source)).state).toBe('reclaimed')
    expect(await f.store.retainedCaptureBytes(approved.source.manifest.snapshotId)).toBe(0)
  }, 60_000)
