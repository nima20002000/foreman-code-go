import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile, access,rename } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, CODEX_APPROVAL_OPTIONS_FIXTURE, withAdvancedDefaults, type AgentConfigurationVersion, type NativeSessionReference } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { NativeHistory } from '../../harnesses/port.js'
import * as installedQualification from '../../harnesses/installedCodexQualification.js'
import * as workerMcpEndpoint from './workerMcpEndpoint.js'
import { ExecutionFactsRequestSchema, ExecutionFactsResultSchema, ExecutionAuthorityRequestSchema } from '@foreman-code/contracts/execution-authority'
import { DispatchIntentSchema } from '@foreman-code/contracts/node-placement'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { CodexAppServerSessionManager } from '../../harnesses/codexAppServer.js'
import * as installedInspection from '../../harnesses/installedCodexInspection.js'
import { harnessConnectionGeneration } from '../../harnesses/hostConnectionGeneration.js'
import * as workerMcpEndpoint from './workerMcpEndpoint.js'
import { NativeProcessRegistry, type NativeLaunchObservation } from '../../harnesses/recovery/processRegistry.js'
import { bootIdentity } from '../../harnesses/recovery/linuxIdentity.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { readInstalledWorkflowConfiguration } from './installedWorkflowConfiguration.js'
import { captureInstalledWorkflowNativeOwner, settleInstalledWorkflowNativeOwner, closeInstalledNativeOutputWriters,
  createInstalledWorkflowHost, attestInstalledWorkflowRuntimeLeaf, type InstalledWorkflowHostOptions } from './installedWorkflowHost.js'
