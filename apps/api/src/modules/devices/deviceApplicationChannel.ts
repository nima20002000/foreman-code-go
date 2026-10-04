import { componentLogger } from '../../infrastructure/logger.js'
import { createHash, randomUUID } from 'node:crypto'
import {
  DEVICE_APPLICATION_BUFFER_BYTES, DEVICE_APPLICATION_CHUNK_BYTES, DEVICE_APPLICATION_IN_FLIGHT,
  parseExtensionDescriptors, type DeviceApplicationResult, type DeviceExtensionDescriptor, type DeviceNegotiatedExtension,
} from '@foreman-code/contracts/device-application'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { DeviceConnectionError, nextFrame, readFrame, sendFrame, withDeviceDeadline, type DeviceSocket } from './deviceWire.js'
import { DeviceApplicationError } from './deviceApplicationError.js'
export { DeviceApplicationError } from './deviceApplicationError.js'

export interface DeviceExtensionContext { binding: Readonly<DeviceSessionBinding>; signal: AbortSignal; bytes?: Uint8Array }
export interface DeviceExtensionRegistration extends DeviceExtensionDescriptor {
  /** Domain handler MUST validate its execution/job/transfer grant and immutable target. */
  handle?(payload: unknown, context: DeviceExtensionContext): Promise<DeviceApplicationResult>
}
export interface DeviceApplicationRequestOptions { signal?: AbortSignal; bytes?: Uint8Array; timeoutMs?: number }
interface Pending {
  resolve(value: DeviceApplicationResult): void
  reject(error: Error): void
  namespace: string
  abort: AbortController
}
interface Assembly {
  namespace: string; kind: 'request' | 'response' | 'error'; jsonBytes: number; binaryBytes: number
  received: number; chunks: Buffer[]; abort: AbortController
}
export function extensionDescriptors(registrations: DeviceExtensionRegistration[]) {
  for (const registration of registrations) if (registration.role !== 'client' && typeof registration.handle !== 'function') throw new Error('A device server extension requires its actual domain handler')
  return parseExtensionDescriptors(registrations)
}
export function deviceNegotiationHash(extensions: DeviceNegotiatedExtension[]) {
  return createHash('sha256').update(JSON.stringify(extensions)).digest('hex')
}
/** One reader per authenticated epoch. Chunk ACKs attest receipt only, never task acceptance. */
export class DeviceApplicationChannel {
  private readonly abort = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly extensions: DeviceNegotiatedExtension[]
  private readonly registrations: DeviceExtensionRegistration[]
  private readonly binding: Readonly<DeviceSessionBinding>
  private readonly pending = new Map<string, Pending>()
  private readonly assemblies = new Map<string, Assembly>()
  private readonly handlers = new Map<string, AbortController>()
  private readonly replies = new Map<string, AbortController>()
  private readonly uploads = new Map<string, AbortController>()
  private readonly acknowledgements = new Map<string, { offset: number; resolve(): void; reject(error: Error): void }>()
  private inboundBytes = 0
  private outboundBytes = 0
  private failure: Error | undefined
  private readonly detach: () => void
  constructor(private readonly options: {
    side: 'main' | 'worker'; binding: DeviceSessionBinding; socket: DeviceSocket; signal: AbortSignal
    extensions: DeviceNegotiatedExtension[]; registrations: DeviceExtensionRegistration[]
    /** Main live device authorization, separate from the handler's operation authority. */
    revalidate?(): Promise<void>
    onObservedFrame?(observedAt: string): void
  }) {
    this.extensions = options.extensions.map((item) => Object.freeze({ ...item }))
    this.registrations = options.registrations.map((item) => Object.freeze({ ...item }))
    this.binding = Object.freeze({ ...options.binding })
    const close = () => this.close(new DeviceConnectionError('transport'))
    options.signal.addEventListener('abort', close, { once: true })
    this.detach = () => options.signal.removeEventListener('abort', close)
    if (options.signal.aborted) close()
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task)
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }
  /** Joins physical callbacks as well as canceled deadline wrappers. Close first for shutdown. */
  async join(): Promise<void> { while (this.tasks.size) await Promise.allSettled([...this.tasks]) }
  currentBinding(): Readonly<DeviceSessionBinding> { this.current(); return this.binding }
  currentBindingForIncoming(namespace: string): Readonly<DeviceSessionBinding> { this.current(); this.negotiated(namespace, false); return this.binding }
  captureRequest(namespace: string) {
    this.current(); this.negotiated(namespace, true)
    return Object.freeze({ binding: this.binding, request: (payload: unknown, options?: DeviceApplicationRequestOptions) => this.request(namespace, payload, options) })
  }
  capabilities(): DeviceNegotiatedExtension[] { return this.extensions.map((item) => ({ ...item })) }
  private current() { if (this.abort.signal.aborted) throw this.failure ?? new DeviceConnectionError('transport') }
  private negotiated(namespace: string, outgoing: boolean) {
    const extension = this.extensions.find((item) => item.namespace === namespace)
    const allowed = extension && (this.options.side === 'main' ? outgoing ? extension.mainCanRequest : extension.workerCanRequest : outgoing ? extension.workerCanRequest : extension.mainCanRequest)
    if (!extension || !allowed) throw new DeviceApplicationError('unavailable')
    return extension
  }
  private async authorized() {
    this.current()
    if (this.options.revalidate) await withDeviceDeadline(this.track(this.options.revalidate()), this.abort.signal, 10_000)
    this.current()
  }
  request(namespace: string, payload: unknown, options: DeviceApplicationRequestOptions = {}): Promise<DeviceApplicationResult> {
    return this.track(this.requestInternal(namespace, payload, options))
  }
  private async requestInternal(namespace: string, payload: unknown, options: DeviceApplicationRequestOptions): Promise<DeviceApplicationResult> {
    const extension = this.negotiated(namespace, true)
    this.current()
    if (this.pending.size >= DEVICE_APPLICATION_IN_FLIGHT) throw new DeviceApplicationError('backpressure')
    if (options.signal?.aborted) throw new DeviceApplicationError('cancelled')
    await this.authorized()
    if (options.signal?.aborted) throw new DeviceApplicationError('cancelled')
    if (this.pending.size >= DEVICE_APPLICATION_IN_FLIGHT) throw new DeviceApplicationError('backpressure')
    const id = randomUUID(), abort = new AbortController()
    let reject!: (error: Error) => void
    const result = new Promise<DeviceApplicationResult>((resolve, fail) => { reject = fail; this.pending.set(id, { namespace, resolve, reject: fail, abort }) })
    const cancel = () => { abort.abort(); reject(new DeviceApplicationError('cancelled')); this.trySendCancel(id) }
    options.signal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => { abort.abort(); reject(new DeviceApplicationError('timeout')); this.trySendCancel(id) }, Math.min(900_000, Math.max(1, options.timeoutMs ?? 30_000)))
    // Observe rejection immediately while the request bytes are still uploading.
    void result.catch(() => undefined)
    try {
      await this.sendPacket(id, namespace, extension.version, 'request', payload, options.bytes, abort.signal)
      return await result
    } catch (error) { this.trySendCancel(id); throw error } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); this.pending.delete(id); abort.abort()
    }
  }
  private trySendCancel(id: string) { try { this.current(); sendFrame(this.options.socket, { type: 'application-cancel', id }) } catch { /* already fenced */ } }
  private async waitAck(id: string, offset: number, signal: AbortSignal, send: () => void) {
    this.current()
    let abort: (() => void) | undefined
    const acknowledged = new Promise<void>((resolve, reject) => {
      this.acknowledgements.set(id, { offset, resolve, reject })
      abort = () => reject(new DeviceApplicationError('cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else try { send() } catch (error) { reject(error as Error) }
    })
    try { await withDeviceDeadline(acknowledged, this.abort.signal, 10_000) }
    finally { if (abort) signal.removeEventListener('abort', abort); this.acknowledgements.delete(id) }
  }
  private async sendPacket(id: string, namespace: string, version: number, kind: Assembly['kind'], payload: unknown, bytes: Uint8Array | undefined, signal: AbortSignal) {
    this.current()
    const extension = this.extensions.find((item) => item.namespace === namespace)!
    const json = Buffer.from(JSON.stringify(payload === undefined ? null : payload))
    if (json.byteLength > extension.maxJsonBytes || (bytes?.byteLength ?? 0) > extension.maxBinaryBytes) throw new DeviceApplicationError('payload-too-large')
    const size = json.byteLength + (bytes?.byteLength ?? 0)
    if (this.outboundBytes + size > DEVICE_APPLICATION_BUFFER_BYTES) throw new DeviceApplicationError('backpressure')
    this.outboundBytes += size
    const upload = new AbortController(), cancel = () => upload.abort()
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
    this.uploads.set(id, upload)
    try {
      await this.waitAck(id, 0, upload.signal, () => sendFrame(this.options.socket, { type: 'application-open', id, namespace, version, kind, jsonBytes: json.byteLength, binaryBytes: bytes?.byteLength ?? 0 }))
      const packet = bytes ? Buffer.concat([json, Buffer.from(bytes)]) : json
      for (let offset = 0; offset < packet.byteLength; offset += DEVICE_APPLICATION_CHUNK_BYTES) {
        const chunk = packet.subarray(offset, offset + DEVICE_APPLICATION_CHUNK_BYTES)
        await this.waitAck(id, offset + chunk.byteLength, upload.signal, () => sendFrame(this.options.socket, { type: 'application-chunk', id, offset, data: chunk.toString('base64') }))
      }
    } finally { this.outboundBytes -= size; this.uploads.delete(id); signal.removeEventListener('abort', cancel); upload.abort() }
  }
  /** Called only by run()'s sole socket reader; control frames never wait for a domain handler. */
  private receive(frame: Record<string, unknown>) {
    this.current()
    if (typeof frame.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(frame.id)) throw new DeviceConnectionError('malformed-frame')
    const id = frame.id
    if (frame.type === 'application-ack') {
      if (typeof frame.offset !== 'number' || !Number.isSafeInteger(frame.offset) || frame.offset < 0) throw new DeviceConnectionError('malformed-frame')
      const ack = this.acknowledgements.get(id)
      if (!ack) return // Cancellation can race a chunk receipt; receipts acquire no authority.
      if (frame.offset !== ack.offset) throw new DeviceConnectionError('malformed-frame')
      ack.resolve(); return
    }
    if (frame.type === 'application-cancel') {
      this.uploads.get(id)?.abort(); this.handlers.get(id)?.abort(); this.replies.get(id)?.abort()
      const assembly = this.assemblies.get(id)
      if (assembly) { this.inboundBytes -= assembly.jsonBytes + assembly.binaryBytes; this.assemblies.delete(id); assembly.abort.abort() }
      this.pending.get(id)?.reject(new DeviceApplicationError('cancelled')); return
    }
    if (frame.type === 'application-open') {
      if (typeof frame.namespace !== 'string' || !['request', 'response', 'error'].includes(String(frame.kind))) throw new DeviceConnectionError('malformed-frame')
      const kind = frame.kind as Assembly['kind']
      const extension = kind === 'request' ? this.negotiated(frame.namespace, false) : this.extensions.find((item) => item.namespace === frame.namespace)
      if (kind !== 'request' && !this.pending.has(id)) { this.trySendCancel(id); return }
      if (!extension || frame.version !== extension.version || (kind !== 'request' && this.pending.get(id)?.namespace !== frame.namespace)) throw new DeviceConnectionError('malformed-frame')
      const jsonBytes = Number(frame.jsonBytes), binaryBytes = Number(frame.binaryBytes), total = jsonBytes + binaryBytes
      if (typeof frame.jsonBytes !== 'number' || typeof frame.binaryBytes !== 'number' || !Number.isSafeInteger(jsonBytes) || jsonBytes < 1 || jsonBytes > extension.maxJsonBytes || !Number.isSafeInteger(binaryBytes) || binaryBytes < 0 || binaryBytes > extension.maxBinaryBytes) throw new DeviceConnectionError('malformed-frame')
      // Replies to admitted outgoing requests have their own bounded capacity.
      const active = kind === 'request' ? this.handlers : this.replies
      const assembling = [...this.assemblies.values()].filter((item) => (item.kind === 'request') === (kind === 'request')).length
      if (this.assemblies.has(id) || this.handlers.has(id) || this.replies.has(id) || assembling + active.size >= DEVICE_APPLICATION_IN_FLIGHT || this.inboundBytes + total > DEVICE_APPLICATION_BUFFER_BYTES) throw new DeviceConnectionError('backpressure')
      this.inboundBytes += total
      this.assemblies.set(id, { namespace: frame.namespace, kind, jsonBytes, binaryBytes, received: 0, chunks: [], abort: new AbortController() })
      sendFrame(this.options.socket, { type: 'application-ack', id, offset: 0 }); return
    }
    if (frame.type !== 'application-chunk') throw new DeviceConnectionError('malformed-frame')
    const assembly = this.assemblies.get(id)
    if (!assembly) { this.trySendCancel(id); return }
    if (frame.offset !== assembly.received || typeof frame.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new DeviceConnectionError('malformed-frame')
    const chunk = Buffer.from(frame.data, 'base64')
    if (!chunk.byteLength || chunk.byteLength > DEVICE_APPLICATION_CHUNK_BYTES || assembly.received + chunk.byteLength > assembly.jsonBytes + assembly.binaryBytes) throw new DeviceConnectionError('malformed-frame')
    assembly.chunks.push(chunk); assembly.received += chunk.byteLength
    sendFrame(this.options.socket, { type: 'application-ack', id, offset: assembly.received })
    if (assembly.received === assembly.jsonBytes + assembly.binaryBytes) {
      this.assemblies.delete(id); (assembly.kind === 'request' ? this.handlers : this.replies).set(id, assembly.abort)
      void this.track(this.complete(id, assembly)).catch((error: unknown) => this.close(error instanceof Error ? error : new DeviceConnectionError('transport')))
    }
  }
  private async complete(id: string, assembly: Assembly) {
    try {
      const packet = Buffer.concat(assembly.chunks); assembly.chunks.length = 0
      const payload: unknown = JSON.parse(packet.subarray(0, assembly.jsonBytes).toString())
      const bytes = assembly.binaryBytes ? packet.subarray(assembly.jsonBytes) : undefined
      if (assembly.kind !== 'request') {
        await this.authorized()
        if (assembly.abort.signal.aborted) return
        const pending = this.pending.get(id)
        if (pending) {
          if (assembly.kind === 'error') pending.reject(new DeviceApplicationError(typeof (payload as { code?: unknown })?.code === 'string' ? (payload as { code: string }).code : 'extension-rejected'))
          else pending.resolve({ payload, ...(bytes ? { bytes } : {}) })
        }
        return
      }
      await this.authorized()
      const registration = this.registrations.find((item) => item.namespace === assembly.namespace)
      if (!registration?.handle || assembly.abort.signal.aborted) return
      let result: DeviceApplicationResult
      try {
        result = await withDeviceDeadline(this.track(registration.handle(payload, { binding: Object.freeze({ ...this.binding }), signal: assembly.abort.signal, ...(bytes ? { bytes } : {}) })), assembly.abort.signal, 900_000)
        await this.authorized()
      } catch (error) {
        if (assembly.abort.signal.aborted || this.abort.signal.aborted) return
        componentLogger('devices').error({ err: error, namespace: assembly.namespace }, 'Device extension request failed')
        const proposed = (error as { code?: unknown })?.code
        const code = typeof proposed === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(proposed) ? proposed : 'extension-rejected'
        await this.sendPacket(id, assembly.namespace, registration.version, 'error', { code }, undefined, assembly.abort.signal); return
      }
      if (!assembly.abort.signal.aborted) {
        try { await this.sendPacket(id, assembly.namespace, registration.version, 'response', result.payload, result.bytes, assembly.abort.signal) } catch (error) {
          if (!(error instanceof DeviceApplicationError) || assembly.abort.signal.aborted) throw error
          await this.sendPacket(id, assembly.namespace, registration.version, 'error', { code: error.code }, undefined, assembly.abort.signal)
        }
      }
    } finally { this.inboundBytes -= assembly.jsonBytes + assembly.binaryBytes; (assembly.kind === 'request' ? this.handlers : this.replies).delete(id); assembly.abort.abort() }
  }
  run(iterator: AsyncIterator<string>, heartbeatMs: number): Promise<void> { return this.track(this.runInternal(iterator, heartbeatMs)) }
  private async runInternal(iterator: AsyncIterator<string>, heartbeatMs: number): Promise<void> {
    let lastHeartbeat = Date.now(), timer: ReturnType<typeof setInterval> | undefined
    const worker = this.options.side === 'worker'
    if (worker) {
      const ping = () => { try { this.current(); sendFrame(this.options.socket, { type: 'ping', connectionEpoch: this.binding.connectionEpoch }) } catch (error) { this.close(error as Error) } }
      ping(); timer = setInterval(ping, heartbeatMs)
    }
    try {
      while (!this.abort.signal.aborted) {
        const next = await nextFrame(iterator, this.abort.signal, Math.max(1, lastHeartbeat + heartbeatMs * (worker ? 2 : 1) - Date.now()))
        if (next.done) throw new DeviceConnectionError('transport')
        const observedAt = new Date().toISOString()
        const frame = readFrame(next.value)
        if (frame.type === (worker ? 'pong' : 'ping')) {
          if (frame.connectionEpoch !== this.binding.connectionEpoch) throw new DeviceConnectionError('malformed-frame')
          await this.authorized(); lastHeartbeat = Date.now()
          if (!worker) sendFrame(this.options.socket, { type: 'pong', connectionEpoch: this.binding.connectionEpoch })
        } else if (frame.type === 'blocked') throw new DeviceConnectionError(classify(frame.code))
        else this.receive(frame)
        this.current(); this.options.onObservedFrame?.(observedAt)
      }
      if (this.failure) throw this.failure
    } catch (error) { this.close(error instanceof Error ? error : new DeviceConnectionError('transport')); throw error } finally { if (timer) clearInterval(timer); this.close() }
  }
  close(error: Error = new DeviceConnectionError('transport')) {
    if (this.abort.signal.aborted) return
    this.failure = error; this.abort.abort(); this.detach()
    for (const pending of this.pending.values()) { pending.abort.abort(); pending.reject(error) }
    for (const assembly of this.assemblies.values()) assembly.abort.abort()
    for (const controller of this.handlers.values()) controller.abort()
    for (const controller of this.replies.values()) controller.abort()
    for (const controller of this.uploads.values()) controller.abort()
    for (const ack of this.acknowledgements.values()) ack.reject(error)
    this.assemblies.clear(); this.options.socket.close()
  }
}
function classify(code: unknown): import('@foreman-code/contracts/device-connection').DeviceFailureCode {
  return ['authentication', 'permission', 'wrong-main', 'incompatible-protocol', 'malformed-frame', 'backpressure', 'timeout', 'transport'].includes(String(code)) ? code as import('@foreman-code/contracts/device-connection').DeviceFailureCode : 'malformed-frame'
}
