import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CiHostRequestSchema, CiRunRecordSchema, type CiDurations, type CiHostRequest, type CiRunRecord } from '@foreman-code/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from './service.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'

afterEach(() => { vi.restoreAllMocks() })

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

function fleet(records: CiRunRecord[], available: HostCiComputer[],
  unavailable = new Map<string, string>(), occupied = new Set<string>(), slots = new Map<string, number>(),
  options: { cpuCounts?: Map<string, number>; durations?: CiDurations; reservedCloudSlots?: number } = {}) {
  const started: { computer: HostCiComputer; request: CiHostRequest; assigned: CiRunRecord }[] = []
  let writes = 0
  const pool = { options: { max: 10 }, query: async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith('select pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }] }
    if (sql.startsWith('select record from ci_runs where id=')) {
      return { rows: records.filter(record => record.id === parameters![0]).map(record => ({ record })) }
    }
    if (sql.startsWith('insert into ci_runs')) {
      records.push(CiRunRecordSchema.parse(JSON.parse(parameters![3] as string)))
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('update ci_runs')) {
      writes++
      if (parameters?.length === 2) {
        const plans = JSON.parse(parameters[0] as string) as { id: string; patch: Partial<CiRunRecord> }[]
        const rows = plans.map(plan => {
          const index = records.findIndex(item => item.id === plan.id)
          records[index] = CiRunRecordSchema.parse({ ...records[index], ...plan.patch })
          return { record: records[index] }
        })
        return { rows, rowCount: rows.length }
      }
      const record = CiRunRecordSchema.parse(JSON.parse(parameters![3] as string))
      const previous = records.find(item => item.id === record.id)
      if (sql.includes("state='queued'") && (previous?.state !== 'queued'
        || JSON.stringify(previous) !== parameters![4])) return { rows: [], rowCount: 0 }
      records[records.findIndex(item => item.id === record.id)] = record
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('where group_id=any')) {
      return { rows: records.map(record => ({ record })) }
    }
    if (sql.includes('as group_id')) {
      return { rows: records.filter(record => !record.deferred).map(record => ({ group_id: record.groupId, state: record.state })) }
    }
    if (sql.includes("state='queued'")) {
      return { rows: records.filter(record => record.state === 'queued')
        .map(record => ({ record, durations: options.durations ?? null })) }
    }
    if (sql.includes("'gate'='true'")) {
      return { rows: records.filter(record => record.gate).map(record => ({ record })) }
    }
    if (sql.includes("state in ('passed','failed')")) return { rows: [] }
    return { rows: records.filter(record => ['starting', 'running'].includes(record.state))
      .map(record => ({ record, host_key: record.computer?.hostRef.kind === 'cloud' ? cloud.key : host.key })) }
  }, connect: async () => ({ query: pool.query, release: () => {} }) } as unknown as pg.Pool
  const endpoint: HostCiEndpoint = {
    computers: async () => available,
    request: async (computer, request) => {
      if (request.operation === 'status') {
        const reason = unavailable.get(computer.key)
        if (reason === 'offline' || reason === 'extension-rejected') throw new Error(reason)
        return { operation: 'status', ready: !reason, reasons: reason ? [reason] : [],
          cpuCount: options.cpuCounts?.get(computer.key) ?? 8,
          memoryBytes: (options.cpuCounts?.get(computer.key) ?? 16) * 2 * 2 ** 30, runs: [],
          slotsTotal: slots.get(computer.key) ?? 1, slotsUsed: occupied.has(computer.key) ? 1 : 0 }
      }
      if (request.operation !== 'start') throw new Error('Unexpected fixture request')
      if (unavailable.has(computer.key)) throw new Error('Unavailable executor cannot start work')
      const assigned = CiRunRecordSchema.parse(records.find(record => record.id === request.runId))
      started.push({ computer, request, assigned })
      return { operation: 'start', run: { runId: request.runId, state: 'running', step: 'integration',
        exitCode: null, startedAt: '2026-10-12T00:00:01.000Z', finishedAt: null, logBytes: 0, message: null } }
    },
  }
  const service = new HostCiService(pool, {} as PostgresCommandCoordinator, {} as CiAuthority, {} as CiCommits,
    endpoint, undefined, options)
  return { service, started, writes: () => writes }
}

