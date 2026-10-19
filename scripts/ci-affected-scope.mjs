import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { integrationFileList, repositoryFileList, selectByIndexes } from './ci-files.mjs'

export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const kinds = ['typecheck', 'lint', 'unit', 'integration', 'build']
const requestKeys = ['files', 'goTestRoots', 'goRace', 'nativePrerequisites', 'conformanceScenarios', 'conformanceTsRequired', 'conformanceTarget', 'nativeReports', 'scriptsDatabaseRequired']
const nativeKinds = ['go-unit', 'go-integration', 'conformance-go', 'conformance-ts']
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const packageOf = file => posix.dirname(file) === 'backend' ? '.' : `./${posix.dirname(file).slice('backend/'.length)}`
const nativeSelector = file => /^scripts\/.*\.(?:test|spec)\.mjs$/.test(file)
  || /^apps\/api\/test\/[^/]+\.integration\.test\.ts$/.test(file)

export function suiteKind(suite) {
  const kind = suite?.split('-')[0]
  const valid = kinds.includes(kind) && (suite === kind || ['typecheck', 'lint', 'unit', 'build'].includes(kind)
    && ['api', 'other'].includes(suite.slice(kind.length + 1)) || ['unit-web', 'unit-web-heavy'].includes(suite))
  if (!valid) throw new Error(`Unsupported affected suite: ${suite}`)
  return kind
}

export function validateFile(file, root = repositoryRoot) {
  if (typeof file !== 'string' || !file || file.includes('\0') || file.includes('\\')
    || posix.isAbsolute(file) || win32.isAbsolute(file) || posix.normalize(file) !== file
    || file.split('/').includes('..') || /(?:^|\/)(?:node_modules|dist|\.git)(?:\/|$)/.test(file)) {
    throw new Error(`Invalid CI file: ${file}`)
  }
  const absolute = resolve(root, file)
  if (!lstatSync(absolute, { throwIfNoEntry: false })?.isFile()
    || realpathSync(absolute) !== join(realpathSync(root), file)) {
    throw new Error(`CI selection must contain existing repository files: ${file}`)
  }
  return file
}

function uniqueStrings(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item || item.trim() !== item
    || /[\x00-\x1f\x7f]/.test(item)) || new Set(value).size !== value.length) {
    throw new Error(`Invalid ${label}.`)
  }
  return [...value]
}

