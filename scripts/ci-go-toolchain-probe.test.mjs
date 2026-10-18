import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const installer = fileURLToPath(new URL('./ci-go-toolchain.sh', import.meta.url))
const pins = JSON.parse(readFileSync(new URL('./ci-go-versions.json', import.meta.url), 'utf8'))
const recordProgram = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
function record(tool) {
  fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ tool, args,
    home: process.env.HOME, config: process.env.XDG_CONFIG_HOME,
    cache: process.env.XDG_CACHE_HOME, state: process.env.XDG_STATE_HOME,
    temp: process.env.TMPDIR, goTemp: process.env.GOTMPDIR,
    goroot: process.env.GOROOT, toolchain: process.env.GOTOOLCHAIN,
    telemetryOverride: process.env.TEST_TELEMETRY_DIR,
    homeMode: fs.statSync(process.env.HOME).mode & 0o777 }) + '\n')
}
`

// Model the supported compiler CLI, not Go's private mode-file layout or a guessed writer race.
const compilerProgram = recordProgram + String.raw`
record('compiler')
const mode = path.join(process.env.XDG_CONFIG_HOME, 'fixture-private-mode')
if (args.join(' ') === 'telemetry off') {
  if (process.env.FIXTURE_TELEMETRY_FAILURE === '1') {
    console.error('fixture compiler rejected private telemetry configuration')
    process.exit(17)
  }
  fs.writeFileSync(mode, 'off')
} else if (args.join(' ') === 'env GOVERSION') {
  if (!fs.existsSync(mode) || fs.readFileSync(mode, 'utf8') !== 'off') {
    console.error('fixture compiler probe can leave background work enabled')
    process.exit(41)
  }
  if (process.env.FIXTURE_VERSION_FAILURE === '1') {
    console.error('fixture compiler version query failed')
    process.exit(19)
  }
  console.log(process.env.FIXTURE_VERSION)
} else throw new Error('Unexpected public compiler command: ' + args.join(' '))
`

function executablePath(name) {
  const candidate = process.env.PATH.split(delimiter).map(directory => join(directory, name))
    .find(file => existsSync(file) && statSync(file).isFile() && (statSync(file).mode & 0o111))
  assert.ok(candidate, `The CI image needs ${name} for the public installer fixture.`)
  return candidate
}

function probeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-go-probe-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const cache = join(directory, 'cache with spaces')
  const root = join(cache, `toolchains/go${pins.go.version}`)
  const commands = join(directory, 'commands')
  const caller = join(directory, 'caller')
  const callers = Object.fromEntries(['home', 'config', 'cache', 'state', 'tmp', 'telemetry', 'observed-telemetry']
    .map(name => [name, join(caller, name)]))
  for (const path of [root, commands, ...Object.values(callers)]) mkdirSync(path, { recursive: true, mode: 0o700 })
  for (const path of Object.values(callers)) writeFileSync(join(path, 'sentinel'), 'caller state')
  const calls = join(directory, 'calls.jsonl')
  writeFileSync(calls, '')
  const lock = join(cache, 'install.lock')
  writeFileSync(lock, '')
  const lockInode = statSync(lock).ino
  const unrelated = join(cache, 'unrelated-cache-entry')
  writeFileSync(unrelated, 'unrelated cache state')
  for (const name of ['dirname', 'realpath', 'mkdir', 'mktemp', 'flock']) {
    symlinkSync(executablePath(name), join(commands, name))
  }
  symlinkSync(process.execPath, join(commands, 'node'))
  const executable = (path, program) => writeFileSync(path, `#!${process.execPath}\n${program}`, { mode: 0o700 })
  executable(join(commands, 'uname'), "console.log(process.argv[2] === '-s' ? 'Linux' : 'x86_64')\n")
  executable(join(commands, 'rm'), recordProgram + String.raw`
record('remove')
const probes = fs.readFileSync(process.env.FIXTURE_CALLS, 'utf8').trim().split('\n')
  .map(line => JSON.parse(line)).filter(call => call.tool === 'compiler').map(call => path.dirname(call.home))
if (process.env.FIXTURE_CLEANUP_FAILURE === '1' && probes.includes(args.at(-1))) {
  console.error('fixture removal boundary: Directory not empty')
  process.exit(23)
}
const result = require('node:child_process').spawnSync(process.env.FIXTURE_REAL_RM, args, { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
`)
  executable(join(commands, 'curl'), recordProgram + String.raw`
record('download')
console.error('fixture unexpected download after cached compiler failure')
process.exit(29)
`)
  mkdirSync(join(root, 'bin'))
  executable(join(root, 'bin/go'), compilerProgram)
  const environment = { ...process.env, BASH_ENV: '', ENV: '', PATH: commands,
    HOME: callers.home, XDG_CONFIG_HOME: callers.config, XDG_CACHE_HOME: callers.cache,
    XDG_STATE_HOME: callers.state, TMPDIR: callers.tmp, GOTMPDIR: callers.tmp,
    TEST_TELEMETRY_DIR: callers.telemetry, GOTELEMETRYDIR: callers['observed-telemetry'],
    FOREMAN_CODE_CI_GO_CACHE: cache, CI_STATE: directory, SUITE: 'unit',
    GOROOT: join(directory, 'stale-root'), GOTOOLCHAIN: 'auto',
    FIXTURE_CALLS: calls, FIXTURE_REAL_RM: executablePath('rm'), FIXTURE_VERSION: `go${pins.go.version}` }
  delete environment.NODE_TEST_CONTEXT
  return { cache, root, callers, lock, lockInode, unrelated,
    calls: () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    run(action = 'verify', extra = {}) {
      const result = spawnSync(executablePath('bash'), [installer, action], {
        cwd: directory, env: { ...environment, ...extra }, encoding: 'utf8', timeout: 20_000,
      })
      assert.ifError(result.error)
      return result
    },
  }
}

