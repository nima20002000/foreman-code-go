import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual as same } from 'node:util'
import { MAX_FILE_BYTES, type AgentFilePublishInput, type AgentFilePublishResult,
  type TemporaryFileScope } from '@graphql/contracts/files'
import { BYTE_TRANSFER_POLICY } from '@graphql/contracts/byte-transfer'
import { WorkerNativeOutputCommandSchema, WorkerNativeOutputReplySchema,
  type WorkerNativeOutputCommand, type WorkerNativeOutputReply } from '@graphql/contracts/worker-native-output'
import type { NativeOutputBridge, NativeOutputCallback, NativeOutputTurnPin,
  NativeOutputPreparation, NativeOutputQualificationInput, WorkflowNativeOutputs } from '../../harnesses/workflowNativeOutput.js'
import { DomainError } from '../../errors.js'
import { captureWorkerNativeArtifactCallback, type WorkerNativeArtifactCallback,
  type WorkerNativeArtifactSnapshot, type WorkerNativeArtifactSource } from './workerNativeArtifactSender.js'

const unavailable = () => new DomainError('WORKER_NATIVE_OUTPUT_UNAVAILABLE',
  'The original native output owner or publication permission is unavailable.', 403)
const conflict = () => new DomainError('WORKER_NATIVE_OUTPUT_CONFLICT',
  'The output command, sealed bytes or publication changed.', 409)
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

/** Buffers never expose a native filesystem path. Sealing detaches the append chunks,
 * and every reader receives a copy, so native tools cannot mutate published bytes. */
export class NativeOutputMemoryBudget {
  private bytes = 0
  private records = 0
  constructor(private readonly maxBytes = BYTE_TRANSFER_POLICY.maxStagingBytes,
    private readonly maxRecords = BYTE_TRANSFER_POLICY.maxRecords * BYTE_TRANSFER_POLICY.maxActiveGlobal) {}
  reserve(bytes: number): () => void {
    if (this.bytes + bytes > this.maxBytes || this.records >= this.maxRecords) throw unavailable()
    this.bytes += bytes
    this.records++
    let released = false
    return () => {
      if (released) return
      released = true
      this.bytes -= bytes
      this.records--
    }
  }
}
interface Entry {
  filename: string
  mediaType: AgentFilePublishInput['mediaType']
  chunks: Buffer[]
  byteSize: number
  release(): void
  snapshot?: Buffer
  publication?: AgentFilePublishInput
}
interface Ports {
  scope: TemporaryFileScope
  budget: NativeOutputMemoryBudget
  authorize(operation: WorkerNativeOutputCommand['operation'], signal?: AbortSignal): Promise<void>
  assertCurrent(signal?: AbortSignal): void | Promise<void>
  publish(publication: AgentFilePublishInput, source: WorkerNativeArtifactSource,
    callback: WorkerNativeArtifactCallback, signal?: AbortSignal): Promise<AgentFilePublishResult>
}
export class BufferedNativeOutputRegistry implements WorkerNativeArtifactSource {
  private readonly entries = new Map<string, Entry>()
  private readonly commands = new Map<string, { digest: string; reply?: WorkerNativeOutputReply }>()
  private tail: Promise<unknown> = Promise.resolve()
  private queuedBytes = 0
  private closed = false
  constructor(private readonly ports: Ports) {}
  private async check(operation: WorkerNativeOutputCommand['operation'], call: WorkerNativeArtifactCallback,
    signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (this.closed) throw unavailable()
    await this.ports.assertCurrent(signal)
    await call.assertCurrent(signal)
    await this.ports.authorize(operation, signal)
    await this.ports.assertCurrent(signal)
    await call.assertCurrent(signal)
    signal?.throwIfAborted()
    if (this.closed) throw unavailable()
  }
  async dispatch(raw: WorkerNativeOutputCommand, callback: WorkerNativeArtifactCallback,
    signal?: AbortSignal): Promise<WorkerNativeOutputReply> {
    const command = WorkerNativeOutputCommandSchema.parse(raw)
    const call = captureWorkerNativeArtifactCallback(callback)
    const key = command.operation === 'publish' ? command.publication.commandId : command.commandId
    const digest = hash(JSON.stringify(command))
    const size = Buffer.byteLength(JSON.stringify(command))
    if (this.queuedBytes + size > BYTE_TRANSFER_POLICY.maxQueuedBytes) throw unavailable()
    this.queuedBytes += size
    const pending = this.tail.then(async () => {
      await this.check(command.operation, call, signal)
      const stored = this.commands.get(key)
      if (stored && stored.digest !== digest) throw conflict()
      if (stored?.reply) return structuredClone(stored.reply)
      if (!stored && this.commands.size >= BYTE_TRANSFER_POLICY.maxRecords) throw unavailable()
      const record = stored ?? { digest }
      this.commands.set(key, record)
      const reply = WorkerNativeOutputReplySchema.parse(await this.execute(command, call, signal))
      record.reply = reply
      await this.check(command.operation, call, signal)
      return structuredClone(reply)
    })
    this.tail = pending.catch(() => undefined) // The caller receives failures; later calls still drain.
    try { return await pending } finally { this.queuedBytes -= size }
  }
  private async execute(command: WorkerNativeOutputCommand, call: WorkerNativeArtifactCallback,
    signal?: AbortSignal): Promise<WorkerNativeOutputReply> {
    if (command.operation === 'create') {
      const release = this.ports.budget.reserve(2 * MAX_FILE_BYTES)
      const artifactId = randomUUID()
      this.entries.set(artifactId, { filename: command.filename, mediaType: command.mediaType,
        chunks: [], byteSize: 0, release })
      return { operation: 'create', artifactId, byteSize: 0 }
    }
    const id = command.operation === 'publish' ? command.publication.artifactId : command.artifactId
    const entry = this.entries.get(id)
    if (!entry) throw conflict()
    if (command.operation === 'append') {
      const bytes = Buffer.from(command.contentBase64, 'base64')
      if (entry.snapshot || command.offset !== entry.byteSize || entry.byteSize + bytes.length > MAX_FILE_BYTES) throw conflict()
      entry.chunks.push(bytes)
      entry.byteSize += bytes.length
      return { operation: 'append', artifactId: id, byteSize: entry.byteSize }
    }
    if (command.operation === 'seal') {
      entry.snapshot ??= Buffer.concat(entry.chunks, entry.byteSize)
      entry.chunks = []
      return { operation: 'seal', artifactId: id, sha256: hash(entry.snapshot), byteSize: entry.byteSize }
    }
    const publication = { ...command.publication, scope: this.ports.scope }
    if (!entry.snapshot || publication.filename !== entry.filename || publication.mediaType !== entry.mediaType
      || entry.publication && !same(entry.publication, publication)) throw conflict()
    entry.publication = structuredClone(publication)
    return { operation: 'publish', result: await this.ports.publish(publication, this, call, signal) }
  }
  async sealed(publication: AgentFilePublishInput, callback: WorkerNativeArtifactCallback,
    signal?: AbortSignal): Promise<WorkerNativeArtifactSnapshot> {
    const call = captureWorkerNativeArtifactCallback(callback)
    const entry = this.entries.get(publication.artifactId)
    if (!entry?.snapshot || !same(entry.publication, publication)) throw conflict()
    const snapshot = entry.snapshot
    const check = async (bounded?: AbortSignal) => {
      await this.check('publish', call, bounded)
      if (this.entries.get(publication.artifactId) !== entry || entry.snapshot !== snapshot) throw conflict()
    }
    await check(signal)
    return { sha256: hash(snapshot), byteSize: snapshot.length, assertCurrent: check,
      read: async (offset, length, bounded) => {
        await check(bounded)
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
          || length > BYTE_TRANSFER_POLICY.maxChunkBytes || offset + length > snapshot.length) throw conflict()
        return Buffer.from(snapshot.subarray(offset, offset + length))
      } }
  }
  async close(): Promise<void> {
    this.closed = true
    await this.tail
    for (const entry of this.entries.values()) entry.release()
    this.entries.clear()
  }
}

