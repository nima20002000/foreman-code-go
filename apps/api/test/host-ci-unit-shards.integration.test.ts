import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it.each(['http', 'mcp'] as const)('returns and replays every maximum unit shard through %s', async transport => {
  const files = ['apps/api/test', 'apps/web/src'].flatMap(directory => Array.from({ length: 32 }, (_, index) =>
    `${directory}/measured${index}.test.ts`))
  const durations = Object.fromEntries(files.map(file => [file, 120_000]))
  const f = await fixture({ unitInventory: { files, durations, heavy: [] } })
  try {
    const input = { suite: 'unit', scope: 'full', commit: 'a'.repeat(40), commandId: `maximum-${transport}` }
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    const credential = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const run = async () => {
      if (transport === 'mcp') return CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
      const response = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${f.workspaceId}/ci`,
        headers: { authorization: `Bearer ${credential.token}` }, payload: input })
      expect(response.statusCode, response.body).toBe(200)
      return CiRunOutputSchema.parse(response.json())
    }
    const result = await run()
    expect(result.partitions).toHaveLength(67)
    expect(await run()).toEqual(result)
    const read = CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: result.ticketId }))
    expect(read.partitions).toHaveLength(67)
    expect(new Set(read.partitions!.map(part => part.id))).toEqual(new Set(result.partitions!.map(part => part.ticketId)))
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(67)
  } finally { await f.close() }
})
