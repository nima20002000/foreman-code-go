import { lstat, realpath, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  installManagedLauncher,
  readLauncherInstallation,
  writeLauncherInstallation,
} from './appMcpLauncher.js'

const launcherSource = new URL('../../../../../scripts/graphql-mcp.mjs', import.meta.url)

async function existingPath(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Called under the production installation lock while the old API is stopped. */
export async function upgradeProductionMcpLauncher(desktopHome: string): Promise<void> {
  const previous = join(desktopHome, '.local/state/graphql-production/mcp')
  const destination = join(desktopHome, '.local/share/graphql/mcp')
  const launcher = join(destination, 'launcher.mjs')
  const alias = join(previous, 'launcher.mjs')
  const retained = `${previous}.previous`
  const previousState = await existingPath(previous)
  const retainedState = await existingPath(retained)
  if (!previousState && !retainedState) return
  if (previousState?.isSymbolicLink()) {
    const installation = readLauncherInstallation(launcher)
    if (await realpath(previous) !== await realpath(destination)
      || !installation?.launcherAliases?.includes(alias)) {
      throw new Error('The previous production MCP directory is linked to an unmanaged installation.')
    }
    await installManagedLauncher(launcherSource, launcher)
    return
  }
  if (previousState && retainedState) {
    throw new Error('Both the previous production MCP directory and its upgrade backup exist.')
  }
  const sourceDirectory = previousState ? previous : retained
  const state = previousState ?? retainedState
  const oldLauncher = join(sourceDirectory, 'launcher.mjs')
  const installation = readLauncherInstallation(oldLauncher)
  if (!state?.isDirectory() || !installation?.executables.length
    || !(await existingPath(oldLauncher))?.isFile()) {
    throw new Error('The previous production MCP launcher has no valid managed installation record.')
  }
  await installManagedLauncher(launcherSource, launcher)
  const current = readLauncherInstallation(launcher)!
  const executables = [...current.executables]
  for (const executable of installation.executables) {
    if (!executables.some((entry) => entry.path === executable.path && entry.realpath === executable.realpath)) {
      executables.push(executable)
    }
  }
  await writeLauncherInstallation(launcher, {
    version: 1,
    executables,
    launcherAliases: [...new Set([...(current.launcherAliases ?? []), alias])],
  })
  const pending = `${previous}.${randomUUID()}.tmp`
  try {
    await symlink(destination, pending)
    if (previousState) await rename(previous, retained)
    await rename(pending, previous)
  } finally {
    await rm(pending, { force: true })
  }
}
