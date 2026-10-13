import type pg from 'pg'
import Fastify from 'fastify'
import { CiGetOutputSchema, CiRunRecordSchema, type CiHostRun, type CiRunRecord } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it, vi } from 'vitest'

import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { type CiAuthority, CI_GET_ACTIONS } from '../jobs/ciAuthority.js'
import { HostCiService, type HostCiEndpoint, type HostCiComputer, type CiCommits } from './service.js'

const caller: ManagementPrincipal = {
  id: 'operator', name: 'Operator', audience: 'operator',
  grants: [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: ['workspace'] } }],
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
}
const computer: HostCiComputer = {
  key: 'main:builder', hostRef: { kind: 'main', mainId: 'main' }, label: 'Builder', priority: 0,
}

function fixture(suite: 'lint' | 'integration' = 'lint') {
  let record = CiRunRecordSchema.parse({
    id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace',
    groupId: '22222222-2222-4222-8222-222222222222', suite, part: null,
    scope: 'full', files: [], partition: suite === 'integration' ? { index: 0, count: 2, hostIndexes: [0] } : null,
    repository: 'owner/repo', commit: 'a'.repeat(40),
    state: 'running', computer: { hostRef: computer.hostRef, label: computer.label }, step: suite,
    exitCode: null, message: null, queuedAt: '2026-10-12T00:00:00.000Z',
    startedAt: '2026-10-12T00:00:01.000Z', finishedAt: null,
    initiator: { principalId: 'worker', executionId: 'execution' },
  })
  let logTail = 'persisted log\n'
  const pool = { query: vi.fn(async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith('update ci_runs')) {
      record = CiRunRecordSchema.parse(JSON.parse(parameters![3] as string))
      if (typeof parameters![5] === 'string') logTail = parameters![5]
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('durations from ci_runs')) return { rows: [] }
    if (sql.startsWith('select id,host_key')) return { rows: [{ id: record.id, host_key: computer.key }] }
    return { rows: [{ record, log_tail: logTail, host_key: computer.key }] }
  }) } as unknown as pg.Pool
  const resolve = vi.fn(async (principal: ManagementPrincipal) => {
    if (!principal.grants.length) throw new DomainError('ACCESS_DENIED', 'CI read denied.', 403)
    return { principal, workspaceId: 'workspace', executionId: 'execution' }
  })
  const authority: CiAuthority = { resolve }
  const endpoint: HostCiEndpoint = {
    computers: vi.fn(async () => [computer]),
    request: vi.fn(async () => { throw new Error('Build computer unavailable') }),
  }
  const commands = new PostgresCommandCoordinator(pool)
  const create = () => new HostCiService(pool, commands, authority,
    {} as CiCommits, endpoint)
  return { create, pool, commands, endpoint, resolve, read: () => ({ record, logTail }) }
}

function dispatchFixture(settlementError?: Error) {
  const f = fixture()
  const active = f.read().record
  const queued = CiRunRecordSchema.parse({ ...active,
    id: '33333333-3333-4333-8333-333333333333',
    groupId: '44444444-4444-4444-8444-444444444444',
    state: 'queued', computer: null, startedAt: null, step: null,
  })
  const records: CiRunRecord[] = [active, queued]
  const tails = new Map<string, string>()
  const query = async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith('update ci_runs')) {
      const next = CiRunRecordSchema.parse(JSON.parse(parameters![3] as string))
      if (next.id === active.id && settlementError) throw settlementError
      const tail = parameters![5]
      for (const value of [next.message, tail]) {
        if (typeof value === 'string' && (value.includes('\0') || Buffer.from(value).toString('utf8') !== value)) {
          throw new Error('Database rejected invalid text')
        }
      }
      records[records.findIndex(record => record.id === next.id)] = next
      if (typeof tail === 'string') tails.set(next.id, tail)
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes("'supersededBy' is not null")) return { rows: [] }
    if (sql.includes("state='queued'")) {
      return { rows: records.filter(record => record.state === 'queued').map(record => ({ record, durations: null })) }
    }
    if (sql.includes("state in ('starting','running')")) {
      return { rows: records.filter(record => ['starting', 'running'].includes(record.state))
        .map(record => ({ id: record.id, record, host_key: computer.key })) }
    }
    if (sql.includes("'gate'='true'")) return { rows: [] }
    return { rows: records.filter(record => record.id === parameters?.[0] || record.groupId === parameters?.[0])
      .map(record => ({ record, log_tail: tails.get(record.id) ?? '' })) }
  }
  vi.mocked(f.pool.query).mockImplementation(query as unknown as pg.Pool['query'])
  const output = { text: 'finished\n', message: 'Done.' }
  vi.mocked(f.endpoint.request).mockImplementation(async (_computer, request) => {
    if (request.operation === 'status') {
      return { operation: 'status', ready: true, reasons: [], cpuCount: 8,
        memoryBytes: 16 * 2 ** 30, runs: [], slotsTotal: 2, slotsUsed: 0 }
    }
    if (request.operation !== 'read' && request.operation !== 'start') throw new Error('Unexpected request')
    const run: CiHostRun = { runId: request.runId, state: request.operation === 'read' ? 'passed' : 'running',
      step: 'lint', exitCode: request.operation === 'read' ? 0 : null,
      startedAt: active.startedAt!, finishedAt: request.operation === 'read' ? '2026-10-12T00:01:00.000Z' : null,
      message: output.message, logBytes: Buffer.byteLength(output.text) }
    if (request.operation === 'start') return { operation: 'start', run }
    return { operation: 'read', run, text: output.text, nextOffset: Buffer.byteLength(output.text) }
  })
  return { ...f, active, queued, records, output }
}

