import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, basename } from 'node:path'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { ciTestResults } from './ci-test-results.mjs'

if (process.env.CI !== 'true' && process.env.CI_HOST_RUNNER !== '1') {
  throw new Error('This diagnostic requires authenticated Foreman CI')
}
process.umask(0o077)
const original = await realpath(fileURLToPath(new URL('..', import.meta.url)))
const plan = JSON.parse(await readFile(join(original, 'scripts/ci-selected-package-plan.json'), 'utf8'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const cache = resolve(original, process.env.FOREMAN_CODE_CI_GO_CACHE || join(homedir(), '.cache/foreman-go'))

// The CI host invokes contracts build before the suite hook. Keep that required
// setup on the same two explicit roots instead of running the package build.
if (process.argv[2] === 'prepare-contracts') {
  const packageRoot = join(original, 'packages/contracts')
  const require = createRequire(join(packageRoot, 'package.json'))
  const compilerFile = require.resolve('typescript/package.json')
  const compiler = JSON.parse(await readFile(compilerFile, 'utf8'))
  if (compiler.name !== '@typescript/typescript6' || compiler.version !== '6.0.2' || !compiler.bin.tsc6) {
    throw new Error('The pinned TS6 compiler and bin.tsc6 are required')
  }
  const config = JSON.parse(await readFile(join(packageRoot, 'tsconfig.json'), 'utf8'))
  const flags = Object.entries({ ...config.compilerOptions, noEmit: false,
    rootDir: join(packageRoot, 'src'), outDir: join(packageRoot, 'dist') })
    .flatMap(([key, value]) => ['--' + key, Array.isArray(value) ? value.join(',') : String(value)])
  const args = [join(dirname(compilerFile), compiler.bin.tsc6), '--ignoreConfig', ...flags,
    ...plan.compileEntryPoints.map(path => join(original, path))]
  console.log('[contracts-setup] ' + JSON.stringify({ compiler: compiler.name, version: compiler.version,
    program: process.execPath, args, sourceRoots: plan.compileEntryPoints }))
  const child = spawn(process.execPath, args, { cwd: packageRoot, stdio: 'inherit' })
  child.once('error', error => { throw error })
  child.once('exit', code => { process.exitCode = code ?? 1 })
} else {
  await qualify()
}

async function qualify() {
  const parent = join(await realpath(homedir()), '.c')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const owned = await mkdtemp(join(parent, 'contracts-'))
  const environment = { PATH: process.env.PATH, CI: 'true', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    HOME: join(owned, 'home'), TMPDIR: join(owned, 'tmp'), XDG_CONFIG_HOME: join(owned, 'config'),
    XDG_CACHE_HOME: join(owned, 'cache'), XDG_STATE_HOME: join(owned, 'state'),
    XDG_DATA_HOME: join(owned, 'data'), CODEX_HOME: join(owned, 'codex'), CLAUDE_CONFIG_DIR: join(owned, 'claude') }
  const facts = { checkoutSha, source: plan.source, sourceTree: plan.sourceTree, sharedCache: cache,
    executedGo: null, fullSuiteExecuted: false, conformanceExecuted: false, commands: [], selections: [], cleanup: false }
  const raw = []
  const reports = []
  const artifacts = []
  let failed = false
  let phase = 'setup'
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
    const command = { name, program, args, cwd, exitCode, stdout, stderr, startedAt, finishedAt: new Date().toISOString() }
    raw.push(command)
    facts.commands.push({ name, exitCode, startedAt, finishedAt: command.finishedAt })
    record({ stage: 'command-finish', name, exitCode })
    return command
  }

  async function required(name, program, args, cwd, input) {
    const command = await run(name, program, args, cwd, input)
    if (command.exitCode !== 0) throw new Error(name + ' failed: ' + command.stderr.slice(-4000))
    return command
  }

  async function sourceCheckout(label, identity) {
    const destination = join(owned, label)
    const pack = Buffer.from(plan.objectPack, 'base64')
    if (digest(pack) !== plan.objectPackSHA256) throw new Error('Genuine Git object pack digest mismatch')
    await required(label + '-init', 'git', ['init', '--quiet', destination], original)
    await required(label + '-objects', 'git', ['unpack-objects', '-q'], destination, pack)
    await writeFile(join(destination, '.git/HEAD'), identity + '\n')
    await required(label + '-sparse-init', 'git', ['sparse-checkout', 'init', '--no-cone'], destination)
    await writeFile(join(destination, '.git/info/sparse-checkout'), plan.sparsePaths.map(path => '/' + path).join('\n') + '\n')
    await required(label + '-checkout', 'git', ['read-tree', '-mu', 'HEAD'], destination)
    await symlink(join(original, 'node_modules'), join(destination, 'node_modules'), 'dir')
    await symlink(join(original, 'packages/contracts/node_modules'), join(destination, 'packages/contracts/node_modules'), 'dir')
    const actual = await required(label + '-identity', 'git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], destination)
    facts[label] = { identity: actual.stdout.trim().split('\n'), sparsePaths: plan.sparsePaths }
    return destination
  }

  async function compile(label, source) {
    const packageRoot = join(source, 'packages/contracts')
    const require = createRequire(join(packageRoot, 'package.json'))
    const compilerFile = require.resolve('typescript/package.json')
    const compiler = JSON.parse(await readFile(compilerFile, 'utf8'))
    if (compiler.name !== '@typescript/typescript6' || compiler.version !== '6.0.2' || !compiler.bin.tsc6) {
      throw new Error('Expected pinned TS6 compiler and bin.tsc6')
    }
    const config = JSON.parse(await readFile(join(packageRoot, 'tsconfig.json'), 'utf8'))
    const flags = Object.entries({ ...config.compilerOptions, noEmit: false,
      rootDir: join(packageRoot, 'src'), outDir: join(packageRoot, 'dist') })
      .flatMap(([key, value]) => ['--' + key, Array.isArray(value) ? value.join(',') : String(value)])
    const args = [join(dirname(compilerFile), compiler.bin.tsc6), '--ignoreConfig', ...flags,
      ...plan.compileEntryPoints.map(path => join(source, path))]
    await required(label + '-strict-compile', process.execPath, args, packageRoot)
    const output = join(packageRoot, 'dist')
    const files = (await readdir(output, { recursive: true })).filter(file => file.endsWith('.js')).sort()
    const expected = label === 'frozen' ? plan.frozenOutputs : plan.candidateOutputs
    if (JSON.stringify(files) !== JSON.stringify([...expected].sort())) throw new Error('Unexpected compile output closure: ' + files)
    facts[label].compiler = { name: compiler.name, version: compiler.version, bin: compiler.bin, options: config.compilerOptions }
    facts[label].compiled = await Promise.all(files.map(async path => ({ path, sha256: digest(await readFile(join(output, path))) })))
    return output
  }

  async function tests(label, file, names, source) {
    const reportPath = join(owned, label + '.vitest.json')
    const pattern = '^(' + names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$'
    const command = await run(label, process.execPath, ['--test', '--test-name-pattern=' + pattern,
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=' + join(original, 'scripts/ci-node-test-reporter.mjs'),
      '--test-reporter-destination=' + reportPath, file], source)
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    artifacts.push({ path: label + '-raw-report.json', bytes: Buffer.from(JSON.stringify(report)) })
    const outcomes = report.testResults.flatMap(result => result.assertionResults)
    const selected = outcomes.filter(result => names.includes(result.fullName))
    facts.selections.push({ kind: label, requested: names, originalExitCode: command.exitCode,
      missing: names.filter(name => !selected.some(test => test.fullName === name)),
      notSelected: outcomes.filter(test => !names.includes(test.fullName)).map(test => ({ name: test.fullName, status: test.status })),
      tests: selected, namedCount: selected.length })
    reports.push({ testResults: report.testResults.map(result => ({ ...result, name: join(original, file),
      assertionResults: result.assertionResults.filter(test => names.includes(test.fullName)) })) })
    if (command.exitCode !== 0 || selected.length !== names.length || selected.some(test => test.status !== 'passed')) failed = true
  }

  try {
    if (process.getuid?.() === 0) throw new Error('An existing unprivileged CI user is required')
    for (const path of Object.values(environment).filter(value => value.startsWith(owned))) await mkdir(path, { recursive: true, mode: 0o700 })
    const frozen = await sourceCheckout('frozen', plan.frozen)
    const candidate = await sourceCheckout('candidate', plan.source)
    const frozenCompiled = await compile('frozen', frozen)
    const candidateCompiled = await compile('candidate', candidate)
    environment.AUTH_VECTOR_FROZEN_ROOT = frozen
    environment.AUTH_VECTOR_FROZEN_COMPILED_DIR = frozenCompiled
    environment.AUTH_VECTOR_CANDIDATE_COMPILED_DIR = candidateCompiled
    await tests('auth-cli', 'scripts/go-contracts/auth-vectors.test.mjs', plan.authTests, candidate)
    await tests('schema-export', 'scripts/go-contracts/export-schemas.test.mjs', plan.exportTests, candidate)
    if (plan.capture) {
      const outputPath = process.env.TEST_RESULTS_OUTPUT
      const event = process.env.GITHUB_EVENT_PATH
        ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) : null
      const hostTicket = outputPath && basename(dirname(outputPath))
      const branchTicket = /(?:^|\/)ci\/([a-f0-9-]{36})(?:$|\/)/.exec(process.env.CIRCLE_BRANCH || '')?.[1]
      const ticketId = process.env.FOREMAN_CODE_CI_HOST_RUN_ID || event?.inputs?.run_id || branchTicket || hostTicket
      if (!ticketId || !/^[a-f0-9-]{36}$/.test(ticketId)) throw new Error('Actual Foreman CI ticket id unavailable from host metadata')
      const compilation = { schemaVersion: 1, ticket: { provider: 'foreman-ci', id: ticketId,
        scenario: 'contracts.auth.compile.frozen-candidate' },
        source: { reference: plan.frozen, frozenTree: facts.frozen.identity[1], candidate: plan.source, tree: plan.sourceTree },
        commands: raw.filter(command => command.name.endsWith('-strict-compile')).map(command => [command.program, ...command.args]),
        runtime: { executable: process.execPath, versions: process.versions },
        compiled: { frozen: facts.frozen.compiled, candidate: facts.candidate.compiled } }
      facts.provider = { githubRunId: process.env.GITHUB_RUN_ID || null,
        githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT || null, circleWorkflowId: process.env.CIRCLE_WORKFLOW_ID || null }
      const evidence = join(owned, 'compilation-evidence.json')
      await writeFile(evidence, JSON.stringify(compilation, null, 2))
      environment.AUTH_CONTRACT_COMPILATION_EVIDENCE_FILE = evidence
      const authOutput = join(owned, 'auth-vectors.json')
      await required('auth-47-outcome-capture', process.execPath, ['scripts/go-contracts/auth-vectors.mjs', frozen,
        frozenCompiled, candidateCompiled, plan.source, plan.sourceTree, authOutput], candidate)
      const authBytes = await readFile(authOutput)
      const auth = JSON.parse(authBytes)
      if (auth.vectors.length !== 47 || auth.vectors.filter(vector => vector.goApplicable).length !== 45 ||
          auth.mismatches.length || auth.thrown.length || auth.failures.length) throw new Error('Auth capture did not qualify all 47 projected outcomes')
      artifacts.push({ path: 'auth-vectors.json', bytes: authBytes }, { path: 'compilation-evidence.json', bytes: await readFile(evidence) })
      facts.authCapture = { outcomes: auth.vectors.length, jsonBacked: 45, compilationTicket: ticketId,
        mismatches: auth.mismatches, thrown: auth.thrown, failures: auth.failures }
      const schemaOutput = join(owned, 'auth-schemas.json')
      const mappings = plan.moduleMappings.flatMap(value => ['--module', value])
      const selection = plan.selectedRoots.flatMap(value => ['--select', value])
      await required('auth-four-schema-export', process.execPath, ['scripts/go-contracts/export-schemas.mjs',
        ...mappings, ...selection, '--output', schemaOutput], candidate)
      const schemaBytes = await readFile(schemaOutput)
      const schema = JSON.parse(schemaBytes)
      if (schema.schemas.length !== 4 || schema.unsupported.length ||
          schema.schemas.some(entry => !entry.input || !entry.output)) throw new Error('Four input/output schema definitions were not exported')
      artifacts.push({ path: 'auth-schemas.json', bytes: schemaBytes })
      facts.schemaExport = { coverage: schema.coverage, unsupported: schema.unsupported }
    }
  } catch (error) {
    failed = true
    facts.failure = error.stack || String(error)
  } finally {
    try {
      const normalized = ciTestResults(reports, original)
      const output = process.env.TEST_RESULTS_OUTPUT
      if (output) await writeFile(output, JSON.stringify(normalized))
      facts.normalizedSummary = normalized.summary
      await rm(owned, { recursive: true, force: true })
      facts.cleanup = true
    } catch (error) {
      failed = true
      facts.cleanupFailure = error.stack || String(error)
    }
    clearInterval(progress)
    facts.failed = failed
    artifacts.unshift({ path: 'selected-package-reports.json', bytes: Buffer.from(JSON.stringify({ plan,
      facts, commands: raw, originalReports: reports })) })
    for (const artifact of artifacts) {
      const encoded = gzipSync(artifact.bytes).toString('base64')
      const chunks = encoded.match(/.{1,12000}/g) || ['']
      console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'artifact', path: artifact.path,
        bytes: artifact.bytes.length, sha256: digest(artifact.bytes), chunks: chunks.length }))
      chunks.forEach((data, index) => console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'chunk', path: artifact.path, index, data })))
    }
    record({ stage: 'result', ...facts })
  }
  process.exitCode = failed ? 1 : 0
}
