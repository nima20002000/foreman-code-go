import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import { workerOpenCodeStorageRoot } from './workerOpenCodeStorage.js'

it('protects existing Main storage without creating or replacing its bytes', async () => {
  const state = await privateFixtureDirectory('worker-vault-selection-')
  const vault = join(state, 'main-vault')
  try {
    await mkdir(vault, { mode: 0o700 })
    const before = await lstat(vault)
    expect(await workerOpenCodeStorageRoot(state, { bootId: bootIdentity(), storageRoot: vault })).toBe(vault)
    expect(await lstat(vault)).toMatchObject({ dev: before.dev, ino: before.ino })
    expect(await readdir(vault)).toEqual([])
  } finally { await rm(state, { recursive: true, force: true }) }
})

it('refuses absent local storage and aliases instead of manufacturing a source vault', async () => {
  const state = await privateFixtureDirectory('worker-vault-refusal-')
  const vault = join(state, 'main-vault')
  try {
    await expect(workerOpenCodeStorageRoot(state, undefined))
      .rejects.toMatchObject({ code: 'FILE_SOURCE_ISOLATION_REQUIRED' })
    await expect(workerOpenCodeStorageRoot(state, { bootId: bootIdentity(), storageRoot: vault }))
      .rejects.toMatchObject({ code: 'FILE_SOURCE_ISOLATION_REQUIRED', cause: { code: 'ENOENT' } })
    await mkdir(vault, { mode: 0o700 })
    const alias = join(state, 'alias')
    await symlink(vault, alias)
    await expect(workerOpenCodeStorageRoot(state, { bootId: bootIdentity(), storageRoot: alias }))
      .rejects.toMatchObject({ code: 'FILE_SOURCE_ISOLATION_REQUIRED' })
  } finally { await rm(state, { recursive: true, force: true }) }
})

it('uses a private Worker vault only when the advertised remote storage is absent here', async () => {
  const state = await privateFixtureDirectory('worker-remote-vault-')
  try {
    const source = { bootId: randomUUID(), storageRoot: join(state, 'remote-only-vault') }
    const vault = await workerOpenCodeStorageRoot(state, source)
    expect(await readdir(vault)).toEqual([])
    expect((await lstat(vault)).mode & 0o077).toBe(0)
    await expect(lstat(source.storageRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(state, { recursive: true, force: true }) }
})
