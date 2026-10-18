import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { integrationFileList, repositoryFileList } from '../ci-files.mjs'
import { goCiFixture } from './go-ci-fixture.mjs'

const repository = fileURLToPath(new URL('../..', import.meta.url))

function adapter(suite, plan, prefix) {
  return `import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('delegates one named native fixture case', () => {
  const environment = { ...process.env }
  delete environment.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('${prefix}scripts/ci-affected-run.mjs', import.meta.url)),
    '${suite}', '--files-from', fileURLToPath(new URL('${prefix}${plan}', import.meta.url)),
  ], { cwd: fileURLToPath(new URL('${prefix}', import.meta.url)), env: environment, encoding: 'utf8', timeout: 20000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
`
}

function scopedFiles(fixture) {
  const { directory } = fixture
  const put = (file, value) => {
    mkdirSync(dirname(join(directory, file)), { recursive: true })
    writeFileSync(join(directory, file), typeof value === 'string' ? value : JSON.stringify(value))
  }
  const goFile = 'backend/runtime/state_test.go'
  const goSource = 'backend/runtime/state.go'
  const unitSelector = 'scripts/cloud-unit-adapter.test.mjs'
  const integrationSelector = 'apps/api/test/cloud-native.integration.test.ts'
  const unboundIntegration = 'apps/api/test/unbound.integration.test.ts'
  const ordinary = 'scripts/cloud-ordinary.test.mjs'
  const conformanceFile = 'conformance/src/scenarios/fixture.ts'
  const request = { files: [goFile], goTestRoots: { './runtime': ['TestRuntimeState'] } }
  const unitPlan = 'scripts/cloud-unit-plan.json'
  const integrationPlan = 'scripts/cloud-integration-plan.json'
  put(goFile, 'package runtime\n')
  put(goSource, 'package runtime\n')
  put(unitPlan, request)
  put(integrationPlan, request)
  put(unitSelector, adapter('unit-api', unitPlan, '../'))
  put(integrationSelector, adapter('integration', integrationPlan, '../../../'))
  put(unboundIntegration, 'export {}\n')
  put('apps/api/test/nested/ignored.integration.test.ts', 'export {}\n')
  put(ordinary, "import { test } from 'node:test'\ntest('ordinary JavaScript fixture', () => {})\n")
  put(conformanceFile, '// Selected conformance source fixture; no scenario executes in a scope test.\n')
  put('scripts/ci-native-selectors.json', {
    [unitSelector]: { suite: 'unit-api', selection: unitPlan },
    [integrationSelector]: { suite: 'integration', selection: integrationPlan },
  })
  put('package.json', { type: 'module' })
  put('apps/api/package.json', { type: 'module' })
  const track = () => execFileSync('git', ['add', '--all'], { cwd: directory, stdio: 'pipe' })
  execFileSync('git', ['init', '--quiet'], { cwd: directory, stdio: 'pipe' })
  track()
  const base = { ...fixture.environment, SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '',
    CI_AFFECTED_SELECTION_FILE: '', SELECTED_FILES: '', SLICE: '', CI_PARTITION: '',
    TEST_RESULTS_OUTPUT: '', FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT: '' }
  const index = (files, file) => {
    const value = files.indexOf(file)
    if (value < 0) throw new Error(`The fixture did not track its selected file: ${file}`)
    return `s:${value}`
  }
  let requests = 0
  return { ...fixture, put, track, goFile, goSource, unitSelector, integrationSelector, unboundIntegration, ordinary, conformanceFile,
    selectedEnvironment: (suite, file, extra = {}) => ({ ...base, SUITE: suite,
      SELECTED_FILES: index(repositoryFileList(directory), file), ...extra }),
    integrationEnvironment: (file = integrationSelector, extra = {}) => ({ ...base, SUITE: 'integration', SCOPE: 'full',
      SLICE: index(integrationFileList(directory), file), FOREMAN_CODE_CI_GATE: '1', ...extra }),
    requestEnvironment: (suite, input, extra = {}) => {
      const file = `request-${++requests}.json`
      put(file, input)
      return { ...base, SUITE: suite, CI_AFFECTED_SELECTION_FILE: join(directory, file), ...extra }
    } }
}

export function cloudSelectionFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-cloud-selection-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return scopedFiles({ directory })
}

/** Execute copied public entrypoints; only Go, database and package-manager process boundaries are fakes. */
export function cloudSuiteFixture(t) {
  const f = goCiFixture(t, { SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '' })
  const fixture = scopedFiles(f)
  f.environment.CLOUD_FIXTURE_REAL_PATH = process.env.PATH
  writeFileSync(join(f.directory, 'bin/git.cjs'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'ls-files') {
  const result = spawnSync('git', args, { env: { ...process.env, PATH: process.env.CLOUD_FIXTURE_REAL_PATH }, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
if (args[0] === 'rev-parse') { console.log(process.env.FIXTURE_COMMIT_SHA); process.exit(0); }
throw new Error('Unexpected fixture Git action: ' + args[0]);
`)
  renameSync(join(f.directory, 'bin/corepack.cjs'), join(f.directory, 'bin/corepack-fixture.cjs'))
  writeFileSync(join(f.directory, 'bin/corepack.cjs'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'pnpm' && args[1] === '--dir' && args[2] === 'apps/api' && args[3] === 'exec' && args.includes('--test')) {
  fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ tool: 'corepack', args, cwd: process.cwd(), scope: process.env.SCOPE }) + '\\n');
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(args[4], args.slice(5), { cwd: path.join(process.cwd(), 'apps/api'), env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
require('./corepack-fixture.cjs');
`, { mode: 0o755 })
  symlinkSync(join(repository, 'apps/api/node_modules'), join(f.directory, 'apps/api/node_modules'), 'dir')
  return fixture
}
