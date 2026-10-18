import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { affectedContracts, contractsCompiler } from './ci-affected-contracts.mjs'
import { readAffectedRequest } from './ci-affected-scope.mjs'

const cli = fileURLToPath(new URL('./ci-contracts.mjs', import.meta.url))

function fixture(t, compiler = true) {
  const root = mkdtempSync(join(tmpdir(), 'affected-contracts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text) }
  put('scripts/consumer.test.mjs', "import '@foreman-code/contracts/selected'\n")
  put('packages/contracts/package.json', JSON.stringify({ type: 'module', exports: { './selected': { import: './dist/selected.js' } } }))
  put('packages/contracts/src/selected.ts', "export { value } from './transitive.js'\n")
  put('packages/contracts/src/transitive.ts', 'export const value: number = 7\n')
  put('packages/contracts/src/unselected.ts', 'export const broken: number = "unselected"\n')
  put('packages/contracts/tsconfig.json', JSON.stringify({ compilerOptions: { noEmit: true }, files: ['src/unselected.ts'] }))
  put('pnpm-lock.yaml', 'isolated compiler fixture\n')
  put('selection.json', JSON.stringify({ files: ['scripts/consumer.test.mjs'] }))
  if (compiler) {
    const modules = join(root, 'packages/contracts/node_modules')
    mkdirSync(join(modules, '@types'), { recursive: true })
    symlinkSync(fileURLToPath(new URL('../packages/contracts/node_modules/typescript', import.meta.url)), join(modules, 'typescript'), 'dir')
    symlinkSync(fileURLToPath(new URL('../packages/contracts/node_modules/@types/node', import.meta.url)), join(modules, '@types/node'), 'dir')
  }
  const cache = join(root, 'cache')
  const env = { ...process.env, CI: 'true', CI_HOST_RUNNER: '0', CI_STATE: join(root, 'state'), SUITE: '', SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '',
    CI_AFFECTED_SELECTION_FILE: join(root, 'selection.json'), SELECTED_FILES: '', CI_PARTITION: '',
    CI_NATIVE_REPORTS_DIR: '', CI_NATIVE_SELECTOR: '', FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT: '' }
  const run = (action = 'affected') => {
    const args = action === 'ready' ? [cli, action, root] : [cli, action, root, cache]
    const result = spawnSync(process.execPath, args, { cwd: join(root, 'packages/contracts'), env, encoding: 'utf8' })
    assert.ifError(result.error)
    return result
  }
  return { root, put, cache, run, env, dist: join(root, 'packages/contracts/dist') }
}

test('TS6 emits only the required export closure with explicit roots despite an unrelated local config error', t => {
  const f = fixture(t)
  const result = f.run()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(existsSync(join(f.dist, 'selected.js')), true)
  assert.equal(existsSync(join(f.dist, 'transitive.js')), true)
  assert.equal(existsSync(join(f.dist, 'transitive.d.ts')), true)
  assert.equal(existsSync(join(f.dist, 'unselected.js')), false)
  const receipt = JSON.parse(readFileSync(join(f.root, 'state/go/contracts-preparation.json'), 'utf8'))
  assert.equal(receipt.mode, 'compiler')
  assert.equal(receipt.exitCode, 0)
  assert.deepEqual(receipt.sources, ['packages/contracts/src/selected.ts', 'packages/contracts/src/transitive.ts'])
  assert.ok(receipt.command.includes('--ignoreConfig'))
  assert.deepEqual(receipt.command.slice(-2), ['src/selected.ts', 'src/transitive.ts'])
  assert.equal(f.run('ready').status, 0)
})

test('a missing required transitive output cannot qualify a stamped dist or cached export', t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  const key = readFileSync(join(f.dist, '.ci-cache-key'), 'utf8')
  rmSync(join(f.dist, 'transitive.js'))
  assert.equal(f.run('ready').status, 1)
  rmSync(join(f.cache, key, 'transitive.js'))
  const rebuilt = f.run()
  assert.equal(rebuilt.status, 0, rebuilt.stderr)
  assert.match(readFileSync(join(f.dist, 'transitive.js'), 'utf8'), /value = 7/)
  assert.equal(existsSync(join(f.cache, key, 'transitive.js')), true)
})

test('cached closure contents with a mismatched key stamp are rebuilt before use', t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  const key = readFileSync(join(f.dist, '.ci-cache-key'), 'utf8')
  writeFileSync(join(f.cache, key, '.ci-cache-key'), 'wrong-key')
  writeFileSync(join(f.cache, key, 'transitive.js'), 'poisoned output')
  rmSync(f.dist, { recursive: true })
  const rebuilt = f.run()
  assert.equal(rebuilt.status, 0, rebuilt.stderr)
  assert.match(readFileSync(join(f.dist, 'transitive.js'), 'utf8'), /value = 7/)
  assert.equal(readFileSync(join(f.dist, '.ci-cache-key'), 'utf8'), key)
})