export function readAffectedRequest(input, root = repositoryRoot) {
  const data = Array.isArray(input) ? { files: input } : input
  if (!object(data) || !Object.hasOwn(data, 'files') || Object.keys(data).some(key => !requestKeys.includes(key))) {
    throw new Error('CI selection must be a file array or a bounded affected request.')
  }
  const files = uniqueStrings(data.files, 'CI files').map(file => validateFile(file, root))
  const goTestRoots = data.goTestRoots ?? {}
  if (!object(goTestRoots)) throw new Error('Invalid Go test roots.')
  for (const [pkg, roots] of Object.entries(goTestRoots)) {
    if (!(pkg === '.' || /^\.\/[A-Za-z0-9_./-]+$/.test(pkg)) || pkg.includes('..') || pkg.endsWith('/')
      || !files.some(file => file.startsWith('backend/') && file.endsWith('_test.go')
        && packageOf(file) === pkg)) {
      throw new Error(`Go test package must be bound to a selected test file: ${pkg}`)
    }
    if (!uniqueStrings(roots, 'Go test roots').length || roots.some(name => !/^Test[A-Za-z0-9_]+$/.test(name))) {
      throw new Error(`Invalid named Go test roots for ${pkg}.`)
    }
  }
  if (data.goRace !== undefined && (typeof data.goRace !== 'boolean'
    || data.goRace && !Object.keys(goTestRoots).length)) {
    throw new Error('Go race execution requires an explicit boolean and selected named Go test roots.')
  }
  const nativePrerequisites = uniqueStrings(data.nativePrerequisites ?? [], 'native prerequisites')
  if (nativePrerequisites.some(name => name !== 'openssl') || nativePrerequisites.length
    && !files.some(file => /^backend\/.*\.go$/.test(file))) {
    throw new Error('Native prerequisites must name the supported OpenSSL profile for selected Go files.')
  }
  const conformanceScenarios = uniqueStrings(data.conformanceScenarios ?? [], 'conformance scenario IDs')
  if (conformanceScenarios.some(id => id.startsWith('-')) || conformanceScenarios.length
    && (typeof data.conformanceTsRequired !== 'boolean' || !files.some(file => file.startsWith('conformance/')))) {
    throw new Error('Selected conformance requires exact scenario IDs, selected source files and an explicit TS comparison decision.')
  }
  if (data.conformanceTsRequired !== undefined && typeof data.conformanceTsRequired !== 'boolean') {
    throw new Error('Invalid conformance TS comparison decision.')
  }
  if (data.conformanceTarget !== undefined && (!['go', 'ts'].includes(data.conformanceTarget) || !conformanceScenarios.length)) {
    throw new Error('An explicit conformance target requires exact scenario IDs and must be go or ts.')
  }
  if (data.conformanceTarget === 'ts' && (data.conformanceTsRequired || files.some(file => file.startsWith('backend/')))) {
    throw new Error('TS reference qualification cannot include Go checks or a Go-to-TS comparison.')
  }
  if (data.scriptsDatabaseRequired !== undefined && (typeof data.scriptsDatabaseRequired !== 'boolean'
    || data.scriptsDatabaseRequired === true && !files.some(file => file.startsWith('scripts/')))) throw new Error('Invalid selected scripts database requirement.')
  if (data.nativeReports !== undefined && !object(data.nativeReports)) throw new Error('Invalid native report bindings.')
  const nativeReports = { ...data.nativeReports }
  for (const [selector, binding] of Object.entries(nativeReports)) {
    if (!files.includes(selector) || !nativeSelector(selector) || !object(binding)
      || Object.keys(binding).some(key => !['requiredKinds', 'optionalKinds'].includes(key))) {
      throw new Error(`Native report binding requires one selected script test: ${selector}`)
    }
    const required = uniqueStrings(binding.requiredKinds, 'required native report kinds')
    const optional = uniqueStrings(binding.optionalKinds ?? [], 'optional native report kinds')
    if (!required.length || [...required, ...optional].some(kind => !nativeKinds.includes(kind))
      || new Set([...required, ...optional]).size !== required.length + optional.length) {
      throw new Error(`Invalid native report kinds for ${selector}.`)
    }
  }
  return { files, goTestRoots, goRace: data.goRace ?? false, nativePrerequisites,
    conformanceScenarios, conformanceTsRequired: data.conformanceTsRequired ?? false, nativeReports,
    scriptsDatabaseRequired: data.scriptsDatabaseRequired ?? false,
    ...(data.conformanceTarget === undefined ? {} : { conformanceTarget: data.conformanceTarget }) }
}

/** An explicit TS qualification is separate from the normal Go target and optional TS comparison. */
export function conformanceTargets(request) {
  if (!request.conformanceScenarios.length) return []
  if (request.conformanceTarget === 'ts') return ['ts']
  return request.conformanceTsRequired ? ['go', 'ts'] : ['go']
}

function bindNativeReports(request, root) {
  const nativeReports = { ...request.nativeReports }
  for (const selector of request.files.filter(nativeSelector)) {
    const action = nativeActionBinding(selector, root)
    if (action && nativeReports[selector]) throw new Error(`An ordinary native action cannot request native test reports: ${selector}.`)
    const binding = nativeSelectorBinding(selector, root)
    if (!binding) continue
    const expected = { requiredKinds: binding.requiredKinds, optionalKinds: [] }
    if (nativeReports[selector] && (JSON.stringify(nativeReports[selector].requiredKinds) !== JSON.stringify(expected.requiredKinds)
      || (nativeReports[selector].optionalKinds ?? []).length)) throw new Error(`Native report binding conflicts for ${selector}.`)
    nativeReports[selector] = expected
  }
  return { ...request, nativeReports }
}

