import { RSYNC_STAGE_EXTENSION, type TransferIntent } from '@graphql/contracts/byte-transfer'
import { PostgresSourceRsyncLifecycle } from './rsyncTransferLifecycle.js'
import { AgentSourceAttemptAuthority, installedSourceAttemptAuthority } from './agentSourceAuthority.js'
import { readAcceptedPlacement, readDispatchIntent, readNativePlacement } from '../placement/persistence.js'
import { readReconciledDispatchIntent, readRemoteReceipts } from '../runs/remote/persistence.js'
import { readNativeExecutionBinding } from '../placement/executionBinding.js'
import { sourceMaterializationDigest } from './bindingHash.js'
import { remoteWorkflowPreparationClosed } from './workflowPreparationCleanup.js'
import { sameWorkflowValue } from '@graphql/contracts/wave25'
import { SOURCE_OPERATION_EXTENSION } from '@graphql/contracts/source-operations'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { ManagementPrincipal } from '@graphql/contracts/management'
import { SourceRootRecordSchema, type SourceRootRecord, type SourcePreparationClosure, type SourceMaterializationRecord } from '@graphql/contracts/source-admission'
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
import type { RegisteredSourceRootPort } from './admissionPorts.js'
import { InstalledSourceExecutionHosts, type SourceAttemptAuthority, type RemoteSourceMaterializationHost, type SourceActiveNativeSessionReader, type SourceNativeSessionCaptureReader } from './executionHosts.js'
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
import { isDeepStrictEqual } from 'node:util'
import { DeviceRegistrationSchema } from '@graphql/contracts/device-identity'
import { readInstalledRootConfiguration } from './installedRootConfiguration.js'
import { localWorkflowSourceClosed } from './workflowCleanup.js'
import { reconcileFailedCaptures } from './failedCaptureCleanup.js'
import { localWorkflowPreparationClosed } from './workflowPreparationCleanup.js'
import { resolvePreparationReconciliationOwner } from './preparationReconciliation.js'

/** Existing approved root records and original Job attempts own these services.
 * Construction does not fabricate an allowlist or authorize native execution. */
