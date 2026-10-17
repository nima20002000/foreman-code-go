import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./ci-go-toolchain.sh', import.meta.url))
const pins = JSON.parse(readFileSync(new URL('./ci-go-versions.json', import.meta.url), 'utf8'))
const recordProgram = String.raw`
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
function record(tool) {
  fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ tool, args, executable: process.argv[1],
    cwd: process.cwd(), home: process.env.HOME, path: process.env.PATH, goroot: process.env.GOROOT,
    gopath: process.env.GOPATH, modcache: process.env.GOMODCACHE, buildcache: process.env.GOCACHE,
    toolchain: process.env.GOTOOLCHAIN, goenv: process.env.GOENV, gowork: process.env.GOWORK,
    flags: process.env.GOFLAGS, proxy: process.env.GOPROXY, sumdb: process.env.GOSUMDB,
    private: process.env.GOPRIVATE, noproxy: process.env.GONOPROXY, nosumdb: process.env.GONOSUMDB,
    insecure: process.env.GOINSECURE, published: fs.existsSync(process.env.FIXTURE_PUBLISHED) }) + '\n')
}
`
const compilerProgram = recordProgram + String.raw`
record('compiler')
if (args.join(' ') !== 'env GOVERSION') throw new Error('Unexpected fixture compiler command')
console.log(process.env.FIXTURE_RESULT_VERSION || 'go' + process.env.FIXTURE_PINNED_GO)
`
const bootstrapProgram = recordProgram + String.raw`
record('bootstrap')
const bundledRoot = path.dirname(path.dirname(process.argv[1]))
if (args.join(' ') === 'env GOVERSION') {
  if (process.env.GOTOOLCHAIN !== 'local' || (process.env.GOROOT && process.env.GOROOT !== bundledRoot)) {
    throw new Error('Bootstrap inherited an unrelated target compiler')
  }
  const versions = JSON.parse(process.env.FIXTURE_BOOTSTRAP_VERSIONS || '{}')
  let version = versions[path.basename(process.argv[1])] || process.env.FIXTURE_BOOTSTRAP_VERSION || 'go1.26.8'
  if (process.env.FIXTURE_STAGED_VERSION && process.env.GOROOT && bundledRoot !== process.env.FIXTURE_INSTALLED_ROOT) {
    version = process.env.FIXTURE_STAGED_VERSION
  }
  console.log(version)
} else if (args.join(' ') === 'clean -modcache') {
  if (process.env.GOTOOLCHAIN !== 'local') throw new Error('Cleanup must use the installed bootstrap')
  if (process.env.FIXTURE_CLEAN_FAILURE === '1') {
    console.error('fixture owned module cache cleanup failed')
    process.exit(17)
  }
  fs.rmSync(process.env.GOMODCACHE, { recursive: true, force: true })
} else if (args.join(' ') === 'env GOROOT') {
  if (process.env.GOTOOLCHAIN === 'local') {
    console.log(process.env.FIXTURE_LOCAL_ROOT || bundledRoot)
    process.exit(0)
  }
  const shim = process.env.PATH.split(path.delimiter).map(directory => path.join(directory, process.env.GOTOOLCHAIN))
    .find(file => fs.existsSync(file))
  if (shim) {
    const result = require('node:child_process').spawnSync(shim, args, { env: process.env, stdio: 'inherit' })
    if (result.error) throw result.error
    process.exit(result.status ?? 1)
  }
  if (process.env.GOPROXY !== 'https://proxy.golang.org' || process.env.GOSUMDB !== 'sum.golang.org') {
    throw new Error('Toolchain authentication settings were not retained')
  }
  const root = path.join(process.env.GOMODCACHE,
    'golang.org/toolchain@v0.0.1-' + process.env.GOTOOLCHAIN + '.linux-' + process.env.GOARCH)
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'bin/go'), process.env.FIXTURE_COMPILER_PROGRAM, { mode: 0o755 })
  if (process.env.FIXTURE_DOWNLOAD_FAILURE === '1') {
    console.error('fixture checksum database verification failed')
    process.exit(11)
  }
  console.log(process.env.FIXTURE_WRONG_ROOT || root)
} else throw new Error('Unexpected fixture bootstrap command: ' + args.join(' '))
`

function executablePath(name) {
  const executable = process.env.PATH.split(delimiter).map(directory => join(directory, name))
    .find(file => existsSync(file) && statSync(file).isFile() && (statSync(file).mode & 0o111))
  assert.ok(executable, `The CI image needs ${name} for installer behavior tests.`)
  return executable
}

function toolchainFixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-go-installer-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'repository')
  const image = join(directory, 'image/bin')
  const commands = join(directory, 'commands')
  const cache = join(directory, 'cache with spaces')
  const home = join(directory, 'home')
  const state = join(directory, 'state')
  const calls = join(directory, 'calls.jsonl')
  const published = join(cache, `toolchains/go${pins.go.version}`)
  for (const path of [workspace, image, commands, cache, home, state, join(cache, 'modules')]) mkdirSync(path, { recursive: true })
  writeFileSync(calls, '')
  writeFileSync(join(cache, 'modules/shared-module'), 'shared module cache stays unchanged')
  writeFileSync(join(home, 'existing-state'), 'original home stays unchanged')
  for (const tool of ['dirname', 'realpath', 'mkdir', 'flock', 'mktemp', 'rm', 'tar', 'mv', 'sha256sum']) {
    symlinkSync(executablePath(tool), join(commands, tool))
  }
  symlinkSync(process.execPath, join(commands, 'node'))
  const writeExecutable = (file, program) => writeFileSync(file, `#!${process.execPath}\n${program}`, { mode: 0o755 })
  const bootstrap = (directory, name = 'go') => {
    mkdirSync(directory, { recursive: true })
    writeExecutable(join(directory, name), bootstrapProgram)
  }
  if (options.bootstrap !== false) bootstrap(image, options.bootstrapName)
  writeExecutable(join(commands, 'uname'), "console.log(process.argv[2] === '-s' ? 'Linux' : 'x86_64')\n")
  writeExecutable(join(commands, 'curl'), recordProgram + String.raw`
record('curl')
if (process.env.FIXTURE_ARCHIVE_RESPONSE === 'invalid') {
  fs.writeFileSync(args[args.indexOf('--output') + 1], 'invalid archive fixture')
} else {
  console.error('fixture pinned archive download failed')
  process.exit(22)
}
`)
  if (options.shim) writeExecutable(join(image, `go${pins.go.version}`),
    recordProgram + "record('versioned-shim'); throw new Error('Unrelated versioned PATH shim was executed')\n")
  const env = { ...process.env, BASH_ENV: '', ENV: '', HOME: home, CI_STATE: state, TMPDIR: state,
    FOREMAN_CODE_CI_GO_CACHE: cache, PATH: [image, commands].join(delimiter), SUITE: 'unit', GOENV: join(home, 'go-env'),
    GOROOT: join(workspace, 'inherited-go'), GOTOOLCHAIN: 'auto', GOFLAGS: '-mod=mod',
    GOPROXY: 'https://fixture.invalid', GOSUMDB: 'off', GOPRIVATE: '*', GONOPROXY: '*', GONOSUMDB: '*', GOINSECURE: '*',
    CI_PROGRESS_FILE: '', TEST_RESULTS_OUTPUT: '', DURATIONS_OUTPUT: '',
    FIXTURE_CALLS: calls, FIXTURE_PUBLISHED: published, FIXTURE_PINNED_GO: pins.go.version,
    FIXTURE_INSTALLED_ROOT: join(directory, 'image'),
    FIXTURE_COMPILER_PROGRAM: `#!${process.execPath}\n${compilerProgram}` }
  delete env.NODE_TEST_CONTEXT
  return {
    directory, workspace, image, commands, cache, home, state, published, bootstrap,
    run(extra = {}) {
      const result = spawnSync(executablePath('bash'), [script, 'install'], {
        cwd: workspace, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20_000,
      })
      assert.ifError(result.error)
      return result
    },
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
  }
}

