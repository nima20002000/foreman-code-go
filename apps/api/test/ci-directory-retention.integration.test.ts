import { randomUUID } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { ProductionHostCiEndpoint } from '../src/modules/ci-host/endpoint.js'
import { HostCiRunner, type HostCiPorts } from '../src/modules/ci-host/runner.js'
import { CloudCi } from '../src/modules/ci-host/cloud.js'
import type { CloudProvider } from '../src/modules/ci-host/cloudProviders.js'
import type { GitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import type { HostCiComputer } from '../src/modules/ci-host/service.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

it.each(['main', 'device', 'github', 'circleci'] as const)(
  'retains the newest 200 %s tickets, recent tickets and DB-active tickets without changing DB facts', async kind => {
    const root = await privateFixtureDirectory('ci-retention-')
    const mainId = randomUUID()
    const deviceId = randomUUID()
    let hostRef: HostCiComputer['hostRef']
    if (kind === 'main') hostRef = { kind, mainId }
    else if (kind === 'device') hostRef = { kind, mainId, deviceId }
    else hostRef = { kind: 'cloud', mainId, provider: kind, slot: 0 }
    const computer: HostCiComputer = { key: `fixture:${kind}`, hostRef, label: 'Fixture computer', priority: 1 }
    const workspaceId = randomUUID()
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Retention fixture' })])
    const ports: HostCiPorts = { cpus: 8, memoryBytes: 16 * 2 ** 30,
      now: () => new Date('2026-10-14T00:00:00Z'),
      run: async () => ({ code: 0, stdout: 'active', stderr: '' }) }
    const runner = new HostCiRunner(root, ports, {})
    const git: GitWorktreePorts = { cloneDirectory: () => root,
      git: async () => ({ code: 0, stdout: '', stderr: '' }) }
    const cloud = new CloudCi(mainId, { id: kind === 'circleci' ? 'circleci' : 'github', cpus: ports.cpus, memoryBytes: ports.memoryBytes,
      userSystemd: { supported: false, reason: 'Fixture provider' }, ready: async () => true } as CloudProvider,
      async () => null, root, ports, git)
    const endpoint = new ProductionHostCiEndpoint(database.pool, mainId, () => ({
      capabilities: () => [], request: async (_id, _namespace, request) => ({ payload: await runner.handle(request) }),
    }), runner, hostRef.kind === 'cloud' ? [cloud] : [])
    const records = []
    for (let index = 0; index < 208; index++) {
      const id = randomUUID()
      const time = new Date(Date.parse('2026-10-01T00:00:00Z') + index * 1000).toISOString()
      const recent = index === 205
      const active = index === 206
      const collecting = index === 207
      const ref = hostRef.kind === 'cloud' ? { ...hostRef, slot: index % 2 } : hostRef
      let finishedAt: string | null = time
      if (active) finishedAt = null
      else if (recent) finishedAt = new Date(Date.now() - 2 * 86_400_000).toISOString()
      const record = CiRunRecordSchema.parse({ id, workspaceId, groupId: randomUUID(), repository: 'fixture/site',
        commit: 'a'.repeat(40), suite: 'lint', partition: null, state: active ? 'running' : 'passed',
        computer: { hostRef: ref, label: computer.label }, step: null, exitCode: active ? null : 0, message: null,
        queuedAt: time, startedAt: time,
        finishedAt,
        ...(collecting ? { collection: 'pending' } : {}),
        initiator: { principalId: 'fixture-reader', executionId: null } })
      await database.pool.query('insert into ci_runs(id,workspace_id,group_id,state,record) values($1,$2,$3,$4,$5::jsonb)',
        [id, workspaceId, record.groupId, record.state, JSON.stringify(record)])
      // The executor can already be settled while Main still needs its result.
      const directory = join(root, 'runs', id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'meta.json'), JSON.stringify({ runId: id, repository: record.repository,
        mirror: 'fixture/mirror', commit: record.commit, suite: record.suite, state: 'passed', cleaned: true,
        startedAt: time, finishedAt: time, exitCode: 0, message: null, providerRunId: null }))
      await writeFile(join(directory, 'log'), 'retained log')
      records.push(record)
    }
    // Unknown local directories are never inferred to be terminal from their age alone.
    const unknown = randomUUID()
    await mkdir(join(root, 'runs', unknown))
    await writeFile(join(root, 'runs', unknown, 'meta.json'), JSON.stringify({ runId: unknown,
      repository: 'fixture/site', mirror: 'fixture/mirror', commit: 'a'.repeat(40), suite: 'lint', state: 'passed',
      cleaned: true, startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:00:00Z',
      exitCode: 0, message: null, providerRunId: null }))
    try {
      await endpoint.request(computer, { operation: 'status' })
      // There are 207 terminal records; the recent and pending records also count toward the newest 200.
      await vi.waitFor(async () => {
        for (const record of records.slice(0, 7)) {
          await expect(access(join(root, 'runs', record.id))).rejects.toMatchObject({ code: 'ENOENT' })
        }
      }, { timeout: 10_000 })
      for (const record of records.slice(7)) {
        await expect(access(join(root, 'runs', record.id))).resolves.toBeUndefined()
      }
      await expect(access(join(root, 'runs', unknown))).resolves.toBeUndefined()
      const saved = (await database.pool.query<{ record: unknown }>(
        'select record from ci_runs where workspace_id=$1', [workspaceId])).rows.map(row => row.record)
      expect(saved).toEqual(expect.arrayContaining(records))
      expect(saved).toHaveLength(records.length)
    } finally {
      if (hostRef.kind === 'cloud') await cloud.waitForMirrorCleanup('fixture/site', 'fixture/mirror')
    }
  }, 30_000,
)
