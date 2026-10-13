import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { stopGroup } from './integration-process.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const reporter = join(repository, 'scripts/ci-progress-reporter.mjs')
const temporary = process.env.TMPDIR ?? join(homedir(), '.cache', 'foreman-tmp')
mkdirSync(temporary, { recursive: true })

test('CI suite kills a synchronous looping Vitest test and reports its file and name', { timeout: 85_000 }, async t => {
  const directory = mkdtempSync(join(temporary, 'ci-hang-'))
  mkdirSync(join(directory, 'bin'))
  symlinkSync(join(repository, 'packages/contracts/node_modules'), join(directory, 'node_modules'))
  writeFileSync(join(directory, 'loop.test.ts'), `import { test } from 'vitest'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
test('planner never returns', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true })
  writeFileSync('descendant.pid', String(child.pid))
  while (true) { /* synchronous planner fixture */ }
})
`)
  writeFileSync(join(directory, 'vitest.config.mjs'), `export default { test: {
    include: ['loop.test.ts'], maxWorkers: 1,
    reporters: ['default', ...${existsSync(reporter) ? JSON.stringify([reporter]) : '[]'}]
  } }
`)
  writeFileSync(join(directory, 'bin/pnpm'), `#!${process.execPath}
const { spawnSync } = require('node:child_process')
if (process.argv.includes('test')) {
  const result = spawnSync(process.execPath, [process.env.FIXTURE_VITEST, 'run', '--config', 'vitest.config.mjs'],
    { cwd: process.env.FIXTURE_ROOT, stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
`, { mode: 0o755 })
  const child = spawn('bash', [join(repository, 'scripts/ci-suite.sh')], {
    cwd: repository, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}`, SUITE: 'unit-other', SCOPE: 'full',
      CI_HOST_RUNNER: '0', CI_USER_SYSTEMD: '0', CI_STATE: join(directory, 'state'),
      CI_EXPECTED_DURATION_MS: '1000', CI_WATCHDOG_DIRECTORY: join(directory, 'watchdog'), CI_WATCHDOG_ACTIVE: '', CI_PROGRESS_FILE: '',
      FIXTURE_ROOT: directory, FIXTURE_VITEST: join(repository, 'packages/contracts/node_modules/vitest/vitest.mjs') },
  })
  t.after(async () => {
    await stopGroup(child.pid, { graceMs: 100 })
    const pidFile = join(directory, 'descendant.pid')
    if (existsSync(pidFile)) await stopGroup(Number(readFileSync(pidFile, 'utf8')), { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  })
  let output = ''
  child.stdout.on('data', bytes => { output += bytes })
  child.stderr.on('data', bytes => { output += bytes })
  // This outer test remains responsive while the fixture's event loop is blocked.
  const heartbeat = setInterval(() => console.log('Waiting for the looping CI fixture to fail'), 5000)
  t.after(() => clearInterval(heartbeat))
  const deadline = setTimeout(() => {
    void stopGroup(child.pid, { graceMs: 100 })
    const pidFile = join(directory, 'descendant.pid')
    if (existsSync(pidFile)) void stopGroup(Number(readFileSync(pidFile, 'utf8')), { graceMs: 100 })
  }, 75_000)
  t.after(() => clearTimeout(deadline))
  const started = Date.now()
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  assert.equal(code, 1, output)
  assert.match(output, /CI hang watchdog: no test progress for 60000 ms/)
  assert.match(output, /loop\.test\.ts.*planner never returns/)
  assert.ok(Date.now() - started < 70_000, output)
  const pid = Number(readFileSync(join(directory, 'descendant.pid'), 'utf8'))
  if (existsSync(`/proc/${pid}/stat`)) {
    assert.equal(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[0], 'Z')
  }
})

async function watchdogFixture(t, source, overrides = {}) {
  const { runCiPart } = await import('./ci-watchdog.mjs')
  const directory = mkdtempSync(join(temporary, 'ci-progress-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const messageFile = join(directory, 'message')
  const resultsFile = join(directory, 'results.json')
  const code = await runCiPart([process.execPath, '-e', source], { expectedDurationMs: 0,
    progressFile: join(directory, 'progress.jsonl'), messageFile, resultsFile,
    idleTimeoutMs: 1000, ...overrides })
  return { code, reason: existsSync(messageFile) ? readFileSync(messageFile, 'utf8') : null,
    results: existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : null }
}

test('CI deadlines use three expected durations with a two minute minimum', async () => {
  const { ciPartDeadlineMs } = await import('./ci-watchdog.mjs')
  assert.equal(ciPartDeadlineMs(0), 120_000)
  assert.equal(ciPartDeadlineMs(30_000), 120_000)
  assert.equal(ciPartDeadlineMs(210_000), 630_000)
})

test('test-start events identify concurrent stuck tests without resetting progress', async t => {
  const result = await watchdogFixture(t, `
    const { appendFileSync } = require('node:fs')
    let id = 0
    setInterval(() => appendFileSync(process.env.CI_PROGRESS_FILE,
      JSON.stringify({ type: 'start', kind: 'test', id: String(++id), file: 'loop.test.ts', name: 'loop ' + id }) + '\\n'), 30)
  `)
  assert.equal(result.code, 1)
  assert.match(result.reason, /no test progress for 1000 ms.*loop\.test\.ts > loop 1/)
  assert.ok(result.results.summary.failed > 1)
  assert.equal(result.results.files.length, 1)
})

test('new per-test results keep a progressing part alive', async t => {
  const result = await watchdogFixture(t, `
    const { appendFileSync } = require('node:fs')
    let id = 0
    const timer = setInterval(() => {
      appendFileSync(process.env.CI_PROGRESS_FILE, JSON.stringify({ type: 'finish', id: String(++id) }) + '\\n')
      if (id === 10) clearInterval(timer)
    }, 100)
  `)
  assert.equal(result.code, 0)
  assert.equal(result.reason, null)
})

test('the part deadline stops a process even while it keeps producing output', async t => {
  const result = await watchdogFixture(t, "setInterval(() => console.log('test output'), 30)", { deadlineMs: 500 })
  assert.equal(result.code, 1)
  assert.match(result.reason, /exceeded part deadline 500 ms/)
})