export function createBufferedNativeOutputs(ports: {
  budget: NativeOutputMemoryBudget
  assertQualified(input: NativeOutputQualificationInput, signal: AbortSignal): Promise<void>
  assertCurrent(signal?: AbortSignal): Promise<void>
  authorize(pin: NativeOutputTurnPin, operation: WorkerNativeOutputCommand['operation'],
    signal?: AbortSignal): Promise<TemporaryFileScope>
  publish: Ports['publish']
}): WorkflowNativeOutputs {
  const prepare = async (input: NativeOutputPreparation, signal: AbortSignal): Promise<NativeOutputBridge> => {
    await ports.assertQualified(input, signal)
    let pin: NativeOutputTurnPin | undefined
    let registry: BufferedNativeOutputRegistry | undefined
    let scope: TemporaryFileScope | undefined
    let closed = false
    const current = async (effectSignal?: AbortSignal) => {
      effectSignal?.throwIfAborted()
      if (closed || !pin) throw unavailable()
      pin.assertCurrent()
      await ports.assertCurrent(effectSignal)
      pin.assertCurrent()
    }
    return {
      activate: async (original, effectSignal) => {
        if (pin || closed || !same(original.session, input.session) || original.connectionId !== input.connectionId
          || original.runtimeGeneration !== input.runtimeGeneration) throw unavailable()
        pin = Object.freeze({ ...original, session: structuredClone(original.session),
          assertCurrent: original.assertCurrent.bind(original) })
        await current(effectSignal)
      },
      dispatch: async (command, callback: NativeOutputCallback, effectSignal) => {
        if (!pin || !same(callback.session, pin.session) || callback.nativeTurnId !== pin.nativeTurnId
          || callback.connectionId !== pin.connectionId || callback.runtimeGeneration !== pin.runtimeGeneration
          || !callback.callId.trim()) throw unavailable()
        if (!registry) {
          scope = await ports.authorize(pin, 'create', effectSignal)
          await current(effectSignal)
          registry ??= new BufferedNativeOutputRegistry({ scope, budget: ports.budget, assertCurrent: current,
            authorize: async (operation, bounded) => {
              const returned = await ports.authorize(pin!, operation, bounded)
              if (!same(returned, scope)) throw unavailable()
            }, publish: ports.publish })
        }
        return registry.dispatch(command, callback, effectSignal)
      },
      close: async () => { closed = true; await registry?.close() },
    }
  }
  return { codex: { storageKind: 'buffer', assertQualified: ports.assertQualified, prepare },
    opencode: { assertQualified: ports.assertQualified, prepare } }
}
