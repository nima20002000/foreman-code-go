import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { autoRetestFiles, discoverFiles, failedFilesFromLog, failForSkippedCases, fullRunExitCode, hasActiveHeavyJobToken, integrationLogPath, integrationShardLimit, isIntegrationTestPath, isRegularIntegrationFile, parseVitestCases, scheduleFiles, selectFiles, signalOwnedChildren } from './test-integration.mjs'

test('integration discovery takes a sorted snapshot with startup included', () => {
  const files = discoverFiles()
  assert.ok(files.length > 0)
  assert.deepEqual(files, [...files].sort())
  assert.equal(new Set(files).size, files.length)
  assert.ok(files.includes('apps/api/test/dev-startup.integration.test.ts'))
  assert.ok(files.every((file) => file.startsWith('apps/api/test/') && file.endsWith('.integration.test.ts')))
})

test('discovery accepts valid Git filenames and rejects non-normal paths', () => {
  assert.equal(isIntegrationTestPath('apps/api/test/foo.bar.integration.test.ts'), true)
  assert.equal(isIntegrationTestPath('apps/api/test/nested/foo bar+v2.integration.test.ts'), true)
  assert.equal(isIntegrationTestPath('apps/api/test/../foo.integration.test.ts'), false)
  assert.equal(isIntegrationTestPath('apps/api/test//foo.integration.test.ts'), false)
  assert.equal(isIntegrationTestPath('/apps/api/test/foo.integration.test.ts'), false)
})

