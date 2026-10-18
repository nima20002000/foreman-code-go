import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { ciTestResults } from './ci-test-results.mjs'

process.umask(0o077)
if (process.env.CI !== 'true' && process.env.CI_HOST_RUNNER !== '1') throw new Error('Foreman CI required')
const original = fileURLToPath(new URL('..', import.meta.url))
const plan = JSON.parse(await readFile(join(original, 'scripts/ci-selected-reporter-plan.json'), 'utf8'))
const parent = join(await realpath(homedir()), '.c')
await mkdir(parent, { recursive: true, mode: 0o700 })
const owned = await mkdtemp(join(parent, 'u-'))
const env = { PATH: process.env.PATH, CI: 'true', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  HOME: join(owned, 'h'), TMPDIR: join(owned, 't'), XDG_CONFIG_HOME: join(owned, 'config'),
  XDG_CACHE_HOME: join(owned, 'cache'), XDG_STATE_HOME: join(owned, 'state') }
for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
  await mkdir(env[key], { recursive: true, mode: 0o700 })
}
const setup = process.argv[2] === 'prepare-contracts'
const cwd = resolve(original, setup ? 'packages/contracts' : 'conformance')
const required = createRequire(join(cwd, 'package.json'))
const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'))
const checks = []
const dependencies = []
const reports = []
let failure = null
let cleanup = false
const record = value => console.log('[selected-reporter] ' + JSON.stringify(value))

async function dependencyBin(name, command) {
  const packageFile = await realpath(required.resolve(name + '/package.json'))
  const installed = JSON.parse(await readFile(packageFile, 'utf8'))
  const pin = manifest.devDependencies[name]
  const pinnedVersion = pin.startsWith('npm:') ? pin.slice(pin.lastIndexOf('@') + 1) : pin
  if (installed.version !== pinnedVersion) throw new Error('Installed dependency differs from its source pin: ' + name)
  const relativeBin = typeof installed.bin === 'string' ? installed.bin : installed.bin?.[command] ?? (name === 'typescript' ? installed.bin?.tsc6 : undefined)
  if (typeof relativeBin !== 'string') throw new Error('Installed dependency lacks the requested CLI: ' + name)
  const binary = await realpath(resolve(dirname(packageFile), relativeBin))
  dependencies.push({ name: installed.name, version: installed.version, bin: installed.bin, packageFile, binary })
  return binary
}

async function run(name, args) {
  record({ stage: 'start', name })
  const startedAt = new Date().toISOString()
  const result = await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.once('error', reject)
    child.once('close', code => done({ exitCode: code ?? 1, stdout, stderr }))
  })
  checks.push({ name, args, startedAt, finishedAt: new Date().toISOString(), ...result })
  record({ stage: 'finish', name, exitCode: result.exitCode, stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr) })
}

try {
  record({ stage: 'provenance', source: plan.source, phase: plan.phase,
    checkout: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    selectedFiles: plan.testFiles, typeRoots: plan.phase === 'candidate' ? plan.typeRoots : [],
    nativeScenariosExecuted: 0, contractsFullBuild: false, contractsAffectedEmit: setup })
  if (setup) {
    const compiler = await dependencyBin('typescript', 'tsc')
    const config = JSON.parse(await readFile(join(cwd, 'tsconfig.json'), 'utf8'))
    const flags = Object.entries({ ...config.compilerOptions, noEmit: false, declaration: true,
      rootDir: 'src', outDir: 'dist' }).flatMap(([key, value]) =>
        ['--' + key, Array.isArray(value) ? value.join(',') : String(value)])
    await run('affected-contracts-export-emit', [compiler, '--ignoreConfig', ...flags, ...plan.compileEntryPoints])
    for (const paths of Object.values(plan.requiredExports)) {
      for (const path of paths) await readFile(join(cwd, path))
    }
  } else {
  for (const paths of Object.values(plan.requiredExports)) {
    for (const path of paths) await readFile(resolve(original, 'packages/contracts', path))
  }
  if (plan.phase === 'candidate') {
    const eslint = await dependencyBin('eslint', 'eslint')
    await run('nine-file-lint', [eslint, ...plan.typeRoots, '--max-warnings', '0'])
    const compiler = await dependencyBin('typescript', 'tsc')
    await run('nine-root-strict-types', [compiler, '--noEmit', '--target', 'ES2023', '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext', '--strict', '--noUncheckedIndexedAccess',
      '--exactOptionalPropertyTypes', '--skipLibCheck', '--types', 'node', ...plan.typeRoots])
  }
  const vitest = await dependencyBin('vitest', 'vitest')
  const reportFile = join(owned, 'vitest.json')
  await run('public-reporter-cases', [vitest, 'run', ...plan.testFiles,
    '--reporter=default', '--reporter=json', '--outputFile=' + reportFile])
  const rawText = await readFile(reportFile, 'utf8')
  const report = JSON.parse(rawText)
  reports.push({ rawText, sha256: createHash('sha256').update(rawText).digest('hex'), bytes: Buffer.byteLength(rawText) })
  const assertions = report.testResults.flatMap(file => file.assertionResults)
  const selectionMatches = assertions.length === plan.caseNames.length && plan.caseNames.every(name =>
    assertions.some(assertion => assertion.fullName.endsWith(name)))
  checks.push({ name: 'exact-case-selection', exitCode: selectionMatches ? 0 : 1,
    outcomes: assertions.map(assertion => ({ fullName: assertion.fullName, status: assertion.status })) })
  if (assertions.some(test => test.status === 'pending' || test.status === 'skipped')) throw new Error('Selected reporter test skipped')
  const normalized = ciTestResults([report], process.cwd())
  record({ stage: 'summary', tests: normalized.summary, selectionMatches })
  if (process.env.TEST_RESULTS_OUTPUT) {
    await mkdir(dirname(process.env.TEST_RESULTS_OUTPUT), { recursive: true })
    await writeFile(process.env.TEST_RESULTS_OUTPUT, JSON.stringify(normalized))
  }
  }
} catch (error) {
  failure = error.stack ?? String(error)
  record({ stage: 'failure', message: failure })
} finally {
  await rm(owned, { recursive: true, force: true })
  cleanup = true
  record({ stage: 'cleanup', ownedRootRemoved: cleanup })
}
const artifactPath = setup ? 'reporter-contracts-setup.json' : 'selected-reporter-reports.json'
const payload = Buffer.from(JSON.stringify({ plan, checks, dependencies, reports, failure, cleanup }))
const chunks = gzipSync(payload).toString('base64').match(/.{1,24000}/g) ?? []
console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'artifact', path: artifactPath,
  bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex'),
  encoding: 'gzip+base64', chunks: chunks.length }))
for (const [index, data] of chunks.entries()) console.log('FOREMAN_CAPTURE ' + JSON.stringify({
  kind: 'chunk', path: artifactPath, index, data }))
process.exitCode = failure || checks.some(check => check.exitCode !== 0) || !cleanup ? 1 : 0
