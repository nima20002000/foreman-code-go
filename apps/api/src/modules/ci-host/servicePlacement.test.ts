import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CiRunRecordSchema, type CiHostRequest, type CiRunRecord } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from './service.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'

const host: HostCiComputer = {
  key: 'main:builder', hostRef: { kind: 'main', mainId: 'main' }, label: 'Builder', priority: 0,
}
const cloud: HostCiComputer = {
  key: 'cloud:circleci', hostRef: { kind: 'cloud', mainId: 'main', provider: 'circleci', slot: 0 },
  label: 'CircleCI', priority: 10,
}

function queuedRuns(count: number) {
  const groupId = randomUUID()
  return Array.from({ length: count }, (_, index) => CiRunRecordSchema.parse({
    id: randomUUID(), workspaceId: 'workspace', groupId, suite: 'integration', part: null,
    scope: 'full', files: [], partition: count > 1 ? { index, count } : null,
    repository: 'owner/repo', commit: 'a'.repeat(40), state: 'queued', computer: null, step: null,
    exitCode: null, message: null, queuedAt: '2026-10-12T00:00:00.000Z', startedAt: null, finishedAt: null,
    initiator: { principalId: 'operator', executionId: null },
  }))
}

function fleet(records: CiRunRecord[], available: HostCiComputer[]) {
  const started: { computer: HostCiComputer; request: CiHostRequest }[] = []
  let writes = 0
  const pool = { query: async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith('update ci_runs')) {
      writes++
      const record = CiRunRecordSchema.parse(JSON.parse(parameters![3] as string))
      records[records.findIndex(item => item.id === record.id)] = record
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('as group_id')) {
      return { rows: records.filter(record => !record.deferred).map(record => ({ group_id: record.groupId, state: record.state })) }
    }
    if (sql.includes("'gate'='true'")) {
      return { rows: records.filter(record => record.gate).map(record => ({ record })) }
    }
    if (sql.includes("state='queued'")) {
      return { rows: records.filter(record => record.state === 'queued').map(record => ({ record, durations: null })) }
    }
    if (sql.includes("state in ('passed','failed')")) return { rows: [] }
    return { rows: records.filter(record => ['starting', 'running'].includes(record.state))
      .map(record => ({ record, host_key: record.computer?.hostRef.kind === 'cloud' ? cloud.key : host.key })) }
  } } as unknown as pg.Pool
  const endpoint: HostCiEndpoint = {
    computers: async () => available,
    request: async (computer, request) => {
      if (request.operation === 'status') {
        return { operation: 'status', ready: true, reasons: [], cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [] }
      }
      if (request.operation !== 'start') throw new Error('Unexpected fixture request')
      started.push({ computer, request })
      return { operation: 'start', run: { runId: request.runId, state: 'running', step: 'integration',
        exitCode: null, startedAt: '2026-10-12T00:00:01.000Z', finishedAt: null, logBytes: 0, message: null } }
    },
  }
  const service = new HostCiService(pool, {} as PostgresCommandCoordinator, {} as CiAuthority, {} as CiCommits, endpoint)
  return { service, started, writes: () => writes }
}

it('assigns host slices to build computers even when a cloud computer has higher priority', async () => {
  const records = queuedRuns(2)
  const f = fleet(records, [cloud, host])
  await f.service.dispatch()
  expect(f.started).toHaveLength(2)
  expect(f.started.find(item => item.computer.key === host.key)?.request)
    .toMatchObject({ partition: { index: 0, hostIndexes: [0] } })
  expect(f.started.find(item => item.computer.key === cloud.key)?.request)
    .toMatchObject({ partition: { index: 1, hostIndexes: [0] } })
  expect(records.map(record => record.state)).toEqual(['running', 'running'])
})

it('keeps the host slice queued when only cloud slots are available', async () => {
  const records = queuedRuns(2)
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(f.started[0]?.request).toMatchObject({ partition: { index: 1, hostIndexes: [0] } })
  expect(records[0]).toMatchObject({ state: 'queued', computer: null, partition: { hostIndexes: [0] },
    message: 'Waiting for a build computer: this integration slice needs one; no eligible computers' })
  expect(records[1]?.state).toBe('running')
  const writes = f.writes()
  await f.service.dispatch()
  expect(f.writes()).toBe(writes)
  const withHost = fleet(records, [cloud, host])
  await withHost.service.dispatch()
  expect(withHost.started).toHaveLength(1)
  expect(withHost.started[0]?.computer.key).toBe(host.key)
  expect(records[0]).toMatchObject({ state: 'running', message: null })
})

it('keeps an unpartitioned integration suite on a build computer', async () => {
  const records = queuedRuns(1)
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started).toEqual([])
  expect(records[0]?.state).toBe('queued')
})

it.each(['github', 'circleci'] as const)('assigns systemd slices to %s when its executor declares support', async provider => {
  const records = queuedRuns(2)
  const capable = { ...cloud, hostRef: { ...cloud.hostRef, provider },
    userSystemd: { supported: true, reason: null } }
  const f = fleet(records, [capable])
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(f.started[0]?.request).toMatchObject({ partition: { index: 0, hostIndexes: [0] } })
  expect(records[0]).toMatchObject({ state: 'running', computer: { hostRef: { kind: 'cloud', provider } } })
})

