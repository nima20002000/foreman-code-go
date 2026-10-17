import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ciTestResults } from './ci-test-results.mjs'

const plan = JSON.parse(await readFile('scripts/ci-affected-checks.json', 'utf8'))
const directory = await mkdtemp(join(tmpdir(), 'foreman-affected-checks-'))
const reports = []
const checks = []
const record = value => console.log('[affected-check] ' + JSON.stringify(value))
record({ source: plan.source,
  checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scope: 'explicit-affected-files-and-import-closure' })
try {
  for (const check of plan.checks) {
    const report = join(directory, check.name + '.json')
    let args = [...check.args]
    if (check.reportKind === 'vitest') {
      args.push('--reporter=default', '--reporter=json', '--outputFile=' + report)
    }
    if (check.reportKind === 'node') {
      args = ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout',
        '--test-reporter=./scripts/ci-node-test-reporter.mjs', '--test-reporter-destination=' + report,
        ...args.slice(1)]
    }
    record({ stage: 'start', ...check, args })
    const startedAt = new Date().toISOString()
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(check.program, args, { cwd: check.cwd, stdio: 'inherit' })
      child.once('error', reject)
      child.once('close', code => resolve(code ?? 1))
    })
    checks.push({ name: check.name, exitCode, startedAt, finishedAt: new Date().toISOString() })
    record({ stage: 'finish', ...checks.at(-1) })
    if (check.reportKind) reports.push(JSON.parse(await readFile(report, 'utf8')))
  }
  const results = ciTestResults(reports, process.cwd())
  record({ stage: 'summary', checks, tests: results.summary })
  if (process.env.TEST_RESULTS_OUTPUT) {
    await mkdir(dirname(process.env.TEST_RESULTS_OUTPUT), { recursive: true })
    await writeFile(process.env.TEST_RESULTS_OUTPUT, JSON.stringify(results))
  }
  process.exitCode = checks.some(check => check.exitCode !== 0) ? 1 : 0
} finally {
  await rm(directory, { recursive: true, force: true })
  record({ stage: 'cleanup', ownedDirectoryRemoved: true })
}
