import assert from 'node:assert/strict'
import { appendFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, it } from 'vitest'

import { assertCodexUnchanged, canonical, qualifyCodex, QUALIFIED_CODEX_VERSION, type QualifiedCodex } from '../src/modules/harnesses/codexProtocol.js'
import { calls, errorCode, fixture, fixtureProtocol, type Fixture } from './fixtures/codex-test-helpers.js'

let f: Fixture

describe.skipIf(process.platform === 'win32')('Codex installation qualification (unmocked)', () => {
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => { await rm(f.directory, { recursive: true, force: true }) })

  it('F28: the right version and authentication cannot substitute for an installed schema measurement', async () => {
    await assert.rejects(qualifyCodex(f.binary, QUALIFIED_CODEX_VERSION, f.directory, { ...process.env }, true),
      (error: unknown) => errorCode(error) === 'CODEX_SCHEMA_UNQUALIFIED')
    assert((await calls(f.directory)).some((entry) => Array.isArray(entry.cli) && entry.cli.includes('generate-json-schema')))
  })

  it('F27: an arbitrary expected version cannot bypass the exact qualification pin', async () => {
    await assert.rejects(qualifyCodex(f.binary, 'codex-cli 99.0.0', f.directory, { ...process.env }, false),
      (error: unknown) => errorCode(error) === 'CODEX_APP_SERVER_VERSION_UNQUALIFIED')
    assert.equal((await calls(f.directory)).length, 0)
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
      binary: path, identity: canonical([path, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]), protocol: fixtureProtocol,
      providerVersion: QUALIFIED_CODEX_VERSION, schemaManifestSha256: 'test-only', stableSchemaGitBlob: 'test-only', referenceSchemaManifestSha256: 'test-only',
    }
    await assertCodexUnchanged(qualified)
    await appendFile(path, '\n// executable replacement\n')
    await assert.rejects(assertCodexUnchanged(qualified), (error: unknown) => errorCode(error) === 'CODEX_EXECUTABLE_CHANGED')
  })
})

it('F25: canonical objects ignore property order without changing array semantics', () => {
  assert.equal(canonical({ b: { d: 4, c: 3 }, a: 1 }), canonical({ a: 1, b: { c: 3, d: 4 } }))
  assert.notEqual(canonical(['a', 'b']), canonical(['b', 'a']))
})
