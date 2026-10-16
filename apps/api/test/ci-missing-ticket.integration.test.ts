import { CiRunOutputSchema } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('recovers an agent ticket typo and a joined ticket through authenticated MCP reads', async () => {
  const f = await fixture({ agent: true })
  f.computers.splice(0)
  try {
    const input = { suite: 'integration', scope: 'full', partitions: 2, commit: 'c'.repeat(40) }
    const started = CiRunOutputSchema.parse(await f.value(f.agent!, 'ci_run', input))
    const shared = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run', input))
    expect(shared.joined).toBe(true)
    expect(shared.ticketId).toBe(started.ticketId)
    const typo = `${started.ticketId.slice(0, -1)}${started.ticketId.endsWith('0') ? '1' : '0'}`
    for (const client of [f.agent!, f.operator]) {
      for (const tool of ['ci_get', 'ci_logs_read']) {
        const result = await f.call(client, tool, { ticketId: typo })
        expect(result.isError).toBe(true)
        const { error } = JSON.parse((result.content as { text: string }[])[0]!.text)
        expect(error.code).toBe('CI_RUN_NOT_FOUND')
        expect(error.message).toContain(started.ticketId)
        expect(error.details.recentTickets).toEqual([expect.objectContaining({ ticketId: started.ticketId,
          suite: 'integration', scope: 'full', state: 'queued', createdAt: expect.any(String) })])
      }
    }
    const unrelated = await f.connect(CI_GET_ACTIONS)
    const result = await f.call(unrelated, 'ci_get', { ticketId: typo })
    expect(result.isError).toBe(true)
    expect(JSON.parse((result.content as { text: string }[])[0]!.text).error.details.recentTickets).toEqual([])
  } finally { await f.close() }
})