export function validateAffectedSuite(suite, input, root = repositoryRoot, loadBindings = true) {
  const kind = suiteKind(suite)
  const request = loadBindings && ['unit', 'integration'].includes(kind) ? bindNativeReports(input, root) : input
  if (!request.files.length) throw new Error('The affected CI request selected zero files.')
  for (const file of request.files) {
    const go = /^backend\/.*\.go$/.test(file)
    const retained = /^(?:apps\/web|packages\/contracts|conformance|scripts)\/.*\.[cm]?[jt]sx?$/.test(file)
    const adapter = kind === 'integration' && file.startsWith('apps/api/test/') && request.nativeReports[file]
      && nativeSelectorBinding(file, root)?.suite === 'integration'
    if (!go && !retained && !adapter) throw new Error(`Unsupported affected file: ${file}`)
    if (suite.endsWith('-api') && !go || suite.endsWith('-other') && (go || kind === 'unit' && file.startsWith('apps/web/'))
      || ['unit-web', 'unit-web-heavy'].includes(suite) && !file.startsWith('apps/web/')) {
      throw new Error(`Selected file does not belong to ${suite}: ${file}`)
    }
    if (['unit', 'integration'].includes(kind) && go) {
      const pkg = packageOf(file)
      if (!file.endsWith('_test.go') || !request.goTestRoots[pkg]?.length) {
        throw new Error(`Go tests require an explicit selected test file and named roots: ${file}`)
      }
    }
    if (kind === 'unit' && !go && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) {
      throw new Error(`Unit scope requires supported unit test files: ${file}`)
    }
    if (kind === 'integration' && !go && !adapter && (!file.startsWith('conformance/') || !request.conformanceScenarios.length)) {
      throw new Error(`Integration scope requires exact Go roots or conformance scenario IDs: ${file}`)
    }
  }
  if (!['unit', 'integration'].includes(kind) && (Object.keys(request.goTestRoots).length || request.goRace)
    || kind !== 'integration' && request.conformanceScenarios.length
    || !['unit', 'integration'].includes(kind) && Object.keys(request.nativeReports).length) {
    throw new Error(`The request contains test scope for ${suite}.`)
  }
  return request
}

export function readSelectionFile(path, root = repositoryRoot) {
  return readAffectedRequest(JSON.parse(readFileSync(resolve(root, path), 'utf8')), root)
}

/** A legacy host transports selector files; an immutable adapter manifest binds their inner scope. */
export function nativeSelectorBinding(selector, root = repositoryRoot) {
  const path = join(root, 'scripts/ci-native-selectors.json')
  if (!existsSync(path)) return null
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (!object(manifest)) throw new Error('Invalid native selector manifest.')
  if (!Object.hasOwn(manifest, selector)) return null
  const binding = manifest[selector]
  if (!nativeSelector(selector) || !object(binding)
    || Object.keys(binding).sort().join(',') !== 'selection,suite' || typeof binding.selection !== 'string') {
    throw new Error(`Invalid native selector binding for ${selector}.`)
  }
  validateFile(binding.selection, root)
  const input = readSelectionFile(binding.selection, root)
  const actionsPath = join(root, 'scripts/ci-native-actions.json')
  const actions = existsSync(actionsPath) ? JSON.parse(readFileSync(actionsPath, 'utf8')) : {}
  if (!object(actions)) throw new Error('Invalid native action manifest.')
  if (Object.keys(input.nativeReports).length || input.files.some(file => Object.hasOwn(manifest, file)
    || Object.hasOwn(actions, file) || file.startsWith('apps/api/'))) {
    throw new Error(`A native selector cannot recursively select another adapter: ${selector}.`)
  }
  const request = validateAffectedSuite(binding.suite, input, root, false)
  const kind = suiteKind(binding.suite)
  const requiredKinds = []
  if (goPackages(request).length && ['unit', 'integration'].includes(kind)) requiredKinds.push(`go-${kind}`)
  requiredKinds.push(...conformanceTargets(request).map(target => `conformance-${target}`))
  if (!requiredKinds.length) throw new Error(`Native selector ${selector} has no native tests.`)
  return { suite: binding.suite, selection: binding.selection, request, requiredKinds }
}

