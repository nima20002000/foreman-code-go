import { ResolvedJobDefinitionSpecRecordSchema } from '@foreman-code/contracts/job-verification'
import { withTransaction } from '../../infrastructure/transaction.js'
import type { MaterializationAttempt } from './ports.js'
import { installedSourceQuotaPool } from '../jobs/quotaOwnership.js'
import type { InstalledRuntimeConfigurationLocation } from '../jobs/installedRuntimeHost.js'
import { RSYNC_STAGE_EXTENSION, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { PostgresSourceRsyncLifecycle } from './rsyncTransferLifecycle.js'
import { AgentSourceAttemptAuthority, installedSourceAttemptAuthority } from './agentSourceAuthority.js'
import { readAcceptedPlacement, readDispatchIntent, readNativePlacement } from '../placement/persistence.js'
import { readReconciledDispatchIntent, readRemoteReceipts } from '../runs/remote/persistence.js'
import { readNativeExecutionBinding } from '../placement/executionBinding.js'
import { sourceMaterializationDigest } from './bindingHash.js'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { SOURCE_OPERATION_EXTENSION } from '@foreman-code/contracts/source-operations'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { SourceRootRecordSchema, type SourceRootRecord, type SourcePreparationClosure, type SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { PostgresSourceOperationAuthority } from './operationAuthority.js'
import { PostgresSourcePackageTransfers } from './operationTransferAdmission.js'
import { GitHubSourcePublisher } from './githubPublisher.js'
import { CarrierRemoteSourceMaterializationHost, createMainSourceOperationExtension } from './operationCarrier.js'
import type { MainWorkerCarrier } from '../placement/workerCarrier.js'
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { ApprovedRootAllowlistSchema, WORKSPACE_ROOT_EXTENSION } from '@foreman-code/contracts/workspace-root-policies'
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
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { readInstalledRootConfiguration } from './installedRootConfiguration.js'
import { localWorkflowSourceClosed } from './workflowCleanup.js'
import { requireQueuedPreparationClosed } from './queuedPreparationAuthority.js'
import { localWorkflowPreparationClosed } from './workflowPreparationCleanup.js'
import { resolvePreparationReconciliationOwner } from './preparationReconciliation.js'
import { MaterializationReservationCleanup } from './materializationReservationCleanup.js'
import { reclaimSourceReservation } from './reclaimSourceReservation.js'
import { SourceReservationReclamationResponseSchema } from '@foreman-code/contracts/source-operations'

/** Existing approved root records and original Job attempts own these services.
 * Construction does not fabricate an allowlist or authorize native execution. */
export async function createProductionSources(input: { pool: pg.Pool; commands: PostgresCommandCoordinator;
  locations: WorkspaceLocationService; mainId: string; runtimeRoot: string; endpoint(): DeviceEndpoint;
  installedJobConfiguration?: InstalledRuntimeConfigurationLocation;
  dispatch(): PostgresJobDispatch; remote?: RemoteSourceMaterializationHost;
  activeNativeSession?: SourceActiveNativeSessionReader; captureNativeSession?: SourceNativeSessionCaptureReader;
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
    prepareManaged: async root => (await installed(root.selection.hostRef)).prepareManaged(root),
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
  const installationFence = async (sql: GraphSqlClient, value: import('@foreman-code/contracts/source-admission').SourceRootRecord) => {
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
  const confirmedClosed = async (sql: GraphSqlClient, record: import('@foreman-code/contracts/source-admission').SourceMaterializationRecord) => {
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
      if (!receipt || parent.hostRef.kind !== 'device' || !parent.registration) return false
      return sameWorkflowValue(receipt.intent, intent) && receipt.phase === 'confirmed_terminal' && Boolean(receipt.terminal)
        && receipt.connection.mainId === record.receipt.binding.mainId && receipt.connection.deviceId === record.receipt.binding.deviceId
        && receipt.connection.workerInstallationId === parent.registration.workerInstallationId
        && receipt.connection.keyRevision === parent.registration.keyRevision && receipt.connection.authorizationRevision === parent.registration.authorizationRevision
    }

    const execution = await new JobRepository().execution(sql, record.receipt.binding.workspaceId, record.receipt.executionId)
    if (execution.attemptId !== record.receipt.attemptId || execution.operationId !== record.operationId
      || execution.acceptedSpec.source.materializationId !== record.receipt.materializationId
      || execution.acceptedSpec.source.materializationDigest !== sourceMaterializationDigest(record)
      || execution.acceptedSpec.bindingHash !== record.finalDispatchBindingHash) return false
    const identity = { workspaceId: execution.workspaceId, executionId: execution.id,
      attemptId: execution.attemptId, operationId: execution.operationId,
      bindingHash: execution.acceptedSpec.bindingHash, owner: execution.owner }
    if (await input.dispatch().readAcceptedNonEntryClosure(sql, identity)) return true
    return Boolean(await input.dispatch().readAcceptedClosureReceipt(sql, identity))
  }
  const owners = new PostgresSourceOperationAuthority(input.pool, attempts, confirmedClosed, input.activeNativeSession)
  const transfers = new PostgresSourcePackageTransfers(input.pool, input.commands, owners, input.endpoint)
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
  const remote = input.remote ?? new CarrierRemoteSourceMaterializationHost(carrier, owners, new GitHubSourcePublisher())
  const quotaPoolFor = async (binding: SourceRootRecord['binding'], attempt: MaterializationAttempt) => {
    const row = (await input.pool.query<{ spec: unknown }>(
      'select spec from job_computer_selections where execution_id=$1 and attempt_id=$2 and workspace_id=$3',
      [attempt.executionId, attempt.attemptId, binding.workspaceId])).rows[0]
    if (!row || !('verification' in ResolvedJobDefinitionSpecRecordSchema.parse(row.spec))) return undefined
    const path = join(input.runtimeRoot, 'job-runtime.json')
    const exists = input.installedJobConfiguration ?? await lstat(path).then(() => ({ path, ownerUid: process.getuid!() }),
      error => { if (error.code === 'ENOENT') return null; throw error })
    const pool = await installedSourceQuotaPool(exists, binding)
    if (!pool) throw new DomainError('SOURCE_QUOTA_MISSING', 'The verification Job requires its original installed quota pool.', 409)
    return { pool }
  }
  const executions = new InstalledSourceExecutionHosts(input.mainId, snapshots, attempts, remote, input.captureNativeSession, {
    async closed(owner) {
      if (owner.preparationKind === 'workflow') return localWorkflowPreparationClosed(input.pool, owner)
      const row = (await input.pool.query<{ queue_ticket_id: string | null }>(
        'select queue_ticket_id from source_preparation_reconciliations where operation_id=$1',
        [owner.identity.operationId])).rows[0]
      if (!row?.queue_ticket_id) return false
      const ticket = await requireQueuedPreparationClosed(input.pool, row.queue_ticket_id)
      return ticket.operationId === owner.identity.operationId && ticket.executionId === owner.attempt.executionId
        && ticket.attemptId === owner.attempt.attemptId
    },
    async authorize(reconciliationId, owner) {
      await withTransaction(input.pool, async (sql) => {
        const authorized = await resolvePreparationReconciliationOwner(sql, reconciliationId)
        if (!isDeepStrictEqual(authorized, owner)) {
          throw new DomainError('SOURCE_RECONCILIATION_CONFLICT', 'The original Main cleanup owner changed.', 409)
        }
      })
    },
  }, quotaPoolFor)
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
  const reclamations = new MaterializationReservationCleanup(input.pool, async grant => {
    const root = grant.roots[0]!
    const authorize = async () => {
      return withTransaction(input.pool, async (sql) => {
        const current = await reclamations.authorize(sql, grant.reservationId, grant.reclamationId)
        if (!isDeepStrictEqual(current, grant)) {
          throw new DomainError('SOURCE_RECLAMATION_UNCONFIRMED', 'The original source cleanup changed.', 409)
        }
      })
    }
    if (root.binding.deviceId) {
      const endpoint = input.endpoint()
      const channel = endpoint.captureRequest(root.binding.deviceId, SOURCE_OPERATION_EXTENSION.namespace)
      if (!channel || channel.binding.mainId !== root.binding.mainId
        || channel.binding.workerInstallationId !== root.binding.workerInstallationId
        || channel.binding.keyRevision !== root.registration?.keyRevision
        || channel.binding.authorizationRevision !== root.registration.authorizationRevision) unavailable()
      const reply = await channel!.request({ version: 1, operation: 'sources.reclaim-reservation',
        reservationId: grant.reservationId, reclamationId: grant.reclamationId }, { signal: AbortSignal.timeout(60_000) })
      const result = SourceReservationReclamationResponseSchema.parse(reply.payload)
      if (reply.bytes !== undefined || result.reservationId !== grant.reservationId
        || result.reclamationId !== grant.reclamationId || result.operationId !== grant.operationId
        || !isDeepStrictEqual(endpoint.currentBinding(root.binding.deviceId), channel!.binding)) {
        throw new DomainError('SOURCE_RECLAMATION_UNCONFIRMED', 'The original Worker cleanup reply changed.', 409)
      }
      return { closures: result.closures, ...(result.retained ? { retained: result.retained } : {}) }
    }
    return reclaimSourceReservation(grant, { authorize,
      operationClosed: async () => { await authorize(); return true },
      nativeClosed: async owner => {
        const workflow = await input.pool.query('select 1 from execution_dispatch_intents where operation_id=$1',
          [owner.identity.operationId])
        if (workflow.rowCount) return localWorkflowPreparationClosed(input.pool,
          { ...owner, preparationKind: 'workflow', preparationClosed: true })
        return true
      },
      quotaPoolFor: async owner => {
        const path = join(input.runtimeRoot, 'job-runtime.json')
        const configuration = input.installedJobConfiguration ?? await lstat(path).then(
          () => ({ path, ownerUid: process.getuid!() }), error => { if (error.code === 'ENOENT') return null; throw error })
        const pool = await installedSourceQuotaPool(configuration, owner.root.binding)
        return pool ? { pool } : undefined
      },
      closed: async closure => { await input.transferPreparationClosed?.(closure) },
    }, AbortSignal.timeout(60_000))
  })
  return { sources, policies, executions, snapshots, attempts, owners, transfers, lifecycle,
    reconcileMaterializationReservations: (report: (error: unknown) => void) => reclamations.reconcile(report),
    reconcileFailedCaptures: (report: (error: unknown) => void) => sources.reconcileCaptures(report),
    sourceExtension: createMainSourceOperationExtension(owners, transfers, lifecycle, async (reservationId, reclamationId, context) => {
      return withTransaction(input.pool, async (sql) => {
        const grant = await reclamations.authorize(sql, reservationId, reclamationId)
        if (grant.roots.some(root => root.binding.mainId !== context.binding.mainId
          || root.binding.deviceId !== context.binding.deviceId
          || root.binding.workerInstallationId !== context.binding.workerInstallationId
          || root.registration?.keyRevision !== context.binding.keyRevision
          || root.registration.authorizationRevision !== context.binding.authorizationRevision)) {
          throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Cleanup belongs to another Worker installation.', 403)
        }
        return grant
      })
    }) }
}
