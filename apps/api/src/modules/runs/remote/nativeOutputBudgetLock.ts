import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises'
import { z } from 'zod'
import { bootIdentity, identityAlive, processIdentity } from '../../harnesses/recovery/linuxIdentity.js'
import { anchored, identity } from '../../sources/privateFilesystem.js'
import { DomainError } from '../../errors.js'

const Owner = z.object({ version: z.literal(1), ownerId: z.uuid(), bootId: z.uuid(),
  pid: z.number().int().min(2), startTicks: z.string().regex(/^[0-9]+$/) }).strict()
const pending = new Map<string, number>()
const queueLimit = 128
const unavailable = () => new DomainError('WORKER_NATIVE_OUTPUT_STORAGE_UNAVAILABLE',
  'Native output budget ownership cannot be verified.', 409)

async function readOwner(root: FileHandle) {
  let file: FileHandle
  try {
    file = await open(anchored(root, '.native-output-budget-owner.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
      || stat.mode & 0o077 || stat.size > 1024) throw unavailable()
    return Owner.parse(JSON.parse(await file.readFile('utf8')))
  } finally {
    await file.close()
  }
}

async function retireLegacyLock(root: FileHandle, stoppedWorker: boolean) {
  const path = anchored(root, '.native-output-budget.lock')
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  // The previous worker holds the same service lock for the entire budget transaction.
  if (!stoppedWorker || !stat.isDirectory() || stat.uid !== process.getuid?.()
    || stat.mode & 0o077 || (await readdir(path)).length !== 0) throw unavailable()
  await rename(path, anchored(root, `.native-output-budget-retired-lock-${randomUUID()}`))
  await root.sync()
}

async function waitForLock(guard: FileHandle, signal?: AbortSignal) {
  const bounded = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])])
  bounded.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    // The inherited open file description retains flock after its child exits.
    const child = spawn('/usr/bin/flock', ['--exclusive', '--wait', '10', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', guard.fd], signal: bounded,
    })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve()
      else reject(new DomainError('WORKER_NATIVE_OUTPUT_BUDGET_BUSY',
        'Native output budget transaction timed out.', 503))
    })
  })
  signal?.throwIfAborted()
}

export async function acquireNativeOutputBudgetLock(root: FileHandle, options: {
  signal?: AbortSignal | undefined
  stoppedWorker?: boolean | undefined
} = {}) {
  const key = JSON.stringify(await identity(root))
  const count = pending.get(key) ?? 0
  if (count >= queueLimit) throw new DomainError('WORKER_NATIVE_OUTPUT_BUDGET_BUSY',
    'Native output budget transaction queue is full.', 503)
  pending.set(key, count + 1)
  let guard: FileHandle | undefined
  let owner: z.infer<typeof Owner> | undefined
  let temporary: string | undefined
  try {
    guard = await open(anchored(root, '.native-output-budget.guard'),
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    const stat = await guard.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw unavailable()
    await waitForLock(guard, options.signal)
    await retireLegacyLock(root, options.stoppedWorker === true)
    const prior = await readOwner(root)
    const bootId = bootIdentity()
    if (prior) {
      if (prior.bootId === bootId && identityAlive(prior)) throw unavailable()
      await rename(anchored(root, '.native-output-budget-owner.json'),
        anchored(root, `.native-output-budget-retired-owner-${prior.ownerId}.json`))
      await root.sync()
    }
    const processOwner = processIdentity(process.pid)
    if (!processOwner) throw unavailable()
    const replacement = Owner.parse({ version: 1, ownerId: randomUUID(), bootId,
      pid: processOwner.pid, startTicks: processOwner.startTicks })
    temporary = `.native-output-budget-owner-${replacement.ownerId}.tmp`
    const file = await open(anchored(root, temporary), 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(replacement))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(anchored(root, temporary), anchored(root, '.native-output-budget-owner.json'))
    temporary = undefined
    owner = replacement
    await root.sync()
    const held = guard
    let closed = false
    return { async close() {
      if (closed) return
      closed = true
      try {
        const persisted = await readOwner(root)
        if (persisted?.ownerId !== replacement.ownerId) throw unavailable()
        await unlink(anchored(root, '.native-output-budget-owner.json'))
        await root.sync()
      } finally {
        await held.close()
      }
    } }
  } catch (error) {
    try {
      if (owner) await unlink(anchored(root, '.native-output-budget-owner.json'))
      if (temporary) await unlink(anchored(root, temporary))
    } finally {
      await guard?.close()
    }
    throw error
  } finally {
    const remaining = (pending.get(key) ?? 1) - 1
    if (remaining) pending.set(key, remaining)
    else pending.delete(key)
  }
}
