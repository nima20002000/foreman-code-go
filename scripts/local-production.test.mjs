import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { copyVerificationRuntime, desktopLaunchEnvironment, hasNativeTurnStarted, localProductionEnvironment, preserveOperatorConfiguration, publish, readEnvironment,
  removeUninstalledRelease, renderEnvironment,
  pruneReleases, shouldOpenDashboardAfterInstall, waitForIdleRuns, waitForProductionReady, withInstallationLock } from './local-production-runtime.mjs'
import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'

test('an interactive first install opens the dashboard', () => {
  assert.equal(shouldOpenDashboardAfterInstall({
    previousRelease: undefined, stdin: { isTTY: true }, stdout: { isTTY: true },
  }), true)
})

test('upgrades do not open the dashboard even from an interactive terminal', () => {
  assert.equal(shouldOpenDashboardAfterInstall({
    previousRelease: '/installed/release', stdin: { isTTY: true }, stdout: { isTTY: true },
  }), false)
})

test('first installs do not open the dashboard when input or output is non-interactive', () => {
  for (const isTTY of [false, undefined]) {
    for (const [stdin, stdout] of [
      [{ isTTY }, { isTTY: true }],
      [{ isTTY: true }, { isTTY }],
      [{ isTTY }, { isTTY }],
    ]) {
      assert.equal(shouldOpenDashboardAfterInstall({ previousRelease: undefined, stdin, stdout }), false)
    }
  }
})

test('desktop launch preserves the normal user environment without job ownership', () => {
  const source = { PATH: '/user/bin', HOME: '/user', TMPDIR: '/user/tmp' }
  const environment = desktopLaunchEnvironment(source)
  assert.deepEqual(environment, source)
  assert.notEqual(environment, source)
})

test('desktop launch drops job temporary overrides when no original directory was recorded', () => {
  const source = { PATH: '/user/bin', TMPDIR: '/job/tmp', TMP: '/job/tmp', TEMP: '/job/tmp',
    FOREMAN_CODE_HEAVY_JOB_TOKEN: 'owned-job', GRAPHQL_HEAVY_JOB_TOKEN: 'owned-job' }
  assert.deepEqual(desktopLaunchEnvironment(source), { PATH: '/user/bin' })
  assert.equal(source.TMPDIR, '/job/tmp')
})

