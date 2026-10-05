import assert from 'node:assert/strict'
import { appendFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { assertCodexUnchanged, canonical, qualifyCodex } from '../src/modules/harnesses/codexProtocol.js'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { calls, errorCode, fixture, type Fixture } from './fixtures/codex-test-helpers.js'
import { codexSchema } from './fixtures/harness-schemas.js'

let f: Fixture
const newer = 'codex-cli 0.160.0'
async function configure(schema = codexSchema()) {
  await writeFile(join(f.directory, 'version.json'), JSON.stringify(newer))
  await writeFile(join(f.directory, 'schema.json'), JSON.stringify(schema))
}
async function qualify(authenticated = false) {
  return qualifyCodex(f.binary, f.directory, { ...process.env }, authenticated)
}
async function schemaCalls() {
  return (await calls(f.directory)).filter(entry => Array.isArray(entry.cli) && entry.cli.includes('generate-json-schema'))
}

describe.skipIf(process.platform === 'win32')('Codex installed contract verification', () => {
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => { await rm(f.directory, { recursive: true, force: true }) })

  it('accepts a newer compatible binary and records its observed version', async () => {
    await configure()
    const result = await qualify()
    assert.equal(result.providerVersion, newer)
    assert.match(result.schemaManifestSha256, /^[a-f0-9]{64}$/)
    assert.equal((await schemaCalls()).length, 1)
    await qualify()
    assert.equal((await schemaCalls()).length, 1)
  })

  it('names the harness, observed version and missing required method', async () => {
    const schema = codexSchema()
    schema.definitions.ClientRequest.oneOf = schema.definitions.ClientRequest.oneOf.filter(
      branch => branch.properties.method.const !== 'thread/resume')
    await configure(schema)
    await assert.rejects(qualify(), error => error instanceof Error
      && error.message.includes(newer) && error.message.includes('thread/resume')
      && errorCode(error) === 'CODEX_CONTRACT_UNSUPPORTED')
  })

  it('names a missing history response field on the installed version', async () => {
    const schema = codexSchema()
    Reflect.deleteProperty(schema.definitions.v2.ThreadReadResponse.properties, 'thread')
    await configure(schema)
    await assert.rejects(qualify(), error => error instanceof Error
      && error.message.includes(newer) && error.message.includes('ThreadReadResponse.thread'))
  })

  it('reverifies a changed binary even when its reported version is unchanged', async () => {
    await configure()
    const original = await qualify()
    await appendFile(f.binary, '\n// replacement payload\n')
    await assert.rejects(assertCodexUnchanged(original), error => errorCode(error) === 'CODEX_EXECUTABLE_CHANGED')
    const replacement = await qualify()
    assert.notEqual(replacement.identity, original.identity)
    assert.equal((await schemaCalls()).length, 2)
  })

  it('requires authentication on cache hits and allows logged-out model-free control checks', async () => {
    await configure()
    await qualify(true)
    await writeFile(join(f.directory, 'logged-out'), '')
    await assert.rejects(qualify(true), error => errorCode(error) === 'CODEX_APP_SERVER_AUTH_UNQUALIFIED')
    await qualify(false)
    assert.equal((await schemaCalls()).length, 1)
  })

  it.skipIf(process.platform !== 'linux')('attributes verification to the owned recovery scope and closes it', async () => {
    await configure()
    const registry = new NativeProcessRegistry(join(f.directory, 'qualification-recovery'))
    const owner = 'codex-qualification-owner'
    const scope = registry.scope(owner)
    assert.equal(await registry.closeOwner(owner), false)
    await qualifyCodex(f.binary, f.directory, { ...process.env }, true, undefined, scope)
    assert.equal(await registry.closeOwner(owner), true)
  })
})

it('canonical objects ignore property order without changing array semantics', () => {
  assert.equal(canonical({ b: { d: 4, c: 3 }, a: 1 }), canonical({ a: 1, b: { c: 3, d: 4 } }))
  assert.notEqual(canonical(['a', 'b']), canonical(['b', 'a']))
})