function assertCallerPreserved(fixture) {
  for (const path of Object.values(fixture.callers)) {
    assert.deepEqual(readdirSync(path), ['sentinel'])
    assert.equal(readFileSync(join(path, 'sentinel'), 'utf8'), 'caller state')
  }
  assert.equal(statSync(fixture.lock).ino, fixture.lockInode)
  assert.equal(readFileSync(fixture.unrelated, 'utf8'), 'unrelated cache state')
}

test('public Go verification quiesces private compiler telemetry before its version probe and cleans that state once', t => {
  const fixture = probeFixture(t)
  const result = fixture.run()
  assert.equal(result.status, 0, result.stderr)
  const compilers = fixture.calls().filter(call => call.tool === 'compiler')
  assert.deepEqual(compilers.map(call => call.args), [['telemetry', 'off'], ['env', 'GOVERSION']])
  const home = compilers[0].home
  assert.equal(home.startsWith(`${fixture.cache}/toolchain-probe.`), true)
  for (const call of compilers) {
    assert.equal(call.home, home)
    assert.equal(call.homeMode, 0o700)
    for (const [key, name] of [['config', 'config'], ['cache', 'cache'], ['state', 'state'], ['temp', 'tmp'], ['goTemp', 'tmp']]) {
      assert.equal(call[key], join(home, '..', name))
      assert.equal(existsSync(call[key]), false)
    }
    assert.equal(call.goroot, fixture.root)
    assert.equal(call.toolchain, 'local')
    assert.equal(call.telemetryOverride, undefined)
  }
  assert.equal(existsSync(home), false)
  const removals = fixture.calls().filter(call => call.tool === 'remove')
  assert.equal(removals.length, 1)
  assert.equal(removals[0].args.at(-1), join(home, '..'))
  assert.equal(fixture.calls().some(call => call.tool === 'download'), false)
  assertCallerPreserved(fixture)
})

test('public Go verification preserves a rejected private telemetry command and never queries the version', t => {
  const fixture = probeFixture(t)
  const result = fixture.run('verify', { FIXTURE_TELEMETRY_FAILURE: '1' })
  assert.equal(result.status, 17, result.stderr)
  assert.match(result.stderr, /fixture compiler rejected private telemetry configuration/)
  const compilers = fixture.calls().filter(call => call.tool === 'compiler')
  assert.deepEqual(compilers.map(call => call.args), [['telemetry', 'off']])
  assert.equal(existsSync(compilers[0].home), false)
  assert.equal(fixture.calls().filter(call => call.tool === 'remove').length, 1)
  assertCallerPreserved(fixture)
})

for (const [name, extra, status, message] of [
  ['a failed version query', { FIXTURE_VERSION_FAILURE: '1' }, 19, /fixture compiler version query failed/],
  ['an incorrect compiler version', { FIXTURE_VERSION: 'go0.0.0' }, 1, /compiler reports go0\.0\.0/],
]) {
  test(`public Go verification rejects ${name} and still cleans its private command state`, t => {
    const fixture = probeFixture(t)
    const result = fixture.run('verify', extra)
    assert.equal(result.status, status, result.stderr)
    assert.match(result.stderr, message)
    const compilers = fixture.calls().filter(call => call.tool === 'compiler')
    assert.deepEqual(compilers.map(call => call.args), [['telemetry', 'off'], ['env', 'GOVERSION']])
    assert.ok(compilers.every(call => !existsSync(call.home)))
    assert.equal(fixture.calls().filter(call => call.tool === 'remove').length, 1)
    assertCallerPreserved(fixture)
  })
}

test('public Go verification reports failed cleanup once without accepting the version result', t => {
  const fixture = probeFixture(t)
  const result = fixture.run('verify', { FIXTURE_CLEANUP_FAILURE: '1' })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /fixture removal boundary: Directory not empty/)
  assert.equal(fixture.calls().filter(call => call.tool === 'remove').length, 1)
  assert.equal(fixture.calls().filter(call => call.tool === 'compiler').length, 2)
  assert.equal(fixture.calls().some(call => call.tool === 'download'), false)
  assertCallerPreserved(fixture)
})

test('public Go verification retains the original compiler failure when cleanup also fails', t => {
  const fixture = probeFixture(t)
  const result = fixture.run('verify', { FIXTURE_TELEMETRY_FAILURE: '1', FIXTURE_CLEANUP_FAILURE: '1' })
  assert.equal(result.status, 17, result.stderr)
  assert.match(result.stderr, /fixture compiler rejected private telemetry configuration/)
  assert.match(result.stderr, /fixture removal boundary: Directory not empty/)
  assert.equal(fixture.calls().filter(call => call.tool === 'remove').length, 1)
  assert.deepEqual(fixture.calls().filter(call => call.tool === 'compiler').map(call => call.args), [['telemetry', 'off']])
  assertCallerPreserved(fixture)
})

test('a cached public Go install fails on probe cleanup without downloading a replacement or changing its lock inode', t => {
  const fixture = probeFixture(t)
  const result = fixture.run('install', { FIXTURE_CLEANUP_FAILURE: '1' })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /fixture removal boundary: Directory not empty/)
  assert.equal(fixture.calls().some(call => call.tool === 'download'), false)
  assert.equal(fixture.calls().filter(call => call.tool === 'compiler').length, 2)
  const probes = fixture.calls().filter(call => call.tool === 'remove'
    && call.args.at(-1).startsWith(`${fixture.cache}/toolchain-probe.`))
  assert.equal(probes.length, 1)
  assertCallerPreserved(fixture)
})

// Contract source lint-only diagnostic: 42f604ddd7f3c88e4af104d74dec2058754b4e99.
