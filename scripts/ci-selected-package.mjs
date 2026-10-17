import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, access } from 'node:fs/promises'
import { availableParallelism, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { ciTestResults } from './ci-test-results.mjs'

if (process.env.CI !== 'true' && process.env.CI_HOST_RUNNER !== '1') {
  throw new Error('This diagnostic runs only inside authenticated Foreman CI')
}
process.umask(0o077)
const plan = JSON.parse(await readFile('scripts/ci-selected-package-plan.json', 'utf8'))
const originalHome = await realpath(homedir())
const cache = resolve(process.env.FOREMAN_CODE_CI_GO_CACHE || join(originalHome, '.cache', 'foreman-go'))
const parent = join(originalHome, '.c')
await mkdir(parent, { recursive: true, mode: 0o700 })
const root = await mkdtemp(join(parent, 'g-'))
const env = {
  PATH: process.env.PATH, HOME: join(root, 'h'), TMPDIR: join(root, 't'),
  XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'), CI_STATE: join(root, 'provider'), SUITE: 'lint',
  FOREMAN_CODE_CI_GO_CACHE: cache, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  FOREMAN_CODE_CI_CPU_COUNT: String(Math.min(2, availableParallelism())),
  GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly -p=2',
  GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org',
  GOCACHE: join(cache, 'build'), GOMODCACHE: join(cache, 'modules'), GOPATH: join(cache, 'gopath'),
  GOTMPDIR: join(root, 't'), CGO_ENABLED: '1'
}
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'FOREMAN_CODE_CI_DATABASE_CPUS',
  'FOREMAN_CODE_CI_DATABASE_MEMORY_BYTES']) {
  if (process.env[key]) env[key] = process.env[key]
}
const record = value => console.log('[selected-package] ' + JSON.stringify(value))
const facts = {
  source: plan.source, sourceTree: plan.sourceTree,
  checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  selectedMjs: 'scripts/ci-go-toolchain-probe.test.mjs', executedGo: plan.package,
  fullSuiteExecuted: false, conformanceExecuted: false, commands: [], selections: [], cleanup: false,
  sharedToolCacheRetained: true
}
const raw = []
const reports = []
let phase = 'setup'
let failed = false
let providerAttempted = false
const progress = setInterval(() => record({ stage: 'running', phase }), 15000)

function safe(value) {
  return String(value).replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/g, '$1<redacted>@')
    .replaceAll(root, '<owned-runtime>')
}

async function run(name, program, args, options = {}) {
  phase = name
  const startedAt = new Date().toISOString()
  record({ stage: 'command-start', name, program, args })
  let stdout = ''
  let stderr = ''
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd ?? process.cwd(), env: env, stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', text => { stdout += text })
    child.stderr.on('data', text => { stderr += text })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    child.stdin.end(options.input)
  })
  const result = { name, program, args, exitCode, stdout, stderr, startedAt,
    finishedAt: new Date().toISOString() }
  raw.push(result)
  facts.commands.push({ name, exitCode, startedAt, finishedAt: result.finishedAt,
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) })
  record({ stage: 'command-finish', ...facts.commands.at(-1) })
  if (exitCode !== 0) {
    failed = true
    record({ stage: 'command-error', name, output: safe(stdout + '\n' + stderr).slice(-12000) })
  }
  return result
}

async function required(name, program, args, options) {
  const result = await run(name, program, args, options)
  if (result.exitCode !== 0) throw new Error(name + ' failed')
  return result
}

