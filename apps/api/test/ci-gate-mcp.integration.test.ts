import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { CiGetOutputSchema, CiRunOutputSchema, exclusiveIntegrationFiles, userSystemdIntegrationFiles,
  type CiHostRun, type CiHostRequest } from '@foreman-code/contracts'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type HostCiComputer } from '../src/modules/ci-host/service.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)
beforeEach(async () => {
  await database.pool.query('truncate ci_runs, ci_file_durations, management_command_receipts, management_audit')
})

async function fixture(options: { cloudSlots?: number; files?: string[]; offlineKey?: string } = {}) {
  const workspaceId = randomUUID()
  await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId,
    JSON.stringify({ id: workspaceId, name: 'Gate workspace', repository: {
      provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main',
    } })])
  const computers: HostCiComputer[] = [
    { key: 'builder-main', label: 'Main builder', priority: 60, hostRef: { kind: 'main', mainId: 'main' } },
    { key: 'builder-paired', label: 'Paired builder', priority: 50,
      hostRef: { kind: 'device', mainId: 'main', deviceId: 'paired' } },
    ...Array.from({ length: options.cloudSlots ?? 24 }, (_, slot) => ({ key: `cloud-${slot}`, label: `Cloud ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'main', provider: 'github' as const, slot },
      userSystemd: { supported: true, reason: null } })),
  ]
  const files = options.files ?? [...userSystemdIntegrationFiles,
    ...Array.from({ length: 48 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)]
  const runs = new Map<string, CiHostRun>()
  const started: { key: string; request: CiHostRequest }[] = []
  const commands = new PostgresCommandCoordinator(database.pool)
  const ci = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), {
    resolve: async (_repository, _branch, commit) => commit ?? 'a'.repeat(40),
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    integrationInventory: async () => ({ files, durations: Object.fromEntries(files.map(file => [file, 120_000])) }),
    unitInventory: async () => ({ files: ['apps/api/src/site.test.ts', 'apps/web/src/site.test.tsx'],
      durations: {}, heavy: [] }),
  }, {
    computers: async () => computers,
    request: async (computer, request) => {
      if (computer.key === options.offlineKey) throw new Error('Computer disconnected')
      if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
        cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 16, memoryBytes: 16 * 2 ** 30,
        slotsTotal: computer.hostRef.kind === 'cloud' ? 1 : 2, slotsUsed: 0, runs: [] }
      if (request.operation === 'start') {
        started.push({ key: computer.key, request })
        const run: CiHostRun = { runId: request.runId, state: 'running', step: request.suite,
          exitCode: null, message: null, startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0 }
        runs.set(request.runId, run)
        return { operation: 'start', run }
      }
      const run = runs.get(request.runId)!
      if (request.operation === 'cancel') return { operation: 'cancel', run: { ...run, state: 'canceled' } }
      return { operation: 'read', run, text: '', nextOffset: 0 }
    },
  })
  const access = new PostgresAccessService(database.pool)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (readOnly = false) => {
    const issued = await access.issue({ name: 'Gate caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{
        actions: readOnly ? CI_GET_ACTIONS : [...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], scope: { workspaceIds: [workspaceId] },
      }] })
    const client = new Client({ name: 'gate-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
    }))
    return client
  }
  const operator = await connect()
  const call = (client: Client, name: string, input: Record<string, unknown>) =>
    client.callTool({ name, arguments: { workspaceId, ...input } })
  const value = async (name: string, input: Record<string, unknown>) => {
    const result = await call(operator, name, input)
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  const finish = () => {
    for (const [id, run] of runs) runs.set(id, { ...run, state: 'passed', exitCode: 0,
      finishedAt: new Date(Date.parse(run.startedAt) + 1000).toISOString() })
  }
  return { ci, started, files, connect, call, value, operator, finish, close: async () => {
    await Promise.all(clients.map(client => client.close()))
    await ci.close()
    await app.close()
  } }
}

it('admits one complete gate, denies a reader, and persists the plan and measured critical path through MCP', async () => {
  const f = await fixture()
  try {
    const input = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40), commandId: randomUUID() }
    const reader = await f.connect(true)
    expect((await f.call(reader, 'ci_run', input)).isError).toBe(true)
    expect((await database.pool.query('select count(*)::int as count from ci_runs')).rows[0].count).toBe(0)
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value('ci_run', input))).toEqual(admitted)
    await f.ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    expect(new Set(read.partitions!.map(run => run.suite))).toEqual(new Set(['typecheck', 'lint', 'unit', 'integration']))
    expect(read.partitions!.every(run => run.scope === 'full')).toBe(true)
    const hosts = f.started.filter(item => item.key.startsWith('builder-'))
    expect(hosts).toHaveLength(2)
    for (const host of hosts) expect(host.request).toMatchObject({ suite: 'integration', gate: true, integrationShards: 12 })
    const integration = f.started.filter(item => item.request.operation === 'start' && item.request.suite === 'integration')
    const assigned = integration.flatMap(item => item.request.operation === 'start' ? item.request.files ?? [] : [])
    expect(assigned.sort()).toEqual([...f.files].sort())
    expect(new Set(assigned).size).toBe(assigned.length)
    expect(integration.some(item => item.key.startsWith('cloud-'))).toBe(true)
    expect(read).toMatchObject({ gate: { computers: expect.any(Array), criticalPath: {
      expectedDurationMs: expect.any(Number), actualDurationMs: null,
    } } })
    f.finish()
    await f.ci.dispatch()
    const finished = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    expect(finished.group?.state).toBe('passed')
    expect(finished).toMatchObject({ gate: { suites: expect.arrayContaining([
      expect.objectContaining({ suite: 'integration', actualDurationMs: 1000 }),
    ]), criticalPath: { actualDurationMs: expect.any(Number) } } })
    const stored = (await database.pool.query('select record from ci_runs where group_id=$1', [read.run.groupId])).rows
    expect(stored.map(row => row.record)).toEqual(expect.arrayContaining(finished.partitions!))
  } finally { await f.close() }
})

it('admits a gate on the ready fleet when another build computer is disconnected', async () => {
  const f = await fixture({ offlineKey: 'builder-paired' })
  try {
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40), commandId: randomUUID(),
    }))
    await f.ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    expect(read.gate!.computers.some(computer => computer.key === 'builder-paired')).toBe(false)
    expect(read.partitions!.filter(run => run.suite === 'integration').flatMap(run => run.files).sort())
      .toEqual([...f.files].sort())
  } finally { await f.close() }
})

it('runs cloud checks before systemd integration overflow assigned to the same slot', async () => {
  const f = await fixture({ cloudSlots: 4, files: [...exclusiveIntegrationFiles] })
  try {
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40), commandId: randomUUID(),
    }))
    await f.ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    const overflow = read.partitions!.filter(run => run.suite === 'integration'
      && run.plannedHostKey?.startsWith('cloud-'))
    expect(overflow.length).toBeGreaterThan(0)
    for (const run of overflow) {
      const checks = read.partitions!.filter(check => check.suite !== 'integration'
        && check.plannedHostKey === run.plannedHostKey)
      expect(checks.length).toBeGreaterThan(0)
      expect(run.state).toBe('queued')
      expect(checks.some(check => check.state === 'running')).toBe(true)
    }
  } finally { await f.close() }
})

it('queues full requests and a second gate behind the first while affected requests keep using spare cloud slots', async () => {
  const f = await fixture()
  try {
    const gate = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40) }
    const first = CiRunOutputSchema.parse(await f.value('ci_run', { ...gate, commandId: randomUUID() }))
    const full = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'lint', scope: 'full', commandId: randomUUID(), commit: 'b'.repeat(40),
    }))
    const affected = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'lint', scope: 'affected', files: ['apps/web/src/site.tsx'], commandId: randomUUID(), commit: 'b'.repeat(40),
    }))
    const second = CiRunOutputSchema.parse(await f.value('ci_run', { ...gate, commandId: randomUUID() }))
    await f.ci.dispatch()
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: first.ticketId })).group?.state).toBe('running')
    for (const ticketId of [full.ticketId, second.ticketId]) {
      expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId }))).toMatchObject({
        run: { state: 'queued', message: expect.stringContaining('gate') },
        queue: { reason: expect.stringContaining('gate') },
      })
    }
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: affected.ticketId })).run.state).toBe('running')
    f.finish()
    await f.ci.dispatch()
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: second.ticketId })).group?.state).toBe('running')
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: full.ticketId })).run.state).toBe('queued')
  } finally { await f.close() }
})
