import { spawn } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, matchesGlob, posix, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryFileList, selectByIndexes } from './ci-files.mjs'
import { writeCiTestResults } from './ci-test-results.mjs'

if (process.argv[2] === 'unit' && process.argv[3] === '--files-from') {
  const selected = readAffectedSelection(process.argv[3], process.argv[4])
  if (selected.length === 1 && selected[0] === 'scripts/ci-schema-regressions.test.mjs') {
    await import('./ci-schema-host.mjs')
    process.exit(process.exitCode ?? 0)
  }
}

const projects = ['packages/contracts', 'apps/web', 'conformance']

/** Selected paths remain separate process arguments. */
export function affectedCommands(suite, files) {
  if (!['typecheck', 'lint', 'unit', 'integration', 'build'].includes(suite)) {
    throw new Error(`Unsupported affected suite: ${suite}`)
  }
  if (!files.length) return []
  if (!['unit', 'lint'].includes(suite)) throw new Error(`Unsupported affected suite: ${suite}`)
  const groups = new Map()
  for (const file of files) {
    const project = projects.find(value => file.startsWith(`${value}/`))
    const scripts = file.startsWith('scripts/')
    if ((!project && !scripts) || posix.normalize(file) !== file || file.includes('\\')
      || file.includes('\0') || file.split('/').includes('..')) {
      throw new Error(`Unsupported affected file: ${file}`)
    }
    if (suite === 'unit' && (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
      || (scripts && !/\.[cm]?js$/.test(file)))) {
      throw new Error(`Unit scope requires supported unit test files: ${file}`)
    }
    if (suite === 'lint' && (scripts || !/\.[cm]?[jt]sx?$/.test(file))) {
      throw new Error(`Unsupported affected lint file: ${file}`)
    }
    const key = project ?? 'scripts'
    groups.set(key, [...groups.get(key) ?? [], file])
  }
  return [...groups].flatMap(([project, selected]) => projectCommands(suite, project, selected))
}

function projectCommands(suite, project, files) {
  if (project === 'scripts') return [[process.execPath, '--test', ...files]]
  const local = selected => selected.map(file => file.slice(project.length + 1))
  if (suite === 'lint') {
    return [['corepack', 'pnpm', '--dir', project, 'exec', 'eslint', ...local(files), '--max-warnings', '0']]
  }
  const vitest = selected => ['corepack', 'pnpm', '--dir', project, 'exec', 'vitest', 'run', ...local(selected)]
  if (project !== 'apps/web') return [vitest(files)]
  const heavy = JSON.parse(readFileSync(resolve('apps/web/heavy-tests.json'), 'utf8')).files
  const isHeavy = file => heavy.some(pattern => matchesGlob(file.slice(project.length + 1), pattern))
  return [['fast', files.filter(file => !isHeavy(file))], ['heavy', files.filter(isHeavy)]]
    .filter(([, selected]) => selected.length)
    .map(([phase, selected]) => ['env', `FOREMAN_WEB_TEST_PHASE=${phase}`, ...vitest(selected)])
}

/** Validate every selected path before launching any check. */
export function readAffectedSelection(option, value, cwd = process.cwd()) {
  let files
  if (option === '--files-from') {
    if (typeof value !== 'string' || !value) throw new Error('Pass a selection file after --files-from.')
    files = JSON.parse(readFileSync(resolve(cwd, value), 'utf8'))
  } else if (option === '--indexes') {
    if (value !== undefined && typeof value !== 'string') throw new Error('CI file indexes must be a string.')
    files = selectByIndexes(repositoryFileList(cwd), value ?? '')
  } else throw new Error('Pass --files-from or --indexes for affected CI.')
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string')) {
    throw new Error('CI selection must contain existing repository files.')
  }
  for (const file of files) {
    if (!file || file.includes('\0') || file.includes('\\') || posix.isAbsolute(file) || win32.isAbsolute(file)
      || posix.normalize(file) !== file || file.split('/').includes('..')) {
      throw new Error(`Invalid CI file: ${file}`)
    }
  }
  const missing = files.filter(file => !lstatSync(resolve(cwd, file), { throwIfNoEntry: false })?.isFile())
  if (missing.length) throw new Error(`CI selection must contain existing repository files: ${missing.join(', ')}`)
  return files
}