import { SourceOperationWorkerService } from '../../sources/operationWorker.js'
import { PrivateSourceMaterializer } from '../../sources/materialization.js'
import { createSourceManifest, sourceSha256 } from '../../sources/manifest.js'
import { sourceBindingHash } from '../../sources/bindingHash.js'
import { identity, openPrivateRoot } from '../../sources/privateFilesystem.js'
import { verifyMaterializedWorkingDirectory } from '../../sources/workingDirectory.js'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import { bindNativeExecution } from '../../placement/executionBinding.js'
import type { SourceRootRecord, SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import type { SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import { DEVICE_APPLICATION_JSON_BYTES, negotiateDeviceExtensions } from '@foreman-code/contracts/device-application'
import { EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import { WORKER_MCP_EXTENSION } from '@foreman-code/contracts/worker-mcp-relay'
import type { HarnessExecution } from '@foreman-code/contracts'
import type pg from 'pg'
import { InstalledWorkflowPhysicalReadouts, matchingOriginalRegistryLaunch, remoteWorkflowSourceDigest,assertOriginalPhysicalDirectories } from './workflowPhysicalReadout.js'
import { createRemoteWorkflowPhysicalVerification, type RemoteWorkflowMainLifetime } from './workflowPhysicalVerification.js'
import { RemoteWorkflowPhysicalReadoutSchema } from '@foreman-code/contracts/remote-workflow-physical'
import { createRemoteNativeSourceChannel } from '../../placement/remoteNativeSource.js'
import { VerifiedRemoteEvidence } from './resultBridge.js'
import { ExclusiveGraphConnection } from '../../run-graph/connection.js'
import { repeatExecutionIdentity } from '../repeatResolution.js'
import { pageNativeHistory } from './nativeHistoryPage.js'

const roots:string[]=[],journals:RemoteOperationJournal[]=[]
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(journals.splice(0).map(journal=>journal.close()));await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function directory() {const root=await mkdtemp('/tmp/installed-workflow-');roots.push(root);return root}
function nativeFixture() {
  const connection=DeviceConnectionIdentitySchema.parse({mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),
    bootId:bootIdentity(),keyRevision:1,authorizationRevision:1,connectionGeneration:4})
  const intent=DispatchIntentSchema.parse({schemaVersion:1,protocolVersion:1,mainId:connection.mainId,runId:'run',nodeId:'node',executionId:'execution',
    occurrenceId:null,occurrenceIndex:0,technicalAttempt:1,attemptId:'attempt',operationId:'operation',bindingHash:'a'.repeat(64),inputDigest:`sha256:${'b'.repeat(64)}`,owner:{grantId:'grant',epoch:'1'}})
  const session:NativeSessionReference={harness:'codex',providerVersion:'codex-cli 0.154.0',nativeSessionId:'native-session'}
  // Provider/closure doubles test the exact consumer contract; no process or physical closure is produced here.
  const launch:NativeLaunchObservation={owner:'execution:execution',launchId:randomUUID(),bootId:connection.bootId,
    guardian:{pid:200,startTicks:'2000'},provider:{pid:201,startTicks:'2001'},boundary:{kind:'cgroup-v2',path:'/unit/boundary',device:'1',inode:'2'},lifecycle:'active'}
  const registry=new NativeProcessRegistry('/unit/registry'),snapshot=vi.spyOn(registry,'snapshot').mockReturnValue({revision:'snapshot:1',launches:[launch]})
  return {connection,intent,session,launch,registry,snapshot}
}
describe('protected workflow selection without invented qualification',()=>{
  it('has no default installed selection when no explicit configuration is supplied',async()=>{
    expect(await readInstalledWorkflowConfiguration(null)).toBeNull()
  })
  it('reads only executable selection and rejects manually supplied qualification/readiness flags',async()=>{
    const root=await directory(),path=join(root,'workflow.json'),selection={schemaVersion:1,codexBinary:'/installed/codex',appMcpLauncher:'/installed/launcher.mjs',expectedVersion:'codex-cli 0.132.0',payloadPaths:[]}
    const location={path,ownerUid:process.getuid!()}
    await writeFile(path,JSON.stringify(selection),{mode:0o600})
    expect(await readInstalledWorkflowConfiguration(location)).toEqual(selection)
    await writeFile(path,JSON.stringify({...selection,qualified:true}))
    await expect(readInstalledWorkflowConfiguration(location)).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
  })
  it('refuses symlinked and permissive configuration files',async()=>{
    const root=await directory(),path=join(root,'selection.json'),link=join(root,'redirect.json')
    await writeFile(path,JSON.stringify({schemaVersion:1,codexBinary:'/installed/codex',appMcpLauncher:'/installed/launcher.mjs',expectedVersion:'codex-cli 0.154.0',payloadPaths:[]}),{mode:0o600})
    await symlink(path,link)
    await expect(readInstalledWorkflowConfiguration({path:link,ownerUid:process.getuid!()})).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
    await chmod(path,0o644)
    await expect(readInstalledWorkflowConfiguration({path,ownerUid:process.getuid!()})).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
  })
})
describe('exact installed workflow native owner observations',()=>{
  it('binds the session to the unique actual execution guardian/provider generation',()=>{
    const f=nativeFixture(),first=captureInstalledWorkflowNativeOwner(f.registry,f.connection,f.intent,f.session)
    expect(first.native.sessionId).toBe(f.session.nativeSessionId)
    expect(first.launch).toEqual(f.launch)
    f.snapshot.mockReturnValue({revision:'snapshot:2',launches:[{...f.launch,provider:{pid:201,startTicks:'other-generation'}}]})
    expect(captureInstalledWorkflowNativeOwner(f.registry,f.connection,f.intent,f.session).native.processIdentityDigest).not.toBe(first.native.processIdentityDigest)
  })
  it.each(['missing','ambiguous','foreign-owner','foreign-boot','missing-provider','missing-containment'] as const)('does not invent native precision for %s evidence',kind=>{
    const f=nativeFixture()
    const broken={...f.launch}
    if(kind==='foreign-owner')broken.owner='execution:foreign'
    if(kind==='foreign-boot')broken.bootId=randomUUID()
    if(kind==='missing-provider')delete broken.provider
    if(kind==='missing-containment')delete broken.boundary
    const launches:NativeLaunchObservation[]=kind==='missing'?[]:kind==='ambiguous'?[f.launch,{...f.launch,launchId:randomUUID()}]:[broken]
    f.snapshot.mockReturnValue({revision:'snapshot:2',launches})
    expect(()=>captureInstalledWorkflowNativeOwner(f.registry,f.connection,f.intent,f.session)).toThrow('unavailable')
  })
})
async function closureFixture() {
  const f=nativeFixture(),root=await directory(),journal=await RemoteOperationJournal.open(join(root,'journal'),{initializeNewInstallation:true})
  journals.push(journal)
  const captured=captureInstalledWorkflowNativeOwner(f.registry,f.connection,f.intent,f.session)
  await journal.accept(f.intent,f.connection,randomUUID());await journal.reserveEntry(f.intent.operationId)
  await journal.acknowledgeStart(f.intent.operationId,captured.native)
  await journal.reserveTurn(f.intent.operationId,{correlationId:'execution:execution',promptDigest:'c'.repeat(64)})
  await journal.acknowledgeTurn(f.intent.operationId,'original-turn');await journal.markRunning(f.intent.operationId)
  const manager=new CodexAppServerSessionManager('/unused/unit/codex'),close=vi.spyOn(manager,'close').mockResolvedValue(undefined)
  const closeRegistration=vi.spyOn(f.registry,'closeRegistration').mockResolvedValue(undefined)
  const closeOwner=vi.spyOn(f.registry,'closeOwner').mockResolvedValue(false)
  const history={events:[],pendingInteractions:[],nativeTurnId:'original-turn',terminalTurn:{correlationId:'execution:execution',providerId:'original-turn',result:{outcome:'succeeded' as const}}}
  return {...f,journal,captured,manager,close,closeOwner,closeRegistration,history}
}
describe('positive installed native closure consumption',()=>{
  it.each(['intent', 'connection', 'session', 'turn', 'process'] as const)('refuses foreign %s output cleanup before closing a native owner', async kind => {
    const f = await closureFixture()
    const binding = { ...f.connection, connectionEpoch: randomUUID() }
    const owner = { intent: structuredClone(f.intent), binding: structuredClone(binding), session: { ...f.session },
      nativeTurnId: 'original-turn', runtimeGeneration: 1 }
    const captured = structuredClone(f.captured)
    if (kind === 'intent') owner.intent.executionId = 'foreign'
    if (kind === 'connection') owner.binding.connectionEpoch = randomUUID()
    if (kind === 'session') owner.session.nativeSessionId = 'foreign'
    if (kind === 'turn') owner.nativeTurnId = 'foreign'
    if (kind === 'process') captured.native.processIdentityDigest = 'f'.repeat(64)
    await expect(closeInstalledNativeOutputWriters({ ...f, binding, owner, captured })).rejects.toThrow()
    expect(f.closeRegistration).not.toHaveBeenCalled()
    expect(f.closeOwner).not.toHaveBeenCalled()
  })
  it('requires positive original physical closure before completing output cleanup', async () => {
    const f = await closureFixture()
    const binding = { ...f.connection, connectionEpoch: randomUUID() }
    const owner = { intent: f.intent, binding, session: f.session, nativeTurnId: 'original-turn', runtimeGeneration: 1 }
    await expect(closeInstalledNativeOutputWriters({ ...f, binding, owner })).rejects.toThrow()
    f.closeOwner.mockResolvedValue(true)
    const closed = { ...f.launch, lifecycle: 'closed' as const, closureEvidence: 'cgroup_v2_empty' as const }
    f.closeRegistration.mockImplementation(async () => { f.snapshot.mockReturnValue({ revision: 'closed', launches: [closed] }) })
    expect(await closeInstalledNativeOutputWriters({ ...f, binding, owner })).toEqual(closed)
    expect(f.closeOwner).toHaveBeenCalledWith('execution:execution')
  })
  it('does not promote provider success when the original physical owner closure is unconfirmed',async()=>{
    const f=await closureFixture()
    expect(await settleInstalledWorkflowNativeOwner(f)).toBeNull()
    expect(f.closeOwner).toHaveBeenCalledWith('execution:execution')
    expect((await f.journal.status(f.intent.operationId)).status).toBe('known')
  })
  it('records only the original provider result after positive owner closure, and reuses an accepted terminal',async()=>{
    const f=await closureFixture();f.closeOwner.mockResolvedValue(true)
    const terminal=await settleInstalledWorkflowNativeOwner(f)
    expect(terminal).toMatchObject({kind:'completed',result:{outcome:'succeeded'}})
    if(!terminal)throw new Error('Expected unit closure evidence')
    await f.journal.terminal(f.intent.operationId,terminal)
    expect(await settleInstalledWorkflowNativeOwner(f)).toEqual(terminal)
    expect(f.close).toHaveBeenCalledOnce();expect(f.closeOwner).toHaveBeenCalledOnce()
  })
  it('refuses another turn result before any native closure mutation',async()=>{
    const f=await closureFixture();f.history.terminalTurn.providerId='foreign-turn'
    await expect(settleInstalledWorkflowNativeOwner(f)).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
    expect(f.close).not.toHaveBeenCalled();expect(f.closeOwner).not.toHaveBeenCalled()
  })
  it('does not infer a result or close an active execution from an empty native history',async()=>{
    const f=await closureFixture()
    expect(await settleInstalledWorkflowNativeOwner({...f,history:{events:[],pendingInteractions:[]}})).toBeNull()
    expect(f.close).not.toHaveBeenCalled();expect(f.closeOwner).not.toHaveBeenCalled()
  })
})

async function sourceFixture(relativeCwd='') {
  const root=await directory(),runtime=join(root,'runtime'),project=join(root,'project'),namespace=join(runtime,'source-materializations',randomUUID())
  await mkdir(runtime,{mode:0o700});await mkdir(project,{mode:0o700});await mkdir(namespace,{recursive:true,mode:0o700})
  if(relativeCwd)await mkdir(join(project,relativeCwd),{recursive:true,mode:0o700})
  const fsIdentity=async(path:string)=>{const handle=await openPrivateRoot(path);try{return await identity(handle)}finally{await handle.close()}}
  const binding:DeviceSessionBinding={mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),bootId:bootIdentity(),
    keyRevision:1,authorizationRevision:1,connectionEpoch:randomUUID(),connectionGeneration:3}
  const approvedRoots:ApprovedRootAllowlist={schemaVersion:1,hostRef:{kind:'device',mainId:binding.mainId,deviceId:binding.deviceId},
    applicationInstallationId:binding.workerInstallationId,configurationRevision:'1',bases:[{baseId:randomUUID(),canonicalPath:project,filesystem:await fsIdentity(project),accessModes:['read-only']}],
    managedRuntimeRoot:runtime,runtimeFilesystem:await fsIdentity(runtime)}
  const bytes=Buffer.from('export const fixture = true\n'),manifest=createSourceManifest({version:1,snapshotId:randomUUID(),approvedSourceId:randomUUID(),
    capturePolicy:'exclusive-explicit-bytes-v1',executablePolicy:'strip',deletions:[],entries:[{path:relativeCwd?`${relativeCwd}/source.ts`:'source.ts',kind:'file',byteSize:bytes.length,sha256:sourceSha256(bytes),executable:false}]})
  const source={approvedSourceId:manifest.approvedSourceId,snapshotId:manifest.snapshotId,manifestDigest:manifest.manifestDigest},rootPolicyId=namespace.split('/').at(-1)!
  const sourceRoot:SourceRootRecord={version:1,source,selection:{hostRef:approvedRoots.hostRef,rootPolicyId,rootPolicyRevision:'1',locationRevision:'1'},
    binding:{version:1,mainId:binding.mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,workspaceId:'workspace',rootId:randomUUID(),bindingRevision:1,
      locationRevision:1,canonicalPath:namespace,filesystem:await fsIdentity(namespace),accessMode:'exclusive-write',snapshotId:manifest.snapshotId,manifestDigest:manifest.manifestDigest},
    ownerPrincipalId:'owner',authorizedByPrincipalId:'owner',registration:{workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1},
    attestationId:'attestation',attestationDigest:'a'.repeat(64),boundAt:new Date().toISOString()}
  const placement=freezePlacement({schemaVersion:1,mainId:binding.mainId,mainInstallationId:binding.mainId,runId:'run',nodeId:'node',hostRef:approvedRoots.hostRef,registration:sourceRoot.registration,
    destination:{canonicalProjectRoot:project,canonicalCwd:join(project,relativeCwd),managedRuntimeRoot:runtime,directoryIdentityHash:'a'.repeat(64),rootPolicyId,rootPolicyRevision:'1',locationRevision:'1',attestationId:'attestation',attestationHash:'a'.repeat(64)},
    source:{kind:'pending',...source,revisionId:'revision',rootId:sourceRoot.binding.rootId,bindingRevision:1,materializationId:null,materializationDigest:null},
    payload:{kind:'agent',agentId:'agent',agentConfigurationVersionId:'configuration',driverId:'codex',driverRevision:'1',instanceId:randomUUID(),instanceRevision:'1',harnessInstallationId:'installed-codex',installationFingerprint:'a'.repeat(64),runtimeContractVersion:1,protocolRevision:'codex-native-adapter-v1',credentialScopeRefs:[]}})
  const intent=deriveDispatch(placement,{executionId:'execution',attemptId:'attempt',operationId:'operation',technicalAttempt:1,occurrenceId:null,occurrenceIndex:0,inputDigest:`sha256:${'b'.repeat(64)}`,owner:{grantId:'grant',epoch:'1'}})
  const attempt={executionId:intent.executionId,attemptId:intent.attemptId,keyRevision:1,authorizationRevision:1,placementHash:''}
  attempt.placementHash=sourceBindingHash(sourceRoot,attempt,intent.operationId)
  const receipt=await new PrivateSourceMaterializer({read:async()=>bytes},async()=>undefined).prepare({manifest,binding:sourceRoot.binding,attempt,signal:new AbortController().signal})
  const record:SourceMaterializationRecord={receipt,rootPolicyId,rootPolicyRevision:'1',operationId:intent.operationId,reservationId:randomUUID(),sourceBindingHash:attempt.placementHash,finalDispatchBindingHash:null,state:'prepared'}
  const workingTree=await verifyMaterializedWorkingDirectory(record,relativeCwd,async()=>undefined)
  const nativePlacement=bindNativeExecution(placement,intent,record,workingTree)
  nativePlacement.materialization.finalDispatchBindingHash=nativePlacement.bindingHash
  const owner:SourceOperationOwner={identity:{operationId:intent.operationId,ownerPrincipalId:'owner',expiresAt:'2099-01-01T00:00:00.000Z'},root:sourceRoot,attempt,source,record:nativePlacement.materialization,physicalClosureConfirmed:false}
  const sources=new SourceOperationWorkerService({authenticate:async()=>undefined,approvedRoots:async()=>approvedRoots,currentOwner:async()=>owner,
    transfers:{resolveVerifiedReceipt:vi.fn().mockRejectedValue(new Error('Verify-only fixture')),openVerified:vi.fn().mockRejectedValue(new Error('Verify-only fixture'))},transferContext:vi.fn().mockRejectedValue(new Error('Verify-only fixture'))})
  const configuration:AgentConfigurationVersion={id:'configuration',agentId:'agent',workspaceId:'workspace',version:1,prompt:{system:'Unit workflow instructions.'},assignedSkills:[],harness:DEFAULT_HARNESS_DEFAULTS.codex,contentHash:'fixture',createdAt:new Date().toISOString()}
  const request={executionId:intent.executionId,runId:intent.runId,workspaceId:'workspace',workflowNodeId:intent.nodeId,workingDirectory:workingTree.canonicalCwd,
    runtimeDirectory:join(runtime,'workflow-runs',intent.executionId,intent.attemptId),configuration,input:{}}
  return {root,approvedRoots,sources,owner,nativePlacement,intent,placement,request,context:{binding,signal:new AbortController().signal}}
}

async function runningInstalledFixture(phase: 'generation' | 'approval wait' = 'generation') {
  const f = await sourceFixture()
  f.intent = { ...f.intent, inputDigest: commandInputHash(f.request.input) }
  const file = join(f.root, 'workflow.json')
  const binary = join(f.root, 'codex')
  await writeFile(file, JSON.stringify({ schemaVersion: 1, codexBinary: binary,
    appMcpLauncher: join(f.root, 'launcher.mjs'), expectedVersion: '0.132.0', payloadPaths: [] }), { mode: 0o600 })
  const target = { hostRef: f.placement.hostRef, applicationInstallationId: f.context.binding.workerInstallationId,
    harnessInstallationId: 'installed-codex', installationFingerprint: 'a'.repeat(64) }
  const installation = { hostRef: f.placement.hostRef, harnessInstallationId: target.harnessInstallationId,
    installationFingerprint: target.installationFingerprint, driverId: 'codex', driverRevision: '1',
    protocolRevision: 'codex-native-adapter-v1', environmentGeneration: 'environment', connectionGeneration: 'generation',
    installed: true, launcher: { status: 'installed', resolvedLauncher: binary, fingerprint: target.installationFingerprint,
      payloadFingerprints: [{ path: binary, fingerprint: 'a'.repeat(64) }] } }
  // Qualification and native provider doubles isolate installed-host transport/ownership behavior.
  const capture = { binding: f.context.binding, qualification: { version: '0.132.0' },
    inspection: { currentTarget: { installation } }, facts: { intent: f.intent, placement: f.placement,
      executionPlacement: f.nativePlacement, configuration: f.request.configuration,
      harness: { installation, override: { target, instanceId: f.placement.payload.kind === 'agent'
        ? f.placement.payload.instanceId : '', instanceRevision: '1', driverId: 'codex', enabled: true,
        configuration: f.request.configuration.harness } } },
  } as unknown as Awaited<ReturnType<ReturnType<typeof installedQualification.createInstalledCodexQualificationReader>['capture']>>
  vi.spyOn(installedQualification, 'createInstalledCodexQualificationReader').mockReturnValue({
    capture: vi.fn(async () => capture), repository: { find: async () => null, list: async () => [] },
  })
  vi.spyOn(workerMcpEndpoint, 'createWorkerMcpEndpoint').mockImplementation(async ({ relay }) => {
    let closed = false
    return { endpoint: 'http://unit.invalid/mcp', close: vi.fn(async () => { closed = true }),
      refreshLease: () => {
        if (closed) throw new Error('MCP endpoint already closed')
        return relay.refresh()
      } }
  })
  const session: NativeSessionReference = { harness: 'codex', providerVersion: '0.132.0', nativeSessionId: 'original-session' }
  const registry = new NativeProcessRegistry(join(f.root, 'native-processes'))
  const log = await RemoteOperationJournal.open(join(f.root, 'workflow-journal'), { initializeNewInstallation: true })
  journals.push(log)
  let terminalRecorded!: () => void
  const settled = new Promise<void>(resolve => { terminalRecorded = resolve })
  const recordTerminal = log.terminal.bind(log)
  vi.spyOn(log, 'terminal').mockImplementation(async (operationId, evidence) => {
    const result = await recordTerminal(operationId, evidence)
    terminalRecorded()
    return result
  })
  const launch: NativeLaunchObservation = { owner: 'execution:execution', launchId: randomUUID(), bootId: f.context.binding.bootId,
    guardian: { pid: 200, startTicks: '2000' }, provider: { pid: 201, startTicks: '2001' },
    boundary: { kind: 'cgroup-v2', path: '/unit/boundary', device: '1', inode: '2' }, lifecycle: 'active' }
  let observed = launch
  vi.spyOn(registry, 'snapshot').mockImplementation(() => ({ revision: 'snapshot', launches: [observed] }))
  vi.spyOn(registry, 'reserveLaunch').mockImplementation(owner => ({ ...registry.scope(owner), launchId: launch.launchId }))
  vi.spyOn(registry, 'abandonReservedLaunch').mockResolvedValue(false)
  vi.spyOn(registry, 'closeRegistration').mockResolvedValue(undefined)
  const closeOwner = vi.spyOn(registry, 'closeOwner').mockImplementation(async () => {
    observed = { ...launch, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' }
    return true
  })
  const history: NativeHistory = { events: [{ sequence: 1, type: 'native.notification',
    occurredAt: new Date().toISOString(), payload: { text: 'original output' } }],
    correlationId: 'execution:execution', nativeTurnId: 'original-turn', pendingInteractions: [],
    firstRetainedSequence: 1, nextSequence: 2 }
  if (phase === 'approval wait') history.pendingInteractions = [{ session, turn: { nativeTurnId: 'original-turn', nativeRequestId: 'question' },
    nativeRequestType: 'question', request: {}, responseOptions: [CODEX_APPROVAL_OPTIONS_FIXTURE[0]!] }]
  let release!: () => void
  let entered!: () => void
  const turnEnded = new Promise<void>(resolve => { release = resolve })
  const turnEntered = new Promise<void>(resolve => { entered = resolve })
  const create = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession').mockResolvedValue(session)
  const attach = vi.spyOn(CodexAppServerSessionManager.prototype, 'attachSession')
  const turns = vi.spyOn(CodexAppServerSessionManager.prototype, 'startTurn').mockImplementation(async function* (_session, turn) {
    await turn.onSubmitted?.('original-turn')
    entered()
    await turnEnded
    yield history.events[0]!
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'originalSessionLifetime').mockReturnValue({
    residency: { session, connectionId: 'native-connection', runtimeGeneration: 1, nativeTurnId: undefined },
    assertCurrent: () => {},
  })
  vi.spyOn(CodexAppServerSessionManager.prototype, 'reconcile').mockImplementation(async () => structuredClone(history))
  vi.spyOn(CodexAppServerSessionManager.prototype, 'pending').mockImplementation(async () => history.pendingInteractions[0])
  vi.spyOn(CodexAppServerSessionManager.prototype, 'close').mockResolvedValue(undefined)
  vi.spyOn(CodexAppServerSessionManager.prototype, 'dispose').mockResolvedValue(undefined)
  const finish = (outcome: 'succeeded' | 'cancelled') => {
    history.pendingInteractions = []
    history.terminalTurn = { correlationId: 'execution:execution', providerId: 'original-turn', result: { outcome } }
    release()
  }
  const cancel = vi.spyOn(CodexAppServerSessionManager.prototype, 'cancel').mockImplementation(async () => {
    finish('cancelled')
    return true
  })
  let live: DeviceSessionBinding | undefined = f.context.binding
  let expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
  let launchDenied = false
  const requests: Array<{ namespace: string; payload: unknown; binding: DeviceSessionBinding }> = []
  const options: InstalledWorkflowHostOptions = { stateDirectory: f.root, registry,
    pairing: { formatVersion: 1, mainId: f.context.binding.mainId, deviceId: f.context.binding.deviceId,
      workerInstallationId: f.context.binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
      endpoint: 'wss://unit.invalid/device', mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64),
      expiresAt: '2099-01-01T00:00:00.000Z' }, bootId: f.context.binding.bootId,
    configuration: { path: file, ownerUid: process.getuid!() }, currentBinding: () => live,
    captureRequest: namespace => {
      if (!live) return undefined
      const binding = structuredClone(live)
      return { binding, request: async payload => {
        requests.push({ namespace, payload, binding })
        if (namespace === 'execution-authority-v1') {
          const request = payload as { action: string }
          if (launchDenied && request.action !== 'stop' && request.action !== 'read') throw new Error('Launch authority revoked')
          return { payload: { version: 1, action: request.action, operationId: f.intent.operationId,
            attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash, owner: f.intent.owner } }
        }
        if (launchDenied) throw new Error('Original MCP lease revoked')
        return { payload: { version: 1, mainId: f.intent.mainId, audience: 'worker', principalId: 'original-principal',
          executionId: f.intent.executionId, agentId: 'agent', operationId: f.intent.operationId,
          attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash, expiresAt } }
      } }
    }, sources: f.sources, approvedRoots: async () => f.approvedRoots, codexSuiteRevision: 'codex-live-4',
    signal: new AbortController().signal, journal: async () => log }
  const host = await createInstalledWorkflowHost(options)
  if (host.kind !== 'configured') throw new Error('Expected installed test host')
  const handler = host.extensions[0]!.handle!
  const call = async (method: string, fields: Record<string, unknown> = {}, binding = live) => {
    if (!binding) throw new Error('Disconnected')
    return handler({ method, intent: f.intent, placement: f.placement, ...fields },
      { binding, signal: new AbortController().signal })
  }
  const applicationAccess = { kind: 'scoped-worker-mcp', token: 'original-token', executionId: f.intent.executionId,
    agentId: 'agent', operationId: f.intent.operationId, attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash }
  const prepared = await call('prepare', { request: f.request, executionPlacement: f.nativePlacement, applicationAccess })
  await call('start-turn', { prompt: 'original prompt', correlationId: 'execution:execution' })
  await turnEntered
  const initialStatus = await log.status(f.intent.operationId)
  if (initialStatus.status !== 'known') throw new Error('Missing original native status')
  const stop = async () => {
    return call('control', { command: { schemaVersion: 1, protocolVersion: 1, commandId: 'stop',
      operationId: f.intent.operationId, attemptId: f.intent.attemptId, executionId: f.intent.executionId,
      bindingHash: f.intent.bindingHash, owner: f.intent.owner, native: initialStatus.receipt.native, action: { kind: 'stop' } } })
  }
  return { ...f, host, journal: log, prepared, call, stop, finish, settled, history, create, attach, turns, cancel, closeOwner, requests,
    disconnect: () => { live = undefined }, reconnect: (binding: DeviceSessionBinding) => { live = binding },
    renew: (expiry: string) => { expiresAt = expiry }, revoke: () => { launchDenied = true },
    changeProcess: () => { observed = { ...launch, provider: { pid: 201, startTicks: 'changed' } } } }
}

describe('installed host resident execution continuity', () => {
  it('retires a completed owner when Main acknowledges a bounded terminal history page', async () => {
    const f = await runningInstalledFixture()
    try {
      f.history.events = Array.from({ length: 24 }, (_, sequence) => ({
        sequence, type: 'native.notification', occurredAt: new Date().toISOString(),
        payload: { text: 'x'.repeat(80_000) },
      }))
      f.history.firstRetainedSequence = 0
      f.history.nextSequence = 24
      f.finish('succeeded')
      await f.settled
      const response = await f.call('history')
      const value = response.payload as { history: NativeHistory; status: { receipt: { sequence: number } } }
      expect(value.history.events.length).toBeLessThan(f.history.events.length)
      const selector = { receiptSequence: value.status.receipt.sequence,
        sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: value.history }) }
      expect(await f.call('physical-ack', selector)).toMatchObject({ payload: { status: 'retired' } })
      expect(await f.journal.isRetired(f.intent.operationId)).toBe(true)
      expect(await f.call('status')).toMatchObject({ payload: { receipt: { terminal: { kind: 'completed' } } } })
      expect(f.create).toHaveBeenCalledOnce()
    } finally {
      f.finish('cancelled')
      await f.host.close()
    }
  })

  it.each(['generation', 'approval wait'] as const)('rebinds %s to the original resident before history and Stop', async phase => {
    const f = await runningInstalledFixture(phase)
    try {
      const original = f.context.binding
      const { connectionEpoch: _epoch, ...originalConnection } = original
      f.disconnect()
      await expect(f.call('history', {}, original)).rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      const replacement = { ...original, connectionGeneration: original.connectionGeneration + 1, connectionEpoch: randomUUID() }
      f.reconnect(replacement)
      const read = await f.call('history')
      expect(read.payload).toMatchObject({ history: f.history, status: { receipt: {
        connection: originalConnection, native: { sessionId: 'original-session', turnId: 'original-turn' },
      } } })
      if (phase === 'approval wait') expect(f.history.pendingInteractions).toHaveLength(1)
      await expect(f.call('history', {}, original)).rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      await expect(f.stop()).resolves.toMatchObject({ payload: { receipt: { terminal: { kind: 'cancelled' } } } })
      expect(f.cancel).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: 'original-session' }), undefined, 'original-turn')
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.turns).toHaveBeenCalledOnce()
      expect(f.attach).not.toHaveBeenCalled()
      expect(f.requests.at(-1)?.binding).toEqual(replacement)
    } finally {
      f.finish('cancelled')
      await f.host.close()
    }
  })

  it.each(['process', 'boot', 'device', 'authorization'])('rejects changed %s on resident reconnection', async defect => {
    const f = await runningInstalledFixture()
    try {
      const replacement = { ...f.context.binding, connectionGeneration: 4, connectionEpoch: randomUUID() }
      if (defect === 'process') f.changeProcess()
      if (defect === 'boot') replacement.bootId = randomUUID()
      if (defect === 'device') replacement.deviceId = randomUUID()
      if (defect === 'authorization') replacement.authorizationRevision++
      f.reconnect(replacement)
      await expect(f.call('history')).rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.turns).toHaveBeenCalledOnce()
      expect(f.cancel).not.toHaveBeenCalled()
    } finally {
      f.reconnect(f.context.binding)
      f.finish('cancelled')
      await f.host.close()
    }
  })

  it('reads completion produced offline after the original lease expiry without reopening the native or MCP process', async () => {
    const f = await runningInstalledFixture()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20 * 60_000)
    try {
      f.disconnect()
      f.renew(new Date(Date.now() + 15 * 60_000).toISOString())
      f.finish('succeeded')
      await f.settled
      f.reconnect({ ...f.context.binding, connectionGeneration: 4, connectionEpoch: randomUUID() })
      const history = await f.call('history')
      const receipt = (history.payload as { status: { receipt: { sequence: number } } }).status.receipt
      expect((await f.call('physical-readout', { receiptSequence: receipt.sequence,
        sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: f.history }) })).payload).toMatchObject({
        receipt: { terminal: { kind: 'completed' } }, closure: { ownerClosed: true },
      })
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.turns).toHaveBeenCalledOnce()
      expect(f.attach).not.toHaveBeenCalled()
    } finally {
      clock.mockRestore()
      await f.host.close()
    }
  })

  it.each(['completion', 'approval Stop'])('keeps physical readback after twenty minutes and %s', async ending => {
    const f = await runningInstalledFixture(ending === 'approval Stop' ? 'approval wait' : 'generation')
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      for (const minute of [10, 20]) {
        clock.mockReturnValue(now + minute * 60_000)
        f.renew(new Date(Date.now() + 15 * 60_000).toISOString())
        await expect(f.call('history')).resolves.toMatchObject({ payload: { history: f.history } })
      }
      if (ending === 'approval Stop') await f.stop()
      else f.finish('succeeded')
      await f.settled
      const history = await f.call('history')
      const receipt = (history.payload as { status: { receipt: { sequence: number; terminal?: { kind: string } } } }).status.receipt
      const physical = await f.call('physical-readout', { receiptSequence: receipt.sequence,
        sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: f.history }) })
      expect(physical.payload).toMatchObject({ receipt: { terminal: { kind: ending === 'completion' ? 'completed' : 'cancelled' } },
        closure: { ownerClosed: true }, session: { nativeSessionId: 'original-session' } })
      expect(Date.parse((physical.payload as { expiresAt: string }).expiresAt)).toBeGreaterThan(Date.now())
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.turns).toHaveBeenCalledOnce()
    } finally {
      clock.mockRestore()
      f.finish('cancelled')
      await f.host.close()
    }
  })

  it.each(['permission', 'root policy'])('confirms original physical closure after %s changes revoke launch authority', async defect => {
    const f = await runningInstalledFixture('approval wait')
    try {
      f.revoke()
      if (defect === 'root policy') f.approvedRoots.managedRuntimeRoot = join(f.root, 'replacement-runtime')
      await expect(f.call('start-turn', { prompt: 'replacement', correlationId: 'execution:execution' })).rejects.toThrow('revoked')
      await expect(f.stop()).resolves.toMatchObject({ payload: { receipt: { terminal: { kind: 'cancelled' } } } })
      const history = await f.call('history')
      const receipt = (history.payload as { status: { receipt: { sequence: number } } }).status.receipt
      expect((await f.call('physical-readout', { receiptSequence: receipt.sequence,
        sourceDigest: remoteWorkflowSourceDigest({ type: 'history', history: f.history }) })).payload).toMatchObject({
        closure: { ownerClosed: true }, receipt: { stopFence: true, terminal: { kind: 'cancelled' } },
      })
      expect(f.closeOwner).toHaveBeenCalledWith('execution:execution')
      expect(f.cancel).toHaveBeenCalledOnce()
      expect(f.create).toHaveBeenCalledOnce()
    } finally {
      f.finish('cancelled')
      await f.host.close()
    }
  })
})
describe('actual anchored runtime leaf filesystem',()=>{
  it('verifies retained source bytes and records its own sibling inode, with immutable retry readback',async()=>{
    const f=await sourceFixture(),proof=await attestInstalledWorkflowRuntimeLeaf(f)
    expect(proof.bindingHash).toBe(f.nativePlacement.bindingHash)
    expect(proof.directoryIdentityHash).not.toBe(f.nativePlacement.workingTree.directoryIdentityHash)
    expect(proof.materializationId).toBe(f.nativePlacement.materialization.receipt.materializationId)
    expect(await attestInstalledWorkflowRuntimeLeaf(f)).toEqual(proof)
    await writeFile(join(f.request.runtimeDirectory,'.graphql-workflow-runtime.json'),JSON.stringify({...proof,operationId:'foreign-operation'}))
    await expect(attestInstalledWorkflowRuntimeLeaf(f)).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
  })
  it('rejects expired actual source ownership before creating a runtime leaf',async()=>{
    const f=await sourceFixture();f.owner.identity.expiresAt='2020-01-01T00:00:00.000Z'
    await expect(attestInstalledWorkflowRuntimeLeaf(f)).rejects.toThrow()
    await expect(access(f.request.runtimeDirectory)).rejects.toThrow()
  })
})
describe('lazy installed worker host qualification boundary',()=>{
  it('cannot turn a local version selection into Main qualification, journal entry or native launch',async()=>{
    const f=await sourceFixture(),binary=join(f.root,'codex'),file=join(f.root,'installed-workflow.json')
    await writeFile(binary,Buffer.concat([Buffer.from([0x7f,0x45,0x4c,0x46]),Buffer.from('unit bytes, never executed')]),{mode:0o700})
    await writeFile(file,JSON.stringify({schemaVersion:1,codexBinary:binary,appMcpLauncher:join(f.root,'launcher.mjs'),expectedVersion:'codex-cli 0.132.0',payloadPaths:[]}),{mode:0o600})
    const currentBinding=vi.fn(()=>f.context.binding),readMain=vi.fn().mockRejectedValue(new Error('Actual Main qualification is unavailable'))
    const reserve=vi.spyOn(NativeProcessRegistry.prototype,'reserveLaunch'),create=vi.spyOn(CodexAppServerSessionManager.prototype,'createSession').mockRejectedValue(new Error('Native entry must not occur in this source check'))
    let retainedJournal: RemoteOperationJournal | undefined
    const options:InstalledWorkflowHostOptions={stateDirectory:f.root,pairing:{formatVersion:1,mainId:f.context.binding.mainId,deviceId:f.context.binding.deviceId,
      workerInstallationId:f.context.binding.workerInstallationId,keyRevision:1,authorizationRevision:1,endpoint:'wss://unit.invalid/device',mainPublicKeyFingerprint:'a'.repeat(64),credential:'b'.repeat(64),expiresAt:'2099-01-01T00:00:00.000Z'},
      bootId:f.context.binding.bootId,configuration:{path:file,ownerUid:process.getuid!()},currentBinding,captureRequest:()=>({binding:f.context.binding,request:readMain}),
      sources:f.sources,approvedRoots:async()=>f.approvedRoots,codexSuiteRevision:'codex-live-4',signal:new AbortController().signal,
      journal: async () => retainedJournal ??= await RemoteOperationJournal.open(join(f.root, 'workflow-operations.json'),
        { initializeNewInstallation: true })}
    const host=await createInstalledWorkflowHost(options)
    expect(host.kind).toBe('configured')
    if(host.kind!=='configured')throw new Error('Expected unit configured code support')
    try {
      const negotiated = negotiateDeviceExtensions([
        { ...EXECUTION_AUTHORITY_EXTENSION, role: 'server' },
        { ...WORKER_MCP_EXTENSION, role: 'server' },
      ], host.extensions)
      expect(negotiated).toEqual([
        expect.objectContaining({ namespace: 'execution-authority-v1', workerCanRequest: true, mainCanRequest: false }),
        expect.objectContaining({ namespace: 'worker-mcp-v1', workerCanRequest: true, mainCanRequest: false }),
      ])
      const handler=host.extensions[0]!.handle!
      await expect(handler({method:'prepare',intent:f.intent,placement:f.placement,request:f.request,executionPlacement:f.nativePlacement},f.context)).rejects.toThrow('Actual Main qualification is unavailable')
      expect(readMain).toHaveBeenCalledOnce()
      expect(reserve).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled()
      await expect(access(join(f.root,'workflow-operations.json'))).rejects.toThrow()
      expect(await host.preparationClosed({ ...f.owner, preparationKind: 'workflow' })).toBe(false)
      expect(await host.preparationClosed({ ...f.owner, preparationKind: 'workflow', preparationClosed: true })).toBe(true)
      const { mainId, deviceId, workerInstallationId, bootId, keyRevision,
        authorizationRevision, connectionGeneration } = f.context.binding
      const connection = { mainId, deviceId, workerInstallationId, bootId, keyRevision,
        authorizationRevision, connectionGeneration }
      await retainedJournal!.accept(f.intent, connection, randomUUID())
      expect(await host.preparationClosed({ ...f.owner, preparationKind: 'workflow', preparationClosed: true })).toBe(true)
      expect(await retainedJournal!.status(f.intent.operationId)).toMatchObject({
        status: 'known', receipt: { phase: 'confirmed_terminal', entryAttempted: false, terminal: { kind: 'not_started' } },
      })
      expect(await retainedJournal!.isRetired(f.intent.operationId)).toBe(true)
      readMain.mockImplementation(async input => {
        const request = input as { action: string; intent: typeof f.intent }
        return { payload: { version: 1, action: request.action, operationId: request.intent.operationId,
          attemptId: request.intent.attemptId, bindingHash: request.intent.bindingHash, owner: request.intent.owner } }
      })
      const retiredStatus = await retainedJournal!.status(f.intent.operationId)
      expect(await handler({ method: 'status', intent: f.intent, placement: f.placement }, f.context))
        .toEqual({ payload: retiredStatus })
      expect(await handler({ method: 'control', intent: f.intent, placement: f.placement,
        command: { schemaVersion: 1, protocolVersion: 1, commandId: 'retired-stop',
          operationId: f.intent.operationId, executionId: f.intent.executionId, attemptId: f.intent.attemptId,
          bindingHash: f.intent.bindingHash, owner: f.intent.owner, action: { kind: 'stop' } } }, f.context))
        .toEqual({ payload: retiredStatus })
      await expect(handler({ method: 'control', intent: f.intent, placement: f.placement,
        command: { schemaVersion: 1, protocolVersion: 1, commandId: 'foreign-stop',
          operationId: 'foreign-operation', executionId: f.intent.executionId, attemptId: f.intent.attemptId,
          bindingHash: f.intent.bindingHash, owner: f.intent.owner, action: { kind: 'stop' } } }, f.context))
        .rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE',
          details: { reason: 'retired_control_ownership_changed' } })
      readMain.mockRejectedValue(new Error('Original grant revoked'))
      await expect(handler({ method: 'status', intent: f.intent, placement: f.placement }, f.context))
        .rejects.toThrow('Original grant revoked')
      expect(await retainedJournal!.status(f.intent.operationId)).toEqual(retiredStatus)
      expect(reserve).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
      const interrupted = { ...f.intent, executionId: 'interrupted-execution', attemptId: 'interrupted-attempt', operationId: 'interrupted-operation' }
      const cleanupOwner = { ...f.owner, preparationKind: 'workflow' as const, preparationClosed: true as const,
        identity: { ...f.owner.identity, operationId: interrupted.operationId },
        attempt: { ...f.owner.attempt, executionId: interrupted.executionId, attemptId: interrupted.attemptId } }
      await retainedJournal!.accept(interrupted, connection, randomUUID())
      await retainedJournal!.reserveEntry(interrupted.operationId)
      await retainedJournal!.acknowledgeStart(interrupted.operationId, { sessionId: 'unacknowledged-on-main', processIdentityDigest: 'a'.repeat(64) })
      const closeOwner = vi.spyOn(NativeProcessRegistry.prototype, 'closeOwner').mockResolvedValue(false)
      expect(await host.preparationClosed(cleanupOwner)).toBe(false)
      closeOwner.mockResolvedValue(true)
      expect(await host.preparationClosed(cleanupOwner)).toBe(true)
      expect(closeOwner).toHaveBeenLastCalledWith('execution:interrupted-execution')
      expect(await retainedJournal!.status(interrupted.operationId)).toMatchObject({
        status: 'known', receipt: { phase: 'confirmed_terminal', native: { sessionId: 'unacknowledged-on-main' },
          terminal: { kind: 'cancelled' } },
      })
      expect(await host.preparationClosed({ ...cleanupOwner, preparationNativeSession: {
        harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'another-session',
      } })).toBe(false)
      currentBinding.mockReturnValue({...f.context.binding,connectionGeneration:4})
      await expect(handler({method:'status',intent:f.intent,placement:f.placement},f.context)).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
    } finally {await host.close(); await retainedJournal?.close()}
  })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function constructionFixture() {
  const f = await sourceFixture()
  f.intent.inputDigest = commandInputHash(f.request.input)
  if (f.placement.payload.kind !== 'agent') throw new Error('Expected Agent placement')
  const payload = f.placement.payload
  const binding = f.context.binding
  const timestamp = new Date().toISOString()
  const target = { hostRef: f.placement.hostRef, applicationInstallationId: binding.workerInstallationId,
    harnessInstallationId: payload.harnessInstallationId, installationFingerprint: payload.installationFingerprint }
  const installation = { hostRef: target.hostRef, harnessInstallationId: target.harnessInstallationId,
    installationFingerprint: target.installationFingerprint, driverId: 'codex', driverRevision: '1',
    protocolRevision: payload.protocolRevision, environmentGeneration: 'unit-worker-environment',
    connectionGeneration: harnessConnectionGeneration(binding),
    launcher: { requested: '/unit/codex', resolvedLauncher: '/unit/codex', fingerprint: target.installationFingerprint,
      payloadFingerprints: [{ path: '/unit/codex', fingerprint: 'a'.repeat(64) }], status: 'installed', interpreter: null,
      diagnostics: [], environment: { generation: 'unit-worker-environment', provenance: 'worker', cwd: f.root, path: '/usr/bin' },
      checkedAt: timestamp }, observedVersion: '0.154.0', installed: true, authenticated: true, compatible: true, qualified: true }
  const override = { instanceId: payload.instanceId, revision: 1, instanceRevision: payload.instanceRevision,
    target, presetId: 'unit-preset', enabled: true, driverId: 'codex', configuration: f.request.configuration.harness,
    configurationFingerprint: commandInputHash(withAdvancedDefaults(f.request.configuration.harness)), qualification: 'qualified' }
  const qualification = { harness: 'codex', version: '0.154.0', binarySha256: 'a'.repeat(64), status: 'qualified',
    profile: 'codex-0.156', suiteRevision: 'codex-live-4', checks: [{ id: 'unit-native-check', passed: true, detail: null }],
    failureReason: null, startedAt: timestamp, checkedAt: timestamp }
  const facts = ExecutionFactsResultSchema.parse({ version: 1, intent: f.intent, placement: f.placement,
    configuration: f.request.configuration, executionPlacement: f.nativePlacement,
    harness: { installation, override, qualification, profileProof: {
      target, instanceRevision: override.instanceRevision, configurationFingerprint: override.configurationFingerprint,
      driverId: 'codex', driverRevision: '1', protocolRevision: payload.protocolRevision,
      suiteRevision: 'codex-profile-check-v1', environmentGeneration: installation.environmentGeneration,
      connectionGeneration: installation.connectionGeneration, authenticated: true, compatible: true,
      qualified: true, checkedAt: timestamp,
    } } })
  // Main, installed-binary and native-process observations are unit doubles; the host, journal and source guards are real.
  const inspect = vi.spyOn(installedInspection, 'inspectInstalledCodex').mockImplementation(async () => ({
    inventory: { instances: [], installations: [facts.harness.installation] },
    currentTarget: { binding, target, installation: facts.harness.installation,
      binarySha256: 'a'.repeat(64), expectedVersion: '0.154.0' },
  }))
  let authorized = true
  const readMain = vi.fn(async (raw: unknown): Promise<DeviceApplicationResult> => {
    const read = ExecutionFactsRequestSchema.safeParse(raw)
    if (read.success) {
      const { intent, placement } = read.data.authorization
      return { payload: { ...facts, intent, placement, executionPlacement: { ...facts.executionPlacement,
        executionId: intent.executionId, attemptId: intent.attemptId, operationId: intent.operationId } } }
    }
    if (!authorized) throw new Error('Main denied original execution access')
    const authority = ExecutionAuthorityRequestSchema.safeParse(raw)
    if (authority.success) {
      const { intent, action } = authority.data
      return { payload: { version: 1, action, operationId: intent.operationId, attemptId: intent.attemptId,
        bindingHash: intent.bindingHash, owner: intent.owner } }
    }
    return { payload: { version: 1, mainId: binding.mainId, audience: 'worker', principalId: 'unit-principal',
      executionId: f.intent.executionId, agentId: f.request.configuration.agentId, operationId: f.intent.operationId,
      attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash, expiresAt: '2099-01-01T00:00:00.000Z' } }
  })
  const file = join(f.root, 'installed-workflow.json')
  await writeFile(file, JSON.stringify({ schemaVersion: 1, codexBinary: '/unit/codex', appMcpLauncher: '/unit/launcher.mjs',
    expectedVersion: 'codex-cli 0.154.0', payloadPaths: [] }), { mode: 0o600 })
  const journal = await RemoteOperationJournal.open(join(f.root, 'construction-journal'), { initializeNewInstallation: true })
  journals.push(journal)
  const n = nativeFixture()
  const currentBinding = vi.fn(() => binding)
  const openJournal = vi.fn(async () => journal)
  const options: InstalledWorkflowHostOptions = { stateDirectory: f.root, bootId: binding.bootId,
    pairing: { formatVersion: 1, mainId: binding.mainId, deviceId: binding.deviceId,
      workerInstallationId: binding.workerInstallationId, keyRevision: binding.keyRevision,
      authorizationRevision: binding.authorizationRevision, endpoint: 'wss://unit.invalid/device',
      mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' },
    configuration: { path: file, ownerUid: process.getuid!() }, currentBinding,
    captureRequest: () => ({ binding, request: readMain }), sources: f.sources, approvedRoots: async () => f.approvedRoots,
    codexSuiteRevision: 'codex-live-4', signal: new AbortController().signal, registry: n.registry, journal: openJournal }
  const host = await createInstalledWorkflowHost(options)
  if (host.kind !== 'configured') throw new Error('Expected configured installed host')
  const handler = host.extensions[0]!.handle!
  return { ...f, registry: n.registry, session: n.session, launch: n.launch, snapshot: n.snapshot,
    host, handler, journal, readMain, inspect, currentBinding, openJournal,
    deny: () => { authorized = false } }
}

function delayedFacts(readMain: Awaited<ReturnType<typeof constructionFixture>>['readMain'], executionId: string) {
  const entered = deferred()
  const release = deferred()
  const original = readMain.getMockImplementation()!
  readMain.mockImplementation(async raw => {
    const read = ExecutionFactsRequestSchema.safeParse(raw)
    if (read.success && read.data.authorization.intent.executionId === executionId) {
      entered.resolve()
      await release.promise
      throw new Error('Delayed qualification rejected')
    }
    return original(raw)
  })
  return { entered, release, restore: () => { readMain.mockImplementation(original) } }
}

describe('installed workflow construction concurrency', () => {
  it('delivers original history, ACK and Stop while another execution waits for Main facts', async () => {
    const f = await constructionFixture()
    const create = vi.spyOn(CodexAppServerSessionManager.prototype, 'createSession').mockResolvedValue(f.session)
    vi.spyOn(f.registry, 'reserveLaunch').mockImplementation(owner => f.registry.scope(owner))
    vi.spyOn(CodexAppServerSessionManager.prototype, 'originalSessionLifetime').mockReturnValue({
      residency: { session: f.session, connectionId: 'unit-native-connection', runtimeGeneration: 1, nativeTurnId: undefined },
      assertCurrent: () => {},
    })
    vi.spyOn(workerMcpEndpoint, 'createWorkerMcpEndpoint').mockResolvedValue({ endpoint: 'http://unit.invalid/mcp', close: async () => {} })
    const history = { events: [], pendingInteractions: [], correlationId: `execution:${f.intent.executionId}` }
    vi.spyOn(CodexAppServerSessionManager.prototype, 'reconcile').mockResolvedValue(history)
    const cancel = vi.spyOn(CodexAppServerSessionManager.prototype, 'cancel').mockResolvedValue(true)
    vi.spyOn(CodexAppServerSessionManager.prototype, 'close').mockResolvedValue(undefined)
    vi.spyOn(CodexAppServerSessionManager.prototype, 'dispose').mockResolvedValue(undefined)
    vi.spyOn(f.registry, 'closeRegistration').mockResolvedValue(undefined)
    const closeOwner = vi.spyOn(f.registry, 'closeOwner').mockImplementation(async () => {
      f.snapshot.mockReturnValue({ revision: 'snapshot:closed', launches: [{ ...f.launch, lifecycle: 'closed', closureEvidence: 'cgroup_v2_empty' }] })
      return true
    })
    const access = { kind: 'scoped-worker-mcp', token: 'unit-main-owned-token', executionId: f.intent.executionId,
      agentId: f.request.configuration.agentId, operationId: f.intent.operationId, attemptId: f.intent.attemptId,
      bindingHash: f.intent.bindingHash }
    const delayed = delayedFacts(f.readMain, 'other-execution')
    let pending: Promise<unknown> | undefined
    let responsive: Promise<unknown> | undefined
    try {
      await f.handler({ method: 'prepare', intent: f.intent, placement: f.placement, request: f.request,
        executionPlacement: f.nativePlacement, applicationAccess: access }, f.context)
      const status = await f.journal.status(f.intent.operationId)
      if (status.status !== 'known' || !status.receipt.native) throw new Error('Expected original native receipt')
      f.readMain.mockClear()
      await expect(f.handler({ method: 'physical-readout', intent: f.intent, placement: f.placement,
        receiptSequence: status.receipt.sequence, sourceDigest: remoteWorkflowSourceDigest({ type: 'session_created', session: f.session }) }, f.context))
        .resolves.toMatchObject({ payload: { session: f.session } })
      expect(f.readMain).toHaveBeenCalledTimes(2)
      const other = { ...f.intent, executionId: 'other-execution', attemptId: 'other-attempt', operationId: 'other-operation' }
      pending = f.handler({ method: 'prepare', intent: other, placement: f.placement,
        request: { ...f.request, executionId: other.executionId }, executionPlacement: f.nativePlacement }, f.context)
      const rejected = expect(pending).rejects.toThrow('Delayed qualification rejected')
      await delayed.entered.promise
      responsive = (async () => {
        expect(await f.handler({ method: 'history', intent: f.intent, placement: f.placement }, f.context))
          .toMatchObject({ payload: { history } })
        expect(await f.handler({ method: 'physical-ack', intent: f.intent, placement: f.placement,
          receiptSequence: status.receipt.sequence, sourceDigest: remoteWorkflowSourceDigest({ type: 'session_created', session: f.session }) }, f.context))
          .toMatchObject({ payload: { status: 'retired' } })
        return f.handler({ method: 'control', intent: f.intent, placement: f.placement, command: {
          schemaVersion: 1, protocolVersion: 1, commandId: 'original-stop', operationId: f.intent.operationId,
          executionId: f.intent.executionId, attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash,
          owner: f.intent.owner, native: status.receipt.native, action: { kind: 'stop' },
        } }, f.context)
      })()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([responsive, new Promise(resolve => { timeout = setTimeout(() => resolve('blocked'), 1000) })])
        expect(result).toMatchObject({ payload: { status: 'known', receipt: { terminal: { kind: 'cancelled' } } } })
        expect(cancel).toHaveBeenCalledOnce()
        expect(cancel).toHaveBeenCalledWith(f.session, undefined, undefined)
        expect(closeOwner).toHaveBeenCalledWith(`execution:${f.intent.executionId}`)
        expect(create).toHaveBeenCalledOnce()
      } finally { clearTimeout(timeout) }
      delayed.release.resolve()
      await rejected
    } finally {
      delayed.release.resolve()
      await Promise.allSettled([pending, responsive])
      await f.host.close()
    }
  })

  it('coalesces only matching execution construction and releases a rejected lookup for retry', async () => {
    const f = await constructionFixture()
    const delayed = delayedFacts(f.readMain, f.intent.executionId)
    const frame = { method: 'status', intent: f.intent, placement: f.placement }
    const tasks: Promise<unknown>[] = []
    try {
      tasks.push(f.handler(frame, f.context))
      const rejected = expect(tasks[0]).rejects.toThrow('Delayed qualification rejected')
      await delayed.entered.promise
      tasks.push(f.handler(frame, f.context))
      const duplicateRejected = expect(tasks[1]).rejects.toThrow('Delayed qualification rejected')
      await expect(f.handler({ ...frame, intent: { ...f.intent, owner: { grantId: 'foreign-grant', epoch: '2' } } }, f.context))
        .rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      await expect(f.handler({ ...frame, placement: { ...f.placement,
        destination: { ...f.placement.destination, canonicalCwd: '/foreign-cwd' } } }, f.context))
        .rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      const replacement = { ...f.context.binding, connectionEpoch: randomUUID() }
      f.currentBinding.mockReturnValue(replacement)
      await expect(f.handler(frame, { ...f.context, binding: replacement }))
        .rejects.toMatchObject({ code: 'WORKER_WORKFLOW_UNAVAILABLE' })
      f.currentBinding.mockReturnValue(f.context.binding)
      expect(f.readMain).toHaveBeenCalledOnce()
      delayed.release.resolve()
      await Promise.all([rejected, duplicateRejected])
      delayed.restore()
      await expect(f.handler(frame, f.context)).resolves.toMatchObject({ payload: { status: 'unknown' } })
      expect(f.readMain.mock.calls.filter(([raw]) => ExecutionFactsRequestSchema.safeParse(raw).success)).toHaveLength(2)
    } finally {
      delayed.release.resolve()
      await Promise.allSettled(tasks)
      await f.host.close()
    }
  })

  it('refuses aborted construction before inspection or Main requests', async () => {
    const f = await constructionFixture()
    const controller = new AbortController()
    controller.abort(new Error('RPC already aborted'))
    try {
      await expect(f.handler({ method: 'status', intent: f.intent, placement: f.placement }, { ...f.context, signal: controller.signal }))
        .rejects.toThrow('RPC already aborted')
      expect(f.inspect).not.toHaveBeenCalled()
      expect(f.readMain).not.toHaveBeenCalled()
    } finally { await f.host.close() }
  })

  it('shares one generation host when separate constructions await the same journal', async () => {
    const f = await constructionFixture()
    const opened = deferred()
    const release = deferred()
    f.openJournal.mockImplementation(async () => { opened.resolve(); await release.promise; return f.journal })
    const other = { ...f.intent, executionId: 'other-execution', attemptId: 'other-attempt', operationId: 'other-operation' }
    const tasks = [f.intent, other].map(intent => f.handler({ method: 'status', intent, placement: f.placement }, f.context))
    try {
      await opened.promise
      await vi.waitFor(() => { expect(f.inspect).toHaveBeenCalledTimes(4) })
      release.resolve()
      await Promise.all(tasks)
      expect(f.openJournal).toHaveBeenCalledOnce()
      const receipts = []
      for (const intent of [f.intent, other]) {
        await f.handler({ method: 'control', intent, placement: f.placement, command: {
          schemaVersion: 1, protocolVersion: 1, commandId: `stop:${intent.executionId}`,
          operationId: intent.operationId, executionId: intent.executionId, attemptId: intent.attemptId,
          bindingHash: intent.bindingHash, owner: intent.owner, action: { kind: 'stop' },
        } }, f.context)
        const status = await f.journal.status(intent.operationId)
        if (status.status !== 'known') throw new Error('Expected retained Stop receipt')
        receipts.push(status.receipt)
      }
      expect(receipts[0]!.workerIncarnationId).toBe(receipts[1]!.workerIncarnationId)
      expect(receipts.every(receipt => receipt.stopFence && !receipt.entryAttempted)).toBe(true)
    } finally {
      release.resolve()
      await Promise.allSettled(tasks)
      await f.host.close()
    }
  })

  it('joins only the cleanup target construction while unrelated facts are delayed', async () => {
    const f = await constructionFixture()
    f.snapshot.mockReturnValue({ revision: 'snapshot:empty', launches: [] })
    const other = { ...f.intent, executionId: 'other-execution', attemptId: 'other-attempt', operationId: 'other-operation' }
    const delayed = delayedFacts(f.readMain, other.executionId)
    const pending = f.handler({ method: 'status', intent: other, placement: f.placement }, f.context)
    const rejected = expect(pending).rejects.toThrow('Delayed qualification rejected')
    try {
      await delayed.entered.promise
      const owner = { ...f.owner, preparationKind: 'workflow' as const, preparationClosed: true as const }
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([f.host.preparationClosed(owner), new Promise(resolve => {
          timeout = setTimeout(() => resolve('blocked'), 1000)
        })])
        expect(result).toBe(true)
      } finally { clearTimeout(timeout) }
      let targetClosed = false
      const target = f.host.preparationClosed({ ...owner,
        identity: { ...owner.identity, operationId: other.operationId },
        attempt: { ...owner.attempt, executionId: other.executionId, attemptId: other.attemptId },
      }).then(result => { targetClosed = true; return result })
      await Promise.resolve()
      expect(targetClosed).toBe(false)
      delayed.release.resolve()
      await rejected
      expect(await target).toBe(true)
    } finally {
      delayed.release.resolve()
      await Promise.allSettled([pending])
      await f.host.close()
    }
  })

  it('still requires Main control authorization for a constructed owner', async () => {
    const f = await constructionFixture()
    try {
      await f.handler({ method: 'status', intent: f.intent, placement: f.placement }, f.context)
      f.deny()
      await expect(f.handler({ method: 'control', intent: f.intent, placement: f.placement, command: {
        schemaVersion: 1, protocolVersion: 1, commandId: 'denied-stop', operationId: f.intent.operationId,
        executionId: f.intent.executionId, attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash,
        owner: f.intent.owner, action: { kind: 'stop' },
      } }, f.context)).rejects.toThrow('Main denied original execution access')
      expect(await f.journal.status(f.intent.operationId)).toMatchObject({ status: 'unknown' })
    } finally { await f.host.close() }
  })
})

