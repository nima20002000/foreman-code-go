import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { conformanceScenario } from './conformance-report-fixture.mjs'
import { goCiFixture } from './go-ci-fixture.mjs'

export const prerequisiteSelector = 'apps/api/test/native-prerequisites.integration.test.ts'
export const prerequisitePlan = 'scripts/native-prerequisites-selection.json'
export const prerequisiteScenario = conformanceScenario()

// Only the external PostgreSQL process is replaced. The copied suite and native-report lifecycle are real.
const postgres = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const ready = path.join(process.env.FOREMAN_CODE_CI_POSTGRES_CACHE, 'ready')
const cold = !fs.existsSync(ready)
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ tool: 'postgres-tools', args, cold,
  home: process.env.HOME, state: process.env.CI_STATE }) + '\\n')
if (args[0] === process.env.FAIL_POSTGRES_COMMAND) {
  console.error('fixture PostgreSQL preparation failed')
  process.exit(8)
}
if (args[0] === 'install') {
  fs.mkdirSync(path.dirname(ready), { recursive: true })
  fs.writeFileSync(ready, 'prepared')
  console.log(cold ? 'fixture cold PostgreSQL installation completed' : 'fixture PostgreSQL cache reused')
} else if (args[0] === 'verify' && cold) {
  console.error('fixture PostgreSQL installation is missing')
  process.exit(8)
}
`

const adapter = `import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { nativeSelectorBinding, repositoryRoot } from '../../../scripts/ci-affected-scope.mjs'
test('executes only the selected synthetic conformance action', () => {
  appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({ tool: 'adapter', args: ['start'],
    home: process.env.HOME, state: process.env.CI_STATE,
    postgresReady: existsSync(join(process.env.FOREMAN_CODE_CI_POSTGRES_CACHE, 'ready')) }) + '\\n')
  const binding = nativeSelectorBinding('${prerequisiteSelector}')
  const environment = { ...process.env }
  delete environment.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, [join(repositoryRoot, 'scripts/ci-affected-run.mjs'),
    binding.suite, '--files-from', join(repositoryRoot, binding.selection)],
    { cwd: repositoryRoot, env: environment, stdio: 'inherit' })
  assert.ifError(result.error)
  assert.equal(result.status, 0)
})
`

const corepack = `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const args = process.argv.slice(2)
const adapter = args.slice(0, 4).join(' ') === 'pnpm --dir apps/api exec' && args.includes('--test')
const command = adapter ? args.slice(5) : [join(__dirname, 'fallback/corepack.cjs'), ...args]
// The fixture adapter contains ordinary JavaScript; it needs no package loader or runtime installation.
if (adapter && command[0] === '--import' && command[1] === 'tsx') command.splice(0, 2)
const result = spawnSync(process.execPath, command, { env: process.env, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
`

/** Bounded process fixtures exercise the public integration selector, never actual TS qualification. */
export function nativePrerequisiteFixture(t, overrides = {}) {
  const fixture = goCiFixture(t, { SCOPE: 'affected', FOREMAN_CODE_CI_RELEASE: '', SELECTED_FILES: '', ...overrides })
  const put = (file, bytes) => {
    mkdirSync(dirname(join(fixture.directory, file)), { recursive: true })
    writeFileSync(join(fixture.directory, file), bytes)
  }
  put('apps/api/package.json', JSON.stringify({ type: 'module' }))
  put(prerequisiteSelector, adapter)
  const source = 'conformance/src/selected.ts'
  put(source, 'export {}\n')
  const request = { files: [source], conformanceScenarios: [prerequisiteScenario.id],
    conformanceTarget: 'ts', conformanceTsRequired: false }
  put(prerequisitePlan, JSON.stringify(request))
  put('scripts/ci-native-selectors.json', JSON.stringify({
    [prerequisiteSelector]: { suite: 'integration', selection: prerequisitePlan },
  }))
  const selection = join(fixture.directory, 'selected.json')
  writeFileSync(selection, JSON.stringify([prerequisiteSelector]))
  fixture.environment.CI_AFFECTED_SELECTION_FILE = selection
  for (const suffix of ['log', 'exit']) rmSync(join(fixture.state, `postgres.${suffix}`), { force: true })
  put('bin/postgres-tools.cjs', postgres)
  mkdirSync(join(fixture.directory, 'bin/fallback'))
  copyFileSync(join(fixture.directory, 'bin/corepack.cjs'), join(fixture.directory, 'bin/fallback/corepack.cjs'))
  put('bin/corepack.cjs', corepack)
  const sessions = () => {
    const root = join(fixture.state, 'go/native-reports')
    return existsSync(root) ? readdirSync(root).map(name => join(root, name)) : []
  }
  return { ...fixture, put, request, selection, sessions,
    sessionJson: (session, file) => JSON.parse(readFileSync(join(session, file), 'utf8')) }
}
