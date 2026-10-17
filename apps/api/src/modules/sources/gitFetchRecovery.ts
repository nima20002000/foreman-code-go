import { lstat, readdir, unlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { basename, join } from 'node:path'
import { componentLogger } from '../diagnostics/logger.js'

/** What an interrupted fetch can leave in the common directory. Other writers' state (refs/heads, HEAD, index and
 * linked worktrees' files) is never touched. */
const FETCH_LOCKS = ['shallow.lock', 'FETCH_HEAD.lock', 'packed-refs.lock']
const FETCH_REF_NAMESPACES = ['refs/remotes', 'refs/foreman']
const TEMPORARY_PACK = /^tmp_(?:pack|idx|rev)_/u
/** Ref transactions and index-pack's close-to-rename last well under a second, and a receiving pack keeps growing. */
const STALE_MS = 5 * 60_000

function absent(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
}

async function entries(directory: string, recursive = false): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true, recursive }))
      .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  } catch (error) {
    if (absent(error)) return []
    throw error
  }
}

/** The caller holds the repository lock, which every Main fetch writer inherits for its whole life, so none of them
 * is alive. Other Git processes (Agents, people) may still write here, so an artifact is abandoned only once it has
 * stayed unchanged past the staleness bound. Returns the fresh artifacts, which are left alone. */
export async function removeAbandonedFetchArtifacts(common: string): Promise<string[]> {
  const refLocks = (await Promise.all(FETCH_REF_NAMESPACES.map(namespace => entries(join(common, namespace), true))))
    .flat().filter(path => path.endsWith('.lock'))
  const packs = (await entries(join(common, 'objects', 'pack'))).filter(path => TEMPORARY_PACK.test(basename(path)))
  const fresh: string[] = []
  for (const path of [...FETCH_LOCKS.map(name => join(common, name)), ...refLocks, ...packs]) {
    try {
      const stat = await lstat(path)
      if (!stat.isFile()) continue
      if (Date.now() - stat.mtimeMs < STALE_MS) fresh.push(path)
      else await unlink(path)
    } catch (error) {
      if (!absent(error)) throw error
    }
  }
  return fresh
}

/** Git cannot fetch past another writer's lock, so wait (recovering locks as they go stale) within `signal`. */
export async function awaitFetchLocks(common: string, signal: AbortSignal): Promise<void> {
  let logged = false
  while ((await removeAbandonedFetchArtifacts(common)).some(path => path.endsWith('.lock'))) {
    if (!logged) componentLogger('byte-transfer').info({ common }, 'Fetch waits for a fresh Git lock in the repository.')
    logged = true
    await delay(1000, undefined, { signal })
  }
}
