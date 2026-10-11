import * as fs from 'node:fs'
import { mkdtemp, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { assertCodexUnchanged, codexBinaryIdentity, codexExecutableIdentity } from './codexProtocol.js'

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) }
})
const directories: string[] = []
afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'codex-identity-'))
  directories.push(directory)
  const binary = join(directory, 'codex')
  await writeFile(binary, 'original', { mode: 0o700 })
  await utimes(binary, new Date(0), new Date(1000))
  return { directory, binary }
}

it('caches stable executable content while launch checks still hash directly', async () => {
  const f = await fixture()
  const identity = await codexBinaryIdentity(f.binary)
  expect(await codexBinaryIdentity(f.binary)).toBe(identity)
  expect(fs.createReadStream).toHaveBeenCalledTimes(1)
  await assertCodexUnchanged({ binary: f.binary, identity })
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
})

it.each(['overwrite', 'replace', 'symlink'] as const)('invalidates executable fingerprints after %s', async method => {
  const f = await fixture()
  const identity = await codexExecutableIdentity(f.binary)
  const before = await stat(f.binary)
  const replacement = join(f.directory, 'replacement')
  if (method === 'overwrite') {
    await writeFile(f.binary, 'modified')
    await utimes(f.binary, before.atime, before.mtime)
  } else {
    await writeFile(replacement, 'modified', { mode: 0o700 })
    await utimes(replacement, before.atime, before.mtime)
    if (method === 'replace') await rename(replacement, f.binary)
    else {
      await rm(f.binary)
      await symlink(replacement, f.binary)
    }
  }
  const changed = await codexExecutableIdentity(f.binary)
  expect(changed).not.toBe(identity)
  expect(await codexExecutableIdentity(f.binary)).toBe(changed)
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
})

it('rejects missing executable files instead of using their cached fingerprints', async () => {
  const f = await fixture()
  const original = await codexExecutableIdentity(f.binary)
  await rm(f.binary)
  await expect(codexExecutableIdentity(f.binary)).rejects.toThrow()
  await writeFile(f.binary, 'restored', { mode: 0o700 })
  const restored = await codexExecutableIdentity(f.binary)
  expect(restored).not.toBe(original)
  expect(await codexExecutableIdentity(f.binary)).toBe(restored)
  expect(fs.createReadStream).toHaveBeenCalledTimes(2)
})
