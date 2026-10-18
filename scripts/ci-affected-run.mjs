import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, matchesGlob, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repositoryFileList, selectByIndexes } from './ci-files.mjs'
import { writeCiTestResults } from './ci-test-results.mjs'
import { contractsCompiler } from './ci-affected-contracts.mjs'
import { nativeSelectorBinding, readAffectedRequest, readSelectionFile, repositoryRoot, suiteKind, validateAffectedSuite } from './ci-affected-scope.mjs'
import { adoptNativeReports, expectNativeReports } from './ci-native-reports.mjs'

const projects = ['packages/contracts', 'apps/web', 'conformance']

/** Selected retained paths remain separate process arguments. Native checks use the suite lifecycle. */
export function affectedCommands(suite, files, root = repositoryRoot) {
  suiteKind(suite)
  if (!files.length) return []
  if (suite === 'integration') return files.map(file => {
    if (!/^apps\/api\/test\/[^/]+\.integration\.test\.ts$/.test(file)
      || nativeSelectorBinding(file, root)?.suite !== 'integration') {
      throw new Error(`Integration scope requires a committed native adapter binding: ${file}`)
    }
    return ['corepack', 'pnpm', '--dir', 'apps/api', 'exec', process.execPath, '--import', 'tsx', '--test', join(root, file)]
  })
  const groups = new Map()
  for (const file of files) {
    const project = projects.find(value => file.startsWith(`${value}/`))
    const scripts = file.startsWith('scripts/')
    if ((!project && !scripts) || !/\.[cm]?[jt]sx?$/.test(file) || file.includes('\\') || file.includes('\0')
      || file.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Unsupported affected file: ${file}`)
    }
    if (suite === 'unit' && (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || scripts && !/\.[cm]?js$/.test(file))) {
      throw new Error(`Unit scope requires supported unit test files: ${file}`)
    }
    if (suite === 'build') throw new Error('Retained bundle builds require explicit release scope; select typecheck or exact contracts exports.')
    const key = project ?? 'scripts'
    groups.set(key, [...groups.get(key) ?? [], file])
  }
  return [...groups].flatMap(([project, selected]) => projectCommands(suite, project, selected, root))
}

function typecheckCommands(project, files, root) {
  if (project === 'scripts') {
    const typed = files.filter(file => /\.[cm]?tsx?$/.test(file))
    const commands = files.filter(file => !typed.includes(file)).map(file => [process.execPath, '--check', file])
    if (typed.length) commands.push(['corepack', 'pnpm', '--dir', 'packages/contracts', 'exec', process.execPath,
      contractsCompiler(root), '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
      '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node', ...typed.map(file => join(root, file))])
    return commands
  }
  const node = ['--target', project === 'packages/contracts' ? 'ES2022' : 'ES2023',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node']
  const web = ['--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--jsx', 'react-jsx',
    '--lib', 'ES2022,DOM,DOM.Iterable', '--types', 'vite/client,vitest/globals,node', '--esModuleInterop',
    '--allowSyntheticDefaultImports', '--resolveJsonModule', '--isolatedModules', '--forceConsistentCasingInFileNames',
    '--useDefineForClassFields']
  const webConfig = ['--target', 'ES2023', '--lib', 'ES2023', '--module', 'ESNext', '--moduleResolution', 'Bundler',
    '--allowImportingTsExtensions', '--verbatimModuleSyntax', '--moduleDetection', 'force', '--types', 'node']
  const selected = project === 'apps/web' ? [files.filter(file => file.startsWith('apps/web/src/')),
    files.filter(file => !file.startsWith('apps/web/src/'))] : [files]
  return selected.filter(group => group.length).map(group => {
    const options = project === 'apps/web' ? group[0].startsWith('apps/web/src/') ? web : webConfig : node
    const flags = project === 'packages/contracts' ? ['--allowJs'] : project === 'conformance'
      ? ['--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes'] : []
    return ['corepack', 'pnpm', '--dir', project, 'exec', process.execPath, contractsCompiler(root),
      '--ignoreConfig', '--noEmit', '--strict', '--skipLibCheck', ...options, ...flags,
      ...group.map(file => file.slice(project.length + 1))]
  })
}

function projectCommands(suite, project, files, root) {
  if (suite === 'typecheck') return typecheckCommands(project, files, root)
  if (project === 'scripts') {
    if (suite === 'lint') return [[process.execPath, join(root, 'packages/contracts/node_modules/eslint/bin/eslint.js'),
      '--config', 'scripts/eslint.config.mjs', ...files, '--max-warnings', '0']]
    return files.map(file => [process.execPath, '--test', file])
  }
  const local = selected => selected.map(file => file.slice(project.length + 1))
  if (suite === 'lint') return [['corepack', 'pnpm', '--dir', project, 'exec', 'eslint', ...local(files), '--max-warnings', '0']]
  const vitest = selected => ['corepack', 'pnpm', '--dir', project, 'exec', 'vitest', 'run', ...local(selected)]
  if (project !== 'apps/web') return [vitest(files)]
  const heavy = JSON.parse(readFileSync(join(root, 'apps/web/heavy-tests.json'), 'utf8')).files
  const isHeavy = file => heavy.some(pattern => matchesGlob(file.slice(project.length + 1), pattern))
  return [['fast', files.filter(file => !isHeavy(file))], ['heavy', files.filter(isHeavy)]]
    .filter(([, selected]) => selected.length)
    .map(([phase, selected]) => ['env', `FOREMAN_WEB_TEST_PHASE=${phase}`, ...vitest(selected)])
}

function readInput(option, value, root) {
  if (option === '--files-from') {
    if (typeof value !== 'string' || !value) throw new Error('Pass a selection file after --files-from.')
    return readSelectionFile(value, root)
  }
  if (option === '--indexes') return readAffectedRequest(selectByIndexes(repositoryFileList(root), value ?? ''), root)
  throw new Error('Pass --files-from or --indexes for affected CI.')
}

export function readAffectedSelection(option, value, root = repositoryRoot) {
  return readInput(option, value, root).files
}

async function run(command, extraEnvironment = {}, onExit) {
  const environment = { ...process.env, CI: 'true' }
  for (const name of ['SCOPE', 'SELECTED_FILES', 'SLICE', 'CI_PARTITION', 'CI_SELECTION_COMMIT',
    'CI_DURATIONS', 'DEFAULT_BRANCH', 'CI_AFFECTED_SELECTION_FILE', 'FOREMAN_CODE_CI_RELEASE', 'NODE_TEST_CONTEXT',
    'TEST_RESULTS_OUTPUT', 'FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT', 'DURATIONS_OUTPUT',
    'FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT', 'CI_AFFECTED_VITEST_OUTPUT',
    'CI_NATIVE_REPORTS_DIR', 'CI_NATIVE_SELECTOR']) delete environment[name]
  const child = spawn(command[0], command.slice(1), { cwd: repositoryRoot, stdio: 'inherit',
    env: { ...environment, ...extraEnvironment } })
  return new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      onExit?.({ exitCode: code, signal })
      resolveExit(code ?? 1)
    })
  })
}

function reportedCommand(command, report) {
  if (!command.includes('--test')) return [...command, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`,
    `--reporter=${join(repositoryRoot, 'scripts/ci-progress-reporter.mjs')}`]
  return command.flatMap(argument => argument === '--test' ? [argument, '--test-reporter=spec',
    '--test-reporter-destination=stdout', `--test-reporter=${join(repositoryRoot, 'scripts/ci-node-test-reporter.mjs')}`,
    `--test-reporter-destination=${report}`] : [argument])
}

async function runReported(command, request, directory) {
  const argument = command.includes('--test') ? command.at(-1) : undefined
  const selector = argument && (isAbsolute(argument) ? relative(repositoryRoot, argument) : argument)
  const binding = request.nativeReports[selector]
  const nativeRoot = join(resolve(process.env.CI_STATE), 'go/native-reports')
  mkdirSync(binding ? nativeRoot : directory, { recursive: true })
  const session = binding ? mkdtempSync(join(nativeRoot, `${directory.split('/').at(-1)}-`)) : directory
  const report = join(session, 'wrapper.json')
  const environment = { CI_REPOSITORY_ROOT: repositoryRoot }
  if (binding) {
    await expectNativeReports({ directory: session, selector, ...binding })
    environment.CI_NATIVE_REPORTS_DIR = session
    environment.CI_NATIVE_SELECTOR = selector
    environment.CI_STATE = join(session, 'suite-state')
  }
  rmSync(report, { force: true })
  let termination, original, wrapperReadError
  const status = await run(reportedCommand(command, report), environment, outcome => { termination = outcome })
  writeFileSync(join(session, 'wrapper-status.json'), JSON.stringify({ selector, wrapperExit: status, termination }))
  try { original = JSON.parse(readFileSync(report, 'utf8')) }
  catch (error) {
    if (!binding) throw error
    wrapperReadError = error.message
  }
  const executed = value => value.testResults?.some(file => file.assertionResults?.some(test => ['passed', 'failed'].includes(test.status)))
  if (!binding) return { status, report, empty: !executed(original) }
  const adopted = await adoptNativeReports(original, { directory: session, repository: repositoryRoot, selector, wrapperExit: status })
  if (wrapperReadError) {
    adopted.failed = true
    adopted.diagnostics.unshift(`Cannot read the raw wrapper report: ${wrapperReadError}`)
  }
  const output = join(session, 'adopted.json')
  writeFileSync(output, JSON.stringify(adopted.report))
  writeFileSync(join(session, 'metadata.json'), JSON.stringify({ selector, wrapperExit: status,
    termination, wrapperReadError, failed: adopted.failed, diagnostics: adopted.diagnostics, nativeCounts: adopted.nativeCounts }))
  for (const diagnostic of adopted.diagnostics) console.error(diagnostic)
  return { status: status || Number(adopted.failed), report: output,
    empty: !executed(adopted.report) }
}

/** Runs inside ci-suite.sh's isolated runtime, after its exact prerequisites are ready. */
export async function executeAffected(suite, selection) {
  const request = validateAffectedSuite(suite, readSelectionFile(selection))
  const files = request.files.filter(file => !file.startsWith('backend/')
    && !(suite === 'integration' && file.startsWith('conformance/')))
  const commands = affectedCommands(suite, files)
  const output = resolve(process.env.TEST_RESULTS_OUTPUT || join(process.env.CI_STATE, 'affected-results.json'))
  mkdirSync(dirname(output), { recursive: true })
  const reports = []
  let code = 0, zeroTests = false
  for (const [index, command] of commands.entries()) {
    try {
      const result = ['unit', 'integration'].includes(suite)
        ? await runReported(command, request, join(resolve(process.env.CI_STATE), 'affected', String(index)))
        : { status: await run(command) }
      if (!code) code = result.status
      if (result.report) reports.push(result.report)
      zeroTests ||= result.empty === true
    } catch (error) {
      console.error(error.message)
      if (!code) code = 1
    }
  }
  if (['unit', 'integration'].includes(suite) && commands.length) {
    if (process.env.CI_AFFECTED_VITEST_OUTPUT) {
      const aggregate = { testResults: reports.flatMap(file => JSON.parse(readFileSync(file, 'utf8')).testResults) }
      mkdirSync(dirname(resolve(process.env.CI_AFFECTED_VITEST_OUTPUT)), { recursive: true })
      writeFileSync(process.env.CI_AFFECTED_VITEST_OUTPUT, JSON.stringify(aggregate))
    }
    if (!reports.length) throw new Error('The selected files produced no test reports.')
    writeCiTestResults(output, reports, repositoryRoot)
    const { summary, files: results } = JSON.parse(readFileSync(output, 'utf8'))
    if (zeroTests || summary.passed + summary.failed === 0) {
      throw new Error('The selected files executed zero tests.')
    }
    if (!code && summary.failed) code = 1
    if (process.env.DURATIONS_OUTPUT) {
      const durations = Object.fromEntries(results.filter(file => file.status === 'passed' && file.durationMs > 0)
        .map(file => [file.file, file.durationMs]))
      mkdirSync(dirname(resolve(process.env.DURATIONS_OUTPUT)), { recursive: true })
      writeFileSync(process.env.DURATIONS_OUTPUT, JSON.stringify(durations))
    }
  }
  return code
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [suite, option, value, ...extra] = process.argv.slice(2)
  if (extra.length) throw new Error('Unexpected arguments after the CI file selection.')
  const request = validateAffectedSuite(suite, readInput(option, value, repositoryRoot))
  const directory = mkdtempSync(join(tmpdir(), 'ci-affected-'))
  const selection = join(directory, 'selected.json')
  writeFileSync(selection, JSON.stringify(request), { mode: 0o600, flag: 'wx' })
  try {
    const environment = { ...process.env, CI: 'true', SUITE: suite, SCOPE: 'affected', CI_AFFECTED_SELECTION_FILE: selection }
    for (const name of ['SELECTED_FILES', 'SLICE', 'CI_PARTITION', 'CI_SELECTION_COMMIT']) delete environment[name]
    const child = spawn('bash', [join(repositoryRoot, 'scripts/ci-suite.sh'), 'affected', suite, selection],
      { cwd: repositoryRoot, stdio: 'inherit', env: environment })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', code => resolveExit(code ?? 1))
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
