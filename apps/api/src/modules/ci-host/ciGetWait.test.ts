import { EventEmitter } from 'node:events'
import type pg from 'pg'
import Fastify from 'fastify'
import { CiRunRecordSchema, CiGetOutputSchema, CiGetInputSchema, OperatorCiGetInputSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { afterEach, expect, it, vi } from 'vitest'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { ciCapabilities } from '../../mcp/shared/ciTools.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { CI_GET_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from './service.js'

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const caller: ManagementPrincipal = {
    id: 'reader', name: 'CI reader', audience: 'operator',
    grants: [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: ['workspace'] } }],
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  }
  let record = CiRunRecordSchema.parse({
    id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace',
    groupId: '22222222-2222-4222-8222-222222222222', suite: 'lint', part: null,
    scope: 'full', files: [], partition: null, repository: 'owner/repo', commit: 'a'.repeat(40),
    state: 'running', computer: null, step: 'lint', exitCode: null, message: null,
    queuedAt: '2026-10-14T00:00:00.000Z', startedAt: '2026-10-14T00:00:01.000Z', finishedAt: null,
    initiator: { principalId: caller.id, executionId: null },
  })
  const logTail = 'x'.repeat(32_768)
  const query = vi.fn(async () => ({ rows: [{ record: structuredClone(record), log_tail: logTail }] }))
  const client = Object.assign(new EventEmitter(), { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() })
  const pool = { query, connect: vi.fn(async () => client) } as unknown as pg.Pool
  const authority: CiAuthority = { resolve: vi.fn(async principal => {
    if (!principal.grants.length) throw new DomainError('ACCESS_DENIED', 'CI read denied.', 403)
    return { principal, workspaceId: 'workspace' }
  }) }
  const endpoint: HostCiEndpoint = { computers: vi.fn(async () => []),
    request: vi.fn(async () => { throw new Error('CI reads must not contact a computer') }) }
  const commands = new PostgresCommandCoordinator(pool)
  const create = () => new HostCiService(pool, commands, authority, {} as CiCommits, endpoint)
  const ci = create()
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token === 'reader') return caller
    if (token === 'denied') return { ...caller, id: 'denied', grants: [] }
    throw new DomainError('AUTH_INVALID', 'Invalid token.', 401)
  })
  const services = { ci, commands: { recordDenied: vi.fn(async () => undefined),
    recordAudit: vi.fn(async () => undefined) } } as unknown as OperatorServices
  const app = Fastify()
  registerGraphqlMcp(app, { access, operator: services })
  const rpc = (payload: Record<string, unknown>, token = 'reader') => app.inject({ method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' }, payload })
  const call = async (input: Record<string, unknown>, id = 1, token = 'reader') => {
    const response = await rpc({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'ci_get', arguments: { workspaceId: 'workspace', ticketId: record.id, ...input } } }, token)
    const line = response.body.split('\n').find(value => value.startsWith('data: '))
    return line ? JSON.parse(line.slice(6)) : response.json()
  }
  const persist = (changes: Partial<typeof record>) => {
    const before = record
    record = CiRunRecordSchema.parse({ ...record, ...changes })
    if (before.state !== record.state || before.step !== record.step) {
      client.emit('notification', { channel: 'ci_ticket_changed',
        payload: JSON.stringify({ workspaceId: record.workspaceId, ticketId: record.id }) })
    }
  }
  return { app, call, rpc, ci, create, services, caller, pool, client, query, endpoint, persist,
    read: () => record, close: async () => { await ci.close(); await app.close() } }
}

const value = (message: { result: Parameters<typeof decodeMcpToolResult>[0] }) =>
  CiGetOutputSchema.parse(decodeMcpToolResult(message.result))
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

it('accepts bounded waitSeconds and optional logTail for both MCP roles', () => {
  for (const schema of [CiGetInputSchema, OperatorCiGetInputSchema]) {
    const input = { workspaceId: 'workspace', ticketId: 'ticket', waitSeconds: 300, logTail: false }
    const scoped = schema === CiGetInputSchema ? { ticketId: input.ticketId, waitSeconds: 300, logTail: false } : input
    expect(schema.safeParse(scoped).success).toBe(true)
    expect(schema.safeParse({ ...scoped, waitSeconds: 0 }).success).toBe(true)
    expect(schema.safeParse({ ...scoped, waitSeconds: 0.1 }).success).toBe(true)
    for (const waitSeconds of [-1, 301, '10']) {
      expect(schema.safeParse({ ...scoped, waitSeconds }).success).toBe(false)
    }
  }
})

