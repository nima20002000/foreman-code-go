import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { selectInstalledCodex } from '../src/modules/computers/installedCodexSelection.js'
import { readInstalledWorkflowConfiguration } from '../src/modules/runs/remote/installedWorkflowConfiguration.js'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))) })

async function fixture(selected: Record<string, unknown> | null, installedVersion: string | null = 'codex-cli 0.162.0') {
  const home = await mkdtemp(join(tmpdir(), 'codex-selection-'))
  homes.push(home)
  const state = join(home, 'state')
  await mkdir(state, { mode: 0o700 })
  const path = join(state, 'workflow-runtime.json')
  if (selected) { await writeFile(path, JSON.stringify(selected), { mode: 0o600 }) }
  let binary: string | null = null
  if (installedVersion) {
    const bin = join(home, '.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin')
    await mkdir(bin, { recursive: true })
    binary = join(bin, 'codex')
    await writeFile(binary, `#!/bin/sh\necho '${installedVersion}'\n`)
    await chmod(binary, 0o755)
  }
  return { home, state, location: { path, ownerUid: process.getuid!() }, binary }
}

const pinned = { schemaVersion: 1, codexBinary: '/opt/pinned/codex', expectedVersion: 'codex-cli 0.154.0', payloadPaths: [],
  appMcpLauncher: '/opt/app/mcp/launcher.mjs' }

describe('installed Codex selection after a maintenance update', () => {
  it('selects the freshly installed native Codex and keeps the selection private and readable', async () => {
    const f = await fixture(pinned)
    expect(await selectInstalledCodex(f.location, f.home, AbortSignal.timeout(10_000))).toBe(f.binary)
    expect(await readInstalledWorkflowConfiguration(f.location)).toEqual({ ...pinned, codexBinary: f.binary,
      expectedVersion: 'codex-cli 0.162.0', payloadPaths: [] })
    expect((await stat(f.location.path)).mode & 0o777).toBe(0o600)
    expect((await readdir(f.state)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('leaves a Worker without a Codex selection on the maintained Codex in PATH', async () => {
    const f = await fixture({ schemaVersion: 1, appMcpLauncher: '/opt/app/mcp/launcher.mjs',
      claude: { binary: '/opt/claude', installedLockPath: '/opt/claude.lock' } })
    expect(await selectInstalledCodex(f.location, f.home, AbortSignal.timeout(10_000))).toBeNull()
    expect((await readInstalledWorkflowConfiguration(f.location))?.codexBinary).toBeUndefined()
  })

  it('keeps the old selection when the update cannot be located or did not report a version', async () => {
    const missing = await fixture(pinned, null)
    await expect(selectInstalledCodex(missing.location, missing.home, AbortSignal.timeout(10_000)))
      .rejects.toThrow('could not be located')
    expect(await readInstalledWorkflowConfiguration(missing.location)).toEqual(pinned)
    const silent = await fixture(pinned, 'not a version')
    await expect(selectInstalledCodex(silent.location, silent.home, AbortSignal.timeout(10_000)))
      .rejects.toThrow('did not report its version')
    expect(await readInstalledWorkflowConfiguration(silent.location)).toEqual(pinned)
  })
})
