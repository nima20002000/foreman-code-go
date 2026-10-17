import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { affectedSnapshot, selectAffectedFiles } from './ci-affected.mjs'
import { affectedCommands } from './ci-affected-run.mjs'
import { selectByIndexes } from './ci-files.mjs'
import { goCiFixture } from './test-support/go-ci-fixture.mjs'

const inheritedProgressFile = process.env.CI_PROGRESS_FILE
before(() => { process.env.CI_PROGRESS_FILE = '' })
after(() => {
  if (inheritedProgressFile === undefined) delete process.env.CI_PROGRESS_FILE
  else process.env.CI_PROGRESS_FILE = inheritedProgressFile
})

for (const suite of ['typecheck', 'lint', 'unit', 'integration', 'build']) {
  test(`${suite} cannot become an empty or narrowed migration check from TS affected selection`, () => {
    for (const changedFiles of [[], ['backend/runtime/state.go'], ['apps/api/src/feature.ts'],
      ['apps/web/src/view.tsx'], ['packages/contracts/src/domain.ts'], ['conformance/health.test.ts'], ['README.md']]) {
      const selection = selectAffectedFiles({ suite, changedFiles, sources: new Map() })
      assert.equal(selection.scope, 'full')
      assert.deepEqual(selection.files, [])
      assert.match(selection.reason, /complete Go backend and retained TypeScript/)
      assert.deepEqual(affectedCommands(suite, changedFiles), [
        ['env', `SUITE=${suite}`, 'SCOPE=full', 'bash', 'scripts/ci-suite.sh'],
      ])
    }
  })
}

test('unsupported affected commands fail explicitly', () => {
  assert.throws(() => affectedCommands('unknown'), /Unsupported affected suite/)
})

test('legacy file index decoding stays available for retained web shards and host reports', () => {
  assert.deepEqual(selectByIndexes(['a', 'b', 'c'], 's:0,2'), ['a', 'c'])
  assert.throws(() => selectByIndexes(['a', 'b', 'c'], '-1'), /Invalid/)
  const names = Array.from({ length: 100 }, (_, index) => `f${index}`)
  assert.deepEqual(selectByIndexes(names, 'd:0'), ['f0'])
  assert.deepEqual(selectByIndexes(names, 'd:0.2,1,a.1,1'), ['f0', 'f1', 'f2', 'f4', 'f15', 'f16', 'f18'])
  assert.deepEqual(selectByIndexes(names, `d:${(99).toString(36)}`), ['f99'])
  assert.deepEqual(selectByIndexes(names, 'd:'), [])
  for (const bad of ['d:-1', 'd:A', 'd:1.', 'd:.1', 'd:1.2.3', `d:${(100).toString(36)}`, 'd:0.2s', 'd:50,1z']) {
    assert.throws(() => selectByIndexes(names, bad), /Invalid/, bad)
  }
})

for (const files of [[], ['apps/api/src/feature.test.ts']]) {
  test(`the legacy affected CLI still runs full Go and retained checks for ${files.length} explicit TS files`, t => {
    const fixture = goCiFixture(t)
    const selection = join(fixture.directory, 'selected.json')
    writeFileSync(selection, JSON.stringify(files))
    const result = spawnSync(process.execPath, [new URL('./ci-affected-run.mjs', import.meta.url).pathname,
      'typecheck', '--files-from', selection], { cwd: fixture.directory, encoding: 'utf8',
      env: { ...fixture.environment, SCOPE: 'affected', SELECTED_FILES: 's:0', SLICE: '1/9', CI_PARTITION: '{}' } })
    assert.equal(result.error, undefined, result.error?.message)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Ignoring the frozen TypeScript selection/)
    assert.deepEqual(fixture.calls().filter(call => call.tool === 'go' && call.args[0] !== 'env')
      .map(call => call.args), [['build', './...'], ['vet', './...']])
    const checks = fixture.calls().filter(call => call.tool === 'corepack')
    assert.ok(checks.some(call => call.args.includes('@foreman-code/web')))
    assert.ok(checks.every(call => call.scope === 'full'))
    assert.equal(checks.some(call => call.args.includes('@foreman-code/api')), false)
  })
}

test('snapshot selection retains base diagnostics and full scope despite later working tree edits', async t => {
  const { snapshot } = await import('./ci-remote.mjs')
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'affected-ci-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const environment = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  const git = (...args) => execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'feature')
  mkdirSync(join(root, 'backend'), { recursive: true })
  const file = join(root, 'backend/state.go')
  writeFileSync(file, 'package backend\n')
  git('add', '.')
  git('commit', '-qm', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  assert.deepEqual(affectedSnapshot('HEAD', 'unit', root), {
    scope: 'full', files: [], reason: 'The commit is the workspace default branch head.',
  })
  git('update-ref', 'refs/remotes/origin/release/stable', 'HEAD')
  writeFileSync(file, 'package backend\nconst Ready = true\n')
  const commit = snapshot(root)
  writeFileSync(file, 'package backend\nconst Ready = false\n')
  for (const [cwd, ref] of [[root, 'origin/main'], [join(root, 'backend'), 'origin/main'], [root, 'origin/release/stable']]) {
    const selection = affectedSnapshot(commit, 'unit', cwd, ref)
    assert.equal(selection.scope, 'full')
    assert.deepEqual(selection.files, [])
  }
  assert.match(affectedSnapshot(commit, 'unit', root, 'origin/main', 'invalid').reason, /baseCommit is unavailable/)
  const merge = git('commit-tree', `${commit}^{tree}`, '-p', 'HEAD', '-p', commit, '-m', 'merge')
  assert.match(affectedSnapshot(merge, 'unit', root).reason, /Merge commits require a full run/)
  git('update-ref', '-d', 'refs/remotes/origin/main')
  assert.match(affectedSnapshot(commit, 'unit', root).reason, /No merge-base/)
})
