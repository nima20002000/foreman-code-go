import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile, access,rename } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion, type NativeSessionReference } from '@graphql/contracts'
import { DispatchIntentSchema } from '@graphql/contracts/node-placement'
import { DeviceConnectionIdentitySchema } from '@graphql/contracts/device-identity'
import { CodexAppServerSessionManager } from '../../harnesses/codexAppServer.js'
import { NativeProcessRegistry, type NativeLaunchObservation } from '../../harnesses/recovery/processRegistry.js'
import { bootIdentity } from '../../harnesses/recovery/linuxIdentity.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { readInstalledWorkflowConfiguration } from './installedWorkflowConfiguration.js'
import { captureInstalledWorkflowNativeOwner, settleInstalledWorkflowNativeOwner, createInstalledWorkflowHost, attestInstalledWorkflowRuntimeLeaf, type InstalledWorkflowHostOptions } from './installedWorkflowHost.js'
import { SourceOperationWorkerService } from '../../sources/operationWorker.js'
import { PrivateSourceMaterializer } from '../../sources/materialization.js'
import { createSourceManifest, sourceSha256 } from '../../sources/manifest.js'
import { sourceBindingHash } from '../../sources/bindingHash.js'
import { identity, openPrivateRoot } from '../../sources/privateFilesystem.js'
import { verifyMaterializedWorkingDirectory } from '../../sources/workingDirectory.js'
import { freezePlacement, deriveDispatch } from '../../placement/binding.js'
import { bindNativeExecution } from '../../placement/executionBinding.js'
import type { SourceRootRecord, SourceMaterializationRecord } from '@graphql/contracts/source-admission'
import type { SourceOperationOwner } from '@graphql/contracts/source-operations'
import type { DeviceSessionBinding } from '@graphql/contracts/device-connection'
import type { ApprovedRootAllowlist } from '@graphql/contracts/workspace-root-policies'
import type { DeviceApplicationResult } from '@graphql/contracts/device-application'
import { negotiateDeviceExtensions } from '@graphql/contracts/device-application'
import { EXECUTION_AUTHORITY_EXTENSION } from '@graphql/contracts/execution-authority'
import { WORKER_MCP_EXTENSION } from '@graphql/contracts/worker-mcp-relay'
import type { HarnessExecution } from '@graphql/contracts'
import type pg from 'pg'
import { InstalledWorkflowPhysicalReadouts, matchingOriginalRegistryLaunch, remoteWorkflowSourceDigest,assertOriginalPhysicalDirectories } from './workflowPhysicalReadout.js'
import { createRemoteWorkflowPhysicalVerification, type RemoteWorkflowMainLifetime } from './workflowPhysicalVerification.js'
import { RemoteWorkflowPhysicalReadoutSchema } from '@graphql/contracts/remote-workflow-physical'
import { createRemoteNativeSourceChannel } from '../../placement/remoteNativeSource.js'
import { VerifiedRemoteEvidence } from './resultBridge.js'
import { ExclusiveGraphConnection } from '../../run-graph/connection.js'
import { repeatExecutionIdentity } from '../repeatResolution.js'

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
      const { connectionEpoch: _epoch, ...connection } = f.context.binding
      await retainedJournal!.accept(f.intent, connection, randomUUID())
      expect(await host.preparationClosed({ ...f.owner, preparationKind: 'workflow', preparationClosed: true })).toBe(true)
      expect(await retainedJournal!.status(f.intent.operationId)).toMatchObject({
        status: 'known', receipt: { phase: 'confirmed_terminal', entryAttempted: false, terminal: { kind: 'not_started' } },
      })
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
      currentBinding.mockReturnValue({...f.context.binding,connectionGeneration:4})
      await expect(handler({method:'status',intent:f.intent,placement:f.placement},f.context)).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
    } finally {await host.close(); await retainedJournal?.close()}
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
  it('retains the exact earlier source, never reconstructs latest history, and expires/purges selectors',async()=>{
    const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts(),assertCurrent=vi.fn(async()=>{})
    const input={readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',assertCurrent,
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
    expect(()=>f.producer.bind(original,{kind:'original-remote-physical'},f.owner,f.lifetime)).toThrow('Actual authenticated')
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
    readouts.remember({readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',assertCurrent:async()=>{},
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
        assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})
    }
    const source={type:'history' as const,history:{...f.source.history,nextSequence:128}}
    expect(()=>readouts.remember({readout:{...f.readout,history:source.history},placement:f.placement,source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',
      assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})).toThrow('retention is full')
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
        assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})
      accepted++
    } catch(error) {
      expect(error).toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_BACKPRESSURE'})
      break
    }
  }
  expect(accepted).toBeGreaterThan(0);expect(accepted).toBeLessThan(128)
  readouts.purge(f.intent.operationId)
  expect(()=>readouts.remember({readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',
    assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})).not.toThrow()
  await f.sqlConnection.close()
})
it('cannot retain an expired original application lease or use prefetched proof beyond its signed expiry in SQL',async()=>{
  const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts()
  expect(()=>readouts.remember({readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2020-01-01T00:00:00.000Z',
    assertCurrent:async()=>{},observe:()=>f.captured.launch,closure:()=>null})).toThrow('unavailable')
  const original=await f.bind()
  vi.spyOn(Date,'now').mockReturnValue(Date.parse(f.readout.expiresAt)+1)
  await expect(f.sqlConnection.transaction(sql=>f.producer.assertOriginal(sql,f.owner,original))).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
  expect(f.request).toHaveBeenCalledOnce()
  await f.sqlConnection.close()
})

