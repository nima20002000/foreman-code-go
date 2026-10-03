import { JOB_OUTPUT_NAMESPACE } from '../files/jobs/workerProtocol.js'
import { componentLogger } from '../../infrastructure/logger.js'
import { createWorkerSourceRsyncAcknowledgement } from '../sources/rsyncTransferLifecycle.js'
import { createInstalledRsyncComposition, type InstalledRsyncProviders } from '../byte-transfer/productionComposition.js'
import { randomUUID } from 'node:crypto'
import { RemoteJobExecutionRpcRequestSchema } from '@graphql/contracts/remote-job-execution'
import { createInstalledJobExecutionHost } from '../jobs/executorInstalled.js'
import { WorkerJobApplicationSink } from '../runs/remote/workerJobApplicationSink.js'
import { createInstalledJobSource } from '../runs/remote/installedJobSource.js'
import { createRemoteExecutionHandler } from '../runs/remote/executionRouter.js'
import { createWorkerJobInputPort } from '../files/jobInputs/workerFactory.js'
import { JOB_INPUT_NAMESPACE } from '../files/jobInputs/protocol.js'
import { createWorkerJobOutputCollector } from '../runs/remote/workerJobOutputs.js'
import { createInstalledJobOutputRsync } from '../runs/remote/installedJobOutputRsync.js'
import { createInstalledJobInputRsync } from '../runs/remote/installedJobInputRsync.js'
import { DeviceConnectionError } from './deviceWire.js'
import type { RemoteJobExecutionHost } from '../runs/remote/jobExecutionHost.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { createWorkerQualificationExtension } from '../jobs/workerQualificationCarrier.js'
import type { InstalledRuntimeConfigurationLocation } from '../jobs/installedRuntimeHost.js'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { WorkerPairingConfiguration } from '@graphql/contracts/device-identity'
import { ApprovedRootAllowlistSchema, type ApprovedRootAllowlist } from '@graphql/contracts/workspace-root-policies'
import { HarnessDiscoveryRequestSchema } from '@graphql/contracts/harness-registry'
import { SOURCE_OPERATION_EXTENSION, SourceOperationResponseSchema, SourceTransferStatusResponseSchema } from '@graphql/contracts/source-operations'
import type { DeviceExtensionRegistration, DeviceExtensionContext } from './deviceApplicationChannel.js'
import type { DeviceConnectionSupervisor } from './connectionSupervisor.js'
import { createAuthenticatedTransferReceiver, transferContextForBinding } from '../byte-transfer/carrier.js'
import { sourceTransfersOnMain } from '../sources/operationCarrier.js'
import { SourceOperationWorkerService } from '../sources/operationWorker.js'
import { createInstalledWorkflowHost, type InstalledWorkflowHostOptions } from '../runs/remote/installedWorkflowHost.js'
import type { InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { inspectInstalledCodex } from '../harnesses/installedCodexInspection.js'
import { DomainError } from '../errors.js'

/** Shipped worker domains consume actual protected installation selections and
 * sole Main authority. No database, Run scheduler, generated grant or ready flag. */
export async function createInstalledWorkerDomains(input: {
  stateDirectory: string; pairing: WorkerPairingConfiguration; bootId: string
  configuration: InstalledWorkflowConfigurationLocation | null
  nativeOutputs?: InstalledWorkflowHostOptions['nativeOutputs']
  jobConfiguration?: InstalledRuntimeConfigurationLocation | null
  approvedRoots(): Promise<ApprovedRootAllowlist | null>
  connection(): Pick<DeviceConnectionSupervisor, 'currentBinding' | 'captureRequest'> | undefined
  codexSuiteRevision: string
  /** Installed original source/output, canonical acknowledgement and stopped-writer ports. */
  rsync?: InstalledRsyncProviders
}) {
  const lifetime = new AbortController(), active = new Set<Promise<unknown>>()
  const registry = new NativeProcessRegistry(join(input.stateDirectory, 'workflow-native-processes'))
  const jobRegistry = new NativeProcessRegistry(join(input.stateDirectory, 'job-runtime-native-processes'))
  let jobJournalOpening: Promise<RemoteOperationJournal> | undefined
  const jobJournal = () => jobJournalOpening ??= RemoteOperationJournal.open(join(input.stateDirectory, 'job-runtime-operations.json'))
  let journalOpening: Promise<RemoteOperationJournal> | undefined
  const journal = () => journalOpening ??= RemoteOperationJournal.open(join(input.stateDirectory, 'workflow-operations.json'))
  const current = () => {
    lifetime.signal.throwIfAborted()
    const binding = input.connection()?.currentBinding()
    if (!binding || binding.mainId !== input.pairing.mainId || binding.deviceId !== input.pairing.deviceId
      || binding.workerInstallationId !== input.pairing.workerInstallationId || binding.bootId !== input.bootId
      || binding.keyRevision !== input.pairing.keyRevision || binding.authorizationRevision !== input.pairing.authorizationRevision)
      throw new DomainError('WORKER_DOMAIN_UNAVAILABLE', 'The current original paired Main connection is unavailable.', 409)
    return binding
  }
  const request = async (namespace: string, payload: unknown, options?: { signal?: AbortSignal; bytes?: Uint8Array }) => {
    const binding = current(), captured = input.connection()?.captureRequest(namespace)
    if (!captured || !isDeepStrictEqual(captured.binding, binding)) throw new DomainError('WORKER_DOMAIN_UNAVAILABLE', 'The exact original Main channel is unavailable.', 409)
    const reply = await captured.request(payload, { signal: options?.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal, ...(options?.bytes ? { bytes: options.bytes } : {}) })
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
    journal: await jobJournal(), current, request })
  if (rsync.kind === 'configured' && input.rsync && input.jobConfiguration && approved) jobInputRsync = createInstalledJobInputRsync({
    receiver: input.rsync.receiver, journal: await jobJournal(), channel: { request, currentBinding: current },
    receiptRoot: join(input.stateDirectory, 'job-input-receipts'), admissionRoot: join(input.stateDirectory, 'job-input-rsync-admissions') })
  const extensions: DeviceExtensionRegistration[] = rsync.extensions.map(extension => ({ ...extension, role: 'duplex' as const }))
  let receiver: ReturnType<typeof createAuthenticatedTransferReceiver> | undefined
  let native: Awaited<ReturnType<typeof createInstalledWorkflowHost>> | undefined
  if (approved) {
    receiver = createAuthenticatedTransferReceiver({ stagingRoot: join(input.stateDirectory, 'source-transfer-staging'),
      current: deviceId => { const binding = input.connection()?.currentBinding(); return binding?.deviceId === deviceId ? binding : undefined },
      accepted: rsync.kind === 'configured' ? input.rsync!.accepted : sourceTransfersOnMain(request, current),
      ...(rsync.kind === 'configured' ? { receiver: input.rsync!.receiver } : {}) })
    const sources = new SourceOperationWorkerService({
      authenticate: async context => { if (!isDeepStrictEqual(current(), context.binding)) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source operation is not on the actual original worker generation.', 409) },
      approvedRoots: roots,
      currentOwner: async (operation, context) => {
        const reply = await request(SOURCE_OPERATION_EXTENSION.namespace, { version: 1, operation: 'sources.authorize', request: operation }, { signal: context.signal })
        const value = SourceOperationResponseSchema.parse(reply.payload)
        if (reply.bytes !== undefined || value.operation !== 'sources.authorize') throw new DomainError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'The original Main did not return source operation authority.', 403)
        return value.owner
      },
      transfers: receiver.receiver,
      transferContext: async context => { if (!isDeepStrictEqual(current(), context.binding)) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'The source transfer generation changed.', 409); return transferContextForBinding(context.binding) },
      nativeOwnerFor: record => native?.kind === 'configured' ? native.nativeOwnerFor(record) : Promise.resolve(null),
      preparationNativeClosed: async operationId => input.jobConfiguration ? (await (await jobJournal()).jobNativeOwner(operationId)) === null : false,
    })
    native = await createInstalledWorkflowHost({ stateDirectory: input.stateDirectory, pairing: input.pairing, bootId: input.bootId,
      configuration: input.configuration, currentBinding: () => input.connection()?.currentBinding(),
      captureRequest: namespace => input.connection()?.captureRequest(namespace), sources, approvedRoots: roots,
      ...(input.nativeOutputs ? { nativeOutputs: input.nativeOutputs } : {}),
      codexSuiteRevision: input.codexSuiteRevision, signal: lifetime.signal, registry, journal })
    extensions.push(receiver.extension, { ...SOURCE_OPERATION_EXTENSION, role: 'duplex', async handle(payload, context) {
      return { payload: await sources.handle(payload, { ...context, signal: AbortSignal.any([context.signal, lifetime.signal]) }) }
    } }, ...(native.kind === 'configured' ? native.extensions : []))
  }
  if (input.jobConfiguration && approved) extensions.push(createWorkerQualificationExtension({ configuration: input.jobConfiguration, pairing: input.pairing, bootId: input.bootId,
    currentBinding: current, request, journal: jobJournal, registry: jobRegistry, signal: lifetime.signal }))
  extensions.push({ namespace: 'harness-discovery-v1', version: 1, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload, context) {
      HarnessDiscoveryRequestSchema.parse(payload)
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) throw new DomainError('HARNESS_INVENTORY_STALE', 'The actual installed inventory requires its original worker channel.', 409)
      const inspected = await inspectInstalledCodex({ binding: context.binding, configuration: input.configuration,
        environment: process.env, cwd: input.stateDirectory, signal: AbortSignal.any([context.signal, lifetime.signal]) })
      if (!isDeepStrictEqual(current(), context.binding)) throw new DomainError('HARNESS_INVENTORY_STALE', 'The installed inventory generation changed.', 409)
      return { payload: inspected.inventory }
    },
  })
  let jobs: RemoteJobExecutionHost | undefined, jobOpening: Promise<RemoteJobExecutionHost> | undefined
  let jobInputs: ReturnType<typeof createWorkerJobInputPort> | ReturnType<typeof createInstalledJobInputRsync> | undefined
  const openJobs = () => jobOpening ??= (async () => {
    const connection = current(), retained = await jobJournal()
    const application = new WorkerJobApplicationSink({ request })
    jobInputs = jobInputRsync ?? createWorkerJobInputPort({ channel: { request, currentBinding: current },
      stagingRoot: join(input.stateDirectory, 'job-input-transfer-staging'), receiptRoot: join(input.stateDirectory, 'job-input-receipts') })
    const host = createInstalledJobExecutionHost({ configuration: input.jobConfiguration ?? null, registry: jobRegistry,
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
  if (input.jobConfiguration && approved) {
    const outputExtension = extensions.find(extension => extension.namespace === JOB_OUTPUT_NAMESPACE)
    if (outputExtension) {
      if (outputExtension.role === 'server') outputExtension.role = 'duplex'
    } else {
      extensions.push({ namespace: JOB_OUTPUT_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 16384, maxBinaryBytes: 8192 })
    }
    extensions.push({namespace:JOB_INPUT_NAMESPACE,version:1,role:'client',maxJsonBytes:1_048_576,maxBinaryBytes:8192})
    const workflow = execution?.handle
    const handler: DeviceExtensionRegistration = { namespace: 'execution-v1', version: 1, role: 'duplex', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
      async handle(payload, context) {
        if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'Execution requires its actual authenticated worker channel.', 409)
        const job = RemoteJobExecutionRpcRequestSchema.safeParse(payload).success ? await openJobs() : jobs
        return { payload: await createRemoteExecutionHandler({ handle: async raw => {
          if (!workflow) throw new DomainError('WORKER_WORKFLOW_UNAVAILABLE', 'The installed Workflow runtime is unavailable.', 409)
          return (await workflow(raw, context)).payload
        } }, job)(payload) }
      },
    }
    if (execution) extensions.splice(extensions.indexOf(execution), 1, handler)
    else extensions.push(handler)
  }
  const tracked = extensions.map(extension => ({ ...extension, ...(extension.handle ? { handle: (payload: unknown, context: DeviceExtensionContext) => {
    lifetime.signal.throwIfAborted()
    const task = extension.handle!(payload, { ...context, signal: AbortSignal.any([context.signal, lifetime.signal]) })
    active.add(task); void task.then(() => active.delete(task), () => active.delete(task))
    return task
  } } : {}) }))
  let shutdown: Promise<void> | undefined
  return { extensions: tracked, rsyncAvailable: rsync.kind === 'configured', rsyncMissing: rsync.missing,
    ...(rsync.kind === 'configured' ? { rsync: rsync.backend, rsyncWriters: rsync.rsyncWriters, rsyncOwnership: rsync.ownership } : {}), workflowAvailable: native?.kind === 'configured', sourceAvailable: Boolean(receiver),
    close() { return shutdown ??= (async () => {
      lifetime.abort()
      const failures: unknown[] = []
      try { if (rsync.kind === 'configured') await rsync.rsyncWriters.close() } catch (error) { failures.push(error) }
      try { if (jobOpening) await (await jobOpening).shutdown() } catch (error) { failures.push(error) }
      try { await jobInputs?.close() } catch (error) { failures.push(error) }
      try { if (native?.kind === 'configured') await native.close() } catch (error) { failures.push(error) }
      await Promise.allSettled([...active])
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
