import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiRunOutputSchema, type CiHostRequest, type CiHostReply, type CiHostRun } from '@foreman-code/contracts'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunCiAuthority, CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { HostCiService, type HostCiComputer, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { workspaceMirrors } from '../src/modules/ci-host/cloud.js'
import { DomainError } from '../src/modules/errors.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)
beforeEach(async () => {
  await database.pool.query('truncate ci_runs, ci_file_durations, management_command_receipts, management_audit')
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture() {
  const pool = database.pool
  const workspaceId = randomUUID()
  const repository = { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' }
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [workspaceId, JSON.stringify({ id: workspaceId, name: 'CI workspace', repository })])
  const computers: HostCiComputer[] = [0, 1].map(index => ({
    key: `executor:${index}`, hostRef: { kind: 'device', mainId: 'test-main', deviceId: `executor-${index}` },
    label: `Executor ${index}`, priority: 10 - index,
  }))
  const remote = new Map<string, CiHostRun>()
  const starts: { computer: HostCiComputer; request: Extract<CiHostRequest, { operation: 'start' }> }[] = []
  const control: {
    available: boolean
    onStart(computer: HostCiComputer, request: CiHostRequest): Promise<void>
    onStatus(computer: HostCiComputer): Promise<void>
    onCancel(): Promise<void>
  } = {
    available: false,
    onStart: async () => {},
    onStatus: async () => {},
    onCancel: async () => {},
  }
  const endpoint: HostCiEndpoint = {
    computers: async () => control.available ? computers : [],
    request: async (computer, request): Promise<CiHostReply> => {
      if (request.operation === 'status') {
        await control.onStatus(computer)
        return { operation: 'status', ready: true, reasons: [], cpuCount: 8, memoryBytes: 8 * 2 ** 30,
          slotsUsed: [...remote.entries()].filter(([key, run]) => key.startsWith(`${computer.key}:`)
            && ['starting', 'running'].includes(run.state)).length,
          slotsTotal: 1, runs: [] }
      }
      const key = `${computer.key}:${request.runId}`
      if (request.operation === 'start') {
        if (!remote.has(key)) {
          remote.set(key, { runId: request.runId, state: 'running', step: request.suite, exitCode: null,
            startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0, message: null })
          starts.push({ computer, request })
        }
        await control.onStart(computer, request)
        return { operation: 'start', run: remote.get(key)! }
      }
      const run = remote.get(key)
      if (!run) throw new DomainError('CI_RUN_UNKNOWN', 'Unknown CI run.', 404)
      if (request.operation === 'cancel') {
        await control.onCancel()
        const canceled = { ...run, state: 'canceled' as const, finishedAt: new Date().toISOString(), message: 'Canceled.' }
        remote.set(key, canceled)
        return { operation: 'cancel', run: canceled }
      }
      return { operation: 'read', run, text: '', nextOffset: 0 }
    },
  }
  const commands = new PostgresCommandCoordinator(pool)
  const commits = {
    resolve: async (_repository: string, _branch: string, commit: string | undefined) => commit ?? 'a'.repeat(40),
    capabilities: async () => ({ parts: false, integrationPartitions: true, affected: true }),
  }
  const createService = () => {
    const service = new HostCiService(pool, commands, new RunCiAuthority(pool), commits, endpoint)
    vi.spyOn(service, 'start').mockImplementation(() => {})
    return service
  }
  const ci = createService()
  const access = new PostgresAccessService(pool)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (actions: ManagementAction[], workspaceIds = [workspaceId]) => {
    const issued = await access.issue({ name: 'CI caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions, scope: { workspaceIds } }] })
    const client = new Client({ name: 'ci-ownership-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
    return { client, principalId: (await access.authenticate(issued.token)).id }
  }
  const operator = await connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
  const call = (client: Client, name: string, input: Record<string, unknown>) =>
    client.callTool({ name, arguments: { workspaceId, ...input } })
  const value = async (name: string, input: Record<string, unknown>, client = operator.client) => {
    const result = await call(client, name, input)
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  const enqueue = async (input: Record<string, unknown> = {}) => {
    const result = CiRunOutputSchema.parse(await value('ci_run', { suite: 'install', commandId: randomUUID(), ...input }))
    await ci.dispatch()
    return result
  }
  const read = async (ticketId: string) => CiGetOutputSchema.parse(await value('ci_get', { ticketId })).run
  const close = async () => {
    await ci.close()
    await Promise.all(clients.map(client => client.close()))
    await app.close()
  }
  return { pool, workspaceId, repository, operator, connect, call, value, enqueue, read, ci,
    createService, control, remote, starts, computers, close }
}

it('audits queued and running MCP cancellation once with the caller and request identity', async () => {
  const f = await fixture()
  try {
    const queued = await f.enqueue()
    const running = await f.enqueue()
    f.control.available = true
    await f.ci.dispatch()
    const extra = await f.enqueue()
    const denied = await f.connect(['jobs:cancel'], [randomUUID()])
    expect((await f.call(denied.client, 'ci_cancel', { ticketId: extra.ticketId })).isError).toBe(true)
    for (const ticketId of [extra.ticketId, running.ticketId, queued.ticketId]) {
      await f.value('ci_cancel', { ticketId })
      await f.value('ci_cancel', { ticketId })
      expect((await f.read(ticketId)).state).toBe('canceled')
      const rows = (await f.pool.query<{ principal_id: string; source: string; details: Record<string, unknown> }>(
        "select principal_id,source,details from management_audit where action='ci.cancel' and target_key=$1",
        [`ci:${ticketId}`])).rows
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ principal_id: f.operator.principalId, source: 'mcp',
        details: { ticketId, reason: 'direct', commandId: expect.any(String) } })
    }
    const denial = (await f.pool.query("select principal_id,outcome from management_audit where action='ci_cancel'" )).rows
    expect(denial).toContainEqual({ principal_id: denied.principalId, outcome: 'denied' })
  } finally { await f.close() }
})

it('keeps unchanged provider messages and the persisted row stable after a message transition', async () => {
  const f = await fixture()
  try {
    const ticket = await f.enqueue()
    f.control.available = true
    await f.ci.dispatch()
    const key = `${f.starts[0]!.computer.key}:${ticket.ticketId}`
    f.remote.set(key, { ...f.remote.get(key)!, message: 'Observation A' })
    await f.ci.dispatch()
    f.remote.set(key, { ...f.remote.get(key)!, message: 'Observation B' })
    await f.ci.dispatch()
    const before = (await f.pool.query('select record,xmin::text as revision from ci_runs where id=$1', [ticket.ticketId])).rows[0]
    await f.ci.dispatch()
    await f.ci.dispatch()
    const after = (await f.pool.query('select record,xmin::text as revision from ci_runs where id=$1', [ticket.ticketId])).rows[0]
    expect(after).toEqual(before)
    expect((await f.read(ticket.ticketId)).message).toContain('Observation B')
  } finally { await f.close() }
})

it('retains one executor after an accepted start loses its reply and reconciles after restart', async () => {
  const f = await fixture()
  let restarted: HostCiService | undefined
  try {
    const ticket = await f.enqueue()
    f.control.onStart = async () => { throw new Error('Start reply lost') }
    f.control.available = true
    await f.ci.dispatch()
    expect(f.starts).toHaveLength(1)
    expect(await f.read(ticket.ticketId)).toMatchObject({ state: 'starting', computer: {
      hostRef: f.starts[0]!.computer.hostRef } })
    f.control.onStart = async () => {}
    restarted = f.createService()
    await restarted.dispatch()
    expect(f.starts).toHaveLength(1)
    expect((await f.read(ticket.ticketId)).state).toBe('running')
  } finally {
    await restarted?.close()
    await f.close()
  }
})

it('discovers an accepted run when its start acknowledgement was lost', async () => {
  const f = await fixture()
  try {
    const ticket = await f.enqueue()
    f.control.onStart = async () => { throw new Error('Start reply lost') }
    f.control.available = true
    await f.ci.dispatch()
    expect((await f.read(ticket.ticketId)).state).toBe('starting')
    const computers = await f.value('ci_computers_list', {})
    expect(computers).toMatchObject({ computers: expect.arrayContaining([
      expect.objectContaining({ hostRef: f.starts[0]!.computer.hostRef, running: [ticket.ticketId] }),
    ]) })
    expect((await f.read(ticket.ticketId)).state).toBe('running')
    expect(f.starts).toHaveLength(1)
  } finally { await f.close() }
})

it('preserves the assignment when the database rejects settlement after an accepted start', async () => {
  const f = await fixture()
  try {
    const ticket = await f.enqueue()
    await f.pool.query(`create function reject_ci_running() returns trigger language plpgsql as $$
      begin if new.state='running' then raise exception 'Settlement unavailable'; end if; return new; end $$`)
    await f.pool.query(`create trigger reject_ci_running before update on ci_runs
      for each row execute function reject_ci_running()`)
    f.control.available = true
    await f.ci.dispatch()
    expect(f.starts).toHaveLength(1)
    expect((await f.read(ticket.ticketId)).state).toBe('starting')
    await f.pool.query('drop trigger reject_ci_running on ci_runs')
    await f.ci.dispatch()
    expect(f.starts).toHaveLength(1)
    expect((await f.read(ticket.ticketId)).state).toBe('running')
  } finally {
    await f.pool.query('drop trigger if exists reject_ci_running on ci_runs')
    await f.pool.query('drop function if exists reject_ci_running()')
    await f.close()
  }
})

it('claims the executor before entry and prevents competing dispatchers from choosing another executor', async () => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  const other = f.createService()
  let dispatch: Promise<void> | undefined
  try {
    const ticket = await f.enqueue()
    let persisted: unknown
    f.control.onStart = async () => {
      if (persisted) return
      persisted = (await f.pool.query('select state,host_key,record from ci_runs where id=$1', [ticket.ticketId])).rows[0]
      entered.resolve()
      await release.promise
    }
    f.control.available = true
    dispatch = f.ci.dispatch()
    await entered.promise
    await other.dispatch()
    release.resolve()
    await dispatch
    expect(persisted).toMatchObject({ state: 'starting', host_key: f.starts[0]!.computer.key,
      record: { computer: { hostRef: f.starts[0]!.computer.hostRef } } })
    expect(f.starts).toHaveLength(1)
    expect((await f.read(ticket.ticketId)).state).toBe('running')
  } finally {
    release.resolve()
    await dispatch
    await other.close()
    await f.close()
  }
})

it('retries persisted cancellation on the assigned executor after transport failure and restart', async () => {
  const f = await fixture()
  let restarted: HostCiService | undefined
  try {
    const ticket = await f.enqueue()
    f.control.available = true
    await f.ci.dispatch()
    f.control.onCancel = async () => { throw new Error('Cancel reply unavailable') }
    expect((await f.call(f.operator.client, 'ci_cancel', { ticketId: ticket.ticketId })).isError).toBe(true)
    f.control.onCancel = async () => {}
    restarted = f.createService()
    await restarted.dispatch()
    expect((await f.read(ticket.ticketId)).state).toBe('canceled')
    expect([...f.remote.values()].every(run => run.state === 'canceled')).toBe(true)
    expect(f.starts).toHaveLength(1)
    const rows = (await f.pool.query("select principal_id from management_audit where action='ci.cancel'")).rows
    expect(rows).toEqual([{ principal_id: f.operator.principalId }])
  } finally {
    await restarted?.close()
    await f.close()
  }
})

it('persists direct cancellation before a start reply returns and recovers cleanup after restart', async () => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  let dispatch: Promise<void> | undefined
  let restarted: HostCiService | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const ticket = await f.enqueue()
    const commandId = randomUUID()
    f.control.onStart = async () => {
      entered.resolve()
      await release.promise
    }
    f.control.available = true
    dispatch = f.ci.dispatch()
    await entered.promise
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader.client, 'ci_cancel', { ticketId: ticket.ticketId })).isError).toBe(true)
    expect((await f.read(ticket.ticketId)).cancellation).toBeUndefined()
    const cancellation = await Promise.race([
      f.call(f.operator.client, 'ci_cancel', { ticketId: ticket.ticketId, commandId }),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Cancellation waited for the start reply')), 5_000)
      }),
    ])
    clearTimeout(deadline)
    expect(cancellation.isError).toBe(true)
    expect(decodeMcpToolResult(cancellation)).toMatchObject({ error: { code: 'CI_CANCEL_PENDING' } })
    const pending = await f.read(ticket.ticketId)
    expect(pending).toMatchObject({ state: 'starting', cancellation: {
      principalId: f.operator.principalId, source: 'mcp', commandId, reason: 'direct',
    } })
    expect(f.starts).toHaveLength(1)
    release.resolve()
    await dispatch
    expect((await f.read(ticket.ticketId)).cancellation).toEqual(pending.cancellation)
    f.control.onStart = async () => {}
    restarted = f.createService()
    await restarted.dispatch()
    const canceled = await f.read(ticket.ticketId)
    expect(canceled.state).toBe('canceled')
    expect(canceled.cancellation).toBeUndefined()
    expect([...f.remote.values()].every(run => run.state === 'canceled')).toBe(true)
    expect(f.starts).toHaveLength(1)
    const audits = (await f.pool.query<{ principal_id: string; source: string; details: unknown }>(
      "select principal_id,source,details from management_audit where action='ci.cancel' and target_key=$1",
      [`ci:${ticket.ticketId}`])).rows
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ principal_id: f.operator.principalId, source: 'mcp',
      details: { commandId, ticketId: ticket.ticketId, reason: 'direct' } })
  } finally {
    clearTimeout(deadline)
    release.resolve()
    await dispatch
    await restarted?.close()
    await f.close()
  }
})

