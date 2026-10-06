import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { assertWorkerOpenCodeFileHost } from './workerOpenCodeFileHost.js'

it('checks the native OS identity even when the Main vault is absent on another host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foreman-worker-source-check-'))
  try {
    const source = { bootId: randomUUID(), storageRoot: join(root, 'absent-vault') }
    await expect(assertWorkerOpenCodeFileHost(0, source, AbortSignal.timeout(5000)))
      .rejects.toMatchObject({ code: 'FILE_SOURCE_ISOLATION_REQUIRED' })
    const result = assertWorkerOpenCodeFileHost(process.pid, source, AbortSignal.timeout(5000))
    if (process.geteuid?.() === 0) {
      await expect(result).rejects.toMatchObject({ code: 'FILE_SOURCE_ISOLATION_REQUIRED' })
    } else {
      await expect(result).resolves.toBeUndefined()
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a same-host writable vault instead of treating a paired installation as source isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foreman-worker-local-vault-'))
  try {
    const code = process.geteuid?.() === 0 ? 'FILE_SOURCE_ISOLATION_REQUIRED' : 'FILE_SOURCE_WRITABLE'
    await expect(assertWorkerOpenCodeFileHost(process.pid, { bootId: bootIdentity(), storageRoot: root },
      AbortSignal.timeout(5000))).rejects.toMatchObject({ code })
  } finally { await rm(root, { recursive: true, force: true }) }
})
