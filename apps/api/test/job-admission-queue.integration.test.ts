import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { JobDefinition } from '@graphql/contracts/jobs'
import type { JobQueueTicket } from '@graphql/contracts/job-admission'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { JobService } from '../src/modules/jobs/service.js'
import { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import { JobOwnership } from '../src/modules/jobs/ownership.js'
import { SOURCE_AGGREGATE_LIMITS, PostgresSourceReservations } from '../src/modules/sources/reservations.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('durable build admission queue', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let access: PostgresAccessService
  let writer: Awaited<ReturnType<PostgresAccessService['issue']>>
  let reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  const services: JobService[] = []
  const apps: ReturnType<typeof buildApp>[] = []
  const clients: Client[] = []
  beforeAll(async () => {
    database = await agent3Database()
    access = new PostgresAccessService(database.pool)
    writer = await access.issue({ name: 'Queue writer', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['job_definitions:read', 'job_definitions:write', 'jobs:start', 'jobs:read', 'jobs:cancel',
        'settings:read', 'settings:update', 'capabilities:read'], scope: {} }] })
    reader = await access.issue({ name: 'Queue reader', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['jobs:read', 'capabilities:read'], scope: {} }] })
  }, 60000)
  afterAll(async () => {
    await Promise.allSettled(clients.map(client => client.close()))
    await Promise.allSettled(apps.map(app => app.close()))
    await Promise.allSettled(services.map(service => service.closeQueue()))
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
  const command = (definition: JobDefinition) => ({ commandId: randomUUID(), definitionId: definition.id,
    expectedRevision: definition.revision })
  async function submit(f: Fixture, definition: JobDefinition) {
    const result = await f.jobs.enqueue(f.principal, 'http', f.workspaceId, command(definition))
    const id = result.kind === 'accepted' ? result.ticketId : result.ticket.id
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
    expect(new Set(results.map(result => result.kind === 'accepted' ? result.ticketId : result.ticket.id)).size).toBe(1)
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
  it('terminates admission after principal revocation rather than reporting busy', async () => {
    const authority = await access.issue({ name: 'Revocable queue writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: writer.principal.grants })
    const f = await buildQueueFixture(database.pool, authority.principal)
    services.push(f.jobs)
    const definition = await f.save()
    const result = await f.jobs.enqueue(authority.principal, 'http', f.workspaceId, command(definition))
    const id = result.kind === 'accepted' ? result.ticketId : result.ticket.id
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
    f.inventory.candidates.mockImplementation(async (_sql, _principal, _workspace, spec) => [{
      ...f.computers[0]!.candidate, spec: { ...f.computers[0]!.candidate.spec, argv: spec.argv },
      sourceReservation: { ...f.computers[0]!.candidate.sourceReservation,
        reservedBytes: spec.argv[1] === 'large-build.mjs' ? SOURCE_AGGREGATE_LIMITS.bytes * 0.75 : 2097152 },
    }])
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
    const input = { workspaceId: f.workspaceId, ...command(definition) }
    const denied = await readOnly.callTool({ name: 'job_start', arguments: input })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await ordered(f)).toHaveLength(0)
    const started = await client.callTool({ name: 'job_start', arguments: input })
    expect(started.isError).not.toBe(true)
    const admission = started.structuredContent?.admission as { kind: 'pending-admission'; ticket: JobQueueTicket }
    expect(admission.kind).toBe('pending-admission')
    await f.jobs.wakeQueue()
    const retried = await client.callTool({ name: 'job_start', arguments: input })
    expect(retried.isError).not.toBe(true)
    expect((retried.structuredContent?.admission as { ticket: JobQueueTicket }).ticket.id).toBe(admission.ticket.id)
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
    const cancelInput = { workspaceId: f.workspaceId, commandId: randomUUID(), ticketId: persisted.id,
      expectedRevision: persisted.revision }
    expect((await readOnly.callTool({ name: 'job_queue_cancel', arguments: cancelInput })).isError).toBe(true)
    const foreign = await access.issue({ name: 'Other workspace', audience: 'operator',
      expiresAt: new Date(Date.now() + 300000), grants: [{ actions: ['jobs:read', 'jobs:start', 'jobs:cancel'],
        scope: { workspaceIds: [randomUUID()] } }] })
    const foreignClient = await connect(foreign.token)
    expect((await foreignClient.callTool({ name: 'job_queue_get', arguments: {
      workspaceId: f.workspaceId, ticketId: persisted.id,
    } })).isError).toBe(true)
    const cancelled = await client.callTool({ name: 'job_queue_cancel', arguments: cancelInput })
    expect(cancelled.isError).not.toBe(true)
    expect(cancelled.structuredContent?.ticket).toMatchObject({ state: 'terminal', terminalReason: 'cancelled' })
    expect(f.accept).not.toHaveBeenCalled()
    const next = await client.callTool({ name: 'job_start', arguments: { ...input, commandId: randomUUID() } })
    expect(next.isError).not.toBe(true)
    const nextTicket = (next.structuredContent?.admission as { ticket: JobQueueTicket }).ticket
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
  })
})
