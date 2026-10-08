import { mkdtemp, mkdir, rm, symlink, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readNativeUserFile } from './nativeConfigFiles.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'native-config-file-'))
  directories.push(directory)
  return directory
}

it('reads an absent Codex user file as an empty document without creating it', async () => {
  const directory = await fixture()
  const file = join(directory, 'config.toml')
  expect(await readNativeUserFile(file, { whenMissing: '', requireDirectory: true })).toBe('')
  await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(file, 'model = "qualified-model"\n', { mode: 0o600 })
  expect(await readNativeUserFile(file, { whenMissing: '', requireDirectory: true }))
    .toBe('model = "qualified-model"\n')
})

it('preserves an optional missing-file value and required-file failures', async () => {
  const directory = await fixture()
  const file = join(directory, 'missing', 'config.toml')
  expect(await readNativeUserFile(file, { whenMissing: '' })).toBe('')
  await expect(readNativeUserFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readNativeUserFile(file, { whenMissing: '', requireDirectory: true }))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects linked directories and linked files even when a missing-file value is allowed', async () => {
  const directory = await fixture()
  const actual = join(directory, 'actual')
  await mkdir(actual)
  const linked = join(directory, 'linked')
  await symlink(actual, linked)
  const options = { whenMissing: '', requireDirectory: true }
  await expect(readNativeUserFile(join(linked, 'config.toml'), options))
    .rejects.toMatchObject({ code: 'MCP_CONFIG_SYMLINK' })
  const file = join(actual, 'config.toml')
  await writeFile(file, 'model = "qualified-model"\n')
  const linkedFile = join(directory, 'config.toml')
  await symlink(file, linkedFile)
  await expect(readNativeUserFile(linkedFile, options)).rejects.toMatchObject({ code: 'ELOOP' })
})
