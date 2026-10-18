// Throwaway terminal-CI probe support. This file never belongs in the production checkpoint.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeSelectorBinding, readSelectionFile, suiteKind, validateAffectedSuite } from '../../ci-affected-scope.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const frozenReference = '8d2ea76c5028ef4458bf8cd64ef8624422e71d9f'
const sourceBase = '172326db82a5a792f970bf6d2f858e6dd17bf8f5'
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
const input = path => {
  const bytes = readFileSync(join(root, path))
  return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function command(program, args, env, prefix) {
  const child = spawn(program, args, { cwd: root, env, stdio: prefix ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
  let stdout = '', stderr = ''
  if (prefix) {
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value })
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
  }
  const result = await new Promise(resolveResult => {
    child.once('error', error => resolveResult({ exitCode: 1, error: error.message }))
    child.once('exit', (code, signal) => resolveResult({ exitCode: code ?? 1, signal }))
  })
  if (prefix) {
    writeFileSync(`${prefix}.stdout.log`, stdout, { mode: 0o600 })
    writeFileSync(`${prefix}.stderr.log`, stderr, { mode: 0o600 })
  }
  return { ...result, stdout, stderr }
}

function ownedDirectory(path, expected) {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700
    || realpathSync(path) !== expected) throw new Error('The probe no longer owns its canonical private directory.')
}