async function selectedTests(kind, names, tags, go) {
  const flags = tags ? ['-tags', tags] : []
  const result = await run(kind + '-tests', go, [
    'test', '-json', '-count=1', '-timeout=10m', ...flags,
    '-run', '^(' + names.join('|') + ')$', plan.package
  ], { cwd: 'backend' })
  const events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const outcomes = events.filter(event => event.Test && ['pass', 'fail', 'skip'].includes(event.Action))
  const roots = outcomes.filter(event => !event.Test.includes('/'))
  const missing = names.filter(name => !roots.some(event => event.Test === name))
  const unexpected = roots.filter(event => !names.includes(event.Test))
  const selection = { kind, requested: names, originalExitCode: result.exitCode,
    missing, unexpected: unexpected.map(event => event.Test), namedCount: outcomes.length,
    tests: outcomes.map(event => ({ name: event.Test, status: event.Action, durationMs: event.Elapsed * 1000 })) }
  facts.selections.push(selection)
  record({ stage: 'selection', ...selection })
  if (missing.length || unexpected.length || !outcomes.length || outcomes.some(event => event.Action !== 'pass')) failed = true
  if (kind === 'unit' && plan.expectedUnitNamedCount && outcomes.length !== plan.expectedUnitNamedCount) failed = true
  const report = join(root, kind + '.vitest.json')
  const modulePath = /^module\s+(.+)$/m.exec(await readFile('backend/go.mod', 'utf8'))[1]
  const converted = await run(kind + '-conversion', process.execPath, [
    'scripts/ci-go-test-results.mjs', '--module', modulePath, '--output', report,
    '--durations', join(root, kind + '-durations.json')
  ], { input: result.stdout })
  try { reports.push(JSON.parse(await readFile(report, 'utf8'))) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

async function startProvider() {
  providerAttempted = true
  await required('fresh-PostgreSQL-provider-start', process.execPath,
    ['scripts/ci-go-prerequisites.mjs', 'database-start'])
  const provider = JSON.parse(await readFile(join(env.CI_STATE, 'go-database.json'), 'utf8'))
  if (!provider.ready || !provider.url || !provider.name.startsWith('foreman-go-ci-')) {
    throw new Error('The fresh public PostgreSQL provider did not publish owned ready state')
  }
  env.FOREMAN_CODE_CI_TEST_ADMIN_URL = provider.url
  facts.database = { fresh: true, randomLoopbackPort: true, provider: 'ci-go-prerequisites',
    perTestDatabaseProvider: 'internal/testdb' }
}

try {
  if (process.getuid?.() === 0) throw new Error('An existing unprivileged CI user is required')
  for (const path of [env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME,
    env.XDG_STATE_HOME, env.CI_STATE]) await mkdir(path, { recursive: true, mode: 0o700 })
  record({ stage: 'provenance', ...facts, sharedCache: cache })
  await required('pinned-Go-and-Staticcheck-install', 'bash', ['scripts/ci-go-toolchain.sh', 'install'])
  await required('pinned-Go-verify', 'bash', ['scripts/ci-go-toolchain.sh', 'verify'])
  const pins = JSON.parse(await readFile('scripts/ci-go-versions.json', 'utf8'))
  env.GOROOT = join(cache, 'toolchains', 'go' + pins.go.version)
  const go = join(env.GOROOT, 'bin/go')
  await required('private-telemetry-off', go, ['telemetry', 'off'])
  const staticcheck = join(cache, 'tools', 'staticcheck-' + pins.staticcheck.version, 'bin/staticcheck')
  env.PATH = join(env.GOROOT, 'bin') + ':' + dirname(staticcheck) + ':' + env.PATH
  const version = await required('pinned-Staticcheck-version', staticcheck, ['-version'])
  if (!version.stdout.trim().endsWith('(' + pins.staticcheck.version.slice(1) + ')')) {
    throw new Error('Staticcheck does not match the public pin')
  }
  if (plan.mode !== 'Staticcheck-only') {
  const formatted = await run('changed-Go-format', join(env.GOROOT, 'bin/gofmt'),
    ['-l', ...plan.goFiles], { cwd: 'backend' })
  facts.unformatted = formatted.stdout.split('\n').filter(Boolean)
  if (facts.unformatted.length) failed = true
  }
  for (const tags of ['', ...(plan.integrationTests.length ? ['integration'] : [])]) {
    const flags = tags ? ['-tags', tags] : []
    for (const command of plan.mode === 'Staticcheck-only' ? [] : ['build', 'vet']) {
      await run((tags || 'ordinary') + '-' + command, go, [command, ...flags, plan.package], { cwd: 'backend' })
    }
    await run((tags || 'ordinary') + '-Staticcheck', staticcheck, [...flags, plan.package], { cwd: 'backend' })
  }
  if (plan.mode !== 'Staticcheck-only') await selectedTests('unit', plan.unitTests, '', go)
  if (plan.mode !== 'Staticcheck-only' && plan.integrationTests.length) {
    await startProvider()
    await selectedTests('integration', plan.integrationTests, 'integration', go)
  }
} catch (error) {
  failed = true
  facts.failure = safe(error.message)
} finally {
  try {
    if (providerAttempted) {
      const stopped = await run('owned-PostgreSQL-provider-stop', process.execPath,
        ['scripts/ci-go-prerequisites.mjs', 'database-stop'])
      if (stopped.exitCode !== 0) throw new Error('Owned PostgreSQL provider cleanup failed')
      let retained = false
      try { await access(join(env.CI_STATE, 'go-database.json')); retained = true }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (retained) throw new Error('Owned PostgreSQL provider state remains after cleanup')
      facts.databaseCleanup = true
    }
    const output = process.env.TEST_RESULTS_OUTPUT ?? process.env.FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT
    if (output && reports.length) {
      await mkdir(dirname(output), { recursive: true })
      const normalized = ciTestResults(reports, process.cwd())
      await writeFile(output, JSON.stringify(normalized))
      facts.normalizedSummary = normalized.summary
    }
    await rm(root, { recursive: true, force: true })
    facts.cleanup = true
  } catch (error) {
    failed = true
    facts.cleanupFailure = safe(error.message)
  }
  clearInterval(progress)
  facts.failed = failed
  const original = JSON.stringify({ plan, facts, commands: raw })
  if (/postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/.test(original)) {
    failed = true
    facts.failed = true
    facts.rawExportBlocked = 'database-credential-pattern'
  } else {
    const bytes = Buffer.from(original)
    const chunks = gzipSync(bytes).toString('base64').match(/.{1,24000}/g) ?? []
    console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'artifact', path: 'selected-package-reports.json',
      bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      encoding: 'gzip+base64', chunks: chunks.length }))
    chunks.forEach((data, index) => console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'chunk',
      path: 'selected-package-reports.json', index, data })))
  }
  record({ stage: 'result', ...facts })
}
process.exitCode = failed ? 1 : 0
