import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentCiReportSchema, readAgentCiReport, readCiLog,
  requireCiStateOrder } from './helpers/crossComputerCiReadback.js'

function report() {
  const ticketId = randomUUID()
  return { ticketId, groupId: randomUUID(), suite: 'build', outcome: 'passed', repository: 'example/project',
    branch: 'foreman/ci-agent', tickets: [{ ticketId, part: 'build-api', partition: null,
      computer: { kind: 'cloud', mainId: randomUUID(), provider: 'github', slot: 1 },
      commit: 'a'.repeat(40), outcome: 'passed', exitCode: 0, logLine: 'Build passed',
      observedStates: ['queued', 'running', 'passed'] }] }
}

it('reads a complete cloud and physical-computer Agent report from a native text envelope', () => {
  const value = report()
  value.tickets.push({ ...value.tickets[0]!, ticketId: randomUUID(), part: 'build-other' })
  expect(readAgentCiReport({ text: JSON.stringify(value) })).toEqual(value)
  expect(readAgentCiReport(value)).toEqual(value)
  expect(readAgentCiReport({ text: JSON.stringify({ routing: { kind: 'finish' }, data: { latestDeliverable: value } }) }))
    .toEqual(value)
  const physical = { ...value, tickets: value.tickets.map(ticket => ({ ...ticket,
    computer: { kind: 'device', mainId: ticket.computer.mainId, deviceId: randomUUID() } })) }
  expect(AgentCiReportSchema.safeParse(physical).success).toBe(true)
})

it('rejects duplicate tickets, a missing root ticket and incomplete cloud identities', () => {
  const value = report()
  expect(AgentCiReportSchema.safeParse({ ...value, tickets: [value.tickets[0], value.tickets[0]] }).success).toBe(false)
  expect(AgentCiReportSchema.safeParse({ ...value, ticketId: randomUUID() }).success).toBe(false)
  const computer = { kind: 'cloud', mainId: randomUUID(), provider: 'github' }
  expect(AgentCiReportSchema.safeParse({ ...value, tickets: [{ ...value.tickets[0], computer }] }).success).toBe(false)
})

it('requires a terminal CI lifecycle and rejects regression to queued work', () => {
  expect(() => requireCiStateOrder(['queued', 'starting', 'running', 'passed'])).not.toThrow()
  expect(() => requireCiStateOrder(['starting', 'failed'])).not.toThrow()
  expect(() => requireCiStateOrder(['queued', 'running'])).toThrow()
  expect(() => requireCiStateOrder(['running', 'queued', 'passed'])).toThrow()
  expect(() => requireCiStateOrder(['unknown', 'passed'])).toThrow()
  expect(() => requireCiStateOrder(['failed', 'passed'])).toThrow()
})

it('reads the full ticket log by following byte offsets through public MCP', async () => {
  const callTool = vi.fn()
    .mockResolvedValueOnce({ content: [], structuredContent: { text: 'first\n', nextOffset: 6, logBytes: 11, maxBytes: 65_536 } })
    .mockResolvedValueOnce({ content: [], structuredContent: { text: 'last\n', nextOffset: 11, logBytes: 11, maxBytes: 65_536 } })
  const scope = { workspaceId: 'workspace', ticketId: randomUUID() }
  expect(await readCiLog({ callTool }, scope))
    .toEqual({ text: 'first\nlast\n', logBytes: 11 })
  expect(callTool.mock.calls.map(call => call[0])).toEqual([
    { name: 'ci_logs_read', arguments: { ...scope, afterOffset: 0, maxBytes: 65_536 } },
    { name: 'ci_logs_read', arguments: { ...scope, afterOffset: 6, maxBytes: 65_536 } },
  ])
})

it('fails when a log reader stops advancing before the log is complete', async () => {
  const callTool = vi.fn().mockResolvedValue({ content: [], structuredContent: { text: '', nextOffset: 0, logBytes: 11, maxBytes: 65_536 } })
  await expect(readCiLog({ callTool }, {
    workspaceId: 'workspace', ticketId: randomUUID(),
  })).rejects.toThrow('advance')
  expect(callTool).toHaveBeenCalledTimes(1)
})
