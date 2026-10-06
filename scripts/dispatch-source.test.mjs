import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execute = promisify(execFile)

test('captured source executes the accepted commit after its original checkout changes while queued',
  { timeout: 20000 }, async () => {
    const capture = process.env.FOREMAN_CODE_TEST_SOURCE_CAPTURE
    assert.ok(capture, 'Provide the actual reviewed source-capture operation on this machine.')
    const directory = await mkdtemp(join(tmpdir(), 'dispatch-source-'))
    const worktree = join(directory, 'original')
    const snapshot = join(directory, 'captured')
    try {
      await mkdir(worktree)
      const environment = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' }
      const git = (...args) => execute('git', ['-C', worktree, ...args], { env: environment })
      await git('init', '-q', '-b', 'main')
      await writeFile(join(worktree, 'program.mjs'), 'process.stdout.write(JSON.stringify({value: 1}))\n')
      await git('add', 'program.mjs')
      await git('commit', '-qm', 'Accepted source')
      const commit = (await git('rev-parse', 'HEAD')).stdout.trim()
      await execute('bash', [capture, worktree, commit, snapshot], { env: environment })
      await writeFile(join(worktree, 'dependency.mjs'), 'export const value = 2\n')
      await writeFile(join(worktree, 'program.mjs'),
        "import {value} from './dependency.mjs'; process.stdout.write(JSON.stringify({value}))\n")
      const captured = await execute('node', ['program.mjs'], { cwd: snapshot })
      const current = await execute('node', ['program.mjs'], { cwd: worktree })
      assert.deepEqual(JSON.parse(captured.stdout), { value: 1 })
      assert.deepEqual(JSON.parse(current.stdout), { value: 2 })
      assert.equal((await execute('git', ['-C', snapshot, 'rev-parse', 'HEAD'])).stdout.trim(), commit)
      assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), commit)
      await git('worktree', 'remove', '--force', snapshot)
      await git('worktree', 'prune')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
