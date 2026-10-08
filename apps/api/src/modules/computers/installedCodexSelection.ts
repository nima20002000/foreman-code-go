import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, open, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  readInstalledWorkflowConfiguration, type InstalledWorkflowConfigurationLocation,
} from '../runs/remote/installedWorkflowConfiguration.js'

/** Where `npm install --global --prefix ~/.local @openai/codex` puts the platform's native Codex binaries. */
function nativeCodexScope(home: string) {
  return join(home, '.local', 'lib', 'node_modules', '@openai', 'codex', 'node_modules', '@openai')
}

async function installedNativeCodex(home: string): Promise<string> {
  const scope = nativeCodexScope(home)
  const candidates: string[] = []
  for (const entry of await readdir(scope).catch(() => [])) {
    if (!entry.startsWith('codex-')) continue
    const vendor = join(scope, entry, 'vendor')
    for (const triple of await readdir(vendor).catch(() => [])) candidates.push(join(vendor, triple, 'bin', 'codex'))
  }
  const executable = (await Promise.all(candidates.map(candidate =>
    access(candidate, constants.X_OK).then(() => candidate, () => null)))).filter((value): value is string => value !== null)
  if (executable.length !== 1) throw new Error('The updated Codex binary could not be located on this computer.')
  return executable[0]!
}

function reportedVersion(binary: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['--version'], { signal, timeout: 15_000, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
      (error, stdout) => {
        const version = stdout.trim()
        if (error || !/^codex-cli \d+\.\d+\.\d+/u.test(version)) reject(new Error('The updated Codex binary did not report its version.'))
        else resolve(version)
      })
  })
}

/**
 * Moves a Worker's installer-selected Codex to the Codex that maintenance just installed, so new work actually runs the
 * update. Only the binary selection changes: qualification still checks the exact binary before any profile uses it.
 * Returns null when the Worker has no Codex selection (it then uses the maintained Codex on PATH).
 */
export async function selectInstalledCodex(location: InstalledWorkflowConfigurationLocation | null, home: string,
  signal: AbortSignal): Promise<string | null> {
  if (!location) return null
  const configuration = await readInstalledWorkflowConfiguration(location)
  if (!configuration?.codexBinary) return null
  const binary = await installedNativeCodex(home)
  const expectedVersion = await reportedVersion(binary, signal)
  if (configuration.codexBinary === binary && configuration.expectedVersion === expectedVersion) return binary
  const next = { ...configuration, codexBinary: binary, expectedVersion, payloadPaths: [] }
  // The reader requires a private, single-link file; write a new one and rename it over the old selection.
  const temporary = join(dirname(location.path), `.workflow-runtime.${randomUUID()}.tmp`)
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await file.writeFile(`${JSON.stringify(next, null, 2)}\n`)
    await file.sync()
  } finally { await file.close() }
  try { await rename(temporary, location.path) }
  catch (error) { await rm(temporary, { force: true }); throw error }
  return binary
}
