import { createInstalledWorkerAccounts } from '../provider-accounts/installedWorkerAccounts.js'
import { createProviderAccountWorkerExtension, workerProviderAccountResolver, type WorkerAccountOperationPorts } from '../provider-accounts/workerOperations.js'
import { inventoryPayloadFingerprints } from '../harnesses/payloadFingerprintCache.js'
import { realpath } from 'node:fs/promises'
import { setTimeout as wait } from 'node:timers/promises'
import { SourceReservationReclamationAuthorityResponseSchema } from '@foreman-code/contracts/source-operations'
import { hasPositiveRemoteEntryClosure, hasPositiveRemoteNonEntryClosure }
  from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { recoverInstalledJobRuntimeQualifications } from '../jobs/installedRuntimeQualification.js'
import { installedSourceQuotaPool } from '../jobs/quotaOwnership.js'
import { JOB_OUTPUT_NAMESPACE } from '../files/jobs/workerProtocol.js'
import { componentLogger } from '../diagnostics/logger.js'
import { createWorkerSourceRsyncAcknowledgement } from '../sources/rsyncTransferLifecycle.js'
import { createInstalledRsyncComposition, type InstalledRsyncProviders } from '../byte-transfer/productionComposition.js'
import { randomUUID } from 'node:crypto'
import { RemoteJobExecutionRpcRequestRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import { createInstalledJobExecutionHost } from '../jobs/executorInstalled.js'
import { createVerificationSystemInput } from '../jobs/verificationSystemInput.js'
import { WorkerJobApplicationSink } from '../runs/remote/workerJobApplicationSink.js'
import { createInstalledJobSource } from '../runs/remote/installedJobSource.js'
import { createRemoteExecutionHandler } from '../runs/remote/executionRouter.js'
import { workflowPreparationExtension } from '../runs/remote/preparationExtension.js'
import { REMOTE_PREPARATION_EXTENSION } from '@foreman-code/contracts/remote-execution-rpc'
import { createWorkerJobInputPort } from '../files/jobInputs/workerFactory.js'
import { JOB_INPUT_NAMESPACE } from '../files/jobInputs/protocol.js'
import { createWorkerJobOutputCollector } from '../runs/remote/workerJobOutputs.js'
import { createInstalledJobOutputRsync } from '../runs/remote/installedJobOutputRsync.js'
import { createInstalledJobInputRsync } from '../runs/remote/installedJobInputRsync.js'
import { DeviceConnectionError } from './deviceWire.js'
import type { RemoteJobExecutionHost, RemoteJobExecutionHostPorts } from '../runs/remote/jobExecutionHost.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { createWorkerQualificationExtension } from '../jobs/workerQualificationCarrier.js'
import type { InstalledRuntimeConfigurationLocation } from '../jobs/installedRuntimeHost.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { selectInstalledCodex } from '../computers/installedCodexSelection.js'
import { isDeepStrictEqual } from 'node:util'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import { ApprovedRootAllowlistSchema, type ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { HarnessDiscoveryRequestSchema, HARNESS_PROFILE_CHECK_NAMESPACE } from '@foreman-code/contracts/harness-registry'
import { EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import {
  SOURCE_OPERATION_EXTENSION,
  SourceOperationResponseSchema,
  SourceTransferStatusResponseSchema,
} from '@foreman-code/contracts/source-operations'
import type { DeviceExtensionRegistration, DeviceExtensionContext } from './deviceApplicationChannel.js'
import type { DeviceConnectionSupervisor } from './connectionSupervisor.js'
import { MainClock } from './workerClock.js'
import { createAuthenticatedTransferReceiver, transferContextForBinding } from '../byte-transfer/carrier.js'
import { sourceTransfersOnMain } from '../sources/operationCarrier.js'
import { SourceOperationWorkerService } from '../sources/operationWorker.js'
import { createInstalledWorkflowHost, type InstalledWorkflowHostOptions } from '../runs/remote/installedWorkflowHost.js'
import { InstalledWorkflowRecovery } from '../runs/remote/installedWorkflowRecovery.js'
import type { InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { inspectInstalledCodex } from '../harnesses/installedCodexInspection.js'
import { COMPUTER_MAINTENANCE_NAMESPACE, COMPUTER_MAINTENANCE_VERSION, MaintenanceReplySchema, MaintenanceRequestSchema } from '@foreman-code/contracts/computer-maintenance'
import { ComputerMaintenance, systemMaintenancePorts, type MaintenancePorts } from '../computers/maintenance.js'
import { COMPUTER_ACCOUNTS_NAMESPACE, COMPUTER_GITHUB_NAMESPACE, ComputerAccountsRequestSchema, GitHubLoginRequestSchema } from '@foreman-code/contracts/computer-accounts'
import { createComputerSyncExtension } from '../computers/syncExtension.js'
import { SyncthingComputer } from '../computers/syncthingComputer.js'
import { GitHubLoginRunner } from '../computers/githubLogin.js'
import {
  AGENT_SNAPSHOT_JSON_BYTES, AGENT_SNAPSHOT_NAMESPACE, AgentSnapshotRequestSchema, AgentSnapshotResultSchema,
} from '@foreman-code/contracts/source-materialization'
import { snapshotAgentWorktree } from '../sources/agentSnapshot.js'
import { CI_HOST_NAMESPACE, CI_RUNTIME_NAMESPACE } from '@foreman-code/contracts'
import { HostCiRunner, hostCiDirectory, systemHostCiPorts } from '../ci-host/runner.js'
import { CiRuntimeWorker } from '../jobs/ciRuntimeWorker.js'
import { prepareCiRuntime } from '../jobs/ciRuntimePrepare.js'
import { retainedCiJobImages } from '../jobs/ciRuntimeImages.js'
import { currentCiRuntimePaths, lastCiRuntimeRefresh, retireCiRuntimeConfigurations } from '../jobs/ciRuntimeRefresh.js'
import { systemGitWorktreePorts } from '../sources/gitWorktree.js'
import { readInstalledWorkflowConfiguration } from '../runs/remote/installedWorkflowConfiguration.js'
import { probeComputerAccounts, systemPorts } from '../computers/accountProbe.js'
import { inspectInstalledClaude } from '../harnesses/installedClaudeInspection.js'
import { createInstalledWorkerProfileChecks } from '../harnesses/installedWorkerProfileChecks.js'
import { DomainError } from '../errors.js'
import { jobContainerNonEntryObserved } from '../jobs/executorJournal.js'
import { proveOCIBoundaryEmpty } from '../jobs/executorContainerOwner.js'
import { sourceMaterializationDigest } from '../sources/bindingHash.js'
import { createWorkerResourceTelemetryExtension } from '../resource-telemetry/ingestion/carrier.js'
import { createLinuxResourceCollector } from '../resource-telemetry/collector/ports.js'
import { createInstalledWorkerConversations } from '../conversations/installedWorkerConversations.js'
import { WORKER_MCP_EXTENSION } from '@foreman-code/contracts/worker-mcp-relay'
import { fallbackOnError } from '../diagnostics/ignoredError.js'

/** Shipped worker domains consume actual protected installation selections and
 * sole Main authority. No database, Run scheduler, generated grant or ready flag. */
export async function createInstalledWorkerDomains(input: {
  stateDirectory: string; pairing: WorkerPairingConfiguration; bootId: string
  /** The packaged Worker's existing exclusive state socket remains held during journal recovery. */
  assertStateOwnership?: () => void
  configuration: InstalledWorkflowConfigurationLocation | null
  refreshWorkflowConfiguration?: (signal: AbortSignal) => Promise<InstalledWorkflowConfigurationLocation | null>
  nativeOutputs?: InstalledWorkflowHostOptions['nativeOutputs']
  jobConfiguration?: InstalledRuntimeConfigurationLocation | null
  jobReports?: Pick<RemoteJobExecutionHostPorts, 'prepareOutputs' | 'preparePublication'>
  approvedRoots(): Promise<ApprovedRootAllowlist | null>
  connection(): Pick<DeviceConnectionSupervisor, 'currentBinding' | 'captureRequest' | 'mainNow'> | undefined
  codexSuiteRevision: string
  providerAccounts?: Omit<WorkerAccountOperationPorts, 'current'>
  /** Installed original source/output, canonical acknowledgement and stopped-writer ports. */
  rsync?: InstalledRsyncProviders
  workerUpdate?: NonNullable<MaintenancePorts['workerUpdate']>
  ciStartupPending?: () => boolean | Promise<boolean>
}) {
  const lifetime = new AbortController()
  let configuration = input.configuration
  const configurationLocation = input.configuration ?? {
    path: join(input.stateDirectory, 'workflow-runtime.json'), ownerUid: process.getuid!(),
  }
  const active = new Map<Promise<unknown>, string>()
  let maintenance: Promise<ComputerMaintenance> | undefined
  const registry = new NativeProcessRegistry(join(input.stateDirectory, 'workflow-native-processes'))
  const jobRegistry = new NativeProcessRegistry(join(input.stateDirectory, 'job-runtime-native-processes'))
  let jobJournalOpening: Promise<RemoteOperationJournal> | undefined
  const mainClock = new MainClock()
  const observedMainTime = () => {
    const observed = input.connection()?.mainNow()
    if (observed !== undefined) mainClock.observe(observed)
    return mainClock.observed ? mainClock.now() : undefined
  }
  const ownership = { now: () => observedMainTime() ?? Date.now(),
    retentionNow: () => input.connection()?.mainNow(),
    ...(input.assertStateOwnership ? { assertExclusiveOwner: input.assertStateOwnership } : {}) }
  const jobJournal = () => jobJournalOpening ??= RemoteOperationJournal.open(
    join(input.stateDirectory, 'job-runtime-operations.json'), ownership)
  const systemInput = createVerificationSystemInput({ configuration: input.jobConfiguration ?? null, journal: jobJournal })
  let journalOpening: Promise<RemoteOperationJournal> | undefined
  const journal = () => journalOpening ??= RemoteOperationJournal.open(
    join(input.stateDirectory, 'workflow-operations.json'), ownership)
  const current = () => {
    lifetime.signal.throwIfAborted()
    const binding = input.connection()?.currentBinding()
    if (!binding || binding.mainId !== input.pairing.mainId || binding.deviceId !== input.pairing.deviceId
      || binding.workerInstallationId !== input.pairing.workerInstallationId || binding.bootId !== input.bootId
      || binding.keyRevision !== input.pairing.keyRevision || binding.authorizationRevision !== input.pairing.authorizationRevision)
      throw new DomainError('WORKER_DOMAIN_UNAVAILABLE', 'The current original paired Main connection is unavailable.', 409)
    return binding
  }
  const request = async (namespace: string, payload: unknown, options?: { signal?: AbortSignal; bytes?: Uint8Array; timeoutMs?: number }) => {
    const binding = current(), captured = input.connection()?.captureRequest(namespace)
    if (!captured || !isDeepStrictEqual(captured.binding, binding)) throw new DomainError('WORKER_DOMAIN_UNAVAILABLE', 'The exact original Main channel is unavailable.', 409)
    const reply = await captured.request(payload, { ...options,
      signal: options?.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal })
    if (!isDeepStrictEqual(current(), binding)) throw new DomainError('WORKER_DOMAIN_UNAVAILABLE', 'The authenticated Main generation changed.', 409)
    return reply
  }
  const roots = async () => {
    lifetime.signal.throwIfAborted()
    const value = await input.approvedRoots()
    if (!value) throw new DomainError('ROOT_CONFIGURATION_MISSING', 'The actual human-approved worker roots are unavailable.', 409)
    return ApprovedRootAllowlistSchema.parse(value)
  }
  const approved = await input.approvedRoots()
  let profileChecks = approved ? await createInstalledWorkerProfileChecks({ stateDirectory: input.stateDirectory,
    configuration, pairing: input.pairing, current, registry }) : null
  let jobOutputRsync: Awaited<ReturnType<typeof createInstalledJobOutputRsync>> | undefined
  let jobInputRsync: ReturnType<typeof createInstalledJobInputRsync> | undefined
  const sourceAcknowledgement = input.rsync && createWorkerSourceRsyncAcknowledgement({
    authenticate: async (intent, context, signal) => {
      if (!isDeepStrictEqual(transferContextForBinding(current()), context)) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source acknowledgement requires the original current channel.', 409)
      signal.throwIfAborted(); await input.rsync!.accepted.authorize(intent, context, 'read'); signal.throwIfAborted()
      if (!isDeepStrictEqual(transferContextForBinding(current()), context)) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source acknowledgement generation changed.', 409)
    },
    currentCommitted: async (id, context, signal) => {
      if (!isDeepStrictEqual(transferContextForBinding(current()), context)) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source status requires the actual current Main capture.', 409)
      const reply = await request(SOURCE_OPERATION_EXTENSION.namespace, { version: 1, operation: 'sources.transfer-status', transferId: id }, { signal })
      const response = SourceTransferStatusResponseSchema.parse(reply.payload)
      if (reply.bytes !== undefined || response.operation !== 'sources.transfer-status' || response.intent.transferId !== id)
        throw new DomainError('SOURCE_TRANSFER_CONFLICT', 'Main did not return the original committed source record.', 403)
      return { intent: response.intent, record: response.record }
    },
    approvedRoots: roots,
  })
  const rsyncProviders: InstalledRsyncProviders | undefined = input.rsync ? { ...input.rsync,
    resolveSource:async(intent,signal)=>jobOutputRsync&&await jobOutputRsync.owns(intent)?jobOutputRsync.resolveSource(intent,signal):input.rsync!.resolveSource(intent,signal),
    acknowledged: async (intent, context) => {
    if (intent.byteClass === 'source' && intent.direction === 'to-worker') await sourceAcknowledgement!.acknowledged(intent, context)
    else if(jobOutputRsync&&await jobOutputRsync.owns(intent))await jobOutputRsync.acknowledged(intent,context)
    else if(jobInputRsync&&await jobInputRsync.owns(intent))await jobInputRsync.acknowledged(intent,context)
    else await input.rsync!.acknowledged(intent, context)
  } } : undefined
  const rsync = createInstalledRsyncComposition({ side: 'worker', providers: approved ? rsyncProviders : undefined,
    current: deviceId => deviceId === input.pairing.deviceId ? current() : undefined })
  if (rsync.kind === 'configured' && input.rsync && input.jobConfiguration && approved) jobOutputRsync = await createInstalledJobOutputRsync({
    providers: { ...input.rsync, quiescent: async (intent, signal) => { await rsync.writers.quiescent(intent, signal); await input.rsync!.quiescent(intent, signal) } },
    ownership: rsync.ownership, journal: await jobJournal(), current, request })
  if (rsync.kind === 'configured' && input.rsync && input.jobConfiguration && approved) jobInputRsync = createInstalledJobInputRsync({
    systemInput,
    receiver: input.rsync.receiver, journal: await jobJournal(), channel: { request, currentBinding: current },
    receiptRoot: join(input.stateDirectory, 'job-input-receipts'), admissionRoot: join(input.stateDirectory, 'job-input-rsync-admissions') })
  const extensions: DeviceExtensionRegistration[] = rsync.extensions.map(extension => ({ ...extension, role: 'duplex' as const }))
  const providerAccounts = input.providerAccounts ?? createInstalledWorkerAccounts({
    stateDirectory: input.stateDirectory, configuration: configurationLocation, current, registry,
    target: { hostRef: { kind: 'device', mainId: input.pairing.mainId, deviceId: input.pairing.deviceId },
      applicationInstallationId: input.pairing.workerInstallationId, keyRevision: input.pairing.keyRevision,
      authorizationRevision: input.pairing.authorizationRevision },
    request: (namespace, payload) => request(namespace, payload),
  })
  const accounts = providerAccounts
    ? workerProviderAccountResolver({ ...providerAccounts, current }) : undefined
  if (providerAccounts) {
    extensions.push(createProviderAccountWorkerExtension({ ...providerAccounts, current }))
  }
  let receiver: ReturnType<typeof createAuthenticatedTransferReceiver> | undefined
  let native: Awaited<ReturnType<typeof createInstalledWorkflowHost>> | undefined
  let openWorkflow: ((location: InstalledWorkflowConfigurationLocation) => Promise<void>) | undefined
  if (approved) {
    receiver = createAuthenticatedTransferReceiver({ stagingRoot: join(input.stateDirectory, 'source-transfer-staging'),
      current: deviceId => { const binding = input.connection()?.currentBinding(); return binding?.deviceId === deviceId ? binding : undefined },
      accepted: rsync.kind === 'configured' ? input.rsync!.accepted : sourceTransfersOnMain(request, current),
      ...(rsync.kind === 'configured' ? { receiver: input.rsync!.receiver } : {}) })
    const sources = new SourceOperationWorkerService({
      authenticate: async context => { if (!isDeepStrictEqual(current(), context.binding)) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source operation is not on the actual original worker generation.', 409) },
      approvedRoots: roots,
      async quotaPoolFor(binding) {
        const pool = await installedSourceQuotaPool(input.jobConfiguration ?? null, binding)
        return pool ? { pool } : undefined
      },
      currentOwner: async (operation, context) => {
        const reply = await request(SOURCE_OPERATION_EXTENSION.namespace, { version: 1, operation: 'sources.authorize', request: operation }, { signal: context.signal })
        const value = SourceOperationResponseSchema.parse(reply.payload)
        if (reply.bytes !== undefined || value.operation !== 'sources.authorize') throw new DomainError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'The original Main did not return source operation authority.', 403)
        return value.owner
      },
      currentReclamation: async (reservationId, reclamationId, context) => {
        const reply = await request(SOURCE_OPERATION_EXTENSION.namespace, { version: 1,
          operation: 'sources.reclamation-authorize', reservationId, reclamationId }, { signal: context.signal })
        if (reply.bytes !== undefined) throw new DomainError('SOURCE_ROLE_DENIED', 'Cleanup authority contains no binary data.', 403)
        return SourceReservationReclamationAuthorityResponseSchema.parse(reply.payload).grant
      },
      reclamationNativeClosed: async (owner, operationId) => {
        const retained = await jobJournal()
        const status = await retained.jobStatus(operationId)
        if (status.status === 'known' && (!status.receipt.terminal?.processStopped
          || !['complete', 'failed'].includes(status.receipt.publication))) return false
        const jobOwner = await retained.jobNativeOwner(operationId)
        if (jobOwner) {
          if (jobOwner.connection.bootId !== input.bootId || status.status !== 'known' || !status.receipt.terminal?.processStopped
            || !['complete', 'failed'].includes(status.receipt.publication)
            || jobOwner.launches.some(launch => !launch.closed)) return false
          const certificate = jobOwner.container?.certificate
          if (!jobOwner.nonEntryConfirmed || !jobContainerNonEntryObserved(jobOwner)) {
            if (!certificate || certificate.lifecycle !== 'closed'
              || certificate.scope.subject.operationId !== operationId
              || certificate.scope.bootId !== input.bootId || !await proveOCIBoundaryEmpty(certificate.boundary)
              || !(await Promise.all(certificate.helpers.map(helper => helper.boundary
                ? proveOCIBoundaryEmpty(helper.boundary) : Promise.resolve(false)))).every(Boolean)) return false
          }
        }
        if (native?.kind === 'configured') {
          if (!owner) return native.reservationClosed(operationId)
          return native.preparationClosed({ ...owner, preparationKind: 'workflow', preparationClosed: true })
        }
        // Removing a runtime selection does not erase protected operation or process records.
        if ([...registry.snapshot().launches, ...jobRegistry.snapshot().launches]
          .some(launch => launch.lifecycle !== 'closed')) return false
        const workflow = await (await journal()).status(operationId)
        if (workflow.status === 'known') {
          return hasPositiveRemoteEntryClosure(workflow.receipt) || hasPositiveRemoteNonEntryClosure(workflow.receipt)
        }
        const recovery = new InstalledWorkflowRecovery(join(input.stateDirectory, 'workflow-recovery'), registry)
        return !recovery.hasCapture(operationId)
      },
      nativeOwnerFor: record => native?.kind === 'configured' ? native.nativeOwnerFor(record) : Promise.resolve(null),
      preparationNativeClosed: async (operationId, owner) => {
        if (owner.preparationKind === 'workflow') {
          return native?.kind === 'configured' ? native.preparationClosed(owner) : false
        }
        if (!input.jobConfiguration) return false
        const retained = await jobJournal(), nativeOwner = await retained.jobNativeOwner(operationId)
        if (!nativeOwner) return true
        const status = await retained.jobStatus(operationId)
        if (status.status !== 'known' || !status.receipt.terminal?.processStopped
          || !['complete', 'failed'].includes(status.receipt.publication) || !owner.record) return false
        const execution = status.receipt.execution, receipt = owner.record.receipt
        if (execution.id !== owner.attempt.executionId || execution.attemptId !== owner.attempt.attemptId
          || execution.operationId !== operationId || execution.workspaceId !== owner.root.binding.workspaceId
          || execution.acceptedSpec.source.materializationId !== receipt.materializationId
          || execution.acceptedSpec.source.materializationDigest !== sourceMaterializationDigest(owner.record)
          || execution.acceptedSpec.bindingHash !== owner.record.finalDispatchBindingHash
          || nativeOwner.connection.bootId !== input.bootId || nativeOwner.launches.some(launch => !launch.closed)) return false
        if (nativeOwner.nonEntryConfirmed && jobContainerNonEntryObserved(nativeOwner)) return true
        const certificate = nativeOwner.container?.certificate
        if (!certificate || certificate.lifecycle !== 'closed' || certificate.scope.subject.operationId !== operationId
          || certificate.scope.bootId !== input.bootId) return false
        return await proveOCIBoundaryEmpty(certificate.boundary)
          && (await Promise.all(certificate.helpers.map(helper => helper.boundary
            ? proveOCIBoundaryEmpty(helper.boundary) : Promise.resolve(false)))).every(Boolean)
      },
      preparationReconciled: async closure => {
        if (!input.jobConfiguration) return
        const retained = await jobJournal()
        const status = await retained.jobStatus(closure.operationId)
        if (status.status === 'known' && !await retained.isJobRetired(closure.operationId)) {
          await retained.jobSourceReclaimed(closure.operationId, closure)
        }
      },
      ...(rsync.kind === 'configured' ? {
        preparationTransfersClosed: (closure, signal) => rsync.backend.retirePreparation(closure, signal),
        executionTransfersClosed: (record, signal) => rsync.backend.retireMaterialization(record, signal),
      } : {}),
    })
    const createWorkflow = (location: InstalledWorkflowConfigurationLocation | null) =>
      createInstalledWorkflowHost({ stateDirectory: input.stateDirectory, pairing: input.pairing, bootId: input.bootId,
      configuration: location, currentBinding: () => input.connection()?.currentBinding(),
      captureRequest: namespace => input.connection()?.captureRequest(namespace), sources, approvedRoots: roots,
      ...(input.nativeOutputs ? { nativeOutputs: input.nativeOutputs } : {}),
      codexSuiteRevision: input.codexSuiteRevision,
      signal: lifetime.signal, registry, journal, ...(accounts ? { accounts } : {}) })
    native = await createWorkflow(configuration)
    openWorkflow = async location => {
      if (native?.kind !== 'configured') native = await createWorkflow(location)
    }
    extensions.push({ ...receiver.extension, role: 'duplex' }, { ...SOURCE_OPERATION_EXTENSION, role: 'duplex', async handle(payload, context) {
      return { payload: await sources.handle(payload, { ...context, signal: AbortSignal.any([context.signal, lifetime.signal]) }) }
    } }, ...(native.kind === 'configured' ? native.extensions : []))
  }
  if (input.jobConfiguration && approved) {
    await recoverInstalledJobRuntimeQualifications({ journal: await jobJournal(), registry: jobRegistry,
      host: { hostRef: { kind: 'device', mainId: input.pairing.mainId, deviceId: input.pairing.deviceId },
        registration: { workerInstallationId: input.pairing.workerInstallationId, keyRevision: input.pairing.keyRevision,
          authorizationRevision: input.pairing.authorizationRevision },
        mainInstallationId: input.pairing.mainId, bootId: input.bootId } })
  }
  let qualification: ReturnType<typeof createWorkerQualificationExtension> | undefined
  // Computer telemetry belongs to the pairing (Main checks its metrics:report scope on every sample), not to the Job
  // runtime: a computer that runs only CI or agents still reports CPU, memory and disk.
  const telemetry = createWorkerResourceTelemetryExtension({ signal: lifetime.signal, currentBinding: current,
    createCollector: (identity, signal) => createLinuxResourceCollector({ identity, signal,
      // The installed Job controller already reads host MemAvailable at native entry.
      wholeHostVisible: true,
      // This mount supplies computer metrics; no logical owner attribution is inferred.
      ownership: { async snapshot(signal) {
        signal.throwIfAborted()
        return { revision: jobRegistry.revision(), views: [] }
      }, changes: (revision, signal) => jobRegistry.changes(revision, signal) },
    }) })
  extensions.push(telemetry.extension)
  if (input.jobConfiguration && approved) {
    qualification = createWorkerQualificationExtension({ configuration: input.jobConfiguration, pairing: input.pairing, bootId: input.bootId,
      currentBinding: current, now: () => {
        const now = input.connection()?.mainNow()
        if (now === undefined) throw new DomainError('WORKER_CLOCK_UNTRUSTED',
          'Main clock has not been observed on this connection.', 409)
        return now
      }, request,
      journal: jobJournal, registry: jobRegistry, signal: lifetime.signal })
    extensions.push(qualification)
  }
  const ciRuntime = new CiRuntimeWorker(input.stateDirectory, { git: systemGitWorktreePorts(process.env),
    managedRuntimeRoot: async () => (await roots()).managedRuntimeRoot,
    prepare: async options => {
      const retained = await jobJournal()
      const qualifications = await retained.pendingQualifications()
      const used = [...options.keepImages ?? [],
        ...await retainedCiJobImages(retained),
        ...qualifications.map(receipt => receipt.candidate.fingerprint.imageDigest)]
      const configurations = await retireCiRuntimeConfigurations(input.stateDirectory, used)
      return prepareCiRuntime({ ...options, stateDirectory: input.stateDirectory, keepImages: [...used, ...configurations.images],
        keepPaths: [...options.keepPaths ?? [], ...configurations.paths] })
    },
    lastRefresh: lastCiRuntimeRefresh, currentRuntimePaths: currentCiRuntimePaths,
    now: () => new Date() }, lifetime.signal)
  extensions.push({ namespace: CI_RUNTIME_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload, context) {
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('CI_RUNTIME_STALE', 'CI runtime preparation requires the actual authenticated worker channel.', 409)
      }
      return { payload: await ciRuntime.handle(payload) }
    },
  })
  // Host CI: this computer runs CI suites directly, fetching from GitHub with its own gh login.
  const hostCi = new HostCiRunner(hostCiDirectory(), systemHostCiPorts(), process.env, input.ciStartupPending)
  extensions.push({ namespace: CI_HOST_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload, context) {
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('CI_HOST_STALE', 'Host CI requires the actual authenticated worker channel.', 409)
      }
      return { payload: await hostCi.handle(payload) }
    },
  })
  extensions.push({ namespace: COMPUTER_ACCOUNTS_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 65_536, maxBinaryBytes: 0,
    async handle(payload, context) {
      const request = ComputerAccountsRequestSchema.parse(payload)
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('COMPUTER_ACCOUNTS_STALE', 'Account facts require the actual authenticated worker channel.', 409)
      }
      const selected = await readInstalledWorkflowConfiguration(configuration)
        .catch(fallbackOnError(null, 'devices', 'read installed workflow configuration'))
      const binaries = { ...(selected?.codexBinary ? { codex: selected.codexBinary } : {}),
        ...(selected?.claude ? { claude: selected.claude.binary } : {}) }
      return { payload: await probeComputerAccounts(systemPorts(process.env, binaries),
        AbortSignal.any([context.signal, lifetime.signal, AbortSignal.timeout(20_000)]),
        { refresh: request.refresh === true }) }
    },
  })
  // One maintenance owner per worker process keeps task history across requests.
  extensions.push({ namespace: COMPUTER_MAINTENANCE_NAMESPACE, version: COMPUTER_MAINTENANCE_VERSION, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload, context) {
      const request = MaintenanceRequestSchema.parse(payload)
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('COMPUTER_MAINTENANCE_STALE', 'Computer maintenance requires the actual authenticated worker channel.', 409)
      }
      maintenance ??= readInstalledWorkflowConfiguration(configuration)
        .catch(fallbackOnError(null, 'devices', 'read installed workflow configuration')).then(selected => {
        // Maintenance reads the binaries this Worker actually runs; an update moves the Codex selection with it.
        const binaries: Record<string, string> = { ...(selected?.codexBinary ? { codex: selected.codexBinary } : {}),
          ...(selected?.claude ? { claude: selected.claude.binary } : {}) }
        return new ComputerMaintenance({ ...systemMaintenancePorts(process.env, binaries),
          ...(input.workerUpdate ? { workerUpdate: input.workerUpdate } : {}),
          async selectInstalledCodex(signal) {
            const binary = await selectInstalledCodex(configuration, process.env.HOME ?? homedir(), signal)
            if (binary) binaries.codex = binary
            return binary
          } })
      })
      const owner = await maintenance
      return { payload: MaintenanceReplySchema.parse(request.operation === 'status'
        ? { operation: 'status', status: await owner.status(AbortSignal.any([context.signal, lifetime.signal, AbortSignal.timeout(90_000)])) }
        : { operation: 'start', task: await owner.start(request.task, request.commandId) }) }
    },
  })
  extensions.push({ namespace: AGENT_SNAPSHOT_NAMESPACE, version: 1, role: 'server', maxJsonBytes: AGENT_SNAPSHOT_JSON_BYTES, maxBinaryBytes: 0,
    async handle(payload, context) {
      const request = AgentSnapshotRequestSchema.parse(payload)
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('AGENT_SNAPSHOT_STALE', 'Agent snapshots require the actual authenticated worker channel.', 409)
      }
      // Only an app-managed Agent worktree under this computer's approved roots can be read.
      const allowed = await roots()
      const path = await realpath(request.path)
      if (!path.endsWith('/tree') || ![allowed.managedRuntimeRoot, ...allowed.bases.map(base => base.canonicalPath)]
        .some(base => path.startsWith(`${base.replace(/\/$/u, '')}/`))) {
        throw new DomainError('AGENT_SNAPSHOT_DENIED', 'This folder is not an Agent worktree on this computer.', 403)
      }
      const snapshot = await snapshotAgentWorktree(systemGitWorktreePorts(process.env), { path, baseCommit: request.baseCommit },
        AbortSignal.any([context.signal, lifetime.signal, AbortSignal.timeout(120_000)]))
      return { payload: AgentSnapshotResultSchema.parse({ commit: snapshot.commit, bundleBase64: snapshot.bundle?.toString('base64') ?? null }) }
    },
  })
  const sync = new SyncthingComputer()
  extensions.push(createComputerSyncExtension(sync, current))
  const githubLogin = new GitHubLoginRunner()
  lifetime.signal.addEventListener('abort', () => githubLogin.close(), { once: true })
  extensions.push({ namespace: COMPUTER_GITHUB_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 16_384, maxBinaryBytes: 0,
    async handle(payload, context) {
      const request = GitHubLoginRequestSchema.parse(payload)
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('COMPUTER_GITHUB_STALE', 'GitHub sign-in requires the actual authenticated worker channel.', 409)
      }
      return { payload: await githubLogin.handle(request) }
    },
  })
  extensions.push({ namespace: 'harness-discovery-v1', version: 1, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload, context) {
      HarnessDiscoveryRequestSchema.parse(payload)
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) throw new DomainError('HARNESS_INVENTORY_STALE', 'The actual installed inventory requires its original worker channel.', 409)
      const signal = AbortSignal.any([context.signal, lifetime.signal])
      const refreshed = input.refreshWorkflowConfiguration
        ? await input.refreshWorkflowConfiguration(signal) : input.configuration
      if (!isDeepStrictEqual(current(), context.binding)) throw new DomainError('HARNESS_INVENTORY_STALE', 'The installed inventory generation changed.', 409)
      if (refreshed && approved) await activateWorkflowConfiguration(refreshed)
      if (!isDeepStrictEqual(current(), context.binding)) throw new DomainError('HARNESS_INVENTORY_STALE', 'The installed inventory generation changed.', 409)
      const inspected = await inspectInstalledCodex({ binding: context.binding, configuration: refreshed,
        fingerprintCache: inventoryPayloadFingerprints, environment: process.env, cwd: input.stateDirectory,
        signal: AbortSignal.any([context.signal, lifetime.signal]) })
      const claude = await inspectInstalledClaude({ binding: context.binding, configuration: refreshed,
        fingerprintCache: inventoryPayloadFingerprints, environment: process.env, cwd: input.stateDirectory,
        signal: AbortSignal.any([context.signal, lifetime.signal]) })
      if (!isDeepStrictEqual(current(), context.binding)) throw new DomainError('HARNESS_INVENTORY_STALE', 'The installed inventory generation changed.', 409)
      return { payload: { ...inspected.inventory,
        installations: [...inspected.inventory.installations,
          ...claude.inventory.installations] } }
    },
  })
  let jobs: RemoteJobExecutionHost | undefined, jobOpening: Promise<RemoteJobExecutionHost> | undefined
  let jobInputs: ReturnType<typeof createWorkerJobInputPort> | ReturnType<typeof createInstalledJobInputRsync> | undefined
  const openJobs = () => jobOpening ??= (async () => {
    const connection = current(), retained = await jobJournal()
    const application = new WorkerJobApplicationSink({ request })
    jobInputs = jobInputRsync ?? createWorkerJobInputPort({ channel: { request, currentBinding: current },
      systemInput,
      stagingRoot: join(input.stateDirectory, 'job-input-transfer-staging'), receiptRoot: join(input.stateDirectory, 'job-input-receipts') })
    const host = createInstalledJobExecutionHost({ configuration: input.jobConfiguration ?? null, registry: jobRegistry,
      ...input.jobReports,
      connection, incarnationId: randomUUID(), journal: retained, currentBinding: current,
      source: createInstalledJobSource({ journal: retained, application, currentBinding: current, approvedRoots: roots }), inputs: jobInputs,
      authorize: (intent, _execution, action) => application.authorize(intent, action),
      observeReceipt: receipt => application.observeReceipt(receipt),
      appendLog: async chunk => {
        const owners = (await retained.jobOperations()).filter(receipt => receipt.execution.id === chunk.executionId && receipt.intent.attemptId === chunk.attemptId)
        if (owners.length !== 1) throw new DomainError('JOB_LOG_OWNER_UNAVAILABLE', 'The original Job log owner is unavailable.', 409)
        await application.appendLog(owners[0]!.intent, chunk)
      },
      collectOutputs: createWorkerJobOutputCollector({ request }, { current: async signal => { signal?.throwIfAborted(); return transferContextForBinding(current()) },
        retryable: error => error instanceof DeviceConnectionError && ['transport', 'timeout'].includes(error.code) }, retained,jobOutputRsync?.collector),
    })
    try { await host.recover() } catch (error) {
      componentLogger('jobs').error({ err: error }, 'Installed Job recovery failed')
      throw error
    }
    jobs = host
    return host
  })()
  const execution = extensions.find(extension => extension.namespace === 'execution-v1')
  const createConversations = () => createInstalledWorkerConversations({ stateDirectory: input.stateDirectory,
    configuration, registry, journal, approvedRoots: roots, current,
    capture: () => input.connection()?.captureRequest('execution-v1'), request,
    codexSuiteRevision: input.codexSuiteRevision, signal: lifetime.signal, ...(accounts ? { accounts } : {}) })
  let conversations = approved ? await createConversations() : null
  let activation: Promise<void> | undefined
  const activateWorkflowConfiguration = async (location: InstalledWorkflowConfigurationLocation) => {
    if (!isDeepStrictEqual(location, configurationLocation)) {
      throw new DomainError('HARNESS_INVENTORY_STALE', 'The protected workflow selection location changed.', 409)
    }
    activation ??= (async () => {
      await readInstalledWorkflowConfiguration(location)
      lifetime.signal.throwIfAborted()
      configuration = location
      await openWorkflow?.(location)
      profileChecks ??= await createInstalledWorkerProfileChecks({ stateDirectory: input.stateDirectory,
        configuration, pairing: input.pairing, current, registry })
      conversations ??= await createConversations()
    })()
    try { await activation }
    finally { activation = undefined }
  }
  const workflowSupport = Boolean(approved && input.refreshWorkflowConfiguration)
  if ((conversations || workflowSupport) && !extensions.some(extension => extension.namespace === WORKER_MCP_EXTENSION.namespace)) {
    extensions.push({ ...WORKER_MCP_EXTENSION, role: 'client' })
  }
  if (workflowSupport && !extensions.some(extension => extension.namespace === EXECUTION_AUTHORITY_EXTENSION.namespace)) {
    extensions.push({ ...EXECUTION_AUTHORITY_EXTENSION, role: 'client' })
  }
  if (input.jobConfiguration && approved) {
    const outputExtension = extensions.find(extension => extension.namespace === JOB_OUTPUT_NAMESPACE)
    if (outputExtension) {
      if (outputExtension.role === 'server') outputExtension.role = 'duplex'
    } else {
      extensions.push({ namespace: JOB_OUTPUT_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 16384, maxBinaryBytes: 8192 })
    }
    extensions.push({namespace:JOB_INPUT_NAMESPACE,version:1,role:'client',maxJsonBytes:1_048_576,maxBinaryBytes:8192})
  }
  if (input.jobConfiguration && approved || conversations || workflowSupport) {
    const handler: DeviceExtensionRegistration = { namespace: 'execution-v1', version: 1, role: 'duplex', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
      async handle(payload, context) {
        if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'Execution requires its actual authenticated worker channel.', 409)
        const job = input.jobConfiguration && RemoteJobExecutionRpcRequestRecordSchema.safeParse(payload).success ? await openJobs() : jobs
        const conversationHost = conversations
        return { payload: await createRemoteExecutionHandler({ handle: async raw => {
          const workflow = native?.kind === 'configured'
            ? native.extensions.find(extension => extension.namespace === 'execution-v1')?.handle : undefined
          if (!workflow) throw new DomainError('WORKER_WORKFLOW_UNAVAILABLE', 'The installed Workflow runtime is unavailable.', 409)
          return (await workflow(raw, context)).payload
        } }, job, conversationHost ? { handle: raw => conversationHost.handle(raw, context.binding, context.signal) } : undefined)(payload) }
      },
    }
    if (execution) extensions.splice(extensions.indexOf(execution), 1, handler)
    else extensions.push(handler)
    const preparation = extensions.find(extension => extension.namespace === REMOTE_PREPARATION_EXTENSION.namespace)
    const preparationHandler = workflowPreparationExtension(handler)
    if (preparation) extensions.splice(extensions.indexOf(preparation), 1, preparationHandler)
    else if (workflowSupport) extensions.push(preparationHandler)
  }
  if (profileChecks || workflowSupport) extensions.push({
    namespace: HARNESS_PROFILE_CHECK_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload, context) {
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('HARNESS_INVENTORY_STALE', 'Profile checks require the authenticated worker channel.', 409)
      }
      if (!profileChecks) throw new DomainError('WORKER_WORKFLOW_UNAVAILABLE', 'Install a workflow harness first.', 409)
      return profileChecks.extension.handle(payload, context)
    },
  })
  const updateWaits = new Set<string>()
  const drainStage = async (stage: string, run: () => Promise<void>) => {
    updateWaits.add(stage)
    try { await run() }
    finally { updateWaits.delete(stage) }
  }
  const updateDrain = createWorkerRuntimeDrain({ signal: lifetime.signal,
    waitingOn: () => [...updateWaits, ...new Set([...active.values()]
      .filter(namespace => namespace !== COMPUTER_MAINTENANCE_NAMESPACE))],
    active: () => [...active].filter(([, namespace]) => namespace !== COMPUTER_MAINTENANCE_NAMESPACE)
      .map(([task]) => task),
    drainJobs: async () => {
      await Promise.all([
        drainStage('host-ci-preparation', () => hostCi.beginDrain()),
        drainStage('ci-runtime-preparation', () => ciRuntime.beginDrain()),
      ])
      if (jobOpening) {
        const opening = jobOpening
        await drainStage('jobs', async () => { await (await opening).beginDrain() })
      }
      if (native?.kind === 'configured') {
        const workflow = native
        await drainStage('workflow-turns', () => workflow.drainForUpdate())
      }
      if (conversations) {
        const conversationHost = conversations
        await drainStage('conversation-tasks', () => conversationHost.drainForUpdate())
      }
    },
    drainQualifications: async () => { await qualification?.drain() },
    drainMaintenance: async () => { if (maintenance) await (await maintenance).drainForWorkerUpdate() },
    quiescent: async () => {
      updateWaits.clear()
      if (!hostCi.isUpdateIdle()) {
        updateWaits.add('host-ci-preparation')
        return false
      }
      if (!ciRuntime.isUpdateIdle()) {
        updateWaits.add('ci-runtime-preparation')
        return false
      }
      const workflowLaunches = registry.snapshot().launches
      const jobLaunches = jobRegistry.snapshot().launches
      for (const [name, opening, launches] of [
        ['workflow-journal', journalOpening, workflowLaunches],
        ['job-journal', jobJournalOpening, jobLaunches],
      ] as const) {
        updateWaits.add(name)
        const log = await opening
        if (log && !await log.isWorkerUpdateIdle(launches)) return false
        updateWaits.delete(name)
      }
      const nativeActive = [...workflowLaunches, ...jobLaunches].some(launch =>
        launch.lifecycle !== 'closed' && !launch.owner.startsWith('conversation:'))
      if (nativeActive) {
        updateWaits.add('native-processes')
        return false
      }
      if (receiver) {
        updateWaits.add('byte-transfer-receiver')
        if (!await receiver.receiver.isRuntimeQuiescent()) return false
        updateWaits.delete('byte-transfer-receiver')
      }
      if (rsync.kind === 'configured') {
        updateWaits.add('rsync-writers')
        const transfers = await Promise.allSettled(rsync.ownership.inventory().map(intent =>
          rsync.ownership.quiescent(intent, lifetime.signal)))
        if (transfers.some(result => result.status === 'rejected')) return false
        updateWaits.delete('rsync-writers')
      }
      return true
    } })
  const tracked = extensions.map(extension => ({ ...extension, ...(extension.handle ? { handle: (payload: unknown, context: DeviceExtensionContext) => {
    lifetime.signal.throwIfAborted()
    try {
      updateDrain.assertAdmission(extension.namespace, payload)
    }
    catch (error) { return Promise.reject(error) }
    const task = extension.handle!(payload, { ...context, signal: AbortSignal.any([context.signal, lifetime.signal]) })
    active.set(task, extension.namespace)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  } } : {}) }))
  let shutdown: Promise<void> | undefined
  return { extensions: tracked, rsyncAvailable: rsync.kind === 'configured', rsyncMissing: rsync.missing,
    async drainForUpdate() {
      await updateDrain.run()
    },
    resumeAfterUpdate() {
      updateDrain.resume()
      jobs?.resumeAdmissions()
      hostCi.resumeAdmissions()
      ciRuntime.resumeAdmissions()
    },
    ...(rsync.kind === 'configured' ? { rsync: rsync.backend, rsyncWriters: rsync.rsyncWriters, rsyncOwnership: rsync.ownership } : {}),
    get workflowAvailable() { return native?.kind === 'configured' }, sourceAvailable: Boolean(receiver),
    close() { return shutdown ??= (async () => {
      lifetime.abort()
      await Promise.allSettled([activation])
      const failures: unknown[] = []
      try { await hostCi.beginDrain() } catch (error) { failures.push(error) }
      try { await ciRuntime.close() } catch (error) { failures.push(error) }
      try { await providerAccounts?.native.close() } catch (error) { failures.push(error) }
      try { await profileChecks?.close() } catch (error) { failures.push(error) }
      try { await telemetry.close() } catch (error) { failures.push(error) }
      try { if (rsync.kind === 'configured') await rsync.rsyncWriters.close() } catch (error) { failures.push(error) }
      try { if (jobOpening) await (await jobOpening).shutdown() } catch (error) { failures.push(error) }
      try { await jobInputs?.close() } catch (error) { failures.push(error) }
      try { if (native?.kind === 'configured') await native.close() } catch (error) { failures.push(error) }
      try { await conversations?.close() } catch (error) { failures.push(error) }
      await Promise.allSettled([...active.keys()])
      await qualification?.drain()
      try { await receiver?.receiver.close() } catch (error) { failures.push(error) }
      if (!failures.length) {
        for (const opening of [journalOpening, jobJournalOpening]) {
          if (opening) { try { await (await opening).close() } catch (error) { failures.push(error) } }
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Actual installed worker domain cleanup is incomplete.')
    })() },
  }
}

export function createWorkerRuntimeDrain(ports: {
  signal: AbortSignal
  active(): Promise<unknown>[]
  drainJobs(): Promise<void>
  drainQualifications(): Promise<void>
  drainMaintenance(): Promise<void>
  quiescent(): Promise<boolean>
  waitingOn?(): string[]
}) {
  let draining = false
  return {
    async run() {
      draining = true
      const startedAt = Date.now()
      let stage = 'dispatches'
      const diagnostics = setInterval(() => {
        componentLogger('devices').warn({ stage, elapsedMs: Date.now() - startedAt,
          waitingOn: ports.waitingOn?.() ?? [] }, 'Worker runtime update is still draining')
      }, 30_000)
      diagnostics.unref()
      try {
        // In-flight dispatches finish admission before the Job host stops accepting work.
        await Promise.allSettled(ports.active())
        stage = 'jobs'
        await ports.drainJobs()
        stage = 'qualifications'
        await ports.drainQualifications()
        stage = 'maintenance'
        await ports.drainMaintenance()
        stage = 'quiescence'
        while (!await ports.quiescent()) await wait(100, undefined, { signal: ports.signal })
        ports.signal.throwIfAborted()
      } finally { clearInterval(diagnostics) }
    },
    resume() { draining = false },
    isDraining() { return draining },
    assertAdmission(namespace: string, payload: unknown) {
      if (draining && isWorkerAdmission(namespace, payload)) {
        throw new DomainError('WORKER_RUNTIME_DRAINING',
          'This computer is waiting for active work to finish before updating its runtime.', 409)
      }
    },
  }
}

function isWorkerAdmission(namespace: string, payload: unknown): boolean {
  if (namespace === 'harness-discovery-v1' || namespace === 'host-harness-check-v1') return true
  if (!payload || typeof payload !== 'object') return false
  if (namespace === REMOTE_PREPARATION_EXTENSION.namespace && 'method' in payload) {
    return payload.method === 'prepare'
  }
  if (namespace === 'execution-v1' && 'method' in payload) {
    return ['job-dispatch', 'prepare', 'prepare-review', 'start-turn', 'session-compact', 'capabilities', 'inspect-mcp',
      'conversation.open', 'conversation.initial-turn', 'conversation.start-turn', 'conversation.compact',
      'conversation.capabilities', 'conversation.inspect-mcp', 'conversation.inspect-entry', 'conversation.compact-read',
      'conversation.file-copy']
      .includes(String(payload.method))
  }
  if (namespace === 'byte-transfer-v1' && 'method' in payload) return payload.method === 'start'
  if (namespace === 'rsync-stage-v1' && 'method' in payload) {
    return ['source-prepare', 'receiver-prepare', 'writer-prepare', 'writer-activate'].includes(String(payload.method))
  }
  if (!('operation' in payload)) return false
  return namespace === SOURCE_OPERATION_EXTENSION.namespace && payload.operation === 'sources.prepare'
    || namespace === COMPUTER_MAINTENANCE_NAMESPACE && payload.operation === 'start'
    || namespace === 'job-runtime-qualification-v1' && ['start', 'run'].includes(String(payload.operation))
    || namespace === CI_RUNTIME_NAMESPACE && payload.operation === 'prepare'
    || namespace === CI_HOST_NAMESPACE && payload.operation === 'start'
}