async function physicalFixture(relativeCwd='') {
  const f=await sourceFixture(relativeCwd),n=nativeFixture()
  const connection=DeviceConnectionIdentitySchema.parse({mainId:f.context.binding.mainId,deviceId:f.context.binding.deviceId,
    workerInstallationId:f.context.binding.workerInstallationId,keyRevision:f.context.binding.keyRevision,authorizationRevision:f.context.binding.authorizationRevision,
    bootId:f.context.binding.bootId,connectionGeneration:f.context.binding.connectionGeneration})
  const captured=captureInstalledWorkflowNativeOwner(n.registry,connection,f.intent,n.session)
  const journal=await RemoteOperationJournal.open(join(f.root,'physical-journal'),{initializeNewInstallation:true});journals.push(journal)
  await journal.accept(f.intent,connection,randomUUID());await journal.reserveEntry(f.intent.operationId)
  await journal.acknowledgeStart(f.intent.operationId,captured.native)
  await journal.reserveTurn(f.intent.operationId,{correlationId:`execution:${f.intent.executionId}`,promptDigest:'c'.repeat(64)})
  await journal.acknowledgeTurn(f.intent.operationId,'original-turn');await journal.markRunning(f.intent.operationId)
  const status=await journal.status(f.intent.operationId)
  if(status.status!=='known')throw new Error('Unit journal must retain its original receipt')
  const history={events:[],pendingInteractions:[],correlationId:`execution:${f.intent.executionId}`,nativeTurnId:'original-turn'}
  const source={type:'history' as const,history}
  const runtimeLeaf=await attestInstalledWorkflowRuntimeLeaf(f)
  const readout=RemoteWorkflowPhysicalReadoutSchema.parse({version:1,expiresAt:new Date(Date.now()+60_000).toISOString(),
    receipt:status.receipt,session:n.session,launch:captured.launch,
    observation:captured.launch,runtimeLeaf,source:{record:f.nativePlacement.materialization,workingTree:f.nativePlacement.workingTree},history})
  const execution:HarnessExecution={id:f.intent.executionId,runId:f.intent.runId,workflowNodeId:f.intent.nodeId,agentId:f.request.configuration.agentId,
    agentConfigurationVersionId:f.request.configuration.id,attempt:f.intent.technicalAttempt,state:'running',nativeSessionId:n.session.nativeSessionId,
    input:{},createdAt:new Date().toISOString(),workingDirectory:f.request.workingDirectory,runtimeDirectory:f.request.runtimeDirectory}
  const lifetime:RemoteWorkflowMainLifetime={execution,session:n.session,lifetimeGeneration:1,closureGeneration:'1',
    lane:{id:'original-main-lane',token:'unit-original-private-lane-token',connectionGeneration:2,providerId:'original-turn'},assertCurrent:vi.fn()}
  const reservation={execution:repeatExecutionIdentity(execution),scope:{runId:execution.runId}}
  const entry={phase:'entered',reservation,transition:{phase:'entered',reservation,launchDigest:`sha256:${'e'.repeat(64)}`},source_id:'actual-unit-entry',source_digest:`sha256:${'f'.repeat(64)}`}
  const lane={owner_agent_id:execution.agentId,harness:n.session.harness,native_session_id:n.session.nativeSessionId,generation:'2',token:lifetime.lane!.token,
    correlation:`execution:${execution.id}`,provider_id:'original-turn',held:true}
  const request=vi.fn(async(payload:unknown):Promise<DeviceApplicationResult>=>{void payload;return {payload:readout}}),currentBinding=vi.fn(()=>f.context.binding)
  const canonicalProofs:{record:{execution:ReturnType<typeof repeatExecutionIdentity>;session:NativeSessionReference;original:typeof source}}[]=[]
  // Authenticated carrier/SQL/process observations are explicit unit doubles.
  // The real source materialization/runtime directory above exercises FD/CWD receipts; no native or signed connection is produced.
  const producer=createRemoteWorkflowPhysicalVerification({endpoint:()=>({currentBinding,captureRequest:()=>({binding:f.context.binding,request})})})
  const query=vi.fn(async(text:string)=>{
    if (text.startsWith('select r.id from runs r join execution_dispatch_intents')) {
      return { rows: [{ id: execution.runId }], rowCount: 1 }
    }
    if(['begin isolation level read committed','commit','rollback'].includes(text))return {rows:[],rowCount:0}
    if(text.includes('from execution_dispatch_intents'))return {rows:[{...f.intent,operation_id:f.intent.operationId,execution_id:f.intent.executionId,run_id:f.intent.runId,
      node_id:f.intent.nodeId,binding_hash:f.intent.bindingHash,attempt_id:f.intent.attemptId,record:f.intent}],rowCount:1}
    if(text.includes('remote_execution_owner_reconciliations'))return {rows:[],rowCount:0}
    if(text.includes('run_node_placements'))return {rows:[{record:f.placement}],rowCount:1}
    if(text.includes('execution_native_placements'))return {rows:[{record:f.nativePlacement}],rowCount:1}
    if(text.includes('source_execution_materializations'))return {rows:[{record:f.nativePlacement.materialization,state:f.nativePlacement.materialization.state}],rowCount:1}
    if(text.includes('remote_dispatch_origins'))return {rows:[{connection}],rowCount:1}
    if(text.includes('harness_executions'))return {rows:[{record:execution,accepted:true}],rowCount:1}
    if(text.includes('workflow_native_entries'))return {rows:[entry],rowCount:1}
    if(text.includes('workflow_native_proofs'))return {rows:canonicalProofs.map(row=>({...row,original:row.record.original})),rowCount:canonicalProofs.length}
    if(text.includes('execution_native_sessions'))return {rows:[{reference:n.session}],rowCount:1}
    if(text.includes('execution_native_closures'))return {rows:[{generation:'1',expected_reference:n.session,closed:false}],rowCount:1}
    if(text.includes('native_session_lanes'))return {rows:[lane],rowCount:1}
    throw new Error(`Unexpected physical SQL: ${text}`)
  })
  const sqlConnection=new ExclusiveGraphConnection({query} as unknown as pg.ClientBase,()=>{})
  const owner={runId:f.intent.runId,assertOwned:vi.fn()} as unknown as Parameters<typeof producer.bind>[2]
  const originals=createRemoteNativeSourceChannel()
  let original:Parameters<typeof producer.bind>[0]|undefined
  const bind=async()=>{
    const prepared=await producer.prefetch(readout.receipt,f.placement,source)
    await VerifiedRemoteEvidence.commit(readout.receipt,connection,{transaction:async(_operation,work)=>work({authority:async()=>({intent:f.intent,placement:f.placement,
      originalConnection:connection,originalIncarnationId:readout.receipt.workerIncarnationId,grantIsLive:true,lastSequence:0,lastReceipt:null,native:null,terminal:null}),
      reject:async()=>{throw new Error('Unit original receipt rejected')},accept:async verified=>{
        originals.observe(verified,source,()=>{});original=originals.verify.read(originals.capture(f.intent.executionId,source))
        producer.bind(original,prepared,owner,lifetime)
      }})})
    if(!original)throw new Error('Expected private unit original-source capability')
    return original
  }
  return {...f,registry:n.registry,snapshot:n.snapshot,session:n.session,launch:n.launch,connection,captured,journal,readout,source,execution,lifetime,
    entry,lane,request,currentBinding,producer,query,sqlConnection,owner,originals,bind,canonicalProofs}
}
describe('original physical source selectors and Main SQL consumer',()=>{
  it('retains byte-bounded page and event selectors without copying the entire native history', async () => {
    const f = await physicalFixture()
    const events = Array.from({ length: 80 }, (_, sequence) => ({ sequence, type: 'native.notification',
      occurredAt: '2026-10-01T00:00:00.000Z', payload: { text: '漢'.repeat(6000) } }))
    const full = { ...f.source.history, events, firstRetainedSequence: 0, nextSequence: events.length }
    expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(DEVICE_APPLICATION_JSON_BYTES)
    const readouts = new InstalledWorkflowPhysicalReadouts()
    const assertCurrent = vi.fn(async () => {})
    const observed: number[] = []
    let cursor = -1
    try {
      for (let count = 0; count < events.length; count++) {
        const page = pageNativeHistory(full, cursor)
        const source = { type: 'history' as const, history: page.history }
        readouts.remember({ readout: { ...f.readout, history: page.history }, placement: f.placement, source,
          leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: assertCurrent, assertCurrent,
          observe: () => f.captured.launch, closure: () => null })
        const selector = { intent: f.intent, placement: f.placement, receiptSequence: f.readout.receipt.sequence,
          sourceDigest: remoteWorkflowSourceDigest(source) }
        const readout = await readouts.read(selector)
        expect(Buffer.byteLength(JSON.stringify(readout))).toBeLessThanOrEqual(DEVICE_APPLICATION_JSON_BYTES)
        expect(readout.history).toEqual(page.history)
        for (const event of page.history.events) {
          const original = { type: 'event' as const, event: { ...event, executionId: f.intent.executionId } }
          expect((await readouts.read({ ...selector, sourceDigest: remoteWorkflowSourceDigest(original) }))
            .history?.events).toContainEqual(event)
          observed.push(event.sequence)
        }
        await expect(readouts.read({ ...selector, intent: { ...f.intent, executionId: 'foreign-execution' } }))
          .rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
        await readouts.ack(selector)
        cursor = page.page.nextAfterSequence
        if (!page.page.hasMore) break
      }
      expect(observed).toEqual(events.map(event => event.sequence))
      expect(assertCurrent).toHaveBeenCalled()
    } finally { await f.sqlConnection.close() }
  })
  it('retains the exact earlier source, never reconstructs latest history, and expires/purges selectors',async()=>{
    const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts(),assertCurrent=vi.fn(async()=>{})
    const input={readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',assertOwnerCurrent:assertCurrent,assertCurrent,
      observe:()=>matchingOriginalRegistryLaunch(f.registry,f.captured.launch),closure:()=>null}
    readouts.remember(input)
    const selector={intent:f.intent,placement:f.placement,receiptSequence:f.readout.receipt.sequence,sourceDigest:remoteWorkflowSourceDigest(f.source)}
    expect(await readouts.read(selector)).toEqual(f.readout)
    f.source.history.nativeTurnId='later-provider-turn'
    expect((await readouts.read(selector)).history?.nativeTurnId).toBe('original-turn')
    await expect(readouts.read({...selector,sourceDigest:remoteWorkflowSourceDigest(f.source)})).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    assertCurrent.mockRejectedValueOnce(new Error('Original authority revoked'))
    await expect(readouts.read(selector)).rejects.toThrow('Original authority revoked')
    await expect(readouts.read(selector)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    await f.sqlConnection.close()
  })
  it('requires private prepared/original capabilities and performs no network IO inside the owning SQL transaction',async()=>{
    const f=await physicalFixture(),original=await f.bind()
    expect(f.request).toHaveBeenCalledOnce()
    await f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))
    expect(f.request).toHaveBeenCalledOnce()
    expect(() => f.producer.bind(original, { kind: 'original-remote-physical' }, f.owner, f.lifetime))
      .toThrowError(expect.objectContaining({
        code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'main_lifetime' },
      }))
    await f.sqlConnection.transaction(async sql=>{
      await expect(f.producer.assertOriginal(sql,f.owner,JSON.parse(JSON.stringify(original)))).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    })
    await f.sqlConnection.close()
  })
  it.each(['provider-generation','source-receipt','runtime-leaf','unconfirmed-closure','output-artifact','signed-binding'] as const)('rejects %s before issuing Main physical proof',async defect=>{
    const f=await physicalFixture()
    if(defect==='provider-generation')f.readout.observation.provider.startTicks='different-native-generation'
    if(defect==='source-receipt')f.readout.source.record.receipt.executionId='foreign-execution'
    if(defect==='runtime-leaf')f.readout.runtimeLeaf.operationId='foreign-operation'
    if(defect==='unconfirmed-closure')f.readout.observation.lifecycle='closure-unconfirmed'
    if(defect==='output-artifact')f.readout.output={kind:'text-only',result:{outcome:'succeeded',output:{fileId:'invented-result-file'}}}
    if(defect==='signed-binding')f.currentBinding.mockReturnValue({...f.context.binding,connectionGeneration:4})
    if(defect==='source-receipt'||defect==='runtime-leaf') {
      const original=await f.bind()
      await expect(f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    } else await expect(f.producer.prefetch(f.readout.receipt,f.placement,f.source)).rejects.toThrow()
    await f.sqlConnection.close()
  })
  it.each(['entry-reservation','main-lane-token','main-lane-turn','main-lane-expiry','current-binding','coordinator-owner'] as const)('rejects changed %s through SQL-only final verification',async defect=>{
    const f=await physicalFixture(),original=await f.bind()
    if(defect==='entry-reservation')f.entry.reservation.execution.attempt++
    if(defect==='main-lane-token')f.lane.token='replacement-native-lane-token'
    if(defect==='main-lane-turn')f.lane.provider_id='other-native-turn'
    if(defect==='main-lane-expiry')f.lane.held=false
    if(defect==='current-binding')f.currentBinding.mockReturnValue({...f.context.binding,connectionGeneration:4})
    if(defect==='coordinator-owner')vi.mocked(f.lifetime.assertCurrent).mockImplementation(()=>{throw new Error('Actual coordinator lifetime ended')})
    await expect(f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))).rejects.toThrow()
    expect(f.request).toHaveBeenCalledOnce()
    await f.sqlConnection.close()
  })
})

