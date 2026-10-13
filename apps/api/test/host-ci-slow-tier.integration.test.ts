import { CiGetOutputSchema, CiRunOutputSchema, integrationPartition } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it.each(['full', 'affected'] as const)(
  'persists slow-tier results after a fast failure through authenticated MCP with scope=%s', async scope => {
    const fast = 'apps/api/test/quick.integration.test.ts'
    const slow = 'apps/api/test/lengthy.integration.test.ts'
    const files = [fast, slow]
    const durations = { [fast]: 1_000, [slow]: 60_000 }
    const f = await fixture({ integrationInventory: { files, durations } })
    try {
      const input = { suite: 'integration', scope, commit: 'a'.repeat(40), commandId: 'slow-tier-failure',
        ...(scope === 'affected' ? { files } : {}) }
      const reader = await f.connect(CI_GET_ACTIONS)
      expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
      expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
      const admitted = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
      expect(CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))).toEqual(admitted)
      const initial = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: admitted.ticketId }))
      const fastRun = initial.partitions!.find(run => run.partition?.tier === 'fast')!
      const slowRun = initial.partitions!.find(run => run.partition?.tier === 'slow')!
      expect(fastRun.state).toBe('running')
      expect(slowRun).toMatchObject({ state: 'queued', deferred: true })
      f.finish(fastRun.id, 1, 'Fast file failed.\n')
      const afterFast = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: admitted.ticketId }))
      expect(afterFast.partitions!.find(run => run.id === fastRun.id)).toMatchObject({ state: 'failed', exitCode: 1 })
      expect(afterFast.partitions!.find(run => run.id === slowRun.id)?.state)
        .toBe(scope === 'full' ? 'running' : 'canceled')
      const launched = f.started.flatMap(({ request }) => request.operation === 'start'
        ? integrationPartition(files, request.durations ?? durations, request.partition!) : [])
      expect(launched).toEqual(scope === 'full' ? [fast, slow] : [fast])
      if (scope === 'full') f.finish(slowRun.id, 1, 'Slow file also failed.\n')
      const finished = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: admitted.ticketId }))
      expect(finished.group?.state).toBe('failed')
      expect(finished.partitions!.find(run => run.id === fastRun.id)).toMatchObject({ state: 'failed', exitCode: 1 })
      expect(finished.partitions!.find(run => run.id === slowRun.id)?.state)
        .toBe(scope === 'full' ? 'failed' : 'canceled')
      if (scope === 'full') expect(finished.partitions!.every(run => run.exitCode === 1)).toBe(true)
      for (const run of finished.partitions!) {
        const stored = (await f.pool.query('select record from ci_runs where id=$1', [run.id])).rows[0].record
        expect(stored).toEqual(run)
      }
    } finally { await f.close() }
  },
)
