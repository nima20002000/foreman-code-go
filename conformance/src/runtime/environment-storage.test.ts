import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'
import { createIsolatedEnvironment, type IsolatedEnvironment } from './environment.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

// Fixture mutations are limited to children of the public API's disposable root.
async function ownedChild(resources: IsolatedEnvironment, name: string): Promise<string> {
  const directory = resources.environment[name]
  if (!directory) throw new Error(`The isolated fixture has no ${name} directory`)
  const suffix = relative(resources.directory, await realpath(directory))
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new Error('Fixture mutations require a child of the owned target root')
  }
  return directory
}

it('keeps isolated managed bytes readable after the caller clears its disposable temporary state', async () => {
  const temporary = await mkdtemp(join(await realpath(tmpdir()), 'foreman-conformance-caller-'))
  const inheritedTmpdir = process.env.TMPDIR
  let resources: IsolatedEnvironment | undefined
  try {
    process.env.TMPDIR = temporary
    resources = await createIsolatedEnvironment(repoRoot)
    const bytes = '# Isolated conformance bytes\n'
    const document = join(await ownedChild(resources, 'FILE_STORAGE_ROOT'), `${randomUUID()}.md`)
    await writeFile(document, bytes, { mode: 0o600, flag: 'wx' })
    for (const name of ['TMPDIR', 'WORKSPACE_STORAGE_ROOT', 'HARNESS_WORKSPACE_ROOT']) {
      await rm(await ownedChild(resources, name), { recursive: true })
    }
    await rm(temporary, { recursive: true })
    await assert.doesNotReject(async () => { assert.equal(await readFile(document, 'utf8'), bytes) })
  } finally {
    if (inheritedTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = inheritedTmpdir
    if (resources) {
      const present = await lstat(resources.directory).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (present) await resources.close()
    }
    await rm(temporary, { recursive: true, force: true })
  }
  await assert.rejects(lstat(resources!.directory), { code: 'ENOENT' })
})

it('keeps simultaneous target homes independent and closes only the selected target', async () => {
  const first = await createIsolatedEnvironment(repoRoot)
  let second: IsolatedEnvironment | undefined
  try {
    second = await createIsolatedEnvironment(repoRoot)
    const filename = `${randomUUID()}.txt`
    const firstHome = await ownedChild(first, 'HOME')
    const secondHome = await ownedChild(second, 'HOME')
    await writeFile(join(firstHome, filename), 'first target', { mode: 0o600, flag: 'wx' })
    await assert.rejects(readFile(join(secondHome, filename)), { code: 'ENOENT' })
    await writeFile(join(secondHome, filename), 'second target', { mode: 0o600, flag: 'wx' })
    await first.close()
    await first.close()
    assert.equal(await readFile(join(secondHome, filename), 'utf8'), 'second target')
    await assert.rejects(lstat(first.directory), { code: 'ENOENT' })
  } finally {
    await first.close()
    await second?.close()
  }
  await assert.rejects(lstat(second!.directory), { code: 'ENOENT' })
})

it('removes allocated target state when the owned repository cannot supply its launcher', async () => {
  const repository = await mkdtemp(join(await realpath(repoRoot), '.fc-repository-'))
  try {
    await assert.rejects(createIsolatedEnvironment(repository), { code: 'ENOENT' })
    assert.deepEqual(await readdir(repository), [])
  } finally {
    await rm(repository, { recursive: true })
  }
})

it('retains target state when root privacy changes and permits cleanup after privacy is restored', async () => {
  const resources = await createIsolatedEnvironment(repoRoot)
  try {
    const sentinel = join(await ownedChild(resources, 'HOME'), `${randomUUID()}.txt`)
    await writeFile(sentinel, 'retained owned state', { mode: 0o600, flag: 'wx' })
    await chmod(resources.directory, 0o750)
    await assert.rejects(resources.close())
    assert.equal(await readFile(sentinel, 'utf8'), 'retained owned state')
  } finally {
    const present = await lstat(resources.directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (present) {
      await chmod(resources.directory, 0o700)
      await resources.close()
    }
  }
  await assert.rejects(lstat(resources.directory), { code: 'ENOENT' })
})

it.each(['direct', 'symbolic link'] as const)('rejects a temporary source checkout through a %s location', async (kind) => {
  const repository = await mkdtemp(join(await realpath(tmpdir()), 'foreman-conformance-repository-'))
  let aliases: string | undefined
  let resources: IsolatedEnvironment | undefined
  try {
    await mkdir(join(repository, 'scripts'), { mode: 0o700 })
    await writeFile(join(repository, 'scripts/graphql-mcp.mjs'), 'export {}\n', { mode: 0o600, flag: 'wx' })
    let source = repository
    if (kind === 'symbolic link') {
      aliases = await mkdtemp(join(await realpath(repoRoot), '.fc-repository-'))
      source = join(aliases, 'checkout')
      await symlink(repository, source, 'dir')
    }
    await assert.rejects(async () => { resources = await createIsolatedEnvironment(source) })
  } finally {
    await resources?.close()
    if (aliases) await rm(aliases, { recursive: true })
    await rm(repository, { recursive: true })
  }
})
