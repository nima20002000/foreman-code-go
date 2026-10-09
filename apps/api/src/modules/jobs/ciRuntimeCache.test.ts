import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { readCiRuntimeCache, writeCiRuntimeCache } from './ciRuntimeCache.js'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const installer = await privateFixtureDirectory('ci-image-cache-')
  directories.push(installer)
  const prepared = {
    commit: 'a'.repeat(40),
    imageId: 'sha256:' + 'b'.repeat(64),
    imageManifestDigest: 'sha256:' + 'c'.repeat(64),
    seedReceiptPath: join(installer, 'seed-receipt.json'),
    contextReceiptPath: join(installer, 'context-receipt.json'),
    qualificationSource: join(installer, 'original-source'),
  }
  await mkdir(prepared.qualificationSource)
  await writeFile(prepared.seedReceiptPath, 'reviewed seed', { mode: 0o600 })
  await writeFile(prepared.contextReceiptPath, 'installed controls', { mode: 0o600 })
  const input = { installer, prepared, inputDigest: 'd'.repeat(64) }
  await writeCiRuntimeCache(input)
  return { ...input, imageExists: vi.fn(async () => true) }
}

it('reuses an immutable image and its verified receipts without claiming source qualification', async () => {
  const f = await fixture()
  await rm(f.prepared.qualificationSource, { recursive: true })
  const cached = await readCiRuntimeCache(f)
  expect(cached).toEqual({
    imageId: f.prepared.imageId,
    imageManifestDigest: f.prepared.imageManifestDigest,
    seedReceiptPath: f.prepared.seedReceiptPath,
    contextReceiptPath: f.prepared.contextReceiptPath,
  })
  expect(f.imageExists).toHaveBeenCalledWith(f.prepared.imageId)
  expect(await readFile(f.prepared.seedReceiptPath, 'utf8')).toBe('reviewed seed')
})

it.each(['dependency-inputs', 'missing-image', 'seed-receipt', 'context-receipt'] as const)(
  'rebuilds after changed or unavailable %s', async change => {
    const f = await fixture()
    if (change === 'dependency-inputs') f.inputDigest = 'e'.repeat(64)
    if (change === 'missing-image') f.imageExists.mockResolvedValue(false)
    if (change === 'seed-receipt') await writeFile(f.prepared.seedReceiptPath, 'changed seed')
    if (change === 'context-receipt') await rm(f.prepared.contextReceiptPath)
    expect(await readCiRuntimeCache(f)).toBeNull()
  })

it('does not read cache artifacts outside the installation', async () => {
  const f = await fixture()
  await expect(writeCiRuntimeCache({ ...f,
    prepared: { ...f.prepared, seedReceiptPath: '/another-installation/seed.json' },
  })).rejects.toThrow('belong to the installed runtime')
})
