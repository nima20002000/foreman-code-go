import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'

afterEach(() => vi.restoreAllMocks())

it.each([false, true])('adopts an accepted CircleCI submission after its reply is lost, delayed visibility: %s', async delayed => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  let visible = !delayed
  let submissionBranch = ''
  const original = f.ports.run
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'circleci' && args[0] === 'run' && args[1] === 'trigger') {
      await original(file, args, options)
      submissionBranch = args[args.indexOf('--branch') + 1]!
      if (f.circle.triggered.length === 1) throw new Error('Trigger reply lost')
      return { code: 0, stderr: '', stdout: JSON.stringify({ id: `run-${f.circle.triggered.length}` }) }
    }
    if (file === 'circleci' && args[0] === 'run' && args[1] === 'list') {
      expect(args[args.indexOf('--branch') + 1]).toBe(submissionBranch)
      return { code: 0, stderr: '', stdout: JSON.stringify(visible ? [
        { id: 'unrelated', branch: 'ci/another-ticket', revision: f.commit },
        { id: 'run-1', branch: submissionBranch, revision: f.mirrorGit('rev-parse', submissionBranch) },
      ] : []) }
    }
    return original(file, args, options)
  })
  await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })).rejects.toThrow('Trigger reply lost')
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  f.advance(75_001)
  if (delayed) {
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
    expect(f.circle.triggered).toHaveLength(1)
    visible = true
    f.advance(4_001)
  }
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running' } })
  expect(f.circle.triggered).toHaveLength(1)
  expect(submissionBranch).toContain(runId)
  f.circle.runView = { phase: 'ended', current_outcome: 'canceled', workflows: [] }
  expect(await f.reopen().handle({ operation: 'cancel', runId })).toMatchObject({ run: { state: 'canceled' } })
  expect(f.circle.canceled).toContain('run-1')
})
