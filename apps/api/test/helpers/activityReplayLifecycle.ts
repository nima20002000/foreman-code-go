import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { buildProductionApp } from '../../src/production.js'
import type { ActivityProductionReplay } from './activityProductionReplay.js'

/** Private fixture bytes live beside the checkout, outside temporary/native workspaces. */
export async function createActivityReplayFileStorage(): Promise<string> {
  const parent = fileURLToPath(new URL('../../../../../_activity-replay-files/', import.meta.url))
  await mkdir(parent, { recursive: true, mode: 0o700 })
  return mkdtemp(join(parent, 'owned-'))
}

type Production = Pick<ReturnType<typeof buildProductionApp>, 'initialize' | 'shutdown'> & {
  registerFileStorage(): void
  app: { listen(options: { host: string; port: number }): Promise<string> }
}

/** Register the exact instance before any startup boundary can fail, including restarts. */
export async function startActivityReplayProduction(production: Production, replay: Pick<ActivityProductionReplay, 'drain'>,
  closes: Array<() => Promise<void>>, port: number): Promise<string> {
  closes.push(async () => {
    try { await replay.drain() } finally { await production.shutdown() }
  })
  production.registerFileStorage()
  await production.initialize()
  return production.app.listen({ host: '127.0.0.1', port })
}

/** Layout supplied to the real production workspace admission service. */
export async function createActivityReplayWorkspace(directory: string) {
  const workspaceStorageRoot = join(directory, 'projects'), workingDirectory = join(workspaceStorageRoot, 'replay')
  const harnessWorkspaceRoot = join(directory, 'runtime')
  await mkdir(workingDirectory, { recursive: true })
  await mkdir(harnessWorkspaceRoot, { recursive: true })
  return { workingDirectory, workspaceStorageRoot, harnessWorkspaceRoot }
}
