import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { gzipSync } from 'node:zlib'
import { ciTestResults } from './ci-test-results.mjs'

const plan = JSON.parse(await readFile('scripts/ci-selected-checks.json', 'utf8'))
const group = process.argv[2]
if (!plan.groups[group]) throw new Error('Unknown selected check group')
const hookFile = 'scripts/ci-suite.sh'
const sourceHook = await readFile('scripts/test-support/ci-suite-source.sh')
if (createHash('sha256').update(sourceHook).digest('hex') !== plan.sourceHookSha256) {
  throw new Error('Fixture source hook differs from the declared source')
}
const diagnosticHook = await readFile(hookFile)
const directory = await mkdtemp(join(tmpdir(), 'foreman-selected-checks-'))
const checks = []
const reports = []
const rawReports = []
let contractsReady = false
const record = value => console.log('[selected-check] ' + JSON.stringify(value))
record({ source: plan.source, group, requiredExports: group === 'qconf' ? plan.requiredExports : [],
  checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() })

try {
  // Copied CLI fixtures must exercise the original source, never this diagnostic interception.
  await writeFile(hookFile, sourceHook)
  for (const check of plan.groups[group]) {
    if (check.needsContracts && !contractsReady) {
      checks.push({ name: check.name, blocked: true, reason: 'required-contract-export-setup-failed' })
      record(checks.at(-1))
      continue
    }
    const report = join(directory, check.name + '.json')
    let args = [...check.args]
    if (check.reportKind === 'vitest') args.push('--reporter=default', '--reporter=json', '--outputFile=' + report)
    if (check.reportKind === 'node') {
      args = ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout',
        '--test-reporter=./scripts/ci-node-test-reporter.mjs', '--test-reporter-destination=' + report, ...args.slice(1)]
    }
    record({ stage: 'start', ...check, args })
    const startedAt = new Date().toISOString()
    let stdout = ''
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(check.program, args, { cwd: check.cwd, stdio: ['ignore', 'pipe', 'inherit'] })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', text => { stdout += text; process.stdout.write(text) })
      child.once('error', reject)
      child.once('close', code => resolve(code ?? 1))
    })
    checks.push({ name: check.name, exitCode, startedAt, finishedAt: new Date().toISOString() })
    record({ stage: 'finish', ...checks.at(-1) })
    if (check.dependencySetup) {
      contractsReady = exitCode === 0
      const emittedFiles = stdout.split('\n').filter(line => line.startsWith('TSFILE: '))
        .map(line => relative(process.cwd(), line.slice(8)))
      record({ stage: 'dependency-emission', roots: plan.exportSourceRoots, emittedFiles })
      for (const key of plan.requiredExports) {
        const contractPackage = JSON.parse(await readFile('packages/contracts/package.json', 'utf8'))
        for (const file of Object.values(contractPackage.exports[key])) {
          try { await access(join('packages/contracts', file)) }
          catch (error) { if (error.code !== 'ENOENT') throw error; contractsReady = false }
        }
      }
      record({ stage: 'dependency-ready', ready: contractsReady })
    }
    if (check.reportKind) {
      const rawText = await readFile(report, 'utf8')
      reports.push(JSON.parse(rawText))
      rawReports.push({ name: check.name, kind: check.reportKind, rawText,
        sha256: createHash('sha256').update(rawText).digest('hex') })
    }
  }
  const results = ciTestResults(reports, process.cwd())
  record({ stage: 'summary', checks, tests: results.summary })
  if (process.env.TEST_RESULTS_OUTPUT) {
    await mkdir(dirname(process.env.TEST_RESULTS_OUTPUT), { recursive: true })
    await writeFile(process.env.TEST_RESULTS_OUTPUT, JSON.stringify(results))
  }
  const bytes = Buffer.from(JSON.stringify({ source: plan.source, group, checks, reports: rawReports }))
  const encoded = gzipSync(bytes).toString('base64')
  const chunks = encoded.match(/.{1,24000}/g) ?? []
  console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'artifact', path: 'selected-test-reports.json',
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    encoding: 'gzip+base64', chunks: chunks.length }))
  chunks.forEach((data, index) => console.log('FOREMAN_CAPTURE ' + JSON.stringify({
    kind: 'chunk', path: 'selected-test-reports.json', index, data })))
  process.exitCode = checks.some(check => check.blocked || check.exitCode !== 0) ? 1 : 0
} finally {
  await writeFile(hookFile, diagnosticHook)
  await rm(directory, { recursive: true, force: true })
  record({ stage: 'cleanup', sourceHookRestored: true, privateReportsRemoved: true })
}
