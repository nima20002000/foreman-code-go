import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { AgentHarness } from '@foreman-code/contracts'
import { discoverLauncher } from './hostDiscovery.js'
import { passiveDriverPayloads } from './payloadDiscovery.js'

/** Cache identity includes the launcher, interpreter and installed native payload. */
export async function binaryCacheIdentity(harness: AgentHarness, binary: string, cwd: string): Promise<string> {
  const environment = { path: process.env.PATH ?? '', cwd, provenance: 'terminal' as const,
    generation: commandInputHash({ path: process.env.PATH ?? '', cwd, node: process.execPath }) }
  const launcher = await discoverLauncher(binary, environment, [])
  const payload = launcher.resolvedLauncher ? await passiveDriverPayloads(harness, launcher.resolvedLauncher) : null
  const paths = [...(payload?.paths ?? []), ...(launcher.interpreter ? [launcher.interpreter] : [])]
  const observed = await discoverLauncher(binary, environment, paths)
  return commandInputHash({ binary, environment, launcher: observed.resolvedLauncher, fingerprint: observed.fingerprint })
}
