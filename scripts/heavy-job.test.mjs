import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const source = new URL('./heavy-job.mjs', import.meta.url).pathname
const hookSource = new URL('./vitest-heavy-setup.mjs', import.meta.url).pathname
const run = (cwd, args) => new Promise((resolve) => {
  const env = { ...process.env }
  delete env.GRAPHQL_HEAVY_JOB_COMMON
  delete env.GRAPHQL_HEAVY_JOB_TOKEN
  const child = spawn(process.execPath, ['scripts/heavy-job.mjs', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  child.once('exit', (code) => resolve({ code, output, child }))
})
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'graphql-heavy-test-'))
  const first = join(home, 'one')
  mkdirSync(join(first, 'scripts'), { recursive: true })
  copyFileSync(source, join(first, 'scripts/heavy-job.mjs'))
  writeFileSync(join(first, 'package.json'), '{"type":"module"}')
  writeFileSync(join(first, 'source.txt'), 'first')
  writeFileSync(join(first, '.gitignore'), 'count\ndist/\n.logs/\n')
  git(first, 'init', '-q')
  git(first, 'add', '.')
  git(first, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
  const second = join(home, 'two')
  git(first, 'worktree', 'add', '-q', '--detach', second)
  for (const worktree of [first, second]) {
    mkdirSync(join(worktree, 'packages/contracts'), { recursive: true })
    symlinkSync(join(new URL('..', import.meta.url).pathname, 'packages/contracts/node_modules'), join(worktree, 'packages/contracts/node_modules'), 'dir')
  }
  return { home, first, second, common: git(first, 'rev-parse', '--path-format=absolute', '--git-common-dir') }
}
const waitFile = async (path) => {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${path}`)
}
const pidRunning = (pid) => {
  try { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'); return text.split(') ')[1][0] !== 'Z' } catch { return false }
}

test('linked worktrees take one visible slot in ticket order', async () => {
  const f = fixture()
  try {
    const started = join(f.home, 'started')
    const released = join(f.home, 'released')
    const secondRan = join(f.home, 'second-ran')
    const first = spawn(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(started)},'yes'); while(!require('fs').existsSync(${JSON.stringify(released)})) require('child_process').spawnSync('sleep',['0.05'])`], { cwd: f.first, stdio: 'pipe' })
    await waitFile(started)
    const second = run(f.second, ['--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(secondRan)},'yes')`])
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(existsSync(secondRan), false)
    writeFileSync(released, 'yes')
    assert.equal(await new Promise((resolve) => first.once('exit', resolve)), 0)
    const result = await second
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /queued .*waiting/)
    assert.equal(existsSync(secondRan), true)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('termination stops descendants before releasing the slot', async () => {
  const f = fixture()
  try {
    const pidFile = join(f.home, 'descendant-pid')
    const child = spawn(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', `const c=require('child_process').spawn('sleep',['60']); require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); setInterval(()=>{},1000)`], { cwd: f.first, stdio: 'pipe' })
    await waitFile(pidFile)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
    assert.equal(pidRunning(pid), false)
    const next = await run(f.second, ['--', process.execPath, '-e', 'process.exit(0)'])
    assert.equal(next.code, 0, next.output)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('timeout terminates the process group and frees the next ticket', async () => {
  const f = fixture()
  try {
    const pidFile = join(f.home, 'timeout-descendant')
    const result = await run(f.first, ['--timeout-ms', '300', '--', process.execPath, '-e', `const c=require('child_process').spawn('sleep',['60']);require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`])
    assert.notEqual(result.code, 0)
    assert.match(result.output, /timed out/)
    assert.equal(pidRunning(Number(readFileSync(pidFile, 'utf8'))), false)
    assert.equal((await run(f.second, ['--', process.execPath, '-e', 'process.exit(0)'])).code, 0)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('a TERM-ignoring child is killed after the grace period', async () => {
  const f = fixture()
  try {
    const started = Date.now()
    const result = await run(f.first, ['--timeout-ms', '300', '--stop-grace-ms', '250', '--', process.execPath, '-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`])
    assert.notEqual(result.code, 0)
    assert.match(result.output, /timed out/)
    assert.ok(Date.now() - started < 3000, 'cancellation exceeded its grace period')
    assert.equal((await run(f.second, ['--', process.execPath, '-e', 'process.exit(0)'])).code, 0)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('build freshness stays local and invalidates on source change; stale owned temp is removed', async () => {
  const f = fixture()
  try {
    const script = `const fs=require('fs');fs.mkdirSync('packages/contracts/dist',{recursive:true});fs.writeFileSync('packages/contracts/dist/index.js','built');fs.appendFileSync('count','x')`
    const args = ['--build', 'contracts', '--', process.execPath, '-e', script]
    assert.equal((await run(f.first, args)).code, 0)
    assert.equal((await run(f.first, args)).code, 0)
    assert.equal(readFileSync(join(f.first, 'count'), 'utf8'), 'x')
    assert.equal((await run(f.second, args)).code, 0)
    assert.equal(readFileSync(join(f.second, 'count'), 'utf8'), 'x')
    writeFileSync(join(f.first, 'source.txt'), 'changed')
    assert.equal((await run(f.first, args)).code, 0)
    assert.equal(readFileSync(join(f.first, 'count'), 'utf8'), 'xx')
    const tempRoot = join(tmpdir(), `graphql-heavy-${createHash('sha256').update(f.common).digest('hex').slice(0, 16)}`)
    const stale = join(tempRoot, 'stale-owned')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'owner.json'), JSON.stringify({ common: f.common, worktree: f.first, pid: 99999999, start: '0', pgid: null }))
    utimesSync(stale, new Date(0), new Date(0))
    assert.equal((await run(f.first, ['--', process.execPath, '-e', 'process.exit(0)'])).code, 0)
    assert.equal(existsSync(stale), false)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('API build always runs its dynamic harness check', async () => {
  const f = fixture()
  try {
    const check = `require('fs').appendFileSync('count','x')`
    const args = ['--build', 'api', '--', process.execPath, '-e', check]
    assert.equal((await run(f.first, args)).code, 0)
    assert.equal((await run(f.first, args)).code, 0)
    assert.equal(readFileSync(join(f.first, 'count'), 'utf8'), 'xx')
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('Vitest coordinator hook admits once and releases after teardown', async () => {
  const f = fixture()
  let teardown
  try {
    copyFileSync(hookSource, join(f.first, 'scripts/vitest-heavy-setup.mjs'))
    const { default: setup } = await import(pathToFileURL(join(f.first, 'scripts/vitest-heavy-setup.mjs')).href)
    teardown = await setup()
    assert.equal(typeof teardown, 'function')
    assert.equal(typeof process.env.GRAPHQL_HEAVY_JOB_TOKEN, 'string')
    const ran = join(f.home, 'hook-second-ran')
    const second = run(f.second, ['--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(ran)},'yes')`])
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(existsSync(ran), false)
    await teardown()
    teardown = null
    const result = await second
    assert.equal(result.code, 0, result.output)
    assert.equal(existsSync(ran), true)
  } finally {
    if (teardown) await teardown()
    rmSync(f.home, { recursive: true, force: true })
  }
})