describe('bounded physical readout retention and actual terminal correlation',()=>{
  it('expires originals without selecting current/latest data',async()=>{
    const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts(),now=Date.now()
    readouts.remember({readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',assertOwnerCurrent:async()=>{},assertCurrent:async()=>{},
      observe:()=>f.captured.launch,closure:()=>null})
    vi.spyOn(Date,'now').mockReturnValue(now+60_001)
    await expect(readouts.read({intent:f.intent,placement:f.placement,receiptSequence:f.readout.receipt.sequence,sourceDigest:remoteWorkflowSourceDigest(f.source)})).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    await f.sqlConnection.close()
  })
  it('refuses a 129th retained original for one operation instead of silently inventing eviction readback',async()=>{
    const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts()
    for(let index=0;index<128;index++) {
      const source={type:'history' as const,history:{...f.source.history,nextSequence:index}}
      readouts.remember({readout:{...f.readout,history:source.history},placement:f.placement,source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',
        assertOwnerCurrent:async()=>{},assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})
    }
    const source={type:'history' as const,history:{...f.source.history,nextSequence:128}}
    expect(()=>readouts.remember({readout:{...f.readout,history:source.history},placement:f.placement,source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',
      assertOwnerCurrent:async()=>{},assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})).toThrow('retention is full')
    await f.sqlConnection.close()
  })
  it.each(['matching','closure-digest','result-digest','foreign-result','missing-positive-closure','foreign-closure-launch'] as const)('requires original provider + positive closure + exact text output for %s terminal proof',async defect=>{
    const f=await physicalFixture(),result={outcome:'succeeded' as const,output:{text:'Actual provider text in the unit terminal snapshot.'}}
    const history={...f.source.history,terminalTurn:{correlationId:`execution:${f.intent.executionId}`,providerId:'original-turn',result}}
    const manager=new CodexAppServerSessionManager('/never-executed/unit/codex')
    vi.spyOn(manager,'close').mockResolvedValue(undefined);vi.spyOn(f.registry,'closeRegistration').mockResolvedValue(undefined);vi.spyOn(f.registry,'closeOwner').mockResolvedValue(true)
    const terminal=await settleInstalledWorkflowNativeOwner({journal:f.journal,registry:f.registry,intent:f.intent,history,captured:f.captured,manager,session:f.session})
    if(!terminal)throw new Error('Expected exact unit consumer closure receipt')
    await f.journal.terminal(f.intent.operationId,terminal)
    const status=await f.journal.status(f.intent.operationId)
    if(status.status!=='known')throw new Error('Expected retained unit terminal')
    const closed={...f.captured.launch,lifecycle:'closed' as const,closureEvidence:'cgroup_v2_empty' as const}
    f.readout.receipt=status.receipt;f.readout.history=history;f.source.history=history
    f.readout.observation=RemoteWorkflowPhysicalReadoutSchema.shape.observation.parse(closed)
    f.readout.closure={ownerClosed:true,launch:f.readout.observation};f.readout.output={kind:'text-only',result}
    if(defect==='closure-digest')f.readout.receipt.terminal!.closureEvidenceDigest='d'.repeat(64)
    if(defect==='result-digest')f.readout.receipt.terminal!.resultDigest='d'.repeat(64)
    if(defect==='foreign-result')f.readout.output.result={outcome:'succeeded',output:{text:'Other provider result'}}
    if(defect==='missing-positive-closure')delete f.readout.closure
    if(defect==='foreign-closure-launch')f.readout.closure!.launch={...f.readout.observation,launchId:randomUUID()}
    if(defect==='matching') {
      const original=await f.bind()
      await f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))
      expect(f.request).toHaveBeenCalledOnce()
    } else await expect(f.producer.prefetch(f.readout.receipt,f.placement,f.source)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    await f.sqlConnection.close()
  })
})

