import type pg from 'pg'
import { CiRunRecordSchema, requiresUserSystemd, userSystemdIntegrationFiles,
  type CiRunRecord } from '@foreman-code/contracts'
import type { HostCiComputer, HostCiEndpoint } from './service.js'
import { isGitHubComputer, supportsUserSystemd } from './computerCapabilities.js'
import { fallbackOnError } from '../diagnostics/ignoredError.js'

/** Sizes a partitioned run's slices by the measured speed of the computers that will run them, so they finish
 * together: each free computer takes one slice, weighted by its throughput; slices without a computer yet get the
 * mean. Throughput is share of the suite per wall second from that computer's last integration slice. */
export async function weighCiPartitions(pool: pg.Pool, endpoint: HostCiEndpoint,
  queued: CiRunRecord[], free: HostCiComputer[],
  read: (id: string, workspaceId: string) => Promise<CiRunRecord>): Promise<CiRunRecord[]> {
  const groupIds = [...new Set(queued.filter(run => run.suite === 'integration'
    && run.partition && !run.partition.weights).map(run => run.groupId))]
  if (!groupIds.length) return queued
  const members = (await pool.query<{ record: unknown }>(
    'select record from ci_runs where group_id=any($1::uuid[])', [groupIds])).rows
    .map(row => CiRunRecordSchema.parse(row.record))
  const groups = new Map<string, CiRunRecord[]>()
  for (const run of members) {
    if (run.suite === 'integration' && run.partition) groups.set(run.groupId, [...groups.get(run.groupId) ?? [], run])
  }
  if (!groups.size) return queued
  const speed = await throughput(pool, endpoint, free)
  const replaced = new Map<string, CiRunRecord>()
  for (const group of groups.values()) {
    group.sort((left, right) => left.partition!.index - right.partition!.index)
    const count = group[0]!.partition!.count
    if (group.length !== count) continue
    if (group.every(run => run.partition!.weights)) {
      for (const run of group) replaced.set(run.id, await read(run.id, run.workspaceId))
      continue
    }
    const existing = group.find(run => run.partition!.weights)
    const ordered = [...free].sort((left, right) =>
      Number(isGitHubComputer(left)) - Number(isGitHubComputer(right))
      || right.priority - left.priority
      || (speed.get(right.key) ?? 0) - (speed.get(left.key) ?? 0))
    const systemdComputers = ordered.filter(supportsUserSystemd).sort((left, right) =>
      Number(right.hostRef.kind === 'cloud') - Number(left.hostRef.kind === 'cloud'))
    const selection = group[0]!
    const knownFiles = selection.scope === 'affected' && !selection.deriveFiles
    const hostFiles = knownFiles ? selection.files.filter(requiresUserSystemd).length : userSystemdIntegrationFiles.size
    const ordinaryFiles = knownFiles ? selection.files.length - hostFiles : count
    const hostCount = hostFiles ? Math.min(hostFiles, ordinaryFiles ? count - 1 : count,
      Math.max(1, systemdComputers.length, count - ordinaryFiles)) : 0
    const hostIndexes = existing ? existing.partition!.hostIndexes ?? []
      : Array.from({ length: hostCount }, (_, index) => index)
    // Keep systemd files separate so executors without a user manager can take ordinary slices.
    const planned: (HostCiComputer | undefined)[] = [
      ...hostIndexes.map(index => systemdComputers[index]),
      ...ordered.filter(computer => computer.hostRef.kind === 'cloud'
        && !systemdComputers.slice(0, hostCount).includes(computer)),
      ...systemdComputers.slice(hostCount).filter(computer => computer.hostRef.kind !== 'cloud'),
    ]
    const known = ordered.map(computer => speed.get(computer.key)).filter((value): value is number => value !== undefined)
    const mean = known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : 1
    const weights = existing?.partition!.weights ?? group.map((_, index) => {
      const computer = planned[index]
      return Number((computer ? speed.get(computer.key) ?? mean : mean).toPrecision(6))
    })
    const plan = group.map((run, index) => ({ id: run.id, patch: { partition: { ...run.partition!, weights,
        ...(hostIndexes.length ? { hostIndexes } : {}) },
      plannedHostKey: planned[index]?.key ?? null } }))
    // One immutable plan includes canceled siblings; their slices remain reserved and their state stays terminal.
    const saved = await pool.query<{ record: unknown }>(`update ci_runs
      set record=ci_runs.record || plan.patch
      from jsonb_to_recordset($1::jsonb) as plan(id text, patch jsonb)
      where ci_runs.id=plan.id::uuid and ci_runs.group_id=$2
        and ci_runs.record#>'{partition,weights}' is null
      returning ci_runs.record`, [JSON.stringify(plan), group[0]!.groupId])
    for (const row of saved.rows) {
      const run = CiRunRecordSchema.parse(row.record)
      replaced.set(run.id, run)
    }
    // A concurrent planner or assignment can exclude rows from the update; use their persisted state.
    for (const run of group) {
      if (!replaced.has(run.id)) replaced.set(run.id, await read(run.id, run.workspaceId))
    }
  }
  return queued.map(run => replaced.get(run.id) ?? run).filter(run => run.state === 'queued' && !run.computer)
}

async function throughput(pool: pg.Pool, endpoint: HostCiEndpoint,
  computers: HostCiComputer[]): Promise<Map<string, number>> {
  const rows = (await pool.query<{ record: unknown }>(`select record from ci_runs
    where state in ('passed','failed') and record->>'suite'='integration' and record->'partition' is not null
      and record->>'finishedAt' is not null order by created_at desc limit 200`)).rows
    .map(row => CiRunRecordSchema.parse(row.record))
  const speed = new Map<string, number>()
  for (const run of rows) {
    const key = computers.find(value => JSON.stringify(value.hostRef) === JSON.stringify(run.computer?.hostRef))?.key
    if (!key || speed.has(key) || !run.startedAt || !run.finishedAt || run.step !== 'integration' || run.scope === 'affected') continue
    const seconds = (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000
    // Fail-fast runs say nothing about speed.
    if (seconds < 120) continue
    const partition = run.partition!
    if (partition.hostIndexes?.includes(partition.index)) continue
    const weights = partition.weights ?? Array.from({ length: partition.count }, () => 1)
    const ordinaryWeight = weights.reduce((sum, value, index) =>
      sum + (partition.hostIndexes?.includes(index) ? 0 : value), 0)
    const share = weights[partition.index]! / ordinaryWeight
    speed.set(key, share / seconds)
  }
  for (const computer of computers) {
    if (speed.has(computer.key)) continue
    // No measurement yet: CPU count relative to the measured computers' typical speed per CPU.
    const status = await endpoint.request(computer, { operation: 'status' })
      .catch(fallbackOnError(null, 'jobs', 'read CI computer status', { computer: computer.key }))
    if (status?.operation === 'status' && speed.size) {
      const perCpu = [...speed.values()].reduce((sum, value) => sum + value, 0) / speed.size / 12
      speed.set(computer.key, perCpu * Math.max(1, Math.floor(status.cpuCount / (status.slotsTotal ?? 1))))
    }
  }
  return speed
}

