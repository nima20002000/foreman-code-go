import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { preserveOperatorConfiguration, publish, readEnvironment, renderEnvironment,
  waitForProductionReady, withInstallationLock } from './local-production-runtime.mjs'

test('updates retain operator settings separately from installer isolation settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-settings-'))
  const path = join(directory, 'operator.json')
  const owned = { HOST: '127.0.0.1', NODE_ENV: 'production', GRAPHQL_PRODUCTION_DB_PASSWORD: 'a'.repeat(64) }
  const previous = { ...owned, HOST: '0.0.0.0', GRAPHQL_OPENCODE_PARITY_QUALIFIED: '1',
    CODEX_BINARY: '/opt/native CLI/codex', OPENCODE_BINARY: '/opt/native/opencode', HARNESS_TIMEOUT_MS: '600000' }
  const validate = environment => {
    assert.equal(environment.HOST, '127.0.0.1')
    assert.equal(environment.GRAPHQL_OPENCODE_PARITY_QUALIFIED, '1')
    assert.equal(environment.HARNESS_TIMEOUT_MS, '600000')
  }
  try {
    const first = await preserveOperatorConfiguration(path, previous, owned, validate)
    await publish(join(directory, 'production.env'), renderEnvironment(first))
    const next = await preserveOperatorConfiguration(path, await readEnvironment(join(directory, 'production.env')),
      { ...owned, GRAPHQL_LOCAL_PRODUCTION: '1' }, validate)
    assert.equal(next.CODEX_BINARY, previous.CODEX_BINARY)
    assert.equal(next.OPENCODE_BINARY, previous.OPENCODE_BINARY)
    assert.equal(next.GRAPHQL_PRODUCTION_DB_PASSWORD, owned.GRAPHQL_PRODUCTION_DB_PASSWORD)
    assert.equal(next.GRAPHQL_LOCAL_PRODUCTION, '1')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      GRAPHQL_OPENCODE_PARITY_QUALIFIED: '1', CODEX_BINARY: previous.CODEX_BINARY,
      OPENCODE_BINARY: previous.OPENCODE_BINARY, HARNESS_TIMEOUT_MS: '600000',
    })
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    const before = await readFile(path, 'utf8')
    await assert.rejects(preserveOperatorConfiguration(path, previous, owned, () => {
      throw new Error('Invalid configuration')
    }), /Invalid configuration/)
    assert.equal(await readFile(path, 'utf8'), before)
    await writeFile(path, JSON.stringify({ HOST: '0.0.0.0' }))
    await assert.rejects(preserveOperatorConfiguration(path, previous, owned, validate), /managed by the installer/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('first migration and later updates preserve quoted, escaped and multiline operator values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-escaped-settings-'))
  const path = join(directory, 'operator.json')
  const envFile = join(directory, 'production.env')
  const owned = { HOST: '127.0.0.1', GRAPHQL_PRODUCTION_DB_PASSWORD: 'a'.repeat(64) }
  const settings = {
    CODEX_BINARY: '/opt/native "qualified"/codex',
    OPENCODE_BINARY: "/opt/native\\tools/'qualified'/opencode",
    PROVIDER_API_KEY: " space\\slash\"quote'single$literal`tick\nsecond line\\ ",
    LITERAL_NEWLINE: '\\n',
    TRAILING_BACKSLASH: 'end\\',
    EMPTY_SETTING: '',
  }
  const validate = environment => {
    for (const [key, value] of Object.entries(settings)) assert.equal(environment[key], value)
    assert.equal(environment.HOST, owned.HOST)
  }
  try {
    await publish(envFile, renderEnvironment({ ...settings, ...owned }))
    const previous = await readEnvironment(envFile)
    assert.deepEqual(previous, { ...settings, ...owned })
    const migrated = await preserveOperatorConfiguration(path, previous, owned, validate)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), settings)
    await publish(envFile, renderEnvironment(migrated))
    assert.deepEqual(await readEnvironment(envFile), { ...settings, ...owned })
    const updated = await preserveOperatorConfiguration(path, await readEnvironment(envFile),
      { ...owned, GRAPHQL_LOCAL_PRODUCTION: '1' }, validate)
    await publish(envFile, renderEnvironment(updated))
    assert.deepEqual(await readEnvironment(envFile), { ...settings, ...owned, GRAPHQL_LOCAL_PRODUCTION: '1' })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), settings)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('environment migration reads systemd quoting, continuations and duplicate assignments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-environment-'))
  const path = join(directory, 'production.env')
  try {
    await writeFile(path, [
      '# ignored comment', '; also ignored', 'HOST=first', 'HOST = 127.0.0.1  ',
      'UNQUOTED=path\\ with\\ spaces\\\\suffix', "SINGLE='literal\\path\nnext line'",
      'DOUBLE="quote\\\" slash\\\\ dollar\\$ tick\\` other\\q"',
      'CONTINUED=one\\\ntwo', 'QUOTED_CONTINUED="one\\\ntwo"', 'EMPTY=',
    ].join('\n'))
    assert.deepEqual(await readEnvironment(path), {
      HOST: '127.0.0.1', UNQUOTED: 'path with spaces\\suffix', SINGLE: 'literal\\path\nnext line',
      DOUBLE: 'quote" slash\\ dollar$ tick` other\\q', CONTINUED: 'onetwo',
      QUOTED_CONTINUED: 'onetwo', EMPTY: '',
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('concurrent publishers expose one complete file and clean their exclusive temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-publish-'))
  const target = join(directory, 'environment')
  const contents = Array.from({ length: 20 }, (_, index) => `${index}:` + 'x'.repeat(8192))
  try {
    await Promise.all(contents.map(content => publish(target, content)))
    assert.ok(contents.includes(await readFile(target, 'utf8')))
    assert.deepEqual(await readdir(directory), ['environment'])
    assert.equal((await stat(target)).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('installation lock serializes independent processes and releases after failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-lock-'))
  const lock = join(directory, 'install.lock')
  const counter = join(directory, 'counter')
  const children = []
  try {
    await writeFile(counter, '0')
    const code = `
      import { readFile, writeFile } from 'node:fs/promises';
      import { setTimeout as delay } from 'node:timers/promises';
      import { withInstallationLock } from ${JSON.stringify(new URL('./local-production-runtime.mjs', import.meta.url).href)};
      await withInstallationLock(process.argv[1], async () => {
        const value = Number(await readFile(process.argv[2], 'utf8'));
        await delay(50);
        await writeFile(process.argv[2], String(value + 1));
      });
    `
    const completions = Array.from({ length: 3 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, lock, counter], { stdio: 'inherit' })
      children.push(child)
      return once(child, 'exit').then(([status]) => assert.equal(status, 0))
    })
    await Promise.all(completions)
    assert.equal(await readFile(counter, 'utf8'), '3')
    await assert.rejects(withInstallationLock(lock, () => { throw new Error('Installation interrupted') }), /interrupted/)
    assert.equal(await withInstallationLock(lock, () => 'released'), 'released')
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
    await rm(directory, { recursive: true, force: true })
  }
})

test('readiness rejects conflicting installations and releases despite healthy API and compiled HTML', async () => {
  const expected = { installationId: 'installation', checkoutId: 'release', databaseId: 'database' }
  let actual = expected
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/health/identity') response.end(JSON.stringify(actual))
    else if (request.url === '/health/ready') response.end(JSON.stringify({ service: 'graphql-api',
      checks: { database: 'ok', checkpoints: 'ok' } }))
    else response.end('<html><script src="/assets/app.js"></script></html>')
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const origin = `http://127.0.0.1:${server.address().port}`
    for (const key of Object.keys(expected)) {
      actual = { ...expected, [key]: 'conflicting' }
      await assert.rejects(waitForProductionReady({ origin, expected, timeoutMs: 30 }), /different database installation or release/)
    }
    actual = expected
    await waitForProductionReady({ origin, expected, timeoutMs: 1000 })
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
