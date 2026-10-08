import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { JobDefinitionRecord } from '@foreman-code/contracts/job-verification'
import { JobPendingAdmissionSchema, JobQueueTicketSchema, JobQueuePageSchema } from '@foreman-code/contracts/job-admission'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { JobService } from '../src/modules/jobs/service.js'
import { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import { jobComputerHasCapacity } from '../src/modules/jobs/computerSelection.js'
import { jobExecution } from './helpers/jobFixture.js'
import { JobOwnership } from '../src/modules/jobs/ownership.js'
import { SOURCE_AGGREGATE_LIMITS, PostgresSourceReservations } from '../src/modules/sources/reservations.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { ScheduleOperatorCapabilitiesSchema } from '../src/mcp/operator/tools/workflowSchedules.js'

describe.skipIf(!postgresEnabled)('durable build admission queue', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let access: PostgresAccessService
  let writer: Awaited<ReturnType<PostgresAccessService['issue']>>
  let reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  const services: JobService[] = []
  const apps: ReturnType<typeof buildApp>[] = []
  const clients: Client[] = []
  beforeEach(async () => {
    database = await agent3Database()
    access = new PostgresAccessService(database.pool)
    writer = await access.issue({ name: 'Queue writer', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['job_definitions:read', 'job_definitions:write', 'jobs:start', 'jobs:read', 'jobs:cancel',
        'settings:read', 'settings:update', 'capabilities:read'], scope: {} }] })
    reader = await access.issue({ name: 'Queue reader', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['jobs:read', 'capabilities:read'], scope: {} }] })
  }, 60000)
  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map(client => client.close()))
    await Promise.allSettled(apps.splice(0).map(app => app.close()))
    await Promise.allSettled(services.splice(0).map(service => service.closeQueue()))
    await database?.close()
  })
  async function fixture(options: Parameters<typeof buildQueueFixture>[2] = {}) {
    const authority = await access.issue({ name: 'Fixture queue writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: writer.principal.grants })
    const f = await buildQueueFixture(database.pool, authority.principal, options)
    services.push(f.jobs)
    return f
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  function admissionTicketId(result: Awaited<ReturnType<JobService['enqueue']>>) {
    if (result.kind === 'retained-execution') throw new Error('Fresh queue requests must own a queue ticket')
    return result.kind === 'accepted' ? result.ticketId : result.ticket.id
  }
  const command = (definition: JobDefinitionRecord) => ({ commandId: randomUUID(), definitionId: definition.id,
    expectedRevision: definition.revision })
  async function submit(f: Fixture, definition: JobDefinitionRecord) {
    const result = await f.jobs.enqueue(f.principal, 'http', f.workspaceId, command(definition))
    const id = admissionTicketId(result)
    return f.jobs.getQueueTicket(reader.principal, f.workspaceId, id)
  }
  async function ordered(f: Fixture, service = f.jobs) {
    return (await service.listQueue(reader.principal, f.workspaceId))
      .sort((a, b) => Number(BigInt(a.enqueueSequence) - BigInt(b.enqueueSequence)))
  }
  it('serializes five concurrent requests on one heavy slot and advances only after closure and publication', async () => {
    const f = await fixture()
    const definition = await f.save()
    await Promise.all(Array.from({ length: 5 }, () => submit(f, definition)))
    await f.jobs.wakeQueue()
    const original = await ordered(f)
    expect(original).toHaveLength(5)
    expect(f.accept).not.toHaveBeenCalled()
    f.online()
    for (let index = 0; index < original.length; index++) {
      await f.jobs.wakeQueue()
      const tickets = await ordered(f)
      expect(tickets.filter(ticket => ticket.state === 'accepted')).toHaveLength(index + 1)
      expect(tickets[index]!.executionId).toBe(original[index]!.executionId)
      expect(tickets.slice(index + 1).every(ticket => ticket.state === 'waiting')).toBe(true)
      const execution = await f.jobs.getExecution(reader.principal, f.workspaceId, tickets[index]!.executionId)
      expect(execution.operationId).toBe(original[index]!.operationId)
      expect(execution.attemptId).toBe(original[index]!.attemptId)
      if (index === 0) {
        await f.worker.settleProcess(f.workspaceId, execution.id, { attemptId: execution.attemptId, owner: execution.owner }, {
          process: { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true },
          startedAt: execution.createdAt, finishedAt: new Date().toISOString(),
        })
        await f.jobs.wakeQueue()
        expect(f.accept).toHaveBeenCalledTimes(1)
      }
      await f.complete(execution.id)
    }
    expect(f.accept).toHaveBeenCalledTimes(5)
    expect(new Set(f.accept.mock.calls.map(call => call[4].operationId)).size).toBe(5)
  })
  it('replays concurrent duplicate submissions as one ticket and rejects conflicting payloads', async () => {
    const f = await fixture()
    const definition = await f.save()
    const input = command(definition)
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      f.jobs.enqueue(f.principal, 'mcp', f.workspaceId, input)))
    expect(new Set(results.map(result => admissionTicketId(result))).size).toBe(1)
    await expect(f.jobs.enqueue(f.principal, 'http', f.workspaceId, { ...input, expectedRevision: 2 }))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    expect(await ordered(f)).toHaveLength(1)
    f.online()
    await f.jobs.wakeQueue()
    await f.jobs.enqueue(f.principal, 'mcp', f.workspaceId, input)
    expect(f.accept).toHaveBeenCalledTimes(1)
    expect(await f.jobs.listExecutions(reader.principal, f.workspaceId)).toHaveLength(1)
  })
  it('uses the existing dispatch wake path for waiting admission without contacting a worker', async () => {
    const f = await fixture()
    const ticket = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    const unavailable = async () => { throw new Error('Waiting admission must not contact the carrier') }
    const dispatch = new PostgresJobDispatch(database.pool,
      { deliver: unavailable, reconcile: unavailable, control: unavailable },
      { revalidate: async () => {}, authorizeControl: async () => {}, observe: async () => {},
        prepareWaiting: () => f.jobs.wakeQueue() })
    try {
      await dispatch.wake(ticket.executionId)
      expect(f.accept).not.toHaveBeenCalled()
      f.online()
      await dispatch.wake(ticket.executionId)
      expect(f.accept).toHaveBeenCalledTimes(1)
      expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id)).state).toBe('accepted')
    } finally { await dispatch.close() }
  })
  it('cancels an unclaimed ticket without source preparation or worker contact', async () => {
    const f = await fixture()
    const ticket = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    const current = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id)
    const input = { commandId: randomUUID(), ticketId: ticket.id, expectedRevision: current.revision }
    const cancelled = await f.jobs.cancelQueued(writer.principal, 'mcp', f.workspaceId, input)
    expect(cancelled).toMatchObject({ state: 'terminal', terminalReason: 'cancelled', reservationId: null })
    expect(await f.jobs.cancelQueued(writer.principal, 'http', f.workspaceId, input)).toEqual(cancelled)
    f.online()
    await f.jobs.wakeQueue()
    expect(f.accept).not.toHaveBeenCalled()
    expect(f.cancel).not.toHaveBeenCalled()
    expect(f.wake).not.toHaveBeenCalled()
  })
  it('fences multi-owner claim/cancel races so one attempt is admitted at most once', async () => {
    const f = await fixture()
    const ticket = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    const current = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id)
    const second = f.createService()
    services.push(second)
    f.online()
    const results = await Promise.allSettled([f.jobs.wakeQueue(), second.wakeQueue(),
      f.jobs.cancelQueued(writer.principal, 'mcp', f.workspaceId,
        { commandId: randomUUID(), ticketId: ticket.id, expectedRevision: current.revision })])
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'REVISION_CONFLICT' })
    }
    await second.wakeQueue()
    const persisted = await second.getQueueTicket(reader.principal, f.workspaceId, ticket.id)
    expect(f.accept.mock.calls.length).toBeLessThanOrEqual(1)
    expect((await second.listExecutions(reader.principal, f.workspaceId)).length).toBeLessThanOrEqual(1)
    expect(persisted.executionId).toBe(ticket.executionId)
    if (persisted.state === 'terminal') expect(persisted.terminalReason).toBe('cancelled')
    else expect(persisted.state).toBe('accepted')
  })
  it('preserves queued order, identity, saved versions and deadlines after service restart', async () => {
    const f = await fixture()
    const definition = await f.save()
    await Promise.all(Array.from({ length: 3 }, () => submit(f, definition)))
    await f.jobs.closeQueue()
    const before = await ordered(f)
    await f.jobs.saveDefinition(writer.principal, 'http', f.workspaceId, { commandId: randomUUID(),
      id: definition.id, expectedRevision: definition.revision, name: 'Edited build', spec: definition.spec })
    const restarted = f.createService()
    services.push(restarted)
    expect((await ordered(f, restarted)).map(ticket => [ticket.id, ticket.executionId, ticket.attemptId,
      ticket.operationId, ticket.enqueueSequence, ticket.deadlineAt, ticket.definition.versionId]))
      .toEqual(before.map(ticket => [ticket.id, ticket.executionId, ticket.attemptId, ticket.operationId,
        ticket.enqueueSequence, ticket.deadlineAt, ticket.definition.versionId]))
    f.online()
    await restarted.wakeQueue()
    const first = await restarted.getExecution(reader.principal, f.workspaceId, before[0]!.executionId)
    expect(first.acceptedSpec.definitionVersionId).toBe(definition.versionId)
    expect((await ordered(f, restarted)).slice(1).every(ticket => ticket.state === 'waiting')).toBe(true)
  })
  it('retains one preparation owner during cancellation and never accepts a cancelled claimed attempt', async () => {
    const f = await fixture()
    const ticket = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    const prepare = f.accept.getMockImplementation()!
    let resume!: () => void
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { resume = resolve })
    const preparing = new Promise<void>(resolve => { entered = resolve })
    f.accept.mockImplementationOnce(async (...args) => {
      entered()
      await waiting
      return prepare(...args)
    })
    f.online()
    const pending = f.jobs.wakeQueue()
    await preparing
    try {
      const otherOwner = await JobOwnership.acquire(database.pool, ticket.executionId, () => {})
      expect(otherOwner).toBeUndefined()
      await otherOwner?.release()
      const second = f.createService()
      services.push(second)
      await second.wakeQueue()
      const claimed = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id)
      expect(claimed.state).toBe('claimed')
      await f.jobs.cancelQueued(writer.principal, 'mcp', f.workspaceId,
        { commandId: randomUUID(), ticketId: ticket.id, expectedRevision: claimed.revision })
    } finally {
      resume()
      await pending
    }
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id))
      .toMatchObject({ state: 'terminal', terminalReason: 'cancelled' })
    expect(await f.jobs.listExecutions(reader.principal, f.workspaceId)).toHaveLength(0)
    expect(f.accept).toHaveBeenCalledTimes(1)
    expect(f.wake).not.toHaveBeenCalled()
  })
  it('recovers interrupted preparation on the original reservation without rerouting', async () => {
    const f = await fixture({ computerCount: 2 })
    const ticket = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    f.online(0)
    f.accept.mockRejectedValueOnce(new DomainError('SOURCE_TRANSFER_PENDING', 'Transfer interrupted', 503))
    await expect(f.jobs.wakeQueue()).rejects.toMatchObject({ code: 'SOURCE_TRANSFER_PENDING' })
    await f.jobs.closeQueue()
    const original = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id)
    expect(original.state).toBe('claimed')
    f.online(1)
    const restarted = f.createService()
    services.push(restarted)
    await restarted.wakeQueue()
    const execution = await restarted.getExecution(reader.principal, f.workspaceId, ticket.executionId)
    expect(execution).toMatchObject({ id: ticket.executionId, attemptId: ticket.attemptId, operationId: ticket.operationId })
    expect(execution.acceptedSpec.target).toEqual(f.computers[0]!.candidate.spec.target)
    expect(new Set(f.accept.mock.calls.map(call => call[4].operationId)).size).toBe(1)
  })
  it('keeps delayed cleanup active beyond a history page and exposes the scoped claimed computer through HTTP and MCP', async () => {
    const f = await fixture()
    const definition = await f.save()
    const original = await submit(f, definition)
    await f.jobs.wakeQueue()
    const prepare = f.accept.getMockImplementation()!
    let resume!: () => void
    let entered!: () => void
    const paused = new Promise<void>(resolve => { resume = resolve })
    const preparing = new Promise<void>(resolve => { entered = resolve })
    f.accept.mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args)
      entered()
      await paused
      return prepared
    })
    f.online()
    const pending = f.jobs.wakeQueue()
    await preparing
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { jobs: f.jobs, commands: f.commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'claim-readback', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
      return client
    }
    const client = await connect(reader.token)
    let claimed: Awaited<ReturnType<JobService['getQueueTicket']>>
    try {
      claimed = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, original.id)
      const computer = f.computers[0]!.candidate
      expect(claimed).toMatchObject({ state: 'claimed', selectedComputer: {
        target: computer.spec.target, rootId: computer.profile.root.binding.rootId,
        bindingRevision: 1, profileId: computer.profile.id, profileRevision: 1,
      } })
      const read = await client.callTool({ name: 'job_queue_get', arguments: {
        workspaceId: f.workspaceId, ticketId: original.id,
      } })
      expect(read.isError).not.toBe(true)
      expect(read.structuredContent).toEqual({ ticket: claimed })
      const http = await app.inject({ method: 'GET',
        url: `/api/management/workspaces/${f.workspaceId}/jobs/queue/${original.id}`,
        headers: { authorization: `Bearer ${reader.token}` } })
      expect(http.statusCode).toBe(200)
      expect(http.json()).toEqual(read.structuredContent)
      const foreign = await access.issue({ name: 'Foreign claim reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['jobs:read'],
          scope: { workspaceIds: [randomUUID()] } }] })
      const denied = await (await connect(foreign.token)).callTool({ name: 'job_queue_get', arguments: {
        workspaceId: f.workspaceId, ticketId: original.id,
      } })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied)).not.toContain(computer.spec.target.destination.canonicalProjectRoot)
      const deniedHttp = await app.inject({ method: 'GET',
        url: `/api/management/workspaces/${f.workspaceId}/jobs/queue/${original.id}`,
        headers: { authorization: `Bearer ${foreign.token}` } })
      expect(deniedHttp.statusCode).toBe(403)
      await f.jobs.cancelQueued(writer.principal, 'mcp', f.workspaceId, { commandId: randomUUID(),
        ticketId: claimed.id, expectedRevision: claimed.revision })
    } finally {
      resume()
      await pending
    }
    for (let index = 0; index < 105; index++) {
      const submitted = await submit(f, definition)
      await f.jobs.wakeQueue()
      const newer = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, submitted.id)
      await f.jobs.cancelQueued(writer.principal, 'mcp', f.workspaceId, { commandId: randomUUID(),
        ticketId: newer.id, expectedRevision: newer.revision })
    }
    await f.jobs.closeQueue()
    const restarted = f.createService()
    services.push(restarted)
    const ticket = await restarted.getQueueTicket(reader.principal, f.workspaceId, original.id)
    expect(ticket).toMatchObject({ state: 'terminal', terminalReason: 'cancelled', cleanupStatus: 'pending',
      selectedComputer: claimed!.selectedComputer })
    const first = await restarted.listQueuePage(reader.principal, f.workspaceId, { historyLimit: 3 })
    expect(first.tickets.filter(item => item.id === original.id)).toEqual([ticket])
    expect(first.tickets).toHaveLength(4)
    const second = await restarted.listQueuePage(reader.principal, f.workspaceId,
      { historyLimit: 3, historyBeforeSequence: first.nextHistoryCursor! })
    expect(second.tickets.filter(item => item.id === original.id)).toEqual([ticket])
    const listed = await client.callTool({ name: 'job_queue_list', arguments: {
      workspaceId: f.workspaceId, historyLimit: 3,
    } })
    expect(listed.structuredContent).toEqual(first)
    const read = await client.callTool({ name: 'job_queue_get', arguments: {
      workspaceId: f.workspaceId, ticketId: original.id,
    } })
    expect(read.structuredContent).toEqual({ ticket })
    const before = (await database.pool.query('select state from source_execution_materializations where execution_id=$1',
      [ticket.executionId])).rows[0]
    expect(before).toEqual({ state: 'prepared' })
    expect((await database.pool.query('select released_at from job_computer_selections where execution_id=$1',
      [ticket.executionId])).rows[0]).toEqual({ released_at: null })
    expect((await database.pool.query("select state from source_storage_reservations where owner_id=$1",
      [ticket.operationId])).rows[0]).toEqual({ state: 'owned' })
  }, 90000)
  it('admits another computer while preparation is pending and waits for that preparation on shutdown', async () => {
    const f = await fixture({ computerCount: 2 })
    const first = await submit(f, await f.save(f.computers[0]!.candidate.spec))
    await f.jobs.wakeQueue()
    const prepare = f.accept.getMockImplementation()!
    let resume!: () => void
    let entered!: () => void
    const paused = new Promise<void>(resolve => { resume = resolve })
    const preparing = new Promise<void>(resolve => { entered = resolve })
    f.accept.mockImplementationOnce(async (...args) => {
      entered()
      await paused
      return prepare(...args)
    })
    f.online(0)
    f.online(1)
    const pending = f.jobs.wakeQueue()
    await preparing
    let closed = false
    let closing: Promise<void> | undefined
    try {
      const second = await submit(f, await f.save(f.computers[1]!.candidate.spec))
      await vi.waitFor(async () => {
        expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, second.id)).state).toBe('accepted')
      })
      expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, first.id)).state).toBe('claimed')
      expect(f.accept).toHaveBeenCalledTimes(2)
      closing = f.jobs.closeQueue().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
    } finally {
      resume()
      await pending
      await closing
    }
    expect(closed).toBe(true)
    expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, first.id)).state).toBe('accepted')
  })
  it('expires waiting from the original enqueue time and enforces pending limits', async () => {
    let now = new Date()
    const f = await fixture({ maxPendingPerPrincipal: 1, clock: () => now })
    const definition = await f.save()
    const ticket = await submit(f, definition)
    await f.jobs.wakeQueue()
    await expect(submit(f, definition)).rejects.toMatchObject({ code: 'JOB_QUEUE_LIMIT' })
    now = new Date(Date.parse(ticket.deadlineAt))
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id))
      .toMatchObject({ state: 'terminal', terminalReason: 'timed_out', deadlineAt: ticket.deadlineAt })
    expect(f.accept).not.toHaveBeenCalled()
    expect((await submit(f, definition)).id).not.toBe(ticket.id)
  })
  it('never frees an accepted but uncertain execution on service restart or elapsed queue deadline', async () => {
    let now = new Date()
    const f = await fixture({ clock: () => now })
    const definition = await f.save()
    const first = await submit(f, definition)
    const second = await submit(f, definition)
    f.online()
    await f.jobs.wakeQueue()
    await f.jobs.closeQueue()
    now = new Date(Date.parse(second.deadlineAt) - 1)
    const restarted = f.createService()
    services.push(restarted)
    await restarted.wakeQueue()
    expect((await restarted.getQueueTicket(reader.principal, f.workspaceId, second.id)).state).toBe('waiting')
    expect((await restarted.getExecution(reader.principal, f.workspaceId, first.executionId)).transport).toBe('unknown')
    expect(f.accept).toHaveBeenCalledTimes(1)
  })
  it('counts a historical execution until publication and source cleanup finish without a selection record', async () => {
    const f = await fixture()
    const computer = f.computers[0]!
    const definition = await f.save(computer.candidate.spec)
    const identity = { executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID() }
    const prepared = await f.accept(database.pool, f.principal, f.workspaceId, computer.candidate.spec, identity)
    const execution = { ...jobExecution(), id: identity.executionId, workspaceId: f.workspaceId,
      attemptId: identity.attemptId, operationId: identity.operationId,
      acceptedSpec: { ...jobExecution().acceptedSpec, ...prepared,
        definitionId: definition.id, definitionVersionId: definition.versionId } }
    await database.pool.query(`insert into job_executions
      (id,workspace_id,definition_version_id,operation_id,attempt_id,record,accepted_spec,accepted_by)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`, [execution.id, f.workspaceId,
      definition.versionId, execution.operationId, execution.attemptId, JSON.stringify(execution),
      JSON.stringify(execution.acceptedSpec), f.principal.id])
    const capacity = () => jobComputerHasCapacity(database.pool, computer.candidate.spec.target, computer.candidate.profile)
    expect(await capacity()).toBe(false)
    const fence = { attemptId: execution.attemptId, owner: execution.owner }
    await f.worker.settleProcess(f.workspaceId, execution.id, fence, {
      process: { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true },
      startedAt: execution.createdAt, finishedAt: new Date().toISOString(),
    })
    expect(await capacity()).toBe(false)
    await f.worker.publication(f.workspaceId, execution.id, fence, { state: 'complete', issue: null })
    expect(await capacity()).toBe(false)
    await f.complete(execution.id)
    expect(await capacity()).toBe(true)
    expect((await database.pool.query('select 1 from job_computer_selections where execution_id=$1',
      [execution.id])).rowCount).toBe(0)
  })
  it('keeps an explicit disabled target blocked while another computer admits an Auto Job', async () => {
    const f = await fixture({ computerCount: 2 })
    const fixed = await submit(f, await f.save(f.computers[0]!.candidate.spec))
    await f.jobs.wakeQueue()
    const current = await f.settings.read(writer.principal, { target: f.computers[0]!.target })
    await f.settings.update(writer.principal, 'http', { target: f.computers[0]!.target,
      commandId: randomUUID(), expectedRevision: current.preference.revision, buildEnabled: false, buildPriority: 100 })
    const automatic = await submit(f, await f.save())
    f.online(0)
    f.online(1)
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, fixed.id))
      .toMatchObject({ state: 'blocked', waitingReasons: ['disabled'], reservationId: null })
    expect((await f.jobs.getExecution(reader.principal, f.workspaceId, automatic.executionId)).acceptedSpec.target)
      .toEqual(f.computers[1]!.candidate.spec.target)
  })
  it.each(['fixed-to-explicit', 'fixed-to-auto', 'auto-to-explicit'] as const)(
    'places %s through the selector and retains the saved definition and idempotent request', async mode => {
      const f = await fixture({ computerCount: 2 })
      await f.settings.update(f.principal, 'http', { target: f.computers[0]!.target,
        commandId: randomUUID(), expectedRevision: 1, buildEnabled: true, buildPriority: 1 })
      const definition = await f.save(mode === 'auto-to-explicit' ? f.computers[0]!.auto : f.computers[0]!.candidate.spec)
      const placementOverride = mode === 'fixed-to-auto' ? { kind: 'auto' as const }
        : { kind: 'explicit' as const, target: f.computers[1]!.candidate.spec.target }
      const input = { ...command(definition), placementOverride }
      const result = await f.jobs.enqueue(f.principal, 'mcp', f.workspaceId, input)
      const id = admissionTicketId(result)
      await f.jobs.wakeQueue()
      f.online(0)
      f.online(1)
      await f.jobs.wakeQueue()
      const ticket = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, id)
      const execution = await f.jobs.getExecution(reader.principal, f.workspaceId, ticket.executionId)
      expect(ticket).toMatchObject({ state: 'accepted', definition, placement: placementOverride, placementOverride })
      expect(execution.acceptedSpec).toMatchObject({ target: f.computers[1]!.candidate.spec.target,
        definitionVersionId: definition.versionId, source: definition.spec.source,
        argv: definition.spec.argv, outputs: definition.spec.outputs,
        policy: { imageDigest: definition.spec.policy.imageDigest, network: definition.spec.policy.network } })
      expect(await f.jobs.getDefinition(f.principal, f.workspaceId, definition.id)).toEqual(definition)
      expect(await f.jobs.enqueue(f.principal, 'http', f.workspaceId, input))
        .toEqual({ kind: 'accepted', ticketId: ticket.id, executionId: ticket.executionId })
      await expect(f.jobs.enqueue(f.principal, 'mcp', f.workspaceId, { ...input,
        placementOverride: { kind: 'explicit', target: f.computers[0]!.candidate.spec.target } }))
        .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
      expect(f.accept).toHaveBeenCalledOnce()
    })
  it('keeps an override blocked when its computer does not satisfy the saved network policy', async () => {
    const f = await fixture({ computerCount: 2 })
    const definition = await f.save(f.computers[0]!.candidate.spec)
    f.computers[1]!.candidate.spec.policy.network = 'approved-dependency-fetch'
    f.online(0)
    f.online(1)
    const result = await f.jobs.enqueue(f.principal, 'mcp', f.workspaceId, { ...command(definition),
      placementOverride: { kind: 'explicit', target: f.computers[1]!.candidate.spec.target } })
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, admissionTicketId(result)))
      .toMatchObject({ state: 'blocked', reservationId: null, waitingReasons: ['incompatible'] })
    expect(f.accept).not.toHaveBeenCalled()
  })
  it('terminates admission after principal revocation rather than reporting busy', async () => {
    const authority = await access.issue({ name: 'Revocable queue writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: writer.principal.grants })
    const f = await buildQueueFixture(database.pool, authority.principal)
    services.push(f.jobs)
    const definition = await f.save()
    const result = await f.jobs.enqueue(authority.principal, 'http', f.workspaceId, command(definition))
    const id = admissionTicketId(result)
    await f.jobs.wakeQueue()
    await access.revoke(authority.principal.id)
    f.online()
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, id))
      .toMatchObject({ state: 'terminal', terminalReason: 'authorization_revoked' })
    expect(f.accept).not.toHaveBeenCalled()
  })
  it('terminates a request that exceeds empty storage capacity and reports expired qualification as blocked', async () => {
    const f = await fixture()
    const first = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    f.computers[0]!.candidate.sourceReservation.reservedBytes = SOURCE_AGGREGATE_LIMITS.bytes + 1
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, first.id))
      .toMatchObject({ state: 'terminal', terminalReason: 'request_exceeds_maximum' })
    f.computers[0]!.candidate.sourceReservation.reservedBytes = 2097152
    f.computers[0]!.candidate.reasons = ['qualification_expired']
    const second = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, second.id))
      .toMatchObject({ state: 'blocked', waitingReasons: ['qualification_expired'] })
    expect(f.accept).not.toHaveBeenCalled()
  })
  it('keeps Auto waiting for an authorized computer when another matching profile is revoked', async () => {
    const f = await fixture({ computerCount: 2 })
    f.computers[0]!.candidate.reasons = ['authorization_revoked']
    const ticket = await submit(f, await f.save())
    await f.jobs.wakeQueue()
    expect(await f.jobs.getQueueTicket(reader.principal, f.workspaceId, ticket.id))
      .toMatchObject({ state: 'waiting', waitingReasons: ['offline'] })
    f.online(1)
    await f.jobs.wakeQueue()
    const execution = await f.jobs.getExecution(reader.principal, f.workspaceId, ticket.executionId)
    expect(execution.acceptedSpec.target).toEqual(f.computers[1]!.candidate.spec.target)
    expect(f.accept).toHaveBeenCalledOnce()
  })
  it('bounds backfill of an older storage-constrained Job while allowing unrelated computers', async () => {
    const f = await fixture({ maxBackfillClaims: 1 })
    const oldSpec = { ...f.computers[0]!.auto, argv: ['node', 'large-build.mjs'] }
    const older = await submit(f, await f.save(oldSpec))
    const smaller = await f.save()
    const firstSmall = await submit(f, smaller)
    const secondSmall = await submit(f, smaller)
    await f.jobs.wakeQueue()
    const reservations = new PostgresSourceReservations()
    const retained = await reservations.reserve(database.pool, { ownerKind: 'capture', ownerId: randomUUID(),
      scopeId: f.computers[0]!.candidate.sourceReservation.scopeId, reservedBytes: SOURCE_AGGREGATE_LIMITS.bytes / 2 })
    await reservations.retain(database.pool, retained, 'retained')
    f.inventory.candidates.mockImplementation(async (_sql, _principal, _workspace, spec) => ({ candidates: [{
      ...f.computers[0]!.candidate, spec: { ...f.computers[0]!.candidate.spec, argv: spec.argv },
      sourceReservation: { ...f.computers[0]!.candidate.sourceReservation,
        reservedBytes: spec.argv[1] === 'large-build.mjs' ? SOURCE_AGGREGATE_LIMITS.bytes * 0.75 : 2097152 },
    }], diagnosticCodes: [] }))
    f.online()
    await f.jobs.wakeQueue()
    expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, firstSmall.id)).state).toBe('accepted')
    await f.complete(firstSmall.executionId)
    await f.jobs.wakeQueue()
    expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, secondSmall.id)).state).toBe('waiting')
    expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, older.id)).state).toBe('waiting')
    await reservations.reclaimed(database.pool, retained, async () => true)
    await f.jobs.wakeQueue()
    expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, older.id)).state).toBe('accepted')
  })
  it('exposes the same persisted queue via authenticated HTTP/MCP and denies read-only and foreign-workspace writes', async () => {
    const f = await fixture()
    const definition = await f.save()
    const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { jobs: f.jobs, commands: f.commands } as unknown as OperatorServices } })
    apps.push(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'queue-tests', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
      return client
    }
    const client = await connect(writer.token)
    const readOnly = await connect(reader.token)
    const tools = (await client.listTools()).tools.map(tool => tool.name)
    expect(tools).toEqual(expect.arrayContaining(['job_queue_get', 'job_queue_list', 'job_queue_cancel']))
    const readerTools = (await readOnly.listTools()).tools.map(tool => tool.name)
    expect(readerTools).toEqual(expect.arrayContaining(['job_queue_get', 'job_queue_list']))
    expect(readerTools).not.toContain('job_queue_cancel')
    const capabilities = await client.callTool({ name: 'operator_get_capabilities', arguments: {
      workspaceId: f.workspaceId,
    } })
    expect(capabilities.isError).not.toBe(true)
    const capabilitySummary = ScheduleOperatorCapabilitiesSchema.parse(capabilities.structuredContent)
    expect(capabilitySummary.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'job_queue_get', actions: ['jobs:read'] }),
      expect.objectContaining({ name: 'job_queue_list', actions: ['jobs:read'] }),
      expect.objectContaining({ name: 'job_queue_cancel', actions: ['jobs:cancel'] }),
    ]))
    const input = { workspaceId: f.workspaceId, ...command(definition) }
    const denied = await readOnly.callTool({ name: 'job_start', arguments: input })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await ordered(f)).toHaveLength(0)
    const started = await client.callTool({ name: 'job_start', arguments: input })
    expect(started.isError).not.toBe(true)
    const { admission } = z.object({ admission: JobPendingAdmissionSchema }).parse(started.structuredContent)
    expect(admission.kind).toBe('pending-admission')
    await f.jobs.wakeQueue()
    const retried = await client.callTool({ name: 'job_start', arguments: input })
    expect(retried.isError).not.toBe(true)
    const retry = z.object({ admission: JobPendingAdmissionSchema }).parse(retried.structuredContent)
    expect(retry.admission.ticket.id).toBe(admission.ticket.id)
    await f.jobs.wakeQueue()
    const read = await readOnly.callTool({ name: 'job_queue_get', arguments: {
      workspaceId: f.workspaceId, ticketId: admission.ticket.id,
    } })
    expect(read.isError).not.toBe(true)
    const persisted = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, admission.ticket.id)
    expect(read.structuredContent).toEqual({ ticket: persisted })
    const http = await app.inject({ method: 'GET',
      url: `/api/management/workspaces/${f.workspaceId}/jobs/queue/${persisted.id}`,
      headers: { authorization: `Bearer ${reader.token}` } })
    expect(http.statusCode).toBe(200)
    expect(http.json()).toEqual(read.structuredContent)
    const listed = await readOnly.callTool({ name: 'job_queue_list', arguments: { workspaceId: f.workspaceId } })
    const httpList = await app.inject({ method: 'GET',
      url: `/api/management/workspaces/${f.workspaceId}/jobs/queue`,
      headers: { authorization: `Bearer ${reader.token}` } })
    expect(httpList.statusCode).toBe(200)
    expect(httpList.json()).toEqual(listed.structuredContent)
    const { workspaceId, ...body } = input
    const crossTransport = await app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/jobs/executions`,
      headers: { authorization: `Bearer ${writer.token}` }, payload: body })
    expect(crossTransport.statusCode).toBe(200)
    expect(crossTransport.json().admission).toMatchObject({ kind: 'pending-admission', ticket: { id: persisted.id } })
    const deniedHttp = await app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/jobs/executions`,
      headers: { authorization: `Bearer ${reader.token}` }, payload: { ...body, commandId: randomUUID() } })
    expect(deniedHttp.statusCode).toBe(403)
    expect(deniedHttp.json().error.code).toBe('ACCESS_DENIED')
    const overrideInput = { ...input, commandId: randomUUID(),
      placementOverride: { kind: 'explicit', target: f.computers[0]!.candidate.spec.target } }
    expect((await readOnly.callTool({ name: 'job_start', arguments: overrideInput })).isError).toBe(true)
    const override = await client.callTool({ name: 'job_start', arguments: overrideInput })
    expect(override.isError).not.toBe(true)
    const overrideAdmission = z.object({ admission: JobPendingAdmissionSchema }).parse(override.structuredContent)
    expect((await client.callTool({ name: 'job_start', arguments: overrideInput })).structuredContent)
      .toMatchObject({ admission: { ticket: { id: overrideAdmission.admission.ticket.id } } })
    await f.jobs.wakeQueue()
    const overrideTicket = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, overrideAdmission.admission.ticket.id)
    expect(overrideTicket).toMatchObject({ placement: overrideInput.placementOverride,
      placementOverride: overrideInput.placementOverride, definition })
    const overrideRead = await readOnly.callTool({ name: 'job_queue_get', arguments: {
      workspaceId: f.workspaceId, ticketId: overrideTicket.id,
    } })
    expect(overrideRead.structuredContent).toEqual({ ticket: overrideTicket })
    await f.jobs.cancelQueued(writer.principal, 'mcp', f.workspaceId, { commandId: randomUUID(),
      ticketId: overrideTicket.id, expectedRevision: overrideTicket.revision })
    const cancellationTicket = await f.jobs.getQueueTicket(reader.principal, f.workspaceId, persisted.id)
    const cancelInput = { workspaceId: f.workspaceId, commandId: randomUUID(), ticketId: persisted.id,
      expectedRevision: cancellationTicket.revision }
    expect((await readOnly.callTool({ name: 'job_queue_cancel', arguments: cancelInput })).isError).toBe(true)
    const foreign = await access.issue({ name: 'Other workspace', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['jobs:read', 'jobs:start', 'jobs:cancel'],
        scope: { workspaceIds: [randomUUID()] } }] })
    const foreignClient = await connect(foreign.token)
    expect((await foreignClient.callTool({ name: 'job_queue_get', arguments: {
      workspaceId: f.workspaceId, ticketId: persisted.id,
    } })).isError).toBe(true)
    expect((await foreignClient.callTool({ name: 'job_queue_list', arguments: { workspaceId: f.workspaceId } })).isError).toBe(true)
    expect((await foreignClient.callTool({ name: 'job_start', arguments: { ...input, commandId: randomUUID() } })).isError).toBe(true)
    expect((await foreignClient.callTool({ name: 'job_queue_cancel', arguments: cancelInput })).isError).toBe(true)
    const noGrants = await access.issue({ name: 'No Job grants', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['capabilities:read'], scope: {} }] })
    const hidden = await connect(noGrants.token)
    for (const name of ['job_queue_get', 'job_queue_list', 'job_queue_cancel']) {
      const denied = await hidden.callTool({ name, arguments: cancelInput })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      expect((await database.pool.query(`select 1 from management_audit
        where principal_id=$1 and action=$2 and outcome='denied'`, [noGrants.principal.id, name])).rows.length).toBeGreaterThan(0)
    }
    const deniedCancel = await app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/jobs/queue/${persisted.id}/cancel`,
      headers: { authorization: `Bearer ${reader.token}` },
      payload: { commandId: randomUUID(), expectedRevision: cancelInput.expectedRevision } })
    expect(deniedCancel.statusCode).toBe(403)
    const staleCancel = await client.callTool({ name: 'job_queue_cancel', arguments: {
      ...cancelInput, commandId: randomUUID(), expectedRevision: cancelInput.expectedRevision + 1,
    } })
    expect(staleCancel.isError).toBe(true)
    expect(JSON.stringify(staleCancel.content)).toContain('REVISION_CONFLICT')
    const cancelled = await client.callTool({ name: 'job_queue_cancel', arguments: cancelInput })
    expect(cancelled.isError).not.toBe(true)
    const cancellation = z.object({ ticket: JobQueueTicketSchema }).parse(cancelled.structuredContent)
    expect(cancellation.ticket).toMatchObject({ state: 'terminal', terminalReason: 'cancelled' })
    const cancelledHttp = await app.inject({ method: 'POST',
      url: `/api/management/workspaces/${workspaceId}/jobs/queue/${persisted.id}/cancel`,
      headers: { authorization: `Bearer ${writer.token}` },
      payload: { commandId: cancelInput.commandId, expectedRevision: cancelInput.expectedRevision } })
    expect(cancelledHttp.statusCode).toBe(200)
    expect(cancelledHttp.json()).toEqual(cancelled.structuredContent)
    expect((await readOnly.callTool({ name: 'job_queue_get', arguments: {
      workspaceId, ticketId: persisted.id,
    } })).structuredContent).toEqual(cancelled.structuredContent)
    expect(f.accept).not.toHaveBeenCalled()
    const next = await client.callTool({ name: 'job_start', arguments: { ...input, commandId: randomUUID() } })
    expect(next.isError).not.toBe(true)
    const nextTicket = z.object({ admission: JobPendingAdmissionSchema }).parse(next.structuredContent).admission.ticket
    f.online()
    await f.jobs.wakeQueue()
    const executed = await readOnly.callTool({ name: 'job_get', arguments: {
      workspaceId: f.workspaceId, executionId: nextTicket.executionId,
    } })
    expect(executed.isError).not.toBe(true)
    expect(executed.structuredContent).toEqual({
      execution: await f.jobs.getExecution(reader.principal, f.workspaceId, nextTicket.executionId),
    })
    expect(f.accept).toHaveBeenCalledTimes(1)
    const acceptedRetry = await client.callTool({ name: 'job_start', arguments: {
      ...input, commandId: nextTicket.commandId,
    } })
    expect(acceptedRetry.structuredContent).toEqual({ admission: {
      kind: 'accepted', ticketId: nextTicket.id, executionId: nextTicket.executionId,
    } })
    expect(f.accept).toHaveBeenCalledTimes(1)
  }, 60000)
  it('discovers old active requests alongside paginated history through HTTP and authenticated MCP', async () => {
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
      const page = JobQueuePageSchema.parse(response.structuredContent)
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
    expect(cancelled.structuredContent).toEqual({ ticket:
      await f.jobs.getQueueTicket(reader.principal, f.workspaceId, active.id) })
    expect((await f.jobs.getQueueTicket(reader.principal, f.workspaceId, active.id)).terminalReason).toBe('cancelled')
  }, 60000)
})
