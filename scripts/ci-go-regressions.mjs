import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, lstat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { ciTestResults } from './ci-test-results.mjs'

if (process.env.CI !== 'true' && process.env.CI_HOST_RUNNER !== '1') throw new Error('Authenticated Foreman CI required')
process.umask(0o077)
const checkout = await realpath(fileURLToPath(new URL('..', import.meta.url)))
if (process.argv[2] === 'prepare-contracts') {
  console.log('[go-regressions] Go-only setup; no contracts build or provider starts')
} else {
  await regressions()
}

async function regressions() {
  const plan = JSON.parse(await readFile(join(checkout, 'scripts/ci-go-regressions-plan.json'), 'utf8'))
  const originalHome = await realpath(homedir())
  const stockCache = resolve(checkout, process.env.FOREMAN_CODE_CI_GO_CACHE || join(originalHome, '.cache/foreman-go'))
  const parent = join(originalHome, '.c')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(await realpath(parent), 'go-regressions-'))
  const env = {
    PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data'),
    GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly -p=2',
    GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org',
    GOCACHE: join(root, 'go-build'), GOMODCACHE: join(root, 'go-modules'), GOPATH: join(root, 'gopath'),
    GOTMPDIR: join(root, 'tmp'), FOREMAN_CODE_CI_GO_CACHE: stockCache,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CI: 'true', SUITE: 'unit',
  }
  const facts = {
    checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(),
    checkoutTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: checkout, encoding: 'utf8' }).trim(),
    selectedMjs: plan.selector, requestedRoots: plan.roots, commands: [], selections: [], cleanup: false,
    fullSuiteExecuted: false, databaseStarted: false, schemaExecuted: false, startupBuildExecuted: false,
  }
  const raw = []
  const artifacts = []
  let failed = false
  let phase = 'setup'
  let assertions = []
  let go
  const record = value => console.log('[go-regressions] ' + JSON.stringify(value))
  const progress = setInterval(() => record({ stage: 'running', phase }), 15000)
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

  async function run(name, program, args, cwd = checkout) {
    phase = name
    record({ stage: 'command-start', name, program, args })
    const startedAt = new Date().toISOString()
    let stdout = ''
    let stderr = ''
    const exitCode = await new Promise((finish, reject) => {
      const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', text => { stdout += text })
      child.stderr.on('data', text => { stderr += text })
      child.once('error', reject)
      child.once('close', (code, signal) => finish(code ?? (signal ? 1 : 0)))
    })
    const command = { name, program, args, cwd, startedAt, finishedAt: new Date().toISOString(), exitCode, stdout, stderr }
    raw.push(command)
    facts.commands.push({ name, startedAt, finishedAt: command.finishedAt, exitCode })
    record({ stage: 'command-finish', name, exitCode })
    return command
  }

  async function required(name, program, args, cwd) {
    const result = await run(name, program, args, cwd)
    if (result.exitCode !== 0) throw new Error(name + ' failed')
    return result
  }

  async function verifyFiles() {
    facts.sourceFiles = []
    for (const expected of plan.sourceFiles) {
      const file = join(checkout, expected.path)
      const info = await lstat(file)
      const bytes = await readFile(file)
      const blob = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
      const mode = info.mode & 0o111 ? '100755' : '100644'
      if (!info.isFile() || bytes.length !== expected.bytes || blob !== expected.blob ||
          sha256(bytes) !== expected.sha256 || mode !== expected.mode) throw new Error('Source identity differs: ' + expected.path)
      facts.sourceFiles.push({ ...expected, verified: true })
    }
  }

  async function prepareGo() {
    await required('stock-pinned-Go-install', 'bash', ['scripts/ci-go-toolchain.sh', 'install'])
    await required('stock-pinned-Go-verify', 'bash', ['scripts/ci-go-toolchain.sh', 'verify'])
    const pins = JSON.parse(await readFile(join(checkout, 'scripts/ci-go-versions.json'), 'utf8'))
    if (pins.go.version !== '1.27.2') throw new Error('Expected stock pinned Go 1.27.2')
    env.GOROOT = join(stockCache, 'toolchains', 'go' + pins.go.version)
    go = join(env.GOROOT, 'bin/go')
    env.PATH = dirname(go) + ':' + env.PATH
    await required('private-Go-telemetry-off', go, ['telemetry', 'off'])
    const settings = JSON.parse((await required('actual-Go-version-root', go, ['env', '-json', 'GOVERSION', 'GOROOT'])).stdout)
    if (settings.GOVERSION !== 'go1.27.2' || await realpath(settings.GOROOT) !== await realpath(env.GOROOT)) {
      throw new Error('Actual Go version/root differs from pin')
    }
    facts.toolchain = { ...settings, goSHA256: sha256(await readFile(go)) }
    await mkdir(env.GOMODCACHE, { mode: 0o700 })
    await mkdir(env.GOPATH, { mode: 0o700 })
  }

  async function selectedTests() {
    const result = await run('selected-Go-regressions', go, plan.goArguments, join(checkout, 'backend'))
    artifacts.push({ path: 'go-regressions.jsonl', bytes: Buffer.from(result.stdout) })
    const events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
    const terminal = events.filter(event => event.Test && ['pass', 'fail', 'skip'].includes(event.Action))
    const roots = terminal.filter(event => !event.Test.includes('/'))
    const missing = plan.roots.filter(name => !roots.some(event => event.Test === name))
    const unexpected = roots.filter(event => !plan.roots.includes(event.Test))
    facts.selections.push({ kind: 'Go', requested: plan.roots, originalExitCode: result.exitCode,
      roots, nestedOutcomes: terminal.filter(event => event.Test.includes('/')), missing,
      unexpected: unexpected.map(event => event.Test) })
    assertions = roots.map(event => ({ fullName: event.Test,
      status: event.Action === 'pass' ? 'passed' : event.Action === 'fail' ? 'failed' : 'pending',
      duration: event.Elapsed * 1000,
      failureMessages: [events.filter(item => item.Test === event.Test && item.Output).map(item => item.Output).join('')] }))
    facts.allRequestedRootsExecuted = !missing.length && !unexpected.length && roots.length === plan.roots.length
      && roots.every(event => event.Action !== 'skip')
    if (result.exitCode !== 0 || !facts.allRequestedRootsExecuted) failed = true
  }

  async function cleanPrivateModules() {
    let exists = false
    try { await lstat(env.GOMODCACHE); exists = true }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!exists) return
    if (!facts.toolchain || facts.toolchain.GOVERSION !== 'go1.27.2' || env.GOMODCACHE !== join(root, 'go-modules') ||
        await realpath(root) !== root || await realpath(env.GOMODCACHE) !== env.GOMODCACHE ||
        await realpath(env.HOME) !== join(root, 'home') || env.GOPATH !== join(root, 'gopath')) {
      throw new Error('Cleanup requires verified Go and canonical job-owned module cache')
    }
    await required('owned-private-module-cache-clean', go, ['clean', '-modcache'], root)
    let remaining = false
    try { await lstat(env.GOMODCACHE); remaining = true }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    facts.privateModuleCache = { private: true, canonical: true, explicitlySelected: true, cleaned: !remaining }
    if (remaining) throw new Error('Private module cache remains after stock cleanup')
  }

  try {
    if (process.getuid?.() === 0) throw new Error('Existing unprivileged CI user required')
    for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) {
      await mkdir(env[key], { recursive: true, mode: 0o700 })
    }
    await verifyFiles()
    await prepareGo()
    await selectedTests()
  } catch (error) {
    failed = true
    facts.failure = error.stack || String(error)
  } finally {
    try {
      const normalized = ciTestResults([{ testResults: [{ name: join(checkout, plan.selector),
        status: failed ? 'failed' : 'passed', assertionResults: assertions }] }], checkout)
      const output = process.env.TEST_RESULTS_OUTPUT || process.env.FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT
      if (output) {
        await mkdir(dirname(output), { recursive: true })
        await writeFile(output, JSON.stringify(normalized))
      }
      facts.normalizedSummary = normalized.summary
      await cleanPrivateModules()
      await rm(root, { recursive: true, force: true })
      facts.cleanup = true
    } catch (error) {
      failed = true
      facts.cleanupFailure = error.stack || String(error)
    }
    clearInterval(progress)
    facts.failed = failed
    artifacts.unshift({ path: 'go-regressions-report.json', bytes: Buffer.from(JSON.stringify({ plan, facts, commands: raw })) })
    for (const artifact of artifacts) {
      const chunks = gzipSync(artifact.bytes).toString('base64').match(/.{1,12000}/g) || ['']
      console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'artifact', path: artifact.path, bytes: artifact.bytes.length,
        sha256: sha256(artifact.bytes), chunks: chunks.length }))
      chunks.forEach((data, index) => console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'chunk', path: artifact.path, index, data })))
    }
    record({ stage: 'result', ...facts })
  }
  process.exitCode = failed ? 1 : 0
}
