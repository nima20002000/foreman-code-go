import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CiRunRecordSchema, type CiHostRun } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import type { CloudCi } from './cloud.js'
import { HostCiService, type CiCommits, type HostCiComputer } from './service.js'

/** Keeps Main's database boundary in memory while using the real cloud adapter and dispatcher. */
export function cloudService(cloud: CloudCi, run: CiHostRun, commit: string) {
  const computer: HostCiComputer = { key: 'cloud:circleci', label: 'CircleCI', priority: 0,
    hostRef: { kind: 'cloud', mainId: 'main', provider: 'circleci', slot: 0 },
    userSystemd: { supported: true, reason: null } }
  let record = CiRunRecordSchema.parse({ id: run.runId, workspaceId: 'workspace', groupId: randomUUID(),
    suite: 'integration', part: null, partition: null, scope: 'full', files: [], repository: 'octo/site', commit,
    state: run.state, computer: { hostRef: computer.hostRef, label: computer.label }, step: run.step,
    queuedAt: run.startedAt, startedAt: run.startedAt, finishedAt: run.finishedAt, exitCode: run.exitCode,
    message: run.message, initiator: { principalId: 'operator', executionId: null } })
  const pool = { query: async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith('update ci_runs')) {
      record = CiRunRecordSchema.parse(JSON.parse(parameters![3] as string))
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('supersededBy') || sql.includes("record->>'gate'='true'") || sql.includes('durations from ci_runs')) {
      return { rows: [] }
    }
    if (sql.includes('as group_id')) return { rows: [{ group_id: record.groupId, state: record.state }] }
    const active = ['starting', 'running'].includes(record.state)
    if (sql.includes("state='queued'") && record.state !== 'queued'
      || sql.includes("state in ('starting','running')") && !active
      || sql.includes("state in ('passed','failed')") && !['passed', 'failed'].includes(record.state)) return { rows: [] }
    return { rows: [{ id: record.id, record, host_key: active ? computer.key : null,
      log_tail: '', test_results: null, durations: null, position: 1 }] }
  } } as unknown as pg.Pool
  const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator',
    grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const authority: CiAuthority = { resolve: async () => ({ principal, workspaceId: 'workspace' }) }
  const service = new HostCiService(pool, {} as PostgresCommandCoordinator, authority, {} as CiCommits,
    { computers: async () => [computer], request: async (_computer, request) => cloud.handle(request) })
  return { service, read: () => service.get(principal, { workspaceId: 'workspace', ticketId: record.id }) }
}
