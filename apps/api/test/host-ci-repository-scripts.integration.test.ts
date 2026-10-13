import { CiGetOutputSchema, CiLogsOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { genericCiRepository } from './helpers/genericCiRepository.js'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it.each([
  ['typecheck', 0], ['typecheck', 1250], ['integration', 0], ['integration', 1250],
] as const)(
  'reports a missing generic %s script through MCP and persisted readback after a %i ms launch delay',
  async (suite, launchDelayMs) => {
  const repository = await genericCiRepository({ beforeLaunch: async () => {
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(resolve => setTimeout(resolve, launchDelayMs))
  } })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const input = { suite, commandId: `missing-${suite}` }
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get',
      { ticketId: started.ticketId })).run.state, { timeout: 10_000 }).toBe('failed')
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.run).toMatchObject({ state: 'failed', part: null, partition: null,
      message: `The repository has no "${suite}" script for the ${suite} suite.` })
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [started.ticketId])).rows[0]!.record).toEqual(read.run)
  } finally {
    await f.close()
    await repository.close()
  }
})

it('runs another repository’s named parts through its own suite hook', async () => {
  const repository = await genericCiRepository({ suiteHook: true })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const started = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'build', commandId: 'custom-hook' }))
    expect(started.partitions).toHaveLength(2)
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get',
      { ticketId: started.ticketId })).group!.state, { timeout: 10_000 }).toBe('passed')
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: started.ticketId }))
    expect(read.partitions!.map(run => run.part).sort()).toEqual(['build-api', 'build-other'])
    for (const run of read.partitions!) {
      expect(run.state).toBe('passed')
      const logs = CiLogsOutputSchema.parse(await f.value(f.operator, 'ci_logs_read', { ticketId: run.id }))
      expect(logs.text).toContain(`fixture hook ${run.part} passed`)
    }
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1',
      [read.run.groupId])).rows.map(row => row.record)).toEqual(expect.arrayContaining(read.partitions!))
  } finally {
    await f.close()
    await repository.close()
  }
})

it.each([0, 1250])(
  'runs generic install without an install script and persists a package-script failure after a %i ms launch delay',
  async launchDelayMs => {
  const repository = await genericCiRepository({ suiteExit: 7, beforeLaunch: async () => {
    // A subprocess launch can take longer than the default matcher polling deadline.
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(resolve => setTimeout(resolve, launchDelayMs))
  } })
  const f = await fixture({ repositoryRunner: repository })
  try {
    const install = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'install', commandId: 'generic-install' }))
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get',
      { ticketId: install.ticketId })).run.state, { timeout: 10_000 }).toBe('passed')
    const installed = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: install.ticketId }))
    expect(installed.run).toMatchObject({ part: null, partition: null, step: 'install', exitCode: 0 })
    expect(installed.logTail).toContain('npm install')
    expect(installed.logTail).not.toContain('npm run install')
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [install.ticketId])).rows[0]!.record).toEqual(installed.run)
    const build = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', { suite: 'build', commandId: 'generic-failure' }))
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get',
      { ticketId: build.ticketId })).run.state, { timeout: 10_000 }).toBe('failed')
    const failed = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: build.ticketId }))
    expect(failed.run).toMatchObject({ part: null, partition: null, step: 'build', state: 'failed', exitCode: 7 })
    expect((await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1',
      [build.ticketId])).rows[0]!.record).toEqual(failed.run)
  } finally {
    await f.close()
    await repository.close()
  }
})
