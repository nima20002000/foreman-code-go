import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { CiGetOutputSchema, CiRunOutputSchema, type CiHostReply, type CiHostRequest, type CiHostRun } from '@foreman-code/contracts'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type CiCommits, type HostCiComputer } from '../src/modules/ci-host/service.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)
beforeEach(async () => {
  await database.pool.query('truncate ci_runs, ci_file_durations, management_command_receipts, management_audit')
})

const builders: HostCiComputer[] = [
  { key: 'builder-main', label: 'Main builder', priority: 60, hostRef: { kind: 'main', mainId: 'main' } },
  { key: 'builder-paired', label: 'Paired builder', priority: 50,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'paired' } },
]

function cloudSlots(count: number): HostCiComputer[] {
  return Array.from({ length: count }, (_, slot) => ({ key: `cloud-${slot}`, label: `Cloud ${slot}`, priority: 30,
    hostRef: { kind: 'cloud' as const, mainId: 'main', provider: 'github' as const, slot },
    userSystemd: { supported: true, reason: null } }))
}

const commits: CiCommits = {
  resolve: async (_repository, _branch, commit) => commit ?? 'a'.repeat(40),
  capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
  integrationInventory: async () => {
    const files = Array.from({ length: 24 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
    return { files, durations: Object.fromEntries(files.map(file => [file, 120_000])) }
  },
  unitInventory: async () => ({ files: ['apps/api/src/site.test.ts', 'apps/web/src/site.test.tsx'],
    durations: {}, heavy: [] }),
}

/** A build computer or cloud slot that starts every assigned ticket at once and records which slot received it. */
function executor(options: { status?: (computer: HostCiComputer) => Promise<CiHostReply> } = {}) {
  const runs = new Map<string, CiHostRun>()
  const started: { key: string; runId: string }[] = []
  const request = async (computer: HostCiComputer, request: CiHostRequest): Promise<CiHostReply> => {
    if (request.operation === 'status') {
      if (options.status && computer.hostRef.kind !== 'cloud') return options.status(computer)
      return { operation: 'status', ready: true, reasons: [], cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 16,
        memoryBytes: 16 * 2 ** 30, slotsTotal: computer.hostRef.kind === 'cloud' ? 1 : 2, slotsUsed: 0, runs: [] }
    }
    if (request.operation === 'start') {
      started.push({ key: computer.key, runId: request.runId })
      const run: CiHostRun = { runId: request.runId, state: 'running', step: request.suite, exitCode: null,
        message: null, startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0 }
      runs.set(request.runId, run)
      return { operation: 'start', run }
    }
    const run = runs.get(request.runId)!
    if (request.operation === 'cancel') return { operation: 'cancel', run: { ...run, state: 'canceled' } }
    return { operation: 'read', run, text: '', nextOffset: 0 }
  }
  const finish = (runId: string) => {
    const run = runs.get(runId)!
    runs.set(runId, { ...run, state: 'passed', exitCode: 0, finishedAt: new Date().toISOString() })
  }
  return { request, started, finish }
}

async function operatorApp(ci: HostCiService, commands: PostgresCommandCoordinator) {
  const workspaceId = randomUUID()
  await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId,
    JSON.stringify({ id: workspaceId, name: 'Verification workspace', repository: {
      provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main',
    }, ciMirror: { provider: 'github', owner: 'octo', name: 'site-ci' } })])
  const access = new PostgresAccessService(database.pool)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const issued = await access.issue({ name: 'Verification caller', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{
      actions: [...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], scope: { workspaceIds: [workspaceId] },
    }] })
  const client = new Client({ name: 'verification-slots-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
    requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
  }))
  const value = async (name: string, input: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { workspaceId, ...input } })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  return { value, close: async () => {
    await client.close()
    await ci.close()
    await app.close()
  } }
}

const verification = (commit: string, priority: 'high' | 'normal' = 'high') => ({ suite: 'lint', scope: 'affected',
  files: ['apps/web/src/site.tsx'], priority, noSupersede: true, commit, commandId: randomUUID() })

