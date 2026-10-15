import { sourceWorkingTreeComponents, sourceWorkingTreePath } from '../../sources/sourceTreePaths.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { constants } from 'node:fs'
import { open,realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DispatchIntent, AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { RemoteWorkflowPhysicalReadoutSchema, RemoteWorkflowPhysicalReadoutTransferSchema,
  RemoteWorkflowPhysicalAckSchema, REMOTE_PHYSICAL_CONTINUATION_LIMIT, REMOTE_NATIVE_SOURCE_LIMIT,
  type RemoteResultDictionary, type RemoteWorkflowPhysicalReadout,type RemoteWorkflowPhysicalAck } from '@foreman-code/contracts/remote-workflow-physical'
import { DEVICE_HISTORY_PAGE_BYTES, DEVICE_JSON_CONTINUATION_LIMIT,
  type DeviceJsonContinuationRequest } from '@foreman-code/contracts/device-application'
import { pageJsonContinuation, readJsonContinuation } from './jsonContinuation.js'
import type { WorkflowOriginalNativeSource } from '../../interactions/workflowNativeCapture.js'
import type { NativeLaunchObservation, NativeProcessRegistry } from '../../harnesses/recovery/processRegistry.js'
import { DomainError } from '../../errors.js'
import { DeviceApplicationAdmissionError, DeviceApplicationError } from '../../devices/deviceApplicationError.js'
import { DeviceConnectionError } from '../../devices/deviceWire.js'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { anchored,identity,openChildDirectory,openPrivateRoot } from '../../sources/privateFilesystem.js'
import { sourcePath } from '../../sources/manifest.js'
import { sourceCwdAttestationDigest } from '../../sources/workingDirectory.js'
import { RuntimeLeafAttestationSchema,assertRuntimeLeafPath } from './runtimeLeaf.js'
import type { NativeHistory } from '../../harnesses/port.js'
import { encodeResultCopies, decodeResultCopies, physicalResultPaths, historyResultPaths } from './executionResultCodec.js'

const unavailable = (): never => { throw new DomainError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', 'The original installed native source and physical observations are unavailable.', 409) }
const physicalRetentionLimit = DEVICE_JSON_CONTINUATION_LIMIT * 4
const physicalReadoutLifetimeMs = 60_000
export function pagePhysicalReadout(readout: RemoteWorkflowPhysicalReadout, metadata?: DeviceJsonContinuationRequest) {
  if (!metadata && Buffer.byteLength(JSON.stringify(readout)) <= DEVICE_HISTORY_PAGE_BYTES) return readout
  const dictionary = encodeResultCopies(readout, physicalResultPaths(readout))
  return { kind: 'result-continuation' as const, metadata: pageJsonContinuation(dictionary, metadata,
    { maxBytes: REMOTE_PHYSICAL_CONTINUATION_LIMIT }) }
}
export async function readPhysicalReadout(raw: unknown,
  read: (metadata: DeviceJsonContinuationRequest) => Promise<unknown>, signal?: AbortSignal) {
  const transfer = RemoteWorkflowPhysicalReadoutTransferSchema.parse(raw)
  if (!('kind' in transfer)) return transfer
  const kind = transfer.kind
  const options = kind === 'result-continuation' ? { maxBytes: REMOTE_PHYSICAL_CONTINUATION_LIMIT } : {}
  const value = await readJsonContinuation(transfer.metadata, async metadata => {
    const next = RemoteWorkflowPhysicalReadoutTransferSchema.parse(await read(metadata))
    if (!('kind' in next) || next.kind !== kind) throw new Error('Physical readout continuation changed')
    return next.metadata
  }, signal, options)
  return RemoteWorkflowPhysicalReadoutSchema.parse(kind === 'result-continuation' ? decodeResultCopies(value) : value)
}
export function hasNativeClosure(observation: NativeLaunchObservation): boolean {
  return observation.lifecycle === 'closed' && (observation.closureEvidence === 'cgroup_v2_empty'
    || observation.closureEvidence === 'linux_boot_changed'
    || observation.closureEvidence === 'native_exit_removed_cgroup')
}
function freezeTree<T>(value:T):T {
  if(value!==null&&typeof value==='object') {Object.freeze(value);for(const child of Object.values(value))freezeTree(child)}
  return value
}
export function remoteWorkflowSourceDigest(source: WorkflowOriginalNativeSource): string {
  return createHash('sha256').update(canonicalGraphJson(source, REMOTE_NATIVE_SOURCE_LIMIT)).digest('hex')
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
  placement:AcceptedNodePlacement;approvedRoots:ApprovedRootAllowlist;signal:AbortSignal;
  assertCurrent():void;authorize():Promise<void>}):Promise<void> {
  const check=()=>{input.signal.throwIfAborted();input.assertCurrent();input.signal.throwIfAborted()}
  const authorize=async()=>{check();await input.authorize();check()}
  const {source,runtimeLeaf,approvedRoots,placement}=input,receipt=source.record.receipt,cwd=source.workingTree.cwdAttestation
  if(!isDeepStrictEqual(approvedRoots.hostRef,placement.hostRef)||approvedRoots.applicationInstallationId!==placement.registration?.workerInstallationId
    ||approvedRoots.managedRuntimeRoot!==placement.destination.managedRuntimeRoot
    ||!receipt.binding.canonicalPath.startsWith(`${approvedRoots.managedRuntimeRoot}/`)
    ||source.workingTree.canonicalProjectRoot!==sourceWorkingTreePath(receipt)
    ||source.workingTree.canonicalCwd!==cwd.canonicalCwd||cwd.canonicalCwd!==join(source.workingTree.canonicalProjectRoot,cwd.relativeCwd)
    ||cwd.attestationDigest!==sourceCwdAttestationDigest(cwd))return unavailable()
  const inspectSource=async()=>{
    check()
    let directory=await openPrivateRoot(receipt.binding.canonicalPath)
    try {
      check()
      if(await realpath(receipt.binding.canonicalPath)!==receipt.binding.canonicalPath
        ||!isDeepStrictEqual(await identity(directory),receipt.binding.filesystem))return unavailable()
      await check()
      for(const [index,part] of [...sourceWorkingTreeComponents(receipt),'tree',...(cwd.relativeCwd?cwd.relativeCwd.split('/'):[])].entries()) {
        const child=await openChildDirectory(directory,part)
        await directory.close();directory=child
        await check()
        if(index===sourceWorkingTreeComponents(receipt).length&&!isDeepStrictEqual(await identity(directory),receipt.localTreeIdentity))return unavailable()
        await check()
      }
      if(!isDeepStrictEqual(await identity(directory),cwd.filesystem)||await realpath(cwd.canonicalCwd)!==cwd.canonicalCwd)return unavailable()
      check()
    } finally {await directory.close()}
  }
  const inspectRuntime=async()=>{
    check()
    const base=await openPrivateRoot(approvedRoots.managedRuntimeRoot)
    try {
      check()
      if(!isDeepStrictEqual(await identity(base),approvedRoots.runtimeFilesystem))return unavailable()
      check()
      const directory=await openPrivateRoot(runtimeLeaf.canonicalRuntimeDirectory)
      try {
        check()
        if(await realpath(runtimeLeaf.canonicalRuntimeDirectory)!==runtimeLeaf.canonicalRuntimeDirectory
          ||commandInputHash(await identity(directory)).slice('sha256:'.length)!==runtimeLeaf.directoryIdentityHash)return unavailable()
        check()
        const marker=await open(anchored(directory,'.graphql-workflow-runtime.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
        try {
          check()
          const stat=await marker.stat()
          if(!stat.isFile()||stat.nlink!==1||stat.size>4096||stat.mode&0o077||stat.uid!==process.getuid?.())return unavailable()
          check()
          if(!isDeepStrictEqual(RuntimeLeafAttestationSchema.parse(JSON.parse((await marker.readFile()).toString('utf8'))),runtimeLeaf))return unavailable()
          check()
        } finally {await marker.close()}
      } finally {await directory.close()}
    } finally {await base.close()}
  }
  try {if(cwd.relativeCwd)sourcePath(cwd.relativeCwd);assertRuntimeLeafPath(runtimeLeaf.canonicalRuntimeDirectory,placement)
    // Main authorizes the whole inspection; local fences guard each filesystem step.
    await authorize()
    await inspectSource();await inspectRuntime();await inspectSource();await inspectRuntime()
    await authorize()}
  catch(error){if(error instanceof DomainError)throw error;input.signal.throwIfAborted();return unavailable()}
}
/** Admission, backpressure, timeout and link failures say nothing about the original reply, so it must stay retained for the retry. */
function transientAuthorizationFailure(error: unknown): boolean {
  return error instanceof DeviceApplicationAdmissionError || error instanceof DeviceConnectionError
    || error instanceof DeviceApplicationError && ['timeout', 'cancelled', 'transport', 'DATABASE_READ_TIMEOUT'].includes(error.code)
}
interface Retained {
  receipt: RemoteOperationReceipt
  placement: AcceptedNodePlacement
  source: WorkflowOriginalNativeSource
  readout: RemoteWorkflowPhysicalReadout
  readoutExpiresAt: number
  bytes: number
  resultDigests: readonly string[]
  aliases: readonly {key:string;source:WorkflowOriginalNativeSource}[]
  assertOwnerCurrent(): Promise<void>
  assertCurrent(): Promise<void>
  observe(): NativeLaunchObservation
  closure(): NativeLaunchObservation | null
  waitForSettlement?: (signal: AbortSignal) => Promise<void>
}
/** Only the installed original host remembers its own replies. Request selectors
 * locate those immutable originals; they can never supply or reconstruct proof. */
export class InstalledWorkflowPhysicalReadouts {
  private readonly originals = new Map<string, Map<string, Retained>>()
  private readonly events=new Map<string,Map<string,{retained:Retained;source:WorkflowOriginalNativeSource}>>()
  private byteSize = 0
  private readonly results = new Map<string, {
    value: RemoteResultDictionary['results'][number]
    bytes: number
    references: number
  }>()
  private key(sequence: number, sourceDigest: string) { return `${sequence}:${sourceDigest}` }
  private release(retained: Retained) {
    this.byteSize -= retained.bytes
    for (const digest of retained.resultDigests) {
      const result = this.results.get(digest)!
      result.references--
      if (result.references === 0) {
        this.byteSize -= result.bytes
        this.results.delete(digest)
      }
    }
  }
  purge(operationId: string) {
    const entries = this.originals.get(operationId)
    if (entries) for (const retained of entries.values()) this.release(retained)
    this.originals.delete(operationId)
    this.events.delete(operationId)
  }
  clear() { this.originals.clear();this.events.clear();this.results.clear(); this.byteSize = 0 }
  remember(input: { readout: RemoteWorkflowPhysicalReadout; placement: AcceptedNodePlacement; source: WorkflowOriginalNativeSource;
    leaseExpiresAt: string; assertOwnerCurrent(): Promise<void>; assertCurrent(): Promise<void>; observe(): NativeLaunchObservation; closure(): NativeLaunchObservation | null;
    waitForSettlement?: (signal: AbortSignal) => Promise<void> }): void {
    const parsed = RemoteWorkflowPhysicalReadoutSchema.parse(input.readout)
    canonicalGraphJson(input.source, REMOTE_NATIVE_SOURCE_LIMIT)
    const paths = physicalResultPaths(parsed, ['readout'])
    if (input.source.type === 'history') paths.push(...historyResultPaths(['source', 'history']))
    const dictionary = encodeResultCopies({ readout: parsed, source: input.source, placement: input.placement }, paths)
    const payloads = dictionary.results.map(value => {
      const serialized = canonicalGraphJson(value, DEVICE_JSON_CONTINUATION_LIMIT)
      const digest = createHash('sha256').update(serialized).digest('hex')
      return { digest, value: this.results.get(digest)?.value ?? value, bytes: Buffer.byteLength(serialized) }
    })
    dictionary.results = payloads.map(payload => payload.value)
    const decoded = decodeResultCopies(dictionary) as {
      readout: RemoteWorkflowPhysicalReadout; source: WorkflowOriginalNativeSource; placement: AcceptedNodePlacement
    }
    const readout = freezeTree(RemoteWorkflowPhysicalReadoutSchema.parse(decoded.readout)), receipt = readout.receipt
    if (!receipt.native || readout.session.nativeSessionId !== receipt.native.sessionId) return unavailable()
    const source = freezeTree(decoded.source)
    const placement=freezeTree(decoded.placement)
    const readoutExpiresAt = Math.min(Date.parse(readout.expiresAt), Date.parse(input.leaseExpiresAt),
      Date.now() + physicalReadoutLifetimeMs)
    if (!Number.isFinite(readoutExpiresAt) || readoutExpiresAt <= Date.now()) return unavailable()
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
    const resultDigests = payloads.map(payload => payload.digest)
    const bytes = Buffer.byteLength(canonicalGraphJson({ ...dictionary, results: resultDigests, aliases },
      REMOTE_PHYSICAL_CONTINUATION_LIMIT))
    let nextByteSize = this.byteSize - (previous?.bytes ?? 0) + bytes
    const changes = new Set([...(previous?.resultDigests ?? []), ...resultDigests])
    for (const digest of changes) {
      const original = this.results.get(digest)
      const references = (original?.references ?? 0) - (previous?.resultDigests.includes(digest) ? 1 : 0)
        + (resultDigests.includes(digest) ? 1 : 0)
      if (original && references === 0) nextByteSize -= original.bytes
      if (!original && references > 0) nextByteSize += payloads.find(payload => payload.digest === digest)!.bytes
    }
    if ((!previous && entries.size >= 128) || nextByteSize > physicalRetentionLimit) {
      throw new DomainError('REMOTE_NATIVE_PHYSICAL_BACKPRESSURE', 'Original physical source retention is full.', 503)
    }
    if (previous) this.release(previous)
    for (const payload of payloads) {
      const original = this.results.get(payload.digest)
      if (original) original.references++
      else this.results.set(payload.digest, { value: freezeTree(payload.value), bytes: payload.bytes, references: 1 })
    }
    const retained:Retained={ receipt, placement, source, readout, readoutExpiresAt, bytes,aliases,resultDigests,
      assertOwnerCurrent: input.assertOwnerCurrent, assertCurrent: input.assertCurrent, observe: input.observe, closure: input.closure,
      ...(input.waitForSettlement ? { waitForSettlement: input.waitForSettlement } : {}) }
    entries.set(key,retained)
    this.originals.set(receipt.intent.operationId, entries); this.byteSize = nextByteSize
    const events=this.events.get(receipt.intent.operationId)??new Map<string,{retained:Retained;source:WorkflowOriginalNativeSource}>()
    // Each fresh, authenticated history refreshes its exact event observations.
    for(const alias of aliases)events.set(alias.key,{retained,source:alias.source})
    if(events.size)this.events.set(receipt.intent.operationId,events)
  }
  async read(input: { intent: DispatchIntent; placement: AcceptedNodePlacement; receiptSequence: number; sourceDigest: string },
    signal?: AbortSignal): Promise<RemoteWorkflowPhysicalReadout> {
    signal?.throwIfAborted()
    const key=this.key(input.receiptSequence,input.sourceDigest)
    const retained = this.originals.get(input.intent.operationId)?.get(key)??this.events.get(input.intent.operationId)?.get(key)?.retained
    if (!retained) throw new DomainError('REMOTE_NATIVE_PHYSICAL_UNAVAILABLE',
      'The original physical reply is no longer retained.', 409,
      { reason: 'not_retained',
        operationId: input.intent.operationId,
        receiptSequence: input.receiptSequence, sourceDigest: input.sourceDigest })
    if (!isDeepStrictEqual(retained.receipt.intent, input.intent)
      || !isDeepStrictEqual(retained.placement, input.placement)) throw new DomainError(
      'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', 'The original physical reply selector changed.', 409,
      { reason: 'selector_changed', operationId: input.intent.operationId, receiptSequence: input.receiptSequence })
    try { await retained.assertCurrent() } catch (error) {
      if (!transientAuthorizationFailure(error)) this.purge(input.intent.operationId)
      throw error
    }
    let observation = retained.observe()
    let closure = retained.closure()
    if (!closure && observation.lifecycle !== 'active' && retained.waitForSettlement) {
      const expiry = AbortSignal.timeout(physicalReadoutLifetimeMs)
      await retained.waitForSettlement(signal ? AbortSignal.any([signal, expiry]) : expiry)
      signal?.throwIfAborted()
      await retained.assertCurrent()
      observation = retained.observe()
      closure = retained.closure()
    }
    if (closure && (!hasNativeClosure(observation) || !isDeepStrictEqual(observation,closure))) return unavailable()
    if (!closure && observation.lifecycle !== 'active') return unavailable()
    // Retention ends at ACK; a late read gets fresh physical checks and a fresh verification window.
    if (retained.readoutExpiresAt <= Date.now()) retained.readoutExpiresAt = Date.now() + physicalReadoutLifetimeMs
    return RemoteWorkflowPhysicalReadoutSchema.parse({ ...retained.readout,
      expiresAt: new Date(retained.readoutExpiresAt).toISOString(), observation,
      ...(closure ? {closure:{ownerClosed:true,launch:closure}} : {}) })
  }
  /** An exact original reply selector retires its derived event indexes too.
   * Main sends this only after their durable canonical publication; this class
   * never writes an execution/journal outcome or treats an ACK as success. */
  async ack(input:{intent:DispatchIntent;placement:AcceptedNodePlacement;receiptSequence:number;sourceDigest:string}):Promise<RemoteWorkflowPhysicalAck> {
    const key=this.key(input.receiptSequence,input.sourceDigest),entries=this.originals.get(input.intent.operationId)
    const direct=entries?.get(key),event=this.events.get(input.intent.operationId)?.get(key),retained=direct??event?.retained
    if(retained) {
      if(!isDeepStrictEqual(retained.receipt.intent,input.intent)||!isDeepStrictEqual(retained.placement,input.placement))return unavailable()
      // ACK only retires in-memory observations; physical checks still gate reads.
      try {await retained.assertOwnerCurrent()}catch(error){if(!transientAuthorizationFailure(error))this.purge(input.intent.operationId);throw error}
      if(direct) {
        entries!.delete(key);this.release(retained)
        for(const alias of retained.aliases)if(this.events.get(input.intent.operationId)?.get(alias.key)?.retained===retained)this.events.get(input.intent.operationId)?.delete(alias.key)
      } else this.events.get(input.intent.operationId)?.delete(key)
      if(!entries?.size)this.originals.delete(input.intent.operationId)
      if(!this.events.get(input.intent.operationId)?.size)this.events.delete(input.intent.operationId)
    }
    return RemoteWorkflowPhysicalAckSchema.parse({version:1,operationId:input.intent.operationId,receiptSequence:input.receiptSequence,
      sourceDigest:input.sourceDigest,status:retained?'retired':'not_retained'})
  }
}