for (const bootstrapName of ['go', 'go1.26.8']) {
  test(`a failed archive download uses installed ${bootstrapName} with authenticated isolated module settings`, t => {
    const fixture = toolchainFixture(t, { bootstrapName, shim: true })
    const result = fixture.run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(fixture.published, 'bin/go')), true)
    const calls = fixture.calls()
    const download = calls.find(call => call.tool === 'bootstrap' && call.toolchain === `go${pins.go.version}`)
    assert.ok(download)
    assert.equal(download.goroot, undefined)
    assert.equal(download.proxy, 'https://proxy.golang.org')
    assert.equal(download.sumdb, 'sum.golang.org')
    assert.deepEqual([download.goenv, download.gowork, download.flags], ['off', 'off', ''])
    assert.deepEqual([download.private, download.noproxy, download.nosumdb, download.insecure], ['', '', '', ''])
    assert.equal(download.home, join(download.cwd, 'home'))
    assert.equal(download.modcache, join(download.cwd, 'modules'))
    assert.equal(download.buildcache, join(download.cwd, 'build'))
    assert.equal(download.gopath, join(download.cwd, 'gopath'))
    assert.equal(download.path, join(download.cwd, 'path'))
    assert.equal(calls.some(call => call.tool === 'versioned-shim'), false)
    const compiler = calls.filter(call => call.tool === 'compiler')
    assert.equal(compiler[0].goroot, join(download.modcache, `golang.org/toolchain@v0.0.1-go${pins.go.version}.linux-amd64`))
    assert.equal(new Set(compiler.filter(call => !call.published).map(call => call.goroot)).size, 2)
    assert.equal(compiler.at(-1).published, true)
    assert.equal(compiler.at(-1).goroot, fixture.published)
    assert.ok(compiler.every(call => call.toolchain === 'local'))
    const cleanup = calls.find(call => call.tool === 'bootstrap' && call.args.join(' ') === 'clean -modcache')
    assert.ok(cleanup)
    assert.equal(cleanup.toolchain, 'local')
    assert.equal(cleanup.modcache, download.modcache)
    assert.equal(cleanup.published, false)
    assert.equal(existsSync(download.cwd), false)
    assert.equal(readFileSync(join(fixture.cache, 'modules/shared-module'), 'utf8'), 'shared module cache stays unchanged')
    assert.equal(readFileSync(join(fixture.home, 'existing-state'), 'utf8'), 'original home stays unchanged')
  })
}

test('an archive checksum failure remains terminal without probing or using a bootstrap', t => {
  const fixture = toolchainFixture(t)
  const result = fixture.run({ FIXTURE_ARCHIVE_RESPONSE: 'invalid' })
  assert.equal(result.status, 1, result.stderr)
  assert.equal(fixture.calls().some(call => call.tool === 'bootstrap'), false)
  assert.equal(existsSync(fixture.published), false)
})

test('an already exact installed compiler is reused without switching through another bootstrap', t => {
  const fixture = toolchainFixture(t)
  fixture.bootstrap(fixture.image, 'go1.26.8')
  const result = fixture.run({ FIXTURE_BOOTSTRAP_VERSIONS: JSON.stringify({ go: `go${pins.go.version}` }) })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /Reusing trusted installed Go 1\.27\.2/)
  assert.doesNotMatch(result.stderr, /from the authenticated toolchain module/)
  assert.equal(fixture.calls().some(call => call.toolchain === `go${pins.go.version}`), false)
  assert.equal(fixture.calls().some(call => call.executable === join(fixture.image, 'go1.26.8')), false)
  assert.equal(existsSync(join(fixture.published, 'bin/go')), true)
})

test('a same-version-only bootstrap publishes a verified owned copy with installed-source provenance', t => {
  const fixture = toolchainFixture(t)
  const result = fixture.run({ FIXTURE_BOOTSTRAP_VERSION: `go${pins.go.version}` })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /Reusing trusted installed Go 1\.27\.2.*source is the installed toolchain/)
  assert.doesNotMatch(result.stderr, /from the authenticated toolchain module/)
  const calls = fixture.calls()
  assert.equal(calls.some(call => call.toolchain === `go${pins.go.version}`), false)
  const rootQuery = calls.find(call => call.tool === 'bootstrap' && call.args.join(' ') === 'env GOROOT')
  assert.ok(rootQuery)
  assert.equal(rootQuery.toolchain, 'local')
  assert.equal(rootQuery.goroot, undefined)
  const verified = calls.filter(call => call.args.join(' ') === 'env GOVERSION' && call.goroot)
  assert.equal(verified[0].goroot, join(fixture.directory, 'image'))
  assert.equal(new Set(verified.filter(call => !call.published).map(call => call.goroot)).size, 2)
  assert.equal(verified.at(-1).goroot, fixture.published)
  assert.equal(verified.at(-1).published, true)
  assert.equal(lstatSync(join(fixture.published, 'bin/go')).isFile(), true)
  assert.equal(existsSync(rootQuery.cwd), false)
  assert.equal(readFileSync(join(fixture.cache, 'modules/shared-module'), 'utf8'), 'shared module cache stays unchanged')
})

