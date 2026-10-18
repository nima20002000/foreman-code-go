import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, realpath, rm, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { ciTestResults } from './ci-test-results.mjs'

if (process.env.CI !== 'true' && process.env.CI_HOST_RUNNER !== '1') throw new Error('Foreman CI is required')
process.umask(0o077)
process.chdir(fileURLToPath(new URL('..', import.meta.url)))
if (process.argv[2] === 'prepare-contracts') process.exit(0)
const checkout = process.cwd()
const plan = JSON.parse(await readFile('scripts/ci-oracle-plan.json', 'utf8'))
const inheritedHome = await realpath(homedir())
const cache = resolve(checkout, process.env.FOREMAN_CODE_CI_GO_CACHE || join(inheritedHome, '.cache/foreman-go'))
const parent = join(inheritedHome, '.c')
await mkdir(parent, { recursive: true, mode: 0o700 })
const root = await mkdtemp(join(parent, 'm-'))
const env = {
  PATH: process.env.PATH, HOME: join(root, 'h'), TMPDIR: join(root, 't'),
  XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data'),
  COREPACK_HOME: join(root, 'corepack'), PNPM_HOME: join(root, 'pnpm'),
  GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly -p=2',
  GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org',
  GOCACHE: join(root, 'go-build'), GOMODCACHE: join(root, 'go-modules'), GOPATH: join(root, 'gopath'),
  GOTMPDIR: join(root, 't'), FOREMAN_CODE_CI_GO_CACHE: cache,
  LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CI: 'true', SUITE: 'unit',
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const commands = []
const artifacts = []
const assertions = []
const facts = { source: plan.source, sourceTree: plan.sourceTree,
  checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  checkoutTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  noDatabase: true, noProvider: true, fullSuiteExecuted: false, cleanup: false, selections: [] }
let failed = false
let phase = 'setup'
const record = value => console.log('[oracle] ' + JSON.stringify(value))
const progress = setInterval(() => record({ stage: 'running', phase }), 15000)

async function run(name, program, args, options = {}) {
  phase = name
  record({ stage: 'command-start', name, program, args })
  const stdout = []
  const stderr = []
  const startedAt = new Date().toISOString()
  const exitCode = await new Promise((complete, reject) => {
    const child = spawn(program, args, { cwd: options.cwd ?? checkout, env, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => stdout.push(Buffer.from(bytes)))
    child.stderr.on('data', bytes => stderr.push(Buffer.from(bytes)))
    child.once('error', reject)
    child.once('close', code => complete(code ?? 1))
    child.stdin.end(options.input)
  })
  const result = { name, program, args, startedAt, finishedAt: new Date().toISOString(), exitCode,
    stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
    stdoutBase64: Buffer.concat(stdout).toString('base64'), stderrBase64: Buffer.concat(stderr).toString('base64') }
  commands.push(result)
  record({ stage: 'command-finish', name, exitCode })
  if (options.required !== false && exitCode !== 0) throw new Error(name + ' failed')
  return result
}

async function sourceCheckout(source, name) {
  const destination = join(root, name)
  const pack = Buffer.from(source.pack, 'base64')
  if (sha256(pack) !== source.packSHA256) throw new Error('Source pack differs')
  await run(name + '-init', 'git', ['init', '--quiet', destination])
  await run(name + '-objects', 'git', ['unpack-objects', '-q'], { cwd: destination, input: pack })
  await writeFile(join(destination, '.git/HEAD'), source.commit + '\n')
  await run(name + '-sparse', 'git', ['sparse-checkout', 'init', '--no-cone'], { cwd: destination })
  await writeFile(join(destination, '.git/info/sparse-checkout'), source.paths.map(path => '/' + path).join('\n') + '\n')
  await run(name + '-checkout', 'git', ['read-tree', '-mu', 'HEAD'], { cwd: destination })
  const identity = await run(name + '-identity', 'git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], { cwd: destination })
  if (identity.stdout.trim() !== source.commit + '\n' + source.tree) throw new Error('Private checkout differs')
  return destination
}

async function prepareGo() {
  await run('stock-Go-install', 'bash', ['scripts/ci-go-toolchain.sh', 'install'])
  await run('stock-Go-verify', 'bash', ['scripts/ci-go-toolchain.sh', 'verify'])
  const pins = JSON.parse(await readFile('scripts/ci-go-versions.json', 'utf8'))
  env.GOROOT = join(cache, 'toolchains', 'go' + pins.go.version)
  const go = join(env.GOROOT, 'bin/go')
  env.PATH = dirname(go) + ':' + env.PATH
  await run('private-Go-telemetry', go, ['telemetry', 'off'])
  const version = await run('actual-Go-version', go, ['version'])
  const settings = JSON.parse((await run('actual-Go-root', go, ['env', '-json', 'GOVERSION', 'GOROOT'])).stdout)
  if (settings.GOVERSION !== 'go' + pins.go.version || await realpath(settings.GOROOT) !== await realpath(env.GOROOT)) {
    throw new Error('Go version/root differs')
  }
  facts.toolchain = { ...settings, rawVersion: version.stdout, goSHA256: sha256(await readFile(go)) }
  return go
}

async function goCases(sourceRoot) {
  const go = await prepareGo()
  const result = await run('selected-Go-assertions', go,
    ['test', '-json', '-count=1', '-timeout=30s', '-run', plan.pattern, './internal/mcpserver'],
    { cwd: join(sourceRoot, 'backend'), required: false })
  const events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const outcomes = events.filter(event => event.Test && ['pass', 'fail', 'skip'].includes(event.Action))
  const selected = outcomes.filter(event => plan.cases.includes(event.Test))
  const otherLeaves = outcomes.filter(event => event.Test.includes('/') && !plan.cases.includes(event.Test))
  const missing = plan.cases.filter(name => !selected.some(event => event.Test === name))
  facts.selections = [{ requested: plan.cases, originalExitCode: result.exitCode, missing,
    unexpectedLeaves: otherLeaves, rawOutcomes: outcomes, selected }]
  facts.behaviorExecuted = selected.length === plan.cases.length && !missing.length && !otherLeaves.length
  failed = result.exitCode !== 0 || !facts.behaviorExecuted || selected.some(event => event.Action !== 'pass')
  for (const event of selected) {
    const output = events.filter(item => item.Test === event.Test && item.Output).map(item => item.Output).join('')
    assertions.push({ fullName: event.Test, status: event.Action === 'pass' ? 'passed' : 'failed',
      duration: event.Elapsed * 1000, failureMessages: [output] })
  }
}

async function captureCases(sourceRoot) {
  const frozen = await sourceCheckout(plan.frozenSource, 'frozen')
  const install = await run('frozen-locked-private-install', 'corepack',
    ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts', '--filter', '@foreman-code/api...',
      '--store-dir', join(root, 'pnpm-store')], { cwd: frozen })
  facts.installation = { command: install.args, exitCode: install.exitCode, privateStore: true,
    lockSHA256: sha256(await readFile(join(frozen, 'pnpm-lock.yaml'))), ignoredLifecycleScripts: true }
  await run('private-pnpm-version', 'corepack', ['pnpm', '--version'], { cwd: frozen })
  const output = join(root, 'transport-capture.json')
  const result = await run('frozen-public-transport-capture', process.execPath,
    [join(sourceRoot, 'scripts/go-mcp/capture-ids.mjs'), '--frozen-root', frozen,
      '--candidate', plan.source, '--tree', plan.sourceTree, '--output', output,
      ...plan.cases.flatMap(id => ['--case', id])], { cwd: sourceRoot, required: false })
  const bytes = await readFile(output)
  const report = JSON.parse(bytes)
  artifacts.push({ path: 'transport-capture.json', bytes })
  const selected = report.outcomes.map(outcome => outcome.id)
  if (JSON.stringify(selected) !== JSON.stringify(plan.cases)) throw new Error('Capture selection differs')
  facts.behaviorExecuted = true
  facts.selections = [{ requested: plan.cases, originalExitCode: result.exitCode, selected,
    failed: report.coverage.failed }]
  failed = result.exitCode !== 0 || report.coverage.failed.length !== 0
  for (const outcome of report.outcomes) assertions.push({ fullName: outcome.id,
    status: outcome.failures.length ? 'failed' : 'passed', duration: null,
    failureMessages: [JSON.stringify(outcome.failures)] })
}

async function cleanPrivateModuleCache() {
  let exists = false
  try { await lstat(env.GOMODCACHE); exists = true }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!exists) return
  if (env.GOMODCACHE !== join(root, 'go-modules') || await realpath(root) !== root ||
      await realpath(env.GOMODCACHE) !== env.GOMODCACHE || await realpath(env.HOME) !== join(root, 'h') ||
      env.GOPATH !== join(root, 'gopath') || !facts.toolchain || facts.toolchain.GOVERSION !== 'go1.27.2') {
    throw new Error('Cleanup requires verified Go and canonical job-owned private module cache')
  }
  await run('owned-private-module-cache-clean', join(facts.toolchain.GOROOT, 'bin/go'),
    ['clean', '-modcache'], { cwd: root })
  let remaining = false
  try { await lstat(env.GOMODCACHE); remaining = true }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  facts.privateModuleCache = { private: true, canonical: true, cleaned: !remaining }
  if (remaining) throw new Error('Private module cache remains after stock go clean')
}

function publishArtifact(path, bytes) {
  const chunks = gzipSync(bytes).toString('base64').match(/.{1,24000}/g) ?? []
  console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'artifact', path, bytes: bytes.length,
    sha256: sha256(bytes), encoding: 'gzip+base64', chunks: chunks.length }))
  chunks.forEach((data, index) => console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'chunk', path, index, data })))
}

