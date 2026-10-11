import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

async function cacheEntryExists(directory) {
  try {
    const entry = await lstat(directory)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Invalid fixture cache entry')
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function lockCacheEntry(handle) {
  // The inherited descriptor shares the lock until this parent closes it.
  await new Promise((resolve, reject) => {
    const child = spawn('flock', ['--exclusive', '3'], {
      stdio: ['ignore', 'ignore', 'inherit', handle.fd],
    })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`Fixture cache lock failed (${code})`))
    })
  })
}

/** Only immutable setup output is shared. Rename publishes a complete entry. */
export async function cachedTestFixture(root, namespace, inputs, populate) {
  const hash = createHash('sha256')
  for (const input of inputs) {
    hash.update(String(Buffer.byteLength(input)))
    hash.update(':')
    hash.update(input)
  }
  const parent = join(root, namespace)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const key = hash.digest('hex')
  const directory = join(parent, key)
  if (await cacheEntryExists(directory)) return directory
  const handle = await open(join(parent, `${key}.lock`), 'a', 0o600)
  try {
    await lockCacheEntry(handle)
    if (await cacheEntryExists(directory)) return directory
    const temporary = await mkdtemp(join(parent, `${key}.pending-`))
    try {
      await populate(temporary)
      await rename(temporary, directory)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
    return directory
  } finally {
    await handle.close()
  }
}