const gateChecks = [
  { suite: 'typecheck', part: 'typecheck-api' },
  { suite: 'lint', part: 'lint-api' },
  { suite: 'unit', part: 'unit-api' },
] as const

function buildGateRun(files = ['apps/api/test/feature.integration.test.ts']) {
  return CiRunRecordSchema.parse({ ...queuedRuns(1)[0], gate: true, noSupersede: true,
    priority: 'high', priorityReason: 'gate', plannedHostKey: host.key, integrationShards: 12,
    expectedDurationMs: 300_000, files, requiresBuildComputer: false })
}

it.each(['not-ready', 'offline', 'disabled'])(
  'keeps a build-sized gate part off cloud while its planned computer is %s during the grace period', async reason => {
    const records = [buildGateRun()]
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(records[0]!.queuedAt) + 90_000)
    const available = reason === 'disabled' ? [cloud] : [host, cloud]
    const f = fleet(records, available, new Map([[host.key, reason]]), new Set(), new Map(),
      { cpuCounts: new Map([[cloud.key, 4]]) })
    await f.service.dispatch()
    expect(f.started).toEqual([])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ state: 'queued', plannedHostKey: host.key, integrationShards: 12 })
  })

it.each([8, 12, 16])('requires planned capacity before a %i-shard spare can steal a build gate part', async cpuCount => {
  const replacement: HostCiComputer = { key: 'device:spare', label: 'Spare builder', priority: 0,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'spare' } }
  const records = [buildGateRun()]
  const elapsed = cpuCount >= 12 ? 91_000 : 30_000
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(records[0]!.queuedAt) + elapsed)
  const f = fleet(records, [host, replacement, cloud], new Map([[host.key, 'not-ready']]), new Set(), new Map(),
    { cpuCounts: new Map([[replacement.key, cpuCount], [cloud.key, 4]]) })
  await f.service.dispatch()
  expect(f.started).toHaveLength(cpuCount >= 12 ? 1 : 0)
  if (cpuCount >= 12) {
    expect(f.started[0]?.computer.key).toBe(replacement.key)
    expect(f.started[0]?.request).toMatchObject({ files: records[0]!.files, integrationShards: cpuCount })
    expect(records[0]).toMatchObject({ plannedHostKey: host.key, integrationShards: 12 })
  } else expect(records[0]?.state).toBe('queued')
})

it('uses the spare build allowance when checking capacity for a gate takeover', async () => {
  const replacement: HostCiComputer = { key: 'device:spare', label: 'Spare builder', priority: 0,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'spare' }, buildAllowancePercent: 50 }
  const records = [buildGateRun()]
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(records[0]!.queuedAt) + 30_000)
  const f = fleet(records, [host, replacement], new Map(), new Set([host.key]), new Map(),
    { cpuCounts: new Map([[replacement.key, 16]]) })
  await f.service.dispatch()
  expect(f.started).toEqual([])
  expect(records[0]).toMatchObject({ state: 'queued', plannedHostKey: host.key, integrationShards: 12 })
})

