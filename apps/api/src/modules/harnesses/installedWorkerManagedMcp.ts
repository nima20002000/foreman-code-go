import { mkdir, open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { appLauncherPath, installManagedLauncher } from './appMcpLauncher.js'
import { CodexMcpConnections } from './codexMcpConnections.js'
import { ClaudeMcpConnections } from './claudeMcpConnections.js'
import { WorkerManagedMcp } from './workerManagedMcp.js'
import { DomainError } from '../errors.js'
import { installedHarnessSelection, readInstalledWorkflowConfiguration,
  type InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'
import type { NativeMcpAdapter } from './nativeMcpCommon.js'

/** Uses the Worker's own home, native binaries and packaged launcher, never paths supplied by Main. */
export function createInstalledWorkerManagedMcp(input: {
  stateDirectory: string
  configuration: InstalledWorkflowConfigurationLocation
  availableConfiguration(): InstalledWorkflowConfigurationLocation | null
  registry: NativeProcessRegistry
  launcherSource?: URL | undefined
}) {
  const home = process.env.HOME ?? homedir()
  const installLauncher = (signal: AbortSignal) => installManagedLauncher(
    input.launcherSource ?? new URL('../../../../../scripts/graphql-mcp.mjs', import.meta.url), appLauncherPath(), signal)
  const codex: NativeMcpAdapter = {
    async read(signal) {
      return controlCodex(adapter => adapter.read(signal))
    },
    async apply(snapshot, change, signal, managed) {
      return controlCodex(adapter => adapter.apply(snapshot, change, signal, managed))
    },
  }
  async function controlCodex<T>(work: (adapter: NativeMcpAdapter) => Promise<T>): Promise<T> {
    const configuration = await readInstalledWorkflowConfiguration(input.configuration)
    const selection = configuration && installedHarnessSelection(configuration)
    if (!selection) throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'Codex is not installed on this computer.', 409)
    const owner = `managed-mcp:codex:${randomUUID()}`
    const adapter = new CodexMcpConnections(selection.binary, input.stateDirectory,
      input.registry.scope(owner), installLauncher)
    try {
      return await work(adapter)
    } finally {
      await input.registry.closeOwner(owner)
    }
  }
  const claude = new ClaudeMcpConnections(join(process.env.CLAUDE_CONFIG_DIR ?? home, '.claude.json'))
  async function prepare(harness: 'codex' | 'claude') {
    if (harness !== 'codex') return
    const file = join(process.env.CODEX_HOME ?? join(home, '.codex'), 'config.toml')
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    try { await (await open(file, 'wx', 0o600)).close() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  const worker = new WorkerManagedMcp({ directory: input.stateDirectory, adapters: { codex, claude }, installLauncher, prepare })
  return { worker, async ensureReady(options: { signal?: AbortSignal } = {}) {
    const configuration = await readInstalledWorkflowConfiguration(input.availableConfiguration())
    const harnesses: ('codex' | 'claude')[] = []
    if (configuration && installedHarnessSelection(configuration)) harnesses.push('codex')
    if (configuration?.claude) harnesses.push('claude')
    if (harnesses.length) await worker.ensureReady(harnesses, options)
  } }
}
