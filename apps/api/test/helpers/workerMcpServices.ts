import type { Pool } from 'pg'
import { BugReportService } from '../../src/modules/bug-reports/service.js'
import { HostCiService } from '../../src/modules/ci-host/service.js'
import type { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { RunCiAuthority } from '../../src/modules/jobs/ciAuthority.js'

/** The bug report and CI services every enabled Agent tool needs, so worker tool discovery is complete. */
export function workerToolServices(pool: Pool, commands: PostgresCommandCoordinator) {
  const bugReports = new BugReportService(pool, commands)
  const ci = new HostCiService(pool, commands, new RunCiAuthority(pool), {
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    resolve: async () => { throw new Error('This fixture does not publish CI commits.') },
  }, {
    computers: async () => [],
    request: async () => { throw new Error('This fixture does not dispatch CI jobs.') },
  })
  return { bugReports, ci }
}