/** Ordinary action wrappers declare preparation without adopting or inventing native test cases. */
export function nativeActionBinding(selector, root = repositoryRoot) {
  const path = join(root, 'scripts/ci-native-actions.json')
  if (!existsSync(path)) return null
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (!object(manifest)) throw new Error('Invalid native action manifest.')
  if (!Object.hasOwn(manifest, selector)) return null
  const binding = manifest[selector]
  if (!nativeSelector(selector) || !selector.startsWith('scripts/') || !object(binding)
    || Object.keys(binding).sort().join(',') !== 'selection,suite' || typeof binding.selection !== 'string') {
    throw new Error(`Invalid native action binding for ${selector}.`)
  }
  validateFile(selector, root)
  validateFile(binding.selection, root)
  if (nativeSelectorBinding(selector, root)) throw new Error(`A selector cannot bind both native tests and an action: ${selector}.`)
  const kind = suiteKind(binding.suite)
  const request = validateAffectedSuite(binding.suite, readSelectionFile(binding.selection, root), root, false)
  if (!['typecheck', 'lint', 'build'].includes(kind) || !request.files.every(file => /^backend\/.*\.go$/.test(file))) {
    throw new Error(`A native action must bind only exact Go files to build, typecheck or lint: ${selector}.`)
  }
  return { suite: binding.suite, selection: binding.selection, request, requiredKinds: [] }
}

/** Only an executed wrapper can request its inner native preparation; inspecting its source cannot. */
export function selectedNativeRequests(suite, request, root = repositoryRoot) {
  const requests = [request]
  if (['unit', 'integration'].includes(suiteKind(suite))) {
    for (const selector of request.files.filter(nativeSelector)) {
      const action = nativeActionBinding(selector, root)
      const binding = nativeSelectorBinding(selector, root) ?? action
      if (binding) requests.push(binding.request)
    }
  }
  return requests
}

function dispatchEnvironment(environment, root) {
  if (!environment.CI_PARTITION?.startsWith('sha256:')) return environment
  const bytes = readFileSync(join(root, 'ci-dispatch-inputs.json'))
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== environment.CI_PARTITION) {
    throw new Error('CI dispatch inputs hash mismatch')
  }
  const inputs = JSON.parse(bytes)
  if (Object.keys(inputs).sort().join(',') !== 'commit,files,partition,slice'
    || Object.values(inputs).some(value => typeof value !== 'string')
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(inputs.commit) || inputs.partition.startsWith('sha256:')) {
    throw new Error('Invalid CI dispatch inputs')
  }
  return { ...environment, SLICE: inputs.slice, SELECTED_FILES: inputs.files, CI_PARTITION: inputs.partition,
    CI_SELECTION_COMMIT: inputs.commit }
}

/** Host setup exposes exact indexes or a nonempty selection beside the result destination. */
export function environmentRequest(environment = process.env, root = repositoryRoot) {
  if (environment.CI_AFFECTED_SELECTION_FILE) return readSelectionFile(environment.CI_AFFECTED_SELECTION_FILE, root)
  const input = dispatchEnvironment(environment, root)
  if (input.SELECTED_FILES) {
    return readAffectedRequest(selectByIndexes(repositoryFileList(root), input.SELECTED_FILES), root)
  }
  if (input.SUITE === 'integration' && input.SLICE) {
    return readAffectedRequest(selectByIndexes(integrationFileList(root), input.SLICE), root)
  }
  if (environment.CI_PARTITION?.startsWith('sha256:')) {
    throw new Error('Hash-bound dispatch inputs contain no explicit affected file indexes.')
  }
  const output = input.TEST_RESULTS_OUTPUT || input.FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT
  const selected = output && resolve(root, dirname(output), 'selected-files.json')
  if (selected && existsSync(selected)) return readSelectionFile(selected, root)
  throw new Error('Affected CI scope is unresolved; pass an explicit selection file or repository file indexes.')
}

/** The frozen host supplies integration --files only after its setup phase. */
export function deferredHostIntegration(environment = process.env) {
  return environment.CI_HOST_RUNNER === '1' && Boolean(environment.FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT)
    && !environment.CI_AFFECTED_SELECTION_FILE && !environment.SELECTED_FILES && !environment.CI_PARTITION && !environment.SLICE
    && environment.SCOPE !== 'full'
}