test('Go-only setup bypasses contracts metadata and the compiler before readiness or cache work', t => {
  const f = fixture(t, false)
  f.put('backend/runtime/state.go', 'package runtime\n')
  f.put('selection.json', JSON.stringify({ files: ['backend/runtime/state.go'] }))
  rmSync(join(f.root, 'packages/contracts/package.json'))
  rmSync(join(f.root, 'pnpm-lock.yaml'))
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(f.cache), false)
  assert.equal(existsSync(f.dist), false)
})

test('TS oracle runtime export dependencies are conditional on the exact conformance comparison request', t => {
  const f = fixture(t, false)
  f.put('conformance/src/selected.ts', 'export {}')
  f.put('conformance/src/main.ts', 'export {}')
  f.put('apps/api/src/server.ts', "import '@foreman-code/contracts/selected'")
  f.put('apps/api/src/cli/operatorCredentials.ts', "import '@foreman-code/contracts/selected'")
  const input = { files: ['conformance/src/selected.ts'], conformanceScenarios: ['health'], conformanceTsRequired: false }
  assert.deepEqual(affectedContracts(readAffectedRequest(input, f.root), f.root).entries, [])
  const plan = affectedContracts(readAffectedRequest({ ...input, conformanceTsRequired: true }, f.root), f.root)
  assert.deepEqual(plan.entries, ['packages/contracts/src/selected.ts'])
  assert.deepEqual(plan.sources, ['packages/contracts/src/selected.ts', 'packages/contracts/src/transitive.ts'])
})

test('selected fixture program strings are data while real literal module edges prepare their exports', t => {
  const f = fixture(t, false)
  const names = ['selected', 'reexport', 'dynamic', 'required', 'expression']
  f.put('packages/contracts/package.json', JSON.stringify({ type: 'module', exports: Object.fromEntries(names.map(name =>
    [`./${name}`, { import: `./dist/${name}.js` }])) }))
  for (const name of names.slice(1)) f.put(`packages/contracts/src/${name}.ts`, `export const ${name} = 1\n`)
  f.put('scripts/consumer.test.mjs', [
    "import '@foreman-code/contracts/selected'",
    "export { reexport } from /* an actual edge */ '@foreman-code/contracts/reexport'",
    "await import /* an actual edge */ ('@foreman-code/contracts/dynamic')",
    "const loaded = require('@foreman-code/contracts/required')",
    'const quoted = "import \'@foreman-code/contracts/not-an-export\'"',
    "// import '@foreman-code/contracts/comment-only'",
    "/* export * from '@foreman-code/contracts/comment-only' */",
    "const program = `export * from '@foreman-code/contracts/template-only'`",
    String.raw`const pattern = /import '@foreman-code\/contracts\/regexp-only'/`,
    "const evaluated = `${await import('@foreman-code/contracts/expression')}`",
  ].join('\n'))
  const plan = affectedContracts(readAffectedRequest({ files: ['scripts/consumer.test.mjs'] }, f.root), f.root)
  assert.deepEqual(plan.entries, names.map(name => `packages/contracts/src/${name}.ts`).sort())
  assert.deepEqual(plan.sources, [...plan.entries, 'packages/contracts/src/transitive.ts'].sort())
})

test('a reached runtime keeps its declaration-only public types and companion bytes invalidate the cache', t => {
  const f = fixture(t)
  f.put('packages/contracts/src/selected.ts', "export { runtimeValue } from './runtime.mjs'\nexport type { RuntimeResult } from './runtime.mjs'\n")
  f.put('packages/contracts/src/runtime.mjs', 'export const runtimeValue = 7\n')
  f.put('packages/contracts/src/runtime.d.mts', 'export declare const runtimeValue: number\nexport interface RuntimeResult { value: number }\n')
  f.put('scripts/runtime-consumer.mts', "import type { RuntimeResult } from '../packages/contracts/dist/selected.js'\nconst result: RuntimeResult = { value: 7 }\nexport { result }\n")
  const checkConsumer = () => spawnSync(process.execPath, [contractsCompiler(f.root), '--ignoreConfig', '--noEmit',
    '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--types', 'node',
    join(f.root, 'scripts/runtime-consumer.mts')], { cwd: join(f.root, 'packages/contracts'), env: f.env, encoding: 'utf8' })
  const result = f.run()
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(readFileSync(join(f.dist, 'runtime.mjs'), 'utf8'), /runtimeValue = 7/)
  const initial = checkConsumer()
  assert.ifError(initial.error)
  assert.equal(initial.status, 0, initial.stdout + initial.stderr)
  const key = readFileSync(join(f.dist, '.ci-cache-key'), 'utf8')
  f.put('packages/contracts/src/runtime.d.mts', 'export declare const runtimeValue: number\nexport interface RuntimeResult { name: string }\n')
  const rebuilt = f.run()
  assert.equal(rebuilt.status, 0, rebuilt.stdout + rebuilt.stderr)
  assert.notEqual(readFileSync(join(f.dist, '.ci-cache-key'), 'utf8'), key)
  const changed = checkConsumer()
  assert.ifError(changed.error)
  assert.notEqual(changed.status, 0)
  assert.match(changed.stdout + changed.stderr, /value.*does not exist|value.*RuntimeResult/)
})
