import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

const require = createRequire(new URL('../apps/web/package.json', import.meta.url))
const compiler = require.resolve('typescript/bin/tsc')

function fixture(t, project = 'apps/web') {
  const base = process.env.TMPDIR ?? tmpdir()
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'ci-typecheck-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'checkout')
  const bin = join(root, 'bin')
  mkdirSync(join(source, project), { recursive: true })
  mkdirSync(join(source, 'scripts'), { recursive: true })
  for (const file of ['ci-suite.sh', 'ci-runtime-state.sh', 'ci-typecheck-cache.mjs']) {
    copyFileSync(new URL(file, import.meta.url), join(source, 'scripts', file))
  }
  mkdirSync(bin)
  mkdirSync(join(root, 'home'))
  if (project === 'conformance') writeFileSync(join(source, project, 'package.json'), '{}')
  writeFileSync(join(source, project, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, incremental: true, skipLibCheck: true,
      tsBuildInfoFile: 'node_modules/.cache/tsc/typecheck.tsbuildinfo' },
    files: ['value.ts'],
  }))
  writeFileSync(join(source, project, 'value.ts'), 'export const value: number = 1\n')
  writeFileSync(join(bin, 'corepack'), `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const args = process.argv.slice(2)
if (args.includes('build')) process.exit(0)
const conformance = args.includes('--dir') && args.includes('conformance')
if (conformance !== ${JSON.stringify(project === 'conformance')}) process.exit(0)
console.log('cache=' + existsSync(join(${JSON.stringify(project)}, 'node_modules/.cache/tsc/typecheck.tsbuildinfo')))
const result = spawnSync(process.execPath, [${JSON.stringify(compiler)}, '-p', ${JSON.stringify(project)}],
  { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
`, { mode: 0o755 })
  const run = () => {
    const environment = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, SUITE: 'typecheck-other', SCOPE: 'full',
      HOME: join(root, 'home'), XDG_CACHE_HOME: '', COREPACK_HOME: join(root, 'corepack'),
      BASH_ENV: '', ENV: '', CI_PARTITION: '', FOREMAN_CODE_CI_RELEASE: '1', FOREMAN_CODE_CI_CONTRACTS_CACHE: '',
      SELECTED_FILES: '', CI_HOST_RUNNER: '0', CI_EXPECTED_DURATION_MS: '',
      FOREMAN_CODE_CI_TYPECHECK_CACHE: join(root, 'cache'), FOREMAN_CODE_CI_TYPECHECK_CACHE_ACTIVE: '',
      CI_STATE: join(root, 'state') }
    delete environment.NODE_TEST_CONTEXT
    const result = spawnSync('bash', [join(source, 'scripts/ci-suite.sh')], { cwd: source, encoding: 'utf8', env: environment })
    assert.equal(result.error, undefined, result.error?.message)
    assert.notEqual(result.status, null)
    return result
  }
  const replaceDependencies = () => rmSync(join(source, project, 'node_modules'), { recursive: true, force: true })
  return { run, source, project, replaceDependencies }
}

for (const project of ['apps/web', 'packages/contracts', 'conformance']) {
  test(`retained typecheck restores ${project} state after dependency replacement and reports changed-source errors`, t => {
    const f = fixture(t, project)
    const first = f.run()
    assert.equal(first.status, 0, first.stdout + first.stderr)
    assert.match(first.stdout, /cache=false/)
    f.replaceDependencies()
    const second = f.run()
    assert.equal(second.status, 0, second.stdout + second.stderr)
    assert.match(second.stdout, /cache=true/)
    writeFileSync(join(f.source, f.project, 'value.ts'), 'export const value: number = "invalid"\n')
    f.replaceDependencies()
    const changed = f.run()
    assert.notEqual(changed.status, 0)
    assert.match(changed.stdout, /TS2322/)
    f.replaceDependencies()
    const repeated = f.run()
    assert.notEqual(repeated.status, 0)
    assert.match(repeated.stdout, /TS2322/)
    writeFileSync(join(f.source, f.project, 'value.ts'), 'export const value: number = 2\n')
    f.replaceDependencies()
    const fixed = f.run()
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr)
  })
}

test('a fresh checkout without cached build info still reports all type errors', t => {
  const f = fixture(t)
  writeFileSync(join(f.source, f.project, 'value.ts'), 'export const value: number = "invalid"\n')
  const result = f.run()
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /cache=false/)
  assert.match(result.stdout, /TS2322/)
})
