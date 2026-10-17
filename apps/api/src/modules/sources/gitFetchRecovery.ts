import { readFileSync, readdirSync, readlinkSync, statSync, type BigIntStats } from 'node:fs'
import { lstat, readdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { componentLogger } from '../diagnostics/logger.js'

/** What an interrupted fetch can leave in the common directory. Other writers' state (refs/heads, HEAD, index and
 * linked worktrees' files) is never touched. */
const FETCH_LOCKS = ['shallow.lock', 'FETCH_HEAD.lock', 'packed-refs.lock']
const FETCH_REF_NAMESPACES = ['refs/remotes', 'refs/foreman']
const TEMPORARY_PACK = /^tmp_(?:pack|idx|rev)_/u

function absent(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
}

function fileIdentity(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}` }

async function entries(directory: string, recursive = false): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true, recursive }))
      .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  } catch (error) {
    if (absent(error)) return []
    throw error
  }
}

async function fetchArtifacts(common: string): Promise<Map<string, string>> {
  const refLocks = (await Promise.all(FETCH_REF_NAMESPACES.map(namespace => entries(join(common, namespace), true))))
    .flat().filter(path => path.endsWith('.lock'))
  const packs = (await entries(join(common, 'objects', 'pack'))).filter(path => TEMPORARY_PACK.test(basename(path)))
  const found = new Map<string, string>()
  for (const path of [...FETCH_LOCKS.map(name => join(common, name)), ...refLocks, ...packs]) {
    try {
      const stat = await lstat(path, { bigint: true })
      if (stat.isFile()) found.set(path, fileIdentity(stat))
    } catch (error) {
      if (!absent(error)) throw error
    }
  }
  return found
}

/** Git changes to its worktree's top level (or its Git directory) before it writes, so every live writer of this
 * repository has one of these as its working directory. Inodes also match writers in other mount namespaces. */
function repositoryDirectories(common: string): Set<string> {
  const directories = [common, ...basename(common) === '.git' ? [dirname(common)] : []]
  let linked: string[] = []
  try { linked = readdirSync(join(common, 'worktrees')) } catch (error) {
    if (!absent(error)) throw error
  }
  for (const id of linked) {
    try { directories.push(dirname(readFileSync(join(common, 'worktrees', id, 'gitdir'), 'utf8').trim())) }
    catch (error) {
      if (!absent(error)) throw error
    }
  }
  const identities = new Set<string>()
  for (const directory of directories) {
    try { identities.add(fileIdentity(statSync(directory, { bigint: true }))) }
    catch (error) {
      if (!absent(error)) throw error
    }
  }
  return identities
}

function liveGitProcess(common: string): number | undefined {
  const directories = repositoryDirectories(common)
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/u.test(pid)) continue
    try {
      if (!directories.has(fileIdentity(statSync(`/proc/${pid}/cwd`, { bigint: true })))) continue
      // An exiting process loses its executable before its descriptors, so a killed transfer never counts here.
      if (basename(readlinkSync(`/proc/${pid}/exe`)).startsWith('git')) return Number(pid)
    } catch (error) {
      // ignore: the process exited, or it belongs to another user and cannot be inspected.
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  return undefined
}

/** The caller holds the repository lock, which every Main fetch writer inherits for its whole life, so none of them
 * survives (even when the API that started it died). Agents and people may also run Git in the repository, and their
 * locks look the same, so recovery waits while any other Git process works there. Returns whether it recovered. */
export async function removeAbandonedFetchArtifacts(common: string): Promise<boolean> {
  const artifacts = await fetchArtifacts(common)
  if (artifacts.size === 0) return true
  const writer = liveGitProcess(common)
  if (writer !== undefined) {
    componentLogger('byte-transfer').info({ pid: writer, common },
      'Fetch recovery waits for a live Git process in the repository; the next acquisition retries.')
    return false
  }
  for (const [path, listed] of artifacts) {
    try {
      // A writer that finished after the listing may have committed this name, and a newer one reused it.
      if (fileIdentity(await lstat(path, { bigint: true })) === listed) await unlink(path)
    } catch (error) {
      if (!absent(error)) throw error
    }
  }
  return true
}
