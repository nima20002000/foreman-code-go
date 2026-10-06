import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ExecutionResultSchema, type HarnessExecutionRequest, type NativeSessionReference } from '@foreman-code/contracts'
import { randomUUID } from 'node:crypto'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import { DeviceConnectionIdentitySchema, WorkerPairingConfigurationSchema, type WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { DispatchIntent, AcceptedNodePlacement, NativeExecutionPlacement } from '@foreman-code/contracts/node-placement'
import { RemoteNativeIdentitySchema, RemoteTerminalEvidenceSchema, RemoteOperationReceiptSchema, type RemoteNativeIdentity, type RemoteTerminalEvidence, type RemoteApplicationAccess } from '@foreman-code/contracts/remote-execution'
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
import { CodexAppServerSessionManager } from '../../harnesses/codexAppServer.js'
import { inspectInstalledCodex } from '../../harnesses/installedCodexInspection.js'
import { createInstalledCodexQualificationReader } from '../../harnesses/installedCodexQualification.js'
import { createInstalledCodexDependencies } from '../../harnesses/installedCodexDependencies.js'
import { normalizeHarnessVersion } from '../../harnesses/qualification/profiles.js'
import { NativeProcessRegistry, type NativeLaunchObservation, type NativeProcessRecovery } from '../../harnesses/recovery/processRegistry.js'
import { bootIdentity } from '../../harnesses/recovery/linuxIdentity.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../interactions/runtimePorts.js'
import { workerExecutionAuthorizer, workerExecutionFactsReader } from '../../placement/executionAuthorityClient.js'
import { sourceMaterializationDigest } from '../../sources/bindingHash.js'
import { readNativeExecutionBinding } from '../../placement/executionBinding.js'
import { anchored, identity, openPrivateRoot, openChildDirectory } from '../../sources/privateFilesystem.js'
import type { SourceOperationWorkerService, SourceOperationWorkerContext } from '../../sources/operationWorker.js'
import type { SourceInstalledNativeOwner } from '../../sources/executionHosts.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteExecutionHost } from './executionHost.js'
import { createRemoteExecutionHandler } from './executionRouter.js'
import { RemoteJobExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-job-execution'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { DeviceExtensionRegistration, DeviceExtensionContext, DeviceApplicationRequestOptions } from '../../devices/deviceApplicationChannel.js'
import { prepareWorkerApplicationAccess } from './workerApplicationAccess.js'
import { createWorkerMcpEndpoint } from './workerMcpEndpoint.js'
import { readInstalledWorkflowConfiguration, type InstalledWorkflowConfigurationLocation } from './installedWorkflowConfiguration.js'
import { RuntimeLeafAttestationSchema, assertRuntimeLeafPath, type RuntimeLeafAttestation } from './runtimeLeaf.js'
import { InstalledWorkflowPhysicalReadouts, matchingOriginalRegistryLaunch,assertOriginalPhysicalDirectories } from './workflowPhysicalReadout.js'
import { createInstalledNativeOutputs, type InstalledNativeOutputProviders } from './installedNativeOutput.js'
import type { CodexNativeOutputTurnPin } from '../../harnesses/codexNativeOutput.js'
import type { WorkflowOriginalNativeSource } from '../../interactions/workflowNativeCapture.js'
import { createInstalledWorkflowNativeOutputProviders } from './installedWorkflowNativeOutputs.js'
import { AgentFilePublishInputSchema, AgentFilePublishResultSchema,
  type AgentFilePublishInput, type AgentFilePublishResult } from '@foreman-code/contracts/files'
import { workflowArtifactDigestsByOutputKey, type WorkflowArtifactOutputsV1 } from '@foreman-code/contracts/workflow-artifact-result'

function unavailable(reason:string):never {throw new DomainError('WORKER_WORKFLOW_UNAVAILABLE','The original installed workflow authority is unavailable.',409,{reason})}
const digest=(value:unknown)=>commandInputHash(value).slice('sha256:'.length)
export interface InstalledWorkflowNativeOwner {
  readonly native:RemoteNativeIdentity
  readonly launch:NativeLaunchObservation
  readonly owner:string
}
/** The manager's exact execution owner supplies this single actual guardian/provider pair. Names, PID absence and another launch are never used. */
export function captureInstalledWorkflowNativeOwner(registry:NativeProcessRegistry,connection:DeviceConnectionIdentity,
  intent:DispatchIntent,session:NativeSessionReference):InstalledWorkflowNativeOwner {
  if(session.harness!=='codex'||intent.mainId!==connection.mainId)unavailable('native_binding_conflict')
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
  publications?:ReadonlyMap<string,AgentFilePublishResult['value']>}):Promise<RemoteTerminalEvidence|null> {
  const status=await input.journal.status(input.intent.operationId)
  if(status.status!=='known'||!isDeepStrictEqual(status.receipt.intent,input.intent)||!status.receipt.native
    ||status.receipt.native.sessionId!==input.session.nativeSessionId||input.captured.native.sessionId!==input.session.nativeSessionId
    ||status.receipt.native.processIdentityDigest!==input.captured.native.processIdentityDigest
    ||input.captured.owner!==`execution:${input.intent.executionId}`)unavailable('native_closure_binding_conflict')
  if(status.receipt.terminal)return status.receipt.terminal
  const terminal=input.history.terminalTurn
  if(terminal&&(terminal.correlationId!==status.receipt.turnInput?.correlationId
    ||terminal.providerId!==status.receipt.native.turnId
    ||input.history.nativeTurnId!==undefined&&input.history.nativeTurnId!==status.receipt.native.turnId))unavailable('native_result_correlation_conflict')
  if(!terminal&&!status.receipt.stopFence)return null
  const result=terminal?ExecutionResultSchema.parse(terminal.result):undefined
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
  manager?:CodexAppServerSessionManager
  launchDisabled?:true
  native?:InstalledWorkflowNativeOwner
  session?:NativeSessionReference
  nativeSignal?:AbortSignal
  nativeStart?:NativeSessionStart
  applicationAccess?:RemoteApplicationAccess
  publications: Map<string, AgentFilePublishResult['value']>
  mcp?:Awaited<ReturnType<typeof createWorkerMcpEndpoint>>
  leaseExpiresAt?:string
  runtimeLeaf?:RuntimeLeafAttestation
  retainedHistory?:NativeHistory
  physicalClosure?:NativeLaunchObservation
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
  const operations=new Map<string,InstalledOperation>(),hosts=new Map<string,RemoteExecutionHost>()
  const physical=new InstalledWorkflowPhysicalReadouts()
  const active=new Set<Promise<unknown>>()
  let journalOpening:Promise<RemoteOperationJournal>|undefined,closing=false,shutdown:Promise<void>|undefined
  const journal=()=>journalOpening??=input.journal?input.journal():RemoteOperationJournal.open(join(input.stateDirectory,'workflow-operations.json'),
    input.initializeNewInstallation?{initializeNewInstallation:true}:{})
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
  const constructOwned=async(context:DeviceExtensionContext,intent:DispatchIntent,placement:AcceptedNodePlacement)=>{
    current(context.binding)
    const request=forBinding(context.binding),authorize=workerExecutionAuthorizer(request),readFacts=workerExecutionFactsReader(request)
    let owned=operations.get(intent.executionId)
    if(owned) {
      if(!isDeepStrictEqual(owned.context.binding,context.binding)||!isDeepStrictEqual(owned.intent,intent)
        ||!isDeepStrictEqual(owned.placement,placement))unavailable('original_operation_generation_changed')
    } else {
      if(operations.size>=1000)unavailable('operation_retention_full')
      const reader=createInstalledCodexQualificationReader({intent,placement,signal,
        trustedCurrentBinding:()=>input.currentBinding()??null,
        inspect:(binding,effectSignal)=>inspectInstalledCodex({binding,configuration:input.configuration,
          environment:process.env,cwd:input.stateDirectory,signal:effectSignal}),
        readFacts:()=>readFacts(intent,placement),suiteRevision:input.codexSuiteRevision})
      const capture=await reader.capture()
      current(context.binding)
      owned={intent:structuredClone(intent),placement:structuredClone(placement),context,reader,capture,
        scope:registry.scope(`execution:${intent.executionId}`),publications:new Map()}
      operations.set(intent.executionId,owned)
    }
    const generation=commandInputHash(context.binding)
    let host=hosts.get(generation)
    if(!host) {
      const log=await journal();current(context.binding)
      const managers=new ExecutionScopedNativeSessionManagerResolver(configurationContext=>{
        const resident=operations.get(configurationContext.executionId)
        if(!resident||configurationContext.harness!=='codex'||!isDeepStrictEqual(configurationContext.configuration,resident.capture.facts.configuration)
          ||configurationContext.workingDirectory!==resident.capture.facts.executionPlacement.workingTree.canonicalCwd)unavailable('accepted_configuration_conflict')
        const actual=resident!,binary=actual.capture.inspection.currentTarget?.installation.launcher.resolvedLauncher
        if(!binary)unavailable('installed_launcher_unavailable')
        Object.assign(actual.scope,registry.reserveLaunch(actual.scope.owner))
        const instances=new HarnessInstanceRegistry(localHarnessDrivers.filter(driver=>driver.driverId==='codex'))
        const override=actual.capture.facts.harness.override,installation=actual.capture.facts.harness.installation
        instances.reload([{instanceId:override.instanceId,instanceRevision:override.instanceRevision,driverId:override.driverId,enabled:override.enabled,configuration:override.configuration}])
        const payloadFingerprints=installation.launcher.payloadFingerprints
        if(!payloadFingerprints?.length)unavailable('launcher_payload_evidence_missing')
        const installations=new HarnessInstallationRegistry(instances);installations.refresh([{...installation,launcher:{...installation.launcher,payloadFingerprints}}])
        const selection=installations.pin({instanceId:override.instanceId,hostRef:override.target.hostRef,
          harnessInstallationId:override.target.harnessInstallationId,connectionGeneration:installation.connectionGeneration,environmentGeneration:installation.environmentGeneration})
        const dependencies=createInstalledCodexDependencies({reader:actual.reader,codexSuiteRevision:input.codexSuiteRevision})
        const before=async()=>{if(actual.launchDisabled||closing)unavailable('original_native_owner_closed');await authorize(actual.intent,actual.placement,'start');installations.assertCurrent(selection)}
        const outputContext: InstalledWorkflowNativeOutputContext = {
          intent: structuredClone(actual.intent), placement: structuredClone(actual.placement),
          binding: Object.freeze(structuredClone(actual.context.binding)),
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
            await before(); effectSignal?.throwIfAborted(); current(actual.context.binding)
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
          qualify:async(binary,cwd,environment,authenticated,effectSignal)=>{
            await before()
            const result=await dependencies.qualify(binary,cwd,environment,authenticated,effectSignal,actual.scope)
            if(normalizeHarnessVersion('codex',result.providerVersion)!==actual.capture.qualification.version)unavailable('native_version_changed')
            return result
          },
          assertUnchanged:async value=>{await before();await dependencies.assertUnchanged(value)},
          runCommand:async(binary,args,cwd,effectSignal,environment,options)=>{await before();return dependencies.runCommand(binary,args,cwd,effectSignal,environment,{...options,recovery:actual.scope})},
          qualifyModel:async(configuration,binary,cwd,environment,effectSignal)=>{await before();return dependencies.qualifyModel(configuration,binary,cwd,environment,effectSignal,actual.scope)},
        },{workingDirectory:configurationContext.workingDirectory},nativeOutputs)
        actual.manager=manager
        return manager
      })
      host=new RemoteExecutionHost({journal:log,connection:DeviceConnectionIdentitySchema.parse({mainId:context.binding.mainId,deviceId:context.binding.deviceId,
        workerInstallationId:context.binding.workerInstallationId,keyRevision:context.binding.keyRevision,authorizationRevision:context.binding.authorizationRevision,
        bootId:context.binding.bootId,connectionGeneration:context.binding.connectionGeneration}),incarnationId:randomUUID(),managers,
        authorize:async(intent,placement,action)=>{current(context.binding);await authorize(intent,placement,action)
          if(action==='start')operation(intent).capture=await operation(intent).reader.capture()},
        attestRuntimeLeaf:async(intent,placement,request,executionPlacement)=>{
          const resident=operation(intent),capture=await resident.reader.capture()
          if(!executionPlacement||executionPlacement.bindingHash!==capture.facts.executionPlacement.bindingHash
            ||!isDeepStrictEqual(request.configuration,capture.facts.configuration))unavailable('actual_native_placement_required')
          resident.capture=capture
          const runtimeLeaf=await attestInstalledWorkflowRuntimeLeaf({sources:input.sources,context:{...context,signal},approvedRoots:await input.approvedRoots(),
            nativePlacement:capture.facts.executionPlacement,intent,placement,request})
          resident.runtimeLeaf=runtimeLeaf
          return runtimeLeaf
        },
        preflight:async(nativeRequest,access)=>{
          const resident=operations.get(nativeRequest.executionId)
          if(!resident||!access)unavailable('original_main_lease_required')
          const actual=resident!
          await authorize(actual.intent,actual.placement,'start');actual.capture=await actual.reader.capture()
          if(!isDeepStrictEqual(nativeRequest.configuration,actual.capture.facts.configuration))unavailable('accepted_configuration_conflict')
          const relay=await prepareWorkerApplicationAccess({request},actual.intent,actual.placement,access,signal)
          actual.applicationAccess=structuredClone(access)
          actual.leaseExpiresAt=relay.expiresAt
          const nativeStart:NativeSessionStart={request:structuredClone(nativeRequest),correlationId:`execution:${actual.intent.executionId}`,environment:relay.environment}
          if(actual.nativeStart&&!isDeepStrictEqual(actual.nativeStart,nativeStart))unavailable('original_native_start_changed')
          actual.nativeStart??=nativeStart
          if(!actual.mcp)actual.mcp=await createWorkerMcpEndpoint({relay,launcher:configuration.appMcpLauncher,signal})
          return relay.environment
        },
        nativeEvidence:async(intent,session,nativeContext)=>{const resident=operation(intent)
          if(!resident.manager||!nativeContext||nativeContext.manager!==resident.manager
            ||nativeContext.request.executionId!==intent.executionId)unavailable('native_manager_not_allocated')
          resident.session=structuredClone(session);resident.nativeSignal=nativeContext.signal
          resident.native=captureInstalledWorkflowNativeOwner(registry,DeviceConnectionIdentitySchema.parse({mainId:context.binding.mainId,deviceId:context.binding.deviceId,
            workerInstallationId:context.binding.workerInstallationId,bootId:context.binding.bootId,keyRevision:context.binding.keyRevision,
            authorizationRevision:context.binding.authorizationRevision,connectionGeneration:context.binding.connectionGeneration}),intent,session)
          if(!resident.nativeStart)unavailable('original_native_start_missing')
          const captured=resident.native
          const lifetime=captureOriginalCodexSession(resident.manager,session,resident.nativeStart!,()=>{
            nativeContext.signal.throwIfAborted();current(context.binding)
            if(operations.get(intent.executionId)!==resident||resident.launchDisabled)unavailable('original_native_owner_closed')
            const observed=matchingOriginalRegistryLaunch(registry,captured.launch)
            if(observed.lifecycle!=='active'||!isDeepStrictEqual(observed.guardian,captured.launch.guardian)
              ||!isDeepStrictEqual(observed.provider,captured.launch.provider)||!isDeepStrictEqual(observed.boundary,captured.launch.boundary))unavailable('original_native_process_changed')
          })
          if(!lifetime)unavailable('original_native_residency_unavailable')
          lifetime!.assertCurrent()
          return resident.native.native
        },
        settle:async(intent,history,owner)=>{
          const resident=operation(intent)
          if(!resident.native||resident.manager!==owner.manager)unavailable('original_native_owner_required')
          resident.retainedHistory=structuredClone(history)
          const state=await log.status(intent.operationId)
          const declaration = resident.placement.payload.kind === 'agent' ? resident.placement.payload.artifactOutputs : undefined
          if(state.status==='known'&&(state.receipt.stopFence||history.terminalTurn!==undefined&&history.terminalTurn.correlationId===state.receipt.turnInput?.correlationId
            &&history.terminalTurn.providerId===state.receipt.native?.turnId))resident.launchDisabled=true
          const terminal=await settleInstalledWorkflowNativeOwner({journal:log,registry,intent,history,captured:resident.native,
            manager:owner.manager,session:owner.session,publications:resident.publications,
            ...(declaration ? { artifactOutputs: declaration } : {})})
          if(terminal) {
            const observation=matchingOriginalRegistryLaunch(registry,resident.native.launch)
            if(observation.lifecycle!=='closed'||observation.closureEvidence!=='cgroup_v2_empty')unavailable('original_physical_closure_missing')
            resident.physicalClosure=observation
            await resident.mcp?.close()
          }
          return terminal
        },
      })
      hosts.set(generation,host)
    }
    return host
  }
  let construction:Promise<unknown>=Promise.resolve()
  const construct=(context:DeviceExtensionContext,intent:DispatchIntent,placement:AcceptedNodePlacement)=>{
    const next=construction.then(()=>constructOwned(context,intent,placement))
    construction=next.then(()=>undefined,()=>undefined)
    return next
  }
  const extensions:DeviceExtensionRegistration[]=[{namespace:'execution-v1',version:1,role:'duplex',maxJsonBytes:1024*1024,maxBinaryBytes:0,
    async handle(payload,context) {
      if(context.bytes!==undefined)unavailable('workflow_binary_payload_refused')
      const task=(async()=>{
        if(RemoteJobExecutionRpcRequestSchema.safeParse(payload).success)throw new DomainError('JOB_RUNTIME_UNAVAILABLE','The installed Codex workflow host has no Job runtime.',409)
        const frame=RemoteExecutionRpcRequestSchema.parse(payload)
        const host=await construct(context,frame.intent,frame.placement)
        context.signal.throwIfAborted()
        if(frame.method==='physical-readout')return {payload:await physical.read(frame)}
        if(frame.method==='physical-ack')return {payload:await physical.ack(frame)}
        const response=await createRemoteExecutionHandler(host)(frame)
        const value=response&&typeof response==='object'?response as {session?:NativeSessionReference;history?:NativeHistory;status?:unknown}:undefined
        const status=value?.status&&typeof value.status==='object'?value.status as {status?:string;receipt?:unknown}:response as {status?:string;receipt?:unknown}
        if(status?.status==='known') {
          const receipt=RemoteOperationReceiptSchema.parse(status.receipt),resident=operation(frame.intent)
          if(receipt.native&&resident.native&&resident.session&&resident.runtimeLeaf&&resident.leaseExpiresAt) {
            const source:WorkflowOriginalNativeSource=value?.session?{type:'session_created',session:value.session}
              :value?.history?{type:'history',history:value.history}:{type:'boundary'}
            const history=value?.history??resident.retainedHistory
            const readout=RemoteWorkflowPhysicalReadoutSchema.parse({version:1,expiresAt:new Date(Math.min(Date.parse(resident.leaseExpiresAt),Date.now()+60_000)).toISOString(),
              receipt,session:resident.session,launch:resident.native.launch,
              observation:matchingOriginalRegistryLaunch(registry,resident.native.launch),runtimeLeaf:resident.runtimeLeaf,
              source:{record:resident.capture.facts.executionPlacement.materialization,workingTree:resident.capture.facts.executionPlacement.workingTree},
              ...(history?{history}:{}),...(resident.physicalClosure?{closure:{ownerClosed:true,launch:resident.physicalClosure}}:{}),
              ...(receipt.terminal?.result ? { output: remoteWorkflowPhysicalOutput(receipt.terminal.result,
                resident.placement.payload.kind === 'agent' ? resident.placement.payload.artifactOutputs : undefined,
                receipt.terminal.artifactValidationError) } : {})})
            const assertOwnerCurrent = async () => {
              current(context.binding)
              await workerExecutionAuthorizer(forBinding(context.binding))(resident.intent,resident.placement,'read')
              const logged = await(await journal()).status(resident.intent.operationId)
              if(logged.status!=='known'||!isDeepStrictEqual(logged.receipt.intent,resident.intent)
                ||logged.receipt.native?.sessionId!==resident.session?.nativeSessionId
                ||logged.receipt.native?.processIdentityDigest!==resident.native?.native.processIdentityDigest)unavailable('original_physical_owner_changed')
              current(context.binding)
            }
            physical.remember({readout,placement:frame.placement,source,leaseExpiresAt:resident.leaseExpiresAt,assertOwnerCurrent,
              assertCurrent:async()=>{
                await assertOwnerCurrent()
                const approvedRoots=ApprovedRootAllowlistSchema.parse(await input.approvedRoots())
                await assertOriginalPhysicalDirectories({source:readout.source,runtimeLeaf:readout.runtimeLeaf,placement:resident.placement,approvedRoots,signal,
                  authorize:async()=>{current(context.binding);await workerExecutionAuthorizer(forBinding(context.binding))(resident.intent,resident.placement,'read');current(context.binding)}})
                if(!isDeepStrictEqual(approvedRoots,ApprovedRootAllowlistSchema.parse(await input.approvedRoots())))unavailable('original_physical_root_policy_changed')
                current(context.binding)},
              observe:()=>matchingOriginalRegistryLaunch(registry,resident.native!.launch),
              closure:()=>resident.physicalClosure??null})
          }
        }
        return {payload:response}
      })()
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
    const request=forBinding(owned.context.binding),authorize=workerExecutionAuthorizer(request)
    const assertCurrent=async()=>{
      nativeSignal.throwIfAborted();current(owned.context.binding)
      if(operations.get(owned.intent.executionId)!==owned||owned.launchDisabled)unavailable('original_source_native_owner_closed')
      const observed=captureInstalledWorkflowNativeOwner(registry,DeviceConnectionIdentitySchema.parse({mainId:owned.context.binding.mainId,deviceId:owned.context.binding.deviceId,
        workerInstallationId:owned.context.binding.workerInstallationId,keyRevision:owned.context.binding.keyRevision,authorizationRevision:owned.context.binding.authorizationRevision,
        bootId:owned.context.binding.bootId,connectionGeneration:owned.context.binding.connectionGeneration}),owned.intent,session)
      if(observed.launch.launchId!==native.launch.launchId||!isDeepStrictEqual(observed.native,native.native))unavailable('original_source_native_owner_changed')
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
    physical.clear()
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
    // Main has fenced future construction. Join any earlier fact lookup before checking its installed owner.
    await construction
    const owned = operations.get(owner.attempt.executionId)
    const log = await journal()
    const status = await log.status(owner.identity.operationId)
    const processOwner = `execution:${owner.attempt.executionId}`
    const launches = () => registry.snapshot().launches.filter(launch => launch.owner === processOwner)
    if (status.status === 'unknown') return !owned && launches().length === 0
    const receipt = status.receipt
    if (receipt.intent.executionId !== owner.attempt.executionId || receipt.intent.attemptId !== owner.attempt.attemptId
      || owner.preparationNativeSession && (owner.preparationNativeSession.harness !== 'codex'
        || owner.preparationNativeSession.nativeSessionId !== receipt.native?.sessionId)
      || receipt.entryAttempted && !receipt.native
      || owned?.native && !isDeepStrictEqual(owned.native.native, receipt.native)
      || owned?.session && owned.session.nativeSessionId !== receipt.native?.sessionId) return false
    if (receipt.terminal?.kind === 'not_started') return true
    if (owned) owned.launchDisabled = true
    await log.revokeFence(owner.identity.operationId)
    if (owned?.manager) {
      if (!owned.manager.dispose) return false
      await owned.manager.dispose()
    }
    if ((receipt.native || launches().length) && !await registry.closeOwner(processOwner)) return false
    await owned?.mcp?.close()
    if (receipt.terminal) return true
    await log.terminal(owner.identity.operationId, {
      kind: receipt.native ? 'cancelled' : 'not_started',
      closureEvidenceDigest: digest({ intent: receipt.intent, preparationClosed: true, launches: launches() }),
    })
    return true
  }
  return {kind:'configured' as const,extensions,nativeOwnerFor,preparationClosed,close}
}
