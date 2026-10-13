import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('reports pending MCP cancellation during host preparation and confirms cleanup after dispatch', async () => {
  const f = await fixture()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const preparing = new Promise<void>(resolve => { entered = resolve })
  const request = f.endpoint.request.bind(f.endpoint)
  f.endpoint.request = async (computer, input) => {
    if (input.operation === 'start') { entered(); await gate }
    return request(computer, input)
  }
  let cancellation: ReturnType<typeof f.call> | undefined
  try {
    const result = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run',
      { suite: 'install', commandId: 'preparing-cancel' }))
    await preparing
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader, 'ci_cancel', { ticketId: result.ticketId })).isError).toBe(true)
    cancellation = f.call(f.operator, 'ci_cancel', { ticketId: result.ticketId })
    await expect.poll(async () => {
      const response = await reader.callTool({ name: 'ci_get',
        arguments: { workspaceId: f.workspaceId, ticketId: result.ticketId } })
      expect(response.isError).not.toBe(true)
      return CiGetOutputSchema.parse(decodeMcpToolResult(response)).run.cancellation
    }).toMatchObject({ source: 'mcp', reason: 'direct' })
    const pending = await cancellation
    expect(pending.isError).toBe(true)
    expect(decodeMcpToolResult(pending)).toMatchObject({ error: { code: 'CI_CANCEL_PENDING' } })
    release()
    await f.ci.dispatch()
    expect(CiGetOutputSchema.parse(await f.value(f.operator, 'ci_get', { ticketId: result.ticketId })).run.state)
      .toBe('canceled')
    for (const computer of f.computers) {
      const reply = await f.endpoint.request(computer, { operation: 'status' })
      expect(reply.operation === 'status' && reply.runs.some(run => ['starting', 'running'].includes(run.state))).toBe(false)
    }
  } finally {
    release()
    try {
      await cancellation
    } finally {
      await f.close()
    }
  }
})
