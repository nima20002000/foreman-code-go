import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'vitest'

import { PostgresFileCleanupRepository } from '../src/modules/files/cleanup/postgres.js'
import type { FileCleanupCandidate } from '../src/modules/files/cleanup/repository.js'

const original: FileCleanupCandidate = { fileId: 'file', revisionId: 'revision', storageKey: '00000000-0000-4000-8000-000000000001',
  ownerPrincipalId: 'owner', requestId: 'request', expiresAt: '2026-09-01 00:00:00.123456+00', retentionRevision: 0 }
function row() {
  return { file_id: original.fileId, revision_id: original.revisionId, storage_key: original.storageKey,
    owner_principal_id: original.ownerPrincipalId, request_id: original.requestId,
    expires_at: original.expiresAt, retention_revision: 0, state: 'ready', due: true, scope_kind: 'temporary' }
}
/** Transaction/transport fault test double, NOT an emulation/proof of PostgreSQL SQL or locking.
 * Real owner/publication locks, SQL predicates and concurrent sessions are covered in the integration suite. */
class Client extends EventEmitter {
  record = row()
  working: ReturnType<typeof row> | undefined
  queries: { sql: string; values: unknown[] }[] = []
  reads = 0
  commits = 0
  busySeed: number | undefined
  uncertainLock = false
  failCommit = 0
  failUnlock = false
  destroyed = false
  beforeRead: (client: Client) => void = () => undefined
  async query(sql: string, values: unknown[] = []) {
    this.queries.push({ sql, values })
    let rows: unknown[] = []
    if (sql.includes('pg_try_advisory_lock')) {
      if (this.uncertainLock) throw new Error('lost lock acknowledgment')
      rows = [{ locked: values[1] !== this.busySeed }]
    } else if (sql.includes('pg_advisory_unlock')) rows = [{ unlocked: !this.failUnlock }]
    else if (sql === 'begin') this.working = { ...this.record }
    else if (sql === 'rollback') this.working = undefined
    else if (sql === 'commit') {
      if (this.working) this.record = { ...this.working }
      this.working = undefined
      if (++this.commits === this.failCommit) throw new Error('lost commit acknowledgment')
    } else if (sql.includes('for update of f')) {
      this.reads++; this.beforeRead(this)
      const value = this.working ?? this.record
      if (value.scope_kind === 'temporary') rows = [{ ...value }]
    } else if (sql.startsWith('update files')) {
      assert.ok(this.working)
      this.working.state = 'expired'; rows = [{ file_id: this.record.file_id }]
    } else if (sql.startsWith('select')) rows = [{ ...this.record }]
    return { rows, rowCount: rows.length }
  }
  release(destroy = false) { this.destroyed = destroy }
}
function fixture() {
  const client = new Client()
  const pool = { connect: async () => client, query: client.query.bind(client) }
  return { client, repository: new PostgresFileCleanupRepository(pool as unknown as ConstructorParameters<typeof PostgresFileCleanupRepository>[0]) }
}

