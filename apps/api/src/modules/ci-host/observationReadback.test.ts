import type pg from 'pg'
import Fastify from 'fastify'
import { CiGetOutputSchema, CiRunRecordSchema, type CiHostRun } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { afterEach, expect, it, vi } from 'vitest'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { CI_GET_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from './service.js'

const computer: HostCiComputer = { key: 'main:executor', label: 'Build executor', priority: 0,
  hostRef: { kind: 'main', mainId: 'main' } }
const caller: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator',
  grants: [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: ['workspace'] } }],
  expiresAt: '9999-12-31T23:59:59.999Z', revokedAt: null }

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function fixture() {
  let record = CiRunRecordSchema.parse({
    id: '11111111-1111-4111-8111-111111111111', workspaceId: 'workspace',
    groupId: '22222222-2222-4222-8222-222222222222', suite: 'lint', part: null,
    scope: 'full', files: [], partition: null, repository: 'fixture/project', commit: 'a'.repeat(40),
    state: 'running', computer: { hostRef: computer.hostRef, label: computer.label }, step: 'lint',
    exitCode: null, message: 'Lint in progress', queuedAt: '2026-10-14T00:00:00.000Z',
    startedAt: '2026-10-14T00:00:01.000Z', finishedAt: null,
    initiator: { principalId: 'operator', executionId: null },
  })
  let tail = 'saved output'
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith('update ci_runs')) {
      record = CiRunRecordSchema.parse(JSON.parse(values![3] as string))
      if (typeof values![5] === 'string') tail = values![5]
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes("'supersededBy' is not null") || sql.includes("state='queued'")
      || sql.includes("'gate'='true'")) return { rows: [] }
    if (sql.includes("state in ('starting','running')")) return { rows: [{ id: record.id, record, host_key: computer.key }] }
    if (values?.[0] === record.id || values?.[0] === record.groupId) return { rows: [{ record, log_tail: tail }] }
    return { rows: [] }
  })
  const pool = { query } as unknown as pg.Pool
  const authority: CiAuthority = { resolve: async principal => {
    if (!principal.grants.length) throw new DomainError('ACCESS_DENIED', 'CI read denied.', 403)
    return { principal, workspaceId: 'workspace' }
  } }
  let fail: 'read' | 'tail' | null = 'read'
  let transport: CiHostRun['transport']
  let observedState: 'running' | 'passed' = 'running'
  const requests: unknown[] = []
  const endpoint: HostCiEndpoint = { computers: async () => [computer], request: async (_host, request) => {
    if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
      cpuCount: 4, memoryBytes: 8 * 2 ** 30, slotsUsed: 1, slotsTotal: 1, runs: [] }
    requests.push(request)
    if (request.operation !== 'read') throw new Error('Unexpected operation')
    if (fail === 'read' || fail === 'tail' && request.afterOffset > 0) {
      throw new DomainError('DEVICE_CHANNEL_BACKPRESSURE', 'private-token credential details', 503)
    }
    return { operation: 'read', run: { runId: record.id, state: observedState, step: fail === 'tail' ? 'collecting' : 'lint',
      ...(transport ? { transport } : {}),
      startedAt: record.startedAt!, finishedAt: observedState === 'passed' ? new Date().toISOString() : null,
      exitCode: observedState === 'passed' ? 0 : null, message: 'Lint in progress',
      logBytes: fail === 'tail' ? 40_000 : 12 }, text: 'fresh output', nextOffset: 12 }
  } }
  const commands = new PostgresCommandCoordinator(pool)
  const create = () => new HostCiService(pool, commands, authority, {} as CiCommits, endpoint)
  const ci = create()
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token === 'reader') return caller
    return { ...caller, id: 'denied', grants: [] }
  })
  const recordDenied = vi.fn(async () => undefined)
  const app = Fastify()
  registerGraphqlMcp(app, { access, operator: { ci, commands: { recordDenied } } as unknown as OperatorServices })
  const call = async (token = 'reader') => {
    const response = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_get',
        arguments: { workspaceId: 'workspace', ticketId: record.id } } } })
    const data = response.body.split('\n').find(line => line.startsWith('data: '))
    return data ? JSON.parse(data.slice(6)) : response.json()
  }
  return { ci, create, call, requests, setState: (value: typeof observedState) => { observedState = value }, setTransport: (value: typeof transport) => { transport = value }, read: () => ({ record, tail }),
    failure: (value: typeof fail) => { fail = value },
    close: async () => { await ci.close(); await app.close() } }
}