it('splits an unavailable build gate after 90 seconds by file duration and fills only free unreserved cloud slots', async () => {
  const files = Array.from({ length: 80 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const durations = Object.fromEntries(files.map((file, index) => [file, index < 24 ? 60_000 : 5_000]))
  const records = [buildGateRun(files)]
  const original = { ...records[0]! }
  const clouds = Array.from({ length: 4 }, (_, slot) => ({ ...cloud, key: `cloud:circleci:${slot}`,
    hostRef: { ...cloud.hostRef, slot } }))
  const occupied = new Set([clouds[2]!.key])
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(original.queuedAt) + 90_001)
  const f = fleet(records, [host, ...clouds], new Map([[host.key, 'not-ready']]), occupied, new Map(),
    { durations, cpuCounts: new Map(clouds.map(computer => [computer.key, 4])), reservedCloudSlots: 1 })
  await f.service.dispatch()
  expect(records.length).toBeGreaterThan(1)
  expect(records.some(record => record.id === original.id)).toBe(true)
  expect(records.flatMap(record => record.files).sort()).toEqual([...files].sort())
  for (const record of records) {
    expect(record).toMatchObject({ groupId: original.groupId, workspaceId: original.workspaceId,
      commit: original.commit, gate: true, noSupersede: true, queuedAt: original.queuedAt,
      integrationShards: 4, partition: null, initiator: original.initiator })
    const measured = record.files.reduce((sum, file) => sum + durations[file]!, 0)
    expect(measured).toBeLessThanOrEqual(240_000)
    expect(record.expectedDurationMs).toBe(90_000 + measured)
  }
  expect(f.started).toHaveLength(2)
  expect(f.started.map(item => item.computer.key).sort()).toEqual([clouds[0]!.key, clouds[1]!.key])
  expect(records.filter(record => record.state === 'queued').length).toBeGreaterThan(0)
  for (const item of f.started) {
    expect(item.request).toMatchObject({ operation: 'start', gate: true, scope: 'full', integrationShards: 4,
      durations, files: item.assigned.files })
    expect(item.assigned.files.length).toBeLessThan(files.length)
  }
  const ids = records.map(record => record.id).sort()
  for (const record of records.filter(record => record.state === 'running')) record.state = 'passed'
  for (const computer of clouds) occupied.add(computer.key)
  await f.service.dispatch()
  expect(records.map(record => record.id).sort()).toEqual(ids)
  expect(f.started).toHaveLength(2)
})

it('keeps an expired build gate intact while its planned computer is ready but occupied', async () => {
  const records = [buildGateRun()]
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(records[0]!.queuedAt) + 91_000)
  const f = fleet(records, [host, cloud], new Map(), new Set([host.key]), new Map(),
    { cpuCounts: new Map([[cloud.key, 4]]) })
  await f.service.dispatch()
  expect(f.started).toEqual([])
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ state: 'queued', plannedHostKey: host.key })
})

it.each(gateChecks)('runs a gate $suite part on another free slot of its planned provider', async check => {
  const planned: HostCiComputer = { ...cloud, key: 'cloud:github:0', label: 'GitHub slot 0',
    hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 0 } }
  const replacement: HostCiComputer = { ...planned, key: 'cloud:github:1', label: 'GitHub slot 1',
    hostRef: { ...planned.hostRef, slot: 1 } }
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, ...check, gate: true,
    plannedHostKey: planned.key, expectedDurationMs: 150_000, partition: null }))
  const f = fleet(records, [planned, cloud, host, replacement], new Map(), new Set([planned.key]))
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(f.started[0]?.computer.key).toBe(replacement.key)
  expect(f.started[0]?.request).toMatchObject({ operation: 'start', runId: records[0]!.id, ...check })
  expect(records[0]).toMatchObject({ state: 'running', plannedHostKey: planned.key,
    expectedDurationMs: 150_000, computer: { hostRef: replacement.hostRef } })
})

it.each(gateChecks)('runs a gate $suite part on an idle build computer when cloud slots are busy', async check => {
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, ...check, gate: true,
    plannedHostKey: cloud.key, partition: null }))
  const f = fleet(records, [cloud, host], new Map(), new Set([cloud.key]))
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(f.started[0]?.computer.key).toBe(host.key)
  expect(f.started[0]?.request).toMatchObject({ operation: 'start', runId: records[0]!.id, ...check })
  expect(records[0]).toMatchObject({ state: 'running', plannedHostKey: cloud.key,
    computer: { hostRef: host.hostRef } })
})

