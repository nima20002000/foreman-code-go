import type { ProviderAccountResolver, ResolvedProviderAccount } from '../../provider-accounts/service.js'
import { assertWorkerProviderAccountBinding } from '../../provider-accounts/workerOperations.js'
import { managedProviderEnvironment, resolveRuntimeProviderAccount } from '../../harnesses/providerAccountRuntime.js'
import { constants } from 'node:fs'
import { componentLogger } from '../../diagnostics/logger.js'
import { appLauncherPath } from '../../harnesses/appMcpLauncher.js'
import { open, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ExecutionResultSchema, RETIRED_OPENCODE_MESSAGE,
  type HarnessExecutionRequest, type NativeSessionReference } from '@foreman-code/contracts'
import { randomUUID } from 'node:crypto'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import {
  DeviceConnectionIdentitySchema,
  WorkerPairingConfigurationSchema,
  type WorkerPairingConfiguration,
} from '@foreman-code/contracts/device-identity'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import { DEVICE_APPLICATION_JSON_BYTES } from '@foreman-code/contracts/device-application'
import type { DispatchIntent, AcceptedNodePlacement, NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'
import { RemoteNativeIdentitySchema, RemoteTerminalEvidenceSchema, RemoteOperationReceiptSchema, type RemoteReviewerRequest,
  type RemoteNativeIdentity, type RemoteTerminalEvidence, type RemoteApplicationAccess,
  type RemoteOwnerReconciliation } from '@foreman-code/contracts/remote-execution'
import { RemoteWorkflowPhysicalReadoutSchema, remoteWorkflowPhysicalOutput } from '@foreman-code/contracts/remote-workflow-physical'
import { ApprovedRootAllowlistSchema, type ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { SourceMaterializationRecordSchema, type SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { SourceOperationResponseSchema, type SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import { EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import { WORKER_MCP_EXTENSION } from '@foreman-code/contracts/worker-mcp-relay'
import { DomainError } from '../../errors.js'
import { captureOriginalCodexSession } from '../../harnesses/originalCodexSession.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../../harnesses/port.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../../harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry } from '../../harnesses/installationRegistry.js'
import { CodexAppServerSessionManager, safeEnvironment } from '../../harnesses/codexAppServer.js'
import { inspectInstalledCodex } from '../../harnesses/installedCodexInspection.js'
import { PayloadFingerprintCache } from '../../harnesses/payloadFingerprintCache.js'
import { createInstalledCodexQualificationReader } from '../../harnesses/installedCodexQualification.js'
import { createInstalledCodexDependencies } from '../../harnesses/installedCodexDependencies.js'
import { normalizeHarnessVersion } from '../../harnesses/qualification/profiles.js'
import { NativeProcessRegistry, type NativeLaunchObservation, type NativeProcessRecovery } from '../../harnesses/recovery/processRegistry.js'
import { bootIdentity } from '../../harnesses/recovery/linuxIdentity.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../interactions/runtimePorts.js'
import { workerExecutionAuthorizer, workerExecutionFactsReader, workerReviewerAuthorizer } from '../../placement/executionAuthorityClient.js'
import { sourceMaterializationDigest } from '../../sources/bindingHash.js'
import { readNativeExecutionBinding } from '../../placement/executionBinding.js'
import { readPlacement } from '../../placement/binding.js'
import { anchored, identity, openPrivateRoot, openChildDirectory } from '../../sources/privateFilesystem.js'
import type { SourceOperationWorkerService, SourceOperationWorkerContext } from '../../sources/operationWorker.js'
import type { SourceInstalledNativeOwner } from '../../sources/executionHosts.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteExecutionHost } from './executionHost.js'
import { createRemoteExecutionHandler } from './executionRouter.js'
import { RemoteJobExecutionRpcRequestRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import { RemoteExecutionRpcRequestSchema, type RemoteExecutionRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceExtensionRegistration, DeviceExtensionContext, DeviceApplicationRequestOptions } from '../../devices/deviceApplicationChannel.js'
import { prepareWorkerApplicationAccess } from './workerApplicationAccess.js'
import { createWorkerMcpEndpoint } from './workerMcpEndpoint.js'
import { readInstalledWorkflowConfiguration, type InstalledWorkflowConfigurationLocation } from './installedWorkflowConfiguration.js'
import { RuntimeLeafAttestationSchema, assertRuntimeLeafPath, type RuntimeLeafAttestation } from './runtimeLeaf.js'
import { InstalledWorkflowPhysicalReadouts, matchingOriginalRegistryLaunch,assertOriginalPhysicalDirectories, remoteWorkflowSourceDigest, remoteWorkflowNativeHistory } from './workflowPhysicalReadout.js'
import { createInstalledNativeOutputs, type InstalledNativeOutputProviders } from './installedNativeOutput.js'
import type { CodexNativeOutputTurnPin } from '../../harnesses/codexNativeOutput.js'
import type { WorkflowOriginalNativeSource } from '../../interactions/workflowNativeCapture.js'
import { createInstalledWorkflowNativeOutputProviders } from './installedWorkflowNativeOutputs.js'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema,
  type AgentFilePublishInput, type AgentFilePublishResult } from '@foreman-code/contracts/files'
import { workflowArtifactDigestsByOutputKey, type WorkflowArtifactOutputsV1 } from '@foreman-code/contracts/workflow-artifact-result'
import { pageNativeHistory, nativeHistoryPageSource } from './nativeHistoryPage.js'
import { pagePhysicalReadout } from './workflowPhysicalReadout.js'
import { InstalledWorkflowRecovery } from './installedWorkflowRecovery.js'
import { recoverInstalledWorkflowReply } from './installedWorkflowRecoveryHandler.js'
import { InstalledWorkflowResponsePages } from './installedWorkflowResponsePages.js'
import { hasPositiveRemoteEntryClosure, remoteNonEntryClosureDigest } from '@foreman-code/contracts/remote-execution-entry-closure-node'

function unavailable(reason:string):never {throw new DomainError('WORKER_WORKFLOW_UNAVAILABLE','The original installed workflow authority is unavailable.',409,{reason})}
const digest=(value:unknown)=>commandInputHash(value).slice('sha256:'.length)
function connectionIdentity(binding: Readonly<DeviceSessionBinding>): DeviceConnectionIdentity {
  const { mainId, deviceId, workerInstallationId, bootId, keyRevision, authorizationRevision, connectionGeneration } = binding
  return DeviceConnectionIdentitySchema.parse({
    mainId, deviceId, workerInstallationId, bootId, keyRevision, authorizationRevision, connectionGeneration,
  })
}
export interface InstalledWorkflowNativeOwner {
  readonly native:RemoteNativeIdentity
  readonly launch:NativeLaunchObservation
  readonly owner:string
}
/** The manager's exact execution owner supplies this single actual guardian/provider pair. Names, PID absence and another launch are never used. */
export function captureInstalledWorkflowNativeOwner(registry:NativeProcessRegistry,connection:DeviceConnectionIdentity,
  intent:DispatchIntent,session:NativeSessionReference):InstalledWorkflowNativeOwner {
  if (session.harness === 'opencode') {
    throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
  }
  if(session.harness !== 'codex'||intent.mainId!==connection.mainId)unavailable('native_binding_conflict')
  const owner=`execution:${intent.executionId}`
  const launches=registry.snapshot().launches.filter(row=>row.owner===owner&&row.lifecycle==='active')
  if(launches.length!==1)unavailable('native_owner_missing_or_ambiguous')
  const launch=launches[0]!
  if(launch.bootId!==connection.bootId||!launch.guardian||!launch.provider||!launch.boundary)unavailable('native_provider_evidence_missing')
  return Object.freeze({owner,launch,native:RemoteNativeIdentitySchema.parse({sessionId:session.nativeSessionId,
    processIdentityDigest:digest({connection,intent,owner,launchId:launch.launchId,bootId:launch.bootId,
      guardian:launch.guardian,provider:launch.provider,boundary:launch.boundary})})})
}

/** Only matched provider history plus positive original registry closure can settle. Manager/process cleanup errors retain the original uncertainty. */
export async function settleInstalledWorkflowNativeOwner(input:{journal:RemoteOperationJournal;registry:NativeProcessRegistry;
  intent:DispatchIntent;history:NativeHistory;captured:InstalledWorkflowNativeOwner;
  manager:NativeHarnessSessionManager;session:NativeSessionReference;artifactOutputs?:WorkflowArtifactOutputsV1;
  publications?:ReadonlyMap<string,AgentFilePublishResult['value']>;
  retainReviewer?: { agentId: string; expiresAt: string }}):Promise<RemoteTerminalEvidence|null> {
  const status=await input.journal.status(input.intent.operationId)
  if(status.status!=='known'||!isDeepStrictEqual(status.receipt.intent,input.intent)||!status.receipt.native
    ||status.receipt.native.sessionId!==input.session.nativeSessionId||input.captured.native.sessionId!==input.session.nativeSessionId
    ||status.receipt.native.processIdentityDigest!==input.captured.native.processIdentityDigest
    ||input.captured.owner!==`execution:${input.intent.executionId}`)unavailable('native_closure_binding_conflict')
  if(status.receipt.terminal)return status.receipt.terminal
  const terminal=status.receipt.retainedReviewer && status.receipt.stopFence ? undefined : input.history.terminalTurn
  if(terminal&&(terminal.correlationId!==status.receipt.turnInput?.correlationId
    ||terminal.providerId!==status.receipt.native.turnId
    ||input.history.nativeTurnId!==undefined&&input.history.nativeTurnId!==status.receipt.native.turnId))unavailable('native_result_correlation_conflict')
  if(!terminal&&!status.receipt.stopFence)return null
  const result=terminal?ExecutionResultSchema.parse(terminal.result):undefined
  if (input.retainReviewer && result?.outcome === 'succeeded' && !status.receipt.stopFence) {
    if (matchingOriginalRegistryLaunch(input.registry, input.captured.launch).lifecycle !== 'active')
      unavailable('original_reviewer_process_closed')
    await input.journal.retainReviewer(input.intent.operationId, input.retainReviewer, input.history)
    return null
  }
  await input.manager.close(input.session)
  await input.registry.closeRegistration(input.registry.scope(input.captured.owner),input.captured.launch.launchId)
  if(!await input.registry.closeOwner(input.captured.owner))return null
  const artifacts = result ? installedWorkflowArtifactSettlement(result, input.artifactOutputs, input.publications) : {}
  return RemoteTerminalEvidenceSchema.parse({kind:result?result.outcome==='succeeded'?'completed':result.outcome==='failed'?'failed':'cancelled':'cancelled',
    closureEvidenceDigest:digest({intent:input.intent,native:status.receipt.native,launch:input.captured.launch,physicalOwnerClosed:true}),
    ...(result?{result,resultDigest:digest(result)}:{}),
    ...artifacts})
}

function installedWorkflowArtifactSettlement(result: NonNullable<RemoteTerminalEvidence['result']>,
  declaration?: WorkflowArtifactOutputsV1, publications?: ReadonlyMap<string, AgentFilePublishResult['value']>
): Pick<RemoteTerminalEvidence, 'artifactDigests' | 'artifactValidationError'> {
  const output = remoteWorkflowPhysicalOutput(result, declaration)
  if (output.kind === 'invalid-artifacts') return { artifactValidationError: output.failure, artifactDigests: [] }
  if (output.kind !== 'published-artifacts') return { artifactDigests: [] }
  const digests: { outputKey: string; sha256: string }[] = []
  for (const mapping of output.artifactOutputs.outputs) {
    const publication = publications?.get(mapping.commandId)
    if (!publication) {
      return { artifactValidationError: { code: 'WORKFLOW_ARTIFACT_OUTPUTS_CONFLICT' as const,
        reason: 'missing_publication' as const }, artifactDigests: [] }
    }
    digests.push({ outputKey: mapping.outputKey, sha256: publication.revision.sha256 })
  }
  return { artifactDigests: workflowArtifactDigestsByOutputKey(digests) }
}

/** Source verification uses W09's actual Main-authorized worker service. The runtime leaf is a separate anchored directory with an immutable operation receipt. */
export async function attestInstalledWorkflowRuntimeLeaf(input:{sources:SourceOperationWorkerService;context:SourceOperationWorkerContext;
  approvedRoots:ApprovedRootAllowlist;nativePlacement:NativeExecutionPlacement;intent:DispatchIntent;placement:AcceptedNodePlacement;
  request:HarnessExecutionRequest}):Promise<RuntimeLeafAttestation> {
  const {intent,placement,request}=input,executionPlacement=readNativeExecutionBinding(placement,intent,input.nativePlacement)
  const record=SourceMaterializationRecordSchema.parse(executionPlacement.materialization),roots=ApprovedRootAllowlistSchema.parse(input.approvedRoots)
  const binding=record.receipt.binding
  if(placement.payload.kind!=='agent'||placement.hostRef.kind!=='device'||roots.hostRef.kind!=='device'
    ||!isDeepStrictEqual(roots.hostRef,placement.hostRef)||roots.applicationInstallationId!==placement.registration?.workerInstallationId
    ||roots.managedRuntimeRoot!==placement.destination.managedRuntimeRoot||record.operationId!==intent.operationId
    ||record.receipt.executionId!==intent.executionId||record.receipt.attemptId!==intent.attemptId
    ||record.receipt.materializationId!==executionPlacement.workingTree.materializationId
    ||record.finalDispatchBindingHash!==executionPlacement.bindingHash||placement.bindingHash!==intent.bindingHash
    ||binding.mainId!==input.context.binding.mainId||binding.deviceId!==input.context.binding.deviceId
    ||binding.workerInstallationId!==input.context.binding.workerInstallationId
    ||request.executionId!==intent.executionId||request.runId!==intent.runId||request.workflowNodeId!==intent.nodeId
    ||request.configuration.id!==placement.payload.agentConfigurationVersionId||request.configuration.agentId!==placement.payload.agentId
    ||request.workingDirectory!==executionPlacement.workingTree.canonicalCwd)unavailable('runtime_source_binding_conflict')
  assertRuntimeLeafPath(request.runtimeDirectory,placement)
  input.context.signal.throwIfAborted()
  const verified=SourceOperationResponseSchema.parse(await input.sources.handle({version:1,operation:'sources.verify',record,
    relativeCwd:executionPlacement.workingTree.cwdAttestation?.relativeCwd??''},input.context))
  if(verified.operation!=='sources.verify'||verified.workTree!==executionPlacement.workingTree.canonicalProjectRoot
    ||verified.canonicalCwd!==request.workingDirectory||verified.directoryIdentityHash!==executionPlacement.workingTree.directoryIdentityHash)unavailable('runtime_source_path_conflict')
  const base=await openPrivateRoot(roots.managedRuntimeRoot)
  let directory=base
  try {
    if(!isDeepStrictEqual(await identity(base),roots.runtimeFilesystem))unavailable('runtime_root_changed')
    const parts=relative(roots.managedRuntimeRoot,request.runtimeDirectory).split('/').filter(Boolean)
    for(const part of parts) {
      input.context.signal.throwIfAborted()
      const child=await openChildDirectory(directory,part,true)
      if(directory!==base)await directory.close()
      directory=child
    }
    const filesystem=await identity(directory)
    const proof=RuntimeLeafAttestationSchema.parse({executionId:intent.executionId,attemptId:intent.attemptId,
      operationId:intent.operationId,bindingHash:executionPlacement.bindingHash,canonicalRuntimeDirectory:request.runtimeDirectory,
      directoryIdentityHash:digest(filesystem),materializationId:record.receipt.materializationId,materializationDigest:executionPlacement.workingTree.materializationDigest})
    const marker=anchored(directory,'.graphql-workflow-runtime.json')
    let created:Awaited<ReturnType<typeof open>>|undefined
    try {created=await open(marker,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)}
    catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='EEXIST'))throw error}
    if(created) {
      try {await created.writeFile(JSON.stringify(proof));await created.sync()} finally {await created.close()}
      await directory.sync()
    } else {
      const file=await open(marker,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
      try {
        const stat=await file.stat()
        if(!stat.isFile()||stat.nlink!==1||stat.size>4096||stat.mode&0o077||stat.uid!==process.getuid?.())unavailable('runtime_leaf_receipt_invalid')
        if(!isDeepStrictEqual(RuntimeLeafAttestationSchema.parse(JSON.parse((await file.readFile()).toString('utf8'))),proof))unavailable('runtime_leaf_owner_conflict')
      } finally {await file.close()}
    }
    if(await realpath(request.runtimeDirectory)!==request.runtimeDirectory)unavailable('runtime_leaf_retargeted')
    const current=await openPrivateRoot(request.runtimeDirectory)
    try {if(!isDeepStrictEqual(await identity(current),filesystem))unavailable('runtime_leaf_changed')}
    finally {await current.close()}
    input.context.signal.throwIfAborted()
    return proof
  } finally {if(directory!==base)await directory.close();await base.close()}
}

type QualificationReader=ReturnType<typeof createInstalledCodexQualificationReader>
type QualificationCapture=Awaited<ReturnType<QualificationReader['capture']>>
export interface CapturedWorkflowMainRequest {
  readonly binding:Readonly<DeviceSessionBinding>
  request(payload:unknown,options?:DeviceApplicationRequestOptions):Promise<DeviceApplicationResult>
}
export interface InstalledWorkflowNativeOutputContext {
  intent: DispatchIntent
  placement: AcceptedNodePlacement
  binding: Readonly<DeviceSessionBinding>
  materialization: SourceMaterializationRecord
  applicationAccess(): RemoteApplicationAccess
  publicationCompleted(publication: AgentFilePublishInput, result: AgentFilePublishResult): void
  /** Real original registry/ACK evidence; deliberately does not inspect passive
   * originalSessionLifetime while the producer's starting gate is active. */
  assertCurrent(pin?: CodexNativeOutputTurnPin, signal?: AbortSignal): Promise<void>
}
export interface InstalledWorkflowHostOptions {
  stateDirectory:string
  pairing:WorkerPairingConfiguration
  bootId:string
  configuration:InstalledWorkflowConfigurationLocation|null
  /** Current authenticated channel only; a capture belongs permanently to its original generation. */
  currentBinding():Readonly<DeviceSessionBinding>|undefined
  captureRequest(namespace:string):CapturedWorkflowMainRequest|undefined
  sources:SourceOperationWorkerService
  approvedRoots():Promise<ApprovedRootAllowlist>
  codexSuiteRevision:string
  accounts?:ProviderAccountResolver
  nativeOutputs?(context: InstalledWorkflowNativeOutputContext): InstalledNativeOutputProviders
  signal:AbortSignal
  /** Explicit installation initialization; absence of an established journal is otherwise recovery-required. */
  initializeNewInstallation?:true
  /** Common worker composition owns these shared original journal/registry instances. */
  journal?():Promise<RemoteOperationJournal>
  registry?:NativeProcessRegistry
}
interface InstalledOperation {
  intent:DispatchIntent
  placement:AcceptedNodePlacement
  context:DeviceExtensionContext
  reader:QualificationReader
  capture:QualificationCapture
  scope:NativeProcessRecovery
  account:ResolvedProviderAccount|null
  host?:RemoteExecutionHost
  manager?:CodexAppServerSessionManager
  launchDisabled?:true
  native?:InstalledWorkflowNativeOwner
  session?:NativeSessionReference
  nativeSignal?:AbortSignal
  nativeStart?:NativeSessionStart
  applicationAccess?:RemoteApplicationAccess
  publications: Map<string, AgentFilePublishResult['value']>
  mcp?:Awaited<ReturnType<typeof createWorkerMcpEndpoint>>
  relay?:Awaited<ReturnType<typeof prepareWorkerApplicationAccess>>
  leaseExpiresAt?:string
  runtimeLeaf?:RuntimeLeafAttestation
  runtimeRoots?:ApprovedRootAllowlist
  retainedHistory?:NativeHistory
  physicalClosure?:NativeLaunchObservation
  reviewTimer?:ReturnType<typeof setTimeout>
  reviewAssignment?:RemoteReviewerRequest
  reviewFailure?:unknown
  preparationRecovery?: true
}
/** A configured extension is code support, not qualified readiness. Every new operation consumes genuine Main facts before opening a journal or allocating a manager. */
export async function createInstalledWorkflowHost(input:InstalledWorkflowHostOptions) {
  input.signal.throwIfAborted()
  const configuration=await readInstalledWorkflowConfiguration(input.configuration)
  if(!configuration)return {kind:'unavailable' as const,reason:'missing_configuration' as const}
  const pairing=WorkerPairingConfigurationSchema.parse(input.pairing)
  if(input.bootId!==bootIdentity()||Date.parse(pairing.expiresAt)<=Date.now())unavailable('installed_identity_unavailable')
  const state=await openPrivateRoot(input.stateDirectory);await state.close()
  const registry=input.registry??new NativeProcessRegistry(join(input.stateDirectory,'workflow-native-processes'))
  const lifetime=new AbortController(),signal=AbortSignal.any([input.signal,lifetime.signal])
  const payloadFingerprints = new PayloadFingerprintCache()
  const operations=new Map<string,InstalledOperation>(),hosts=new Map<string,RemoteExecutionHost>()
  const physical=new InstalledWorkflowPhysicalReadouts()
  const responsePages = new InstalledWorkflowResponsePages()
  const recovery = new InstalledWorkflowRecovery(join(input.stateDirectory, 'workflow-recovery'), registry)
  const active=new Set<Promise<unknown>>()
  let journalOpening:Promise<RemoteOperationJournal>|undefined,closing=false,shutdown:Promise<void>|undefined
  const journal=()=>journalOpening??=input.journal?input.journal():RemoteOperationJournal.open(join(input.stateDirectory,'workflow-operations.json'),
    input.initializeNewInstallation?{initializeNewInstallation:true}:{})
  const hasRetainedJournal = async () => {
    try {
      const file = await open(join(input.stateDirectory, 'workflow-operations.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      try { return (await file.stat()).isFile() }
      finally { await file.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  const current=(binding:Readonly<DeviceSessionBinding>)=>{
    signal.throwIfAborted()
    const live=input.currentBinding()
    if(closing||!live||!isDeepStrictEqual(live,binding)||binding.mainId!==pairing.mainId||binding.deviceId!==pairing.deviceId
      ||binding.workerInstallationId!==pairing.workerInstallationId||binding.keyRevision!==pairing.keyRevision
      ||binding.authorizationRevision!==pairing.authorizationRevision||binding.bootId!==input.bootId)unavailable('authenticated_generation_unavailable')
  }
  const forBinding=(binding:Readonly<DeviceSessionBinding>)=>{
    const captures=new Map<string,CapturedWorkflowMainRequest>()
    return async(namespace:string,payload:unknown,options?:{signal?:AbortSignal})=>{
      current(binding)
      let captured=captures.get(namespace)
      if(!captured) {
        captured=input.captureRequest(namespace)
        if(!captured||!isDeepStrictEqual(captured.binding,binding))unavailable('main_channel_unavailable')
        captures.set(namespace,captured)
      }
      const response=await captured.request(payload,{signal:options?.signal?AbortSignal.any([signal,options.signal]):signal})
      current(binding)
      return response
    }
  }
  const operation=(intent:DispatchIntent)=>{
    const owned=operations.get(intent.executionId)
    if(!owned||!isDeepStrictEqual(owned.intent,intent))unavailable('original_operation_unavailable')
    return owned!
  }
  const rememberEntry = (resident: InstalledOperation) => {
    if (!resident.scope.launchId) return
    recovery.rememberEntry({ version: 1,
      ...(resident.placement.payload.kind === 'agent' && resident.placement.payload.accountBinding
        ? { accountBinding: resident.placement.payload.accountBinding } : {}), intent: resident.intent, connection: connectionIdentity(resident.capture.binding),
      owner: resident.scope.owner, initialLaunchId: resident.scope.launchId })
  }
  const refreshReviewer = (resident: InstalledOperation): void => {
    if (resident.reviewTimer || closing) return
    resident.reviewTimer = setTimeout(() => {
      delete resident.reviewTimer
      const check = (async () => {
        const log = await journal()
        const status = await log.status(resident.intent.operationId)
        if (status.status !== 'known' || !status.receipt.retainedReviewer || status.receipt.terminal) return
        try {
          const policy = await workerReviewerAuthorizer(forBinding(resident.context.binding))(resident.intent, resident.placement)
          if (!policy) unavailable('reviewer_run_finished')
          await log.renewReviewer(resident.intent.operationId, policy!)
        } catch (error) {
          resident.reviewFailure = error
          if (Date.parse(status.receipt.retainedReviewer.expiresAt) <= Date.now()) {
            await resident.host!.closeRetainedReviewer(resident.intent.operationId)
            delete resident.reviewFailure
            return
          }
        }
        refreshReviewer(resident)
      })()
      active.add(check)
      void check.finally(() => active.delete(check)).catch(error => {
        resident.reviewFailure = error
        refreshReviewer(resident)
      })
    }, 10_000)
    resident.reviewTimer.unref()
  }
  const constructOwned=async(context:DeviceExtensionContext,intent:DispatchIntent,placement:AcceptedNodePlacement,
    action: 'read' | 'stop', renewal?: RemoteOwnerReconciliation)=>{
    current(context.binding)
    const request=forBinding(context.binding),authorize=workerExecutionAuthorizer(request)
    let owned=operations.get(intent.executionId)
    if(owned) {
      const renewing = renewal && renewal.operationId === intent.operationId
        && isDeepStrictEqual(renewal.nextOwner, intent.owner)
        && isDeepStrictEqual({ ...owned.intent, owner: renewal.nextOwner }, intent)
      if ((!isDeepStrictEqual(owned.intent, intent) && !renewing) || !isDeepStrictEqual(owned.placement, placement)) {
        unavailable('original_operation_binding_changed')
      }
      if (!isDeepStrictEqual(owned.context.binding, context.binding)) {
        const original = owned.context.binding
        if (original.bootId !== context.binding.bootId || !owned.host || !owned.native || !owned.session) {
          unavailable('original_native_reconnection_unavailable')
        }
        await authorize(intent, placement, action)
        const log = await journal()
        let status = await log.status(intent.operationId)
        let observed = matchingOriginalRegistryLaunch(registry, owned.native.launch)
        if (observed.lifecycle !== 'active') {
          // Native closure precedes the terminal journal commit. Join the original settlement before rebinding.
          await owned.host.waitForSettlement(intent.operationId)
          status = await log.status(intent.operationId)
          observed = matchingOriginalRegistryLaunch(registry, owned.native.launch)
        }
        if (status.status !== 'known' || !isDeepStrictEqual(status.receipt.intent, owned.intent)
          || status.receipt.native?.sessionId !== owned.session.nativeSessionId
          || status.receipt.native?.processIdentityDigest !== owned.native.native.processIdentityDigest
          || !isDeepStrictEqual(status.receipt.connection, connectionIdentity(owned.capture.binding))) {
          unavailable('original_native_reconnection_conflict')
        }
        if (status.receipt.terminal ? !isDeepStrictEqual(observed, owned.physicalClosure) : observed.lifecycle !== 'active') {
          unavailable('original_native_reconnection_process_changed')
        }
        current(context.binding)
        if (!isDeepStrictEqual(owned.context.binding, original)) unavailable('original_operation_generation_changed')
        physical.purge(intent.operationId)
        owned.context = context
      }
      if (owned.host) return owned.host
    } else {
      if(operations.size>=1000)unavailable('operation_retention_full')
      const harness = placement.payload.kind === 'agent' ? placement.payload.driverId : undefined
      if (harness !== 'codex') unavailable('installed_harness_selection_missing')
      const binding = placement.payload.kind === 'agent' ? placement.payload.accountBinding : undefined
      assertWorkerProviderAccountBinding(binding, context.binding)
      const account = await resolveRuntimeProviderAccount(input.accounts, 'codex', undefined,
        registry.scope(`execution:${intent.executionId}`), undefined, binding)
      const environment = account ? managedProviderEnvironment(process.env, account, 'codex') : process.env
      const suiteRevision = input.codexSuiteRevision
      const readerInput: Parameters<typeof createInstalledCodexQualificationReader>[0] = {intent,placement,signal,
        trustedCurrentBinding:()=>input.currentBinding()??null,
        trustedCurrentIntent: () => operations.get(intent.executionId)?.intent ?? intent,
        inspect: (binding, effectSignal) => {
          const inspectionInput = { binding, configuration: input.configuration,
            environment, cwd: input.stateDirectory, signal: effectSignal,
            fingerprintCache: payloadFingerprints }
          return inspectInstalledCodex(inspectionInput)
        },
        readFacts: () => {
          const resident = operations.get(intent.executionId)
          return workerExecutionFactsReader(forBinding(resident?.context.binding ?? context.binding))(
            resident?.intent ?? intent, placement)
        },
        assertResident: async (original, binding) => {
          const selected = operations.get(intent.executionId)
          if (!selected) unavailable('original_resident_requalification_missing')
          const resident = selected!
          if (!resident.manager || !resident.native || !resident.session || !resident.host
            || !isDeepStrictEqual(resident.context.binding, binding)) unavailable('original_resident_requalification_missing')
          const assertOriginal = async () => {
            current(binding)
            const state = await(await journal()).status(intent.operationId)
            if (state.status !== 'known' || state.receipt.terminal
              || state.receipt.native?.sessionId !== resident.session?.nativeSessionId
              || state.receipt.native?.processIdentityDigest !== resident.native?.native.processIdentityDigest
              || !isDeepStrictEqual(state.receipt.connection, connectionIdentity(original))
              || matchingOriginalRegistryLaunch(registry, resident.native!.launch).lifecycle !== 'active') {
              unavailable('original_resident_requalification_changed')
            }
          }
          await assertOriginal()
          await workerExecutionAuthorizer(forBinding(binding))(resident.intent, placement, 'read')
          await assertOriginal()
        }, suiteRevision }
      const reader = createInstalledCodexQualificationReader(readerInput)
      const capture=await reader.capture()
      const savedHarness = capture.facts.configuration.harness
      if (savedHarness.harness === 'codex' && savedHarness.accountId
        && savedHarness.accountId !== account?.accountId) unavailable('accepted_account_binding_missing')
      current(context.binding)
      if(operations.size>=1000)unavailable('operation_retention_full')
      owned={intent:structuredClone(intent),placement:structuredClone(placement),context,reader,capture,
        scope:registry.scope(`execution:${intent.executionId}`),account,publications:new Map()}
      operations.set(intent.executionId,owned)
    }
    const generation=commandInputHash(context.binding)
    let host=hosts.get(generation)
    if(!host) {
      const log=await journal();current(context.binding)
      // Other executions may publish this generation's host while the journal opens.
      host = hosts.get(generation)
      if (host) {
        owned.host = host
        return host
      }
      const managers=new ExecutionScopedNativeSessionManagerResolver(configurationContext=>{
        const resident=operations.get(configurationContext.executionId)
        if(!resident||configurationContext.harness !== 'codex'||!isDeepStrictEqual(configurationContext.configuration,resident.capture.facts.configuration)
          ||configurationContext.workingDirectory!==resident.capture.facts.executionPlacement.workingTree.canonicalCwd)unavailable('accepted_configuration_conflict')
        const actual=resident!,binary=actual.capture.inspection.currentTarget?.installation.launcher.resolvedLauncher
        if(!binary)unavailable('installed_launcher_unavailable')
        if (!actual.scope.launchId) Object.assign(actual.scope,registry.reserveLaunch(actual.scope.owner))
        rememberEntry(actual)
        const instances=new HarnessInstanceRegistry(localHarnessDrivers.filter(driver=>driver.driverId===configurationContext.harness))
        const override=actual.capture.facts.harness.override,installation=actual.capture.facts.harness.installation
        instances.reload([{instanceId:override.instanceId,instanceRevision:override.instanceRevision,driverId:override.driverId,enabled:override.enabled,configuration:override.configuration}])
        const payloadFingerprints=installation.launcher.payloadFingerprints
        if(!payloadFingerprints?.length)unavailable('launcher_payload_evidence_missing')
        const installations=new HarnessInstallationRegistry(instances);installations.refresh([{...installation,launcher:{...installation.launcher,payloadFingerprints}}])
        const selection=installations.pin({instanceId:override.instanceId,hostRef:override.target.hostRef,
          harnessInstallationId:override.target.harnessInstallationId,connectionGeneration:installation.connectionGeneration,environmentGeneration:installation.environmentGeneration})
        const before=async()=>{if(actual.launchDisabled||closing)unavailable('original_native_owner_closed');
          if (actual.reviewAssignment) {
            await workerReviewerAuthorizer(forBinding(actual.context.binding))(actual.intent, actual.placement, actual.reviewAssignment)
          } else await workerExecutionAuthorizer(forBinding(actual.context.binding))(actual.intent,actual.placement,'start')
          installations.assertCurrent(selection)}
        const outputContext: InstalledWorkflowNativeOutputContext = {
          get intent() { return structuredClone(actual.intent) },
          placement: structuredClone(actual.placement),
          get binding() { return Object.freeze(structuredClone(actual.context.binding)) },
          materialization: structuredClone(actual.capture.facts.executionPlacement.materialization),
          applicationAccess: () => {
            if (!actual.applicationAccess || actual.launchDisabled || closing) unavailable('original_main_lease_required')
            return structuredClone(actual.applicationAccess!)
          },
          publicationCompleted: (raw, reply) => {
            const publication = AgentFilePublishInputSchema.parse(raw)
            const result = AgentFilePublishResultSchema.parse(reply)
            const chat = publication.scope.chat
            if (actual.launchDisabled || closing || chat.kind !== 'agent' || chat.runId !== actual.intent.runId
              || chat.executionId !== actual.intent.executionId
              || !isDeepStrictEqual(result.value.file.scope, publication.scope)) unavailable('original_artifact_publication_conflict')
            const previous = actual.publications.get(publication.commandId)
            if (previous && !isDeepStrictEqual(previous, result.value)) unavailable('original_artifact_publication_conflict')
            actual.publications.set(publication.commandId, structuredClone(result.value))
          },
          assertCurrent: async (pin, effectSignal) => {
            effectSignal?.throwIfAborted(); current(actual.context.binding)
            if (actual.native) {
              await workerExecutionAuthorizer(forBinding(actual.context.binding))(actual.intent,actual.placement,'read')
              installations.assertCurrent(selection)
            } else {
              await before()
            }
            effectSignal?.throwIfAborted(); current(actual.context.binding)
            if (operations.get(actual.intent.executionId) !== actual) unavailable('original_native_owner_closed')
            if (pin) {
              pin.assertCurrent()
              const native = actual.native
              if (!native || !actual.session || !isDeepStrictEqual(actual.session, pin.session)) unavailable('original_native_owner_missing')
              const observed = matchingOriginalRegistryLaunch(registry, native!.launch)
              if (observed.lifecycle !== 'active' || !isDeepStrictEqual(observed.guardian, native!.launch.guardian)
                || !isDeepStrictEqual(observed.provider, native!.launch.provider)
                || !isDeepStrictEqual(observed.boundary, native!.launch.boundary)) unavailable('original_native_process_changed')
              const status = await log.status(actual.intent.operationId)
              if (status.status !== 'known' || status.receipt.stopFence || status.receipt.terminal
                || status.receipt.native?.sessionId !== pin.session.nativeSessionId
                || status.receipt.native?.turnId !== pin.nativeTurnId
                || status.receipt.native?.processIdentityDigest !== native!.native.processIdentityDigest) unavailable('original_native_ack_missing')
              pin.assertCurrent(); effectSignal?.throwIfAborted(); current(actual.context.binding)
            }
          },
        }
        const dependencies=createInstalledCodexDependencies({reader:actual.reader,codexSuiteRevision:input.codexSuiteRevision})
        const declared = actual.placement.payload.kind === 'agent' && actual.placement.payload.artifactOutputs
        const outputPorts = declared ? (input.nativeOutputs
          ? input.nativeOutputs(outputContext)
          : createInstalledWorkflowNativeOutputProviders({ stateDirectory: input.stateDirectory,
            context: outputContext, registry, captureRequest: input.captureRequest,
            qualification: { qualify: dependencies.qualify, command: dependencies.runCommand } })) : undefined
        if (outputPorts && (!isDeepStrictEqual(outputPorts.artifacts.binding.intent, actual.intent)
          || !isDeepStrictEqual(outputPorts.artifacts.binding.placement, actual.placement)
          || outputPorts.artifacts.binding.root.rootId !== outputContext.materialization.receipt.binding.rootId
          || outputPorts.artifacts.binding.root.rootBindingRevision !== outputContext.materialization.receipt.binding.bindingRevision)) unavailable('original_native_output_binding_conflict')
        const nativeOutputs = outputPorts && createInstalledNativeOutputs({ ...outputPorts,
          assertCurrent: async effectSignal => { await outputContext.assertCurrent(undefined, effectSignal); await outputPorts.assertCurrent(effectSignal) },
          storage: (prepared, pin) => {
            const storage = outputPorts.storage(prepared, pin)
            if (!('binding' in storage.owner)
              || !isDeepStrictEqual(storage.owner.binding, actual.context.binding)) unavailable('original_native_output_connection_conflict')
            return storage
          },
          authorize: async (pin, operation, effectSignal) => {
            await outputContext.assertCurrent(pin, effectSignal)
            const scope = await outputPorts.authorize(pin, operation, effectSignal)
            await outputContext.assertCurrent(pin, effectSignal)
            return scope
          },
        })
        const manager=new CodexAppServerSessionManager(binary,undefined,undefined,actual.scope,'scoped',undefined,{...dependencies,
          environment: (variables, scopedNames) => {
            const source = safeEnvironment(variables, scopedNames)
            return actual.account ? managedProviderEnvironment(source, actual.account, 'codex') : source
          },
          qualify:async(binary,cwd,environment,authenticated,effectSignal)=>{
            await before()
            const result=await dependencies.qualify(binary,cwd,environment,authenticated,effectSignal,actual.scope)
            if(normalizeHarnessVersion(result.providerVersion)!==actual.capture.qualification.version)unavailable('native_version_changed')
            return result
          },
          assertUnchanged:async value=>{await before();await dependencies.assertUnchanged(value)},
          runCommand:async(binary,args,cwd,effectSignal,environment,options)=>{await before();return dependencies.runCommand(binary,args,cwd,effectSignal,environment,{...options,recovery:actual.scope})},
          qualifyModel: async (configuration, binary, cwd, environment, effectSignal, _recovery, inspection) => {
            await before()
            return dependencies.qualifyModel(configuration, binary, cwd, environment,
              effectSignal, actual.scope, inspection)
          },
        },{workingDirectory:configurationContext.workingDirectory},nativeOutputs)
        actual.manager=manager
        return manager
      })
      host=new RemoteExecutionHost({journal:log,connection:DeviceConnectionIdentitySchema.parse({mainId:context.binding.mainId,deviceId:context.binding.deviceId,
        workerInstallationId:context.binding.workerInstallationId,keyRevision:context.binding.keyRevision,authorizationRevision:context.binding.authorizationRevision,
        bootId:context.binding.bootId,connectionGeneration:context.binding.connectionGeneration}),incarnationId:randomUUID(),managers,
        authorize:async(intent,placement,action)=>{const resident=operations.get(intent.executionId)
          if (!resident || !isDeepStrictEqual({ ...resident.intent, owner: intent.owner }, intent)) {
            unavailable('original_operation_binding_changed')
          }
          await workerExecutionAuthorizer(forBinding(resident.context.binding))(intent,placement,action)
          if(action==='start')operation(intent).capture=await operation(intent).reader.capture()},
        verifyOwnerRenewal: async (transition, receipt) => {
          const resident = operation(receipt.intent)
          if (!resident.native || !resident.session || !isDeepStrictEqual(transition.native, receipt.native)
            || transition.operationId !== receipt.intent.operationId
            || matchingOriginalRegistryLaunch(registry, resident.native.launch).lifecycle !== 'active') {
            unavailable('original_native_owner_renewal_changed')
          }
          const next = { ...receipt.intent, owner: transition.nextOwner }
          await workerExecutionAuthorizer(forBinding(resident.context.binding))(next, resident.placement, 'control')
          current(resident.context.binding)
          const currentState = await log.status(receipt.intent.operationId)
          if (currentState.status !== 'known' || !isDeepStrictEqual(currentState.receipt, receipt)) {
            unavailable('original_native_owner_renewal_changed')
          }
          resident.intent = structuredClone(next)
        },
        authorizeReview: async (intent, placement, review) => {
          const resident = operation(intent)
          current(resident.context.binding)
          const policy = await workerReviewerAuthorizer(forBinding(resident.context.binding))(intent, placement, review)
          if (!policy || policy.agentId !== review.reviewerAgentId) unavailable('original_review_assignment_denied')
          await log.renewReviewer(intent.operationId, policy!)
          resident.reviewAssignment = structuredClone(review)
        },
        attestRuntimeLeaf:async(intent,placement,request,executionPlacement)=>{
          const resident=operation(intent),capture=await resident.reader.capture()
          if(!executionPlacement||executionPlacement.bindingHash!==capture.facts.executionPlacement.bindingHash
            ||!isDeepStrictEqual(request.configuration,capture.facts.configuration))unavailable('actual_native_placement_required')
          resident.capture=capture
          const approvedRoots = ApprovedRootAllowlistSchema.parse(await input.approvedRoots())
          const runtimeLeaf=await attestInstalledWorkflowRuntimeLeaf({sources:input.sources,context:{...context,signal},approvedRoots,
            nativePlacement:capture.facts.executionPlacement,intent,placement,request})
          resident.runtimeLeaf=runtimeLeaf
          resident.runtimeRoots=structuredClone(approvedRoots)
          if (!resident.scope.launchId) Object.assign(resident.scope, registry.reserveLaunch(resident.scope.owner))
          rememberEntry(resident)
          return runtimeLeaf
        },
        preflight: async (nativeRequest, access) => {
          const log = componentLogger('harness')
          let launcher: string | undefined
          try {
            launcher = appLauncherPath()
            log.info({ executionId: nativeRequest.executionId, launcher }, 'Preparing worker workflow MCP route')
            const resident = operations.get(nativeRequest.executionId)
            if (!resident || !access) unavailable('original_main_lease_required')
            const actual = resident!
            await authorize(actual.intent, actual.placement, 'start')
            actual.capture = await actual.reader.capture()
            if (!isDeepStrictEqual(nativeRequest.configuration, actual.capture.facts.configuration)) {
              unavailable('accepted_configuration_conflict')
            }
            const relay = await prepareWorkerApplicationAccess({ request: async (namespace, payload, options) =>
              forBinding(actual.context.binding)(namespace, payload, options) }, actual.intent, actual.placement,
            access, signal, { currentIntent: () => actual.intent })
            const nativeStart: NativeSessionStart = { request: structuredClone(nativeRequest),
              correlationId: `execution:${actual.intent.executionId}`, environment: relay.environment }
            if (actual.nativeStart && !isDeepStrictEqual(actual.nativeStart, nativeStart)) {
              unavailable('original_native_start_changed')
            }
            // Native MCP inspection accepts the managed launcher, which reads routes beside itself.
            if (!actual.mcp) actual.mcp = await createWorkerMcpEndpoint({ relay, launcher, signal })
            else await actual.mcp.bindRelay(relay)
            actual.applicationAccess = structuredClone(access)
            actual.relay = relay
            actual.leaseExpiresAt = relay.expiresAt
            actual.nativeStart ??= nativeStart
            rememberEntry(actual)
            return relay.environment
          } catch (error) {
            log.error({ executionId: nativeRequest.executionId, launcher,
              code: error instanceof Error && 'code' in error ? error.code : undefined,
              errorType: error instanceof Error ? error.name : typeof error }, 'Worker workflow MCP preparation failed')
            throw error
          }
        },
        nativeEvidence:async(intent,session,nativeContext)=>{const resident=operation(intent)
          if(!resident.manager||!nativeContext||nativeContext.manager!==resident.manager
            ||nativeContext.request.executionId!==intent.executionId)unavailable('native_manager_not_allocated')
          resident.session=structuredClone(session);resident.nativeSignal=nativeContext.signal
          const state = await log.status(intent.operationId)
          const originalCapture = state.status === 'known' && state.receipt.native ? recovery.read(state.receipt) : undefined
          const captured = captureInstalledWorkflowNativeOwner(registry,
            originalCapture?.connection ?? connectionIdentity(resident.capture.binding),
            originalCapture?.intent ?? intent, session)
          if (resident.native && !isDeepStrictEqual(resident.native, captured)) unavailable('original_native_process_changed')
          resident.native ??= captured
          if(!resident.nativeStart)unavailable('original_native_start_missing')
          const assertOwnerCurrent = () => {
            nativeContext.signal.throwIfAborted();current(resident.context.binding)
            if(operations.get(intent.executionId)!==resident||resident.launchDisabled)unavailable('original_native_owner_closed')
            const observed=matchingOriginalRegistryLaunch(registry,captured.launch)
            if(observed.lifecycle!=='active'||!isDeepStrictEqual(observed.guardian,captured.launch.guardian)
              ||!isDeepStrictEqual(observed.provider,captured.launch.provider)||!isDeepStrictEqual(observed.boundary,captured.launch.boundary))unavailable('original_native_process_changed')
          }
          const lifetime = captureOriginalCodexSession(resident.manager, session, resident.nativeStart!, assertOwnerCurrent)
          assertOwnerCurrent()
          if(!lifetime)unavailable('original_native_residency_unavailable')
          lifetime!.assertCurrent()
          if (!resident.runtimeLeaf) unavailable('original_runtime_leaf_missing')
          recovery.remember({ version: 1,
            ...(resident.placement.payload.kind === 'agent' && resident.placement.payload.accountBinding
              ? { accountBinding: resident.placement.payload.accountBinding } : {}),
            intent: originalCapture?.intent ?? resident.intent,
            connection: originalCapture?.connection ?? connectionIdentity(resident.capture.binding), native: resident.native.native,
            session: resident.session, launch: RemoteWorkflowPhysicalReadoutSchema.shape.launch.parse(resident.native.launch),
            runtimeLeaf: resident.runtimeLeaf!, approvedRoots: ApprovedRootAllowlistSchema.parse(resident.runtimeRoots),
            source: RemoteWorkflowPhysicalReadoutSchema.shape.source.parse({
              record: resident.capture.facts.executionPlacement.materialization,
              workingTree: resident.capture.facts.executionPlacement.workingTree }) })
          return resident.native.native
        },
        settle:async(intent,history,owner)=>{
          const resident=operation(intent)
          if(!resident.native||resident.manager!==owner.manager)unavailable('original_native_owner_required')
          resident.retainedHistory=structuredClone(history)
          const state=await log.status(intent.operationId)
          const declaration = resident.placement.payload.kind === 'agent' ? resident.placement.payload.artifactOutputs : undefined
          const reviewer = state.status === 'known' && !state.receipt.stopFence
            && resident.capture.facts.configuration.productRole === 'orchestrator'
            && history.terminalTurn?.result.outcome === 'succeeded'
            ? await workerReviewerAuthorizer(forBinding(resident.context.binding))(intent, resident.placement) : undefined
          if(!reviewer&&state.status==='known'&&(state.receipt.stopFence||history.terminalTurn!==undefined&&history.terminalTurn.correlationId===state.receipt.turnInput?.correlationId
            &&history.terminalTurn.providerId===state.receipt.native?.turnId))resident.launchDisabled=true
          const terminal=await settleInstalledWorkflowNativeOwner({journal:log,registry,intent,history,captured:resident.native,
            manager:owner.manager,session:owner.session,publications:resident.publications,
            ...(declaration ? { artifactOutputs: declaration } : {}),
            ...(reviewer ? { retainReviewer: reviewer } : {})})
          if(terminal) {
            if (resident.reviewTimer) clearTimeout(resident.reviewTimer)
            const observation=matchingOriginalRegistryLaunch(registry,resident.native.launch)
            if(observation.lifecycle!=='closed'||observation.closureEvidence!=='cgroup_v2_empty')unavailable('original_physical_closure_missing')
            resident.physicalClosure=observation
            componentLogger('engine').info({ executionId: intent.executionId }, 'Original workflow owner settled')
            await resident.mcp?.close()
          }
          if (reviewer) refreshReviewer(resident)
          return terminal
        },
      })
      hosts.set(generation,host)
    }
    owned.host = host
    return host
  }
  const construction = new Map<string, {
    binding: Readonly<DeviceSessionBinding>
    intent: DispatchIntent
    placement: AcceptedNodePlacement
    task: Promise<RemoteExecutionHost>
  }>()
  const construct = async (context:DeviceExtensionContext,intent:DispatchIntent,placement:AcceptedNodePlacement,
    action:'read'|'stop', renewal?: RemoteOwnerReconciliation): Promise<RemoteExecutionHost> => {
    context.signal.throwIfAborted()
    current(context.binding)
    const pending = construction.get(intent.executionId)
    if (pending) {
      if (!isDeepStrictEqual(pending.intent,intent) || !isDeepStrictEqual(pending.placement,placement)) {
        unavailable('original_operation_generation_changed')
      }
      if (isDeepStrictEqual(pending.binding,context.binding)) return pending.task
      if (pending.binding.bootId !== context.binding.bootId
        || pending.binding.connectionGeneration === context.binding.connectionGeneration)
        unavailable('original_operation_generation_changed')
      await Promise.allSettled([pending.task])
      current(context.binding)
      return construct(context,intent,placement,action,renewal)
    }
    const task = constructOwned(context,intent,placement,action,renewal)
    construction.set(intent.executionId, {
      binding: structuredClone(context.binding),
      intent: structuredClone(intent),
      placement: structuredClone(placement),
      task,
    })
    void task.then(() => construction.delete(intent.executionId), () => construction.delete(intent.executionId))
    return task
  }
  const closeResidentPreparation = async (resident: InstalledOperation, reason: string) => {
    componentLogger('engine').warn({ executionId: resident.intent.executionId, reason,
      native: Boolean(resident.native), session: Boolean(resident.session) }, 'Closing original workflow preparation')
    resident.launchDisabled = true
    resident.preparationRecovery = true
    await resident.host?.abortPreparation(resident.intent.operationId)
    await resident.manager?.dispose?.()
    await registry.abandonReservedLaunch(resident.scope)
    const log = await journal()
    const state = await log.status(resident.intent.operationId)
    const receipt = state.status === 'known' ? state.receipt
      : await log.accept(resident.intent, connectionIdentity(resident.capture.binding), randomUUID())
    if (receipt.native) {
      await recovery.reconcile(receipt, log, signal)
    } else if (receipt.entryAttempted) {
      await recovery.closePendingEntry(receipt, log, signal)
    } else {
      if (!await registry.closeOwner(resident.scope.owner, signal)) unavailable('native_owner_closure_unconfirmed')
      await log.revokeFence(receipt.intent.operationId)
      if (!receipt.terminal) await log.terminal(receipt.intent.operationId, { kind: 'not_started',
        closureEvidenceDigest: remoteNonEntryClosureDigest(receipt.intent) })
    }
    await resident.mcp?.close()
  }
  const releaseSettled = async (intent: DispatchIntent) => {
    for (const host of hosts.values()) await host.retireSettled(intent.operationId)
    operations.delete(intent.executionId)
    physical.purge(intent.operationId)
  }
  const retiredReply = async (frame: RemoteExecutionRpcRequest,
    context: DeviceExtensionContext, log: RemoteOperationJournal) => {
    current(context.binding)
    const placement = readPlacement(frame.placement)
    const status = await log.status(frame.intent.operationId)
    if (status.status !== 'known' || !isDeepStrictEqual(status.receipt.intent, frame.intent)
      || placement.bindingHash !== frame.intent.bindingHash || placement.hostRef.kind !== 'device'
      || placement.hostRef.deviceId !== context.binding.deviceId || placement.mainId !== context.binding.mainId
      || status.receipt.connection.workerInstallationId !== context.binding.workerInstallationId) {
      unavailable('retired_operation_ownership_changed')
    }
    if (frame.method === 'control' && (frame.command.operationId !== frame.intent.operationId
      || frame.command.attemptId !== frame.intent.attemptId || frame.command.executionId !== frame.intent.executionId
      || frame.command.bindingHash !== frame.intent.bindingHash || !isDeepStrictEqual(frame.command.owner, frame.intent.owner))) {
      unavailable('retired_control_ownership_changed')
    }
    let action: 'start' | 'read' | 'control' = 'read'
    if (frame.method === 'control') action = 'control'
    else if (frame.method === 'prepare' || frame.method === 'start-turn') action = 'start'
    await workerExecutionAuthorizer(forBinding(context.binding))(frame.intent, placement, action)
    current(context.binding)
    if (frame.method === 'status' || frame.method === 'physical-readout') {
      const recovered = await recoverInstalledWorkflowReply({ frame, binding: context.binding,
        journal: log, recovery, registry, physical, signal: context.signal, lifetimeSignal: signal,
        assertCurrent: () => current(context.binding),
        authorize: async action => {
          await workerExecutionAuthorizer(forBinding(context.binding))(frame.intent, placement, action)
        } })
      if (recovered) return recovered
    }
    await releaseSettled(frame.intent)
    if (frame.method === 'status') return { payload: status }
    if (frame.method === 'control-delivery') {
      if (frame.command.operationId !== frame.intent.operationId || frame.command.executionId !== frame.intent.executionId
        || frame.command.attemptId !== frame.intent.attemptId || frame.command.bindingHash !== frame.intent.bindingHash
        || !isDeepStrictEqual(frame.command.owner, frame.intent.owner)
          && !status.receipt.controls.some(command => isDeepStrictEqual(command, frame.command))) {
        unavailable('retired_control_ownership_changed')
      }
      return { payload: { phase: await log.controlDelivery(frame.command) ?? 'unknown', status } }
    }
    if (frame.method === 'control') {
      await log.control(frame.command)
      return { payload: status }
    }
    if (frame.method === 'physical-ack') return { payload: { version: 1, operationId: frame.intent.operationId,
      receiptSequence: frame.receiptSequence, sourceDigest: frame.sourceDigest, status: 'not_retained' } }
    unavailable('original_operation_retired')
  }
  const extensions:DeviceExtensionRegistration[]=[{namespace:'execution-v1',version:1,role:'duplex',maxJsonBytes:DEVICE_APPLICATION_JSON_BYTES,maxBinaryBytes:0,
    async handle(payload,context) {
      if(context.bytes!==undefined)unavailable('workflow_binary_payload_refused')
      if(RemoteJobExecutionRpcRequestRecordSchema.safeParse(payload).success)throw new DomainError('JOB_RUNTIME_UNAVAILABLE','The installed workflow host has no Job runtime.',409)
      const frame=RemoteExecutionRpcRequestSchema.parse(payload)
      const task=(async()=>{
        current(context.binding)
        if (frame.method === 'receipt-continuation') {
          const status = await(await journal()).status(frame.intent.operationId)
          if (status.status !== 'known' || !isDeepStrictEqual(status.receipt.intent, frame.intent)) {
            unavailable('original_receipt_transfer_owner_changed')
          }
          await workerExecutionAuthorizer(forBinding(context.binding))(frame.intent, frame.placement,
            status.receipt.stopFence ? 'stop' : 'read')
          current(context.binding)
          return { payload: responsePages.read(frame, context.binding) }
        }
        const resident = operations.get(frame.intent.executionId)
        if (resident && (resident.preparationRecovery || !isDeepStrictEqual(resident.context.binding, context.binding))) {
          const status = await(await journal()).status(frame.intent.operationId)
          const acknowledged = status.status === 'known' && status.receipt.native && resident.native && resident.session
          if (!acknowledged || resident.preparationRecovery) {
            if (!isDeepStrictEqual(resident.intent, frame.intent) || !isDeepStrictEqual(resident.placement, frame.placement)
              || resident.context.binding.bootId !== context.binding.bootId) unavailable('original_operation_binding_changed')
            const action = frame.method === 'control' && frame.command.action.kind === 'stop' ? 'stop' : 'read'
            await workerExecutionAuthorizer(forBinding(context.binding))(frame.intent, frame.placement, action)
            current(context.binding)
            resident.context = context
            await closeResidentPreparation(resident, resident.preparationRecovery ? 'preparation_recovery'
              : `binding_changed:${status.status}:${Boolean(status.status === 'known' && status.receipt.native)}`)
            current(context.binding)
          }
        }
        if ((!resident || resident.preparationRecovery) && (journalOpening
          || recovery.hasCapture(frame.intent.operationId) || await hasRetainedJournal())) {
          const recovered = await recoverInstalledWorkflowReply({ frame, binding: context.binding,
            journal: await journal(), recovery, registry, physical, signal: context.signal, lifetimeSignal: signal,
            assertCurrent: () => current(context.binding),
            authorize: async action => { await workerExecutionAuthorizer(forBinding(context.binding))(frame.intent, frame.placement, action) } })
          if (recovered) return recovered
        }
        if (journalOpening && await(await journalOpening).isRetired(frame.intent.operationId)) {
          return retiredReply(frame, context, await journalOpening)
        }
        const action = frame.method === 'control' && frame.command.action.kind === 'stop' ? 'stop' : 'read'
        const host=await construct(context,frame.intent,frame.placement,action,
          frame.method === 'renew-owner' ? frame.transition : undefined)
        context.signal.throwIfAborted()
        const log = await journal()
        if (await log.isRetired(frame.intent.operationId)) return retiredReply(frame, context, log)
        if (frame.method === 'get-application-access') {
          const resident = operation(frame.intent)
          await workerExecutionAuthorizer(forBinding(resident.context.binding))(frame.intent, resident.placement, 'read')
          if (!resident.applicationAccess || !isDeepStrictEqual(resident.session, frame.session)
            || !resident.native || matchingOriginalRegistryLaunch(registry, resident.native.launch).lifecycle !== 'active')
            unavailable('original_application_lease_owner_missing')
          return { payload: { status: await log.status(frame.intent.operationId),
            applicationAccess: structuredClone(resident.applicationAccess!) } }
        }
        if(frame.method==='physical-readout')return {payload:pagePhysicalReadout(await physical.read(frame, context.signal), frame.metadata)}
        if(frame.method==='physical-ack') {
          const resident = operation(frame.intent)
          const status = await log.status(frame.intent.operationId)
          if (frame.retire && resident.physicalClosure
            && status.status === 'known' && status.receipt.terminal && status.receipt.sequence === frame.receiptSequence) {
            const readout = await physical.read(frame, context.signal)
            const terminalSource = frame.sourceDigest === remoteWorkflowSourceDigest({ type: 'boundary' })
              || readout.history && frame.sourceDigest === remoteWorkflowSourceDigest({
                type: 'history', history: remoteWorkflowNativeHistory(readout.history),
              })
            if (terminalSource) {
              await log.retireSettled(frame.intent, frame.receiptSequence)
              const ack = await physical.ack(frame)
              await releaseSettled(frame.intent)
              return {payload:ack}
            }
          }
          return {payload:await physical.ack(frame)}
        }
        // A retained process must be observable before its App binding can be restored.
        let reviewerObservationExpiresAt: string | undefined
        if (frame.method === 'status' || frame.method === 'reattach') {
          const original = await log.status(frame.intent.operationId)
          if (original.status === 'known' && original.receipt.retainedReviewer
            && !original.receipt.terminal && !original.receipt.stopFence) {
            const resident = operation(frame.intent)
            if (!resident.native || resident.session?.nativeSessionId !== original.receipt.native?.sessionId
              || matchingOriginalRegistryLaunch(registry, resident.native.launch).lifecycle !== 'active') {
              unavailable('original_reviewer_observation_owner_missing')
            }
            const policy = await workerReviewerAuthorizer(forBinding(context.binding))(frame.intent, frame.placement)
            if (!policy) unavailable('original_reviewer_observation_denied')
            const renewed = await log.renewReviewer(frame.intent.operationId, policy!)
            reviewerObservationExpiresAt = renewed.retainedReviewer!.expiresAt
          }
        }
        const response=await createRemoteExecutionHandler(host)(frame)
        const value=response&&typeof response==='object'?response as {session?:NativeSessionReference;history?:NativeHistory;status?:unknown}:undefined
        const status=value?.status&&typeof value.status==='object'?value.status as {status?:string;receipt?:unknown}:response as {status?:string;receipt?:unknown}
        if(status?.status==='known') {
          const receipt=RemoteOperationReceiptSchema.parse(status.receipt),resident=operation(frame.intent)
          if(receipt.native&&resident.native&&resident.session&&resident.runtimeLeaf&&resident.leaseExpiresAt) {
            const authority = await workerExecutionAuthorizer(forBinding(context.binding))(frame.intent, frame.placement,
              receipt.stopFence ? 'stop' : 'read')
            const cleanupOnly = authority?.cleanupOnly === true
            if (!reviewerObservationExpiresAt && !cleanupOnly && !receipt.stopFence && !resident.physicalClosure) {
              if (!resident.mcp) unavailable('original_main_lease_required')
              resident.leaseExpiresAt = await resident.mcp!.refreshLease()
            } else if (!reviewerObservationExpiresAt && !cleanupOnly && !receipt.stopFence
              && Date.parse(resident.leaseExpiresAt) <= Date.now()) {
              if (!resident.relay) unavailable('original_main_lease_required')
              resident.leaseExpiresAt = await resident.relay!.refresh(signal)
            }
            // Cancellation readback uses cleanup authority; it does not extend the MCP credential.
            const observationExpiresAt = cleanupOnly || receipt.stopFence
              ? new Date(Date.now() + 60_000).toISOString() : reviewerObservationExpiresAt ?? resident.leaseExpiresAt
            const originalHistory = nativeHistoryPageSource(response) ?? value?.history
            const source:WorkflowOriginalNativeSource=value?.session?{type:'session_created',session:value.session}
              :originalHistory?{type:'history',history:originalHistory}:{type:'boundary'}
            const history = originalHistory ?? (resident.retainedHistory
              ? nativeHistoryPageSource(pageNativeHistory(resident.retainedHistory)) : undefined)
            const readout=RemoteWorkflowPhysicalReadoutSchema.parse({version:1,expiresAt:new Date(Math.min(Date.parse(observationExpiresAt),Date.now()+60_000)).toISOString(),
              launchIntent: recovery.read(receipt)?.intent ?? resident.intent,
              receipt,session:resident.session,launch:resident.native.launch,
              observation:matchingOriginalRegistryLaunch(registry,resident.native.launch),runtimeLeaf:resident.runtimeLeaf,
              source:{record:resident.capture.facts.executionPlacement.materialization,workingTree:resident.capture.facts.executionPlacement.workingTree},
              ...(history?{history}:{}),...(resident.physicalClosure?{closure:{ownerClosed:true,launch:resident.physicalClosure}}:{}),
              ...(receipt.terminal?.result ? { output: remoteWorkflowPhysicalOutput(receipt.terminal.result,
                resident.placement.payload.kind === 'agent' ? resident.placement.payload.artifactOutputs : undefined,
                receipt.terminal.artifactValidationError) } : {})})
            const assertOwnerCurrent = async () => {
              current(context.binding)
              await workerExecutionAuthorizer(forBinding(context.binding))(resident.intent,resident.placement,receipt.stopFence?'stop':'read')
              const logged = await(await journal()).status(resident.intent.operationId)
              if(logged.status!=='known'||!isDeepStrictEqual(logged.receipt.intent,resident.intent)
                ||logged.receipt.native?.sessionId!==resident.session?.nativeSessionId
                ||logged.receipt.native?.processIdentityDigest!==resident.native?.native.processIdentityDigest)unavailable('original_physical_owner_changed')
              current(context.binding)
            }
            physical.remember({readout,placement:frame.placement,source,leaseExpiresAt:observationExpiresAt,assertOwnerCurrent,
              assertCurrent:async()=>{
                const approvedRoots=ApprovedRootAllowlistSchema.parse(cleanupOnly || receipt.stopFence
                  ? resident.runtimeRoots : await input.approvedRoots())
                await assertOriginalPhysicalDirectories({source:readout.source,runtimeLeaf:readout.runtimeLeaf,placement:resident.placement,approvedRoots,signal,
                  assertCurrent:()=>current(context.binding),authorize:assertOwnerCurrent})
                if(!cleanupOnly&&!receipt.stopFence&&!isDeepStrictEqual(approvedRoots,ApprovedRootAllowlistSchema.parse(await input.approvedRoots())))unavailable('original_physical_root_policy_changed')
                current(context.binding)},
              observe:()=>matchingOriginalRegistryLaunch(registry,resident.native!.launch),
              closure:()=>resident.physicalClosure??null,
              waitForSettlement: signal => host.waitForSettlement(frame.intent.operationId, signal) })
          }
        }
        return {payload:response}
      })().then(reply => {
        current(context.binding)
        const paged = responsePages.page(reply.payload, frame, context.binding)
        if (paged !== undefined && Buffer.byteLength(JSON.stringify(paged)) > DEVICE_APPLICATION_JSON_BYTES) {
          unavailable('workflow_response_too_large')
        }
        return { ...reply, payload: paged }
      })
      active.add(task);void task.then(()=>active.delete(task),()=>active.delete(task))
      return task
    }},
    { ...EXECUTION_AUTHORITY_EXTENSION, role: 'client' },
    { ...WORKER_MCP_EXTENSION, role: 'client' },
  ]
  const nativeOwnerFor=async(record:SourceMaterializationRecord):Promise<SourceInstalledNativeOwner|null>=>{
    const owned=operations.get(record.receipt.executionId)
    if(!owned?.native||!owned.session||!owned.nativeSignal||!owned.applicationAccess||owned.launchDisabled||owned.nativeSignal.aborted
      ||record.receipt.attemptId!==owned.intent.attemptId||record.operationId!==owned.intent.operationId
      ||record.receipt.materializationId!==owned.capture.facts.executionPlacement.materialization.receipt.materializationId
      ||record.finalDispatchBindingHash!==owned.capture.facts.executionPlacement.bindingHash
      ||sourceMaterializationDigest(record)!==sourceMaterializationDigest(owned.capture.facts.executionPlacement.materialization))return null
    const native=owned.native,session=owned.session,nativeSignal=AbortSignal.any([signal,owned.nativeSignal])
    const request: ReturnType<typeof forBinding> = (namespace,payload,options)=>
      forBinding(owned.context.binding)(namespace,payload,options)
    const authorize=workerExecutionAuthorizer(request)
    const assertCurrent=async()=>{
      nativeSignal.throwIfAborted();current(owned.context.binding)
      if(operations.get(owned.intent.executionId)!==owned||owned.launchDisabled)unavailable('original_source_native_owner_closed')
      const observed=matchingOriginalRegistryLaunch(registry,native.launch)
      if(observed.lifecycle!=='active')unavailable('original_source_native_owner_changed')
      await authorize(owned.intent,owned.placement,'read')
      await prepareWorkerApplicationAccess({request},owned.intent,owned.placement,owned.applicationAccess!,nativeSignal)
      const logged=await(await journal()).status(owned.intent.operationId)
      if(logged.status!=='known'||logged.receipt.terminal||logged.receipt.native?.sessionId!==session.nativeSessionId
        ||logged.receipt.native.processIdentityDigest!==native.native.processIdentityDigest)unavailable('original_source_native_owner_changed')
      nativeSignal.throwIfAborted();current(owned.context.binding)
    }
    await assertCurrent()
    return {executionId:owned.intent.executionId,runId:owned.intent.runId,technicalAttempt:owned.intent.technicalAttempt,
      attemptId:owned.intent.attemptId,operationId:owned.intent.operationId,
      materializationId:record.receipt.materializationId,sourceBindingHash:record.sourceBindingHash,finalDispatchBindingHash:owned.capture.facts.executionPlacement.bindingHash,
      session:structuredClone(session),owner:structuredClone(owned.intent.owner),signal:nativeSignal,assertCurrent}
  }
  const close=()=>shutdown??=(async()=>{
    closing=true;lifetime.abort(new Error('Installed workflow host is closing.'))
    for (const resident of operations.values()) if (resident.reviewTimer) clearTimeout(resident.reviewTimer)
    physical.clear()
    responsePages.clear()
    const results=await Promise.allSettled([...hosts.values()].map(host=>host.shutdown()))
    await Promise.allSettled([...active])
    const failures:unknown[]=results.flatMap(result=>result.status==='rejected'?[result.reason]:[])
    for(const owned of operations.values()) {
      try {
        if(owned.scope.launchId) {
          await registry.abandonReservedLaunch(owned.scope)
          if(!await registry.closeOwner(owned.scope.owner))unavailable('native_owner_closure_unconfirmed')
        }
        await owned.mcp?.close()
      } catch(error){failures.push(error)}
    }
    if(failures.length)throw new AggregateError(failures,'Original installed workflow cleanup remains unconfirmed; the journal owner is retained.')
    if(journalOpening&&!input.journal)await(await journalOpening).close()
  })()
  const preparationClosed = async (owner: SourceOperationOwner): Promise<boolean> => {
    if (owner.preparationKind !== 'workflow' || owner.preparationClosed !== true) return false
    // A failed fact lookup may still leave an owner that needs cleanup.
    const pending = construction.get(owner.attempt.executionId)
    if (pending) await Promise.allSettled([pending.task])
    const owned = operations.get(owner.attempt.executionId)
    const log = await journal()
    const status = await log.status(owner.identity.operationId)
    const processOwner = `execution:${owner.attempt.executionId}`
    const launches = () => registry.snapshot().launches.filter(launch => launch.owner === processOwner)
    if (status.status === 'unknown') {
      const entry = recovery.readEntry(owner.identity.operationId)
      if (!entry) return !owned && launches().length === 0
      if (entry.intent.executionId !== owner.attempt.executionId || entry.intent.attemptId !== owner.attempt.attemptId
        || owner.preparationNativeSession) return false
      if (owned) {
        owned.launchDisabled = true
        await owned.manager?.dispose?.()
        await registry.abandonReservedLaunch(owned.scope)
      }
      if (!await registry.closeOwner(entry.owner)) return false
      componentLogger('engine').warn({ executionId: owner.attempt.executionId }, 'Source preparation closed an unentered workflow owner')
      await owned?.mcp?.close()
      return true
    }
    let receipt = status.receipt
    if (receipt.intent.executionId === owner.attempt.executionId && receipt.intent.attemptId === owner.attempt.attemptId
      && receipt.entryAttempted && !receipt.native && !hasPositiveRemoteEntryClosure(receipt)) {
      if (owned) await closeResidentPreparation(owned, 'source_preparation_closed_before_entry')
      else await recovery.closePendingEntry(receipt, log, signal)
      const closed = await log.status(receipt.intent.operationId)
      if (closed.status !== 'known') return false
      receipt = closed.receipt
    }
    if (receipt.intent.executionId !== owner.attempt.executionId || receipt.intent.attemptId !== owner.attempt.attemptId
      || owner.preparationNativeSession && (!['codex', 'opencode'].includes(owner.preparationNativeSession.harness)
        || owner.preparationNativeSession.nativeSessionId !== receipt.native?.sessionId)
      || receipt.entryAttempted && !receipt.native && !hasPositiveRemoteEntryClosure(receipt)
      || owned?.native && !hasPositiveRemoteEntryClosure(receipt) && !isDeepStrictEqual(owned.native.native, receipt.native)
      || owned?.session && !hasPositiveRemoteEntryClosure(receipt)
        && owned.session.nativeSessionId !== receipt.native?.sessionId) return false
    if (await log.isRetired(receipt.intent.operationId)) {
      await releaseSettled(receipt.intent)
      return true
    }
    if (receipt.terminal?.kind === 'not_started') {
      await log.retireSettled(receipt.intent, receipt.sequence)
      await releaseSettled(receipt.intent)
      return true
    }
    if (owned) owned.launchDisabled = true
    await log.revokeFence(owner.identity.operationId)
    if (owned?.manager) {
      if (!owned.manager.dispose) return false
      await owned.manager.dispose()
    }
    if ((receipt.native || launches().length) && !await registry.closeOwner(processOwner)) return false
    componentLogger('engine').warn({ executionId: owner.attempt.executionId, terminal: Boolean(receipt.terminal) },
      'Source preparation closed a workflow owner')
    await owned?.mcp?.close()
    const terminal = receipt.terminal ? receipt : await log.terminal(owner.identity.operationId, {
      kind: receipt.native ? 'cancelled' : 'not_started',
      closureEvidenceDigest: receipt.native ? digest({ intent: receipt.intent, preparationClosed: true, launches: launches() })
        : remoteNonEntryClosureDigest(receipt.intent),
    })
    await log.retireSettled(terminal.intent, terminal.sequence)
    await releaseSettled(terminal.intent)
    return true
  }
  const reservationClosed = async (operationId: string): Promise<boolean> => {
    if ([...operations.values()].some(owned => owned.intent.operationId === operationId)) return false
    if ([...construction.values()].some(pending => pending.intent.operationId === operationId)) return false
    const status = await (await journal()).status(operationId)
    if (status.status === 'unknown') return !recovery.readEntry(operationId)
    const receipt = status.receipt
    return Boolean(receipt.terminal && (receipt.terminal.kind === 'not_started' || hasPositiveRemoteEntryClosure(receipt))
      && !registry.snapshot().launches.some(launch => launch.owner === `execution:${receipt.intent.executionId}`
        && launch.lifecycle !== 'closed'))
  }
  const drainForUpdate = async () => {
    await Promise.allSettled([...active])
    await Promise.all([...hosts.values()].map(host => host.drain()))
  }
  return {kind:'configured' as const,extensions,nativeOwnerFor,preparationClosed,reservationClosed,close,drainForUpdate}
}
