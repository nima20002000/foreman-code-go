import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, access, lstat } from 'node:fs/promises'
import { availableParallelism, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { ciTestResults } from './ci-test-results.mjs'

if (process.env.CI !== 'true' && process.env.CI_HOST_RUNNER !== '1') {
  throw new Error('This diagnostic runs only inside authenticated Foreman CI')
}
process.umask(0o077)
if (process.argv[2] === 'prepare-contracts') {
  console.log('[history-cursor] Go-only scope; no contracts setup build')
  process.exit(0)
}
process.chdir(fileURLToPath(new URL('..', import.meta.url)))
const plan = JSON.parse(await readFile('scripts/ci-selected-package-plan.json', 'utf8'))
const originalHome = await realpath(homedir())
const cache = resolve(process.env.FOREMAN_CODE_CI_GO_CACHE || join(originalHome, '.cache', 'foreman-go'))
const parent = join(originalHome, '.c')
await mkdir(parent, { recursive: true, mode: 0o700 })
const root = await mkdtemp(join(parent, 'g-'))
const env = {
  PATH: process.env.PATH, HOME: join(root, 'h'), TMPDIR: join(root, 't'),
  XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data'),
  CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), CI_STATE: join(root, 'provider'), SUITE: 'unit',
  FOREMAN_CODE_CI_GO_CACHE: cache, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  FOREMAN_CODE_CI_CPU_COUNT: String(Math.min(2, availableParallelism())),
  GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '',
  GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org',
  GOCACHE: join(root, 'go-build'), GOMODCACHE: join(root, 'go-modules'), GOPATH: join(root, 'gopath'),
  GOTMPDIR: join(root, 't'), CGO_ENABLED: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
  USERPROFILE: join(root, 'h'), TMP: join(root, 't'), TEMP: join(root, 't')
}
const record = value => console.log('[selected-package] ' + JSON.stringify(value))
const facts = {
  source: plan.source, sourceTree: plan.sourceTree,
  checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  selectedMjs: 'scripts/ci-go-toolchain-probe.test.mjs',
  executedGo: plan.packages,
  checkoutTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  provider: { hostRunId: process.env.FOREMAN_CODE_CI_HOST_RUN_ID ?? null, githubRunId: process.env.GITHUB_RUN_ID ?? null },
  fullSuiteExecuted: false, conformanceExecuted: false,
  testsRequested: plan.unitTests.length,
  commands: [], selections: [], cleanup: false,
  sharedToolCacheRetained: true
}
const raw = []
const reports = []
const extraArtifacts = []
let phase = 'setup'
let failed = false
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

async function selectedTests(kind, names, go) {
  const packages = plan.packages
  const flags = ['-race']
  const result = await run(kind + '-tests', go, [
    'test', '-json', '-count=1', '-timeout=30s', ...flags,
    '-run', '^(' + names.join('|') + ')$', ...packages
  ], { cwd: 'backend' })
  const events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
  const outcomes = events.filter(event => event.Test && ['pass', 'fail', 'skip'].includes(event.Action))
  const roots = outcomes.filter(event => !event.Test.includes('/'))
  const missing = names.filter(name => !roots.some(event => event.Test === name))
  const unexpected = roots.filter(event => !names.includes(event.Test))
  const selection = { kind, requested: names, originalExitCode: result.exitCode,
    missing, unexpected: unexpected.map(event => event.Test), namedCount: outcomes.length,
    rootCount: roots.length, subtestCount: outcomes.length - roots.length,
    tests: outcomes.map(event => ({ name: event.Test, status: event.Action, durationMs: event.Elapsed * 1000 })) }
  facts.selections.push(selection)
  record({ stage: 'selection', ...selection })
  if (missing.length || unexpected.length || !outcomes.length || outcomes.some(event => event.Action !== 'pass')) failed = true
  if (outcomes.length !== 2 || roots.length !== 2 || outcomes.length - roots.length !== 0) failed = true
  const report = join(root, kind + '.vitest.json')
  const modulePath = /^module\s+(.+)$/m.exec(await readFile('backend/go.mod', 'utf8'))[1]
  await run(kind + '-conversion', process.execPath, [
    'scripts/ci-go-test-results.mjs', '--module', modulePath, '--output', report,
    '--durations', join(root, kind + '-durations.json')
  ], { input: result.stdout })
  try { reports.push(JSON.parse(await readFile(report, 'utf8'))) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}

function captureArtifact(path, bytes) {
  const chunks = gzipSync(bytes).toString('base64').match(/.{1,24000}/g) ?? []
  console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'artifact', path, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), encoding: 'gzip+base64', chunks: chunks.length }))
  chunks.forEach((data, index) => console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'chunk', path, index, data })))
}

