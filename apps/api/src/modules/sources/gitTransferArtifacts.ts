import { constants, readFileSync, readdirSync, statSync, watch, type BigIntStats, type FSWatcher } from 'node:fs'
import { lstat, open, readFile, unlink } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { componentLogger } from '../diagnostics/logger.js'

const ArtifactSchema = z.object({
  path: z.string(), device: z.string(), inode: z.string(), born: z.string(),
}).strict()
type Artifact = z.infer<typeof ArtifactSchema>
export interface GitTransferArtifacts { common: string; journal: string; reservationFd: number }

function artifactPath(path: string): boolean {
  if (isAbsolute(path) || path.split('/').some(part => part === '..' || part === '.')) return false
  return ['shallow.lock', 'FETCH_HEAD.lock', 'packed-refs.lock'].includes(path)
    || path.startsWith('refs/') && path.endsWith('.lock')
    || /^objects\/pack\/tmp_(?:pack|idx|rev)_[^/]+$/u.test(path)
}

function vanished(error: unknown): boolean {
  return ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')
}

function sameFile(stat: BigIntStats, artifact: Artifact): boolean {
  return String(stat.dev) === artifact.device && String(stat.ino) === artifact.inode
    && String(stat.birthtimeNs) === artifact.born
}

/** Only a writable descriptor in this transfer's process group can establish artifact ownership. */
function writerOwnsFile(pid: number, artifact: Artifact, reservation: BigIntStats): boolean {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/u.test(entry)) continue
    try {
      const text = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
      if (Number(fields[2]) !== pid || ['Z', 'X'].includes(fields[0]!)) continue
      let ownsReservation = false
      let writesArtifact = false
      for (const fd of readdirSync(`/proc/${entry}/fd`)) {
        const path = `/proc/${entry}/fd/${fd}`
        const stat = statSync(path, { bigint: true })
        if (stat.dev === reservation.dev && stat.ino === reservation.ino) ownsReservation = true
        if (!sameFile(stat, artifact)) continue
        const info = readFileSync(`/proc/${entry}/fdinfo/${fd}`, 'utf8')
        const flags = /^flags:\s*([0-7]+)/mu.exec(info)?.[1]
        if (flags && (parseInt(flags, 8) & 3) !== constants.O_RDONLY) writesArtifact = true
      }
      if (ownsReservation && writesArtifact) return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        componentLogger('byte-transfer').warn({ err: error, pid: Number(entry) },
          'Git writer descriptors are unavailable; leaving unconfirmed artifacts untouched.')
        continue
      }
      if (!vanished(error)) throw error
      // A closing process or descriptor cannot establish ownership in this scan.
    }
  }
  return false
}

/** Unobserved files are deliberately left alone: absence before a fetch does not prove who created them. */
export async function recordGitTransferArtifacts(input: GitTransferArtifacts) {
  const reservation = statSync(`/proc/self/fd/${input.reservationFd}`, { bigint: true })
  const journal = await open(input.journal, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
  let pid: number | undefined
  let pending = Promise.resolve()
  let failure: unknown
  const recorded = new Set<string>()
  const capture = async (path: string) => {
    if (pid === undefined) return
    let stat: BigIntStats
    try { stat = await lstat(resolve(input.common, path), { bigint: true }) }
    catch (error) {
      if (vanished(error)) return
      throw error
    }
    if (!stat.isFile()) return
    const artifact = { path, device: String(stat.dev), inode: String(stat.ino), born: String(stat.birthtimeNs) }
    const key = JSON.stringify(artifact)
    if (recorded.has(key) || !writerOwnsFile(pid, artifact, reservation)) return
    await journal.writeFile(key + '\n')
    await journal.sync()
    recorded.add(key)
  }
  let watcher: FSWatcher
  try {
    watcher = watch(input.common, { recursive: true }, (_event, filename) => {
      if (!filename || !artifactPath(filename)) return
      pending = pending.then(() => capture(filename)).catch(error => { failure ??= error })
    })
    watcher.on('error', error => { failure ??= error })
  } catch (error) {
    await journal.close()
    throw error
  }
  return {
    started(childPid: number) { pid = childPid },
    async close() {
      watcher.close()
      try {
        await pending
        if (failure) throw failure
      } finally { await journal.close() }
    },
  }
}

/** The caller has both the repository lock and confirmed closure of the reservation's writers. */
export async function removeGitTransferArtifacts(common: string, journal: string): Promise<void> {
  let bytes: string
  try { bytes = await readFile(journal, 'utf8') }
  catch (error) {
    if (vanished(error)) return
    throw error
  }
  // An interrupted append cannot establish ownership; retain only complete records.
  const lines = bytes.split('\n').slice(0, -1)
  for (const line of lines) {
    const artifact = ArtifactSchema.parse(JSON.parse(line))
    if (!artifactPath(artifact.path)) throw new Error('Git transfer artifact path is invalid.')
    const path = resolve(common, artifact.path)
    try {
      const stat = await lstat(path, { bigint: true })
      if (stat.isFile() && sameFile(stat, artifact)) await unlink(path)
    } catch (error) {
      if (!vanished(error)) throw error
    }
  }
}