it('omits the tail on request and preserves default persisted readback across service recreation', async () => {
  const f = fixture()
  try {
    const withoutTail = value(await f.call({ logTail: false }))
    expect(withoutTail.run).toEqual(f.read())
    expect(withoutTail).not.toHaveProperty('logTail')
    expect(value(await f.call({})).logTail).toHaveLength(32_768)
    expect((await f.create().get(f.caller, { workspaceId: 'workspace', ticketId: f.read().id })).run).toEqual(f.read())
    expect(f.endpoint.request).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it.each([{ step: 'collecting' }, { state: 'passed' as const, exitCode: 0 }, { state: 'canceled' as const }])(
  'wakes an authenticated MCP wait on persisted change %j', async changes => {
    const f = fixture()
    try {
      let settled = false
      const pending = f.call({ waitSeconds: 2, logTail: false }).then(result => { settled = true; return result })
      await pause(100)
      expect(settled).toBe(false)
      const reads = f.query.mock.calls.length
      f.persist({ message: 'More output' })
      f.client.emit('notification', { channel: 'ci_ticket_changed',
        payload: JSON.stringify({ workspaceId: 'other-workspace', ticketId: f.read().id }) })
      await pause(100)
      expect(settled).toBe(false)
      expect(f.query).toHaveBeenCalledTimes(reads)
      f.persist(changes)
      const result = value(await pending)
      expect(result.run).toEqual(f.read())
      expect(result).not.toHaveProperty('logTail')
      expect(f.client.release).toHaveBeenCalledTimes(1)
      expect(f.endpoint.request).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

it('returns at the deadline without repeatedly reading the ticket', async () => {
  const f = fixture()
  try {
    const started = performance.now()
    const pending = f.call({ waitSeconds: 0.3, logTail: false })
    await pause(100)
    const reads = f.query.mock.calls.length
    await pause(100)
    expect(f.query).toHaveBeenCalledTimes(reads)
    expect(value(await pending).run.state).toBe('running')
    expect(performance.now() - started).toBeGreaterThanOrEqual(290)
    expect(f.client.release).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})

it.each(['passed', 'failed', 'canceled', 'lost'] as const)('returns a terminal %s ticket immediately', async state => {
  const f = fixture()
  try {
    f.persist({ state })
    const started = performance.now()
    expect(value(await f.call({ waitSeconds: 300, logTail: false })).run.state).toBe(state)
    expect(performance.now() - started).toBeLessThan(1000)
  } finally { await f.close() }
})

it('cancels an authenticated MCP wait and releases its subscription', async () => {
  const f = fixture()
  try {
    const pending = f.call({ waitSeconds: 300, logTail: false }, 'waiting')
    await pause(100)
    const response = await f.rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'waiting' } })
    expect(response.statusCode).toBe(202)
    const message = await pending
    expect(message.result.isError).toBe(true)
    expect(f.client.release).toHaveBeenCalledTimes(1)
    expect(value(await f.call({ waitSeconds: 0, logTail: false }, 'waiting')).run.state).toBe('running')
  } finally { await f.close() }
})

it('denies an ungranted MCP caller before opening a wait', async () => {
  const f = fixture()
  try {
    const denied = await f.call({ waitSeconds: 300, logTail: false }, 1, 'denied')
    expect(JSON.stringify(denied)).toContain('ACCESS_DENIED')
    expect(f.pool.connect).not.toHaveBeenCalled()
    expect(f.services.commands.recordDenied).toHaveBeenCalledWith('denied', 'mcp', 'ci_get', 'mcp:ci_get')
  } finally { await f.close() }
})

it('shares one subscription connection and cancels only the requested MCP wait', async () => {
  const f = fixture()
  try {
    const first = f.call({ waitSeconds: 2, logTail: false }, 'first')
    const second = f.call({ waitSeconds: 2, logTail: false }, 'second')
    await pause(100)
    expect(f.pool.connect).toHaveBeenCalledTimes(1)
    await f.rpc({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'first' } })
    expect((await first).result.isError).toBe(true)
    expect(f.client.release).not.toHaveBeenCalled()
    f.persist({ step: 'collecting' })
    expect(value(await second).run.step).toBe('collecting')
    expect(f.client.release).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})

it('reads back a state change that commits while the subscription connection is being acquired', async () => {
  const f = fixture()
  try {
    vi.mocked(f.pool.connect).mockImplementation(async () => {
      f.persist({ state: 'passed', exitCode: 0 })
      return f.client as unknown as pg.PoolClient
    })
    expect(value(await f.call({ waitSeconds: 2, logTail: false })).run.state).toBe('passed')
    expect(f.client.release).toHaveBeenCalledTimes(1)
  } finally { await f.close() }
})

it('releases the wait when the HTTP client aborts its MCP request', async () => {
  const f = fixture()
  const controller = new AbortController()
  try {
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 })
    const pending = fetch(new URL('/mcp', address), {
      method: 'POST', signal: controller.signal,
      headers: { authorization: 'Bearer reader', accept: 'application/json, text/event-stream',
        'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'disconnect', method: 'tools/call',
        params: { name: 'ci_get', arguments: { workspaceId: 'workspace', ticketId: f.read().id,
          waitSeconds: 300, logTail: false } } }),
    }).then(async response => response.text()).catch(error => error)
    await pause(100)
    expect(f.client.release).not.toHaveBeenCalled()
    controller.abort()
    expect(await pending).toBeInstanceOf(Error)
    await vi.waitFor(() => expect(f.client.release).toHaveBeenCalledTimes(1))
  } finally { controller.abort(); await f.close() }
})

it('describes waiting and tail omission in Operator discovery and tools/list', async () => {
  const f = fixture()
  try {
    const capabilities = ciCapabilities({ principal: f.caller, services: f.services }, { workspaceId: 'workspace' })
    expect(capabilities.find(tool => tool.name === 'ci_get')?.detail).toContain('waitSeconds')
    expect(capabilities.find(tool => tool.name === 'ci_get')?.detail).toContain('logTail=false')
    const response = await f.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const message = JSON.parse(response.body.split('\n').find(line => line.startsWith('data: '))!.slice(6))
    const tool = message.result.tools.find((entry: { name: string }) => entry.name === 'ci_get')
    expect(tool.inputSchema.properties.waitSeconds).toMatchObject({ minimum: 0, maximum: 300 })
    expect(tool.inputSchema.properties.logTail.type).toBe('boolean')
  } finally { await f.close() }
})