describe('FIL-04 cleanup guard and transaction fault handling', () => {
  it('commits a tombstone before unlink, reads twice and retains both session locks across commits', async () => {
    const { client, repository } = fixture()
    let unlinks = 0
    assert.equal(await repository.remove(original, async () => {
      unlinks++
      assert.equal(client.record.state, 'expired')
      assert.equal(client.commits, 1); assert.equal(client.reads, 2)
      assert.equal(client.queries.some(({ sql }) => sql.includes('pg_advisory_unlock')), false)
      return true
    }), 'cleaned')
    assert.equal(unlinks, 1); assert.equal(client.commits, 2)
    const locks = client.queries.filter(({ sql }) => sql.includes('pg_try_advisory_lock')).map(({ values }) => values)
    assert.deepEqual(locks, [[JSON.stringify(['file-allocation', 'owner', 'request']), 273601], ['owner', 273640]])
    assert.equal(client.destroyed, false)
    assert.equal(client.listenerCount('error'), 0)
  })

  it('rejects stale expiry, retention revision, scope, owner, revision and storage-key identities', async () => {
    const changes = [
      { expires_at: '2026-10-01 00:00:00+00', due: false }, { retention_revision: 1 },
      { scope_kind: 'workflow_reference' }, { scope_kind: 'workspace_reference' },
      { owner_principal_id: 'other' }, { revision_id: 'other' }, { storage_key: 'other' }, { request_id: 'other' },
    ]
    for (const change of changes) {
      const { client, repository } = fixture()
      Object.assign(client.record, change)
      assert.equal(await repository.remove(original, async () => { assert.fail('Stale/permanent candidate must not unlink'); }), 'stale')
      assert.equal(client.record.state, 'ready')
    }
  })

  it('checks revision and expiry again immediately before deletion, not just before marking', async () => {
    for (const change of [{ retention_revision: 1 }, { expires_at: '2026-10-01 00:00:00+00', due: false }]) {
      const { client, repository } = fixture()
      client.beforeRead = (current) => { if (current.reads === 2) Object.assign(current.working!, change) }
      assert.equal(await repository.remove(original, async () => { assert.fail('Second guard must reject'); }), 'stale')
      assert.equal(client.record.state, 'expired', 'The first committed tombstone is not rolled back')
    }
  })

  it('uses the file expiry, not the current preference duration; fresh revision can reclaim an overdue snapshot', async () => {
    const { client, repository } = fixture()
    client.record.retention_revision = 2
    assert.equal(await repository.remove(original, async () => { assert.fail('Old preference revision'); }), 'stale')
    assert.equal(await repository.remove({ ...original, retentionRevision: 2 }, async () => true), 'cleaned')
    assert.equal(client.record.expires_at, original.expiresAt)
  })

  it('skips busy allocation/retention owners without waiting or deleting, releasing already-held locks', async () => {
    for (const seed of [273601, 273640]) {
      const { client, repository } = fixture()
      client.busySeed = seed
      assert.equal(await repository.remove(original, async () => { assert.fail('Busy'); }), 'busy')
      assert.equal(client.queries.some(({ sql }) => sql === 'begin'), false)
      const releases = client.queries.filter(({ sql }) => sql.includes('pg_advisory_unlock'))
      assert.equal(releases.length, seed === 273640 ? 1 : 0)
    }
  })

  it('retains tombstone metadata after disk failure and permits a restart/retry to finish deletion', async () => {
    const { client, repository } = fixture()
    await assert.rejects(repository.remove(original, async () => { throw new Error('disk offline') }), /disk offline/)
    assert.equal(client.record.state, 'expired'); assert.equal(client.working, undefined)
    assert.equal(await repository.remove(original, async () => true), 'cleaned')
  })

  it('does not unlink after an uncertain tombstone commit and destroys uncertain lock sessions', async () => {
    const failedCommit = fixture()
    failedCommit.client.failCommit = 1
    await assert.rejects(failedCommit.repository.remove(original, async () => { assert.fail('Uncertain COMMIT cannot authorize bytes'); }), /lost commit/)
    assert.equal(failedCommit.client.record.state, 'expired')
    assert.equal(failedCommit.client.destroyed, true)
    const failedLock = fixture()
    failedLock.client.uncertainLock = true
    await assert.rejects(failedLock.repository.remove(original, async () => { assert.fail('Uncertain lock'); }), /lost lock/)
    assert.equal(failedLock.client.destroyed, true)
  })

  it('destroys a session whose unlock cannot be confirmed and handles allocation-free revisions', async () => {
    const { client, repository } = fixture()
    client.record.request_id = null
    client.failUnlock = true
    assert.equal(await repository.remove({ ...original, requestId: null }, async () => false), 'remaining')
    assert.equal(client.destroyed, true)
    assert.equal(client.queries.filter(({ sql }) => sql.includes('pg_try_advisory_lock')).length, 1)
  })

  it('uses bound discovery inputs, skips empty key lookups and preserves microsecond expiry tokens', async () => {
    const { client, repository } = fixture()
    assert.deepEqual(await repository.findByStorageKeys([]), [])
    assert.equal(client.queries.length, 0)
    const [found] = await repository.findDue('previous-file', 7)
    assert.deepEqual(found, original)
    assert.deepEqual(client.queries[0]!.values, ['previous-file', 7])
    assert.match(client.queries[0]!.sql, /f\.scope_kind='temporary'/)
    assert.match(client.queries[0]!.sql, /statement_timestamp\(\)/)
    assert.equal((await repository.findByStorageKeys([original.storageKey]))[0]!.expiresAt, original.expiresAt)
    await assert.rejects(repository.findDue(null, 0), /batches/)
  })
})