it.each([false, true])('moves a systemd gate integration part to a free provider slot only with support: %s',
  async supported => {
    const replacement = { ...cloud, key: 'cloud:circleci:1', hostRef: { ...cloud.hostRef, slot: 1 },
      userSystemd: { supported, reason: supported ? null : 'No user manager' } }
    const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true,
      plannedHostKey: cloud.key, partition: null, integrationShards: 32, requiresBuildComputer: true,
      files: ['apps/api/test/native-service-restart.integration.test.ts'] }))
    const f = fleet(records, [cloud, replacement], new Map(), new Set([cloud.key]))
    await f.service.dispatch()
    expect(f.started).toHaveLength(supported ? 1 : 0)
    expect(records[0]?.state).toBe(supported ? 'running' : 'queued')
    if (supported) {
      expect(f.started[0]?.computer.key).toBe(replacement.key)
      expect(f.started[0]?.request).toMatchObject({ gate: true, files: records[0]!.files, integrationShards: 8 })
      expect(records[0]?.plannedHostKey).toBe(cloud.key)
      expect(records[0]?.integrationShards).toBe(32)
    }
  })

it.each(gateChecks)('keeps a gate $suite check queued while the build computer starts its own exclusive gate part', async check => {
  const records = queuedRuns(2).map((run, index) => CiRunRecordSchema.parse({ ...run, gate: true,
    ...(index === 0 ? { ...check, plannedHostKey: cloud.key }
      : { plannedHostKey: host.key, integrationShards: 16, requiresBuildComputer: false,
        files: ['apps/api/test/workflow.integration.test.ts'] }),
    partition: null }))
  const f = fleet(records, [cloud, host], new Map(), new Set([cloud.key]))
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(f.started[0]?.computer.key).toBe(host.key)
  expect(f.started[0]?.request).toMatchObject({ operation: 'start', runId: records[1]!.id,
    suite: 'integration', gate: true, scope: 'full', integrationShards: 8,
    files: ['apps/api/test/workflow.integration.test.ts'] })
  expect(records[0]).toMatchObject({ state: 'queued', computer: null })
  expect(records[1]).toMatchObject({ state: 'running', plannedHostKey: host.key, integrationShards: 16,
    computer: { hostRef: host.hostRef } })
})

it('does not start a gate check on a build computer with an occupied CI slot', async () => {
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, suite: 'typecheck',
    part: 'typecheck-api', gate: true, plannedHostKey: cloud.key, partition: null }))
  const f = fleet(records, [cloud, host], new Map(), new Set([cloud.key, host.key]))
  await f.service.dispatch()
  expect(f.started).toEqual([])
  expect(records[0]).toMatchObject({ state: 'queued', computer: null })
})

