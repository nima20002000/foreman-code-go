import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CloudCi } from './cloud.js'
import { CircleCiProvider, type CloudRun } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'
import { withProviderPoll } from './providerPoll.js'
import { fixture } from './cloud.testSupport.js'

const run: CloudRun = {
  runId: 'ticket', repository: 'fixture/site', mirror: 'fixture/site-ci', commit: 'a'.repeat(40),
  suite: 'integration', startedAt: '2026-10-01T00:00:00Z', providerRunId: 'pipeline', state: 'starting',
  finishedAt: null, exitCode: null, message: null,
}
const finishedAt = '2026-10-01T00:04:00Z'

it.each(['created', 'setup-pending'])(
  'waits for workflows on a %s CircleCI pipeline and then reads success through HTTP', async state => {
    let visible = false
    let pipelineId = 'pipeline'
    const command = vi.fn<HostCiPorts['run']>(async () => { throw new Error('Unexpected CLI request') })
    const ports: HostCiPorts = { run: command, now: () => new Date(finishedAt), cpus: 4, memoryBytes: 2 ** 30 }
    const fetchCircle: typeof fetch = async input => {
      const path = new URL(String(input)).pathname
      if (path === `/api/v2/pipeline/${pipelineId}`) return Response.json({ state, errors: [] })
      if (path === `/api/v2/pipeline/${pipelineId}/workflow`) {
        return Response.json({ items: visible ? [{ id: 'workflow', status: 'success', stopped_at: finishedAt }] : [] })
      }
      if (path === '/api/v2/workflow/workflow/job') return Response.json({ items: [] })
      throw new Error(`Unexpected CircleCI request: ${path}`)
    }
    const provider = new CircleCiProvider(ports, { fetch: fetchCircle, circleToken: async () => 'fixture-token' })
    await withProviderPoll(async () => {
      expect(await provider.find(run)).toBeNull()
      expect(await provider.status(run)).toMatchObject({ done: false })
    })
    visible = true
    await withProviderPoll(async () => {
      expect(await provider.find(run)).toBe('pipeline')
      expect(await provider.status(run)).toMatchObject({ done: true, conclusion: 'success', finishedAt })
    })
    expect(command).not.toHaveBeenCalled()

    const f = await fixture({}, { provider: 'circleci' })
    f.circle.runView = { phase: state, workflows: [] }
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
      repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    pipelineId = 'run-1'
    visible = false
    const reopen = () => new CloudCi('main-1', provider, async () => 'octo/site-ci',
      join(f.root, 'ci-cloud'), f.ports, f.git, { home: f.root, user: 'fixture', host: 'fixture-computer' })
    const request = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
    expect(await reopen().handle(request)).toMatchObject({ run: { state: 'starting', exitCode: null, finishedAt: null } })
    visible = true
    expect(await reopen().handle(request)).toMatchObject({ run: { state: 'passed', exitCode: 0, finishedAt } })
    expect(await reopen().handle(request)).toMatchObject({ run: { state: 'passed', exitCode: 0, finishedAt } })
  },
)

it.each([
  { phase: 'created', current_outcome: 'not_run' },
  { phase: 'setup-pending', current_outcome: 'not_run' },
  { state: 'created', phase: 'ended', current_outcome: 'not_run' },
  { state: 'setup-pending', phase: 'ended', current_outcome: 'not_run' },
  { phase: 'ended' },
  { phase: 'ended', current_outcome: 'not_run' },
  { phase: 'ended', current_outcome: '' },
  { phase: 'ended', current_outcome: 'unknown' },
])('keeps an incomplete CircleCI CLI pipeline pending: %j', async pending => {
  let view: unknown = { ...pending, errors: [], workflows: [] }
  const ports: HostCiPorts = { cpus: 4, memoryBytes: 2 ** 30, now: () => new Date(finishedAt),
    run: async () => ({ code: 0, stdout: JSON.stringify(view), stderr: '' }) }
  const provider = new CircleCiProvider(ports, { circleToken: async () => null })
  expect(await provider.find(run)).toBeNull()
  expect(await provider.status(run)).toMatchObject({ done: false })
  view = { phase: 'ended', workflows: [{ phase: 'ended', outcome: 'succeeded', stopped_at: finishedAt }] }
  expect(await provider.find(run)).toBe('pipeline')
  expect(await provider.status(run)).toMatchObject({ done: true, conclusion: 'success', finishedAt })
})

it.each(['failed', 'errored', 'unauthorized', 'not_run', 'skipped', 'infrastructure_fail', 'timedout'])(
  'settles an explicitly ended CircleCI failing outcome: %s', async outcome => {
    const ports: HostCiPorts = { cpus: 4, memoryBytes: 2 ** 30, now: () => new Date(finishedAt),
      run: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ phase: 'ended',
        workflows: [{ phase: 'ended', outcome, jobs: [] }] }) }) }
    const provider = new CircleCiProvider(ports, { circleToken: async () => null })
    expect(await provider.status(run)).toMatchObject({ done: true, conclusion: 'failure' })
  },
)
