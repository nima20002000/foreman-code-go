import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { JobQueuePageSchema } from '@foreman-code/contracts/job-admission'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { setupJobAdmissionQueue } from './helpers/jobAdmissionQueue.js'

describe.skipIf(!postgresEnabled)('durable build admission queue: pagination', () => {
  const queue = setupJobAdmissionQueue()
  const { apps, clients, fixture, submit } = queue

  it('discovers old active requests alongside paginated history through HTTP and authenticated MCP', async () => {
    const { access, writer, reader } = queue
    const f = await fixture({ computerCount: 2 })
    f.computers[0]!.candidate.spec.policy.queueTimeoutMs = 600000
    f.computers[0]!.candidate.profile.policy.queueTimeoutMs = 600000
    const active = await submit(f, await f.save(f.computers[0]!.candidate.spec))
    await f.jobs.wakeQueue()
    const setting = await f.settings.read(writer.principal, { target: f.computers[0]!.target })
    await f.settings.update(writer.principal, 'http', { target: f.computers[0]!.target,
      commandId: randomUUID(), expectedRevision: setting.preference.revision,
      buildEnabled: false, buildPriority: 100 })
    const definition = await f.save(f.computers[1]!.candidate.spec)
    const completed: string[] = []
    for (let index = 0; index < 105; index++) {
      const ticket = await submit(f, definition)
      const cancelled = await f.jobs.cancelQueued(writer.principal, 'http', f.workspaceId,
        { commandId: randomUUID(), ticketId: ticket.id, expectedRevision: ticket.revision })
      expect(cancelled.state).toBe('terminal')
      completed.push(ticket.id)
    }
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { jobs: f.jobs, commands: f.commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const client = new Client({ name: 'queue-history-tests', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${writer.token}` } } }))
    const found: string[] = []
    let cursor: string | null = null
    do {
      const input = { workspaceId: f.workspaceId, historyLimit: 10,
        ...(cursor ? { historyBeforeSequence: cursor } : {}) }
      const response = await client.callTool({ name: 'job_queue_list', arguments: input })
      expect(response.isError).not.toBe(true)
      const page = JobQueuePageSchema.parse(decodeMcpToolResult(response))
      expect(page.tickets.find(ticket => ticket.id === active.id)).toMatchObject({ state: 'blocked' })
      const query = new URLSearchParams({ historyLimit: '10' })
      if (cursor) query.set('historyBeforeSequence', cursor)
      const http = await app.inject({ method: 'GET',
        url: `/api/management/workspaces/${f.workspaceId}/jobs/queue?${query}`,
        headers: { authorization: `Bearer ${reader.token}` } })
      expect(http.statusCode).toBe(200)
      expect(http.json()).toEqual(page)
      found.push(...page.tickets.filter(ticket => ticket.id !== active.id).map(ticket => ticket.id))
      cursor = page.nextHistoryCursor
    } while (cursor)
    expect(found).toEqual(completed.toReversed())
    const current = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, active.id)
    const cancelled = await client.callTool({ name: 'job_queue_cancel', arguments: {
      workspaceId: f.workspaceId, ticketId: current.id, expectedRevision: current.revision,
      commandId: randomUUID(),
    } })
    expect(cancelled.isError).not.toBe(true)
    expect(decodeMcpToolResult(cancelled)).toEqual({ ticket:
      await f.jobs.getQueueTicket(reader.principal, f.workspaceId, active.id) })
    expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, active.id)).terminalReason).toBe('cancelled')
  }, 60000)
})