test('an exact bootstrap cannot supply an unrelated installed Go root', t => {
  const fixture = toolchainFixture(t)
  const unrelated = join(fixture.directory, 'unrelated-go')
  fixture.bootstrap(join(unrelated, 'bin'))
  const result = fixture.run({ FIXTURE_BOOTSTRAP_VERSION: `go${pins.go.version}`, FIXTURE_LOCAL_ROOT: unrelated })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /installed Go root must contain the queried bootstrap compiler/)
  assert.equal(existsSync(fixture.published), false)
})

test('reused Go is verified again after staging before the CI cache is published', t => {
  const fixture = toolchainFixture(t)
  const result = fixture.run({ FIXTURE_BOOTSTRAP_VERSION: `go${pins.go.version}`, FIXTURE_STAGED_VERSION: 'go1.27.1' })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /Expected Go 1\.27\.2; compiler reports go1\.27\.1/)
  assert.equal(existsSync(fixture.published), false)
})

for (const [name, extra, status, message] of [
  ['checksum database verification', { FIXTURE_DOWNLOAD_FAILURE: '1' }, 11, /fixture checksum database verification failed/],
  ['wrong resulting version', { FIXTURE_RESULT_VERSION: 'go1.27.1' }, 1, /Expected Go 1\.27\.2; compiler reports go1\.27\.1/],
  ['an unrelated toolchain root', { FIXTURE_WRONG_ROOT: '/unrelated/toolchain' }, 1, /Downloaded Go must come from the owned toolchain module/],
]) {
  test(`module fallback rejects ${name} before publishing and cleans only its owned cache`, t => {
    const fixture = toolchainFixture(t)
    const result = fixture.run(extra)
    assert.equal(result.status, status, result.stderr)
    assert.match(result.stderr, message)
    assert.equal(existsSync(fixture.published), false)
    const cleanup = fixture.calls().find(call => call.tool === 'bootstrap' && call.args.join(' ') === 'clean -modcache')
    assert.ok(cleanup)
    assert.equal(cleanup.modcache, join(cleanup.cwd, 'modules'))
    assert.equal(existsSync(cleanup.cwd), false)
    assert.equal(existsSync(join(fixture.cache, 'modules/shared-module')), true)
  })
}

test('owned module-cache cleanup failure stays red and preserves the invocation directory without publishing', t => {
  const fixture = toolchainFixture(t)
  const result = fixture.run({ FIXTURE_CLEAN_FAILURE: '1' })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /fixture owned module cache cleanup failed/)
  assert.match(result.stderr, /Failed to clean the owned Go module cache; preserving/)
  assert.equal(existsSync(fixture.published), false)
  const cleanup = fixture.calls().find(call => call.tool === 'bootstrap' && call.args.join(' ') === 'clean -modcache')
  assert.ok(cleanup)
  assert.equal(existsSync(cleanup.cwd), true)
  assert.equal(existsSync(cleanup.modcache), true)
  assert.equal(existsSync(join(fixture.cache, 'modules/shared-module')), true)
})

for (const version of ['go1.20.14', 'devel go1.28']) {
  test(`an unsupported installed compiler cannot start a toolchain download: ${version}`, t => {
    const fixture = toolchainFixture(t)
    const result = fixture.run({ FIXTURE_BOOTSTRAP_VERSION: version })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /No installed stable Go 1\.21 or newer/)
    assert.equal(fixture.calls().some(call => call.toolchain === `go${pins.go.version}`), false)
    assert.equal(existsSync(fixture.published), false)
  })
}

test('task and cache executables cannot replace an installed bootstrap', t => {
  const fixture = toolchainFixture(t, { bootstrap: false })
  const taskBin = join(fixture.workspace, 'bin')
  const cacheBin = join(fixture.cache, 'other/bin')
  fixture.bootstrap(taskBin)
  fixture.bootstrap(cacheBin, 'go1.26.8')
  const result = fixture.run({ PATH: [taskBin, cacheBin, fixture.image, fixture.commands].join(delimiter) })
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /no installed bootstrap Go is available/)
  assert.equal(fixture.calls().some(call => call.tool === 'bootstrap'), false)
  assert.equal(existsSync(fixture.published), false)
})

test('an unavailable installed bootstrap leaves the failed archive attempt red', t => {
  const fixture = toolchainFixture(t, { bootstrap: false })
  const result = fixture.run()
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /no installed bootstrap Go is available/)
  assert.equal(existsSync(fixture.published), false)
})
