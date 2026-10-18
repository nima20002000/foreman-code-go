import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { affectedContracts } from '../ci-affected-contracts.mjs'
import { readAffectedRequest } from '../ci-affected-scope.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const cli = fileURLToPath(new URL('../ci-contracts.mjs', import.meta.url))
export const referenceScenario = 'conformance/src/selected.ts'
export const referenceAdapter = 'apps/api/test/reference.integration.test.ts'

/** Copies executable runtime inputs; assertions consume public planner, compiler and import results. */
export function frozenRuntimeFixture(t, { compiler = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'frozen-runtime-contracts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  const link = (file, source) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    symlinkSync(source, join(root, file), 'dir')
  }
  put('package.json', JSON.stringify({ type: 'module' }))
  const names = ['scenario', 'server', 'credentials', 'worker', 'retained']
  put('packages/contracts/package.json', JSON.stringify({ type: 'module', exports: Object.fromEntries(names.map(name =>
    [`./${name}`, { import: `./dist/${name}.js` }])) }))
  for (const [index, name] of names.entries()) {
    put(`packages/contracts/src/${name}.ts`, `export const ${name}Value: number = ${index + 3}\n`)
  }
  put('packages/contracts/src/unselected.ts', 'export const unselected: number = "not selected"\n')
  put('packages/contracts/tsconfig.json', JSON.stringify({ compilerOptions: { noEmit: true }, files: ['src/unselected.ts'] }))
  put('pnpm-lock.yaml', 'finite frozen runtime fixture\n')
  put(referenceScenario, "export { scenarioValue } from '@foreman-code/contracts/scenario'\n")
  put('conformance/src/main.ts', "import './selected.js'\n")
  put('apps/api/src/server.ts', [
    "import './modules/jobs/ciRuntimeContext.mjs'",
    "import '../../../scripts/runtime-bridge.mjs'",
    "import '@foreman-code/contracts/server'",
  ].join('\n'))
  put('apps/api/src/cli/operatorCredentials.ts', "import '@foreman-code/contracts/credentials'\n")
  put('scripts/runtime-bridge.mjs', [
    "import { WorkerError, workerValue } from '../apps/worker/src/runtime.mjs'",
    "export const workerResult = { code: new WorkerError('fixture-worker').code, value: workerValue }",
  ].join('\n'))
  put('apps/worker/src/runtime.mjs', [
    "export { WorkerError } from './diagnostics.mjs'",
    "export { workerValue } from '@foreman-code/contracts/worker'",
  ].join('\n'))
  for (const file of ['apps/worker/src/diagnostics.mjs', 'apps/worker/artifacts/ci-runtime/context.mjs',
    'apps/worker/artifacts/ci-runtime/seed-policy.mjs', 'apps/api/src/modules/jobs/ciRuntimeContext.mjs']) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    copyFileSync(join(repository, file), join(root, file))
  }
  const request = (overrides = {}) => ({ files: [referenceScenario], conformanceScenarios: ['fixture-reference'],
    conformanceTarget: 'ts', conformanceTsRequired: false, ...overrides })
  const select = input => put('selection.json', JSON.stringify(input))
  select(request())
  const home = join(root, 'home'), temporary = join(root, 'tmp')
  mkdirSync(home, { mode: 0o700 })
  mkdirSync(temporary, { mode: 0o700 })
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'), TMPDIR: temporary, CI: 'true', CI_HOST_RUNNER: '0', CI_STATE: join(root, 'state'),
    SUITE: '', SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '', CI_AFFECTED_SELECTION_FILE: join(root, 'selection.json'),
    SELECTED_FILES: '', CI_PARTITION: '', CI_NATIVE_REPORTS_DIR: '', CI_NATIVE_SELECTOR: '',
    FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT: '' }
  if (compiler) {
    link('packages/contracts/node_modules/typescript', join(repository, 'packages/contracts/node_modules/typescript'))
    link('packages/contracts/node_modules/@types/node', join(repository, 'packages/contracts/node_modules/@types/node'))
    link('apps/worker/node_modules/yaml', join(repository, 'apps/worker/node_modules/yaml'))
    link('node_modules/@foreman-code/contracts', join(root, 'packages/contracts'))
  }
  const execute = args => {
    const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000 })
    assert.ifError(result.error)
    assert.equal(result.signal, null, result.stdout + result.stderr)
    return result
  }
  const run = () => execute([cli, 'affected', root, join(root, 'cache')])
  const observe = source => {
    put('observe.mjs', source)
    return execute([join(root, 'observe.mjs')])
  }
  const plan = input => affectedContracts(readAffectedRequest(input, root), root)
  const remove = file => rmSync(join(root, file))
  return { root, put, request, select, env, run, observe, plan, remove }
}