it('keeps reserved cloud slots out of a gate plan and starts a fix verification on one within a dispatch pass', async () => {
  const clouds = cloudSlots(6)
  const reserved = new Set(['cloud-4', 'cloud-5'])
  const fleet = executor()
  const commands = new PostgresCommandCoordinator(database.pool)
  const ci = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), commits,
    { computers: async () => [...builders, ...clouds], request: fleet.request }, undefined, { reservedCloudSlots: 2 })
  const f = await operatorApp(ci, commands)
  try {
    const gate = CiRunOutputSchema.parse(await f.value('ci_run', { suite: 'integration', scope: 'full', gate: true,
      commit: 'a'.repeat(40), commandId: randomUUID() }))
    await ci.dispatch()
    const planned = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: gate.ticketId }))
    const parts = planned.partitions!
    expect(parts.some(run => run.plannedHostKey?.startsWith('cloud-'))).toBe(true)
    expect(parts.filter(run => reserved.has(run.plannedHostKey ?? ''))).toEqual([])
    expect(planned.gate!.computers.filter(computer => reserved.has(computer.key))).toEqual([])
    const gateCloud = parts.filter(run => run.state === 'running' && run.computer?.hostRef.kind === 'cloud')
    expect(gateCloud).toHaveLength(4)
    expect(gateCloud.filter(run => reserved.has(`cloud-${run.computer!.hostRef.slot}`))).toEqual([])
    expect(parts.some(run => run.state === 'queued' && run.suite !== 'integration')).toBe(true)

    const fix = CiRunOutputSchema.parse(await f.value('ci_run', verification('b'.repeat(40))))
    await ci.dispatch()
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: fix.ticketId }))
    expect(read.run).toMatchObject({ state: 'running', computer: { hostRef: { kind: 'cloud' } } })
    expect(reserved.has(`cloud-${read.run.computer!.hostRef.slot}`)).toBe(true)
    const stored = (await database.pool.query('select record,host_key from ci_runs where id=$1', [fix.ticketId])).rows[0]
    expect(stored.record).toEqual(read.run)
    expect(reserved.has(stored.host_key)).toBe(true)
    const active = (await database.pool.query<{ host_key: string; count: number }>(`select host_key,count(*)::int as count
      from ci_runs where state in ('starting','running') group by host_key`)).rows
    expect(active.filter(row => row.host_key.startsWith('cloud-') && row.count > 1)).toEqual([])
  } finally { await f.close() }
})

it('never dispatches a ticket to a cloud slot another Main dispatcher assigned meanwhile', async () => {
  const [slot] = cloudSlots(1)
  const builder = builders[0]!
  let paused!: () => void
  const reachedStatus = new Promise<void>(resolve => { paused = resolve })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  // The second dispatcher reads free slots, then waits on a build computer while the first assigns the cloud slot.
  const fleet = executor({ status: async computer => {
    paused()
    await held
    return { operation: 'status', ready: false, reasons: [`${computer.label} is updating`],
      cpuCount: 16, memoryBytes: 16 * 2 ** 30, runs: [] }
  } })
  const commands = new PostgresCommandCoordinator(database.pool)
  const primary = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), commits,
    { computers: async () => [slot!], request: fleet.request })
  const f = await operatorApp(primary, commands)
  const secondary = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), commits,
    { computers: async () => [builder, slot!], request: fleet.request })
  try {
    const earlier = CiRunOutputSchema.parse(await f.value('ci_run', verification('c'.repeat(40))))
    await primary.dispatch()
    const waiting = CiRunOutputSchema.parse(await f.value('ci_run', verification('d'.repeat(40), 'normal')))
    await primary.dispatch()
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: waiting.ticketId })).run.state).toBe('queued')
    fleet.finish(earlier.ticketId)
    const stale = secondary.dispatch()
    await reachedStatus
    const urgent = CiRunOutputSchema.parse(await f.value('ci_run', verification('e'.repeat(40))))
    await primary.dispatch()
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: urgent.ticketId })).run)
      .toMatchObject({ state: 'running', computer: { hostRef: slot!.hostRef } })
    release()
    await stale
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: waiting.ticketId }))
    expect(read.run).toMatchObject({ state: 'queued', computer: null, startedAt: null,
      message: expect.stringContaining('Cloud 0: slot is busy with another CI ticket') })
    expect(fleet.started.filter(start => start.runId === waiting.ticketId)).toEqual([])
    const active = (await database.pool.query<{ id: string }>(
      `select id from ci_runs where host_key=$1 and state in ('starting','running')`, [slot!.key])).rows
    expect(active.map(row => row.id)).toEqual([urgent.ticketId])
  } finally {
    release()
    await secondary.close()
    await f.close()
  }
})
