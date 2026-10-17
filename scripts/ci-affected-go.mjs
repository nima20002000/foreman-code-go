import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { writeGoTestResults } from './ci-go-test-results.mjs'
import { ciTestResults } from './ci-test-results.mjs'

const plan = JSON.parse(await readFile('scripts/ci-affected-go-plan.json', 'utf8'))
const checkout = process.cwd()
const originalHome = await realpath(homedir())
const parent = join(originalHome, '.c')
await mkdir(parent, { recursive: true, mode: 0o700 })
const owned = await mkdtemp(join(parent, 'g-'))
const cache = resolve(process.env.FOREMAN_CODE_CI_GO_CACHE ?? join(originalHome, '.cache/foreman-go'))
const pins = JSON.parse(await readFile('scripts/ci-go-versions.json', 'utf8'))
const goRoot = join(cache, 'toolchains', 'go' + pins.go.version)
const go = join(goRoot, 'bin/go')
const staticcheck = join(cache, 'tools', 'staticcheck-' + pins.staticcheck.version, 'bin/staticcheck')
const checks = []
const reports = []
const raw = []
const secrets = []
let setupFailure = null
let cleanup = { databaseRequired: Boolean(plan.integration), databaseStopped: !plan.integration, ownedRootRemoved: false }
const env = { ...process.env, HOME: join(owned, 'h'), TMPDIR: join(owned, 't'),
  XDG_CONFIG_HOME: join(owned, 'h/config'), XDG_CACHE_HOME: join(owned, 'h/cache'),
  XDG_STATE_HOME: join(owned, 'h/state'), CI_STATE: join(owned, 'state'),
  FOREMAN_CODE_CI_GO_CACHE: cache, GOROOT: goRoot, GOCACHE: join(cache, 'build'),
  GOMODCACHE: join(cache, 'modules'), GOPATH: join(cache, 'gopath'),
  GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly',
  GOTMPDIR: join(owned, 't'), PATH: join(goRoot, 'bin') + ':' + process.env.PATH, SUITE: 'lint' }
