import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, homedir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

process.umask(0o077)
const plan = JSON.parse(await readFile('scripts/ci-selected-native-plan.json', 'utf8'))
const parent = join(await realpath(homedir()), '.cache', 'foreman-selected-native')
await mkdir(parent, { recursive: true, mode: 0o700 })
const root = await mkdtemp(join(parent, 'n-'))
const record = value => console.log('[selected-native] ' + JSON.stringify(value))
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
  XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  FOREMAN_CODE_CI_POSTGRES_CACHE: join(root, 'postgres-tools'),
  FOREMAN_CODE_CI_CPU_COUNT: String(Math.min(2, Math.max(1, Number(process.env.FOREMAN_CODE_CI_CPU_COUNT) || availableParallelism()))),
  CONFORMANCE_COMMIT_SHA: plan.source, CONFORMANCE_TARGET: 'ts', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
const facts = { source: plan.source, apiSourceTree: plan.apiSourceTree, conformanceSourceTree: plan.conformanceSourceTree,
  contractsSourceTree: plan.contractsSourceTree, nodeVersion: process.version,
  checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  commands: [], selections: [], cleanup: false, fullInventoryExecuted: false, liveCatalogExecuted: false }
const rawReports = []
let phase = 'dependency-preflight'
let failed = false
const progress = setInterval(() => record({ stage: 'running', phase,
  completedSelections: facts.selections.length }), 15000)

async function run(name, program, args, cwd = process.cwd(), childEnv = env) {
  phase = name
  const startedAt = new Date().toISOString()
  record({ stage: 'command-start', name })
  let stdout = ''
  let stderr = ''
  let pending = ''
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', text => {
      stdout += text
      pending += text
      const lines = pending.split('\n')
      pending = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('{"kind":"conformance-scenario"')) continue
        const outcome = JSON.parse(line)
        record({ stage: 'scenario', selection: name, id: outcome.id, status: outcome.status,
          executed: outcome.executed, phase: outcome.phase, durationMs: outcome.durationMs })
      }
    })
    child.stderr.on('data', text => { stderr += text })
    child.once('error', reject)
    child.once('close', code => resolve(code ?? 1))
  })
  facts.commands.push({ name, exitCode, startedAt, finishedAt: new Date().toISOString(),
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) })
  record({ stage: 'command-finish', ...facts.commands.at(-1) })
  return { exitCode, stdout, stderr }
}

async function prepareContractExports() {
  const missing = []
  for (const [name, entry] of Object.entries(plan.requiredExports)) {
    let present = true
    for (const output of entry.outputs) {
      try { await access(join('packages/contracts', output)) }
      catch (error) { if (error.code !== 'ENOENT') throw error; present = false }
    }
    if (!present) missing.push({ name, source: entry.source })
  }
  record({ stage: 'runtime-export-preflight', required: Object.keys(plan.requiredExports).length,
    missing: missing.map(entry => entry.name) })
  if (missing.length) {
    const result = await run('only-missing-runtime-contract-exports', 'corepack',
      ['pnpm', 'exec', 'tsc', '--ignoreConfig', '--target', 'ES2022', '--module', 'NodeNext',
        '--moduleResolution', 'NodeNext', '--types', 'node', '--strict', '--skipLibCheck', '--allowJs',
        '--declaration', '--sourceMap', '--rootDir', 'src', '--outDir', 'dist', '--listEmittedFiles',
        ...missing.map(entry => entry.source)], 'packages/contracts')
    facts.dependencyEmission = { roots: missing.map(entry => entry.source),
      emittedFiles: result.stdout.split('\n').filter(line => line.startsWith('TSFILE: ')), exitCode: result.exitCode }
    if (result.exitCode !== 0) {
      facts.dependencyDiagnostics = result.stdout.split('\n').filter(line => /error TS\d+/.test(line))
      throw new Error('Required real runtime export generation failed')
    }
  }
  facts.requiredRuntimeExports = Object.keys(plan.requiredExports)
}

function sensitiveCategory(value) {
  if (typeof value === 'string') {
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)) return 'private-key'
    const database = /postgres(?:ql)?:\/\/[^:\s]+:([^@\s]+)@/.exec(value)
    if (database && !/redact|\*{3}/i.test(database[1])) return 'database-password'
    if (/Authorization["']?\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~-]{20,}/i.test(value)) return 'authorization-value'
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:token|password|privateKey)$/i.test(key) && typeof child === 'string'
        && child.length >= 20 && !/redact/i.test(child)) return 'credential-field'
      const category = sensitiveCategory(child)
      if (category) return category
    }
  }
}

