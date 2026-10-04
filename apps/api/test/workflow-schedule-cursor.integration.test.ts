import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ScheduleGetResultSchema, ScheduleSaveResultSchema,
  type ScheduleConfiguration, type ScheduleSaveResult,
} from '@graphql/contracts/schedules'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { WorkflowScheduleDispatcher } from '../src/modules/schedules/dispatcher.js'
import { ScheduleOccurrencePageSchema } from '../src/modules/schedules/transportSchemas.js'
import { agent3Database, deferred, postgresEnabled } from './helpers/wave25Agent3.js'
import {
  sch11Actions, sch11DomainState, sch11Fixture,
  type Sch11Database, type Sch11Fixture,
} from './helpers/sch11Fixture.js'

type Mode = ScheduleConfiguration['mode']
type Operation = 'save' | 'enable'
type Transport = 'http' | 'mcp'
const cursorCases = (['weekly', 'interval', 'once'] as const).flatMap((mode) =>
  (['save', 'enable'] as const).flatMap((operation) =>
    (['http', 'mcp'] as const).map((transport) => ({ mode, operation, transport }))))

describe.skipIf(!postgresEnabled)('unchanged schedule cursor persistence and admission', () => {
  let database: Sch11Database
  let f: Sch11Fixture
  let dueAt: string
  let app: ReturnType<typeof buildApp> | undefined
  let address: string
  let clients: Client[] = []

  beforeAll(async () => { database = await agent3Database() }, 60_000)
  afterAll(async () => { await database?.close() })
  beforeEach(async () => {
    app = undefined
    // Keep the occurrence behind the real HTTP/MCP service clock. Only the
    // fixture's schedule/dispatcher clock moves; authentication uses real time.
    const due = new Date()
    due.setUTCSeconds(0, 0)
    due.setUTCMinutes(due.getUTCMinutes() - 1)
    dueAt = due.toISOString()
    f = await sch11Fixture(database, new Date(due.getTime() - 1).toISOString())
    clients = []
    app = buildApp({
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: {
        access: f.access,
        services: { workflows: f.workflows, commands: f.commands } as unknown as OperatorServices,
      },
    })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 60_000)
  afterEach(async () => {
    await Promise.allSettled(clients.map((client) => client.close()))
    await app?.close()
  }, 30_000)

  function configuration(mode: Mode): ScheduleConfiguration {
    const settings = { timezone: 'UTC', enabled: true, policy: 'latest_saved' as const }
    const date = new Date(dueAt)
    switch (mode) {
      case 'weekly':
        return { ...settings, mode, weekdays: [date.getUTCDay() || 7], time: dueAt.slice(11, 16) }
      case 'interval':
        return {
          ...settings, mode, every: 1, unit: 'minute',
          anchorAt: new Date(date.getTime() - 60_000).toISOString(),
        }
      case 'once':
        return { ...settings, mode, localDate: dueAt.slice(0, 10), time: dueAt.slice(11, 16) }
    }
  }
  function nextDue(mode: Mode): string | null {
    if (mode === 'once') return null
    const duration = mode === 'weekly' ? 7 * 86_400_000 : 60_000
    return new Date(Date.parse(dueAt) + duration).toISOString()
  }
  const root = () => `/api/management/workspaces/${f.scope.workspaceId}/workflows/${f.scope.workflowId}/schedule`

  async function connect(token: string) {
    const client = new Client({ name: 'schedule-cursor-tests', version: '1.0.0' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }))
    return client
  }
  function writeHttp(operation: Operation, input: Record<string, unknown>, token: string) {
    const payload = {
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      ...(operation === 'save' ? { schedule: input.schedule } : {}),
    }
    return app!.inject({
      method: operation === 'save' ? 'PUT' : 'POST',
      url: operation === 'save' ? root() : `${root()}/enable`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    })
  }
  async function write(transport: Transport, operation: Operation, input: Record<string, unknown>,
    caller: { token: string; client: Client }): Promise<ScheduleSaveResult> {
    if (transport === 'http') {
      const response = await writeHttp(operation, input, caller.token)
      expect(response.statusCode).toBe(200)
      return ScheduleSaveResultSchema.parse(response.json())
    }
    const response = await caller.client.callTool({ name: `workflow_schedule_${operation}`, arguments: input })
    expect(response.isError).not.toBe(true)
    return ScheduleSaveResultSchema.parse(response.structuredContent)
  }
  async function readBoth(client: Client) {
    const response = await app!.inject({
      method: 'GET', url: root(), headers: { authorization: `Bearer ${f.reader.token}` },
    })
    expect(response.statusCode).toBe(200)
    const result = ScheduleGetResultSchema.parse(response.json())
    const tool = await client.callTool({ name: 'workflow_schedule_get', arguments: f.scope })
    expect(tool.isError).not.toBe(true)
    expect(ScheduleGetResultSchema.parse(tool.structuredContent)).toEqual(result)
    return result.schedule
  }

  it.each(cursorCases)('$mode: $transport $operation retains a prepared occurrence across owner rebinding',
    async ({ mode, operation, transport }) => {
      const settings = configuration(mode)
      const saved = await f.save(settings)
      expect(saved.nextOccurrenceAt).toBe(dueAt)
      f.time.now = new Date(Date.parse(dueAt) + 2_000).toISOString()
      const replacement = await f.issue(sch11Actions)
      const caller = { token: replacement.token, client: await connect(replacement.token) }
      const reader = await connect(f.reader.token)
      const prepared = deferred()
      const release = deferred()
      const principals: string[] = []
      const errors: unknown[] = []
      const port = f.dispatcher(async (principal, input, guard) => {
        principals.push(principal.id)
        if (principals.length === 1) {
          prepared.resolve()
          await release.promise
        }
        await f.startUsing()(principal, input, guard)
      })
      const dispatcher = new WorkflowScheduleDispatcher(port, {
        clock: f.clock, reportError: (error) => { errors.push(error) },
      })
      const work = dispatcher.tick()
      try {
        await Promise.race([
          prepared.promise,
          work.then(() => { throw new Error('Dispatch ended before the preparation barrier.') }),
        ])
        const input = {
          ...f.command(saved.revision),
          ...(operation === 'save' ? { schedule: settings } : {}),
        }
        const before = await sch11DomainState(f)
        const deniedHttp = await writeHttp(operation, input, f.reader.token)
        expect(deniedHttp.statusCode).toBe(403)
        const deniedMcp = await reader.callTool({ name: `workflow_schedule_${operation}`, arguments: input })
        expect(deniedMcp.isError).toBe(true)
        expect(JSON.stringify(deniedMcp.content)).toContain('ACCESS_DENIED')
        expect(await sch11DomainState(f)).toEqual(before)

        const changed = await write(transport, operation, input, caller)
        expect(changed.replayed).toBe(false)
        expect(changed.value).toEqual({ ...saved, revision: 2 })
        expect(await readBoth(reader)).toEqual(changed.value)
        expect(await f.history()).toEqual([])
        expect(await f.countRuns()).toBe(0)
        const replayTransport = transport === 'http' ? 'mcp' : 'http'
        expect(await write(replayTransport, operation, input, caller)).toEqual({
          value: changed.value, replayed: true,
        })

        release.resolve()
        await work
        // Allow admission to retry immediately or on the next scan. Its outcome
        // must use the new revision and owner for the original due instant.
        await dispatcher.tick()
        await dispatcher.tick()
        expect(errors).toEqual([])
        expect(principals[0]).toBe(f.writer.principal.id)
        expect(principals).toContain(replacement.principal.id)
        expect(await f.countRuns()).toBe(1)
        const history = await f.history()
        expect(history).toEqual([expect.objectContaining({
          dueAt, status: 'accepted', reason: null, scheduleRevision: 2,
          workflowVersionId: f.fixture.version.id,
        })])
        expect(await readBoth(reader)).toEqual({ ...changed.value, nextOccurrenceAt: nextDue(mode) })
        const page = await reader.callTool({ name: 'workflow_schedule_occurrences_list', arguments: f.scope })
        expect(page.isError).not.toBe(true)
        expect(ScheduleOccurrencePageSchema.parse(page.structuredContent).items).toEqual(history)
        const httpHistory = await app!.inject({
          method: 'GET', url: `${root()}/occurrences`,
          headers: { authorization: `Bearer ${f.reader.token}` },
        })
        expect(httpHistory.statusCode).toBe(200)
        expect(ScheduleOccurrencePageSchema.parse(httpHistory.json()).items).toEqual(history)
      } finally {
        release.resolve()
        await work
        await dispatcher.stop()
      }
    }, 60_000)

  it('preserves an exhausted enabled Once through fresh Save and Enable commands', async () => {
    const settings = configuration('once')
    const saved = await f.save(settings)
    f.time.now = new Date(Date.parse(dueAt) + 2_000).toISOString()
    await f.dispatcher().dispatch(saved)
    const exhausted = await f.current()
    expect(exhausted).toEqual({ ...saved, nextOccurrenceAt: null })
    const caller = { token: f.writer.token, client: await connect(f.writer.token) }
    const reader = await connect(f.reader.token)
    const history = await f.history()
    const updated = await write('mcp', 'save', { ...f.command(1), schedule: settings }, caller)
    expect(updated.value).toEqual({ ...exhausted, revision: 2 })
    const enabled = await write('http', 'enable', f.command(2), caller)
    expect(enabled.value).toEqual({ ...updated.value, revision: 3 })
    expect(await readBoth(reader)).toEqual(enabled.value)
    await f.dispatcher().dispatch(enabled.value)
    expect(await f.countRuns()).toBe(1)
    expect(await f.history()).toEqual(history)
  }, 60_000)

  it('preserves a pending cursor for weekday order, interval anchor offsets and display timezone', async () => {
    const weekly = configuration('weekly')
    if (weekly.mode !== 'weekly') throw new Error('Expected weekly settings.')
    const day = weekly.weekdays[0]!
    const settings = { ...weekly, weekdays: [day, day % 7 + 1] }
    const saved = await f.save(settings)
    f.time.now = new Date(Date.parse(dueAt) + 2_000).toISOString()
    const reordered = await f.service.save(f.writer.principal, 'mcp', {
      ...f.command(1), schedule: { ...settings, weekdays: [...settings.weekdays].reverse() },
    })
    expect(reordered.value.nextOccurrenceAt).toBe(dueAt)
    expect(reordered.value.revision).toBe(saved.revision + 1)

    const interval = configuration('interval')
    if (interval.mode !== 'interval') throw new Error('Expected interval settings.')
    f.time.now = new Date(Date.parse(dueAt) - 1).toISOString()
    const elapsed = await f.save(interval, 2)
    f.time.now = new Date(Date.parse(dueAt) + 2_000).toISOString()
    const anchor = new Date(Date.parse(interval.anchorAt) + 3 * 3_600_000).toISOString().replace('Z', '+03:00')
    const sameInstant = await f.service.save(f.writer.principal, 'http', {
      ...f.command(3), schedule: { ...interval, anchorAt: anchor },
    })
    expect(sameInstant.value).toEqual({ ...elapsed, revision: 4 })
    const deviceTimezone = await f.service.save(f.writer.principal, 'http', {
      ...f.command(4), schedule: { ...interval, timezone: 'Asia/Tokyo' },
    })
    expect(deviceTimezone.value).toEqual({ ...sameInstant.value, timezone: 'Asia/Tokyo', revision: 5 })
  }, 60_000)

  it.each(['weekly', 'interval', 'once'] as const)('%s recurrence edits calculate a future cursor', async (mode) => {
    const settings = configuration(mode)
    await f.save(settings)
    f.time.now = new Date(Date.parse(dueAt) + 2_000).toISOString()
    const future = new Date(Date.parse(dueAt) + 10 * 60_000).toISOString()
    let edited: ScheduleConfiguration
    if (settings.mode === 'interval') {
      edited = { ...settings, anchorAt: future }
    } else if (settings.mode === 'weekly') {
      edited = { ...settings, weekdays: [new Date(future).getUTCDay() || 7], time: future.slice(11, 16) }
    } else {
      edited = { ...settings, localDate: future.slice(0, 10), time: future.slice(11, 16) }
    }
    const result = await f.service.save(f.writer.principal, 'mcp', { ...f.command(1), schedule: edited })
    expect(result.value).toMatchObject({ revision: 2, nextOccurrenceAt: future })
    expect(await f.history()).toEqual([])
    expect(await f.countRuns()).toBe(0)
  }, 60_000)

  it.each(['weekly', 'interval'] as const)('%s re-enable calculates a future cursor after disable', async (mode) => {
    await f.save(configuration(mode))
    f.time.now = new Date(Date.parse(dueAt) + 2_000).toISOString()
    const disabled = await f.service.disable(f.writer.principal, 'http', f.command(1))
    expect(disabled.value.nextOccurrenceAt).toBeNull()
    const enabled = await f.service.enable(f.writer.principal, 'mcp', f.command(2))
    expect(enabled.value).toMatchObject({ enabled: true, revision: 3, nextOccurrenceAt: nextDue(mode) })
  }, 60_000)

  it('still rejects a disabled past Once and a new past Once configuration', async () => {
    const settings = configuration('once')
    await f.save(settings)
    f.time.now = new Date(Date.parse(dueAt) + 2_000).toISOString()
    await f.service.disable(f.writer.principal, 'http', f.command(1))
    const before = await sch11DomainState(f)
    await expect(f.service.enable(f.writer.principal, 'mcp', f.command(2)))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(f.service.save(f.writer.principal, 'http', { ...f.command(2), schedule: settings }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await sch11DomainState(f)).toEqual(before)
  }, 60_000)
})
