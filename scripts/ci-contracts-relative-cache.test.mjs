import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const cli = fileURLToPath(new URL('./ci-contracts.mjs', import.meta.url))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'contracts-relative-cache-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  put('packages/contracts/package.json', JSON.stringify({
    name: '@foreman-code/contracts',
    type: 'module',
    exports: { './selected': { import: './dist/selected.js' } },
  }))
  put('packages/contracts/src/selected.ts', "export { sum } from './arithmetic.js'\n")
  put('packages/contracts/src/arithmetic.ts',
    'export function sum(left: number, right: number): number { return left + right }\n')
  put('packages/contracts/consumer.test.mjs',
    "import { sum } from '@foreman-code/contracts/selected'\nconsole.log(sum(3, 4))\n")
  put('pnpm-lock.yaml', 'selected compiler fixture\n')
  put('selection.json', JSON.stringify({ files: ['packages/contracts/consumer.test.mjs'] }))
  const modules = join(root, 'packages/contracts/node_modules')
  mkdirSync(join(modules, '@types'), { recursive: true })
  symlinkSync(fileURLToPath(new URL('../packages/contracts/node_modules/typescript', import.meta.url)),
    join(modules, 'typescript'), 'dir')
  symlinkSync(fileURLToPath(new URL('../packages/contracts/node_modules/@types/node', import.meta.url)),
    join(modules, '@types/node'), 'dir')
  const env = {
    ...process.env,
    CI: 'true',
    CI_HOST_RUNNER: '0',
    CI_STATE: join(root, 'state'),
    SUITE: '',
    SCOPE: 'affected',
    FOREMAN_CODE_CI_RELEASE: '',
    CI_AFFECTED_SELECTION_FILE: join(root, 'selection.json'),
    SELECTED_FILES: '',
    CI_PARTITION: '',
    CI_NATIVE_REPORTS_DIR: '',
    CI_NATIVE_SELECTOR: '',
    FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT: '',
  }
  const run = args => {
    const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout.trim()
  }
  return { root, run }
}

for (const cacheKind of ['relative', 'absolute']) {
  test(`selected contracts can be consumed after preparation with a ${cacheKind} cache from the repository root`, t => {
    const { root, run } = fixture(t)
    let cache = '.logs/ci-contracts-cache'
    if (cacheKind === 'absolute') cache = join(root, cache)
    run([cli, 'affected', root, cache])
    run([cli, 'ready', root])
    assert.equal(run([join(root, 'packages/contracts/consumer.test.mjs')]), '7')

    rmSync(join(root, 'packages/contracts/dist'), { recursive: true })
    run([cli, 'affected', root, cache])
    run([cli, 'ready', root])
    assert.equal(run([join(root, 'packages/contracts/consumer.test.mjs')]), '7')
  })
}