it.each([
  { ownPart: 'none', requiresBuildComputer: false },
  { ownPart: 'passed', requiresBuildComputer: false },
  { ownPart: 'none', requiresBuildComputer: true },
  { ownPart: 'passed', requiresBuildComputer: true },
])('steals a busy build computer integration part with own part=$ownPart and systemd=$requiresBuildComputer',
  async ({ ownPart, requiresBuildComputer }) => {
    const replacement: HostCiComputer = { key: 'device:spare', label: 'Spare builder', priority: 0,
      hostRef: { kind: 'device', mainId: 'main', deviceId: 'spare' } }
    const records = queuedRuns(2).map(run => CiRunRecordSchema.parse({ ...run, gate: true,
      plannedHostKey: host.key, partition: null, integrationShards: 32, requiresBuildComputer,
      expectedDurationMs: 120_000,
      files: [requiresBuildComputer ? 'apps/api/test/native-service-restart.integration.test.ts'
        : 'apps/api/test/workflow.integration.test.ts'],
    }))
    if (ownPart === 'passed') {
      records[1] = CiRunRecordSchema.parse({ ...records[1], plannedHostKey: replacement.key, state: 'passed',
        computer: { hostRef: replacement.hostRef, label: replacement.label },
        startedAt: '2026-10-12T00:00:01.000Z', finishedAt: '2026-10-12T00:01:00.000Z' })
    } else records.pop()
    const f = fleet(records, [host, replacement, cloud], new Map(), new Set([host.key]), new Map(),
      { cpuCounts: new Map([[replacement.key, 32]]) })
    await f.service.dispatch()
    expect(f.started).toHaveLength(1)
    expect(f.started[0]?.computer.key).toBe(replacement.key)
    expect(f.started[0]?.request).toMatchObject({ operation: 'start', runId: records[0]!.id,
      suite: 'integration', gate: true, scope: 'full', files: records[0]!.files, integrationShards: 32 })
    expect(f.started[0]?.assigned).toMatchObject({ state: 'starting', step: 'dispatch',
      plannedHostKey: host.key, integrationShards: 32, expectedDurationMs: 120_000,
      computer: { hostRef: replacement.hostRef }, dispatchHostKey: replacement.key,
      dispatchedAt: expect.any(String), dispatchAttempts: 1, dispatchRequest: f.started[0]!.request })
    expect(records[0]).toMatchObject({ state: 'running', plannedHostKey: host.key, integrationShards: 32,
      step: 'integration', expectedDurationMs: 120_000, computer: { hostRef: replacement.hostRef } })
    expect(records[0]?.dispatchRequest).toBeUndefined()
    expect(records[0]?.dispatchHostKey).toBeUndefined()
    expect(records[0]?.dispatchedAt).toBeUndefined()
    if (ownPart === 'passed') expect(records[1]?.state).toBe('passed')
  })

it.each(['queued-own-part', 'occupied-slot', 'not-ready'])(
  'keeps a busy build computer integration part queued when the spare has %s', async reason => {
    const replacement: HostCiComputer = { key: 'device:spare', label: 'Spare builder', priority: 0,
      hostRef: { kind: 'device', mainId: 'main', deviceId: 'spare' } }
    const records = queuedRuns(2).map((run, index) => CiRunRecordSchema.parse({ ...run, gate: true,
      plannedHostKey: index ? replacement.key : host.key, partition: null,
      integrationShards: 32, requiresBuildComputer: false,
      files: ['apps/api/test/workflow.integration.test.ts'],
    }))
    if (reason !== 'queued-own-part') records.pop()
    const occupied = new Set([host.key])
    if (reason === 'occupied-slot') occupied.add(replacement.key)
    const unavailable = new Map<string, string>()
    if (reason === 'not-ready') unavailable.set(replacement.key, reason)
    const f = fleet(records, [host, replacement, cloud], unavailable, occupied, new Map([[replacement.key, 2]]),
      { cpuCounts: new Map([[replacement.key, 32]]) })
    await f.service.dispatch()
    expect(records[0]).toMatchObject({ state: 'queued', computer: null })
    expect(f.started).toHaveLength(reason === 'queued-own-part' ? 1 : 0)
    if (reason === 'queued-own-part') {
      expect(f.started[0]?.request).toMatchObject({ runId: records[1]!.id })
      expect(records[1]).toMatchObject({ state: 'running', computer: { hostRef: replacement.hostRef } })
    }
  })

