import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const source = new URL('./heavy-job.mjs', import.meta.url).pathname
const hookSource = new URL('./vitest-heavy-setup.mjs', import.meta.url).pathname
// Frozen, unmodified scheduler from 4fb7c5b4; exercise real old callers.
const legacySource = new URL('./fixtures/heavy-job-single-slot.mjs', import.meta.url).pathname
const namespace = { boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pid: readlinkSync('/proc/self/ns/pid') }
const jobEnv = (cwd) => {
  const env = { ...process.env, GRAPHQL_HEAVY_BASE_TMPDIR: dirname(cwd) }
  delete env.GRAPHQL_HEAVY_JOB_COMMON
  delete env.GRAPHQL_HEAVY_JOB_TOKEN
  delete env.FOREMAN_CODE_HEAVY_JOB_COMMON
  delete env.FOREMAN_CODE_HEAVY_JOB_TOKEN
  delete env.FOREMAN_CODE_HEAVY_BASE_TMPDIR
  return env
}
const run = (cwd, args) => new Promise((resolve) => {
  const env = jobEnv(cwd)
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
  mkdirSync(join(first, 'packages/contracts/src'), { recursive: true })
  copyFileSync(new URL('../packages/contracts/src/productEnvironment.mjs', import.meta.url), join(first, 'packages/contracts/src/productEnvironment.mjs'))
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
  const common = git(first, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const state = join(common, 'graphql-heavy-jobs')
  const tempRoot = join(home, `graphql-heavy-${createHash('sha256').update(common).digest('hex').slice(0, 16)}`)
  return { home, first, second, common, state, tempRoot }
}
function mockProc(f, declarations) {
  // Change only the disposable script's read functions to model visibility errors.
  const path = join(f.first, 'scripts/heavy-job.mjs')
  const script = readFileSync(path, 'utf8').replace('readFileSync,', 'readFileSync as actualReadFileSync,').replace('readdirSync,', 'readdirSync as actualReaddirSync,')
  writeFileSync(path, `${script}\n${declarations}\n`)
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

// Each probe uses the normal scheduler in a disposable Git common directory.
// Stop only the fixture waiter once it reports admission or queuing.
async function probe(f) {
  const ran = join(f.home, 'probe-ran')
  const child = spawn(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(ran)},'yes')`], { cwd: f.first, env: jobEnv(f.first), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', ready
  const announced = new Promise((resolve) => { ready = resolve })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.stdout.on('data', (data) => { output += data; if (/\[heavy-job\] (queued|running)/.test(output)) ready() })
  child.stderr.on('data', (data) => { output += data })
  child.once('exit', ready)
  const timer = setTimeout(() => { child.kill('SIGTERM'); ready() }, 4000)
  try {
    await announced
    if (child.exitCode === null) child.kill('SIGTERM')
    await exited
    return { output, ran: existsSync(ran) }
  } finally { clearTimeout(timer) }
}

for (const [name, identity] of [
  ['foreign PID namespace', { ...namespace, pid: 'pid:[foreign-fixture]' }],
  ['foreign boot', { ...namespace, boot: 'foreign-fixture' }],
  ['legacy ownership without namespace', undefined],
]) {
  test(`cleanup preserves ${name} queue, active slot, and temp`, { timeout: 6000 }, async () => {
    const f = fixture()
    try {
      const record = JSON.stringify({ common: f.common, worktree: f.first, pid: 99999999, start: '0', pgid: null, token: randomUUID(), namespace: identity })
      const ticket = join(f.state, 'queue', '000000000001-foreign')
      const active = join(f.state, 'active')
      const temp = join(f.tempRoot, 'peer-temp')
      mkdirSync(dirname(ticket), { recursive: true })
      mkdirSync(active)
      mkdirSync(temp, { recursive: true })
      for (const path of [ticket, join(active, 'owner.json'), join(temp, 'owner.json')]) writeFileSync(path, record)
      for (const path of [ticket, active, temp]) utimesSync(path, new Date(0), new Date(0))
      const result = await probe(f)
      assert.match(result.output, /queued .*waiting/)
      assert.equal(result.ran, false)
      for (const path of [ticket, join(active, 'owner.json'), join(temp, 'owner.json')]) assert.equal(readFileSync(path, 'utf8'), record)
    } finally { rmSync(f.home, { recursive: true, force: true }) }
  })
}

for (const [name, pgid, denied] of [
  ['owner', null, '/proc/99999999/stat'],
  ['process group', 99999998, '/proc/99999998/stat'],
  ['token', null, '/proc/99999998/environ'],
]) test(`unreadable local ${name} evidence remains reserved`, { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    mockProc(f, `function readFileSync(path, ...args) { if (path === ${JSON.stringify(denied)}) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return actualReadFileSync(path, ...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999998'] : actualReaddirSync(path, ...args) }`)
    const path = join(f.state, 'queue', '000000000001-unreadable')
    mkdirSync(dirname(path), { recursive: true })
    const record = JSON.stringify({ common: f.common, pid: 99999999, start: '0', pgid, token: randomUUID(), namespace })
    writeFileSync(path, record)
    const result = await probe(f)
    assert.match(result.output, /queued .*waiting/)
    assert.equal(result.ran, false)
    assert.equal(readFileSync(path, 'utf8'), record)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('a dead queued owner cannot retain FIFO behind unrelated unreadable environments', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    mockProc(f, `function readFileSync(path, ...args) { if (path === '/proc/99999998/environ') throw Object.assign(new Error('unrelated fixture denied'), { code: 'EACCES' }); return actualReadFileSync(path, ...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999998'] : actualReaddirSync(path, ...args) }`)
    const ticket = join(f.state, 'queue', '000000000001-queued')
    mkdirSync(dirname(ticket), { recursive: true })
    writeFileSync(ticket, JSON.stringify({ common: f.common, pid: 99999999, start: '0', pgid: null, phase: 'queued', namespace, token: randomUUID() }))
    const result = await run(f.first, ['--', process.execPath, '-e', 'process.exit(0)'])
    assert.equal(result.code, 0, result.output)
    assert.equal(existsSync(ticket), false)
    assert.equal(existsSync(join(f.state, 'active')), false)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

for (const [name, phase, pid, pgid, identity] of [
  ['live queued owner', 'queued', process.pid, null, namespace],
  ['queued foreign ownership', 'queued', 99999999, null, { ...namespace, boot: 'foreign' }],
  ['queued unreadable owner', 'queued', 99999998, null, namespace],
  ['acquisition crash before the child PID is recorded', 'acquiring', 99999999, null, namespace],
  ['running crash before the child PID is recorded', 'running', 99999999, null, namespace],
  ['unknown phase', 'unknown', 99999999, null, namespace],
  ['inconsistent queued process group', 'queued', 99999999, 99999998, namespace],
]) test(`${name} remains reserved with unreadable evidence`, { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    mockProc(f, `function readFileSync(path, ...args) { if (path === '/proc/99999998/environ' || path === '/proc/99999998/stat') throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return actualReadFileSync(path, ...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999998'] : actualReaddirSync(path, ...args) }`)
    const ticket = join(f.state, 'queue', '000000000001-reserved')
    mkdirSync(dirname(ticket), { recursive: true })
    const start = pid === process.pid ? readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] : '0'
    const record = JSON.stringify({ common: f.common, pid, start, pgid, phase, namespace: identity, token: randomUUID() })
    writeFileSync(ticket, record)
    const result = await probe(f)
    assert.match(result.output, /queued .*waiting/)
    assert.equal(result.ran, false)
    assert.equal(readFileSync(ticket, 'utf8'), record)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

for (const pgidRecorded of [false, true]) test(`detached worker retains a dead running owner with ${pgidRecorded ? 'recorded group' : 'unrecorded group/token evidence'}`, { timeout: 6000 }, async () => {
  const f = fixture()
  const token = randomUUID()
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env: { ...process.env, GRAPHQL_HEAVY_JOB_TOKEN: token } })
  const exited = new Promise((resolve) => worker.once('exit', resolve))
  try {
    mockProc(f, `function readFileSync(...args) { return actualReadFileSync(...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? [${JSON.stringify(String(worker.pid))}] : actualReaddirSync(path, ...args) }`)
    const ticket = join(f.state, 'queue', '000000000001-detached')
    mkdirSync(dirname(ticket), { recursive: true })
    const record = JSON.stringify({ common: f.common, pid: 99999999, start: '0', pgid: pgidRecorded ? worker.pid : null, phase: 'acquiring', namespace, token })
    writeFileSync(ticket, record)
    const result = await probe(f)
    assert.match(result.output, /queued .*waiting/)
    assert.equal(result.ran, false)
    assert.equal(readFileSync(ticket, 'utf8'), record)
  } finally {
    worker.kill('SIGTERM')
    await exited
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('a coordinator crash at spawn leaves acquiring provenance in every marker', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    const scriptPath = join(f.first, 'scripts/heavy-job.mjs')
    const script = readFileSync(scriptPath, 'utf8')
    const spawnLine = "    child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: environment, detached: true })"
    assert.ok(script.includes(spawnLine))
    writeFileSync(scriptPath, script.replace(spawnLine, "    process.kill(process.pid, 'SIGKILL')\n" + spawnLine))
    const result = await run(f.first, ['--', process.execPath, '-e', 'process.exit(0)'])
    assert.equal(result.child.signalCode, 'SIGKILL', result.output)
    const ticket = join(f.state, 'queue', readdirSync(join(f.state, 'queue'))[0])
    const active = join(f.state, 'active', 'owner.json')
    const temp = join(f.tempRoot, readdirSync(f.tempRoot)[0], 'owner.json')
    for (const path of [ticket, active, temp]) {
      const record = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(record.phase, 'acquiring')
      assert.equal(record.pgid, null)
    }
    copyFileSync(source, scriptPath)
    mockProc(f, `function readFileSync(path, ...args) { if (path === '/proc/99999998/environ') throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return actualReadFileSync(path, ...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999998'] : actualReaddirSync(path, ...args) }`)
    const next = await probe(f)
    assert.match(next.output, /queued .*waiting/)
    assert.equal(next.ran, false)
    for (const path of [ticket, active, temp]) assert.equal(existsSync(path), true)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('marker publication failure stops the spawned group before releasing its slot', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    const scriptPath = join(f.first, 'scripts/heavy-job.mjs')
    const pidPath = join(f.home, 'unpublished-pid')
    const script = readFileSync(scriptPath, 'utf8').replace('writeFileSync }', 'writeFileSync as actualWriteFileSync }')
    writeFileSync(scriptPath, `${script}\nfunction writeFileSync(path, data, ...args) { if (path.startsWith(queue + '/') && JSON.parse(data).phase === 'running') { actualWriteFileSync(${JSON.stringify(pidPath)}, String(JSON.parse(data).pgid)); throw new Error('fixture marker publication failure') } return actualWriteFileSync(path, data, ...args) }\n`)
    const result = await run(f.first, ['--stop-grace-ms', '100', '--', process.execPath, '-e', 'setInterval(()=>{},1000)'])
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /fixture marker publication failure/)
    assert.equal(pidRunning(Number(readFileSync(pidPath, 'utf8'))), false)
    assert.equal(existsSync(join(f.state, 'active')), false)
    assert.deepEqual(readdirSync(join(f.state, 'queue')), [])
    copyFileSync(source, scriptPath)
    assert.equal((await run(f.first, ['--', process.execPath, '-e', 'process.exit(0)'])).code, 0)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('malformed queue and missing active ownership remain reserved', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    const path = join(f.state, 'queue', '000000000001-aaaaaaaa')
    const active = join(f.state, 'active')
    mkdirSync(dirname(path), { recursive: true })
    mkdirSync(active)
    writeFileSync(path, '{')
    for (const entry of [path, active]) utimesSync(entry, new Date(0), new Date(0))
    const result = await probe(f)
    assert.match(result.output, /queued .*waiting/)
    assert.equal(result.ran, false)
    assert.equal(readFileSync(path, 'utf8'), '{')
    assert.equal(existsSync(active), true)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('matching namespace with complete dead-process evidence reclaims stale reservations', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    mockProc(f, `function readFileSync(...args) { return actualReadFileSync(...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999999'] : actualReaddirSync(path, ...args) }`)
    const record = JSON.stringify({ common: f.common, worktree: f.first, pid: 99999999, start: '0', pgid: null, token: randomUUID(), namespace })
    const ticket = join(f.state, 'queue', '000000000001-stale')
    const active = join(f.state, 'active')
    const temp = join(f.tempRoot, 'stale-temp')
    mkdirSync(dirname(ticket), { recursive: true })
    mkdirSync(active)
    mkdirSync(temp, { recursive: true })
    for (const path of [ticket, join(active, 'owner.json'), join(temp, 'owner.json')]) writeFileSync(path, record)
    for (const path of [ticket, active, temp]) utimesSync(path, new Date(0), new Date(0))
    const result = await run(f.first, ['--', process.execPath, '-e', 'process.exit(0)'])
    assert.equal(result.code, 0, result.output)
    for (const path of [ticket, active, temp]) assert.equal(existsSync(path), false)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('one stable token owns ticket, active slot, and temp; release preserves replacement ownership', { timeout: 6000 }, async () => {
  const f = fixture()
  const started = join(f.home, 'started')
  const released = join(f.home, 'released')
  const child = spawn(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'yes');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(released)})) clearInterval(timer)},20)`], { cwd: f.first, env: jobEnv(f.first), stdio: 'pipe' })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    await waitFile(started)
    const activePath = join(f.state, 'active', 'owner.json')
    const owner = JSON.parse(readFileSync(activePath, 'utf8'))
    const ticketPath = join(f.state, 'queue', readdirSync(join(f.state, 'queue'))[0])
    const tempPath = join(owner.tempPath, 'owner.json')
    const replacement = randomUUID()
    for (const path of [ticketPath, activePath, tempPath]) {
      const record = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(record.token, owner.token)
      assert.deepEqual(record.namespace, namespace)
      assert.equal(record.phase, 'running')
      writeFileSync(path, JSON.stringify({ ...record, token: replacement }))
    }
    writeFileSync(released, 'yes')
    assert.equal(await exited, 0)
    for (const path of [ticketPath, activePath, tempPath]) assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, replacement)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('nested worktree jobs reuse the same integration owner', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    const result = await run(f.first, ['--', process.execPath, join(f.second, 'scripts/heavy-job.mjs'), '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(join(f.home, 'nested-ran'))},'yes')`])
    assert.equal(result.code, 0, result.output)
    assert.equal((result.output.match(/\[heavy-job\] running /g) || []).length, 1)
    assert.equal(existsSync(join(f.home, 'nested-ran')), true)
    assert.equal(existsSync(join(f.state, 'active')), false)
    assert.deepEqual(readdirSync(join(f.state, 'queue')), [])
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('linked worktrees take one visible slot in ticket order', async () => {
  const f = fixture()
  try {
    const started = join(f.home, 'started')
    const released = join(f.home, 'released')
    const secondRan = join(f.home, 'second-ran')
    const first = spawn(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(started)},'yes'); while(!require('fs').existsSync(${JSON.stringify(released)})) require('child_process').spawnSync('sleep',['0.05'])`], { cwd: f.first, env: jobEnv(f.first), stdio: 'pipe' })
    await waitFile(started)
    const second = run(f.second, ['--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(secondRan)},'yes')`])
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(existsSync(secondRan), false)
    const pending = readdirSync(join(f.state, 'queue')).sort().at(-1)
    assert.equal(JSON.parse(readFileSync(join(f.state, 'queue', pending), 'utf8')).phase, 'queued')
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
    const child = spawn(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', `const c=require('child_process').spawn('sleep',['60']); require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); setInterval(()=>{},1000)`], { cwd: f.first, env: jobEnv(f.first), stdio: 'pipe' })
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

test('build freshness stays local and invalidates on source change; legacy temp is preserved', async () => {
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
    const stale = join(f.tempRoot, 'legacy-owned')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'owner.json'), JSON.stringify({ common: f.common, worktree: f.first, pid: 99999999, start: '0', pgid: null }))
    utimesSync(stale, new Date(0), new Date(0))
    assert.equal((await run(f.first, ['--', process.execPath, '-e', 'process.exit(0)'])).code, 0)
    assert.equal(existsSync(stale), true, 'legacy temp liveness is unknown')
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

const waitFor = async (check) => {
  for (let i = 0; i < 120; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for scheduler state')
}
function heldJob(f, label, cwd = f.first) {
  const started = join(f.home, `${label}-started`)
  const released = join(f.home, `${label}-released`)
  const script = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'yes');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(released)})) clearInterval(timer)},20)`
  const child = spawn(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', script], { cwd, env: jobEnv(cwd), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve({ code, output })))
  return { child, started, exited, release: () => writeFileSync(released, 'yes') }
}
async function stopJobs(jobs) {
  for (const job of jobs) if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill('SIGTERM')
  await Promise.all(jobs.map((job) => job.exited))
}
function configureSlots(f, value) {
  mkdirSync(f.state, { recursive: true })
  writeFileSync(join(f.state, 'slots'), String(value))
}

for (const setting of ['1', '0', '9', 'garbage']) test(`slot setting ${setting} keeps single-slot admission`, { timeout: 8000 }, async () => {
  const f = fixture(), jobs = []
  try {
    configureSlots(f, setting)
    const first = heldJob(f, 'first'); jobs.push(first)
    await waitFile(first.started)
    const second = heldJob(f, 'second', f.second); jobs.push(second)
    await waitFor(() => readdirSync(join(f.state, 'queue')).length === 2)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(existsSync(second.started), false)
    first.release()
    assert.equal((await first.exited).code, 0)
    await waitFile(second.started)
    second.release()
    assert.equal((await second.exited).code, 0)
  } finally { await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

test('three slots admit three jobs and preserve FIFO for waiting jobs', { timeout: 12000 }, async () => {
  const f = fixture(), jobs = []
  try {
    configureSlots(f, 3)
    for (let i = 0; i < 3; i++) {
      const job = heldJob(f, `active-${i}`, i % 2 ? f.second : f.first); jobs.push(job)
      await waitFile(job.started)
    }
    assert.equal(readdirSync(join(f.state, 'running')).length, 3)
    for (let i = 3; i < 5; i++) {
      jobs.push(heldJob(f, `waiting-${i}`))
      await waitFor(() => readdirSync(join(f.state, 'queue')).length === i + 1)
    }
    assert.equal(existsSync(jobs[3].started), false)
    assert.equal(existsSync(jobs[4].started), false)
    // Releasing the legacy owner must preserve the other two active records.
    jobs[0].release()
    assert.equal((await jobs[0].exited).code, 0)
    await waitFile(jobs[3].started)
    assert.equal(existsSync(jobs[4].started), false)
    assert.equal(readdirSync(join(f.state, 'running')).length, 3)
    jobs[1].release()
    assert.equal((await jobs[1].exited).code, 0)
    await waitFile(jobs[4].started)
    for (const job of jobs.slice(2)) job.release()
    for (const job of jobs.slice(2)) assert.equal((await job.exited).code, 0)
    assert.deepEqual(readdirSync(join(f.state, 'running')), [])
    assert.equal(existsSync(join(f.state, 'active')), false)
  } finally { await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

test('a live legacy owner consumes one slot; legacy release cannot erase new reservations', { timeout: 12000 }, async () => {
  const f = fixture(), jobs = []
  try {
    copyFileSync(legacySource, join(f.second, 'scripts/heavy-job.mjs'))
    configureSlots(f, 3)
    const old = heldJob(f, 'old', f.second); jobs.push(old)
    await waitFile(old.started)
    const ownerPath = join(f.state, 'active', 'owner.json')
    const original = readFileSync(ownerPath, 'utf8')
    for (let i = 1; i < 3; i++) {
      const job = heldJob(f, `new-${i}`); jobs.push(job)
      await waitFile(job.started)
    }
    assert.equal(readFileSync(ownerPath, 'utf8'), original, 'new jobs must not rewrite legacy ownership')
    assert.equal(readdirSync(join(f.state, 'running')).length, 2)
    const nextOld = heldJob(f, 'next-old', f.second); jobs.push(nextOld)
    await waitFor(() => readdirSync(join(f.state, 'queue')).length === 4)
    old.release()
    assert.equal((await old.exited).code, 0)
    assert.equal(readdirSync(join(f.state, 'running')).length, 2)
    // A waiting old ticket remains ahead of new tickets even with capacity free.
    const nextNew = heldJob(f, 'next-new'); jobs.push(nextNew)
    await waitFor(() => readdirSync(join(f.state, 'queue')).length === 4)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(existsSync(nextOld.started), false)
    assert.equal(existsSync(nextNew.started), false)
    for (const job of jobs.slice(1, 3)) job.release()
    for (const job of jobs.slice(1, 3)) assert.equal((await job.exited).code, 0)
    await waitFile(nextOld.started)
    await waitFile(nextNew.started)
    nextOld.release(); nextNew.release()
    assert.equal((await nextOld.exited).code, 0)
    assert.equal((await nextNew.exited).code, 0)
  } finally { await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

test('old callers wait for all new jobs to drain and old cleanup preserves a live gate', { timeout: 12000 }, async () => {
  const f = fixture(), jobs = []
  try {
    copyFileSync(legacySource, join(f.second, 'scripts/heavy-job.mjs'))
    configureSlots(f, 3)
    for (let i = 0; i < 3; i++) {
      const job = heldJob(f, `new-${i}`); jobs.push(job)
      await waitFile(job.started)
    }
    jobs[0].release()
    assert.equal((await jobs[0].exited).code, 0)
    utimesSync(join(f.state, 'active'), new Date(0), new Date(0))
    const old = heldJob(f, 'old', f.second); jobs.push(old)
    await waitFor(() => readdirSync(join(f.state, 'queue')).length === 3)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(existsSync(old.started), false)
    assert.equal(existsSync(join(f.state, 'active')), true)
    for (const job of jobs.slice(1, 3)) job.release()
    for (const job of jobs.slice(1, 3)) assert.equal((await job.exited).code, 0)
    await waitFile(old.started)
    old.release()
    assert.equal((await old.exited).code, 0)
  } finally { await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

test('multi-slot cleanup reclaims dead owners but preserves foreign and replacement records', { timeout: 8000 }, async () => {
  const f = fixture()
  try {
    mockProc(f, `function readFileSync(...args) { return actualReadFileSync(...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999999'] : actualReaddirSync(path, ...args) }`)
    configureSlots(f, 3)
    const running = join(f.state, 'running')
    mkdirSync(running)
    const base = { common: f.common, pid: 99999999, start: '0', pgid: null, namespace, token: randomUUID() }
    const stale = join(running, '000000000001-stale')
    const foreign = join(running, '000000000002-foreign')
    writeFileSync(stale, JSON.stringify(base))
    const unknown = JSON.stringify({ ...base, namespace: { ...namespace, boot: 'foreign' }, token: randomUUID() })
    writeFileSync(foreign, unknown)
    for (const path of [stale, foreign]) utimesSync(path, new Date(0), new Date(0))
    assert.equal((await run(f.first, ['--', process.execPath, '-e', 'process.exit(0)'])).code, 0)
    assert.equal(existsSync(stale), false)
    assert.equal(readFileSync(foreign, 'utf8'), unknown)
    // Release must never remove a record whose ownership token has changed.
    const job = heldJob(f, 'replacement')
    try {
      await waitFile(job.started)
      const path = readdirSync(running).map((name) => join(running, name)).find((path) => JSON.parse(readFileSync(path, 'utf8')).pid === job.child.pid)
      const replacement = { ...JSON.parse(readFileSync(path, 'utf8')), token: randomUUID() }
      writeFileSync(path, JSON.stringify(replacement))
      job.release()
      assert.equal((await job.exited).code, 0)
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), replacement)
    } finally { await stopJobs([job]) }
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('a crashed wrapper retains its slot while token-bearing descendants are live', { timeout: 10000 }, async () => {
  const f = fixture(), jobs = []
  try {
    // Model complete visibility of fixture processes; unrelated host processes
    // may deny /proc reads, which correctly prevents production reclamation.
    const visible = join(f.home, 'visible-pids')
    writeFileSync(visible, '[]')
    mockProc(f, `function readFileSync(...args) { return actualReadFileSync(...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? JSON.parse(actualReadFileSync(${JSON.stringify(visible)}, 'utf8')) : actualReaddirSync(path, ...args) }`)
    configureSlots(f, 1)
    const crashed = heldJob(f, 'crashed'); jobs.push(crashed)
    await waitFile(crashed.started)
    crashed.child.kill('SIGKILL')
    await crashed.exited
    const recordPath = join(f.state, 'running', readdirSync(join(f.state, 'running'))[0])
    const crashedOwner = JSON.parse(readFileSync(recordPath, 'utf8'))
    utimesSync(recordPath, new Date(0), new Date(0))
    utimesSync(join(f.state, 'active'), new Date(0), new Date(0))
    const next = heldJob(f, 'next'); jobs.push(next)
    writeFileSync(visible, JSON.stringify([crashed.child.pid, crashedOwner.pgid, next.child.pid].map(String)))
    await waitFor(() => readdirSync(join(f.state, 'queue')).length === 2)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(existsSync(next.started), false)
    crashed.release()
    await waitFile(next.started)
    assert.equal(existsSync(recordPath), false)
    next.release()
    assert.equal((await next.exited).code, 0)
  } finally { for (const job of jobs) job.release(); await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

test('Vitest secondary-slot setup and nested jobs reuse their own token', { timeout: 8000 }, async () => {
  const f = fixture(), jobs = []
  let teardown
  try {
    configureSlots(f, 3)
    const primary = heldJob(f, 'primary'); jobs.push(primary)
    await waitFile(primary.started)
    copyFileSync(hookSource, join(f.first, 'scripts/vitest-heavy-setup.mjs'))
    const { default: setup } = await import(pathToFileURL(join(f.first, 'scripts/vitest-heavy-setup.mjs')).href)
    teardown = await setup()
    const record = readdirSync(join(f.state, 'running')).map((name) => JSON.parse(readFileSync(join(f.state, 'running', name), 'utf8'))).find((record) => record.token === process.env.GRAPHQL_HEAVY_JOB_TOKEN)
    assert.ok(record)
    assert.notEqual(record.pid, primary.child.pid)
    assert.equal(await setup(), undefined, 'nested hook must reuse its own slot')
    const nested = spawn(process.execPath, [join(f.second, 'scripts/heavy-job.mjs'), '--', process.execPath, '-e', 'process.exit(0)'], { cwd: f.second, env: { ...process.env }, stdio: 'pipe' })
    assert.equal(await new Promise((resolve) => nested.once('exit', resolve)), 0)
    assert.equal(readdirSync(join(f.state, 'running')).length, 2)
    await teardown(); teardown = null
    assert.equal(readdirSync(join(f.state, 'running')).length, 1)
  } finally { if (teardown) await teardown(); await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

test('queued callers reread a changed shared slot count without restarting', { timeout: 10000 }, async () => {
  const f = fixture(), jobs = []
  try {
    configureSlots(f, 1)
    const first = heldJob(f, 'first'); jobs.push(first)
    await waitFile(first.started)
    for (let i = 1; i < 3; i++) {
      jobs.push(heldJob(f, `queued-${i}`))
      await waitFor(() => readdirSync(join(f.state, 'queue')).length === i + 1)
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(existsSync(jobs[1].started), false)
    configureSlots(f, 3)
    for (const job of jobs.slice(1)) await waitFile(job.started)
    assert.equal(readdirSync(join(f.state, 'running')).length, 3)
    for (const job of jobs) job.release()
    for (const job of jobs) assert.equal((await job.exited).code, 0)
  } finally { await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

for (const [name, contents] of [
  ['malformed', '{'],
  ['missing namespace', JSON.stringify({ pid: 99999999, start: '0', pgid: null, token: 'unknown' })],
]) test(`new ${name} slot records remain reserved`, { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    const path = join(f.state, 'running', '000000000001-unknown')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    utimesSync(path, new Date(0), new Date(0))
    const result = await probe(f)
    assert.match(result.output, /queued .*waiting/)
    assert.equal(result.ran, false)
    assert.equal(readFileSync(path, 'utf8'), contents)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})