it('retains cleanup when cancellation arrives while the accepted start reply is still in flight', async () => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  let dispatch: Promise<void> | undefined
  try {
    const ticket = await f.enqueue()
    f.control.onStart = async () => {
      entered.resolve()
      await release.promise
    }
    f.control.available = true
    dispatch = f.ci.dispatch()
    await entered.promise
    expect((await f.call(f.operator.client, 'ci_cancel', { ticketId: ticket.ticketId })).isError).toBe(true)
    expect((await f.read(ticket.ticketId)).state).toBe('starting')
    release.resolve()
    await dispatch
    f.control.onStart = async () => {}
    await f.ci.dispatch()
    expect((await f.read(ticket.ticketId)).state).toBe('canceled')
    expect([...f.remote.values()].every(run => run.state === 'canceled')).toBe(true)
    expect(f.starts).toHaveLength(1)
  } finally {
    release.resolve()
    await dispatch
    await f.close()
  }
})

it.each([2, 3])('preserves direct cancellation during throughput planning with %i partitions', async partitions => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  let dispatch: Promise<void> | undefined
  try {
    const statuses = new Map<string, number>()
    f.control.onStatus = async computer => {
      const count = (statuses.get(computer.key) ?? 0) + 1
      statuses.set(computer.key, count)
      // Capacity is read first; the next status read measures partition throughput.
      if (count === 2) {
        entered.resolve()
        await release.promise
      }
    }
    f.control.available = true
    const tickets = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'integration', partitions, scope: 'full', commandId: randomUUID(),
    }))
    expect(tickets.partitions).toHaveLength(partitions)
    dispatch = f.ci.dispatch()
    await entered.promise
    const ticketId = tickets.ticketId
    expect((await f.read(ticketId)).partition?.weights).toBeUndefined()
    expect(f.starts).toEqual([])
    await f.value('ci_cancel', { ticketId })
    expect((await f.read(ticketId)).state).toBe('canceled')
    release.resolve()
    await dispatch
    await f.ci.dispatch()
    expect((await f.read(ticketId)).state).toBe('canceled')
    expect(f.starts.some(start => start.request.runId === ticketId)).toBe(false)
    expect(f.starts.length).toBeGreaterThan(0)
  } finally {
    release.resolve()
    await dispatch
    await f.close()
  }
})