export function executionScope(environment = process.env, root = repositoryRoot) {
  const scope = environment.SCOPE || 'affected'
  if (!['affected', 'full'].includes(scope)) throw new Error(`Unsupported CI scope: ${scope}`)
  if (scope !== 'full') return scope
  if (environment.FOREMAN_CODE_CI_RELEASE === '1') return 'full'
  const input = dispatchEnvironment(environment, root)
  if (input.SUITE === 'integration' && input.SLICE) {
    validateAffectedSuite('integration', environmentRequest(input, root), root)
    return 'affected'
  }
  throw new Error('Full CI scope is reserved for explicit release mode.')
}

export function explicitRelease(environment = process.env, root = repositoryRoot) {
  return executionScope(environment, root) === 'full'
}

export function goPackages(request) {
  return [...new Set(request.files.filter(file => /^backend\/.*\.go$/.test(file))
    .map(packageOf))]
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, suite, output] = process.argv.slice(2)
  if (action === 'deferred-host-integration') process.exitCode = deferredHostIntegration() ? 0 : 1
  else if (action === 'scope') process.stdout.write(executionScope())
  else if (action === 'prepare' && output) {
    const request = validateAffectedSuite(suite, environmentRequest())
    writeFileSync(output, JSON.stringify(request), { mode: 0o600 })
  } else if (action === 'go-packages') {
    const values = goPackages(readSelectionFile(suite))
    process.stdout.write(values.length ? `${values.join('\0')}\0` : '')
  } else if (action === 'go-files') {
    const values = readSelectionFile(suite).files.filter(file => /^backend\/.*\.go$/.test(file))
    process.stdout.write(values.length ? `${values.join('\0')}\0` : '')
  } else if (action === 'go-roots' && output) {
    const roots = readSelectionFile(suite).goTestRoots[output]
    if (!roots?.length) throw new Error(`No named Go roots selected for ${output}.`)
    process.stdout.write(`^(${roots.join('|')})$`)
  } else if (action === 'go-selection' && output) {
    writeFileSync(output, JSON.stringify(readSelectionFile(suite).goTestRoots), { mode: 0o600 })
  } else if (action === 'go-race') {
    process.stdout.write(readSelectionFile(suite).goRace ? '1' : '0')
  } else if (action === 'openssl-required') {
    process.stdout.write(readSelectionFile(suite).nativePrerequisites.includes('openssl') ? '1' : '0')
  } else if (action === 'conformance-selection' && output) {
    const request = readSelectionFile(suite)
    if (!request.conformanceScenarios.length) throw new Error('Conformance scope has no exact scenario IDs.')
    writeFileSync(output, JSON.stringify(request.conformanceScenarios), { mode: 0o600 })
    process.stdout.write(`${request.conformanceScenarios.join('\0')}\0`)
  } else if (action === 'conformance-ts-required') {
    const request = readSelectionFile(suite)
    if (!request.conformanceScenarios.length) throw new Error('Conformance scope has no exact scenario IDs.')
    process.stdout.write(request.conformanceTsRequired ? '1' : '0')
  } else if (action === 'conformance-targets') {
    const targets = conformanceTargets(readSelectionFile(suite))
    if (!targets.length) throw new Error('Conformance scope has no exact scenario IDs.')
    process.stdout.write(targets.join(' '))
  } else if (action === 'flags') {
    const request = readSelectionFile(suite)
    // A selected adapter's tools are prerequisites, not additional outer native execution.
    const postgresRequired = request.conformanceScenarios.length > 0 || Object.keys(request.nativeReports)
      .some(selector => nativeSelectorBinding(selector)?.request.conformanceScenarios.length > 0)
    process.stdout.write([Number(goPackages(request).length > 0), Number(request.conformanceScenarios.length > 0),
      Number(request.scriptsDatabaseRequired),
      Number(request.files.some(file => !file.startsWith('backend/') && !(request.conformanceScenarios.length && file.startsWith('conformance/')))),
      Number(postgresRequired)].join(' '))
  } else throw new Error('Invalid affected scope action.')
}
