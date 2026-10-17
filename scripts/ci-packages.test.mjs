import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./ci-packages.mjs', import.meta.url))
const projects = ['apps/api', 'apps/web', 'apps/worker', 'packages/contracts']

function fixture(t, additionalProjects = []) {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, 'ci-packages-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  mkdirSync(join(root, '.logs'))
  writeFileSync(join(root, 'package.json'), '{"packageManager":"pnpm@11.27.0"}')
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 2880\n')
  writeFileSync(join(root, '.npmrc'), 'auto-install-peers=false\n')
  const workspaceProjects = [...projects, ...additionalProjects]
  for (const project of workspaceProjects) {
    mkdirSync(join(root, project), { recursive: true })
    writeFileSync(join(root, project, 'package.json'), '{}')
  }
  const calls = join(root, 'calls.jsonl')
  writeFileSync(calls, '')
  writeFileSync(join(bin, 'corepack'), `#!${process.execPath}
const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs')
if (process.argv[2] !== 'pnpm') process.exit(7)
const args = process.argv.slice(3)
appendFileSync(process.env.CALLS_FILE, JSON.stringify(args) + '\\n')
if (args.includes('--offline') && process.env.FAIL_OFFLINE === 'true') process.exit(9)
mkdirSync('node_modules/.pnpm', { recursive: true })
writeFileSync('node_modules/.modules.yaml', 'installed')
for (const project of ${JSON.stringify(workspaceProjects)}) mkdirSync(project + '/node_modules', { recursive: true })
`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CALLS_FILE: calls,
    CI_PNPM_STORE_CACHE_HIT: '', FAIL_OFFLINE: '' }
  const run = (extra = {}) => {
    const result = spawnSync(process.execPath, [script, 'install', root],
      { cwd: root, env: { ...env, ...extra }, encoding: 'utf8' })
    assert.ifError(result.error)
    return result
  }
  const commands = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
  const clear = () => writeFileSync(calls, '')
  return { root, env, run, commands, clear }
}

test('a complete packages cache hit skips installation when optional workspaces are absent', t => {
  const f = fixture(t)
  const first = f.run()
  assert.equal(first.status, 0, first.stdout + first.stderr)
  f.clear()
  const second = f.run()
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.deepEqual(f.commands(), [])
})

for (const project of ['conformance', 'backend/bridge/claude']) {
  test(`a changed ${project} manifest refreshes the installed packages`, t => {
    const f = fixture(t, [project])
    assert.equal(f.run().status, 0)
    f.clear()
    writeFileSync(join(f.root, project, 'package.json'), '{"name":"updated-workspace"}')
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(f.commands().length, 1)
    f.clear()
    assert.equal(f.run().status, 0)
    assert.deepEqual(f.commands(), [])
  })

  test(`a missing ${project} dependency directory repairs the packages cache`, t => {
    const f = fixture(t, [project])
    assert.equal(f.run().status, 0)
    f.clear()
    rmSync(join(f.root, project, 'node_modules'), { recursive: true })
    const result = f.run()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(f.commands().length, 1)
  })
}

test('packages installation falls back online on a cold cache and skips unchanged installed state', t => {
  const f = fixture(t)
  const first = f.run({ FAIL_OFFLINE: 'true' })
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.equal(f.commands().length, 2)
  assert.equal(f.commands()[0].includes('--offline'), true)
  assert.equal(f.commands()[1].includes('--offline'), false)
  f.clear()
  const second = f.run()
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.deepEqual(f.commands(), [])
})

test('a restored store installation failure stays a failure instead of using the network', t => {
  const f = fixture(t)
  const result = f.run({ FAIL_OFFLINE: 'true', CI_PNPM_STORE_CACHE_HIT: 'true' })
  assert.equal(result.status, 9)
  assert.equal(f.commands().length, 1)
})

for (const input of ['package.json', 'apps/api/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
  test(`packages cache invalidates when ${input} changes`, t => {
    const f = fixture(t)
    const first = f.run()
    assert.equal(first.status, 0, first.stderr)
    writeFileSync(join(f.root, input), readFileSync(join(f.root, input), 'utf8') + '\n')
    f.clear()
    assert.equal(f.run().status, 0)
    assert.equal(f.commands().length, 1)
  })
}

test('an incomplete packages restore is repaired rather than treated as an installation hit', t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  rmSync(join(f.root, 'apps/web/node_modules'), { recursive: true })
  f.clear()
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(f.commands().length, 1)
})