test('a desktop child can create temporary files after its launching build job is removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-desktop-environment-'))
  const base = join(directory, 'base')
  const job = join(directory, 'job')
  let child
  try {
    await mkdir(base)
    await mkdir(job)
    const environment = desktopLaunchEnvironment({ ...process.env,
      TMPDIR: job, TMP: job, TEMP: job,
      FOREMAN_CODE_HEAVY_JOB_TOKEN: 'owned-job', GRAPHQL_HEAVY_JOB_TOKEN: 'owned-job',
      FOREMAN_CODE_HEAVY_BASE_TMPDIR: base, GRAPHQL_HEAVY_BASE_TMPDIR: base,
    })
    child = spawn(process.execPath, ['-e', `
      const { mkdirSync, mkdtempSync } = require('node:fs');
      const { tmpdir } = require('node:os');
      const { join } = require('node:path');
      process.on('message', () => {
        mkdirSync(tmpdir(), { recursive: true });
        const directory = mkdtempSync(join(tmpdir(), 'desktop-'));
        process.send({ directory, ownsJob: Object.keys(process.env).some(key => /^(FOREMAN_CODE|GRAPHQL)_HEAVY_/.test(key)) });
      });
    `], { env: environment, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    await once(child, 'spawn')
    await rm(job, { recursive: true })
    const message = once(child, 'message')
    child.send('create')
    const [result] = await message
    assert.equal(result.ownsJob, false)
    assert.equal((await stat(result.directory)).isDirectory(), true)
    await assert.rejects(stat(job), { code: 'ENOENT' })
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed release cleanup removes only uninstalled staging and retains the active release through aliases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-release-cleanup-'))
  const installed = join(directory, 'installed')
  const failed = join(directory, 'failed')
  const current = join(directory, 'current')
  const alias = join(directory, 'alias')
  try {
    await mkdir(installed)
    await mkdir(failed)
    await writeFile(join(installed, 'retained'), 'installed production')
    await writeFile(join(failed, 'partial'), 'incomplete staging')
    await symlink(installed, current)
    await symlink(directory, alias)
    await removeUninstalledRelease(join(alias, 'installed'), current)
    assert.equal(await readFile(join(installed, 'retained'), 'utf8'), 'installed production')
    await removeUninstalledRelease(failed, current)
    await assert.rejects(stat(failed), { code: 'ENOENT' })
    assert.equal(await readFile(join(current, 'retained'), 'utf8'), 'installed production')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('native startup requires a live provider event on the bound execution and session', () => {
  const execution = { id: 'execution', nativeSessionId: 'session' }
  const codex = { executionId: execution.id, type: 'turn.started', payload: { threadId: 'session' } }
  const claude = { executionId: execution.id, type: 'claude.text',
    payload: { role: 'assistant', text: 'native answer', nativeSessionId: 'session' } }
  assert.equal(hasNativeTurnStarted('codex', execution, codex), true)
  assert.equal(hasNativeTurnStarted('claude', execution, claude), true)
  for (const [harness, event] of [['codex', codex], ['claude', claude]]) {
    assert.equal(hasNativeTurnStarted(harness, { id: execution.id }, event), false)
    assert.equal(hasNativeTurnStarted(harness, execution, { ...event, executionId: 'other' }), false)
    assert.equal(hasNativeTurnStarted(harness, { ...execution, nativeSessionId: 'other' }, event), false)
    assert.equal(hasNativeTurnStarted(harness, execution, { ...event, connectionId: 'history-replay' }), false)
  }
  assert.equal(hasNativeTurnStarted('claude', execution,
    { ...claude, payload: { role: 'user', text: 'input', nativeSessionId: 'session' } }), false)
  assert.equal(hasNativeTurnStarted('claude', execution,
    { ...claude, type: 'claude.session' }), false)
})

test('production updates retire the browser-access setting while retaining native settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-retired-settings-'))
  const path = join(directory, 'operator.json')
  const owned = localProductionEnvironment('/owner/home', 'a'.repeat(64))
  const native = { CODEX_BINARY: '/opt/owner/codex' }
  const retired = { FOREMAN_CODE_DEV_BROWSER_ACCESS: '0', GRAPHQL_DEV_BROWSER_ACCESS: '1' }
  try {
    assert.equal(Object.hasOwn(owned, 'FOREMAN_CODE_DEV_BROWSER_ACCESS'), false)
    const first = await preserveOperatorConfiguration(path, { ...owned, ...native, ...retired }, owned, () => {})
    assert.deepEqual(first, { ...native, ...owned })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), native)
    await writeFile(path, JSON.stringify({ ...native, ...retired }))
    const updated = await preserveOperatorConfiguration(path, first, owned, () => {})
    assert.deepEqual(updated, first)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), native)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('renamed installer settings retain operator values and the existing database credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-renamed-settings-'))
  const path = join(directory, 'operator.json')
  const password = 'a'.repeat(64)
  const owned = { FOREMAN_CODE_LOCAL_PRODUCTION: '1', FOREMAN_CODE_APP_MCP_DIRECTORY: '/installed/mcp',
    GRAPHQL_PRODUCTION_DB_PASSWORD: password }
  const previous = { GRAPHQL_LOCAL_PRODUCTION: '1', GRAPHQL_APP_MCP_DIRECTORY: '/installed/mcp',
    FOREMAN_CODE_PRODUCTION_DB_PASSWORD: password, GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0',
    CODEX_BINARY: '/opt/owner cli/codex' }
  const validate = environment => {
    assert.equal(readProductEnvironment(environment, 'LOCAL_PRODUCTION'), '1')
    assert.equal(readProductEnvironment(environment, 'APP_MCP_DIRECTORY'), '/installed/mcp')
    assert.equal(readProductEnvironment(environment, 'PRODUCTION_DB_PASSWORD'), password)
    assert.equal(readProductEnvironment(environment, 'ENABLE_EXPERIMENTAL_CODEX_APP_SERVER'), '0')
  }
  try {
    const environment = await preserveOperatorConfiguration(path, previous, owned, validate)
    assert.deepEqual(environment, { ...owned, GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0',
      CODEX_BINARY: previous.CODEX_BINARY })
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0', CODEX_BINARY: previous.CODEX_BINARY,
    })
    for (const name of ['GRAPHQL_LOCAL_PRODUCTION', 'FOREMAN_CODE_LOCAL_PRODUCTION',
      'GRAPHQL_PRODUCTION_DB_PASSWORD', 'FOREMAN_CODE_PRODUCTION_DB_PASSWORD']) {
      await writeFile(path, JSON.stringify({ [name]: 'override' }))
      await assert.rejects(preserveOperatorConfiguration(path, previous, owned, validate), /managed by the installer/)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('configuration aliases reject conflicts before publishing and retain matching operator spellings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-alias-conflicts-'))
  const path = join(directory, 'operator.json')
  const owned = { FOREMAN_CODE_LOCAL_PRODUCTION: '1' }
  const settings = { GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0', FOREMAN_CODE_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '0' }
  try {
    await preserveOperatorConfiguration(path, settings, owned, () => undefined)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), settings)
    const before = await readFile(path, 'utf8')
    await assert.rejects(preserveOperatorConfiguration(path,
      { GRAPHQL_PRODUCTION_DB_PASSWORD: 'old-secret', FOREMAN_CODE_PRODUCTION_DB_PASSWORD: 'new-secret' },
      owned, () => undefined), error => {
        assert.match(error.message, /FOREMAN_CODE_PRODUCTION_DB_PASSWORD conflicts with GRAPHQL_PRODUCTION_DB_PASSWORD/)
        assert.ok(!error.message.includes('old-secret') && !error.message.includes('new-secret'))
        return true
      })
    assert.equal(await readFile(path, 'utf8'), before)
    await writeFile(path, JSON.stringify({ ...settings, FOREMAN_CODE_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1' }))
    await assert.rejects(preserveOperatorConfiguration(path, undefined, owned, () => undefined), /conflicts/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('updates retain operator settings separately from installer isolation settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-settings-'))
  const path = join(directory, 'operator.json')
  const owned = { HOST: '127.0.0.1', NODE_ENV: 'production', GRAPHQL_PRODUCTION_DB_PASSWORD: 'a'.repeat(64) }
  const previous = { ...owned, HOST: '0.0.0.0', GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1',
    CODEX_BINARY: '/opt/native CLI/codex', HARNESS_TIMEOUT_MS: '600000' }
  const validate = environment => {
    assert.equal(environment.HOST, '127.0.0.1')
    assert.equal(environment.GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER, '1')
    assert.equal(environment.HARNESS_TIMEOUT_MS, '600000')
  }
  try {
    const first = await preserveOperatorConfiguration(path, previous, owned, validate)
    await publish(join(directory, 'production.env'), renderEnvironment(first))
    const next = await preserveOperatorConfiguration(path, await readEnvironment(join(directory, 'production.env')),
      { ...owned, GRAPHQL_LOCAL_PRODUCTION: '1' }, validate)
    assert.equal(next.CODEX_BINARY, previous.CODEX_BINARY)
    assert.equal(next.GRAPHQL_PRODUCTION_DB_PASSWORD, owned.GRAPHQL_PRODUCTION_DB_PASSWORD)
    assert.equal(next.GRAPHQL_LOCAL_PRODUCTION, '1')
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      GRAPHQL_ENABLE_EXPERIMENTAL_CODEX_APP_SERVER: '1', CODEX_BINARY: previous.CODEX_BINARY,
      HARNESS_TIMEOUT_MS: '600000',
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

test('staged verification runtime imports without invoking a CLI or requiring the source checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'production-verification-runtime-'))
  try {
    await copyVerificationRuntime(new URL('..', import.meta.url).pathname, directory)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        'const runtime = await import(process.argv[1]); console.log(typeof runtime.finalizeVerification)',
        new URL(`file://${join(directory, 'scripts/verification-runner.mjs')}`).href],
      { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', bytes => { stdout += bytes })
      child.stderr.on('data', bytes => { stderr += bytes })
      child.once('error', reject)
      child.once('exit', code => resolve({ code, stdout, stderr }))
    })
    assert.deepEqual(result, { code: 0, stdout: 'function\n', stderr: '' })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('install waits for active Runs before restarting the API, and fails closed at its deadline', async () => {
  const answers = [['run-a', 'run-b'], ['run-b'], []], waits = []
  await waitForIdleRuns({ query: async () => ({ rows: answers.shift().map(id => ({ id })) }), timeoutMs: 60_000,
    log: () => {}, sleep: async (ms) => { waits.push(ms) } })
  assert.deepEqual(waits, [15_000, 15_000])
  await assert.rejects(waitForIdleRuns({ query: async () => ({ rows: [{ id: 'run-c' }] }), timeoutMs: 0, log: () => {} }),
    /1 Run\(s\) still active \(run-c\).*FOREMAN_INSTALL_INTERRUPT_RUNS=1/)
  let asked = false
  await waitForIdleRuns({ query: async () => { asked = true; return { rows: [{ id: 'run-d' }] } }, timeoutMs: 0, interrupt: true })
  assert.equal(asked, false)
})

test('install keeps only the current and previous release', async () => {
  const root = await mkdtemp(join(tmpdir(), 'releases-'))
  try {
    for (const name of ['release-old1', 'release-old2', 'release-prev', 'release-now', 'notes']) await mkdir(join(root, name))
    const removed = await pruneReleases(root, [join(root, 'release-now'), join(root, 'release-prev')])
    assert.deepEqual(removed.map((path) => path.slice(root.length + 1)).sort(), ['release-old1', 'release-old2'])
    assert.deepEqual((await readdir(root)).sort(), ['notes', 'release-now', 'release-prev'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const failure of ['CI setup: missing package metadata', 'API response timed out', 'second ci_run timed out', 'new API start failed']) {
  test(`install rolls back a healthy release when smoke reports ${failure}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'production-ci-rollback-'))
    const current = join(directory, 'current')
    const expected = { installationId: 'installation', checkoutId: 'release', databaseId: 'database' }
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/health/identity') response.end(JSON.stringify(expected))
      else if (request.url === '/health/ready') response.end(JSON.stringify({ service: 'graphql-api',
        checks: { database: 'ok', checkpoints: 'ok' } }))
      else response.end('<html><script src="/assets/app.js"></script></html>')
    })
    try {
      await symlink('previous-release', join(directory, 'previous'))
      await symlink('broken-release', current)
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const origin = `http://127.0.0.1:${server.address().port}`
      let reported
      try {
        await waitForProductionReady({ origin, expected, timeoutMs: 1000,
          [failure === 'new API start failed' ? 'start' : 'smoke']: async () => { throw new Error(failure) },
          rollback: () => rename(join(directory, 'previous'), current) })
      } catch (error) { reported = error.message }
      assert.equal(await readlink(current), 'previous-release', 'A broken CI release must not stay active')
      assert.equal(reported, failure)
    } finally {
      await new Promise(resolve => server.close(resolve))
      await rm(directory, { recursive: true, force: true })
    }
  })
}
