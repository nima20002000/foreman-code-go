import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { installManagedLauncher, readLauncherInstallation, registerAppRoute, writeLauncherInstallation } from './appMcpLauncher.js'

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

it('installs, merges concurrent alias registrations and renews routes without spawning lock processes', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'launcher-spawns-'))
  const directory = join(root, 'mcp')
  const alias = join(root, 'alias')
  const launcher = join(directory, 'launcher.mjs')
  try {
    await installManagedLauncher(new URL('../../../../../scripts/graphql-mcp.mjs', import.meta.url), launcher)
    await symlink(directory, alias)
    await Promise.all(Array.from({ length: 5 }, (_, index) => writeLauncherInstallation(
      join(index % 2 ? alias : directory, 'launcher.mjs'),
      { version: 1, executables: [{ path: `/runtime/node-${index}`, realpath: `/runtime/node-${index}` }] },
    )))
    expect(readLauncherInstallation(launcher)?.executables).toHaveLength(6)
    const first = await registerAppRoute('local-token', 'http://127.0.0.1:9000/mcp', '2099-01-01T00:00:00Z', launcher)
    await first.refresh('2099-02-01T00:00:00Z')
    const replacement = await registerAppRoute('local-token', 'http://127.0.0.1:9001/mcp', '2099-03-01T00:00:00Z', launcher)
    await first()
    await replacement.refresh('2099-04-01T00:00:00Z')
    const routes = join(directory, 'routes')
    const records = await Promise.all((await readdir(routes)).map(async file =>
      JSON.parse(await readFile(join(routes, file), 'utf8')) as unknown))
    expect(records).toEqual([expect.objectContaining({
      endpoint: 'http://127.0.0.1:9001/mcp', expiresAt: '2099-04-01T00:00:00Z',
    })])
    await replacement()
    expect(await readdir(routes)).toEqual([])
    expect(spawn).not.toHaveBeenCalled()
  } finally { await rm(root, { recursive: true, force: true }) }
})
