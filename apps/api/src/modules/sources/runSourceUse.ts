import { AsyncLocalStorage } from 'node:async_hooks'
import pg from 'pg'
import { componentLogger } from '../diagnostics/logger.js'

type SourceUse = { pool: pg.Pool; client: pg.Client; snapshots: Set<string> }
const preparing = new AsyncLocalStorage<SourceUse>()

export function runSourceUseKey(snapshotId: string): string {
  return `run-source-use:${snapshotId}`
}

/** Called while the snapshot's shared row lock still excludes retention. */
export async function retainRunSource(pool: pg.Pool, snapshotId: string): Promise<void> {
  const use = preparing.getStore()
  if (!use || use.pool !== pool || use.snapshots.has(snapshotId)) return
  await use.client.query('select pg_advisory_lock_shared(hashtext($1))', [runSourceUseKey(snapshotId)])
  use.snapshots.add(snapshotId)
}

/** Keep database references from capture through Run commit, including host I/O between transactions. */
export async function withRunSourceUse<T>(pool: pg.Pool, workspaceId: string, work: () => Promise<T>): Promise<T> {
  // A waiting Start must not occupy a pool slot needed by its own source preparation.
  const client = new pg.Client(pool.options)
  let failure: Error | undefined
  client.on('error', error => {
    failure = error
    componentLogger('db').error({ err: error, workspaceId }, 'Run source-use connection failed')
  })
  try {
    await client.connect()
    const result = await preparing.run({ pool, client, snapshots: new Set() }, work)
    if (failure) throw failure
    return result
  } finally {
    await client.end()
  }
}
