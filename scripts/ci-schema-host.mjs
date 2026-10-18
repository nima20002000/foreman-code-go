import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { ciTestResults } from './ci-test-results.mjs'
import { prepareSource, installAndCompile } from './ci-schema-host-setup.mjs'

if (process.env.CI !== 'true' || process.env.CI_HOST_RUNNER !== '1'
  || process.env.GITHUB_ACTIONS || process.env.CIRCLECI) throw new Error('Private Foreman CI host required')
process.umask(0o077)
const checkout = await realpath(fileURLToPath(new URL('..', import.meta.url)))
if (process.argv[2] === 'prepare-contracts') {
  console.log('[schema-host] Contracts emit is isolated within the selected schema qualification')
} else {
  await qualify()
}

async function qualify() {
  const plan = JSON.parse(await readFile(join(checkout, 'scripts/ci-schema-host-plan.json'), 'utf8'))
  const originalHome = await realpath(homedir())
  const parent = join(originalHome, '.c')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(await realpath(parent), 'schema-host-'))
  const normalEnvironment = { ...process.env, HOME: originalHome, GIT_TERMINAL_PROMPT: '0' }
  const environment = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'), XDG_DATA_HOME: join(root, 'data'),
    COREPACK_HOME: join(root, 'corepack'), PNPM_HOME: join(root, 'pnpm'),
    CI: 'true', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' }
  const identity = execFileSync('git', ['rev-parse', 'HEAD', 'HEAD^{tree}'], { cwd: checkout, encoding: 'utf8' })
    .trim().split('\n')
  const facts = { checkout: { commit: identity[0], tree: identity[1] }, selector: plan.selector,
    requested: plan.tests, commands: [], cleanup: false, sourceWorktreeCreated: false,
    setupCompleted: false, fullSuiteExecuted: false, goExecuted: false, databaseStarted: false }
  const raw = []
  const artifacts = []
  const reports = []
  let phase = 'setup'
  let failed = false
  const record = value => console.log('[schema-host] ' + JSON.stringify(value))
  const progress = setInterval(() => record({ stage: 'running', phase }), 15000)
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

  async function run(name, program, args, cwd = checkout, env = environment) {
    phase = name
    record({ stage: 'command-start', name, program, args })
    const command = { name, program, args, cwd, startedAt: new Date().toISOString(), stdout: '', stderr: '' }
    raw.push(command)
    command.exitCode = await new Promise((finish, reject) => {
      const child = spawn(program, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', text => { command.stdout += text })
      child.stderr.on('data', text => { command.stderr += text })
      child.once('error', reject)
      child.once('close', (code, signal) => finish(code ?? (signal ? 1 : 0)))
    })
    command.finishedAt = new Date().toISOString()
    facts.commands.push({ name, exitCode: command.exitCode, startedAt: command.startedAt, finishedAt: command.finishedAt })
    record({ stage: 'command-finish', name, exitCode: command.exitCode })
    return command
  }

  async function required(...args) {
    const command = await run(...args)
    if (command.exitCode !== 0) throw new Error(command.name + ' failed: ' + command.stderr.slice(-4000))
    return command
  }

  try {
    if (process.getuid?.() === 0) throw new Error('An existing unprivileged CI user is required')
    for (const path of Object.values(environment).filter(value => value.startsWith(root))) {
      await mkdir(path, { recursive: true, mode: 0o700 })
    }
    const context = { checkout, root, plan, required, normalEnvironment, environment, facts, sha256 }
    const source = await prepareSource(context)
    await installAndCompile(context, source)
    const clean = await required('protected-source-clean', 'git', ['status', '--porcelain', '--untracked-files=normal',
      '--', 'packages/contracts/src', 'packages/contracts/package.json', 'scripts/go-contracts'], source)
    if (clean.stdout.trim()) throw new Error('Protected source changed during setup')
    facts.setupCompleted = true
    const reportPath = join(root, 'schema-four-report.json')
    const pattern = '^schema-export\\.execution-(default|custom)-memoizer-(before|after)-binding$'
    const command = await run('schema-four', process.execPath, ['--test', '--test-name-pattern=' + pattern,
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=' + join(checkout, 'scripts/ci-node-test-reporter.mjs'),
      '--test-reporter-destination=' + reportPath, plan.testFile], source)
    const reportBytes = await readFile(reportPath)
    const report = JSON.parse(reportBytes)
    artifacts.push({ path: 'schema-four-raw-report.json', bytes: reportBytes })
    const outcomes = report.testResults.flatMap(file => file.assertionResults)
    const selected = outcomes.filter(test => plan.tests.includes(test.fullName))
    facts.selection = { originalExitCode: command.exitCode, namedCount: selected.length, tests: selected,
      missing: plan.tests.filter(name => !selected.some(test => test.fullName === name)),
      unexpected: outcomes.filter(test => !plan.tests.includes(test.fullName)) }
    reports.push({ testResults: report.testResults.map(file => ({ ...file, name: join(checkout, plan.selector) })) })
    const complete = selected.length === plan.tests.length && !facts.selection.missing.length
      && !facts.selection.unexpected.length && selected.every(test => ['passed', 'failed'].includes(test.status))
    facts.selection.complete = complete
    failed = command.exitCode !== 0 || !complete || selected.some(test => test.status !== 'passed')
  } catch (error) {
    failed = true
    facts.failure = error.stack || String(error)
    facts.failureStage = facts.setupCompleted ? 'test-or-report' : 'setup'
  } finally {
    try {
      if (facts.sourceWorktreeCreated) {
        await required('private-source-worktree-remove', 'git', ['worktree', 'remove', '--force', join(root, 'source')],
          join(root, 'repository'), normalEnvironment)
        const remaining = await required('private-source-worktree-readback', 'git', ['worktree', 'list', '--porcelain'],
          join(root, 'repository'), normalEnvironment)
        if (remaining.stdout.split('\n').includes('worktree ' + join(root, 'source'))) {
          throw new Error('Owned source worktree record remains')
        }
      }
      await rm(root, { recursive: true, force: true })
      facts.cleanup = true
    } catch (error) {
      failed = true
      facts.cleanupFailure = error.stack || String(error)
    }
    clearInterval(progress)
    const normalized = ciTestResults(reports, checkout)
    const output = process.env.TEST_RESULTS_OUTPUT
    if (output) {
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, JSON.stringify(normalized))
    }
    facts.normalizedSummary = normalized.summary
    facts.failed = failed
    artifacts.unshift({ path: 'schema-host-report.json', bytes: Buffer.from(JSON.stringify({ plan, facts, commands: raw })) })
    for (const artifact of artifacts) {
      const chunks = gzipSync(artifact.bytes).toString('base64').match(/.{1,12000}/g) || ['']
      console.log('FOREMAN_CAPTURE ' + JSON.stringify({ kind: 'artifact', path: artifact.path,
        bytes: artifact.bytes.length, sha256: sha256(artifact.bytes), chunks: chunks.length }))
      chunks.forEach((data, index) => console.log('FOREMAN_CAPTURE ' + JSON.stringify({
        kind: 'chunk', path: artifact.path, index, data })))
    }
    record({ stage: 'result', ...facts })
  }
  process.exitCode = failed ? 1 : 0
}