it('dispatches a queued ticket after settling ordinary output', async () => {
  const f = dispatchFixture()
  await f.create().dispatch()
  expect((await f.create().get(caller, { ticketId: f.active.id })).run.state).toBe('passed')
  expect((await f.create().get(caller, { ticketId: f.queued.id })).run.state).toBe('running')
  expect(f.endpoint.request).toHaveBeenCalledWith(computer, expect.objectContaining({
    operation: 'start', runId: f.queued.id,
  }))
})

it.each([
  { text: 'finished\0 café 🚀\n', message: 'Done.\0 café 🚀',
    cleanText: 'finished café 🚀\n', cleanMessage: 'Done. café 🚀' },
  { text: 'finished\ud800\n', message: 'Done.\udc00',
    cleanText: 'finished\ufffd\n', cleanMessage: 'Done.\ufffd' },
])('settles invalid log text and dispatches a queued ticket in the same pass: $cleanMessage', async output => {
  const f = dispatchFixture()
  Object.assign(f.output, output)
  await f.create().dispatch()
  const result = await f.create().get(caller, { ticketId: f.active.id })
  expect(result.run).toMatchObject({ state: 'passed', message: output.cleanMessage })
  expect(result.logTail).toBe(output.cleanText)
  expect((await f.create().get(caller, { ticketId: f.queued.id })).run.state).toBe('running')
  expect(f.endpoint.request).toHaveBeenCalledWith(computer, expect.objectContaining({
    operation: 'start', runId: f.queued.id,
  }))
})

