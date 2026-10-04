import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { adminDatabaseUrl, autoRetestFiles, discoverFiles, failedCasesFromLog, failedFilesFromLog, failForSkippedCases, fullRunExitCode, hasActiveHeavyJobToken, hasHeavyJobAdmission, integrationEnvironment, integrationLogPath, integrationProgressLine, integrationShardLimit, integrationTimeouts, isIntegrationTestPath, isRegularIntegrationFile, parseVitestCases, scheduleFiles, selectFiles, selectExactFiles, signalOwnedChildren } from './test-integration.mjs'

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

test('requested integration files select only discovered files once in discovery order', () => {
  const files = ['apps/api/test/a.integration.test.ts', 'apps/api/test/b.integration.test.ts',
    'apps/api/test/c.integration.test.ts']
  assert.deepEqual(selectExactFiles(files, [files[2], files[0], files[2]]), [files[0], files[2]])
  assert.throws(() => selectExactFiles(files, []), /at least one integration file/)
  assert.throws(() => selectExactFiles(files, ['apps/api/test/missing.integration.test.ts']), /Unknown --files/)
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

test('exact-file selection runs only requested discovered files once', () => {
  const files = ['apps/api/test/a.integration.test.ts', 'apps/api/test/b.integration.test.ts']
  assert.deepEqual(selectExactFiles(files, [files[1], files[1]]), [files[1]])
  assert.throws(() => selectExactFiles(files, []), /at least one/)
  assert.throws(() => selectExactFiles(files, ['apps/api/test/unknown.integration.test.ts']), /Unknown --files/)
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
  assert.deepEqual(autoRetestFiles(failed, { diagnostic: false, interrupted: null }), ['a', 'b'])
  assert.deepEqual(autoRetestFiles(failed, { diagnostic: true, interrupted: null }), [])
  assert.deepEqual(autoRetestFiles(failed, { diagnostic: false, interrupted: 'SIGINT' }), [])
})

test('a successful retest cannot make a failed first pass green', () => {
  assert.equal(fullRunExitCode(1, null), 1)
  assert.equal(fullRunExitCode(0, null), 0)
  assert.equal(fullRunExitCode(1, 'SIGINT'), 130)
  assert.equal(fullRunExitCode(1, 'SIGTERM'), 143)
})

test('integration defaults to twelve slots and bounds explicit overrides', () => {
  assert.equal(integrationShardLimit(undefined), 12)
  assert.equal(integrationShardLimit('8'), 8)
  assert.equal(integrationShardLimit('12'), 12)
  assert.throws(() => integrationShardLimit('0'), /integer from 1 to 12/)
  assert.throws(() => integrationShardLimit('13'), /integer from 1 to 12/)
})

test('process deadlines allow long progressing files and cannot be disabled by overrides', () => {
  const limits = integrationTimeouts({})
  assert.equal(limits.idleTimeoutMs, 600_000)
  assert.equal(limits.fileTimeoutMs, 3_600_000)
  assert.equal(integrationTimeouts({ GRAPHQL_INTEGRATION_IDLE_TIMEOUT_MS: '5000' }).idleTimeoutMs, 5000)
  for (const value of ['0', '-1', 'Infinity', 'NaN', '3600001', '1.5']) {
    assert.throws(() => integrationTimeouts({ GRAPHQL_INTEGRATION_FILE_TIMEOUT_MS: value }), /integer/)
  }
})

test('progress distinguishes twelve configured slots from a draining file and retest queue', () => {
  const active = new Map([[3, { file: 'slow.integration.test.ts',
    progress: { started: 1000, lastOutputAt: 6000, bytes: 2048 } }]])
  const line = integrationProgressLine({ phase: 'first pass', total: 175,
    passed: 171, failed: 3, active, slotCount: 12 }, 11_000)
  assert.match(line, /174\/175 completed \(171 passed, 3 failed\); 1\/12 slots active; 0 queued/)
  assert.match(line, /slot 3: slow.integration.test.ts, elapsed 10s, output idle 5s, 2048 bytes/)
  const retest = integrationProgressLine({ phase: 'retest', total: 2,
    passed: 0, failed: 0, active, slotCount: 12 }, 11_000)
  assert.match(retest, /PROGRESS retest: 0\/2 completed.*1\/12 slots active; 1 queued/)
  const retired = integrationProgressLine({ phase: 'first pass', total: 175,
    passed: 171, failed: 3, active, slotCount: 12, usableCount: 11 }, 11_000)
  assert.match(retired, /1\/12 slots active; 0 queued; 1 retired/)
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

test('twelve slots start twelve files and refill an available slot after a failure', async () => {
  const files = Array.from({ length: 13 }, (_, index) => `file-${index + 1}`)
  const slots = Array.from({ length: integrationShardLimit() }, (_, index) => index + 1)
  const waiting = new Map()
  const started = []
  const pending = scheduleFiles(files, slots, (slot, file) => new Promise((resolve) => {
    started.push([slot, file])
    waiting.set(file, resolve)
  }))
  assert.equal(started.length, 12)
  assert.equal(new Set(started.map(([slot]) => slot)).size, 12)
  waiting.get('file-4')({ code: 1 })
  await Promise.resolve()
  assert.deepEqual(started.at(-1), [4, 'file-13'])
  for (const [file, finish] of waiting) if (file !== 'file-4') finish({ code: 0 })
  const result = await pending
  assert.equal(result.outcomes.length, 13)
  assert.equal(result.skipped, 0)
  assert.equal(result.outcomes.filter(({ code }) => code !== 0).length, 1)
})

test('interrupt escalates a TERM-ignoring owned process group without awaiting its exit', async () => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const timers = new Map()
  let timeout
  try {
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject) })
    signalOwnedChildren(new Map([[1, { child }]]), timers, 'SIGTERM', 100)
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

test('lists failing case names from a Vitest log', () => {
  const log = '\x1b[31m FAIL \x1b[39m test/a.integration.test.ts > suite > breaks\n FAIL  test/a.integration.test.ts > suite > breaks\n FAIL  test/b.integration.test.ts [ test/b.integration.test.ts ]\n ✓ passes'
  assert.deepEqual(failedCasesFromLog(log), ['suite > breaks'])
})

test('TEST_DATABASE_URL selects the server; slots get their own databases there', () => {
  assert.equal(adminDatabaseUrl(undefined), 'postgresql://graphql:graphql@127.0.0.1:5432/postgres')
  assert.equal(adminDatabaseUrl('postgresql://u:p@127.0.0.1:5433/my_test'), 'postgresql://u:p@127.0.0.1:5433/postgres')
})

test('dedicated database gates use the current owned slot, overriding inherited destinations', () => {
  const slot = { databaseUrl: 'postgresql://graphql:graphql@127.0.0.1:5432/graphql_test_owned', directory: '/tmp/slot-1' }
  const inherited = { TEST_DATABASE_URL: 'postgresql://remote/live',
    JOB_DISPATCH_DATABASE_URL: 'postgresql://remote/live',
    NIM2691_ADMIN_DATABASE_URL: 'postgresql://remote/live', HRT_F14_ADMIN_DATABASE_URL: 'postgresql://remote/live', TMPDIR: '/inherited' }
  const environment = integrationEnvironment(inherited, slot)
  for (const name of ['TEST_DATABASE_URL', 'JOB_DISPATCH_DATABASE_URL', 'NIM2691_ADMIN_DATABASE_URL', 'HRT_F14_ADMIN_DATABASE_URL']) {
    assert.equal(environment[name], slot.databaseUrl)
  }
  assert.equal(environment.NIM2691_POSTGRES, '1')
  assert.equal(environment.TMPDIR, slot.directory)
  assert.equal(inherited.HRT_F14_ADMIN_DATABASE_URL, 'postgresql://remote/live')
  const retest = integrationEnvironment(environment, { ...slot, databaseUrl: slot.databaseUrl + '_retest' })
  assert.equal(retest.HRT_F14_ADMIN_DATABASE_URL, slot.databaseUrl + '_retest')
  assert.equal(retest.JOB_DISPATCH_DATABASE_URL, slot.databaseUrl + '_retest')
  for (const databaseUrl of ['postgresql://graphql:graphql@remote/graphql_test_owned',
    'postgresql://graphql:graphql@127.0.0.1/live', slot.databaseUrl + '?options=unsafe']) {
    assert.throws(() => integrationEnvironment(inherited, { ...slot, databaseUrl }), /loopback PostgreSQL database explicitly named for tests/)
  }
})


test('admission recognizes legacy and secondary slots and rejects forged, stale and foreign records', () => {
  const common = mkdtempSync(join(tmpdir(), 'integration-admission-'))
  try {
    const state = join(common, 'graphql-heavy-jobs')
    const legacy = join(state, 'active', 'owner.json')
    const running = join(state, 'running')
    mkdirSync(join(state, 'active'), { recursive: true })
    mkdirSync(running)
    const start = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]
    const owner = { common, token: 'owned-token', pid: process.pid, start }
    const environment = { GRAPHQL_HEAVY_JOB_COMMON: common, GRAPHQL_HEAVY_JOB_TOKEN: owner.token }
    writeFileSync(legacy, JSON.stringify(owner))
    assert.equal(hasHeavyJobAdmission(environment, common), true)
    writeFileSync(legacy, JSON.stringify({ ...owner, token: 'another-slot' }))
    const secondary = join(running, '000000000002-secondary')
    writeFileSync(secondary, JSON.stringify(owner))
    writeFileSync(join(running, '000000000001-malformed'), '{')
    assert.equal(hasHeavyJobAdmission(environment, common), true)
    assert.equal(hasHeavyJobAdmission({ ...environment, GRAPHQL_HEAVY_JOB_TOKEN: 'forged' }, common), false)
    assert.equal(hasHeavyJobAdmission({ ...environment, GRAPHQL_HEAVY_JOB_COMMON: '/other/common' }, common), false)
    for (const invalid of [{ ...owner, start: 'stale' }, { ...owner, common: '/other/common' }, { ...owner, pid: 0 }]) {
      writeFileSync(secondary, JSON.stringify(invalid))
      assert.equal(hasHeavyJobAdmission(environment, common), false)
    }
    writeFileSync(secondary, JSON.stringify(owner))
    rmSync(legacy)
    assert.equal(hasHeavyJobAdmission(environment, common), true)
  } finally { rmSync(common, { recursive: true, force: true }) }
})
