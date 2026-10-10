import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { SourceReservationReclamationResponseSchema, type SourceReservationReclamation } from '@foreman-code/contracts/source-operations'
import { JobPendingAdmissionSchema, JobQueueTicketSchema } from '@foreman-code/contracts/job-admission'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { PostgresSourceService } from '../src/modules/sources/service.js'
import { PostgresSourceReservations, type SourceReservation } from '../src/modules/sources/reservations.js'
import { MaterializationReservationCleanup } from '../src/modules/sources/materializationReservationCleanup.js'
import { SourceOperationWorkerService } from '../src/modules/sources/operationWorker.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim } from '../src/modules/sources/materialization.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { sourceBindingHash } from '../src/modules/sources/bindingHash.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { measureRetainedMaterializationFootprint, measureRetainedSourceDirectory } from '../src/modules/sources/retainedDirectoryUsage.js'
import { identity, openPrivateRoot } from '../src/modules/sources/privateFilesystem.js'
import { qualifyApprovedRootAllowlist } from '../src/modules/sources/rootAttestation.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { agent3Database } from './helpers/wave25Agent3.js'

let fixture: Awaited<ReturnType<typeof setup>> | undefined
afterEach(async () => { await fixture?.close(); fixture = undefined })

async function setup() {
  const database = await agent3Database()
  const pool = database.pool
  const access = new PostgresAccessService(pool)
  const writer = await access.issue({ name: 'Reservation cleanup fixture', audience: 'operator',
    expiresAt: new Date(Date.now() + 3600_000), grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] })
  const f = await buildQueueFixture(pool, writer.principal)
  const computer = f.computers[0]!
  const runtime = join(database.directory, 'runtime')
  const project = join(database.directory, 'project')
  const namespace = join(runtime, 'source-materializations', computer.candidate.profile.root.selection.rootPolicyId)
  await mkdir(namespace, { recursive: true, mode: 0o700 })
  await mkdir(project, { mode: 0o700 })
  const directory = await openPrivateRoot(namespace)
  const filesystem = await identity(directory)
  await directory.close()
  const bytes = Buffer.from('original source\n')
  const original = computer.candidate.profile.root
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(),
    approvedSourceId: randomUUID(), capturePolicy: 'git-tree-v1',
    git: { commit: '2'.repeat(40), tree: '3'.repeat(40), objectFormat: 'sha1' }, executablePolicy: 'strip', deletions: [],
    entries: [{ path: 'source.txt', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }] })
  const source = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest }
  const root = SourceRootRecordSchema.parse({ ...original, source, attestationId: randomUUID(),
    ownerPrincipalId: writer.principal.id, authorizedByPrincipalId: writer.principal.id,
    binding: { ...original.binding, rootId: randomUUID(), snapshotId: manifest.snapshotId,
      filesystem, canonicalPath: namespace, manifestDigest: manifest.manifestDigest } })
  computer.candidate.spec.source = { ...computer.candidate.spec.source, ...source }
  computer.candidate.spec.target.destination.attestationId = root.attestationId
  computer.candidate.spec.target.destination.canonicalProjectRoot = namespace
  computer.auto.source = computer.candidate.spec.source
  computer.candidate.profile.root = root
  const scopeId = `${root.binding.mainId}:${root.binding.deviceId}:${root.binding.workerInstallationId}:${filesystem.device}:${filesystem.mountId}`
  computer.candidate.sourceReservation.scopeId = scopeId
  await pool.query(`insert into source_approvals
    (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
    values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
  [manifest.approvedSourceId, manifest.snapshotId, f.workspaceId, writer.principal.id, randomUUID(), 'f'.repeat(64)])
  await pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
    values($1,$2,$3,$4,$5::jsonb)`,
    [manifest.snapshotId, manifest.approvedSourceId, f.workspaceId, manifest.manifestDigest,
      JSON.stringify({ version: 1, workspaceId: f.workspaceId,
      ownerPrincipalId: writer.principal.id, approvedByPrincipalId: writer.principal.id, locationRevision: 1,
      mainId: root.binding.mainId, originIdentityHash: `sha256:${'f'.repeat(64)}`, manifest,
      approvedAt: new Date().toISOString(), availability: 'retained' })])
  await pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
    values($1,$2,$3,1)`, [root.binding.rootId, f.workspaceId, randomUUID()])
  await pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
    values($1,1,$2,$3,$4::jsonb)`, [root.binding.rootId, f.workspaceId, manifest.snapshotId, JSON.stringify(root)])
  const allowlist = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef: root.selection.hostRef,
    applicationInstallationId: root.binding.workerInstallationId!, configurationRevision: '1',
    bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-only', 'read-write'] }], managedRuntimeRoot: runtime })
  const binding: DeviceSessionBinding = { ...computer.registration, bootId: randomUUID(),
    connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const unused = async (): Promise<never> => { throw new Error('No native execution or byte transfer in this fixture') }
  let reachable = true
  let nativeClosed = true
  const worker = new SourceOperationWorkerService({ authenticate: async () => {}, approvedRoots: async () => allowlist,
    currentOwner: unused,
    currentReclamation: async (reservationId, reclamationId) => {
      const sql = await pool.connect()
      try {
        await sql.query('begin')
        const grant = await cleanup.authorize(sql, reservationId, reclamationId)
        await sql.query('commit')
        return grant
      } catch (error) {
        await sql.query('rollback')
        throw error
      } finally { sql.release() }
    }, reclamationNativeClosed: async () => nativeClosed })
  const reclaim = vi.fn(async (grant: SourceReservationReclamation) => {
    if (!reachable) throw new DomainError('SOURCE_REMOTE_UNAVAILABLE', 'Worker is offline.', 409)
    const response = SourceReservationReclamationResponseSchema.parse(await worker.handle({ version: 1,
      operation: 'sources.reclaim-reservation', reservationId: grant.reservationId, reclamationId: grant.reclamationId },
    { binding, signal: AbortSignal.timeout(60_000) }))
    expect(response.operationId).toBe(grant.operationId)
    return { closures: response.closures, ...(response.retained ? { retained: response.retained } : {}) }
  })
  const cleanup = new MaterializationReservationCleanup(pool, reclaim)
  const reservations = new PostgresSourceReservations()
  const materializer = new PrivateSourceMaterializer({ read: async () => bytes }, async () => {})
  function attempt(operationId: string) {
    const value = { executionId: randomUUID(), attemptId: randomUUID(), placementHash: '',
      keyRevision: 1, authorizationRevision: 1 }
    value.placementHash = sourceBindingHash(root, value, operationId)
    return value
  }
  async function orphan(state: 'owned' | 'preparing', options?: { sharedWritableTree?: true }) {
    const operationId = randomUUID()
    const ownerAttempt = attempt(operationId)
    const receipt = await materializer.prepare({ binding: root.binding, manifest, attempt: ownerAttempt, ...options })
    const sql = await pool.connect()
    try {
      await sql.query('begin')
      const reservation = await reservations.reserve(sql, { scopeId, ownerKind: 'materialization',
        ownerId: operationId, reservedBytes: computer.candidate.sourceReservation.reservedBytes,
        preparation: { identity: { operationId, ownerPrincipalId: writer.principal.id,
          expiresAt: writer.principal.expiresAt }, root, source: root.source, attempt: ownerAttempt,
          record: null, physicalClosureConfirmed: false } })
      if (state === 'owned') await reservations.retain(sql, reservation, 'owned')
      await sql.query('commit')
      return { reservation, receipt, attempt: ownerAttempt }
    } catch (error) {
      await sql.query('rollback')
      throw error
    } finally { sql.release() }
  }
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { jobs: f.jobs, commands: f.commands } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  async function connect(token: string) {
    const client = new Client({ name: 'reservation-cleanup', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { authProvider: { token: async () => token } }))
    return client
  }
  return { ...f, pool, root, scopeId, namespace, manifest, attempt, cleanup, reclaim, orphan, materializer,
    writer, access, runtime, unused, connect, offline: () => { reachable = false }, onlineWorker: () => { reachable = true },
    nativeActive: () => { nativeClosed = false }, nativeStopped: () => { nativeClosed = true },
    async close() {
      await f.jobs.closeQueue()
      await Promise.all(clients.map(client => client.close()))
      await app.close()
      await database.close()
    } }
}

