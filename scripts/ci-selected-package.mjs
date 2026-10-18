import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, access, lstat, readdir, symlink } from 'node:fs/promises'
import { availableParallelism, homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { ciTestResults } from './ci-test-results.mjs'

if (process.env.CI !== 'true' && process.env.CI_HOST_RUNNER !== '1') {
  throw new Error('This diagnostic runs only inside authenticated Foreman CI')
}
process.umask(0o077)
process.chdir(fileURLToPath(new URL('..', import.meta.url)))
if (process.argv[2] === 'prepare-contracts') {
  console.log('[transport-setup] Dependency emission is explicit inside the selected diagnostic scope')
  process.exit(0)
}
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
  CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), CI_STATE: join(root, 'provider'), SUITE: ['format-only', 'integration-only', 'tests-only', 'targeted', 'build-and-tests'].includes(plan.mode) ? 'unit' : 'lint',
  FOREMAN_CODE_CI_GO_CACHE: cache, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
  FOREMAN_CODE_CI_CPU_COUNT: String(Math.min(2, availableParallelism())),
  GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly -p=2',
  GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org',
  GOCACHE: join(cache, 'build'), GOMODCACHE: join(cache, 'modules'), GOPATH: join(cache, 'gopath'),
  GOTMPDIR: join(root, 't'), CGO_ENABLED: '1', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1',
  USERPROFILE: join(root, 'h'), TMP: join(root, 't'), TEMP: join(root, 't')
}
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'FOREMAN_CODE_CI_DATABASE_CPUS',
  'FOREMAN_CODE_CI_DATABASE_MEMORY_BYTES']) {
  if (process.env[key]) env[key] = process.env[key]
}
const record = value => console.log('[selected-package] ' + JSON.stringify(value))
const facts = {
  source: plan.source, sourceTree: plan.sourceTree,
  checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  selectedMjs: 'scripts/ci-go-toolchain-probe.test.mjs',
  executedGo: ['capture', 'node-only', 'python-only'].includes(plan.mode) ? null : plan.packages ?? plan.package,
  executedPython: plan.pythonTestFile ?? null,
  executedNode: ['package', 'node-only'].includes(plan.mode) ? plan.nodeTestFile ?? null : null,
  fullSuiteExecuted: false, conformanceExecuted: false,
  testsRequested: requestedTestCount(),
  commands: [], selections: [], cleanup: false,
  sharedToolCacheRetained: true
}
const raw = []
const reports = []
const extraArtifacts = []
let phase = 'setup'
let failed = false
let providerAttempted = false
let filesFixtureRoot
const progress = setInterval(() => record({ stage: 'running', phase }), 15000)

