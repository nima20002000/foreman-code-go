import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { genericCiRepository } from './helpers/genericCiRepository.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it.each([
  ['pnpm-lock.yaml', 'corepack pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'corepack yarn'],
  [undefined, 'npm'],
])('runs another repository with %s as single jobs through authenticated MCP', async (lockfile, pm) => {
  const repository = await genericCiRepository(lockfile ? { lockfile } : {})
  const f = await fixture({ repositoryRunner: repository })
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', { suite: 'build', commandId: 'denied-generic' })).isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    for (const suite of ['build', 'lint', 'unit'] as const) {
      const input = { suite, commandId: `generic-${suite}` }
      const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
      expect(started.partitions).toBeUndefined()
      expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(started)
      await expect.poll(async () => CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get',
        { ticketId: started.ticketId })).run.state, { timeout: 10_000 }).toBe('passed')
      const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
      expect(read.run).toMatchObject({ suite, part: null, partition: null, scope: 'full', files: [],
        state: 'passed', exitCode: 0, commit: repository.commit, computer: { hostRef: { kind: 'main' } } })
      expect(read.partitions).toBeUndefined()
      expect(read.logTail).toContain(`${pm} install`)
      expect(read.logTail).toContain(`${pm} run ${suite}`)
      expect(read.logTail).toContain(`fixture ${suite} passed`)
      const stored = (await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
        [read.run.groupId])).rows
      expect(stored.map(row => row.record)).toEqual([read.run])
    }
  } finally {
    await f.close()
    await repository.close()
  }
})

it.each([0, 1250])(
  'runs generic integration once on a build computer when no cloud mirror is configured after a %i ms launch delay',
  async launchDelayMs => {
  const repository = await genericCiRepository({ integration: true, cloud: true, beforeLaunch: async () => {
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(resolve => setTimeout(resolve, launchDelayMs))
  } })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run',
      { suite: 'integration', partitions: 4, commandId: 'generic-integration' }))
    expect(started.partitions).toBeUndefined()
    await f.value(f.operator, 'ci_computers_list', {})
    await f.ci.dispatch()
    expect((await repository.waitForCompletion(started.ticketId)).code).toBe(0)
    await f.ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', {
      ticketId: started.ticketId, waitUntil: 'group-terminal', waitSeconds: 10,
    }))
    expect(read.run).toMatchObject({ part: null, partition: null, state: 'passed',
      computer: { hostRef: { kind: 'main' } } })
    expect(read.logTail).toContain('npm run integration')
    expect(read.logTail?.split('\n').filter(line => line === 'npm run integration')).toHaveLength(1)
    expect(read.logTail).toContain('fixture integration passed')
    expect(repository.cloudAttempts).toEqual([])
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [read.run.groupId])).rows.map(row => row.record)).toEqual([read.run])
  } finally {
    await f.close()
    await repository.close()
  }
})

it.each([
  ['unit', 0], ['unit', 1250], ['lint', 0], ['lint', 1250],
] as const)(
  'runs generic %s for an empty affected selection and preserves HTTP and MCP readback after a %i ms launch delay',
  async (suite, launchDelayMs) => {
  const repository = await genericCiRepository({ cloud: true, beforeLaunch: async () => {
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(resolve => setTimeout(resolve, launchDelayMs))
  } })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const input = { suite, scope: 'affected', files: [], commit: repository.commit, commandId: 'generic-affected' }
    const writer = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const headers = { authorization: `Bearer ${writer.token}` }
    const url = `/api/management/workspaces/${f.workspaceId}/ci`
    const reader = await f.credential(CI_GET_ACTIONS)
    const denied = await f.app.inject({ method: 'POST', url,
      headers: { authorization: `Bearer ${reader.token}` }, payload: input })
    expect(denied.statusCode).toBe(403)
    const response = await f.app.inject({ method: 'POST', url, headers, payload: input })
    expect(response.statusCode).toBe(200)
    const started = CiRunOutputSchema.parse(response.json())
    await f.value(f.operator, 'ci_computers_list', {})
    await f.ci.dispatch()
    expect((await repository.waitForCompletion(started.ticketId)).code).toBe(0)
    await f.ci.dispatch()
    await f.value(f.operator, 'ci_get', { ticketId: started.ticketId, waitUntil: 'group-terminal', waitSeconds: 10 })
    const read = await f.app.inject({ method: 'GET', url: `${url}/${started.ticketId}`, headers })
    expect(read.statusCode).toBe(200)
    const result = CiGetOutputSchema.parse(read.json())
    expect(result.run).toMatchObject({ state: 'passed', part: null, partition: null, scope: 'full', files: [],
      computer: { hostRef: { kind: 'main' } } })
    expect(result.logTail).toContain(`fixture ${suite} passed`)
    expect(repository.cloudAttempts).toEqual([])
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId })).run)
      .toEqual(result.run)
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record).toEqual(result.run)
  } finally {
    await f.close()
    await repository.close()
  }
})
