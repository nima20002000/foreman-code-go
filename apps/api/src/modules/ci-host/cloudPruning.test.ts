import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'

it.each(['github', 'circleci'] as const)(
  'drains a due cancellation sweep queued during %s mirror cleanup', async provider => {
    const f = await fixture({}, { provider })
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const sweeping = new Promise<void>(resolve => { entered = resolve })
    f.cloud.setActiveRunLookup(async () => {
      entered()
      await blocked
      return { ids: new Set<string>(), readAt: 0 }
    })
    const runId = randomUUID()
    const branch = `refs/heads/ci/${f.commit}`
    try {
      await f.cloud.handle({
        operation: 'start', workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
        runId, suite: 'lint', scope: 'full',
      })
      await sweeping
      expect(f.mirrorGit('for-each-ref', '--format=%(refname)', branch)).toBe(branch)
      f.advance(5 * 60_000)
      expect(await f.cloud.handle({ operation: 'cancel', runId }))
        .toMatchObject({ operation: 'cancel', run: { state: 'canceled' } })
    } finally {
      release()
      await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    }
    expect(f.mirrorGit('for-each-ref', '--format=%(refname)', branch)).toBe('')
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ operation: 'read', run: { state: 'canceled' } })
    expect(provider === 'github' ? f.dispatched : f.circle.triggered).toHaveLength(1)
  },
)

it.each(['github', 'circleci'] as const)(
  'removes a canceled %s branch after an in-flight sweep already retained it', async provider => {
    const f = await fixture({}, { provider })
    f.mirrorGit('update-ref', 'refs/heads/ci/retired-run', 'main')
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let deleting = false
    const git = f.git.git.bind(f.git)
    vi.spyOn(f.git, 'git').mockImplementation(async (args, options) => {
      if (args[0] === 'push' && args.includes('--atomic')) {
        deleting = true
        await blocked
      }
      return git(args, options)
    })
    const runId = randomUUID()
    try {
      await f.cloud.handle({
        operation: 'start', workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
        runId, suite: 'lint', scope: 'full',
      })
      await expect.poll(() => deleting, { timeout: 5_000 }).toBe(true)
      expect(f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/'))
        .toContain(`refs/heads/ci/${f.commit}`)
      expect(await f.cloud.handle({ operation: 'cancel', runId }))
        .toMatchObject({ operation: 'cancel', run: { state: 'canceled' } })
    } finally {
      release()
      await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    }
    expect(f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/')).toBe('')
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ operation: 'read', run: { state: 'canceled' } })
  },
)

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
