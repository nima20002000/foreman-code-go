import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ciTestResults } from './ci-test-results.mjs'

const source = '11950b175bd9cd51d99429628405589cee794ec9'
const testFile = 'scripts/ci-suite-go.test.mjs'
const hookFile = 'scripts/ci-suite.sh'
const original = await readFile('scripts/test-support/ci-suite-source.sh')
const hook = await readFile(hookFile)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
if (digest(original) !== 'a4e0af0dc031390f6aa25fd3c21e6ae7c75e5de80efab70e7376822695aaef96'
  || digest(await readFile(testFile)) !== 'd09e38f73f955be87a74d416ddf7c3c84fb41eb1a827160d83a58eaa2232eb9c') {
  throw new Error('Affected test or fixture script differs from the reviewed source')
}
const directory = await mkdtemp(join(tmpdir(), 'foreman-fixture-regression-'))
const report = join(directory, 'tests.json')
console.log('[fixture-regression] ' + JSON.stringify({ source, affectedFile: testFile,
  checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  originalHookSha256: digest(original), testSha256: digest(await readFile(testFile)) }))
let code = 1
try {
  // The fixtures copy this script; exercise the reviewed source instead of this diagnostic interception.
  await writeFile(hookFile, original)
  code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec',
      '--test-reporter-destination=stdout', '--test-reporter=./scripts/ci-node-test-reporter.mjs',
      '--test-reporter-destination=' + report, testFile], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', status => resolve(status ?? 1))
  })
  const results = ciTestResults([JSON.parse(await readFile(report, 'utf8'))], process.cwd())
  console.log('[fixture-regression] ' + JSON.stringify({ exitCode: code, summary: results.summary }))
  if (process.env.TEST_RESULTS_OUTPUT) {
    await mkdir(dirname(process.env.TEST_RESULTS_OUTPUT), { recursive: true })
    await writeFile(process.env.TEST_RESULTS_OUTPUT, JSON.stringify(results))
  }
} finally {
  await writeFile(hookFile, hook)
  await rm(directory, { recursive: true, force: true })
}
process.exitCode = code