async function prepareGo() {
  await required('pinned-Go-and-Staticcheck-install', 'bash', ['scripts/ci-go-toolchain.sh', 'install'])
  await required('pinned-Go-verify', 'bash', ['scripts/ci-go-toolchain.sh', 'verify'])
  const pins = JSON.parse(await readFile('scripts/ci-go-versions.json', 'utf8'))
  env.GOROOT = join(cache, 'toolchains', 'go' + pins.go.version)
  const go = join(env.GOROOT, 'bin/go')
  await required('private-telemetry-off', go, ['telemetry', 'off'])
  env.PATH = join(env.GOROOT, 'bin') + ':' + env.PATH
  return { go }
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
  await required('owned-private-module-cache-clean', join(facts.toolchain.GOROOT, 'bin/go'),
    ['clean', '-modcache'], { cwd: root })
  let remaining = false
  try { await lstat(env.GOMODCACHE); remaining = true }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  facts.privateModuleCache = { ...facts.privateModuleCache, private: true, canonical: true,
    explicitlySelected: true, scope: '<owned-runtime>/go-modules', cleaned: !remaining }
  if (remaining) throw new Error('Private module cache remains after stock go clean')
}

async function executePlan() {
  const { go } = await prepareGo()
  const settings = JSON.parse((await required('genuine-Go-root', go,
    ['env', '-json', 'GOVERSION', 'GOROOT'])).stdout)
  facts.toolchain = { ...settings,
    goSHA256: createHash('sha256').update(await readFile(go)).digest('hex') }
  await required('genuine-Go-version', go, ['version'])
  facts.inputIdentities = []
  for (const identity of plan.sourceIdentities) {
    const bytes = await readFile(identity.path)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== identity.sha256 || bytes.length !== identity.bytes) {
      throw new Error('Source identity mismatch: ' + identity.path)
    }
    facts.inputIdentities.push({ ...identity, verified: true })
  }
  await run('activity-build', go, ['build', ...plan.packages], { cwd: 'backend' })
  await selectedTests('unit', plan.unitTests, go)
}


try {
  if (process.getuid?.() === 0) throw new Error('An existing unprivileged CI user is required')
  for (const path of [env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME,
    env.XDG_STATE_HOME, env.XDG_DATA_HOME, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.CI_STATE]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  record({ stage: 'provenance', ...facts, sharedCache: cache })
  await executePlan()
} catch (error) {
  failed = true
  facts.failure = safe(error.message)
} finally {
  try {
    const output = process.env.TEST_RESULTS_OUTPUT ?? process.env.FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT
    if (output) {
      await mkdir(dirname(output), { recursive: true })
      const byFile = new Map()
      for (const report of reports) {
        for (const file of report.testResults ?? []) {
          const previous = byFile.get(file.name)
          if (!previous) byFile.set(file.name, { ...file })
          else {
            previous.assertionResults = [...previous.assertionResults, ...file.assertionResults]
            previous.duration = (previous.duration ?? 0) + (file.duration ?? 0)
            if (file.status === 'failed') previous.status = 'failed'
          }
        }
      }
      const normalized = ciTestResults([{ testResults: [...byFile.values()] }], process.cwd())
      await writeFile(output, JSON.stringify(normalized))
      facts.normalizedSummary = normalized.summary
    }
    await cleanPrivateModuleCache()
    await rm(root, { recursive: true, force: true })
    let retained = false
    try { await access(root); retained = true }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (retained) throw new Error('Owned runtime remains after cleanup')
    facts.cleanup = true
  } catch (error) {
    failed = true
    facts.cleanupFailure = safe(error.message)
  }
  clearInterval(progress)
  facts.failed = failed
  const original = JSON.stringify({ plan, facts, commands: raw, originalReports: reports })
  if (/postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/.test(original)) {
    failed = true
    facts.failed = true
    facts.rawExportBlocked = 'database-credential-pattern'
  } else {
    captureArtifact('selected-package-reports.json', Buffer.from(original))
    for (const artifact of extraArtifacts) captureArtifact(artifact.path, artifact.bytes)
  }
  record({ stage: 'result', ...facts })
}
process.exitCode = failed ? 1 : 0
