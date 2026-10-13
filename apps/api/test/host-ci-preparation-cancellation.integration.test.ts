import { CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('persists pending MCP cancellation during host preparation and confirms cleanup afterward', async () => {
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
  let dispatch: Promise<void> | undefined
  let cancellation: ReturnType<typeof f.call> | undefined
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    const result = CiRunOutputSchema.parse(await f.value(f.operator, 'ci_run',
      { suite: 'install', commandId: 'preparing-cancel' }))
    await preparing
    dispatch = f.ci.dispatch()
    const commandId = randomUUID()
    expect((await f.call(reader, 'ci_cancel', { ticketId: result.ticketId })).isError).toBe(true)
    cancellation = f.call(f.operator, 'ci_cancel', { ticketId: result.ticketId, commandId })
    await expect.poll(async () => {
      const response = await reader.callTool({ name: 'ci_get',
        arguments: { workspaceId: f.workspaceId, ticketId: result.ticketId } })
      expect(response.isError).not.toBe(true)
      return CiGetOutputSchema.parse(decodeMcpToolResult(response)).run.cancellation
    }).toMatchObject({ source: 'mcp', commandId, reason: 'direct' })
    const cancellationResult = await cancellation
    expect(cancellationResult.isError).toBe(true)
    expect(decodeMcpToolResult(cancellationResult)).toMatchObject({ error: { code: 'CI_CANCEL_PENDING' } })
    const pending = await reader.callTool({ name: 'ci_get',
      arguments: { workspaceId: f.workspaceId, ticketId: result.ticketId } })
    expect(pending.isError).not.toBe(true)
    const pendingRun = CiGetOutputSchema.parse(decodeMcpToolResult(pending)).run
    expect(pendingRun).toMatchObject({ state: 'starting', cancellation: {
      source: 'mcp', commandId, reason: 'direct',
    } })
    expect((await f.pool.query('select record from ci_runs where id=$1', [result.ticketId])).rows[0].record)
      .toEqual(pendingRun)
    release()
    await dispatch
    await f.ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value(reader, 'ci_get', { ticketId: result.ticketId }))
    expect(read.run).toMatchObject({ state: 'canceled' })
    expect(read.run.cancellation).toBeUndefined()
    expect((await f.pool.query('select record,host_key from ci_runs where id=$1', [result.ticketId])).rows[0])
      .toEqual({ record: read.run, host_key: null })
    expect(f.started).toHaveLength(1)
    for (const computer of f.computers) {
      const reply = await f.endpoint.request(computer, { operation: 'status' })
      expect(reply.operation === 'status' && reply.runs.some(run => ['starting', 'running'].includes(run.state))).toBe(false)
    }
  } finally {
    release()
    try {
      await cancellation
    } finally {
      try {
        await dispatch
      } finally {
        await f.close()
      }
    }
  }
})