describe('original physical directory revalidation after native closure',()=>{
  it('keeps original W09 identities while observing edited bytes without granting mutable continuation',async()=>{
    const f=await physicalFixture('src'),authorize=vi.fn(async()=>{})
    await writeFile(join(f.readout.source.workingTree.canonicalCwd,'source.ts'),'Actual allowed native-edited output bytes\n')
    await assertOriginalPhysicalDirectories({source:f.readout.source,runtimeLeaf:f.readout.runtimeLeaf,placement:f.placement,
      approvedRoots:f.approvedRoots,signal:new AbortController().signal,authorize})
    expect(authorize.mock.calls.length).toBeGreaterThan(2)
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
      approvedRoots:f.approvedRoots,signal:new AbortController().signal,authorize:async()=>{}})).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    await f.sqlConnection.close()
  })
  it('rechecks authority after opening original FDs and never turns lost authority into a readback capability',async()=>{
    const f=await physicalFixture('src'),authorize=vi.fn(async()=>{})
    authorize.mockImplementationOnce(async()=>{}).mockImplementationOnce(async()=>{throw new Error('Original Main read authority revoked after FD open')})
    await expect(assertOriginalPhysicalDirectories({source:f.readout.source,runtimeLeaf:f.readout.runtimeLeaf,placement:f.placement,
      approvedRoots:f.approvedRoots,signal:new AbortController().signal,authorize})).rejects.toMatchObject({code:'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE'})
    await f.sqlConnection.close()
  })
})

it('resolves actual original per-event selectors from the frozen reply instead of a later history snapshot',async()=>{
  const f=await physicalFixture(),readouts=new InstalledWorkflowPhysicalReadouts()
  const event={sequence:1,connectionId:'unit-original-native-connection',type:'native.notification',occurredAt:new Date().toISOString(),payload:{value:'original-provider-event'}}
  const source={type:'history' as const,history:{...f.source.history,events:[event]}}
  const readout={...f.readout,history:source.history}
  readouts.remember({readout,placement:f.placement,source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',assertCurrent:async()=>{},
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
  readouts.remember({readout:f.readout,placement:f.placement,source:f.source,leaseExpiresAt:'2099-01-01T00:00:00.000Z',assertCurrent,
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
