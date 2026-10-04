import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { link, open, readdir, rename, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { bootIdentity, identityAlive, processIdentity } from '../../harnesses/recovery/linuxIdentity.js'

const ServiceOwnerSchema = z.object({
  version: z.literal(1), ownerId: z.uuid(), bootId: z.uuid(),
  pid: z.number().int().min(2), startTicks: z.string().regex(/^[0-9]+$/),
}).strict()

async function assertLegacyOwnerClosed(file: Awaited<ReturnType<typeof open>>) {
  const owner = await file.stat()
  if (!owner.isFile() || owner.nlink !== 1 || (owner.mode & 0o077)
    || owner.uid !== process.getuid?.()) throw new Error('Unsafe legacy journal owner record')
  // Legacy owners retain this inode's descriptor until close. Scan that kernel
  // ownership before upgrading, rather than treating an unknown UUID as stale.
  for (const pid of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(pid)) continue
    try {
      if ((await stat(`/proc/${pid}`)).uid !== owner.uid) continue
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        if (Number(pid) === process.pid && Number(fd) === file.fd) continue
        try {
          const descriptor = await stat(`/proc/${pid}/fd/${fd}`)
          if (descriptor.dev === owner.dev && descriptor.ino === owner.ino) {
            throw Object.assign(new Error('Legacy journal service owner is still alive'), { code: 'EEXIST' })
          }
        } catch (error) {
          if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        }
      }
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
}

export async function acquireJournalOwner(path: string) {
  const ownerPath = `${path}.owner-lock`
  const guard = await open(`${path}.owner-guard`, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  let file: Awaited<ReturnType<typeof open>> | undefined
  let temporary: string | undefined
  let published = false
  let recovered = false
  try {
    // flock locks the inherited open file description, retained here after its child exits.
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', guard.fd],
      })
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0) resolve()
        else reject(Object.assign(new Error('Journal already owned'), { code: 'EEXIST' }))
      })
    })
    const bootId = bootIdentity()
    try {
      const priorFile = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      let ownerId: string
      try {
        if ((await priorFile.stat()).size > 1024) throw new Error('Journal service owner record is too large')
        const serialized = await priorFile.readFile('utf8')
        const legacy = z.uuid().safeParse(serialized)
        if (legacy.success) {
          await assertLegacyOwnerClosed(priorFile)
          ownerId = legacy.data
        } else {
          const prior = ServiceOwnerSchema.parse(JSON.parse(serialized))
          if (prior.bootId === bootId && identityAlive(prior)) {
            throw Object.assign(new Error('Journal service owner is still alive'), { code: 'EEXIST' })
          }
          ownerId = prior.ownerId
        }
      } finally {
        await priorFile.close()
      }
      // Retain the stale service identity. Native descendants remain governed by the journal's receipts.
      await rename(ownerPath, `${path}.retired-owner-${ownerId}.json`)
      recovered = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const identity = processIdentity(process.pid)
    if (!identity) throw new Error('Journal service process identity unavailable')
    temporary = `${ownerPath}.${randomUUID()}.tmp`
    file = await open(temporary, 'wx', 0o600)
    await file.writeFile(JSON.stringify(ServiceOwnerSchema.parse({
      version: 1, ownerId: randomUUID(), bootId, pid: identity.pid, startTicks: identity.startTicks,
    })))
    await file.sync()
    // Publish complete metadata without replacing a concurrent legacy owner.
    await link(temporary, ownerPath)
    published = true
    await unlink(temporary)
    temporary = undefined
    const owned = file
    let closed = false
    return { recovered, async close() {
      if (closed) return
      closed = true
      try {
        await unlink(ownerPath)
      } finally {
        await owned.close()
        await guard.close()
      }
    } }
  } catch (error) {
    if (file) {
      await file.close()
      if (published) await unlink(ownerPath)
    }
    if (temporary) await unlink(temporary)
    await guard.close()
    throw error
  }
}