it('persists unavailable observation, bounded retry timing and sanitized cause through authenticated MCP', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = fixture()
  try {
    await f.ci.dispatch()
    const first = CiGetOutputSchema.parse(decodeMcpToolResult((await f.call()).result))
    expect(first).toMatchObject({ run: { state: 'running', computer: { label: computer.label },
      message: expect.stringContaining('observation unavailable'), observation: { status: 'unavailable',
        consecutiveFailures: 1, lastSuccessAt: null, lastError: expect.stringContaining('DEVICE_CHANNEL_BACKPRESSURE'),
        nextAttemptAt: expect.any(String) } }, logTail: 'saved output' })
    expect(JSON.stringify(first)).not.toContain('private-token')
    expect((await f.create().get(caller, { workspaceId: 'workspace', ticketId: first.run.id })).run).toEqual(first.run)
    const count = f.requests.length
    await f.ci.dispatch()
    expect(f.requests).toHaveLength(count)
    vi.setSystemTime(Date.now() + 60_000)
    await f.ci.dispatch()
    expect(f.read().record).toMatchObject({ observation: { consecutiveFailures: 2 } })
    expect(JSON.stringify(await f.call('denied'))).toContain('ACCESS_DENIED')
    f.failure(null)
    vi.setSystemTime(Date.now() + 60_000)
    await f.ci.dispatch()
    const recovered = CiGetOutputSchema.parse(decodeMcpToolResult((await f.call()).result))
    expect(recovered).toMatchObject({ run: { state: 'running', message: 'Lint in progress',
      observation: { status: 'available', consecutiveFailures: 0, lastError: null,
        lastSuccessAt: expect.any(String), nextAttemptAt: null } }, logTail: 'fresh output' })
  } finally { await f.close() }
})

it.each(['running', 'passed'] as const)('retains fresh %s facts when the log tail fails and later recovers it', async state => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = fixture()
  try {
    f.failure('tail')
    f.setState(state)
    await f.ci.dispatch()
    expect(f.read()).toMatchObject({ record: { state, step: 'collecting', observation: { status: 'unavailable', consecutiveFailures: 1 } },
      tail: 'saved output' })
    expect(CiGetOutputSchema.parse(decodeMcpToolResult((await f.call()).result)).run.message)
      .toContain('observation unavailable')
    f.failure(null)
    vi.setSystemTime(Date.now() + 60_000)
    await f.ci.dispatch()
    expect(f.read()).toMatchObject({ record: { state, observation: { status: 'available' } }, tail: 'fresh output' })
  } finally { await f.close() }
})


it('preserves the last successful observation time when later reads fail', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = fixture()
  try {
    f.failure(null)
    await f.ci.dispatch()
    const successful = await f.ci.get(caller, { workspaceId: 'workspace', ticketId: f.read().record.id })
    expect(successful.run).toMatchObject({ observation: { status: 'available', lastSuccessAt: expect.any(String) } })
    const at = successful.run.observation!.lastSuccessAt
    f.failure('read')
    vi.setSystemTime(Date.now() + 1000)
    await f.ci.dispatch()
    const failed = CiGetOutputSchema.parse(decodeMcpToolResult((await f.call()).result))
    expect(failed.run).toMatchObject({ observation: { status: 'unavailable', lastSuccessAt: at } })
  } finally { await f.close() }
})

it('persists provider transport status and exposes its cause through authenticated MCP', async () => {
  const f = fixture()
  try {
    f.failure(null)
    const transport = { source: 'cli' as const, reason: 'REST token unavailable; using CLI credential resolution.',
      lastError: null, fallbackCount: 2 }
    f.setTransport(transport)
    await f.ci.dispatch()
    const output = CiGetOutputSchema.parse(decodeMcpToolResult((await f.call()).result))
    expect(output.run).toMatchObject({ transport })
    expect((await f.create().get(caller, { workspaceId: 'workspace', ticketId: output.run.id })).run)
      .toMatchObject({ transport })
    expect(JSON.stringify(await f.call('denied'))).toContain('ACCESS_DENIED')
  } finally { await f.close() }
})