it.each(['not-ready', 'offline', 'extension-rejected', 'disabled'])(
  'dispatches a queued gate part elsewhere after its planned computer becomes %s', async reason => {
    const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true,
      plannedHostKey: host.key, partition: null, integrationShards: 32, requiresBuildComputer: false,
      files: ['apps/api/test/workflow.integration.test.ts'],
    }))
    const replacement: HostCiComputer = { key: 'device:replacement', label: 'Replacement builder', priority: 0,
      hostRef: { kind: 'device', mainId: 'main', deviceId: 'replacement' } }
    const available = [host, replacement, cloud]
    const unavailable = new Map<string, string>()
    const f = fleet(records, available, unavailable, new Set([host.key]), new Map(),
      { cpuCounts: new Map([[replacement.key, 32]]) })
    if (reason === 'disabled') available.splice(0, 1)
    else unavailable.set(host.key, reason)
    await f.service.dispatch()
    expect(f.started).toHaveLength(1)
    expect(f.started[0]?.computer.key).toBe(replacement.key)
    expect(f.started[0]?.request).toMatchObject({ operation: 'start', runId: records[0]!.id,
      gate: true, files: records[0]!.files, integrationShards: 32 })
    expect(records[0]).toMatchObject({ state: 'running', plannedHostKey: host.key, integrationShards: 32,
      computer: { hostRef: replacement.hostRef } })
    expect(records[0]?.files).toEqual(['apps/api/test/workflow.integration.test.ts'])
    expect(records[0]?.gate).toBe(true)
  },
)

it.each([false, true])('splits an expired systemd gate part only onto a capable cloud slot: supported=%s', async supported => {
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true,
    plannedHostKey: host.key, partition: null, integrationShards: 32, requiresBuildComputer: true,
    files: ['apps/api/test/native-service-restart.integration.test.ts'],
  }))
  const capable = { ...cloud, userSystemd: { supported, reason: supported ? null : 'No user manager' } }
  const f = fleet(records, [capable])
  await f.service.dispatch()
  expect(f.started).toHaveLength(supported ? 1 : 0)
  expect(records[0]?.state).toBe(supported ? 'running' : 'queued')
  if (supported) {
    expect(f.started[0]?.computer.key).toBe(cloud.key)
    expect(f.started[0]?.request).toMatchObject({ gate: true, files: records[0]!.files, integrationShards: 8 })
    expect(records[0]?.computer?.hostRef).toEqual(cloud.hostRef)
    expect(records[0]).toMatchObject({ plannedHostKey: cloud.key, integrationShards: 8 })
  }
})

it('keeps an unavailable planned gate queued when no replacement is ready', async () => {
  const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run, gate: true,
    plannedHostKey: host.key, partition: null, integrationShards: 16, requiresBuildComputer: false,
    files: ['apps/api/test/workflow.integration.test.ts'],
  }))
  const f = fleet(records, [cloud], new Map([[cloud.key, 'not-ready']]))
  await f.service.dispatch()
  expect(f.started).toEqual([])
  expect(records[0]).toMatchObject({ state: 'queued', computer: null })
})

it.each([
  { suite: 'integration', requiresBuildComputer: true,
    files: ['apps/api/test/native-service-restart.integration.test.ts'] },
  { suite: 'integration', requiresBuildComputer: false,
    files: ['apps/api/test/workflow.integration.test.ts'] },
  { suite: 'unit', requiresBuildComputer: false,
    files: ['apps/api/src/modules/ci-host/servicePlacement.test.ts'] },
] as const)('prefers an idle build computer for affected $suite with requiresBuildComputer=$requiresBuildComputer',
  async ({ suite, requiresBuildComputer, files }) => {
    const records = queuedRuns(1).map(run => CiRunRecordSchema.parse({ ...run,
      suite, scope: 'affected', files, requiresBuildComputer,
    }))
    const circleci = { ...cloud, userSystemd: { supported: true, reason: null } }
    const github: HostCiComputer = {
      ...circleci, key: 'cloud:github', label: 'GitHub',
      hostRef: { kind: 'cloud', mainId: 'main', provider: 'github', slot: 0 },
    }
    const f = fleet(records, [circleci, github, host])
    await f.service.dispatch()
    expect(f.started).toHaveLength(1)
    expect(f.started[0]?.computer.key).toBe(host.key)
    expect(f.started[0]?.request).toMatchObject({ operation: 'start', suite, scope: 'affected', files })
    expect(records[0]).toMatchObject({ state: 'running', computer: { hostRef: host.hostRef } })
  })

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


