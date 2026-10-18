import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, basename } from 'node:path'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { ciTestResults } from './ci-test-results.mjs'

if (process.env.CI !== 'true' && process.env.CI_HOST_RUNNER !== '1') throw new Error('Authenticated Foreman CI required')
process.umask(0o077)
const original = await realpath(fileURLToPath(new URL('..', import.meta.url)))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const blob = bytes => createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
if (process.argv[2] === 'prepare-contracts') {
  console.log('[schema-descriptor] No setup build; private source emits only its required three unchanged modules')
} else {
  await qualify()
}

async function qualify() {
  const plan = JSON.parse(await readFile(join(original, 'scripts/ci-selected-package-plan.json'), 'utf8'))
  const parent = join(await realpath(homedir()), '.c')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const owned = await mkdtemp(join(parent, 'schema-'))
  const environment = { PATH: process.env.PATH, CI: 'true', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    HOME: join(owned, 'home'), TMPDIR: join(owned, 'tmp'), XDG_CONFIG_HOME: join(owned, 'config'),
    XDG_CACHE_HOME: join(owned, 'cache'), XDG_STATE_HOME: join(owned, 'state'), XDG_DATA_HOME: join(owned, 'data') }
  const facts = { source: plan.source, sourceTree: plan.sourceTree,
    checkoutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: original }).trim(),
    executedGo: null, fullSuiteExecuted: false, conformanceExecuted: false,
    testsRequested: plan.tests.length, commands: [], selections: [], cleanup: false }
  const raw = []
  const reports = []
  const artifacts = []
  let phase = 'setup'
  let failed = false
  const record = value => console.log('[selected-package] ' + JSON.stringify(value))
  const progress = setInterval(() => record({ stage: 'running', phase }), 15000)

  async function run(name, program, args, cwd, input) {
    phase = name
    record({ stage: 'command-start', name, program, args })
    const startedAt = new Date().toISOString()
    let stdout = ''
    let stderr = ''
    const exitCode = await new Promise((finish, reject) => {
      const child = spawn(program, args, { cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', text => { stdout += text })
      child.stderr.on('data', text => { stderr += text })
      child.once('error', reject)
      child.once('close', (code, signal) => finish(code ?? (signal ? 1 : 0)))
      child.stdin.end(input)
    })
    const result = { name, program, args, cwd, exitCode, stdout, stderr, startedAt, finishedAt: new Date().toISOString() }
    raw.push(result)
    facts.commands.push({ name, exitCode, startedAt, finishedAt: result.finishedAt })
    record({ stage: 'command-finish', name, exitCode })
    return result
  }

  async function required(name, program, args, cwd, input) {
    const command = await run(name, program, args, cwd, input)
    if (command.exitCode !== 0) throw new Error(name + ' failed: ' + command.stderr.slice(-4000))
    return command
  }

  async function sourceCheckout() {
    const source = join(owned, 'source')
    const pack = Buffer.from(plan.objectPack, 'base64')
    if (digest(pack) !== plan.objectPackSHA256) throw new Error('Genuine Git pack digest differs')
    await required('source-init', 'git', ['init', '--quiet', source], original)
    await required('source-objects', 'git', ['unpack-objects', '-q'], source, pack)
    await writeFile(join(source, '.git/HEAD'), plan.source + '\n')
    await required('source-sparse-init', 'git', ['sparse-checkout', 'init', '--no-cone'], source)
    await writeFile(join(source, '.git/info/sparse-checkout'), plan.sparsePaths.map(path => '/' + path).join('\n') + '\n')
    await required('source-checkout', 'git', ['read-tree', '-mu', 'HEAD'], source)
    await symlink(join(original, 'node_modules'), join(source, 'node_modules'), 'dir')
    await symlink(join(original, 'packages/contracts/node_modules'), join(source, 'packages/contracts/node_modules'), 'dir')
    const identity = await required('source-identity', 'git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], source)
    facts.sourceIdentity = identity.stdout.trim().split('\n')
    if (facts.sourceIdentity[0] !== plan.source || facts.sourceIdentity[1] !== plan.sourceTree) throw new Error('Source identity differs')
    return source
  }

  async function emitRequiredModules(source) {
    const packageRoot = join(source, 'packages/contracts')
    const require = createRequire(join(packageRoot, 'package.json'))
    const compilerFile = require.resolve('typescript/package.json')
    const compiler = JSON.parse(await readFile(compilerFile, 'utf8'))
    if (compiler.name !== '@typescript/typescript6' || compiler.version !== '6.0.2' || !compiler.bin.tsc6) throw new Error('Pinned TS6 compiler required')
    const config = JSON.parse(await readFile(join(packageRoot, 'tsconfig.json'), 'utf8'))
    const flags = Object.entries({ ...config.compilerOptions, noEmit: false, noCheck: true,
      rootDir: join(packageRoot, 'src'), outDir: join(packageRoot, 'dist') })
      .flatMap(([key, value]) => ['--' + key, Array.isArray(value) ? value.join(',') : String(value)])
    await required('required-dependency-emit-only', process.execPath,
      [join(dirname(compilerFile), compiler.bin.tsc6), '--ignoreConfig', ...flags,
        ...plan.compileRoots.map(path => join(source, path))], packageRoot)
    const output = join(packageRoot, 'dist')
    const files = (await readdir(output, { recursive: true })).filter(path => path.endsWith('.js')).sort()
    if (JSON.stringify(files) !== JSON.stringify(plan.qualifiedModules.map(file => file.path).sort())) throw new Error('Required output closure differs')
    const compiled = await Promise.all(files.map(async path => ({ path, sha256: digest(await readFile(join(output, path))) })))
    if (compiled.some(file => !plan.qualifiedModules.some(prior => prior.path === file.path && prior.sha256 === file.sha256))) {
      throw new Error('Required dependency emit differs from prior strict-qualified output')
    }
    facts.compilation = { compiler: { name: compiler.name, version: compiler.version, bin: compiler.bin },
      emitOnly: true, semanticTypecheckRepeated: false, priorStrictTicket: plan.priorStrictTicket, compiled }
  }

  async function selectedTests(source) {
    const reportPath = join(owned, 'schema.vitest.json')
    const pattern = '^(' + plan.tests.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$'
    const command = await run('schema-descriptor-selected-tests', process.execPath,
      ['--test', '--test-name-pattern=' + pattern, '--test-reporter=spec', '--test-reporter-destination=stdout',
        '--test-reporter=' + join(original, 'scripts/ci-node-test-reporter.mjs'),
        '--test-reporter-destination=' + reportPath, plan.testFile], source)
    const parsed = JSON.parse(await readFile(reportPath, 'utf8'))
    artifacts.push({ path: 'schema-selected-raw-report.json', bytes: Buffer.from(JSON.stringify(parsed)) })
    const tests = parsed.testResults.flatMap(file => file.assertionResults).filter(test => plan.tests.includes(test.fullName))
    facts.selections.push({ kind: 'schema-descriptor', requested: plan.tests, namedCount: tests.length,
      missing: plan.tests.filter(name => !tests.some(test => test.fullName === name)), tests, originalExitCode: command.exitCode })
    reports.push({ testResults: parsed.testResults.map(file => ({ ...file, name: join(original, plan.testFile),
      assertionResults: file.assertionResults.filter(test => plan.tests.includes(test.fullName)) })) })
    if (command.exitCode !== 0 || tests.length !== plan.tests.length || tests.some(test => test.status !== 'passed')) failed = true
  }

  async function descriptors(source) {
    const output = join(owned, 'auth-runtime-schemas.json')
    await required('four-auth-runtime-descriptors', process.execPath,
      plan.exportCommand.map(argument => argument === '<isolated-output>/auth-runtime-schemas.json' ? output : argument).slice(1), source)
    const bytes = await readFile(output)
    artifacts.push({ path: 'auth-runtime-schemas.json', bytes })
    const manifest = JSON.parse(bytes)
    const require = createRequire(join(source, 'packages/contracts/package.json'))
    const zodPackageFile = require.resolve('zod/package.json')
    const zodRoot = dirname(zodPackageFile)
    const localeSource = await readFile(join(zodRoot, 'src/v4/locales/en.ts'))
    const installed = await readFile(join(zodRoot, 'v4/locales/en.js'))
    const sourceBlob = blob(localeSource)
    if (sourceBlob !== '3836bd1651071082fb24488d4e3b3d29db851134') throw new Error('Actual pinned English locale source blob differs')
    artifacts.push({ path: 'zod-en-source.ts', bytes: localeSource }, { path: 'zod-en-installed.mjs', bytes: installed })
    if (manifest.schemas.length !== 4 || manifest.unsupported.length || manifest.coverage.exported.length !== 4 ||
        manifest.schemas.some(entry => !entry.input || !entry.output || !entry.runtime?.root ||
          entry.runtime.locale.sourceBlob !== sourceBlob || entry.runtime.locale.installedSHA256 !== digest(installed))) {
      throw new Error('Selected auth schema runtime descriptors or locale identity incomplete')
    }
    const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : null
    const ticket = process.env.FOREMAN_CODE_CI_HOST_RUN_ID || event?.inputs?.run_id ||
      /(?:^|\/)ci\/([a-f0-9-]{36})(?:$|\/)/.exec(process.env.CIRCLE_BRANCH || '')?.[1] ||
      (process.env.TEST_RESULTS_OUTPUT && basename(dirname(process.env.TEST_RESULTS_OUTPUT)))
    if (!ticket || !/^[a-f0-9-]{36}$/.test(ticket)) throw new Error('Actual Foreman CI execution ticket unavailable')
    const evidence = { schemaVersion: 1, ticket: { provider: 'foreman-ci', id: ticket },
      source: { commit: plan.source, tree: plan.sourceTree }, compilation: facts.compilation,
      commands: raw.filter(command => command.name === 'required-dependency-emit-only').map(command => [command.program, ...command.args]),
      runtime: { executable: process.execPath, versions: process.versions },
      locale: { sourceBlob, sourceSHA256: digest(localeSource), installedSHA256: digest(installed) } }
    artifacts.push({ path: 'descriptor-execution-evidence.json', bytes: Buffer.from(JSON.stringify(evidence, null, 2)) })
    facts.descriptors = { ticket, coverage: manifest.coverage, unsupported: manifest.unsupported, locale: evidence.locale }
  }

  async function observeConfig(source) {
    const output = join(owned, 'observation')
    await mkdir(output, { mode: 0o700 })
    const command = await run('public-zod-config-observation', process.execPath,
      [join(original, 'scripts/ci-observe-zod-config.mjs'), source, output], source)
    for (const path of ['zod-config-observation.json', 'zod-en-source.ts', 'zod-en-installed.mjs']) {
      try { artifacts.push({ path, bytes: await readFile(join(output, path)) }) }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        facts.missingObservationArtifacts = [...(facts.missingObservationArtifacts || []), path]
      }
    }
    if (command.exitCode !== 0) failed = true
    facts.observationExitCode = command.exitCode
  }

  try {
    if (process.getuid?.() === 0) throw new Error('Existing unprivileged CI user required')
    for (const path of Object.values(environment).filter(value => value.startsWith(owned))) await mkdir(path, { recursive: true, mode: 0o700 })
    const source = await sourceCheckout()
    await emitRequiredModules(source)
    if (plan.mode === 'observe-config') {
      await observeConfig(source)
    } else {
      for (const path of plan.analysisFiles) await required('syntax-' + path, process.execPath, ['--check', path], source)
      await selectedTests(source)
      await descriptors(source)
    }
  } catch (error) {
    failed = true
    facts.failure = error.stack || String(error)
  } finally {
    try {
      const normalized = ciTestResults(reports, original)
      if (process.env.TEST_RESULTS_OUTPUT) await writeFile(process.env.TEST_RESULTS_OUTPUT, JSON.stringify(normalized))
      facts.normalizedSummary = normalized.summary
      await rm(owned, { recursive: true, force: true })
      facts.cleanup = true
    } catch (error) {
      failed = true
      facts.cleanupFailure = error.stack || String(error)
    }
    clearInterval(progress)
    facts.failed = failed
    artifacts.unshift({ path: 'selected-package-reports.json', bytes: Buffer.from(JSON.stringify({ plan, facts, commands: raw, originalReports: reports })) })
    for (const artifact of artifacts) {
      const chunks = gzipSync(artifact.bytes).toString('base64').match(/.{1,12000}/g) || ['']
      console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'artifact', path: artifact.path, bytes: artifact.bytes.length,
        sha256: digest(artifact.bytes), chunks: chunks.length }))
      chunks.forEach((data, index) => console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'chunk', path: artifact.path, index, data })))
    }
    record({ stage: 'result', ...facts })
  }
  process.exitCode = failed ? 1 : 0
}
