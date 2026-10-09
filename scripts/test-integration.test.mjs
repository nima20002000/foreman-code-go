import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { integrationEnvironmentCapabilities, partitionIntegrationCapabilities,
  supportsInstalledWorkerHost } from './integration-capabilities.mjs'
import { readVerificationEnvironment } from '../packages/contracts/src/verificationEnvironment.mjs'
import { createTestRoot, removeTestRoot, requireTestServerUrl, testAdminUrl } from './test-resources.mjs'
import { autoRetestFiles, discoverFiles, failedCasesFromLog, failedFilesFromLog, failForSkippedCases,
  fullRunExitCode, hasActiveHeavyJobToken, hasHeavyJobAdmission, integrationEnvironment, integrationReport,
  integrationLogPath, integrationProgressLine, integrationShardLimit, integrationTimeouts, integrationVitestArguments,
  isIntegrationTestPath, isRegularIntegrationFile, mergeDurations, options, orderByDuration, parseVitestCases,
  partitionIntegrationFiles, readDurations, reservedIntegrationShards, scheduleFiles, selectFiles, selectExactFiles,
  signalOwnedChildren, vitestCommand, writeDurations } from './test-integration.mjs'

test('the installed Job environment reports its unsupported host capabilities without probing the host', async () => {
  const environment = { FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1', PATH: '/no-tools' }
  assert.deepEqual(await integrationEnvironmentCapabilities(environment), {
    schemaVersion: 1, runtime: 'isolated-job',
    capabilities: { nativeCgroupDelegation: false, dockerCompose: false, installedWorkerHost: false },
    postgres: 'job-private', git: 'mounted-readonly',
  })
  assert.equal(readVerificationEnvironment({}), null)
  assert.throws(() => readVerificationEnvironment({ FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'unknown' }), /Unknown/)
  assert.throws(() => readVerificationEnvironment({ FOREMAN_CODE_VERIFICATION_ROOT: '/workspace' }), /missing/)
  await assert.rejects(integrationEnvironmentCapabilities({ FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'unknown' }), /Unknown/)
  await assert.rejects(integrationEnvironmentCapabilities({ FOREMAN_CODE_VERIFICATION_ROOT: '/workspace' }), /missing/)
})

test('installed Worker capability requires an approved matching target and persistent root, home and state', () => {
  const target = { os: 'ubuntu', osRelease: '26.04', arch: 'x64', libc: 'glibc-2.43', node: 'v22.23.2' }
  const facts = { ...target, rootPersistent: true, homePersistent: true, storagePersistent: true }
  assert.equal(supportsInstalledWorkerHost(facts, [target]), true)
  assert.equal(supportsInstalledWorkerHost(facts, []), false)
  for (const field of ['rootPersistent', 'homePersistent', 'storagePersistent']) {
    assert.equal(supportsInstalledWorkerHost({ ...facts, [field]: false }, [target]), false)
  }
  const unsupported = { os: 'debian', osRelease: '12', arch: 'arm64', libc: 'glibc-2.36', node: 'v22.23.3' }
  for (const [field, value] of Object.entries(unsupported)) {
    assert.equal(supportsInstalledWorkerHost({ ...facts, [field]: value }, [target]), false)
  }
  const debian = { ...facts, os: 'debian', osRelease: '12' }
  assert.equal(supportsInstalledWorkerHost(debian, [debian]), false)
})

test('each affected integration file runs only when its required capability is present', () => {
  const requirements = [
    ['apps/api/test/local-human-native.integration.test.ts', 'nativeCgroupDelegation'],
    ['apps/api/test/operator-file-delivery.integration.test.ts', 'nativeCgroupDelegation'],
    ['apps/api/test/operator-management-file-authority.integration.test.ts', 'nativeCgroupDelegation'],
    ['apps/api/test/test-database-startup.integration.test.ts', 'dockerCompose'],
    ['apps/api/test/computer-workflow-save.regression.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/remote-review-production.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/worker-chat-profile-qualification.integration.test.ts', 'installedWorkerHost'],
    ['apps/api/test/worker-profile-requalification.integration.test.ts', 'installedWorkerHost'],
  ]
  for (const [file, capability] of requirements) {
    const environment = { schemaVersion: 1, runtime: 'host',
      capabilities: { nativeCgroupDelegation: true, dockerCompose: true, installedWorkerHost: true } }
    assert.deepEqual(partitionIntegrationCapabilities([file], environment), { runnable: [file], unavailable: [] })
    environment.capabilities[capability] = false
    const { runnable, unavailable } = partitionIntegrationCapabilities([file], environment)
    assert.deepEqual(runnable, [])
    assert.equal(unavailable.length, 1)
    assert.deepEqual(unavailable[0].requiredCapabilities, [capability])
    assert.equal(unavailable[0].complete, false)
    assert.equal(unavailable[0].code, null)
  }
})

test('unsupported integration files remain required and prevent a complete or passing report', async () => {
  const native = 'apps/api/test/operator-file-delivery.integration.test.ts'
  const database = 'apps/api/test/test-database-startup.integration.test.ts'
  const ordinary = 'apps/api/test/operator-mcp.integration.test.ts'
  const selected = [native, database, ordinary]
  const environment = await integrationEnvironmentCapabilities({ FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1' })
  const { runnable, unavailable } = partitionIntegrationCapabilities(selected, environment)
  assert.deepEqual(runnable, [ordinary])
  assert.deepEqual(unavailable.map(file => file.requiredCapabilities), [['nativeCgroupDelegation'], ['dockerCompose']])
  const counts = { total: 1, passed: 1, failed: 0, skipped: 0 }
  const passed = { file: ordinary, code: 0, complete: true, report: { totals: counts } }
  const report = integrationReport(selected, [...unavailable, passed], [], {
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), diagnostic: false,
    processStopped: true, environment,
  })
  assert.equal(report.outcome, 'incomplete')
  assert.equal(report.completeness, 'partial')
  assert.equal(report.expectedPortions, 3)
  assert.equal(report.completedPortions, 1)
  assert.equal(report.totals.skipped, 0)
  assert.deepEqual(report.files.slice(0, 2), unavailable.map(file => ({ ...file,
    totals: { total: 0, passed: 0, failed: 0, skipped: 0 },
  })))
  assert.deepEqual(report.environment, environment)
  assert.deepEqual(partitionIntegrationCapabilities(selected, {
    capabilities: { nativeCgroupDelegation: true, dockerCompose: true, installedWorkerHost: true },
  }), { runnable: selected, unavailable: [] })
})

test('installed Worker suites remain unavailable and nonzero even when explicitly selected in a Job', async () => {
  const files = [
    'apps/api/test/computer-workflow-save.regression.integration.test.ts',
    'apps/api/test/remote-review-production.integration.test.ts',
    'apps/api/test/worker-chat-profile-qualification.integration.test.ts',
    'apps/api/test/worker-profile-requalification.integration.test.ts',
  ]
  const environment = await integrationEnvironmentCapabilities({ FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1' })
  for (const requested of [files, ...files.map(file => [file])]) {
    const selected = selectExactFiles(files, requested)
    const { runnable, unavailable } = partitionIntegrationCapabilities(selected, environment)
    assert.deepEqual(runnable, [])
    assert.deepEqual(unavailable.map(file => file.requiredCapabilities), selected.map(() => ['installedWorkerHost']))
    const report = integrationReport(selected, unavailable, [], {
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), diagnostic: requested.length === 1,
      processStopped: true, environment,
    })
    assert.equal(report.outcome, 'incomplete')
    assert.equal(report.completeness, 'partial')
    assert.equal(report.expectedPortions, selected.length)
    assert.equal(report.completedPortions, 0)
    assert.deepEqual(report.totals, { total: 0, passed: 0, failed: 0, skipped: 0 })
    assert.ok(report.files.every(file => file.code === null && file.complete === false))
    assert.equal(fullRunExitCode(unavailable.length, null), 1)
  }
})

test('diagnostic case selection preserves file and worker limits and passes the pattern as one argument', () => {
  const file = 'apps/api/test/remote-review-production.integration.test.ts'
  const unfiltered = ['run', 'test/remote-review-production.integration.test.ts', '--no-file-parallelism',
    '--maxWorkers=1', '--maxConcurrency=1', '--reporter=verbose', '--fsModuleCache']
  assert.deepEqual(integrationVitestArguments(file), unfiltered)
  const pattern = 'delivered remote decision|reserved decision'
  assert.deepEqual(integrationVitestArguments(file, pattern), [...unfiltered, '--testNamePattern', pattern])
  assert.equal(failForSkippedCases({ skipped: 5 }, false), true)
  assert.equal(failForSkippedCases({ skipped: 5 }, true), false)
  assert.deepEqual(autoRetestFiles([file], { diagnostic: true, interrupted: null }), [])
})

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
  const environment = { FOREMAN_CODE_HEAVY_JOB_COMMON: '/git/common', FOREMAN_CODE_HEAVY_JOB_TOKEN: 'owned-token' }
  const owner = { token: 'owned-token', pid: process.pid, start }
  assert.equal(hasActiveHeavyJobToken(environment, '/git/common', owner), true)
  assert.equal(hasActiveHeavyJobToken({ ...environment, FOREMAN_CODE_HEAVY_JOB_TOKEN: 'stale' }, '/git/common', owner), false)
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
  assert.throws(() => selectExactFiles(files, ['apps/api/test/../a.integration.test.ts']), /Unknown --files/)
  assert.throws(() => selectExactFiles(files, ['apps/api/test/a.test.ts']), /Unknown --files/)
})

test('the runner accepts an explicit file list and rejects an empty list', () => {
  const files = ['apps/api/test/a.integration.test.ts', 'apps/api/test/b.integration.test.ts']
  assert.deepEqual(options(['--files', ...files]), { startAt: null, failedFrom: null, files })
  assert.throws(() => options(['--files']), /Usage/)
  assert.deepEqual(options([]), { startAt: null, failedFrom: null, files: null })
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

test('isolates bounded resource checks and retains every requested file exactly once', () => {
  const files = ['apps/api/test/ordinary.integration.test.ts',
    'apps/api/test/operator-chat.integration.test.ts',
    'apps/api/test/entrypoints-source-approval-profile.integration.test.ts',
    'apps/api/test/production-lifecycle.integration.test.ts',
    'apps/api/test/dev-startup.integration.test.ts']
  const partition = partitionIntegrationFiles(files)
  assert.deepEqual(partition.parallel, [files[0]])
  assert.deepEqual(partition.exclusive, [files[4], files[2], files[1], files[3]])
  assert.deepEqual([...partition.exclusive, ...partition.parallel].sort(), [...files].sort())
  assert.deepEqual(partitionIntegrationFiles([files[0]]), { exclusive: [], parallel: [files[0]] })
})

test('exact-file selection runs only requested discovered files once', () => {
  const files = ['apps/api/test/a.integration.test.ts', 'apps/api/test/b.integration.test.ts',
    'apps/api/test/c.integration.test.ts']
  assert.deepEqual(selectExactFiles(files, [files[1], files[1]]), [files[1]])
  assert.deepEqual(selectExactFiles(files, [files[2], files[0], files[2]]), [files[0], files[2]])
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
  assert.equal(integrationShardLimit('16'), 16)
  assert.throws(() => integrationShardLimit('0'), /integer from 1 to 64/)
  assert.throws(() => integrationShardLimit('65'), /integer from 1 to 64/)
})

test('process deadlines allow long progressing files and cannot be disabled by overrides', () => {
  const limits = integrationTimeouts({})
  assert.equal(limits.idleTimeoutMs, 600_000)
  assert.equal(limits.fileTimeoutMs, 3_600_000)
  assert.equal(integrationTimeouts({ FOREMAN_CODE_INTEGRATION_IDLE_TIMEOUT_MS: '5000' }).idleTimeoutMs, 5000)
  for (const value of ['0', '-1', 'Infinity', 'NaN', '3600001', '1.5']) {
    assert.throws(() => integrationTimeouts({ FOREMAN_CODE_INTEGRATION_FILE_TIMEOUT_MS: value }), /integer/)
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

test('database gates and storage paths use the current owned slot, overriding inherited destinations', () => {
  const resource = createTestRoot()
  const databaseUrl = new URL('/graphql_test_owned', testAdminUrl).toString()
  const slot = { ...resource, databaseUrl }
  const inherited = { TEST_DATABASE_URL: 'postgresql://remote/live', DATABASE_URL: 'postgresql://remote/live',
    JOB_DISPATCH_DATABASE_URL: 'postgresql://remote/live', SUBAGENT_CORE_ADMIN_DATABASE_URL: 'postgresql://remote/live',
    HRT_F03_DATABASE_URL: 'postgresql://remote/live', ENG03_A_TEST_DATABASE_URL: 'postgresql://remote/live',
    NIM2691_ADMIN_DATABASE_URL: 'postgresql://remote/live', HRT_F14_ADMIN_DATABASE_URL: 'postgresql://remote/live',
    HOME: '/real/home', CODEX_HOME: '/real/codex', TMPDIR: '/inherited' }
  try {
    const environment = integrationEnvironment(inherited, slot)
    for (const name of Object.keys(inherited).filter(key => key.endsWith('DATABASE_URL'))) {
      assert.equal(environment[name], slot.databaseUrl)
    }
    assert.equal(environment.NIM2691_POSTGRES, '1')
    assert.equal(environment.TMPDIR, join(slot.directory, 'tmp'))
    assert.ok(environment.HOME.startsWith(slot.directory + '/'))
    assert.ok(environment.CODEX_HOME.startsWith(slot.directory + '/'))
    assert.equal(inherited.HRT_F14_ADMIN_DATABASE_URL, 'postgresql://remote/live')
    const retest = integrationEnvironment(environment, { ...slot, databaseUrl: databaseUrl + '_retest' })
    assert.equal(retest.HRT_F14_ADMIN_DATABASE_URL, databaseUrl + '_retest')
    for (const url of ['postgresql://graphql:graphql@127.0.0.1:5432/graphql',
      'postgresql://graphql_test_admin:graphql_test_disposable_only@remote:55439/test', databaseUrl + '?options=unsafe']) {
      assert.throws(() => integrationEnvironment(inherited, { ...slot, databaseUrl: url }), /dedicated disposable/)
    }
    assert.throws(() => integrationEnvironment(inherited, { ...slot, token: 'another-owner' }), /ownership/)
  } finally { removeTestRoot(resource) }
})

test('the runner database selector accepts only the dedicated disposable server', () => {
  assert.equal(requireTestServerUrl(testAdminUrl).href, testAdminUrl)
  assert.equal(requireTestServerUrl(new URL('/graphql_test_selected', testAdminUrl).href).pathname,
    '/graphql_test_selected')
  for (const url of ['postgresql://graphql:graphql@127.0.0.1:5432/graphql',
    testAdminUrl.replace('127.0.0.1', 'remote'), `${testAdminUrl}?options=unsafe`]) {
    assert.throws(() => requireTestServerUrl(url), /dedicated disposable/)
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
    const environment = { FOREMAN_CODE_HEAVY_JOB_COMMON: common, FOREMAN_CODE_HEAVY_JOB_TOKEN: owner.token }
    writeFileSync(legacy, JSON.stringify(owner))
    assert.equal(hasHeavyJobAdmission(environment, common), true)
    writeFileSync(legacy, JSON.stringify({ ...owner, token: 'another-slot' }))
    const secondary = join(running, '000000000002-secondary')
    writeFileSync(secondary, JSON.stringify(owner))
    writeFileSync(join(running, '000000000001-malformed'), '{')
    assert.equal(hasHeavyJobAdmission(environment, common), true)
    assert.equal(hasHeavyJobAdmission({ ...environment, FOREMAN_CODE_HEAVY_JOB_TOKEN: 'forged' }, common), false)
    assert.equal(hasHeavyJobAdmission({ ...environment, FOREMAN_CODE_HEAVY_JOB_COMMON: '/other/common' }, common), false)
    for (const invalid of [{ ...owner, start: 'stale' }, { ...owner, common: '/other/common' }, { ...owner, pid: 0 }]) {
      writeFileSync(secondary, JSON.stringify(invalid))
      assert.equal(hasHeavyJobAdmission(environment, common), false)
    }
    writeFileSync(secondary, JSON.stringify(owner))
    rmSync(legacy)
    assert.equal(hasHeavyJobAdmission(environment, common), true)
  } finally { rmSync(common, { recursive: true, force: true }) }
})


test('machine reports keep first-pass failures after a successful fresh-DB diagnostic', () => {
  const failed = { file: 'a', code: 1, complete: true, report: {
    totals: { total: 2, passed: 1, failed: 1, skipped: 0 }, files: [] } }
  const retest = { file: 'a', code: 0, complete: true, report: {
    totals: { total: 2, passed: 2, failed: 0, skipped: 0 }, files: [] } }
  const report = integrationReport(['a'], [failed], [retest], {
    startedAt: '2026-10-05T00:00:00.000Z', finishedAt: '2026-10-05T00:01:00.000Z',
    interrupted: null, diagnostic: false, processStopped: true })
  assert.equal(report.outcome, 'failed')
  assert.equal(report.firstPassFailed, 1)
  assert.equal(report.totals.failed, 1)
  assert.equal(report.retests[0].totals.failed, 0)
})

test('missing JSON, unexecuted files and interruption retain an honest partial report', () => {
  const firstPass = [{ file: 'a', code: 0, complete: true,
    report: { totals: { total: 2, passed: 2, failed: 0, skipped: 0 }, files: [] } },
  { file: 'b', code: 1, complete: false, reportError: 'missing JSON' }]
  const settings = { startedAt: '2026-10-05T00:00:00.000Z', finishedAt: '2026-10-05T00:01:00.000Z',
    interrupted: null, diagnostic: false, processStopped: true }
  const partial = integrationReport(['a', 'b', 'c'], firstPass, [], settings)
  assert.equal(partial.outcome, 'incomplete')
  assert.equal(partial.completeness, 'partial')
  assert.equal(partial.completedPortions, 1)
  assert.equal(partial.files[2].reason, 'not executed')
  assert.equal(partial.totals.passed, 2)
  const cancelled = integrationReport(['a', 'b', 'c'], firstPass, [], { ...settings, interrupted: 'SIGTERM' })
  assert.equal(cancelled.outcome, 'cancelled')
  assert.equal(cancelled.totals.passed, 2)
})

test('skipped cases and diagnostic resumes cannot satisfy a complete integration gate', () => {
  const firstPass = [{ file: 'a', code: 0, complete: true,
    report: { totals: { total: 2, passed: 1, failed: 0, skipped: 1 }, files: [] } }]
  const settings = { startedAt: '2026-10-05T00:00:00.000Z', finishedAt: '2026-10-05T00:01:00.000Z',
    interrupted: null, diagnostic: false, processStopped: true }
  const full = integrationReport(['a'], firstPass, [], settings)
  assert.equal(full.outcome, 'failed')
  assert.equal(full.disallowedSkipped, 1)
  const diagnostic = integrationReport(['a'], firstPass, [], { ...settings, diagnostic: true })
  assert.equal(diagnostic.outcome, 'incomplete')
  assert.equal(diagnostic.completeness, 'partial')
})


test('Job integration shards require and respect both reservation and qualification', () => {
  assert.equal(reservedIntegrationShards({}), 12)
  const job = { FOREMAN_CODE_VERIFICATION_ROOT: '/source',
    FOREMAN_CODE_VERIFICATION_INTEGRATION_SHARDS: '1', FOREMAN_CODE_VERIFICATION_MAX_INTEGRATION_SHARDS: '1' }
  assert.equal(reservedIntegrationShards(job), 1)
  assert.throws(() => reservedIntegrationShards({ FOREMAN_CODE_VERIFICATION_ROOT: '/source' }), /require reserved/)
  assert.throws(() => reservedIntegrationShards({ ...job, GRAPHQL_INTEGRATION_SHARDS: '2' }), /exceed/)
  assert.throws(() => reservedIntegrationShards({ ...job, FOREMAN_CODE_VERIFICATION_INTEGRATION_SHARDS: '2',
    GRAPHQL_INTEGRATION_SHARDS: '2' }), /exceed/)
})

test('slowest recorded files start first and unmeasured files lead the queue', async () => {
  const files = ['unmeasured-b', 'fast', 'slow', 'same-speed', 'unmeasured-a']
  const durations = { fast: 5000, slow: 90000, 'same-speed': 5000 }
  const ordered = orderByDuration(files, durations)
  assert.deepEqual(ordered, ['unmeasured-b', 'unmeasured-a', 'slow', 'fast', 'same-speed'])
  const started = []
  await scheduleFiles(ordered, [1], async (_slot, file) => {
    started.push(file)
    return { code: 0 }
  })
  assert.deepEqual(started, ordered)
  assert.deepEqual(files, ['unmeasured-b', 'fast', 'slow', 'same-speed', 'unmeasured-a'])
})

test('recorded durations persist across runs, replace earlier ones and forget removed files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-durations-'))
  try {
    const path = join(directory, 'cache', 'durations.json')
    writeDurations(path, { gone: 1, kept: 2, updated: 3 })
    writeDurations(path, mergeDurations(readDurations(path), { updated: 30 }, ['kept', 'updated']))
    assert.deepEqual(readDurations(path), { kept: 2, updated: 30 })
    assert.deepEqual(orderByDuration(['kept', 'updated'], readDurations(path)), ['updated', 'kept'])
    assert.deepEqual(mergeDurations({ invalid: -1 }, { infinite: Infinity, string: '3', zero: 0 },
      ['invalid', 'infinite', 'string', 'zero']), { zero: 0 })
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('missing or corrupt duration records fall back to discovery order', () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-durations-'))
  try {
    const path = join(directory, 'durations.json')
    assert.deepEqual(readDurations(path), {})
    for (const contents of ['{', 'null', '[]', '42']) {
      writeFileSync(path, contents)
      assert.deepEqual(readDurations(path), {})
      assert.deepEqual(orderByDuration(['b', 'a'], readDurations(path)), ['b', 'a'])
    }
    assert.deepEqual(orderByDuration(['b', 'a'], { b: -1, a: 'invalid' }), ['b', 'a'])
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('integration files launch workspace Vitest directly with package binaries and isolated state', () => {
  const resource = createTestRoot()
  try {
    const file = 'apps/api/test/dev-startup.integration.test.ts'
    const slot = { ...resource, databaseUrl: new URL('/graphql_test_owned', testAdminUrl).href }
    const environment = integrationEnvironment({ PATH: process.env.PATH }, slot)
    const json = join(resource.directory, 'vitest.json')
    const vitest = vitestCommand(environment, file, 'first case|second case', json)
    assert.deepEqual(vitest.args, ['run', 'test/dev-startup.integration.test.ts', '--no-file-parallelism',
      '--maxWorkers=1', '--maxConcurrency=1', '--reporter=verbose', '--reporter=json',
      `--outputFile.json=${json}`, '--fsModuleCache', '--testNamePattern', 'first case|second case'])
    assert.equal(vitest.env.TEST_DATABASE_URL, slot.databaseUrl)
    assert.equal(vitest.env.HOME, environment.HOME)
    assert.equal(vitest.env.FOREMAN_CODE_TEST_OWNER, resource.token)
    const version = spawnSync(vitest.command, ['--version'], { cwd: vitest.cwd, env: vitest.env, encoding: 'utf8' })
    assert.equal(version.status, 0, version.stderr || version.error?.message)
    assert.match(version.stdout, /vitest\/\d+/)
    const tsx = spawnSync('tsx', ['--version'], { cwd: vitest.cwd, env: vitest.env, encoding: 'utf8' })
    assert.equal(tsx.status, 0, tsx.stderr || tsx.error?.message)
    assert.match(tsx.stdout, /tsx v\d+/)
    assert.equal(environment.PATH, process.env.PATH)
  } finally { removeTestRoot(resource) }
})
