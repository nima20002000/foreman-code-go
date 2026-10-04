import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { constants } from 'node:fs'
import { open,realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DispatchIntent, AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { RemoteWorkflowPhysicalReadoutSchema,RemoteWorkflowPhysicalAckSchema, type RemoteWorkflowPhysicalReadout,type RemoteWorkflowPhysicalAck } from '@foreman-code/contracts/remote-workflow-physical'
import type { WorkflowOriginalNativeSource } from '../../interactions/workflowNativeCapture.js'
import type { NativeLaunchObservation, NativeProcessRegistry } from '../../harnesses/recovery/processRegistry.js'
import { DomainError } from '../../errors.js'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { anchored,identity,openChildDirectory,openPrivateRoot } from '../../sources/privateFilesystem.js'
import { sourcePath } from '../../sources/manifest.js'
import { sourceCwdAttestationDigest } from '../../sources/workingDirectory.js'
import { RuntimeLeafAttestationSchema,assertRuntimeLeafPath } from './runtimeLeaf.js'
import type { NativeHistory } from '../../harnesses/port.js'

const unavailable = (): never => { throw new DomainError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', 'The original installed native source and physical observations are unavailable.', 409) }
function freezeTree<T>(value:T):T {
  if(value!==null&&typeof value==='object') {Object.freeze(value);for(const child of Object.values(value))freezeTree(child)}
  return value
}
export function remoteWorkflowSourceDigest(source: WorkflowOriginalNativeSource): string {
  return createHash('sha256').update(canonicalGraphJson(source, 4 * 1024 * 1024)).digest('hex')
}
export function remoteWorkflowNativeHistory(value:NonNullable<RemoteWorkflowPhysicalReadout['history']>):NativeHistory {
  return {events:value.events,pendingInteractions:value.pendingInteractions,
    ...(value.nativeSubmission!==undefined?{nativeSubmission:value.nativeSubmission}:{}),
    ...(value.correlationId!==undefined?{correlationId:value.correlationId}:{}),...(value.nativeTurnId!==undefined?{nativeTurnId:value.nativeTurnId}:{}),
    ...(value.nativeMessageId!==undefined?{nativeMessageId:value.nativeMessageId}:{}),...(value.nextCursor!==undefined?{nextCursor:value.nextCursor}:{}),
    ...(value.firstRetainedSequence!==undefined?{firstRetainedSequence:value.firstRetainedSequence}:{}),...(value.nextSequence!==undefined?{nextSequence:value.nextSequence}:{}),
    ...(value.gap!==undefined?{gap:value.gap}:{}),
    ...(value.pendingInteraction!==undefined?{pendingInteraction:value.pendingInteraction}:{}),...(value.terminalResult!==undefined?{terminalResult:value.terminalResult}:{}),
    ...(value.terminalTurn!==undefined?{terminalTurn:value.terminalTurn}:{}),...(value.canceledRequestIds!==undefined?{canceledRequestIds:value.canceledRequestIds}:{}),
    ...(value.interactionDeliveries!==undefined?{interactionDeliveries:value.interactionDeliveries.map(item=>({nativeRequestId:item.nativeRequestId,state:item.state,
      ...(item.selectedOptionId!==undefined?{selectedOptionId:item.selectedOptionId}:{})}))}:{}),
    ...(value.responseDeliveries!==undefined?{responseDeliveries:value.responseDeliveries}:{}),
  }
}
export function remoteWorkflowProcessDigest(connection: RemoteOperationReceipt['connection'], intent: DispatchIntent,
  launch: Pick<NativeLaunchObservation,'owner'|'launchId'|'bootId'|'guardian'|'provider'|'boundary'>): string {
  return commandInputHash({ connection, intent, owner: launch.owner, launchId: launch.launchId,
    bootId: launch.bootId, guardian: launch.guardian, provider: launch.provider, boundary: launch.boundary }).slice('sha256:'.length)
}
export function matchingOriginalRegistryLaunch(registry: NativeProcessRegistry, launch: NativeLaunchObservation): NativeLaunchObservation {
  const observed = registry.snapshot().launches.find(value => value.launchId === launch.launchId)
  if (!observed || observed.owner !== launch.owner || observed.bootId !== launch.bootId
    || !isDeepStrictEqual(observed.guardian, launch.guardian) || !isDeepStrictEqual(observed.provider, launch.provider)
    || !isDeepStrictEqual(observed.boundary, launch.boundary)) return unavailable()
  return observed
}
/** Physical readback only. It neither verifies mutable source bytes nor grants
 * continuation after closure; W09's original owner gate stays authoritative. */
export async function assertOriginalPhysicalDirectories(input:{source:RemoteWorkflowPhysicalReadout['source'];runtimeLeaf:RemoteWorkflowPhysicalReadout['runtimeLeaf'];
  placement:AcceptedNodePlacement;approvedRoots:ApprovedRootAllowlist;signal:AbortSignal;authorize():Promise<void>}):Promise<void> {
  const check=async()=>{input.signal.throwIfAborted();await input.authorize();input.signal.throwIfAborted()}
  const {source,runtimeLeaf,approvedRoots,placement}=input,receipt=source.record.receipt,cwd=source.workingTree.cwdAttestation
  if(!isDeepStrictEqual(approvedRoots.hostRef,placement.hostRef)||approvedRoots.applicationInstallationId!==placement.registration?.workerInstallationId
    ||approvedRoots.managedRuntimeRoot!==placement.destination.managedRuntimeRoot
    ||!receipt.binding.canonicalPath.startsWith(`${approvedRoots.managedRuntimeRoot}/`)
    ||source.workingTree.canonicalProjectRoot!==join(receipt.binding.canonicalPath,receipt.materializationId,'tree')
    ||source.workingTree.canonicalCwd!==cwd.canonicalCwd||cwd.canonicalCwd!==join(source.workingTree.canonicalProjectRoot,cwd.relativeCwd)
    ||cwd.attestationDigest!==sourceCwdAttestationDigest(cwd))return unavailable()
  const inspectSource=async()=>{
    await check()
    let directory=await openPrivateRoot(receipt.binding.canonicalPath)
    try {
      await check()
      if(await realpath(receipt.binding.canonicalPath)!==receipt.binding.canonicalPath
        ||!isDeepStrictEqual(await identity(directory),receipt.binding.filesystem))return unavailable()
      await check()
      for(const [index,part] of [receipt.materializationId,'tree',...(cwd.relativeCwd?cwd.relativeCwd.split('/'):[])].entries()) {
        const child=await openChildDirectory(directory,part)
        await directory.close();directory=child
        await check()
        if(index===1&&!isDeepStrictEqual(await identity(directory),receipt.localTreeIdentity))return unavailable()
        await check()
      }
      if(!isDeepStrictEqual(await identity(directory),cwd.filesystem)||await realpath(cwd.canonicalCwd)!==cwd.canonicalCwd)return unavailable()
      await check()
    } finally {await directory.close()}
  }
  const inspectRuntime=async()=>{
    await check()
    const base=await openPrivateRoot(approvedRoots.managedRuntimeRoot)
    try {
      await check()
      if(!isDeepStrictEqual(await identity(base),approvedRoots.runtimeFilesystem))return unavailable()
      await check()
      const directory=await openPrivateRoot(runtimeLeaf.canonicalRuntimeDirectory)
      try {
        await check()
        if(await realpath(runtimeLeaf.canonicalRuntimeDirectory)!==runtimeLeaf.canonicalRuntimeDirectory
          ||commandInputHash(await identity(directory)).slice('sha256:'.length)!==runtimeLeaf.directoryIdentityHash)return unavailable()
        await check()
        const marker=await open(anchored(directory,'.graphql-workflow-runtime.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
        try {
          await check()
          const stat=await marker.stat()
          if(!stat.isFile()||stat.nlink!==1||stat.size>4096||stat.mode&0o077||stat.uid!==process.getuid?.())return unavailable()
          await check()
          if(!isDeepStrictEqual(RuntimeLeafAttestationSchema.parse(JSON.parse((await marker.readFile()).toString('utf8'))),runtimeLeaf))return unavailable()
          await check()
        } finally {await marker.close()}
      } finally {await directory.close()}
    } finally {await base.close()}
  }
  try {if(cwd.relativeCwd)sourcePath(cwd.relativeCwd);assertRuntimeLeafPath(runtimeLeaf.canonicalRuntimeDirectory,placement)
    await inspectSource();await inspectRuntime();await inspectSource();await inspectRuntime();await check()}
  catch(error){if(error instanceof DomainError)throw error;input.signal.throwIfAborted();return unavailable()}
}
interface Retained {
  receipt: RemoteOperationReceipt
  placement: AcceptedNodePlacement
  source: WorkflowOriginalNativeSource
  readout: RemoteWorkflowPhysicalReadout
  expiresAt: number
  bytes: number
  aliases: readonly {key:string;source:WorkflowOriginalNativeSource}[]
  assertOwnerCurrent(): Promise<void>
  assertCurrent(): Promise<void>
  observe(): NativeLaunchObservation
  closure(): NativeLaunchObservation | null
}
/** Only the installed original host remembers its own replies. Request selectors
 * locate those immutable originals; they can never supply or reconstruct proof. */
export class InstalledWorkflowPhysicalReadouts {
  private readonly originals = new Map<string, Map<string, Retained>>()
  private readonly events=new Map<string,Map<string,{retained:Retained;source:WorkflowOriginalNativeSource}>>()
  private byteSize = 0
  private key(sequence: number, sourceDigest: string) { return `${sequence}:${sourceDigest}` }
  private purgeExpired() {
    for (const [operation, entries] of this.originals) {
      for (const [key, retained] of entries) if (retained.expiresAt <= Date.now()) {
        entries.delete(key);this.byteSize-=retained.bytes
        for(const alias of retained.aliases)if(this.events.get(operation)?.get(alias.key)?.retained===retained)this.events.get(operation)?.delete(alias.key)
      }
      if (!entries.size) this.originals.delete(operation)
      if(!this.events.get(operation)?.size)this.events.delete(operation)
    }
  }
  purge(operationId: string) {
    const entries = this.originals.get(operationId)
    if (entries) for (const retained of entries.values()) this.byteSize -= retained.bytes
    this.originals.delete(operationId)
    this.events.delete(operationId)
  }
  clear() { this.originals.clear();this.events.clear(); this.byteSize = 0 }
  remember(input: { readout: RemoteWorkflowPhysicalReadout; placement: AcceptedNodePlacement; source: WorkflowOriginalNativeSource;
    leaseExpiresAt: string; assertOwnerCurrent(): Promise<void>; assertCurrent(): Promise<void>; observe(): NativeLaunchObservation; closure(): NativeLaunchObservation | null }): void {
    this.purgeExpired()
    const readout = freezeTree(RemoteWorkflowPhysicalReadoutSchema.parse(input.readout)), receipt = readout.receipt
    if (!receipt.native || readout.session.nativeSessionId !== receipt.native.sessionId) return unavailable()
    const source = freezeTree(JSON.parse(canonicalGraphJson(input.source, 4 * 1024 * 1024)) as WorkflowOriginalNativeSource)
    const placement=freezeTree(structuredClone(input.placement))
    const expiresAt = Math.min(Date.parse(readout.expiresAt),Date.parse(input.leaseExpiresAt), Date.now() + 60_000)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return unavailable()
    const key = this.key(receipt.sequence, remoteWorkflowSourceDigest(source)), entries = this.originals.get(receipt.intent.operationId) ?? new Map<string, Retained>()
    const previous = entries.get(key)
    if (previous) {
      if (!isDeepStrictEqual(previous.receipt,receipt)||!isDeepStrictEqual(previous.source, source)
        ||!isDeepStrictEqual(previous.readout.launch,readout.launch)||!isDeepStrictEqual(previous.readout.runtimeLeaf,readout.runtimeLeaf)
        ||!isDeepStrictEqual(previous.readout.source,readout.source)
        ||!isDeepStrictEqual(previous.placement,placement))return unavailable()
    }
    const aliases=source.type==='history'?(readout.history?.events??[]).map(event=>{
      const source:WorkflowOriginalNativeSource=freezeTree({type:'event',event:{...event,executionId:receipt.intent.executionId}})
      return {key:this.key(receipt.sequence,remoteWorkflowSourceDigest(source)),source}
    }):[]
    const bytes = Buffer.byteLength(canonicalGraphJson({ readout, source, placement,aliases }, 4 * 1024 * 1024))
    const nextByteSize = this.byteSize - (previous?.bytes ?? 0) + bytes
    if ((!previous && entries.size >= 128) || nextByteSize > 8 * 1024 * 1024) throw new DomainError('REMOTE_NATIVE_PHYSICAL_BACKPRESSURE', 'Original physical source retention is full.', 503)
    const retained:Retained={ receipt, placement, source, readout, expiresAt, bytes,aliases,
      assertOwnerCurrent: input.assertOwnerCurrent, assertCurrent: input.assertCurrent, observe: input.observe, closure: input.closure }
    entries.set(key,retained)
    this.originals.set(receipt.intent.operationId, entries); this.byteSize = nextByteSize
    const events=this.events.get(receipt.intent.operationId)??new Map<string,{retained:Retained;source:WorkflowOriginalNativeSource}>()
    // Each fresh, authenticated history refreshes its exact event observations.
    for(const alias of aliases)events.set(alias.key,{retained,source:alias.source})
    if(events.size)this.events.set(receipt.intent.operationId,events)
  }
  async read(input: { intent: DispatchIntent; placement: AcceptedNodePlacement; receiptSequence: number; sourceDigest: string }): Promise<RemoteWorkflowPhysicalReadout> {
    this.purgeExpired()
    const key=this.key(input.receiptSequence,input.sourceDigest)
    const retained = this.originals.get(input.intent.operationId)?.get(key)??this.events.get(input.intent.operationId)?.get(key)?.retained
    if (!retained || !isDeepStrictEqual(retained.receipt.intent, input.intent) || !isDeepStrictEqual(retained.placement, input.placement)) return unavailable()
    try { await retained.assertCurrent() } catch (error) { this.purge(input.intent.operationId); throw error }
    const observation = retained.observe()
    const closure = retained.closure()
    if (closure && (observation.lifecycle !== 'closed' || observation.closureEvidence !== 'cgroup_v2_empty' || !isDeepStrictEqual(observation,closure))) return unavailable()
    if (!closure && observation.lifecycle !== 'active') return unavailable()
    if (retained.expiresAt <= Date.now()) return unavailable()
    return RemoteWorkflowPhysicalReadoutSchema.parse({ ...retained.readout,expiresAt:new Date(retained.expiresAt).toISOString(), observation,
      ...(closure ? {closure:{ownerClosed:true,launch:closure}} : {}) })
  }
  /** An exact original reply selector retires its derived event indexes too.
   * Main sends this only after their durable canonical publication; this class
   * never writes an execution/journal outcome or treats an ACK as success. */
  async ack(input:{intent:DispatchIntent;placement:AcceptedNodePlacement;receiptSequence:number;sourceDigest:string}):Promise<RemoteWorkflowPhysicalAck> {
    this.purgeExpired()
    const key=this.key(input.receiptSequence,input.sourceDigest),entries=this.originals.get(input.intent.operationId)
    const direct=entries?.get(key),event=this.events.get(input.intent.operationId)?.get(key),retained=direct??event?.retained
    if(retained) {
      if(!isDeepStrictEqual(retained.receipt.intent,input.intent)||!isDeepStrictEqual(retained.placement,input.placement))return unavailable()
      // ACK only retires in-memory observations; physical checks still gate reads.
      try {await retained.assertOwnerCurrent()}catch(error){this.purge(input.intent.operationId);throw error}
      if(direct) {
        entries!.delete(key);this.byteSize-=retained.bytes
        for(const alias of retained.aliases)if(this.events.get(input.intent.operationId)?.get(alias.key)?.retained===retained)this.events.get(input.intent.operationId)?.delete(alias.key)
      } else this.events.get(input.intent.operationId)?.delete(key)
      if(!entries?.size)this.originals.delete(input.intent.operationId)
      if(!this.events.get(input.intent.operationId)?.size)this.events.delete(input.intent.operationId)
    }
    return RemoteWorkflowPhysicalAckSchema.parse({version:1,operationId:input.intent.operationId,receiptSequence:input.receiptSequence,
      sourceDigest:input.sourceDigest,status:retained?'retired':'not_retained'})
  }
}