test('discovery rejects symlinked test files and parent directories', () => {
  const base = mkdtempSync(join(tmpdir(), 'integration-discovery-'))
  try {
    const directory = join(base, 'apps/api/test')
    mkdirSync(directory, { recursive: true })
    const file = 'apps/api/test/with space+v2.integration.test.ts'
    writeFileSync(join(base, file), '')
    assert.equal(isRegularIntegrationFile(base, file), true)
    symlinkSync(join(base, file), join(directory, 'linked.integration.test.ts'))
    assert.equal(isRegularIntegrationFile(base, 'apps/api/test/linked.integration.test.ts'), false)
    symlinkSync(directory, join(directory, 'linked-dir'))
    assert.equal(isRegularIntegrationFile(base, 'apps/api/test/linked-dir/with space+v2.integration.test.ts'), false)
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('stale or forged heavy-job tokens do not count as queue admission', () => {
  const start = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]
  const environment = { GRAPHQL_HEAVY_JOB_COMMON: '/git/common', GRAPHQL_HEAVY_JOB_TOKEN: 'owned-token' }
  const owner = { token: 'owned-token', pid: process.pid, start }
  assert.equal(hasActiveHeavyJobToken(environment, '/git/common', owner), true)
  assert.equal(hasActiveHeavyJobToken({ ...environment, GRAPHQL_HEAVY_JOB_TOKEN: 'stale' }, '/git/common', owner), false)
  assert.equal(hasActiveHeavyJobToken(environment, '/other/common', owner), false)
  assert.equal(hasActiveHeavyJobToken(environment, '/git/common', { ...owner, start: 'stale' }), false)
  assert.equal(hasActiveHeavyJobToken(environment, '/git/common', null), false)
})

test('resume includes the selected file so a repaired failure is rerun', () => {
  const files = ['a', 'b', 'c']
  assert.deepEqual(selectFiles(files, 'b'), ['b', 'c'])
  assert.deepEqual(selectFiles(files, 'c'), ['c'])
  assert.throws(() => selectFiles(files, 'missing'), /Unknown --start-at/)
})

test('failed-log selection includes only discovered failures once', () => {
  const files = ['apps/api/test/a.integration.test.ts', 'apps/api/test/b.integration.test.ts']
  const log = '[integration] FAIL apps/api/test/b.integration.test.ts (slot 2, exit 1); log: /tmp/b\n'
    + '[integration] PASS apps/api/test/a.integration.test.ts (slot 1; 2 cases passed, 0 skipped)\n'
    + '[integration] RETEST FAIL apps/api/test/a.integration.test.ts (slot 1, exit 1); log: /tmp/retest-a\n'
    + '[integration] FAIL apps/api/test/b.integration.test.ts (slot 2, exit 1); log: /tmp/b\n'
  assert.deepEqual(failedFilesFromLog(log, files), ['apps/api/test/b.integration.test.ts'])
  assert.throws(() => failedFilesFromLog('[integration] FAIL apps/api/test/unknown.integration.test.ts (slot 1, exit 1)\n', files), /Unknown failed/)
  assert.throws(() => failedFilesFromLog('no failures', files), /no failed files/)
})

test('nested integration files retain distinct log paths', () => {
  const first = integrationLogPath('/tmp/run', 'apps/api/test/one/shared.integration.test.ts')
  const second = integrationLogPath('/tmp/run', 'apps/api/test/two/shared.integration.test.ts')
  assert.notEqual(first, second)
  assert.match(first, /one\/shared\.integration\.test\.ts\.log$/)
  assert.throws(() => integrationLogPath('/tmp/run', 'apps/api/test/../outside.integration.test.ts'), /Invalid integration log path/)
})

test('case totals parse mixed and colored Vitest summaries', () => {
  assert.deepEqual(parseVitestCases(' Tests  \x1b[32m7 passed\x1b[0m | 2 skipped (9)\n'), { passed: 7, failed: 0, skipped: 2, total: 9 })
  assert.deepEqual(parseVitestCases(' Tests  2 failed | 3 passed | 1 todo (6)\n'), { passed: 3, failed: 2, skipped: 1, total: 6 })
  assert.equal(parseVitestCases('Vitest crashed before its summary'), null)
})

test('skipped cases fail a clean full run while a diagnostic resume reports them', () => {
  const summary = { passed: 2, failed: 0, skipped: 1, total: 3 }
  assert.equal(failForSkippedCases(summary, null), true)
  assert.equal(failForSkippedCases(summary, 'apps/api/test/file.integration.test.ts'), false)
  assert.equal(failForSkippedCases({ ...summary, skipped: 0 }, null), false)
})

test('only a default full run queues each first-pass failure for one retest', () => {
  const failed = ['b', 'a', 'b']
  assert.deepEqual(autoRetestFiles(failed, { diagnostic: false, explicit: false, interrupted: null }), ['a', 'b'])
  assert.deepEqual(autoRetestFiles(failed, { diagnostic: true, explicit: false, interrupted: null }), [])
  assert.deepEqual(autoRetestFiles(failed, { diagnostic: false, explicit: true, interrupted: null }), [])
  assert.deepEqual(autoRetestFiles(failed, { diagnostic: false, explicit: false, interrupted: 'SIGINT' }), [])
})

test('a successful retest cannot make a failed first pass green', () => {
  assert.equal(fullRunExitCode(1, null), 1)
  assert.equal(fullRunExitCode(0, null), 0)
  assert.equal(fullRunExitCode(1, 'SIGINT'), 130)
  assert.equal(fullRunExitCode(1, 'SIGTERM'), 143)
})

test('integration shard limit respects CPU capacity by default and bounds explicit overrides', () => {
  assert.equal(integrationShardLimit(undefined, 4), 4)
  assert.equal(integrationShardLimit(undefined, 16), 8)
  assert.equal(integrationShardLimit('8', 4), 8)
  assert.equal(integrationShardLimit('12', 16), 12)
  assert.throws(() => integrationShardLimit('0', 16), /integer from 1 to 12/)
  assert.throws(() => integrationShardLimit('13', 16), /integer from 1 to 12/)
})

test('a failed file is reported while the remaining files continue', async () => {
  const waiting = new Map()
  const started = []
  const runFile = (slot, file) => new Promise((resolve) => {
    started.push({ slot, file })
    waiting.set(file, resolve)
  })
  const pending = scheduleFiles(['a', 'b', 'c', 'd'], [1, 2], runFile)
  assert.deepEqual(started.map(({ file }) => file), ['a', 'b'])
  waiting.get('a')({ code: 1 })
  await Promise.resolve()
  assert.deepEqual(started.map(({ file }) => file), ['a', 'b', 'c'])
  waiting.get('b')({ code: 0 })
  await Promise.resolve()
  assert.deepEqual(started.map(({ file }) => file), ['a', 'b', 'c', 'd'])
  waiting.get('c')({ code: 0 })
  waiting.get('d')({ code: 0 })
  const result = await pending
  assert.equal(result.skipped, 0)
  assert.deepEqual(result.outcomes.map(({ file, code }) => [file, code]).sort(), [['a', 1], ['b', 0], ['c', 0], ['d', 0]])
})

test('an interruption stops new dispatch without interrupting already-running files', async () => {
  let stop = false
  let finish
  const pending = scheduleFiles(['a', 'b', 'c'], [1], () => new Promise((resolve) => { finish = resolve }), () => stop)
  stop = true
  finish({ code: 0 })
  const result = await pending
  assert.equal(result.skipped, 2)
  assert.deepEqual(result.outcomes.map(({ file }) => file), ['a'])
})

test('slots draw the next file only when their current file finishes', async () => {
  const waiting = new Map()
  const started = []
  const pending = scheduleFiles(['a', 'b', 'c'], [1, 2], (slot, file) => new Promise((resolve) => {
    started.push([slot, file])
    waiting.set(file, resolve)
  }))
  waiting.get('b')({ code: 0 })
  await Promise.resolve()
  assert.deepEqual(started, [[1, 'a'], [2, 'b'], [2, 'c']])
  waiting.get('a')({ code: 0 })
  waiting.get('c')({ code: 0 })
  assert.equal((await pending).skipped, 0)
})

test('interrupt escalates a TERM-ignoring owned process group without awaiting its exit', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const timers = new Map()
  let timeout
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject) })
    signalOwnedChildren(new Map([[1, child]]), timers, 'SIGTERM', 100)
    const signal = await Promise.race([
      new Promise((resolve) => child.once('exit', (_code, value) => resolve(value))),
      new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('TERM-ignoring child did not exit')), 2000) }),
    ])
    assert.equal(signal, 'SIGKILL')
  } finally {
    clearTimeout(timeout)
    for (const timer of timers.values()) clearTimeout(timer)
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* exited */ } }
  }
})
