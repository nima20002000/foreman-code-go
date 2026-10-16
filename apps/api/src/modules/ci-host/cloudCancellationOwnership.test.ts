import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'

afterEach(() => vi.restoreAllMocks())

it.each(['github', 'circleci'] as const)('retains %s ownership and refs until every canceled attempt stops', async provider => {
  const f = await fixture({}, { provider })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  if (provider === 'github') f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  await f.cloud.handle(read)
  await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  f.advance(5 * 60_000)
  expect(await f.cloud.handle({ operation: 'cancel', runId }))
    .toMatchObject({ run: { state: 'running', finishedAt: null } })
  await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  expect(f.mirrorGit('rev-parse', `refs/heads/ci/${f.commit}`)).toBeTruthy()
  f.advance(75_001)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null } })
  if (provider === 'github') Object.assign(f.github, { status: 'completed', conclusion: 'cancelled' })
  else f.circle.runView = { phase: 'ended', current_outcome: 'canceled', workflows: [] }
  f.advance(4_001)
  const reopened = f.reopen()
  expect(await reopened.handle(read)).toMatchObject({ run: { state: 'canceled', finishedAt: expect.any(String) } })
  await reopened.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  expect(f.mirrorGit('for-each-ref', '--format=%(refname)', `refs/heads/ci/${f.commit}`)).toBe('')
  expect(provider === 'github' ? f.github.canceled : f.circle.canceled).toEqual([provider === 'github' ? '91' : 'run-1'])
})

it('retains ownership when terminal status cannot be read after cancellation', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  await f.cloud.handle({ operation: 'cancel', runId })
  f.circle.lookupError = 'permission denied'
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  for (let poll = 0; poll < 3; poll++) {
    f.advance(75_001)
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null } })
  }
})
