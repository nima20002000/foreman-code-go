import { readdir, readlink, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

function belongsToDirectory(directory: string, cwd: string): boolean {
  const path = relative(directory, cwd)
  return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

/** Resource cleanup observes OS ownership, never private product records or scenario answers. */
async function ownedProcessIds(directory: string): Promise<number[]> {
  const uid = process.getuid?.()
  if (process.platform !== 'linux' || uid === undefined) {
    throw new Error('Conformance cleanup requires Linux /proc process ownership observations')
  }
  const owned: number[] = []
  for (const entry of await readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) continue
    const processDirectory = join('/proc', entry.name)
    try {
      if ((await stat(processDirectory)).uid !== uid) continue
      const cwd = await readlink(join(processDirectory, 'cwd'))
      if (belongsToDirectory(directory, cwd)) owned.push(Number(entry.name))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ESRCH') continue
      throw new Error(`Could not establish process ${entry.name} cleanup ownership`, { cause: error })
    }
  }
  return owned.sort((left, right) => left - right)
}

/** Detached guardians can outlive the API group; retain their state if closure is unproven. */
export async function waitForOwnedProcessesToExit(directory: string, timeoutMs = 5000): Promise<void> {
  if (!isAbsolute(directory) || resolve(directory) === sep) throw new Error('An owned absolute resource directory is required')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const owned = await ownedProcessIds(directory)
    if (owned.length === 0) return
    if (Date.now() >= deadline) {
      throw new Error(`Owned conformance processes remain after shutdown: ${owned.join(', ')}`)
    }
    await delay(50)
  }
}
