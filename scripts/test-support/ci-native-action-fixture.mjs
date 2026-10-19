import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scripts = fileURLToPath(new URL('..', import.meta.url))

/** Copies public CLIs, then supplies ordinary selected JS files and committed action declarations. */
export function nativeActionFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-native-actions-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const put = (file, value) => {
    mkdirSync(dirname(join(directory, file)), { recursive: true })
    writeFileSync(join(directory, file), typeof value === 'string' ? value : JSON.stringify(value))
  }
  for (const name of ['ci-cloud-native-prerequisites.mjs', 'ci-affected-scope.mjs', 'ci-files.mjs']) {
    mkdirSync(join(directory, 'scripts'), { recursive: true })
    copyFileSync(join(scripts, name), join(directory, 'scripts', name))
  }
  const goFile = 'backend/runtime/state.go'
  const ordinary = 'scripts/ordinary-state.test.mjs'
  const declarations = {}
  put(goFile, 'package runtime\n')
  put(ordinary, "import { test } from 'node:test'\ntest('ordinary state', () => {})\n")
  const actions = ['build', 'typecheck', 'lint'].map(kind => {
    const selector = `scripts/native-${kind}-action.test.mjs`
    const selection = `scripts/native-${kind}-selection.json`
    put(selector, "import { test } from 'node:test'\ntest('selected action fixture', () => {})\n")
    put(selection, { files: [goFile] })
    declarations[selector] = { suite: `${kind}-api`, selection }
    return { kind, selector, selection }
  })
  put('scripts/ci-native-selectors.json', {})
  put('scripts/ci-native-actions.json', declarations)
  let sequence = 0
  const invoke = (script, args, suite, files) => {
    const selection = join(directory, `outer-${++sequence}.json`)
    writeFileSync(selection, JSON.stringify({ files }))
    const environment = { ...process.env, SUITE: suite, SCOPE: 'affected',
      FOREMAN_CODE_CI_RELEASE: '', CI_AFFECTED_SELECTION_FILE: selection,
      SELECTED_FILES: '', SLICE: '', CI_PARTITION: '', TEST_RESULTS_OUTPUT: '',
      FOREMAN_CODE_INTEGRATION_TEST_RESULTS_OUTPUT: '' }
    delete environment.NODE_TEST_CONTEXT
    const result = spawnSync(process.execPath, [join(directory, 'scripts', script), ...args],
      { cwd: directory, env: environment, encoding: 'utf8', timeout: 20_000 })
    assert.equal(result.error, undefined, 'The public CLI must launch before behavior is asserted.')
    return result
  }
  return { directory, put, goFile, ordinary, actions, declarations,
    cloud: (suite, files, args = []) => invoke('ci-cloud-native-prerequisites.mjs', args, suite, files),
    normalize: (suite, files) => {
      const output = join(directory, `normalized-${sequence + 1}.json`)
      const result = invoke('ci-affected-scope.mjs', ['prepare', suite, output], suite, files)
      return { ...result, request: result.status === 0 ? JSON.parse(readFileSync(output, 'utf8')) : null }
    } }
}
