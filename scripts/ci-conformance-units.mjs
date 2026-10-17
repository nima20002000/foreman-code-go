import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ciTestResults } from './ci-test-results.mjs'

const directory = await mkdtemp(join(tmpdir(), 'foreman-conformance-units-'))
const reports = []
let failed = false
async function run(name, args, file) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn('corepack', ['pnpm', ...args], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', code => resolve(code ?? 1))
  })
  console.log('[conformance-units] ' + JSON.stringify({ name, exitCode: code,
    sourceBaseline: 'eaea4e3ff4e1ef9a8666083b16b26c734e1e83e1' }))
  if (code !== 0) failed = true
  reports.push(JSON.parse(await readFile(file, 'utf8')))
}
try {
  const conformance = join(directory, 'conformance.json')
  await run('all-conformance-unit-tests', ['--dir', 'conformance', 'test', '--reporter=default',
    '--reporter=json', '--outputFile=' + conformance], conformance)
  const helpers = join(directory, 'helpers.json')
  await run('conformance-report-and-gate-helpers', ['exec', 'node', '--test',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=./scripts/ci-node-test-reporter.mjs', '--test-reporter-destination=' + helpers,
    'scripts/ci-conformance-results.test.mjs', 'scripts/ci-conformance-gate.test.mjs'], helpers)
  if (process.env.TEST_RESULTS_OUTPUT) {
    await writeFile(process.env.TEST_RESULTS_OUTPUT, JSON.stringify(ciTestResults(reports, process.cwd())))
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
