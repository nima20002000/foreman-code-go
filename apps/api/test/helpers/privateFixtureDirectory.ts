import { AsyncLocalStorage } from 'node:async_hooks'
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openPrivateRoot } from '../../src/modules/sources/privateFilesystem.js'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'

const directories = new AsyncLocalStorage<Set<string>>()

async function removeFixtureDirectory(directory: string): Promise<void> {
  const registryPath = join(directory, 'runtime', 'native-process-registry')
  let nativeRegistryExists = false
  try {
    const registry = await lstat(registryPath)
    if (!registry.isDirectory()) throw new Error('Fixture native registry must be a directory.')
    nativeRegistryExists = true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (nativeRegistryExists) {
    const registry = new NativeProcessRegistry(registryPath)
    const owners = new Set(registry.snapshot().launches.map(launch => launch.owner))
    for (const owner of owners) {
      if (!await registry.closeOwner(owner)) throw new Error('Fixture native processes did not close.')
    }
  }
  await rm(directory, { recursive: true, force: true })
}

export async function withPrivateFixtureDirectories<T>(work: () => Promise<T>): Promise<T> {
  const created = new Set<string>()
  let outcome: { value: T } | { error: unknown }
  try { outcome = { value: await directories.run(created, work) } }
  catch (error) { outcome = { error } }
  const failures: unknown[] = []
  for (const directory of [...created].reverse()) {
    try { await removeFixtureDirectory(directory) }
    catch (error) { failures.push(error) }
  }
  if (failures.length) {
    if ('error' in outcome) failures.unshift(outcome.error)
    throw new AggregateError(failures, 'Private fixture work or cleanup failed.',
      { cause: 'error' in outcome ? outcome.error : failures[0] })
  }
  if ('error' in outcome) throw outcome.error
  return outcome.value
}

/** Heavy-job TMPDIR ancestors are shared; private fixture bytes use an owned parent. */
export async function privateFixtureDirectory(prefix: string): Promise<string> {
  const parent = join(homedir(), '.graphql-private-test-fixtures')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const handle = await openPrivateRoot(parent)
  await handle.close()
  const directory = await mkdtemp(join(parent, prefix))
  directories.getStore()?.add(directory)
  return directory
}
