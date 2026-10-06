import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it } from 'vitest'
import { qualifyCodex } from '../src/modules/harnesses/codexProtocol.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { calls, errorCode, fixture, until } from './fixtures/codex-test-helpers.js'

it.skipIf(process.platform !== 'linux')('keeps qualification commands inside one recovery lifetime and closes them before rejecting a schema', async () => {
  const f = await fixture()
  const registry = new NativeProcessRegistry(join(f.directory, 'recovery'))
  const owner = 'qualification-owner'
  await writeFile(join(f.directory, 'diagnostic-barrier'), '')
  const checking = qualifyCodex(f.binary, f.directory,
    { ...process.env }, true, undefined, registry.scope(owner))
  const rejected = assert.rejects(checking, (error: unknown) => errorCode(error) === 'CODEX_CONTRACT_UNSUPPORTED')
  try {
    await until(async () => (await calls(f.directory)).some((entry) => Array.isArray(entry.cli)
      && entry.cli[0] === 'login'))
    const active = registry.snapshot().launches.filter((launch) => launch.owner === owner
      && launch.lifecycle !== 'closed')
    assert.equal(active.length, 1)
    assert.equal((await calls(f.directory)).filter((entry) => Array.isArray(entry.cli)
      && entry.cli.includes('generate-json-schema')).length, 0)
    await writeFile(join(f.directory, 'release-diagnostics'), '')
    await rejected
    assert.equal((await calls(f.directory)).filter((entry) => Array.isArray(entry.diagnosticCompleted)).length, 2)
    assert.equal(await registry.closeOwner(owner), true)
  } finally {
    await writeFile(join(f.directory, 'release-diagnostics'), '')
    await checking.catch(() => undefined)
    await registry.closeOwner(owner)
    await rm(f.directory, { recursive: true, force: true })
  }
})