it('bounds the global original-source byte window and frees it only through explicit purge',async()=>{
  const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts()
  let accepted=0
  for(let index=0;index<128;index++) {
    const history={...f.source.history,nextSequence:index,terminalResult:{outcome:'succeeded' as const,output:{text:'x'.repeat(800_000)}}}
    try {
      readouts.remember({readout:{...f.readout,history},placement:f.placement,source:{type:'history',history},leaseExpiresAt:'2099-01-01T00:00:00.000Z',
        assertOwnerCurrent:async()=>{},assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})
      accepted++
    } catch(error) {
      expect(error).toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_BACKPRESSURE'})
      break
    }
  }
  expect(accepted).toBeGreaterThan(0);expect(accepted).toBeLessThan(128)
  readouts.purge(f.intent.operationId)
  expect(()=>readouts.remember({readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',
    assertOwnerCurrent:async()=>{},assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})).not.toThrow()
  await f.sqlConnection.close()
})
it('cannot retain an expired original application lease or use prefetched proof beyond its signed expiry in SQL',async()=>{
  const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts()
  expect(()=>readouts.remember({readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2020-01-01T00:00:00.000Z',
    assertOwnerCurrent:async()=>{},assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})).toThrow('unavailable')
  const original=await f.bind()
  vi.spyOn(Date,'now').mockReturnValue(Date.parse(f.readout.expiresAt)+1)
  await expect(f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  expect(f.request).toHaveBeenCalledOnce()
  await f.sqlConnection.close()
})

describe('original physical directory revalidation after native closure',()=>{
  it.each(['', 'src'])('bounds authorization requests and their injected latency for cwd %j', async relativeCwd => {
    const f = await physicalFixture(relativeCwd)
    let authorizationLatency = 0
    const authorize = vi.fn(async () => {
      authorizationLatency += 25
      await new Promise(resolve => setTimeout(resolve, 25))
    })
    const assertCurrent = vi.fn(() => {})
    const started = performance.now()
    await assertOriginalPhysicalDirectories({ source: f.readout.source, runtimeLeaf: f.readout.runtimeLeaf,
      placement: f.placement, approvedRoots: f.approvedRoots, signal: new AbortController().signal,
      assertCurrent, authorize })
    const elapsed = performance.now() - started
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(authorizationLatency).toBe(50)
    expect(elapsed).toBeGreaterThanOrEqual(45)
    expect(assertCurrent.mock.calls.length).toBeGreaterThan(20)
    await f.sqlConnection.close()
  })
  it.each(['connection', 'abort'] as const)('stops a physical inspection when its local %s fence changes', async defect => {
    const f = await physicalFixture('src')
    const controller = new AbortController()
    const authorize = vi.fn(async () => {})
    let checks = 0
    const assertCurrent = () => {
      if (++checks === 4) {
        if (defect === 'abort') controller.abort(new Error('Original readout aborted'))
        else throw new Error('Original connection changed during filesystem inspection')
      }
    }
    await expect(assertOriginalPhysicalDirectories({ source: f.readout.source, runtimeLeaf: f.readout.runtimeLeaf,
      placement: f.placement, approvedRoots: f.approvedRoots, signal: controller.signal,
      assertCurrent, authorize })).rejects.toThrow()
    expect(authorize).toHaveBeenCalledOnce()
    await f.sqlConnection.close()
  })
  it('refuses the inspection when Main denies its initial authorization', async () => {
    const f = await physicalFixture()
    const authorize = vi.fn(async () => { throw new Error('Original Main read authority revoked') })
    await expect(assertOriginalPhysicalDirectories({ source: f.readout.source, runtimeLeaf: f.readout.runtimeLeaf,
      placement: f.placement, approvedRoots: f.approvedRoots, signal: new AbortController().signal,
      assertCurrent: () => {}, authorize })).rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
    expect(authorize).toHaveBeenCalledOnce()
    await f.sqlConnection.close()
  })
  it('keeps original W09 identities while observing edited bytes without granting mutable continuation',async()=>{
    const f=await physicalFixture('src'),authorize=vi.fn(async()=>{})
    await writeFile(join(f.readout.source.workingTree.canonicalCwd,'source.ts'),'Actual allowed native-edited output bytes\n')
    await assertOriginalPhysicalDirectories({source:f.readout.source,runtimeLeaf:f.readout.runtimeLeaf,placement:f.placement,
      approvedRoots:f.approvedRoots,signal:new AbortController().signal,assertCurrent:()=>{},authorize})
    expect(authorize).toHaveBeenCalledTimes(2)
    // The original strict-byte W09 mode remains fenced; physical directory readback never changes its ownership or byte policy.
    await expect(f.sources.handle({version:1,operation:'sources.verify',record:f.nativePlacement.materialization,relativeCwd:'src'},f.context)).rejects.toThrow()
    await f.sqlConnection.close()
  })
  it.each(['source-root','source-tree','source-child-cwd','runtime-root','runtime-leaf','runtime-marker','missing-cwd'] as const)('fails unavailable for replaced or absent %s',async defect=>{
    const f=await physicalFixture('src')
    if(defect==='runtime-marker')await writeFile(join(f.readout.runtimeLeaf.canonicalRuntimeDirectory,'.graphql-workflow-runtime.json'),JSON.stringify({...f.readout.runtimeLeaf,operationId:'different-operation'}))
    else if(defect==='missing-cwd')await rm(f.readout.source.workingTree.canonicalCwd,{recursive:true})
    else {
      const path=defect==='source-root'?f.readout.source.record.receipt.binding.canonicalPath
        :defect==='source-tree'?f.readout.source.workingTree.canonicalProjectRoot
          :defect==='source-child-cwd'?f.readout.source.workingTree.canonicalCwd
            :defect==='runtime-root'?f.approvedRoots.managedRuntimeRoot:f.readout.runtimeLeaf.canonicalRuntimeDirectory
      await rename(path,`${path}-original`);await mkdir(path,{mode:0o700})
    }
    await expect(assertOriginalPhysicalDirectories({source:f.readout.source,runtimeLeaf:f.readout.runtimeLeaf,placement:f.placement,
      approvedRoots:f.approvedRoots,signal:new AbortController().signal,assertCurrent:()=>{},authorize:async()=>{}})).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    await f.sqlConnection.close()
  })
  it('rechecks authority before releasing a physical readout',async()=>{
    const f=await physicalFixture('src'),authorize=vi.fn(async()=>{})
    authorize.mockImplementationOnce(async()=>{}).mockImplementationOnce(async()=>{throw new Error('Original Main read authority revoked after FD open')})
    await expect(assertOriginalPhysicalDirectories({source:f.readout.source,runtimeLeaf:f.readout.runtimeLeaf,placement:f.placement,
      approvedRoots:f.approvedRoots,signal:new AbortController().signal,assertCurrent:()=>{},authorize})).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    expect(authorize).toHaveBeenCalledTimes(2)
    await f.sqlConnection.close()
  })
})

it('resolves actual original per-event selectors from the frozen reply instead of a later history snapshot',async()=>{
  const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts()
  const event={sequence:1,connectionId:'unit-original-native-connection',type:'native.notification',occurredAt:new Date().toISOString(),payload:{value:'original-provider-event'}}
  const source={type:'history' as const,history:{...f.source.history,events:[event]}}
  const readout={...f.readout,history:source.history}
  readouts.remember({readout,placement:f.placement,source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',assertOwnerCurrent:async()=>{},assertCurrent:async()=>{},
    observe:()=>f.captured.launch,closure:()=>null})
  const selected={type:'event' as const,event:{...event,executionId:f.intent.executionId}}
  const selector={intent:f.intent,placement:f.placement,receiptSequence:readout.receipt.sequence,sourceDigest:remoteWorkflowSourceDigest(selected)}
  event.payload.value='later-mutated-value'
  expect((await readouts.read(selector)).history?.events[0]?.payload.value).toBe('original-provider-event')
  await expect(readouts.read({...selector,sourceDigest:remoteWorkflowSourceDigest({type:'event',event:{...selected.event,executionId:'foreign-execution'}})})).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  await f.sqlConnection.close()
})

it('retires only an authenticated exact original reply and leaves journal/native outcomes unchanged',async()=>{
  const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts(),assertCurrent=vi.fn(async()=>{})
  readouts.remember({readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',assertOwnerCurrent:assertCurrent,assertCurrent,
    observe:()=>f.captured.launch,closure:()=>null})
  const selector={intent:f.intent,placement:f.placement,receiptSequence:f.readout.receipt.sequence,sourceDigest:remoteWorkflowSourceDigest(f.source)}
  await expect(readouts.ack({...selector,intent:{...f.intent,attemptId:'different-attempt'}})).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  expect(await readouts.read(selector)).toEqual(f.readout)
  expect(await readouts.ack(selector)).toMatchObject({status:'retired',sourceDigest:selector.sourceDigest,receiptSequence:selector.receiptSequence})
  expect(await readouts.ack(selector)).toMatchObject({status:'not_retained'})
  await expect(readouts.read(selector)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  expect(await f.journal.status(f.intent.operationId)).toEqual({status:'known',receipt:f.readout.receipt})
  expect(f.registry.snapshot().launches[0]!.lifecycle).toBe('active')
  await f.sqlConnection.close()
})

it.each(['same', 'overlapping'] as const)('refreshes event observations from a fresh %s authenticated history', async kind => {
  const f = await physicalFixture()
  const readouts = new InstalledWorkflowPhysicalReadouts()
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const event = { sequence: 1, type: 'native.notification', occurredAt: new Date(now).toISOString(),
    payload: { value: 'original event' } }
  const history = { ...f.source.history, events: [event] }
  const source = { type: 'history' as const, history }
  const observation = {
    readout: { ...f.readout, history, expiresAt: new Date(now + 60_000).toISOString() },
    placement: f.placement, source, leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    assertOwnerCurrent: async () => {}, assertCurrent: async () => {},
    observe: () => f.captured.launch, closure: () => null,
  }
  readouts.remember(observation)
  clock.mockReturnValue(now + 50_000)
  const refreshed = kind === 'same' ? history : { ...history, nextSequence: 2 }
  readouts.remember({ ...observation,
    source: { type: 'history', history: refreshed },
    readout: { ...observation.readout, history: refreshed, expiresAt: new Date(now + 110_000).toISOString() },
  })
  clock.mockReturnValue(now + 65_000)
  const selected = { type: 'event' as const, event: { ...event, executionId: f.intent.executionId } }
  const result = await readouts.read({ intent: f.intent, placement: f.placement,
    receiptSequence: f.readout.receipt.sequence, sourceDigest: remoteWorkflowSourceDigest(selected) })
  expect(result.history?.events[0]?.payload.value).toBe('original event')
  expect(result.expiresAt).toBe(new Date(now + 110_000).toISOString())
  await f.sqlConnection.close()
})

it('authorizes observation retirement without reopening an already published physical source', async () => {
  const f = await physicalFixture()
  const readouts = new InstalledWorkflowPhysicalReadouts()
  const physical = vi.fn(async () => {})
  const owner = vi.fn(async () => {})
  const observation = { readout: f.readout, placement: f.placement, source: f.source,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z', assertOwnerCurrent: owner, assertCurrent: physical,
    observe: () => f.captured.launch, closure: () => null }
  const selector = { intent: f.intent, placement: f.placement, receiptSequence: f.readout.receipt.sequence,
    sourceDigest: remoteWorkflowSourceDigest(f.source) }
  readouts.remember(observation)
  expect(await readouts.read(selector)).toEqual(f.readout)
  physical.mockRejectedValue(new Error('Physical source is no longer readable'))
  expect(await readouts.ack(selector)).toMatchObject({ status: 'retired' })
  readouts.remember(observation)
  await expect(readouts.read(selector)).rejects.toThrow('Physical source is no longer readable')
  readouts.remember(observation)
  owner.mockRejectedValue(new Error('Original owner revoked'))
  await expect(readouts.ack(selector)).rejects.toThrow('Original owner revoked')
  expect(await f.journal.status(f.intent.operationId)).toEqual({ status: 'known', receipt: f.readout.receipt })
  await f.sqlConnection.close()
})
it('cannot ACK physical packet delivery or precommit verification; only the exact durable canonical source permits ACK',async()=>{
  const f=await physicalFixture(),original=await f.bind()
  await expect(f.producer.acknowledge(original)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  await f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))
  await expect(f.producer.acknowledge(original)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  f.canonicalProofs.push({record:{execution:repeatExecutionIdentity(f.execution),session:f.session,original:f.source}})
  await f.sqlConnection.transaction(async sql=>{
    await f.producer.assertOriginal(sql,f.owner,original)
    await expect(f.producer.acknowledge(original)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  })
  f.request.mockImplementation(async payload=>{
    const input=payload as {method:string;receiptSequence:number;sourceDigest:string}
    expect(input.method).toBe('physical-ack')
    return {payload:{version:1,operationId:f.intent.operationId,receiptSequence:input.receiptSequence,sourceDigest:input.sourceDigest,status:'retired'}}
  })
  expect(await f.producer.acknowledge(original)).toMatchObject({status:'retired',sourceDigest:original.sourceDigest})
  expect(await f.producer.acknowledgeReply(original)).toMatchObject({status:'retired'})
  await f.sqlConnection.close()
})
it('retains proof when the owning canonical transaction rolls back instead of sending a false durable ACK',async()=>{
  const f=await physicalFixture(),original=await f.bind()
  f.canonicalProofs.push({record:{execution:repeatExecutionIdentity(f.execution),session:f.session,original:f.source}})
  await expect(f.sqlConnection.transaction(async sql=>{await f.producer.assertOriginal(sql,f.owner,original);throw new Error('Canonical publication rolled back')})).rejects.toThrow('rolled back')
  await expect(f.producer.acknowledge(original)).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  expect(f.request).toHaveBeenCalledOnce()
  await f.sqlConnection.close()
})


describe('passive original remote telemetry precision, no native or database IO', () => {
  it('returns only the privately bound original owner and authenticated binding without IO', async () => {
    const f = await physicalFixture(), original = await f.bind()
    const passive = f.producer.passiveNativeOwner(original)!
    expect(passive.nativeOwner).toBe(f.readout.launch.owner)
    expect(passive.native).toEqual(f.readout.receipt.native)
    expect(passive.binding).toEqual(f.context.binding)
    passive.native.sessionId = 'mutated-readback'
    expect(f.producer.passiveNativeOwner(original)!.native.sessionId).toBe(f.session.nativeSessionId)
    passive.assertCurrent()
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.query).not.toHaveBeenCalled()
    expect(f.producer.passiveNativeOwner({ ...original })).toBeUndefined()
    await f.sqlConnection.close()
  })
  it.each(['expired', 'revoked', 'original-binding'] as const)('withdraws %s precision and invalidates captured fences', async defect => {
    const f = await physicalFixture(), original = await f.bind(), passive = f.producer.passiveNativeOwner(original)!
    if (defect === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.readout.expiresAt) + 1)
    if (defect === 'revoked') vi.mocked(f.lifetime.assertCurrent).mockImplementation(() => { throw new Error('Original writer revoked') })
    if (defect === 'original-binding') f.currentBinding.mockReturnValue({ ...f.context.binding, connectionEpoch: randomUUID() })
    expect(f.producer.passiveNativeOwner(original)).toBeUndefined()
    expect(() => passive.assertCurrent()).toThrow()
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.query).not.toHaveBeenCalled()
    await f.sqlConnection.close()
  })
})
