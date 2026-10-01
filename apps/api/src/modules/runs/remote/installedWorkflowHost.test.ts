import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile, access } from 'node:fs/promises'
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

async function sourceFixture() {
  const root=await directory(),runtime=join(root,'runtime'),project=join(root,'project'),namespace=join(runtime,'source-materializations',randomUUID())
  await mkdir(runtime,{mode:0o700});await mkdir(project,{mode:0o700});await mkdir(namespace,{recursive:true,mode:0o700})
  const fsIdentity=async(path:string)=>{const handle=await openPrivateRoot(path);try{return await identity(handle)}finally{await handle.close()}}
  const binding:DeviceSessionBinding={mainId:randomUUID(),deviceId:randomUUID(),workerInstallationId:randomUUID(),bootId:bootIdentity(),
    keyRevision:1,authorizationRevision:1,connectionEpoch:randomUUID(),connectionGeneration:3}
  const approvedRoots:ApprovedRootAllowlist={schemaVersion:1,hostRef:{kind:'device',mainId:binding.mainId,deviceId:binding.deviceId},
    applicationInstallationId:binding.workerInstallationId,configurationRevision:'1',bases:[{baseId:randomUUID(),canonicalPath:project,filesystem:await fsIdentity(project),accessModes:['read-only']}],
    managedRuntimeRoot:runtime,runtimeFilesystem:await fsIdentity(runtime)}
  const bytes=Buffer.from('export const fixture = true\n'),manifest=createSourceManifest({version:1,snapshotId:randomUUID(),approvedSourceId:randomUUID(),
    capturePolicy:'exclusive-explicit-bytes-v1',executablePolicy:'strip',deletions:[],entries:[{path:'source.ts',kind:'file',byteSize:bytes.length,sha256:sourceSha256(bytes),executable:false}]})
  const source={approvedSourceId:manifest.approvedSourceId,snapshotId:manifest.snapshotId,manifestDigest:manifest.manifestDigest},rootPolicyId=namespace.split('/').at(-1)!
  const sourceRoot:SourceRootRecord={version:1,source,selection:{hostRef:approvedRoots.hostRef,rootPolicyId,rootPolicyRevision:'1',locationRevision:'1'},
    binding:{version:1,mainId:binding.mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,workspaceId:'workspace',rootId:randomUUID(),bindingRevision:1,
      locationRevision:1,canonicalPath:namespace,filesystem:await fsIdentity(namespace),accessMode:'exclusive-write',snapshotId:manifest.snapshotId,manifestDigest:manifest.manifestDigest},
    ownerPrincipalId:'owner',authorizedByPrincipalId:'owner',registration:{workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1},
    attestationId:'attestation',attestationDigest:'a'.repeat(64),boundAt:new Date().toISOString()}
  const placement=freezePlacement({schemaVersion:1,mainId:binding.mainId,mainInstallationId:binding.mainId,runId:'run',nodeId:'node',hostRef:approvedRoots.hostRef,registration:sourceRoot.registration,
    destination:{canonicalProjectRoot:project,canonicalCwd:project,managedRuntimeRoot:runtime,directoryIdentityHash:'a'.repeat(64),rootPolicyId,rootPolicyRevision:'1',locationRevision:'1',attestationId:'attestation',attestationHash:'a'.repeat(64)},
    source:{kind:'pending',...source,revisionId:'revision',rootId:sourceRoot.binding.rootId,bindingRevision:1,materializationId:null,materializationDigest:null},
    payload:{kind:'agent',agentId:'agent',agentConfigurationVersionId:'configuration',driverId:'codex',driverRevision:'1',instanceId:randomUUID(),instanceRevision:'1',harnessInstallationId:'installed-codex',installationFingerprint:'a'.repeat(64),runtimeContractVersion:1,protocolRevision:'codex-native-adapter-v1',credentialScopeRefs:[]}})
  const intent=deriveDispatch(placement,{executionId:'execution',attemptId:'attempt',operationId:'operation',technicalAttempt:1,occurrenceId:null,occurrenceIndex:0,inputDigest:`sha256:${'b'.repeat(64)}`,owner:{grantId:'grant',epoch:'1'}})
  const attempt={executionId:intent.executionId,attemptId:intent.attemptId,keyRevision:1,authorizationRevision:1,placementHash:''}
  attempt.placementHash=sourceBindingHash(sourceRoot,attempt,intent.operationId)
  const receipt=await new PrivateSourceMaterializer({read:async()=>bytes},async()=>undefined).prepare({manifest,binding:sourceRoot.binding,attempt,signal:new AbortController().signal})
  const record:SourceMaterializationRecord={receipt,rootPolicyId,rootPolicyRevision:'1',operationId:intent.operationId,reservationId:randomUUID(),sourceBindingHash:attempt.placementHash,finalDispatchBindingHash:null,state:'prepared'}
  const workingTree=await verifyMaterializedWorkingDirectory(record,'',async()=>undefined)
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
    const options:InstalledWorkflowHostOptions={stateDirectory:f.root,pairing:{formatVersion:1,mainId:f.context.binding.mainId,deviceId:f.context.binding.deviceId,
      workerInstallationId:f.context.binding.workerInstallationId,keyRevision:1,authorizationRevision:1,endpoint:'wss://unit.invalid/device',mainPublicKeyFingerprint:'a'.repeat(64),credential:'b'.repeat(64),expiresAt:'2099-01-01T00:00:00.000Z'},
      bootId:f.context.binding.bootId,configuration:{path:file,ownerUid:process.getuid!()},currentBinding,captureRequest:()=>({binding:f.context.binding,request:readMain}),
      sources:f.sources,approvedRoots:async()=>f.approvedRoots,codexSuiteRevision:'codex-live-4',signal:new AbortController().signal}
    const host=await createInstalledWorkflowHost(options)
    expect(host.kind).toBe('configured')
    if(host.kind!=='configured')throw new Error('Expected unit configured code support')
    try {
      const handler=host.extensions[0]!.handle!
      await expect(handler({method:'prepare',intent:f.intent,placement:f.placement,request:f.request,executionPlacement:f.nativePlacement},f.context)).rejects.toThrow('Actual Main qualification is unavailable')
      expect(readMain).toHaveBeenCalledOnce()
      expect(reserve).not.toHaveBeenCalled();expect(create).not.toHaveBeenCalled()
      await expect(access(join(f.root,'workflow-operations.json'))).rejects.toThrow()
      currentBinding.mockReturnValue({...f.context.binding,connectionGeneration:4})
      await expect(handler({method:'status',intent:f.intent,placement:f.placement},f.context)).rejects.toMatchObject({code:'WORKER_WORKFLOW_UNAVAILABLE'})
    } finally {await host.close()}
  })
})
