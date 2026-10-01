import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { ApprovedRootAllowlistSchema, WORKSPACE_ROOT_EXTENSION } from '@graphql/contracts/workspace-root-policies'
import type { WorkspaceRootHostPort } from './rootPolicyPorts.js'
import { PostgresWorkspaceRootPolicies, workspaceRootHostScope } from './rootPolicies.js'
import { InstalledWorkspaceRootHosts } from './rootHosts.js'
import { RegisteredWorkspaceSourceRoots } from './registeredSourceRoots.js'
import { InstalledSourceExecutionHosts, type RemoteSourceMaterializationHost } from './executionHosts.js'
import { PrivateSourceSnapshotStore } from './store.js'
import { PostgresSourceService } from './service.js'
import { JobSourceAttemptAuthority } from '../jobs/sourceAuthority.js'
import type { PostgresJobDispatch } from '../jobs/dispatch.js'
import { JobRepository } from '../jobs/repository.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError } from '../errors.js'

/** Existing approved root records and original Job attempts own these services.
 * Construction does not fabricate an allowlist or authorize native execution. */
export async function createProductionSources(input: { pool: pg.Pool; commands: PostgresCommandCoordinator;
  locations: WorkspaceLocationService; mainId: string; runtimeRoot: string; endpoint(): DeviceEndpoint;
  dispatch(): PostgresJobDispatch; remote?: RemoteSourceMaterializationHost }) {
  const unavailable = (): never => { throw new DomainError('SOURCE_REMOTE_UNAVAILABLE', 'The authenticated source materialization host is not installed.', 409) }
  const hosts: WorkspaceRootHostPort = {
    authorize: async (sql, _principal, host, installationId) => {
      const registration = await assertDeviceHostInstallation(sql, host, installationId)
      return registration ? { workerInstallationId: registration.workerInstallationId,
        keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision } : null
    },
    async configurations(sql) {
      const rows = await sql.query<{ record: unknown }>(`select c.record from workspace_root_host_configuration_heads h
        join workspace_root_host_configurations c on c.host_scope=h.host_scope and c.configuration_revision=h.configuration_revision
        where c.main_id=$1 order by h.host_scope`, [input.mainId])
      return rows.rows.map(row => ApprovedRootAllowlistSchema.parse(row.record))
    },
    attest: async root => (await installed(root.selection.hostRef)).attest(root),
    browse: async (root, path) => (await installed(root.selection.hostRef)).browse(root, path),
    sourceNamespace: async (policy, id) => (await installed(policy.hostRef)).sourceNamespace(policy, id),
  }
  async function installed(host: Parameters<typeof workspaceRootHostScope>[0]) {
    const rows = await input.pool.query<{ record: unknown }>(`select c.record from workspace_root_host_configuration_heads h
      join workspace_root_host_configurations c on c.host_scope=h.host_scope and c.configuration_revision=h.configuration_revision
      where h.host_scope=$1`, [workspaceRootHostScope(host)])
    if (!rows.rows[0]) throw new DomainError('ROOT_CONFIGURATION_MISSING', 'The selected host has no explicit human-approved root configuration.', 409)
    const configuration = ApprovedRootAllowlistSchema.parse(rows.rows[0].record)
    return new InstalledWorkspaceRootHosts(configuration, hosts.authorize, { async request(host, registration, request) {
      if (host.kind !== 'device') throw new DomainError('ROOT_HOST_MISMATCH', 'The remote root request must target its actual registered device.', 409)
      const endpoint = input.endpoint(), binding = endpoint.currentBinding(host.deviceId)
      if (!binding || binding.mainId !== host.mainId || binding.workerInstallationId !== registration.workerInstallationId
        || binding.keyRevision !== registration.keyRevision || binding.authorizationRevision !== registration.authorizationRevision) unavailable()
      return (await endpoint.request(host.deviceId, WORKSPACE_ROOT_EXTENSION.namespace, request)).payload
    } })
  }
  const policies = new PostgresWorkspaceRootPolicies(input.mainId, hosts)
  const roots = new RegisteredWorkspaceSourceRoots(policies, hosts)
  const root = join(input.runtimeRoot, 'source-snapshots')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const snapshots = new PrivateSourceSnapshotStore(root)
  const attempts = new JobSourceAttemptAuthority(input.pool, async (sql, value) => {
    await assertDeviceHostInstallation(sql, value.selection.hostRef, value.selection.hostRef.kind === 'main'
      ? value.selection.hostRef.mainId : value.registration!.workerInstallationId)
  })
  const executions = new InstalledSourceExecutionHosts(input.mainId, snapshots, attempts, input.remote ?? {
    prepare: async () => unavailable(), verify: async () => unavailable(), releaseClaim: async () => unavailable(), privateRepository: async () => unavailable(),
  })
  const sources = new PostgresSourceService(input.pool, input.commands, input.locations, snapshots, input.mainId, roots, executions, {
    async confirmedClosed(record) {
      const sql = await input.pool.connect()
      try {
        const execution = await new JobRepository().execution(sql, record.receipt.binding.workspaceId, record.receipt.executionId)
        if (execution.attemptId !== record.receipt.attemptId || execution.operationId !== record.operationId
          || execution.acceptedSpec.source.materializationId !== record.receipt.materializationId) return false
        return Boolean(await input.dispatch().readAcceptedClosureReceipt(sql, { workspaceId: execution.workspaceId, executionId: execution.id,
          attemptId: execution.attemptId, operationId: execution.operationId, bindingHash: execution.acceptedSpec.bindingHash, owner: execution.owner }))
      } finally { sql.release() }
    },
  })
  return { sources, policies, executions, snapshots }
}