it('reclaims abandoned owned and preparing copies and restores placement through authenticated MCP', async () => {
  fixture = await setup()
  const f = fixture
  const owned = await f.orphan('owned')
  const preparing = await f.orphan('preparing')
  f.online()
  const definition = await f.save()
  const client = await f.connect(f.writer.token)
  const input = { workspaceId: f.workspaceId, commandId: randomUUID(), definitionId: definition.id,
    expectedRevision: definition.revision }
  const started = await client.callTool({ name: 'job_start', arguments: input })
  expect(started.isError, JSON.stringify(started)).not.toBe(true)
  const pending = JobPendingAdmissionSchema.parse((decodeMcpToolResult(started) as { admission: unknown }).admission)
  await f.jobs.wakeQueue()
  const before = await client.callTool({ name: 'job_queue_get', arguments: { workspaceId: f.workspaceId, ticketId: pending.ticket.id } })
  expect(before.isError, JSON.stringify(before)).not.toBe(true)
  expect(JobQueueTicketSchema.parse((decodeMcpToolResult(before) as { ticket: unknown }).ticket).waitingReasons).toEqual(['busy'])
  const denied = await f.access.issue({ name: 'Unscoped fixture reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['jobs:read'], scope: { workspaceIds: ['another-workspace'] } }] })
  const readOnly = await f.connect(denied.token)
  const deniedStart = await readOnly.callTool({ name: 'job_start', arguments: { ...input, commandId: randomUUID() } })
  expect(deniedStart.isError).toBe(true)
  expect(JSON.stringify(deniedStart.content)).toContain('ACCESS_DENIED')
  expect(await f.cleanup.reconcile()).toBe(2)
  for (const orphan of [owned, preparing]) {
    await expect(readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.pool.query('select state from source_storage_reservations where reservation_id=$1',
      [orphan.reservation.reservationId])).rows[0]!.state).toBe('reclaimed')
  }
  const audits = await f.pool.query("select details from management_audit where action='source.materialization.reservation.release'")
  expect(audits.rows).toHaveLength(2)
  expect(await f.cleanup.reconcile()).toBe(0)
  await f.jobs.wakeQueue()
  const after = await client.callTool({ name: 'job_queue_get', arguments: { workspaceId: f.workspaceId, ticketId: pending.ticket.id } })
  expect(after.isError, JSON.stringify(after)).not.toBe(true)
  expect(JobQueueTicketSchema.parse((decodeMcpToolResult(after) as { ticket: unknown }).ticket))
    .toMatchObject({ state: 'accepted', waitingReasons: [],
      selectedComputer: { rootId: f.root.binding.rootId, bindingRevision: f.root.binding.bindingRevision } })
  expect(f.accept).toHaveBeenCalledTimes(1)
}, 60_000)

it('leaves a live computer selection and its reservation untouched', async () => {
  fixture = await setup()
  const f = fixture
  const orphan = await f.orphan('owned')
  const definition = await f.save()
  await f.pool.query(`insert into job_computer_selections
    (execution_id,workspace_id,definition_version_id,attempt_id,operation_id,host_key,spec,limits,selection,source_scope,source_bytes)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'{}',$6,1)`,
  [orphan.attempt.executionId, f.workspaceId, definition.versionId, orphan.attempt.attemptId, orphan.reservation.ownerId,
    f.scopeId, JSON.stringify(f.computers[0]!.candidate.spec), JSON.stringify(f.computers[0]!.candidate.profile.limits)])
  expect(await f.cleanup.reconcile()).toBe(0)
  expect(f.reclaim).not.toHaveBeenCalled()
  expect((await f.pool.query('select state,record from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]).toEqual({ state: 'owned', record: orphan.reservation })
  expect(await readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt'))).toBeDefined()
}, 60_000)

it('reclaims an original copy while another root on the same filesystem has a live producer', async () => {
  fixture = await setup()
  const f = fixture
  const orphan = await f.orphan('owned')
  const policyId = randomUUID()
  const namespace = join(f.runtime, 'source-materializations', policyId)
  await mkdir(namespace, { mode: 0o700 })
  const directory = await openPrivateRoot(namespace)
  const filesystem = await identity(directory)
  await directory.close()
  const otherRoot = SourceRootRecordSchema.parse({ ...f.root,
    selection: { ...f.root.selection, rootPolicyId: policyId },
    binding: { ...f.root.binding, rootId: randomUUID(), canonicalPath: namespace, filesystem } })
  await f.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
    values($1,$2,$3,1)`, [otherRoot.binding.rootId, f.workspaceId, randomUUID()])
  await f.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
    values($1,1,$2,$3,$4::jsonb)`, [otherRoot.binding.rootId, f.workspaceId, f.manifest.snapshotId,
    JSON.stringify(otherRoot)])
  const producer = spawn(process.execPath, ['-e',
    "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
  { cwd: namespace, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => {
      producer.once('error', reject)
      producer.stdout.once('data', () => resolve())
    })
    expect(await f.cleanup.reconcile()).toBe(1)
    expect(producer.exitCode).toBeNull()
    expect((await f.pool.query('select state from source_storage_reservations where reservation_id=$1',
      [orphan.reservation.reservationId])).rows[0]!.state).toBe('reclaimed')
    await expect(readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (producer.exitCode === null && producer.signalCode === null) {
      const exited = once(producer, 'exit')
      producer.kill('SIGTERM')
      await exited
    }
  }
}, 60_000)

it('keeps an offline uncertain reservation charged and retries automatically', async () => {
  fixture = await setup()
  const f = fixture
  const orphan = await f.orphan('preparing')
  f.offline()
  const report = vi.fn()
  expect(await f.cleanup.reconcile(report)).toBe(0)
  expect(report).toHaveBeenCalledTimes(1)
  expect((await f.pool.query('select state from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]!.state).toBe('uncertain')
  f.onlineWorker()
  expect(await f.cleanup.reconcile()).toBe(1)
}, 60_000)

it('keeps a reservation charged until the Worker confirms native closure', async () => {
  fixture = await setup()
  const f = fixture
  const orphan = await f.orphan('owned')
  f.nativeActive()
  const report = vi.fn()
  expect(await f.cleanup.reconcile(report)).toBe(0)
  expect(report).toHaveBeenCalledTimes(1)
  expect((await f.pool.query('select state from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]!.state).toBe('uncertain')
  expect(await readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt'))).toBeDefined()
  f.nativeStopped()
  expect(await f.cleanup.reconcile()).toBe(1)
}, 60_000)

it('reclaims a released Worker copy when Main lost its preparation metadata', async () => {
  fixture = await setup()
  const f = fixture
  const orphan = await f.orphan('owned')
  await releaseMaterializationClaim(orphan.receipt, async () => 'released')
  expect(await f.cleanup.reconcile()).toBe(1)
  await expect(readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt')))
    .rejects.toMatchObject({ code: 'ENOENT' })
  expect((await f.pool.query('select state from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]!.state).toBe('reclaimed')
}, 60_000)

it('retries an expired cleanup owner and persists its confirmed closure', async () => {
  fixture = await setup()
  const f = fixture
  const orphan = await f.orphan('owned')
  const reconciliationId = randomUUID()
  const owner = { identity: { operationId: orphan.reservation.ownerId, ownerPrincipalId: f.principal.id,
    expiresAt: new Date(Date.now() + 600_000).toISOString() }, root: f.root, source: f.root.source,
    attempt: orphan.attempt, record: null, physicalClosureConfirmed: false, preparationClosed: true }
  await f.pool.query(`insert into source_preparation_reconciliations
    (operation_id,reconciliation_id,workspace_id,principal_id,command_id,status,owner)
    values($1,$2,$3,$4,$5,'reconciling',$6::jsonb)`, [orphan.reservation.ownerId, reconciliationId,
    f.workspaceId, f.principal.id, randomUUID(), JSON.stringify(owner)])
  expect(await f.cleanup.reconcile()).toBe(0)
  expect(f.reclaim).not.toHaveBeenCalled()
  owner.identity.expiresAt = new Date(Date.now() - 1000).toISOString()
  await f.pool.query('update source_preparation_reconciliations set owner=$2::jsonb where operation_id=$1',
    [orphan.reservation.ownerId, JSON.stringify(owner)])
  expect(await f.cleanup.reconcile()).toBe(1)
  const closed = (await f.pool.query('select status,closure from source_preparation_reconciliations where operation_id=$1',
    [orphan.reservation.ownerId])).rows[0]!
  expect(closed).toMatchObject({ status: 'closed', closure: { reconciliationId,
    operationId: orphan.reservation.ownerId, admissionClosed: true, childrenClosed: true, claimReleased: true } })
}, 60_000)

it.each(['timeout', 'invalid reply', 'adoption rollback'] as const)(
  'preserves an atomic cleanup owner after %s and reclaims the failed preparation automatically', async failure => {
    fixture = await setup()
    const f = fixture
    const operationId = randomUUID()
    const attempt = f.attempt(operationId)
    const definition = await f.save(f.computers[0]!.candidate.spec)
    const commandId = randomUUID()
    await f.pool.query(`insert into job_preparations
      (execution_id,attempt_id,operation_id,workspace_id,definition_version_id,principal_id,command_id,definition)
      values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [attempt.executionId, attempt.attemptId, operationId,
      f.workspaceId, definition.versionId, f.principal.id, commandId, JSON.stringify(definition)])
    const authorize = vi.fn(async () => {})
    if (failure === 'adoption rollback') authorize.mockResolvedValueOnce().mockRejectedValueOnce(new Error('Adoption rolled back'))
    const sources = new PostgresSourceService(f.pool, f.commands,
      new WorkspaceLocationService(f.pool, f.commands, f.runtime, 'fixture', f.runtime),
      new PrivateSourceSnapshotStore(join(f.runtime, 'snapshots')), f.root.binding.mainId,
      { authorize: f.unused, attest: f.unused, fence: f.unused },
      { authorize, authorizeFinal: f.unused, verify: f.unused, verifyWorkingDirectory: f.unused,
        releaseClaim: f.unused, prepare: async () => {
          const receipt = await f.materializer.prepare({ binding: f.root.binding, manifest: f.manifest, attempt })
          if (failure === 'timeout') throw new Error('Lost source activation reply')
          if (failure === 'invalid reply') return { ...receipt, executionId: randomUUID() }
          return receipt
        } }, { confirmedClosed: f.unused })
    const input = { principal: f.principal, workspaceId: f.workspaceId, rootId: f.root.binding.rootId,
      bindingRevision: 1, source: f.root.source, attempt, operationId }
    await expect(sources.prepareExecution(input)).rejects.toThrow()
    const row = (await f.pool.query<{ record: SourceReservation }>(
      'select record from source_storage_reservations where owner_id=$1', [operationId])).rows[0]!
    expect(row.record.preparation).toMatchObject({ root: f.root, attempt, identity: { operationId } })
    expect((await f.pool.query('select 1 from source_execution_materializations where operation_id=$1', [operationId])).rowCount).toBe(0)
    expect(await f.cleanup.reconcile()).toBe(0)
    await f.pool.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,'http','job.start',$2,'failed',$3::jsonb)`, [f.principal.id, f.workspaceId, JSON.stringify({ commandId })])
    expect(await f.cleanup.reconcile()).toBe(1)
    expect((await f.pool.query('select state from source_storage_reservations where owner_id=$1', [operationId])).rows[0]!.state)
      .toBe('reclaimed')
    await expect(sources.prepareExecution(input)).rejects.toMatchObject({ code: 'SOURCE_PREPARATION_RECONCILED' })
  }, 60_000)


it('keeps abandoned writable trees and their measured charge after releasing preparation ownership', async () => {
  fixture = await setup()
  const f = fixture
  const orphan = await f.orphan('owned', { sharedWritableTree: true })
  const working = join(f.namespace, orphan.receipt.sharedTree!.id, 'tree', 'output.txt')
  await writeFile(working, 'Unintegrated Agent output')
  expect(await f.cleanup.reconcile()).toBe(1)
  expect(await f.cleanup.reconcile()).toBe(0)
  const footprint = await measureRetainedMaterializationFootprint(orphan.receipt)
  const retained = (await f.pool.query<{ state: string; reserved_bytes: string }>(
    'select state,reserved_bytes from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]!
  expect(retained).toEqual({ state: 'retained', reserved_bytes: String(footprint.retainedBytes + 16 * 1024) })
  expect(await readFile(working, 'utf8')).toBe('Unintegrated Agent output')
  expect(await readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt'))).toBeDefined()
  const next = await f.orphan('owned')
  expect(next.reservation.reservationId).not.toBe(orphan.reservation.reservationId)
}, 60_000)

it('charges three closed references and one reused writable tree across closure replay', async () => {
  fixture = await setup()
  const f = fixture
  const copies = []
  const reservations = new PostgresSourceReservations()
  async function close(copy: Awaited<ReturnType<typeof f.orphan>>) {
    await releaseMaterializationClaim(copy.receipt, async () => 'released')
    const footprint = await measureRetainedMaterializationFootprint(copy.receipt)
    const sql = await f.pool.connect()
    try {
      await sql.query('begin')
      await reservations.retainMaterialization(sql, copy.reservation,
        { ...footprint, retainedBytes: footprint.retainedBytes + 16 * 1024 })
      await sql.query('commit')
    } catch (error) {
      await sql.query('rollback')
      throw error
    } finally { sql.release() }
  }
  for (let index = 0; index < 3; index++) {
    const copy = await f.orphan('owned', { sharedWritableTree: true })
    await close(copy)
    copies.push(copy)
  }
  expect(new Set(copies.map(copy => copy.receipt.sharedTree!.id)).size).toBe(1)
  const references = await Promise.all(copies.map(copy =>
    measureRetainedSourceDirectory(f.namespace, copy.receipt.materializationId)))
  const shared = await measureRetainedSourceDirectory(f.namespace, copies[0]!.receipt.sharedTree!.id)
  const expected = references.reduce((total, bytes) => total + bytes, 0) + shared + 3 * 16 * 1024
  const charged = async () => Number((await f.pool.query<{ bytes: string }>(
    "select sum(reserved_bytes) as bytes from source_storage_reservations where scope_id=$1 and state<>'reclaimed'",
    [f.scopeId])).rows[0]!.bytes)
  expect(await charged()).toBe(expected)
  for (const copy of copies) await close(copy)
  expect(await charged()).toBe(expected)
}, 60_000)

it.each([false, true])('ignores an unrelated historical host key during cleanup (other workspace: %s)', async otherWorkspace => {
  fixture = await setup()
  const f = fixture
  const orphan = await f.orphan('preparing')
  const workspaceId = otherWorkspace ? randomUUID() : f.workspaceId
  const manifest = otherWorkspace
    ? createSourceManifest({ ...f.manifest, snapshotId: randomUUID(), approvedSourceId: randomUUID() })
    : f.manifest
  if (otherWorkspace) {
    await f.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Historical roots' })])
    await f.pool.query(`insert into source_approvals
      (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
      values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
      [manifest.approvedSourceId, manifest.snapshotId, workspaceId, f.writer.principal.id,
        randomUUID(), 'f'.repeat(64)])
    await f.pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
      select $1,$2,$3,$4,record || jsonb_build_object('workspaceId',$3::text,'manifest',$5::jsonb)
      from source_snapshots where snapshot_id=$6`,
      [manifest.snapshotId, manifest.approvedSourceId, workspaceId, manifest.manifestDigest,
        JSON.stringify(manifest), f.manifest.snapshotId])
  }
  const rootId = randomUUID()
  const old = SourceRootRecordSchema.parse({ ...f.root,
    source: { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
      manifestDigest: manifest.manifestDigest },
    registration: { ...f.root.registration!, keyRevision: 2 },
    binding: { ...f.root.binding, rootId, workspaceId, snapshotId: manifest.snapshotId,
      manifestDigest: manifest.manifestDigest } })
  const current = SourceRootRecordSchema.parse({ ...old, registration: f.root.registration,
    binding: { ...old.binding, bindingRevision: 2 } })
  await f.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
    values($1,$2,$3,2)`, [rootId, workspaceId, randomUUID()])
  for (const root of [old, current]) await f.pool.query(`insert into source_root_bindings
    (root_id,binding_revision,workspace_id,snapshot_id,record) values($1,$2,$3,$4,$5::jsonb)`,
    [rootId, root.binding.bindingRevision, workspaceId, manifest.snapshotId, JSON.stringify(root)])
  expect(await f.cleanup.reconcile()).toBe(1)
  expect(f.reclaim.mock.calls[0]![0].roots).toEqual([f.root])
  expect((await f.pool.query('select state from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]!.state).toBe('reclaimed')
  expect((await f.pool.query('select record from source_root_bindings where root_id=$1 and binding_revision=1',
    [rootId])).rows[0]!.record).toEqual(old)
}, 60_000)


it('keeps an unowned reservation charged until its original cleanup root is recovered', async () => {
  fixture = await setup()
  const f = fixture
  const orphan = await f.orphan('owned')
  await f.pool.query("update source_storage_reservations set record=record-'preparation' where reservation_id=$1",
    [orphan.reservation.reservationId])
  expect(await f.cleanup.reconcile()).toBe(0)
  expect(f.reclaim).not.toHaveBeenCalled()
  const retained = (await f.pool.query<{ state: string; reserved_bytes: string }>(
    'select state,reserved_bytes from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]!
  expect(retained).toEqual({ state: 'owned', reserved_bytes: String(orphan.reservation.reservedBytes) })
  expect(await readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt'))).toBeDefined()
}, 60_000)