it('runs an unpartitioned systemd selection on a capable cloud slot', async () => {
  const records = queuedRuns(1)
  records[0] = CiRunRecordSchema.parse({ ...records[0], scope: 'affected',
    files: ['apps/api/test/native-service-restart.integration.test.ts'] })
  const f = fleet(records, [{ ...cloud, userSystemd: { supported: true, reason: null } }])
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(records[0]?.state).toBe('running')
})

it('plans systemd files on capable cloud capacity and keeps a build computer available for other slices', async () => {
  const records = queuedRuns(2)
  const f = fleet(records, [host, { ...cloud, userSystemd: { supported: true, reason: null } }])
  await f.service.dispatch()
  expect(f.started.find(item => item.computer.key === cloud.key)?.request)
    .toMatchObject({ partition: { index: 0, hostIndexes: [0] } })
  expect(f.started.find(item => item.computer.key === host.key)?.request)
    .toMatchObject({ partition: { index: 1, hostIndexes: [0] } })
})

it.each([host, cloud])('dispatches high priority then oldest tickets on $label', async computer => {
  const records = queuedRuns(4).map((record, index) => CiRunRecordSchema.parse({ ...record,
    suite: 'install', partition: null, priority: index > 1 ? 'high' : 'normal',
    queuedAt: new Date(Date.parse(record.queuedAt) + index * 1000).toISOString(),
  }))
  const f = fleet(records, [computer])
  const expected = [records[2]!.id, records[3]!.id, records[0]!.id, records[1]!.id]
  for (const id of expected) {
    await f.service.dispatch()
    expect(f.started.at(-1)?.request).toMatchObject({ runId: id })
    const running = records.find(record => record.id === id)!
    running.state = 'passed'
  }
  expect(f.started.map(item => item.request.operation === 'start' ? item.request.runId : null)).toEqual(expected)
})

it('dispatches a duration-planned single ordinary full slice to cloud', async () => {
  const records = queuedRuns(1).map(run => ({ ...run, expectedDurationMs: 210_000, requiresBuildComputer: false }))
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(f.started[0]!.computer.key).toBe(cloud.key)
  expect(records[0]!.state).toBe('running')
})


function tieredRuns() {
  const [fast, slow] = queuedRuns(2)
  return [CiRunRecordSchema.parse({ ...fast, partition: { index: 0, count: 1, weights: [1], tier: 'fast', slowFiles: ['slow'] } }),
    CiRunRecordSchema.parse({ ...slow, partition: { index: 0, count: 1, weights: [1], tier: 'slow', slowFiles: ['slow'] },
      deferred: true })]
}

it('starts the slow tier only after every other part of its request passed', async () => {
  const records = tieredRuns()
  const f = fleet(records, [cloud, { ...cloud, key: 'cloud:circleci:1', hostRef: { ...cloud.hostRef, slot: 1 } }])
  await f.service.dispatch()
  expect(f.started.map(item => item.request.operation === 'start' ? item.request.runId : null)).toEqual([records[0]!.id])
  records[0] = CiRunRecordSchema.parse({ ...records[0]!, state: 'passed', finishedAt: '2026-10-12T00:05:00.000Z' })
  await f.service.dispatch()
  expect(f.started.map(item => item.request.operation === 'start' ? item.request.runId : null))
    .toEqual([records[0]!.id, records[1]!.id])
})

it('skips the slow tier with a reason when another part of its request failed', async () => {
  const records = tieredRuns()
  records[0] = CiRunRecordSchema.parse({ ...records[0]!, state: 'failed', finishedAt: '2026-10-12T00:05:00.000Z' })
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started).toHaveLength(0)
  expect(records[1]).toMatchObject({ state: 'canceled',
    message: expect.stringContaining('slow tests run only after every other test of this request passed') })
})

it('lets later full requests dispatch when the oldest gate already has a failed part', async () => {
  const [failed, straggler] = queuedRuns(2).map((run, index) => CiRunRecordSchema.parse({ ...run, gate: true,
    state: index ? 'running' : 'failed', computer: index ? { hostRef: cloud.hostRef, label: cloud.label } : null,
    startedAt: '2026-10-12T00:00:01.000Z', finishedAt: index ? null : '2026-10-12T00:01:00.000Z' }))
  const [later] = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, suite: 'lint', partition: null,
    queuedAt: '2026-10-12T00:02:00.000Z' }))
  const records = [failed!, straggler!, later!]
  const second = { ...cloud, key: 'cloud:circleci:1', hostRef: { ...cloud.hostRef, slot: 1 } }
  const f = fleet(records, [cloud, second])
  await f.service.dispatch()
  expect(f.started.map(item => item.request.operation === 'start' ? item.request.runId : null)).toEqual([later!.id])
  expect(records[2]).toMatchObject({ state: 'running', message: null })
  expect(records[1]!.state).toBe('running')
})
