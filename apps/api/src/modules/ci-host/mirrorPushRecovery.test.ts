import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { readOperationalFailures } from '../diagnostics/operationalFailures.js'
import { fixture } from './cloud.testSupport.js'

const publication = (commit: string) => ({ repository: 'octo/site', mirror: 'octo/site-ci', commit })

it('renegotiates once when an advertised snapshot disappears during publication of its cached child', async () => {
  const f = await fixture()
  const initial = f.mirrorGit('rev-parse', 'main')
  await f.cloud.publishMirror(publication(f.commit))
  const parent = f.mirrorGit('rev-parse', 'main')
  // Another publisher replaces main; only the old snapshot branches now retain the cached parent.
  f.mirrorGit('update-ref', 'refs/heads/main', initial)
  await f.write('README.md', 'child snapshot\n')
  f.run('add', '.')
  f.run('commit', '-qm', 'child')
  f.push('main')
  const commit = f.run('rev-parse', 'HEAD')
  const hook = join(f.git.cloneDirectory('octo/site-ci'), '.git', 'hooks', 'pre-push')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const remote = `git --git-dir=${quote(join(f.root, 'mirror.git'))}`
  // pre-push runs after advertisement. Reclaiming the deleted refs' objects forces a real connectivity failure.
  await mkdir(dirname(hook), { recursive: true })
  await writeFile(hook, [
    '#!/bin/sh',
    'set -eu',
    'rm -- "$0"',
    'unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_INDEX_FILE',
    `${remote} update-ref -d refs/heads/ci/${f.commit}`,
    `${remote} update-ref -d refs/heads/ci-snapshot/${parent}`,
    `${remote} reflog expire --expire=now --all`,
    `${remote} gc --prune=now --quiet`,
    '',
  ].join('\n'))
  await chmod(hook, 0o700)
  const pushes: { code: number; stderr: string }[] = []
  const git = f.git.git
  f.git.git = async (args, options) => {
    const result = await git(args, options)
    if (args[0] === 'push' && args.includes('--force')) pushes.push(result)
    return result
  }

  await expect(f.reopen().publishMirror(publication(commit))).resolves.toBeUndefined()
  expect(pushes).toHaveLength(2)
  expect(pushes[0]).toMatchObject({ code: 1, stderr: expect.stringContaining('(missing necessary objects)') })
  expect(pushes[1]?.code).toBe(0)
  expect(f.mirrorGit('rev-parse', 'main^')).toBe(parent)
  const snapshot = f.mirrorGit('rev-parse', `refs/heads/ci/${commit}`)
  expect(f.mirrorGit('rev-parse', `refs/heads/ci-snapshot/${snapshot}`)).toBe(snapshot)
  expect(f.mirrorGit('rev-parse', 'main^{tree}')).toBe(f.run('rev-parse', `${commit}^{tree}`))
  expect(f.mirrorGit('fsck', '--connectivity-only')).not.toContain('missing')
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({
    operation: 'retry CI mirror push', attempt: 1,
  }))
})

it.each([
  { reason: 'missing necessary objects', attempts: 2 },
  { reason: 'hook declined', attempts: 1 },
  { reason: 'permission denied', attempts: 1 },
])('propagates a persistent $reason rejection after $attempts push attempts', async ({ reason, attempts }) => {
  const f = await fixture()
  const initial = f.mirrorGit('rev-parse', 'main')
  const git = f.git.git
  let pushes = 0
  f.git.git = async (args, options) => {
    if (args[0] === 'push' && args.includes('--force')) {
      pushes++
      return { code: 1, stdout: '',
        stderr: ` ! [remote rejected] snapshot -> ci/child (${reason})\nerror: failed to push some refs` }
    }
    return git(args, options)
  }

  await expect(f.cloud.publishMirror(publication(f.commit))).rejects.toThrow(`(${reason})`)
  expect(pushes).toBe(attempts)
  expect(f.mirrorGit('rev-parse', 'main')).toBe(initial)
  expect(f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/')).toBe('')
  expect(f.dispatched).toHaveLength(0)
})
