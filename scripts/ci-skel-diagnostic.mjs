import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const candidate = 'db934add98d66d6fb2b288487c76d6f9910c3919'
const expectedTrees = { backend: '81452336fac71df0169ada92aa20941502f10e77',
  conformance: 'df51d161f4a6ccb1a3d1cae214b59d1f6e56e421' }
const repository = process.cwd()
const parent = join(homedir(), '.cache', 'foreman-skel-diagnostic')
mkdirSync(parent, { recursive: true, mode: 0o700 })
const root = mkdtempSync(join(realpathSync(parent), 's-'))
const report = value => console.log(`[skel-diagnostic] ${JSON.stringify(value)}`)

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  return result
}

function artifact(path, bytes) {
  bytes = Buffer.from(bytes)
  const chunks = gzipSync(bytes).toString('base64').match(/.{1,6000}/g) ?? []
  console.log(`FOREMAN_CAPTURE ${JSON.stringify({ kind: 'artifact', path, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), encoding: 'gzip+base64', chunks: chunks.length })}`)
  for (let index = 0; index < chunks.length; index++) {
    console.log(`FOREMAN_CAPTURE ${JSON.stringify({ kind: 'chunk', path, index, data: chunks[index] })}`)
  }
}

function prerequisites() {
  const configuration = spawnSync('pg_config', ['--bindir'], { encoding: 'utf8', timeout: 10_000 })
  const candidates = ['/usr/lib/postgresql/17/bin']
  if (configuration.status === 0) candidates.push(configuration.stdout.trim())
  const observed = []
  for (const directory of [...new Set(candidates)]) {
    const availability = Object.fromEntries(['initdb', 'postgres', 'pg_isready', 'psql', 'createdb'].map(name => {
      try { accessSync(join(directory, name), constants.X_OK); return [name, true] }
      catch { return [name, false] /* ignore: missing installed prerequisite is reported as blocked. */ }
    }))
    const version = availability.postgres ? command(join(directory, 'postgres'), ['--version']) : undefined
    const major = Number(/PostgreSQL\) (\d+)/.exec(version?.stdout ?? '')?.[1])
    observed.push({ directory, availability, version: version?.stdout.trim() })
    if (Object.values(availability).every(Boolean) && major >= 17) {
      const tls = command('openssl', ['version'])
      if (tls.status !== 0) return { observed, blocked: 'Existing OpenSSL is unavailable for the unchanged fixture launcher.' }
      return { observed, directory }
    }
  }
  return { observed, blocked: 'The unchanged fresh-database launcher requires existing native PostgreSQL >=17 server/client binaries.' }
}

try {
  if (!['true', '1'].includes(process.env.CI)) throw new Error('SKEL diagnostics run only inside Foreman CI.')
  if (process.getuid() === 0) throw new Error('SKEL requires the existing unprivileged CI job user; no user change is performed.')
  for (const [path, expected] of Object.entries(expectedTrees)) {
    const actual = command('git', ['rev-parse', `HEAD:${path}`]).stdout.trim()
    if (actual !== expected) throw new Error(`Reviewed ${path} source tree changed.`)
  }
  const available = prerequisites()
  report({ candidate, sourceTrees: expectedTrees, uid: process.getuid(), prerequisites: available })
  if (available.blocked) {
    report({ status: 'blocked', reason: available.blocked, executedScenarios: 0, postgresInstallerRun: false })
    process.exitCode = 2
  } else {
    const binary = join(root, 'foreman')
    const build = command('bash', ['-e', '-c', 'source scripts/ci-go-toolchain.sh; ci_go_environment; ci_go_verify; cd backend; go build -o "$1" ./cmd/foreman', 'bash', binary])
    if (build.status !== 0) throw new Error('Pinned Go build failed; no conformance scenarios executed.')
    const output = join(root, 'skel-report.json')
    const environment = { ...process.env, CONFORMANCE_TARGET: 'go', CONFORMANCE_GO_BINARY: binary,
      CONFORMANCE_POSTGRES_BIN_DIR: available.directory, TMPDIR: root, TMP: root, TEMP: root }
    delete environment.CONFORMANCE_COMMIT_SHA
    const execution = command(process.execPath, ['--import', 'tsx', 'src/main.ts', '--target', 'go',
      '--lane', 'SKEL', '--output', output], { cwd: join(repository, 'conformance'), env: environment })
    const metadata = { candidate, sourceTrees: expectedTrees, executionMirrorCommit: command('git', ['rev-parse', 'HEAD']).stdout.trim(),
      originalExitStatus: execution.status, originalSignal: execution.signal,
      postgresBinaryDirectory: available.directory, postgresInstallerRun: false }
    if (!existsSync(output)) throw new Error(`Conformance did not produce its original report (exit ${execution.status}).`)
    const bytes = readFileSync(output)
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|postgresql:\/\/[^\s"]+:[^\s"]+@/.test(bytes.toString())) {
      throw new Error('Original report contains credential-like data; bytes withheld without rewriting it.')
    }
    artifact('skel-report.json', bytes)
    artifact('skel-provenance.json', `${JSON.stringify(metadata, null, 2)}\n`)
    const native = JSON.parse(bytes)
    report({ ...metadata, rawStatus: native.status, rawScope: native.scope, coverageComplete: native.coverage?.complete,
      totals: native.totals, executed: native.executed,
      scenarios: native.scenarios.map(scenario => ({ id: scenario.id, status: scenario.status,
        phase: scenario.phase, executed: scenario.executed, error: scenario.error })) })
    console.log('FOREMAN_CAPTURE {"kind":"complete"}')
    process.exitCode = execution.status ?? 1
  }
} catch (error) {
  report({ status: 'failed', message: error.message })
  process.exitCode = 1
} finally { rmSync(root, { recursive: true, force: true }) }
