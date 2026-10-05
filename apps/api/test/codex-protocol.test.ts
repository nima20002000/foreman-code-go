import assert from 'node:assert/strict'
import { appendFile, link, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, it } from 'vitest'

import { assertCodexUnchanged, canonical, codexExecutableIdentity, qualifyCodex,
  QUALIFIED_CODEX_VERSION, type QualifiedCodex } from '../src/modules/harnesses/codexProtocol.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { nativeCompatibilityProbe } from '../src/modules/harnesses/compatibility/probe.js'
import { CompatibilityCheckError } from '../src/modules/harnesses/compatibility/errors.js'
import { calls, errorCode, fixture, fixtureProtocol, type Fixture } from './fixtures/codex-test-helpers.js'

let f: Fixture

describe.skipIf(process.platform === 'win32')('Codex installation qualification (unmocked)', () => {
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => { await rm(f.directory, { recursive: true, force: true }) })

  it.skipIf(process.platform !== 'linux')('attributes model-free qualification commands to the existing recovery owner', async () => {
    const registry = new NativeProcessRegistry(join(f.directory, 'qualification-recovery'))
    const owner = 'codex-qualification-owner'
    const scope = registry.scope(owner)
    assert.equal(await registry.closeOwner(owner), false)
    await assert.rejects(qualifyCodex(f.binary, QUALIFIED_CODEX_VERSION, f.directory, { ...process.env }, true, undefined, scope),
      (error: unknown) => errorCode(error) === 'CODEX_SCHEMA_UNQUALIFIED')
    assert.equal(await registry.closeOwner(owner), true)
  })

  it.each([QUALIFIED_CODEX_VERSION, '0.154.0'])('keeps schema verification after matching version %s', async expectedVersion => {
    await assert.rejects(qualifyCodex(f.binary, expectedVersion, f.directory, { ...process.env }, true),
      (error: unknown) => errorCode(error) === 'CODEX_SCHEMA_UNQUALIFIED')
    assert((await calls(f.directory)).some((entry) => Array.isArray(entry.cli) && entry.cli.includes('generate-json-schema')))
  })

  it.each(['codex-cli 99.0.0', '0.156.1'])('rejects a different expected version %s before schema commands', async expectedVersion => {
    await assert.rejects(qualifyCodex(f.binary, expectedVersion, f.directory, { ...process.env }, false),
      (error: unknown) => errorCode(error) === 'CODEX_APP_SERVER_VERSION_UNQUALIFIED')
    assert.equal((await calls(f.directory)).length, 1)
  })

  it('selects a registered installed release but still requires its measured schema', async () => {
    await writeFile(join(f.directory, 'version.json'), JSON.stringify('codex-cli 0.156.1'))
    await assert.rejects(qualifyCodex(f.binary, undefined, f.directory, { ...process.env }, false),
      (error: unknown) => errorCode(error) === 'CODEX_SCHEMA_UNQUALIFIED')
    assert((await calls(f.directory)).some((entry) => Array.isArray(entry.cli) && entry.cli.includes('generate-json-schema')))
    await writeFile(join(f.directory, 'version.json'), JSON.stringify('codex-cli 99.0.0'))
    const priorCalls = (await calls(f.directory)).length
    await assert.rejects(qualifyCodex(f.binary, undefined, f.directory, { ...process.env }, false),
      (error: unknown) => errorCode(error) === 'HARNESS_UNQUALIFIED')
    assert.equal((await calls(f.directory)).length, priorCalls + 1)
  })

  it('F24/F28: logged-out control initialization reaches schema qualification, not execution authentication', async () => {
    await writeFile(join(f.directory, 'logged-out'), '')
    await assert.rejects(qualifyCodex(f.binary, QUALIFIED_CODEX_VERSION, f.directory, { ...process.env }, true),
      (error: unknown) => errorCode(error) === 'CODEX_APP_SERVER_AUTH_UNQUALIFIED')
    await assert.rejects(qualifyCodex(f.binary, QUALIFIED_CODEX_VERSION, f.directory, { ...process.env }, false),
      (error: unknown) => errorCode(error) === 'CODEX_SCHEMA_UNQUALIFIED')
    assert.equal((await calls(f.directory)).filter((entry) => Array.isArray(entry.cli) && entry.cli[0] === 'login').length, 1)
  })

  it('F27: executable replacement invalidates previously measured identity before spawn', async () => {
    const path = await realpath(f.binary)
    const info = await stat(path)
    const qualified: QualifiedCodex = {
      binary: path, identity: await codexExecutableIdentity(path), protocol: fixtureProtocol,
      providerVersion: QUALIFIED_CODEX_VERSION, schemaManifestSha256: 'test-only', stableSchemaGitBlob: 'test-only', referenceSchemaManifestSha256: 'test-only',
    }
    await assertCodexUnchanged(qualified)
    await appendFile(path, '\n// executable replacement\n')
    await utimes(path, info.atime, info.mtime)
    await assert.rejects(assertCodexUnchanged(qualified), (error: unknown) => errorCode(error) === 'CODEX_EXECUTABLE_CHANGED')
  })

  it('keeps executable qualification when another worktree creates a hardlink', async () => {
    const path = await realpath(f.binary)
    const qualified: QualifiedCodex = {
      binary: path, identity: await codexExecutableIdentity(path), protocol: fixtureProtocol,
      providerVersion: QUALIFIED_CODEX_VERSION, schemaManifestSha256: 'test-only',
      stableSchemaGitBlob: 'test-only', referenceSchemaManifestSha256: 'test-only',
    }
    await link(path, join(f.directory, 'worktree-installation'))
    await assertCodexUnchanged(qualified)
  })

  it('keeps diagnostic identity across hardlinks and rejects changed executable content', async () => {
    const probe = nativeCompatibilityProbe({ codex: f.binary, opencode: f.binary }, f.directory, process.env)
    const signal = AbortSignal.timeout(5000)
    try {
      const installed = await probe.inspect('codex', signal)
      await link(f.binary, join(f.directory, 'diagnostic-installation'))
      await probe.assertUnchanged(installed, signal)
      await appendFile(f.binary, '\n// executable replacement\n')
      await assert.rejects(probe.assertUnchanged(installed, signal), (error: unknown) =>
        error instanceof CompatibilityCheckError && error.code === 'CLI_CHANGED')
    } finally { await probe.close?.() }
  })
})

it('F25: canonical objects ignore property order without changing array semantics', () => {
  assert.equal(canonical({ b: { d: 4, c: 3 }, a: 1 }), canonical({ a: 1, b: { c: 3, d: 4 } }))
  assert.notEqual(canonical(['a', 'b']), canonical(['b', 'a']))
})
