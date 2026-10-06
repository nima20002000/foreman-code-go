import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { assertWorkerOpenCodeFileHost } from './workerOpenCodeFileHost.js'
import { OpenCodeFileError } from '../harnesses/opencodeFiles/types.js'
import type { OpenCodeServerController } from '../harnesses/opencodeTransport.js'

function server(assertFileSourceIsolation?: OpenCodeServerController['assertFileSourceIsolation']): OpenCodeServerController {
  return { expectedVersion: 'recorded', ensure: async () => {}, request: async () => new Response(),
    dispose: async () => {}, ...(assertFileSourceIsolation ? { assertFileSourceIsolation } : {}) }
}

// The kernel namespace gate is covered by opencode-vault-isolation.test.ts; this verifies its Worker composition.
it('requires the native namespace verifier even when Main storage is absent on another host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foreman-worker-source-check-'))
  try {
    const source = { bootId: randomUUID(), storageRoot: join(root, 'absent-vault') }
    await expect(assertWorkerOpenCodeFileHost(server(), root, source, AbortSignal.timeout(5000)))
      .rejects.toMatchObject({ code: 'FILE_SOURCE_ISOLATION_REQUIRED' })
    const verify = vi.fn(async () => {})
    const signal = AbortSignal.timeout(5000)
    await expect(assertWorkerOpenCodeFileHost(server(verify), root, source, signal)).resolves.toBeUndefined()
    expect(verify).toHaveBeenCalledExactlyOnceWith(root, signal)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('propagates a writable source or unverified namespace refusal before file access', async () => {
  const verify = vi.fn(async () => { throw new OpenCodeFileError('FILE_SOURCE_WRITABLE', 'The source is writable.') })
  await expect(assertWorkerOpenCodeFileHost(server(verify), '/protected-vault',
    { bootId: bootIdentity(), storageRoot: '/protected-vault' }, AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ code: 'FILE_SOURCE_WRITABLE' })
})

it('rejects a vault outside the verified namespace on the same host or at an existing remote path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'foreman-worker-local-vault-'))
  try {
    for (const bootId of [bootIdentity(), randomUUID()]) {
      await expect(assertWorkerOpenCodeFileHost(server(async () => {}), '/another-protected-vault',
        { bootId, storageRoot: root }, AbortSignal.timeout(5000)))
        .rejects.toMatchObject({ code: 'FILE_SOURCE_ISOLATION_REQUIRED' })
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})