function requestedTestCount() {
  if (plan.mode === 'capture') return plan.captureTests.length
  if (plan.mode === 'package') return plan.unitTests.length + plan.integrationTests.length + (plan.nodeTests?.length ?? 0)
  if (['compatibility', 'tests-only', 'targeted', 'build-and-tests'].includes(plan.mode)) return plan.unitTests.length
  if (plan.mode === 'integration-only') return plan.integrationTests.length
  if (plan.mode === 'node-only') return plan.nodeTests.length
  if (plan.mode === 'python-only') return plan.pythonTests.length
  return 0
}

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
  const stdoutChunks = []
  const stderrChunks = []
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd ?? process.cwd(), env: env, stdio: ['pipe', 'pipe', 'pipe']
    })
    child.stdout.on('data', bytes => { stdoutChunks.push(Buffer.from(bytes)) })
    child.stderr.on('data', bytes => { stderrChunks.push(Buffer.from(bytes)) })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
    child.stdin.end(options.input)
  })
  stdout = Buffer.concat(stdoutChunks).toString('utf8')
  stderr = Buffer.concat(stderrChunks).toString('utf8')
  const result = { name, program, args, exitCode, stdout, stderr, startedAt,
    stdoutBase64: Buffer.concat(stdoutChunks).toString('base64'),
    stderrBase64: Buffer.concat(stderrChunks).toString('base64'),
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
  const race = kind === 'integration' ? plan.integrationRace ?? plan.race : plan.race
  const packages = kind === 'integration' ? plan.integrationPackages ?? plan.packages ?? [plan.package] : plan.unitPackages ?? plan.packages ?? [plan.package]
  const flags = [...(tags ? ['-tags', tags] : []), ...(race ? ['-race'] : [])]
  const result = await run(kind + '-tests', go, [
    'test', '-json', '-count=1', '-timeout=' + (kind === 'integration' ? plan.integrationTimeout ?? plan.testTimeout ?? '10m' : plan.testTimeout ?? '10m'), ...flags,
    '-run', plan.testPattern ?? '^(' + names.join('|') + ')$', ...packages
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
  await run(kind + '-conversion', process.execPath, [
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

async function selectedNodeTests() {
  const report = join(root, 'node.vitest.json')
  const result = await run('selected-Node-tests', process.execPath, [
    '--test', '--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=' + resolve('scripts/ci-node-test-reporter.mjs'),
    '--test-reporter-destination=' + report, plan.nodeTestFile
  ])
  let parsed
  try { parsed = JSON.parse(await readFile(report, 'utf8')); reports.push(parsed) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const outcomes = (parsed?.testResults ?? []).flatMap(file => file.assertionResults)
  const names = outcomes.map(test => test.fullName)
  const statuses = { passed: 'pass', failed: 'fail', pending: 'skip' }
  const selection = { kind: 'node', requested: plan.nodeTests, originalExitCode: result.exitCode,
    missing: plan.nodeTests.filter(name => !names.includes(name)),
    unexpected: names.filter(name => !plan.nodeTests.includes(name)), namedCount: outcomes.length,
    tests: outcomes.map(test => ({ name: test.fullName,
      status: statuses[test.status] ?? 'skip',
      durationMs: test.duration, failureMessages: test.failureMessages })) }
  facts.selections.push(selection)
  record({ stage: 'selection', ...selection })
  if (selection.missing.length || selection.unexpected.length || !outcomes.length
    || selection.tests.some(test => test.status !== 'pass')) failed = true
}

async function selectedPythonTests() {
  await required('retained-Python-version', 'python3', ['--version'])
  const result = await run('selected-Python-unittest', 'python3', [plan.pythonTestFile, '-v', ...plan.pythonTests])
  const lines = result.stderr.split('\n')
  const statuses = { ok: 'pass', FAIL: 'fail', ERROR: 'fail' }
  const tests = plan.pythonTests.map(name => {
    const leaf = name.split('.').at(-1)
    const line = lines.find(line => line.startsWith(leaf + ' (') && line.includes(' ... '))
    const nativeStatus = line?.split(' ... ').at(-1).trim() ?? 'missing'
    return { name, nativeStatus, status: statuses[nativeStatus] ?? 'skip', durationMs: null }
  })
  const count = Number(/^Ran (\d+) tests? in /m.exec(result.stderr)?.[1] ?? 0)
  const selection = { kind: 'python', requested: plan.pythonTests, originalExitCode: result.exitCode,
    namedCount: tests.filter(test => test.nativeStatus !== 'missing').length, nativeExecutedCount: count, tests }
  facts.selections.push(selection)
  record({ stage: 'selection', ...selection })
  if (count !== plan.pythonTests.length || tests.some(test => test.status !== 'pass')) failed = true
  const normalizedStatuses = { pass: 'passed', fail: 'failed', skip: 'pending' }
  reports.push({ testResults: [{ name: plan.pythonTestFile,
    status: tests.some(test => test.status === 'fail') ? 'failed' : 'passed',
    duration: Date.parse(result.finishedAt) - Date.parse(result.startedAt),
    assertionResults: tests.map(test => ({ fullName: test.name, duration: null,
      status: normalizedStatuses[test.status],
      ...(test.status === 'fail' ? { failureMessages: [result.stderr] } : {}) })) }] })
  if (!plan.reproduceGenerator) return
  const output = join(root, 'output', 'types.gen.go')
  await required('exact-generator-CLI', 'python3', [plan.generatorFile,
    '--schema', plan.schemaFile, '--method-source', plan.methodSourceFile, '--output', output])
  const compared = await run('full-generated-file-compare', 'cmp', ['--', output, plan.generatedFile])
  const rendered = await readFile(output)
  const checkedIn = await readFile(plan.generatedFile)
  facts.generatedFile = { bytes: rendered.length, checkedInBytes: checkedIn.length,
    sha256: createHash('sha256').update(rendered).digest('hex'),
    checkedInSha256: createHash('sha256').update(checkedIn).digest('hex'), cmpExitCode: compared.exitCode,
    fullByteEquality: rendered.equals(checkedIn) }
  extraArtifacts.push({ path: 'generated-types.gen.go', bytes: rendered })
  if (!facts.generatedFile.fullByteEquality) failed = true
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
  const staticcheck = join(cache, 'tools', 'staticcheck-' + pins.staticcheck.version, 'bin/staticcheck')
  env.PATH = join(env.GOROOT, 'bin') + ':' + dirname(staticcheck) + ':' + env.PATH
  if (['package', 'Staticcheck-only', 'checks-only', 'compatibility'].includes(plan.mode)) {
    const version = await required('pinned-Staticcheck-version', staticcheck, ['-version'])
    if (!version.stdout.trim().endsWith('(' + pins.staticcheck.version.slice(1) + ')')) {
      throw new Error('Staticcheck does not match the public pin')
    }
  }
  return { go, staticcheck }
}

async function checkFormatting() {
  const formatted = await run('changed-Go-format', join(env.GOROOT, 'bin/gofmt'),
    ['-l', ...plan.goFiles], { cwd: 'backend' })
  facts.unformatted = formatted.stdout.split('\n').filter(Boolean)
  if (facts.unformatted.length) {
    failed = true
    await run('changed-Go-format-patch', join(env.GOROOT, 'bin/gofmt'),
      ['-d', ...facts.unformatted], { cwd: 'backend' })
  }
}

async function prepareFilesFixture() {
  if (process.platform !== 'linux' || await realpath(parent) !== parent) {
    throw new Error('Managed file fixture requires existing canonical Linux CI state')
  }
  filesFixtureRoot = await mkdtemp(join(parent, 'f-'))
  const canonical = await realpath(filesFixtureRoot)
  const info = await lstat(filesFixtureRoot)
  if (canonical !== filesFixtureRoot || !info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error('Managed file fixture is not a canonical private current-UID-owned directory')
  }
  const excluded = ['/tmp', '/var/tmp', tmpdir(), process.cwd(), root,
    process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR].filter(Boolean).map(path => resolve(path))
  const overlaps = path => path === canonical || canonical.startsWith(path + '/') || path.startsWith(canonical + '/')
  for (const path of excluded) {
    let resolved = path
    try { resolved = await realpath(path) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (overlaps(path) || overlaps(resolved)) {
      throw new Error('Managed file fixture overlaps existing temporary, workspace or harness state')
    }
  }
  env.FOREMAN_FILES_TEST_ROOT = canonical
  facts.filesFixture = { root: canonical, canonical: true, private: true, uid: info.uid,
    mode: (info.mode & 0o777).toString(8), existingCIState: parent,
    excludedRoots: excluded, fresh: true, noPermissionsOrMountsChanged: true }
}

function contentIdentity(bytes) {
  return {
    blob: createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  }
}

async function selectedReferenceVectors() {
  const reference = plan.referenceVectors
  const frozenRoot = join(root, 'frozen')
  const pack = Buffer.from(reference.frozenSparsePack, 'base64')
  if (createHash('sha256').update(pack).digest('hex') !== reference.frozenSparsePackSha256) {
    throw new Error('Frozen sparse Git object pack digest differs')
  }
  await required('frozen-sparse-repository-init', 'git', ['init', '--quiet', frozenRoot])
  await required('frozen-genuine-object-import', 'git', ['-C', frozenRoot, 'unpack-objects'], { input: pack })
  await writeFile(join(frozenRoot, '.git', 'HEAD'), reference.frozen + '\n')
  const identity = await required('frozen-reference-identity', 'git',
    ['-C', frozenRoot, 'rev-parse', 'HEAD', 'HEAD^{tree}'])
  if (identity.stdout.trim() !== reference.frozen + '\n' + reference.frozenTree) {
    throw new Error('Frozen sparse repository has a different commit or tree')
  }
  const packageFile = await required('frozen-package-source', 'git',
    ['-C', frozenRoot, 'show', reference.frozen + ':apps/api/package.json'])
  const packageBytes = Buffer.from(packageFile.stdout)
  if (contentIdentity(packageBytes).blob !== reference.frozenPackageBlob) {
    throw new Error('Frozen API package metadata has a different Git identity')
  }
  await mkdir(join(frozenRoot, 'apps', 'api'), { recursive: true })
  await writeFile(join(frozenRoot, 'apps', 'api', 'package.json'), packageBytes)
  facts.referenceVectors = {
    frozen: reference.frozen, frozenTree: reference.frozenTree,
    frozenCheckout: 'isolated sparse checkout containing the required API package metadata',
    frozenObjects: reference.frozenSparseObjects,
    frozenSparsePackSha256: reference.frozenSparsePackSha256,
    runtime: { executable: process.execPath, version: process.version, versions: process.versions },
    producers: [],
  }
  for (const producer of reference.sourceProvenance.producers) {
    const bytes = await readFile(producer.file)
    const expected = reference.sourceProvenance.source.changedFiles.find(file => file.path === producer.file)
    const actual = contentIdentity(bytes)
    if (actual.blob !== expected.candidateBlob || actual.sha256 !== expected.sha256) {
      throw new Error('Reference producer differs from its reviewed source: ' + producer.file)
    }
    const outputs = {
      JSON_VALUE_VECTORS_FILE: 'json-vectors.json',
      CANONICAL_JSON_VECTORS_FILE: 'canonical-vectors.json',
      CANONICAL_JSON_LEGACY_VECTORS_FILE: 'canonical-legacy-vectors.json',
    }
    const file = outputs[producer.consumerEnv]
    const output = join(root, file)
    const args = producer.consumerEnv === 'JSON_VALUE_VECTORS_FILE'
      ? [producer.file, frozenRoot, output]
      : ['--experimental-strip-types', producer.file, output, ...(producer.args.includes('--legacy') ? ['--legacy'] : [])]
    await required('reference-producer-' + file, process.execPath, args)
    const rendered = await readFile(output)
    const capture = JSON.parse(rendered)
    const ids = capture.vectors.map(vector => vector.id)
    if (!ids.length || new Set(ids).size !== ids.length || capture.source.reference !== reference.frozen) {
      throw new Error('Reference producer returned missing, duplicate or foreign outcomes')
    }
    if (producer.consumerEnv === 'JSON_VALUE_VECTORS_FILE' &&
        (ids.length !== producer.outcomes || capture.unexpected.length ||
         capture.source.candidate.reference !== facts.checkoutSha ||
         capture.source.candidate.producer.blob !== actual.blob ||
         capture.source.frozen.tree !== reference.frozenTree || capture.producer.runtime.name !== 'node')) {
      throw new Error('Native JSON.parse capture provenance or outcomes differ')
    }
    const captured = { file, producer: { path: producer.file, ...actual },
      artifact: contentIdentity(rendered), vectors: ids.length, ids,
      methods: Object.fromEntries(['canonical', 'graph', 'numericLegacy', 'localeLegacy']
        .map(method => [method, capture.vectors.filter(vector => vector[method]).length])),
      runtime: capture.producer.runtime, source: capture.source }
    facts.referenceVectors.producers.push(captured)
    extraArtifacts.push({ path: file, bytes: rendered })
    env[producer.consumerEnv] = output
  }
}

async function executePlan() {
  if (plan.mode === 'capture') { await selectedCaptureTests(); return }
  if (plan.mode === 'node-only') { await selectedNodeTests(); return }
  if (plan.mode === 'python-only') { await selectedPythonTests(); return }
  const { go, staticcheck } = await prepareGo()
  if (plan.mode === 'build-and-tests') {
    await run('ordinary-build', go, ['build', ...plan.packages], { cwd: 'backend' })
  }
  if (['package', 'format-only', 'checks-only', 'compatibility', 'targeted'].includes(plan.mode)) await checkFormatting()
  if (['package', 'Staticcheck-only', 'checks-only', 'compatibility', 'targeted'].includes(plan.mode)) {
    for (const tags of plan.staticcheckTags ?? ['', ...(plan.integrationTests.length ? ['integration'] : [])]) {
      const flags = tags ? ['-tags', tags] : []
      if (['package', 'targeted'].includes(plan.mode)) {
        for (const command of ['build', 'vet']) {
          await run((tags || 'ordinary') + '-' + command, go, [command, ...flags, ...(plan.packages ?? [plan.package])], { cwd: 'backend' })
        }
      }
      if (plan.mode !== 'targeted') {
        await run((tags || 'ordinary') + '-Staticcheck', staticcheck, [...flags, ...(plan.packages ?? [plan.package])], { cwd: 'backend' })
      }
    }
  }
  if (plan.mode === 'package') {
    for (const file of plan.nodeSyntaxFiles ?? []) await run('Node-syntax-' + file, process.execPath, ['--check', file])
  }
  if (plan.referenceVectors) await selectedReferenceVectors()
  if (plan.filesFixtureRequired) await prepareFilesFixture()
  if (plan.commandBinary) {
    env.FOREMAN_TEST_BINARY = join(root, 'foreman')
    await required('exact-command-binary-build', go, ['build', '-o', env.FOREMAN_TEST_BINARY, './cmd/foreman'], { cwd: 'backend' })
  }
  if (['package', 'compatibility', 'tests-only', 'targeted', 'build-and-tests'].includes(plan.mode)) await selectedTests('unit', plan.unitTests, '', go)
  if (['package', 'integration-only'].includes(plan.mode) && plan.integrationTests.length) {
    if (plan.integrationRequiresDatabase !== false) await startProvider()
    await selectedTests('integration', plan.integrationTests, 'integration', go)
  }
  if (plan.mode === 'package' && plan.nodeTests?.length) await selectedNodeTests()
}

async function selectedCaptureTests() {
  const frozen = await prepareCaptureSource()
  await required('explicit-minimal-contracts-emit', process.execPath, ['scripts/ci-capture-contracts.mjs', frozen])
  const compilation = await readFile('scripts/ci-capture-contracts-result.json')
  const emission = JSON.parse(compilation)
  if (emission.source && emission.source !== plan.source) throw new Error('Contracts emission source differs')
  if (JSON.stringify(emission.entryPoints) !== JSON.stringify(plan.compileEntryPoints)) throw new Error('Contracts emission scope differs')
  const api = join(frozen, 'apps/api')
  const require = createRequire(join(api, 'package.json'))
  if (plan.captureTests.length) {
  const report = join(root, 'capture.vitest.json')
  const escaped = plan.captureTests.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
  const result = await run('frozen-public-capture', process.execPath, [vitest, 'run',
    '--config', resolve('scripts/ci-capture-vitest.config.mjs'),
    plan.captureFile.replace(/^apps\/api\//, ''), '-t', '^(' + escaped.join('|') + ')$',
    '--reporter=default', '--reporter=json', '--outputFile=' + report], { cwd: api })
  const original = JSON.parse(await readFile(report, 'utf8'))
  const outcomes = original.testResults.flatMap(file => file.assertionResults)
  const selected = outcomes.filter(test => plan.captureTests.includes(test.fullName))
  const missing = plan.captureTests.filter(name => !selected.some(test => test.fullName === name))
  facts.selections.push({ kind: 'frozen-capture', requested: plan.captureTests, missing,
    originalExitCode: result.exitCode, namedCount: selected.length, tests: selected })
  if (missing.length || selected.some(test => test.status !== 'passed')) failed = true
  reports.push({ testResults: original.testResults.map(file => ({ ...file, name: resolve(plan.captureFile),
    assertionResults: file.assertionResults.filter(test => plan.captureTests.includes(test.fullName)) })) })
  extraArtifacts.push({ path: 'capture-vitest-original.json', bytes: Buffer.from(JSON.stringify(original)) })
  }
  facts.runtime = { executable: process.execPath, versions: process.versions,
    platform: process.platform, architecture: process.arch }
  facts.captureDependencies = {}
  for (const dependency of ['vitest', 'pino', 'tsx']) {
    facts.captureDependencies[dependency] = JSON.parse(await readFile(require.resolve(dependency + '/package.json'), 'utf8')).version
  }
  extraArtifacts.push({ path: 'capture-contracts-emission.json', bytes: compilation })
  if (plan.analyzeProbe) {
    if (!plan.analysisChecks || plan.analysisChecks.includes('lint')) {
    await run('exact-probe-lint', process.execPath,
      [join(dirname(require.resolve('eslint/package.json')), 'bin/eslint.js'), plan.captureFile.replace(/^apps\/api\//, ''), '--max-warnings=0'], { cwd: api })
    }
    const compiler = require.resolve('typescript/bin/tsc')
    const config = JSON.parse(await readFile(join(api, 'tsconfig.json'), 'utf8'))
    const flags = Object.entries({ ...config.compilerOptions, noEmit: true })
      .flatMap(([key, value]) => ['--' + key, Array.isArray(value) ? value.join(',') : String(value)])
    await run('exact-probe-typecheck', process.execPath, [compiler, ...flags, join(frozen, plan.captureFile)], { cwd: api })
  }
}

async function prepareCaptureSource() {
  const destination = join(root, 'source')
  const pack = Buffer.from(plan.objectPack, 'base64')
  if (createHash('sha256').update(pack).digest('hex') !== plan.objectPackSHA256) throw new Error('Frozen Git pack differs')
  await required('frozen-init', 'git', ['init', '--quiet', destination])
  await required('frozen-objects', 'git', ['unpack-objects', '-q'], { cwd: destination, input: pack })
  await writeFile(join(destination, '.git/HEAD'), plan.source + '\n')
  await required('frozen-sparse-init', 'git', ['sparse-checkout', 'init', '--no-cone'], { cwd: destination })
  await writeFile(join(destination, '.git/info/sparse-checkout'), plan.sparsePaths.map(path => '/' + path).join('\n') + '\n')
  await required('frozen-checkout', 'git', ['read-tree', '-mu', 'HEAD'], { cwd: destination })
  const identity = await required('frozen-identity', 'git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], { cwd: destination })
  if (identity.stdout.trim() !== plan.source + '\n' + plan.sourceTree) throw new Error('Frozen source identity differs')
  await symlink(resolve('node_modules'), join(destination, 'node_modules'), 'dir')
  await symlink(resolve('packages/contracts/node_modules'), join(destination, 'packages/contracts/node_modules'), 'dir')
  const sourceModules = resolve('apps/api/node_modules')
  const privateModules = join(destination, 'apps/api/node_modules')
  await mkdir(privateModules)
  for (const name of await readdir(sourceModules)) {
    if (name.startsWith('.')) continue
    if (!name.startsWith('@')) {
      await symlink(join(sourceModules, name), join(privateModules, name), 'dir')
      continue
    }
    await mkdir(join(privateModules, name))
    for (const child of await readdir(join(sourceModules, name))) {
      const target = name === '@foreman-code' && child === 'contracts'
        ? join(destination, 'packages/contracts') : join(sourceModules, name, child)
      await symlink(target, join(privateModules, name, child), 'dir')
    }
  }
  facts.frozenSource = { source: plan.source, tree: plan.sourceTree, sparsePaths: plan.sparsePaths,
    objectPackSHA256: plan.objectPackSHA256, dependencyLinks: 'pinned external packages; private contracts output' }
  return destination
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
    if (filesFixtureRoot) {
      const remaining = await readdir(filesFixtureRoot)
      if (facts.filesFixture) facts.filesFixture.childrenCleanedByTests = remaining.length === 0
      if (remaining.length) failed = true
      await rm(filesFixtureRoot, { recursive: true, force: true })
      let retained = false
      try { await access(filesFixtureRoot); retained = true }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (retained) throw new Error('Owned managed file fixture remains after cleanup')
      facts.filesFixtureCleanup = true
    }
    await rm(root, { recursive: true, force: true })
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
