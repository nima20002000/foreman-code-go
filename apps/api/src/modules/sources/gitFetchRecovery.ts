import { readFileSync, readdirSync, readlinkSync, statSync, type BigIntStats } from 'node:fs'
import { lstat, readdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
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

/** Lookups in another process's view: it may have exited, belong to another user, or name missing paths. */
function unavailable(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR', 'ESRCH', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG']
    .includes((error as NodeJS.ErrnoException).code ?? '')
}

/** A regular file's content as `pid` sees it; directories and special files (which could block) are skipped. */
function readIn(pid: string, path: string): string | undefined {
  const visible = `/proc/${pid}/root${path}`
  try { return statSync(visible).isFile() ? readFileSync(visible, 'utf8') : undefined }
  catch (error) {
    if (unavailable(error)) return undefined
    throw error
  }
}

/** Git's own discovery, seen through the process's root so writers in other mount namespaces resolve too:
 * GIT_DIR/GIT_COMMON_DIR, `--git-dir` and `-C`, then every directory up from its working directory, each itself or
 * through its `.git` directory or `gitdir:` file. Checking every candidate is a superset of the one Git chose. */
function gitDirectories(pid: string): string[] {
  const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
  const explicit = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
    .flatMap(variable => /^GIT_(?:COMMON_)?DIR=(.+)$/su.exec(variable)?.[1] ?? [])
  let directory = readlinkSync(`/proc/${pid}/cwd`)
  for (let index = 1; args[index]?.startsWith('-'); index++) {
    const option = args[index]!
    if (option === '-C') directory = resolve(directory, args[++index] ?? '')
    else if (option === '--git-dir') explicit.push(args[++index] ?? '')
    else if (option.startsWith('--git-dir=')) explicit.push(option.slice('--git-dir='.length))
    else if (['-c', '--work-tree', '--namespace', '--config-env'].includes(option)) index++
  }
  const candidates = explicit.map(path => resolve(directory, path))
  for (let current = directory; ; current = dirname(current)) {
    const linked = /^gitdir: (.+)$/mu.exec(readIn(pid, join(current, '.git')) ?? '')?.[1]
    candidates.push(current, join(current, '.git'), ...linked ? [resolve(current, linked.trim())] : [])
    if (current === dirname(current)) return candidates
  }
}

function usesCommonDirectory(pid: string, gitDirectory: string, common: string): boolean {
  const shared = readIn(pid, join(gitDirectory, 'commondir'))?.trim()
  try {
    return fileIdentity(statSync(`/proc/${pid}/root${shared ? resolve(gitDirectory, shared) : gitDirectory}`,
      { bigint: true })) === common
  } catch (error) {
    if (unavailable(error)) return false
    throw error
  }
}

/** Git closes a lock's descriptor once it is written and keeps only its name until commit, so the owner of a prepared
 * lock is any live Git process whose repository is this one, wherever it runs from. */
function repositoryWriter(common: string): number | undefined {
  const target = fileIdentity(statSync(common, { bigint: true }))
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/u.test(pid)) continue
    try {
      // An exiting process loses its executable before its descriptors, so a killed transfer never counts here.
      if (!basename(readlinkSync(`/proc/${pid}/exe`)).startsWith('git')) continue
      if (gitDirectories(pid).some(directory => usesCommonDirectory(pid, directory, target))) return Number(pid)
    } catch (error) {
      // ignore: the process exited, or it belongs to another user and cannot be inspected.
      if (!unavailable(error)) throw error
    }
  }
  return undefined
}

/** Identities of open files with one of these names, in any process. Names are compared before following a
 * descriptor, so unrelated (possibly hung) filesystems are never touched. */
function openFiles(names: Set<string>): Set<string> {
  const open = new Set<string>()
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/u.test(pid)) continue
    let descriptors: string[]
    try { descriptors = readdirSync(`/proc/${pid}/fd`) } catch (error) {
      // ignore: the process exited, or it belongs to another user and cannot be inspected.
      if (unavailable(error)) continue
      throw error
    }
    for (const descriptor of descriptors) {
      const path = `/proc/${pid}/fd/${descriptor}`
      try {
        if (names.has(basename(readlinkSync(path).replace(/ \(deleted\)$/u, '')))) {
          open.add(fileIdentity(statSync(path, { bigint: true })))
        }
      } catch (error) {
        // ignore: the descriptor or its process closed during the scan.
        if (!unavailable(error)) throw error
      }
    }
  }
  return open
}

/** The caller holds the repository lock, which every Main fetch writer inherits for its whole life, so none of them
 * survives (even when the API that started it died). Agents and people may also run Git in the repository, so each
 * artifact needs evidence that no writer owns it. Index-pack keeps its pack open until it has renamed all of its
 * outputs, so temporary packs are abandoned once none is open anywhere; readers of committed packs never matter.
 * Locks wait for every live Git process of this repository. Returns whether everything was recovered. */
export async function removeAbandonedFetchArtifacts(common: string): Promise<boolean> {
  const artifacts = [...await fetchArtifacts(common)]
  if (artifacts.length === 0) return true
  const packs = artifacts.filter(([path]) => TEMPORARY_PACK.test(basename(path)))
  const locks = artifacts.filter(artifact => !packs.includes(artifact))
  const open = packs.length ? openFiles(new Set(packs.map(([path]) => basename(path)))) : new Set<string>()
  const writing = packs.some(([, listed]) => open.has(listed))
  const writer = locks.length ? repositoryWriter(common) : undefined
  const abandoned = [...writing ? [] : packs, ...writer === undefined ? locks : []]
  if (abandoned.length < artifacts.length) {
    componentLogger('byte-transfer').info({ common, ...writer === undefined ? {} : { pid: writer }, writing },
      'Fetch recovery waits for a live Git writer in the repository; the next acquisition retries.')
  }
  for (const [path, listed] of abandoned) {
    try {
      // A writer that finished after the listing may have committed this name, and a newer one reused it.
      if (fileIdentity(await lstat(path, { bigint: true })) === listed) await unlink(path)
    } catch (error) {
      if (!absent(error)) throw error
    }
  }
  return abandoned.length === artifacts.length
}