function tieredRuns({ gate = false }: { gate?: boolean } = {}) {
  const fastFile = 'apps/api/test/workflow.integration.test.ts'
  const slowFile = 'apps/api/test/workflow-recovery.integration.test.ts'
  return queuedRuns(2).map((run, index) => {
    const file = index === 0 ? fastFile : slowFile
    const tier = index === 0 ? 'fast' : 'slow'
    const selection = gate
      ? { partition: null, files: [file],
        integrationShards: 8, plannedHostKey: cloud.key, requiresBuildComputer: false }
      : { partition: { index: 0, count: 1, weights: [1], tier, slowFiles: [slowFile] } }
    return CiRunRecordSchema.parse({ ...run, ...selection, gate, ...(index === 1 ? { deferred: true } : {}) })
  })
}

it('dispatches the deferred gate selection with valid host requests after a fast failure', async () => {
  const records = tieredRuns({ gate: true })
  records[0] = CiRunRecordSchema.parse({ ...records[0]!, state: 'failed', exitCode: 1,
    finishedAt: '2026-10-12T00:05:00.000Z' })
  const failed = { ...records[0]! }
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started).toHaveLength(1)
  expect(CiHostRequestSchema.parse(f.started[0]!.request)).toMatchObject({
    operation: 'start', runId: records[1]!.id, gate: true, scope: 'full',
    files: records[1]!.files, integrationShards: 8,
  })
  expect(records[1]).toMatchObject({ state: 'running', deferred: true })
  expect(records[0]).toEqual(failed)
})

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

it('skips the slow tier of an affected request when another part failed', async () => {
  const records = tieredRuns().map(run => CiRunRecordSchema.parse({ ...run, scope: 'affected' }))
  records[0] = CiRunRecordSchema.parse({ ...records[0]!, state: 'failed', finishedAt: '2026-10-12T00:05:00.000Z' })
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started).toHaveLength(0)
  expect(records[1]).toMatchObject({ state: 'canceled',
    message: expect.stringContaining('slow tests run only after every other test of this request passed') })
})

it.each([false, true])('runs the slow tier after a fast failure in a full request with gate=%s', async gate => {
  const records = tieredRuns({ gate })
  records[0] = CiRunRecordSchema.parse({ ...records[0]!, state: 'failed', exitCode: 1,
    finishedAt: '2026-10-12T00:05:00.000Z' })
  const failed = { ...records[0]! }
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started.map(item => item.request.operation === 'start' ? item.request.runId : null))
    .toEqual([records[1]!.id])
  expect(records[1]).toMatchObject({ state: 'running', deferred: true })
  expect(records[0]).toEqual(failed)
})

it.each([false, true])('waits for remaining fast parts after a full request failure with gate=%s', async gate => {
  const [fast, slow] = tieredRuns({ gate })
  const running = CiRunRecordSchema.parse({ ...fast!, id: randomUUID(), state: 'running',
    computer: { hostRef: cloud.hostRef, label: cloud.label } })
  const records = [CiRunRecordSchema.parse({ ...fast!, state: 'failed', exitCode: 1,
    finishedAt: '2026-10-12T00:05:00.000Z' }), running, slow!]
  const f = fleet(records, [cloud])
  await f.service.dispatch()
  expect(f.started).toEqual([])
  expect(records[2]).toMatchObject({ state: 'queued', deferred: true, finishedAt: null })
  records[1] = CiRunRecordSchema.parse({ ...running, state: 'passed', exitCode: 0,
    finishedAt: '2026-10-12T00:06:00.000Z' })
  await f.service.dispatch()
  expect(f.started.map(item => item.request.operation === 'start' ? item.request.runId : null)).toEqual([slow!.id])
  expect(records[2]).toMatchObject({ state: 'running', deferred: true })
  expect(records[0]).toMatchObject({ state: 'failed', exitCode: 1 })
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