try {
  if (process.getuid?.() === 0) throw new Error('Unprivileged CI user is required')
  for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) {
    await mkdir(env[key], { recursive: true, mode: 0o700 })
  }
  facts.runtime = { executable: process.execPath, versions: process.versions }
  const sourceRoot = await sourceCheckout(plan.sourcePack, 'source')
  if (plan.kind === 'capture') await captureCases(sourceRoot)
  else await goCases(sourceRoot)
} catch (error) {
  failed = true
  facts.failure = error.message
} finally {
  try {
    await cleanPrivateModuleCache()
    await rm(root, { recursive: true, force: true })
    facts.cleanup = true
  } catch (error) {
    failed = true
    facts.cleanupFailure = error.message
  }
  clearInterval(progress)
  facts.failed = failed
  const output = process.env.TEST_RESULTS_OUTPUT
  const wrapped = { testResults: [{ name: resolve('scripts/ci-go-toolchain-probe.test.mjs'),
    status: failed ? 'failed' : 'passed', assertionResults: assertions }] }
  if (output) {
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify(ciTestResults([wrapped], checkout)))
  }
  const retainedPlan = structuredClone(plan)
  for (const key of ['sourcePack', 'frozenSource']) if (retainedPlan[key]) delete retainedPlan[key].pack
  publishArtifact('oracle-report.json', Buffer.from(JSON.stringify({ plan: retainedPlan, facts, commands,
    reportMapping: 'Actual case identities retained; diagnostic selector filename wraps structured CI reports only' })))
  for (const artifact of artifacts) publishArtifact(artifact.path, artifact.bytes)
  record({ stage: 'result', ...facts })
}
process.exitCode = failed ? 1 : 0