for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'FOREMAN_CODE_CI_TEST_ADMIN_URL', 'TEST_TELEMETRY_DIR']) delete env[key]
for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'CI_STATE']) {
  await mkdir(env[key], { recursive: true, mode: 0o700 })
}
const log = value => console.log('[affected-go] ' + JSON.stringify(value))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function redact(text) {
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[REDACTED_DATABASE_URL]')
}
async function command(name, program, args, options = {}) {
  const startedAt = new Date().toISOString()
  const result = await new Promise((done, reject) => {
    const child = spawn(program, args, { cwd: options.cwd ?? checkout, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes })
    child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', reject)
    child.once('close', code => done({ exitCode: code ?? 1, stdout, stderr }))
  })
  const record = { name, program, args, exitCode: result.exitCode, startedAt, finishedAt: new Date().toISOString() }
  if (!options.private) {
    record.stdout = redact(result.stdout)
    record.stderr = redact(result.stderr)
  }
  checks.push(record)
  log({ name, exitCode: result.exitCode, stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) })
  return result
}
async function test(name, args, expectedRoots) {
  const result = await command(name, go, ['test', '-json', '-count=1', ...args, plan.package], { cwd: join(checkout, 'backend'), private: true })
  const jsonl = redact(result.stdout)
  const output = join(owned, name + '.json')
  const converted = await writeGoTestResults(Readable.from([jsonl]), {
    modulePath: plan.modulePath, repository: checkout, output,
  })
  const roots = new Set()
  for (const line of jsonl.split('\n').filter(Boolean)) {
    const event = JSON.parse(line)
    if (event.Action === 'run' && event.Test && !event.Test.includes('/')) roots.add(event.Test)
  }
  const selectionMatches = expectedRoots.length === roots.size && expectedRoots.every(name => roots.has(name))
  checks.push({ name: name + '-selection', exitCode: selectionMatches && converted.executed > 0 ? 0 : 1,
    expectedRoots, observedRoots: [...roots], selected: converted.selected, executed: converted.executed, failed: converted.failed })
  const report = JSON.parse(await readFile(output, 'utf8'))
  reports.push(report)
  raw.push({ name, jsonl, stderr: redact(result.stderr), originalExitCode: result.exitCode,
    sha256: digest(jsonl), bytes: Buffer.byteLength(jsonl) })
  log({ name, exitCode: result.exitCode, selected: converted.selected, executed: converted.executed,
    failed: converted.failed, selectionMatches })
}
try {
  log({ source: plan.source, checkout: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    scope: plan, cacheContract: 'inherited-verified-prefix-retained', privateState: true })
  const install = await command('pinned-tool-install', 'bash', ['scripts/ci-go-toolchain.sh', 'install'])
  if (install.exitCode !== 0) throw new Error('Pinned tool preparation failed')
  await command('compiler-version', go, ['version'])
  await command('staticcheck-version', staticcheck, ['-version'])
  const backend = join(checkout, 'backend')
  await command('build', go, ['build', plan.package], { cwd: backend })
  await command('vet', go, ['vet', plan.package], { cwd: backend })
  if (plan.integration) await command('integration-vet', go, ['vet', '-tags', 'integration', plan.package], { cwd: backend })
  const format = await command('gofmt', join(goRoot, 'bin/gofmt'), ['-l', ...plan.files], { cwd: backend })
  checks.push({ name: 'gofmt-clean', exitCode: format.exitCode === 0 && format.stdout.trim() === '' ? 0 : 1,
    paths: format.stdout.trim().split('\n').filter(Boolean) })
  await command('staticcheck', staticcheck, [plan.package], { cwd: backend })
  await test('ordinary', [...(plan.unitFlags ?? []), '-run', plan.unitPattern], plan.unitRoots)
  if (plan.integration) {
    const started = await command('database-start', process.execPath, ['scripts/ci-go-prerequisites.mjs', 'database-start'], { private: true })
    if (started.exitCode !== 0) throw new Error('Owned PostgreSQL provider failed')
    const database = JSON.parse(await readFile(join(env.CI_STATE, 'go-database.json'), 'utf8'))
    secrets.push(database.url, database.password)
    const validated = await command('database-ownership-validation', process.execPath,
      ['scripts/ci-go-prerequisites.mjs', 'database-env'], { private: true })
    if (validated.exitCode !== 0) throw new Error('Owned PostgreSQL validation failed')
    const url = new URL(database.url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port) throw new Error('Disposable database must use explicit loopback port')
    env.FOREMAN_CODE_CI_TEST_ADMIN_URL = database.url
    log({ database: { owned: true, explicitLoopback: true, freshContainer: true, image: 'postgres:17.6-alpine' } })
    await test('integration', ['-tags', 'integration', '-run', plan.integrationPattern], plan.integrationRoots)
  }
} catch (error) {
  setupFailure = redact(error.stack ?? String(error))
  log({ error: setupFailure })
} finally {
  if (plan.integration) {
    const stopped = await command('database-stop', process.execPath, ['scripts/ci-go-prerequisites.mjs', 'database-stop'], { private: true })
    let recordAbsent = false
    try { await access(join(env.CI_STATE, 'go-database.json')) }
    catch (error) { if (error.code !== 'ENOENT') throw error; recordAbsent = true }
    cleanup.databaseStopped = stopped.exitCode === 0 && recordAbsent
  }
  if (cleanup.databaseStopped) {
    await rm(owned, { recursive: true, force: true })
    cleanup.ownedRootRemoved = true
  }
  log({ cleanup })
}
const results = ciTestResults(reports, checkout)
if (process.env.TEST_RESULTS_OUTPUT) {
  await mkdir(dirname(process.env.TEST_RESULTS_OUTPUT), { recursive: true })
  await writeFile(process.env.TEST_RESULTS_OUTPUT, JSON.stringify(results))
}
const payload = Buffer.from(JSON.stringify({ plan, checks, raw, reports, results, setupFailure, cleanup }))
const chunks = gzipSync(payload).toString('base64').match(/.{1,24000}/g) ?? []
console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'artifact', path: 'affected-go-results.json',
  bytes: payload.length, sha256: digest(payload), encoding: 'gzip+base64', chunks: chunks.length }))
for (const [index, data] of chunks.entries()) console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'chunk', path: 'affected-go-results.json', index, data }))
process.exitCode = setupFailure || checks.some(check => check.exitCode !== 0) || !cleanup.ownedRootRemoved ? 1 : 0
