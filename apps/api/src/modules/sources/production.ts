import { RSYNC_STAGE_EXTENSION, type TransferIntent } from '@graphql/contracts/byte-transfer'
import { PostgresSourceRsyncLifecycle } from './rsyncTransferLifecycle.js'
import { AgentSourceAttemptAuthority, installedSourceAttemptAuthority } from './agentSourceAuthority.js'
import { readAcceptedPlacement, readDispatchIntent, readNativePlacement } from '../placement/persistence.js'
import { readReconciledDispatchIntent, readRemoteReceipts } from '../runs/remote/persistence.js'
import { readNativeExecutionBinding } from '../placement/executionBinding.js'
import { sourceMaterializationDigest } from './bindingHash.js'
import { sameWorkflowValue } from '@graphql/contracts/wave25'
import { SOURCE_OPERATION_EXTENSION } from '@graphql/contracts/source-operations'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { PostgresSourceOperationAuthority } from './operationAuthority.js'
import { PostgresSourcePackageTransfers } from './operationTransferAdmission.js'
import { ExistingByteTransferSourcePackageSender, type SourcePackageTransferAdmission } from './operationSender.js'
import { CarrierRemoteSourceMaterializationHost, createMainSourceOperationExtension } from './operationCarrier.js'
import type { MainWorkerCarrier } from '../placement/workerCarrier.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { ApprovedRootAllowlistSchema, WORKSPACE_ROOT_EXTENSION } from '@graphql/contracts/workspace-root-policies'
import type { WorkspaceRootHostPort } from './rootPolicyPorts.js'
import { PostgresWorkspaceRootPolicies, workspaceRootHostScope } from './rootPolicies.js'
import { InstalledWorkspaceRootHosts } from './rootHosts.js'
import { RegisteredWorkspaceSourceRoots } from './registeredSourceRoots.js'
import { InstalledSourceExecutionHosts, type RemoteSourceMaterializationHost, type SourceActiveNativeSessionReader, type SourceNativeSessionCaptureReader } from './executionHosts.js'
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
  dispatch(): PostgresJobDispatch; remote?: RemoteSourceMaterializationHost;
  activeNativeSession?: SourceActiveNativeSessionReader; captureNativeSession?: SourceNativeSessionCaptureReader;
  transferSender?: SourcePackageTransferAdmission['sender'];
  transferAcknowledged?: (intent: TransferIntent) => Promise<void> }) {
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
  const installationFence = async (sql: GraphSqlClient, value: import('@graphql/contracts/source-admission').SourceRootRecord) => {
    await assertDeviceHostInstallation(sql, value.selection.hostRef, value.selection.hostRef.kind === 'main'
      ? value.selection.hostRef.mainId : value.registration!.workerInstallationId)
  }
  const jobs = new JobSourceAttemptAuthority(input.pool, installationFence)
  const agents = new AgentSourceAttemptAuthority(input.pool, installationFence)
  const attempts = installedSourceAttemptAuthority(input.pool, agents, jobs)
  const confirmedClosed = async (sql: GraphSqlClient, record: import('@graphql/contracts/source-admission').SourceMaterializationRecord) => {
    const original = await readDispatchIntent(sql, record.receipt.executionId)
    if (original) {
      const intent = await readReconciledDispatchIntent(sql, record.operationId, true)
      const parent = await readAcceptedPlacement(sql, original.runId, original.nodeId)
      const rawNative = await readNativePlacement(sql, record.receipt.executionId)
      if (!intent || !parent || !rawNative || intent.executionId !== record.receipt.executionId
        || intent.attemptId !== record.receipt.attemptId || intent.operationId !== record.operationId
        || original.bindingHash !== intent.bindingHash || !record.finalDispatchBindingHash) return false
      const native = readNativeExecutionBinding(parent, intent, rawNative)
      if (native.bindingHash !== record.finalDispatchBindingHash || native.workingTree.materializationId !== record.receipt.materializationId
        || native.workingTree.materializationDigest !== sourceMaterializationDigest(record)) return false
      const receipts = (await readRemoteReceipts(sql, intent.runId, intent.nodeId)).filter(value => value.intent.operationId === record.operationId)
      const receipt = receipts.length === 1 ? receipts[0] : undefined
      if (!receipt || parent.hostRef.kind !== 'device' || !parent.registration) return false
      return sameWorkflowValue(receipt.intent, intent) && receipt.phase === 'confirmed_terminal' && Boolean(receipt.terminal)
        && receipt.connection.mainId === record.receipt.binding.mainId && receipt.connection.deviceId === record.receipt.binding.deviceId
        && receipt.connection.workerInstallationId === parent.registration.workerInstallationId
        && receipt.connection.keyRevision === parent.registration.keyRevision && receipt.connection.authorizationRevision === parent.registration.authorizationRevision
    }

    const execution = await new JobRepository().execution(sql, record.receipt.binding.workspaceId, record.receipt.executionId)
    if (execution.attemptId !== record.receipt.attemptId || execution.operationId !== record.operationId
      || execution.acceptedSpec.source.materializationId !== record.receipt.materializationId) return false
    return Boolean(await input.dispatch().readAcceptedClosureReceipt(sql, { workspaceId: execution.workspaceId, executionId: execution.id,
      attemptId: execution.attemptId, operationId: execution.operationId, bindingHash: execution.acceptedSpec.bindingHash, owner: execution.owner }))
  }
  const owners = new PostgresSourceOperationAuthority(input.pool, attempts, confirmedClosed, input.activeNativeSession)
  const transfers = new PostgresSourcePackageTransfers(input.pool, input.commands, owners, input.endpoint, input.transferSender)
  const lifecycle = new PostgresSourceRsyncLifecycle(input.pool, transfers)
  const carrier: MainWorkerCarrier = { capture(deviceId) {
    const channel = input.endpoint().captureRequest(deviceId, SOURCE_OPERATION_EXTENSION.namespace)
    if (!channel) return unavailable()
    const { mainId, workerInstallationId, bootId, keyRevision, authorizationRevision, connectionGeneration } = channel.binding
    return { identity: { mainId, deviceId: channel.binding.deviceId, workerInstallationId, bootId, keyRevision, authorizationRevision, connectionGeneration },
      request(namespace, payload, options) {
        if (namespace !== SOURCE_OPERATION_EXTENSION.namespace) return Promise.reject(new DomainError('SOURCE_NAMESPACE_CONFLICT', 'The captured source channel cannot serve another namespace.', 409))
        return channel.request(payload, options)
      } }
  } }
  const remote = input.remote ?? new CarrierRemoteSourceMaterializationHost(carrier, owners, new ExistingByteTransferSourcePackageSender(snapshots, transfers))
  const executions = new InstalledSourceExecutionHosts(input.mainId, snapshots, attempts, remote, input.captureNativeSession)
  const sources = new PostgresSourceService(input.pool, input.commands, input.locations, snapshots, input.mainId, roots, executions, {
    async confirmedClosed(record) {
      const sql = await input.pool.connect()
      try {
        return await confirmedClosed(sql, record)
      } finally { sql.release() }
    },
  }, input.transferAcknowledged ? async record => {
    const deviceId = record.receipt.binding.deviceId
    if (!deviceId) return
    const channel = input.endpoint().captureRequest(deviceId, RSYNC_STAGE_EXTENSION.namespace)
    if (!channel) unavailable()
    const intent = await lifecycle.forMaterialization(record, channel!.binding)
    await input.transferAcknowledged!(intent)
  } : undefined)
  return { sources, policies, executions, snapshots, attempts, owners, transfers, lifecycle,
    sourceExtension: createMainSourceOperationExtension(owners, transfers, lifecycle) }
}
