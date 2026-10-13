import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fixture } from './cloud.testSupport.js'

it.each(['github', 'circleci'] as const)(
  'prunes stale branches while another %s ticket awaits its first metadata write', async provider => {
    const f = await fixture({}, { provider })
    await mkdir(join(f.root, 'ci-cloud', 'runs', randomUUID()), { recursive: true })
    f.mirrorGit('update-ref', 'refs/heads/ci/retired-run', 'main')
    f.mirrorGit('update-ref', 'refs/heads/feature/keep', 'main')
    const runId = randomUUID()
    const activeState = provider === 'github' ? 'starting' : 'running'
    expect(await f.cloud.handle({
      operation: 'start', workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
      runId, suite: 'lint', scope: 'affected', files: [],
    })).toMatchObject({ operation: 'start', run: { state: activeState } })

    const refs = () => f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/')
    await expect.poll(refs, { timeout: 5_000 }).not.toContain('refs/heads/ci/retired-run')
    expect(refs()).toContain('refs/heads/feature/keep')
    expect(refs()).toContain(`refs/heads/ci/${f.commit}`)
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ operation: 'read', run: { state: activeState } })
  },
)