async function cleanOwnedCache(job, cache, pins, environment, evidence) {
  ownedDirectory(job, job)
  ownedDirectory(cache, join(job, 'go-cache'))
  const home = join(job, 'cleanup-home')
  mkdirSync(home, { mode: 0o700 })
  ownedDirectory(home, home)
  const goroot = join(cache, 'toolchains', `go${pins.go.version}`)
  const go = join(goroot, 'bin/go')
  const env = { ...environment, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'), TMPDIR: join(home, 'tmp'), GOTMPDIR: join(home, 'tmp'),
    GOROOT: goroot, GOPATH: join(cache, 'gopath'), GOCACHE: join(cache, 'build'), GOMODCACHE: join(cache, 'modules'),
    GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly' }
  for (const path of [env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TMPDIR]) mkdirSync(path, { mode: 0o700 })
  const versions = {}
  if (existsSync(go)) {
    versions.version = await command(go, ['version'], env, join(evidence, 'go-version'))
    versions.goversion = await command(go, ['env', 'GOVERSION'], env, join(evidence, 'go-goversion'))
  }
  let cleanup = { exitCode: 0, reason: 'No owned module cache was created.' }
  if (existsSync(env.GOMODCACHE)) {
    if (!existsSync(go)) throw new Error('Owned module cache remains but its stock pinned cleanup tool is unavailable.')
    const modules = lstatSync(env.GOMODCACHE)
    if (realpathSync(env.GOMODCACHE) !== join(cache, 'modules') || !modules.isDirectory()
      || modules.isSymbolicLink() || modules.uid !== process.getuid()) {
      throw new Error('The owned module cache binding changed; cleanup was refused.')
    }
    cleanup = await command(go, ['clean', '-modcache'], env, join(evidence, 'go-clean-modcache'))
    if (cleanup.exitCode !== 0) throw new Error('Scoped cleanup of the fresh owned module cache failed.')
  }
  ownedDirectory(job, job)
  ownedDirectory(cache, join(job, 'go-cache'))
  rmSync(job, { recursive: true })
  const versionCaptureExit = Object.values(versions).some(result => result.exitCode !== 0) ? 1 : 0
  return { cleanup, versions, versionCaptureExit, removedOwnedJob: true }
}

/** The real selected adapter executes the exact committed plan; every native failure remains a process failure. */
export async function runNativeProbe(moduleUrl, variant) {
  const selector = relative(root, fileURLToPath(moduleUrl)).replaceAll('\\', '/')
  const binding = nativeSelectorBinding(selector, root)
  if (!binding || process.env.CI_NATIVE_SELECTOR !== selector || !process.env.CI_NATIVE_REPORTS_DIR) {
    throw new Error('This native probe must run through its real selected adapter and committed CI binding.')
  }
  return executeProbe(selector, variant, binding, resolve(process.env.CI_NATIVE_REPORTS_DIR), true)
}

/** Non-test Go actions remain ordinary JS assertions; no native case publication is requested. */
export async function runActionProbe(moduleUrl, suite, selection) {
  const selector = relative(root, fileURLToPath(moduleUrl)).replaceAll('\\', '/')
  if (!['typecheck', 'lint'].includes(suiteKind(suite)) || process.env.CI_NATIVE_REPORTS_DIR || process.env.CI_NATIVE_SELECTOR
    || !process.env.CI_STATE) throw new Error('An action probe requires its ordinary selected JS executor and bounded check suite.')
  const request = validateAffectedSuite(suite, readSelectionFile(selection, root), root)
  const directory = join(resolve(process.env.CI_STATE), 'go/action-probes')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return executeProbe(selector, suite, { suite, selection, request, requiredKinds: [] }, directory, false)
}

async function executeProbe(selector, variant, binding, session, native) {
  process.umask(0o077)
  const pins = JSON.parse(readFileSync(join(root, 'scripts/ci-go-versions.json'), 'utf8'))
  const fixtureGoSourceFiles = binding.request.files.some(path => path.startsWith('backend/ciprobe/'))
    ? ['backend/ciprobe/roundtrip.go', 'backend/ciprobe/roundtrip_test.go'] : []
  const inputFiles = [selector, binding.selection, 'scripts/fixtures/go-ci-acceptance/run-native.mjs',
    'backend/go.mod', 'backend/go.sum', ...new Set([...binding.request.files, ...fixtureGoSourceFiles])].map(input)
  const evidence = mkdtempSync(join(session, 'probe-evidence-'))
  const state = join(evidence, 'state')
  mkdirSync(state, { mode: 0o700 })
  const job = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'qci-native-probe-')))
  const cache = join(job, 'go-cache')
  try { mkdirSync(cache, { mode: 0o700 }) }
  catch (error) { ownedDirectory(job, job); rmSync(job, { recursive: true }); throw error }
  const environment = { ...process.env, CI: 'true', SCOPE: 'affected', CI_STATE: state,
    CI_AFFECTED_SELECTION_FILE: join(root, binding.selection), FOREMAN_CODE_CI_GO_CACHE: cache,
    TEST_RESULTS_OUTPUT: join(evidence, 'inner-results.json'), DURATIONS_OUTPUT: join(evidence, 'inner-durations.json') }
  for (const name of ['NODE_TEST_CONTEXT', 'SELECTED_FILES', 'SLICE', 'CI_PARTITION', 'CI_SELECTION_COMMIT',
    'FOREMAN_CODE_CI_RELEASE', 'FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT', 'FOREMAN_CODE_INTEGRATION_DURATIONS_OUTPUT',
    'CI_AFFECTED_VITEST_OUTPUT', 'CONFORMANCE_COMMIT_SHA']) delete environment[name]
  const provenance = { status: 'STARTED', variant, sourceBase, frozenReference, selector,
    executionClass: native ? 'native test adapter' : 'ordinary JS action assertion; no Go test cases requested',
    outerSuite: process.env.SUITE ?? null, innerSuite: binding.suite, selection: binding.selection,
    requestedGoRoots: binding.request.goTestRoots, requestedConformanceScenarios: binding.request.conformanceScenarios,
    conformanceTsRequired: binding.request.conformanceTsRequired, requiredNativeKinds: binding.requiredKinds,
    runtimeEntries: binding.request.conformanceScenarios.length ? {
      go: 'backend/cmd/foreman', ts: binding.request.conformanceTsRequired ? 'apps/api/src/server.ts' : null,
      checkout: 'actualCheckout below; frozenReference is provenance only',
    } : null,
    inputFiles, fixtureGoSourceFiles,
    cacheOwnership: { job, cache, existingProviderCache: process.env.FOREMAN_CODE_CI_GO_CACHE ?? null },
    providerRunId: process.env.GITHUB_RUN_ID ?? null,
    logicalRunIdSource: process.env.GITHUB_EVENT_PATH ? 'GITHUB_EVENT_PATH.inputs.run_id' : 'terminal ticket receipt',
    nativeCounts: null, note: native
      ? 'Requested roots are not execution counts. Read raw Go/QCONF reports and the native publication.'
      : 'The ordinary JS wrapper records check action success or failure. No Go test cases are requested or counted.' }
  let affectedActionExit = 1, cleanupExit = 0, versionCaptureExit = 0
  try {
    const checkout = await command('git', ['rev-parse', 'HEAD'], environment, join(evidence, 'actual-checkout'))
    const tree = await command('git', ['rev-parse', 'HEAD^{tree}'], environment, join(evidence, 'actual-checkout-tree'))
    provenance.actualCheckout = { commit: checkout.stdout.trim(), tree: tree.stdout.trim(),
      commitExit: checkout.exitCode, treeExit: tree.exitCode }
    if (checkout.exitCode !== 0 || tree.exitCode !== 0) throw new Error('Actual checkout provenance was unavailable before the native action.')
    write(join(evidence, 'provenance.json'), provenance)
    const result = await command(process.execPath, [join(root, 'scripts/ci-affected-run.mjs'), binding.suite,
      '--files-from', join(root, binding.selection)], environment)
    affectedActionExit = result.exitCode
    provenance.affectedAction = { exitCode: affectedActionExit, signal: result.signal ?? null, error: result.error ?? null,
      meaning: 'Complete affected action including preparation, real native command, converter and gate; not raw Go exit.' }
  } catch (error) {
    provenance.adapterError = error.message
    process.stderr.write(`${error.message}\n`)
  } finally {
    try {
      provenance.cleanup = await cleanOwnedCache(job, cache, pins, environment, evidence)
      versionCaptureExit = provenance.cleanup.versionCaptureExit
    }
    catch (error) {
      cleanupExit = 1
      provenance.cleanup = { exitCode: 1, error: error.message, preservedOwnedJob: job }
      process.stderr.write(`${error.message}\n`)
    }
    provenance.status = 'FINISHED'
    provenance.affectedActionExit = affectedActionExit
    provenance.cleanupExit = cleanupExit
    provenance.versionCaptureExit = versionCaptureExit
    provenance.adapterExit = affectedActionExit || cleanupExit || versionCaptureExit
    write(join(evidence, 'provenance.json'), provenance)
  }
  return affectedActionExit || cleanupExit || versionCaptureExit
}