it('continues refreshing later batches and dispatching after one settlement write fails', async () => {
  const f = dispatchFixture(new Error('Settlement storage unavailable'))
  const later = Array.from({ length: 8 }, (_, index) => CiRunRecordSchema.parse({ ...f.active,
    id: `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
  }))
  f.records.push(...later)
  await f.create().dispatch()
  expect((await f.create().get(caller, { ticketId: f.active.id })).run.state).toBe('running')
  for (const run of later) {
    expect((await f.create().get(caller, { ticketId: run.id })).run.state).toBe('passed')
  }
  expect((await f.create().get(caller, { ticketId: f.queued.id })).run.state).toBe('running')
})

it('persists sanitized dispatch errors on queued tickets', async () => {
  const f = dispatchFixture()
  const request = vi.mocked(f.endpoint.request).getMockImplementation()!
  vi.mocked(f.endpoint.request).mockImplementation(async (computer, input) => {
    if (input.operation === 'start') throw new Error('Executor\0 unavailable\ud800')
    return request(computer, input)
  })
  await f.create().dispatch()
  const result = await f.create().get(caller, { ticketId: f.queued.id })
  expect(result.run).toMatchObject({ state: 'queued',
    message: 'No ready computer for lint; Builder: Executor unavailable\ufffd' })
})

it('keeps assigned running ticket ids visible when the computer is offline', async () => {
  const f = fixture()
  expect(await f.create().computers(caller, { workspaceId: 'workspace' })).toMatchObject({ computers: [{
    ready: false, reasons: ['Build computer unavailable'], running: [f.read().record.id],
  }] })
})

it('refreshes submitted CI in the background without status reads and stops on close', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const ci = f.create()
  vi.spyOn(f.commands, 'execute').mockResolvedValue({ value: { ticketId: f.read().record.id }, replayed: false })
  let finished = false
  vi.mocked(f.endpoint.request).mockImplementation(async (_computer, request) => {
    if (request.operation !== 'read') throw new Error('Unexpected request')
    const record = f.read().record
    const run: CiHostRun = {
      runId: record.id, state: finished ? 'failed' : 'running', step: 'lint',
      exitCode: finished ? 1 : null, startedAt: record.startedAt!,
      finishedAt: finished ? new Date().toISOString() : null, logBytes: 0, message: null,
    }
    return { operation: 'read', run, text: '', nextOffset: 0 }
  })
  try {
    await ci.run(caller, { workspaceId: 'workspace', suite: 'lint', commandId: 'background' })
    await ci.dispatch()
    expect(f.read().record.state).toBe('running')
    finished = true
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.read().record.state).toBe('failed')
    vi.mocked(f.endpoint.request).mockClear()
    expect((await ci.get(caller, { workspaceId: 'workspace', ticketId: f.read().record.id })).run.state).toBe('failed')
    expect(f.endpoint.request).not.toHaveBeenCalled()
    await ci.close()
    vi.mocked(f.endpoint.computers).mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.endpoint.computers).not.toHaveBeenCalled()
  } finally {
    await ci.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

it.each(['lint', 'integration'] as const)('serves authenticated MCP %s polling from persisted data while fleet dispatch is blocked', async suite => {
  const f = fixture(suite)
  const ci = f.create()
  let unblock!: () => void
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  vi.mocked(f.endpoint.computers).mockImplementation(async () => {
    await blocked
    return []
  })
  const dispatch = ci.dispatch()
  const access = new PostgresAccessService(f.pool)
  const authenticate = vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token === 'reader') return caller
    if (token === 'denied') return { ...caller, id: 'denied', grants: [] }
    throw new DomainError('AUTH_INVALID', 'Invalid token.', 401)
  })
  const recordDenied = vi.fn(async () => undefined)
  const app = Fastify()
  registerGraphqlMcp(app, { access, operator: { ci, commands: { recordDenied } } as unknown as OperatorServices })
  const poll = (token: string) => app.inject({
    method: 'POST', url: '/mcp',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'ci_get', arguments: { workspaceId: 'workspace', ticketId: f.read().record.id } } },
  })
  try {
    const response = await poll('reader')
    expect(response.statusCode).toBe(200)
    const message = JSON.parse(response.body.split('\n').find(line => line.startsWith('data: '))!.slice(6))
    const result = CiGetOutputSchema.parse(decodeMcpToolResult(message.result))
    expect(result.run).toEqual(f.read().record)
    expect(result.logTail).toBe('persisted log\n')
    expect(f.endpoint.request).not.toHaveBeenCalled()
    const denied = await poll('denied')
    expect(denied.body).toContain('ACCESS_DENIED')
    expect(recordDenied).toHaveBeenCalledWith('denied', 'mcp', 'ci_get', 'mcp:ci_get')
    expect(authenticate).toHaveBeenCalledWith('reader', ['operator'])
  } finally {
    unblock()
    await dispatch
    await app.close()
    vi.restoreAllMocks()
  }
})

it.each([10, 40_000, 70_000])('persists a bounded %i-byte log with terminal status across service restart', async length => {
  const f = fixture()
  const log = 'x'.repeat(length) + '\nfinished\n'
  const state: CiHostRun = {
    runId: f.read().record.id, state: 'passed', step: 'lint', exitCode: 0,
    startedAt: '2026-10-12T00:00:01.000Z', finishedAt: '2026-10-12T00:01:00.000Z',
    logBytes: Buffer.byteLength(log), message: null,
  }
  vi.mocked(f.endpoint.request).mockImplementation(async (_computer, request) => {
    if (request.operation !== 'read') throw new Error('Unexpected request')
    const text = log.slice(request.afterOffset, request.afterOffset + request.maxBytes)
    return { operation: 'read', run: state, text, nextOffset: request.afterOffset + text.length }
  })
  await f.create().dispatch()
  vi.mocked(f.endpoint.request).mockClear()
  const result = await f.create().get(caller, { workspaceId: 'workspace', ticketId: state.runId })
  expect(result.run.state).toBe('passed')
  expect(result.logTail).toBe(log.slice(-32_768))
  expect(f.endpoint.request).not.toHaveBeenCalled()
  const page = await f.create().logs(caller, {
    workspaceId: 'workspace', ticketId: state.runId, afterOffset: 0, maxBytes: 500_000,
  })
  expect(page).toEqual({ text: log.slice(0, 65_536), maxBytes: 65_536,
    nextOffset: Math.min(log.length, 65_536), logBytes: log.length })
  expect(f.endpoint.request).toHaveBeenCalledWith(expect.anything(), {
    operation: 'read', runId: state.runId, afterOffset: 0, maxBytes: 65_536,
  })
})

it('checks worker ownership before returning cached logs or group data', async () => {
  const f = fixture()
  f.resolve.mockResolvedValue({ principal: caller, workspaceId: 'workspace', executionId: 'another-execution' })
  const worker: ManagementPrincipal = { ...caller, audience: 'worker', agentId: 'agent' }
  await expect(f.create().get(worker, { ticketId: f.read().record.id })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  expect(f.pool.query).toHaveBeenCalledTimes(1)
  expect(f.endpoint.computers).not.toHaveBeenCalled()
  expect(f.endpoint.request).not.toHaveBeenCalled()
})

it('retries a CI read once after a statement timeout, then reports a retryable error', async () => {
  const f = fixture()
  const canceled = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
  f.resolve.mockRejectedValueOnce(canceled())
  expect(await f.create().get(caller, { ticketId: f.read().record.id })).toMatchObject({ run: { id: f.read().record.id } })
  f.resolve.mockRejectedValueOnce(canceled()).mockRejectedValueOnce(canceled())
  await expect(f.create().get(caller, { ticketId: f.read().record.id })).rejects.toMatchObject({
    code: 'DATABASE_READ_TIMEOUT', status: 503, details: { retryable: true, sqlState: '57014' } })
})