async function run(command) {
  const environment = { ...process.env, CI: 'true' }
  for (const name of ['SCOPE', 'SELECTED_FILES', 'SLICE', 'CI_PARTITION', 'CI_SELECTION_COMMIT',
    'CI_DURATIONS', 'DEFAULT_BRANCH', 'TEST_RESULTS_OUTPUT']) delete environment[name]
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: environment })
  return new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolveExit(code ?? 1))
  })
}

function reportedCommand(command, report) {
  if (!command.includes('--test')) {
    return [...command, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`,
      `--reporter=${resolve('scripts/ci-progress-reporter.mjs')}`]
  }
  return command.flatMap(argument => argument === '--test' ? [argument,
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${resolve('scripts/ci-node-test-reporter.mjs')}`,
    `--test-reporter-destination=${report}`] : [argument])
}

/** Runs inside ci-suite.sh's isolated runtime, after its prerequisites are ready. */
export async function executeAffected(suite, selection) {
  const files = readAffectedSelection('--files-from', selection)
  const commands = affectedCommands(suite, files)
  const output = process.env.TEST_RESULTS_OUTPUT || resolve(process.env.CI_STATE, 'affected-results.json')
  const reports = []
  let code = 0
  let zeroTests = false
  for (const command of commands) {
    const report = suite === 'unit' ? `${output}.${reports.length}.report.json` : null
    if (report) reports.push(report)
    const result = await run(report ? reportedCommand(command, report) : command)
    if (code === 0) code = result
    if (report && result === 0) {
      const data = JSON.parse(readFileSync(report, 'utf8'))
      if (!data.testResults.some(file => file.assertionResults?.length)) zeroTests = true
    }
  }
  if (reports.length) {
    try {
      writeCiTestResults(output, reports, process.cwd())
      const { summary, files: results } = JSON.parse(readFileSync(output, 'utf8'))
      if (zeroTests || summary.passed + summary.failed + summary.skipped === 0) {
        throw new Error('The selected unit files executed zero tests.')
      }
      if (process.env.DURATIONS_OUTPUT) {
        const durations = Object.fromEntries(results.filter(file => file.status === 'passed' && file.durationMs > 0)
          .map(file => [file.file, file.durationMs]))
        writeFileSync(process.env.DURATIONS_OUTPUT, JSON.stringify(durations))
      }
    } finally {
      for (const report of reports) rmSync(report, { force: true })
    }
  }
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [suite, option, value, ...extra] = process.argv.slice(2)
  if (extra.length) throw new Error('Unexpected arguments after the CI file selection.')
  const files = readAffectedSelection(option, value)
  const commands = affectedCommands(suite, files)
  if (!commands.length) {
    console.log('No affected files for this suite.')
  } else {
    const directory = mkdtempSync(join(tmpdir(), 'ci-affected-'))
    const selection = join(directory, 'selected.json')
    writeFileSync(selection, JSON.stringify(files), { mode: 0o600, flag: 'wx' })
    try {
      const environment = { ...process.env, CI: 'true', SUITE: `${suite}-other`, SCOPE: 'affected' }
      for (const name of ['SELECTED_FILES', 'SLICE', 'CI_PARTITION', 'CI_SELECTION_COMMIT']) delete environment[name]
      const child = spawn('bash', ['scripts/ci-suite.sh', 'affected', suite, selection,
        files.some(file => file.startsWith('scripts/')) ? 'scripts' : 'retained'], { stdio: 'inherit', env: environment })
      process.exitCode = await new Promise((resolveExit, reject) => {
        child.once('error', reject)
        child.once('exit', code => resolveExit(code ?? 1))
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}