it.each([
  { partitions: 2, hostIndexes: [0] },
  { partitions: 3, hostIndexes: [0, 1] },
  { partitions: 4, hostIndexes: [0, 1] },
])('persists one plan for $partitions canceled siblings', async ({ partitions, hostIndexes }) => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  let dispatch: Promise<void> | undefined
  try {
    const statuses = new Map<string, number>()
    f.control.onStatus = async computer => {
      const count = (statuses.get(computer.key) ?? 0) + 1
      statuses.set(computer.key, count)
      if (count === 2) {
        entered.resolve()
        await release.promise
      }
    }
    f.control.available = true
    const tickets = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'integration', partitions, scope: 'full', commandId: randomUUID(),
    }))
    expect(tickets.partitions).toHaveLength(partitions)
    dispatch = f.ci.dispatch()
    await entered.promise
    const canceled = []
    for (const { ticketId } of tickets.partitions!) {
      await f.value('ci_cancel', { ticketId })
      canceled.push(await f.read(ticketId))
    }
    release.resolve()
    await dispatch
    const saved = (await f.pool.query<{ record: Record<string, unknown>; revision: string }>(
      'select record,xmin::text as revision from ci_runs where group_id=$1', [canceled[0]!.groupId])).rows
    expect(saved).toHaveLength(partitions)
    expect(new Set(saved.map(row => row.revision)).size).toBe(1)
    const planned = await Promise.all(canceled.map(run => f.read(run.id)))
    for (const [index, run] of planned.entries()) {
      expect(run).toMatchObject(canceled[index]!)
      expect(run).toMatchObject({ state: 'canceled', partition: { index, count: partitions } })
      expect(run.partition?.weights).toEqual(Array.from({ length: partitions }, () => 1))
      expect(run.partition?.weights).toHaveLength(partitions)
      expect(run.partition).toMatchObject({ weights: planned[0]!.partition!.weights, hostIndexes })
    }
    await f.ci.dispatch()
    expect(await Promise.all(canceled.map(run => f.read(run.id)))).toEqual(planned)
    expect(f.starts).toEqual([])
  } finally {
    release.resolve()
    await dispatch
    await f.close()
  }
})