try {
  if (process.getuid?.() === 0) throw new Error('An existing unprivileged CI user is required')
  for (const path of [env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  record({ stage: 'provenance', source: plan.source, checkoutSha: facts.checkoutSha,
    selectedIds: plan.selections.flatMap(selection => selection.ids), canonicalPrivateTemporaryRoot: true })
  await prepareContractExports()
  const key = await run('postgres-cache-key', 'bash', ['scripts/ci-postgres-toolchain.sh', 'cache-key'])
  if (key.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(key.stdout.trim())) throw new Error('PostgreSQL tool preflight failed')
  const install = await run('postgres-tool-dependency-install', 'bash', ['scripts/ci-postgres-toolchain.sh', 'install'])
  if (install.exitCode !== 0) {
    facts.toolSetupDiagnostics = install.stderr.split('\n').filter(line => /error:|Error [0-9]|failed|Could not/i.test(line))
      .slice(-15).map(line => line.replaceAll(root, '<owned-runtime>'))
    throw new Error('Native PostgreSQL dependency preparation failed')
  }
  const verify = await run('postgres-tool-dependency-verify', 'bash', ['scripts/ci-postgres-toolchain.sh', 'verify'])
  if (verify.exitCode !== 0) throw new Error('Native PostgreSQL dependency verification failed')
  env.CONFORMANCE_POSTGRES_BIN_DIR = join(env.FOREMAN_CODE_CI_POSTGRES_CACHE, 'toolchains',
    'postgresql-17.6-' + key.stdout.trim(), 'bin')
  for (const selection of plan.selections) {
    const reportFile = join(root, selection.name + '.json')
    const result = await run(selection.name, process.execPath, selection.args, 'conformance',
      { ...env, CONFORMANCE_RESULTS_FILE: reportFile })
    let rawReport
    let report
    try { rawReport = await readFile(reportFile, 'utf8'); report = JSON.parse(rawReport) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    const outcomes = report?.scenarios ?? []
    const summary = { name: selection.name, requestedIds: selection.ids, originalExitCode: result.exitCode,
      rawStatus: report?.status ?? 'report-not-produced', actualCount: outcomes.length,
      executedCount: outcomes.filter(outcome => outcome.executed).length,
      passedCount: outcomes.filter(outcome => outcome.status === 'passed').length,
      outcomes: outcomes.map(outcome => ({ id: outcome.id, status: outcome.status,
        executed: outcome.executed, phase: outcome.phase, errorName: outcome.error?.name })) }
    const category = sensitiveCategory([report, result.stdout, result.stderr])
    if (category) { summary.rawExportBlockedCategory = category; failed = true }
    else rawReports.push({ name: selection.name, rawReport, stdout: result.stdout, stderr: result.stderr })
    facts.selections.push(summary)
    record({ stage: 'selection-finish', ...summary })
    if (result.exitCode !== 0 || outcomes.length !== selection.ids.length
      || outcomes.some(outcome => !outcome.executed || outcome.status !== 'passed')
      || outcomes.some(outcome => !selection.ids.includes(outcome.id))) failed = true
  }
  const bytes = Buffer.from(JSON.stringify({ source: plan.source, selections: rawReports }))
  const encoded = gzipSync(bytes).toString('base64')
  const chunks = encoded.match(/.{1,24000}/g) ?? []
  console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'artifact', path: 'selected-native-reports.json',
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), encoding: 'gzip+base64', chunks: chunks.length }))
  chunks.forEach((data, index) => console.log('FOREMAN_CAPTURE ' + JSON.stringify({
    kind: 'chunk', path: 'selected-native-reports.json', index, data })))
} catch (error) {
  failed = true
  facts.failure = error.message.replaceAll(root, '<owned-runtime>')
} finally {
  clearInterval(progress)
  await rm(root, { recursive: true, force: true })
  facts.cleanup = true
  facts.failed = failed
  facts.completeAcceptanceProven = false
  record({ stage: 'result', ...facts })
}
process.exitCode = failed ? 1 : 0
