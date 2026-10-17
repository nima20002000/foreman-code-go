import { AsyncLocalStorage } from 'node:async_hooks'
import type pg from 'pg'
import { componentLogger } from '../diagnostics/logger.js'

type SourceUse = { pool: pg.Pool; client: pg.PoolClient; snapshots: Set<string> }
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
  const client = await pool.connect()
  let failure: Error | undefined
  const onError = (error: Error) => {
    failure = error
    componentLogger('db').error({ err: error, workspaceId }, 'Run source-use connection failed')
  }
  client.on('error', onError)
  try {
    const result = await preparing.run({ pool, client, snapshots: new Set() }, work)
    if (failure) throw failure
    return result
  } finally {
    client.removeListener('error', onError)
    // Session locks must not survive in an idle pooled connection.
    client.release(true)
  }
}
