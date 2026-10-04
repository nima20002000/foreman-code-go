import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import pg from 'pg'
import { expect, it } from 'vitest'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { PrivateSourceMaterializer, releaseMaterializationClaim } from '../src/modules/sources/materialization.js'
import { PostgresSourceService, type SourceExecutionHostPort } from '../src/modules/sources/service.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { identity, openPrivateRoot } from '../src/modules/sources/privateFilesystem.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import type { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import type { RegisteredSourceRootPort } from '../src/modules/sources/admissionPorts.js'
import { measureRetainedSourceDirectory } from '../src/modules/sources/retainedDirectoryUsage.js'
import { closeCompletedWorkflowSources } from '../src/modules/sources/workflowCleanup.js'

// Owned closure-only SQL fixture. This exercises the unchanged confirmClosed
// transaction and retention accounting; it does not qualify native closure proof.
it.each(['lost-acknowledgement', 'database-failure'] as const)('finishes durable release replay after %s and keeps retained bytes charged', async failure => {
  const database = `source_claims_test_${randomUUID().replaceAll('-', '')}`
  const adminUrl = 'postgresql://graphql:graphql@127.0.0.1:5432/postgres'
  const admin = new pg.Pool({ connectionString: adminUrl })
  await admin.query(`create database "${database}"`)
  const url = new URL(adminUrl); url.pathname = `/${database}`
  const pool = new pg.Pool({ connectionString: url.toString() }), root = await mkdtemp('/tmp/source-claims-db-')
  try {
    await pool.query(`create table source_execution_materializations (materialization_id uuid primary key, record jsonb not null,
      state text not null, execution_id text not null, reservation_id uuid not null);
      create table runs (id text primary key, execution_state text not null);
      create table harness_executions (id text primary key, run_id text not null, record jsonb not null);
      create table source_preparation_reconciliations (operation_id text primary key, status text not null);
      create table source_storage_reservations (reservation_id uuid primary key, scope_id text not null, owner_kind text not null,
      owner_id text not null, state text not null, reserved_bytes bigint not null, record jsonb not null)`)
    const bytes = Buffer.from('retained original bytes\n')
    const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
      capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip',
      entries: [{ path: 'app.ts', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }], deletions: [] })
    const handle = await openPrivateRoot(root), filesystem = await identity(handle); await handle.close()
    const binding = { version: 1 as const, mainId: randomUUID(), deviceId: null, workerInstallationId: null, workspaceId: randomUUID(), rootId: randomUUID(),
      bindingRevision: 1, locationRevision: 1, canonicalPath: root, filesystem, accessMode: 'exclusive-write' as const,
      snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
    const attempt = { placementHash: 'a'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(), keyRevision: null, authorizationRevision: null }
    const receipt = await new PrivateSourceMaterializer({ async read() { return bytes } }, async () => {}).prepare({ manifest, binding, attempt })
    const reservation = { reservationId: randomUUID(), scopeId: `main:${filesystem.device}:${filesystem.mountId}`, ownerKind: 'materialization', ownerId: randomUUID(), reservedBytes: 100_000 }
    const record = SourceMaterializationRecordSchema.parse({ receipt, rootPolicyId: randomUUID(), rootPolicyRevision: '1', operationId: reservation.ownerId,
      reservationId: reservation.reservationId, sourceBindingHash: attempt.placementHash, finalDispatchBindingHash: null, state: 'prepared' })
    await pool.query(`insert into source_execution_materializations values ($1,$2,'prepared',$3,$4)`,
      [receipt.materializationId, record, receipt.executionId, record.reservationId])
    await pool.query(`insert into runs values ('ongoing-workflow','running')`)
    await pool.query(`insert into harness_executions values ($1,'ongoing-workflow',$2)`,
      [receipt.executionId, { state: 'running' }])
    await pool.query(`insert into source_storage_reservations values ($1,$2,$3,$4,'owned',$5,$6)`, [reservation.reservationId, reservation.scopeId, reservation.ownerKind, reservation.ownerId, reservation.reservedBytes, reservation])
    const makeService = (releaseClaim: SourceExecutionHostPort['releaseClaim']) => new PostgresSourceService(pool,
      {} as PostgresCommandCoordinator, {} as WorkspaceLocationService, {} as PrivateSourceSnapshotStore,
      binding.mainId, {} as RegisteredSourceRootPort, { releaseClaim } as SourceExecutionHostPort,
      { async confirmedClosed(original) { expect(original).toEqual(record); return true } })
    if (failure === 'database-failure') await pool.query(`create function fail_source_close() returns trigger language plpgsql as $$ begin raise exception 'injected Main DB failure'; end $$;
      create trigger fail_source_close before update on source_execution_materializations for each row execute function fail_source_close()`)
    const initial = makeService(async original => {
      await releaseMaterializationClaim(original.receipt, async () => 'released')
      if (failure === 'lost-acknowledgement') throw new Error('injected lost remote acknowledgement')
      return measureRetainedSourceDirectory(root, receipt.materializationId, filesystem)
    })
    await expect(initial.confirmClosed(record)).rejects.toThrow('injected')
    expect((await pool.query('select state from source_execution_materializations')).rows[0].state).toBe('prepared')
    expect((await pool.query('select state,reserved_bytes from source_storage_reservations')).rows[0]).toEqual({ state: 'owned', reserved_bytes: String(reservation.reservedBytes) })
    await expect(readFile(join(root, `binding-${binding.rootId}.lock`))).rejects.toMatchObject({ code: 'ENOENT' })
    if (failure === 'database-failure') await pool.query('drop trigger fail_source_close on source_execution_materializations')
    // A new host process has no in-memory release history.
    const recovered = makeService(async original => {
      await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        "import { releaseMaterializationClaim } from './src/modules/sources/materialization.ts'; await releaseMaterializationClaim(JSON.parse(process.argv[1]), async () => 'released');",
        JSON.stringify(original.receipt)])
      return measureRetainedSourceDirectory(root, receipt.materializationId, filesystem)
    })
    const report = (error: unknown): never => { throw error }
    await closeCompletedWorkflowSources(pool, recovered, report)
    expect((await pool.query('select state from source_execution_materializations')).rows[0].state).toBe('prepared')
    await pool.query(`update harness_executions set record=$1`, [{ state: 'completed' }])
    await closeCompletedWorkflowSources(pool, recovered, report)
    expect((await pool.query('select execution_state from runs')).rows[0].execution_state).toBe('running')
    await recovered.confirmClosed(record)
    expect((await pool.query('select state from source_execution_materializations')).rows[0].state).toBe('closed')
    const retainedBytes = await measureRetainedSourceDirectory(root, receipt.materializationId, filesystem) + 16 * 1024
    expect(retainedBytes).toBeLessThan(reservation.reservedBytes)
    expect((await pool.query('select state,reserved_bytes from source_storage_reservations')).rows[0]).toEqual({ state: 'retained', reserved_bytes: String(retainedBytes) })
    expect(Number((await pool.query("select sum(reserved_bytes) as charged from source_storage_reservations where state<>'reclaimed'")).rows[0].charged)).toBe(retainedBytes)
    expect(await readFile(join(root, receipt.materializationId, 'tree/app.ts'))).toEqual(bytes)
    await pool.query(`insert into source_preparation_reconciliations values ($1,'closed')`, [record.operationId])
    await pool.query('update source_storage_reservations set reserved_bytes=$1', [reservation.reservedBytes])
    await closeCompletedWorkflowSources(pool, recovered, report)
    expect((await pool.query('select reserved_bytes from source_storage_reservations')).rows[0].reserved_bytes)
      .toBe(String(reservation.reservedBytes))
  } finally {
    await pool.end(); await admin.query(`drop database "${database}"`); await admin.end(); await rm(root, { recursive: true, force: true })
  }
}, 30_000)
