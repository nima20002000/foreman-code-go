import { randomUUID } from 'node:crypto'
import { CiRunOutputSchema, type CiHostReply, type CiHostRun } from '@foreman-code/contracts'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { CI_DISPATCH_PASS_MS } from '../src/modules/ci-host/dispatchDeadline.js'
import { CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { deferred } from './helpers/deferred.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

it('dispatches to an idle Worker while another Worker prepares its start, and records that start once it replies', async () => {
  const pool = database.pool
  const workspaceId = randomUUID()
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId, JSON.stringify({
    id: workspaceId, name: 'CI workspace',
    repository: { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' },
  })])
  const computers: HostCiComputer[] = [0, 1].map(index => ({ key: `executor:${index}`,
    hostRef: { kind: 'device', mainId: 'test-main', deviceId: `executor-${index}` },
    label: `Executor ${index}`, priority: 10 - index }))
  const remote = new Map<string, CiHostRun>()
  const entered = new Map(computers.map(computer => [computer.key, { at: 0, gate: deferred() }]))
  const release = deferred()
  const endpoint: HostCiEndpoint = {
    computers: async () => computers,
    request: async (computer, request): Promise<CiHostReply> => {
      const runs = [...remote.entries()].filter(([key]) => key.startsWith(`${computer.key}:`)).map(([, run]) => run)
      if (request.operation === 'status') {
        return { operation: 'status', ready: true, reasons: [], cpuCount: 8, memoryBytes: 8 * 2 ** 30,
          slotsUsed: runs.length, slotsTotal: 1, runs }
      }
      if (request.operation !== 'start') throw new Error(`Unexpected ${request.operation} request`)
      const key = `${computer.key}:${request.runId}`
      // The Worker prepares its repository before it replies; its status lists the start meanwhile.
      remote.set(key, { runId: request.runId, state: 'starting', step: 'dispatch', exitCode: null,
        startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0, message: null })
      const start = entered.get(computer.key)!
      start.at = performance.now()
      start.gate.resolve()
      if (computer.key === computers[0]!.key) await release.promise
      const running: CiHostRun = { ...remote.get(key)!, state: 'running', step: request.suite }
      remote.set(key, running)
      return { operation: 'start', run: running }
    },
  }
  const commits: CiCommits = {
    capabilities: async () => ({ parts: false, integrationPartitions: false, affected: true }),
    resolve: async (_repository, _branch, commit) => commit ?? 'a'.repeat(40),
  }
  const issued = await new PostgresAccessService(pool).issue({ name: 'CI caller', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: CI_RUN_ACTIONS, scope: { workspaceIds: [workspaceId] } }] })
  const ci = new HostCiService(pool, new PostgresCommandCoordinator(pool), new RunCiAuthority(pool), commits, endpoint)
  vi.spyOn(ci, 'start').mockImplementation(() => {})
  const admit = async (commit: string) => CiRunOutputSchema.parse(await ci.run(issued.principal,
    { workspaceId, suite: 'install', commit, commandId: randomUUID() }, 'mcp')).ticketId
  try {
    const slow = await admit('a'.repeat(40))
    const [first, second] = [...entered.values()]
    await first!.gate.promise
    const idle = await admit('b'.repeat(40))
    await second!.gate.promise
    release.resolve()
    await ci.dispatch()
    await ci.drain()
    const saved = await pool.query<{ id: string; state: string; host_key: string; message: string | null }>(
      `select id,state,host_key,record->>'message' as message from ci_runs where workspace_id=$1`, [workspaceId])
    expect(saved.rows).toHaveLength(2)
    expect(saved.rows).toEqual(expect.arrayContaining([
      { id: slow, state: 'running', host_key: computers[0]!.key, message: null },
      { id: idle, state: 'running', host_key: computers[1]!.key, message: null },
    ]))
    // The slow start must not hold the pass that the idle Worker's ticket waits for.
    expect(second!.at - first!.at).toBeLessThan(CI_DISPATCH_PASS_MS - 1000)
  } finally {
    release.resolve()
    await ci.close()
  }
}, 30_000)