it('pins each workspace mirror at admission and never borrows a duplicate repository workspace mirror', async () => {
  const f = await fixture()
  try {
    const workspaceIds = [f.workspaceId, randomUUID(), randomUUID()]
    const mirrors = ['site-ci-first', 'site-ci-second', null]
    for (const [index, workspaceId] of workspaceIds.entries()) {
      const record = { id: workspaceId, name: `Workspace ${index}`, repository: f.repository,
        ...(mirrors[index] ? { ciMirror: { provider: 'github', owner: 'octo', name: mirrors[index] } } : {}) }
      await f.pool.query(`insert into workspaces(id,record) values($1,$2::jsonb)
        on conflict(id) do update set record=excluded.record`, [workspaceId, JSON.stringify(record)])
    }
    const caller = await f.connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], workspaceIds)
    const resolve = workspaceMirrors(f.pool)
    for (const [index, workspaceId] of workspaceIds.entries()) {
      expect(await resolve(workspaceId)).toBe(mirrors[index] ? `octo/${mirrors[index]}` : null)
      const ticket = CiRunOutputSchema.parse(await f.value('ci_run', {
        workspaceId, suite: 'install', commandId: randomUUID(),
      }, caller.client))
      await f.ci.dispatch()
      await f.pool.query("update workspaces set record=record-'ciMirror' where id=$1", [workspaceId])
      f.control.available = true
      await f.ci.dispatch()
      const start = f.starts.find(item => item.request.runId === ticket.ticketId)!
      expect(start.request).toMatchObject({ workspaceId, ciMirror: mirrors[index] ? `octo/${mirrors[index]}` : null })
      await f.value('ci_cancel', { workspaceId, ticketId: ticket.ticketId }, caller.client)
      f.control.available = false
    }
  } finally { await f.close() }
})
