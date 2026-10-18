// Committed integration adapter implementation; the suite owns setup, execution and native result publication.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeSelectorBinding, repositoryRoot, validateFile } from './ci-affected-scope.mjs'
import { CONFORMANCE_BASELINE_SHA, CONFORMANCE_REPOSITORY } from './ci-conformance-report.mjs'

const selector = 'apps/api/test/conformance-ts-reference.integration.test.ts'
const referencePath = 'conformance/ci/ts-reference-inputs.json'
const manifestPath = 'scripts/ci-native-selectors.json'
const git = args => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim()
const blob = bytes => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex')

function inputIdentity(file) {
  validateFile(file)
  const bytes = readFileSync(join(repositoryRoot, file))
  return { file, gitBlob: blob(bytes), sha256: createHash('sha256').update(bytes).digest('hex'),
    mode: lstatSync(join(repositoryRoot, file)).mode & 0o111 ? '100755' : '100644' }
}

function referenceSource(binding, nativeInput) {
  const reference = JSON.parse(readFileSync(join(repositoryRoot, referencePath), 'utf8'))
  assert.equal(reference.baselineSha, CONFORMANCE_BASELINE_SHA, 'The frozen TS reference cannot change.')
  const checkout = realpathSync(repositoryRoot)
  assert.equal(realpathSync(git(['rev-parse', '--show-toplevel'])), checkout, 'The adapter must use its own checkout.')
  const commitSha = git(['rev-parse', '--verify', 'HEAD^{commit}'])
  const treeSha = git(['rev-parse', '--verify', 'HEAD^{tree}'])
  assert.equal(nativeInput.selector, selector, 'The native input receipt belongs to another adapter.')
  assert.equal(nativeInput.checkoutCommit, commitSha, 'The native adapter checkout changed after selection.')
  const production = Object.fromEntries(Object.keys(reference.production)
    .map(path => [path, git(['rev-parse', '--verify', `HEAD:${path}`])]))
  assert.deepEqual(production, reference.production, 'TS production must still match the frozen reference.')
  const metadata = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'))
  assert.deepEqual(Object.fromEntries(Object.keys(reference.packageMetadata).map(key => [key, metadata[key]])),
    reference.packageMetadata, 'The TS runtime package metadata must match the frozen reference.')
  // Only the test-tooling importer/package entry was added; all TS runtime dependency bytes remain frozen.
  const lockfile = readFileSync(join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')
    .replace(/^  conformance:\n(?: {4}.*\n|\n)*/m, '')
  const workspace = readFileSync(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8').replace(/^  - conformance\n/m, '')
  assert.equal(blob(lockfile), reference.lockfileWithoutConformanceImporter, 'The frozen TS runtime dependency lock changed.')
  assert.equal(blob(workspace), reference.workspaceWithoutConformancePackage, 'The frozen TS workspace configuration changed.')
  const inputs = [...new Set([selector, manifestPath, binding.selection, referencePath,
    'scripts/ci-conformance-reference.mjs', 'scripts/ci-conformance-reference.d.mts',
    'scripts/ci-affected-scope.mjs', 'scripts/ci-affected-contracts.mjs', 'scripts/ci-affected-run.mjs',
    'scripts/ci-suite.sh', 'scripts/ci-conformance-suite.sh', 'scripts/ci-native-reports.mjs',
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ...binding.request.files])]
  const checked = [...new Set([...Object.keys(production), 'conformance', ...inputs])]
  assert.equal(git(['status', '--porcelain', '--untracked-files=all', '--', ...checked]), '',
    'The selected TS reference and qualification source must be a clean committed checkout.')
  return { schemaVersion: 1, repository: CONFORMANCE_REPOSITORY,
    sourceCheckout: { directory: checkout, commitSha, treeSha }, nativeInput,
    tsProduction: { directory: checkout, baselineSha: reference.baselineSha, baselineTree: reference.baselineTree,
      verifiedObjects: production, dependencyLockMatchesFrozenRuntime: true },
    target: 'ts', selector, suite: binding.suite, selection: binding.selection,
    scenarioIds: binding.request.conformanceScenarios, selectedInputs: inputs.map(inputIdentity),
    harnessTree: git(['rev-parse', '--verify', 'HEAD:conformance']),
  }
}

/** Called only by the real selected integration test under the existing native-report collector. */
export async function runConformanceReference() {
  if (process.env.CI_NATIVE_SELECTOR !== selector || !process.env.CI_NATIVE_REPORTS_DIR) {
    throw new Error('TS reference qualification requires the selected native integration adapter boundary.')
  }
  const binding = nativeSelectorBinding(selector)
  if (!binding || binding.suite !== 'integration' || binding.request.conformanceTarget !== 'ts'
    || binding.requiredKinds.length !== 1 || binding.requiredKinds[0] !== 'conformance-ts') {
    throw new Error('The committed TS reference selector must bind one exact TS-only integration plan.')
  }
  const nativeInput = JSON.parse(readFileSync(join(process.env.CI_NATIVE_REPORTS_DIR, 'native-input.json'), 'utf8'))
  const receipt = referenceSource(binding, nativeInput)
  const destination = join(process.env.CI_NATIVE_REPORTS_DIR, 'ts-reference-source.json')
  writeFileSync(destination, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flag: 'wx' })
  const environment = { ...process.env }
  for (const name of ['NODE_TEST_CONTEXT', 'CONFORMANCE_COMMIT_SHA', 'CONFORMANCE_BASELINE_SHA']) delete environment[name]
  const outcome = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [join(repositoryRoot, 'scripts/ci-affected-run.mjs'), binding.suite,
      '--files-from', join(repositoryRoot, binding.selection)], { cwd: repositoryRoot, env: environment, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (exitCode, signal) => resolveExit({ exitCode, signal }))
  })
  writeFileSync(destination, `${JSON.stringify({ ...receipt, action: outcome })}\n`, { mode: 0o600 })
  assert.equal(outcome.signal, null, 'The TS reference action terminated by signal.')
  assert.equal(outcome.exitCode, 0, 'The selected TS reference action failed; retain its native reports.')
}