export async function createProductionSources(input: { pool: pg.Pool; commands: PostgresCommandCoordinator;
  locations: WorkspaceLocationService; mainId: string; runtimeRoot: string; endpoint(): DeviceEndpoint;
  dispatch(): PostgresJobDispatch; remote?: RemoteSourceMaterializationHost;
  activeNativeSession?: SourceActiveNativeSessionReader; captureNativeSession?: SourceNativeSessionCaptureReader;
  transferSender?: SourcePackageTransferAdmission['sender'];
  transferAcknowledged?: (intent: TransferIntent) => Promise<void>;
  transferPreparationClosed?: (closure: SourcePreparationClosure) => Promise<void>;
  transferMaterializationClosed?: (record: SourceMaterializationRecord) => Promise<void> }) {
  const unavailable = (): never => { throw new DomainError('SOURCE_REMOTE_UNAVAILABLE', 'The authenticated source materialization host is not installed.', 409) }
  const hosts: WorkspaceRootHostPort = {
    async configuration(sql, host) {
      if (host.kind === 'main') return readInstalledRootConfiguration(join(input.runtimeRoot, 'approved-roots.json'))
      const row = (await sql.query<{ record: unknown }>('select record from device_registrations where id=$1 and main_id=$2 for share', [host.deviceId, host.mainId])).rows[0]
      if (!row) throw new DomainError('ROOT_DEVICE_CONFLICT', 'The selected root host is not registered.', 403)
      const registration = DeviceRegistrationSchema.parse(row.record)
      await assertDeviceHostInstallation(sql, host, registration.workerInstallationId)
      const endpoint = input.endpoint(), captured = endpoint.captureRequest(host.deviceId, WORKSPACE_ROOT_EXTENSION.namespace)
      if (!captured || captured.binding.mainId !== host.mainId || captured.binding.workerInstallationId !== registration.workerInstallationId
        || captured.binding.keyRevision !== registration.keyRevision || captured.binding.authorizationRevision !== registration.authorizationRevision) unavailable()
      const reply = await captured!.request({ version: 1, operation: 'workspace-roots.configuration' }, { signal: AbortSignal.timeout(10_000) })
      if (reply.bytes !== undefined || !isDeepStrictEqual(endpoint.currentBinding(host.deviceId), captured!.binding))
        throw new DomainError('ROOT_DEVICE_CONFLICT', 'The authenticated root configuration channel changed during adoption.', 409)
      const configuration = ApprovedRootAllowlistSchema.parse(reply.payload)
      if (!isDeepStrictEqual(configuration.hostRef, host) || configuration.applicationInstallationId !== registration.workerInstallationId)
        throw new DomainError('ROOT_CONFIGURATION_CONFLICT', 'The approved configuration belongs to another host installation.', 409)
      return configuration
    },
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
  const roots: RegisteredSourceRootPort = new RegisteredWorkspaceSourceRoots(policies, hosts)
  const root = join(input.runtimeRoot, 'source-snapshots')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const snapshots = new PrivateSourceSnapshotStore(root)
  const installationFence = async (sql: GraphSqlClient, value: import('@graphql/contracts/source-admission').SourceRootRecord) => {
    await assertDeviceHostInstallation(sql, value.selection.hostRef, value.selection.hostRef.kind === 'main'
      ? value.selection.hostRef.mainId : value.registration!.workerInstallationId)
  }
  const jobs = new JobSourceAttemptAuthority(input.pool, installationFence)
  const agents = new AgentSourceAttemptAuthority(input.pool, installationFence)
  const originalAttempts = installedSourceAttemptAuthority(input.pool, agents, jobs)
  const assertRootPolicy = async (sql: GraphSqlClient, principal: ManagementPrincipal, root: SourceRootRecord) => {
    const current = await roots.authorize(sql, principal, { workspaceId: root.binding.workspaceId, selection: root.selection, accessMode: root.binding.accessMode })
    if (current.ownerPrincipalId !== root.ownerPrincipalId || current.mainId !== root.binding.mainId || current.deviceId !== root.binding.deviceId
      || current.workerInstallationId !== root.binding.workerInstallationId || current.keyRevision !== (root.registration?.keyRevision ?? null)
      || current.authorizationRevision !== (root.registration?.authorizationRevision ?? null)
      || current.canonicalPath !== root.binding.canonicalPath) throw new DomainError('SOURCE_ROOT_CONFLICT', 'Current root authority differs from the exact accepted source namespace.', 409)
  }
  const readRoot = async (sql: GraphSqlClient, record: Parameters<SourceAttemptAuthority['revalidateMaterialization']>[0]) => {
    const row = (await sql.query<{ record: unknown }>('select record from source_root_bindings where root_id=$1 and binding_revision=$2 for share',
      [record.receipt.binding.rootId, record.receipt.binding.bindingRevision])).rows[0]
    return SourceRootRecordSchema.parse(row?.record)
  }
  const attempts: SourceAttemptAuthority = {
    async authorize(sql, principal, value) { await originalAttempts.authorize(sql, principal, value); await assertRootPolicy(sql, principal, value.root) },
    async authorizeFinal(sql, principal, record, hash) { await originalAttempts.authorizeFinal(sql, principal, record, hash); await assertRootPolicy(sql, principal, await readRoot(sql, record)) },
    async revalidate(root, attempt) { await owners.prepareIdentity(root, attempt) },
    async revalidateMaterialization(record) {
      const sql = await input.pool.connect()
      let root: SourceRootRecord
      try { root = await readRoot(sql, record) } finally { sql.release() }
      await originalAttempts.revalidateMaterialization(record)
      await owners.prepareIdentity(root, record.receipt)
    },
  }
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
      if (parent.hostRef.kind === 'main') {
        if (record.receipt.binding.deviceId !== null || record.receipt.binding.workerInstallationId !== null) return false
        return localWorkflowSourceClosed(sql, intent.executionId)
      }
      const receipts = (await readRemoteReceipts(sql, intent.runId, intent.nodeId)).filter(value => value.intent.operationId === record.operationId)
      const receipt = receipts.length === 1 ? receipts[0] : undefined
      if (parent.hostRef.kind !== 'device' || !parent.registration) return false
      const nativeClosed = receipt && sameWorkflowValue(receipt.intent, intent)
        && receipt.phase === 'confirmed_terminal' && Boolean(receipt.terminal)
        && receipt.connection.mainId === record.receipt.binding.mainId && receipt.connection.deviceId === record.receipt.binding.deviceId
        && receipt.connection.workerInstallationId === parent.registration.workerInstallationId
        && receipt.connection.keyRevision === parent.registration.keyRevision && receipt.connection.authorizationRevision === parent.registration.authorizationRevision
      return Boolean(nativeClosed) || await remoteWorkflowPreparationClosed(sql, intent.executionId)
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
  const executions = new InstalledSourceExecutionHosts(input.mainId, snapshots, attempts, remote, input.captureNativeSession, {
    closed: owner => localWorkflowPreparationClosed(input.pool, owner),
    async authorize(reconciliationId, owner) {
      const sql = await input.pool.connect()
      try {
        await sql.query('begin')
        const authorized = await resolvePreparationReconciliationOwner(sql, reconciliationId)
        if (!isDeepStrictEqual(authorized, owner)) {
          throw new DomainError('SOURCE_RECONCILIATION_CONFLICT', 'The original Main cleanup owner changed.', 409)
        }
        await sql.query('commit')
      } catch (error) {
        await sql.query('rollback')
        throw error
      } finally { sql.release() }
    },
  })
  const sources = new PostgresSourceService(input.pool, input.commands, input.locations, snapshots, input.mainId, roots, executions, {
    async confirmedClosed(record) {
      const sql = await input.pool.connect()
      try {
        return await confirmedClosed(sql, record)
      } finally { sql.release() }
    },
  }, { adopted: input.transferAcknowledged ? async record => {
    const deviceId = record.receipt.binding.deviceId
    if (!deviceId) return
    const channel = input.endpoint().captureRequest(deviceId, RSYNC_STAGE_EXTENSION.namespace)
    if (!channel) unavailable()
    const intent = await lifecycle.forMaterialization(record, channel!.binding)
    await input.transferAcknowledged!(intent)
  } : undefined, preparationClosed: input.transferPreparationClosed, closed: input.transferMaterializationClosed })
  return { sources, policies, executions, snapshots, attempts, owners, transfers, lifecycle,
    reconcileFailedCaptures: (report: (error: unknown) => void) => reconcileFailedCaptures(input.pool, snapshots, report),
    sourceExtension: createMainSourceOperationExtension(owners, transfers, lifecycle) }
}
